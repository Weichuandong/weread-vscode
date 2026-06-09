import axios, { AxiosError, AxiosInstance } from 'axios';
import * as vscode from 'vscode';
import type { ZhihuAuthService } from '../auth/AuthService';
import type {
  ZhihuCardForView,
  ZhihuCommentForView,
  ZhihuCommentsPage,
  ZhihuFeedItem,
  ZhihuQuestionAnswersPage,
  ZhihuRecommendResponse,
  ZhihuTarget,
} from '../types';

/**
 * 知乎推荐流客户端。
 *
 * 这块是这次知乎模块的灵魂 — touchFish 知乎模块"内容反复重复"的根因有三:
 *   1. 没维护 session_token → 每次拉取都告诉服务端 "我是新会话", 服务端必然返回相同的高热内容
 *   2. 没上报 feedback/read → 即使有 session_token, 服务端也不知道你看过什么
 *   3. 前端追加列表时没去重 → 即使前两个 fix 都不做, 至少能避免同一会话内同 id 多次入列
 *
 * 我们三层都做了:
 *
 *   - this.sessionToken / this.pageNumber / this.endOffset 维护会话状态,
 *     每次请求带上, 服务端能识别这是同一个连续会话
 *   - reportRead() 把"刚返回给前端展示"的 item 用 feedback/read 接口告诉服务端,
 *     下次推荐流会避开这些条目 (除非 config 关闭 zhihu.reportRead)
 *   - this.seenFeedIds 一个 Set 在内存里去重, 哪怕服务端发了重复也不会入列
 *
 * 关于知乎的反爬:
 *   /api/v3/feed/topstory/recommend 这个 web 接口对登录用户 (有 z_c0 cookie) 比较宽松,
 *   一般不需要 x-zse-95/96 签名。如果哪天用户反馈 403, 排查路径:
 *     - 先确认 cookie 没过期 (浏览器开 zhihu.com 还在登录态吗?)
 *     - 再看返回 body 里的 error.code, 如果是 'AuthenticationInvalidCSRFToken' 之类,
 *       说明知乎改成强签名校验了, 那时再考虑加 x-zse-* 实现 (参考社区 zhihu-on-vscode)
 */
export class ZhihuClient {
  private readonly axios: AxiosInstance;

  /**
   * session_token: 知乎用这个 token 串起"同一个用户的连续浏览会话",
   * 服务端基于它做"已展示过的不再下发"。
   *
   * 首次请求时为 undefined (省略该参数), 服务端会下发一个新的;
   * 后续每次请求都带上, 直到用户主动 refresh / 退登 / 重启插件。
   *
   * 这个值的来源是响应 paging.next URL 的 query string (而不是某个独立字段),
   * 见 extractPagingFromNextUrl() 注释。
   */
  private sessionToken: string | undefined;
  /** page_number: 1 起步, 每拉一次自增 1, 配合 session_token 给服务端 */
  private pageNumber = 1;
  /** end_offset: 已经下发了多少条, 给服务端做"翻页"用 */
  private endOffset = 0;

  /**
   * 已经见过的 feed id, 用于本地二次去重。
   *
   * 为什么用 Set 而不是直接信 paging.is_end?
   * — 即使带了 session_token, 知乎服务端偶尔也会下发重复 id (尤其是热门内容),
   *   有了这层兜底, 用户视觉上是 100% 不重复的。
   *
   * Set 不会无限增长, 每次 resetSession() 都会清空; 一个会话内即使刷 1000 条
   * 也才 ~50KB 内存, 不需要 LRU。
   */
  private readonly seenFeedIds = new Set<string>();

  /** 上次"用过期通知去骚扰用户"的时刻, 防止网络抖动导致弹一堆 */
  private lastExpiredNotifyAt = 0;

  constructor(private readonly auth: ZhihuAuthService) {
    const timeout = vscode.workspace
      .getConfiguration('zhihu')
      .get<number>('requestTimeout', 15000);

    this.axios = axios.create({
      baseURL: 'https://www.zhihu.com',
      timeout,
      // 跟随重定向 (知乎部分接口会 302 到带 trace 参数的 url)
      maxRedirects: 3,
      // 任何 2xx 都算成功, 其它统一抛出, 由 handleError 处理
      validateStatus: (s) => s >= 200 && s < 300,
    });

    // request 拦截器: 每次请求自动拼 cookie + UA + 标准 web 头
    this.axios.interceptors.request.use((config) => {
      const ua = vscode.workspace
        .getConfiguration('zhihu')
        .get<string>('userAgent') as string;
      config.headers = config.headers ?? {};
      config.headers['Cookie'] = this.auth.getCookieHeader();
      config.headers['User-Agent'] = ua;
      config.headers['Referer'] = 'https://www.zhihu.com/';
      config.headers['Origin'] = 'https://www.zhihu.com';
      config.headers['Accept'] = 'application/json, text/plain, */*';
      // 知乎部分接口会校验这个头, 加上无害
      config.headers['x-requested-with'] = 'fetch';
      return config;
    });
  }

  // ---------- 推荐流 ----------

  /**
   * 拉一页推荐流并归一化成给前端的 card 数组。
   *
   * @param refresh true 表示用户点了刷新, 清掉所有会话状态从头开始
   * @returns 已去重的 card 列表 (返回空数组表示这一页全是重复, 但不代表流到底)
   */
  public async fetchRecommend(refresh: boolean): Promise<{
    cards: ZhihuCardForView[];
    /** 原始 items, 给外层去调 feedback/read 用 */
    rawItems: ZhihuFeedItem[];
    isEnd: boolean;
  }> {
    if (refresh) {
      this.resetSession();
    }

    const pageSize = vscode.workspace
      .getConfiguration('zhihu')
      .get<number>('pageSize', 6);

    // 构造请求 query。
    // 这里参数名严格对齐浏览器实际请求 (抓包验证), 漏一个或多一个都可能被风控。
    const params: Record<string, string | number> = {
      action: 'down', // down = 下拉加载更多, pull = 顶部下拉刷新
      desktop: 'true',
      end_offset: this.endOffset,
      page_number: this.pageNumber,
      // 注意: 知乎抓包里没有显式的 page_size 字段, 真要传也不一定生效,
      // 但留着不会被拒, 当个"调参建议"
      ...(pageSize && pageSize !== 6 ? { limit: pageSize } : {}),
    };
    if (this.sessionToken) {
      params['session_token'] = this.sessionToken;
    }

    let resp: ZhihuRecommendResponse;
    try {
      const r = await this.axios.get<ZhihuRecommendResponse>(
        '/api/v3/feed/topstory/recommend',
        { params },
      );
      resp = r.data;
    } catch (e) {
      this.handleError(e, 'recommend');
      throw e;
    }

    const items = Array.isArray(resp.data) ? resp.data : [];

    // 1. 服务端会话状态推进
    this.applyPagingState(resp, items.length);

    // 2. 前端去重: 同 id 一律丢弃
    const fresh: ZhihuFeedItem[] = [];
    for (const item of items) {
      const fid = this.feedIdOf(item);
      if (!fid) {
        // 没有 id 的兜底进列表 — 但其实推荐流每条都有 id, 几乎走不到
        fresh.push(item);
        continue;
      }
      if (this.seenFeedIds.has(fid)) {
        continue;
      }
      this.seenFeedIds.add(fid);
      fresh.push(item);
    }

    // 3. 归一化成 card
    const cards = fresh
      .map((it) => this.toCard(it))
      .filter((c): c is ZhihuCardForView => c !== null);

    console.log(
      `[zhihu] recommend page=${this.pageNumber - 1} 服务端 ${items.length} 条 -> 去重后 ${fresh.length} 条 -> 可渲染 ${cards.length} 条; session=${this.sessionToken ? this.sessionToken.slice(0, 8) + '...' : '(none)'}`,
    );

    return {
      cards,
      rawItems: fresh,
      isEnd: Boolean(resp.paging?.is_end),
    };
  }

  /**
   * 上报"用户已看到这些 item"给知乎服务端, 用于服务端去重。
   *
   * 实现态度: 这个接口是知乎私有的, 字段名 / body 形态历史上变过几次,
   * 我们抓现在能跑的格式打过去, 失败静默吞掉 — 它失败只会让推荐质量回退到"没上报"的程度,
   * 不应该影响主流程。配置 zhihu.reportRead = false 可以全局关闭。
   *
   * @param items fetchRecommend 返回的 rawItems
   */
  public async reportRead(items: ZhihuFeedItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const enabled = vscode.workspace
      .getConfiguration('zhihu')
      .get<boolean>('reportRead', true);
    if (!enabled) {
      return;
    }

    // 提取每条的 token (attached_info 或 attached_info_bytes), 没有就跳过
    const readDataList = items
      .map((it) => {
        const token = it.attached_info ?? it.attached_info_bytes;
        if (!token) {
          return null;
        }
        return { attached_info: token };
      })
      .filter((x): x is { attached_info: string } => x !== null);

    if (readDataList.length === 0) {
      return;
    }

    try {
      await this.axios.post(
        '/api/v3/feed/topstory/feedback/read',
        { read_data_list: readDataList },
        { headers: { 'Content-Type': 'application/json' } },
      );
      console.log(`[zhihu] feedback/read 上报 ${readDataList.length} 条 ✓`);
    } catch (e) {
      // 静默: 这个接口失败不影响功能, 只影响后续推荐质量
      const status = (e as AxiosError)?.response?.status;
      console.warn(`[zhihu] feedback/read 上报失败 (status=${status}), 忽略`);
    }
  }

  // ---------- 工具 ----------

  /**
   * 拿当前用户信息 — 用来在登录后验证一下 cookie 是不是真的有效。
   * 失败时抛错, 调用方负责给用户提示。
   */
  public async getCurrentUser(): Promise<{ name?: string; url_token?: string }> {
    try {
      const r = await this.axios.get('/api/v4/me');
      return r.data ?? {};
    } catch (e) {
      this.handleError(e, 'me');
      throw e;
    }
  }

  /** 用户主动刷新 / 切回视图时调用, 清掉会话状态从头开始 */
  public resetSession(): void {
    this.sessionToken = undefined;
    this.pageNumber = 1;
    this.endOffset = 0;
    this.seenFeedIds.clear();
    console.log('[zhihu] session 已重置');
  }

  // ---------- 内部 ----------

  /**
   * 从响应推进会话状态。
   *
   * 关键: session_token 不是响应里的某个独立字段, 而是埋在 paging.next 这个 URL 里的
   * query string 参数。例子:
   *   paging.next = "https://www.zhihu.com/api/v3/feed/topstory/recommend?
   *     action=down&desktop=true&end_offset=12&page_number=2&session_token=ABCDEF123..."
   *
   * 解析失败 (paging 缺失 / next 不带 session_token) 也不致命:
   *   - sessionToken 维持原值 (首次会维持 undefined → 还是匿名会话)
   *   - page_number / end_offset 走本地累加
   * 这样即使知乎临时改了 paging 格式, 我们的去重依然走本地 Set, 不会全军覆没。
   */
  private applyPagingState(resp: ZhihuRecommendResponse, itemsCount: number): void {
    const parsed = this.extractPagingFromNextUrl(resp.paging?.next);
    if (parsed.sessionToken) {
      this.sessionToken = parsed.sessionToken;
    }
    if (typeof parsed.pageNumber === 'number') {
      this.pageNumber = parsed.pageNumber;
    } else {
      this.pageNumber += 1;
    }
    if (typeof parsed.endOffset === 'number') {
      this.endOffset = parsed.endOffset;
    } else {
      this.endOffset += itemsCount;
    }
  }

  private extractPagingFromNextUrl(next: string | undefined): {
    sessionToken?: string;
    pageNumber?: number;
    endOffset?: number;
  } {
    if (!next) {
      return {};
    }
    try {
      // next 可能是相对路径也可能是绝对 url, URL 构造器需要 base
      const u = new URL(next, 'https://www.zhihu.com');
      const sessionToken = u.searchParams.get('session_token') ?? undefined;
      const pageNumber = Number(u.searchParams.get('page_number'));
      const endOffset = Number(u.searchParams.get('end_offset'));
      return {
        sessionToken,
        pageNumber: Number.isFinite(pageNumber) ? pageNumber : undefined,
        endOffset: Number.isFinite(endOffset) ? endOffset : undefined,
      };
    } catch {
      return {};
    }
  }

  /** 取 feed id, 找不到就回退到 target.id, 实在没有返回空串 */
  private feedIdOf(item: ZhihuFeedItem): string {
    if (item.id) {
      return String(item.id);
    }
    if (item.target?.id) {
      return `${item.target.type}:${item.target.id}`;
    }
    return '';
  }

  /**
   * 把推荐流原始 item 归一化为 card。
   *
   * 知乎的 target 是多态对象, 这里按 type 分发取字段:
   *   - answer:  title 取自 question.title (回答本身没标题, 用问题标题)
   *              excerpt 是 HTML, 需要剥标签
   *              url 是 /question/{qid}/answer/{aid}
   *   - article: title 是文章标题
   *              url 是 /p/{id}
   *   - zvideo:  title 是视频标题, excerpt 用 description
   *              url 是 /zvideo/{id}
   *   - pin:     想法, 没标题, 拿 excerpt 当 title 第一行
   *              url 是 /pin/{id}
   *
   * 返回 null 表示是不认识的 type (比如广告、活动卡), 上层会过滤掉
   */
  private toCard(item: ZhihuFeedItem): ZhihuCardForView | null {
    const t = item.target;
    if (!t || !t.type) {
      return null;
    }
    const feedId = this.feedIdOf(item);
    const author = t.author ?? {};
    const voteCount = typeof t.voteup_count === 'number' ? t.voteup_count : 0;

    let kind: ZhihuCardForView['kind'];
    let title: string;
    let excerpt: string;
    let url: string;

    switch (t.type) {
      case 'answer':
        kind = '回答';
        title = t.question?.title ?? '(无标题)';
        excerpt = stripHtml(t.excerpt ?? '');
        url =
          t.url ??
          `https://www.zhihu.com/question/${t.question?.id ?? ''}/answer/${t.id}`;
        break;
      case 'article':
        kind = '文章';
        title = t.title ?? '(无标题)';
        excerpt = stripHtml(t.excerpt ?? '');
        url = t.url ?? `https://zhuanlan.zhihu.com/p/${t.id}`;
        break;
      case 'zvideo':
        kind = '视频';
        title = t.title ?? '(无标题)';
        excerpt = stripHtml(t.description ?? '');
        url = t.url ?? `https://www.zhihu.com/zvideo/${t.id}`;
        break;
      case 'pin':
        kind = '想法';
        excerpt = stripHtml(t.excerpt ?? t.description ?? '');
        // 想法没有 title, 拿前 60 字当 title
        title = excerpt.slice(0, 60) || '(想法)';
        url = t.url ?? `https://www.zhihu.com/pin/${t.id}`;
        break;
      default:
        // 不认识的 type — 例如 'roundtable' / 'special' / 广告, 不展示
        return null;
    }

    // url 偶尔是 api 形式, 转成 web 形式 (替换 api/v4/answers/{id} → /answer/{id})
    url = normalizeWebUrl(url);

    return {
      feedId,
      url,
      kind,
      title,
      excerpt,
      authorName: author.name ?? '匿名用户',
      authorAvatar: author.avatar_url ?? '',
      voteCount,
      targetId: t.id != null ? String(t.id) : '',
      // 仅 answer 卡片带, 用于跳"问题详情页"看其他回答; 其它 kind 字段不存在自然 undefined
      questionId:
        t.type === 'answer' && t.question?.id != null
          ? String(t.question.id)
          : undefined,
    };
  }

  // ---------- 内容详情 ----------

  /**
   * 按 kind + targetId 拉一条内容的正文 (纯文本, 保留段落换行)。
   *
   * 为什么不在前端用 webview 直接 iframe 知乎页面?
   *   - 知乎页面 CSP / X-Frame-Options 直接禁了 iframe
   *   - 即使能嵌, 还要带 cookie 才看得到完整内容, 跨域 cookie 不可控
   *   - 用户痛点是"看完决定要不要点开浏览器", 纯文本预览正中靶心, 也最省流量
   *
   * 各 kind 对应的接口 (web 接口, z_c0 cookie 鉴权):
   *   - answer:  /api/v4/answers/{id}?include=content
   *   - article: /api/v4/articles/{id}?include=content
   *   - pin:     /api/v4/pins/{id}  (返回 content: [{type:'text'|'image'|'video', ...}])
   *   - zvideo:  接口返回视频元信息, 真要看必须播放器, webview 内做不了, 直接给提示
   *
   * 失败统一抛错, 由 view 层友好展示 (顶部红条 + 重试按钮)。
   */
  public async fetchContent(
    kind: ZhihuCardForView['kind'],
    targetId: string,
  ): Promise<string> {
    if (!targetId) {
      throw new Error('缺少内容 id, 无法加载正文');
    }

    try {
      if (kind === '回答') {
        const r = await this.axios.get<{ content?: string }>(
          `/api/v4/answers/${encodeURIComponent(targetId)}`,
          { params: { include: 'content' } },
        );
        return stripHtmlPreserveBreaks(r.data?.content ?? '') || '(此回答暂无正文)';
      }
      if (kind === '文章') {
        const r = await this.axios.get<{ content?: string }>(
          `/api/v4/articles/${encodeURIComponent(targetId)}`,
          { params: { include: 'content' } },
        );
        return stripHtmlPreserveBreaks(r.data?.content ?? '') || '(此文章暂无正文)';
      }
      if (kind === '想法') {
        const r = await this.axios.get<{
          content?: Array<{ type?: string; content?: string; url?: string }>;
          excerpt_title?: string;
        }>(`/api/v4/pins/${encodeURIComponent(targetId)}`);
        const blocks = Array.isArray(r.data?.content) ? r.data!.content! : [];
        const parts: string[] = [];
        if (r.data?.excerpt_title) {
          parts.push(r.data.excerpt_title);
        }
        for (const b of blocks) {
          if (!b || !b.type) continue;
          if (b.type === 'text') {
            const t = stripHtmlPreserveBreaks(b.content ?? '');
            if (t) parts.push(t);
          } else if (b.type === 'image') {
            // webview 当前不内嵌图片, 用 [图片] 占位提示读者此处原本有图;
            // 与正文里 stripHtmlPreserveBreaks 对 <img> 的处理保持一致.
            parts.push('[图片]');
          } else if (b.type === 'video') {
            parts.push('[视频]');
          } else if (b.type === 'link') {
            parts.push(`[链接] ${b.url ?? ''}`.trim());
          }
        }
        return parts.join('\n\n').trim() || '(此想法暂无正文)';
      }
      if (kind === '视频') {
        // 不再引导跳浏览器 (UI 上已无"在浏览器打开"按钮, 跳出去会暴露摸鱼). 评论区仍能看,
        // 用户想知道"这视频在讲啥"看下评论即可。
        return '[视频内容]\n\nVSCode 侧栏暂不支持播放视频, 可以展开评论看看大家怎么说。';
      }
      return '(暂不支持该类型内容的内嵌阅读)';
    } catch (e) {
      this.handleError(e, `content/${kind}`);
      throw e;
    }
  }

  // ---------- 问题详情 (某问题下的所有回答) ----------

  /**
   * 问题详情 — 答案分页大小. 与评论同口径 10/页:
   *   - 答案展开是延迟操作 (列表只显示标题+作者+赞数), 一页 10 条铺起来不算重;
   *   - 用户在侧栏滚到底自动续拉, 体感上跟知乎 web 端无差异;
   *   - server 对 limit 上限有截断 (20), 这里取 10 平衡 "一次给得够" 和 "拉得快".
   */
  private static readonly QUESTION_ANSWERS_PAGE_SIZE = 10;

  /**
   * 拉取某个问题下的回答列表 (即"问题详情页"下方那一坨答案).
   *
   * 接口: GET /api/v4/questions/{id}/answers
   *   - include: 控制返回字段; 缺省时不带 content/excerpt, 我们必须显式带上 data[*].excerpt
   *     (用于卡片摘要), 顺便带 voteup_count / author / is_normal 等常用字段;
   *     如果只是看"还有哪些回答", 不带 content 能省一大半流量 — 详情留给 fetchContent 拉.
   *   - limit/offset: 标准分页;
   *   - sort_by: 'default' (综合, 知乎默认按热度) / 'updated' / 'created' — 我们用默认综合,
   *     未来想加排序切换再开放参数.
   *
   * 字段归一化:
   *   接口返回的 data[i] 直接就是 ZhihuTarget 形态的 answer (没有 feed 外层包装),
   *   我们手工包一层 ZhihuFeedItem 然后复用 toCard() — 一致性最好, 维护成本最低.
   *
   * questionTitle: 接口返回的每个 answer 里都有 question.title, 全相同, 取第一条即可;
   * 如果一条都没回 (offset 越界 / 问题已删), title 返回空, 前端 fallback 用入口标题.
   */
  public async fetchQuestionAnswers(
    questionId: string,
    offset: number = 0,
  ): Promise<ZhihuQuestionAnswersPage> {
    if (!questionId) {
      throw new Error('缺少问题 id, 无法加载回答列表');
    }
    try {
      const r = await this.axios.get<ZhihuQuestionAnswersResponse>(
        `/api/v4/questions/${encodeURIComponent(questionId)}/answers`,
        {
          params: {
            // 与浏览器 web 端实际请求保持一致 (字段名严格, 多一个少一个无碍但少不得 excerpt)
            include:
              'data[*].is_normal,voteup_count,comment_count,excerpt,author,content,question',
            limit: ZhihuClient.QUESTION_ANSWERS_PAGE_SIZE,
            offset,
            sort_by: 'default',
            platform: 'desktop',
          },
        },
      );
      const body = r.data ?? {};
      const items = Array.isArray(body.data) ? body.data : [];

      // 把裸 answer 包成 ZhihuFeedItem, 复用 toCard 归一化
      const cards: ZhihuCardForView[] = [];
      for (const a of items) {
        if (!a || a.type !== 'answer') continue;
        const wrapped: ZhihuFeedItem = {
          type: 'feed',
          id: a.id != null ? `answer-${a.id}` : undefined,
          target: a,
        };
        const c = this.toCard(wrapped);
        if (c) cards.push(c);
      }

      const totals =
        typeof body.paging?.totals === 'number' ? body.paging.totals : -1;

      // 问题标题: 任意一条 answer 的 question.title 都行, 全相同
      const questionTitle = items.find((a) => a?.question?.title)?.question
        ?.title;

      return {
        cards,
        totals,
        isEnd: Boolean(body.paging?.is_end),
        questionTitle,
      };
    } catch (e) {
      this.handleError(e, `question_answers/${questionId}`);
      throw e;
    }
  }

  // ---------- 评论 ----------

  /**
   * 评论分页大小。
   *
   * 之前 fetchComments 写死 20, 一次铺满半屏太重 — 摸鱼场景下"快速扫两条" 比"一次看 20 条"更
   * 符合实际体验, 而且服务端给 root_comments / child_comments 的 limit 都是 5/10/20 都接受,
   * 这里都用 10 (与浏览器 m.zhihu.com 移动端默认一致)。
   *
   * 注意 zhihu 服务端会对 limit 截断 — 超过 20 一般会被它压回 20, 这里没必要做客户端校验。
   */
  private static readonly COMMENTS_PAGE_SIZE = 10;

  /**
   * 拉取一页根评论 (top-level comments)。
   *
   * 接口路径 (经典 root_comments, 比 v5 更稳定; v5 需要带 x-zse-* 签名才稳):
   *   - 回答:  /api/v4/answers/{id}/root_comments
   *   - 文章:  /api/v4/articles/{id}/root_comments
   *   - 想法:  /api/v4/pins/{id}/comments
   *   - 视频:  /api/v4/zvideos/{id}/root_comments
   *
   * 分页: 用 offset + limit (COMMENTS_PAGE_SIZE), 服务端会回 paging.is_end。
   *
   * 子评论由 fetchChildComments 提供, 前端按需点开 "查看 N 条回复" 才拉, 不会一次给所有。
   *
   * 失败: 走 handleError, 401/403 触发 notifyExpired; 其它错误抛给上层。
   */
  public async fetchComments(
    kind: ZhihuCardForView['kind'],
    targetId: string,
    offset: number = 0,
  ): Promise<ZhihuCommentsPage> {
    if (!targetId) {
      throw new Error('缺少内容 id, 无法加载评论');
    }
    const path = this.commentApiPath(kind, targetId);
    if (!path) {
      // 不认识的 kind ('其他' 或新类型) — 给个空页, 前端会显示"暂无评论"
      return { comments: [], totals: 0, isEnd: true };
    }

    try {
      const r = await this.axios.get<ZhihuRootCommentsResponse>(path, {
        params: {
          order: 'normal',
          limit: ZhihuClient.COMMENTS_PAGE_SIZE,
          offset,
          // status / 角色字段省略 — 默认全部评论
        },
      });
      return this.normalizeCommentsResponse(r.data);
    } catch (e) {
      this.handleError(e, `comments/${kind}`);
      throw e;
    }
  }

  /**
   * 拉取某条根评论的子评论 (replies) 一页。
   *
   * 接口: /api/v4/comments/{rootCommentId}/child_comments?limit=10&offset=N
   *
   * 该接口对所有内容类型 (回答/文章/想法/视频) 都通用 — 因为评论 id 在知乎是全局唯一,
   * 不需要再带 kind 路由。响应字段结构跟 root_comments 一致 (data 数组 + paging),
   * 直接复用 normalizeCommentsResponse 归一化。
   *
   * 关于 reply_to_author:
   *   子评论的 `reply_to_author` 一般是真正被回复的那条 (而不是根评论作者),
   *   归一化后会显示在评论正文上方的 "回复 XX：", 不需要前端额外处理。
   */
  public async fetchChildComments(
    rootCommentId: string,
    offset: number = 0,
  ): Promise<ZhihuCommentsPage> {
    if (!rootCommentId) {
      throw new Error('缺少根评论 id, 无法加载回复');
    }
    try {
      const r = await this.axios.get<ZhihuRootCommentsResponse>(
        `/api/v4/comments/${encodeURIComponent(rootCommentId)}/child_comments`,
        {
          params: {
            limit: ZhihuClient.COMMENTS_PAGE_SIZE,
            offset,
          },
        },
      );
      return this.normalizeCommentsResponse(r.data);
    } catch (e) {
      this.handleError(e, `child_comments/${rootCommentId}`);
      throw e;
    }
  }

  /** 把 server 返回的 root_comments/child_comments 响应统一归一化成 ZhihuCommentsPage */
  private normalizeCommentsResponse(
    data: ZhihuRootCommentsResponse | undefined,
  ): ZhihuCommentsPage {
    const body = data ?? {};
    const items = Array.isArray(body.data) ? body.data : [];
    const comments = items
      .map((c) => this.toCommentView(c))
      .filter((c): c is ZhihuCommentForView => c !== null);
    const totals =
      typeof body.paging?.totals === 'number'
        ? body.paging.totals
        : typeof body.common_counts === 'number'
          ? body.common_counts
          : -1;
    return {
      comments,
      totals,
      isEnd: Boolean(body.paging?.is_end),
    };
  }

  /** 按 kind 取 root_comments 接口路径 (找不到返回 null) */
  private commentApiPath(
    kind: ZhihuCardForView['kind'],
    targetId: string,
  ): string | null {
    const id = encodeURIComponent(targetId);
    switch (kind) {
      case '回答':
        return `/api/v4/answers/${id}/root_comments`;
      case '文章':
        return `/api/v4/articles/${id}/root_comments`;
      case '想法':
        // 想法走 /comments 而不是 /root_comments (知乎服务端差异), 字段结构一致
        return `/api/v4/pins/${id}/comments`;
      case '视频':
        return `/api/v4/zvideos/${id}/root_comments`;
      default:
        return null;
    }
  }

  /**
   * 把 server 的原始评论 item 归一化成给前端的 ZhihuCommentForView。
   *
   * 知乎评论作者字段历史上有两种形态:
   *   1) author: { member: { name, avatar_url, headline } }   ← root_comments
   *   2) author: { name, avatar_url, headline }                ← v5 / 部分老接口
   * 这里两个都兜底, 避免新老接口切换时整个评论列表空白。
   */
  private toCommentView(raw: ZhihuRawComment): ZhihuCommentForView | null {
    if (!raw) return null;
    const member = raw.author?.member ?? raw.author ?? {};
    const replyMember =
      raw.reply_to_author?.member ?? raw.reply_to_author ?? null;

    const content = stripHtmlPreserveBreaks(raw.content ?? '');
    if (!content && !replyMember) {
      // 完全空内容 (可能是被删除的评论占位), 不展示
      return null;
    }

    return {
      id: raw.id != null ? String(raw.id) : '',
      content: content || '(评论内容为空)',
      authorName: member.name ?? '匿名用户',
      authorAvatar: member.avatar_url ?? '',
      authorHeadline: member.headline ?? '',
      voteCount:
        typeof raw.vote_count === 'number'
          ? raw.vote_count
          : typeof raw.like_count === 'number'
            ? raw.like_count
            : 0,
      replyTo: replyMember?.name ? `回复 ${replyMember.name}：` : '',
      childCount:
        typeof raw.child_comment_count === 'number'
          ? raw.child_comment_count
          : Array.isArray(raw.child_comments)
            ? raw.child_comments.length
            : 0,
      createdAt: formatCommentTime(raw.created_time),
    };
  }

  /**
   * 统一错误处理: 401/403/特定 errcode → 走 notifyExpired (节流), 不重复弹窗。
   * 其他错误打日志后让调用方 throw 原始异常, 由 UI 层决定如何展示。
   */
  private handleError(e: unknown, scope: string): void {
    const err = e as AxiosError<{ error?: { code?: string; message?: string } }>;
    const status = err?.response?.status;
    const code = err?.response?.data?.error?.code;
    console.warn(
      `[zhihu] ${scope} 失败 status=${status} code=${code} msg=${err?.message}`,
    );

    const looksExpired =
      status === 401 ||
      status === 403 ||
      code === 'AuthenticationInvalidCookie' ||
      code === '100010' || // "ERR_USER_NEED_LOGIN" 常用 code
      code === 'ERR_USER_NEED_LOGIN';

    if (looksExpired) {
      const now = Date.now();
      if (now - this.lastExpiredNotifyAt < 30 * 1000) {
        return;
      }
      this.lastExpiredNotifyAt = now;
      void this.auth.notifyExpired();
    }
  }
}

// ---------- 模块内工具函数 ----------

/**
 * 把 HTML 摘要降级为纯文本。
 * 知乎的 excerpt 经常带 <b>/<a>/<br>, 直接显示在 webview 列表里会出格,
 * 这里只展示纯文本预览; 正文进一步用 stripHtmlPreserveBreaks 保留段落换行。
 *
 * 不引第三方 HTML parser — 推荐流摘要都是平铺的轻量 HTML, 一行正则够用,
 * 同时把多余空白压缩, 避免 "<br><br>" 渲染出多余换行。
 */
function stripHtml(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把正文 HTML 降级为纯文本, 但保留段落级换行 — 用于内嵌阅读。
 *
 * stripHtml() 是为列表 excerpt 服务的, 把所有空白压成一行;
 * 这个函数则把 <p>/<br>/<li> 转成 \n, 让用户在 webview 里看到的还是分段文章,
 * 否则一坨没换行的长字符串读起来很痛苦。
 *
 * 图片暂不内嵌展示, 统一替换为 [图片] 占位 — 避免读者看到突兀的段落断裂.
 */
function stripHtmlPreserveBreaks(html: string): string {
  if (!html) return '';
  return html
    // 所有 <img> 统一替换为 [图片] 占位 (不区分 src/data-original)
    .replace(/<img\b[^>]*>/gi, '[图片]')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|blockquote|pre|tr)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 一些字段返回的是 api 形式 url (https://api.zhihu.com/...), 改成 web 形式让用户在浏览器能直接看。
 * 找不到映射的就原样返回。
 */
function normalizeWebUrl(url: string): string {
  if (!url) return 'https://www.zhihu.com/';
  // api.zhihu.com → www.zhihu.com (大多数情况下路径兼容)
  return url.replace(/^https?:\/\/api\.zhihu\.com/, 'https://www.zhihu.com');
}

// ---------- 评论 接口数据形态 (内部, 不导出) ----------

/**
 * 知乎评论 author 字段两种历史形态都兜底:
 *   - root_comments:  { member: { ... } }
 *   - v5 / 老接口:    直接平铺
 */
interface ZhihuRawAuthor {
  name?: string;
  avatar_url?: string;
  headline?: string;
  member?: { name?: string; avatar_url?: string; headline?: string };
}

interface ZhihuRawComment {
  id?: number | string;
  content?: string;
  vote_count?: number;
  like_count?: number;
  /** server 返的可能是 ISO 字符串或秒级时间戳 */
  created_time?: string | number;
  author?: ZhihuRawAuthor;
  reply_to_author?: ZhihuRawAuthor;
  child_comments?: unknown[];
  child_comment_count?: number;
}

interface ZhihuRootCommentsResponse {
  data?: ZhihuRawComment[];
  paging?: {
    is_end?: boolean;
    totals?: number;
    next?: string;
  };
  /** 部分接口在顶层放总数 */
  common_counts?: number;
}

/**
 * /api/v4/questions/{id}/answers 响应结构.
 * data 数组的每一项是裸 ZhihuTarget (type='answer'), 复用现有 ZhihuTarget 类型即可.
 */
interface ZhihuQuestionAnswersResponse {
  data?: ZhihuTarget[];
  paging?: {
    is_end?: boolean;
    totals?: number;
    next?: string;
  };
}

/**
 * 把 server 返的评论时间格式化成 "M-D HH:mm" / "yyyy-M-D HH:mm" (含跨年时显示年份)。
 *
 * server 返回历史上见过三种:
 *   - 数字: 秒级时间戳 (推荐流接口主用)
 *   - 字符串数字: 同上, 但被序列化为字符串
 *   - ISO 8601: "2024-01-01T12:00:00+08:00"
 *
 * 解析失败/空值返回空串, 前端就不展示时间字段, 不影响布局。
 */
function formatCommentTime(input: string | number | undefined): string {
  if (input === undefined || input === null || input === '') return '';
  let ts: number;
  if (typeof input === 'number') {
    // 秒 → 毫秒
    ts = input * 1000;
  } else {
    const num = Number(input);
    if (Number.isFinite(num) && num > 1e9 && num < 1e11) {
      ts = num * 1000;
    } else {
      ts = Date.parse(input);
    }
  }
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const sameYear = d.getFullYear() === now.getFullYear();
  const ymd = sameYear
    ? `${d.getMonth() + 1}-${d.getDate()}`
    : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  return `${ymd} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
