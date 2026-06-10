import * as vscode from 'vscode';
import type { ModuleContext } from '../../../core/ModuleContext';
import type { ZhihuCookieJar } from '../types';

/**
 * 知乎登录态服务。
 *
 * 跟 weread 的 AuthService 几乎是双胞胎, 故意没抽 BaseCookieAuth — 我们承诺过
 * "等真的有第二个 cookie 模块再抽", 这就是第二个, 但 ZhihuClient 还没写完,
 * 等知乎跑通后, 把两个 AuthService 的共同部分提到 core/BaseCookieAuth.ts 是下一轮的事。
 *
 * 与 weread 版的关键不同:
 *   1. SecretStorage 通过 ctx.secrets 走, key 自动加 'zhihu.' 前缀 (= 'zhihu.cookie')
 *   2. Cookie 校验关键字段是 z_c0 (登录态) 和 d_c0 (设备 ID, 几乎所有接口都查)
 *   3. 知乎没有像 weread 的 wr_skey 那样需要主动续命 — z_c0 是长期 cookie, 通常几个月有效,
 *      所以这里不实现 mergeAndPersistCookies, 也不需要心跳保活。
 *      (真的过期了就是过期了, 让用户重粘就行, 不像 weread 那样有"几天没登就掉线"的尴尬)
 */
export class ZhihuAuthService {
  /** 缓存的 cookie, 避免每次都查 SecretStorage */
  private cachedCookie: string | undefined;

  /** 登录态变化事件, 给视图刷新用 */
  private readonly _onDidChangeLoginState = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeLoginState = this._onDidChangeLoginState.event;

  /** "登录失效" 日志节流, 5 分钟内最多打一条 (避免接口连环失败时刷屏 console) */
  private lastExpiredLogAt = 0;

  /**
   * 已观察到 cookie 失效 (服务器返回 401/403 等鉴权失败信号).
   *
   * 用于在 webview 内被动展示一条"cookie 已失效, 点这里重新导入"的横幅 —
   * 走"被动告示", 不弹任何 modal/toast (用户明确说过 toast 太烦)。
   *
   * 注意: 这个标记只代表"上一次请求时服务器拒绝了我", 不能 100% 等价"现在 cookie 就是无效的"
   * (server 可能临时抖动). 用户重新导入或主动 logout 时会清除。
   */
  private cookieKnownInvalid = false;

  /** cookie 有效性变化事件 (true = 失效, false = 已恢复, 给视图刷新 banner 用) */
  private readonly _onDidChangeCookieValidity = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeCookieValidity = this._onDidChangeCookieValidity.event;

  constructor(private readonly ctx: ModuleContext) {}

  /** 启动时把 cookie 读到内存 */
  public async initialize(): Promise<void> {
    this.cachedCookie = await this.ctx.secrets.get('cookie');
  }

  /** 仅判断存在性, 不验证服务端是否还认 */
  public isLoggedIn(): boolean {
    return Boolean(this.cachedCookie && this.cachedCookie.trim().length > 0);
  }

  /**
   * 是否处于"已登录但 cookie 被 server 拒"的状态。
   * 未登录时永远返回 false (没登录就没"失效"一说, 走未登录态 UI 即可)。
   */
  public isCookieKnownInvalid(): boolean {
    return this.cookieKnownInvalid && this.isLoggedIn();
  }

  /** 给 axios 拼 Cookie 头用 */
  public getCookieHeader(): string {
    return this.cachedCookie ?? '';
  }

  /** 给需要单独字段的场景用 (比如调试) */
  public getCookieJar(): ZhihuCookieJar {
    return ZhihuAuthService.parseCookieString(this.cachedCookie ?? '');
  }

  /** 用户主动导入 cookie */
  public async importCookie(): Promise<boolean> {
    const cookie = await vscode.window.showInputBox({
      title: '导入知乎 Cookie',
      prompt:
        '请在浏览器登录 zhihu.com 后, 打开开发者工具 → Network → 任意请求 → 复制 Request Headers 中的 Cookie 字段',
      placeHolder: '_zap=...; d_c0=...; z_c0=...; ...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Cookie 不能为空';
        }
        const jar = ZhihuAuthService.parseCookieString(value);
        // z_c0 是登录态 token, d_c0 是设备 ID。两者都缺基本不能用,
        // 只缺 z_c0 (有 d_c0) 也提示一下 — 这种情况是"游客 cookie", 推荐流质量差
        if (!jar['d_c0']) {
          return '看起来不是有效的知乎 Cookie (缺少 d_c0 设备 ID)';
        }
        if (!jar['z_c0']) {
          return '缺少 z_c0 (登录 token), 请确认浏览器已登录知乎再复制 Cookie';
        }
        return null;
      },
    });

    if (!cookie) {
      return false;
    }

    const trimmed = cookie.trim();
    await this.ctx.secrets.set('cookie', trimmed);
    this.cachedCookie = trimmed;
    // 新导入的 cookie 默认认为有效, 让 banner 立刻消失;
    // 如果新 cookie 其实也无效, interceptor 下次请求时会再标记回来。
    this.markCookieValid();
    this._onDidChangeLoginState.fire(true);
    vscode.window.showInformationMessage('知乎: Cookie 已保存, 登录成功');
    return true;
  }

  /** 退出登录 */
  public async logout(): Promise<void> {
    await this.ctx.secrets.delete('cookie');
    this.cachedCookie = undefined;
    this.markCookieValid();
    this._onDidChangeLoginState.fire(false);
    vscode.window.showInformationMessage('知乎: 已退出登录');
  }

  /**
   * 检测到登录失效 (401/403/code=ERR_USER_NEED_LOGIN 等) 时调用。
   *
   * **完全静默** — 之前会弹 showWarningMessage 让用户重导, 但用户反馈每次都要
   * 点关闭很烦. 现在改为仅打一条节流日志, 视图层拉不到数据自然会显示空态/错误态,
   * 用户感知到了再自行 "知乎: 导入 Cookie" 即可, 插件不主动打扰。
   *
   * 接口签名保留 (返回 Promise<void>), 方便上层调用方继续 `void this.auth.notifyExpired()`
   * 而不需要全局改造。
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
      '[zhihu] 检测到登录失效信号 ' +
        (this.isLoggedIn() ? '(cookie 已失效, 请通过命令 "知乎: 导入 Cookie" 重新导入)' : '(未登录)'),
    );
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

  /** 解析 "k1=v1; k2=v2" 形式的 cookie 字符串 */
  public static parseCookieString(raw: string): ZhihuCookieJar {
    const jar: ZhihuCookieJar = {};
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
