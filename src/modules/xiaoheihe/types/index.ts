/**
 * 小黑盒资讯流相关类型.
 *
 * 同 zhihu 模块的处理思路一致: 服务端字段繁多且不稳定 (官方私有 APP API), 这里只
 * 声明真正用到的子集, 其它字段直接保留 unknown / 不写, 不影响解码也不锁定结构.
 *
 * 对资讯列表来说我们关心的核心字段 (按实测 /bbs/app/feeds/news 抓包):
 *   - content_type:   1=普通帖子 (我们要的); 10=头部专题工具栏 (要过滤)
 *   - linkid:         资讯唯一 id (数字), 跨页 / 跨刷新去重就靠它
 *   - title:          标题
 *   - description:    摘要
 *   - imgs / thumbs:  封面图 (imgs 原图, thumbs 缩略)
 *   - post_tag:       作者昵称 (字段名很迷, 但实测就是作者)
 *   - has_video:      0/1, 1 表示视频帖
 *   - formated_time:  服务端已格式化好的 "3 小时前" / "yyyy-MM-dd" 字符串, 直接用
 *   - hashtags[]:     话题标签数组, 取第 0 个作为卡片标签
 *   - share_url:      服务端给的完整分享 URL (注意里面的 link_id 是 hash 不是 linkid)
 *   - 统计:           comment_num / link_award_num
 */

/**
 * 板块 (Section) id —— 插件层的"友好 id".
 *
 * 取值规则:
 *   - 'home': 主页推荐流 (本地多源混排, 不是真实服务端接口); 不可被禁用, 永远是第一个 tab
 *   - 其它:   各游戏板块, 字符串走 vscode 配置 / globalState key, 跟 SectionMeta.id 一致
 *
 * 注意:
 *   - 这里用 string 而不是 union literal — 用户可以在 settings 里加 customSections,
 *     编译期我们不知道有哪些, 用 string 包容; 内置板块的 id 在 BUILTIN_SECTIONS 里维护
 *   - 旧版本叫 XiaoheiheGameId, 保留 alias 兼容 (现有 client/types 还在引用)
 */
export type XiaoheiheSectionId = string;
/** @deprecated 用 XiaoheiheSectionId 替代; 保留是因为 client 还在用 */
export type XiaoheiheGameId = XiaoheiheSectionId;

/**
 * 板块 meta —— UI 展示 + 服务端 tag 映射.
 *
 * verified 标志:
 *   - true:  原参考实现 (vscode-maxPlus) 抓包验证过 tag 有效
 *   - false: 基于小黑盒社区高频出现猜的 tag, 没我亲手验证过. 用户勾选后若服务端返回
 *            空数据 (tag 错), 前端会提示"可能 tag 已变更, 可点 ⚙ 取消勾选"
 */
export interface XiaoheiheSectionMeta {
  /** 板块 id, 全小写无破折号; 'home' 保留给主页推荐流 */
  id: XiaoheiheSectionId;
  /** 给前端 UI 用的中文短名 (tab 文案) */
  label: string;
  /**
   * 打到服务端 /bbs/app/feeds/news 的 tag 字段值.
   * 主页 (id='home') 这里填空字符串, fetch 时走 fetchHomeFeed 不走 tag.
   */
  tag: string;
  /** 是否抓包验证过 tag 有效 — 未验证的在 UI 上加角标提示 */
  verified: boolean;
  /** 是否为用户自定义板块 (来自 customSections 配置); UI 在标签后加 "自定义" 区别 */
  custom?: boolean;
}
/** @deprecated 旧名, 用 XiaoheiheSectionMeta */
export type XiaoheiheGameMeta = XiaoheiheSectionMeta;

/**
 * Home 主页板块的常量 id —— 多处用到, 抽常量防拼错.
 *
 * 主页流的实现策略 (见 XiaoheiheClient.fetchHomeFeed):
 *   把用户当前启用的所有"非 home"板块 round-robin 拉前几条, 本地混排成"个性化推荐流".
 *   不依赖任何未知接口, 100% 可用. 用户启用的板块越多, "推荐"越丰富.
 */
export const HOME_SECTION_ID: XiaoheiheSectionId = 'home';

/** 主页板块 meta (固定, 不可禁用) */
export const HOME_SECTION_META: XiaoheiheSectionMeta = {
  id: HOME_SECTION_ID,
  label: '主页',
  tag: '',
  verified: true, // 不依赖任何 tag, 不存在 verified 问题
};

/**
 * 内置板块清单 (不含 home; home 单独处理).
 *
 * 加新板块只需要 push 一项 — UI / 配置 / Client 都自动适配.
 *
 * tag 约定:
 *   - 大小写敏感, 跟服务端约定一致 (实测 csgo / APEX / lol / PUBG 大小写不统一)
 *   - 三角洲的 tag 是 'topic_611472' — 这是小黑盒 APP 内部话题 id, 没独立 slug, 抓包结果, 不要改
 *
 * verified 区分原则:
 *   - 原参考实现 (vscode-maxPlus 1.5.0, 2026/02) 验证过的 6 个 → verified: true
 *   - 其它是基于"小黑盒 APP 游戏圈"页面常见命名猜的 → verified: false, 用户启用后自行验证
 *     (做不到 verified: true 不是技术原因, 是我手上没有 APK 抓包环境跑完整覆盖)
 */
export const BUILTIN_SECTIONS: readonly XiaoheiheSectionMeta[] = [
  // ---- 已验证 (vscode-maxPlus 原版同款) ----
  { id: 'ow',          label: '守望先锋',         tag: 'overwatchtwo',  verified: true },
  { id: 'sjz',         label: '三角洲行动',       tag: 'topic_611472',  verified: true },
  { id: 'csgo',        label: 'CS:GO',           tag: 'csgo',          verified: true },
  { id: 'apex',        label: 'APEX英雄',        tag: 'APEX',          verified: true },
  { id: 'lol',         label: '英雄联盟',         tag: 'lol',           verified: true },
  { id: 'pubg',        label: '绝地求生',         tag: 'PUBG',          verified: true },
  // ---- 未验证 (社区高频, tag 猜的; 用户启用后可自行验证) ----
  { id: 'yuanshen',    label: '原神',             tag: 'yuanshen',      verified: false },
  { id: 'naraka',      label: '永劫无间',         tag: 'naraka',        verified: false },
  { id: 'valorant',    label: '无畏契约',         tag: 'valorant',      verified: false },
  { id: 'dota2',       label: 'DOTA2',           tag: 'dota2',         verified: false },
  { id: 'eldenring',   label: '艾尔登法环',       tag: 'eldenring',     verified: false },
  { id: 'pubgm',       label: '和平精英',         tag: 'pubgm',         verified: false },
  { id: 'gta5',        label: 'GTA5',            tag: 'gta5',          verified: false },
  { id: 'diablo4',     label: '暗黑破坏神4',      tag: 'diablo4',       verified: false },
  { id: 'genshin',     label: '崩坏:星穹铁道',    tag: 'sr',            verified: false },
  { id: 'wuthering',   label: '鸣潮',             tag: 'wuthering',     verified: false },
] as const;

/**
 * @deprecated 旧名, 仅原始 6 个游戏; 新代码用 BUILTIN_SECTIONS / getAllSections.
 *
 * 保留这个数组是因为 XiaoheiheClient.fetchFeed 早期版本按 GAMES.find(id) 校验, 临时兼容;
 * 一旦 client 也改到 SectionMeta 后这里可以删.
 */
export const GAMES = BUILTIN_SECTIONS.filter((s) =>
  ['ow', 'sjz', 'csgo', 'apex', 'lol', 'pubg'].includes(s.id),
);

/**
 * 默认启用的板块 id 列表 (新用户第一次打开看到的 tab).
 *
 * 默认全勾 6 个已验证的 + home; 未验证的让用户自己去 ⚙ 勾, 避免新用户首屏出空 tab.
 */
export const DEFAULT_ENABLED_SECTIONS: readonly XiaoheiheSectionId[] = [
  HOME_SECTION_ID,
  'ow', 'sjz', 'csgo', 'apex', 'lol', 'pubg',
];

/**
 * 服务端原始 link 对象 (经验子集, 不完整).
 *
 * 关键字段说明 (字段名按 2026/06 抓包):
 *   - content_type:   1=普通帖子, 10=头部专题工具栏 (跳过)
 *   - linkid:         数字 id (注意不是 share_url 里的 link_id hash)
 *                     用 number 但传给前端 / 内部去重时统一转 string
 *   - title:          标题, 文字
 *   - description:    摘要, 可能为空; 视频/直播类经常空
 *   - has_video:      1 表示视频帖
 *   - imgs / thumbs:  封面图数组, 优先 imgs[0], 兜底 thumbs[0]
 *   - post_tag:       作者昵称 (字段名很迷)
 *   - formated_time:  服务端已格式化的相对时间字符串, 客户端直接展示
 *   - modify_at:      秒级 timestamp 兜底 (formated_time 缺失时自己格式化)
 *   - hashtags:       话题标签数组 [{name, hashtag_id}], 我们取第 0 个
 *   - share_url:      完整分享 URL, 直接给前端跳浏览器
 *   - comment_num:    评论数
 *   - link_award_num: 点赞数
 */
export interface XiaoheiheRawLink {
  content_type?: number;
  linkid?: number | string;
  title?: string;
  description?: string;
  has_video?: number;
  imgs?: string[];
  thumbs?: string[];
  post_tag?: string;
  formated_time?: string;
  modify_at?: number;
  hashtags?: Array<{ name?: string; hashtag_id?: number }>;
  share_url?: string;
  comment_num?: number;
  link_award_num?: number;
  /** 服务端可能塞的其他字段, 一律保留不读 */
  [key: string]: unknown;
}

/** /bbs/app/feeds/news 的响应外壳 */
export interface XiaoheiheNewsResponse {
  /** 业务 code, 'ok' 或 0 表示成功; 其它走 msg/message 报错 */
  status?: string | number;
  msg?: string;
  message?: string;
  result?: {
    /** 主体: 资讯列表 */
    links?: XiaoheiheRawLink[];
    /** 服务端是否提示已到底; 经验上不总是给, 我们以 links 是否为空兜底判断 */
    is_end?: boolean | number;
  };
}

/**
 * 经过本地归一化、专门给 webview 渲染的 card.
 *
 * 同 zhihu 模块原则一致: 前端不感知"is_video=1 时要换显示样式"这种业务规则,
 * 这一层把所有 raw 字段揉成视图可直接用的字段.
 */
export interface XiaoheiheCardForView {
  /** linkid 字符串形式, 前端去重 + 跳详情 url 拼接 */
  linkId: string;
  /** 标题 */
  title: string;
  /** 摘要 (纯文本, 已剥 HTML; 空则不渲染) */
  excerpt: string;
  /** 封面图 url (https), 没有则空字符串, 前端按需隐藏 */
  cover: string;
  /** 作者名 (没有则空) */
  authorName: string;
  /** 子标签, 形如 "新闻" / "攻略"; 没有则空, 前端隐藏 */
  linkTag: string;
  /** 是否视频帖, 视频帖在卡片角标显示 ▶ */
  isVideo: boolean;
  /** 发布时间, 已格式化成 "x 小时前" / "yyyy-MM-dd" 这种 (本地化由后端做完发给前端) */
  publishedAt: string;
  /** 评论数 (0 表示无, 前端按需隐藏) */
  commentCount: number;
  /** 点赞数 (0 表示无) */
  awardCount: number;
  /**
   * 详情 url — 用于在浏览器中打开 / 后续如果做内嵌阅读也复用这个.
   *
   * 直接用服务端 raw.share_url, 形如:
   *   https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?h_camp=link&h_src=...&link_id=<hash>
   * 注意末尾 link_id 是 hash 字符串 (不是数字 linkid), 服务端 302 到最终 h5 详情页.
   * 不要自己拼这个 URL — 没有 share token 接服务端会 403.
   */
  shareUrl: string;

  /**
   * 卡片来源板块 id — 主页混排时用. 普通板块拉的卡片就是该板块本身, 主页 (home) 拉的
   * 卡片回填为"实际来源板块"(round-robin 取自的子板块). 空字符串表示未知/不展示.
   * 仅作 UI 角标 ("来自 守望先锋") 用, 不影响业务逻辑.
   */
  sourceSectionId?: string;
  /** 卡片来源板块 label (中文短名), 配合 sourceSectionId 渲染角标 */
  sourceSectionLabel?: string;
}

/**
 * 卡片就地展开后的"详情视图"数据 (走 /bbs/app/link/tree page=1 limit=1).
 *
 * 设计上有意保持很薄: 小黑盒帖子普遍短 (几百字内, 大多是配图水帖), 不像知乎长答案
 * 那样需要分段切片. 所以这里就给"全文 + 图片", webview 一次性渲染.
 */
export interface XiaoheiheDetailForView {
  /** 跟 card.linkId 一致, 用于路由展开/折叠 + 评论翻页 */
  linkId: string;
  /**
   * 正文文本 (已剥 HTML, 保留段落换行), 含 `[IMG:url]` 占位符表示正文里嵌入的图.
   *
   * 处理来源:
   *   1) link.description 里的 <img src> -> [IMG:url] 占位符 (按出现位置原位保留)
   *   2) link.imgs / link.thumbs 里 description 没出现过的图 -> append 到末尾
   *      (每行一个 [IMG:url], 跟正文之间空一行)
   *
   * 前端 renderTextWithImages 把 [IMG:url] 切片成 <img> (开关开) / 占位 span (关).
   * 空字符串 = 帖子无正文且无图.
   */
  contentText: string;
  /**
   * 全部图 URL 数组 (description 解析 + raw.imgs/thumbs 兜底, 去重后).
   *
   * v2.2.1 起前端不直接渲染这个数组 — 所有图都通过 contentText 里的 [IMG:url]
   * 占位符在原位渲染, 这样图片显示开关可以统一控制. 字段保留用于上层做"图片张数"
   * 之类的统计, 删它会破坏类型契约, 索性留着.
   */
  contentImgs: string[];
  /** 评论总数 (服务端 link.comment_num), 给 "查看评论 (N)" 按钮显示 */
  commentCount: number;
  /** 总楼层数 (服务端 result.total_floor_num), 用于评论分页"已加载 a/b 楼"提示 */
  totalFloor: number;
}

/**
 * 单条主评论 (楼层) 的视图数据.
 *
 * 服务端 result.comments[i].comment[0] (comment 是数组, 0 是主评论, 后面是楼中楼回复;
 * v1 不展开楼中楼, 只标记"还有 N 条回复"提示用户去 web 看).
 */
export interface XiaoheiheCommentForView {
  /** 评论 id (前端去重 + 后续翻子评论用) */
  commentId: string;
  /** 评论者用户名 */
  username: string;
  /** 头像 url (https), 空则前端用占位 */
  avatar: string;
  /** 用户等级 (没有则 0, 前端不显示) */
  level: number;
  /** 评论文本 (服务端给的就是纯文本, 含表情占位符如 [cube_哭泣]) */
  text: string;
  /** 楼层号, 0 表示置顶 (服务端给 floor_num=0/is_top=1 表示置顶楼) */
  floorNum: number;
  /** 点赞数 */
  up: number;
  /** IP 属地 ("湖北" / "陕西"); 空则前端隐藏 */
  ipLocation: string;
  /** 子评论数, >0 时前端显示 "N 条回复" 但 v1 不点开 */
  childNum: number;
  /** 是否置顶 (官方/楼主置顶) */
  isTop: boolean;
}

/**
 * 评论翻页响应 (调用方维护 page 推进).
 *
 * 翻页约定: page 从 1 起步 (跟服务端一致, 不要 0); hasMore=false 表示已到底.
 */
export interface XiaoheiheCommentsPage {
  /** 本页评论 */
  comments: XiaoheiheCommentForView[];
  /** 本次请求的 page (echo, 方便前端按 reqId 路由) */
  page: number;
  /** 总页数 (服务端 total_page), 仅用于显示, 翻页决策看 hasMore */
  totalPage: number;
  /** 是否还有下一页 (= has_more_floors === 1) */
  hasMore: boolean;
}

/**
 * /bbs/app/link/tree 的响应外壳 — 服务端字段比 feeds/news 多, 这里只声明用到的子集.
 *
 * result.link:      帖子正文 (XiaoheiheRawLink 的超集, 多了 description 完整版)
 * result.comments:  评论楼层数组, 每项 { comment: RawComment[] } —
 *                   comment[0] 是主评论, comment[1..] 是楼中楼 (v1 不展开)
 * result.total_page / has_more_floors / total_floor_num: 评论分页相关
 */
export interface XiaoheiheLinkTreeResponse {
  status?: string | number;
  msg?: string;
  message?: string;
  result?: {
    link?: XiaoheiheRawLink;
    /** 评论楼层数组, 注意是 [{ comment: [...] }, ...] 嵌套结构 */
    comments?: Array<{ comment?: XiaoheiheRawComment[] }>;
    total_page?: number;
    has_more_floors?: number | boolean;
    total_floor_num?: number;
  };
}

/**
 * 服务端 result.comments[i].comment[j] 的字段 (经验子集).
 *
 * j=0 是主评论, j>=1 是楼中楼 (回复主评论的). v1 只取 j=0 渲染主楼层.
 */
export interface XiaoheiheRawComment {
  commentid?: number | string;
  text?: string;
  up?: number;
  floor_num?: number;
  is_top?: number;
  child_num?: number;
  has_more?: number;
  ip_location?: string;
  user?: {
    username?: string;
    avatar?: string;
    avartar?: string; // 服务端字段拼写错误版本 (sic), 兜底
    level_info?: { level?: number };
  };
  [key: string]: unknown;
}

/**
 * 小黑盒 cookie 解析结果.
 *
 * 关键字段:
 *   - pkey:     登录鉴权 token, 没这个就是未登录态 — 业务接口 signedGet 注入到 Cookie header
 *   - heyboxId: 用户数字 ID, 注入到 signedGet 的 heybox_id 字段 (替代未登录占位 '-1')
 *   - rawCookie: 原始 cookie 字符串, signedGet 从这里白名单过滤后注入到 Cookie header
 *                (鉴权字段 pkey/heybox_id 及其 httpOnly 副本)
 *
 * v2.2.4 起 web hkey 走本地算法 (utils/webSign.ts), 不再需要持久化 webSig (历史
 * 字段已删, v2.2.3 老用户的 JSON 持久化在 AuthService.initialize 里向后兼容读取
 * cookie 字段, webSig 段直接丢弃).
 *
 * AuthService.getJar() 返回; 未登录返回 null.
 */
export interface XiaoheiheCookieJar {
  pkey?: string;
  heyboxId?: string;
  rawCookie: string;
}
