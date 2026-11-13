/**
 * Codex (网页小说阅读器) 数据结构。
 *
 * 与 Saga / Folio 不同, Codex 没有"官方接口", 一切都从网页 HTML 里解析,
 * 所以章节 / 书籍的唯一标识就是 URL:
 *   - 章节: 该章"第一页"的绝对 URL (同一章被拆成 _2 / _3 多页时, 统一归到第一页)
 *   - 书籍: 目录页 URL (拿不到目录时退化为站点 origin + 书名)
 */

/** 目录里的一个章节 */
export interface WebChapterLink {
  title: string;
  /** 绝对 URL (章节第一页) */
  url: string;
}

/** 单个"章节分页"的解析结果 (一章可能被站点拆成多页) */
export interface WebChapterPage {
  /** 本页实际 URL (跟随重定向后) */
  url: string;
  /** 章节标题 (已去掉 "(2/4)" 之类的分页后缀) */
  title: string;
  bookTitle?: string;
  author?: string;
  /** 正文段落 (已去噪、去 HTML) */
  paragraphs: string[];
  /** 本页第一段是否带行首缩进 — 用于判断跨页时段落是否被腰斩 */
  firstIndented: boolean;
  /** 本页段落里带缩进的比例 (0~1), 站点不缩进时缩进信号不可用 */
  indentRatio: number;
  /** 同一章内的上一页 / 下一页 */
  prevPageUrl?: string;
  nextPageUrl?: string;
  /** 上一章 / 下一章 */
  prevChapterUrl?: string;
  nextChapterUrl?: string;
  /** 目录页 */
  catalogUrl?: string;
  /** 正文 CJK 字数, 用于判断这是不是一个"章节页" */
  textLength: number;
}

/** 一整章 (已把多页合并) */
export interface WebChapterContent {
  /** 章节第一页 URL — 章节唯一标识 */
  url: string;
  title: string;
  paragraphs: string[];
  /** 合并了几页 */
  pageCount: number;
  prevChapterUrl?: string;
  nextChapterUrl?: string;
  catalogUrl?: string;
  bookTitle?: string;
  author?: string;
  /** 字数 (去空白后的字符数) */
  wordCount: number;
}

/** 目录 (已把多页目录合并) */
export interface WebCatalog {
  /** 目录首页 URL */
  catalogUrl: string;
  bookTitle?: string;
  author?: string;
  chapters: WebChapterLink[];
  /** 目录共几页 */
  pageCount: number;
}

/** "书签"里的一本书 (最近阅读记录) */
export interface WebBookRecord {
  /** 唯一 key: 目录 URL, 没有目录时为章节 URL */
  key: string;
  bookTitle: string;
  author?: string;
  catalogUrl?: string;
  /** 读到的章节 */
  chapterUrl: string;
  chapterTitle: string;
  /** 站点 host, 展示用 */
  site: string;
  updatedAt: number;
}

/** 探测一个 URL 是章节页还是目录页 */
export type WebProbeResult =
  | { kind: 'chapter'; page: WebChapterPage }
  | { kind: 'catalog'; url: string; html: string };
