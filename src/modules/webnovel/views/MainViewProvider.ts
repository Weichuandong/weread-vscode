import * as vscode from 'vscode';
import { WebNovelClient } from '../api/WebNovelClient';
import { hostOf, titleKey, urlKey, urlPathKey } from '../api/htmlUtil';
import { WebBookRecord, WebChapterContent, WebChapterLink } from '../types';
import { ChapterStore } from '../services/ChapterStore';
import { CacheDownloader, CacheProgressEvent } from '../services/CacheDownloader';
import {
  DEFAULT_READING_PREFS,
  ReadingPrefs,
  loadReadingPrefs,
  mergeReadingPrefs,
  saveReadingPrefs,
} from '../../weread/views/readingPrefs';
import { WebNovelTab, renderWebNovelHtml } from './webnovelRender';

const KEY_TAB = 'webnovel.tab';
const KEY_RECORDS = 'webnovel.records';
/** 排版偏好独立于 Folio / Saga */
const KEY_READING_PREFS = 'webnovel.readingPrefs.v1';

const RECORDS_MAX = 50;
/** 整章内存缓存 (LRU): 翻回上一章 / 预拉下一章命中 */
const CHAPTER_CACHE_MAX = 30;

interface BookState {
  /** 书的唯一 key: 目录 URL, 没有目录时为首次打开的章节 URL */
  key: string;
  catalogUrl?: string;
  bookTitle?: string;
  author?: string;
}

/**
 * Codex (网页小说阅读器) 侧栏视图: 书签 / 在读 两个 tab。
 *
 *   - 书签: 粘贴链接打开 + 最近阅读列表 (点一下从上次读到的章节继续)
 *   - 在读: 正文 (自动合并分页、去水印) + 底部目录抽屉 + Aa 排版 + 键盘翻页 + 离线缓存
 *   - 贴目录页链接时先展示整页目录让用户挑章节 (阅读中不再提供整页目录入口, 统一用底部抽屉)
 *
 * 章节读取顺序: 内存 LRU → 磁盘离线缓存 (ChapterStore) → 网络。
 * 阅读区的 HTML 结构、样式、前端交互全部复用 Saga (起点) 那一套, 见 webnovelRender.ts。
 */
export class WebNovelMainViewProvider implements vscode.WebviewViewProvider {
  // 必须与 package.json views.webnovelVscode[0].id 一致
  public static readonly viewType = 'webnovelVscode.main';

  private view: vscode.WebviewView | undefined;
  private tab: WebNovelTab = 'home';
  private records: WebBookRecord[] = [];

  private book: BookState | undefined;
  private chapters: WebChapterLink[] = [];
  private catalogLoading = false;
  private catalogError: string | null = null;
  /** 当前 chapters 属于哪个目录 (urlKey) */
  private catalogFor = '';
  private catalogToken = 0;
  private catalogView = false;
  private catalogAutoScroll = false;

  private content: WebChapterContent | null = null;
  private chapterLoading = false;
  private chapterError: string | null = null;
  /** 正在打开 / 打开失败的 URL (重试用) */
  private pendingUrl: string | undefined;
  private loadToken = 0;
  private chapterCache = new Map<string, WebChapterContent>();
  private prefetching = new Set<string>();
  /** 视图首次可见时要恢复的记录 */
  private pendingRestore: WebBookRecord | undefined;

  private readingPrefs: ReadingPrefs = DEFAULT_READING_PREFS;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: WebNovelClient,
    private readonly store: ChapterStore,
    private readonly downloader: CacheDownloader,
  ) {
    this.records = (context.globalState.get<WebBookRecord[]>(KEY_RECORDS) ?? []).filter((r) => r && r.key && r.chapterUrl);
    const savedTab = context.globalState.get<WebNovelTab>(KEY_TAB);
    if (savedTab === 'reader' && this.records[0]) {
      this.tab = 'reader';
      this.pendingRestore = this.records[0];
    }
    this.readingPrefs = loadReadingPrefs(context, KEY_READING_PREFS);
    downloader.onProgress((e) => this.onCacheProgress(e));
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
    const restore = this.pendingRestore;
    this.pendingRestore = undefined;
    if (restore && !this.content && !this.chapterLoading) {
      void this.openRecord(restore);
    } else {
      this.render();
    }
  }

  // ---------------- 公共入口 (命令调用) ----------------

  private async reveal(): Promise<void> {
    if (!this.view) {
      try {
        await vscode.commands.executeCommand(`${WebNovelMainViewProvider.viewType}.focus`);
      } catch {
        await vscode.commands.executeCommand('workbench.view.extension.webnovelVscode');
      }
    }
    this.view?.show?.(true);
  }

  private setTab(tab: WebNovelTab): void {
    this.tab = tab;
    void this.context.globalState.update(KEY_TAB, tab);
  }

  /** 打开任意链接: 自动判断章节页 / 目录页 */
  public async openUrl(raw: string): Promise<void> {
    const url = normalizeInputUrl(raw);
    if (!url) {
      vscode.window.showWarningMessage(`Codex：不是有效的网址 — ${raw}`);
      return;
    }
    // resolveWebviewView 里的"恢复上次阅读"让位于这次显式打开
    this.pendingRestore = undefined;
    await this.reveal();
    this.setTab('reader');
    const token = ++this.loadToken;
    this.catalogView = false;
    this.chapterLoading = true;
    this.chapterError = null;
    this.pendingUrl = url;
    this.render();
    try {
      const probe = await this.client.probe(url);
      if (token !== this.loadToken) return;
      if (probe.kind === 'chapter') {
        const content = await this.client.getChapter(url, probe.page);
        if (token !== this.loadToken) return;
        // 页面上找不到"目录"链接时, 以章节 URL 作为新书 key, 避免并进上一本书
        if (!content.catalogUrl) this.switchBook({ key: urlKey(content.url), bookTitle: content.bookTitle, author: content.author });
        this.putCache(content, url);
        this.applyChapter(content);
      } else {
        // 目录页: 进入整页目录, 让用户挑章节
        this.chapterLoading = false;
        this.switchBook({ key: urlKey(probe.url), catalogUrl: probe.url });
        this.content = null;
        this.catalogView = true;
        this.catalogAutoScroll = true;
        // loadCatalog 会先以 loading 态渲染一帧, 不在这里提前 render (否则会闪一下空目录)
        await this.loadCatalog(probe.url, undefined, probe.html);
      }
    } catch (e) {
      if (token !== this.loadToken) return;
      this.chapterLoading = false;
      this.chapterError = errMsg(e);
      this.render();
    }
  }

  /** 从最近阅读继续 */
  private async openRecord(r: WebBookRecord): Promise<void> {
    await this.reveal();
    this.setTab('reader');
    this.switchBook({ key: r.key, catalogUrl: r.catalogUrl, bookTitle: r.bookTitle, author: r.author });
    await this.openChapter(r.chapterUrl);
  }

  /** 当前页面的浏览器地址 */
  public currentUrl(): string | undefined {
    if (this.tab === 'reader' && this.catalogView && this.book?.catalogUrl) return this.book.catalogUrl;
    return this.content?.url ?? this.pendingUrl ?? this.records[0]?.chapterUrl;
  }

  public async clearHistory(): Promise<void> {
    this.records = [];
    await this.context.globalState.update(KEY_RECORDS, []);
    this.render();
  }

  /** 紧急恢复: 清"在读"状态回到书签页 */
  public async resetReadingState(): Promise<void> {
    this.loadToken++;
    this.catalogToken++;
    this.book = undefined;
    this.chapters = [];
    this.catalogFor = '';
    this.catalogLoading = false;
    this.catalogError = null;
    this.catalogView = false;
    this.content = null;
    this.chapterLoading = false;
    this.chapterError = null;
    this.pendingUrl = undefined;
    this.chapterCache.clear();
    this.setTab('home');
    this.render();
    vscode.window.showInformationMessage('Codex：已清除"在读"状态，回到书签页。');
  }

  // ---------------- 书 / 目录 ----------------

  /** 切换到另一本书时清掉旧目录; 同一本书只补全书名 / 作者 */
  private switchBook(next: BookState): void {
    const same =
      this.book &&
      (this.book.key === next.key ||
        (!!next.catalogUrl && urlKey(this.book.catalogUrl) === urlKey(next.catalogUrl)));
    if (same && this.book) {
      this.book = {
        ...this.book,
        catalogUrl: this.book.catalogUrl ?? next.catalogUrl,
        bookTitle: this.book.bookTitle ?? next.bookTitle,
        author: this.book.author ?? next.author,
      };
      return;
    }
    this.book = { ...next };
    this.catalogToken++;
    this.chapters = [];
    this.catalogFor = '';
    this.catalogLoading = false;
    this.catalogError = null;
  }

  private async loadCatalog(catalogUrl: string, chapterHint?: string, html?: string, force = false): Promise<void> {
    const key = urlKey(catalogUrl);
    if (!force && this.catalogFor === key && (this.chapters.length > 0 || this.catalogLoading)) return;
    const token = ++this.catalogToken;
    this.catalogFor = key;
    this.catalogLoading = true;
    this.catalogError = null;
    this.render();
    try {
      const cat = await this.client.getCatalog(catalogUrl, chapterHint, html);
      if (token !== this.catalogToken) return;
      this.chapters = cat.chapters;
      if (this.book) {
        // 目录页上的书名更干净 (章节页 <title> 常带 SEO 尾巴), 优先用目录页的
        this.book = {
          ...this.book,
          bookTitle: cat.bookTitle ?? this.book.bookTitle,
          author: cat.author ?? this.book.author,
        };
        // 有离线缓存的书顺手刷新离线目录 (新章节也能看到)
        if (this.store.hasBook(this.book.key)) this.store.saveCatalog(this.book, this.chapters);
      }
      this.upsertRecord();
    } catch (e) {
      if (token !== this.catalogToken) return;
      // 断网 / 站点挂了: 用离线缓存的目录兜底
      const offline = this.store.getCatalog(this.book?.key);
      if (offline) {
        this.chapters = offline;
        vscode.window.setStatusBarMessage('Codex：目录加载失败，已使用离线缓存的目录', 4000);
      } else {
        this.catalogError = errMsg(e);
      }
    } finally {
      if (token === this.catalogToken) {
        this.catalogLoading = false;
        this.render();
      }
    }
  }

  /** 当前章在目录里的位置: URL → 路径 (跨子域) → 标题 (byTitle=false 时不做标题兜底) */
  private currentIdx(byTitle = true): number {
    const c = this.content;
    if (!c || !this.chapters.length) return -1;
    const k = urlKey(c.url);
    let i = this.chapters.findIndex((x) => urlKey(x.url) === k);
    if (i >= 0) return i;
    const pk = urlPathKey(c.url);
    i = this.chapters.findIndex((x) => urlPathKey(x.url) === pk);
    if (i >= 0 || !byTitle) return i;
    const tk = titleKey(c.title);
    return tk ? this.chapters.findIndex((x) => titleKey(x.title) === tk) : -1;
  }

  private prevUrl(): string | undefined {
    const idx = this.currentIdx();
    if (idx > 0) return this.chapters[idx - 1].url;
    return idx === 0 ? undefined : this.content?.prevChapterUrl;
  }

  private nextUrl(): string | undefined {
    const idx = this.currentIdx();
    if (idx >= 0 && idx < this.chapters.length - 1) return this.chapters[idx + 1].url;
    // 目录里的最后一章: 目录可能还没刷新到最新, 用页面上的"下一章"兜底
    return this.content?.nextChapterUrl;
  }

  // ---------------- 章节 ----------------

  private putCache(c: WebChapterContent, ...aliases: string[]): void {
    for (const u of [c.url, ...aliases]) {
      const key = urlKey(u);
      this.chapterCache.delete(key);
      this.chapterCache.set(key, c);
    }
    while (this.chapterCache.size > CHAPTER_CACHE_MAX) {
      const oldest = this.chapterCache.keys().next().value;
      if (oldest === undefined) break;
      this.chapterCache.delete(oldest);
    }
  }

  private async openChapter(url: string): Promise<void> {
    const token = ++this.loadToken;
    this.catalogView = false;
    this.pendingUrl = url;
    const cached = this.chapterCache.get(urlKey(url));
    if (cached) {
      this.chapterError = null;
      this.chapterLoading = false;
      this.applyChapter(cached);
      return;
    }
    this.chapterLoading = true;
    this.chapterError = null;
    this.render();
    try {
      const c = (await this.store.getChapter(url)) ?? (await this.client.getChapter(url));
      if (token !== this.loadToken) return;
      this.putCache(c, url);
      this.applyChapter(c);
    } catch (e) {
      if (token !== this.loadToken) return;
      this.chapterLoading = false;
      this.chapterError = errMsg(e);
      this.render();
    }
  }

  private applyChapter(c: WebChapterContent): void {
    this.putCache(c);
    this.content = c;
    this.chapterLoading = false;
    this.chapterError = null;
    this.pendingUrl = c.url;
    this.catalogView = false;

    // 已在当前目录里 (比如从目录分页 /index/xx/2/ 点进来, 章节页上的"目录"链接是 /index/xx/),
    // 视为同一本书, 不重拉目录; 否则由章节页上的"目录"链接决定它属于哪本书
    if (this.book && this.currentIdx(false) >= 0) {
      this.book = {
        ...this.book,
        bookTitle: this.book.bookTitle ?? c.bookTitle,
        author: this.book.author ?? c.author,
      };
    } else {
      const catalogUrl = c.catalogUrl ?? this.book?.catalogUrl;
      this.switchBook({
        key: catalogUrl ? urlKey(catalogUrl) : this.book?.key ?? urlKey(c.url),
        catalogUrl,
        bookTitle: c.bookTitle,
        author: c.author,
      });
    }
    const catalogUrl = this.book?.catalogUrl;
    // 已开启离线缓存的书: 读过的章节顺手落盘 (断网后从书签继续时, 当前这章也能打开)
    if (this.book && this.store.hasBook(this.book.key) && !this.store.isCached(this.book.key, c.url)) {
      void this.store.putChapter(this.book, c).catch(() => undefined);
    }
    this.upsertRecord();
    this.render();
    if (catalogUrl) void this.loadCatalog(catalogUrl, c.url);
    this.schedulePrefetch();
  }

  /** 后台静默预拉下一章 (整章含分页), 翻页零等待 */
  private schedulePrefetch(): void {
    if (!vscode.workspace.getConfiguration('webnovel').get<boolean>('prefetchNextChapter', true)) return;
    const next = this.nextUrl();
    if (!next) return;
    const key = urlKey(next);
    if (this.chapterCache.has(key) || this.prefetching.has(key) || this.store.isCached(this.book?.key, next)) return;
    this.prefetching.add(key);
    void this.client
      .getChapter(next)
      .then((c) => this.putCache(c, next))
      .catch(() => undefined)
      .finally(() => this.prefetching.delete(key));
  }

  private upsertRecord(): void {
    const c = this.content;
    if (!c || !this.book) return;
    const rec: WebBookRecord = {
      key: this.book.key,
      bookTitle: this.book.bookTitle || c.bookTitle || hostOf(c.url) || '未命名',
      author: this.book.author ?? c.author,
      catalogUrl: this.book.catalogUrl,
      chapterUrl: c.url,
      chapterTitle: c.title,
      site: hostOf(c.url),
      updatedAt: Date.now(),
    };
    this.records = [rec, ...this.records.filter((r) => r.key !== rec.key)].slice(0, RECORDS_MAX);
    void this.context.globalState.update(KEY_RECORDS, this.records);
  }

  // ---------------- 离线缓存 ----------------

  /** 底部"缓存"按钮 / 命令: 选择缓存范围 */
  public async openCacheMenu(): Promise<void> {
    const job = this.downloader.current();
    if (job) {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(debug-stop) 停止缓存', id: 'stop' },
          { label: '$(close) 继续缓存', id: 'keep' },
        ],
        { title: `正在缓存《${job.bookTitle}》 ${job.done}/${job.total}`, placeHolder: '同一时间只能有一个缓存任务' },
      );
      if (pick?.id === 'stop') this.downloader.cancel();
      return;
    }
    const book = this.book;
    const content = this.content;
    if (!book) {
      vscode.window.showInformationMessage('Codex：先打开一本书再缓存');
      return;
    }
    if (!this.chapters.length) {
      vscode.window.showInformationMessage(
        this.catalogLoading ? 'Codex：目录还在加载，稍等一下再缓存' : 'Codex：本书没有可用的目录，无法批量缓存',
      );
      return;
    }
    const total = this.chapters.length;
    const idx = this.currentIdx();
    const start = idx >= 0 ? idx + 1 : 0;
    const remaining = total - start;
    const cachedAll = this.chapters.filter((c) => this.store.isCached(book.key, c.url)).length;
    const cachedAfter = this.chapters.slice(start).filter((c) => this.store.isCached(book.key, c.url)).length;

    type Item = vscode.QuickPickItem & { id: string; n?: number };
    const items: Item[] = [];
    if (remaining > 0) {
      for (const n of [20, 50, 100]) {
        if (n < remaining) items.push({ label: `$(cloud-download) 缓存后续 ${n} 章`, id: 'after', n });
      }
      items.push({
        label: `$(cloud-download) 缓存后续全部 ${remaining} 章`,
        description: cachedAfter ? `已缓存 ${cachedAfter} 章，会自动跳过` : undefined,
        id: 'after',
        n: remaining,
      });
      items.push({ label: '$(edit) 自定义后续章数…', id: 'custom' });
    }
    items.push({
      label: `$(library) 缓存全书 ${total} 章`,
      description: cachedAll ? `已缓存 ${cachedAll} 章，会自动跳过` : undefined,
      id: 'all',
    });
    if (cachedAll > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator, id: 'sep' });
      items.push({ label: `$(trash) 删除本书缓存（${this.store.cachedCount(book.key)} 章）`, id: 'remove' });
    }

    const pick = await vscode.window.showQuickPick(items, {
      title: `离线缓存《${book.bookTitle ?? '当前书'}》 · 已缓存 ${cachedAll}/${total}`,
      placeHolder: idx >= 0 ? `当前读到第 ${idx + 1} 章，"后续"从第 ${start + 1} 章算起` : '选择缓存范围',
    });
    if (!pick) return;

    let list: WebChapterLink[] | undefined;
    if (pick.id === 'after') {
      list = this.chapters.slice(start, start + (pick.n ?? remaining));
    } else if (pick.id === 'all') {
      list = this.chapters;
    } else if (pick.id === 'custom') {
      const v = await vscode.window.showInputBox({
        title: '缓存后续多少章？',
        prompt: `从第 ${start + 1} 章开始，最多 ${remaining} 章`,
        value: String(Math.min(30, remaining)),
        validateInput: (s) => {
          const n = Number(s);
          return Number.isInteger(n) && n >= 1 && n <= remaining ? undefined : `请输入 1 ~ ${remaining} 的整数`;
        },
      });
      if (!v) return;
      list = this.chapters.slice(start, start + Number(v));
    } else if (pick.id === 'remove') {
      const n = await this.store.removeBook(book.key);
      vscode.window.showInformationMessage(`Codex：已删除《${book.bookTitle ?? ''}》的 ${n} 章缓存`);
      this.render();
      return;
    }
    if (!list?.length) return;
    const meta = { ...book, bookTitle: book.bookTitle ?? content?.bookTitle ?? '未命名' };
    this.store.saveCatalog(meta, this.chapters);
    // 当前这章已在内存里, 直接落盘, 不额外请求
    if (content && !this.store.isCached(book.key, content.url)) await this.store.putChapter(meta, content);
    this.downloader.start(meta, list);
  }

  /** 清空所有书的离线缓存 (命令) */
  public async clearAllCache(): Promise<void> {
    const books = this.store.listBooks();
    const bytes = await this.store.diskUsage();
    const choice = await vscode.window.showWarningMessage(
      `确定清空 Codex 全部离线缓存吗？共 ${books.length} 本书，约 ${(bytes / 1024 / 1024).toFixed(1)} MB`,
      { modal: true },
      '清空',
    );
    if (choice !== '清空') return;
    this.downloader.cancel();
    await this.store.clearAll();
    this.render();
    vscode.window.showInformationMessage('Codex：离线缓存已清空');
  }

  /**
   * 缓存进度: 在读页不整页重建 (会打断阅读 / 关掉抽屉), 只 postMessage 让前端局部更新
   * 底部按钮文字 + 目录里的"已缓存"标记; 书签页才整页重建 (刷新"已缓存 x 章")。
   */
  private onCacheProgress(e: CacheProgressEvent): void {
    if (!this.view) return;
    if (this.tab === 'home') {
      this.render();
      return;
    }
    if (!this.book || e.job.bookKey !== this.book.key) return;
    const idxs: number[] = [];
    if (e.cachedUrls.length && this.chapters.length) {
      const want = new Set(e.cachedUrls.map((u) => urlKey(u)));
      this.chapters.forEach((c, i) => {
        if (want.has(urlKey(c.url))) idxs.push(i);
      });
    }
    void this.view.webview.postMessage({
      type: 'wnCacheProgress',
      running: !e.finished,
      done: e.job.done,
      total: e.job.total,
      failed: e.job.failed,
      cachedCount: this.store.cachedCount(this.book.key),
      idxs,
    });
  }

  // ---------------- 消息分发 ----------------

  private handleMessage(msg: { type?: string; payload?: unknown }): void {
    if (!msg || typeof msg.type !== 'string') return;
    const p = (msg.payload ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : undefined);

    switch (msg.type) {
      case 'switchTab': {
        const next = s('tab');
        if (next !== 'home' && next !== 'reader') break;
        this.setTab(next);
        this.render();
        break;
      }
      case 'openUrl': {
        const url = s('url');
        if (url) void this.openUrl(url);
        break;
      }
      case 'openRecord': {
        const r = this.records.find((x) => x.key === s('key'));
        if (r) void this.openRecord(r);
        break;
      }
      case 'removeRecord': {
        const key = s('key');
        this.records = this.records.filter((x) => x.key !== key);
        void this.context.globalState.update(KEY_RECORDS, this.records);
        this.render();
        break;
      }
      case 'selectChapter': {
        const idx = Number(p.idx);
        const ch = Number.isInteger(idx) ? this.chapters[idx] : undefined;
        if (ch) void this.openChapter(ch.url);
        break;
      }
      case 'prev': {
        const u = this.prevUrl();
        if (u) void this.openChapter(u);
        break;
      }
      case 'next': {
        const u = this.nextUrl();
        if (u) void this.openChapter(u);
        break;
      }
      case 'retry':
        if (this.catalogView && this.book?.catalogUrl) {
          void this.loadCatalog(this.book.catalogUrl, this.content?.url, undefined, true);
        } else if (this.content && !this.chapterError) {
          // 重新加载当前章 (站点更新了内容 / 解析不全时)
          this.chapterCache.delete(urlKey(this.content.url));
          void this.openChapter(this.content.url);
        } else if (this.pendingUrl) {
          void this.openUrl(this.pendingUrl);
        }
        break;
      case 'retryCatalog':
        if (this.book?.catalogUrl) void this.loadCatalog(this.book.catalogUrl, this.content?.url, undefined, true);
        break;
      case 'cacheMenu':
        void this.openCacheMenu();
        break;
      case 'hideCatalogView':
        if (this.content) {
          this.catalogView = false;
          this.render();
        }
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
    const autoScroll = this.catalogAutoScroll;
    // 自动定位当前章只在"进入整页目录后、目录已就绪"的那一帧消费一次
    if (this.catalogView && !this.catalogLoading) this.catalogAutoScroll = false;
    const prev = this.content ? this.prevUrl() : undefined;
    const next = this.content ? this.nextUrl() : undefined;
    const bookKey = this.book?.key;
    const job = this.downloader.current();
    const recordsCached: Record<string, number> = {};
    for (const r of this.records) recordsCached[r.key] = this.store.cachedCount(r.key);
    this.view.webview.html = renderWebNovelHtml({
      cspSource: this.view.webview.cspSource,
      tab: this.tab,
      records: this.records,
      bookKey: this.book?.key,
      bookTitle: this.book?.bookTitle ?? this.content?.bookTitle,
      author: this.book?.author ?? this.content?.author,
      catalogUrl: this.book?.catalogUrl,
      chapters: this.chapters,
      currentIdx: this.currentIdx(),
      catalogLoading: this.catalogLoading,
      catalogError: this.catalogError,
      catalogView: this.catalogView,
      catalogAutoScroll: autoScroll,
      content: this.content,
      chapterLoading: this.chapterLoading,
      chapterError: this.chapterError,
      pendingUrl: this.pendingUrl,
      hasPrev: !!prev,
      hasNext: !!next,
      readingPrefs: this.readingPrefs,
      cachedFlags: this.chapters.map((c) => this.store.isCached(bookKey, c.url)),
      cachedCount: this.store.cachedCount(bookKey),
      cacheJob: job && job.bookKey === bookKey ? job : undefined,
      recordsCached,
    });
  }
}

/** 用户输入 → 规范 URL: 自动补 https://, 去掉首尾空白 / 引号 */
export function normalizeInputUrl(raw: string): string | undefined {
  let s = String(raw ?? '').trim().replace(/^["'<]+|["'>]+$/g, '');
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.')) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
