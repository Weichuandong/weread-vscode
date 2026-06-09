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

  /** "登录已失效"通知节流：避免一次会话里同时多个 401 弹多个气泡 */
  private expiredPromptInFlight = false;
  private lastExpiredPromptAt = 0;

  /** "renewal 彻底失效"通知节流, 独立于 notifyExpired (因为文案/动作不同) */
  private renewalDeadPromptInFlight = false;
  private lastRenewalDeadPromptAt = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** 启动时加载 Cookie 到内存 */
  public async initialize(): Promise<void> {
    this.cachedCookie = await this.context.secrets.get(AuthService.SECRET_KEY);
  }

  /** 当前是否已登录（仅判断是否存在 Cookie，不验证有效性） */
  public isLoggedIn(): boolean {
    return Boolean(this.cachedCookie && this.cachedCookie.trim().length > 0);
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
    this._onDidChangeLoginState.fire(true);
    const hint = jar['wr_rt'] ? '登录成功' : '已保存（但缺 wr_rt，预计几分钟后失效）';
    vscode.window.showInformationMessage(`微信读书：Cookie 已保存，${hint}`);
    return true;
  }

  /** 退出登录：清除 Cookie 与缓存 */
  public async logout(): Promise<void> {
    await this.context.secrets.delete(AuthService.SECRET_KEY);
    this.cachedCookie = undefined;
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
   * 检测到 Cookie 失效(401/403/errcode -2010/-2012/-2013)时调用,
   * 给一个非阻塞的提示让用户重新粘贴。
   *
   * 节流: 5 分钟内最多弹一次, 且并发的多个 401 共享同一个 prompt,
   * 避免一次性多个请求集中失败时弹一堆相同的气泡。
   */
  public async notifyExpired(): Promise<void> {
    if (this.expiredPromptInFlight) {
      return;
    }
    const now = Date.now();
    if (now - this.lastExpiredPromptAt < 5 * 60 * 1000) {
      return;
    }
    this.expiredPromptInFlight = true;
    this.lastExpiredPromptAt = now;
    try {
      const choice = await vscode.window.showWarningMessage(
        '微信读书：登录已失效，是否重新导入 Cookie？',
        '重新导入',
        '稍后',
      );
      if (choice === '重新导入') {
        await vscode.commands.executeCommand('weread.importCookie');
      }
    } finally {
      this.expiredPromptInFlight = false;
    }
  }

  /**
   * renewal 接口被 server 判定彻底失效 (errCode=-2013/-12013, 或本地缺 wr_rt)
   * 时调用。区别于 `notifyExpired`：
   *
   *   - notifyExpired 适用于"wr_skey 暂时性过期"——重新粘贴当前 cookie 可能还能用
   *   - notifyRenewalDead 适用于"wr_rt 在 server 端被废弃 / 缺失"——
   *     **必须用户先到浏览器里重新登录** weread.qq.com, 再复制新的 cookie,
   *     否则即使再复制 100 遍同样的 cookie 也救不回来
   *
   * 用 modal 阻塞式弹窗 (而不是 notifyExpired 的非阻塞), 因为这是彻底失效,
   * 用户不处理的话整个微信读书功能完全不可用, 让消息更醒目一点。
   *
   * @param reason
   *   - `missing_wr_rt`  当前 cookie 里就没有 wr_rt
   *   - `auth_failed`    renewal 返回 -2013 鉴权失败
   *   - `auth_expired`   renewal 返回 -12013 授权过期
   */
  public async notifyRenewalDead(
    reason: 'missing_wr_rt' | 'auth_failed' | 'auth_expired',
  ): Promise<void> {
    if (this.renewalDeadPromptInFlight) {
      return;
    }
    const now = Date.now();
    if (now - this.lastRenewalDeadPromptAt < 5 * 60 * 1000) {
      return;
    }
    this.renewalDeadPromptInFlight = true;
    this.lastRenewalDeadPromptAt = now;

    const headline =
      reason === 'missing_wr_rt'
        ? '微信读书 Cookie 缺少 wr_rt（续命凭证）'
        : reason === 'auth_expired'
          ? '微信读书登录授权已过期 (server 端 wr_rt 失效)'
          : '微信读书登录已被服务器废弃 (renewal 鉴权失败)';

    const body =
      reason === 'missing_wr_rt'
        ? '当前 Cookie 不包含 wr_rt, 续命接口必败 — 几分钟后就完全不可用。\n\n' +
          '【正确复制方法】\n' +
          '1. 浏览器登录 weread.qq.com\n' +
          '2. F12 → Network → 刷新页面 → 点任意 weread 请求\n' +
          '3. 右侧 Request Headers → Cookie 整条复制\n' +
          '   (注意: 不要从 Application 面板复制, 那里看不到 HttpOnly 的 wr_rt)'
        : '服务器拒绝了续命请求 — 说明你的会话已被 weread 主动清退\n' +
          '(常见原因: 浏览器里点了退出 / 异地登录被踢 / 长期未活跃被回收)。\n\n' +
          '【必须的操作】\n' +
          '1. 打开浏览器, 在 weread.qq.com **先退出再重新登录** (重要!)\n' +
          '2. F12 → Network → 刷新页面 → 点任意 weread 请求\n' +
          '3. 右侧 Request Headers → Cookie 整条复制\n\n' +
          '⚠️ 直接再粘贴一遍当前 cookie 是无效的, 因为 server 端已经把这份会话注销了。';

    try {
      const choice = await vscode.window.showWarningMessage(
        `${headline}\n\n${body}`,
        { modal: true },
        '我已重登, 导入新 Cookie',
        '稍后',
      );
      if (choice === '我已重登, 导入新 Cookie') {
        await vscode.commands.executeCommand('weread.importCookie');
      }
    } finally {
      this.renewalDeadPromptInFlight = false;
    }
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
  }
}
