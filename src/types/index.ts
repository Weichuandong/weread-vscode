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
