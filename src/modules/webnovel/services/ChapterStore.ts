import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { WebChapterContent, WebChapterLink } from '../types';
import { urlKey } from '../api/htmlUtil';

/** 一本书的缓存索引 (books/<hash>.json) */
export interface CachedBookIndex {
  bookKey: string;
  bookTitle?: string;
  author?: string;
  catalogUrl?: string;
  /** 离线目录: 断网时也能看目录 / 翻章 */
  catalog?: WebChapterLink[];
  /** 已缓存章节的 urlKey */
  urls: string[];
  updatedAt: number;
}

export interface CacheBookMeta {
  key: string;
  bookTitle?: string;
  author?: string;
  catalogUrl?: string;
}

/**
 * Codex 章节离线缓存 (落盘到扩展 globalStorage, 跨会话保留)。
 *
 * 目录结构:
 *   <globalStorage>/webnovel-cache/chapters/<sha1(urlKey)>.json   整章正文 (WebChapterContent)
 *   <globalStorage>/webnovel-cache/books/<sha1(bookKey)>.json      每本书的索引 + 离线目录
 *
 * 章节文件按 URL 平铺, 读取时不需要知道属于哪本书; 书索引只用于统计 / 删除 / 目录兜底。
 */
export class ChapterStore {
  private readonly chaptersDir: string;
  private readonly booksDir: string;
  private books = new Map<string, CachedBookIndex>();
  private cachedSets = new Map<string, Set<string>>();
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly root: string) {
    this.chaptersDir = path.join(root, 'chapters');
    this.booksDir = path.join(root, 'books');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.chaptersDir, { recursive: true });
    await fs.mkdir(this.booksDir, { recursive: true });
    let files: string[] = [];
    try {
      files = await fs.readdir(this.booksDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const idx = JSON.parse(await fs.readFile(path.join(this.booksDir, f), 'utf8')) as CachedBookIndex;
        if (!idx?.bookKey || !Array.isArray(idx.urls)) continue;
        this.books.set(idx.bookKey, idx);
        this.cachedSets.set(idx.bookKey, new Set(idx.urls));
      } catch {
        /* 损坏的索引直接跳过 */
      }
    }
  }

  // ---------------- 章节 ----------------

  private chapterFile(url: string): string {
    return path.join(this.chaptersDir, `${sha1(urlKey(url))}.json`);
  }

  async getChapter(url: string): Promise<WebChapterContent | undefined> {
    try {
      const c = JSON.parse(await fs.readFile(this.chapterFile(url), 'utf8')) as WebChapterContent;
      return c && Array.isArray(c.paragraphs) ? c : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 写入一章。aliases: 目录里的链接与章节"第一页"URL 不一致时 (极少), 也按目录链接存一份索引,
   * 保证从目录点进来能命中。
   */
  async putChapter(book: CacheBookMeta, c: WebChapterContent, ...aliases: string[]): Promise<void> {
    const keys = Array.from(new Set([c.url, ...aliases].map((u) => urlKey(u)).filter(Boolean)));
    const body = JSON.stringify(c);
    for (const u of [c.url, ...aliases]) {
      await fs.writeFile(this.chapterFile(u), body, 'utf8');
    }
    const idx = this.ensureBook(book);
    const set = this.cachedSets.get(book.key)!;
    keys.forEach((k) => set.add(k));
    idx.urls = Array.from(set);
    idx.updatedAt = Date.now();
    this.scheduleSave(book.key);
  }

  isCached(bookKey: string | undefined, url: string): boolean {
    if (!bookKey) return false;
    return this.cachedSets.get(bookKey)?.has(urlKey(url)) ?? false;
  }

  cachedCount(bookKey: string | undefined): number {
    if (!bookKey) return 0;
    return this.cachedSets.get(bookKey)?.size ?? 0;
  }

  // ---------------- 书 / 离线目录 ----------------

  private ensureBook(book: CacheBookMeta): CachedBookIndex {
    let idx = this.books.get(book.key);
    if (!idx) {
      idx = { bookKey: book.key, urls: [], updatedAt: Date.now() };
      this.books.set(book.key, idx);
      this.cachedSets.set(book.key, new Set());
    }
    if (book.bookTitle) idx.bookTitle = book.bookTitle;
    if (book.author) idx.author = book.author;
    if (book.catalogUrl) idx.catalogUrl = book.catalogUrl;
    return idx;
  }

  hasBook(bookKey: string | undefined): boolean {
    return !!bookKey && this.books.has(bookKey);
  }

  /** 保存离线目录 (只给已经有缓存的书 / 正在缓存的书存) */
  saveCatalog(book: CacheBookMeta, chapters: WebChapterLink[]): void {
    const idx = this.ensureBook(book);
    idx.catalog = chapters.map((c) => ({ title: c.title, url: c.url }));
    idx.updatedAt = Date.now();
    this.scheduleSave(book.key);
  }

  getCatalog(bookKey: string | undefined): WebChapterLink[] | undefined {
    if (!bookKey) return undefined;
    const cat = this.books.get(bookKey)?.catalog;
    return cat && cat.length ? cat : undefined;
  }

  listBooks(): CachedBookIndex[] {
    return Array.from(this.books.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async removeBook(bookKey: string): Promise<number> {
    const idx = this.books.get(bookKey);
    if (!idx) return 0;
    // 别的书也引用的章节文件 (极少见: 两本书共用目录) 不删
    const others = new Set<string>();
    for (const [k, set] of this.cachedSets) if (k !== bookKey) set.forEach((u) => others.add(u));
    for (const u of idx.urls) {
      if (others.has(u)) continue;
      await fs.rm(path.join(this.chaptersDir, `${sha1(u)}.json`), { force: true });
    }
    const t = this.saveTimers.get(bookKey);
    if (t) clearTimeout(t);
    this.saveTimers.delete(bookKey);
    await fs.rm(path.join(this.booksDir, `${sha1(bookKey)}.json`), { force: true });
    this.books.delete(bookKey);
    this.cachedSets.delete(bookKey);
    return idx.urls.length;
  }

  async clearAll(): Promise<void> {
    for (const t of this.saveTimers.values()) clearTimeout(t);
    this.saveTimers.clear();
    this.books.clear();
    this.cachedSets.clear();
    await fs.rm(this.root, { recursive: true, force: true });
    await fs.mkdir(this.chaptersDir, { recursive: true });
    await fs.mkdir(this.booksDir, { recursive: true });
  }

  /** 统计磁盘占用 (字节) */
  async diskUsage(): Promise<number> {
    let total = 0;
    for (const dir of [this.chaptersDir, this.booksDir]) {
      let files: string[] = [];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          total += (await fs.stat(path.join(dir, f))).size;
        } catch {
          /* ignore */
        }
      }
    }
    return total;
  }

  // ---------------- 索引落盘 (防抖) ----------------

  private scheduleSave(bookKey: string): void {
    const old = this.saveTimers.get(bookKey);
    if (old) clearTimeout(old);
    this.saveTimers.set(
      bookKey,
      setTimeout(() => {
        this.saveTimers.delete(bookKey);
        void this.saveBook(bookKey);
      }, 500),
    );
  }

  private async saveBook(bookKey: string): Promise<void> {
    const idx = this.books.get(bookKey);
    if (!idx) return;
    try {
      await fs.writeFile(path.join(this.booksDir, `${sha1(bookKey)}.json`), JSON.stringify(idx), 'utf8');
    } catch {
      /* ignore */
    }
  }

  /** 立即把所有待写索引落盘 (下载结束 / 插件停用时) */
  async flush(): Promise<void> {
    const keys = Array.from(this.saveTimers.keys());
    for (const k of keys) {
      clearTimeout(this.saveTimers.get(k)!);
      this.saveTimers.delete(k);
      await this.saveBook(k);
    }
  }
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
