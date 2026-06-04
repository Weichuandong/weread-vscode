import * as vscode from 'vscode';
import { WereadClient, ChapterFetchResult } from '../api/WereadClient';
import { AuthService } from '../auth/AuthService';
import { QrLoginSession, QrStatus } from '../auth/QrLoginService';
import { BookProgress, WereadArchive, WereadBook, WereadChapter } from '../types';
import { getBookReaderUrl, getChapterReaderUrl } from '../api/wereadUrl';

type Tab = 'shelf' | 'reader';

/**
 * 本地 globalState 里缓存的"最近在读"快照, 仅用作首屏占位,
 * 真正的多端互通走云端 /web/book/getProgress 与 /web/book/read。
 */
interface LastReadSnapshot {
  bookId: string;
  title?: string;
  author?: string;
  cover?: string;
  chapterUid?: number;
}
const KEY_LAST_READ = 'weread.lastRead';
const KEY_TAB = 'weread.tab';

/**
 * 唯一的侧栏 Webview 视图: 整合书架与阅读两个功能。
 *
 * 设计目标(参考 CodeWiz 紧凑感):
 *   - 顶部一行 tab 切换(书架 / 在读), 不再为两个 view 各占一截 header
 *   - 阅读时正文区拥有 90% 以上的纵向空间
 *   - 字体/行高/段落缩进/章节标题均做了排版优化, 阅读体验接近"读书"App
 *
 * 状态:
 *   - tab: 当前显示的页签
 *   - books / shelfError / shelfLoading: 书架数据
 *   - currentBook / currentChapters / currentChapterIdx: 阅读中的书与章节
 *   - chapterContent: 当前章节的解密结果(null=未加载, 否则为渲染数据)
 *
 * 渲染策略:
 *   - 任意状态变更后调用 render() 一次性重新生成 HTML
 *   - 中间态(loading/error) 通过特定占位 HTML 表达, 不需要复杂局部更新
 *   - 切换章节/打开书等耗时动作通过 loadToken 防并发
 */
export class MainViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'weread.main';

  private view: vscode.WebviewView | undefined;

  // ---- UI 状态 ----
  private tab: Tab = 'shelf';

  // ---- 书架状态 ----
  private books: WereadBook[] = [];
  /** 用户在微信读书里自建的分组(原样从接口返回) */
  private archives: WereadArchive[] = [];
  private shelfLoading = false;
  private shelfError: string | null = null;
  /** 防止 view 还没 ready 时丢失加载请求 */
  private pendingShelfLoad = false;
  /** 当前已展开的分组名集合(默认全部折叠) */
  private expandedGroups = new Set<string>();

  // ---- 阅读状态 ----
  private currentBook: WereadBook | undefined;
  private currentChapters: WereadChapter[] = [];
  private currentChapterIdx = -1;
  private chapterFetch: ChapterFetchResult | null = null;
  private chapterLoading = false;
  /** 异步操作 token, 用于丢弃过期回包 */
  private loadToken = 0;
  /**
   * 打开某本书时, 用云端进度里的 chapterUid 来定位章节。
   * 在 loadBookInternal 内消费一次后置 undefined。
   */
  private pendingRestoreChapterUid: number | undefined;
  /** 上次上报云端阅读进度的时间, 简单节流 */
  private lastReportAt = 0;

  // ---- 扫码登录状态 ----
  private qrSession: QrLoginSession | undefined;
  private qrState: { status: QrStatus; qrImageDataUrl?: string; message?: string } | null = null;

  /**
   * 浏览器登录助手状态: OAuth 走不通时降级到此流程,
   * 引导用户在浏览器登录后, 跑一段 console 把 cookie 复制到剪贴板,
   * 我们再读剪贴板自动导入。
   */
  private browserLoginState: {
    step: 'guide' | 'waiting' | 'verifying';
    message?: string;
    error?: string;
  } | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: WereadClient,
    private readonly auth: AuthService,
  ) {
    // ---- 从本地 globalState 恢复最近在读快照 (云端慢, 先有个占位) ----
    const snap = context.globalState.get<LastReadSnapshot>(KEY_LAST_READ);
    if (snap?.bookId) {
      this.currentBook = {
        bookId: snap.bookId,
        title: snap.title ?? '',
        author: snap.author,
        cover: snap.cover,
      };
      this.pendingRestoreChapterUid = snap.chapterUid;
    }
    const savedTab = context.globalState.get<Tab>(KEY_TAB);
    if (savedTab === 'shelf' || savedTab === 'reader') {
      this.tab = savedTab;
    }

    // 登录态变化时让书架重拉
    auth.onDidChangeLoginState(() => {
      this.books = [];
      this.shelfError = null;
      this.pendingShelfLoad = true;
      void this.loadShelfIfNeeded();
    });
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'resources')],
    };
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    view.onDidDispose(() => {
      this.view = undefined;
    });

    // 首屏: 已登录则拉书架, 未登录则展示登录卡片
    if (this.auth.isLoggedIn() && this.books.length === 0 && !this.shelfLoading) {
      this.pendingShelfLoad = true;
    }
    void this.loadShelfIfNeeded();

    // 如果用户上次停在"在读"且有书快照, 直接触发加载, 章节会定位到云端进度
    if (this.tab === 'reader' && this.currentBook && this.currentChapters.length === 0) {
      void this.loadBookInternal(this.currentBook);
    }

    this.render();
  }

  // ---------------- 公共入口(被命令调用) ----------------

  /** 强制刷新书架 */
  public async refreshShelf(): Promise<void> {
    this.books = [];
    this.shelfError = null;
    this.pendingShelfLoad = true;
    await this.loadShelfIfNeeded(true);
  }

  /** 命令: 打开某本书并切到阅读 tab */
  public async openBook(book: WereadBook): Promise<void> {
    if (!book?.bookId) return;
    if (!this.view) {
      // 还没创建 view, 触发聚焦让它创建
      try {
        await vscode.commands.executeCommand('weread.main.focus');
      } catch {
        await vscode.commands.executeCommand('workbench.view.extension.weread');
      }
    }
    this.view?.show?.(true);
    this.tab = 'reader';
    void this.context.globalState.update(KEY_TAB, this.tab);

    // 打开新书时:
    //   - 如果是本地快照里的同一本书 → 用快照 chapterUid 定位
    //   - 否则 → 从云端 getProgress 拉真实进度定位
    if (this.currentBook?.bookId !== book.bookId) {
      this.pendingRestoreChapterUid = undefined;
    }
    await this.loadBookInternal(book);
    // 打开即视为"开始阅读", 顺手上报一次, 让其它设备看到我换书了
    void this.reportProgressToCloud();
  }

  // ---------------- 扫码登录 ----------------

  /**
   * 启动微信扫码登录会话。
   * 会一直发事件直到 success/expired/failed/cancelled, 每个事件都触发 render。
   */
  /**
   * 提供给命令面板/外部调用的入口, 内部直接复用 startQrLogin。
   * 调用方应该先确保 webview 已聚焦(weread.main.focus)。
   */
  public triggerQrLogin(): void {
    void this.startQrLogin();
  }

  private async startQrLogin(): Promise<void> {
    // 已经在跑就忽略
    if (this.qrSession) return;
    const session = new QrLoginSession();
    this.qrSession = session;
    this.qrState = { status: 'init', message: '正在生成二维码…' };
    this.render();

    session.onEvent(async (e) => {
      this.qrState = {
        status: e.status,
        qrImageDataUrl: e.qrImageDataUrl,
        message: e.message,
      };
      this.render();

      if (e.status === 'success' && e.cookieHeader) {
        // 直接落盘并刷新书架, 不再需要 UI 再点确认
        const ok = await this.auth.setCookieString(e.cookieHeader);
        if (ok) {
          this.qrSession = undefined;
          this.qrState = null;
          this.pendingShelfLoad = true;
          await this.loadShelfIfNeeded(true);
        } else {
          this.qrState = { status: 'failed', message: 'Cookie 落盘失败' };
          this.qrSession = undefined;
          this.render();
        }
      } else if (
        e.status === 'failed' ||
        e.status === 'expired' ||
        e.status === 'cancelled'
      ) {
        this.qrSession = undefined;
        // OAuth 被微信拒(典型 'WX_REJECTED' 类) → 自动转入浏览器登录助手流程
        if (
          e.status === 'failed' &&
          typeof e.message === 'string' &&
          /微信开放平台拒绝|拒绝了请求|抱歉.*出错/.test(e.message)
        ) {
          this.qrState = null;
          void this.startBrowserLogin('微信扫码暂不可用, 已切换到「浏览器登录助手」');
        }
      }
    });

    void session.start();
  }

  private cancelQrLogin(): void {
    if (this.qrSession) {
      this.qrSession.cancel();
      this.qrSession = undefined;
    }
    this.qrState = null;
    this.render();
  }

  // ---------------- 浏览器登录助手 ----------------

  /**
   * 启动「浏览器登录助手」:
   *  1. 打开 weread.qq.com
   *  2. UI 展示三步指引(扫码登录 / 控制台粘贴一句 / 回来点完成)
   *  3. 点击完成 → 读剪贴板, 校验后写入 secrets
   */
  public async startBrowserLogin(hint?: string): Promise<void> {
    this.browserLoginState = {
      step: 'guide',
      message: hint,
    };
    this.render();
    try {
      await vscode.env.openExternal(vscode.Uri.parse('https://weread.qq.com/'));
    } catch {
      /* 用户自己手动开也行, 不阻塞流程 */
    }
  }

  /**
   * 点击"完成登录(从剪贴板读取)": 把剪贴板里的 cookie 字符串导入 secrets。
   * 校验通过则触发书架刷新。
   */
  private async finishBrowserLogin(): Promise<void> {
    if (!this.browserLoginState) return;
    this.browserLoginState = { step: 'verifying', message: '正在校验剪贴板内容…' };
    this.render();
    try {
      const raw = (await vscode.env.clipboard.readText()).trim();
      if (!raw) {
        this.browserLoginState = {
          step: 'guide',
          error: '剪贴板为空, 请先在浏览器控制台运行 copy(document.cookie)',
        };
        this.render();
        return;
      }
      // 简单形状校验: 至少要带 wr_vid 或 wr_skey
      if (!/wr_vid|wr_skey/i.test(raw)) {
        this.browserLoginState = {
          step: 'guide',
          error:
            '剪贴板内容不像 weread cookie(缺 wr_vid/wr_skey)。请确认在 weread.qq.com 控制台执行过 copy(document.cookie)',
        };
        this.render();
        return;
      }
      const ok = await this.auth.setCookieString(raw);
      if (!ok) {
        this.browserLoginState = {
          step: 'guide',
          error: 'Cookie 写入失败, 请重试',
        };
        this.render();
        return;
      }
      // 成功 → 清状态, 触发书架加载(auth.onDidChangeLoginState 会自动重拉)
      this.browserLoginState = null;
      this.render();
    } catch (e) {
      this.browserLoginState = {
        step: 'guide',
        error: e instanceof Error ? e.message : String(e),
      };
      this.render();
    }
  }

  private cancelBrowserLogin(): void {
    this.browserLoginState = null;
    this.render();
  }

  // ---------------- 数据加载 ----------------

  private async loadShelfIfNeeded(force = false): Promise<void> {
    if (!this.view) return;
    if (!this.auth.isLoggedIn()) {
      this.render();
      return;
    }
    if (!force && !this.pendingShelfLoad) return;
    if (this.shelfLoading) return;

    this.pendingShelfLoad = false;
    this.shelfLoading = true;
    this.shelfError = null;
    this.render();
    try {
      const shelf = await this.client.getBookshelf();
      this.books = shelf.books;
      this.archives = shelf.archives;

      // 拉到书架后, 如果本地还没有任何最近在读快照, 用云端的 lastReadBookId 补一个,
      // 这样新设备首次安装、登录后立刻就能看到"在读"tab 是活的, 多端真正打通。
      if (!this.currentBook && shelf.lastReadBookId) {
        const b = this.books.find((x) => x.bookId === shelf.lastReadBookId);
        const p = shelf.progressMap.get(shelf.lastReadBookId);
        if (b) {
          this.currentBook = b;
          this.pendingRestoreChapterUid = p?.chapterUid;
          this.persistLastReadSnapshot();
        }
      }
    } catch (e) {
      this.shelfError = e instanceof Error ? e.message : String(e);
      this.books = [];
      this.archives = [];
    } finally {
      this.shelfLoading = false;
      this.render();
    }
  }

  private async loadBookInternal(book: WereadBook): Promise<void> {
    if (!this.view) return;
    const token = ++this.loadToken;
    this.currentBook = book;
    this.currentChapters = [];
    this.currentChapterIdx = -1;
    this.chapterFetch = null;
    this.chapterLoading = true;
    this.render();

    // 消费一次"待恢复章节 uid"(本地快照, 只在云端拉不到时兜底)
    const localChapterUid = this.pendingRestoreChapterUid;
    this.pendingRestoreChapterUid = undefined;

    try {
      // 并行拉: 详情、章节目录、云端进度。三者无依赖, 并行最快。
      const [info, chapters, cloudProgress] = await Promise.all([
        this.client.getBookInfo(book.bookId).catch(() => null),
        this.client.getChapters(book.bookId),
        this.client.getBookProgress(book.bookId),
      ]);
      if (token !== this.loadToken) return;
      if (info) {
        this.currentBook = { ...this.currentBook, ...info };
      }
      this.currentChapters = chapters;

      // 章节定位优先级: 云端 getProgress > 本地快照 > 第一章
      // (云端优先以保证多端互通: 在手机/网页阅读后, VSCode 打开能跳到最新位置)
      const targetUid = cloudProgress?.chapterUid ?? localChapterUid;
      let idx = 0;
      if (targetUid !== undefined) {
        const found = chapters.findIndex((c) => c.chapterUid === targetUid);
        if (found >= 0) idx = found;
      }
      this.currentChapterIdx = chapters.length > 0 ? idx : -1;

      this.persistLastReadSnapshot();
      await this.loadCurrentChapter(token);
    } catch (e) {
      if (token !== this.loadToken) return;
      this.chapterLoading = false;
      this.chapterFetch = {
        html: null,
        style: null,
        content: null,
        format: null,
        diagnostics: e instanceof Error ? e.message : String(e),
        fallbackUrl: getBookReaderUrl(book.bookId),
      };
      this.render();
    }
  }

  private async loadCurrentChapter(externalToken?: number): Promise<void> {
    if (!this.view || !this.currentBook) return;
    const token = externalToken ?? ++this.loadToken;
    const chapter =
      this.currentChapterIdx >= 0 ? this.currentChapters[this.currentChapterIdx] : undefined;
    if (!chapter) {
      this.chapterFetch = null;
      this.chapterLoading = false;
      this.render();
      return;
    }
    this.chapterLoading = true;
    this.chapterFetch = null;
    this.render();
    try {
      const res = await this.client.fetchChapterContent(this.currentBook.bookId, chapter.chapterUid);
      if (token !== this.loadToken) return;
      this.chapterFetch = res;
    } catch (e) {
      if (token !== this.loadToken) return;
      this.chapterFetch = {
        html: null,
        style: null,
        content: null,
        format: null,
        diagnostics: e instanceof Error ? e.message : String(e),
        fallbackUrl: getBookReaderUrl(this.currentBook.bookId),
      };
    } finally {
      if (token === this.loadToken) {
        this.chapterLoading = false;
        this.render();
      }
    }
  }

  private async switchChapter(idx: number): Promise<void> {
    if (idx < 0 || idx >= this.currentChapters.length) return;
    this.currentChapterIdx = idx;
    this.persistLastReadSnapshot();
    void this.reportProgressToCloud();
    await this.loadCurrentChapter();
  }

  /** 把"最近在读"写本地 globalState (即时, 用作下次启动的占位) */
  private persistLastReadSnapshot(): void {
    if (!this.currentBook) return;
    const ch = this.currentChapters[this.currentChapterIdx];
    const snap: LastReadSnapshot = {
      bookId: this.currentBook.bookId,
      title: this.currentBook.title,
      author: this.currentBook.author,
      cover: this.currentBook.cover,
      chapterUid: ch?.chapterUid,
    };
    void this.context.globalState.update(KEY_LAST_READ, snap);
  }

  /**
   * 把当前书+章节上报到微信读书云端, 实现多端互通(VSCode → 手机/网页)。
   * 节流: 同一秒内不重复上报, 失败不抛错。
   */
  private async reportProgressToCloud(): Promise<void> {
    if (!this.currentBook) return;
    const ch = this.currentChapters[this.currentChapterIdx];
    if (!ch) return;
    const now = Date.now();
    if (now - this.lastReportAt < 1000) return;
    this.lastReportAt = now;
    void this.client.reportReadProgress(
      this.currentBook.bookId,
      ch.chapterUid,
      ch.chapterIdx ?? this.currentChapterIdx,
    );
  }

  // ---------------- 消息分发 ----------------

  private handleMessage(msg: { type?: string; payload?: unknown }): void {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'switchTab': {
        const next = (msg.payload as { tab?: Tab })?.tab;
        if (next === 'shelf' || next === 'reader') {
          this.tab = next;
          void this.context.globalState.update(KEY_TAB, this.tab);
          // 切到"在读"且只有占位的 currentBook 但还没拉过章节 → 触发加载
          if (next === 'reader' && this.currentBook && this.currentChapters.length === 0) {
            void this.loadBookInternal(this.currentBook);
            return;
          }
          if (next === 'shelf' && this.books.length === 0 && this.auth.isLoggedIn()) {
            this.pendingShelfLoad = true;
            void this.loadShelfIfNeeded();
          } else {
            this.render();
          }
        }
        break;
      }
      case 'openBook': {
        const bookId = (msg.payload as { bookId?: string })?.bookId;
        const book = this.books.find((b) => b.bookId === bookId);
        if (book) {
          void this.openBook(book);
        }
        break;
      }
      case 'selectChapter': {
        const idx = Number((msg.payload as { idx?: number })?.idx);
        if (Number.isInteger(idx)) void this.switchChapter(idx);
        break;
      }
      case 'prev':
        void this.switchChapter(this.currentChapterIdx - 1);
        break;
      case 'next':
        void this.switchChapter(this.currentChapterIdx + 1);
        break;
      case 'openInBrowser': {
        if (!this.currentBook) return;
        const ch = this.currentChapters[this.currentChapterIdx];
        const url = ch
          ? getChapterReaderUrl(this.currentBook.bookId, ch.chapterUid)
          : getBookReaderUrl(this.currentBook.bookId);
        void vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case 'retry':
        void this.loadCurrentChapter();
        break;
      case 'refreshShelf':
        void this.refreshShelf();
        break;
      case 'toggleGroup': {
        const name = (msg.payload as { name?: string })?.name;
        if (typeof name === 'string') {
          if (this.expandedGroups.has(name)) {
            this.expandedGroups.delete(name);
          } else {
            this.expandedGroups.add(name);
          }
          this.render();
        }
        break;
      }
      case 'expandAll':
        // 当前书架里所有分组名
        for (const g of this.computeGroupNames()) this.expandedGroups.add(g);
        this.render();
        break;
      case 'collapseAll':
        this.expandedGroups.clear();
        this.render();
        break;
      case 'login':
        void vscode.commands.executeCommand('weread.importCookie');
        break;
      case 'qrLogin':
        void this.startQrLogin();
        break;
      case 'cancelQrLogin':
        this.cancelQrLogin();
        break;
      case 'browserLogin':
        void this.startBrowserLogin();
        break;
      case 'reopenWeread':
        void vscode.env.openExternal(vscode.Uri.parse('https://weread.qq.com/'));
        break;
      case 'finishBrowserLogin':
        void this.finishBrowserLogin();
        break;
      case 'cancelBrowserLogin':
        this.cancelBrowserLogin();
        break;
      default:
        break;
    }
  }

  // ---------------- 渲染 ----------------

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = this.buildHtml();
  }

  private buildHtml(): string {
    const cspSource = this.view!.webview.cspSource;
    const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data: ${cspSource}; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};" />`;

    const loggedIn = this.auth.isLoggedIn();
    const body = !loggedIn
      ? this.buildLoginCardHtml()
      : `${this.buildTabBarHtml()}${this.buildContentHtml()}`;

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
${csp}
<style>${this.buildCss()}</style>
</head>
<body>
  ${body}
  <script>${this.buildScript()}</script>
</body>
</html>`;
  }

  // ----- 各分区 HTML -----

  private buildLoginCardHtml(): string {
    // 优先级: 浏览器登录助手 > 扫码登录 > 默认登录入口
    if (this.browserLoginState) {
      return this.buildBrowserLoginCardHtml();
    }
    if (this.qrState) {
      return this.buildQrCardHtml();
    }
    return /* html */ `
      <div class="login-card">
        <div class="login-logo">📖</div>
        <h2>微信读书</h2>
        <p class="muted">推荐使用「浏览器登录助手」, 一键复制 cookie, 不用手动拼。</p>
        <div class="login-actions">
          <button class="primary" data-act="browserLogin">浏览器登录助手</button>
          <button class="link-btn" data-act="qrLogin">尝试微信扫码 (Beta)</button>
          <button class="link-btn" data-act="login">手动粘贴 Cookie</button>
        </div>
        <details class="help">
          <summary>关于 Cookie 登录</summary>
          <ol>
            <li>浏览器登录 <code>weread.qq.com</code></li>
            <li>F12 → Application → Cookies → 选 weread.qq.com</li>
            <li>把所有 cookie 拼成 <code>k1=v1; k2=v2; ...</code></li>
            <li>粘贴到弹出的输入框</li>
          </ol>
        </details>
      </div>
    `;
  }

  /**
   * 浏览器登录助手卡片: 三步指引
   *   1) 已为您打开 weread.qq.com → 在浏览器里扫码登录
   *   2) F12 控制台粘贴运行 copy(document.cookie)
   *   3) 回来点「完成登录」, 我们读剪贴板自动导入
   */
  private buildBrowserLoginCardHtml(): string {
    const s = this.browserLoginState!;
    const snippet = 'copy(document.cookie)';
    const verifying = s.step === 'verifying';

    return /* html */ `
      <div class="login-card browser-login">
        <div class="qr-header">
          <span class="login-logo small">🧭</span>
          <span class="qr-title">浏览器登录助手</span>
        </div>
        ${
          s.message
            ? `<p class="qr-tip" style="text-align:center;">${escapeHtml(s.message)}</p>`
            : ''
        }
        <ol class="bl-steps">
          <li>
            <div class="bl-step-text">在浏览器扫码登录 weread.qq.com</div>
            <button class="ghost small" data-act="reopenWeread">重新打开</button>
          </li>
          <li>
            <div class="bl-step-text">登录后按 <code>F12</code> 打开 Console, 粘贴运行:</div>
            <pre class="bl-snippet"><code>${escapeHtml(snippet)}</code></pre>
            <div class="bl-step-hint">(浏览器会把 cookie 复制到剪贴板)</div>
          </li>
          <li>
            <div class="bl-step-text">回到这里点「完成登录」, 我们从剪贴板自动读取</div>
          </li>
        </ol>
        ${
          s.error
            ? `<div class="bl-error">${escapeHtml(s.error)}</div>`
            : ''
        }
        <div class="login-actions row">
          <button class="primary" data-act="finishBrowserLogin" ${verifying ? 'disabled' : ''}>
            ${verifying ? '校验中…' : '完成登录(读剪贴板)'}
          </button>
          <button class="ghost" data-act="cancelBrowserLogin">取消</button>
        </div>
        <div class="login-actions">
          <button class="link-btn" data-act="login">改用手动粘贴 Cookie</button>
        </div>
      </div>
    `;
  }

  private buildQrCardHtml(): string {
    const s = this.qrState!;
    const img = s.qrImageDataUrl
      ? `<img class="qr-img" src="${s.qrImageDataUrl}" alt="二维码" />`
      : `<div class="qr-placeholder"><div class="spinner"></div></div>`;

    const isRunning =
      s.status === 'init' || s.status === 'waiting' || s.status === 'scanned' || s.status === 'confirmed';
    const isRetryable = s.status === 'expired' || s.status === 'failed' || s.status === 'cancelled';
    const isSuccess = s.status === 'success';

    let badge = '';
    let badgeClass = '';
    switch (s.status) {
      case 'init':
        badge = '生成中';
        badgeClass = 'wait';
        break;
      case 'waiting':
        badge = '待扫码';
        badgeClass = 'wait';
        break;
      case 'scanned':
        badge = '已扫描';
        badgeClass = 'scanned';
        break;
      case 'confirmed':
        badge = '已确认';
        badgeClass = 'scanned';
        break;
      case 'success':
        badge = '登录成功';
        badgeClass = 'success';
        break;
      case 'expired':
        badge = '二维码过期';
        badgeClass = 'error';
        break;
      case 'cancelled':
        badge = '已取消';
        badgeClass = 'error';
        break;
      case 'failed':
        badge = '失败';
        badgeClass = 'error';
        break;
    }

    // 失败态: 遮罩里只放短文案, 详细消息留在底部 tip
    const maskShort =
      s.status === 'expired'
        ? '二维码已过期'
        : s.status === 'cancelled'
        ? '已取消'
        : s.status === 'failed'
        ? '登录失败'
        : '';

    return /* html */ `
      <div class="login-card qr">
        <div class="qr-header">
          <span class="login-logo small">📖</span>
          <span class="qr-title">微信扫码登录</span>
          <span class="qr-badge ${badgeClass}">${escapeHtml(badge)}</span>
        </div>
        <div class="qr-frame ${s.status}">
          ${img}
          ${
            maskShort
              ? `<div class="qr-mask"><div class="qr-mask-text">${escapeHtml(maskShort)}</div></div>`
              : ''
          }
        </div>
        <p class="qr-tip">${escapeHtml(s.message ?? '')}</p>
        <div class="login-actions">
          ${
            isSuccess
              ? `<button class="primary" disabled>登录成功</button>`
              : isRunning
              ? `<button class="ghost" data-act="cancelQrLogin">取消</button>`
              : isRetryable
              ? `<button class="primary" data-act="browserLogin">改用浏览器登录助手</button>
                 <button class="link-btn" data-act="qrLogin">再试一次扫码</button>
                 <button class="link-btn" data-act="login">手动粘贴 Cookie</button>`
              : ''
          }
        </div>
      </div>
    `;
  }

  private buildTabBarHtml(): string {
    // "在读" tab 的 label: 有书时直接显示书名(随作者作 tooltip), 没书时显示"在读"
    const book = this.currentBook;
    const readerLabel = book?.title
      ? escapeHtml(book.title)
      : '在读';
    const readerTooltip = book
      ? `${book.title ?? ''}${book.author ? ' · ' + book.author : ''}`
      : '正在阅读';
    const readerHasBook = !!this.currentBook;

    return /* html */ `
      <nav class="tabbar ${this.tab === 'reader' && readerHasBook ? 'reader-active' : ''}">
        <div class="tabs">
          <button class="tab ${this.tab === 'shelf' ? 'active' : ''}" data-tab="shelf" title="我的书架">
            <span class="icon">📚</span><span class="label">书架</span>
          </button>
          <button class="tab tab-reader ${this.tab === 'reader' ? 'active' : ''}" data-tab="reader" title="${escapeAttr(readerTooltip)}" ${readerHasBook ? '' : 'disabled'}>
            <span class="icon">📖</span><span class="label">${readerLabel}</span>
          </button>
        </div>
        <div class="actions">
          ${
            this.tab === 'shelf'
              ? `<button class="icon-btn" data-act="expandAll" title="全部展开">▾</button>
                 <button class="icon-btn" data-act="collapseAll" title="全部折叠">▸</button>
                 <button class="icon-btn" data-act="refreshShelf" title="刷新书架">⟳</button>`
              : ''
          }
          ${this.tab === 'reader' && this.currentBook ? `<button class="icon-btn" data-act="openInBrowser" title="在浏览器打开">↗</button>` : ''}
        </div>
      </nav>
    `;
  }

  private buildContentHtml(): string {
    if (this.tab === 'shelf') return this.buildShelfHtml();
    return this.buildReaderHtml();
  }

  // ----- 书架 -----

  private buildShelfHtml(): string {
    if (this.shelfLoading) {
      return `<main class="content shelf"><div class="hint">${this.skeletonHtml()}</div></main>`;
    }
    if (this.shelfError) {
      return `<main class="content shelf">
        <div class="error-card">
          <h4>加载失败</h4>
          <p>${escapeHtml(this.shelfError)}</p>
          <button class="ghost" data-act="refreshShelf">重试</button>
        </div>
      </main>`;
    }
    if (this.books.length === 0) {
      return `<main class="content shelf"><div class="empty"><p>书架为空</p></div></main>`;
    }

    const groups = this.computeGroups();

    const sections = groups
      .map((g) => {
        const expanded = this.expandedGroups.has(g.name);
        const arrow = expanded ? '▾' : '▸';
        const body = expanded
          ? `<div class="book-list">${g.books.map((b) => this.bookCardHtml(b)).join('')}</div>`
          : '';
        return `<section class="shelf-section ${expanded ? 'open' : 'closed'}">
          <button class="shelf-section-title" data-toggle="${escapeAttr(g.name)}">
            <span class="arrow">${arrow}</span>
            <span class="name">${escapeHtml(g.name)}</span>
            <span class="count">${g.books.length}</span>
          </button>
          ${body}
        </section>`;
      })
      .join('');

    return `<main class="content shelf">${sections}</main>`;
  }

  /**
   * 把书架按用户自建分组分桶。
   *   - 每个 archive 是一个分组(顺序保持服务端给的顺序)
   *   - 不在任何 archive 中的书 → "未分组"
   *   - 全空时仍保留"全部"作为兜底, 避免出现"啥都不显示"
   */
  private computeGroups(): { name: string; books: WereadBook[] }[] {
    const bookMap = new Map(this.books.map((b) => [b.bookId, b]));
    const assigned = new Set<string>();
    const groups: { name: string; books: WereadBook[] }[] = [];

    for (const a of this.archives) {
      const items: WereadBook[] = [];
      for (const id of a.bookIds) {
        const b = bookMap.get(id);
        if (b) {
          items.push(b);
          assigned.add(id);
        }
      }
      if (items.length > 0) {
        groups.push({ name: a.name, books: items });
      }
    }

    const unassigned = this.books.filter((b) => !assigned.has(b.bookId));
    if (unassigned.length > 0) {
      groups.push({
        name: this.archives.length > 0 ? '未分组' : '全部',
        books: unassigned,
      });
    }
    return groups;
  }

  /** "全部展开 / 全部折叠"按钮用 */
  private computeGroupNames(): string[] {
    return this.computeGroups().map((g) => g.name);
  }

  private bookCardHtml(b: WereadBook): string {
    const cover = typeof b.cover === 'string' && b.cover ? escapeAttr(b.cover) : '';
    const coverHtml = cover
      ? `<img class="cover" src="${cover}" alt="" onerror="this.style.display='none';this.parentNode.classList.add('no-cover');" />`
      : '';
    const progress =
      typeof b.progress === 'number' && b.progress > 0
        ? `<span class="progress">${b.progress}%</span>`
        : b.finished
        ? `<span class="progress done">已读完</span>`
        : '';
    return `
      <button class="book-card" data-book-id="${escapeAttr(b.bookId)}" title="${escapeAttr(b.title ?? '')}">
        <div class="cover-wrap ${cover ? '' : 'no-cover'}">${coverHtml}<div class="cover-fallback">${escapeHtml((b.title ?? '?').slice(0, 1))}</div></div>
        <div class="meta">
          <div class="title">${escapeHtml(b.title ?? '(未命名)')}</div>
          <div class="author">${escapeHtml(b.author ?? '')}</div>
          ${progress}
        </div>
      </button>
    `;
  }

  // ----- 阅读器 -----

  private buildReaderHtml(): string {
    if (!this.currentBook) {
      return `<main class="content reader"><div class="empty"><p>请在<a href="#" data-tab="shelf">书架</a>里选一本书。</p></div></main>`;
    }

    const book = this.currentBook;
    const chapters = this.currentChapters;
    const idx = this.currentChapterIdx;
    const currentChapter = idx >= 0 ? chapters[idx] : undefined;

    // 目录抽屉本体(fixed 定位, 放在 main 内任意位置都可以)
    const tocDrawer = chapters.length ? this.buildTocDrawerHtml(chapters, idx) : '';

    // 正文
    let articleHtml = '';
    if (this.chapterLoading) {
      articleHtml = `<article class="reading">${this.skeletonHtml(8)}</article>`;
    } else if (this.chapterFetch?.html) {
      const style = this.chapterFetch.style ? `<style>${this.chapterFetch.style}</style>` : '';
      const titleBlock = currentChapter
        ? `<h2 class="ch-title">${escapeHtml(currentChapter.title)}</h2>`
        : '';
      articleHtml = `<article class="reading rich">${style}${titleBlock}<div class="rich-body">${this.chapterFetch.html}</div></article>`;
    } else if (this.chapterFetch?.content) {
      const paragraphs = this.chapterFetch.content
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
        .join('');
      const titleBlock = currentChapter
        ? `<h2 class="ch-title">${escapeHtml(currentChapter.title)}</h2>`
        : '';
      articleHtml = `<article class="reading">${titleBlock}${paragraphs}</article>`;
    } else if (this.chapterFetch) {
      articleHtml = `
        <div class="reading unavailable">
          <h4>未能在 VSCode 内获取本章内容</h4>
          <p class="muted">可能是付费章节、试读限制或接口变更, 您可以在浏览器中阅读。</p>
          <div class="actions">
            <button class="primary" data-act="openInBrowser">在浏览器打开</button>
            <button class="ghost" data-act="retry">重试</button>
          </div>
          <details class="diag">
            <summary>诊断信息</summary>
            <pre>${escapeHtml(this.chapterFetch.diagnostics || '(无)')}\n\n章节: ${escapeHtml(currentChapter?.title ?? '')} (uid=${currentChapter?.chapterUid ?? ''})\n格式: ${escapeHtml(this.chapterFetch.format ?? '(未知)')}</pre>
          </details>
        </div>
      `;
    } else {
      articleHtml = '<article class="reading"><p class="hint">尚未加载</p></article>';
    }

    const prevDisabled = idx <= 0;
    const nextDisabled = idx < 0 || idx >= chapters.length - 1;

    // 底部目录入口: 替代原来的纯文字"x/y · 章名", 点击弹出目录抽屉
    const tocBtnLabel = currentChapter
      ? escapeHtml(currentChapter.title || `第 ${idx + 1} 章`)
      : '目录';
    const tocBtnTooltip = currentChapter
      ? `${currentChapter.title} · 第 ${idx + 1}/${chapters.length} 章 · 点击打开目录`
      : '打开目录';
    const tocFooterBtn = chapters.length
      ? `<button class="toc-trigger footer-toc" id="toc-trigger" title="${escapeAttr(tocBtnTooltip)}">
          <span class="toc-icon">📑</span>
          <span class="toc-current">${tocBtnLabel}</span>
          <span class="toc-counter">${idx + 1}/${chapters.length}</span>
        </button>`
      : `<span class="footer-mid"></span>`;

    const footer = `
      <footer class="reader-footer">
        <button class="ghost" data-act="prev" ${prevDisabled ? 'disabled' : ''}>◀ 上一章</button>
        ${tocFooterBtn}
        <button class="ghost" data-act="next" ${nextDisabled ? 'disabled' : ''}>下一章 ▶</button>
      </footer>
    `;

    return `<main class="content reader"><div class="reader-body">${articleHtml}</div>${footer}${tocDrawer}</main>`;
  }

  /**
   * 章节目录抽屉(从右侧滑出, 全 client-side 控制开关)。
   * - 当前章节加 active 类, 自动 scrollIntoView
   * - 章节按 level 缩进
   * - 顶部输入框做即时过滤(纯 client-side)
   */
  private buildTocDrawerHtml(chapters: WereadChapter[], activeIdx: number): string {
    const items = chapters
      .map((c, i) => {
        const lvl = Math.max(0, Math.min(4, (c.level ?? 1) - 1));
        const isActive = i === activeIdx;
        const title = c.title || `第 ${i + 1} 章`;
        const subBadge = c.paid ? `<span class="toc-badge paid">付费</span>` : '';
        return `
          <li class="toc-item ${isActive ? 'active' : ''}" data-toc-idx="${i}" data-toc-key="${escapeAttr(
          title.toLowerCase(),
        )}" data-level="${lvl}">
            <span class="toc-row" style="padding-left:${10 + lvl * 14}px">
              <span class="toc-no">${String(i + 1).padStart(2, '0')}</span>
              <span class="toc-name" title="${escapeAttr(title)}">${escapeHtml(title)}</span>
              ${subBadge}
            </span>
          </li>`;
      })
      .join('');

    return `
      <div class="toc-backdrop" id="toc-backdrop"></div>
      <aside class="toc-drawer" id="toc-drawer" aria-hidden="true">
        <header class="toc-head">
          <div class="toc-head-title">
            <span class="toc-head-name">目录</span>
            <span class="toc-head-count">${chapters.length} 章</span>
          </div>
          <button class="toc-close" id="toc-close" title="关闭">✕</button>
        </header>
        <div class="toc-search-wrap">
          <input id="toc-search" class="toc-search" type="text" placeholder="搜索章节…" autocomplete="off" spellcheck="false" />
        </div>
        <ul class="toc-list" id="toc-list">${items}</ul>
        <div class="toc-empty" id="toc-empty" hidden>无匹配章节</div>
      </aside>
    `;
  }

  // ----- 工具 HTML -----

  /** 骨架屏占位 */
  private skeletonHtml(lines = 4): string {
    let html = '';
    for (let i = 0; i < lines; i++) {
      const w = 60 + Math.floor(Math.random() * 35);
      html += `<div class="skeleton-line" style="width:${w}%"></div>`;
    }
    return `<div class="skeleton">${html}</div>`;
  }

  // ----- CSS / Script -----

  private buildCss(): string {
    return /* css */ `
      :root { color-scheme: light dark; }
      *, *::before, *::after { box-sizing: border-box; }
      html, body { margin:0; padding:0; height:100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC",
          "Microsoft YaHei", "Hiragino Sans GB", system-ui, sans-serif;
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        font-size: 13px;
        line-height: 1.55;
        display: flex; flex-direction: column;
        height: 100vh;
      }
      a { color: var(--vscode-textLink-foreground); text-decoration: none; }
      a:hover { text-decoration: underline; }
      button { font: inherit; cursor: pointer; }
      ::-webkit-scrollbar { width: 8px; height: 8px; }
      ::-webkit-scrollbar-thumb { background: rgba(127,127,127,.35); border-radius: 4px; }
      ::-webkit-scrollbar-thumb:hover { background: rgba(127,127,127,.55); }
      .muted { color: var(--vscode-descriptionForeground); }
      .hint { color: var(--vscode-descriptionForeground); padding: 8px 0; }
      .empty { padding: 24px 14px; color: var(--vscode-descriptionForeground); text-align: center; }

      /* ====== 顶部 TabBar ====== */
      .tabbar {
        flex-shrink: 0;
        display: flex; align-items: center; justify-content: space-between;
        padding: 4px 6px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBarSectionHeader-background, transparent);
      }
      .tabbar .tabs { display: flex; gap: 2px; min-width: 0; flex: 0 1 auto; }
      /* 阅读 tab 激活时, 让 tabs 区拉伸占据剩余空间, 给长书名留位 */
      .tabbar.reader-active .tabs { flex: 1 1 auto; }
      .tabbar .tab {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 4px 10px; font-size: 12px;
        background: transparent; color: var(--vscode-foreground);
        border: none; border-radius: 4px;
        opacity: .65; transition: all .15s ease;
        min-width: 0;
      }
      .tabbar .tab .icon { font-size: 13px; flex-shrink: 0; }
      .tabbar .tab .label {
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .tabbar .tab:hover:not([disabled]) { opacity: .9; background: var(--vscode-list-hoverBackground); }
      .tabbar .tab.active {
        opacity: 1; font-weight: 600;
        background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
        color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
      }
      .tabbar .tab[disabled] { opacity: .35; cursor: not-allowed; }
      /* 阅读 tab 显示书名时占据可用空间, 用 ellipsis 截断 */
      .tab-reader { min-width: 0; }
      .tabbar.reader-active .tab-reader.active {
        flex: 1 1 auto;
        max-width: 260px;
      }
      .tabbar .actions { display: flex; gap: 4px; flex-shrink: 0; }
      .tabbar .icon-btn {
        width: 24px; height: 24px; padding: 0;
        background: transparent; color: var(--vscode-foreground);
        border: none; border-radius: 4px;
        font-size: 14px; opacity: .7;
      }
      .tabbar .icon-btn:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }

      .content { flex: 1; overflow-y: auto; overflow-x: hidden; }

      /* ====== 书架 ====== */
      .shelf { padding: 4px 6px 14px; }
      .shelf-section { margin-top: 2px; }
      .shelf-section-title {
        display: flex; align-items: center; gap: 6px;
        width: 100%; margin: 0; padding: 5px 6px;
        background: transparent; color: var(--vscode-foreground);
        border: none; border-radius: 4px;
        text-align: left; font-size: 12px; font-weight: 600;
        letter-spacing: .02em;
        cursor: pointer; transition: background .12s ease;
      }
      .shelf-section-title:hover {
        background: var(--vscode-list-hoverBackground);
      }
      .shelf-section-title .arrow {
        display: inline-block; width: 12px; font-size: 10px; opacity: .7;
        transition: transform .15s ease;
      }
      .shelf-section-title .name {
        flex: 1; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .shelf-section-title .count {
        font-size: 10.5px; font-weight: 400;
        padding: 0 6px; border-radius: 8px;
        background: rgba(127,127,127,.18);
        color: var(--vscode-descriptionForeground);
      }
      .book-list {
        display: flex; flex-direction: column; gap: 2px;
        padding: 2px 0 4px 14px;
      }
      .book-card {
        display: flex; align-items: center; gap: 10px;
        width: 100%; padding: 6px 8px;
        background: transparent; color: inherit;
        border: 1px solid transparent; border-radius: 6px;
        text-align: left; transition: all .12s ease;
      }
      .book-card:hover {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-contrastBorder, transparent);
      }
      .cover-wrap {
        position: relative; flex-shrink: 0;
        width: 36px; height: 50px;
        border-radius: 3px; overflow: hidden;
        background: linear-gradient(135deg, #6e8efb, #a777e3);
        box-shadow: 0 1px 3px rgba(0,0,0,.15);
      }
      .cover-wrap .cover { width: 100%; height: 100%; object-fit: cover; display: block; }
      .cover-wrap .cover-fallback {
        position: absolute; inset: 0;
        display: none; align-items: center; justify-content: center;
        color: rgba(255,255,255,.92); font-weight: 600; font-size: 18px;
      }
      .cover-wrap.no-cover .cover-fallback { display: flex; }
      .meta { flex: 1; min-width: 0; }
      .meta .title {
        font-size: 13px; font-weight: 500;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .meta .author {
        font-size: 11px; color: var(--vscode-descriptionForeground);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        margin-top: 1px;
      }
      .meta .progress {
        display: inline-block; margin-top: 2px;
        padding: 0 6px; font-size: 10px;
        border-radius: 8px;
        background: var(--vscode-badge-background, rgba(127,127,127,.18));
        color: var(--vscode-badge-foreground, inherit);
      }
      .meta .progress.done {
        background: rgba(60, 180, 120, .25); color: rgb(60,180,120);
      }

      /* ====== 阅读器 ====== */
      .reader {
        display: flex; flex-direction: column;
        padding: 0; height: 100%;
      }
      /* ---- 目录触发按钮(嵌在底部 footer 中间, 替代原来的纯文字章节名) ---- */
      .toc-trigger.footer-toc {
        flex: 1; min-width: 0;
        display: inline-flex; align-items: center; gap: 6px;
        padding: 3px 8px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 4px;
        color: var(--vscode-foreground);
        font-size: 11.5px;
        text-align: left;
        cursor: pointer;
        transition: all .15s ease;
        max-width: 100%;
      }
      .toc-trigger.footer-toc:hover {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-panel-border);
      }
      .toc-trigger.footer-toc .toc-icon {
        font-size: 12px; opacity: .75; flex-shrink: 0;
      }
      .toc-trigger.footer-toc .toc-current {
        flex: 1; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        text-align: center;
      }
      .toc-trigger.footer-toc .toc-counter {
        flex-shrink: 0;
        font-size: 10px; font-variant-numeric: tabular-nums;
        padding: 0 5px; border-radius: 7px;
        background: rgba(127,127,127,.18);
        color: var(--vscode-descriptionForeground);
      }

      /* ---- 目录抽屉 ---- */
      .toc-backdrop {
        position: fixed; inset: 0;
        background: rgba(0, 0, 0, .42);
        backdrop-filter: blur(2px);
        opacity: 0; pointer-events: none;
        transition: opacity .22s ease;
        z-index: 90;
      }
      .toc-backdrop.open { opacity: 1; pointer-events: auto; }

      .toc-drawer {
        position: fixed;
        top: 0; right: 0; bottom: 0;
        width: min(86vw, 320px);
        background: var(--vscode-sideBar-background);
        border-left: 1px solid var(--vscode-panel-border);
        box-shadow: -6px 0 28px rgba(0,0,0,.32);
        transform: translateX(100%);
        transition: transform .26s cubic-bezier(.4, 0, .2, 1);
        display: flex; flex-direction: column;
        z-index: 100;
      }
      .toc-drawer.open { transform: translateX(0); }

      .toc-head {
        flex-shrink: 0;
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 14px 10px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .toc-head-title { display: flex; align-items: baseline; gap: 8px; }
      .toc-head-name { font-size: 14px; font-weight: 600; letter-spacing: .04em; }
      .toc-head-count {
        font-size: 10.5px;
        padding: 1px 7px; border-radius: 8px;
        background: rgba(127,127,127,.18);
        color: var(--vscode-descriptionForeground);
        font-variant-numeric: tabular-nums;
      }
      .toc-close {
        width: 26px; height: 26px;
        background: transparent; border: none;
        border-radius: 4px;
        color: var(--vscode-foreground); opacity: .65;
        font-size: 14px;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .toc-close:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }

      .toc-search-wrap {
        flex-shrink: 0;
        padding: 8px 12px 6px;
        border-bottom: 1px solid transparent;
      }
      .toc-search {
        width: 100%; padding: 5px 9px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 4px;
        font-size: 12px;
        outline: none;
        transition: border-color .12s ease;
      }
      .toc-search:focus {
        border-color: var(--vscode-focusBorder);
      }

      .toc-list {
        flex: 1; overflow-y: auto;
        list-style: none; margin: 0; padding: 4px 0 12px;
      }
      .toc-item {
        display: block; position: relative;
        cursor: pointer;
        transition: background .12s ease;
      }
      /* 修正: .toc-item 设了 display:block, 会覆盖 UA 默认的 [hidden]{display:none},
         导致 filterToc 里 li.hidden = true 不生效, 这里显式拉高优先级 */
      .toc-item[hidden] { display: none !important; }
      .toc-item .toc-row {
        display: flex; align-items: center; gap: 8px;
        padding: 7px 12px 7px 10px;
        min-height: 28px;
        font-size: 12.5px; line-height: 1.4;
      }
      .toc-item .toc-no {
        font-size: 10.5px;
        font-variant-numeric: tabular-nums;
        color: var(--vscode-descriptionForeground);
        opacity: .65; flex-shrink: 0;
        width: 22px; text-align: right;
      }
      .toc-item .toc-name {
        flex: 1; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .toc-item .toc-badge {
        flex-shrink: 0;
        font-size: 9.5px; padding: 0 5px; border-radius: 6px;
        background: rgba(220, 165, 60, .25); color: rgb(210, 140, 30);
      }
      .toc-item[data-level="0"] .toc-name { font-weight: 600; }
      .toc-item:hover { background: var(--vscode-list-hoverBackground); }
      .toc-item.active {
        background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
        color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
      }
      .toc-item.active .toc-name { font-weight: 600; }
      .toc-item.active::before {
        content: '';
        position: absolute; left: 0; top: 4px; bottom: 4px;
        width: 3px; border-radius: 0 2px 2px 0;
        background: var(--vscode-focusBorder, rgb(60,160,230));
      }
      .toc-item.active .toc-no { opacity: 1; color: inherit; }

      .toc-empty {
        padding: 18px 14px;
        text-align: center;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .reader-body {
        flex: 1; overflow-y: auto;
        padding: 18px 18px 24px;
      }
      .reading {
        max-width: 720px; margin: 0 auto;
        font-family: -apple-system, "Songti SC", "STSong", "Source Han Serif SC",
          "Noto Serif SC", Georgia, "Times New Roman", serif;
        font-size: 15px; line-height: 1.95;
        color: var(--vscode-foreground);
      }
      .reading .ch-title {
        margin: 0 0 22px; font-size: 18px; font-weight: 600;
        text-align: center; letter-spacing: .04em;
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        padding-bottom: 14px;
        background: linear-gradient(to right,
          transparent 0%,
          var(--vscode-panel-border) 30%,
          var(--vscode-panel-border) 70%,
          transparent 100%) no-repeat bottom / 100% 1px;
      }
      .reading p { margin: 0 0 0.95em; text-indent: 2em; }
      .reading p:first-of-type::first-letter { font-size: 1.05em; }
      .reading img { max-width: 100%; height: auto; display: block; margin: 14px auto; }

      /* 富 HTML(epub) 兜底, 解除微信读书内置宽度/字体限制 */
      .reading.rich .rich-body,
      .reading.rich .rich-body * {
        max-width: 100% !important;
        width: auto !important;
        color: inherit !important;
        background: transparent !important;
        font-family: inherit !important;
      }
      .reading.rich .rich-body img { height: auto !important; }
      .reading.rich .rich-body p {
        margin: 0 0 0.95em; text-indent: 2em;
      }

      .reading.unavailable { font-family: inherit; font-size: 13px; line-height: 1.6; }
      .reading.unavailable h4 { margin: 0 0 8px; font-size: 13px; }
      .reading.unavailable .actions { display: flex; gap: 8px; margin: 10px 0 14px; }
      .reading.unavailable details.diag { margin-top: 16px; }
      .reading.unavailable details.diag summary {
        cursor: pointer; font-size: 11px;
        color: var(--vscode-textLink-foreground);
      }
      .reading.unavailable details.diag pre {
        background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.08));
        padding: 8px; border-radius: 4px; font-size: 11px;
        max-height: 240px; overflow: auto;
        white-space: pre-wrap; word-break: break-all;
      }

      .reader-footer {
        flex-shrink: 0;
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; padding: 6px 8px;
        border-top: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBarSectionHeader-background, transparent);
      }
      .reader-footer .footer-mid {
        flex: 1; text-align: center; font-size: 10.5px;
        color: var(--vscode-descriptionForeground);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }

      /* ====== 按钮通用 ====== */
      button.primary, button.ghost {
        font-size: 12px; padding: 5px 12px; border-radius: 4px;
        transition: background .12s ease;
      }
      button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: 1px solid transparent;
      }
      button.primary:hover { background: var(--vscode-button-hoverBackground); }
      button.ghost {
        background: transparent; color: var(--vscode-foreground);
        border: 1px solid var(--vscode-panel-border);
      }
      button.ghost:hover:not([disabled]) { background: var(--vscode-list-hoverBackground); }
      button[disabled] { opacity: .4; cursor: not-allowed; }

      /* ====== 登录卡片 ====== */
      .login-card {
        margin: 24px 16px; padding: 22px 18px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        background: var(--vscode-editor-background, transparent);
        text-align: center;
      }
      .login-card .login-logo { font-size: 32px; margin-bottom: 6px; }
      .login-card .login-logo.small { font-size: 16px; margin: 0; }
      .login-card h2 { margin: 4px 0 8px; font-size: 16px; }
      .login-card p.muted { font-size: 12px; margin: 0 0 14px; line-height: 1.5; }
      .login-card button.primary { padding: 6px 16px; }
      .login-card .login-actions {
        display: flex; flex-direction: column; gap: 8px; align-items: center;
        margin: 4px 0;
      }
      .login-card .link-btn {
        background: transparent; border: none; padding: 0;
        color: var(--vscode-textLink-foreground); font-size: 11.5px;
        cursor: pointer;
      }
      .login-card .link-btn:hover { text-decoration: underline; }
      .login-card details.help { margin-top: 16px; text-align: left; }
      .login-card details.help summary {
        cursor: pointer; font-size: 11px;
        color: var(--vscode-textLink-foreground);
      }
      .login-card details.help ol {
        font-size: 11.5px; line-height: 1.7; padding-left: 20px; margin-top: 6px;
      }
      .login-card code {
        font-family: var(--vscode-editor-font-family, monospace);
        background: rgba(127,127,127,.18); padding: 0 4px; border-radius: 3px;
        font-size: 11px;
      }

      /* ====== 扫码卡片 ====== */
      .login-card.qr { padding: 14px 14px 18px; }
      .qr-header {
        display: flex; align-items: center; justify-content: center;
        gap: 8px; margin-bottom: 12px;
      }
      .qr-title { font-size: 13px; font-weight: 600; }
      .qr-badge {
        font-size: 10px; padding: 1px 8px;
        border-radius: 8px; font-weight: 500;
      }
      .qr-badge.wait { background: rgba(127,127,127,.2); color: var(--vscode-descriptionForeground); }
      .qr-badge.scanned { background: rgba(60, 160, 230, .25); color: rgb(60, 160, 230); }
      .qr-badge.success { background: rgba(60, 180, 120, .25); color: rgb(60, 180, 120); }
      .qr-badge.error { background: rgba(220, 90, 90, .22); color: rgb(220, 90, 90); }
      .qr-frame {
        position: relative; width: 180px; height: 180px;
        margin: 0 auto 12px;
        background: #fff;
        border-radius: 6px;
        box-shadow: 0 1px 6px rgba(0,0,0,.18);
        overflow: hidden;
      }
      .qr-frame .qr-img { width: 100%; height: 100%; display: block; }
      .qr-placeholder {
        width: 100%; height: 100%;
        display: flex; align-items: center; justify-content: center;
        background: #fafafa;
      }
      .spinner {
        width: 28px; height: 28px;
        border: 3px solid rgba(127,127,127,.2);
        border-top-color: var(--vscode-progressBar-background, #1976d2);
        border-radius: 50%;
        animation: spin .8s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .qr-frame .qr-mask {
        position: absolute; inset: 0;
        background: rgba(0,0,0,.55);
        display: flex; align-items: center; justify-content: center;
      }
      .qr-frame .qr-mask-text {
        color: #fff; font-size: 12px; text-align: center; padding: 0 14px;
      }
      .qr-frame.scanned .qr-img,
      .qr-frame.confirmed .qr-img {
        filter: brightness(.7);
      }
      .qr-frame.scanned::after, .qr-frame.confirmed::after {
        content: '✓';
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        font-size: 56px; color: rgb(60, 180, 120);
        font-weight: 800;
      }
      .qr-tip {
        margin: 0 0 12px;
        padding: 0 4px;
        font-size: 11.5px; line-height: 1.5;
        color: var(--vscode-descriptionForeground);
        min-height: 1.5em;
        word-break: break-all;
        white-space: pre-wrap;
        max-height: 9em; overflow-y: auto;
      }

      /* ====== 浏览器登录助手卡片 ====== */
      .login-card.browser-login { text-align: left; padding: 14px 14px 18px; }
      .login-card.browser-login .qr-header { justify-content: flex-start; margin-bottom: 8px; }
      .bl-steps {
        margin: 8px 0 6px; padding-left: 22px;
        font-size: 12px; line-height: 1.6;
      }
      .bl-steps > li { margin-bottom: 10px; }
      .bl-steps > li:last-child { margin-bottom: 0; }
      .bl-step-text { margin-bottom: 4px; }
      .bl-step-hint {
        font-size: 11px; color: var(--vscode-descriptionForeground);
        margin-top: 4px;
      }
      .bl-snippet {
        margin: 4px 0 0; padding: 6px 8px;
        background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12));
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        overflow-x: auto;
        white-space: pre;
      }
      .bl-snippet code { color: var(--vscode-textPreformat-foreground, inherit); }
      .bl-error {
        margin: 8px 0;
        padding: 8px 10px;
        background: var(--vscode-inputValidation-errorBackground, rgba(220, 90, 90, .12));
        border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(220, 90, 90, .4));
        color: var(--vscode-errorForeground, rgb(220, 90, 90));
        border-radius: 4px;
        font-size: 11.5px;
        line-height: 1.5;
        word-break: break-all;
      }
      button.ghost.small {
        font-size: 10.5px; padding: 2px 8px;
      }
      .login-actions.row {
        flex-direction: row; justify-content: center;
      }

      /* ====== 错误卡片 ====== */
      .error-card {
        margin: 14px; padding: 12px 14px;
        border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
        border-radius: 6px;
        background: var(--vscode-inputValidation-errorBackground, transparent);
      }
      .error-card h4 { margin: 0 0 6px; font-size: 12px; color: var(--vscode-errorForeground); }
      .error-card p { margin: 0 0 8px; font-size: 12px; }

      /* ====== 骨架屏 ====== */
      .skeleton { padding: 14px; }
      .skeleton-line {
        height: 12px; margin: 0 0 10px;
        background: linear-gradient(90deg,
          rgba(127,127,127,.12) 25%,
          rgba(127,127,127,.22) 50%,
          rgba(127,127,127,.12) 75%);
        background-size: 200% 100%;
        border-radius: 3px;
        animation: shimmer 1.4s linear infinite;
      }
      @keyframes shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    `;
  }

  private buildScript(): string {
    return /* js */ `
      const vscode = acquireVsCodeApi();
      function post(type, payload) { vscode.postMessage({ type, payload }); }

      // tabbar tab 切换
      document.querySelectorAll('.tabbar .tab').forEach(el => {
        el.addEventListener('click', () => {
          const tab = el.getAttribute('data-tab');
          if (tab) post('switchTab', { tab });
        });
      });

      // 顶部 icon-btn 通用动作分发
      document.querySelectorAll('.tabbar .icon-btn, [data-act]').forEach(el => {
        el.addEventListener('click', (ev) => {
          ev.preventDefault();
          const act = el.getAttribute('data-act');
          if (act) post(act);
        });
      });

      // 书架卡片点击
      document.querySelectorAll('.book-card').forEach(el => {
        el.addEventListener('click', () => {
          const bookId = el.getAttribute('data-book-id');
          if (bookId) post('openBook', { bookId });
        });
      });

      // 书架分组折叠/展开
      document.querySelectorAll('.shelf-section-title[data-toggle]').forEach(el => {
        el.addEventListener('click', () => {
          const name = el.getAttribute('data-toggle');
          if (name) post('toggleGroup', { name });
        });
      });

      // ===== 章节目录抽屉 =====
      (function setupToc() {
        const trigger = document.getElementById('toc-trigger');
        const drawer = document.getElementById('toc-drawer');
        const backdrop = document.getElementById('toc-backdrop');
        const close = document.getElementById('toc-close');
        const list = document.getElementById('toc-list');
        const search = document.getElementById('toc-search');
        const empty = document.getElementById('toc-empty');
        if (!drawer || !list) return;

        function openDrawer() {
          drawer.classList.add('open');
          backdrop && backdrop.classList.add('open');
          drawer.setAttribute('aria-hidden', 'false');
          // 自动滚动到当前章节
          const active = list.querySelector('.toc-item.active');
          if (active) {
            requestAnimationFrame(() => {
              try { active.scrollIntoView({ block: 'center', behavior: 'instant' }); }
              catch { active.scrollIntoView({ block: 'center' }); }
            });
          }
          // 焦点到搜索框, 方便快速过滤
          setTimeout(() => { search && search.focus(); }, 100);
        }
        function closeDrawer() {
          drawer.classList.remove('open');
          backdrop && backdrop.classList.remove('open');
          drawer.setAttribute('aria-hidden', 'true');
          // 清空搜索状态
          if (search) {
            search.value = '';
            filterToc('');
          }
        }
        function filterToc(q) {
          const kw = (q || '').trim().toLowerCase();
          let hit = 0;
          list.querySelectorAll('.toc-item').forEach(li => {
            const key = li.getAttribute('data-toc-key') || '';
            const ok = !kw || key.indexOf(kw) >= 0;
            li.hidden = !ok;
            if (ok) hit++;
          });
          if (empty) empty.hidden = hit !== 0;
        }

        trigger && trigger.addEventListener('click', openDrawer);
        close && close.addEventListener('click', closeDrawer);
        backdrop && backdrop.addEventListener('click', closeDrawer);
        search && search.addEventListener('input', (e) => filterToc(e.target.value));
        // ESC 关闭
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
        });
        // 点击章节
        list.addEventListener('click', (e) => {
          const li = e.target && e.target.closest && e.target.closest('.toc-item');
          if (!li) return;
          const idx = Number(li.getAttribute('data-toc-idx'));
          if (Number.isInteger(idx)) {
            closeDrawer();
            post('selectChapter', { idx });
          }
        });
      })();

      // 空状态里"去书架"的链接
      document.querySelectorAll('a[data-tab]').forEach(el => {
        el.addEventListener('click', (ev) => {
          ev.preventDefault();
          post('switchTab', { tab: el.getAttribute('data-tab') });
        });
      });
    `;
  }
}

function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}
