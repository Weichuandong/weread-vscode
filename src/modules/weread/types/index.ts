/**
 * 微信读书相关数据结构定义（仅覆盖 MVP 所需字段）。
 *
 * 注意：以下字段基于社区逆向接口的常见返回，实际字段可能更多，
 * 我们只声明真正用到的部分，并允许通过索引签名兼容未知字段。
 */

/** 一本书的精简信息 */
export interface WereadBook {
  bookId: string;
  title: string;
  author?: string;
  cover?: string;
  intro?: string;
  category?: string;
  /** 阅读进度（0-100） */
  progress?: number;
  /** 是否完结 */
  finished?: boolean;
  [key: string]: unknown;
}

/** 用户自建的书架分组 */
export interface WereadArchive {
  /** 分组在接口里的稳定 id */
  archiveId?: number;
  /** 分组名（用户在微信读书里自己起的名字） */
  name: string;
  /** 该分组下包含的 bookId 列表 */
  bookIds: string[];
  [key: string]: unknown;
}

/** 书架返回结构（接口：/web/shelf/sync） */
export interface BookshelfResponse {
  books?: WereadBook[];
  /** 用户自建的书架分组 */
  archive?: WereadArchive[];
  /** 阅读进度信息（与 books 平行返回，需按 bookId 合并） */
  bookProgress?: Array<{
    bookId: string;
    progress?: number;
    finished?: boolean;
    /** 服务端上次进度更新时间(秒) */
    updateTime?: number;
    /** 上次阅读章节 uid */
    chapterUid?: number;
    /** 上次阅读章节 index */
    chapterIdx?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/** 客户端整理后的书架数据（给 UI 直接消费） */
export interface BookshelfData {
  books: WereadBook[];
  archives: WereadArchive[];
  /** 各书云端进度索引，便于 UI 层"最近在读"等场景使用 */
  progressMap: Map<string, BookProgress>;
  /** 云端"最近在读"的 bookId（按 updateTime 排序得出，可能为 undefined） */
  lastReadBookId?: string;
}

/** 单本书的云端阅读进度 */
export interface BookProgress {
  bookId: string;
  /** 上次阅读章节 uid */
  chapterUid?: number;
  /** 上次阅读章节 index */
  chapterIdx?: number;
  /** 0-100 */
  progress?: number;
  finished?: boolean;
  /** 服务端上次进度更新时间(秒) */
  updateTime?: number;
}

/** 章节信息 */
export interface WereadChapter {
  chapterUid: number;
  chapterIdx?: number;
  title: string;
  level?: number;
  /** 字数 */
  wordCount?: number;
  /** 是否需要付费 */
  paid?: boolean;
  [key: string]: unknown;
}

/** 章节列表返回结构（接口：/web/book/chapterInfos） */
export interface ChapterInfosResponse {
  data?: Array<{
    bookId: string;
    updated?: WereadChapter[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/** 用户信息（接口：/web/user） */
export interface WereadUser {
  vid?: number | string;
  name?: string;
  avatar?: string;
  [key: string]: unknown;
}

/** Cookie 键值对 */
export type CookieJar = Record<string, string>;

// ============================================================
// 社交内容(只读): 想法 / 划线 / 书评
// ============================================================

/** 想法/书评的作者(对应接口里的 user 字段) */
export interface ReviewAuthor {
  vid?: number | string;
  name?: string;
  avatar?: string;
  [key: string]: unknown;
}

/**
 * 想法 / 书评(/web/review/list 返回的单条记录)。
 *
 * 接口对同一种结构复用很彻底:
 *   - listType=11(章节想法)  → type=1, 通常带 markText(被引用的原文片段)
 *   - listType=4 (全书书评)  → type=4, 一般无 markText, content 为评论正文
 * 写操作所需的 range(EPUB CFI) 字段我们只透传不解析。
 */
export interface Review {
  reviewId: string;
  author: ReviewAuthor;
  /** 评论/想法的正文(可能为空, 比如纯划线) */
  content?: string;
  /** 引用的原文片段(章节想法常带, 用作"挂在哪段话上") */
  markText?: string;
  chapterUid?: number;
  chapterIdx?: number;
  /** 秒级时间戳 */
  createTime?: number;
  likesCount?: number;
  commentsCount?: number;
  /** 1=想法 4=书评(社区习惯) */
  type?: number;
  /** EPUB CFI range, 只读不解析 */
  range?: string;
  [key: string]: unknown;
}

/**
 * 章节级"热门划线"(/web/book/underlines 返回的单条)。
 *
 * touchFish 用的就是这个接口而不是 bestbookmarks: 它保证返回 range,
 * 而且 count 字段直接告诉你"有多少人划过这段", 适合做 inline 渲染。
 * 注意它和 bestbookmarks 是两个独立接口, 这里只关心做 inline 高亮需要的字段。
 */
export interface ChapterUnderline {
  /** "start-end", 同 bestbookmarks 的 range 语义, 在章节 HTML 字符串上的偏移 */
  range: string;
  /** 多少人划过这段 */
  count?: number;
  /** 划线类型, 透传不解析 */
  type?: number;
  [key: string]: unknown;
}

/** 热门划线(/web/book/bestbookmarks 返回的单条) */
export interface BestBookmark {
  bookmarkId: string;
  markText: string;
  chapterUid?: number;
  /** 多少人划过这段 */
  totalCount?: number;
  /**
   * 划线在章节 HTML 字符串里的范围 "start-end"。
   *
   * 微信读书后端给的索引参考的是 EPUB 原始 HTML(含 <html>/<head>/<body>...)
   * 的字符偏移, 直接 slice(start, end) 即可取到对应 HTML 片段。
   * 用于在正文 inline 渲染时, 把热门划线包成 <span class="hot-underline">,
   * 让用户在阅读时直接看到大家划过的句子。
   */
  range?: string;
  [key: string]: unknown;
}
