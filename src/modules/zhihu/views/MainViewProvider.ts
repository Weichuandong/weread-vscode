import * as vscode from 'vscode';
import type { ZhihuAuthService } from '../auth/AuthService';
import type { ZhihuClient } from '../api/ZhihuClient';
import type { ZhihuCardForView, ZhihuFeedItem } from '../types';

/**
 * 知乎推荐流的 webview view。
 *
 * 设计原则:
 *   1. 列表 + 卡片 + "点击展开内嵌阅读": 卡片折叠时只显示标题/摘要/作者; 点开后在卡片下方
 *      就地展开正文 (纯文本, 保留段落), 并按 zhihu.readChunkSize 分段加载 — 看不下去随时折叠。
 *      视频类型只显示元信息提示 (实际播放需在外部进行)。
 *   2. 「就地看评论」: 任何卡片展开后都能点 "查看评论 (N)", 在正文下方再就地展开评论列表,
 *      每页 20 条, 滚到底/手动点继续加载, 完全不离开 VSCode (摸鱼必备)。
 *   3. 不重复: 三层去重 (服务端 session_token / feedback/read 上报 / 前端 Set), 详见 ZhihuClient
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
  /** 当前是否正在拉取, 用于前端"加载中"状态 + 防止重复并发 */
  private loading = false;
  /** 已经到流末尾了, 不再请求 */
  private reachedEnd = false;

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
        // 重置 + 拉一页
        void this.refresh();
      } else {
        this.post({ type: 'cards', cards: [], replace: true });
      }
    });
    this.context.subscriptions.push(sub);

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
    await this.fetchAndPush(true);
  }

  // ---------- 内部 ----------

  private async handleMessage(msg: { type?: string; [k: string]: unknown }): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        // webview 初次挂载后通知一次登录态 + 同步分段大小配置 (前端切片用) + 当前点赞过滤器
        this.post({ type: 'loginState', loggedIn: this.auth.isLoggedIn() });
        this.post({ type: 'config', chunkSize: this.getChunkSize() });
        this.post({ type: 'filterState', filter: this.getFilter() });
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
   * 真正打到 ZhihuClient 的入口。
   * `replace = true` 表示是刷新, 前端会清空再 append; false 表示加载更多。
   */
  private async fetchAndPush(replace: boolean): Promise<void> {
    if (this.loading) {
      // 并发保护: 用户连续点 / 快速滚动时不要叠请求
      return;
    }
    this.loading = true;
    this.post({ type: 'loading', loading: true });

    try {
      const { cards, rawItems, isEnd } = await this.client.fetchRecommend(replace);

      // 推给前端 (即使为空也推, 前端会显示 "本页没有新内容")
      this.post({ type: 'cards', cards, replace });

      if (isEnd) {
        this.reachedEnd = true;
        this.post({ type: 'reachEnd' });
      }

      // 上报已读 — 不 await, 失败静默 (ZhihuClient 内部已经吞了异常)
      void this.client.reportRead(rawItems);

      // 一种保险: 如果服务端给我们的全是重复, cards 为 0 且没到底,
      // 那就再自动拉一页 (最多一次, 避免死循环)
      if (cards.length === 0 && !isEnd && !replace) {
        console.log('[zhihu] 本页 0 条新卡片, 自动续拉一页');
        // 注意: 这里走的是同一个 fetchAndPush 路径, 但 replace=false,
        // loading 标记会在 finally 里清掉, 不会死锁
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.postError(`加载失败: ${m}`);
    } finally {
      this.loading = false;
      this.post({ type: 'loading', loading: false });
    }
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
  .card-wrap {
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.15));
  }
  .card-wrap.expanded {
    /* 展开时不再整体染色, 只靠左侧细色条 + 顶部分隔做视觉锚点, 避免像"被选中的文件"一样刺眼 */
    background: transparent;
    box-shadow: inset 2px 0 0 var(--vscode-focusBorder, var(--vscode-textLink-foreground, rgba(128,128,128,0.4)));
  }
  .card {
    padding: 12px 14px;
    cursor: pointer;
    transition: background 0.1s;
    position: relative;
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
    font-size: 12px;
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
  .filter-bar .filter-stat {
    margin-left: auto;
    font-size: 10.5px;
    color: var(--vscode-descriptionForeground);
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
    font-size: 11.5px;
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
  <div id="filterBar" class="filter-bar" hidden>
    <span>👍</span>
    <input id="filterMin" type="number" min="0" placeholder="最少" title="最低赞数 (留空或 0 = 不限)" />
    <span>~</span>
    <input id="filterMax" type="number" min="0" placeholder="不限" title="最高赞数 (留空 = 不限)" />
    <button id="filterApply" type="button" title="应用筛选 (回车也可)">应用</button>
    <button id="filterClear" type="button" title="清除筛选, 恢复全部显示">清除</button>
    <span id="filterStat" class="filter-stat"></span>
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
  const filterStat = document.getElementById('filterStat');

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

    // 第一次展开 cursor=0 → 至少推一段; 之后每点一次 +chunkSize
    cursor = Math.min(content.length, cursor + chunkSize);
    wrap.dataset.cursor = String(cursor);

    const visibleText = content.slice(0, cursor);
    const remaining = content.length - cursor;

    detail.innerHTML = '';
    const text = document.createElement('div');
    text.className = 'detail-text';
    text.textContent = visibleText;
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
    const body = document.createElement('div');
    body.className = 'comment-body';
    body.textContent = c.content || '';
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

  /** 打开问题详情页 — 由 card-title click 触发 */
  function openQuestionView(questionId, questionTitle) {
    if (!questionId) return;
    // 隐藏 feed 流相关 (filterBar 在详情页里关掉, 语义不同)
    if (filterBar) filterBar.hidden = true;
    root.style.display = 'none';
    footer.style.display = 'none';
    questionView.hidden = false;
    questionTitleEl.textContent = questionTitle || '问题';
    questionList.innerHTML = '<div class="empty">正在加载该问题下的回答...</div>';
    questionFooter.innerHTML = '';
    // 滚到顶 — sidebar 太窄, 用户从 feed 中段进详情页时不希望已经被滚下去
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

  /** 关闭详情页, 还原 feed 流视图 */
  function closeQuestionView() {
    questionView.hidden = true;
    currentQuestion = null;
    // 还原 feed 区: filterBar 仅在已登录时显示
    if (filterBar) filterBar.hidden = !loggedIn;
    root.style.display = '';
    renderFooter();
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
      case 'loginState':
        loggedIn = !!msg.loggedIn;
        // 未登录时整条过滤条隐藏 — 此时 root 里只有一个登录提示, 显示筛选条没意义.
        // 同时如果在详情页里掉线, 强制关闭详情页 (登录提示需要回到 feed 流视图)
        if (!loggedIn) {
          if (currentQuestion) closeQuestionView();
          if (filterBar) filterBar.hidden = true;
          renderLoginTip();
        } else {
          if (filterBar) filterBar.hidden = !!currentQuestion;
          if (cardsRendered === 0) renderEmpty('加载中...');
        }
        renderFooter();
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
</script>
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
