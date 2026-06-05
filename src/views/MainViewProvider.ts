import * as vscode from 'vscode';
import { WereadClient, ChapterFetchResult } from '../api/WereadClient';
import { AuthService } from '../auth/AuthService';
import {
  BestBookmark,
  BookProgress,
  ChapterUnderline,
  Review,
  WereadArchive,
  WereadBook,
  WereadChapter,
} from '../types';
import { getBookReaderUrl, getChapterReaderUrl } from '../api/wereadUrl';

type Tab = 'shelf' | 'reader';
/** "想法"抽屉里 3 个 tab */
type ReviewsTab = 'chapter' | 'hotmarks' | 'book';

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
  // 注意: 这个 id 必须与 package.json 的 views[wereadVscode][0].id 保持一致。
  // 历史曾用 'weread.main', 与社区里另一个微信读书插件的 view 撞了 ID, 导致两个插件
  // 共享同一个 activitybar container, 用户禁用另一个时本插件也跟着消失。
  // 改成带 publisher 前缀风格的 'wereadVscode.main' 避免冲突。
  public static readonly viewType = 'wereadVscode.main';

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
  /**
   * v0.0.6 异步流水线 cache: 完整处理过的章节 HTML
   *   (decode entity → injectUnderlines → sanitize → transformFootnotes → rewriteImage)
   *
   * 为什么独立一个字段而不是 mutate chapterFetch.html?
   *   - inject underlines 的 range 是相对**原始 HTML**的字符偏移, image rewrite
   *     会把 https URL 换成超长 base64 dataURL, 一旦改 chapterFetch.html, range 就全错位
   *     (会切到 base64 中间, 注入 <span> 破坏 img 标签结构, 屏幕显示一长串 base64 文本)
   *   - 保留原始 html 在 chapterFetch.html, prepared 单独缓存, 互不污染
   *
   * 时序:
   *   - loadCurrentChapter 拉到 res.html(原始) → 存 chapterFetch.html, **不改图**
   *   - buildReaderHtml 渲染时若 preparedChapterHtml 命中 → 直接用(含图+划线)
   *     否则走兜底 pipeline(decode/inject/sanitize/transform, 不含 image rewrite, 首屏快)
   *   - loadChapterReviews 拉完 underlines → fire-and-forget 跑 prepareChapterHtml
   *     → preparedChapterHtml 填上 → render → 二次渲染替换成"含图 + 含划线"完整版
   */
  private preparedChapterHtml: string | null = null;
  private preparedChapterUid: number | string | null = null;
  /** 异步操作 token, 用于丢弃过期回包 */
  private loadToken = 0;
  /**
   * 打开某本书时, 用云端进度里的 chapterUid 来定位章节。
   * 在 loadBookInternal 内消费一次后置 undefined。
   */
  private pendingRestoreChapterUid: number | undefined;
  /** 上次上报云端阅读进度的时间, 简单节流 */
  private lastReportAt = 0;

  // ---- 社交内容状态(只读) ----
  /** 当前章节的"想法"列表 */
  private currentChapterReviews: Review[] = [];
  /** 当前章节的"热门划线"(很多人都划的句子) */
  private currentBestBookmarks: BestBookmark[] = [];
  /**
   * 当前章节的"章节级热门划线"(/web/book/underlines, touchFish 同款)。
   * 这个接口和 bestbookmarks 是两个独立接口:
   *   - bestbookmarks: 章节内任意范围的"被多人划过"段落, 但 range 不一定返回
   *   - underlines: 章节内"高频划线段", range 字段稳定返回, 适合做 inline 高亮
   * 因此正文 inline 渲染优先用 underlines, 抽屉里的"热门划线"列表用 bestbookmarks(带 markText)。
   */
  private currentChapterUnderlines: ChapterUnderline[] = [];
  /** 当前书的"书评"(全书维度, 按 book 维度只拉一次) */
  private currentBookReviews: Review[] = [];
  /** 想法抽屉默认 tab */
  private reviewsTab: ReviewsTab = 'chapter';
  /** 章节维度想法/划线 是否在加载中 */
  private reviewsLoading = false;
  /** 全书书评是否在加载中(book 维度, 与章节切换无关) */
  private bookReviewsLoading = false;
  /**
   * 仅用于丢弃过期的章节社交内容回包。
   * 与正文 loadToken 解耦, 因为社交内容拉取是 fire-and-forget。
   */
  private reviewsToken = 0;

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

  /** OutputChannel 复用一份, dispose 跟随 context */
  private diagOutput: vscode.OutputChannel | undefined;

  /**
   * 诊断当前章节: 把 chapterFetch 的 format / html / style / content 长度与前若干字符
   * 写入 Output 面板, 用于排查"章节白屏 / 渲染异常"等问题。
   *
   * 通过命令面板触发: 微信读书: 诊断当前章节
   */
  public diagnoseChapter(): void {
    if (!this.diagOutput) {
      this.diagOutput = vscode.window.createOutputChannel('微信读书诊断');
      this.context.subscriptions.push(this.diagOutput);
    }
    const out = this.diagOutput;
    out.clear();
    out.appendLine(`# 微信读书章节诊断 @ ${new Date().toLocaleString()}`);
    if (!this.currentBook) {
      out.appendLine('(当前未打开任何书)');
      out.show(true);
      return;
    }
    out.appendLine(
      `书: ${this.currentBook.title ?? '?'} (bookId=${this.currentBook.bookId})`,
    );
    const ch =
      this.currentChapterIdx >= 0
        ? this.currentChapters[this.currentChapterIdx]
        : undefined;
    out.appendLine(
      `章节: ${ch?.title ?? '?'} (uid=${ch?.chapterUid ?? '?'}, idx=${this.currentChapterIdx}/${this.currentChapters.length - 1})`,
    );
    if (!this.chapterFetch) {
      out.appendLine('chapterFetch: null (章节尚未加载/加载失败)');
      out.show(true);
      return;
    }
    const f = this.chapterFetch;
    out.appendLine(`format: ${f.format ?? '(未知)'}`);
    out.appendLine(`html 长度: ${f.html?.length ?? 0}`);
    out.appendLine(`style 长度: ${f.style?.length ?? 0}`);
    out.appendLine(`content 长度: ${f.content?.length ?? 0}`);
    if (f.diagnostics) {
      out.appendLine(`diagnostics: ${f.diagnostics}`);
    }
    out.appendLine('');
    out.appendLine('--- chapterFetch.style (前 2000 字符) ---');
    out.appendLine((f.style ?? '(无)').slice(0, 2000));
    out.appendLine('');
    out.appendLine('--- chapterFetch.html (前 4000 字符) ---');
    out.appendLine((f.html ?? '(无)').slice(0, 4000));
    out.appendLine('');
    out.appendLine('--- chapterFetch.content (前 2000 字符) ---');
    out.appendLine((f.content ?? '(无)').slice(0, 2000));
    out.show(true);
    vscode.window.showInformationMessage(
      '章节诊断已写入 Output 面板「微信读书诊断」, 截图发我即可。',
    );
  }

  /**
   * 紧急解锁: 清空所有"在读"快照与缓存, 回到书架页。
   *
   * 触发场景:
   *   - 某本书的 EPUB 章节 CSS/HTML 异常, 把 webview 卡死, 点啥都不动
   *   - 启动时 lastRead 自动加载又把同一本书拉起来 → 死锁
   *
   * 该命令独立于 webview 的 message channel, 通过 vscode.commands 触发,
   * 所以即使 webview JS 完全不工作也能解锁。
   */
  public async resetReadingState(): Promise<void> {
    // 让正在飞的章节 / 社交内容回包失效
    this.loadToken++;
    this.reviewsToken++;

    this.currentBook = undefined;
    this.currentChapters = [];
    this.currentChapterIdx = -1;
    this.chapterFetch = null;
    this.chapterLoading = false;
    this.pendingRestoreChapterUid = undefined;
    this.currentChapterReviews = [];
    this.currentBestBookmarks = [];
    this.currentChapterUnderlines = [];
    this.currentBookReviews = [];
    this.reviewsLoading = false;
    this.bookReviewsLoading = false;

    this.tab = 'shelf';

    await this.context.globalState.update(KEY_LAST_READ, undefined);
    await this.context.globalState.update(KEY_TAB, this.tab);

    this.render();
    vscode.window.showInformationMessage('已清除"在读"缓存, 已回到书架。');
  }

  /** 命令: 打开某本书并切到阅读 tab */
  public async openBook(book: WereadBook): Promise<void> {
    if (!book?.bookId) return;
    if (!this.view) {
      // 还没创建 view, 触发聚焦让它创建
      try {
        await vscode.commands.executeCommand('wereadVscode.main.focus');
      } catch {
        await vscode.commands.executeCommand('workbench.view.extension.wereadVscode');
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
    const isBookSwitch = this.currentBook?.bookId !== book.bookId;
    this.currentBook = book;
    this.currentChapters = [];
    this.currentChapterIdx = -1;
    this.chapterFetch = null;
    this.chapterLoading = true;
    // 切到一本新书时, 旧的社交内容也要立刻清空, 避免抽屉里露出上一本书的内容
    if (isBookSwitch) {
      this.currentChapterReviews = [];
      this.currentBestBookmarks = [];
      this.currentChapterUnderlines = [];
      this.currentBookReviews = [];
      this.reviewsTab = 'chapter';
    }
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
      // 全书书评只跟 bookId 走, 不跟着章节切换, 这里 fire-and-forget
      if (isBookSwitch) {
        void this.loadBookReviews(book.bookId);
      }
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
    // 切章节立刻清旧社交内容 + 上一章 preparedChapterHtml, 避免"上一章想法/HTML 挂新章节"
    this.currentChapterReviews = [];
    this.currentBestBookmarks = [];
    this.currentChapterUnderlines = [];
    this.preparedChapterHtml = null;
    this.preparedChapterUid = null;
    this.render();
    try {
      const res = await this.client.fetchChapterContent(this.currentBook.bookId, chapter.chapterUid);
      if (token !== this.loadToken) return;
      // 章节 HTML 预处理:
      //   1) entity-escape 反解: 某些章节 HTML 是整段 `&lt;p&gt;...` 包成一坨,
      //      不反解 innerHTML 看到的是 "<p>" 字面量, 图片标签也不会被解析
      //   ⚠️ v0.0.6 修复: **不再**在这里做 image rewrite!
      //   image rewrite 会把 https URL 换成超长 base64 dataURL, 让章节 HTML 字符串
      //   膨胀几百 KB; 后续 injectHotUnderlinesIntoHtml 基于"weread 接口返回的 range"
      //   (相对原始 HTML 的字符偏移) 切 substring, 一膨胀就全部错位到 base64 中间,
      //   注入 <span class="hot-underline"> 后破坏 img 标签的 src 引号闭合,
      //   屏幕上就会出现一长串 base64 文本(用户截图描述的现象)。
      //   所以 image rewrite 必须**后置**到 inject underlines 之后, 由 prepareChapterHtml
      //   异步完成, 见 buildReaderHtml + prepareChapterHtml。
      if (res.html) {
        res.html = decodeEntityEscapedHtmlIfNeeded(res.html);
      }
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
        // 正文渲染完后再异步拉社交内容, 不阻塞主流程
        void this.loadChapterReviews(this.currentBook.bookId, chapter.chapterUid);
      }
    }
  }

  /**
   * 拉取当前章节的"想法 + 热门划线"。
   * - fire-and-forget, 用 reviewsToken 丢弃过期回包
   * - 失败不 throw, 控制台 warn 即可
   * - 全程不影响正文渲染
   */
  private async loadChapterReviews(bookId: string, chapterUid: number | string): Promise<void> {
    const token = ++this.reviewsToken;
    this.reviewsLoading = true;
    this.render();
    try {
      // 三个接口并行:
      //   - getChapterReviews   章节内想法(给"想法"tab 用)
      //   - getBestBookmarks    热门划线 + markText(给"热门划线"tab 用)
      //   - getChapterUnderlines /web/book/underlines, range 稳定, 给正文 inline 高亮
      const [reviewsRes, bookmarksRes, underlinesRes] = await Promise.allSettled([
        this.client.getChapterReviews(bookId, chapterUid),
        this.client.getBestBookmarks(bookId, chapterUid),
        this.client.getChapterUnderlines(bookId, chapterUid),
      ]);
      if (token !== this.reviewsToken) return;
      this.currentChapterReviews =
        reviewsRes.status === 'fulfilled' ? reviewsRes.value : [];
      this.currentBestBookmarks =
        bookmarksRes.status === 'fulfilled' ? bookmarksRes.value : [];
      this.currentChapterUnderlines =
        underlinesRes.status === 'fulfilled' ? underlinesRes.value : [];
      // 诊断: 让用户在 DevTools 里就能看清三路数据各拉到多少条, 排查"没划线评论"
      console.log(
        '[weread-vscode] loadChapterReviews done',
        {
          chapterUid,
          reviews: this.currentChapterReviews.length,
          bestbookmarks: this.currentBestBookmarks.length,
          bestbookmarksWithRange: this.currentBestBookmarks.filter((b) => !!b.range).length,
          underlines: this.currentChapterUnderlines.length,
        },
      );
    } catch (e) {
      console.warn('[weread-vscode] loadChapterReviews 异常', e);
    } finally {
      if (token === this.reviewsToken) {
        this.reviewsLoading = false;
        this.render();
        // 社交数据(underlines / bestbookmarks)拉完了, 立刻 fire-and-forget 跑
        // prepareChapterHtml: 用正确的 range 注入 inline 高亮, 然后才做 image rewrite,
        // 最终二次渲染替换成"含图 + 含划线"完整版章节正文。
        void this.prepareChapterHtml(chapterUid);
      }
    }
  }

  /**
   * v0.0.6 异步章节 HTML 完整流水线: decode → injectUnderlines → sanitize →
   * transformFootnotes → rewriteImageSrcsToDataUrls。
   *
   * 关键: rewriteImageSrcsToDataUrls **必须在 injectHotUnderlinesIntoHtml 之后**,
   * 否则 image 膨胀会让 weread 接口给的 range (相对原始 HTML 偏移) 全部错位到
   * base64 data URL 字符中间, 破坏 img 标签结构(用户截图描述的"显示一长串 base64"现象)。
   *
   * 写入 preparedChapterHtml + preparedChapterUid, 由 buildReaderHtml 优先使用。
   * 切章节 race: 在每次 await 前后校验 chapterUid 是否仍是当前章节, 不是就丢弃结果。
   */
  private async prepareChapterHtml(chapterUid: number | string): Promise<void> {
    const rawHtml = this.chapterFetch?.html;
    if (!rawHtml) return;
    // 校验: 仍在当前章节才继续, 防止 await 期间用户切走
    const expectedUid = this.currentChapters[this.currentChapterIdx]?.chapterUid;
    if (expectedUid !== chapterUid) return;

    const mergedUnderlineSources: InjectableRange[] = [
      ...this.currentBestBookmarks,
      ...this.currentChapterUnderlines,
    ];
    let prepared = rawHtml;
    // pipeline 顺序与 buildReaderHtml 兜底分支一致, 唯独**追加** image rewrite 作为最后一步
    prepared = decodeEntityEscapedHtmlIfNeeded(prepared);
    prepared = injectHotUnderlinesIntoHtml(prepared, mergedUnderlineSources);
    prepared = sanitizeChapterForInline(prepared);
    prepared = transformFootnotes(prepared);
    try {
      prepared = await this.rewriteImageSrcsToDataUrls(prepared);
    } catch (e) {
      // image rewrite 失败不阻塞: 至少 text + underlines 是 OK 的, 图退化为原 src(可能破图)
      console.warn('[weread-vscode] prepareChapterHtml: image rewrite 失败, 保留原 src', e);
    }
    // 二次校验: await 之后再确认章节没变, 避免回包覆盖了新章节
    const stillExpectedUid = this.currentChapters[this.currentChapterIdx]?.chapterUid;
    if (stillExpectedUid !== chapterUid) return;
    this.preparedChapterHtml = prepared;
    this.preparedChapterUid = chapterUid;
    this.render();
  }

  /**
   * 把章节 HTML 内 `<img src="https://...">` 全部走后端代理拉成 base64 dataURL 内嵌。
   *
   * 为什么必须代理?
   *   - 微信读书很多 img 在 res.weread.qq.com / cdn.weread.qq.com 上, 校验 Referer,
   *     webview 直接渲染时 Referer 是 `vscode-webview://...`, 会 403 黑空白
   *   - 部分图还有 cookie 校验 (登录态), 不带 cookie 也是 403
   *   - 走我们 axios 客户端能同时注入 cookie + 正确 Referer, 拿到二进制后变 dataURL
   *     就完全脱离网络限制
   *
   * 不代理的:
   *   - 非 http(s) 协议的 src (data: / 相对路径)
   *   - EPUB 内部相对路径(`../Images/cover.jpg`) — 拿不到 base URL, 注定加载不到, 略过
   *
   * 并发: 简单分块, 一次最多 4 张, 避免一章 30 张图同时打爆 weread 限频。
   */
  private async rewriteImageSrcsToDataUrls(html: string): Promise<string> {
    if (!html || typeof html !== 'string') return html;
    const urls = new Set<string>();
    // 注意 src 可能没有引号, 也可能用单引号; 这里三种格式一起兼容
    const reImg = /<img\b[^>]*?\bsrc\s*=\s*("([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    let m: RegExpExecArray | null;
    while ((m = reImg.exec(html)) !== null) {
      const raw = (m[2] ?? m[3] ?? m[4] ?? '').trim();
      if (raw && /^https?:\/\//i.test(raw)) urls.add(raw);
    }
    // 同时兼容 EPUB 里 SVG <image xlink:href="..."> (插图章节里常见)
    const reSvgImage = /<image\b[^>]*?\b(?:xlink:)?href\s*=\s*("([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    while ((m = reSvgImage.exec(html)) !== null) {
      const raw = (m[2] ?? m[3] ?? m[4] ?? '').trim();
      if (raw && /^https?:\/\//i.test(raw)) urls.add(raw);
    }
    if (!urls.size) return html;

    const list = Array.from(urls);
    const dataMap = new Map<string, string>();
    const CONCURRENCY = 4;
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      const chunk = list.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map((u) => this.client.fetchImageAsDataUrl(u)),
      );
      chunk.forEach((u, j) => {
        const r = results[j];
        if (r.status === 'fulfilled' && r.value) dataMap.set(u, r.value);
      });
    }
    console.log('[weread-vscode] rewriteImageSrcsToDataUrls', {
      total: urls.size,
      success: dataMap.size,
    });
    if (!dataMap.size) return html;

    // 字面量批量替换: 同一 URL 在 HTML 里可能出现多次(srcset / 重复 img), 一并替掉
    let out = html;
    for (const [url, dataUrl] of dataMap.entries()) {
      out = out.split(url).join(dataUrl);
    }
    return out;
  }

  /** 拉取全书"书评", 跟着 bookId 走, 切章节不刷新 */
  private async loadBookReviews(bookId: string): Promise<void> {
    this.bookReviewsLoading = true;
    this.render();
    try {
      this.currentBookReviews = await this.client.getBookReviews(bookId);
    } catch (e) {
      console.warn('[weread-vscode] loadBookReviews 异常', e);
      this.currentBookReviews = [];
    } finally {
      // 切书会异步覆盖, 只要当前书还是这本就更新 UI
      if (this.currentBook?.bookId === bookId) {
        this.bookReviewsLoading = false;
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
      case 'switchReviewsTab': {
        const next = (msg.payload as { tab?: ReviewsTab })?.tab;
        if (next === 'chapter' || next === 'hotmarks' || next === 'book') {
          this.reviewsTab = next;
          this.render();
        }
        break;
      }
      case 'refreshReviews': {
        // 用户手动刷新当前章节的想法/划线
        if (this.currentBook) {
          const ch = this.currentChapters[this.currentChapterIdx];
          if (ch) {
            void this.loadChapterReviews(this.currentBook.bookId, ch.chapterUid);
          }
          void this.loadBookReviews(this.currentBook.bookId);
        }
        break;
      }
      case 'getThoughtsByRange': {
        // 点击 inline 划线后, 按 range 单独拉这一段的想法 (touchFish 同款 UX)。
        // 优势相比预拉:
        //   - underlines 接口给的划线没有 markText, 没法在 webview 里用 indexOf 命中 reviews
        //   - 按 range 拉是 weread 官方支持的, 命中准确, 不会出现"明明有人写了想法却显示空"
        const range = (msg.payload as { range?: string })?.range;
        if (!this.currentBook || !range) return;
        const ch = this.currentChapters[this.currentChapterIdx];
        if (!ch) return;
        const bookId = this.currentBook.bookId;
        const chapterUid = ch.chapterUid;
        void (async () => {
          try {
            const reviews = await this.client.getReadReviewsByRange(bookId, chapterUid, range);
            // 简化成 popover 直接可用的最小集
            const items = reviews
              .filter((r) => !!r.content)
              .map((r) => ({
                name: r.author?.name ?? '匿名',
                avatar: typeof r.author?.avatar === 'string' ? r.author.avatar : '',
                content: r.content!,
                likes: typeof r.likesCount === 'number' ? r.likesCount : 0,
              }));
            this.view?.webview.postMessage({
              type: 'thoughtsByRange',
              payload: { range, items },
            });
          } catch (e) {
            console.warn('[weread-vscode] getThoughtsByRange 异常', e);
            this.view?.webview.postMessage({
              type: 'thoughtsByRange',
              payload: { range, items: [], error: (e as Error)?.message || 'unknown' },
            });
          }
        })();
        break;
      }
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

  /**
   * 登录卡片: 仅保留「导入 Cookie」一种登录方式。
   *
   * 历史背景: 早期同时提供「微信扫码」「浏览器登录助手」「手动粘贴 Cookie」三种方式,
   * 但前两种在实际使用中都不稳定(qrconnect 频繁被微信开放平台拒、读剪贴板路径在多种场景下
   * 失败), 唯一可靠的还是用户自己从浏览器把 cookie 拷出来粘进来。
   * 为简化心智, 现已统一收敛到这一种入口, 由命令面板 `微信读书: 导入 Cookie 登录`
   * 与本卡片的「导入 Cookie」按钮共同触发(走 weread.importCookie 命令)。
   */
  private buildLoginCardHtml(): string {
    return /* html */ `
      <div class="login-card">
        <div class="login-logo">📖</div>
        <h2>微信读书</h2>
        <p class="muted">在浏览器登录 weread.qq.com 后, 复制 Cookie 粘贴到这里即可。</p>
        <div class="login-actions">
          <button class="primary" data-act="login">导入 Cookie</button>
        </div>
        <details class="help">
          <summary>如何获取 Cookie?</summary>
          <ol>
            <li>浏览器登录 <code>weread.qq.com</code></li>
            <li>F12 → Application → Cookies → 选 weread.qq.com</li>
            <li>把所有 cookie 拼成 <code>k1=v1; k2=v2; ...</code></li>
            <li>点上面的「导入 Cookie」按钮, 在弹出的输入框中粘贴</li>
          </ol>
        </details>
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

    const chapters = this.currentChapters;
    const idx = this.currentChapterIdx;
    const currentChapter = idx >= 0 ? chapters[idx] : undefined;

    // 目录抽屉本体(fixed 定位, 放在 main 内任意位置都可以)
    const tocDrawer = chapters.length ? this.buildTocDrawerHtml(chapters, idx) : '';
    // 想法抽屉(只读社交), 始终渲染, 内容为空时显示"暂无"占位
    const reviewsDrawer = this.buildReviewsDrawerHtml();

    // 正文
    let articleHtml = '';
    if (this.chapterLoading) {
      articleHtml = `<article class="reading">${this.skeletonHtml(8)}</article>`;
    } else if (this.chapterFetch?.html) {
      const titleBlock = currentChapter
        ? `<h2 class="ch-title">${escapeHtml(currentChapter.title)}</h2>`
        : '';

      {
        // v0.0.6: 放弃"image-only 章节占位卡"启发式判定 — 之前的 looksLikeImageOnlyChapter
        // 实测会把"短文本 + 含 absolute https 图"的正常章节也误判, 反而挡掉了渲染。
        // touchFish 的做法是: **无脑 inline 渲染章节正文**, 图片代理已经能把所有 http(s)
        // 图拉成 data URL 内嵌, EPUB 包内的相对路径(如 ../Images/cover.jpg) 在 webview
        // 里加载失败就让它空白 — 文字章节不会受任何影响。
        //
        // 借鉴 touchFish (https://github.com/ylw1997/touchFish) 方案:
        //   不再用 sandbox iframe, 直接把 EPUB 章节正文内联渲染到外层 webview DOM。
        //
        // 之所以放弃 iframe:
        //   1) iframe 的 canvas 在 about:srcdoc 下受 color-scheme 影响, 浅色 vscode 主题
        //      会强制白底, 怎么改 srcdoc CSS 都改不了 (canvas 不属于 DOM)
        //   2) iframe 内的 EPUB 出版社 CSS / inline style 难以彻底压制, 跟外层主题脱节
        //   3) iframe 主题同步必须靠 contentDocument 注入 + MutationObserver, 复杂且易裂
        //
        // 改为 inline 之后:
        //   - sanitizeChapterForInline 把 <head>/<style>/<script>/<link>/<meta>/inline background
        //     和 color 等"主题污染源"一刀剥光, EPUB 出版社硬编码白底/黑字彻底失效
        //   - 章节内容直接继承外层 .reading 的 var(--vscode-*) 主题色, 任何主题都正确显示
        //   - 不再有 iframe canvas 默认色 / color-scheme 兼容性 / contentDocument 跨进 hack
        //
        // v0.0.6 两层渲染:
        //   1) **完整版**(preparedChapterHtml 命中): 含图 + 含划线 + sanitize + footnote,
        //      由 prepareChapterHtml 异步处理好缓存, 走 inject → sanitize → transformFootnote
        //      → **image rewrite**(关键: 必须在 inject 之后, 否则 base64 膨胀让 range 错位)
        //   2) **首屏兜底**(prepared 还没好): 走同步 pipeline, 不做 image rewrite —
        //      文字立刻可读, 图先 https 直链(weread 防盗链 + webview CSP 通常加载失败,
        //      会显示破图占位), 等 ~1s 后社交数据回来 prepareChapterHtml 写入 preparedChapterHtml
        //      触发 render 替换为完整版。
        //
        // 为什么不直接在 loadCurrentChapter 同步做 image rewrite? 见 prepareChapterHtml 注释:
        // image rewrite 会把 https URL 换成超长 base64 dataURL, 而 weread 接口给的 range
        // (相对原始 HTML 字符偏移) 一旦被 base64 膨胀就全部错位 — 注入到 base64 字符中间
        // 破坏 img 标签 src 引号闭合, 屏幕上出现一长串 base64 文本(用户截图描述的现象)。
        const currentUid = currentChapter?.chapterUid;
        let prepared: string;
        if (
          this.preparedChapterHtml !== null &&
          this.preparedChapterUid === currentUid
        ) {
          // 命中完整版: 已含图 + 划线 + sanitize, 直接用
          prepared = this.preparedChapterHtml;
        } else {
          // 兜底首屏: 同步 pipeline, 不含 image rewrite (留待 prepareChapterHtml 二次渲染)
          //   0) decodeEntityEscapedHtmlIfNeeded — 微信读书部分章节整段被 HTML entity 转义,
          //      不先反解 innerHTML 会显示 `<p>` 字面量, **图片也不显示**
          //   1) injectHotUnderlinesIntoHtml — 必须在 sanitize 前注入,
          //      因为 range 是相对**原始 HTML 字符串**的偏移
          //   2) sanitizeChapterForInline — 剥文档壳/css/script/inline style
          //   3) transformFootnotes — 把 <img class="qqreader-footnote"> 转成统一小图标 span
          prepared = this.chapterFetch.html;
          prepared = decodeEntityEscapedHtmlIfNeeded(prepared);
          const mergedUnderlineSources: InjectableRange[] = [
            ...this.currentBestBookmarks,
            ...this.currentChapterUnderlines,
          ];
          prepared = injectHotUnderlinesIntoHtml(prepared, mergedUnderlineSources);
          prepared = sanitizeChapterForInline(prepared);
          prepared = transformFootnotes(prepared);
        }
        articleHtml =
          `<article class="reading rich">${titleBlock}` +
          `<div class="rich-body">${prepared}</div>` +
          `</article>`;
      }
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
    const tocBtnTooltip = currentChapter
      ? `${currentChapter.title} · 第 ${idx + 1}/${chapters.length} 章 · 点击打开目录`
      : '打开目录';
    const tocFooterBtn = chapters.length
      ? `<button class="toc-trigger footer-mini" id="toc-trigger" title="${escapeAttr(tocBtnTooltip)}">
          <span class="ft-icon">📑</span>
          <span class="ft-label">目录</span>
          <span class="ft-badge">${idx + 1}/${chapters.length}</span>
        </button>`
      : '';

    // 想法按钮: 数量 = 章节想法 + 热门划线 + 全书书评(汇总让用户一眼看出有内容)。
    // 不计 currentChapterUnderlines 因为抽屉里没有为它专门开 tab, 只是用来给正文做 inline 高亮
    const reviewsCount =
      this.currentChapterReviews.length +
      this.currentBestBookmarks.length +
      this.currentBookReviews.length;
    const reviewsBadge = reviewsCount > 0 ? `<span class="ft-badge">${reviewsCount > 99 ? '99+' : reviewsCount}</span>` : '';
    const reviewsBtnTooltip = this.reviewsLoading
      ? '想法加载中…'
      : reviewsCount > 0
      ? `想法/划线/书评 共 ${reviewsCount} 条 · 点击查看`
      : '看看大家的想法、划线和书评';
    const reviewsFooterBtn = `<button class="toc-trigger footer-mini" id="reviews-trigger" title="${escapeAttr(reviewsBtnTooltip)}">
          <span class="ft-icon">💬</span>
          <span class="ft-label">想法</span>
          ${reviewsBadge}
        </button>`;

    const footer = `
      <footer class="reader-footer">
        <button class="ghost" data-act="prev" ${prevDisabled ? 'disabled' : ''}>◀ 上一章</button>
        <div class="footer-mid-group">
          ${tocFooterBtn}
          ${reviewsFooterBtn}
        </div>
        <button class="ghost" data-act="next" ${nextDisabled ? 'disabled' : ''}>下一章 ▶</button>
      </footer>
    `;

    // 把当前章节的"想法"序列化进 webview, 给 .hot-underline 点击 popover 检索用。
    // 数据精简到最小集 (mark / name / avatar / content / likes), 减少传输/解析开销。
    // 安全: JSON.stringify 后, 用 \u003c 转义 < 避免出现 </script> 提前闭合。
    const reviewsForPopover = this.currentChapterReviews
      .filter((r) => r.markText && r.content)
      .map((r) => ({
        mark: r.markText!,
        name: r.author?.name ?? '匿名',
        avatar: typeof r.author?.avatar === 'string' ? r.author.avatar : '',
        content: r.content!,
        likes: typeof r.likesCount === 'number' ? r.likesCount : 0,
      }));
    const reviewsJson = JSON.stringify(reviewsForPopover).replace(/</g, '\\u003c');
    const reviewsDataScript = `<script id="weread-reviews-data" type="application/json">${reviewsJson}</script>`;

    // 共用 popover 容器: .hot-underline 弹想法 / .weread-footnote-wrapper 弹注释
    // 都复用这一个 fixed 浮层, 内容动态写入。点击容器外 / Esc 关闭。
    const inlinePopover = `<div class="weread-popover" id="weread-popover" hidden></div>`;

    return `<main class="content reader"><div class="reader-body">${articleHtml}</div>${footer}${tocDrawer}${reviewsDrawer}${inlinePopover}${reviewsDataScript}</main>`;
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

  /**
   * "想法"抽屉(只读社交). 顶部 3 个 tab:
   *   - 本章想法(chapter) : /web/review/list?listType=11
   *   - 热门划线(hotmarks): /web/book/bestbookmarks
   *   - 全书书评(book)    : /web/review/list?listType=4
   *
   * 点击带 markText 的卡片会让正文 indexOf 命中后滚动 + 闪烁高亮(纯前端,
   * 不走 EPUB CFI, 命中率视章节而定, 命中不了就只是滚不动, 无副作用)。
   */
  private buildReviewsDrawerHtml(): string {
    const tab = this.reviewsTab;
    const chapterReviews = this.currentChapterReviews;
    const bestBookmarks = this.currentBestBookmarks;
    const bookReviews = this.currentBookReviews;

    const tabBtn = (key: ReviewsTab, label: string, count: number) => `
      <button class="rv-tab ${tab === key ? 'active' : ''}" data-rv-tab="${key}">
        <span class="rv-tab-label">${label}</span>
        <span class="rv-tab-count">${count}</span>
      </button>`;

    const tabs = `
      <div class="rv-tabs">
        ${tabBtn('chapter', '本章想法', chapterReviews.length)}
        ${tabBtn('hotmarks', '热门划线', bestBookmarks.length)}
        ${tabBtn('book', '全书书评', bookReviews.length)}
      </div>`;

    let body = '';
    const loadingForCurrent =
      (tab === 'chapter' || tab === 'hotmarks') ? this.reviewsLoading : this.bookReviewsLoading;

    if (tab === 'chapter') {
      body = chapterReviews.length
        ? `<ul class="rv-list">${chapterReviews.map((r) => this.reviewCardHtml(r, false)).join('')}</ul>`
        : this.reviewsEmptyHtml(loadingForCurrent, '本章还没有想法');
    } else if (tab === 'hotmarks') {
      body = bestBookmarks.length
        ? `<ul class="rv-list">${bestBookmarks.map((b) => this.bookmarkCardHtml(b)).join('')}</ul>`
        : this.reviewsEmptyHtml(loadingForCurrent, '本章暂无热门划线');
    } else {
      body = bookReviews.length
        ? `<ul class="rv-list">${bookReviews.map((r) => this.reviewCardHtml(r, true)).join('')}</ul>`
        : this.reviewsEmptyHtml(loadingForCurrent, '这本书还没有书评');
    }

    return `
      <div class="reviews-backdrop" id="reviews-backdrop"></div>
      <aside class="reviews-drawer" id="reviews-drawer" aria-hidden="true">
        <header class="toc-head">
          <div class="toc-head-title">
            <span class="toc-head-name">想法</span>
            <span class="toc-head-count">${chapterReviews.length + bestBookmarks.length + bookReviews.length}</span>
          </div>
          <button class="toc-close" id="reviews-close" title="关闭">✕</button>
        </header>
        ${tabs}
        <div class="rv-body" id="rv-body">${body}</div>
      </aside>
    `;
  }

  /** "想法"列表为空 / 加载中的占位 */
  private reviewsEmptyHtml(loading: boolean, emptyText: string): string {
    if (loading) {
      return `<div class="rv-loading">${this.skeletonHtml(3)}</div>`;
    }
    return `<div class="rv-empty">${escapeHtml(emptyText)}</div>`;
  }

  /**
   * 单条"想法/书评"卡片。
   * - isBookReview=true 时不显示 markText 引用块(全书书评通常没 markText)
   * - markText 用 data-mark 透传给前端 JS 做"点击定位正文"
   */
  private reviewCardHtml(r: Review, isBookReview: boolean): string {
    const avatar = typeof r.author?.avatar === 'string' && r.author.avatar
      ? `<img class="rv-avatar" src="${escapeAttr(r.author.avatar)}" alt="" onerror="this.style.display='none';this.parentNode.classList.add('no-avatar');" />`
      : '';
    const nameInitial = (r.author?.name ?? '?').slice(0, 1);
    const name = r.author?.name ?? '匿名用户';
    const time = r.createTime ? formatRelativeTime(r.createTime) : '';
    const likes = typeof r.likesCount === 'number' && r.likesCount > 0
      ? `<span class="rv-likes">❤ ${r.likesCount > 999 ? '999+' : r.likesCount}</span>`
      : '';
    const mark = !isBookReview && r.markText
      ? `<blockquote class="rv-mark" data-mark="${escapeAttr(r.markText)}" title="点击在正文中定位">${escapeHtml(r.markText)}</blockquote>`
      : '';
    const content = r.content
      ? `<div class="rv-content">${escapeHtml(r.content)}</div>`
      : '';
    // 空 content 又空 mark 的卡片(几乎不会有)就不渲染
    if (!mark && !content) return '';
    return `
      <li class="rv-card">
        <header class="rv-card-head">
          <div class="rv-avatar-wrap ${avatar ? '' : 'no-avatar'}">
            ${avatar}
            <span class="rv-avatar-fallback">${escapeHtml(nameInitial)}</span>
          </div>
          <div class="rv-meta">
            <div class="rv-name">${escapeHtml(name)}</div>
            <div class="rv-time">${escapeHtml(time)}</div>
          </div>
          ${likes}
        </header>
        ${mark}
        ${content}
      </li>`;
  }

  /** 单条"热门划线"卡片(没有作者, 只有划线本体 + 多少人划过) */
  private bookmarkCardHtml(b: BestBookmark): string {
    const total = typeof b.totalCount === 'number' && b.totalCount > 0
      ? `<span class="rv-likes">${b.totalCount > 9999 ? '9999+' : b.totalCount} 人划过</span>`
      : '';
    return `
      <li class="rv-card rv-card-mark">
        <blockquote class="rv-mark" data-mark="${escapeAttr(b.markText)}" title="点击在正文中定位">${escapeHtml(b.markText)}</blockquote>
        <footer class="rv-card-foot">${total}</footer>
      </li>`;
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
      /* ---- 底部中间的目录/想法触发按钮(footer 中间, 紧凑显示) ---- */
      .footer-mid-group {
        flex: 1; min-width: 0;
        display: flex; align-items: center; justify-content: center; gap: 4px;
        overflow: hidden;
      }
      .toc-trigger.footer-mini {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 3px 8px;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 4px;
        color: var(--vscode-foreground);
        font-size: 11.5px;
        cursor: pointer;
        transition: all .15s ease;
        min-width: 0;
      }
      .toc-trigger.footer-mini:hover {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-panel-border);
      }
      .toc-trigger.footer-mini .ft-icon {
        font-size: 12px; opacity: .8; flex-shrink: 0;
      }
      .toc-trigger.footer-mini .ft-label {
        flex-shrink: 0;
        white-space: nowrap;
      }
      .toc-trigger.footer-mini .ft-badge {
        flex-shrink: 0;
        font-size: 10px; font-variant-numeric: tabular-nums;
        padding: 0 5px; border-radius: 7px;
        background: rgba(127,127,127,.2);
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
      /* 阅读区外框: 用 editor 背景, 跟 VSCode 主题完全一致 */
      .reader-body {
        flex: 1; overflow-y: auto;
        padding: 10px 10px 18px;
        background: var(--vscode-editor-background, var(--vscode-sideBar-background));
      }
      /* === 正文卡片 ===
       * 设计原则 (参考 https://github.com/ylw1997/touchFish/blob/main/weread/src/style/App.less):
       *   完全交给 VSCode 主题接管, 不写固定纸张色。
       *
       * 历史教训:
       *   1) 之前用米黄纸张色 + sandbox iframe, 深色主题下用户体感不一致, 反复迭代
       *   2) iframe canvas 受 color-scheme 影响, 主题切换不干净
       *   3) EPUB 出版社 CSS 也写死颜色, 跟自定义纸张色打架
       *
       * 现方案:
       *   - 这里只用 var(--vscode-editor-foreground/background), 跟随主题
       *   - 章节正文通过 sanitizeChapterForInline 剥掉 EPUB <style>/<link>/inline background
       *     再 inline 渲染, EPUB CSS 完全失效, 不会污染
       *   - 用户切 vscode 主题, 阅读区背景/文字/链接颜色全部自动跟随
       */
      .reading {
        max-width: 720px;
        margin: 6px auto 14px;
        padding: 18px 24px 28px;
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground, var(--vscode-foreground));
        border-radius: 6px;
        border: 1px solid var(--vscode-panel-border, transparent);
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei",
          "Hiragino Sans GB", "Songti SC", "STSong", "Source Han Serif SC",
          "Noto Serif SC", Georgia, serif;
        font-size: 15px; line-height: 1.85;
      }
      .reading .ch-title {
        margin: 0 0 22px; font-size: 18px; font-weight: 600;
        text-align: center; letter-spacing: .04em;
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
        padding-bottom: 14px;
        color: var(--vscode-foreground);
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .reading p { margin: 0 0 0.95em; text-indent: 2em; }
      .reading p:first-of-type::first-letter { font-size: 1.05em; }
      .reading img { max-width: 100%; height: auto; display: block; margin: 14px auto; border-radius: 4px; }

      /* 富 HTML(epub) 兜底: 解除微信读书内置宽度/字体限制, 拒绝任何子元素自定义背景/颜色
       * 让所有色彩交给 .reading 父容器 + VSCode 主题接管。
       * 这里的兜底其实是双保险 — sanitizeChapterForInline 已经剥掉了大部分 background/color
       * inline style, 但出版社可能用 align/bgcolor 等老 HTML 属性, CSS 这层一并兜住。 */
      .reading.rich .rich-body,
      .reading.rich .rich-body * {
        max-width: 100% !important;
        color: inherit !important;
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
        font-family: inherit !important;
      }
      .reading.rich .rich-body { font-size: inherit; line-height: inherit; }
      .reading.rich .rich-body img,
      .reading.rich .rich-body svg,
      .reading.rich .rich-body video {
        height: auto !important;
        display: block;
        margin: 14px auto;
        max-width: 100% !important;
      }
      .reading.rich .rich-body p {
        margin: 0 0 0.95em; text-indent: 2em;
        text-align: justify;
      }
      .reading.rich .rich-body h1,
      .reading.rich .rich-body h2,
      .reading.rich .rich-body h3,
      .reading.rich .rich-body h4,
      .reading.rich .rich-body h5,
      .reading.rich .rich-body h6 {
        margin: 1.2em 0 0.6em !important;
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif !important;
        color: var(--vscode-foreground) !important;
        text-indent: 0;
        line-height: 1.4;
      }
      .reading.rich .rich-body a {
        color: var(--vscode-textLink-foreground) !important;
        text-decoration: none;
      }
      .reading.rich .rich-body a:hover { text-decoration: underline; }
      .reading.rich .rich-body blockquote {
        margin: 0.8em 0;
        padding: 4px 0 4px 12px;
        border-left: 3px solid var(--vscode-panel-border);
        color: var(--vscode-descriptionForeground) !important;
        text-indent: 0;
      }
      .reading.rich .rich-body hr {
        border: 0;
        border-top: 1px solid var(--vscode-panel-border);
        margin: 1.4em 0;
      }
      .reading.rich .rich-body table {
        border-collapse: collapse;
        margin: 12px auto;
      }
      .reading.rich .rich-body th,
      .reading.rich .rich-body td {
        border: 1px solid var(--vscode-panel-border);
        padding: 6px 10px;
      }

      /* === touchFish 风格: 章节内插图 ===
       * EPUB 章节里有相对路径(../Images/xxx.jpg)的 <img>, webview 也加载不了,
       * 但出版社也会有些 CDN 绝对路径图能加载. 给 <img> 加阴影/居中/圆角, 提升视觉体感,
       * 加载失败的图依靠浏览器原生 broken-image icon 体现, 不再隐藏. */
      .reading.rich .rich-body img {
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        border-radius: 8px;
      }

      /* === touchFish 风格: 热门划线 inline 视觉 ===
       * sanitizeChapterForInline 之前先注入了 <span class="hot-underline">,
       * 这里只画虚线下划线 + hover 实线高亮, 点击触发 popover (见 buildScript).
       * 注意要用 !important 覆盖 .reading.rich .rich-body * 的 color: inherit 兜底. */
      .reading.rich .rich-body .hot-underline {
        border-bottom: 1px dashed rgba(127, 127, 127, .55) !important;
        cursor: pointer;
        transition: border-color .15s ease, background .15s ease;
        padding-bottom: 1px;
        display: inline;
      }
      .reading.rich .rich-body .hot-underline:hover {
        border-bottom-color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground)) !important;
        background: rgba(127, 127, 127, .08);
      }

      /* === touchFish 风格: 脚注小图标 ===
       * transformFootnotes 把 <img class="qqreader-footnote"> 替换成
       * <span class="weread-footnote-wrapper"><span class="weread-footnote-icon"></span></span>,
       *
       * v0.0.5 之前用 cdn.weread.qq.com 的 PNG, 但 CSP/CDN/网络任一卡住都会黑空白.
       * 现改为纯 CSS 圆圈 + 字符 "i" 的伪元素方案:
       *   - 没有任何网络依赖, 不受 CSP/CORS/CDN 失效影响
       *   - 自动跟随 VSCode 主题前景色 (currentColor), 深浅色全部正确
       *   - 自带 hover 缩放动效, 视觉跟原 PNG 一致 */
      .reading.rich .rich-body .weread-footnote-wrapper {
        display: inline-block;
        vertical-align: middle;
        cursor: pointer;
        margin: 0 2px;
        line-height: 1;
        padding: 0;
      }
      .reading.rich .rich-body .weread-footnote-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px; height: 14px;
        border: 1px solid currentColor;
        border-radius: 50%;
        vertical-align: middle;
        position: relative;
        top: -1px;
        opacity: .7;
        color: var(--vscode-textLink-foreground, var(--vscode-foreground));
        font-style: italic;
        font-family: Georgia, "Times New Roman", serif;
        font-size: 10px;
        line-height: 1;
        transition: opacity .15s ease, transform .15s ease;
      }
      .reading.rich .rich-body .weread-footnote-icon::before {
        content: 'i';
      }
      .reading.rich .rich-body .weread-footnote-wrapper:hover .weread-footnote-icon {
        opacity: 1;
        transform: scale(1.12);
      }

      /* 封面/插图章节: 图片无法在 iframe 里解析时的友好提示卡 */
      .reading.image-only {
        max-width: 480px;
      }
      .reading.image-only .image-only-card {
        margin-top: 14px; padding: 22px 18px;
        border: 1px dashed rgba(127, 127, 127, .35);
        border-radius: 8px;
        background: transparent;
        text-align: center;
      }
      .reading.image-only .image-only-icon {
        font-size: 36px; margin-bottom: 6px; opacity: .85;
      }
      .reading.image-only h4 {
        margin: 4px 0 8px; font-size: 14px; font-weight: 600;
        font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      .reading.image-only p {
        font-size: 12px; line-height: 1.65; text-indent: 0;
        margin: 0 0 14px;
      }
      .reading.image-only .actions {
        display: flex; gap: 8px; justify-content: center;
        flex-wrap: wrap;
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
      .login-card h2 { margin: 4px 0 8px; font-size: 16px; }
      .login-card p.muted { font-size: 12px; margin: 0 0 14px; line-height: 1.5; }
      .login-card button.primary { padding: 6px 16px; }
      .login-card .login-actions {
        display: flex; flex-direction: column; gap: 8px; align-items: center;
        margin: 4px 0;
      }
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

      /* ====== 想法/划线 抽屉 ====== */
      .reviews-backdrop {
        position: fixed; inset: 0;
        background: rgba(0, 0, 0, .42);
        backdrop-filter: blur(2px);
        opacity: 0; pointer-events: none;
        transition: opacity .22s ease;
        z-index: 90;
      }
      .reviews-backdrop.open { opacity: 1; pointer-events: auto; }

      .reviews-drawer {
        position: fixed;
        top: 0; right: 0; bottom: 0;
        width: min(92vw, 360px);
        background: var(--vscode-sideBar-background);
        border-left: 1px solid var(--vscode-panel-border);
        box-shadow: -6px 0 28px rgba(0,0,0,.32);
        transform: translateX(100%);
        transition: transform .26s cubic-bezier(.4, 0, .2, 1);
        display: flex; flex-direction: column;
        z-index: 100;
      }
      .reviews-drawer.open { transform: translateX(0); }

      .rv-head {
        flex-shrink: 0;
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 14px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .rv-head-title { display: flex; align-items: baseline; gap: 8px; }
      .rv-head-name { font-size: 14px; font-weight: 600; letter-spacing: .04em; }
      .rv-close {
        width: 26px; height: 26px;
        background: transparent; border: none;
        border-radius: 4px;
        color: var(--vscode-foreground); opacity: .65;
        font-size: 14px;
        display: inline-flex; align-items: center; justify-content: center;
      }
      .rv-close:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }

      .rv-tabs {
        flex-shrink: 0;
        display: flex; gap: 2px;
        padding: 6px 10px 8px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .rv-tab {
        flex: 1;
        display: inline-flex; align-items: center; justify-content: center; gap: 5px;
        padding: 5px 8px;
        background: transparent; color: var(--vscode-foreground);
        border: 1px solid transparent; border-radius: 4px;
        font-size: 12px; opacity: .7;
        cursor: pointer;
        transition: all .12s ease;
      }
      .rv-tab:hover:not(.active) {
        background: var(--vscode-list-hoverBackground);
        opacity: .95;
      }
      .rv-tab.active {
        opacity: 1; font-weight: 600;
        background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
        color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
      }
      .rv-tab-count {
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        padding: 0 5px; border-radius: 7px;
        background: rgba(127,127,127,.22);
        color: var(--vscode-descriptionForeground);
      }
      .rv-tab.active .rv-tab-count {
        background: rgba(255,255,255,.18);
        color: inherit;
      }

      .rv-body {
        flex: 1; overflow-y: auto;
        padding: 8px 10px 16px;
      }
      .rv-list {
        list-style: none; margin: 0; padding: 0;
        display: flex; flex-direction: column; gap: 8px;
      }
      .rv-card {
        padding: 10px 12px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        background: var(--vscode-editor-background, transparent);
        transition: border-color .12s ease, background .12s ease;
      }
      .rv-card:hover {
        border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
      }
      .rv-card-head {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 6px;
      }
      .rv-avatar-wrap {
        position: relative; flex-shrink: 0;
        width: 26px; height: 26px;
        border-radius: 50%; overflow: hidden;
        background: linear-gradient(135deg, #6e8efb, #a777e3);
      }
      .rv-avatar-wrap .rv-avatar {
        width: 100%; height: 100%; object-fit: cover; display: block;
      }
      .rv-avatar-wrap .rv-avatar-fallback {
        position: absolute; inset: 0;
        display: none; align-items: center; justify-content: center;
        color: rgba(255,255,255,.92); font-weight: 600; font-size: 12px;
      }
      .rv-avatar-wrap.no-avatar .rv-avatar-fallback { display: flex; }
      .rv-meta {
        flex: 1; min-width: 0;
        display: flex; flex-direction: column;
      }
      .rv-name {
        font-size: 12px; font-weight: 500;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .rv-time {
        font-size: 10.5px;
        color: var(--vscode-descriptionForeground);
        font-variant-numeric: tabular-nums;
      }
      .rv-likes {
        flex-shrink: 0;
        font-size: 10.5px;
        padding: 0 6px; border-radius: 8px;
        background: rgba(127,127,127,.18);
        color: var(--vscode-descriptionForeground);
        font-variant-numeric: tabular-nums;
      }
      .rv-mark {
        margin: 4px 0 6px;
        padding: 6px 9px;
        background: rgba(127,127,127,.1);
        border-left: 2px solid rgba(127,127,127,.4);
        border-radius: 0 3px 3px 0;
        font-size: 11.5px; font-style: italic;
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
        cursor: pointer;
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
        transition: background .12s ease;
      }
      .rv-mark:hover {
        background: rgba(127,127,127,.18);
        color: var(--vscode-foreground);
      }
      .rv-mark::before { content: '“'; opacity: .55; margin-right: 1px; }
      .rv-mark::after { content: '”'; opacity: .55; margin-left: 1px; }
      .rv-content {
        font-size: 12.5px; line-height: 1.6;
        color: var(--vscode-foreground);
        word-break: break-word;
        white-space: pre-wrap;
      }
      .rv-content.bk-only {
        font-style: normal;
        font-size: 13px;
        color: var(--vscode-foreground);
      }
      .rv-empty {
        padding: 28px 16px;
        text-align: center;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }
      .rv-empty .rv-empty-icon {
        font-size: 28px; opacity: .55; margin-bottom: 8px;
      }
      .rv-loading {
        padding: 14px;
        font-size: 12px;
        color: var(--vscode-descriptionForeground);
        text-align: center;
      }

      /* 正文定位命中后, 短暂闪烁高亮 */
      .flash-highlight {
        background: rgba(255, 200, 60, .35) !important;
        transition: background 1.2s ease;
        border-radius: 2px;
      }

      /* === touchFish 风格 inline popover ===
       * 点击 .hot-underline 弹想法卡片列表, 点击 .weread-footnote-wrapper 弹注释文本,
       * 共用一个 #weread-popover 容器, 由 buildScript 动态填充内容并 fixed 定位到锚点下方. */
      .weread-popover {
        position: fixed;
        z-index: 120;
        max-width: min(380px, calc(100vw - 24px));
        min-width: 220px;
        max-height: 320px;
        overflow-y: auto;
        padding: 10px 12px;
        background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
        color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
        border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
        border-radius: 6px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, .35);
        font-size: 12.5px;
        line-height: 1.55;
      }
      .weread-popover[hidden] { display: none; }
      .weread-popover .wp-empty {
        color: var(--vscode-descriptionForeground);
        text-align: center;
        padding: 12px 4px;
        font-size: 12px;
      }
      .weread-popover .wp-footnote {
        font-size: 12.5px;
        line-height: 1.65;
        color: var(--vscode-foreground);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .weread-popover .wp-list {
        list-style: none; margin: 0; padding: 0;
        display: flex; flex-direction: column; gap: 10px;
      }
      .weread-popover .wp-item {
        padding: 8px 0;
        border-bottom: 1px solid rgba(127, 127, 127, .18);
      }
      .weread-popover .wp-item:last-child { border-bottom: none; padding-bottom: 0; }
      .weread-popover .wp-item:first-child { padding-top: 0; }
      .weread-popover .wp-head {
        display: flex; align-items: center; gap: 8px;
        margin-bottom: 5px;
      }
      .weread-popover .wp-avatar {
        width: 22px; height: 22px;
        border-radius: 50%;
        background: linear-gradient(135deg, #6e8efb, #a777e3);
        object-fit: cover;
        flex-shrink: 0;
      }
      .weread-popover .wp-name {
        flex: 1; min-width: 0;
        font-size: 12px; font-weight: 500;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .weread-popover .wp-likes {
        flex-shrink: 0;
        font-size: 10.5px;
        padding: 0 6px; border-radius: 8px;
        background: rgba(127, 127, 127, .18);
        color: var(--vscode-descriptionForeground);
      }
      .weread-popover .wp-content {
        font-size: 12.5px; line-height: 1.55;
        color: var(--vscode-foreground);
        word-break: break-word;
        white-space: pre-wrap;
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

      // ===== 抽屉互斥小工具: 打开一个抽屉前主动关掉另一个 =====
      function closeOtherDrawer(except) {
        if (except !== 'toc') {
          const d = document.getElementById('toc-drawer');
          const b = document.getElementById('toc-backdrop');
          if (d) { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); }
          if (b) b.classList.remove('open');
        }
        if (except !== 'reviews') {
          const d = document.getElementById('reviews-drawer');
          const b = document.getElementById('reviews-backdrop');
          if (d) { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); }
          if (b) b.classList.remove('open');
        }
      }

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
          closeOtherDrawer('toc');
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

      // ===== 想法/划线 抽屉 =====
      (function setupReviews() {
        const trigger = document.getElementById('reviews-trigger');
        const drawer = document.getElementById('reviews-drawer');
        const backdrop = document.getElementById('reviews-backdrop');
        const close = document.getElementById('reviews-close');
        if (!drawer) return;

        function openDrawer() {
          closeOtherDrawer('reviews');
          drawer.classList.add('open');
          backdrop && backdrop.classList.add('open');
          drawer.setAttribute('aria-hidden', 'false');
          // 顶到顶
          const body = document.getElementById('rv-body');
          if (body) {
            requestAnimationFrame(() => { try { body.scrollTop = 0; } catch (e) {} });
          }
        }
        function closeDrawer() {
          drawer.classList.remove('open');
          backdrop && backdrop.classList.remove('open');
          drawer.setAttribute('aria-hidden', 'true');
        }

        trigger && trigger.addEventListener('click', openDrawer);
        close && close.addEventListener('click', closeDrawer);
        backdrop && backdrop.addEventListener('click', closeDrawer);
        // ESC 关
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
        });

        // tab 切换
        drawer.addEventListener('click', (e) => {
          const t = e.target && e.target.closest && e.target.closest('[data-rv-tab]');
          if (!t) return;
          const tab = t.getAttribute('data-rv-tab');
          if (tab) post('switchReviewsTab', { tab });
        });

        // 点击 markText 引用块 → 关抽屉 + 正文 indexOf 命中 + 闪烁高亮
        drawer.addEventListener('click', (e) => {
          const mark = e.target && e.target.closest && e.target.closest('.rv-mark[data-mark]');
          if (!mark) return;
          const text = mark.getAttribute('data-mark') || '';
          if (!text) return;
          closeDrawer();
          // 让抽屉收起的过渡先跑一帧, 再做定位, 体感更顺
          setTimeout(() => locateMarkInArticle(text), 220);
        });
      })();

      // 章节正文现已 inline 渲染 (sanitizeChapterForInline 剥光 EPUB 文档壳 + style),
      // 不再需要 iframe sandbox / contentDocument 注入主题 / ResizeObserver 自适应高度,
      // 全部交给浏览器原生 DOM 渲染 + 外层 .reading CSS + VSCode 主题变量自动跟随。

      // ===== touchFish 风格 inline popover: 热门划线 / 脚注 =====
      // 章节 inline 渲染后, 用 DOM 事件委托接管 .hot-underline 和 .weread-footnote-wrapper:
      //   - 点击划线 → 用 markText 在 window.__WEREAD_REVIEWS__ 里匹配相关想法 → popover 列出
      //   - 点击脚注小图标 → popover 显示 data-note 文本
      //   - 点击容器外 / Esc 关闭
      (function setupInlinePopover() {
        const article = document.querySelector('.reading.rich .rich-body');
        const popover = document.getElementById('weread-popover');
        if (!article || !popover) return;

        // 读取后端注入的 reviews JSON (只含本章带 markText+content 的)
        let reviews = [];
        try {
          const node = document.getElementById('weread-reviews-data');
          if (node && node.textContent) reviews = JSON.parse(node.textContent) || [];
        } catch (e) { reviews = []; }

        // ----- popover 定位 -----
        // touchFish 用 antd Popover 自动 placement; 我们手写 fixed 定位:
        // 默认锚点下方; 若下方超视口则翻到上方; 水平方向贴左 4px, 右侧防溢出。
        function positionPopover(anchor) {
          const rect = anchor.getBoundingClientRect();
          popover.hidden = false;
          popover.style.visibility = 'hidden';
          popover.style.left = '0px';
          popover.style.top = '0px';
          // 强制 reflow 拿尺寸
          const pw = popover.offsetWidth;
          const ph = popover.offsetHeight;
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          let top = rect.bottom + 6;
          if (top + ph > vh - 8) {
            // 下面装不下 → 翻到上方
            top = Math.max(8, rect.top - ph - 6);
          }
          let left = rect.left;
          if (left + pw > vw - 8) left = Math.max(8, vw - pw - 8);
          if (left < 8) left = 8;
          popover.style.top = top + 'px';
          popover.style.left = left + 'px';
          popover.style.visibility = '';
        }

        function escapeHtmlJs(s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function showFootnotePopover(anchor, note) {
          popover.innerHTML = '<div class="wp-footnote">' + escapeHtmlJs(note) + '</div>';
          positionPopover(anchor);
        }

        // 渲染想法列表的统一函数, 给 loading / 本地缓存 / 后端按 range 拉回三个分支共用
        function renderThoughtsList(items) {
          if (!items || !items.length) {
            return '<div class="wp-empty">这段划线还没有想法</div>';
          }
          return '<ul class="wp-list">' + items.map(function(h) {
            const avatar = h.avatar
              ? '<img class="wp-avatar" src="' + escapeHtmlJs(h.avatar) + '" onerror="this.style.display=\\'none\\'" alt="" />'
              : '<span class="wp-avatar"></span>';
            const likes = (typeof h.likes === 'number' && h.likes > 0)
              ? '<span class="wp-likes">❤ ' + (h.likes > 999 ? '999+' : h.likes) + '</span>'
              : '';
            return '<li class="wp-item">'
              + '<div class="wp-head">' + avatar
              + '<span class="wp-name">' + escapeHtmlJs(h.name || '匿名') + '</span>'
              + likes + '</div>'
              + '<div class="wp-content">' + escapeHtmlJs(h.content || '') + '</div>'
              + '</li>';
          }).join('') + '</ul>';
        }

        // 当前 popover 正在等待哪个 range 的回包 — 用作消息回到时的过期检查
        // (用户快速点了两个不同划线, 第一个回包到了不要覆盖第二个的内容)
        let pendingRange = null;

        function showUnderlinePopover(anchor, underEl) {
          const range = underEl.getAttribute('data-range') || '';
          const mark = (underEl.getAttribute('data-mark') || underEl.textContent || '').trim();

          // 先用本地 reviews 数组做一次 indexOf 兜底 (markText 双向 indexOf 召回率较高)。
          // 没命中或没本地缓存就显示 loading, 让后端按 range 拉一遍。
          const localHits = mark ? reviews.filter(function(r) {
            const rm = (r.mark || '').trim();
            if (!rm) return false;
            return rm === mark || rm.indexOf(mark) >= 0 || mark.indexOf(rm) >= 0;
          }) : [];

          if (localHits.length) {
            // 本地有命中, 直接渲染, 同时仍然按 range 拉一次 (拿更全的数据回填覆盖)
            popover.innerHTML = renderThoughtsList(localHits);
          } else {
            popover.innerHTML = '<div class="wp-empty">加载想法中…</div>';
          }
          positionPopover(anchor);

          if (range) {
            pendingRange = range;
            post('getThoughtsByRange', { range: range });
          }
        }

        function hidePopover() {
          popover.hidden = true;
          popover.innerHTML = '';
        }

        article.addEventListener('click', function(e) {
          const target = e.target;
          if (!target) return;
          // 优先脚注 (在 .hot-underline 里也可能嵌脚注, 防止被外层拦截)
          const footEl = target.closest && target.closest('.weread-footnote-wrapper');
          if (footEl) {
            e.preventDefault();
            e.stopPropagation();
            const note = footEl.getAttribute('data-note') || '';
            showFootnotePopover(footEl, note);
            return;
          }
          const underEl = target.closest && target.closest('.hot-underline');
          if (underEl) {
            e.preventDefault();
            e.stopPropagation();
            // v0.0.6: 新签名 (anchor, underEl) — popover 内部按 data-range 异步拉想法,
            // 不再仅依赖 markText indexOf, 解决 /web/book/underlines 无 markText 时点击空白的问题
            showUnderlinePopover(underEl, underEl);
            return;
          }
        });

        // ===== 监听后端按 range 异步拉回的想法, 回填 popover =====
        // 过期检查: 用户快速点了两个不同划线, 早到的回包不能覆盖晚到的内容
        window.addEventListener('message', function(ev) {
          const m = ev && ev.data;
          if (!m || m.type !== 'thoughtsByRange') return;
          const p = m.payload || {};
          if (popover.hidden) return;
          if (p.range && pendingRange && p.range !== pendingRange) return;
          if (p.error) {
            // 后端报错时, 若本地兜底已经显示了内容就别盖掉, 否则给一个提示
            if (popover.innerHTML.indexOf('wp-list') < 0) {
              popover.innerHTML = '<div class="wp-empty">想法加载失败</div>';
            }
            return;
          }
          popover.innerHTML = renderThoughtsList(p.items || []);
        });

        // 点击其它任意位置关闭 (popover 自己例外, 让用户能滚动里面的内容)
        document.addEventListener('click', function(e) {
          if (popover.hidden) return;
          if (popover.contains(e.target)) return;
          if (e.target && e.target.closest && (e.target.closest('.hot-underline') || e.target.closest('.weread-footnote-wrapper'))) return;
          hidePopover();
        });
        // Esc 关
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape' && !popover.hidden) hidePopover();
        });
        // 滚动正文也关 — 否则浮层会"漂移", 因为我们用 fixed 锚定一次
        const readerBody = document.querySelector('.reader-body');
        if (readerBody) {
          readerBody.addEventListener('scroll', function() { if (!popover.hidden) hidePopover(); }, { passive: true });
        }
      })();

      // 在正文里查找 markText 并滚动 + 闪烁高亮(纯前端 fallback, 不依赖 EPUB CFI)。
      // 命中策略: 取前 20 个字符做 indexOf, 命中后定位到包含该文本的 element 节点。
      function locateMarkInArticle(text) {
        try {
          const article = document.querySelector('.reading');
          if (!article) return;
          const key = (text || '').trim().slice(0, 20);
          if (!key) return;
          // 用 TreeWalker 找出第一个文本节点 textContent 包含 key 的
          const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null);
          let node = walker.nextNode();
          let hit = null;
          while (node) {
            if (node.nodeValue && node.nodeValue.indexOf(key) >= 0) { hit = node; break; }
            node = walker.nextNode();
          }
          if (!hit) return;
          const el = hit.parentElement;
          if (!el) return;
          try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
          catch (e) { el.scrollIntoView({ block: 'center' }); }
          el.classList.add('flash-highlight');
          setTimeout(() => { el.classList.remove('flash-highlight'); }, 1500);
        } catch (e) { /* 命中失败静默 */ }
      }

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

/**
 * 把秒级时间戳格式化成"刚刚 / N 分钟前 / N 小时前 / N 天前 / yyyy-mm-dd"。
 * 不依赖任何库, 用作"想法/书评"卡片底部的时间显示。
 */
/**
 * 判断 EPUB 章节 HTML 是否基本"只有图片", 没有可读文本。
 *
 * 典型场景: EPUB 的封面、插图章节, HTML 大概长这样:
 *   <div><img src="../Images/cover.jpg"/></div>
 *   <svg viewBox="..."><image xlink:href="cover.jpg"/></svg>
 *
 * 这些图片 src 是 EPUB zip 包内的相对路径, 在 webview iframe (about:srcdoc) 下
 * 无法解析, 永远 404, 用户看到的就是一片白(慢慢加载的转圈图)。
 *
 * 策略: 把 HTML 标签全部 strip 掉, 看剩余文本(去 entity, 去空白)的长度。
 * 阈值 30 字符 — EPUB 章节正文通常至少几百字以上, 30 字符以下基本能笃定是封面/插图。
 */
function looksLikeImageOnlyChapter(html: string): boolean {
  if (typeof html !== 'string' || !html) return false;
  const text = html
    // 去掉 script/style 内容(防止把 css/js 代码当成文本)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // 去掉所有标签
    .replace(/<[^>]+>/g, '')
    // 去掉常见 entity (粗略)
    .replace(/&[a-z#0-9]+;/gi, '')
    // 合并空白
    .replace(/\s+/g, '')
    .trim();
  if (text.length >= 30) return false;
  // v0.0.6: 现在我们对章节 HTML 做了 fetchImageAsDataUrl 改写, 含 absolute http(s) 图片的章节
  // 完全能在线下载并 inline 渲染 — 这种章节哪怕文本极短(纯插图页/封面页)也别再挡用户,
  // 让浏览器原生把图片画出来即可。只剩"短文本 + 无可代理图片"才视为真正的 image-only 占位。
  if (/<img\b[^>]*\bsrc\s*=\s*["']?https?:\/\//i.test(html)) return false;
  if (/<image\b[^>]*\b(?:xlink:href|href)\s*=\s*["']?https?:\/\//i.test(html)) return false;
  return true;
}

/**
 * 把 EPUB chapter HTML 处理为"可以直接 innerHTML 注入外层 webview"的安全 + 主题中立内容。
 *
 * 设计思路参考 touchFish (https://github.com/ylw1997/touchFish):
 *   不用 iframe 隔离, 直接把章节正文渲染到外层 DOM, 这样能完美继承 vscode 主题色,
 *   不会有 iframe canvas 默认色 / color-scheme 兼容性问题。
 *
 * 但 innerHTML 注入有风险, 需要剥光以下"主题污染源"和"危险内容":
 *
 *   1) 文档壳: <?xml?>, <!DOCTYPE>, <html>, <head>...</head>, <body...>, </body>
 *      EPUB 章节常是完整 XHTML 文档, 不剥的话 HTML5 parser 会把内层 <link>/<title>
 *      提升到外层 head, 触发 404, 也污染 webview title
 *
 *   2) <style>...</style> 整段: EPUB 出版社硬编码白底 / 黑字 / 字体, 用 !important
 *      + 高特异性, 注入到主文档会盖过我们的 .reading CSS, 跟 vscode 主题打架
 *
 *   3) <script>...</script> 整段: webview CSP 允许 'unsafe-inline', 不剥会执行,
 *      可能抛错中断我们自己的 buildScript JS
 *
 *   4) <link>, <meta>: <link rel=stylesheet> 引用 EPUB zip 内 CSS 在 webview 下 404,
 *      <meta http-equiv> 可能触发 refresh / 改 charset
 *
 *   5) inline style 中的 background-* / color: 有些 EPUB 用
 *      <div style="background: white; color: black"> 写死前后景, 直接污染主题适配
 *
 *   6) inline event handler (onclick / onload / onerror / on*): 报错会中断交互
 *
 *   7) javascript: 协议 (href / src / xlink:href): XSS 风险
 *
 * 剩余结构 (p / h1-6 / img / a / blockquote / table / em / strong / br / span / div…)
 * 全部保留, 由外层 .reading.rich .rich-body CSS 接管样式。
 */
function sanitizeChapterForInline(html: string): string {
  if (typeof html !== 'string' || !html) return '';
  let s = html;

  // 1) 文档壳: <?xml?> / <!DOCTYPE>
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '');
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  // 2) <head>...</head> 整段 (含内部 <link>/<title>/<meta>/<style>)
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '');
  // 3) <script>...</script> 整段, 含自闭
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<script\b[^>]*\/>/gi, '');
  // 4) <style>...</style> 整段 — 关键, 干掉 EPUB 出版社主题污染源
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  // 5) 散落的 <link> / <meta> (head 已剥, 但可能有手写在 body 里的)
  s = s.replace(/<link\b[^>]*\/?>/gi, '');
  s = s.replace(/<meta\b[^>]*\/?>/gi, '');
  // 6) <html>/</html>, <body...>/</body> 包装标签 (保留中间内容)
  s = s.replace(/<\/?html\b[^>]*>/gi, '');
  s = s.replace(/<\/?body\b[^>]*>/gi, '');
  // 7) 危险内嵌: iframe / object / embed / frameset / frame / noframes / noscript
  s = s.replace(/<(iframe|object|embed|frameset|noframes|noscript|frame)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<(iframe|object|embed|frame)\b[^>]*\/?>/gi, '');

  // 8) 剥 inline event handler (双引号 / 单引号 / 无引号三种格式)
  s = s.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '');
  // 9) 剥 javascript: 协议链接
  s = s.replace(/\s(href|src|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '');

  // 10) inline style 中的 background-* / color 声明 → 干掉, 让外层主题接管
  //     保留其他 (text-align / font-style / margin / padding 等 EPUB 排版用得到的)
  const stripBgColor = (val: string): string =>
    val
      .split(';')
      .map((d) => d.trim())
      .filter((d) => {
        if (!d) return false;
        // background / background-color / background-image / bgcolor 等全干掉
        if (/^background(\s*$|[-:])/i.test(d)) return false;
        // color: xxx — 前景色, 干掉让 inherit
        if (/^color\s*:/i.test(d)) return false;
        return true;
      })
      .join('; ');
  s = s.replace(/\sstyle\s*=\s*"([^"]*)"/gi, (_m, val: string) => {
    const cleaned = stripBgColor(val);
    return cleaned ? ` style="${cleaned}"` : '';
  });
  s = s.replace(/\sstyle\s*=\s*'([^']*)'/gi, (_m, val: string) => {
    const cleaned = stripBgColor(val);
    return cleaned ? ` style='${cleaned}'` : '';
  });

  // 11) 老 HTML 属性 bgcolor / text 也能写死颜色, 一并干掉
  s = s.replace(/\s(bgcolor|text)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  return s.trim();
}

/**
 * 模仿 touchFish (https://github.com/ylw1997/touchFish) 的 injectUnderlines:
 *
 *   微信读书后端给的 range 是 "start-end" 格式的字符偏移,
 *   参考的是 EPUB 原始 HTML 字符串(包含 <html>/<head>/<body>...)的索引。
 *   把每条划线对应的 HTML 片段包成 <span class="hot-underline" data-range data-mark>,
 *   渲染后正文里就能看到大家划过的句子(虚线下划线), 点击弹想法 popover。
 *
 * 实现要点:
 *   1) **必须先注入再 sanitize** — touchFish 也是这个顺序:
 *      sanitize 会改字符串长度(剥 <style>/<script>/inline event handler 等),
 *      若 sanitize 在前, 注入位置全错位; 先注入则只剩 head 内的极少量划线被剥(可接受)。
 *   2) 按 range 的 start 倒序排序, 从大到小 splice ——
 *      这样在前一条插入后, 后续 (start 更小) 的索引依然有效。
 *   3) range 不合法 / 越界 / 命中 tag(片段含 <) 都跳过, 避免破坏 HTML 结构。
 *      tag 命中检测: 简单粗暴看 middle 是否包含 '<' 或 '>', 含则跳过。
 *   4) 同一 range 去重: bestbookmarks + underlines 有概率重叠, 优先保留带 markText 的那条。
 *
 * 参数 ranges 接受任意带 range 的对象:
 *   - BestBookmark: 带 markText (popover 检索用)
 *   - ChapterUnderline: 只带 range / count, mark 留空
 */
interface InjectableRange {
  range?: string;
  /** 仅 BestBookmark 有, 用作 popover indexOf 检索 */
  markText?: string;
}
function injectHotUnderlinesIntoHtml(
  rawHtml: string,
  ranges: InjectableRange[],
): string {
  if (typeof rawHtml !== 'string' || !rawHtml || !ranges.length) return rawHtml;
  const len = rawHtml.length;

  // 收集合法 range, 顺手排序(start 倒序)。
  // 用 Map 按 range 字符串去重, 优先保留带 markText 的那条 (后写覆盖前写)。
  const dedup = new Map<string, { start: number; end: number; range: string; mark: string }>();
  for (const r of ranges) {
    if (!r || typeof r.range !== 'string' || !r.range) continue;
    const [sRaw, eRaw] = r.range.split('-');
    const start = Number(sRaw);
    const end = Number(eRaw);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end <= start || end > len) continue;
    const prev = dedup.get(r.range);
    // 已有同 range, 且当前条 mark 为空, 就跳过 (避免空 mark 覆盖了带 mark 的)
    if (prev && !r.markText) continue;
    dedup.set(r.range, { start, end, range: r.range, mark: r.markText || prev?.mark || '' });
  }
  if (!dedup.size) {
    console.warn('[weread-vscode] injectHotUnderlinesIntoHtml: 没有合法 range, 跳过', {
      input: ranges.length,
      sampleRange: ranges[0]?.range,
      htmlLen: len,
    });
    return rawHtml;
  }
  const parsed = [...dedup.values()].sort((a, b) => b.start - a.start);

  let injected = 0;
  let skippedTag = 0;
  let result = rawHtml;
  for (const p of parsed) {
    const before = result.slice(0, p.start);
    const middle = result.slice(p.start, p.end);
    const after = result.slice(p.end);
    // 跨标签的 range 会让 middle 包含 < 或 >, 注入后 HTML 会嵌套出 bug,
    // touchFish 没处理这种情况(直接生成非法 HTML), 但浏览器宽容渲染还能跑;
    // 我们这里为了稳, 含 tag 就跳过, 不渲染那条划线。
    if (middle.indexOf('<') >= 0 || middle.indexOf('>') >= 0) {
      skippedTag++;
      continue;
    }
    // 注入 — data-range 给后端定位用, data-mark 给前端 popover 检索想法用
    const markAttr = escapeAttr(p.mark);
    const rangeAttr = escapeAttr(p.range);
    result =
      `${before}<span class="hot-underline" data-range="${rangeAttr}" data-mark="${markAttr}">${middle}</span>${after}`;
    injected++;
  }
  console.log('[weread-vscode] injectHotUnderlinesIntoHtml', {
    inputRanges: ranges.length,
    dedupRanges: dedup.size,
    injected,
    skippedTag,
    htmlLen: len,
  });
  return result;
}

/**
 * 微信读书部分章节 HTML 是被 HTML entity **整体转义**过的字符串
 * (整个章节包成一个文本节点, 里面是 `&lt;p&gt;...&lt;/p&gt;` 这种), 直接 innerHTML
 * 渲染只会看到一堆 `<p>` 字面量。touchFish 的处理是 DOMParser + textContent
 * 做一次反解。Node 端没 DOMParser, 用最小 entity 表替换 (覆盖 lt/gt/amp/quot/apos
 * + 数字字符引用 &#39; / &#x3c;), 已能应付微信读书所有已知章节。
 *
 * 判定: 若 html 在前 2000 字内出现 `&lt;` 且 **不存在真实** `<`, 说明就是被 entity 包过的。
 * (有 `<` 说明已是真实 HTML, 不要重复解码搞反 — entity 文学引文可能合法存在)
 */
function decodeEntityEscapedHtmlIfNeeded(html: string): string {
  if (typeof html !== 'string' || !html) return html;
  const head = html.slice(0, 2000);
  if (head.indexOf('&lt;') < 0) return html;
  // 真实 HTML 标签存在就别反解, 避免把内容文字里的 `&lt;` 也变成 `<` 破坏页面
  if (/<\s*(p|div|span|h[1-6]|img|br|section|article|body|html)\b/i.test(head)) return html;
  console.log('[weread-vscode] decodeEntityEscapedHtmlIfNeeded: 检测到 entity-escaped 章节, 反解中');
  const decoded = html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x3c;/gi, '<')
    .replace(/&#x3e;/gi, '>')
    .replace(/&#60;/g, '<')
    .replace(/&#62;/g, '>')
    .replace(/&nbsp;/g, ' ')
    // amp 必须最后做, 否则上面所有 &xxx; 都会被先变成 &x;
    .replace(/&amp;/g, '&');
  return decoded;
}

/**
 * 模仿 touchFish 把 EPUB 章节内的 <img class="qqreader-footnote" alt="..."/>
 * (微信读书脚注图标, alt 里塞着注释正文) 转成统一的小图标 + 可点击容器:
 *   <span class="weread-footnote-wrapper" data-note="..."><span class="weread-footnote-icon"/></span>
 *
 * 之所以做转换:
 *   - 原生 <img> 在 webview 里加载不到(qqreader-footnote 是出版社私有相对路径,
 *     EPUB zip 内的资源 webview 没法去拿), 会显示一个破图标
 *   - 把 alt 文本提到 data-note, CSS 用 weread CDN 上的统一小图标做 background-image,
 *     用户点击就能弹出脚注内容
 *
 * 用正则替换(不上 DOMParser): EPUB 字符串大, regex 比 jsdom 快也省依赖。
 */
function transformFootnotes(html: string): string {
  if (typeof html !== 'string' || !html) return html;
  // 命中所有 <img ... class="...qqreader-footnote..." ... />, 大小写不敏感, 自闭合可有可无
  return html.replace(
    /<img\b([^>]*\bclass\s*=\s*["'][^"']*\bqqreader-footnote\b[^"']*["'][^>]*)\/?>/gi,
    (match, attrs: string) => {
      // 提取 alt / title 当作脚注正文
      const altMatch = attrs.match(/\balt\s*=\s*"([^"]*)"/i) ||
        attrs.match(/\balt\s*=\s*'([^']*)'/i);
      const titleMatch = attrs.match(/\btitle\s*=\s*"([^"]*)"/i) ||
        attrs.match(/\btitle\s*=\s*'([^']*)'/i);
      const note = (altMatch?.[1] ?? titleMatch?.[1] ?? '').trim();
      if (!note) return ''; // 没正文的脚注就直接吃掉破图标
      return `<span class="weread-footnote-wrapper" data-note="${escapeAttr(note)}" title="点击查看注释"><span class="weread-footnote-icon"></span></span>`;
    },
  );
}

function formatRelativeTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const ms = seconds * 1000;
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


