import * as vscode from 'vscode';
import type { ZhihuAuthService } from '../auth/AuthService';
import type { ZhihuClient } from '../api/ZhihuClient';
import type { ZhihuCardForView, ZhihuFeedItem } from '../types';
import {
  getImageLightboxCss,
  getImageLightboxHtml,
  getImageLightboxScript,
} from '../../../core/imageLightbox';
import { getKeyboardScrollScript } from '../../../core/keyboardScroll';

/**
 * 知乎推荐流的 webview view。
 *
 * 设计原则:
 *   1. 列表 + 卡片 + "点击展开内嵌阅读": 卡片折叠时只显示标题/摘要/作者; 点开后在卡片下方
 *      就地展开正文 (纯文本, 保留段落), 并按 zhihu.readChunkSize 分段加载 — 看不下去随时折叠。
 *      视频类型只显示元信息提示 (实际播放需在外部进行)。
 *   2. 「就地看评论」: 任何卡片展开后都能点 "查看评论 (N)", 在正文下方再就地展开评论列表,
 *      每页 20 条, 滚到底/手动点继续加载, 完全不离开 VSCode (摸鱼必备)。
 *   3. 不重复: 四层去重 (session_token / feedback/read 上报 / 会话内 Set / 持久化 targetKey), 详见 ZhihuClient
 *   4. 摸鱼友好: 整个视图不出现任何"在浏览器打开"按钮 — 一旦带浏览器跳转,
 *      工位上扫到的同事一眼就发现是知乎; 保持"VSCode 文档列表"的伪装感。
 *
 * 数据流:
 *
 *      [webview]                       [provider]                   [client]
 *  init/mount       --postMessage-->   onDidReceiveMessage    -->   fetchRecommend
 *                                                                       │
 *                                                                       ↓
 *                   <--postMessage--   { type: 'cards', cards }   <-- 归一化
 *                                              │
 *                                              ↓
 *  appendCards 渲染                       reportRead (异步, fire-and-forget)
 *
 *  滚动到底:
 *  scroll bottom    --postMessage-->   onDidReceiveMessage 'loadMore' --> fetchRecommend
 *
 *  点击卡片 (展开):
 *  click            --postMessage-->   'expand' { reqId, kind, targetId }
 *                                              │
 *                                              ↓
 *                                          fetchContent (按 kind 拉正文)
 *                   <--postMessage--   { type: 'content', reqId, content }
 *                                              │
 *                                              ↓
 *                          前端按 chunkSize 切片, 每点一次"继续阅读"推进 cursor
 *
 *  查看评论 (展开后):
 *  click 评论 btn   --postMessage-->   'comments' { reqId, kind, targetId, offset }
 *                                              │
 *                                              ↓
 *                                          fetchComments (按 kind 路由到对应 /root_comments)
 *                   <--postMessage--   { type: 'commentsPage', reqId, comments, totals, isEnd }
 *                                              │
 *                                              ↓
 *                       前端 append 渲染, 维护本地 offset, 点 "加载更多" 翻页
 */
export class MainViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'zhihuTouch.main';

  private view?: vscode.WebviewView;
  /** 当前是否正在拉取, 用于前端"加载中"状态 + 防止重复并发 (仅前台 fetchAndPush 持有) */
  private loading = false;
  /** 服务端流是否到底 (paging.is_end). reachedEnd 是 "用户视角到底": serverIsEnd && buffer 取空才算 */
  private serverIsEnd = false;
  /** 通知前端"到底"的最终标志 — buffer 见底 + 服务端 isEnd 才设, 用户视角真到底 */
  private reachedEnd = false;

  /**
   * "非匹配"卡片的复用池. 注意: 匹配过滤的卡片不进这里, 它们由 fetchPageAndPartition
   * 直接 push 给前端 DOM (前端列表自己就是"用户视角的未读 buffer"), buffer 只装
   * 当前过滤拉到但**不匹配**的卡片.
   *
   * 设计要点:
   *   - 存归一化卡片 (ZhihuClient.fetchRecommend 已通过 4 层去重), 不是 raw items —
   *     reportRead 在拉到的当时就上报了, 这里只是"等用户改宽过滤后再展示"的复用池.
   *   - 用户改宽过滤后, 下次 fetchAndPush 走 takeMatchingFromBuffer 复用 — 省一次网络.
   *   - 内存控制: PREFETCH_HARD_BUFFER_CAP 条上限; 极端过滤 (e.g. min=10w) 下连续多页
   *     全不匹配也不会无限膨胀, fetchPageAndPartition 内部超限时 trim 头部.
   *   - 刷新 (replace=true) 时清空: 概念上跟新会话不属同一批, 旧卡不复用.
   */
  private cardBuffer: ZhihuCardForView[] = [];
  /** buffer 总容量硬上限. 防御性数值, 极端过滤场景下兜底防内存膨胀 */
  private static readonly PREFETCH_HARD_BUFFER_CAP = 100;

  /**
   * 后台 prefetch 的 in-flight promise. 同时只允许一个后台任务跑,
   * 也用于前台 fetchAndPush 入口 await 让 prefetch 完手头这一页再让位.
   */
  private prefetchPromise: Promise<void> | null = null;
  /**
   * 前台 fetchAndPush 是否在等待开始. prefetch 循环每页结束后 check 此标志,
   * 为 true 则停止下一页拉取, 把 ZhihuClient 状态机让给前台.
   * 没用 AbortSignal 是因为 axios 这条请求本身不需要 abort — 让出"下一页"的调度即可,
   * 当前 in-flight 的那页跑完无伤大雅 (反正最多让前台等几百毫秒).
   */
  private frontendWantingFetch = false;
  /**
   * prefetch 出错后的熔断标志. cookie 失效 / 网络断 / 服务端 5xx 期间, 反复后台
   * prefetch 会一直失败, 浪费请求 + 反复触发 cookie 失效 banner. 一旦后台 prefetch
   * 抛错就 suspend, 等下次 refresh() (用户主动刷新) 才重置 — 那时候用户应该已经
   * 解决了登录态问题.
   */
  private prefetchSuspended = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: ZhihuClient,
    private readonly auth: ZhihuAuthService,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      // 只允许加载 https 资源 (头像) 和 webview 的本地 css/script
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.renderHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        await this.handleMessage(msg);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        this.postError(m);
      }
    });

    // 登录态变化 → 通知前端刷新 UI (登录前显示 "请登录", 登录后立即拉一页)
    const sub = this.auth.onDidChangeLoginState((loggedIn) => {
      this.post({ type: 'loginState', loggedIn });
      if (loggedIn) {
        // 重置 + 拉一页 (refresh 内部会清 buffer / 解除熔断)
        void this.refresh();
      } else {
        // 退登: 清掉本进程的预取状态, 防止下次登录第一屏看到上个账号 prefetch 的卡
        this.cardBuffer = [];
        this.serverIsEnd = false;
        this.reachedEnd = false;
        this.prefetchSuspended = false;
        this.post({ type: 'cards', cards: [], replace: true });
      }
    });
    this.context.subscriptions.push(sub);

    // cookie 失效状态变化 → 通知前端切 banner 显隐.
    // 之所以不复用 onDidChangeLoginState: 这里语义不同 — "cookie 失效" 指
    // "server 拒绝当前请求 (401/403/code=ERR_USER_NEED_LOGIN)", 此时 cachedCookie
    // 还在 (isLoggedIn() 仍返回 true), 视图不应该回到未登录态, 只需挂个提示.
    // 必须用事件驱动而不是仅在 resolve 时推一次 — retainContextWhenHidden=true 时
    // 切走切回不会重新 resolve, 但 cookie 期间可能从有效跌到失效, 必须收到事件实时推.
    const subCookie = this.auth.onDidChangeCookieValidity((invalid) => {
      this.post({ type: 'cookieValidity', invalid });
    });
    this.context.subscriptions.push(subCookie);

    // view 首次可见时, 如果已登录就直接拉一页
    if (this.auth.isLoggedIn()) {
      void this.refresh();
    } else {
      this.post({ type: 'loginState', loggedIn: false });
    }
  }

  /** 命令: 用户点了刷新按钮 */
  public async refresh(): Promise<void> {
    if (!this.auth.isLoggedIn()) {
      this.post({ type: 'loginState', loggedIn: false });
      return;
    }
    this.reachedEnd = false;
    this.serverIsEnd = false;
    // 解除 prefetch 熔断: 用户主动刷新表明他想再试一次, 此前的失败 (cookie 失效等)
    // 可能已经处理. 注意 buffer 清空在 fetchAndPush 内做 (与 resetSession 时序更紧).
    this.prefetchSuspended = false;
    await this.fetchAndPush(true);
  }

  // ---------- 内部 ----------

  private async handleMessage(msg: { type?: string; [k: string]: unknown }): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        // webview 初次挂载后通知一次登录态 + 同步分段大小配置 (前端切片用)
        //   + 当前点赞过滤器 + 当前图片显示开关 + 当前阅读字号缩放
        //   + 当前 cookie 失效状态 (用户可能在打开 view 之前就已被服务器拒过)
        this.post({ type: 'loginState', loggedIn: this.auth.isLoggedIn() });
        this.post({ type: 'config', chunkSize: this.getChunkSize() });
        this.post({ type: 'filterState', filter: this.getFilter() });
        this.post({ type: 'imagesState', enabled: this.getImagesEnabled() });
        this.post({ type: 'readerFontScaleState', scale: this.getReaderFontScale() });
        this.post({
          type: 'cookieValidity',
          invalid: this.auth.isCookieKnownInvalid(),
        });
        if (this.auth.isLoggedIn()) {
          await this.fetchAndPush(true);
        }
        return;
      case 'setFilter': {
        // 用户在前端调了点赞过滤范围. 持久化到 workspaceState (下次启动复用),
        // 不需要重拉数据 — 前端会自己用 dataset.voteCount 切 .filtered-out 类.
        const raw = msg.filter as { min?: unknown; max?: unknown } | undefined;
        const min =
          raw && typeof raw.min === 'number' && raw.min > 0 ? Math.floor(raw.min) : 0;
        const max =
          raw && typeof raw.max === 'number' && raw.max > 0 ? Math.floor(raw.max) : -1;
        await this.saveFilter({ min, max });
        return;
      }
      case 'setImagesEnabled': {
        // 用户在前端点了图片开关. 仅持久化, 不需要重拉数据 —
        // 前端自己已经 syncImagesEnabledToDOM 把现有卡片切完了.
        await this.saveImagesEnabled(msg.enabled === true);
        return;
      }
      case 'setReaderFontScale': {
        // 用户在前端点了 A- / A+ 改阅读字号. 仅持久化 — 前端写 CSS var 即时生效.
        // clamp 在前端已经做过一遍, 这里再 clamp 一次防御 (postMessage 内容理论上
        // 可被篡改, workspaceState 写入异常值后下次启动会出怪事).
        const raw = msg.scale;
        const scale = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
        await this.saveReaderFontScale(scale);
        return;
      }
      case 'loadMore':
        if (this.reachedEnd) {
          this.post({ type: 'reachEnd' });
          return;
        }
        await this.fetchAndPush(false);
        return;
      case 'expand': {
        // 展开正文: 由前端按 chunkSize 切片分段渲染。
        // reqId 是前端生成的临时 id, 用于把回包路由到正确的卡片 DOM。
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
        // kind 来自 webview, 必然是 ZhihuCardForView['kind'] 的字面值之一; 但 postMessage
        // 类型是宽 string, 这里走一次类型断言, fetchContent 内部 switch 会处理未知值
        const kind = (typeof msg.kind === 'string'
          ? msg.kind
          : '其他') as ZhihuCardForView['kind'];
        const targetId = typeof msg.targetId === 'string' ? msg.targetId : '';
        if (!reqId) return;
        try {
          const content = await this.client.fetchContent(kind, targetId);
          this.post({ type: 'content', reqId, content });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          this.post({ type: 'contentError', reqId, message: m });
        }
        return;
      }
      case 'comments': {
        // 拉评论: 与 expand 同模式, 用 reqId 路由回正确的卡片
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
        const kind = (typeof msg.kind === 'string'
          ? msg.kind
          : '其他') as ZhihuCardForView['kind'];
        const targetId = typeof msg.targetId === 'string' ? msg.targetId : '';
        const offset =
          typeof msg.offset === 'number' && msg.offset >= 0 ? msg.offset : 0;
        if (!reqId) return;
        try {
          const page = await this.client.fetchComments(kind, targetId, offset);
          this.post({ type: 'commentsPage', reqId, ...page, offset });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          this.post({ type: 'commentsError', reqId, message: m });
        }
        return;
      }
      case 'childComments': {
        // 拉子评论 (某条根评论下的回复): 不需要 kind/targetId, 用根评论 id 唯一定位.
        // 前端按 reqId 路由回到对应的 .comment-item DOM, 同时一并带回 rootCommentId 方便调试.
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
        const rootCommentId =
          typeof msg.rootCommentId === 'string' ? msg.rootCommentId : '';
        const offset =
          typeof msg.offset === 'number' && msg.offset >= 0 ? msg.offset : 0;
        if (!reqId || !rootCommentId) return;
        try {
          const page = await this.client.fetchChildComments(rootCommentId, offset);
          this.post({
            type: 'childCommentsPage',
            reqId,
            rootCommentId,
            offset,
            ...page,
          });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          this.post({
            type: 'childCommentsError',
            reqId,
            rootCommentId,
            message: m,
          });
        }
        return;
      }
      case 'openQuestion': {
        // 用户点了某张回答卡片的标题 → 拉该问题下所有回答, 在前端切到"问题详情页".
        // reqId 路由回正确的视图实例 (理论上同时只有一个详情页打开, 但保留 reqId 以便取消旧请求);
        // 首次进入时 offset=0.
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
        const questionId =
          typeof msg.questionId === 'string' ? msg.questionId : '';
        if (!reqId || !questionId) return;
        try {
          const page = await this.client.fetchQuestionAnswers(questionId, 0);
          this.post({
            type: 'questionAnswersPage',
            reqId,
            questionId,
            offset: 0,
            ...page,
          });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          this.post({
            type: 'questionAnswersError',
            reqId,
            questionId,
            offset: 0,
            message: m,
          });
        }
        return;
      }
      case 'loadMoreQuestionAnswers': {
        // 问题详情页内滚到底 / 点 "加载更多" — 翻页拉同一个 questionId 的下一批.
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
        const questionId =
          typeof msg.questionId === 'string' ? msg.questionId : '';
        const offset =
          typeof msg.offset === 'number' && msg.offset >= 0 ? msg.offset : 0;
        if (!reqId || !questionId) return;
        try {
          const page = await this.client.fetchQuestionAnswers(
            questionId,
            offset,
          );
          this.post({
            type: 'questionAnswersPage',
            reqId,
            questionId,
            offset,
            ...page,
          });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          this.post({
            type: 'questionAnswersError',
            reqId,
            questionId,
            offset,
            message: m,
          });
        }
        return;
      }
      case 'login':
        await vscode.commands.executeCommand('zhihu.importCookie');
        return;
      default:
      // ignore
    }
  }

  private getChunkSize(): number {
    const n = vscode.workspace
      .getConfiguration('zhihu')
      .get<number>('readChunkSize', 400);
    // 卡防御: 太小读起来碎, 太大又失去"分段"的意义
    if (!Number.isFinite(n) || n < 50) return 50;
    if (n > 5000) return 5000;
    return Math.floor(n);
  }

  /**
   * 点赞过滤器 — 存在 workspaceState 里, 跨重启保留.
   * 约定: min=0 表示不限下界, max=-1 表示不限上界.
   *
   * 选择 workspaceState (而不是 globalState 或 configuration):
   *   - 不同 workspace 摸不同的鱼: 工作项目里可能想看精品 (min=1000),
   *     学习项目里想看入门讨论 (无下限) — 一份配置走天下不合适.
   *   - 不用 configuration 是因为这俩字段用户基本不会去 settings.json 手改,
   *     都是在 webview UI 上调; configuration 反而要求开放 schema, 噪音大.
   */
  private getFilter(): { min: number; max: number } {
    const v = this.context.workspaceState.get<{ min: unknown; max: unknown }>(
      'zhihu.voteFilter',
    );
    if (!v || typeof v !== 'object') return { min: 0, max: -1 };
    const min =
      typeof v.min === 'number' && v.min > 0 ? Math.floor(v.min) : 0;
    const max =
      typeof v.max === 'number' && v.max > 0 ? Math.floor(v.max) : -1;
    return { min, max };
  }

  private async saveFilter(filter: { min: number; max: number }): Promise<void> {
    await this.context.workspaceState.update('zhihu.voteFilter', filter);
  }

  /**
   * 图片显示开关 — 存 workspaceState, 默认 false (摸鱼场景: 默认不发图床请求, 不出图).
   * 跟过滤器一样选 workspaceState 而非 configuration:
   *   - 不需要让用户在 settings.json 里改, 顶部按钮一键切;
   *   - 不同 workspace 可以不同 (公司项目里默认关, 个人项目里随便).
   */
  private getImagesEnabled(): boolean {
    return this.context.workspaceState.get<boolean>('zhihu.imagesEnabled') === true;
  }

  private async saveImagesEnabled(enabled: boolean): Promise<void> {
    await this.context.workspaceState.update('zhihu.imagesEnabled', enabled);
  }

  /**
   * 阅读字号缩放系数 — 同样选 workspaceState (而非 configuration), 理由同 imagesEnabled:
   *   - 顶部 A- / A+ 按钮一键切, 不需要让用户去 settings.json 改;
   *   - 不同 workspace 可以不同 (大屏外接 vs 笔记本字号偏好不一样).
   *
   * 默认 1.0. clamp 到 [0.7, 1.8] 跟前端约束保持一致 — 防御 workspaceState 被外部写入
   * 异常值 (比如旧版本残留 / 手动改 storage) 导致下次启动正文字号怪异.
   */
  private getReaderFontScale(): number {
    const raw = this.context.workspaceState.get<number>('zhihu.readerFontScale');
    return clampReaderFontScale(raw);
  }

  private async saveReaderFontScale(scale: number): Promise<void> {
    await this.context.workspaceState.update(
      'zhihu.readerFontScale',
      clampReaderFontScale(scale),
    );
  }

  /**
   * 真正打到 ZhihuClient 的入口。
   * `replace = true` 表示是刷新, 前端会清空再 append; false 表示加载更多。
   *
   * 「同步 batch + 后台静默 push 给前端」策略 — 用户视角始终是"底部一直有已加载未读卡":
   *
   *   1) 入口先 await 已 in-flight 的 prefetchPromise (如果有), 让它跑完手上这一页就停;
   *      期间设 frontendWantingFetch=true, prefetch 循环看到就不开新页, 把 ZhihuClient
   *      状态机让给前台. 等待时间最多一页 HTTP RTT (~几百毫秒), 用户基本无感.
   *
   *   2) 取卡片走两路 (同步, 用户视角是按下按钮就出 N 张):
   *      a. 优先从 cardBuffer (非匹配残留池) 取匹配当前过滤的 — 零网络瞬时;
   *         主要在 "用户刚改宽过滤" 这种场景命中, 通常 buffer 是空的.
   *      b. buffer 凑不够 → fetchPageAndPartition: 拉一页 + 拆分 + 匹配 push 前端 +
   *         非匹配存 buffer (供未来放宽过滤复用).
   *
   *   3) 同步阶段目标:
   *      - target = refreshTargetCount (默认 6) — 刷新和加载更多都按这个 batch 同步 push.
   *      - maxAttempts:
   *          * "刷新+过滤激活": refreshMaxAttempts (默认 10) — 过滤极端时多 try 凑数
   *          * 其它场景: 1 — 只发一次网络, 后续靠 finally 触发的 prefetch 持续 push.
   *      - serverIsEnd: 流到底, 退出
   *
   *   4) finally 阶段触发 startPrefetchIfNeeded() — 不 await. 这就是"用户视角 buffer"
   *      的来源: 后台 prefetch 跑起来后, 把拉到的匹配卡**直接 post 给前端** (而不是
   *      塞 cardBuffer), 前端 append 到列表底部. 用户在阅读时, 底部已经积累了 N 张
   *      已加载未翻到的卡, 滚下去一眼就看见. 后台 push 自身有上限 (prefetchTargetCount
   *      默认 12, prefetchMaxPages 默认 5), push 完一轮就停, 下次用户交互再触发,
   *      DOM 不会无限膨胀.
   *
   *   5) replace 语义只在 "本次第一次有内容 push" 时生效, 后续都是 append.
   *
   *   6) reportRead 在 fetchPageAndPartition 内 fire-and-forget. 失败 N 次后 ZhihuClient
   *      内部熔断.
   */
  private async fetchAndPush(replace: boolean): Promise<void> {
    // 标志后台 prefetch 让出: 即使下面 await 期间 prefetch 又被启动也能立刻让位.
    this.frontendWantingFetch = true;
    try {
      // 让正在跑的 prefetch 把当前这一页跑完 (它会因为 frontendWantingFetch=true 不再开新页).
      // 这是为了避免 ZhihuClient 状态机 (sessionToken/pageNumber/endOffset) 被并发 fetch 改乱.
      if (this.prefetchPromise) {
        await this.prefetchPromise.catch(() => undefined);
      }
    } finally {
      this.frontendWantingFetch = false;
    }

    if (this.loading) {
      // 并发保护: 用户连续点 / 快速滚动时不要叠请求
      return;
    }
    this.loading = true;
    this.post({ type: 'loading', loading: true });

    try {
      // 刷新: resetSession 会让服务端从头下发, 旧 buffer 概念上跟新会话不属同一批,
      // 清空避免给用户 "刷新后第一条还是上次看到的卡" 的认知错位.
      // (持久化去重 seenTargetKeys 仍生效, 所以 resetSession 后服务端给的也是新内容)
      if (replace) {
        this.cardBuffer = [];
      }

      const filter = this.getFilter();
      const filterActive = filter.min > 0 || filter.max > 0;
      // 刷新+过滤 才走多次循环凑目标; 其它场景 (刷新无过滤 / 加载更多) 只发最多 1 次网络,
      // 剩下让 prefetch 静默把后续匹配卡 push 给前端 (用户视角"底部一直有未读卡").
      const loopForTarget = replace && filterActive;
      const targetMatchCount = this.getRefreshTargetCount();
      const maxAttempts = loopForTarget ? this.getRefreshMaxAttempts() : 1;

      let pushedToFrontend = 0;
      let totalServerCards = 0;
      let bufferHits = 0;       // 统计: 从 buffer 取到的卡数 (零网络)
      let attempts = 0;          // 服务端实际请求次数
      let pendingReplace = replace;

      while (pushedToFrontend < targetMatchCount) {
        const need = targetMatchCount - pushedToFrontend;

        // 1) 优先从 buffer 取 (buffer 装的几乎全是 "上次拉到但不匹配当前过滤" 的卡;
        //    用户改宽过滤后会从这里复用, 节约一次网络)
        const fromBuffer = this.takeMatchingFromBuffer(need, filter, filterActive);
        if (fromBuffer.length > 0) {
          this.post({
            type: 'cards',
            cards: fromBuffer,
            replace: pendingReplace,
          });
          pendingReplace = false;
          pushedToFrontend += fromBuffer.length;
          bufferHits += fromBuffer.length;
          continue;
        }

        // 2) buffer 没匹配可取了, 看是不是要去服务端拉
        if (this.serverIsEnd) break;
        if (attempts >= maxAttempts) break;
        attempts++;
        const refreshFlag = attempts === 1 ? replace : false;

        // fetchPageAndPartition 内部已经做了 reportRead + 把非匹配卡塞 buffer.
        const { matching, rawCount } = await this.fetchPageAndPartition(refreshFlag);
        totalServerCards += rawCount;
        if (matching.length > 0) {
          this.post({
            type: 'cards',
            cards: matching,
            replace: pendingReplace,
          });
          pendingReplace = false;
          pushedToFrontend += matching.length;
        }
        // 极端 case: 服务端返回 0 条 + 到底了, 不会再有数据, 跳出避免死循环
        if (rawCount === 0 && this.serverIsEnd) break;
      }

      console.log(
        `[zhihu] fetchAndPush 完成: 推前端 ${pushedToFrontend} 条 (目标 ${targetMatchCount}); ` +
          `网络 attempts=${attempts} (服务端 ${totalServerCards} 条), buffer 命中 ${bufferHits} 条, ` +
          `剩余 buffer=${this.cardBuffer.length}; serverIsEnd=${this.serverIsEnd}, filterActive=${filterActive}`,
      );

      // 边界: 整个流程一次都没 push (服务端 0 卡 + buffer 0 匹配 + replace=true 还要清空旧列表)
      if (pendingReplace) {
        this.post({ type: 'cards', cards: [], replace: true });
      }

      this.maybeNotifyReachEnd();

      // 刷新场景循环跑满仍未凑够匹配 — 提示用户. 加载更多场景不打提示 (prefetch 会继续
      // 在后台 push 匹配卡, footer 也会自然回到 "加载更多" 让用户继续点).
      if (
        loopForTarget &&
        pushedToFrontend < targetMatchCount &&
        !this.serverIsEnd &&
        attempts >= maxAttempts
      ) {
        this.postError(
          `已尝试 ${attempts} 次仅找到 ${pushedToFrontend} 条符合点赞过滤条件的内容 (目标 ${targetMatchCount}), 可适当放宽过滤范围或继续 "加载更多"`,
        );
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.postError(`加载失败: ${m}`);
    } finally {
      this.loading = false;
      this.post({ type: 'loading', loading: false });
      // 启动后台 prefetch — 不 await, 让用户的 fetchAndPush 立即返回.
      // 关键: prefetch 内部会把拉到的"匹配"卡直接 push 给前端 (而不是只塞 buffer),
      // 用户视角就是 "底部一直自动冒出新卡片, 翻页时一眼就能看见".
      this.startPrefetchIfNeeded();
    }
  }

  /**
   * 拉一页推荐 + 按当前过滤拆分:
   *   - 匹配的: 返回给调用方 (调用方决定 push 给前端 / 累计计数)
   *   - 不匹配的: 塞 cardBuffer (用户改宽过滤后下次 fetchAndPush 走 takeMatchingFromBuffer 复用)
   *
   * 同时副作用:
   *   - 更新 this.serverIsEnd
   *   - 触发 reportRead (fire-and-forget)
   *
   * 每次都新读 getFilter — 用户在 inflight 中切了过滤区间, 也走最新值, 避免老过滤吞掉新匹配.
   *
   * 不主动 post 给前端 — push 逻辑由调用方决定, 让 fetchAndPush / runPrefetch 各自有
   * 推送节奏 (前者目标 refreshTargetCount, 后者目标 prefetchTargetCount).
   */
  private async fetchPageAndPartition(
    replace: boolean,
  ): Promise<{ matching: ZhihuCardForView[]; rawCount: number }> {
    const result = await this.client.fetchRecommend(replace);
    this.serverIsEnd = result.isEnd;
    void this.client.reportRead(result.rawItems);

    const filter = this.getFilter();
    const filterActive = filter.min > 0 || filter.max > 0;
    const matching: ZhihuCardForView[] = [];
    const nonMatching: ZhihuCardForView[] = [];
    for (const c of result.cards) {
      if (!filterActive || this.matchesFilter(c, filter)) matching.push(c);
      else nonMatching.push(c);
    }
    if (nonMatching.length > 0) {
      this.cardBuffer.push(...nonMatching);
      // buffer 硬上限保护: 极端过滤 (例如 min=1000000) 下连续多页全不匹配, buffer 会膨胀.
      // 简单 trim 头部 (保留尾部最新批次, 旧的反正用户也大概率不会再放宽到那么低门槛了)
      if (this.cardBuffer.length > MainViewProvider.PREFETCH_HARD_BUFFER_CAP) {
        const drop = this.cardBuffer.length - MainViewProvider.PREFETCH_HARD_BUFFER_CAP;
        this.cardBuffer.splice(0, drop);
      }
    }
    return { matching, rawCount: result.cards.length };
  }

  /**
   * 判定是否已到 "用户视角的底" 并通知前端 (幂等, reachedEnd 已为 true 则跳过):
   *   = 服务端 isEnd 且 buffer 里也没有匹配当前过滤的卡片可推
   * 后者很重要: 服务端 isEnd 后, buffer 里可能还有非匹配卡, 用户改宽过滤还能看到,
   * 这种情况就不该现在告诉前端 reachEnd.
   *
   * 在 fetchAndPush 和 runPrefetch 结束时各调一次, 二者都可能拿到最后一页拉到 isEnd.
   */
  private maybeNotifyReachEnd(): void {
    if (this.reachedEnd) return;
    if (!this.serverIsEnd) return;
    const filter = this.getFilter();
    const filterActive = filter.min > 0 || filter.max > 0;
    if (this.countMatchingInBuffer(filter, filterActive) > 0) return;
    this.reachedEnd = true;
    this.post({ type: 'reachEnd' });
  }

  /**
   * 启动后台 prefetch (如果当前没在跑 且 还有补充必要).
   *
   * 不 throw — 内部所有异常吞掉, 因为后台失败不应影响 UI; resetSession 后下次自然重试.
   *
   * 注意: 不再用 cardBuffer.length 判断 "是否还要 prefetch"。runPrefetch 现在的
   * 任务是 "把匹配卡片 push 给前端" 而不是 "把 buffer 填满", buffer 只装非匹配残留.
   * 何时停由 runPrefetch 内的 pushedThisRound < target 控制.
   */
  private startPrefetchIfNeeded(): void {
    if (this.prefetchPromise) return;
    if (this.loading) return;
    if (this.serverIsEnd) return;
    if (this.prefetchSuspended) return;
    if (!this.auth.isLoggedIn()) return;

    this.prefetchPromise = this.runPrefetch()
      .catch((e) => {
        // 拉取失败 — 触发熔断 (refresh 时解除). 避免后续每次 fetchAndPush 完都重启
        // prefetch 然后再次失败, 反复触发 cookie 失效 banner / 浪费请求.
        this.prefetchSuspended = true;
        console.warn(
          '[zhihu] prefetch 失败, 本进程暂停后台 prefetch (用户主动刷新后恢复):',
          e,
        );
      })
      .finally(() => {
        this.prefetchPromise = null;
      });
  }

  /**
   * 后台 prefetch 实际执行体 — 把匹配过滤的卡片**直接 push 给前端**, 让前端列表
   * 自己变成"用户视角的未读 buffer": 底部一直冒出已加载的新卡, 用户翻页 (滚动) 时
   * 不会看到 loading, 因为内容已经在 DOM 里.
   *
   * 终止条件 (任一满足即跳出):
   *   - 本次已 push 给前端的匹配卡数 >= prefetchTargetCount (默认 12 ≈ 2 页满量)
   *   - 拉了 prefetchMaxPages 页 (单轮 prefetch 上限, 避免极端过滤连拉 50 页都凑不够)
   *   - serverIsEnd  (推荐流到底, 不会再有新卡)
   *   - frontendWantingFetch=true  (前台 fetchAndPush 正在等待用 ZhihuClient, 让位)
   *
   * 何时重新跑: 下次 fetchAndPush 结束时的 finally → startPrefetchIfNeeded 触发新一轮.
   * 也就是说 prefetch 不会无限自递归, push 完一轮就停, 等用户下次交互再触发, DOM
   * 不会被无限灌满.
   *
   * 注意不持有 this.loading 锁 — prefetch 跟前台 loading 语义不同, 不该把前端 spinner
   * 一直转着 (那会让用户以为 "一直在加载中"). 前台触发时通过 frontendWantingFetch
   * 让出资源, 不通过 loading 互斥.
   */
  private async runPrefetch(): Promise<void> {
    const target = this.getPrefetchTargetCount();
    const maxPages = this.getPrefetchMaxPages();
    let pages = 0;
    let pushedThisRound = 0;
    console.log(
      `[zhihu] prefetch 启动: 目标 push ${target} 条, maxPages=${maxPages}, ` +
        `buffer(非匹配残留)=${this.cardBuffer.length}`,
    );

    while (
      pushedThisRound < target &&
      pages < maxPages &&
      !this.serverIsEnd &&
      !this.frontendWantingFetch
    ) {
      pages++;
      const { matching, rawCount } = await this.fetchPageAndPartition(false);
      if (matching.length > 0) {
        this.post({ type: 'cards', cards: matching, replace: false });
        pushedThisRound += matching.length;
      }
      // 服务端连续给 0 条 + 到底, 跳出
      if (rawCount === 0 && this.serverIsEnd) break;
    }

    this.maybeNotifyReachEnd();

    console.log(
      `[zhihu] prefetch 结束: 本轮 push 给前端 ${pushedThisRound}/${target} 条, ` +
        `pages=${pages}, serverIsEnd=${this.serverIsEnd}, ` +
        `interrupted=${this.frontendWantingFetch}, buffer 残留=${this.cardBuffer.length}`,
    );
  }

  /**
   * 从 buffer 头部取最多 `need` 张符合过滤的卡片, 取出的从 buffer 移除;
   * 不匹配的留在 buffer 里 (按原顺序). 不修改 buffer 顺序, 保持服务端推荐顺序.
   */
  private takeMatchingFromBuffer(
    need: number,
    filter: { min: number; max: number },
    filterActive: boolean,
  ): ZhihuCardForView[] {
    if (need <= 0 || this.cardBuffer.length === 0) return [];
    const taken: ZhihuCardForView[] = [];
    const remain: ZhihuCardForView[] = [];
    for (const c of this.cardBuffer) {
      if (taken.length < need && (!filterActive || this.matchesFilter(c, filter))) {
        taken.push(c);
      } else {
        remain.push(c);
      }
    }
    this.cardBuffer = remain;
    return taken;
  }

  /** buffer 中匹配当前过滤的卡片数 — 用来判 "真到底" */
  private countMatchingInBuffer(
    filter: { min: number; max: number },
    filterActive: boolean,
  ): number {
    if (!filterActive) return this.cardBuffer.length;
    let n = 0;
    for (const c of this.cardBuffer) {
      if (this.matchesFilter(c, filter)) n++;
    }
    return n;
  }

  /**
   * 一次给前端的目标卡片数 — 刷新和"加载更多"都用这个数. 默认 6 (跟知乎推荐流单页
   * 默认条数一致). 上限 30 防止用户调成离谱值导致一次拉太多卡 (前端 DOM 撑大 + 服务端
   * 单次拉太多页面).
   *
   * 命名历史: 引入 prefetch buffer 后 "刷新" 和 "加载更多" 的目标都统一成了这个值,
   * 但保留 refreshTargetCount 名字 (不改 setting key 以保持用户配置向后兼容); 描述
   * 在 package.json 已更新成新语义.
   */
  private getRefreshTargetCount(): number {
    const n = vscode.workspace
      .getConfiguration('zhihu')
      .get<number>('refreshTargetCount', 6);
    if (!Number.isFinite(n) || n < 1) return 6;
    if (n > 30) return 30;
    return Math.floor(n);
  }

  /**
   * 「凑够匹配卡片」的循环上限. 默认 10 — 经验值, 平衡 "确实凑得起来"
   * 与 "过滤太极端时不要无限烧请求 + 不要触发风控".
   * 用户也可以临时调高 (但封顶 30) 以应对小众阈值.
   */
  private getRefreshMaxAttempts(): number {
    const n = vscode.workspace
      .getConfiguration('zhihu')
      .get<number>('refreshMaxAttempts', 10);
    if (!Number.isFinite(n) || n < 1) return 10;
    if (n > 30) return 30;
    return Math.floor(n);
  }

  /**
   * 后台 prefetch 的 buffer 目标存量 (条数). 默认 12 ≈ 2 页 — 用户翻 1-2 屏
   * 都能 buffer 命中. 上限 50 防止 prefetch 把无效拉取做到极端.
   * 设 0 关闭后台 prefetch (回退到 "用户翻页才拉" 的同步模式).
   */
  private getPrefetchTargetCount(): number {
    const n = vscode.workspace
      .getConfiguration('zhihu')
      .get<number>('prefetchTargetCount', 12);
    if (!Number.isFinite(n) || n < 0) return 12;
    if (n > 50) return 50;
    return Math.floor(n);
  }

  /**
   * 单次后台 prefetch 最多发起的服务端请求数. 默认 5 — 单次最多拉 ~5 页 (~30 条),
   * 拉完释放, 等下次 fetchAndPush 结束时再 startPrefetchIfNeeded.
   * 不直接用 refreshMaxAttempts: prefetch 是低优先级背景任务, 单次跑太久会让用户
   * 长时间感受到接口压力 (虽然 spinner 不转, 但服务端可能限流).
   */
  private getPrefetchMaxPages(): number {
    const n = vscode.workspace
      .getConfiguration('zhihu')
      .get<number>('prefetchMaxPages', 5);
    if (!Number.isFinite(n) || n < 1) return 5;
    if (n > 20) return 20;
    return Math.floor(n);
  }

  /**
   * 是否落入过滤区间 (跟前端 shouldFilterOut 取反语义).
   * 约定: min<=0 表示不限下界, max<=0 表示不限上界 — 与 getFilter() 的取值约定对齐.
   */
  private matchesFilter(
    card: ZhihuCardForView,
    filter: { min: number; max: number },
  ): boolean {
    const v = typeof card.voteCount === 'number' ? card.voteCount : 0;
    if (filter.min > 0 && v < filter.min) return false;
    if (filter.max > 0 && v > filter.max) return false;
    return true;
  }
  
  /** 给前端发消息 (view 可能尚未 resolve, 兜底) */
  private post(payload: unknown): void {
    void this.view?.webview.postMessage(payload);
  }

  private postError(message: string): void {
    this.post({ type: 'error', message });
  }

  /**
   * 渲染 webview 的 HTML。
   *
   * 一次性内联所有 CSS/JS — 这个视图很简单, 没必要拆 esbuild / 多文件; 改起来也直接,
   * 不需要"改 ts → tsc → reload"两段式调试。
   *
   * 注意 CSP:
   *   - default-src 'none' — 默认拒一切, 显式开白名单
   *   - img-src 允许 https: 因为知乎头像在 https 域名下
   *   - script-src 用 nonce, 防止 XSS (虽然来源全是我们自己的 server, 加上不亏)
   */
  private renderHtml(): string {
    const nonce = generateNonce();
    const csp = [
      `default-src 'none'`,
      `img-src https: data:`,
      `style-src 'unsafe-inline' ${this.view?.webview.cspSource ?? ''}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root {
    color-scheme: light dark;
    /* 卡片底色 — 关键: 必须是"看起来"不透明的, 否则 sticky 头部浮在内容上方时
       下面的回答正文会从半透明背景里透出来, 字叠字非常脏.
       vscode 的 --vscode-textCodeBlock-background 在多数主题下是半透明 rgba
       (设计用来叠在 editor/sidebar 之上才出"代码块"层次感), 直接拿来当 sticky
       背景会透字. 这里用 linear-gradient 把同色叠两次铺成实色覆盖, 再用
       --vscode-sideBar-background 做底层兜底 — 即便上层 token 是半透明, 也会被
       下层 sideBar 实色挡住, 视觉跟原来基本一致, 但 sticky 头部不再透字. */
    --card-bg:
      linear-gradient(
        var(--vscode-textCodeBlock-background, rgba(128,128,128,0.06)),
        var(--vscode-textCodeBlock-background, rgba(128,128,128,0.06))
      ),
      var(--vscode-sideBar-background);
    /* 阅读字号缩放系数 — 只作用于 "正文 / 评论" 这种长文本阅读区域, 不动 chrome
       (标题/按钮/作者/meta) 字号, 否则按钮一起变大会撑破布局.
       由前端 A- / A+ 按钮调, 持久化到 workspaceState 'zhihu.readerFontScale'.
       范围 0.7 ~ 1.8, 默认 1.0; JS 端 applyReaderFontScale 会 clamp 并写回这里. */
    --reader-font-scale: 1;
  }
  body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  .empty, .login-tip {
    padding: 24px 16px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.6;
    font-size: 13px;
  }
  .login-tip button {
    margin-top: 12px;
    padding: 6px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 13px;
  }
  .login-tip button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  /*
    卡片化视觉 — 每张 .card-wrap 都做成独立的圆角小卡片:
      - background 用 textCodeBlock-background, 跟 vscode 聊天界面里代码块同一类视觉
        (主题切换时自动跟随; fallback 一层半透明灰).
      - border 用 widget-border / panel-border, 一道细描边.
      - border-radius 6px, margin 8px 让卡片之间留空气感.
    !!! 这里**不能**写 overflow:hidden — 任何 overflow != visible 的祖先都会成为
    sticky 的 scroll container, 导致内部 .card sticky 失效 (展开后标题不再吸顶).
    .card hover 块色溢出圆角的问题由 .card 自己加 border-radius 解决, 不依赖父级裁剪.
  */
  .card-wrap {
    /* 用 --card-bg 双层背景 (sideBar 实色兜底 + codeBlock 半透明叠加), 解决 sticky 头部透字.
       详细原因见 :root 里 --card-bg 的注释. */
    background: var(--card-bg);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.18)));
    border-radius: 6px;
    margin: 8px 8px;
    transition: border-color 0.15s;
  }
  /* 展开态: 整张卡片描边换成柔和的中性灰 (descriptionForeground), 仍跟折叠态有明显
     对比, 但不像 --vscode-focusBorder 那么刺眼 (后者多数主题是高饱和蓝, 整圈描边
     视觉太重). */
  .card-wrap.expanded {
    border-color: var(--vscode-descriptionForeground, rgba(128,128,128,0.55));
  }
  .card {
    padding: 12px 14px;
    cursor: pointer;
    transition: background 0.1s;
    position: relative;
    /* 折叠态: 整圆角, 让 hover 时的块色不会超出 wrap 边界露出方角 (没有 wrap overflow:hidden 兜底).
       展开态会被下面 .card-wrap.expanded .card 的 6px 6px 0 0 覆盖, 只保留顶部圆角. */
    border-radius: 6px;
  }
  .card:hover {
    background: var(--vscode-list-hoverBackground);
  }
  /* 展开态 card 头部不再使用 activeSelectionBackground (那是高饱和蓝, 整块色看着累),
     仅保留 hover 反馈; 折叠/展开的视觉差异已由 .card-toggle 旋转 + 左侧色条传达 */
  /* 展开/折叠的小三角标记 — 用 CSS 画, 不引图标库 */
  .card-toggle {
    display: inline-block;
    width: 0;
    height: 0;
    border-left: 4px solid var(--vscode-descriptionForeground);
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    margin-right: 4px;
    transition: transform 0.15s;
    flex-shrink: 0;
  }
  .card-wrap.expanded .card-toggle {
    transform: rotate(90deg);
  }
  /*
    展开后的卡片头 sticky 在顶部 (紧贴 filter-bar 下方) — 长答案看到一半也能随时
    在原位置看到标题, 点一下头部直接折叠回去, 不用滚回顶部.
      - top 用 --filter-bar-h 变量, 由 ResizeObserver 实时同步 filter-bar 实际高度
        (登录态切换 hidden / 用户改 vscode 字号 都会自动跟); 兜底 36px.
      - z-index 5 < filter-bar 的 10, 确保 filter-bar 在最上.
      - background 必须不透明, 否则 sticky 时下面正文会从下面透上来.
      - 左侧色条用 inset box-shadow 重新画一遍 — 因为 .card 的不透明背景会盖住
        .card-wrap.expanded 自己的 inset 阴影, 不补就视觉上断掉.
      - 底部一道细阴影暗示 "已浮起在内容上方".
    多张卡片同时展开时, 每张 .card 在自己的 .card-wrap 内 sticky, 滚出 wrap 边界
    会自然被下一张顶替 — 这是 position:sticky 的天然行为, 不会重叠.
  */
  .card-wrap.expanded .card {
    position: sticky;
    top: var(--filter-bar-h, 36px);
    z-index: 5;
    /* sticky 必须"看起来"不透明, 否则滚动时下面的正文会从背景透上来叠在标题文字上.
       用跟 .card-wrap 一致的 --card-bg (linear-gradient 实色兜底), 既保证不透字,
       又跟卡片本体融为一体, 不出现两段色. */
    background: var(--card-bg);
    /* 只顶部圆角 — 因为下方紧贴 .card-detail, 底部如果留圆角会露出 wrap 背景缺口. */
    border-radius: 6px 6px 0 0;
    /* 底部一道细线分隔头部与正文; 用 inset 不会被任何祖先裁掉, 也不会推开下方内容. */
    box-shadow: inset 0 -1px 0 var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.2));
  }
  /* 展开后的正文区
     之前用 list-activeSelectionBackground 整块染蓝 — 体感像被选中的文件, 且打破了 sidebar 的视觉层级.
     现在保持透明背景, 只用一条 dashed 分隔线把"标题/正文"轻量切开, 蓝色仅留在 wrap 的左侧色条上. */
  .card-detail {
    padding: 0 14px 14px 14px;
    font-size: 12.5px;
    line-height: 1.7;
    color: var(--vscode-foreground);
    background: transparent;
    border-top: 1px dashed var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.2));
  }
  .card-detail[hidden] {
    display: none;
  }
  .detail-text {
    white-space: pre-wrap;
    word-break: break-word;
    padding-top: 10px;
    color: var(--vscode-foreground);
    /* 正文阅读字号 — 用户可在 filter-bar 上 A- / A+ 调整, 见 --reader-font-scale 定义.
       这里基础值取 12.5px (跟之前 .card-detail 的 12.5px 视觉一致), 不动 chrome 区. */
    font-size: calc(12.5px * var(--reader-font-scale, 1));
  }
  /* 内联图片相关样式 — 不绑 .detail-text 前缀, 让正文 (.detail-text) / 评论 (.comment-body)
     / 未来其它内容区都能共用. 类名 inline-img 本身够独特, 不会跟外部样式撞.
     评论区里图片再额外覆盖 max-height (给评论更紧凑的视觉), 见 .comment-body .inline-img. */
  .inline-img {
    display: block;
    max-width: 100%;
    max-height: 360px;
    object-fit: contain;
    margin: 8px 0;
    border-radius: 4px;
    background: var(--vscode-editor-background, transparent);
  }
  .inline-img-broken {
    display: inline-block;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    margin: 4px 0;
  }
  /* 图片占位符 — imagesEnabled=false 时, 把原本应渲染的 <img> 全部替换成它,
     既不发任何网络请求 (摸鱼场景不能让公司网络/旁观者看到 zhimg.com 的图加载),
     又给用户一个明确的 "这里原本有图" 提示, 可以随时点顶部 🖼️ 按钮切换显示. */
  .inline-img-placeholder {
    display: inline-block;
    padding: 2px 8px;
    margin: 4px 0;
    color: var(--vscode-descriptionForeground);
    border: 1px dashed var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.3));
    border-radius: 3px;
    font-size: 11.5px;
    user-select: none;
  }
  /* 评论区里的图片视觉降一档 — max-height 给小 + 缩短上下 margin, 避免一张表情图
     把楼层撑得比正文还大. 占位符不需要覆盖 (已经够小). */
  .comment-body .inline-img {
    max-height: 220px;
    margin: 6px 0;
  }
  .detail-loading, .detail-error {
    padding: 12px 0;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  .detail-error {
    color: var(--vscode-errorForeground, var(--vscode-descriptionForeground));
  }
  .detail-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px dotted var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.2));
    flex-wrap: wrap;
  }
  .detail-btn {
    padding: 4px 10px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
  }
  .detail-btn:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .detail-btn.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
  }
  .detail-btn.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  .detail-progress {
    margin-left: auto;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }
  /* ---------- 评论区 ---------- */
  .comments-section {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px dashed var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.25));
  }
  .comments-section[hidden] {
    display: none;
  }
  .comments-header {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .comments-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .comment-item {
    padding: 8px 10px;
    background: var(--vscode-editor-background, var(--vscode-sideBar-background));
    border-radius: 3px;
    border: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
  }
  .comment-head {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .comment-head img {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .comment-author {
    color: var(--vscode-foreground);
    font-weight: 600;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .comment-headline {
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }
  .comment-time {
    margin-left: auto;
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
    flex-shrink: 0;
  }
  .comment-reply-to {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    margin-bottom: 2px;
  }
  .comment-body {
    /* 评论正文也走 --reader-font-scale 缩放, 跟 .detail-text 同步变化, 体验一致 */
    font-size: calc(12px * var(--reader-font-scale, 1));
    line-height: 1.55;
    color: var(--vscode-foreground);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .comment-meta {
    display: flex;
    gap: 12px;
    margin-top: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 10.5px;
  }
  .comments-empty {
    padding: 8px 0;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  .comments-loading, .comments-error {
    padding: 8px 0;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  .comments-error {
    color: var(--vscode-errorForeground, var(--vscode-descriptionForeground));
  }
  .comments-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  /* ---------- 顶部点赞过滤条 ---------- */
  /* sticky 让筛选条始终贴顶 — 用户滚到任意位置都能改阈值. z-index 防止被
     展开后的 .card-detail 顶住. 背景同 sideBar, 视觉上像是 sidebar 自带 header. */
  .filter-bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 6px 10px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .filter-bar[hidden] {
    display: none;
  }
  .filter-bar input {
    width: 56px;
    padding: 2px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-size: 11px;
    font-family: inherit;
  }
  .filter-bar input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .filter-bar button {
    padding: 2px 8px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
    border-radius: 2px;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
  }
  .filter-bar button:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  /* 图片显示开关 — 视觉上区分 on/off:
       off (默认): 复用 filter-bar button 灰底, 跟其他次要按钮一致;
       on:        切到主色 button-background, 让用户一眼看到"图片是开着的" (摸鱼场景下
                  这是个需要警觉的状态 — 同事走过来一眼能看到知乎图). */
  .filter-bar .images-toggle.on {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .filter-bar .images-toggle.on:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .filter-bar .filter-stat {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground);
  }
  /* 详情页 (问题详情) 状态下, 隐藏 filter-bar 里跟"推荐流过滤"绑定的元素 —
     点赞 min/max 输入 + 应用/清除按钮 + 可见/总数统计;
     图片开关 (🖼️) 与字号按钮 (A-/A+) 不属于"推荐流过滤", 保留可见,
     这样用户在详情页阅读长答案时仍可一键开关图片 / 调字号 (之前是整条 bar
     藏掉, 进了详情页就够不到这两个按钮, 体验断裂). */
  .filter-bar.in-question .feed-only {
    display: none !important;
  }
  /* ---------- Cookie 失效提示 banner ----------
     被动告示, 不弹 modal/toast (用户明确说过弹窗太烦). 配套 ZhihuAuthService 的
     onDidChangeCookieValidity 事件: server 返回 401/403/code=ERR_USER_NEED_LOGIN
     时显示, 用户重新导入或 logout 后隐藏.

     放在 filter-bar *上方* 且 *不* sticky:
       - 不 sticky 避免破坏 filter-bar 原有的 top: 0 / --filter-bar-h 计算链
         (展开卡片的 .card-header sticky top 依赖这个变量, 改动会牵连一大片).
       - 用户首次打开 view / 切回 tab 都能在顶部一眼看到提醒, 滚走也无所谓
         (反正状态没解决就一直在 DOM 里, 下次刷新还会看到).
     视觉上用 vscode 的 inputValidation.warning 主题色调, 跟 vscode 自带的警告条更搭. */
  .invalid-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: var(--vscode-inputValidation-warningBackground, rgba(244, 130, 31, 0.12));
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, rgba(244, 130, 31, 0.35));
    font-size: 11.5px;
    line-height: 1.4;
  }
  .invalid-banner[hidden] {
    display: none;
  }
  .invalid-banner-icon {
    flex: 0 0 auto;
  }
  .invalid-banner-text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .invalid-banner-btn {
    flex: 0 0 auto;
    padding: 2px 8px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
    border-radius: 2px;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
  }
  .invalid-banner-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  /* 被过滤掉的卡片 — 完全 display:none, 不占布局空间 (相比 visibility:hidden 更省滚动距离).
     注意: 这只是 "前端视觉过滤", 后端依然推全量数据, 翻页 / 去重等状态机不变. */
  .card-wrap.filtered-out {
    display: none;
  }
  /* ---------- 子评论 (回复) ---------- */
  /* 设计取舍: 子评论在父评论下方缩进展示, 用左侧细色条做层级提示, 字号/间距比根评论再小一档,
     避免"楼中楼"一展开就把列表撑爆. 子评论本身的回复 (二级以上) 不再支持展开 — 知乎自己 web 端
     也是只下钻一层, 再深就跳详情页了; 我们摸鱼场景下更没必要走那么深. */
  .child-comments-section {
    margin-top: 8px;
    padding-left: 10px;
    border-left: 2px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.25));
  }
  .child-comments-section[hidden] {
    display: none;
  }
  .child-comments-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .child-comment-item {
    padding: 4px 0;
    border-bottom: 1px dotted var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.12));
  }
  .child-comment-item:last-child {
    border-bottom: none;
  }
  .child-comment-item .comment-body {
    /* 子评论字号比根评论再小一档 (基础 11.5px), 同样跟随 --reader-font-scale */
    font-size: calc(11.5px * var(--reader-font-scale, 1));
  }
  .child-comments-actions {
    display: flex;
    gap: 8px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  /* 回复展开按钮: 走链接样式而不是 button 块, 让 "N 条回复" 看着是 "可点的提示" 而不是按钮 */
  .comment-replies-toggle {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    padding: 0;
    font-size: 10.5px;
    font-family: inherit;
    text-decoration: underline;
  }
  .comment-replies-toggle:hover {
    color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
  }
  .comment-replies-toggle:disabled {
    color: var(--vscode-descriptionForeground);
    cursor: default;
    text-decoration: none;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
  .kind-tag {
    padding: 1px 6px;
    border-radius: 2px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 10px;
    line-height: 1.4;
  }
  .author {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
  }
  .author img {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .vote {
    flex-shrink: 0;
  }
  .card-title {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.45;
    margin: 0 0 4px 0;
    color: var(--vscode-foreground);
    /* 最多 2 行省略 */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .card-excerpt {
    font-size: 12px;
    line-height: 1.5;
    color: var(--vscode-descriptionForeground);
    /* 最多 3 行省略 */
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0;
  }
  /* ---------- 问题详情页 ---------- */
  /* 设计取舍:
     - 详情页 #questionView 与 #root 同级, 通过 hidden / display 切换显隐, 而非整体重写 root.innerHTML;
       这样 feed 流的滚动位置 + 已展开卡片状态完全保留, 返回后还在原地; webview 也不需要重新初始化任何状态.
     - 标题做成 sticky, 让用户滚到任意位置都能看到"我现在在哪个问题里", 紧贴顶部更省垂直空间.
     - 详情页里不复用顶部点赞过滤条 (语义不同: 详情页里关心的是"看更多回答", 不是按赞数过滤); 详情页打开时强制隐藏 filterBar. */
  .question-header {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 8px 10px;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
  }
  .question-back {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
    padding: 2px 8px;
    border-radius: 2px;
    cursor: pointer;
    font-size: 11px;
    font-family: inherit;
    flex-shrink: 0;
    /* 把按钮压到跟标题第一行平齐 — 标题可能多行, 按钮永远在第一行视觉锚定 */
    margin-top: 1px;
  }
  .question-back:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
  }
  .question-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-foreground);
    line-height: 1.4;
    flex: 1;
    min-width: 0;
    /* 标题允许多行 — 详情页头部没有其他元素竞争空间, 长问题完整展示更友好 */
    word-break: break-word;
  }
  .question-meta {
    font-size: 11px;
    font-weight: normal;
    color: var(--vscode-descriptionForeground);
    margin-left: 4px;
  }
  /* card-title 在 feed 流里, 仅 kind=回答 且 有 questionId 时可点击跳转问题详情;
     用 .clickable class 标记 — 鼠标 hover 上链接色 + 下划线, 暗示"这里可点". */
  .card-title.clickable {
    cursor: pointer;
  }
  .card-title.clickable:hover {
    color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
    text-decoration: underline;
  }
  .footer {
    padding: 16px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--vscode-descriptionForeground);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
${getImageLightboxCss()}
</style>
</head>
<body>
  <!--
    点赞过滤条 — 始终 sticky 在顶部, 未登录时整条隐藏 (避免在登录提示上方还显示一条空白筛选条).
    设计取舍: 选择"前端过滤 + 状态持久化到 workspaceState", 而不是改后端拉取条件 —
      - 即时生效, 改个数立刻看见结果, 无需重拉数据;
      - 不同 workspace 可以摸不同的鱼 (写代码摸鱼场景, 公司项目 vs 个人项目想看的阈值可能不一样);
      - 副作用: 过滤太严时新拉一批可能全被过滤掉, "加载更多"会一直能点 —
        这反而起到反向提醒 "你阈值卡太死了" 的作用, 故意保留.
    约定: min=0 表示不限下界 (>=0 就是不限), max=-1 表示不限上界 (避开 0 这种合法值).
  -->
  <!--
    Cookie 失效提示 banner — 见 .invalid-banner CSS 注释:
    放在 filter-bar 上方, 不 sticky, hidden 切显示. 状态由 extension 端
    'cookieValidity' 消息驱动, "重新导入" 触发 vscode.postMessage({ type: 'login' }).
  -->
  <div id="invalidBanner" class="invalid-banner" hidden>
    <span class="invalid-banner-icon" aria-hidden="true">⚠️</span>
    <span class="invalid-banner-text">知乎 Cookie 已失效, 部分内容可能加载失败</span>
    <button class="invalid-banner-btn" type="button" data-act="reimport">重新导入</button>
  </div>
  <!--
    feed-only 类标记: 详情页 (.filter-bar.in-question) 状态下会被 display:none 隐藏.
    凡是只对"推荐流"有意义的控件 (点赞过滤/统计) 都加 feed-only;
    图片开关 / 字号按钮 不加, 详情页里也要能用.
  -->
  <div id="filterBar" class="filter-bar" hidden>
    <span class="feed-only">👍</span>
    <input id="filterMin" class="feed-only" type="number" min="0" placeholder="最少" title="最低赞数 (留空或 0 = 不限)" />
    <span class="feed-only">~</span>
    <input id="filterMax" class="feed-only" type="number" min="0" placeholder="不限" title="最高赞数 (留空 = 不限)" />
    <button id="filterApply" class="feed-only" type="button" title="应用筛选 (回车也可)">应用</button>
    <button id="filterClear" class="feed-only" type="button" title="清除筛选, 恢复全部显示">清除</button>
    <!--
      图片开关 — 摸鱼场景默认关闭 (workspaceState 'zhihu.imagesEnabled' = false):
        - 关闭时正文里所有 [IMG:url] 渲染成纯占位符 "🖼️ 图片", 完全不发请求, 不出图;
        - 打开后已经展开的卡片里占位符立即就地变成 <img> (无需重新展开).
      放在 filter-bar 里跟过滤按钮同一行, sticky 顶部, 滚到哪都点得到.
      详情页里也要能切, 故 *不* 加 feed-only.
    -->
    <button id="imagesToggle" type="button" class="images-toggle" title="开启/关闭正文图片显示 (默认关闭, 摸鱼伪装感)">🖼️ 图片</button>
    <!--
      阅读字号调整 — A- / A+ 一对按钮, 只影响 .detail-text 与 .comment-body
      (chrome 区域字号保持 vscode 默认, 避免按钮一起变大撑破布局).
      title 里 JS 会动态写入当前百分比, 让用户知道在哪一档.
      详情页里读长答案场景更需要调字号, 故 *不* 加 feed-only.
    -->
    <button id="fontSmaller" type="button" class="font-zoom" title="缩小阅读字号">A-</button>
    <button id="fontLarger" type="button" class="font-zoom" title="放大阅读字号">A+</button>
    <span id="filterStat" class="filter-stat feed-only"></span>
  </div>
  <div id="root">
    <div class="empty">初始化中...</div>
  </div>
  <!--
    footer 同时承担三个角色 (按状态切换):
      1. 加载中  → spinner + "加载中..."
      2. 空闲态  → "加载更多" 按钮 (用户手点 fallback)
      3. 已到底  → "—— 已经到底了 ——"
    并且通过 IntersectionObserver 监听这个 div, 一旦它进入视口就自动触发 loadMore —
    比 window.scroll 事件可靠 (sidebar 这种细长 webview 里 scroll 很难触底).
  -->
  <div id="footer" class="footer" style="display:none"></div>

  <!--
    问题详情页 — 点击 feed 流里某张 "回答" 卡片的标题, 显示该问题下所有回答.
    与 #root 同级用 hidden 切显隐 (保留 feed 流的滚动位置 + 已展开卡片状态, 返回即原状).
    每张答案卡片与 feed 卡片共用 .card-wrap 结构, 复用全部展开/评论/子评论交互, 只在
    渲染时隐藏 kind-tag 标签 (详情页里都是同一种 kind, 显示重复且无意义).
  -->
  <div id="questionView" hidden>
    <div class="question-header">
      <button id="questionBack" class="question-back" type="button" title="返回推荐流">← 返回</button>
      <div id="questionTitle" class="question-title">问题</div>
    </div>
    <div id="questionList"></div>
    <div id="questionFooter" class="footer"></div>
  </div>

<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  const footer = document.getElementById('footer');
  // —— 点赞过滤条 DOM 引用 (始终在 DOM 中存在, hidden 属性切显示) ——
  const filterBar = document.getElementById('filterBar');
  const filterMinInput = /** @type {HTMLInputElement} */ (document.getElementById('filterMin'));
  const filterMaxInput = /** @type {HTMLInputElement} */ (document.getElementById('filterMax'));
  const filterApplyBtn = document.getElementById('filterApply');
  const filterClearBtn = document.getElementById('filterClear');
  const imagesToggleBtn = document.getElementById('imagesToggle');
  const fontSmallerBtn = document.getElementById('fontSmaller');
  const fontLargerBtn = document.getElementById('fontLarger');
  const filterStat = document.getElementById('filterStat');
  // Cookie 失效 banner — 显隐由 'cookieValidity' 消息驱动, 内部按钮走 'login' 命令
  const invalidBanner = document.getElementById('invalidBanner');

  let loggedIn = false;
  let reachedEnd = false;
  let loading = false;
  let cardsRendered = 0;
  /** 每段展示的字符数 (extension 端 zhihu.readChunkSize 配置, ready 后下发) */
  let chunkSize = 400;
  /**
   * 当前生效的点赞过滤区间.
   * 约定: min=0 表示不限下界, max=-1 表示不限上界.
   * 初值是"全部不限", ready 后 extension 会下发 'filterState' 用持久化值覆盖.
   */
  let currentFilter = { min: 0, max: -1 };
  /**
   * 是否允许在正文里渲染图片. 默认 false (摸鱼场景: 别让网络流量 / 屏幕上突然冒出
   * zhimg.com 的高饱和图片暴露你在看知乎). ready 后 extension 会下发 'imagesState'
   * 用持久化值覆盖.
   *
   * 渲染策略 (见 renderTextWithImages):
   *   - true:  [IMG:url] -> <img class="inline-img" src=url>
   *   - false: [IMG:url] -> <span class="inline-img-placeholder" data-src=url>🖼️ 图片</span>
   * 用户切换时遍历 DOM 替换节点, 实现"已展开的卡片也立即响应"且默认态完全不发请求.
   */
  let imagesEnabled = false;
  /**
   * 阅读字号缩放系数. 只作用于正文 (.detail-text) + 评论正文 (.comment-body),
   * 不动 chrome 字号 (标题/按钮/作者/meta), 避免按钮一起变大撑破 sidebar 布局.
   *
   * 范围 0.7 ~ 1.8, step 0.1, 默认 1.0.
   * 写到 CSS var --reader-font-scale, 三处 calc(基础px * var(--reader-font-scale))
   * 实时跟随. 持久化到 workspaceState 'zhihu.readerFontScale', ready 后 extension
   * 通过 'readerFontScaleState' 下发覆盖.
   */
  let readerFontScale = 1;
  const READER_FONT_MIN = 0.7;
  const READER_FONT_MAX = 1.8;
  const READER_FONT_STEP = 0.1;
  /**
   * 正在加载正文的请求 -> wrap 元素映射。
   * 收到 'content' / 'contentError' 时按 reqId 路由回正确的卡片 DOM。
   * 卡片若被刷新清空, 对应 wrap 已不在 DOM 中, 我们直接丢弃回包即可 (不报错)。
   */
  const pendingExpands = Object.create(null);

  /** 正在加载评论的请求 -> wrap 元素映射 (同 pendingExpands 模式) */
  const pendingComments = Object.create(null);

  /** 正在加载子评论(回复)的请求 -> .comment-item 元素映射 */
  const pendingChildComments = Object.create(null);

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // 注意: 这一段 JS 嵌在 TS template literal (反引号) 里, \\[ \\] \\/ 必须双写,
  // 否则模板求值时反斜杠被吞, 注入到 webview 的正则会变成 /[IMG:(https?://[^]]+)]/g,
  // 抛 "Unmatched ')'" SyntaxError, 整个 IIFE 不执行, 前端永远停在 "初始化中...".
  const IMG_PLACEHOLDER_RE = /\\[IMG:(https?:\\/\\/[^\\]]+)\\]/g;

  /**
   * 把正文中的 [IMG:url] 占位符渲染成图片或占位符, 其它内容保持纯文本。
   * 只处理 http(s) url, 并用 DOM API 创建节点, 不拼 innerHTML, 避免 XSS。
   *
   * 根据 imagesEnabled 决定生成什么节点 (二选一, 不会同时存在):
   *   - true:  <img class="inline-img" src=url>  — 会发请求
   *   - false: <span class="inline-img-placeholder" data-src=url>🖼️ 图片</span> — 不发请求
   * 两种节点都带 data-src, 切换开关时由 syncImagesEnabledToDOM 全量替换.
   */
  function renderTextWithImages(container, content) {
    const raw = String(content == null ? '' : content);
    let last = 0;
    let match;
    IMG_PLACEHOLDER_RE.lastIndex = 0;
    while ((match = IMG_PLACEHOLDER_RE.exec(raw))) {
      if (match.index > last) {
        container.appendChild(document.createTextNode(raw.slice(last, match.index)));
      }
      const src = match[1];
      if (/^https?:\\/\\//i.test(src)) {
        container.appendChild(imagesEnabled ? createImgNode(src) : createImgPlaceholder(src));
      } else {
        container.appendChild(document.createTextNode('[图片]'));
      }
      last = match.index + match[0].length;
    }
    if (last < raw.length) {
      container.appendChild(document.createTextNode(raw.slice(last)));
    }
  }

  /** 创建真实 <img> 节点 (图片开启态). 失败时降级为 inline-img-broken 占位. */
  function createImgNode(src) {
    const img = document.createElement('img');
    img.className = 'inline-img';
    img.dataset.src = src;
    img.src = src;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = '[图片]';
    img.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'inline-img-broken';
      fallback.textContent = '[图片加载失败]';
      img.replaceWith(fallback);
    });
    return img;
  }

  /** 创建占位 span (图片关闭态). data-src 留着, 切到开启时一键升级为 <img>. */
  function createImgPlaceholder(src) {
    const span = document.createElement('span');
    span.className = 'inline-img-placeholder';
    span.dataset.src = src;
    span.textContent = '🖼️ 图片';
    return span;
  }

  /**
   * 把 DOM 里所有图片节点同步到当前 imagesEnabled 状态:
   *   开启 → 把 .inline-img-placeholder 替换成 <img>;
   *   关闭 → 把 <img.inline-img> 替换成 .inline-img-placeholder (注意: 已发出的 HTTP 请求
   *           无法撤销 — 但默认就是关闭, 用户主动开过才会有"已加载"的图, 那时再关回去
   *           只是把视觉去掉, 网络流量已经发生, 这是合理的取舍).
   * 同时遍历 inline-img-broken (加载失败占位) — 关闭态下也替换为统一的占位符,
   * 避免视觉杂乱.
   *
   * 选择器不绑 .detail-text 前缀 — 评论 (.comment-body) 里的图也要一起切换, 否则
   * 用户开关图片时正文切了但评论没切, 体感很怪. 类名足够独特, 全局扫无副作用.
   */
  function syncImagesEnabledToDOM() {
    if (imagesEnabled) {
      const placeholders = document.querySelectorAll('.inline-img-placeholder');
      placeholders.forEach((el) => {
        const src = el.dataset && el.dataset.src;
        if (src) el.replaceWith(createImgNode(src));
      });
    } else {
      const imgs = document.querySelectorAll('img.inline-img, .inline-img-broken');
      imgs.forEach((el) => {
        const src = (el.dataset && el.dataset.src) || (el.getAttribute && el.getAttribute('src')) || '';
        if (src) el.replaceWith(createImgPlaceholder(src));
      });
    }
  }

  /** 同步图片开关按钮的视觉状态 (class + 文案). */
  function updateImagesToggleUI() {
    if (!imagesToggleBtn) return;
    imagesToggleBtn.classList.toggle('on', imagesEnabled);
    imagesToggleBtn.textContent = imagesEnabled ? '🖼️ 图片开' : '🖼️ 图片';
    imagesToggleBtn.title = imagesEnabled
      ? '当前: 显示正文图片 — 点击关闭 (摸鱼伪装感)'
      : '当前: 不显示正文图片 (默认, 不发任何请求) — 点击开启';
  }

  /**
   * 把 readerFontScale clamp 到合法区间, 并截到小数点 1 位.
   *
   * 截位的动机: 0.1+0.1+0.1 在 JS 里等于 0.30000000000000004 — 这串塞进 CSS var
   * 也能用, 但 hover tooltip 上显示成 "30.000000000000004%" 太丑.
   */
  function clampReaderFontScale(v) {
    let n = typeof v === 'number' ? v : parseFloat(v);
    if (!Number.isFinite(n)) n = 1;
    if (n < READER_FONT_MIN) n = READER_FONT_MIN;
    if (n > READER_FONT_MAX) n = READER_FONT_MAX;
    return Math.round(n * 10) / 10;
  }

  /**
   * 把当前 readerFontScale 写到 :root 的 CSS var, 并同步 A- / A+ 按钮的
   * disabled 状态 + tooltip 文案 (展示当前百分比).
   *
   * 调用方: ready 下发时 / 用户点 A- A+ 时 / extension 推回灌时.
   */
  function applyReaderFontScale() {
    readerFontScale = clampReaderFontScale(readerFontScale);
    document.documentElement.style.setProperty(
      '--reader-font-scale',
      String(readerFontScale),
    );
    const pct = Math.round(readerFontScale * 100) + '%';
    // 浮点比较留 0.001 余量, 避免按钮在边界值时因精度抖动 enable/disable 反复跳
    const atMin = readerFontScale <= READER_FONT_MIN + 0.001;
    const atMax = readerFontScale >= READER_FONT_MAX - 0.001;
    if (fontSmallerBtn) {
      fontSmallerBtn.title = '缩小阅读字号 (当前 ' + pct + ')';
      fontSmallerBtn.disabled = atMin;
    }
    if (fontLargerBtn) {
      fontLargerBtn.title = '放大阅读字号 (当前 ' + pct + ')';
      fontLargerBtn.disabled = atMax;
    }
  }

  /** 用户点按钮: clamp 后写状态, apply, 持久化 — 已到极值则 no-op */
  function changeReaderFontScale(delta) {
    const next = clampReaderFontScale(readerFontScale + delta);
    if (next === readerFontScale) return;
    readerFontScale = next;
    applyReaderFontScale();
    vscode.postMessage({ type: 'setReaderFontScale', scale: readerFontScale });
  }

  /** 如果分段光标刚好落在 [IMG:url] 中间, 扩到占位符末尾, 避免露出半截文本。 */
  function alignCursorOutsideImagePlaceholder(content, cursor) {
    if (cursor <= 0 || cursor >= content.length) return cursor;
    IMG_PLACEHOLDER_RE.lastIndex = 0;
    let match;
    while ((match = IMG_PLACEHOLDER_RE.exec(content))) {
      const start = match.index;
      const end = start + match[0].length;
      if (cursor > start && cursor < end) return end;
      if (start > cursor) break;
    }
    return cursor;
  }

  // ============================================================
  // 点赞过滤 — 纯前端实现
  // ============================================================
  // 工作方式:
  //   1. 后端推过来的卡片全部 append 到 DOM, 每张卡片在自己的 .card-wrap.dataset.voteCount
  //      上存赞数 (字符串);
  //   2. applyFilter() 一次性扫所有 .card-wrap, 把不在区间内的加 .filtered-out class,
  //      CSS 里 .filtered-out { display:none } —— 不占布局, 不影响滚动距离;
  //   3. 用户改完阈值点 "应用" 触发 readFilterFromInputs + applyFilter, 同时把新阈值
  //      postMessage 到 extension 持久化 (workspaceState);
  //   4. 新批次卡片 append 时, 在循环里就直接判一次 shouldFilterOut, 早点加 class 避免
  //      "先闪现再隐藏" 的视觉跳动.
  // 边界:
  //   - filterStat 展示 "可见 / 总数", 数字以 .card-wrap 总数为基准 (含 filtered-out);
  //   - "加载更多" 按钮逻辑里不参考 filter — 即使当前可见为 0 也允许继续拉, 让用户能
  //     "拉一拉看看下一批有没有合适的"; 实在嫌烦自己清掉过滤即可.

  /** 当前的 vote 值是否需要被过滤掉 */
  function shouldFilterOut(v) {
    const n = typeof v === 'number' ? v : (parseInt(v || '0', 10) || 0);
    if (currentFilter.min > 0 && n < currentFilter.min) return true;
    if (currentFilter.max > 0 && n > currentFilter.max) return true;
    return false;
  }

  /** 重新扫一遍 DOM 应用过滤, 并刷新 filterStat 文案 */
  function applyFilter() {
    const wraps = root.querySelectorAll('.card-wrap');
    let visible = 0;
    for (const w of wraps) {
      const v = parseInt(w.dataset.voteCount || '0', 10) || 0;
      if (shouldFilterOut(v)) {
        w.classList.add('filtered-out');
      } else {
        w.classList.remove('filtered-out');
        visible++;
      }
    }
    if (!filterStat) return;
    const total = wraps.length;
    const filtering = currentFilter.min > 0 || currentFilter.max > 0;
    if (total === 0) {
      filterStat.textContent = '';
    } else if (filtering) {
      filterStat.textContent = visible + ' / ' + total;
    } else {
      filterStat.textContent = total + ' 条';
    }
  }

  /** 把 input.value 解析进 currentFilter (规范化: 空/非法/0 → 不限上界) */
  function readFilterFromInputs() {
    const rawMin = filterMinInput && filterMinInput.value.trim();
    const rawMax = filterMaxInput && filterMaxInput.value.trim();
    let min = rawMin ? parseInt(rawMin, 10) : 0;
    let max = rawMax ? parseInt(rawMax, 10) : -1;
    if (!Number.isFinite(min) || min < 0) min = 0;
    if (!Number.isFinite(max) || max <= 0) max = -1;
    currentFilter = { min: min, max: max };
  }

  /** 把 currentFilter 反向同步到 input (extension 下发持久化值时调用) */
  function setFilterInputsFromCurrent() {
    if (filterMinInput) filterMinInput.value = currentFilter.min > 0 ? String(currentFilter.min) : '';
    if (filterMaxInput) filterMaxInput.value = currentFilter.max > 0 ? String(currentFilter.max) : '';
  }

  if (filterApplyBtn) {
    filterApplyBtn.addEventListener('click', () => {
      readFilterFromInputs();
      applyFilter();
      vscode.postMessage({ type: 'setFilter', filter: currentFilter });
    });
  }
  if (filterClearBtn) {
    filterClearBtn.addEventListener('click', () => {
      currentFilter = { min: 0, max: -1 };
      setFilterInputsFromCurrent();
      applyFilter();
      vscode.postMessage({ type: 'setFilter', filter: currentFilter });
    });
  }
  // 图片开关 click — 立即切状态 + 同步 DOM + 持久化
  if (imagesToggleBtn) {
    imagesToggleBtn.addEventListener('click', () => {
      imagesEnabled = !imagesEnabled;
      updateImagesToggleUI();
      syncImagesEnabledToDOM();
      vscode.postMessage({ type: 'setImagesEnabled', enabled: imagesEnabled });
    });
  }
  // 阅读字号 A- / A+ — 即时改 CSS var, 已展开的卡片/评论会自动跟随;
  // disabled 边界由 applyReaderFontScale 维护, 这里不重复判断.
  if (fontSmallerBtn) {
    fontSmallerBtn.addEventListener('click', () => changeReaderFontScale(-READER_FONT_STEP));
  }
  if (fontLargerBtn) {
    fontLargerBtn.addEventListener('click', () => changeReaderFontScale(READER_FONT_STEP));
  }
  // 初始 apply 一次 — 保证按钮 tooltip / disabled 在收到 readerFontScaleState 前
  // 也跟当前默认值 (1.0) 对齐. extension 下发后再 apply 一次.
  applyReaderFontScale();
  // 回车即应用 (sidebar 太窄, 用户大概率不想再去鼠标点)
  [filterMinInput, filterMaxInput].forEach((inp) => {
    if (!inp) return;
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && filterApplyBtn) {
        ev.preventDefault();
        filterApplyBtn.click();
      }
    });
  });

  // —— filter-bar 高度 → CSS var --filter-bar-h ——
  // 展开的 .card 用这个值做 sticky top, 紧贴 filter-bar 下方. 必须实时跟随:
  //   - filter-bar hidden 切换 (登录态 / 详情页打开): offsetHeight 由 N <-> 0
  //   - vscode 字号变化: filter-bar 实际像素高度会变
  //   - 窗口 resize: 一般不影响高度, 但兜底
  // ResizeObserver 一招覆盖前两种, 安装后会立即回调一次, 不需要再手动调初始值;
  // hidden 切换会触发尺寸 0 <-> N, ResizeObserver 也能正确通知 (实测).
  function syncFilterBarHeight() {
    const h = filterBar && !filterBar.hidden ? filterBar.offsetHeight : 0;
    document.documentElement.style.setProperty('--filter-bar-h', h + 'px');
  }
  if (filterBar) {
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(syncFilterBarHeight).observe(filterBar);
    } else {
      // fallback: 老环境无 ResizeObserver, 至少把当前值算一次
      syncFilterBarHeight();
    }
    window.addEventListener('resize', syncFilterBarHeight);
  }

  // Cookie 失效 banner 内部按钮 — 走和登录卡片同一条路径
  // (vscode.postMessage({ type: 'login' }) → extension 端执行 zhihu.importCookie 命令)
  if (invalidBanner) {
    invalidBanner.addEventListener('click', (e) => {
      const target = e.target;
      if (
        target &&
        target instanceof HTMLElement &&
        target.dataset &&
        target.dataset.act === 'reimport'
      ) {
        vscode.postMessage({ type: 'login' });
      }
    });
  }

  function renderLoginTip() {
    root.innerHTML = '<div class="login-tip">请先登录知乎才能加载推荐流<br/>(本插件不会上传 Cookie, 仅保存在本地 VSCode SecretStorage)<br/><button id="loginBtn">导入 Cookie 登录</button></div>';
    const btn = document.getElementById('loginBtn');
    if (btn) btn.addEventListener('click', () => vscode.postMessage({ type: 'login' }));
    footer.style.display = 'none';
  }

  function renderEmpty(text) {
    root.innerHTML = '<div class="empty">' + escapeHtml(text) + '</div>';
  }

  /**
   * 构造一张卡片 DOM (含 wrap + card + 空 detail). 不挂到任何父节点, 由调用方决定.
   *
   * 提炼这个工厂的动机: feed 流 (renderCardsAppend) 和问题详情页 (appendQuestionAnswers)
   * 两条路径要画的卡片结构完全一致, 唯一差异是 — 详情页里所有卡片都是"回答", kind-tag 重复
   * 显示反而是噪音, 所以加一个 options.hideKindTag 开关. 把两条路径共享的 ~30 行 DOM
   * 拼装收敛到一处, 后续改 card 视觉只需要改一处.
   *
   * @param c             ZhihuCardForView (后端归一化的卡片数据)
   * @param options       { hideKindTag?: boolean }  详情页里传 true
   * @returns             组装好的 wrap 元素 (未挂到 DOM)
   */
  function createCardWrap(c, options) {
    const opts = options || {};
    const hideKindTag = !!opts.hideKindTag;

    const wrap = document.createElement('div');
    wrap.className = 'card-wrap';
    wrap.dataset.url = c.url || '';
    wrap.dataset.kind = c.kind || '';
    wrap.dataset.targetId = c.targetId || '';
    // 把赞数挂到 dataset 上, applyFilter 直接读 — 避免重新询问 extension
    wrap.dataset.voteCount = String(c.voteCount || 0);
    // 仅 kind=回答 时才会有 questionId, 用于"点标题进详情页"; 其它 kind 直接不挂 dataset, dataset 取值时为 undefined
    if (c.questionId) wrap.dataset.questionId = c.questionId;

    // 在 feed 流里, kind=回答 且 拿到 questionId 才把 title 设为可点击 (跳问题详情页);
    // 详情页里所有卡片都是同一个问题, 二级跳转无意义, 故 hideKindTag=true 时不绑 click.
    const titleClickable =
      !hideKindTag && c.kind === '回答' && !!c.questionId;

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = [
      '<div class="card-head">',
        '<span class="card-toggle"></span>',
        hideKindTag ? '' : '<span class="kind-tag">' + escapeHtml(c.kind) + '</span>',
        '<span class="author">',
          c.authorAvatar ? '<img src="' + escapeHtml(c.authorAvatar) + '" referrerpolicy="no-referrer"/>' : '',
          '<span>' + escapeHtml(c.authorName) + '</span>',
        '</span>',
        c.voteCount > 0 ? '<span class="vote">' + formatVote(c.voteCount) + ' 赞</span>' : '',
      '</div>',
      '<h3 class="card-title' + (titleClickable ? ' clickable' : '') + '" title="' + (titleClickable ? '点击查看该问题下的所有回答' : '') + '">' + escapeHtml(c.title) + '</h3>',
      c.excerpt ? '<p class="card-excerpt">' + escapeHtml(c.excerpt) + '</p>' : '',
    ].join('');
    // 点 card 头部 → 展开/折叠; detail 区里的按钮自己 stopPropagation
    card.addEventListener('click', () => toggleExpand(wrap));

    // title 单独绑跳转, stopPropagation 阻止冒泡到 card 触发展开 —
    // 用户体感: 点标题 = "看这个问题"; 点别处 = "看这条回答正文"; 两个意图清晰区分.
    if (titleClickable) {
      const titleEl = card.querySelector('.card-title');
      if (titleEl) {
        titleEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          openQuestionView(c.questionId, c.title);
        });
      }
    }

    const detail = document.createElement('div');
    detail.className = 'card-detail';
    detail.hidden = true;

    wrap.appendChild(card);
    wrap.appendChild(detail);
    return wrap;
  }

  function renderCardsAppend(cards, replace) {
    if (replace) {
      root.innerHTML = '';
      cardsRendered = 0;
      // 刷新后旧的 pendingExpands 仍可能有未到的回包, 让它们自然丢弃即可
    }
    if (cards.length === 0 && cardsRendered === 0) {
      renderEmpty('暂无内容, 试试下拉刷新');
      return;
    }
    for (const c of cards) {
      const wrap = createCardWrap(c, { hideKindTag: false });
      // 当批 append 时就先判一次, 避免新卡片闪现一下再被隐藏
      if (shouldFilterOut(c.voteCount || 0)) {
        wrap.classList.add('filtered-out');
      }
      root.appendChild(wrap);
      cardsRendered += 1;
    }
    // 新批次加完后, 重算一次 stat (个数 / 可见数)
    // 注: shouldFilterOut 在循环里已经按当批应用过 class, 这里主要刷新 filterStat 文本
    applyFilter();
  }

  /** 展开/折叠一张卡片。首次展开会触发正文请求, 后续展开直接复用已缓存的全文。 */
  function toggleExpand(wrap) {
    const detail = wrap.querySelector('.card-detail');
    if (!detail) return;
    const isExpanded = wrap.classList.contains('expanded');
    if (isExpanded) {
      // 折叠: 只切 class, 保留内容缓存, 再次展开可以继续读 (cursor 不重置)
      wrap.classList.remove('expanded');
      detail.hidden = true;
      return;
    }
    wrap.classList.add('expanded');
    detail.hidden = false;

    // 已经加载过正文 → 直接渲染下一段 (或重渲染当前进度)
    if (wrap.dataset.loaded === 'done') {
      renderDetailChunk(wrap);
      return;
    }
    // 正在加载中 → 不重复发请求
    if (wrap.dataset.loaded === 'loading') {
      return;
    }
    // 首次展开 → 发请求
    wrap.dataset.loaded = 'loading';
    detail.innerHTML = '<div class="detail-loading"><span class="spinner"></span>正在加载正文...</div>';
    const reqId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    wrap.dataset.reqId = reqId;
    pendingExpands[reqId] = wrap;
    vscode.postMessage({
      type: 'expand',
      reqId: reqId,
      kind: wrap.dataset.kind,
      targetId: wrap.dataset.targetId,
    });
  }

  /**
   * 把 wrap.dataset.content 按 chunkSize 切片, 渲染当前已读光标之前的内容。
   *
   * 关键: 每次点"继续阅读"只往后推 chunkSize 个字符, 不一次性显示全部 —
   *      这才是用户要的"避免回答太长看着烦"的体验。
   */
  function renderDetailChunk(wrap) {
    const detail = wrap.querySelector('.card-detail');
    if (!detail) return;
    const content = wrap.dataset.content || '';
    let cursor = parseInt(wrap.dataset.cursor || '0', 10);
    if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;

    // 第一次展开 cursor=0 → 至少推一段; 之后每点一次 +chunkSize。
    // 如果正好切进 [IMG:url] 占位符中间, 扩到占位符尾部, 让图片一次性可渲染。
    cursor = alignCursorOutsideImagePlaceholder(
      content,
      Math.min(content.length, cursor + chunkSize),
    );
    wrap.dataset.cursor = String(cursor);

    const visibleText = content.slice(0, cursor);
    const remaining = content.length - cursor;

    detail.innerHTML = '';
    const text = document.createElement('div');
    text.className = 'detail-text';
    renderTextWithImages(text, visibleText);
    detail.appendChild(text);

    const actions = document.createElement('div');
    actions.className = 'detail-actions';

    if (remaining > 0) {
      const more = document.createElement('button');
      more.className = 'detail-btn';
      more.type = 'button';
      more.textContent = '继续阅读';
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        renderDetailChunk(wrap);
      });
      actions.appendChild(more);
    } else if (content.length > 0) {
      const done = document.createElement('span');
      done.className = 'detail-progress';
      done.textContent = '— 已读完 —';
      actions.appendChild(done);
    }

    // 视频类型/未知类型本质上没有可读评论 (zvideo 评论接口存在但很冷清, 且 UI 上"视频"卡片
    // 用户更多是关掉而不是聊天), 这里"想法/回答/文章"才挂评论按钮。
    const kind = wrap.dataset.kind || '';
    if (kind === '回答' || kind === '文章' || kind === '想法') {
      const cmtBtn = document.createElement('button');
      cmtBtn.className = 'detail-btn secondary';
      cmtBtn.type = 'button';
      // 已加载过评论后, 按钮文案变为"显示/隐藏评论"; 第一次不知道总数, 不加 N
      const totals = parseInt(wrap.dataset.commentsTotal || '-1', 10);
      const loaded = wrap.dataset.commentsLoaded === 'done';
      const visible = wrap.dataset.commentsVisible === '1';
      cmtBtn.textContent = loaded
        ? (visible ? '隐藏评论' : '显示评论' + (totals >= 0 ? ' (' + totals + ')' : ''))
        : '查看评论';
      cmtBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleComments(wrap);
      });
      actions.appendChild(cmtBtn);
    }

    if (remaining > 0 && content.length > 0) {
      const progress = document.createElement('span');
      progress.className = 'detail-progress';
      progress.textContent = cursor + ' / ' + content.length + ' 字  (剩余 ' + remaining + ')';
      actions.appendChild(progress);
    }

    detail.appendChild(actions);

    // 评论区容器: 与正文同级挂在 detail 末尾, 由 toggleComments 控制 hidden
    // 容器从一开始就建好, 用户首次点击时再去 fetch — 后续展开/收起只切 hidden, DOM 不重建
    let section = wrap.querySelector('.comments-section');
    if (!section) {
      section = document.createElement('div');
      section.className = 'comments-section';
      section.hidden = true;
    } else if (section.parentElement) {
      // 之前可能已经渲染过, 重渲 detail 时把它从老位置摘下来重新挂尾部, 避免被 detail.innerHTML='' 误删
      section.parentElement.removeChild(section);
    }
    detail.appendChild(section);
  }

  /**
   * 切换评论区的显示/加载。首次点击触发 fetch, 后续点击只切 hidden。
   *
   * 三种状态记录在 wrap.dataset 里:
   *   - commentsLoaded:  '' | 'loading' | 'done'
   *   - commentsVisible: '' | '1'
   *   - commentsOffset:  下一次 fetch 的 offset (字符串)
   *   - commentsEnd:     '1' 表示 server 已 is_end
   *   - commentsTotal:   server 给的 totals (-1 表示没拿到)
   */
  function toggleComments(wrap) {
    const section = wrap.querySelector('.comments-section');
    if (!section) return;
    if (wrap.dataset.commentsLoaded === 'done') {
      const visible = wrap.dataset.commentsVisible === '1';
      wrap.dataset.commentsVisible = visible ? '' : '1';
      section.hidden = visible;
      // 重新渲染 actions 以更新按钮文案 ("显示评论"/"隐藏评论")
      refreshDetailActions(wrap);
      return;
    }
    if (wrap.dataset.commentsLoaded === 'loading') return;

    wrap.dataset.commentsLoaded = 'loading';
    wrap.dataset.commentsVisible = '1';
    section.hidden = false;
    section.innerHTML = '<div class="comments-loading"><span class="spinner"></span>正在加载评论...</div>';

    const reqId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    pendingComments[reqId] = wrap;
    wrap.dataset.commentsOffset = '0';
    vscode.postMessage({
      type: 'comments',
      reqId: reqId,
      kind: wrap.dataset.kind,
      targetId: wrap.dataset.targetId,
      offset: 0,
    });
    refreshDetailActions(wrap);
  }

  /** 不重渲整个 detail, 只把 actions 区拆掉重建 — 用于评论按钮文案变化 */
  function refreshDetailActions(wrap) {
    const detail = wrap.querySelector('.card-detail');
    if (!detail) return;
    // 简单做法: 把 cursor 回退一段然后重渲 → 但这会让用户看到的字数倒退;
    // 改成只重画 actions, 复用现有的 detail-text / comments-section
    const oldActions = detail.querySelector('.detail-actions');
    if (!oldActions) return;
    // 直接调 renderDetailChunk 不行 (它会 +chunkSize), 这里手工只更新评论按钮文字
    const btns = oldActions.querySelectorAll('button.detail-btn.secondary');
    btns.forEach((b) => {
      if (b.textContent && (b.textContent.indexOf('评论') >= 0)) {
        const totals = parseInt(wrap.dataset.commentsTotal || '-1', 10);
        const loaded = wrap.dataset.commentsLoaded === 'done';
        const visible = wrap.dataset.commentsVisible === '1';
        b.textContent = loaded
          ? (visible ? '隐藏评论' : '显示评论' + (totals >= 0 ? ' (' + totals + ')' : ''))
          : '查看评论';
      }
    });
  }

  /**
   * 渲染一条评论 (根评论或子评论) 为 DOM 元素。
   *
   * @param c       归一化后的 ZhihuCommentForView
   * @param isChild true 时走子评论 (回复) 的轻量样式, 不再挂"查看回复"按钮 — 二级以上不展开
   *
   * 历史: 之前根评论的渲染是用 head.innerHTML 字符串 join 出来的, 但加了 "查看回复" 按钮后
   * meta 区需要混合 text 节点 + button 节点, 字符串拼接搞不定 (要么 button 失去 click handler,
   * 要么得用 querySelector 二次抓 button 重新绑事件), 所以这里改成纯 DOM 构建. 顺手把根/子
   * 评论的渲染合并到一处.
   */
  function renderCommentItem(c, isChild) {
    const item = document.createElement('div');
    item.className = isChild ? 'child-comment-item' : 'comment-item';
    if (c.id) item.dataset.commentId = String(c.id);

    // —— 头部: 头像 + 作者 + 简介 + 时间 ——
    const head = document.createElement('div');
    head.className = 'comment-head';
    head.innerHTML = [
      c.authorAvatar ? '<img src="' + escapeHtml(c.authorAvatar) + '" referrerpolicy="no-referrer"/>' : '',
      '<span class="comment-author">' + escapeHtml(c.authorName || '匿名用户') + '</span>',
      c.authorHeadline && !isChild
        ? '<span class="comment-headline">' + escapeHtml(c.authorHeadline) + '</span>'
        : '<span class="comment-headline"></span>',
      c.createdAt ? '<span class="comment-time">' + escapeHtml(c.createdAt) + '</span>' : '',
    ].join('');
    item.appendChild(head);

    // —— 回复对象 (仅子评论可能有) ——
    if (c.replyTo) {
      const r = document.createElement('div');
      r.className = 'comment-reply-to';
      r.textContent = c.replyTo;
      item.appendChild(r);
    }

    // —— 正文 ——
    // 走 renderTextWithImages 而不是 textContent — c.content 里可能含 [IMG:url] 占位符
    // (后端 toCommentView 用 stripHtmlPreserveBreaks(_, true) 保留的). 走占位符渲染
    // 才能让评论里的图片按当前 imagesEnabled 状态出图或显示 "🖼️ 图片" 占位.
    // 注意: 没图的评论里这条 helper 退化成只创建一个 textNode, 跟原 textContent 等价.
    const body = document.createElement('div');
    body.className = 'comment-body';
    renderTextWithImages(body, c.content || '');
    item.appendChild(body);

    // —— meta: 点赞 + 回复按钮 ——
    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    let metaHasContent = false;
    if (typeof c.voteCount === 'number' && c.voteCount > 0) {
      const vote = document.createElement('span');
      vote.textContent = '❤ ' + formatVote(c.voteCount);
      meta.appendChild(vote);
      metaHasContent = true;
    }
    if (typeof c.childCount === 'number' && c.childCount > 0) {
      if (!isChild) {
        // 根评论: 把 "N 条回复" 做成可点击按钮, 触发 toggleChildComments
        item.dataset.childCount = String(c.childCount);
        const replyBtn = document.createElement('button');
        replyBtn.className = 'comment-replies-toggle';
        replyBtn.type = 'button';
        replyBtn.textContent = '查看 ' + c.childCount + ' 条回复';
        replyBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          toggleChildComments(item);
        });
        meta.appendChild(replyBtn);
      } else {
        // 子评论也可能有自己的回复, 但只显示数字, 不再展开 (避免楼中楼撑爆侧栏)
        const sub = document.createElement('span');
        sub.textContent = c.childCount + ' 条回复';
        meta.appendChild(sub);
      }
      metaHasContent = true;
    }
    if (metaHasContent) item.appendChild(meta);

    // —— 根评论挂一个 hidden 的子评论容器, 首次点 "查看回复" 才填充 ——
    if (!isChild) {
      const cs = document.createElement('div');
      cs.className = 'child-comments-section';
      cs.hidden = true;
      item.appendChild(cs);
    }

    return item;
  }

  /** 把一页评论 append 到评论区, 维护 offset/end 状态 */
  function appendComments(wrap, page) {
    const section = wrap.querySelector('.comments-section');
    if (!section) return;
    const comments = Array.isArray(page.comments) ? page.comments : [];
    const totals = typeof page.totals === 'number' ? page.totals : -1;
    const isEnd = !!page.isEnd;

    // 首次回包: 清掉 loading, 建 header + list 骨架
    let list = section.querySelector('.comments-list');
    if (!list) {
      section.innerHTML = '';
      const header = document.createElement('div');
      header.className = 'comments-header';
      header.textContent = totals >= 0 ? '评论 (' + totals + ')' : '评论';
      section.appendChild(header);
      list = document.createElement('div');
      list.className = 'comments-list';
      section.appendChild(list);
    }

    if (comments.length === 0 && !list.firstChild) {
      // 真的没评论
      const empty = document.createElement('div');
      empty.className = 'comments-empty';
      empty.textContent = '暂无评论';
      section.appendChild(empty);
    }

    for (const c of comments) {
      list.appendChild(renderCommentItem(c, false));
    }

    // 推进 offset, 这里用 list 子节点数为准 (server 偶尔 limit 不严格)
    const newOffset = list.children.length;
    wrap.dataset.commentsOffset = String(newOffset);
    if (totals >= 0) wrap.dataset.commentsTotal = String(totals);

    // actions 区: 重建 "加载更多" / "已到底" 按钮
    let actions = section.querySelector('.comments-actions');
    if (actions) actions.remove();
    actions = document.createElement('div');
    actions.className = 'comments-actions';
    if (isEnd) {
      wrap.dataset.commentsEnd = '1';
      if (list.children.length > 0) {
        const done = document.createElement('span');
        done.className = 'comment-meta';
        done.style.margin = '0';
        done.textContent = '— 已加载全部评论 —';
        actions.appendChild(done);
      }
    } else {
      const more = document.createElement('button');
      more.className = 'detail-btn';
      more.type = 'button';
      more.textContent = '加载更多评论';
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        loadMoreComments(wrap);
      });
      actions.appendChild(more);
    }
    section.appendChild(actions);

    wrap.dataset.commentsLoaded = 'done';
    refreshDetailActions(wrap);
  }

  function loadMoreComments(wrap) {
    if (wrap.dataset.commentsEnd === '1') return;
    const section = wrap.querySelector('.comments-section');
    if (!section) return;
    const oldActions = section.querySelector('.comments-actions');
    if (oldActions) oldActions.innerHTML = '<span class="comments-loading"><span class="spinner"></span>加载中...</span>';
    const offset = parseInt(wrap.dataset.commentsOffset || '0', 10) || 0;
    const reqId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    pendingComments[reqId] = wrap;
    vscode.postMessage({
      type: 'comments',
      reqId: reqId,
      kind: wrap.dataset.kind,
      targetId: wrap.dataset.targetId,
      offset: offset,
    });
  }

  // ---------- 子评论 (回复) ----------
  //
  // 跟根评论同构, 状态机记录在 .comment-item 的 dataset 里:
  //   - commentId:   根评论 id (renderCommentItem 时写入)
  //   - childCount:  初始的 c.childCount (用于按钮上的总数显示)
  //   - childLoaded: '' | 'loading' | 'done'
  //   - childVisible:'' | '1'
  //   - childOffset: 下一次 fetch 的 offset
  //   - childEnd:    '1' 表示 server 已 is_end
  //   - childTotal:  server 回包给的 totals (-1 表示没拿到)
  //
  // pendingChildComments 按 reqId 路由回 item.

  function toggleChildComments(item) {
    const section = item.querySelector('.child-comments-section');
    if (!section) return;

    // 已加载过: toggle 显隐, DOM 不重建
    if (item.dataset.childLoaded === 'done') {
      const visible = item.dataset.childVisible === '1';
      item.dataset.childVisible = visible ? '' : '1';
      section.hidden = visible;
      refreshRepliesToggle(item);
      return;
    }
    if (item.dataset.childLoaded === 'loading') return;

    // 首次加载
    const rootCommentId = item.dataset.commentId || '';
    if (!rootCommentId) return;
    item.dataset.childLoaded = 'loading';
    item.dataset.childVisible = '1';
    item.dataset.childOffset = '0';
    section.hidden = false;
    section.innerHTML = '<div class="comments-loading"><span class="spinner"></span>正在加载回复...</div>';

    const reqId = 'cc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    pendingChildComments[reqId] = item;
    vscode.postMessage({
      type: 'childComments',
      reqId: reqId,
      rootCommentId: rootCommentId,
      offset: 0,
    });
    refreshRepliesToggle(item);
  }

  /** 只更新 .comment-replies-toggle 按钮文案, 不触碰其他 DOM */
  function refreshRepliesToggle(item) {
    const btn = item.querySelector('button.comment-replies-toggle');
    if (!btn) return;
    const childCount = parseInt(item.dataset.childCount || '0', 10) || 0;
    const total = parseInt(item.dataset.childTotal || '-1', 10);
    const loaded = item.dataset.childLoaded === 'done';
    const visible = item.dataset.childVisible === '1';
    const loading = item.dataset.childLoaded === 'loading';
    if (loading) {
      btn.textContent = '加载回复中...';
    } else if (loaded) {
      // server 给的 totals 比初始 childCount 更准 (childCount 可能滞后)
      const n = total >= 0 ? total : childCount;
      btn.textContent = visible ? '收起回复' : '展开 ' + n + ' 条回复';
    } else {
      btn.textContent = '查看 ' + childCount + ' 条回复';
    }
  }

  function appendChildComments(item, page) {
    const section = item.querySelector('.child-comments-section');
    if (!section) return;
    const replies = Array.isArray(page.comments) ? page.comments : [];
    const totals = typeof page.totals === 'number' ? page.totals : -1;
    const isEnd = !!page.isEnd;

    // 首次回包: 清掉 loading, 建 list 骨架 (子评论没有 header, 直接列表)
    let list = section.querySelector('.child-comments-list');
    if (!list) {
      section.innerHTML = '';
      list = document.createElement('div');
      list.className = 'child-comments-list';
      section.appendChild(list);
    }

    if (replies.length === 0 && !list.firstChild) {
      const empty = document.createElement('div');
      empty.className = 'comments-empty';
      empty.textContent = '暂无回复';
      section.appendChild(empty);
    }

    for (const c of replies) {
      list.appendChild(renderCommentItem(c, true));
    }

    item.dataset.childOffset = String(list.children.length);
    if (totals >= 0) item.dataset.childTotal = String(totals);

    // actions 区: 加载更多 / 已到底
    let actions = section.querySelector('.child-comments-actions');
    if (actions) actions.remove();
    if (isEnd) {
      item.dataset.childEnd = '1';
      // 子评论列表到底时不再显示 "—— 已加载全部 ——", 已经有左侧色条作为视觉收尾
    } else {
      actions = document.createElement('div');
      actions.className = 'child-comments-actions';
      const more = document.createElement('button');
      more.className = 'detail-btn secondary';
      more.type = 'button';
      more.textContent = '加载更多回复';
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        loadMoreChildComments(item);
      });
      actions.appendChild(more);
      section.appendChild(actions);
    }

    item.dataset.childLoaded = 'done';
    refreshRepliesToggle(item);
  }

  function loadMoreChildComments(item) {
    if (item.dataset.childEnd === '1') return;
    const section = item.querySelector('.child-comments-section');
    if (!section) return;
    const oldActions = section.querySelector('.child-comments-actions');
    if (oldActions) {
      oldActions.innerHTML = '<span class="comments-loading"><span class="spinner"></span>加载中...</span>';
    }
    const offset = parseInt(item.dataset.childOffset || '0', 10) || 0;
    const rootCommentId = item.dataset.commentId || '';
    if (!rootCommentId) return;
    const reqId = 'cc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    pendingChildComments[reqId] = item;
    vscode.postMessage({
      type: 'childComments',
      reqId: reqId,
      rootCommentId: rootCommentId,
      offset: offset,
    });
  }

  function formatVote(n) {
    if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  /**
   * 触发"加载下一批" — 状态防抖 + 状态机更新.
   * 同时被 IntersectionObserver / 手动点 footer / scroll fallback 三个入口调用.
   */
  function triggerLoadMore() {
    if (!loggedIn || loading || reachedEnd) return;
    // 详情页打开时, feed 流的 IntersectionObserver 仍可能因为布局滚动而 fire,
    // 但此时用户语义是"看这个问题的回答", 不应该触发 feed 加载. 详情页关闭后再恢复.
    if (currentQuestion) return;
    // 立刻把 footer 切到 loading 态, 避免观察器多次触发时连发请求
    loading = true;
    renderFooter();
    vscode.postMessage({ type: 'loadMore' });
  }

  /**
   * 根据 loggedIn / loading / reachedEnd / cardsRendered 4 个状态渲染 footer.
   *
   * 设计取舍:
   *   - 未登录: 隐藏 (整个列表区已经被 login-tip 顶替了)
   *   - 已到底: 显示 "已经到底了" 文案, 不再可点
   *   - 加载中: spinner, 不可点 (避免连点)
   *   - 空闲态: 显示 "加载更多" 按钮 (这就是 feed 流的兜底 — sidebar 滚不动也有这条路)
   *
   * footer 始终保留在 DOM 中, 给 IntersectionObserver 一个稳定的观察目标.
   */
  function renderFooter() {
    if (!loggedIn) {
      footer.style.display = 'none';
      return;
    }
    footer.style.display = 'block';
    if (reachedEnd) {
      footer.innerHTML = '— 已经到底了 —';
      return;
    }
    if (loading) {
      footer.innerHTML = '<span class="spinner"></span>加载中...';
      return;
    }
    if (cardsRendered === 0) {
      // 还没渲染过任何卡片 (登录后/刷新后首屏未到), 显示 spinner 而不是 "加载更多" 按钮
      // —— 避免给人 "什么都没有但又能点" 的误导感
      footer.innerHTML = '<span class="spinner"></span>加载中...';
      return;
    }
    // 空闲 + 已有内容 + 未到底 → 显示可点的 "加载更多"
    footer.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'detail-btn';
    btn.type = 'button';
    btn.textContent = '加载更多';
    btn.style.cssText = 'padding:6px 16px;';
    btn.addEventListener('click', triggerLoadMore);
    footer.appendChild(btn);
  }

  // ============================================================
  // 问题详情页 —— 点击 feed 流"回答"卡片标题 → 展示该问题下所有回答
  // ============================================================
  // 设计点:
  //   - 与 feed 流同源同构: 答案 card 复用 createCardWrap, 因此 展开/评论/子评论 全部交互
  //     "免费"复用 — 详情页里点开一个答案的展开和点开 feed 流答案是同一段代码;
  //   - 视图切换用 hidden / display, feed 流的 DOM 不动, 返回即原状 (滚动位置, 已展开卡片);
  //   - 详情页独立的 questionFooter 也接 IntersectionObserver, 滚到底自动续拉, 同 feed 流体验;
  //   - 同时只能有一个详情页打开 (currentQuestion 单例); 切问题就是关老的开新的, 当前 reqId
  //     用于过滤"切完详情页之后才到的旧请求回包", 防止串台.
  //
  // currentQuestion 状态机:
  //   { id, title, offset, isEnd, loading, reqId, rendered }
  //   - id:       当前问题 id
  //   - title:    入口卡片传过来的标题 (兜底), server 回包后会被更准的覆盖
  //   - offset:   下一次 fetch 的 offset (基于已渲染的答案数累加)
  //   - isEnd:    是否到底
  //   - loading:  是否有 in-flight 请求 (防抖)
  //   - reqId:    最近一次请求 id, 用于路由回包 (旧 reqId 的回包直接丢)
  //   - rendered: 已渲染的答案数 (用于判断是否是首屏)

  const questionView = document.getElementById('questionView');
  const questionList = document.getElementById('questionList');
  const questionFooter = document.getElementById('questionFooter');
  const questionTitleEl = document.getElementById('questionTitle');
  const questionBackBtn = document.getElementById('questionBack');

  /** @type {{id:string,title:string,offset:number,isEnd:boolean,loading:boolean,reqId:string,rendered:number,totals:number}|null} */
  let currentQuestion = null;

  /**
   * 进入详情页前的 feed 流滚动位置, 返回时恢复.
   *
   * 为什么用外部变量而不是挂到 currentQuestion 上:
   *   closeQuestionView 里会先把 currentQuestion 置 null 再恢复 scroll,
   *   挂在对象上反而绕一圈. 直接全局 let 一个数字最简洁.
   *
   * 初值 0 — 用户首次进详情页时 feed 还没滚动, 0 也是对的.
   */
  let savedFeedScrollY = 0;

  /**
   * 统一管理 filter-bar 的可见性 + 详情页态:
   *   - 未登录:       整条 hidden (root 是登录提示, 显示筛选条没意义)
   *   - 已登录非详情: 整条显示, 移除 in-question class
   *   - 已登录详情:   整条显示, 加 in-question class (CSS 隐藏 .feed-only 元素,
   *                  保留 图片开关 / A- / A+ 三个跨场景按钮)
   * 任何切换 currentQuestion 或 loggedIn 的地方都应只调这一个函数, 避免散落多处 hidden=...
   * 出现状态不一致.
   */
  function syncFilterBarVisibility() {
    if (!filterBar) return;
    filterBar.hidden = !loggedIn;
    filterBar.classList.toggle('in-question', !!currentQuestion);
  }

  /** 打开问题详情页 — 由 card-title click 触发 */
  function openQuestionView(questionId, questionTitle) {
    if (!questionId) return;
    // 保存 feed 当前滚动位置, 关闭详情页时恢复 — 之前是直接 scrollTo(0,0)
    // 导致用户从 feed 中段进详情页, 返回后回到最顶端要重新一直翻, 体验劝退.
    savedFeedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
    root.style.display = 'none';
    footer.style.display = 'none';
    questionView.hidden = false;
    // filterBar 不再整条 hidden, 改为加 in-question class — 这样图片开关 / A- / A+
    // 在详情页里仍然可见可点 (它们 *不* 带 feed-only class).
    syncFilterBarVisibility();
    questionTitleEl.textContent = questionTitle || '问题';
    questionList.innerHTML = '<div class="empty">正在加载该问题下的回答...</div>';
    questionFooter.innerHTML = '';
    // 详情页本身从顶部开始读 (sidebar 太窄, 用户从 feed 中段进详情页时不希望被滚下去)
    window.scrollTo(0, 0);

    const reqId = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    currentQuestion = {
      id: questionId,
      title: questionTitle || '',
      offset: 0,
      isEnd: false,
      loading: true,
      reqId: reqId,
      rendered: 0,
      totals: -1,
    };
    renderQuestionFooter();
    vscode.postMessage({
      type: 'openQuestion',
      reqId: reqId,
      questionId: questionId,
    });
  }

  /** 关闭详情页, 还原 feed 流视图 + feed 滚动位置 */
  function closeQuestionView() {
    questionView.hidden = true;
    currentQuestion = null;
    root.style.display = '';
    renderFooter();
    // 同步 filterBar: 已登录时整条显示, 移除 in-question 让 feed-only 元素恢复可见.
    syncFilterBarVisibility();
    // 恢复 feed 滚动位置 — 必须等 root 从 display:none 切回来、布局算完, 才能
    // scrollTo 到目标 Y (否则 documentElement 高度还没回来, scroll 会被 clamp 到 0).
    // 双 rAF 比单层 rAF 更稳: 单层在某些 vscode webview 渲染节奏下会赶不上首帧 layout.
    const target = savedFeedScrollY;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.scrollTo(0, target);
      });
    });
  }

  if (questionBackBtn) {
    questionBackBtn.addEventListener('click', () => closeQuestionView());
  }

  /** 根据 currentQuestion 状态渲染详情页 footer (加载中 / 加载更多 / 已到底) */
  function renderQuestionFooter() {
    if (!currentQuestion) {
      questionFooter.innerHTML = '';
      return;
    }
    if (currentQuestion.loading) {
      questionFooter.innerHTML = '<span class="spinner"></span>加载中...';
      return;
    }
    if (currentQuestion.isEnd) {
      questionFooter.innerHTML = currentQuestion.rendered > 0
        ? '— 已加载全部回答 —'
        : '该问题暂无可显示的回答';
      return;
    }
    // 空闲态: 显示"加载更多"按钮 (IntersectionObserver 也能自动触发, 此处是手动 fallback)
    questionFooter.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'detail-btn';
    btn.type = 'button';
    btn.textContent = '加载更多回答';
    btn.style.cssText = 'padding:6px 16px;';
    btn.addEventListener('click', loadMoreQuestionAnswers);
    questionFooter.appendChild(btn);
  }

  function loadMoreQuestionAnswers() {
    if (!currentQuestion || currentQuestion.loading || currentQuestion.isEnd) return;
    currentQuestion.loading = true;
    const reqId = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    currentQuestion.reqId = reqId;
    renderQuestionFooter();
    vscode.postMessage({
      type: 'loadMoreQuestionAnswers',
      reqId: reqId,
      questionId: currentQuestion.id,
      offset: currentQuestion.offset,
    });
  }

  /** 处理 'questionAnswersPage' 回包 — append 答案卡片到详情页列表 */
  function appendQuestionAnswers(page) {
    if (!currentQuestion) return;
    const cards = Array.isArray(page.cards) ? page.cards : [];
    const isEnd = !!page.isEnd;
    const totals = typeof page.totals === 'number' ? page.totals : -1;

    // 首次回包: 标题里追加 "(N 个回答)", 用 server 给的更准
    if (currentQuestion.rendered === 0) {
      if (page.questionTitle) currentQuestion.title = page.questionTitle;
      if (totals >= 0) currentQuestion.totals = totals;
      const t = currentQuestion.title || '问题';
      questionTitleEl.textContent = currentQuestion.totals >= 0
        ? t + '  '
        : t;
      if (currentQuestion.totals >= 0) {
        const meta = document.createElement('span');
        meta.className = 'question-meta';
        meta.textContent = '(' + currentQuestion.totals + ' 个回答)';
        questionTitleEl.appendChild(meta);
      }
      // 清掉 "正在加载该问题下的回答..." 占位
      questionList.innerHTML = '';
    }

    if (cards.length === 0 && currentQuestion.rendered === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '该问题暂无可显示的回答';
      questionList.appendChild(empty);
    } else {
      for (const c of cards) {
        const wrap = createCardWrap(c, { hideKindTag: true });
        questionList.appendChild(wrap);
        currentQuestion.rendered += 1;
      }
    }

    // 推进 offset — 用累计 rendered 数, 比简单 +cards.length 更鲁棒 (即便接口偶尔少返一条也对齐)
    currentQuestion.offset = currentQuestion.rendered;
    currentQuestion.isEnd = isEnd;
    currentQuestion.loading = false;
    renderQuestionFooter();
  }

  /** 详情页里某次拉取报错 — 首次失败 vs 翻页失败 文案/位置不同 */
  function handleQuestionAnswersError(message) {
    if (!currentQuestion) return;
    currentQuestion.loading = false;
    const isFirst = currentQuestion.rendered === 0;
    const text = '加载失败: ' + (message || '未知错误');
    if (isFirst) {
      // 首次失败: 整个列表区显示错误 + 重试
      questionList.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'detail-error';
      err.style.padding = '24px 16px';
      err.textContent = text;
      questionList.appendChild(err);
      const actions = document.createElement('div');
      actions.style.cssText = 'padding:0 16px 24px;';
      const retry = document.createElement('button');
      retry.className = 'detail-btn';
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', () => {
        const id = currentQuestion.id;
        const title = currentQuestion.title;
        openQuestionView(id, title);
      });
      actions.appendChild(retry);
      questionList.appendChild(actions);
      questionFooter.innerHTML = '';
    } else {
      // 翻页失败: 列表保留, footer 显示错误 + 重试
      questionFooter.innerHTML = '';
      const err = document.createElement('span');
      err.style.cssText =
        'color:var(--vscode-errorForeground, var(--vscode-descriptionForeground));margin-right:8px;';
      err.textContent = text;
      const retry = document.createElement('button');
      retry.className = 'detail-btn';
      retry.type = 'button';
      retry.textContent = '重试';
      retry.addEventListener('click', loadMoreQuestionAnswers);
      questionFooter.appendChild(err);
      questionFooter.appendChild(retry);
    }
  }

  // IntersectionObserver: footer 进入视口就 loadMore
  // 比 window.scroll 阈值更靠谱 — sidebar webview 里 documentElement 经常不滚,
  // 而 IntersectionObserver 走的是布局比较, 元素只要进视口就 fire, 跟谁负责滚没关系.
  // rootMargin 留 200px 缓冲, 让"快滚到底"就先预拉, 提升体感
  const ioFooter = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          triggerLoadMore();
          break;
        }
      }
    },
    { root: null, rootMargin: '200px 0px', threshold: 0 },
  );
  ioFooter.observe(footer);

  // 详情页 footer 的自动加载 — 跟 feed 流同套机制
  const ioQuestionFooter = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (
          e.isIntersecting &&
          currentQuestion &&
          !currentQuestion.loading &&
          !currentQuestion.isEnd
        ) {
          loadMoreQuestionAnswers();
          break;
        }
      }
    },
    { root: null, rootMargin: '200px 0px', threshold: 0 },
  );
  ioQuestionFooter.observe(questionFooter);

  // 兜底: 仍然保留 window scroll 监听 — IntersectionObserver 在 webview 里
  // 极少数环境 (老内核) 可能不稳, 双保险.
  window.addEventListener('scroll', () => {
    if (!loggedIn || loading || reachedEnd) return;
    const remaining = document.documentElement.scrollHeight
      - window.innerHeight
      - window.scrollY;
    if (remaining < 100) {
      triggerLoadMore();
    }
  });

  // 接收 extension 消息
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'config': {
        // chunkSize 在 ready 之后下发, 实测可能在第一个 card 渲染完之前到, 也可能在之后到,
        // 都不影响 — toggleExpand/renderDetailChunk 用的是这里读的实时值
        if (typeof msg.chunkSize === 'number' && msg.chunkSize > 0) {
          chunkSize = msg.chunkSize;
        }
        return;
      }
      case 'filterState': {
        // extension 端持久化的过滤区间下发 — ready 后下发一次, 之后用户每次改完
        // 也是单向 webview → extension (postMessage), 不需要回灌, 但保留这条路径
        // 方便未来 settings 变更等异步刷新场景.
        if (msg.filter && typeof msg.filter === 'object') {
          const f = msg.filter;
          currentFilter = {
            min: typeof f.min === 'number' && f.min > 0 ? f.min : 0,
            max: typeof f.max === 'number' && f.max > 0 ? f.max : -1,
          };
          setFilterInputsFromCurrent();
          applyFilter();
        }
        return;
      }
      case 'imagesState': {
        // 图片开关持久化值下发 — ready 后下发一次. 收到后同步 UI + DOM
        // (DOM 此时一般还没卡片, syncImagesEnabledToDOM 是 no-op; 但若 retainContextWhenHidden
        // 下用户切走再回来, 卡片已存在, 这里就能正确刷一遍).
        imagesEnabled = msg.enabled === true;
        updateImagesToggleUI();
        syncImagesEnabledToDOM();
        return;
      }
      case 'readerFontScaleState': {
        // 阅读字号持久化值下发 — ready 后下发一次. clamp 后写到 CSS var,
        // 所有现存 .detail-text / .comment-body 因为用了 calc(* var(--reader-font-scale))
        // 会自动重排, 不需要遍历 DOM.
        readerFontScale = typeof msg.scale === 'number' ? msg.scale : 1;
        applyReaderFontScale();
        return;
      }
      case 'loginState':
        loggedIn = !!msg.loggedIn;
        // 未登录时整条过滤条隐藏 — 此时 root 里只有一个登录提示, 显示筛选条没意义.
        // 同时如果在详情页里掉线, 强制关闭详情页 (登录提示需要回到 feed 流视图)
        if (!loggedIn) {
          if (currentQuestion) closeQuestionView();
          renderLoginTip();
        } else if (cardsRendered === 0) {
          renderEmpty('加载中...');
        }
        // filterBar 可见性统一由 syncFilterBarVisibility 处理 (含未登录/详情页态),
        // 避免散落多处 hidden=... 出现状态不一致 (例如忘了同步 in-question class).
        syncFilterBarVisibility();
        renderFooter();
        return;
      case 'cookieValidity':
        // Cookie 失效状态变化 → 切 banner 显隐. 未登录态下 extension 端
        // 已通过 isCookieKnownInvalid() 的 isLoggedIn 守卫保证 invalid=false,
        // 所以这里直接信 msg.invalid 即可, 不需要再叠 loggedIn 判断.
        if (invalidBanner) invalidBanner.hidden = !msg.invalid;
        return;
      case 'loading':
        loading = !!msg.loading;
        renderFooter();
        return;
      case 'cards':
        renderCardsAppend(msg.cards || [], !!msg.replace);
        renderFooter();
        return;
      case 'reachEnd':
        reachedEnd = true;
        renderFooter();
        return;
      case 'content': {
        // 正文回包: 把内容缓存到 wrap 上, 然后渲染第一段
        const wrap = pendingExpands[msg.reqId];
        if (wrap) {
          delete pendingExpands[msg.reqId];
          wrap.dataset.loaded = 'done';
          wrap.dataset.content = typeof msg.content === 'string' ? msg.content : '';
          wrap.dataset.cursor = '0';
          // 用户可能在等待期间又点了折叠 → 折叠态也存好缓存, 不强制展开
          if (wrap.classList.contains('expanded')) {
            renderDetailChunk(wrap);
          }
        }
        return;
      }
      case 'contentError': {
        const wrap = pendingExpands[msg.reqId];
        if (wrap) {
          delete pendingExpands[msg.reqId];
          wrap.dataset.loaded = ''; // 允许下次重试
          const detail = wrap.querySelector('.card-detail');
          if (detail) {
            detail.innerHTML = '';
            const err = document.createElement('div');
            err.className = 'detail-error';
            err.textContent = '加载正文失败: ' + (msg.message || '未知错误');
            detail.appendChild(err);
            const actions = document.createElement('div');
            actions.className = 'detail-actions';
            const retry = document.createElement('button');
            retry.className = 'detail-btn';
            retry.type = 'button';
            retry.textContent = '重试';
            retry.addEventListener('click', (ev) => {
              ev.stopPropagation();
              wrap.classList.remove('expanded');
              toggleExpand(wrap);
            });
            actions.appendChild(retry);
            detail.appendChild(actions);
          }
        }
        return;
      }
      case 'commentsPage': {
        const wrap = pendingComments[msg.reqId];
        if (wrap) {
          delete pendingComments[msg.reqId];
          appendComments(wrap, msg);
        }
        return;
      }
      case 'commentsError': {
        const wrap = pendingComments[msg.reqId];
        if (wrap) {
          delete pendingComments[msg.reqId];
          // 首次拉取失败时 loaded 还是 'loading', 重置为空让用户能重试
          const isFirstLoad = wrap.dataset.commentsOffset === '0';
          if (isFirstLoad) wrap.dataset.commentsLoaded = '';
          const section = wrap.querySelector('.comments-section');
          if (section) {
            // 评论区上方保留已加载的列表, 在底部显示错误 + 重试
            let actions = section.querySelector('.comments-actions');
            if (actions) actions.remove();
            // 如果是首次加载失败, section 里只有 loading 占位符, 直接清空换错误提示
            if (isFirstLoad) {
              section.innerHTML = '';
              const err = document.createElement('div');
              err.className = 'comments-error';
              err.textContent = '加载评论失败: ' + (msg.message || '未知错误');
              section.appendChild(err);
            }
            actions = document.createElement('div');
            actions.className = 'comments-actions';
            const retry = document.createElement('button');
            retry.className = 'detail-btn';
            retry.type = 'button';
            retry.textContent = '重试';
            retry.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (isFirstLoad) {
                wrap.dataset.commentsLoaded = '';
                wrap.dataset.commentsVisible = '';
                toggleComments(wrap);
              } else {
                loadMoreComments(wrap);
              }
            });
            actions.appendChild(retry);
            section.appendChild(actions);
          }
        }
        return;
      }
      case 'childCommentsPage': {
        const item = pendingChildComments[msg.reqId];
        if (item) {
          delete pendingChildComments[msg.reqId];
          appendChildComments(item, msg);
        }
        return;
      }
      case 'childCommentsError': {
        const item = pendingChildComments[msg.reqId];
        if (item) {
          delete pendingChildComments[msg.reqId];
          const isFirstLoad = item.dataset.childOffset === '0';
          if (isFirstLoad) item.dataset.childLoaded = '';
          const section = item.querySelector('.child-comments-section');
          if (section) {
            let actions = section.querySelector('.child-comments-actions');
            if (actions) actions.remove();
            if (isFirstLoad) {
              section.innerHTML = '';
              const err = document.createElement('div');
              err.className = 'comments-error';
              err.textContent = '加载回复失败: ' + (msg.message || '未知错误');
              section.appendChild(err);
            }
            actions = document.createElement('div');
            actions.className = 'child-comments-actions';
            const retry = document.createElement('button');
            retry.className = 'detail-btn secondary';
            retry.type = 'button';
            retry.textContent = '重试';
            retry.addEventListener('click', (ev) => {
              ev.stopPropagation();
              if (isFirstLoad) {
                item.dataset.childLoaded = '';
                item.dataset.childVisible = '';
                toggleChildComments(item);
              } else {
                loadMoreChildComments(item);
              }
            });
            actions.appendChild(retry);
            section.appendChild(actions);
          }
          refreshRepliesToggle(item);
        }
        return;
      }
      case 'questionAnswersPage': {
        // 路由校验: 详情页可能已被关闭/换问题, 旧 reqId 的回包直接丢弃
        if (!currentQuestion || msg.reqId !== currentQuestion.reqId) return;
        appendQuestionAnswers(msg);
        return;
      }
      case 'questionAnswersError': {
        if (!currentQuestion || msg.reqId !== currentQuestion.reqId) return;
        handleQuestionAnswersError(msg.message);
        return;
      }
      case 'error': {
        // 顶部插一个错误条而不是覆盖列表, 用户已经加载的内容不丢.
        // 根据当前视图选择挂载位置 — 详情页打开时插到 questionView 头部, 否则插到 feed root.
        const bar = document.createElement('div');
        bar.style.cssText = 'background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-inputValidation-errorForeground);padding:8px 12px;font-size:12px;';
        bar.textContent = msg.message;
        const target = currentQuestion ? questionView : root;
        target.insertBefore(bar, target.firstChild);
        // 5 秒后自动消失
        setTimeout(() => { try { bar.remove(); } catch (e) {} }, 5000);
        return;
      }
    }
  });

  // 通知 extension 已挂载
  vscode.postMessage({ type: 'ready' });
})();
${getImageLightboxScript()}
${getKeyboardScrollScript()}
</script>
${getImageLightboxHtml()}
</body>
</html>`;
  }
}

function generateNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

/**
 * 阅读字号缩放系数的合法区间 + 截位规则 — 跟前端 webview 内的 clampReaderFontScale
 * 一致 (range 0.7~1.8, step 0.1). 这里独立实现一份是因为前端那段写在 template literal
 * 里, TS 编译期不能直接复用; 但两边的常量必须人工保持一致.
 *
 * 截到一位小数: 0.1 + 0.1 + 0.1 在 IEEE-754 下是 0.30000000000000004, 不截会让
 * workspaceState 里塞进一串浮点尾巴.
 */
function clampReaderFontScale(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 1;
  const clamped = Math.min(1.8, Math.max(0.7, n));
  return Math.round(clamped * 10) / 10;
}
