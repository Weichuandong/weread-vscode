import * as vscode from 'vscode';
import { CookieJar } from '../types';

/**
 * 起点登录态服务。
 *
 * 与 Folio (微信读书) 的 AuthService 保持同一套交互约定:
 *   - 唯一登录方式: 用户在浏览器登录后粘贴 Cookie
 *   - Cookie 存 VSCode SecretStorage (系统钥匙串), 不落盘明文
 *   - 失效时**不弹窗**, 只置位 cookieKnownInvalid, 由视图挂一条被动横幅
 *   - 服务器下发的 Set-Cookie 合并回 SecretStorage (起点会滚动续期 ywkey / _csrfToken 等)
 *
 * 起点登录态的关键字段:
 *   - ywguid  阅文用户 id
 *   - ywkey   阅文登录票据 (核心, 缺它所有登录接口返回 code 1000 "未登录")
 *   - ywopenid 部分账号体系才有
 *   - _csrfToken  双提交 CSRF 校验值, 缺失时客户端会自动生成一个
 */
export class QidianAuthService {
  private static readonly SECRET_KEY = 'qidian.cookie';

  private cachedCookie: string | undefined;

  private readonly _onDidChangeLoginState = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeLoginState = this._onDidChangeLoginState.event;

  /** 服务器已拒绝当前 cookie (code 1000 / 401) — 驱动视图里的失效横幅 */
  private cookieKnownInvalid = false;
  private readonly _onDidChangeCookieValidity = new vscode.EventEmitter<boolean>();
  public readonly onDidChangeCookieValidity = this._onDidChangeCookieValidity.event;

  private lastExpiredLogAt = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  public async initialize(): Promise<void> {
    this.cachedCookie = await this.context.secrets.get(QidianAuthService.SECRET_KEY);
  }

  /** 是否已导入 Cookie (不代表一定有效) */
  public isLoggedIn(): boolean {
    return Boolean(this.cachedCookie && this.cachedCookie.trim().length > 0);
  }

  public isCookieKnownInvalid(): boolean {
    return this.cookieKnownInvalid && this.isLoggedIn();
  }

  public getCookieHeader(): string {
    return this.cachedCookie ?? '';
  }

  public getCookieJar(): CookieJar {
    return QidianAuthService.parseCookieString(this.cachedCookie ?? '');
  }

  public async importCookie(): Promise<boolean> {
    const cookie = await vscode.window.showInputBox({
      title: '导入起点 Cookie',
      prompt:
        '浏览器登录 m.qidian.com (或 www.qidian.com) → F12 → Network → 任意 qidian 请求 → ' +
        'Request Headers → 复制完整 Cookie 字段 (需包含 ywkey / ywguid)',
      placeHolder: '_csrfToken=xxx; ywguid=xxx; ywkey=xxx; ...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || !value.trim()) {
          return 'Cookie 不能为空';
        }
        const jar = QidianAuthService.parseCookieString(value);
        if (!jar['ywkey'] && !jar['ywguid']) {
          return '看起来不是有效的起点 Cookie（缺少 ywkey / ywguid）';
        }
        return null;
      },
    });
    if (!cookie) return false;

    const trimmed = cookie.trim();
    const jar = QidianAuthService.parseCookieString(trimmed);
    if (!jar['ywkey']) {
      const choice = await vscode.window.showWarningMessage(
        '起点 Cookie 缺少 ywkey（登录票据）！\n' +
          '书架、加书架、云端进度这些需要登录的功能大概率会返回"未登录"。\n\n' +
          '获取方法: 浏览器登录 m.qidian.com → F12 → Network → 刷新页面 → 点击任意 m.qidian.com 请求 → ' +
          'Request Headers → 复制完整 Cookie 字段 (Application 面板看不到 HttpOnly 字段)',
        { modal: true },
        '重新复制',
        '仍然保存',
      );
      if (choice !== '仍然保存') return false;
    }

    await this.context.secrets.store(QidianAuthService.SECRET_KEY, trimmed);
    this.cachedCookie = trimmed;
    this.markCookieValid();
    this._onDidChangeLoginState.fire(true);
    vscode.window.showInformationMessage('起点：Cookie 已保存');
    return true;
  }

  public async logout(): Promise<void> {
    await this.context.secrets.delete(QidianAuthService.SECRET_KEY);
    this.cachedCookie = undefined;
    this.markCookieValid();
    this._onDidChangeLoginState.fire(false);
    vscode.window.showInformationMessage('起点：已退出登录');
  }

  /**
   * 把服务器下发的 Set-Cookie 合并回当前 cookie 并持久化。
   * 只取 `name=value`, 忽略 Path/Domain/Expires 等属性; 空值 / deleted 占位不处理。
   */
  public async mergeAndPersistCookies(setCookieHeaders: string[] | undefined): Promise<boolean> {
    if (!setCookieHeaders || setCookieHeaders.length === 0) return false;
    if (!this.cachedCookie) return false;

    const jar = QidianAuthService.parseCookieString(this.cachedCookie);
    const updated: string[] = [];
    for (const header of setCookieHeaders) {
      if (!header) continue;
      const semi = header.indexOf(';');
      const pair = semi >= 0 ? header.slice(0, semi) : header;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const key = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!key || !value || value.toLowerCase() === 'deleted') continue;
      if (jar[key] !== value) {
        jar[key] = value;
        updated.push(key);
      }
    }
    if (updated.length === 0) return false;

    const next = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    this.cachedCookie = next;
    await this.context.secrets.store(QidianAuthService.SECRET_KEY, next);
    console.log(`[qidian] Cookie 已续 — 更新 ${updated.length} 字段: ${updated.join(', ')}`);
    return true;
  }

  /**
   * 未登录 / 登录失效信号 (code 1000 / 401)。
   * 静默: 只置位状态驱动横幅, 打节流日志, 不弹窗。
   */
  public notifyExpired(): void {
    if (this.isLoggedIn()) this.markCookieInvalid();
    const now = Date.now();
    if (now - this.lastExpiredLogAt < 5 * 60 * 1000) return;
    this.lastExpiredLogAt = now;
    console.warn(
      '[qidian] 检测到登录失效信号' +
        (this.isLoggedIn() ? ' (已导入的 cookie 被拒, 请通过 "Saga: 导入 Cookie 登录" 重新导入)' : ' (未登录)'),
    );
  }

  /** 登录接口成功返回时调用, 收起失效横幅 */
  public notifyValid(): void {
    this.markCookieValid();
  }

  private markCookieInvalid(): void {
    if (this.cookieKnownInvalid) return;
    this.cookieKnownInvalid = true;
    this._onDidChangeCookieValidity.fire(true);
  }

  private markCookieValid(): void {
    if (!this.cookieKnownInvalid) return;
    this.cookieKnownInvalid = false;
    this._onDidChangeCookieValidity.fire(false);
  }

  public static parseCookieString(raw: string): CookieJar {
    const jar: CookieJar = {};
    if (!raw) return jar;
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const key = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      if (key) jar[key] = value;
    }
    return jar;
  }

  public dispose(): void {
    this._onDidChangeLoginState.dispose();
    this._onDidChangeCookieValidity.dispose();
  }
}
