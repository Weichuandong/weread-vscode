/**
 * 知乎推荐流相关类型。
 *
 * 注: 知乎的 web API 是私有的, 字段会变, 这里只声明我们用到的子集,
 * 多余字段直接保留为 unknown 不影响解码。
 */

/** Cookie 字典 (用于解析 / 校验关键字段) */
export type ZhihuCookieJar = Record<string, string>;

/**
 * 推荐流中单条 item 的 target (真正的内容主体)。
 *
 * 知乎的 target 是个"多态"对象, 不同 type 字段不同:
 *   - answer:   { type: 'answer',  id, question: { id, title }, excerpt, author, url, voteup_count, ... }
 *   - article:  { type: 'article', id, title, excerpt, author, url, voteup_count, ... }
 *   - zvideo:   { type: 'zvideo',  id, title, description, author, url, ... }
 *   - pin:      { type: 'pin',     id, excerpt, author, url, ... }
 *
 * 这里只声明"展示用到的最小集", 排版时按 type 走分支。
 */
export interface ZhihuTarget {
  type: 'answer' | 'article' | 'zvideo' | 'pin' | string;
  id: number | string;
  /** answer 才有, article/zvideo 用顶层 title */
  question?: { id: number | string; title: string };
  /** article / zvideo / pin 有 */
  title?: string;
  /** answer / article 有 (HTML 摘要) */
  excerpt?: string;
  /** zvideo 用 description, pin 用 excerpt_title/content */
  description?: string;
  author?: {
    id?: string;
    name?: string;
    avatar_url?: string;
    headline?: string;
  };
  /** 部分 type 有, 不一定全, 我们自己兜底拼 url */
  url?: string;
  voteup_count?: number;
  comment_count?: number;
  /** zvideo 才有 */
  thumbnail?: string;
}

/**
 * 推荐流顶层 item。
 *
 * `id` 是 feed 维度的唯一标识 (用于前端去重的第一道关), 不同于 target.id。
 * `attached_info` 是上报"已读"时必须回传的不透明 token, 不要解析它。
 */
export interface ZhihuFeedItem {
  type: 'feed' | string;
  id?: string;
  /**
   * 上报已读时必须回传给服务端的不透明 token, 字段名历史上变过:
   *   - 老接口: attached_info_bytes
   *   - 新接口: attached_info
   * 我们读取时两个都试一遍, 任一存在即可。
   */
  attached_info?: string;
  attached_info_bytes?: string;
  /** 真正展示用的内容主体 */
  target: ZhihuTarget;
}

/** 推荐流响应 */
export interface ZhihuRecommendResponse {
  data: ZhihuFeedItem[];
  paging?: {
    is_end?: boolean;
    /** 下一页 URL, 我们从这里解析 session_token / page_number / end_offset */
    next?: string;
    page?: number;
  };
  /** 顶部"为你推荐了 X 条新内容"提示, 偶尔出现 */
  fresh_text?: string;
}

/**
 * 经过本地归一化、专门给 webview 渲染的 card。
 *
 * 为什么不直接把 ZhihuFeedItem 丢给前端? — 前端不应感知"target.type 是 answer 时要从
 * question.title 取标题"这种业务规则, 这一层做完归一化, 前端只负责画。
 */
export interface ZhihuCardForView {
  /** feed id, 用于前端 set 去重 */
  feedId: string;
  /** 用于在浏览器中打开 */
  url: string;
  /** 卡片类型: 用于标记小标签 (回答/文章/视频/想法) */
  kind: '回答' | '文章' | '视频' | '想法' | '其他';
  /** 显示标题 */
  title: string;
  /** 显示摘要 (纯文本, 已剥掉 HTML 标签) */
  excerpt: string;
  /** 作者名 */
  authorName: string;
  /** 作者头像 url (https), 没有就用占位 */
  authorAvatar: string;
  /** 赞同/点赞数, 没有为 0 */
  voteCount: number;
  /**
   * 内容主体的 id, 用于后续按 kind 二次拉正文。
   * - 回答: answer id
   * - 文章: article id
   * - 视频: zvideo id
   * - 想法: pin id
   * 字符串形式存, 避免 number 在大 id 下的精度问题。
   */
  targetId: string;
  /**
   * 仅当 kind='回答' 时存在 — 该回答所属的问题 id.
   *
   * 用于"点击标题进入问题专属页面"功能: 前端拿这个 id 通过 fetchQuestionAnswers
   * 拉取该问题下所有回答, 在侧栏里铺成一个独立的二级视图 (类似 zhihu.com 问题页).
   *
   * 其它 kind (文章/视频/想法) 没有 question 概念, 所以可选.
   */
  questionId?: string;
}

// ---------- 评论 ----------

/**
 * 单条评论的归一化结构 (给前端用)。
 *
 * 知乎评论接口字段 (经典 root_comments 形态):
 *   {
 *     id, content, vote_count, created_time,
 *     author: { member: { name, avatar_url, headline } },
 *     child_comments: [...], child_comment_count,
 *     reply_to_author: { member: { name } }   // 回复某人时才有
 *   }
 *
 * 不同 type (answer/article/pin) 字段大同小异, 都在这里抽平。
 */
export interface ZhihuCommentForView {
  id: string;
  /** 已剥 HTML, 保留段落换行 */
  content: string;
  authorName: string;
  authorAvatar: string;
  /** 作者一句话简介, 没有则空 */
  authorHeadline: string;
  /** 点赞数 */
  voteCount: number;
  /** 回复给谁 ("回复 张三:") — 没有则空 */
  replyTo: string;
  /** 子评论数量, > 0 时前端可以显示 "N 条回复" */
  childCount: number;
  /** 评论时间 (本地化字符串, 如 "2024-01-01 12:00") */
  createdAt: string;
}

/**
 * fetchComments 的归一化返回 — 一次调用代表"第一屏" 或 "下一页",
 * 上层 (view) 自己维护 offset 累加。
 */
export interface ZhihuCommentsPage {
  comments: ZhihuCommentForView[];
  /** 评论总数 (如 server 没回则 -1, 前端不显示) */
  totals: number;
  /** server 是否标记到底, 决定前端是否还显示 "加载更多" */
  isEnd: boolean;
}

// ---------- 问题详情 (该问题下的所有回答) ----------

/**
 * 拉取"某个问题下的回答列表"的归一化返回.
 *
 * 设计取舍: 直接复用 ZhihuCardForView 来表示每个回答 — 而不是另起一套 ZhihuAnswerForView.
 *   - 详情页里每张答案卡片的渲染逻辑 (展开正文/评论/子评论) 跟 feed 流卡片完全一致,
 *     共用一套 DOM 结构能复用前端所有交互, 大幅省事;
 *   - 视觉上唯一差异是详情页里所有 card 都是"回答" kind, kind tag 会重复, 前端按需隐藏即可;
 *   - questionId 字段在详情页里其实用不上 (本来就是从它发起的查询), 但归一化层保持一致也无害.
 *
 * 分页与评论同模式 (offset + limit), totals/isEnd 由 server paging 给出.
 */
export interface ZhihuQuestionAnswersPage {
  /** 该页答案 (复用 card 结构), kind 永远是 '回答' */
  cards: ZhihuCardForView[];
  /** 回答总数; server 没回则 -1 */
  totals: number;
  /** 是否到底 */
  isEnd: boolean;
  /** 问题标题; 从 server 拿到的更准 (前端入口传的可能被截断/转义过), 兜底用 */
  questionTitle?: string;
}
