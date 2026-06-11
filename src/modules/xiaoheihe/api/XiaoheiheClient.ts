import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import { URLSearchParams } from 'url';
import { computeHkey, generateNonce } from '../utils/sign';
import { computeWebHkey, generateWebNonce } from '../utils/webSign';
import type {
  XiaoheiheCardForView,
  XiaoheiheCommentForView,
  XiaoheiheCommentsPage,
  XiaoheiheCookieJar,
  XiaoheiheDetailForView,
  XiaoheiheLinkTreeResponse,
  XiaoheiheNewsResponse,
  XiaoheiheRawComment,
  XiaoheiheRawLink,
  XiaoheiheSectionId,
  XiaoheiheSectionMeta,
  XiaoheiheTopicMeta,
} from '../types';

/**
 * 推荐接口路径 — 已登录态主页"真推荐流".
 *
 * 路径 '/bbs/app/feeds/maintab' 是小黑盒 APP 主页 tab 数据接口 (参考 vscode-maxPlus
 * 及若干公开抓包资料汇总, 未亲手抓包二次验证). 这个接口在登录态下返回服务端按账号
 * 画像生成的"推荐流", 跨板块混合, 每次刷新内容不同 — 解决"主页内容一摸一样"的根因.
 *
 * 风险: path 如果服务端改了 (小黑盒 APP 版本迭代时可能), 调用会业务报错; fetchHomeFeed
 * 已经做了 try-catch 回落本地混排, 不会让主页挂掉.
 *
 * 修改路径: 抓包确认正确 path 后改这里. 也可以做配置项注入但目前没必要.
 */
/**
 * 推荐接口路径 — web 端真实抓包确认 (v2.2.3).
 *
 * 早期 (v2.2.2) 曾用 '/bbs/app/feeds/maintab', 那是参考第三方资料的猜测路径,
 * 实际从未抓包验证. 2026-06 在 https://www.xiaoheihe.cn 关 "Pause on caught
 * exceptions" 绕开反调试后, Network 看到主页推荐流真实路径就是 '/bbs/app/feeds'
 * (无 /news 后缀, 跟 fetchFeed 单板块路径区分开).
 *
 * web 端 query 极简: 只有 pull=0 + offset (limit 服务端默认给 30), 我们也对齐.
 * is_first / tab / rec_mark 这类 APP 字段一律不送 - 多送会被服务端识别为
 * 协议不一致打回.
 */
const RECOMMEND_API_PATH = '/bbs/app/feeds';

/**
 * 小黑盒资讯流客户端.
 *
 * 跟知乎模块的对比 (设计差异):
 *
 *   | 维度       | zhihu (复杂)                              | xiaoheihe (本模块, 简单)             |
 *   | ---        | ---                                       | ---                                   |
 *   | 鉴权       | 用户 cookie (z_c0/d_c0), 失效要重粘        | 完全无登录, 走伪 imei + 签名访问公开 API |
 *   | 去重       | 4 层 (session_token/上报/内存/持久化)      | 仅"会话内 Set" (按 linkid)            |
 *   | 个性化推荐 | 严重依赖 session_token 防重复              | 无 — 列表纯按 tag 翻页, 服务端不个性化  |
 *   | 内嵌阅读   | 卡片就地展开正文 + 评论                    | v1: 点击在浏览器中打开 (基础版优先跑通) |
 *
 * 接口约定:
 *
 *   GET https://api.xiaoheihe.cn/bbs/app/feeds/news
 *
 *   query 必填:
 *     - heybox_id, imei:    设备身份 (匿名用户固定值)
 *     - nonce, hkey, _time: 签名三件套 (见 utils/sign.ts)
 *     - tag:                游戏 tag (见 GAMES 表)
 *     - offset, limit:      翻页
 *     - is_first:           首页 1, 翻页 0 — 影响服务端是否塞置顶/直播位
 *     - 大量"客户端环境" 字段 (os_type/version/build/channel/...)
 *       少了任何一个都可能被风控判为非官方客户端打回, 我们按抓包结果一并塞上
 *
 *   响应 result.links: XiaoheiheRawLink[] (见 types/index.ts)
 *
 * 客户端被设计成无状态 (每次 fetchFeed 都是独立调用):
 *   - 客户端不维护 offset/page — 调用方 (MainViewProvider) 维护
 *     这跟 zhihu 的 stateful 客户端不同, 原因: 小黑盒是简单的 offset 翻页,
 *     没有 session_token / cursor 这种"必须客户端连续递增"的状态
 *   - 会话级 seenIds 也由调用方管, 客户端不参与 — 视图层在切游戏 / 刷新时清空就完事
 */
/**
 * 用于在 globalState 里存放当前用户 IMEI 的 key.
 * 放 globalState (跨 workspace) 而不是 workspaceState — 同一台机器永远复用同一个,
 * 这样服务端看我们的"行为序列"是连续的, 跟普通用户更像; 一个 workspace 一个 IMEI
 * 反而像"频繁换设备"更容易触发风控.
 */
const IMEI_STORAGE_KEY = 'xiaoheihe.imei';

export class XiaoheiheClient {
  private readonly axios: AxiosInstance;

  /**
   * 当前 client 实例使用的 imei.
   *
   * 历史 (v2.2.1 之前): 写死 '054ec0ee9649217b' 常量 — 全网用户共享同一个 IMEI,
   * 服务端把它当机器人打了, link/tree 这种交互接口会返回 status='show_captcha'.
   *
   * 现在 (v2.2.2+): 每个用户机器首次启动随机生成, 通过 getOrCreateImei() 从
   * globalState 读取或新建并持久化 — 同台机器永远固定 (服务端行为序列连续, 不易被
   * 判定为可疑), 不同机器分散 (单个 IMEI 不会被多人轮番压垮). 用户也可以通过
   * 'xiaoheihe.resetImei' 命令重置 (被风控后的"换设备"逃生口).
   *
   * 任意 16 hex 字符即可, 服务端只做长度 / 字符集校验, 不会反查 IMEI 数据库.
   */
  private readonly imei: string;

  /**
   * APP 版本信息 (跟抓包到的官方 APP 一致). 服务端可能基于这个字段限制接口可用性,
   * 升级时同步抓最新 APP 改一下即可. 当前是参考实现里 1.5.0 时使用的版本.
   */
  private static readonly APP_VERSION = '1.3.347';
  private static readonly APP_BUILD = '916';

  /**
   * 从 globalState 读取 IMEI, 没有则随机生成 16 hex 字符并持久化.
   *
   * 调用方在 module.activate() 时拿到 vscode.ExtensionContext 调用一次, 把返回值
   * 传给 XiaoheiheClient 构造函数即可.
   *
   * @param ctx VSCode 扩展上下文 (用于访问 globalState)
   * @returns 16 字符 hex 字符串 IMEI
   */
  public static async getOrCreateImei(ctx: vscode.ExtensionContext): Promise<string> {
    const existing = ctx.globalState.get<string>(IMEI_STORAGE_KEY);
    // 防御性校验: 必须是 16 字符 hex (历史脏数据 / 用户瞎改 globalState 不影响功能)
    if (existing && /^[0-9a-f]{16}$/.test(existing)) {
      return existing;
    }
    const fresh = crypto.randomBytes(8).toString('hex');
    await ctx.globalState.update(IMEI_STORAGE_KEY, fresh);
    return fresh;
  }

  /**
   * 重置 IMEI — 删旧的 + 生成新的并持久化, 返回新 IMEI.
   *
   * 用于"被风控了, 用户想换个设备 ID 重试" 这种场景. 注意调用后已经存在的
   * XiaoheiheClient 实例不会自动切换 (实例字段 immutable), 调用方需要丢掉旧
   * client 重建.
   */
  public static async resetImei(ctx: vscode.ExtensionContext): Promise<string> {
    const fresh = crypto.randomBytes(8).toString('hex');
    await ctx.globalState.update(IMEI_STORAGE_KEY, fresh);
    return fresh;
  }

  /**
   * 登录态读取回调 — 每次 signedGet 调用前会同步执行, 拿到最新 cookie jar 注入到请求.
   *
   * 用回调而不是直接持 AuthService 实例:
   *   1. 解耦, 避免 XiaoheiheClient 依赖 AuthService 类型 (auth 在另一个目录, 互相
   *      引用容易循环 import)
   *   2. 登录态变更 (importCookie / logout) 后无需重建 client — 回调下次执行就拿到
   *      新值, 主页刷新立刻切换推荐/本地混排
   *   3. 单测时直接 mock 回调返回任意 jar, 不用 mock 整个 AuthService
   */
  private readonly getCookieJar: () => XiaoheiheCookieJar | null;

  /**
   * 读取 cookie 注入模式的回调.
   *
   * 跟 getCookieJar 一样, 用回调而不是直接读 vscode.workspace.getConfiguration
   * 的理由:
   *   1. client 文件不引入 vscode 运行时 (现在 vscode 是 import type) — 保持
   *      client 是纯逻辑层, 单测无需 mock vscode
   *   2. setting 变更后无需重建 client — 回调下次执行就拿到新值
   *   3. 调试时调用方可以临时硬编码不同 mode 不依赖 settings
   *
   * 缺省返回 'header'.
   */
  private readonly getCookieInjectMode: () => 'header' | 'query' | 'off';

  /**
   * 旁路"板块自动发现"回调 — feeds 响应里每条 link 都自带 topics[] 元信息
   * (topic_id / name / pic_url / app_id / game_type), 我们 fire-and-forget 把它
   * 们累积到 globalState 字典 (key 'xiaoheihe.topicMap'), 给 fetchFeed 反查 topicId
   * 做 fallback. 详见 types/index.ts XiaoheiheTopicMeta 注释.
   *
   * 用回调而不是直接持 ExtensionContext 的理由跟 getCookieJar 一致:
   *   1. 保持 client 不依赖 vscode 运行时 (单测无需 mock vscode)
   *   2. 累积策略 (合并 / 去重 / 清空策略) 由 index.ts 集中实现, client 不关心
   *   3. 不注入回调时直接 noop (单测 / 旧调用方不用改)
   *
   * 回调实现侧应该:
   *   - 接收 normalized 后的 XiaoheiheTopicMeta[] (字段已 camelCase, topicId 强转 string)
   *   - 内部按 name 合并到字典 (后入覆盖前入), 写 globalState
   *   - 不要在回调里 throw — fire-and-forget 调用方不会 catch, 抛出去也是丢
   */
  private readonly onTopicsDiscovered: (topics: XiaoheiheTopicMeta[]) => void;

  /**
   * 反查"已自动发现的板块 topicId" 回调 — fetchFeed 走推荐流前的兜底.
   *
   * 触发顺序: fetchFeed 取 topicId 时
   *   1) 优先 section.topicId (BUILTIN_SECTIONS 硬编码值, 抓包验证过的)
   *   2) fallback this.lookupDiscoveredTopicId(section.label / section.id)
   *      (用户用过的板块, 主页推荐流 / 同板块帖子 link.topics[] 累积出来的)
   *   3) 全空 → 走老 APP tag 路径 (匿名按时间序)
   *
   * key 优先用 section.label (中文名, 跟 topic.name 自然对齐), id (英文 slug)
   * 兜底是为了万一用户自定义 section 时 label 不规范, 用 id 也能命中.
   *
   * 不注入时直接 noop (返回 undefined) — 退化成"只看硬编码 topicId".
   */
  private readonly lookupDiscoveredTopicId: (key: string) => string | undefined;

  /**
   * @param opts.imei            必填, 设备 IMEI (调用方应通过 getOrCreateImei 获取)
   * @param opts.getCookieJar    必填, 同步获取当前 cookie jar 的回调 (无登录态时返回 null)
   * @param opts.getCookieInjectMode 可选, 获取 cookie 注入模式. 默认全部返回 'header'.
   * @param opts.onTopicsDiscovered 可选, "运行时自动发现板块 topicId" 回调.
   *        每次 fetch{Home|Recommend|TopicRecommend}Feed 返回 link 数组时旁路调用一次,
   *        参数是从 link.topics[] 归一化出来的 XiaoheiheTopicMeta[]. 不传则不累积.
   * @param opts.lookupDiscoveredTopicId 可选, "反查已发现 topicId" 回调.
   *        fetchFeed 在 section 未硬编码 topicId 时按 section.label / section.id 反查;
   *        命中即走推荐流. 不传则只用硬编码值.
   * @param opts.requestTimeoutMs 请求超时, 默认 15s
   */
  constructor(opts: {
    imei: string;
    getCookieJar: () => XiaoheiheCookieJar | null;
    getCookieInjectMode?: () => 'header' | 'query' | 'off';
    onTopicsDiscovered?: (topics: XiaoheiheTopicMeta[]) => void;
    lookupDiscoveredTopicId?: (key: string) => string | undefined;
    requestTimeoutMs?: number;
  }) {
    if (!opts || !opts.imei) {
      throw new Error('XiaoheiheClient: imei 必填, 请通过 XiaoheiheClient.getOrCreateImei() 获取');
    }
    if (typeof opts.getCookieJar !== 'function') {
      throw new Error('XiaoheiheClient: getCookieJar 必填 (无登录态实现可传 () => null)');
    }
    this.imei = opts.imei;
    this.getCookieJar = opts.getCookieJar;
    this.getCookieInjectMode =
      opts.getCookieInjectMode || (() => 'header');
    // 默认 noop — 没传回调时 collectTopicsFromLinks 仍然会被调用,
    // 只是没人接收 (省一个 if 分支, 也方便单测注入计数 mock).
    this.onTopicsDiscovered = opts.onTopicsDiscovered || (() => {});
    this.lookupDiscoveredTopicId =
      opts.lookupDiscoveredTopicId || (() => undefined);
    this.axios = axios.create({
      baseURL: 'https://api.xiaoheihe.cn',
      timeout: opts.requestTimeoutMs ?? 15000,
      headers: {
        // okhttp UA — 跟官方 APP 一致, 避免被认成 web 端走另一套限流策略
        'User-Agent': 'okhttp/4.9.1',
      },
      // 不抛非 2xx, 业务 code 我们自己看 (跟 zhihu 风格一致)
      validateStatus: () => true,
    });
  }

  /**
   * 拉一页资讯.
   *
   * @param gameId 游戏 id, 必须是 GAMES 表里的
   * @param offset 偏移量 (0 起步), 翻页时 +limit
   * @param limit  每页条数, 默认 30 (跟 APP 默认一致, 不要调太大 — 服务端有限流)
   * @returns 归一化后的卡片列表 + 是否到底
   *
   * 错误处理:
   *   - 网络错误 / 超时:  抛 Error('请求失败: <msg>')
   *   - 业务错误 (签名错/版本过旧): 抛 Error('小黑盒接口错误: <msg>')
   *   - 服务端返回 0 条:  正常返回 { cards: [], isEnd: true }, 不当错误
   */
  public async fetchFeed(
    section: XiaoheiheSectionMeta,
    offset: number,
    limit = 30,
  ): Promise<{ cards: XiaoheiheCardForView[]; isEnd: boolean }> {
    if (!section) {
      throw new Error('fetchFeed 缺 section 参数');
    }
    // tag / topicId 至少要有一个 — 主页 (tag='' + topicId 也空) 不该走这里, 应走 fetchHomeFeed.
    // 历史上这里只校验 tag, 现在 BUILTIN_SECTIONS 全部都有 tag (新增 116 个用 'topic_<id>'
    // 占位), 但为了兜底未来"只有 topicId 没有 tag" 的自动发现板块也能用, 校验放宽到二选一.
    if (!section.tag && !section.topicId) {
      throw new Error('fetchFeed 不支持 tag/topicId 全为空的板块, 主页请走 fetchHomeFeed');
    }

    // ============================================================
    // v2.2.6: 登录态 + 板块配了 topicId → 优先走 web 推荐流接口
    // ============================================================
    //   - /bbs/app/topic/feeds?topic_id=<数字id>: 服务端按 pkey 个性化排序,
    //     每次刷新内容会变. 是主页 /bbs/app/feeds 推荐接口的"按板块过滤" 版本.
    //   - 失败 (path 错 / topicId 错 / cookie 过期 / 风控): 静默 fallback 老 APP
    //     tag 路径, 体验降级回"按时间序"但仍可用, 不会变白屏.
    //   - 未登录 / 板块无 topicId / forceApp 兜底: 直接走老 APP tag 路径.
    //
    // 内容侧实测差异: web topic/feeds 同板块每次刷新顺序明显不同 (服务端推荐),
    // 而 APP /feeds/news 是固定按时间序; 这就是 "分板块也变成推荐流" 的根因修复.
    // ============================================================
    const jar = this.getCookieJar();
    // 反查 topicId 优先级 (硬编码 > 字典反查):
    //   - section.topicId: BUILTIN_SECTIONS 抓包验证过的硬编码值, 优先级最高
    //   - lookupDiscoveredTopicId: 运行时自动发现的字典 (globalState 'xiaoheihe.topicMap')
    //     key 用 section.label (中文名) 优先, section.id (英文 slug) 兜底.
    //     字典是用户用过的所有板块累积出来的, 用得越多覆盖越全.
    // 任意命中 + 登录态 → 走推荐流; 否则走老 APP tag 路径.
    const discoveredTopicId =
      this.lookupDiscoveredTopicId(section.label) ||
      this.lookupDiscoveredTopicId(section.id);
    const effectiveTopicId = section.topicId || discoveredTopicId;
    if (effectiveTopicId && jar && jar.pkey) {
      // 用 effective topicId 重新构造一个临时 section 传给 fetchTopicRecommendFeed —
      // 避免污染外层 section (它来自配置 / BUILTIN_SECTIONS, 是只读 readonly).
      const sectionWithTopic: XiaoheiheSectionMeta = {
        ...section,
        topicId: effectiveTopicId,
      };
      try {
        return await this.fetchTopicRecommendFeed(sectionWithTopic, offset, limit);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const tidSource = section.topicId ? 'builtin' : 'discovered';
        // eslint-disable-next-line no-console
        console.warn(
          `[xiaoheihe] fetchTopicRecommendFeed 失败, fallback 到 APP tag 路径: section=${section.id} topicId=${effectiveTopicId}(${tidSource}) err=${msg}`,
        );
      }
    }

    // ---- APP tag 路径 (推荐流 fallback / 未登录 / 无 topicId) ----
    // 进到这里仍要求 section.tag 非空 — 没 tag 没法发请求, 此时只能抛错让前端
    // 提示"该板块需登录后查看" (登录后会走上面 topicId 推荐流分支).
    if (!section.tag) {
      throw new Error(
        `该板块 (${section.label}) 仅支持登录态推荐流, 请导入 Cookie 登录后再查看`,
      );
    }

    // forceAppProtocol=true: /bbs/app/feeds/news 是 APP 端专属路径, web 协议
    // 参数族 (os_type=web 等) 打过去服务端返回 "非法请求". 单板块按 tag 过滤
    // 内容本来就跟账号画像无关, 这里直接强制走 APP 匿名协议, 绕开 web 协议坑.
    // 代价: 单板块走这里只是匿名按时间序 (无个性化), 但 topicId 通道已经在上面
    // 优先吃下了登录态推荐场景, 这里只承担"无 topicId / 推荐失败 / 未登录" 三档.
    const data = await this.signedGet<XiaoheiheNewsResponse>(
      '/bbs/app/feeds/news',
      {
        tag: section.tag,
        offset: String(offset),
        limit: String(limit),
        is_first: offset === 0 ? '1' : '0',
        rec_mark: 'tags',
      },
      { forceAppProtocol: true },
    );

    const rawLinks = Array.isArray(data?.result?.links) ? data.result!.links! : [];
    // 旁路累积 topics — APP /feeds/news 响应 link.topics 大概率为空 (APP 协议字段族
    // 跟 web 协议不一致), 但试一下不亏, 万一服务端补字段了我们立刻受益.
    this.collectTopicsFromLinksSafe(rawLinks);
    const cards = rawLinks
      .filter((it) => XiaoheiheClient.isRenderableLink(it))
      .map((it) => this.normalizeLink(it));

    // is_end 服务端不一定给, 用"本页一条没拿到" 作为兜底信号 — 配合 offset > 0
    // 时空页基本就到底了 (offset = 0 拿到空页通常意味着 tag 错 / 该游戏没新闻).
    const isEnd =
      data?.result?.is_end === true ||
      data?.result?.is_end === 1 ||
      rawLinks.length === 0;

    return { cards, isEnd };
  }

  /**
   * 拉一页"分板块推荐流" (登录态单板块) — 调用 web 端 /bbs/app/topic/feeds 接口.
   *
   * 跟 fetchFeed 老路径 (/bbs/app/feeds/news + tag) 的差异:
   *   - 路径不同: /bbs/app/topic/feeds, 跟主页推荐 /bbs/app/feeds 同源 (web 协议)
   *   - 板块标识不同: topic_id 数字 id (e.g. 23563=ow), 而不是 tag 字符串
   *   - 排序: 服务端按 pkey 个性化推荐排序, 每次刷新顺序可能不同 (vs APP 按时间序)
   *
   * 接口契约 (2026/06 用户抓包确认):
   *   GET /bbs/app/topic/feeds
   *     topic_id:  板块数字 id (从 XiaoheiheSectionMeta.topicId 取)
   *     offset:    偏移量, 0 起步
   *     limit:     每页条数, 默认 10 (抓包默认值; 调大未测过但理论可行)
   *     lastval:   翻页游标; 浏览器抓包 offset=0 时传空字符串. 后续翻页是否需要
   *                填上一页末尾 link 的某字段尚未验证, 暂传空跑通最小可行版本.
   *     dw:        '304' (web 端固定值, 服务端实测不严格校验; 这里不传, 复用 web
   *                分支默认的 '604' 即可, 主页推荐路径已实证 dw=604 OK)
   *     (其余环境字段由 signedGet web 分支统一注入: os_type=web / x_app=heybox_website /
   *      device_id / hkey / nonce / _time / pkey via Cookie header)
   *   响应 result.links: XiaoheiheRawLink[] (跟 feeds/news 同结构)
   *
   * 错误处理:
   *   - 未登录: 抛 Error (调用方 fetchFeed 已挡, 这里保留兜底)
   *   - 路径 / topic_id 不对: signedGet 抛业务错误 -> 调用方 fallback 老 tag 路径
   *
   * @param section 必须有 topicId 字段, sourceSectionId/Label 不在这里 patch
   *                (单板块场景前端不需要"来自 XXX" 角标)
   * @param offset  偏移量 (0 起步)
   * @param limit   每页条数, 默认 30 (服务端不严格校验)
   */
  public async fetchTopicRecommendFeed(
    section: XiaoheiheSectionMeta,
    offset: number,
    limit = 30,
  ): Promise<{ cards: XiaoheiheCardForView[]; isEnd: boolean }> {
    if (!section || !section.topicId) {
      throw new Error('fetchTopicRecommendFeed 需要 section.topicId');
    }
    const jar = this.getCookieJar();
    if (!jar || !jar.pkey) {
      throw new Error(
        'fetchTopicRecommendFeed 需要登录态 (缺 pkey); 未登录请走 fetchFeed APP 路径',
      );
    }
    // lastval 空字符串: URLSearchParams 会编码成 'lastval=', 跟浏览器抓包一致
    // (curl 里写成 '&lastval&' 是 cURL 的省略写法, 等价于 lastval='').
    const data = await this.signedGet<XiaoheiheNewsResponse>(
      '/bbs/app/topic/feeds',
      {
        topic_id: section.topicId,
        offset: String(offset),
        limit: String(limit),
        lastval: '',
      },
    );

    const rawLinks = Array.isArray(data?.result?.links) ? data.result!.links! : [];
    // 旁路累积 topics — 单板块响应里每条 link 仍可能挂多个 topic
    // (e.g. 守望先锋页帖子常多挂"PC游戏"), 累积下来后其它板块也能受益.
    this.collectTopicsFromLinksSafe(rawLinks);
    const cards = rawLinks
      .filter((it) => XiaoheiheClient.isRenderableLink(it))
      .map((it) => this.normalizeLink(it));

    const isEnd =
      data?.result?.is_end === true ||
      data?.result?.is_end === 1 ||
      rawLinks.length === 0;

    return { cards, isEnd };
  }

  /**
   * 拉一页"主页推荐流" — 把若干启用板块的内容本地混排.
   *
   * 重要: 小黑盒并没有 (公开抓包到的) "主页推荐" 接口 — 小黑盒 APP 主页的推荐内容
   * 依赖账号画像 + 服务端推荐, 接口私有且强校验. 我们的插件场景没法做账号侧画像,
   * 这里走"本地混排" 路线:
   *
   *   主页流 = 用户启用的所有非 home 板块 round-robin / interleave 拼接而成
   *
   * 这种"个性化"由"用户勾选了哪些板块"驱动, 反而比官方推荐更可解释 — 用户能精确
   * 控制主页内容构成. 取舍:
   *   - 优点: 不依赖未知接口, 永远可用; 启用板块越多, "推荐"越丰富
   *   - 缺点: 不是真正的算法推荐, 同一板块连续刷会看到顺序固定的内容; 翻页 N 次后
   *           各子板块 offset 不同步可能出现重复 (依赖前端 seenLinkIds 去重)
   *
   * 翻页约定 (offset 含义跟 fetchFeed 不一样, 注意):
   *   - 这里的 offset 是"虚拟全局 offset" — 已经从主页吐出去多少张卡片. 翻页时调用方
   *     传递自己累加的 offset, 我们把它平均摊到每个子板块 (offset / sectionCount) 作为
   *     各子板块的 offset 起点
   *   - 摊不平整时取整, 后果是相邻翻页可能小幅重叠 (前端 seenLinkIds 去重兜底)
   *
   * 策略:
   *   - 'roundrobin': 依次从每个板块取一条, 循环到 limit 满 (你1张/我1张/他1张 …)
   *                   各板块感觉"雨露均沾"
   *   - 'interleave': 每个板块各拉一页, 按"板块顺序 × 每板块前 K 条" 交错拼接
   *                   (你3张/我3张/他3张 …) — 每个板块的局部顺序感更强
   *
   * 错误处理:
   *   - 子板块拉取失败 (tag 错 / 网络抖动): 跳过该板块继续合并, 不让单点失败把整个
   *     主页拉黑. 全部子板块都失败时抛 Error('主页所有板块加载失败: ...')
   *   - 没启用任何非 home 板块: 抛 Error('未启用任何板块, 请在 ⚙ 设置中勾选')
   */
  /**
   * 拉一页"真推荐流" (登录态主页) — 调用小黑盒 APP 主页 tab 接口.
   *
   * 跟 fetchFeed 的差异:
   *   - fetchFeed: 单板块按 tag 拉, 未登录可用, 内容相对固定
   *   - fetchRecommendFeed: 跨板块按账号画像拉, 必须登录态, 每次刷新内容不同
   *
   * 接口契约 (基于参考实现 + 小黑盒 list 接口风格推断, 未亲手抓包验证):
   *   GET /bbs/app/feeds/maintab
   *     tab:        'hot' (热门) / 'follow' (关注) — 默认 'hot'
   *     offset:     偏移量
   *     limit:      每页条数
   *     is_first:   首页 1, 翻页 0
   *     (其它环境/签名参数走 signedGet 公用注入)
   *   响应 result.links: XiaoheiheRawLink[] (跟 feeds/news 同结构假设)
   *
   * 错误处理:
   *   - 未登录: 抛 Error (主页登录前不应该调这个, 调用方 fetchHomeFeed 负责判断)
   *   - 路径不对 / 接口下线: 服务端业务报错 -> signedGet 抛 -> 调用方 fallback
   *   - 返回结构不对: 静默当作空页 (cards 空 + isEnd true) — 调用方 fallback
   *
   * @param offset 偏移量 (0 起步)
   * @param limit  每页条数, 默认 30
   * @param tab    'hot' | 'follow', 默认 'hot' (前者是"算法推荐", 后者是"关注流")
   */
  public async fetchRecommendFeed(
    offset: number,
    _limit = 30,
    _tab: 'hot' | 'follow' = 'hot',
  ): Promise<{ cards: XiaoheiheCardForView[]; isEnd: boolean }> {
    const jar = this.getCookieJar();
    if (!jar || !jar.pkey) {
      throw new Error('fetchRecommendFeed 需要登录态 (缺 pkey), 请先 importCookie');
    }
    // web 端真实抓包: query 仅 pull=0 + offset, 没有 limit / tab / is_first.
    // 服务端默认每页返回 ~10 条 (实测), limit 入参保留兼容签名但不送给服务端.
    const data = await this.signedGet<XiaoheiheNewsResponse>(RECOMMEND_API_PATH, {
      pull: '0',
      offset: String(offset),
    });

    const rawLinks = Array.isArray(data?.result?.links) ? data.result!.links! : [];
    // 旁路累积 topics — 主页推荐流是"板块发现"最高效的数据源 (跨多板块混合,
    // 一次刷新就能覆盖十几个板块). 这里累积下来后 fetchFeed 即可反查 fallback.
    this.collectTopicsFromLinksSafe(rawLinks);
    const cards = rawLinks
      .filter((it) => XiaoheiheClient.isRenderableLink(it))
      .map((it) => this.normalizeLink(it));

    const isEnd =
      data?.result?.is_end === true ||
      data?.result?.is_end === 1 ||
      rawLinks.length === 0;

    return { cards, isEnd };
  }

  public async fetchHomeFeed(
    sections: readonly XiaoheiheSectionMeta[],
    offset: number,
    limit = 30,
    strategy: 'roundrobin' | 'interleave' = 'roundrobin',
  ): Promise<{ cards: XiaoheiheCardForView[]; isEnd: boolean }> {
    // 登录态优先走真推荐接口 — 解决"主页内容一摸一样"的根因.
    //   - 路径 / 字段不对会 throw, catch 后回落本地混排, 用户无感降级
    //   - 推荐接口返回的 card 没有 sourceSectionLabel (跨板块混合不属于任何启用板块),
    //     前端"来自 XXX" 角标不显示是预期行为
    const jar = this.getCookieJar();
    if (jar && jar.pkey) {
      try {
        const r = await this.fetchRecommendFeed(offset, limit, 'hot');
        // 推荐接口返回有效内容时直接用; 空结果也认 (服务端就是给了空就空)
        return r;
      } catch (e) {
        // 静默回落: 错误打到 console.warn, 用户看到的还是正常主页 (走本地混排).
        // 不向上抛, 保证"已登录用户依然能用主页", 推荐接口只是 nice-to-have.
        // v2.2.4 起 web hkey 用本地算法 (utils/webSign.ts), 不再需要用户手动注入
        // webSig — 这里失败大概率是 path 改了 / cookie 过期 / 风控, 让用户在
        // console 看具体错误即可, 不再触发 toast 引导.
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.warn(
          `[xiaoheihe] fetchRecommendFeed 失败, 回落本地混排模式: ${msg}`,
        );
      }
    }

    // 过滤掉 home / tag 为空的 section (防御性)
    const subs = sections.filter((s) => s && s.id && s.tag);
    if (subs.length === 0) {
      throw new Error('未启用任何板块, 请在 ⚙ 设置中勾选');
    }

    // 各子板块的 offset 起点 — 把全局 offset 平均摊到每个板块.
    // 例: 启用 6 板块, offset=60 表示主页已吐出 60 张, 每板块平均贡献 60/6=10 张,
    // 所以下一轮各板块从自身 offset=10 起继续拉.
    const subOffset = Math.floor(offset / subs.length);
    // 每个子板块要拉的条数: 比目标 limit 多拉一点防御被去重 / 失败 / 服务端少给.
    // 不过分大 (>2x), 否则白白增加流量被风控.
    const perSubLimit = Math.max(
      5,
      Math.ceil((limit / subs.length) * 1.5),
    );

    // 并发拉所有子板块 — 失败的子板块返回空数组, 不抛
    const results = await Promise.all(
      subs.map(async (sub) => {
        try {
          const r = await this.fetchFeed(sub, subOffset, perSubLimit);
          // 给每张卡 patch 来源板块信息 (主页才显示徽章)
          for (const c of r.cards) {
            c.sourceSectionId = sub.id;
            c.sourceSectionLabel = sub.label;
          }
          return { sub, cards: r.cards, isEnd: r.isEnd, ok: true as const };
        } catch (e) {
          return {
            sub,
            cards: [] as XiaoheiheCardForView[],
            isEnd: true,
            ok: false as const,
          };
        }
      }),
    );

    // 全部失败 → 抛错 (跟单板块拉空 vs. 全部网络挂掉 区分开, 让用户知道是网络问题)
    const okResults = results.filter((r) => r.ok);
    if (okResults.length === 0) {
      throw new Error('主页所有板块加载失败 (可能是网络问题), 请检查后重试');
    }

    let merged: XiaoheiheCardForView[];
    if (strategy === 'interleave') {
      // interleave: 板块A前3+板块B前3+板块C前3 … 顺序拼接 (保留板块局部顺序)
      // 直接 flatMap 即可; perSub 长度自然由 perSubLimit 控制 (实际可能更少)
      merged = results.flatMap((r) => r.cards);
    } else {
      // roundrobin: 第0轮各拿1张, 第1轮各拿1张 ... 直到限额或全部耗尽
      merged = [];
      let round = 0;
      while (merged.length < limit) {
        let advanced = false;
        for (const r of results) {
          if (r.cards.length > round) {
            merged.push(r.cards[round]);
            advanced = true;
            if (merged.length >= limit) break;
          }
        }
        // 这一轮没人推进 = 全部板块都被取空了, 收手
        if (!advanced) break;
        round++;
      }
    }

    // 裁剪到 limit (interleave 模式可能爆超)
    if (merged.length > limit) merged = merged.slice(0, limit);

    // isEnd: 主页"到底"的语义比单板块复杂得多. 我们采用最保守的判断:
    // 所有子板块都 isEnd 才认为主页到底; 只要还有一个板块还有内容, 主页就能继续翻.
    // 一个常见 corner: 6 个板块 5 个到底 1 个还能翻, 主页继续翻只会重复返回那 1 个
    // 板块的卡片, 看着像"被刷屏" — v1 接受这个体验, 未来可以加"已耗尽板块不再纳入混排"优化.
    const isEnd = results.every((r) => r.isEnd);

    return { cards: merged, isEnd };
  }

  /**
   * 拉单个帖子的详情正文 (link/tree 接口, page=1 limit=1 — 只为了拿 link 字段,
   * 评论单独走 fetchCommentsPage 翻).
   *
   * @param linkId 数字 linkid 的字符串形式 (跟 XiaoheiheCardForView.linkId 对应)
   *
   * 错误处理: 同 fetchFeed (网络 / 业务错误抛 Error).
   * 设计: 不缓存 — 用户重新点开一张卡, 直接再请求一次. 小黑盒服务端有边缘缓存,
   * 同一 linkid 反复请求成本低; 如果体验抖动再考虑加 Map<linkId, detail>.
   */
  public async fetchDetail(linkId: string): Promise<XiaoheiheDetailForView> {
    if (!linkId) throw new Error('linkId 为空');
    // v2.2.5 协议策略调整: 登录态优先走 web 协议, 避开 APP 协议的 IMEI 风控.
    //
    // 旧版本写死 forceAppProtocol=true 的历史原因 (v2.2.3 及之前):
    //   当时用的 huandu 老 hkey 算法已被服务端废弃, web 协议参数族打 link/tree
    //   一律返回 "非法请求". 只能 fallback APP 匿名协议. 副作用:
    //   同一台机器反复以匿名 IMEI 频繁请求 link/tree → 服务端风控判 "爬虫"
    //   → status=show_captcha → 用户被迫执行 "重置设备 ID" 才能恢复.
    //
    // v2.2.4 起 web hkey 走本地 ov 算法 (utils/webSign.ts), 跟浏览器抓包完全
    // 一致. 服务端理论上应放行 web 协议族打 link/tree. 改用 signedGetLinkTree
    // helper: 登录态优先 web (绕开 IMEI 风控), 失败再 fallback APP 匿名.
    const data = await this.signedGetLinkTree<XiaoheiheLinkTreeResponse>(
      '/bbs/app/link/tree',
      {
        link_id: linkId,
        page: '1',
        // limit=1 是因为这里只取 link, 评论让 fetchCommentsPage 重新拉,
        // 这样首屏展开详情网络成本最小; 用户点 "查看评论" 才付出评论这一页成本.
        limit: '1',
        sort_filter: 'hot',
      },
    );

    const link = data?.result?.link;
    if (!link) {
      throw new Error('详情数据为空');
    }

    // 正文解析 (v2.2.5 重写): 优先 link.text (结构化富文本块), 失败 fallback link.description.
    //
    // 字段优先级根据 v2.2.5 诊断结果:
    //   1) link.text  — 完整正文 JSON, 结构 [{"text": "..."}, {"type": "img", ...}, ...]
    //                   实测一篇 1853 字的帖子, text 含全文, description 只截首 127 字摘要.
    //   2) link.description — 旧字段, 短帖大多是完整 HTML 富文本; 长帖被服务端截断.
    //                         text 解析失败时 fallback (保护未知格式 / 兼容历史 / 兜底).
    //
    // 富文本块解析约定 (基于诊断样本归纳, parseRichText 内部实现防御性 fallback):
    //   - {text:"..."} 文本块 -> 直接拼接 (允许内嵌 <img>, 再过一遍 stripHtmlPreserveImages)
    //   - {type:"img"|"image", url/src/img_url:"..."} 图片块 -> [IMG:url] 占位符
    //   - 字符串节点 -> 直接当文本
    //   - 其它未知类型 -> 跳过 (避免渲染垃圾)
    //
    // 再把 raw.imgs / raw.thumbs 里 text 没出现过的图 append 到末尾 (兜底"列表给的封面").
    // 前端按 imagesEnabled 开关把 [IMG:url] 渲染成 <img> 或 "🖼️ 图片" 占位.
    const linkAny = link as Record<string, unknown>;
    const rawText = typeof linkAny.text === 'string' ? linkAny.text : '';
    const rawDesc = link.description ?? '';

    let bodyText: string;
    let inlineImgUrls: string[];
    let usedField: 'text' | 'description' | 'empty';

    const rich = rawText ? parseRichText(rawText) : null;
    if (rich) {
      bodyText = rich.text;
      inlineImgUrls = rich.urls;
      usedField = 'text';
    } else {
      const stripped = stripHtmlPreserveImages(rawDesc);
      bodyText = stripped.text;
      inlineImgUrls = stripped.urls;
      usedField = rawDesc ? 'description' : 'empty';
    }

    const fallbackImgs = collectContentImgs(link);
    const seen = new Set<string>(inlineImgUrls);
    const extraImgs: string[] = [];
    for (const u of fallbackImgs) {
      if (!seen.has(u)) {
        seen.add(u);
        extraImgs.push(u);
      }
    }
    let contentText = bodyText;
    if (extraImgs.length > 0) {
      // append 之前确保有空行隔开正文文本 (如果有的话). 形成的 [IMG:url] 一行一个,
      // 前端 renderTextWithImages 按 [IMG:url] 切片渲染, 顺序保留.
      const sep = contentText ? '\n\n' : '';
      contentText = contentText + sep + extraImgs.map((u) => imgPlaceholder(u)).join('\n');
    }

    // 临时诊断 (v2.2.5): 用了哪个字段 + 解析结果摘要, 用户实测后确认 OK 即可删掉.
    // 上一轮诊断已定位 link.text 是全文, link.description 是摘要; 下一轮验证完整链路.
    try {
      console.warn(
        `[xiaoheihe][DEBUG fetchDetail] linkId=${linkId} usedField=${usedField} ` +
          `rawTextLen=${rawText.length} rawDescLen=${rawDesc.length} ` +
          `bodyLen=${bodyText.length} inlineImgs=${inlineImgUrls.length} ` +
          `extraImgs=${extraImgs.length} ` +
          `contentSample="${contentText.slice(0, 300).replace(/\s+/g, ' ')}" ` +
          `contentTail="${contentText.slice(-200).replace(/\s+/g, ' ')}"`,
      );
    } catch {
      // 诊断日志失败不影响主流程
    }

    return {
      linkId,
      contentText,
      // 保留所有图 URL (description 内 + raw.imgs/thumbs 兜底, 去重后) 给上层做统计.
      // 前端不直接渲染这个数组 (图都在 contentText 的 [IMG:url] 占位里), 仅作未来扩展.
      contentImgs: Array.from(seen),
      commentCount: typeof link.comment_num === 'number' ? link.comment_num : 0,
      totalFloor:
        typeof data?.result?.total_floor_num === 'number'
          ? data.result.total_floor_num
          : 0,
    };
  }

  /**
   * 拉一页评论 (link/tree 同接口, 调用方维护 page 推进).
   *
   * @param linkId  目标帖子的 linkid (字符串)
   * @param page    页码, 从 1 起步
   * @param limit   每页楼层数, 默认 20 (官方 APP 经验值; >50 服务端可能截断)
   * @param sort    排序: 'hot' 热门 (默认) / 'time' 最新; v1 视图不暴露切换,
   *                固定 hot 即可
   */
  public async fetchCommentsPage(
    linkId: string,
    page: number,
    limit = 20,
    sort: 'hot' | 'time' = 'hot',
  ): Promise<XiaoheiheCommentsPage> {
    if (!linkId) throw new Error('linkId 为空');
    if (page < 1) page = 1;
    // 同 fetchDetail (v2.2.5): 登录态优先 web, 失败 fallback APP 匿名,
    // 避开 IMEI 风控引起的 show_captcha. 评论流量比 detail 大得多 (一篇热帖
    // 翻几页就大几十次请求), 走匿名 APP 更容易触风控, web 协议更稳.
    const data = await this.signedGetLinkTree<XiaoheiheLinkTreeResponse>(
      '/bbs/app/link/tree',
      {
        link_id: linkId,
        page: String(page),
        limit: String(limit),
        sort_filter: sort,
      },
    );

    const rawFloors = Array.isArray(data?.result?.comments)
      ? data.result!.comments!
      : [];
    // result.comments 是 [{ comment: [主评论, 子1, 子2, ...] }, ...] 嵌套结构.
    // v1 只取每楼的 comment[0] 主评论, 子评论以 "N 条回复" 提示, 不实际渲染.
    const comments: XiaoheiheCommentForView[] = [];
    for (const floor of rawFloors) {
      const main = floor?.comment?.[0];
      if (!main || !main.commentid) continue;
      comments.push(this.normalizeComment(main));
    }

    const hasMore =
      data?.result?.has_more_floors === true ||
      data?.result?.has_more_floors === 1;
    const totalPage =
      typeof data?.result?.total_page === 'number' ? data.result.total_page : 0;

    return { comments, page, totalPage, hasMore };
  }

  /**
   * raw link -> view card.
   *
   * 关键归一化:
   *   - linkid 统一转 string (防止前端 JS 大整数精度)
   *   - 摘要做 HTML 剥离 + 截断, 卡片视图最多展示 ~200 字, 多了影响列表密度
   *   - 封面图按 imgs[0] -> thumbs[0] 兜底, 都没有就空字符串
   *   - 作者: 服务端字段叫 post_tag (字面"帖子标签"但实际是作者昵称, 抓包确认)
   *   - 时间: 服务端已给好 formated_time ("3 小时前" / "yyyy-MM-dd"), 直接用,
   *     缺失时退回到本地按 modify_at 格式化
   *   - 子标签: 从 hashtags[0].name 取, 没有就空 (服务端没有"link_tag"字符串字段)
   *   - shareUrl: 直接用 raw.share_url, 不要自己拼 (link_id 是 hash 不是 linkid)
   */
  /**
   * 判断一条 raw link 是否值得渲染成卡片. 历史上 (v2.x 早期) 这里硬卡
   * `content_type === 1` 把视频/活动/合集等新类型全干掉, 2026-06 实测推荐流
   * 大量 `content_type === 44` 的帖子被误杀导致"暂无数据" — 服务端已经把
   * content_type 从 "1=帖子 / 10=工具栏" 这种小范围扩展到了一堆数值代号
   * (44 / 50 / 60 …), 我们对应不上也没必要枚举.
   *
   * 现在规则简化成"内容字段是否够渲染":
   *   - 必须有 `linkid` (兜底, 拼 share_url / 跳转 / 去重都依赖它)
   *   - `title` 或 `description` 至少一个非空 — 这条天然兜住了
   *     content_type=10 "专题工具栏" (头部 ow战绩/组队大厅/赛事中心) 这类
   *     纯交互卡片 (它们没 title / 没 linkid, 同样会被本规则排除)
   *
   * 不再黑/白名单 content_type, 服务端再加新类型也不需要改这里.
   */
  /**
   * 从一批 raw link 里抽出板块 (topic) 元信息, 归一化后 fire-and-forget 推给
   * onTopicsDiscovered 回调.
   *
   * "Safe" 后缀: 内部全程 try-catch, 任何异常都吞 (旁路逻辑绝不允许污染主流程).
   * 服务端字段缺失 / topics 不是数组 / topic_id 不是数字之类的脏数据都按"跳过该条"
   * 处理, 不抛.
   *
   * 数据源契约 (2026/06 单板块 feeds 响应抓包确认):
   *   link.topics: [{topic_id, name, pic_url, app_id, game_type, hot_value_v2}, ...]
   *
   * 累积语义: 同一次调用内 name 重复时取首个 (一批 link 同板块名应该是同一个 topic_id);
   * 跨调用合并由 onTopicsDiscovered 回调实现侧负责 (index.ts 把"后入覆盖前入" 写
   * globalState).
   */
  private collectTopicsFromLinksSafe(
    rawLinks: readonly XiaoheiheRawLink[],
  ): void {
    try {
      if (!Array.isArray(rawLinks) || rawLinks.length === 0) return;
      const collected = new Map<string, XiaoheiheTopicMeta>();
      for (const link of rawLinks) {
        const topics = link?.topics;
        if (!Array.isArray(topics)) continue;
        for (const t of topics) {
          if (!t) continue;
          const name = typeof t.name === 'string' ? t.name.trim() : '';
          // topic_id 服务端给 number, 也防御性兜住 string. <=0 / 不可解析的丢弃.
          const tidRaw = t.topic_id;
          const tidNum =
            typeof tidRaw === 'number'
              ? tidRaw
              : typeof tidRaw === 'string'
              ? Number(tidRaw)
              : NaN;
          if (!name || !Number.isFinite(tidNum) || tidNum <= 0) continue;
          if (collected.has(name)) continue; // 同批以首个为准
          collected.set(name, {
            topicId: String(tidNum),
            name,
            picUrl: typeof t.pic_url === 'string' ? t.pic_url : undefined,
            appId: typeof t.app_id === 'number' ? t.app_id : undefined,
            gameType: typeof t.game_type === 'string' ? t.game_type : undefined,
          });
        }
      }
      if (collected.size === 0) return;
      // 防回调里再抛把旁路逻辑变成主流程异常源 — 再加一层 try.
      try {
        this.onTopicsDiscovered(Array.from(collected.values()));
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          '[xiaoheihe] onTopicsDiscovered 回调抛错, 已忽略:',
          e instanceof Error ? e.message : String(e),
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        '[xiaoheihe] collectTopicsFromLinksSafe 内部异常, 已忽略:',
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  private static isRenderableLink(
    raw: XiaoheiheRawLink | null | undefined,
  ): raw is XiaoheiheRawLink {
    if (!raw) return false;
    if (raw.linkid === undefined || raw.linkid === null) return false;
    if (!(raw.title || raw.description)) return false;
    return true;
  }

  private normalizeLink(raw: XiaoheiheRawLink): XiaoheiheCardForView {
    const linkId = String(raw.linkid);
    const title = (raw.title ?? '').trim();
    const excerpt = stripHtml(raw.description ?? '').slice(0, 200);
    const cover = pickCover(raw);
    const authorName = (raw.post_tag ?? '').trim();
    const linkTag = (raw.hashtags?.[0]?.name ?? '').trim();
    const isVideo = raw.has_video === 1;
    const publishedAt =
      (raw.formated_time && raw.formated_time.trim()) ||
      formatTime(raw.modify_at);
    const commentCount = typeof raw.comment_num === 'number' ? raw.comment_num : 0;
    const awardCount =
      typeof raw.link_award_num === 'number' ? raw.link_award_num : 0;

    // 必须用服务端返回的完整 share_url (含 h_src/h_camp/link_id hash), 自己拼会 403.
    // 极端情况下 share_url 缺失, 兜底走 h5 详情页 (link_id 用数字 linkid 也能跳).
    const shareUrl =
      (raw.share_url && raw.share_url.trim()) ||
      `https://h5.xiaoheihe.cn/bbs/share/link?link_id=${encodeURIComponent(linkId)}`;

    return {
      linkId,
      title,
      excerpt,
      cover,
      authorName,
      linkTag,
      isVideo,
      publishedAt,
      commentCount,
      awardCount,
      shareUrl,
    };
  }

  /**
   * raw comment -> view comment. 归一化字段名差异 + 兜底.
   *
   * 服务端 user.avatar / user.avartar 两个拼写都见过 (sic, 服务端历史拼错没改),
   * 这里两个都试一遍, 任意一个有就用.
   */
  private normalizeComment(raw: XiaoheiheRawComment): XiaoheiheCommentForView {
    const u = raw.user ?? {};
    return {
      commentId: String(raw.commentid ?? ''),
      username: (u.username ?? '').trim(),
      avatar: (u.avatar ?? u.avartar ?? '').trim(),
      level: typeof u.level_info?.level === 'number' ? u.level_info.level : 0,
      text: (raw.text ?? '').trim(),
      floorNum: typeof raw.floor_num === 'number' ? raw.floor_num : 0,
      up: typeof raw.up === 'number' ? raw.up : 0,
      ipLocation: (raw.ip_location ?? '').trim(),
      childNum: typeof raw.child_num === 'number' ? raw.child_num : 0,
      isTop: raw.is_top === 1,
    };
  }

  /**
   * link/tree (帖子详情 / 评论翻页) 专用签名策略, v2.2.5 新增.
   *
   * 解决问题: 老版本 fetchDetail / fetchCommentsPage 写死 forceAppProtocol=true,
   * 强制走 APP 匿名协议. 同一台机器的 IMEI 反复匿名请求 link/tree 后必触
   * 服务端风控 → status=show_captcha → 用户被迫执行 "重置设备 ID" 才能恢复.
   * 而且重置后用一阵子又会被打标记, 死循环.
   *
   * 新策略:
   *   - 已登录 (jar.pkey 有效): 优先走 web 协议 (不带 imei, 完全跟浏览器对齐 →
   *     绕开 IMEI 风控). 失败 fallback APP 匿名.
   *   - 未登录: 直接走 APP 匿名 (没 cookie 也没别的选择).
   *
   * fallback 条件: web 协议抛 "非法请求" / "登录态请求被拒" 等签名/cookie 类错误
   * 才 fallback. **不**为 show_captcha fallback — 那是 APP 协议风控, fallback
   * 后立刻又会 captcha, 反而把"重试机会"也耗掉.
   */
  private async signedGetLinkTree<
    T extends { status?: string | number; msg?: string; message?: string },
  >(apiPath: string, business: Record<string, string>): Promise<T> {
    const jar = this.getCookieJar();
    const injectMode = this.getCookieInjectMode();
    // 'off' 模式语义就是 "完全模拟未登录", 这里跟未登录走相同的 APP 匿名分支.
    const hasLogin =
      !!(jar && jar.pkey) && injectMode !== 'off';

    if (!hasLogin) {
      // 未登录 (含 'off' 模式): 直接 APP 匿名, 没有 fallback 余地.
      return this.signedGet<T>(apiPath, business, { forceAppProtocol: true });
    }

    // 登录态: 先试 web 协议 (绕开 IMEI 风控).
    try {
      return await this.signedGet<T>(apiPath, business);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // captcha 错误不 fallback (说明 IMEI 已被标记, 走 APP 匿名也是同一 IMEI,
      // 立刻又 captcha). 直接抛, 让用户去执行 "重置设备 ID".
      if (/触发验证码|IMEI/.test(msg)) throw e;
      // cookie 失效 / 网络错误也不 fallback (前者需要用户重新导入 cookie,
      // 后者 APP 协议也会同样失败). 只对"签名/请求构造"类错误 fallback —
      // 用 "登录态请求被拒" 文案 (signedGet 抛的) 跟 "非法请求" 关键字识别.
      const shouldFallback =
        /登录态请求被拒|非法请求/.test(msg) ||
        /小黑盒接口错误.*status=/.test(msg);
      if (!shouldFallback) throw e;
      // eslint-disable-next-line no-console
      console.warn(
        `[xiaoheihe] ${apiPath} web 协议失败, fallback APP 匿名: ${msg}`,
      );
      return this.signedGet<T>(apiPath, business, { forceAppProtocol: true });
    }
  }

  /**
   * 统一的 "签名 GET" 入口 — 把"业务参数" 跟"环境 + 签名" 三件套拼到一起.
   *
   * 设计动机: feeds/news 和 link/tree 用的环境 / 签名参数完全一致, 提取这里让两个
   * 公开方法都能瘦身, 后续加新接口 (用户主页 / 收藏列表) 也复用.
   *
   * @param apiPath  以 '/' 开头的接口路径, 不含 query (e.g. '/bbs/app/feeds/news')
   * @param business 业务参数 (tag/offset/page 等). 全 string, 不要传 undefined —
   *                 URLSearchParams 会把 undefined 序列化成 "undefined" 字面量, 服务端打回.
   *
   * 错误处理:
   *   - 网络 / HTTP 非 2xx -> 抛 '请求失败: ...'
   *   - 业务 status 非 ok / 0 -> 抛 '小黑盒接口错误: ...'
   *
   * status 兼容 string 'ok' / number 0 两种, 历史接口风格不一.
   */
  private async signedGet<
    T extends { status?: string | number; msg?: string; message?: string },
  >(
    apiPath: string,
    business: Record<string, string>,
    opts?: { forceAppProtocol?: boolean },
  ): Promise<T> {
    const ts = Math.floor(Date.now() / 1000);
    // ⚠️ nonce 必须按协议分别生成, 否则虽然 hkey 算对了但服务端会因 nonce 格式
    // 检查不过返回 "非法请求":
    //   - APP 协议: '6ELSZjqx' 字符集 (服务端只校验长度)
    //   - web 协议: 32 位大写 hex (服务端额外做正则校验, 跟浏览器实际请求对齐)
    // 真正的 nonce 在下面的协议分支里二次决定 (这里先占位算 ts 用).
    const appNonce = generateNonce();

    // ============================================================
    // 协议分支决策 (v2.2.3 引入, v2.2.4 完善):
    // ============================================================
    // 实测发现: web cookie 的 pkey 配 **APP 协议参数族** (os_type=Android +
    // x_app=heybox + imei + build/channel/netmode...) 一律被服务端打回
    // "非法请求" / "验证参数错误" — 因为服务端是按"客户端类型"分发鉴权链路的:
    //   APP 路径 → 校验 IMEI ↔ pkey 设备绑定 → web cookie 没绑定 → 拒
    //   WEB 路径 → 仅校验 cookie pkey 合法性 → web cookie 直接通过
    //
    // 抓 https://www.xiaoheihe.cn 浏览器真实请求拿到 web 协议参数族签名:
    //   os_type=web, x_os_type=Mac, x_app=heybox_website, client_type=web,
    //   x_client_type=web, device_info=Chrome, device_id=<32位hex>,
    //   version=999.0.4, web_version=2.5, dw=604
    //   配合 Origin/Referer/Chrome UA + Cookie header 中的 pkey → 200 OK.
    //
    // v2.2.4 起 hkey 用 utils/webSign.computeWebHkey 本地计算, 完全去掉
    // v2.2.3 的 "手动注入 webSig" 步骤, 用户体验回归"导入 cookie 即可" 一步到位.
    // (huandu/heybox-url 老算法已被服务端废弃, 现在用的是从 www.xiaoheihe.cn 当前线上
    //  Nuxt bundle 逆向出来的新 ov 算法, 35 字符 DICT + MD5 + AES MixColumns checksum.)
    // 算法不依赖 cookie/device_id/imei, 只用 path+ts+nonce 三件套, 详见 utils/webSign.ts.
    //
    // 分支规则:
    //   - 有 effectiveJar.pkey  → web 协议参数 + 浏览器 UA + Origin/Referer
    //                              + Cookie header (依 injectMode 决定是否真的注入)
    //   - 无 pkey (匿名 / 'off') → 原 APP 协议参数 + okhttp UA (跟历史完全一致)
    //
    // injectMode 仍然保留, 但语义变成 "Cookie 是否真的写进 Cookie header":
    //   - 'header' (默认): web 协议 + Cookie header 写真鉴权字段
    //   - 'query':  web 协议但 pkey 进 query (老兼容路径, 实测仍挂, 留着备用)
    //   - 'off':    回到完全匿名 APP 协议 (兜底逃生口, 跟未登录态等价)
    // ============================================================
    const jar = this.getCookieJar();
    const injectMode = this.getCookieInjectMode();
    const forceApp = opts?.forceAppProtocol === true;
    // 'off' 模式 / forceApp 模式 都完全无视 jar, 模拟未登录请求.
    //   - forceApp 必须把 jar 也摘掉的关键原因 (踩坑记录):
    //     如果 jar 还在, heyboxIdForReq 会拿到真实账号 id (e.g. 47252771),
    //     然后 query 里发出 heybox_id=47252771 但又没带 Cookie/pkey 鉴权.
    //     服务端看到 "真账号 id + 无鉴权" 直接判伪造请求 → 打回 "非法请求".
    //     摘掉 jar 后 heyboxIdForReq 回退 '-1', 完全等价于未登录态请求.
    const effectiveJar =
      injectMode === 'off' || forceApp ? null : jar;
    const heyboxIdForReq =
      (effectiveJar && effectiveJar.heyboxId) || '-1';
    // 登录态判定 — 决定走 web 协议 OR APP 协议的唯一开关.
    //   - 有 effectiveJar.pkey → web 协议 (forceApp 已经把 jar 置 null, 自然走 APP)
    //   - 无 pkey (匿名 / 'off' / forceApp) → APP 协议匿名
    const useWebProtocol = !!(effectiveJar && effectiveJar.pkey);

    // ⚠️ APP 协议签名第三个参数是 `${imei}-1` (设备 imei, 不是 heybox_id!).
    //   服务端用 query 里的 imei 重算 hkey 做比对 — 详见 sign.ts 注释.
    //   登录态切换不影响签名公式: imei 是设备维度的, heybox_id 是账号维度的,
    //   两者解耦. 早期一版我误把这里写成 heyboxIdForReq 导致登录后所有接口
    //   返回 '非法请求' / '验证参数错误', 别再踩.
    //
    // appHkey 只用于 APP 分支 (else 走匿名 APP 协议时); web 分支用 webHkey
    // (下面 if 内部用 computeWebHkey 现算).
    const appHkey = computeHkey(apiPath + '/', ts, `${this.imei}-1`);

    // 构造 query 参数 — 按协议分支走完全不同的字段族.
    let params: URLSearchParams;
    if (useWebProtocol) {
      // ============================================================
      // web 协议签名 (v2.2.4): 完全本地计算, 零用户操作.
      // ============================================================
      // 算法来源: www.xiaoheihe.cn 线上 Nuxt bundle 逆向出来的 `ov` 函数,
      // 实现见 utils/webSign.ts. computeWebHkey(path, ts, nonce) → 7 位 [0-9A-Z] hkey.
      //
      // device_id: 跟 web 端浏览器指纹同长度 (32 位 hex), 用 imei 派生 — 同台机器
      //   始终相同, 跟 web 端浏览器一致("一个浏览器一个 device_id"). 服务端实测
      //   不强校验 device_id 跟某次 hkey 的配对关系, 任意稳定 32 位 hex 即可.
      // ============================================================
      // web 协议专用 nonce: 32 位大写 hex, 跟浏览器抓包一致 (服务端会做格式
      // 校验, 别误用 APP 字符集 '6ELSZjqx' 的版本, 否则 hkey 数学算对也会被
      // 判 "非法请求").
      const webNonce = generateWebNonce();
      const webHkey = computeWebHkey(apiPath, ts, webNonce);
      const deviceId = crypto
        .createHash('md5')
        .update(this.imei + ':device_id')
        .digest('hex');
      params = new URLSearchParams({
        ...business,
        heybox_id: heyboxIdForReq,
        // ====== web 协议参数族 (对齐 https://www.xiaoheihe.cn 真实抓包) ======
        os_type: 'web',
        x_os_type: 'Mac',
        x_app: 'heybox_website',
        client_type: 'web',
        x_client_type: 'web',
        device_info: 'Chrome',
        device_id: deviceId,
        version: '999.0.4',
        web_version: '2.5',
        dw: '604',
        app: 'heybox',
        // 签名三件套 — _time 用原始 timestamp (computeWebHkey 内部会自己 +1 算 hkey).
        _time: String(ts),
        nonce: webNonce,
        hkey: webHkey,
      });
    } else {
      // 字段顺序无所谓 (服务端按 key 取值), 按 业务 / 环境 / 签名 分组方便对照抓包.
      // 环境参数任何一项都不要省, 少了就有概率被风控判为非官方客户端打回.
      params = new URLSearchParams({
        ...business,
        heybox_id: heyboxIdForReq,
        imei: this.imei,
        device_info: 'Android',
        os_type: 'Android',
        x_os_type: 'Android',
        x_client_type: 'mobile',
        os_version: '9',
        version: XiaoheiheClient.APP_VERSION,
        build: XiaoheiheClient.APP_BUILD,
        dw: '411',
        channel: 'heybox_google',
        x_app: 'heybox',
        time_zone: 'Asia/Shanghai',
        netmode: 'wifi',
        _time: String(ts),
        nonce: appNonce,
        hkey: appHkey,
      });
    }
    // 仅在 'query' 模式下走老的 APP 风格 (pkey 进 query). 默认 'header' 模式
    // 不动 query, 留到 Cookie header 注入.
    // forceApp 模式下 effectiveJar 已为 null, 这里自然短路.
    if (injectMode === 'query' && effectiveJar && effectiveJar.pkey) {
      params.set('pkey', effectiveJar.pkey);
    }

    // 构造请求 headers.
    //   axios 实例的 default headers (User-Agent) 跟这里的 headers 会自动 merge,
    //   请求级 headers 覆盖实例级 — 所以 web 协议下设 UA 会覆盖默认的 okhttp.
    //
    // web 协议必须配套 "浏览器三件套":
    //   - Chrome User-Agent: 跟 UA sniffing 对齐 (服务端如果 UA=okhttp + os_type=web
    //     会立刻识别为非法组合)
    //   - Origin / Referer 指向 www.xiaoheihe.cn: web 端正常请求都带, 不带可能被
    //     当成爬虫
    const reqHeaders: Record<string, string> = {};
    if (useWebProtocol) {
      reqHeaders['User-Agent'] =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
      reqHeaders['Origin'] = 'https://www.xiaoheihe.cn';
      reqHeaders['Referer'] = 'https://www.xiaoheihe.cn/';
    }

    // ⚠️ 不能整串透传 raw cookie!
    //   实测用户从 www.xiaoheihe.cn 复制的 cookie 长度 1031 字符, 里面塞了
    //   _ga / _gid / Hm_lvt_* / sa_jssdk_* 等一大堆埋点/统计 cookie. 整串发出去
    //   后服务端可能:
    //     - 部分埋点 cookie 跟 APP 鉴权字段冲突 → 拒绝
    //   所以这里**只白名单提取鉴权相关字段**:
    //     - pkey: 主鉴权 token (账号维度)
    //     - heybox_id: 用户 id (账号维度)
    //     - user_pkey / user_heybox_id: pkey/heybox_id 的 httpOnly 副本, 值相同,
    //       带上不亏 (有些接口可能只认 httpOnly 版本)
    // forceApp 模式下 effectiveJar 已为 null, 这里自然短路 (APP 路径配 web cookie
    // 必挂, 详见上面"协议分支决策"段落).
    if (
      injectMode === 'header' &&
      effectiveJar &&
      (effectiveJar.pkey || effectiveJar.heyboxId)
    ) {
      // 从 rawCookie 里挑白名单字段, 没有就用 jar 上已解析好的值兜底.
      const allowList = ['pkey', 'heybox_id', 'user_pkey', 'user_heybox_id'];
      const picked: Record<string, string> = {};
      if (effectiveJar.rawCookie) {
        for (const seg of effectiveJar.rawCookie.split(/[;\n]+/)) {
          const s = seg.trim();
          if (!s) continue;
          const eq = s.indexOf('=');
          if (eq <= 0) continue;
          const k = s.slice(0, eq).trim();
          const v = s.slice(eq + 1).trim();
          if (allowList.includes(k) && v && !(k in picked)) {
            picked[k] = v;
          }
        }
      }
      // jar 已解析字段兜底 (rawCookie 里没显式 pkey=xxx 时, 比如纯 token 输入).
      if (!picked['pkey'] && effectiveJar.pkey) picked['pkey'] = effectiveJar.pkey;
      if (!picked['heybox_id'] && effectiveJar.heyboxId)
        picked['heybox_id'] = effectiveJar.heyboxId;

      const cookieStr = Object.keys(picked)
        .map((k) => `${k}=${picked[k]}`)
        .join('; ');
      if (cookieStr) {
        reqHeaders['Cookie'] = cookieStr;
      }
    }

    const fullUrl = `${apiPath}?${params.toString()}`;
    let data: T;
    try {
      const resp = await this.axios.get<T>(
        fullUrl,
        Object.keys(reqHeaders).length > 0 ? { headers: reqHeaders } : undefined,
      );
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`HTTP ${resp.status}`);
      }
      data = resp.data;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`请求失败: ${msg}`);
    }

    const okStatus =
      data?.status === undefined ||
      data?.status === 0 ||
      data?.status === 'ok';
    if (!okStatus) {
      // 业务错误诊断:
      //   小黑盒的非 ok 响应字段名不固定, 实测见过 msg / message / error / reason / info 等;
      //   有时甚至只给个 status 字符串 (e.g. status='failed') 别的全空. 这里把所有可能
      //   字段都扫一遍, 再把 status 值本身也带上, 用户看到的错误就能区分 "签名挂了" /
      //   "参数错了" / "被风控了" / "服务端 500" 等具体情况.
      //   完整 response 也打到 console.warn (Extension Host 开发人员工具可见), 后续
      //   排查接口字段变更不用再加日志.
      const anyData = data as Record<string, unknown> | null | undefined;
      const detailMsg =
        (typeof anyData?.msg === 'string' && anyData.msg) ||
        (typeof anyData?.message === 'string' && anyData.message) ||
        (typeof anyData?.error === 'string' && anyData.error) ||
        (typeof anyData?.reason === 'string' && anyData.reason) ||
        (typeof anyData?.info === 'string' && anyData.info) ||
        '';
      const statusStr =
        data?.status === undefined ? 'undefined' : JSON.stringify(data.status);
      // VSCode DevTools 把多参数对象折叠成 'Object', 用户复制日志时丢内容.
      // 这里 stringify 拍平, 超长截断防刷屏 (一般业务错误 response 也就几百字节).
      const safeStringify = (v: unknown, max = 2000): string => {
        try {
          const s = JSON.stringify(v);
          if (s == null) return String(v);
          return s.length > max ? s.slice(0, max) + '...(truncated)' : s;
        } catch {
          return String(v);
        }
      };
      const businessStr = safeStringify(business, 500);
      const responseStr = safeStringify(data, 2000);
      // 把"登录注入相关的关键诊断信息"也打出来 — 用户排查 "非法请求" /
      // "验证参数错误" 时一眼看到注入模式 / heybox_id / Cookie header 是否带,
      // 不用再翻源码确认配置生效.
      // v2.2.4 起 web hkey 走本地算法, 不再需要 webSig 注入相关诊断字段.
      // hkey 算法 bug 可以通过对照 utils/webSign.ts 文件头的"实测向量"小节
      // (浏览器抓包样本 7IVTZ50) 验证算法是否漂移.
      const injectDiag = JSON.stringify({
        protocol: useWebProtocol ? 'web' : 'app',
        forceApp,
        mode: injectMode,
        hasJar: !!jar,
        jarPkeyLen: jar?.pkey?.length ?? 0,
        jarHeyboxId: jar?.heyboxId || null,
        queryHeyboxId: heyboxIdForReq,
        queryHasPkey: params.has('pkey'),
        queryOsType: params.get('os_type'),
        queryXApp: params.get('x_app'),   
        // hkey 前 4 位 — web 协议时是本地算的 7 位 (utils/webSign.ts),
        // APP 协议时是 8 位 hex (utils/sign.ts). 用前缀区分两种格式调试.
        queryHkeyPrefix: params.get('hkey')?.slice(0, 4) || null,
        headerUA: reqHeaders['User-Agent']?.slice(0, 20) || '(default okhttp)',
        headerHasCookie: !!reqHeaders['Cookie'],
        cookieHeaderLen: reqHeaders['Cookie']?.length ?? 0,
        // 把发出去的 cookie 字段名列表打出来 (不打 value 防 token 泄露).
        // 帮排查 "白名单过滤后到底剩哪些字段".
        cookieKeys: reqHeaders['Cookie']
          ? reqHeaders['Cookie'].split(';').map((s) => s.split('=')[0].trim())
          : [],
        imeiTail: this.imei.slice(-6),
      });
      // eslint-disable-next-line no-console
      console.warn(
        `[xiaoheihe] signedGet 业务错误 path=${apiPath} inject=${injectDiag} business=${businessStr} response=${responseStr}`,
      );
      // 把完整的请求 URL 也打一行 — 便于用户直接复制成 cURL 复现 / 对比抓包.
      //   ⚠️ URL 里的 hkey/nonce/_time 是签名敏感数据 (短时间内可重放),
      //   但 cookie 不在 URL 里, 所以不会泄漏账号 token.
      // eslint-disable-next-line no-console
      console.warn(
        `[xiaoheihe] signedGet 业务错误 fullUrl=https://api.xiaoheihe.cn${fullUrl}`,
      );
      // 已知 status 值的友好提示:
      //   - show_captcha: 服务端要求过验证码 (人机挑战). 我们没有 webview captcha
      //     方案, 只能告诉用户"重置设备" (resetImei) 或等服务端冷却.
      //     这种错误大多发生在 link/tree 等交互类接口, 一旦 IMEI 被打标记,
      //     一段时间内反复请求都会返回 show_captcha — 重置 IMEI 是最快恢复路径.
      if (data?.status === 'show_captcha') {
        throw new Error(
          '小黑盒触发验证码挑战 (IMEI 已被服务端标记). 请执行命令 "小黑盒: 重置设备 ID" 后重试, 或等待 10-30 分钟再试.',
        );
      }
      // web 协议 + "非法请求" — v2.2.4 起本地算 hkey, 仍然报"非法请求" 99% 是
      // cookie 失效 (pkey 过期) 或服务端校验规则升级. 给精准的引导文案.
      if (
        useWebProtocol &&
        (detailMsg === '非法请求' || data?.status === 'failed')
      ) {
        throw new Error(
          '小黑盒: 登录态请求被拒. 大概率是 cookie 已失效, 请重新执行 "小黑盒: 导入 Cookie" 粘贴最新 cookie. 若反复失败可能是 hkey 校验规则升级 (见 utils/webSign.ts), 请提 issue.',
        );
      }
      // 其它非 ok 状态: 抛给前端的 message 带 response 摘要 (限短, 别撑爆气泡),
      // 用户截图气泡就能直接看到关键字段, 不用再开 DevTools.
      const tail = detailMsg ? ` ${detailMsg}` : '';
      const respSummary = safeStringify(data, 300);
      throw new Error(
        `小黑盒接口错误: status=${statusStr}${tail} (response=${respSummary})`,
      );
    }
    return data;
  }
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

/**
 * 简单 HTML 剥离, 保留段落 / 换行后压成单段文本. 所有 <img> 标签一并丢失.
 *
 * 用于卡片摘要 (excerpt) 这类不需要在卡片上显示图的场景. 详情正文要保图,
 * 改走 stripHtmlPreserveImages.
 */
function stripHtml(html: string): string {
  if (!html) return '';
  return decodeBasicEntities(
    html
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\s*\/\s*p\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    // 多余空白行 / 行末空格收敛
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * HTML 剥离, 但把 <img src="..."> 标签转成 [IMG:url] 占位符保留. 其它标签全部剥除.
 *
 * 输出:
 *   - text: 含 [IMG:url] 占位符的纯文本 (其它换行 / 段落仍按 stripHtml 规则)
 *   - urls: 按出现顺序提取到的所有图 URL (去重 — 同一张图在 HTML 里重复出现的情况)
 *
 * 设计:
 *   1) 必须在 stripTags 之前先扫一遍 <img>, 否则 src 被一起干掉就抓不到了.
 *   2) src 候选: src / data-original / data-src — 小黑盒抓包只见过 src, 但顺手兼容
 *      常见富文本编辑器的延迟加载属性, 不增加误抓风险.
 *   3) 只接受 http(s) URL, 防御性过滤 javascript: / data: 之类 (虽然小黑盒服务端
 *      应该不会给, 但 CSP 之外多一道防线无害).
 *   4) [IMG:url] 占位符跟知乎模块对齐, 让 webview 端复用一套渲染逻辑思路;
 *      实际 URL 里如果含 ] 字符会被 url-encode 为 %5D, 避免提取时贪婪匹配错位.
 */
function stripHtmlPreserveImages(html: string): { text: string; urls: string[] } {
  if (!html) return { text: '', urls: [] };
  const urls: string[] = [];
  const seen = new Set<string>();
  // 替换 <img>: 用启发式优先级 data-original > data-src > src.
  // <img> 标签里只取第一个命中的; 同一张图不重复加入 urls 列表 (按 [IMG:url] 也会重复占位 —
  // 但前端按出现顺序渲染, 重复也无所谓, 主要 urls 列表给上层 seen 去重用).
  const withPlaceholders = html.replace(
    /<img\b[^>]*?>/gi,
    (tag: string): string => {
      const grab = (re: RegExp): string => {
        const m = tag.match(re);
        return m ? m[1].trim() : '';
      };
      const rawSrc =
        grab(/\bdata-original=["']([^"']+)["']/i) ||
        grab(/\bdata-src=["']([^"']+)["']/i) ||
        grab(/\bsrc=["']([^"']+)["']/i);
      if (!rawSrc) return '';
      // 兼容协议相对 URL "//cdn.x.com/a.jpg" -> 自动补 https:
      // (富文本编辑器常见输出, 小黑盒服务端也用过. v2.2.4 加防御.)
      const src = rawSrc.startsWith('//') ? `https:${rawSrc}` : rawSrc;
      if (!/^https?:\/\//i.test(src)) return '';
      if (!seen.has(src)) {
        seen.add(src);
        urls.push(src);
      }
      return imgPlaceholder(src);
    },
  );

  const text = decodeBasicEntities(
    withPlaceholders
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\s*\/\s*p\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return { text, urls };
}

/** 生成 [IMG:url] 占位符. 只接受 http(s), 防御性过滤危险协议. */
function imgPlaceholder(src: string): string {
  const s = (src ?? '').trim();
  if (!s || !/^https?:\/\//i.test(s)) return '';
  // ] 转义防止前端解析占位符时贪婪匹配 (URL 里基本不出现, 仅作兜底)
  return `[IMG:${s.replace(/\]/g, '%5D')}]`;
}

/**
 * 解析小黑盒 link.text 字段 (v2.2.5).
 *
 * 服务端格式 (从实测 1853 字的帖子样本推断, 服务端没公开 schema):
 *   text 字段是 JSON 字符串, 解析后是数组, 每项是一个"内容块":
 *     [
 *       {"text": "段落文本"},                               // 文本块
 *       {"type": "img", "url": "https://..."},               // 图片块
 *       {"type": "image", "src": "https://...", ...},        // 图片块 (别名)
 *       "纯字符串段落",                                       // 极少见, 防御性兼容
 *       ...
 *     ]
 *   服务端可能加新类型 (video / link / quote ...), 这里**未知类型一律跳过**, 不
 *   假装能渲染 — 比强行展示乱码好.
 *
 * 输出:
 *   - 解析成功 → { text: 拼接好的正文 (含 [IMG:url] 占位), urls: 图片 URL 列表 (去重) }
 *   - 不是 JSON / 不是数组 / 数组为空 → null (调用方 fallback 到 description 路径)
 *
 * 设计:
 *   - 每个文本块再走一遍 stripHtmlPreserveImages, 兼容 "JSON 块内嵌 HTML 富文本" 的
 *     混合格式 (实测不一定有, 但便宜的防御).
 *   - 段落之间用 "\n\n" 分隔 (跟 stripHtml 的 <p>\n 收敛规则一致, 前端 white-space:
 *     pre-wrap 渲染正常).
 *   - 图片块字段名兼容 url / src / img_url / image (按优先级取第一个有效的).
 */
function parseRichText(raw: string): { text: string; urls: string[] } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;

  const parts: string[] = [];
  const urls: string[] = [];
  const seen = new Set<string>();

  /** 把 src 规范化 (协议相对 URL 补 https:), 校验合法 -> push url + 返回 [IMG:url] 占位. */
  const pushImg = (rawSrc: unknown): string => {
    if (typeof rawSrc !== 'string') return '';
    const s = rawSrc.trim();
    if (!s) return '';
    const norm = s.startsWith('//') ? `https:${s}` : s;
    if (!/^https?:\/\//i.test(norm)) return '';
    if (!seen.has(norm)) {
      seen.add(norm);
      urls.push(norm);
    }
    return imgPlaceholder(norm);
  };

  for (const node of parsed) {
    // 字符串节点 -> 直接当文本 (实测没见过, 防御性兼容)
    if (typeof node === 'string') {
      const s = node.trim();
      if (s) parts.push(s);
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    const obj = node as Record<string, unknown>;
    const type =
      typeof obj.type === 'string' ? obj.type.toLowerCase() : '';

    // 图片块: type 明确是 img/image/pic 等
    if (type === 'img' || type === 'image' || type === 'pic' || type === 'picture') {
      const placeholder =
        pushImg(obj.url) || pushImg(obj.src) || pushImg(obj.img_url) || pushImg(obj.image);
      if (placeholder) parts.push(placeholder);
      continue;
    }

    // 文本块: text 字段 (服务端常见结构, 上面诊断里第一块就是 {"text": "..."}).
    // 文本里可能内嵌 HTML 标签 (<br>/<img>), 跑一遍 stripHtmlPreserveImages 同时
    // 提取里面的图 URL 跟去重列表合并.
    if (typeof obj.text === 'string') {
      const { text, urls: inner } = stripHtmlPreserveImages(obj.text);
      if (text) parts.push(text);
      for (const u of inner) {
        if (!seen.has(u)) {
          seen.add(u);
          urls.push(u);
        }
      }
      continue;
    }

    // 未知类型节点 — 跳过. 不打日志 (一篇长帖可能十几块, 刷屏).
  }

  if (parts.length === 0) return null;
  const text = parts
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, urls };
}

/** 解码最常见 6 个 HTML 实体, 不上 he 这种库. */
function decodeBasicEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * 取封面图. 不强校验 http(s) — 服务端给的就是绝对 URL, 直接用.
 * 极少数情况下 imgs / thumbs 里可能是空字符串, 顺手 filter.
 */
function pickCover(raw: XiaoheiheRawLink): string {
  if (Array.isArray(raw.imgs)) {
    const first = raw.imgs.find((u) => typeof u === 'string' && u.length > 0);
    if (first) return first;
  }
  if (Array.isArray(raw.thumbs)) {
    const first = raw.thumbs.find((u) => typeof u === 'string' && u.length > 0);
    if (first) return first;
  }
  return '';
}

/**
 * 收集"正文配图"用于 detail 展开. 小黑盒 /bbs/app/link/tree 接口在 link 字段里
 * 经常不返回 imgs (那是 feeds/news 列表接口才稳定给的), 这里全面兜底:
 *   imgs[] -> thumbs[] -> []
 * 过滤掉空串. 全部图都展示, 上限交给前端 CSS (max-height + 滚动) 来控制.
 */
function collectContentImgs(raw: XiaoheiheRawLink): string[] {
  const cand: string[] = [];
  if (Array.isArray(raw.imgs)) {
    for (const u of raw.imgs) if (typeof u === 'string' && u) cand.push(u);
  }
  if (cand.length === 0 && Array.isArray(raw.thumbs)) {
    for (const u of raw.thumbs) if (typeof u === 'string' && u) cand.push(u);
  }
  return cand;
}

/**
 * 格式化发布时间. 服务端给秒级 timestamp, 我们走"相对时间 + 绝对时间"混合策略:
 *   - < 1 小时: "几分钟前"
 *   - < 24 小时: "几小时前"
 *   - < 7 天:   "几天前"
 *   - 否则:      "yyyy-MM-dd"
 *
 * 没有 timestamp 时返回空串, 前端按需隐藏.
 */
function formatTime(sec?: number): string {
  if (typeof sec !== 'number' || sec <= 0) return '';
  const now = Math.floor(Date.now() / 1000);
  const diff = now - sec;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
  const d = new Date(sec * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}