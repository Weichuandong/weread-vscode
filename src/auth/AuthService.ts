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
        '请在浏览器登录 weread.qq.com 后，打开开发者工具 → Network → 任意请求 → 复制 Request Headers 中的 Cookie 字段',
      placeHolder: 'wr_vid=xxx; wr_skey=xxx; wr_pf=xxx; ...',
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
        return null;
      },
    });

    if (!cookie) {
      return false;
    }

    const trimmed = cookie.trim();
    await this.context.secrets.store(AuthService.SECRET_KEY, trimmed);
    this.cachedCookie = trimmed;
    this._onDidChangeLoginState.fire(true);
    vscode.window.showInformationMessage('微信读书：Cookie 已保存，登录成功');
    return true;
  }

  /** 退出登录：清除 Cookie 与缓存 */
  public async logout(): Promise<void> {
    await this.context.secrets.delete(AuthService.SECRET_KEY);
    this.cachedCookie = undefined;
    this._onDidChangeLoginState.fire(false);
    vscode.window.showInformationMessage('微信读书：已退出登录');
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
