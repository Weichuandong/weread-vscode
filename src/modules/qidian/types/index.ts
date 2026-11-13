/**
 * 起点中文网 (Saga 模块) 数据类型。
 *
 * 接口全部来自起点**移动站** m.qidian.com 前端自己在用的 `/webcommon/*` JSON 接口
 * (从 m 站 vite 产物里逆向出的路径, 实测 2026-11 可用):
 *
 *   | 能力       | 接口                                      | 是否需要登录 |
 *   | ---        | ---                                       | ---          |
 *   | 搜索       | GET  /webcommon/search/list               | 否           |
 *   | 榜单       | GET  /webcommon/rank/{type}list           | 否           |
 *   | 目录       | GET  /webcommon/book/mCategory            | 否           |
 *   | 章节正文   | GET  /webcommon/chapter/getMChapterInfo   | 否 (VIP 需购买) |
 *   | 书架列表   | GET  /webcommon/bookshelf/mlist           | 是           |
 *   | 书架分组   | GET  /webcommon/bookshelf/mgroups         | 是           |
 *   | 加入书架   | POST /webcommon/bookshelf/addbooks        | 是           |
 *   | 云端进度   | GET  /webcommon/chapter/getReadStatus     | 是           |
 *   | 上报进度   | POST /webcommon/chapter/updReadStatus     | 是           |
 *   | 账号信息   | GET  /webcommon/user/getUserInfo          | 是           |
 *
 * 所有接口都要求 `_csrfToken` 查询参数与同名 Cookie 一致 (双提交校验), 缺失时返回
 * `{"code":1403,"msg":"CSRF 不合法"}`; 需要登录的接口未登录时返回 code 1000 / 401。
 */

export type CookieJar = Record<string, string>;

/**
 * 统一的书籍模型 (书架 / 书城 / 在读 共用)。
 *
 * 起点不同接口的字段名差异很大 (bid/bName/bAuth/cnameStr/readCname...),
 * 统一在 QidianClient 里归一化成这一份, 视图层不再关心原始字段。
 */
export interface QidianBook {
  bookId: string;
  title: string;
  author?: string;
  cover?: string;
  intro?: string;
  /** 一级分类名, 如 "玄幻" */
  category?: string;
  /** 二级分类名, 如 "异世大陆" */
  subCategory?: string;
  /** 连载 / 完结 */
  status?: string;
  /** 总字数文案, 如 "446.77万字" (接口直接给的就是文案) */
  wordCount?: string;

  // ---- 书架专属 ----
  /** 云端记录的上次读到的章节 id (书架接口 readCid) */
  readChapterId?: string;
  /** 上次读到的章节名 (书架接口 readCname) */
  readChapterName?: string;
  /** 是否读过 (书架接口 isRead) */
  isRead?: boolean;
  /** 最新章节名 (书架接口 cnameStr / 搜索接口 lastChapterName) */
  latestChapterName?: string;
  /** 是否有未读的新章节 (书架接口 isNewChapter) */
  hasUpdate?: boolean;
  /** 该书所在的书架分组 id (由客户端按分组拉取后回填) */
  groupIds?: string[];
  /** 书架接口给的 accessRead=0 表示当前不可读 (下架/版权) */
  accessDenied?: boolean;

  // ---- 书城专属 ----
  /** 榜单名次 */
  rankNum?: number;
  /** 榜单指标文案, 如 "3.94万月票" */
  rankCnt?: string;
  /** 收藏数文案, 如 "2190.26万" */
  favoriteCnt?: string;
  /** 推荐票数 */
  recommendCnt?: number;
  /** 最近更新时间文案 */
  lastUpdate?: string;
  /** 是否 VIP 作品 */
  isVip?: boolean;
  /** 签约状态文案 */
  signStatus?: string;
  /** 是否已在我的书架 (搜索接口 isInShelf + 本地已加载书架 + 本会话刚加入) */
  inShelf?: boolean;
}

/** 书架分组 (起点 APP / 网页里用户自建, 本插件只读) */
export interface QidianShelfGroup {
  groupId: string;
  name: string;
  bookCount: number;
}

export interface QidianShelfData {
  books: QidianBook[];
  groups: QidianShelfGroup[];
}

/** 章节目录项 */
export interface QidianChapter {
  chapterId: string;
  title: string;
  /** 在全书中的顺序 (0-based) */
  idx: number;
  volumeName: string;
  /** 是否为 VIP 付费章节 (VIP 卷里 sS=0 的章节) */
  vip: boolean;
  wordCount?: number;
  updateTime?: string;
}

/** 卷 — 目录抽屉里按卷分组展示 */
export interface QidianVolume {
  volumeId: string;
  name: string;
  vip: boolean;
  chapterCount: number;
}

export interface QidianCatalog {
  bookId: string;
  bookName?: string;
  /** 连载 / 完本 */
  bookStatus?: string;
  chapters: QidianChapter[];
  volumes: QidianVolume[];
}

/**
 * 章节正文抓取结果。
 *
 * 起点 VIP 章节在 web 端是**加密下发**的 (cES≠0, 需起点前端混淆脚本 Fock 解密)
 * 或带**字体反爬** (fEnS≠0, 字形映射打乱)。这两类本插件不做破解, 只诚实提示
 * "请到浏览器 / 起点 APP 阅读"。能内嵌阅读的只有明文下发的章节 (免费章 / 限免章)。
 */
export interface QidianChapterContent {
  chapterId: string;
  title: string;
  /** 已净化的正文 HTML (只含 <p>), 为空表示不可内嵌阅读 */
  html: string | null;
  /** 作家的话 (纯文本) */
  authorSay?: string;
  /** 是否 VIP 章节 */
  vip: boolean;
  /** 是否已购买 */
  bought: boolean;
  /** 正文是否只是试读片段 (未购买的 VIP 章节) */
  preview: boolean;
  /** 不能内嵌阅读的原因 (加密 / 字体反爬 / 风控 / 需购买); 能读时为空 */
  blockedReason?: string;
  /** 下一章 / 上一章 id (接口自带, 目录拉失败时兜底翻页) */
  nextId?: string;
  prevId?: string;
  wordCount?: number;
  updateTime?: string;
  /** 诊断信息 (失败时给用户看) */
  diagnostics: string;
  /** 浏览器打开地址 */
  fallbackUrl: string;
}

/** 云端阅读进度 */
export interface QidianReadStatus {
  readChapterId?: string;
  isInBookShelf?: boolean;
}

export interface QidianSearchResult {
  books: QidianBook[];
  total: number;
  hasMore: boolean;
}

export interface QidianUser {
  isLogin: boolean;
  nickName?: string;
  guid?: string;
}
