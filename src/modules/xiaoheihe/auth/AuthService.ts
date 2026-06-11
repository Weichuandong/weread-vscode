import * as vscode from 'vscode';
import type { ModuleContext } from '../../../core/ModuleContext';
import type { XiaoheiheCookieJar } from '../types';

/**
 * 小黑盒登录态服务.
 *
 * 跟 zhihu / weread 的 AuthService 风格一致 (SecretStorage 存 cookie + 内存缓存 +
 * EventEmitter 通知视图刷新), 故意没共享 BaseCookieAuth — "等真的有第三个" 的承诺
 * 现在兑现, 三个模块都跑通后再抽 core/BaseCookieAuth.ts (跟 zhihu 模块注释呼应).
 *
 * 持久化格式演进:
 *   - v2.2.2 及以前: secrets.cookie 是裸 cookie 字符串
 *   - v2.2.3:        secrets.cookie 改 JSON { cookie, webSig? } — 配合"手动注入
 *                    web 签名"折中方案
 *   - v2.2.4 起:     web hkey 走本地算法 (utils/webSign.ts), webSig 不再需要,
 *                    持久化退回裸 cookie 字符串. initialize 仍向后兼容读取
 *                    v2.2.3 的 JSON 格式 (只取 cookie 字段, webSig 段丢弃),
 *                    下次 importCookie 自然覆盖成裸字符串.
 *
 * 关键 cookie 字段:
 *   - pkey:        登录鉴权 token (核心, 没这个就是未登录态)
 *   - heybox_id:   用户数字 ID (代替 signedGet 里 '-1' 的未登录占位)
 *
 * 跟 zhihu 不同点:
 *   1. 小黑盒 cookie 没观察到 "服务端主动续命" 行为, 不实现 mergeAndPersistCookies
 *   2. cookie 失效是通过业务 status (e.g. 'pkey_expired') 体现, 不通过 HTTP 401,
 *      我们暂时不专门拦截 — 用户重新粘 cookie 即可恢复 (跟 zhihu 一致, 长期 cookie
 *      过期重新粘是 OK 的)
 *   3. 走 ctx.secrets (带 'xiaoheihe.' 前缀) 而不是直接 ctx.raw.secrets
 *
 * 使用:
 *   const auth = new XiaoheiheAuthService(ctx);
 *   await auth.initialize();
 *   if (auth.isLoggedIn()) { ... auth.getJar()?.pkey ... }
 */
export class XiaoheiheAuthService {
  /**
   * 缓存的 cookie 字符串. initialize 后填充, 未登录时 undefined.
   *
   * 全程持有"裸 cookie 字符串"而不是结构化对象 — parseCookieString 成本足够低
   * (几十微秒), 每次 getJar 现解析即可, 避免 importCookie 后还要写同步逻辑.
   */
  private cachedCookie: string | undefined;

  /** 登录态变化事件, 给视图刷新用 (true = 已登录, false = 已登出) */
  private readonly _onDidChangeLoginState = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeLoginState = this._onDidChangeLoginState.event;

  constructor(private readonly ctx: ModuleContext) {}

  /**
   * 启动时把 cookie 读到内存. activate 时必须 await 一次.
   *
   * 调用前 isLoggedIn 始终返回 false — 上层视图首屏渲染应该等 initialize 完成
   * (我们 activate 里 await 等了, 不会跳过).
   *
   * 持久化格式兼容:
   *   - v2.2.4+ (新): 裸 cookie 字符串
   *   - v2.2.3   (旧): JSON { cookie, webSig? } — 只读 cookie 字段, webSig 丢弃
   *   - v2.2.2-  (古): 裸 cookie 字符串 — 跟 v2.2.4 同形态, 直接用
   *
   * 不主动改写持久化格式 — 等用户下次 importCookie 自然覆盖成新格式.
   */
  public async initialize(): Promise<void> {
    const raw = await this.ctx.secrets.get('cookie');
    if (!raw) {
      this.cachedCookie = undefined;
      return;
    }
    // v2.2.3 JSON 路径: 仅识别"看起来是 JSON 对象"形态 (以 '{' 开头), 防止裸
    // cookie 字符串里偶然含 '{' (理论上极少, cookie value 不会塞这种字符) 误判.
    if (raw.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(raw) as { cookie?: unknown };
        if (parsed && typeof parsed.cookie === 'string') {
          this.cachedCookie = parsed.cookie;
          return;
        }
      } catch {
        // JSON 解析失败 (理论不该发生, 但守一手), 当作裸 cookie fallthrough
      }
    }
    this.cachedCookie = raw;
  }

  /** 仅判断存在性, 不验证服务端是否还认. */
  public isLoggedIn(): boolean {
    return Boolean(this.cachedCookie && this.cachedCookie.trim().length > 0);
  }

  /**
   * 解析当前 cookie 拿到结构化 jar. 未登录返回 null.
   *
   * 每次现解析 (而不是缓存), 因为 importCookie 后 cookie 就更新了, 缓存反而要写
   * 同步逻辑; cookie 字符串解析成本很低 (~几十微秒), 不优化.
   */
  public getJar(): XiaoheiheCookieJar | null {
    if (!this.cachedCookie) return null;
    return parseCookieString(this.cachedCookie);
  }

  /**
   * 用户主动导入 cookie. 弹 InputBox 接收粘贴内容, 支持多种粘贴形态
   * (见 parseCookieString 的注释 — Chrome DevTools 各种复制方式都能识别).
   *
   * v2.2.3 曾要求用户粘整条 cURL 命令 (额外提取 hkey/nonce 等), v2.2.4 起 hkey
   * 走本地算法, cookie 一项足够, 用户体验回归"粘 cookie 即可".
   *
   * 校验通过后持久化裸 cookie 字符串 + 触发 onDidChangeLoginState.
   *
   * @returns 导入成功返回 true; 用户取消 / 校验失败返回 false
   */
  public async importCookie(): Promise<boolean> {
    const input = await vscode.window.showInputBox({
      title: '导入小黑盒登录态',
      prompt:
        '粘贴 cookie. 推荐: F12 → Application → Cookies → https://www.xiaoheihe.cn → 选中 pkey 行 → 复制 Value (或框选多行带表头复制). 也支持完整 Cookie header 字符串.',
      placeHolder: 'pkey=xxx; heybox_id=xxx   或   仅 pkey 的 value 字符串',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Cookie 不能为空';
        }
        const parsed = parseCookieString(value.trim());
        if (!parsed.pkey) {
          return '没识别到 pkey. 请确认 (a) 浏览器已登录小黑盒, (b) 粘的是 pkey value / "pkey=xxx; ..." / DevTools 多行复制';
        }
        return null;
      },
    });

    if (!input) {
      return false;
    }

    const trimmed = input.trim();
    const parsed = parseCookieString(trimmed);
    if (!parsed.pkey) {
      // 兜底: validateInput 应该已拦, 这里二次防御
      vscode.window.showErrorMessage('小黑盒: cookie 解析失败 (缺 pkey), 未保存.');
      return false;
    }

    // 持久化为裸 cookie 字符串 (v2.2.4 起的格式, 跟 v2.2.2 之前一致).
    //   如果是 "纯 token" 形态, parseCookieString 会把它当成 pkey value 处理 —
    //   持久化的也是用户原始输入 (parseCookieString 的 rawCookie 字段是
    //   `pkey=${trimmed}` 形态, 但我们这里持久化的是 *用户输入原文*, 因为
    //   getJar 现解析时还会再过一遍 parseCookieString — 保证 rawCookie /
    //   pkey 解析行为始终一致).
    await this.ctx.secrets.set('cookie', trimmed);
    this.cachedCookie = trimmed;
    this._onDidChangeLoginState.fire(true);

    const heyboxIdHint = parsed.heyboxId ? ` (heybox_id=${parsed.heyboxId})` : '';
    vscode.window.showInformationMessage(`小黑盒: 登录成功${heyboxIdHint}.`);
    return true;
  }

  /** 退出登录 — 清缓存 + 清持久化 + 通知视图. */
  public async logout(): Promise<void> {
    await this.ctx.secrets.delete('cookie');
    this.cachedCookie = undefined;
    this._onDidChangeLoginState.fire(false);
    vscode.window.showInformationMessage('小黑盒: 已退出登录, 主页将回到本地混排模式.');
  }
}

/**
 * 解析 cookie 字符串成结构化 jar.
 *
 * 用户粘贴源头多样, 解析做得很宽容 — 尽量"用户怎么贴都能识别":
 *
 *   1. 标准 cookie header 格式: "pkey=xxx; heybox_id=xxx; ..."
 *      场景: F12 Network → Headers → 复制 Cookie 那一行
 *
 *   2. 多行格式: "pkey=xxx\nheybox_id=xxx"
 *      场景: 用户分多行手敲
 *
 *   3. 表格制表符 / 多空格分隔: "pkey\tMTc4xxx\t.xiaoheihe.cn\t/\t...\nheybox_id\t47252771\t..."
 *      场景: 用户在 Chrome DevTools Application Cookies 表格里框选多行复制 —
 *      格式是每行 "name<TAB>value<TAB>domain<TAB>path<TAB>..." 我们只取前两段
 *
 *   4. 纯 pkey value (无 '=' 无 ';' 无空白): "MTc4MTA5NTk3NS4wNF80NzI1..."
 *      场景: 用户在 Application Cookies 表格里只点了 pkey 行的 Value 单元格复制 —
 *      最常见的偷懒粘贴方式, 我们自动包装成 pkey=xxx 处理. 这种情况 heybox_id 拿不到,
 *      但服务端会从 pkey 反查 (-1 占位也能跑通登录态接口).
 *
 *   5. user_pkey / user_heybox_id 兜底: 小黑盒服务端会下发两份 cookie —
 *      普通版 (JS 可读) + user_ 前缀版 (httpOnly, JS 不可读), 值完全相同.
 *      用户在 Application 里看到的可能是 httpOnly 那份, 别让他白复制.
 *
 * 实现要点:
 *   - 第一个 '=' 当分隔符, value 里允许出现 '=' (base64 padding 经常 '==' 结尾)
 *   - 字段名大小写敏感 (小黑盒服务端就是小写 pkey / heybox_id)
 *   - 同名重复取首次出现 (Application 表格里同名 cookie 可能因不同 domain 出现多次)
 */
function parseCookieString(raw: string): XiaoheiheCookieJar {
  const trimmed = (raw || '').trim();

  // 场景 4: 纯 token (一坨连续字符, 无任何分隔). 直接当 pkey 处理.
  //   判定保守: 长度 >= 8 (短的更可能是用户误粘); 不含 '=' / ';' / 空白.
  //   不容易误判 — 真实 cookie 形态里, 至少一个 '=' 几乎必然存在.
  const looksLikeRawToken =
    trimmed.length >= 8 &&
    !trimmed.includes('=') &&
    !trimmed.includes(';') &&
    !/\s/.test(trimmed);
  if (looksLikeRawToken) {
    return {
      pkey: trimmed,
      heyboxId: undefined,
      rawCookie: `pkey=${trimmed}`,
    };
  }

  // 场景 1-3 统一处理: 按 [;\r\n] 切段, 每段尝试 'k=v' 优先, 否则按空白取前两段.
  const map: Record<string, string> = {};
  for (const seg of trimmed.split(/[;\r\n]+/)) {
    const s = seg.trim();
    if (!s) continue;

    // 'k=v' 格式 (标准 cookie / 手敲)
    const eqIdx = s.indexOf('=');
    if (eqIdx > 0) {
      const k = s.slice(0, eqIdx).trim();
      const v = s.slice(eqIdx + 1).trim();
      if (k && !(k in map)) map[k] = v;
      continue;
    }

    // 'k<空白>v<空白>更多元数据' 格式 (Application 表格框选粘贴)
    //   只取前两段, 后续段 (domain/path/expires/size/...) 全忽略.
    const parts = s.split(/\s+/);
    if (parts.length >= 2) {
      const k = parts[0].trim();
      const v = parts[1].trim();
      if (k && !(k in map)) map[k] = v;
    }
    // parts.length === 1 (例如只有键名一坨) — 没法解析, 丢弃
  }

  return {
    // user_pkey / user_heybox_id 是 httpOnly 副本, 跟 pkey / heybox_id 同值,
    //   优先普通版, 副本兜底 — 解决用户从 Application 表格里复制了 httpOnly 那行
    //   (前面带 ✓ 标记) 反而拿不到 token 的尴尬.
    pkey: map['pkey'] || map['user_pkey'] || undefined,
    heyboxId: map['heybox_id'] || map['user_heybox_id'] || undefined,
    rawCookie: trimmed,
  };
}
