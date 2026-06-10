import * as vscode from 'vscode';
import { CookieJar } from '../types';

/**
 * 登录态服务：
 * - 使用 VSCode SecretStorage 安全保存用户 Cookie（避免明文落盘）。
 * - 提供 Cookie 解析、组装、清除等工具方法。
 *
 * 设计动机：
 *   微信读书没有开放 API，扫码登录流程在 VSCode 内实现较复杂，
 *   MVP 采用「浏览器登录 → 复制 Cookie → 粘贴到插件」的方式获取登录态，
 *   既能跑通主流程，又对实现复杂度可控。
 */
export class AuthService {
  private static readonly SECRET_KEY = 'weread.cookie';

  /** 缓存内存中的 Cookie，避免频繁读取 SecretStorage */
  private cachedCookie: string | undefined;

  /** 登录态变化事件（通知视图刷新） */
  private readonly _onDidChangeLoginState = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeLoginState = this._onDidChangeLoginState.event;

  /** "登录失效" 日志节流: 避免接口连环失败时 console 刷屏 */
  private lastExpiredLogAt = 0;

  /** "renewal 彻底失效" 日志节流, 独立于 lastExpiredLogAt (失效语义不同, 排障时分开看更清晰) */
  private lastRenewalDeadLogAt = 0;

  /**
   * 已观察到 cookie 失效 (服务器返回 401/403/errcode -2010/-2012/-2013,
   * 或 renewal 接口被判定 dead).
   *
   * 用于在 webview 内被动展示一条 "cookie 已失效, 点这里重新导入" 的横幅 —
   * 走 "被动告示", 不再弹 toast/modal (用户明确说过弹窗太烦)。
   *
   * 这个标记代表 "上一次请求时服务器拒绝了我", 不能 100% 等价 "现在 cookie 一定无效"
   * (server 可能临时抖动). 用户重新导入或主动 logout 时会清除。
   */
  private cookieKnownInvalid = false;

  /** cookie 有效性变化事件 (true = 失效, false = 已恢复, 给视图刷新 banner 用) */
  private readonly _onDidChangeCookieValidity = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeCookieValidity = this._onDidChangeCookieValidity.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 启动时加载 Cookie 到内存 */
  public async initialize(): Promise<void> {
    this.cachedCookie = await this.context.secrets.get(AuthService.SECRET_KEY);
  }

  /** 当前是否已登录（仅判断是否存在 Cookie，不验证有效性） */
  public isLoggedIn(): boolean {
    return Boolean(this.cachedCookie && this.cachedCookie.trim().length > 0);
  }

  /**
   * 是否处于 "已登录但 cookie 被 server 拒" 的状态。
   * 未登录时永远返回 false (没登录就没"失效"一说, 走未登录态 UI 即可)。
   */
  public isCookieKnownInvalid(): boolean {
    return this.cookieKnownInvalid && this.isLoggedIn();
  }

  /** 获取原始 Cookie 字符串（用于 HTTP 请求头） */
  public getCookieHeader(): string {
    return this.cachedCookie ?? '';
  }

  /** 将原始 Cookie 字符串解析为对象 */
  public getCookieJar(): CookieJar {
    return AuthService.parseCookieString(this.cachedCookie ?? '');
  }

  /**
   * 由用户输入 Cookie 字符串，进行基础校验后保存。
   * 触发登录态变化事件。
   */
  public async importCookie(): Promise<boolean> {
    const cookie = await vscode.window.showInputBox({
      title: '导入微信读书 Cookie',
      prompt:
        '【重要】必须从 DevTools → Network → 任意请求 → Request Headers → Cookie 整条复制 ' +
        '(必须包含 wr_rt — 这是续命凭证, 缺它几分钟就失效)',
      placeHolder: 'wr_vid=xxx; wr_skey=xxx; wr_rt=xxx; wr_pf=xxx; ...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Cookie 不能为空';
        }
        const jar = AuthService.parseCookieString(value);
        if (!jar['wr_vid'] && !jar['wr_skey']) {
          return '看起来不是有效的微信读书 Cookie（缺少 wr_vid 或 wr_skey）';
        }
        // wr_rt 不强制阻断, 但要明确告警 — 没它会几分钟就过期
        // (有些用户从 Application 面板复制时确实拿不到 HttpOnly 的 wr_rt)
        return null;
      },
    });

    if (!cookie) {
      return false;
    }

    const trimmed = cookie.trim();
    const jar = AuthService.parseCookieString(trimmed);

    // wr_rt 是 server 续 wr_skey 的唯一凭证, 缺失会导致 /web/login/renewal 必败,
    // 表现就是用户报的"几分钟就失效"。这里弹个明确的警告并给修复指引。
    if (!jar['wr_rt']) {
      const choice = await vscode.window.showWarningMessage(
        '微信读书 Cookie 缺少 wr_rt（续命凭证）！\n' +
          '保存后大约几分钟 wr_skey 就会过期, 自动续命会失败, 需要频繁重新导入。\n\n' +
          '获取方法: 浏览器登录 weread.qq.com → F12 → Network → 刷新页面 → 点击任意 weread 请求 → ' +
          '右侧 Request Headers → 复制完整 Cookie 字段 (不要从 Application 面板复制, 那里看不到 HttpOnly 的 wr_rt)',
        { modal: true },
        '重新复制',
        '仍然保存',
      );
      if (choice !== '仍然保存') {
        // 不保存, 让用户回去重复制
        return false;
      }
    }

    await this.context.secrets.store(AuthService.SECRET_KEY, trimmed);
    this.cachedCookie = trimmed;
    // 新导入 cookie 默认认为有效, 让 banner 立刻消失;
    // 如果新 cookie 其实也无效, interceptor / renewal 下次失败时会再标记回来。
    this.markCookieValid();
    this._onDidChangeLoginState.fire(true);
    const hint = jar['wr_rt'] ? '登录成功' : '已保存（但缺 wr_rt，预计几分钟后失效）';
    vscode.window.showInformationMessage(`微信读书：Cookie 已保存，${hint}`);
    return true;
  }

  /** 退出登录：清除 Cookie 与缓存 */
  public async logout(): Promise<void> {
    await this.context.secrets.delete(AuthService.SECRET_KEY);
    this.cachedCookie = undefined;
    this.markCookieValid();
    this._onDidChangeLoginState.fire(false);
    vscode.window.showInformationMessage('微信读书：已退出登录');
  }

  /**
   * 拦截到服务器下发的 Set-Cookie 后，把新值合并回当前 cookieJar 并写回 SecretStorage。
   *
   * 微信读书的 `wr_skey` 是短期票据(几天到一周),server 会通过响应头主动续签;
   * 浏览器里这一切是自动的, 但 VSCode 插件用裸 axios + 手动拼 Cookie 头, 需要自己实现这一步,
   * 否则 wr_skey 过期后用户必须手动重新粘贴 Cookie。
   *
   * 入参格式: axios 拿到的 `response.headers['set-cookie']`,
   * 每条形如 `wr_skey=newVal; Path=/; HttpOnly; Domain=.qq.com; Expires=...`。
   * 只取第一个 `;` 之前的 `name=value`,属性部分(Path/Domain/Expires/HttpOnly)直接忽略。
   *
   * @returns 是否真的发生了字段更新(用于上层日志,可不关心)
   */
  public async mergeAndPersistCookies(
    setCookieHeaders: string[] | undefined,
  ): Promise<boolean> {
    if (!setCookieHeaders || setCookieHeaders.length === 0) {
      return false;
    }
    if (!this.cachedCookie) {
      // 还没登录时无脑写入也没意义(没有 wr_vid 等长期字段配对)
      return false;
    }

    const jar = AuthService.parseCookieString(this.cachedCookie);
    const updatedKeys: string[] = [];
    for (const header of setCookieHeaders) {
      if (!header) {
        continue;
      }
      const semi = header.indexOf(';');
      const pair = semi >= 0 ? header.slice(0, semi) : header;
      const eq = pair.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!key) {
        continue;
      }
      // "deleted" 之类的占位值忽略 (server 偶尔会下发清空指令, 我们保守起见不处理)
      if (!value || value.toLowerCase() === 'deleted') {
        continue;
      }
      if (jar[key] !== value) {
        jar[key] = value;
        updatedKeys.push(key);
      }
    }

    if (updatedKeys.length === 0) {
      // 诊断日志: server 下发了 Set-Cookie 但所有字段都和当前一致 (例如重复推同一个 wr_skey)
      // 这条日志频繁出现是正常的; 长期看不到任何 "Cookie 已续" 才是问题信号
      console.log(
        `[weread-vscode] Set-Cookie 收到 ${setCookieHeaders.length} 条, 无字段变化`,
      );
      return false;
    }

    const next = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    this.cachedCookie = next;
    await this.context.secrets.store(AuthService.SECRET_KEY, next);
    // 重点日志: 标记关键 key 的更新 — 如果几个小时内都没看到 wr_skey 被续过,
    // 就说明 weread 根本不主动续 wr_skey, 方案 1 (拦截 Set-Cookie) 是个摆设,
    // 必须走方案 2 (定时心跳) 或重新粘 cookie。
    const hasSkey = updatedKeys.includes('wr_skey');
    console.log(
      `[weread-vscode] Cookie 已续${hasSkey ? ' (含 wr_skey 续签 ✓)' : ''} — 更新 ${updatedKeys.length} 字段: ${updatedKeys.join(', ')}`,
    );
    return true;
  }

  /**
   * 检测到 Cookie 失效 (401/403/errcode -2010/-2012/-2013) 时调用。
   *
   * **完全静默** — 之前会弹 showWarningMessage 让用户重导, 但用户反馈每次都要
   * 点关闭很烦. 现在改为仅打一条节流日志: 视图层拉不到书架/章节时会显示空态/
   * 错误态, 用户感知到了再自行通过命令 "微信读书: 导入 Cookie" 重导。
   *
   * 接口签名保留 (返回 Promise<void>), 方便 interceptor 继续 `void this.auth.notifyExpired()`
   * 调用而不需要全局改造。
   */
  public async notifyExpired(): Promise<void> {
    // 不管节流如何, 状态标记都要打 (banner 不能因为日志节流就漏掉)
    if (this.isLoggedIn()) {
      this.markCookieInvalid();
    }
    const now = Date.now();
    if (now - this.lastExpiredLogAt < 5 * 60 * 1000) {
      return;
    }
    this.lastExpiredLogAt = now;
    console.warn(
      '[weread-vscode] 检测到 Cookie 失效信号 ' +
        (this.isLoggedIn()
          ? '(已登录 cookie 失效, 请通过命令 "微信读书: 导入 Cookie" 重新导入)'
          : '(未登录)'),
    );
  }

  /**
   * renewal 接口被 server 判定彻底失效 (errCode=-2013/-12013, 或本地缺 wr_rt) 时调用。
   *
   * 历史上这里会弹 modal 警告 + 详尽的修复步骤. 但和 notifyExpired 一起被用户反馈
   * "每次都要点关闭很麻烦", 一律改为静默日志。"续命彻底失败" 的状态会被 client 端
   * 的 renewalDead 锁记住, 后续不再发徒劳的心跳请求, 视图层也会自然停在错误态,
   * 用户感知到了再自行重导新 cookie。
   *
   * @param reason
   *   - `missing_wr_rt`  当前 cookie 里就没有 wr_rt
   *   - `auth_failed`    renewal 返回 -2013 鉴权失败
   *   - `auth_expired`   renewal 返回 -12013 授权过期
   */
  public async notifyRenewalDead(
    reason: 'missing_wr_rt' | 'auth_failed' | 'auth_expired',
  ): Promise<void> {
    // 状态标记不走节流, 保证 banner 一旦发现就立刻显示
    if (this.isLoggedIn()) {
      this.markCookieInvalid();
    }
    const now = Date.now();
    if (now - this.lastRenewalDeadLogAt < 5 * 60 * 1000) {
      return;
    }
    this.lastRenewalDeadLogAt = now;
    const desc =
      reason === 'missing_wr_rt'
        ? 'Cookie 缺少 wr_rt (续命凭证), 续命接口必败 — 请重新从 Network → Request Headers 复制完整 Cookie 后通过命令 "微信读书: 导入 Cookie" 重导'
        : reason === 'auth_expired'
          ? '服务器端授权已过期 (errCode=-12013), 当前 cookie 已被 weread 清退 — 请先在浏览器 weread.qq.com 重新登录, 再复制新 cookie 重导'
          : '服务器拒绝续命请求 (errCode=-2013), 当前 cookie 已被 weread 清退 — 请先在浏览器 weread.qq.com 重新登录, 再复制新 cookie 重导';
    console.warn(`[weread-vscode] renewal 彻底失效 (${reason}): ${desc}`);
  }

  /** 内部: 标记 cookie 已失效, 触发 banner 显示 (带变化检测, 避免无谓 fire) */
  private markCookieInvalid(): void {
    if (this.cookieKnownInvalid) return;
    this.cookieKnownInvalid = true;
    this._onDidChangeCookieValidity.fire(true);
  }

  /** 内部: 清掉 cookie 失效状态, 触发 banner 隐藏 (带变化检测) */
  private markCookieValid(): void {
    if (!this.cookieKnownInvalid) return;
    this.cookieKnownInvalid = false;
    this._onDidChangeCookieValidity.fire(false);
  }

  /** 解析 "k1=v1; k2=v2" 形式的 Cookie 字符串 */
  public static parseCookieString(raw: string): CookieJar {
    const jar: CookieJar = {};
    if (!raw) {
      return jar;
    }
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) {
        continue;
      }
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) {
        jar[key] = value;
      }
    }
    return jar;
  }

  public dispose(): void {
    this._onDidChangeLoginState.dispose();
    this._onDidChangeCookieValidity.dispose();
  }
}
