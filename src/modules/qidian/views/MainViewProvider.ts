import * as vscode from 'vscode';
import { QidianClient } from '../api/QidianClient';
import { QidianAuthService } from '../auth/AuthService';
import { QidianBook, QidianChapter, QidianChapterContent, QidianShelfGroup, QidianVolume } from '../types';
import {
  DEFAULT_RANK,
  RANK_CATEGORIES,
  RANK_DEFS,
  SEARCH_SORTS,
  getBookUrl,
  getChapterUrl,
  getRankDef,
} from '../api/qidianParse';
import {
  DEFAULT_READING_PREFS,
  ReadingPrefs,
  loadReadingPrefs,
  mergeReadingPrefs,
  saveReadingPrefs,
} from '../../weread/views/readingPrefs';
import {
  SHELF_GROUPS,
  SHELF_SORTS,
  ShelfGroupBy,
  ShelfGroupView,
  ShelfSortBy,
  StoreMode,
  Tab,
} from './viewState';
import { renderQidianHtml } from './qidianRender';

interface LastReadSnapshot {
  bookId: string;
  title?: string;
  author?: string;
  cover?: string;
  chapterId?: string;
}

const KEY_LAST_READ = 'qidian.lastRead';
const KEY_TAB = 'qidian.tab';
const KEY_SHELF_VIEW = 'qidian.shelfView';
const KEY_STORE_VIEW = 'qidian.storeView';
/** 排版偏好独立于 Folio, 两边各调各的 */
const KEY_READING_PREFS = 'qidian.readingPrefs.v1';

/** 章节正文内存缓存上限 (进程内 LRU, 翻回上一章 / 预拉下一章命中) */
const CHAPTER_CACHE_MAX = 30;

/**
 * Saga (起点中文网) 侧栏视图: 书架 / 书城 / 在读 三个 tab。
 *
 * 交互与 Folio (微信读书) 对齐:
 *   - 顶部 tabbar 三段, 书城不依赖登录 (搜索 / 榜单 / 免费章节阅读都不需要 Cookie)
 *   - 书架: 本地搜索 (纯前端过滤, 不打断中文输入法) / 云端分组 / 排序 / 折叠
 *   - 书城: 搜索 (服务端排序) + 榜单 & 题材 chips + 加载更多 + 加入书架
 *   - 在读: inline 正文 + 目录抽屉 (按卷分组, 可搜索) + Aa 阅读设置 + 键盘翻页 + 云端进度同步
 *
 * 与 Folio 的差异 (起点平台限制):
 *   - VIP 章节在 web 端加密 / 字体反爬下发, 插件不破解, 只给试读片段 + "浏览器阅读" 入口
 *   - 起点没有微信读书那样的"想法 / 划线"开放数据, 故没有社交抽屉
 *
 * 渲染策略同 Folio: 状态变更后 render() 整页重建 (HTML 见 qidianRender.ts);
 * 滚动位置由前端按 data-scroll-key 存进 webview state, 重建后恢复。
 */
export class QidianMainViewProvider implements vscode.WebviewViewProvider {
  // 必须与 package.json views.qidianVscode[0].id 一致
  public static readonly viewType = 'qidianVscode.main';

  private view: vscode.WebviewView | undefined;
  private tab: Tab = 'store';
  private invalidBannerDismissed = false;

  // ---- 书架 ----
  private books: QidianBook[] = [];
  private groups: QidianShelfGroup[] = [];
  private shelfLoading = false;
  private shelfError: string | null = null;
  private shelfLoaded = false;
  private pendingShelfLoad = false;
  private expandedGroups = new Set<string>();
  private shelfKeyword = '';
  private shelfGroupBy: ShelfGroupBy = 'group';
  private shelfSortBy: ShelfSortBy = 'default';

  // ---- 书城 ----
  private storeMode: StoreMode = 'rank';
  private rankKey: string = DEFAULT_RANK;
  private rankCatId = -1;
  private storeKeyword = '';
  private searchSortKey = 'default';
  private storeBooks: QidianBook[] = [];
  private storeLoading = false;
  private storeLoadingMore = false;
  private storeError: string | null = null;
  private storeHasMore = false;
  private storePage = 1;
  private storeTotal = 0;
  /** 书城异步 token, 丢弃过期回包 (快速切榜单 / 连续搜索) */
  private storeToken = 0;
  private storeInitialized = false;
  /** 搜索 / 清空后把焦点还给搜索框 (整页重建会丢焦点) */
  private storeFocusSearch = false;
  private storeCatsExpanded = false;
  /** 本会话内刚加入书架的书 — 按钮立刻变"已在书架", 不必全量刷新书架 */
  private storeAddedBookIds = new Set<string>();

  // ---- 阅读 ----
  private currentBook: QidianBook | undefined;
  private chapters: QidianChapter[] = [];
  private volumes: QidianVolume[] = [];
  private currentIdx = -1;
  private content: QidianChapterContent | null = null;
  private chapterLoading = false;
  private chapterError: string | null = null;
  private catalogError: string | null = null;
  private loadToken = 0;
  private pendingRestoreChapterId: string | undefined;
  private lastReportAt = 0;
  private chapterCache = new Map<string, QidianChapterContent>();
  private prefetching = new Set<string>();

  private readingPrefs: ReadingPrefs = DEFAULT_READING_PREFS;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: QidianClient,
    private readonly auth: QidianAuthService,
  ) {
    const snap = context.globalState.get<LastReadSnapshot>(KEY_LAST_READ);
    if (snap?.bookId) {
      this.currentBook = { bookId: snap.bookId, title: snap.title ?? '', author: snap.author, cover: snap.cover };
      this.pendingRestoreChapterId = snap.chapterId;
    }
    const savedTab = context.globalState.get<Tab>(KEY_TAB);
    if (savedTab === 'shelf' || savedTab === 'store' || savedTab === 'reader') {
      this.tab = savedTab;
    } else if (auth.isLoggedIn()) {
      this.tab = 'shelf';
    }

    const savedView = context.globalState.get<{ groupBy?: string; sortBy?: string }>(KEY_SHELF_VIEW);
    if (SHELF_GROUPS.some((g) => g.key === savedView?.groupBy)) this.shelfGroupBy = savedView!.groupBy as ShelfGroupBy;
    if (SHELF_SORTS.some((s) => s.key === savedView?.sortBy)) this.shelfSortBy = savedView!.sortBy as ShelfSortBy;

    const savedStore = context.globalState.get<{ rankKey?: string; catId?: number }>(KEY_STORE_VIEW);
    if (savedStore?.rankKey && RANK_DEFS.some((r) => r.key === savedStore.rankKey)) this.rankKey = savedStore.rankKey;
    if (typeof savedStore?.catId === 'number' && RANK_CATEGORIES.some((c) => c.id === savedStore.catId)) {
      this.rankCatId = savedStore.catId;
    }

    this.readingPrefs = loadReadingPrefs(context, KEY_READING_PREFS);

    auth.onDidChangeLoginState(() => {
      this.books = [];
      this.groups = [];
      this.shelfError = null;
      this.shelfLoaded = false;
      this.pendingShelfLoad = true;
      void this.loadShelfIfNeeded();
    });
    auth.onDidChangeCookieValidity(() => {
      // 状态翻转时重置"已关闭横幅", 新一轮失效必须再提示一次
      this.invalidBannerDismissed = false;
      this.render();
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

    if (this.auth.isLoggedIn() && !this.shelfLoaded && !this.shelfLoading) this.pendingShelfLoad = true;
    void this.loadShelfIfNeeded();
    if (this.tab === 'reader' && this.currentBook && this.chapters.length === 0) {
      void this.loadBookInternal(this.currentBook);
    }
    if (this.tab === 'store' && !this.storeInitialized) void this.loadRank();
    this.render();
  }

  // ---------------- 公共入口 (命令调用) ----------------

  private async reveal(): Promise<void> {
    if (!this.view) {
      try {
        await vscode.commands.executeCommand(`${QidianMainViewProvider.viewType}.focus`);
      } catch {
        await vscode.commands.executeCommand('workbench.view.extension.qidianVscode');
      }
    }
    this.view?.show?.(true);
  }

  private setTab(tab: Tab): void {
    this.tab = tab;
    void this.context.globalState.update(KEY_TAB, tab);
  }

  public async refreshShelf(): Promise<void> {
    await this.reveal();
    this.setTab('shelf');
    this.pendingShelfLoad = true;
    await this.loadShelfIfNeeded(true);
  }

  public async openStore(keyword?: string): Promise<void> {
    await this.reveal();
    this.setTab('store');
    const kw = (keyword ?? '').trim();
    if (kw) return this.runSearch(kw);
    if (!this.storeInitialized) return this.loadRank();
    this.render();
  }

  public async openBook(book: QidianBook, chapterId?: string): Promise<void> {
    if (!book?.bookId) return;
    await this.reveal();
    this.setTab('reader');
    if (chapterId) this.pendingRestoreChapterId = chapterId;
    else if (this.currentBook?.bookId !== book.bookId) this.pendingRestoreChapterId = undefined;
    await this.loadBookInternal(book);
  }

  /** 当前在读章节的浏览器地址 */
  public currentUrl(): string | undefined {
    if (!this.currentBook) return undefined;
    const ch = this.chapters[this.currentIdx];
    return ch ? getChapterUrl(this.currentBook.bookId, ch.chapterId) : getBookUrl(this.currentBook.bookId);
  }

  /** 紧急恢复: 清"在读"状态回到书架 (命令面板触发, 不依赖 webview 通道) */
  public async resetReadingState(): Promise<void> {
    this.loadToken++;
    this.currentBook = undefined;
    this.chapters = [];
    this.volumes = [];
    this.currentIdx = -1;
    this.content = null;
    this.chapterLoading = false;
    this.chapterError = null;
    this.catalogError = null;
    this.pendingRestoreChapterId = undefined;
    this.chapterCache.clear();
    this.setTab('shelf');
    await this.context.globalState.update(KEY_LAST_READ, undefined);
    this.render();
    vscode.window.showInformationMessage('Saga：已清除"在读"状态，已回到书架。');
  }

  // ---------------- 书架 ----------------

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
      this.groups = shelf.groups;
      this.shelfLoaded = true;
      if (this.storeBooks.length > 0) this.storeBooks = this.markShelfState(this.storeBooks);
      // 新设备 / 首次登录: 本地没有"在读"快照时, 用书架里最近读过的书补位, 多端打通
      if (!this.currentBook) {
        const recent = this.books.find((b) => b.isRead && b.readChapterId);
        if (recent) {
          this.currentBook = recent;
          this.pendingRestoreChapterId = recent.readChapterId;
          this.persistLastRead();
        }
      }
    } catch (e) {
      this.shelfError = errMsg(e);
      this.books = [];
      this.groups = [];
    } finally {
      this.shelfLoading = false;
      this.render();
    }
  }

  private persistShelfView(): void {
    void this.context.globalState.update(KEY_SHELF_VIEW, { groupBy: this.shelfGroupBy, sortBy: this.shelfSortBy });
  }

  /**
   * 书架分桶 + 组内排序。不做关键词过滤 — 搜索是纯前端 toggle (书卡全量在 DOM 里)。
   *
   * 云端分组: 自建分组优先; 没进任何自建分组的书归"默认书架"。
   * 这样无论起点 gid=-100 是"全部书"还是"仅默认分组"语义, 都不会重复展示。
   */
  private computeGroups(): ShelfGroupView[] {
    const books = this.books;
    if (books.length === 0) return [];
    const out: ShelfGroupView[] = [];
    if (this.shelfGroupBy === 'none') {
      out.push({ name: '全部', books });
    } else if (this.shelfGroupBy === 'status') {
      const reading = books.filter((b) => b.isRead);
      const untouched = books.filter((b) => !b.isRead);
      if (reading.length) out.push({ name: '在读', books: reading });
      if (untouched.length) out.push({ name: '未开始', books: untouched });
    } else {
      const custom = this.groups.filter((g) => g.groupId !== '-100');
      const assigned = new Set<string>();
      for (const g of custom) {
        const items = books.filter((b) => b.groupIds?.includes(g.groupId));
        items.forEach((b) => assigned.add(b.bookId));
        if (items.length) out.push({ name: g.name, books: items });
      }
      const rest = books.filter((b) => !assigned.has(b.bookId));
      if (rest.length) out.push({ name: custom.length ? '默认书架' : '全部', books: rest });
    }
    if (this.shelfSortBy !== 'default') {
      for (const g of out) g.books = this.sortShelfBooks(g.books);
    }
    return out;
  }

  private sortShelfBooks(books: QidianBook[]): QidianBook[] {
    const list = [...books];
    if (this.shelfSortBy === 'update') {
      // Array#sort 稳定: 同为"有更新"的书保持最近阅读顺序
      list.sort((a, b) => Number(!!b.hasUpdate) - Number(!!a.hasUpdate));
    } else if (this.shelfSortBy === 'title') {
      list.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', 'zh-CN'));
    }
    return list;
  }

  // ---------------- 书城 ----------------

  private persistStoreView(): void {
    void this.context.globalState.update(KEY_STORE_VIEW, { rankKey: this.rankKey, catId: this.rankCatId });
  }

  private resetStoreList(): void {
    this.storeLoading = true;
    this.storeLoadingMore = false;
    this.storeError = null;
    this.storeHasMore = false;
    this.storePage = 1;
    this.storeTotal = 0;
    this.storeBooks = [];
  }

  private async loadRank(rankKey?: string, catId?: number): Promise<void> {
    const token = ++this.storeToken;
    this.storeInitialized = true;
    this.storeMode = 'rank';
    if (rankKey) this.rankKey = getRankDef(rankKey).key;
    if (typeof catId === 'number') this.rankCatId = catId;
    this.storeKeyword = '';
    this.persistStoreView();
    this.resetStoreList();
    this.render();
    try {
      const res = await this.client.getRankBooks(this.rankKey, this.rankCatId, 1);
      if (token !== this.storeToken) return;
      this.storeBooks = this.markShelfState(res.books);
      this.storeHasMore = res.hasMore;
      this.storeTotal = res.total;
    } catch (e) {
      if (token !== this.storeToken) return;
      this.storeError = errMsg(e);
    } finally {
      if (token === this.storeToken) {
        this.storeLoading = false;
        this.render();
      }
    }
  }

  private async runSearch(keyword: string, sortKey?: string): Promise<void> {
    const kw = (keyword ?? '').trim();
    if (!kw) return this.loadRank();
    const token = ++this.storeToken;
    this.storeInitialized = true;
    this.storeMode = 'search';
    this.storeKeyword = kw;
    if (sortKey && SEARCH_SORTS.some((s) => s.key === sortKey)) this.searchSortKey = sortKey;
    this.resetStoreList();
    this.storeFocusSearch = true;
    this.render();
    try {
      const res = await this.client.searchBooks(kw, 1, this.searchOrderBy());
      if (token !== this.storeToken) return;
      this.storeBooks = this.markShelfState(res.books);
      this.storeHasMore = res.hasMore;
      this.storeTotal = res.total;
    } catch (e) {
      if (token !== this.storeToken) return;
      this.storeError = errMsg(e);
    } finally {
      if (token === this.storeToken) {
        this.storeLoading = false;
        this.render();
      }
    }
  }

  private searchOrderBy(): string {
    return SEARCH_SORTS.find((s) => s.key === this.searchSortKey)?.value ?? '';
  }

  private async loadStoreMore(): Promise<void> {
    if (!this.storeHasMore || this.storeLoading || this.storeLoadingMore) return;
    const token = ++this.storeToken;
    this.storeLoadingMore = true;
    this.render();
    const nextPage = this.storePage + 1;
    try {
      const res =
        this.storeMode === 'search'
          ? await this.client.searchBooks(this.storeKeyword, nextPage, this.searchOrderBy())
          : await this.client.getRankBooks(this.rankKey, this.rankCatId, nextPage);
      if (token !== this.storeToken) return;
      // 去重: 翻页边界偶尔会重复给同一本
      const seen = new Set(this.storeBooks.map((b) => b.bookId));
      const fresh = this.markShelfState(res.books).filter((b) => !seen.has(b.bookId));
      this.storeBooks = [...this.storeBooks, ...fresh];
      this.storePage = nextPage;
      this.storeHasMore = res.hasMore && fresh.length > 0;
    } catch (e) {
      if (token !== this.storeToken) return;
      vscode.window.showWarningMessage(`Saga：加载更多失败 — ${errMsg(e)}`);
    } finally {
      if (token === this.storeToken) {
        this.storeLoadingMore = false;
        this.render();
      }
    }
  }

  /** "已在书架"三处合并: 接口 isInShelf + 已加载书架 + 本会话刚加入 */
  private markShelfState(books: QidianBook[]): QidianBook[] {
    const shelfIds = new Set(this.books.map((b) => b.bookId));
    return books.map((b) => ({
      ...b,
      inShelf: b.inShelf === true || shelfIds.has(b.bookId) || this.storeAddedBookIds.has(b.bookId),
    }));
  }

  private findKnownBook(bookId: string): QidianBook | undefined {
    return (
      this.storeBooks.find((b) => b.bookId === bookId) ??
      this.books.find((b) => b.bookId === bookId) ??
      (this.currentBook?.bookId === bookId ? this.currentBook : undefined)
    );
  }

  private async addToShelf(bookId: string): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      const pick = await vscode.window.showInformationMessage('加入书架需要先登录起点', '导入 Cookie');
      if (pick === '导入 Cookie') await vscode.commands.executeCommand('qidian.importCookie');
      return;
    }
    const book = this.findKnownBook(bookId);
    try {
      const r = await this.client.addToShelf(bookId);
      this.storeAddedBookIds.add(bookId);
      this.storeBooks = this.storeBooks.map((b) => (b.bookId === bookId ? { ...b, inShelf: true } : b));
      if (this.currentBook?.bookId === bookId) this.currentBook = { ...this.currentBook, inShelf: true };
      // 书架下次切过去时重拉, 新书就在里面
      this.pendingShelfLoad = true;
      this.shelfLoaded = false;
      this.render();
      const name = book?.title ? `《${book.title}》` : '';
      vscode.window.showInformationMessage(r === 'exists' ? `${name}已经在书架里了` : `已加入书架：${name}`);
    } catch (e) {
      vscode.window.showErrorMessage(`加入书架失败：${errMsg(e)}`);
    }
  }

  // ---------------- 阅读 ----------------

  private async loadBookInternal(book: QidianBook): Promise<void> {
    if (!this.view) return;
    const token = ++this.loadToken;
    const isSwitch = this.currentBook?.bookId !== book.bookId;
    this.currentBook = isSwitch ? { ...book } : { ...this.currentBook, ...book };
    this.chapters = [];
    this.volumes = [];
    this.currentIdx = -1;
    this.content = null;
    this.chapterError = null;
    this.catalogError = null;
    this.chapterLoading = true;
    this.render();

    const explicit = this.pendingRestoreChapterId;
    this.pendingRestoreChapterId = undefined;

    const [catalogOrErr, cloud] = await Promise.all([
      this.client.getCatalog(book.bookId).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
      this.client.getReadStatus(book.bookId),
    ]);
    if (token !== this.loadToken) return;

    if (catalogOrErr instanceof Error) {
      this.chapterLoading = false;
      this.catalogError = catalogOrErr.message;
      this.render();
      return;
    }
    this.chapters = catalogOrErr.chapters;
    this.volumes = catalogOrErr.volumes;
    if (catalogOrErr.bookName && !this.currentBook.title) {
      this.currentBook = { ...this.currentBook, title: catalogOrErr.bookName };
    }
    if (cloud?.isInBookShelf !== undefined) {
      this.currentBook = { ...this.currentBook, inShelf: cloud.isInBookShelf || this.currentBook.inShelf };
    } else if (this.books.some((b) => b.bookId === book.bookId)) {
      this.currentBook = { ...this.currentBook, inShelf: true };
    }

    // 章节定位优先级: 云端进度 > 书架 readCid > 显式指定 / 本地快照 > 第一章
    // (云端优先保证多端互通: 手机上读到哪, 这里就打开到哪)
    const candidates = [cloud?.readChapterId, book.readChapterId, explicit];
    let idx = -1;
    for (const id of candidates) {
      if (!id) continue;
      idx = this.chapters.findIndex((c) => c.chapterId === id);
      if (idx >= 0) break;
    }
    this.currentIdx = idx >= 0 ? idx : 0;
    this.persistLastRead();
    await this.loadCurrentChapter(token);
    void this.reportProgress();
  }

  private cacheKey(bookId: string, chapterId: string): string {
    return `${bookId}:${chapterId}`;
  }

  private putCache(bookId: string, c: QidianChapterContent): void {
    const key = this.cacheKey(bookId, c.chapterId);
    this.chapterCache.delete(key);
    this.chapterCache.set(key, c);
    while (this.chapterCache.size > CHAPTER_CACHE_MAX) {
      const oldest = this.chapterCache.keys().next().value;
      if (oldest === undefined) break;
      this.chapterCache.delete(oldest);
    }
  }

  private async loadCurrentChapter(externalToken?: number): Promise<void> {
    if (!this.view || !this.currentBook) return;
    const token = externalToken ?? ++this.loadToken;
    const chapter = this.chapters[this.currentIdx];
    if (!chapter) {
      this.chapterLoading = false;
      this.render();
      return;
    }
    const bookId = this.currentBook.bookId;
    const cached = this.chapterCache.get(this.cacheKey(bookId, chapter.chapterId));
    if (cached) {
      this.content = cached;
      this.chapterError = null;
      this.chapterLoading = false;
      this.render();
      this.schedulePrefetch(bookId, this.currentIdx);
      return;
    }

    this.chapterLoading = true;
    this.content = null;
    this.chapterError = null;
    this.render();
    try {
      const res = await this.client.getChapter(bookId, chapter);
      if (token !== this.loadToken) return;
      this.content = res;
      // 只缓存"读得了"的结果 — 被拦的章节过会儿可能已购买 / 风控解除
      if (res.html && !res.blockedReason) this.putCache(bookId, res);
    } catch (e) {
      if (token !== this.loadToken) return;
      this.chapterError = errMsg(e);
    } finally {
      if (token === this.loadToken) {
        this.chapterLoading = false;
        this.render();
        if (this.content?.html && !this.content.blockedReason) this.schedulePrefetch(bookId, this.currentIdx);
      }
    }
  }

  /** 后台静默预拉下一章 (仅非 VIP 章节), 翻页零等待 */
  private schedulePrefetch(bookId: string, idx: number): void {
    if (!vscode.workspace.getConfiguration('qidian').get<boolean>('prefetchNextChapter', true)) return;
    const next = this.chapters[idx + 1];
    if (!next || next.vip) return;
    const key = this.cacheKey(bookId, next.chapterId);
    if (this.chapterCache.has(key) || this.prefetching.has(key)) return;
    this.prefetching.add(key);
    void this.client
      .getChapter(bookId, next)
      .then((res) => {
        if (res.html && !res.blockedReason) this.putCache(bookId, res);
      })
      .catch(() => undefined)
      .finally(() => this.prefetching.delete(key));
  }

  private async switchChapter(idx: number): Promise<void> {
    if (idx < 0 || idx >= this.chapters.length) return;
    this.currentIdx = idx;
    this.persistLastRead();
    void this.reportProgress();
    await this.loadCurrentChapter();
  }

  private persistLastRead(): void {
    if (!this.currentBook) return;
    const ch = this.chapters[this.currentIdx];
    const snap: LastReadSnapshot = {
      bookId: this.currentBook.bookId,
      title: this.currentBook.title,
      author: this.currentBook.author,
      cover: this.currentBook.cover,
      chapterId: ch?.chapterId,
    };
    void this.context.globalState.update(KEY_LAST_READ, snap);
    // 顺手更新书架里这本书的"读至", 不必重拉书架
    if (ch) {
      this.books = this.books.map((b) =>
        b.bookId === snap.bookId ? { ...b, isRead: true, readChapterId: ch.chapterId, readChapterName: ch.title } : b,
      );
    }
  }

  /** 上报云端进度 (与手机 / 网页互通), 1s 节流, 失败静默 */
  private async reportProgress(): Promise<void> {
    if (!this.currentBook) return;
    const ch = this.chapters[this.currentIdx];
    if (!ch) return;
    const now = Date.now();
    if (now - this.lastReportAt < 1000) return;
    this.lastReportAt = now;
    await this.client.reportReadStatus(this.currentBook.bookId, ch);
  }

  // ---------------- 消息分发 ----------------

  private handleMessage(msg: { type?: string; payload?: unknown }): void {
    if (!msg || typeof msg.type !== 'string') return;
    const p = (msg.payload ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
    // 会触发 render 的书架操作都捎带搜索框当前值, 先吸收, render 时回填输入框
    if (typeof p.keyword === 'string' && ['shelfGroupBy', 'shelfSortBy', 'toggleGroup'].includes(msg.type)) {
      this.shelfKeyword = p.keyword;
    }

    switch (msg.type) {
      case 'switchTab': {
        const next = s('tab');
        if (next !== 'shelf' && next !== 'store' && next !== 'reader') break;
        this.setTab(next);
        if (next === 'reader' && this.currentBook && this.chapters.length === 0 && !this.chapterLoading) {
          void this.loadBookInternal(this.currentBook);
        } else if (next === 'store' && !this.storeInitialized) {
          void this.loadRank();
        } else if (next === 'shelf' && this.auth.isLoggedIn() && !this.shelfLoaded) {
          this.pendingShelfLoad = true;
          void this.loadShelfIfNeeded();
        } else {
          this.render();
        }
        break;
      }
      case 'login':
        void vscode.commands.executeCommand('qidian.importCookie');
        break;
      case 'dismissInvalidBanner':
        this.invalidBannerDismissed = true;
        this.render();
        break;

      // ---- 书架 ----
      case 'refreshShelf':
        this.pendingShelfLoad = true;
        void this.loadShelfIfNeeded(true);
        break;
      case 'openBook': {
        const id = s('bookId');
        const book = id ? this.books.find((b) => b.bookId === id) : undefined;
        if (!book) break;
        if (book.accessDenied) {
          void vscode.window
            .showWarningMessage(`《${book.title}》当前不可阅读（可能已下架或无版权）`, '在浏览器打开')
            .then((pick) => {
              if (pick) void vscode.env.openExternal(vscode.Uri.parse(getBookUrl(book.bookId)));
            });
          break;
        }
        void this.openBook(book);
        break;
      }
      case 'shelfSearchState':
        // 只记录, 绝不 render — 否则会打断正在拼音的中文输入法 (同 Folio v3.3.0 修复)
        this.shelfKeyword = s('keyword') ?? '';
        break;
      case 'shelfGroupBy': {
        const hit = SHELF_GROUPS.find((g) => g.key === s('key'));
        if (hit && hit.key !== this.shelfGroupBy) {
          this.shelfGroupBy = hit.key;
          this.expandedGroups.clear();
          const groups = this.computeGroups();
          // 桶少时直接全展开, 免得再点一次
          if (groups.length <= 4) groups.forEach((g) => this.expandedGroups.add(g.name));
          this.persistShelfView();
          this.render();
        }
        break;
      }
      case 'shelfSortBy': {
        const hit = SHELF_SORTS.find((x) => x.key === s('key'));
        if (hit && hit.key !== this.shelfSortBy) {
          this.shelfSortBy = hit.key;
          this.persistShelfView();
          this.render();
        }
        break;
      }
      case 'toggleGroup': {
        const name = s('name');
        if (name === undefined) break;
        if (this.expandedGroups.has(name)) this.expandedGroups.delete(name);
        else this.expandedGroups.add(name);
        this.render();
        break;
      }
      case 'expandAll':
        this.computeGroups().forEach((g) => this.expandedGroups.add(g.name));
        this.render();
        break;
      case 'collapseAll':
        this.expandedGroups.clear();
        this.render();
        break;

      // ---- 书城 ----
      case 'storeSearch':
        void this.runSearch(s('keyword') ?? '');
        break;
      case 'storeClearSearch':
        this.storeFocusSearch = true;
        void this.loadRank();
        break;
      case 'storeSelectRank': {
        const key = s('key');
        if (key) void this.loadRank(key);
        break;
      }
      case 'storeSelectCat': {
        const id = Number(p.id);
        if (Number.isFinite(id)) void this.loadRank(undefined, id);
        break;
      }
      case 'storeToggleMoreCats':
        this.storeCatsExpanded = !this.storeCatsExpanded;
        this.render();
        break;
      case 'storeSort': {
        const key = s('key');
        if (key && key !== this.searchSortKey && this.storeMode === 'search') void this.runSearch(this.storeKeyword, key);
        break;
      }
      case 'storeRefresh':
        if (this.storeMode === 'search') void this.runSearch(this.storeKeyword);
        else void this.loadRank();
        break;
      case 'storeLoadMore':
        void this.loadStoreMore();
        break;
      case 'storeOpenBook': {
        const id = s('bookId');
        const b = id ? this.findKnownBook(id) : undefined;
        if (b) void this.openBook(b);
        break;
      }
      case 'storeAddShelf': {
        const id = s('bookId');
        if (id) void this.addToShelf(id);
        break;
      }
      case 'addCurrentToShelf':
        if (this.currentBook) void this.addToShelf(this.currentBook.bookId);
        break;
      case 'storeOpenInBrowser': {
        const id = s('bookId');
        if (id) void vscode.env.openExternal(vscode.Uri.parse(getBookUrl(id)));
        break;
      }

      // ---- 阅读 ----
      case 'selectChapter': {
        const idx = Number(p.idx);
        if (Number.isInteger(idx)) void this.switchChapter(idx);
        break;
      }
      case 'prev':
        void this.switchChapter(this.currentIdx - 1);
        break;
      case 'next':
        void this.switchChapter(this.currentIdx + 1);
        break;
      case 'retry':
        if (this.catalogError && this.currentBook) void this.loadBookInternal(this.currentBook);
        else void this.loadCurrentChapter();
        break;
      case 'openInBrowser': {
        const url = this.currentUrl();
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case 'updateReadingPref': {
        // 前端已 setProperty 即时生效, 这里只持久化, 不 render
        const key = s('key');
        if (!key) break;
        const next = mergeReadingPrefs(this.readingPrefs, { [key]: p.value } as Partial<ReadingPrefs>);
        if (next === this.readingPrefs) break;
        this.readingPrefs = next;
        void saveReadingPrefs(this.context, next, KEY_READING_PREFS);
        break;
      }
      case 'resetReadingPrefs':
        this.readingPrefs = { ...DEFAULT_READING_PREFS };
        void saveReadingPrefs(this.context, this.readingPrefs, KEY_READING_PREFS);
        this.render();
        break;
      default:
        break;
    }
  }

  // ---------------- 渲染 ----------------

  private render(): void {
    if (!this.view) return;
    const focusSearch = this.storeFocusSearch;
    // 焦点标记留到"结果那一帧"才消费: 一次搜索渲染两次 (骨架屏 → 结果)
    if (!this.storeLoading) this.storeFocusSearch = false;
    this.view.webview.html = renderQidianHtml({
      cspSource: this.view.webview.cspSource,
      tab: this.tab,
      loggedIn: this.auth.isLoggedIn(),
      showInvalidBanner: this.auth.isCookieKnownInvalid() && !this.invalidBannerDismissed,
      shelfLoading: this.shelfLoading,
      shelfError: this.shelfError,
      books: this.books,
      groups: this.groups,
      shelfGroups: this.tab === 'shelf' ? this.computeGroups() : [],
      expandedGroups: this.expandedGroups,
      shelfKeyword: this.shelfKeyword,
      shelfGroupBy: this.shelfGroupBy,
      shelfSortBy: this.shelfSortBy,
      storeMode: this.storeMode,
      rankKey: this.rankKey,
      rankCatId: this.rankCatId,
      storeKeyword: this.storeKeyword,
      searchSortKey: this.searchSortKey,
      storeBooks: this.storeBooks,
      storeLoading: this.storeLoading,
      storeLoadingMore: this.storeLoadingMore,
      storeError: this.storeError,
      storeHasMore: this.storeHasMore,
      storeTotal: this.storeTotal,
      storeFocusSearch: focusSearch,
      storeCatsExpanded: this.storeCatsExpanded,
      currentBook: this.currentBook,
      chapters: this.chapters,
      volumes: this.volumes,
      currentIdx: this.currentIdx,
      content: this.content,
      chapterLoading: this.chapterLoading,
      chapterError: this.chapterError,
      catalogError: this.catalogError,
      readingPrefs: this.readingPrefs,
    });
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
