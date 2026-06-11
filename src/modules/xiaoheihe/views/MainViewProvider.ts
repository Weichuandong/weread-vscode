import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { XiaoheiheClient } from '../api/XiaoheiheClient';
import type { XiaoheiheAuthService } from '../auth/AuthService';
import type {
  XiaoheiheCardForView,
  XiaoheiheSectionId,
  XiaoheiheSectionMeta,
  XiaoheiheTopicMeta,
} from '../types';
import {
  BUILTIN_SECTIONS,
  DEFAULT_ENABLED_SECTIONS,
  HOME_SECTION_ID,
  HOME_SECTION_META,
} from '../types';

/**
 * 小黑盒资讯流的侧边栏 webview view (Arena 模块).
 *
 * v2.2 主要新增 (相比 v2.1):
 *   1. 主页推荐流 (id='home'): 不依赖未知接口, 本地把"用户启用的所有板块" round-robin
 *      混排成主页. 默认作为第一个 tab, 不可禁用. 既解决了"没有官方推荐接口"问题, 又
 *      让"个性化"完全可解释 (用户勾选了哪些板块就决定主页内容).
 *   2. 板块自选: 内置板块池 (BUILTIN_SECTIONS, 含 home/常见热门 + 字典硬编码补齐 ~133 项),
 *      用户在 tab 栏右侧 ⚙ 按钮里勾选启用. 未启用的板块不出现在 tab 里, 主页混排也跳过.
 *      不在 BUILTIN_SECTIONS 里的新板块: 走 onTopicsDiscovered 收集进 topicMap (供
 *      xiaoheihe.dumpTopicMap 命令导出反馈给维护者补硬编码), 用户侧无法直接切.
 *
 * 设计取舍 (与 zhihu 模块对比):
 *   1. 主页推荐为啥用本地混排不直连小黑盒推荐接口?
 *      小黑盒 APP 主页推荐依赖账号画像, 插件场景做不到登录态 + 设备指纹. 真要走它的
 *      推荐接口会被风控反复弹"请升级版本". 本地混排是诚实方案 — 个性化由"用户勾的
 *      板块" 驱动, 100% 可控可解释.
 *   2. 卡片就地展开正文 + 评论 — 跟 v2.1 一致, 不跳浏览器.
 *      接口 /bbs/app/link/tree 一个接口同时给"正文 + 评论", 比知乎的两步 RPC 还省.
 *      浏览器打开作为右上 fallback 按钮.
 *   3. 不需要登录 — 走伪 imei + 签名访问公开 API, 视图永远直接可用, 不存在 cookie 失效.
 *   4. 去重只做"会话内 set" (按 linkid), 切板块 / 刷新清空. 单游戏数据量大,
 *      跨重启持久化去重没必要; 主页混排时同一篇 (主页 vs. 子板块) 也只会出一次.
 *   5. 子评论不展开 — v1 只显示主楼层 + "N 条回复" 提示, 二期再说.
 *
 * 数据流:
 *
 *      [webview]                       [provider]                       [client]
 *  ready (init)        --postMessage-->  handleMessage 'ready'     -->  fetchHome(...) or fetchFeed(...)
 *  switchSection:      --postMessage-->  'switchSection'           -->  fetchXxx(newSection, 0)
 *  refresh:            --postMessage-->  'refresh'                 -->  fetchXxx(current, 0)
 *  loadMore:           --postMessage-->  'loadMore'                -->  fetchXxx(current, offset+limit)
 *
 *  点 ⚙:               --postMessage-->  'openSettings'
 *                     <--postMessage--    'sectionsCatalog' { builtin, enabled }
 *  保存设置:           --postMessage-->  'saveSettings' { enabled }
 *                                              │
 *                                              ↓ globalState
 *                     <--postMessage--    'init' (重新推 tab 列表 + 切换到合适板块)
 *
 *  点卡片 (展开):       --postMessage-->  'expand' { reqId, linkId }
 *                     <--postMessage--    'detail' { reqId, detail }
 *  点 "查看评论":       --postMessage-->  'comments' { reqId, linkId, page }
 *                     <--postMessage--    'commentsPage' { reqId, comments, hasMore, page }
 *  右上 "在浏览器打开": --postMessage-->  'openExternal' { url }     -->  vscode.env.openExternal
 */
export class MainViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'xiaoheiheVscode.main';

  private view?: vscode.WebviewView;

  /** 当前选中的板块 id (可能是 'home' 或某个 section id) */
  private currentSection: XiaoheiheSectionId;

  /** 当前已加载到的 offset (= 已展示卡片数), 配合 limit 翻页 */
  private offset = 0;

  /** 服务端是否到底 (本板块 + 当前 offset 之后没有数据了) */
  private reachedEnd = false;

  /** 列表请求是否进行中 (refresh / loadMore / switchSection), 防并发 */
  private listLoading = false;

  /**
   * 当前会话内已经推给前端的 linkId 集合 — 防服务端偶发返回重复卡 + 主页混排时同卡
   * 出现在多个子板块的情况. 切板块 / 刷新时清空.
   */
  private readonly seenLinkIds = new Set<string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    // 不加 readonly: 'xiaoheihe.resetImei' 命令会通过 replaceClient() 热替换
    // 这个引用, 实现"重置 IMEI -> 立刻用新设备 ID 继续刷帖" 的无重启体验.
    private client: XiaoheiheClient,
    // auth: 仅用来读 isLoggedIn (推 loginState 给前端) + 点 👤 按钮时按当前态做
    //   importCookie / logout 决策. 真正的 cookie 注入走 client 的 getCookieJar
    //   回调, 不经过 view.
    private readonly auth: XiaoheiheAuthService,
  ) {
    this.currentSection = this.loadLastSection();
  }

  /**
   * 热替换底层 client (供 resetImei 命令使用).
   *
   * 调用方应在 IMEI 重置后构造一个新的 XiaoheiheClient 传进来, 然后通常会紧跟
   * 一次 refresh() 让 webview 用新设备 ID 重新拉取首页. 不在这里自动 refresh —
   * 调用方控制时机更灵活 (e.g. resetImei 后可能想先弹通知再刷).
   */
  public replaceClient(newClient: XiaoheiheClient): void {
    this.client = newClient;
  }

  /**
   * 把当前登录态推送给前端 (更新工具栏 👤 按钮的视觉态).
   *
   * 调用时机:
   *   1. activate 首次 (view 可能还没 ready, 前端收不到也无所谓 — ready 后我们会
   *      在 handleMessage 'ready' 里再补推一次)
   *   2. AuthService.onDidChangeLoginState 触发后 (importCookie / logout)
   *   3. ready 消息到达时
   */
  public pushLoginState(): void {
    this.post({ type: 'loginState', isLoggedIn: this.auth.isLoggedIn() });
  }

  /** ============ vscode 入口 ============ */

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    webviewView.webview.html = this.renderHtml();
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      try {
        await this.handleMessage(msg);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        this.post({ type: 'error', message: m });
      }
    });
    // 不在这里主动 fetch — 等前端 'ready' 触发 (避免 webview 还没绑 onMessage
    // 时我们就 post 出去, 首屏丢消息).
  }

  /** 命令: 用户从命令面板 / 标题栏点了刷新 */
  public async refresh(): Promise<void> {
    await this.loadFirstPage(this.currentSection);
  }

  /** 命令: 切换板块 (其它命令调用 / 命令面板用) */
  public async switchSection(sectionId: XiaoheiheSectionId): Promise<void> {
    const meta = this.findSection(sectionId);
    if (!meta) return;
    await this.loadFirstPage(sectionId);
  }
  /** @deprecated 旧名 — extension.ts 注册 xiaoheihe.switchGame 命令时仍可用 */
  public async switchGame(sectionId: XiaoheiheSectionId): Promise<void> {
    return this.switchSection(sectionId);
  }

  /**
   * "切到指定板块, 顺便把它加进启用列表" — 给 xiaoheihe.switchToTopic 命令用.
   *
   * 跟 switchSection 的差别:
   *   - switchSection 只切, 板块不在 enabled 列表里前端 tab 栏不会显示, 用户视觉割裂
   *     (能看到帖子但找不到 tab)
   *   - 这个方法会:
   *      1. 找不到 section (BUILTIN_SECTIONS 未收录) → 弹通知提示 + return,
   *         不再硬切. 字典发现的新板块需走 xiaoheihe.dumpTopicMap 反馈给维护者
   *         补 BUILTIN.
   *      2. 把目标 sectionId 加进 'xiaoheihe.enabledSections' globalState (如果不在)
   *      3. 调 pushInit 让前端 tab 列表立刻刷新出新 tab
   *      4. 调用 loadFirstPage 实际切板块
   *
   * @param sectionId   要切到的板块 id (必须命中 BUILTIN_SECTIONS)
   * @param topicMeta   可选 — 仅用于在"未收录"提示文案里展示板块名, 帮用户辨认.
   *                   命中 BUILTIN_SECTIONS 时这个参数会被忽略.
   */
  public async switchToTopicEnsureEnabled(
    sectionId: XiaoheiheSectionId,
    topicMeta?: XiaoheiheTopicMeta,
  ): Promise<void> {
    // 1. 确保 section 已在 BUILTIN 收录 — 没收录直接拒绝, 不再自动写 customSections
    const meta = this.findSection(sectionId);
    if (!meta) {
      const niceName = topicMeta?.name ? `「${topicMeta.name}」` : `「${sectionId}」`;
      vscode.window.showInformationMessage(
        `小黑盒: 板块 ${niceName} 未在内置列表收录, 暂时无法切换. ` +
          `可执行 "小黑盒: 导出已发现的话题字典" 命令把它反馈给维护者补进下个版本.`,
      );
      return;
    }

    // 2. 把 sectionId 加进 enabledSections (如果还没启用)
    const enabled = this.getEnabledSectionIds();
    if (!enabled.includes(sectionId)) {
      const next = Array.from(new Set([HOME_SECTION_ID, ...enabled, sectionId]));
      await this.context.globalState.update('xiaoheihe.enabledSections', next);
    }

    // 3. 推一次 tab 列表 — 让前端立刻把新启用的 tab 渲染出来 (用户能看到从哪切过去的)
    this.pushInit();

    // 4. 实际切板块 — 这里直接走 loadFirstPage, 跟 switchSection 等价
    await this.loadFirstPage(sectionId);
  }

  // ---------- 内部 ----------

  private async handleMessage(msg: { type?: string; [k: string]: unknown }): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        this.pushInit();
        // 下发图片显示开关持久化值 (默认 false, 摸鱼场景默认不出图, 跟 zhihu 模块对齐).
        // 必须在 pushInit 之后下发, 不然前端 'init' 处理可能把 imagesEnabled 局部状态盖掉.
        this.post({ type: 'imagesState', enabled: this.getImagesEnabled() });
        // 登录态: 让前端工具栏 👤 按钮一开局就显示正确视觉.
        //   index.ts activate 时也调过一次, 但那时 webview 可能还没 ready, 这里补一次.
        this.pushLoginState();
        await this.loadFirstPage(this.currentSection);
        return;

      case 'clickLoginBtn': {
        // 前端点了 👤 按钮 — 根据当前登录态做不同动作:
        //   - 未登录: 直接走 importCookie 流程 (InputBox 收 cookie)
        //   - 已登录: 弹 QuickPick 让用户选 "重新导入" / "退出登录"
        // 走命令而不是直接调 auth, 是为了走命令面板也能复用 (这里调命令 = 调 auth 方法).
        if (!this.auth.isLoggedIn()) {
          await vscode.commands.executeCommand('xiaoheihe.importCookie');
          return;
        }
        const pick = await vscode.window.showQuickPick(
          [
            { label: '$(refresh) 重新导入 Cookie', action: 'reimport' as const },
            { label: '$(sign-out) 退出登录', action: 'logout' as const },
          ],
          {
            title: '小黑盒 — 当前已登录',
            placeHolder: '选择操作',
          },
        );
        if (!pick) return;
        if (pick.action === 'reimport') {
          await vscode.commands.executeCommand('xiaoheihe.importCookie');
        } else {
          await vscode.commands.executeCommand('xiaoheihe.logout');
        }
        return;
      }

      case 'setImagesEnabled': {
        // 用户在前端点了 🖼️ 按钮. 仅持久化, 不需要重拉数据 — 前端把 DOM 里的占位符
        // 与 <img> 互转一遍即可 (syncImagesDom).
        const enabled = msg.enabled === true;
        await this.saveImagesEnabled(enabled);
        return;
      }

      case 'switchSection': {
        const sectionId = String(msg.sectionId || '');
        if (!sectionId || sectionId === this.currentSection) return;
        if (!this.findSection(sectionId)) return;
        // 切板块前确认它还在启用列表里 (UI 上不该出现禁用板块的 tab, 这里防御)
        const enabled = this.getEnabledSectionIds();
        if (!enabled.includes(sectionId)) return;
        await this.loadFirstPage(sectionId);
        return;
      }

      case 'refresh':
        await this.loadFirstPage(this.currentSection);
        return;

      case 'loadMore':
        if (this.reachedEnd) {
          this.post({ type: 'reachEnd' });
          return;
        }
        await this.loadNextPage();
        return;

      case 'openSettings': {
        // 弹设置面板 — 推内置板块目录 + 当前启用
        this.post({
          type: 'sectionsCatalog',
          builtin: BUILTIN_SECTIONS.map((s) => ({
            id: s.id,
            label: s.label,
            verified: s.verified,
          })),
          enabled: this.getEnabledSectionIds(),
        });
        return;
      }

      case 'saveSettings': {
        const newEnabled = Array.isArray(msg.enabled)
          ? (msg.enabled as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];

        // home 必须在 enabled 里 (前端 UI 应该没法取消勾选, 这里再兜底)
        const normalized = Array.from(new Set([HOME_SECTION_ID, ...newEnabled]));
        // enabled 项必须真实存在 (在内置板块里)
        const validIds = new Set<string>([
          HOME_SECTION_ID,
          ...BUILTIN_SECTIONS.map((s) => s.id),
        ]);
        const cleaned = normalized.filter((id) => validIds.has(id));

        await this.context.globalState.update('xiaoheihe.enabledSections', cleaned);

        // 若当前板块被禁了 → 切到 home
        if (!cleaned.includes(this.currentSection)) {
          this.currentSection = HOME_SECTION_ID;
          await this.saveLastSection(HOME_SECTION_ID);
        }

        // 把最新 tab 列表 + 选中态推回; 不重拉数据 (用户可能只是改了别的板块,
        // 当前板块的数据没必要刷新). 真要刷新自己点刷新按钮.
        this.pushInit();
        return;
      }

      case 'expand': {
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
        const linkId = typeof msg.linkId === 'string' ? msg.linkId : '';
        if (!reqId || !linkId) return;
        try {
          const detail = await this.client.fetchDetail(linkId);
          this.post({ type: 'detail', reqId, detail });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          this.post({ type: 'detailError', reqId, message: m });
        }
        return;
      }

      case 'comments': {
        const reqId = typeof msg.reqId === 'string' ? msg.reqId : '';
        const linkId = typeof msg.linkId === 'string' ? msg.linkId : '';
        const rawPage = typeof msg.page === 'number' ? msg.page : 1;
        const page = rawPage >= 1 ? Math.floor(rawPage) : 1;
        if (!reqId || !linkId) return;
        try {
          const r = await this.client.fetchCommentsPage(linkId, page);
          this.post({
            type: 'commentsPage',
            reqId,
            linkId,
            page,
            comments: r.comments,
            hasMore: r.hasMore,
            totalPage: r.totalPage,
          });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          this.post({ type: 'commentsError', reqId, page, message: m });
        }
        return;
      }

      case 'openExternal': {
        const url = typeof msg.url === 'string' ? msg.url : '';
        if (!url) return;
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return;
      }

      default:
        // ignore
    }
  }

  /** 把 tab 列表 + 当前选中推送给前端 (init / 设置变更后调用) */
  private pushInit(): void {
    const enabledIds = this.getEnabledSectionIds();
    // tabs 顺序: home 永远第一, 其它按 BUILTIN_SECTIONS 的"原始顺序" 过滤出已启用的
    const sections: Array<{ id: string; label: string; verified: boolean }> = [];
    // home tab
    sections.push({
      id: HOME_SECTION_ID,
      label: HOME_SECTION_META.label,
      verified: true,
    });
    // builtin
    for (const s of BUILTIN_SECTIONS) {
      if (enabledIds.includes(s.id)) {
        sections.push({ id: s.id, label: s.label, verified: s.verified });
      }
    }
    this.post({
      type: 'init',
      sections,
      currentSection: this.currentSection,
    });
  }

  /**
   * 加载第一页 (切板块 / 刷新都走这里).
   * 会重置 offset / seenLinkIds / reachedEnd, 并通知前端清空旧列表.
   */
  private async loadFirstPage(sectionId: XiaoheiheSectionId): Promise<void> {
    if (this.listLoading) return;
    this.listLoading = true;
    this.post({ type: 'loading', loading: true });
    try {
      this.currentSection = sectionId;
      await this.saveLastSection(sectionId);
      this.offset = 0;
      this.reachedEnd = false;
      this.seenLinkIds.clear();
      // 立刻让前端切到目标 tab + 清空列表, 别等数据回来再切, 视觉上更"跟手"
      this.post({ type: 'currentSection', sectionId });
      const { cards, isEnd } = await this.fetchPage(0, this.getLimit());
      const dedup = this.dedupAndMark(cards);
      this.offset = dedup.length;
      this.reachedEnd = isEnd;
      this.post({ type: 'cards', cards: dedup, replace: true });
      if (this.reachedEnd) this.post({ type: 'reachEnd' });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      // 主页 / 单板块的错误体验: 主页全部子板块挂了 = 网络问题; 单板块拉空通常是
      // tag 已变更, 错误文案引导用户去 ⚙ 取消勾选.
      const hint =
        sectionId === HOME_SECTION_ID
          ? m
          : `${m} (该板块可能 tag 已变更, 可在 ⚙ 设置中取消勾选)`;
      this.post({ type: 'error', message: `加载失败: ${hint}` });
    } finally {
      this.listLoading = false;
      this.post({ type: 'loading', loading: false });
    }
  }

  /** 加载下一页 (append 模式, 不清空旧的) */
  private async loadNextPage(): Promise<void> {
    if (this.listLoading) return;
    if (this.reachedEnd) {
      this.post({ type: 'reachEnd' });
      return;
    }
    this.listLoading = true;
    this.post({ type: 'loading', loading: true });
    try {
      const { cards, isEnd } = await this.fetchPage(this.offset, this.getLimit());
      const dedup = this.dedupAndMark(cards);
      // 注意 offset 用"服务端真实返回数量" 而不是"去重后数量" 推进 —
      // 否则服务端给了 30 条但有 5 条重复, 我们只 +25, 下一次还是会拿到那 5 条.
      this.offset += cards.length;
      if (cards.length === 0 || isEnd) this.reachedEnd = true;
      this.post({ type: 'cards', cards: dedup, replace: false });
      if (this.reachedEnd) this.post({ type: 'reachEnd' });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      this.post({ type: 'error', message: `加载失败: ${m}` });
    } finally {
      this.listLoading = false;
      this.post({ type: 'loading', loading: false });
    }
  }

  /**
   * 根据当前 section 路由到合适的 client 方法.
   *   - home → fetchHomeFeed (本地混排, 传入"启用的非 home 板块 meta 列表")
   *   - 其它 → fetchFeed (单板块)
   *
   * 找不到对应 section meta 时抛错; 这种情况通常发生在用户禁掉了当前 section 又没切走,
   * 上层 saveSettings handler 会兜底切到 home, 这里只是防御性兜底.
   */
  private async fetchPage(
    offset: number,
    limit: number,
  ): Promise<{ cards: XiaoheiheCardForView[]; isEnd: boolean }> {
    if (this.currentSection === HOME_SECTION_ID) {
      const subs = this.getEnabledNonHomeSections();
      const strategy = this.getHomeMixStrategy();
      return this.client.fetchHomeFeed(subs, offset, limit, strategy);
    }
    const meta = this.findSection(this.currentSection);
    if (!meta) {
      throw new Error(`板块 ${this.currentSection} 不存在 (可能已被移除)`);
    }
    return this.client.fetchFeed(meta, offset, limit);
  }

  /** 去重: 已经在 seenLinkIds 里的 cards 丢掉, 新的标记并返回 */
  private dedupAndMark(cards: XiaoheiheCardForView[]): XiaoheiheCardForView[] {
    const out: XiaoheiheCardForView[] = [];
    for (const c of cards) {
      if (this.seenLinkIds.has(c.linkId)) continue;
      this.seenLinkIds.add(c.linkId);
      out.push(c);
    }
    return out;
  }

  /** ============ section 解析 ============ */

  /** 内置板块查找 (含 home) */
  private findSection(id: XiaoheiheSectionId): XiaoheiheSectionMeta | undefined {
    if (id === HOME_SECTION_ID) return HOME_SECTION_META;
    return BUILTIN_SECTIONS.find((s) => s.id === id);
  }

  /** 当前启用的板块 id 列表 (home 一定在里面) */
  private getEnabledSectionIds(): XiaoheiheSectionId[] {
    const raw = this.context.globalState.get<string[]>('xiaoheihe.enabledSections');
    const list = Array.isArray(raw) && raw.length > 0 ? raw : Array.from(DEFAULT_ENABLED_SECTIONS);
    // home 强制存在 + 去重
    const set = new Set<string>([HOME_SECTION_ID, ...list]);
    // 过滤掉已经不存在的 (BUILTIN 调整后旧 id 可能残留在 globalState 里)
    const valid = Array.from(set).filter((id) => !!this.findSection(id));
    return valid;
  }

  /** 主页混排时要拉的子板块 meta 列表 (= 已启用 - home) */
  private getEnabledNonHomeSections(): XiaoheiheSectionMeta[] {
    return this.getEnabledSectionIds()
      .filter((id) => id !== HOME_SECTION_ID)
      .map((id) => this.findSection(id))
      .filter((m): m is XiaoheiheSectionMeta => !!m);
  }

  private getHomeMixStrategy(): 'roundrobin' | 'interleave' {
    const v = vscode.workspace
      .getConfiguration('xiaoheihe')
      .get<string>('homeMixStrategy', 'roundrobin');
    return v === 'interleave' ? 'interleave' : 'roundrobin';
  }

  /** ============ state 持久化 ============ */

  private loadLastSection(): XiaoheiheSectionId {
    const raw = this.context.globalState.get<string>('xiaoheihe.lastSection');
    // 兼容旧字段 xiaoheihe.lastGame (v2.1 用过)
    const legacy = this.context.globalState.get<string>('xiaoheihe.lastGame');
    const candidate = raw || legacy;
    if (candidate && this.findSection(candidate)) {
      return candidate;
    }
    // 默认: 配置里 defaultSection (默认 'home')
    const cfg = vscode.workspace
      .getConfiguration('xiaoheihe')
      .get<string>('defaultSection', HOME_SECTION_ID);
    if (cfg && this.findSection(cfg)) {
      return cfg;
    }
    return HOME_SECTION_ID;
  }

  private async saveLastSection(sectionId: XiaoheiheSectionId): Promise<void> {
    await this.context.globalState.update('xiaoheihe.lastSection', sectionId);
  }

  /**
   * 是否允许在卡片详情正文里渲染图片. 默认 false (摸鱼场景: 别让网络流量 / 屏幕上突然
   * 冒出 cdn 大图暴露你在看游戏论坛). 跟 zhihu 模块的 'zhihu.imagesEnabled' 设计一致.
   *
   * 选 workspaceState 而非 vscode configuration 的理由: 这个开关粒度是"当前工作区",
   * 用户在公司项目里可能想关, 在家个人项目里可以开 — workspace 级最合适.
   */
  private getImagesEnabled(): boolean {
    return this.context.workspaceState.get<boolean>('xiaoheihe.imagesEnabled') === true;
  }

  private async saveImagesEnabled(enabled: boolean): Promise<void> {
    await this.context.workspaceState.update('xiaoheihe.imagesEnabled', enabled);
  }

  /**
   * 每页拉取条数, 走 vscode 配置 xiaoheihe.pageSize (默认 30, 跟 APP 一致).
   * Clamp 到 [10, 50] 防御性范围.
   */
  private getLimit(): number {
    const n = vscode.workspace
      .getConfiguration('xiaoheihe')
      .get<number>('pageSize', 30);
    if (!Number.isFinite(n) || n < 10) return 10;
    if (n > 50) return 50;
    return Math.floor(n);
  }

  /** ============ webview I/O ============ */

  private post(payload: unknown): void {
    void this.view?.webview.postMessage(payload);
  }

  /**
   * 渲染 webview HTML. 一次性内联 CSS/JS — 跟 zhihu 模块风格一致.
   *
   * CSP:
   *   - default-src 'none' — 显式开白名单
   *   - img-src https: data: — 卡片封面 / 头像 / 正文配图都在 cdn (https)
   *   - script-src 'nonce-xxx' — 防 XSS
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
    /* 卡片底色 — 双层 (sideBar 实色兜底 + codeBlock 半透明叠加) 防 sticky 透字 */
    --card-bg:
      linear-gradient(
        var(--vscode-textCodeBlock-background, rgba(128,128,128,0.06)),
        var(--vscode-textCodeBlock-background, rgba(128,128,128,0.06))
      ),
      var(--vscode-sideBar-background);
  }
  body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
  }
  /* ------ 顶部 tab 栏 ------ */
  /*
    tab-bar 是 sticky 的容器, 内部分两段: 左侧 .tabs 可横滑, 右侧 .tab-actions 固定显示 ⚙.
    用 flex 撑开, .tabs 设 flex:1 + overflow:auto-x 实现"滑动区窄出 ⚙ 钉住右边".
  */
  .tab-bar {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: stretch;
    background: var(--vscode-sideBar-background);
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.18)));
  }
  .tabs {
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    white-space: nowrap;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    display: inline-block;
    padding: 8px 12px;
    cursor: pointer;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    border-bottom: 2px solid transparent;
    transition: color 0.1s, border-color 0.1s;
    position: relative;
  }
  .tab:hover { color: var(--vscode-foreground); }
  .tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground, #007acc));
  }
  /* home tab 额外加个图标前缀, 直观区别于普通板块 */
  .tab.home::before {
    content: '🏠 ';
    margin-right: 2px;
  }
  .tab-actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    padding: 0 6px;
    border-left: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
  }
  .icon-btn {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 3px;
    font-size: 14px;
    line-height: 1;
    font-family: inherit;
  }
  .icon-btn:hover {
    color: var(--vscode-foreground);
    background: var(--vscode-list-hoverBackground);
  }
  /* 图片开关按钮的"开启态"视觉 — 用主题强调色, 让用户一眼看到"图片是开着的"
     (摸鱼场景下默认是关, 反向意外开了能立刻发现, 这也是 zhihu 模块同款设计). */
  .icon-btn.images-toggle.on {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #007acc);
  }
  .icon-btn.images-toggle.on:hover {
    background: var(--vscode-button-hoverBackground, #005f9e);
  }
  /* 登录按钮的"已登录态" — 用 git-decoration-addedResource 的绿色 (跟 vscode SCM
     "已添加"色一致), 跟图片开关蓝色强调区分开, 视觉上一眼能识别是登录状态而不是
     图片状态. 未登录时走默认 .icon-btn 灰色描述色, 引导用户去点 (但不强抢注意力). */
  .icon-btn.login-btn.on {
    color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #4caf50));
  }
  .icon-btn.login-btn.on:hover {
    color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #4caf50));
    background: var(--vscode-list-hoverBackground);
  }

  /* ------ 正文中嵌入的图片 / 占位符 ------
     [IMG:url] 占位符被前端 renderTextWithImages 切片成:
       开 → <img.inline-img>           (发请求出图)
       关 → <span.inline-img-placeholder> (不发请求, 显示 "🖼️ 图片" 占位)
     加载失败时进一步降级为 <span.inline-img-broken>. */
  .inline-img {
    display: block;
    max-width: 100%;
    max-height: 600px;
    border-radius: 4px;
    margin: 6px 0;
    background: var(--vscode-input-background, rgba(128,128,128,0.1));
    object-fit: contain;
  }
  .inline-img-broken,
  .inline-img-placeholder {
    display: inline-block;
    padding: 2px 8px;
    margin: 2px 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.12));
    border: 1px dashed var(--vscode-widget-border, rgba(128,128,128,0.3));
    border-radius: 3px;
    user-select: none;
  }
  /* 占位本身可点击 -> 一键全局开图. 工具栏 🖼️ 按钮太隐蔽, 用户很难发现 — 在
     占位上直接给可点击亲和力是最低成本的提示路径. */
  .inline-img-placeholder {
    cursor: pointer;
  }
  .inline-img-placeholder:hover {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #007acc);
    border-color: var(--vscode-button-background, #007acc);
    border-style: solid;
  }
  /* broken 是已加载失败态, 点了也没用 -> 保持 default cursor */
  .inline-img-broken {
    cursor: default;
  }

  /* ------ 卡片列表 ------ */
  #list { padding: 4px 0 8px 0; }
  .card-wrap {
    background: var(--card-bg);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.18)));
    border-radius: 6px;
    margin: 8px 8px;
    transition: border-color 0.15s;
  }
  .card-wrap.expanded {
    border-color: var(--vscode-descriptionForeground, rgba(128,128,128,0.55));
  }
  .card {
    padding: 10px 12px;
    cursor: pointer;
    display: flex;
    gap: 10px;
    border-radius: 6px;
    position: relative;
  }
  /*
    展开后的卡片头 sticky 在顶部 (紧贴 tab-bar 下方) — 长帖看到一半也能随时
    在原位置看到标题, 点一下头部直接折叠回去, 不用滚回顶部. 参照 zhihu 模块同款.
      - top 用 --tab-bar-h 变量, 由 ResizeObserver 实时同步 .tab-bar 实际高度
        (字号变化 / 浏览器缩放 都会跟); 兜底 36px (tab .tab padding 8 + 字号 12 ≈ 32+).
      - z-index 5 < .tab-bar 的 10, 保证 tab-bar 始终在最上.
      - background 必须不透明, 否则 sticky 时下面的 .detail 文字会从下面透上来叠加.
        用跟 wrap 一致的 --card-bg (linear-gradient + sideBar 实色兜底), 不会出现两段色.
      - 只顶部圆角 — 下方紧贴 .detail, 底部留圆角会露出 wrap 背景缺口.
      - 底部 inset 细线分隔 "已浮起标题" 与正文; 用 inset 不会被裁也不会推开下方内容.
    多张卡片同时展开时, 每张 .card 在自己的 .card-wrap 内 sticky, 滚出 wrap 边界
    会被下一张自然顶替 (position:sticky 天然行为), 不会重叠.
  */
  .card-wrap.expanded .card {
    position: sticky;
    top: var(--tab-bar-h, 36px);
    z-index: 5;
    background: var(--card-bg);
    border-radius: 6px 6px 0 0;
    box-shadow: inset 0 -1px 0 var(--vscode-widget-border, rgba(128,128,128,0.2));
  }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card .cover {
    width: 84px;
    height: 56px;
    flex-shrink: 0;
    background: var(--vscode-input-background, rgba(128,128,128,0.1));
    border-radius: 4px;
    object-fit: cover;
    display: block;
  }
  .card.no-cover .cover { display: none; }
  .card .body { flex: 1; min-width: 0; }
  .card .title {
    font-size: 13px;
    font-weight: 500;
    color: var(--vscode-foreground);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .card .excerpt {
    margin-top: 4px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
  .card .meta {
    margin-top: 6px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .card .meta .tag,
  .card .meta .source-tag {
    padding: 0 6px;
    border-radius: 2px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.18));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
  }
  /* "来自 XXX" 角标在主页流里特别有用, 用主题强调色让它一眼可见 */
  .card .meta .source-tag {
    background: var(--vscode-textLink-foreground, #007acc);
    color: var(--vscode-button-foreground, #fff);
    opacity: 0.75;
  }
  .card .meta .video-flag::before {
    content: '▶ ';
    color: var(--vscode-textLink-foreground, #007acc);
  }

  /* ------ 卡片展开后的详情区 ------ */
  .detail {
    padding: 0 14px 12px 14px;
    border-top: 1px dashed var(--vscode-widget-border, rgba(128,128,128,0.25));
    margin-top: 4px;
  }
  .detail-section-title {
    margin: 10px 0 6px 0;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .detail-content {
    font-size: 13px;
    color: var(--vscode-foreground);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .detail-imgs {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .detail-imgs img {
    max-width: 100%;
    border-radius: 4px;
    background: var(--vscode-input-background, rgba(128,128,128,0.1));
    max-height: 600px;
    object-fit: contain;
  }
  .detail-actions {
    margin-top: 10px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .detail-btn {
    padding: 4px 10px;
    font-size: 12px;
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
  }
  .detail-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25));
  }
  .detail-btn[disabled] { opacity: 0.6; cursor: default; }
  .detail-status {
    margin-top: 8px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
  .detail-status.error { color: var(--vscode-errorForeground, #f48771); }

  /* ------ 评论列表 ------ */
  .comments { margin-top: 8px; }
  .comment-item {
    padding: 8px 0;
    border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.15));
    display: flex;
    gap: 8px;
  }
  .comment-item:first-child { border-top: none; }
  .comment-avatar {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--vscode-input-background, rgba(128,128,128,0.15));
    object-fit: cover;
  }
  .comment-body { flex: 1; min-width: 0; }
  .comment-head {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
  }
  .comment-head .username { color: var(--vscode-foreground); font-weight: 500; }
  .comment-head .level {
    padding: 0 4px;
    border-radius: 2px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.2));
    color: var(--vscode-badge-foreground, var(--vscode-foreground));
    font-size: 10px;
  }
  .comment-head .top-flag {
    padding: 0 4px;
    border-radius: 2px;
    background: var(--vscode-textLink-foreground, #007acc);
    color: var(--vscode-button-foreground, #fff);
    font-size: 10px;
  }
  .comment-text {
    margin-top: 4px;
    font-size: 12px;
    color: var(--vscode-foreground);
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .comment-foot {
    margin-top: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    display: flex;
    gap: 10px;
  }
  .comments-loadmore {
    display: block;
    width: 100%;
    margin: 8px 0 0 0;
    padding: 6px 0;
    font-size: 12px;
    background: transparent;
    color: var(--vscode-textLink-foreground, var(--vscode-foreground));
    border: 1px dashed var(--vscode-widget-border, rgba(128,128,128,0.3));
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
  }
  .comments-loadmore:hover { background: var(--vscode-list-hoverBackground); }
  .comments-loadmore[disabled] { opacity: 0.6; cursor: default; }
  .comments-empty {
    padding: 8px 0;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
  }

  /* ------ 状态条 ------ */
  .status {
    padding: 12px 14px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
  }
  .status.error { color: var(--vscode-errorForeground, #f48771); }
  .load-more {
    display: block;
    margin: 8px auto 16px;
    padding: 6px 16px;
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
  }
  .load-more:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25));
  }
  .load-more[disabled] { cursor: default; opacity: 0.6; }
  .hidden { display: none !important; }

  /* ------ 设置面板 (modal) ------ */
  .settings-mask {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    z-index: 50;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 24px 12px;
    overflow-y: auto;
  }
  .settings-panel {
    width: 100%;
    max-width: 460px;
    background: var(--vscode-editor-background, var(--vscode-sideBar-background));
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.35);
    padding: 14px 16px 16px 16px;
    color: var(--vscode-foreground);
  }
  .settings-title {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 6px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .settings-close {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 4px 6px;
    font-family: inherit;
  }
  .settings-close:hover { color: var(--vscode-foreground); }
  .settings-desc {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
    margin-bottom: 10px;
  }
  .settings-section-title {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 10px 0 6px 0;
  }
  .settings-list {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px 12px;
  }
  .settings-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    padding: 3px 0;
    cursor: pointer;
    user-select: none;
  }
  .settings-row input[type="checkbox"] {
    accent-color: var(--vscode-focusBorder, #007acc);
    cursor: pointer;
  }
  .settings-row .row-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .settings-row.disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .settings-actions {
    margin-top: 16px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .settings-btn {
    padding: 5px 16px;
    font-size: 12px;
    border-radius: 3px;
    cursor: pointer;
    font-family: inherit;
    border: 1px solid transparent;
  }
  .settings-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .settings-btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  .settings-btn.secondary {
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border-color: var(--vscode-widget-border, rgba(128,128,128,0.3));
  }
  .settings-btn.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.25));
  }
</style>
</head>
<body>
  <div class="tab-bar">
    <div class="tabs" id="tabs"></div>
    <div class="tab-actions">
      <button class="icon-btn login-btn" id="login-btn" title="登录小黑盒账号 (启用个性化推荐流)">👤</button>
      <button class="icon-btn images-toggle" id="images-toggle-btn" title="开启/关闭正文图片显示 (默认关闭). 也可以直接点击正文里的 🖼️ 占位一键开启.">🖼️</button>
      <button class="icon-btn" id="settings-btn" title="选择要在 tab 栏显示的板块">⚙</button>
    </div>
  </div>
  <div id="list"></div>
  <div id="status" class="status hidden"></div>
  <button class="load-more hidden" id="load-more">加载更多</button>
  <div id="settings-root"></div>

<script nonce="${nonce}">
  /*
    前端逻辑.
    新增 v2.2:
      - 主页 tab (id='home'): 第一个不可去掉, 渲染时加 🏠 前缀
      - tab 栏右侧 ⚙ 按钮: 点击弹出设置面板 (modal), 复选要在 tab 栏显示的内置板块
      - 卡片在主页流场景多一个 "来自 XXX" 角标 (sourceSectionLabel)

    现有功能 (v2.1):
      - 卡片就地展开正文 + 配图 + 评论列表 + 翻页 + 错误重试
      - 浏览器 fallback 按钮
      - 滚到底自动加载
  */
  const vscode = acquireVsCodeApi();
  const $list = document.getElementById('list');
  const $tabs = document.getElementById('tabs');
  const $status = document.getElementById('status');
  const $loadMore = document.getElementById('load-more');
  const $settingsBtn = document.getElementById('settings-btn');
  const $settingsRoot = document.getElementById('settings-root');
  const $imagesToggleBtn = document.getElementById('images-toggle-btn');
  const $loginBtn = document.getElementById('login-btn');

  let currentSection = '';
  /**
   * 当前登录态. extension 通过 'loginState' 消息下发, importCookie/logout 后会再
   * 推一次, 前端只是被动接收 + 同步按钮 UI, 不自己判断.
   */
  let isLoggedIn = false;
  let reachedEnd = false;
  let listLoading = false;

  /**
   * 是否允许在详情正文里渲染真实 <img> (= 发请求出图). 默认 false (摸鱼场景:
   * 别让公司网络 / 旁观者看到 cdn 大图加载暴露你在看游戏论坛). ready 后 extension
   * 会下发 'imagesState' 改写, 用户点 🖼️ 按钮可切换.
   *
   * 取值影响 renderTextWithImages 把 [IMG:url] 占位符渲染成哪种节点:
   *   - true:  <img class="inline-img" src=url>       (发请求)
   *   - false: <span class="inline-img-placeholder" data-src=url>🖼️ 图片</span>  (不发请求)
   */
  let imagesEnabled = false;

  /** reqId -> wrap DOM, 路由 detail/comments 异步回包 */
  const reqIdToWrap = new Map();

  function genReqId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- 与 extension 通信 ----------
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'init':
        renderTabs(msg.sections || [], msg.currentSection);
        currentSection = msg.currentSection;
        break;
      case 'currentSection':
        currentSection = msg.sectionId;
        updateActiveTab();
        $list.innerHTML = '';
        reqIdToWrap.clear();
        reachedEnd = false;
        updateLoadMore();
        break;
      case 'cards':
        if (msg.replace) {
          $list.innerHTML = '';
          reqIdToWrap.clear();
          reachedEnd = false;
        }
        appendCards(msg.cards || []);
        if (!listLoading && $list.children.length === 0 && msg.replace) {
          showStatus('暂无数据', false);
        } else {
          hideStatus();
        }
        updateLoadMore();
        break;
      case 'loading':
        listLoading = !!msg.loading;
        if (listLoading && $list.children.length === 0) {
          showStatus('加载中…', false);
        } else if (!listLoading) {
          if ($list.children.length === 0 && !reachedEnd) {
            showStatus('暂无数据', false);
          } else {
            hideStatus();
          }
        }
        updateLoadMore();
        break;
      case 'reachEnd':
        reachedEnd = true;
        updateLoadMore();
        break;
      case 'error':
        showStatus(msg.message || '加载失败', true);
        break;
      case 'detail':
        onDetail(msg.reqId, msg.detail);
        break;
      case 'detailError':
        onDetailError(msg.reqId, msg.message);
        break;
      case 'commentsPage':
        onCommentsPage(msg.reqId, msg);
        break;
      case 'commentsError':
        onCommentsError(msg.reqId, msg.page, msg.message);
        break;
      case 'sectionsCatalog':
        openSettingsPanel(msg.builtin || [], msg.enabled || []);
        break;
      case 'imagesState': {
        // extension 下发的图片显示开关持久化值. ready 后下发一次; 收到后同步 UI + DOM
        // (已经展开的卡片正文里, 占位符与 <img> 互换, 不需要重新展开).
        imagesEnabled = msg.enabled === true;
        updateImagesToggleBtn();
        syncImagesDom();
        break;
      }
      case 'loginState': {
        // 登录态变化 (importCookie / logout / 首次 ready) 后 extension 推过来.
        // 前端只更新按钮 UI; 列表数据刷新由 extension 端 (index.ts onDidChangeLoginState
        // 监听器) 主动触发 refresh, 不在这里调.
        isLoggedIn = msg.isLoggedIn === true;
        updateLoginBtn();
        break;
      }
      default:
        break;
    }
  });

  // ---------- tab 栏 ----------
  function renderTabs(sections, current) {
    $tabs.innerHTML = '';
    sections.forEach((s) => {
      const el = document.createElement('span');
      el.className = 'tab' + (s.id === 'home' ? ' home' : '') + (s.id === current ? ' active' : '');
      el.dataset.sectionId = s.id;
      el.textContent = s.label;
      el.addEventListener('click', () => {
        if (s.id === currentSection || listLoading) return;
        vscode.postMessage({ type: 'switchSection', sectionId: s.id });
      });
      $tabs.appendChild(el);
    });
  }

  function updateActiveTab() {
    Array.from($tabs.children).forEach((el) => {
      if (el.dataset.sectionId === currentSection) el.classList.add('active');
      else el.classList.remove('active');
    });
  }

  // ---------- 卡片 ----------
  function appendCards(cards) {
    const frag = document.createDocumentFragment();
    cards.forEach((c) => frag.appendChild(buildCard(c)));
    $list.appendChild(frag);
  }

  function buildCard(c) {
    const wrap = document.createElement('div');
    wrap.className = 'card-wrap';
    wrap.dataset.linkId = c.linkId;
    wrap._cardData = c;

    const card = document.createElement('div');
    card.className = 'card' + (c.cover ? '' : ' no-cover');
    card.addEventListener('click', () => toggleExpand(wrap));

    if (c.cover) {
      const img = document.createElement('img');
      img.className = 'cover';
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.src = c.cover;
      img.addEventListener('error', () => { card.classList.add('no-cover'); });
      card.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'body';

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = c.title;
    body.appendChild(title);

    if (c.excerpt) {
      const ex = document.createElement('div');
      ex.className = 'excerpt';
      ex.textContent = c.excerpt;
      body.appendChild(ex);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    // 主页流: 来源板块角标排第一, 让用户快速识别"这是哪个游戏的内容"
    if (currentSection === 'home' && c.sourceSectionLabel) {
      meta.appendChild(makeBadge('source-tag', '来自 ' + c.sourceSectionLabel));
    }
    if (c.linkTag) meta.appendChild(makeBadge('tag', c.linkTag));
    if (c.isVideo) meta.appendChild(makeBadge('video-flag', '视频'));
    if (c.authorName) meta.appendChild(makeText(c.authorName));
    if (c.publishedAt) meta.appendChild(makeText(c.publishedAt));
    if (c.commentCount > 0) meta.appendChild(makeText('评 ' + c.commentCount));
    if (c.awardCount > 0) meta.appendChild(makeText('赞 ' + c.awardCount));
    if (meta.children.length > 0) body.appendChild(meta);

    card.appendChild(body);
    wrap.appendChild(card);
    return wrap;
  }

  function makeBadge(cls, text) {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }
  function makeText(text) {
    const el = document.createElement('span');
    el.textContent = text;
    return el;
  }

  function toggleExpand(wrap) {
    if (wrap.classList.contains('expanded')) {
      wrap.classList.remove('expanded');
      const $detail = wrap.querySelector(':scope > .detail');
      if ($detail) $detail.classList.add('hidden');
      return;
    }
    wrap.classList.add('expanded');
    const existing = wrap.querySelector(':scope > .detail');
    if (existing) {
      existing.classList.remove('hidden');
      return;
    }
    const reqId = genReqId();
    wrap.dataset.reqId = reqId;
    reqIdToWrap.set(reqId, wrap);
    const $detail = document.createElement('div');
    $detail.className = 'detail';
    $detail.innerHTML = '<div class="detail-status">加载中…</div>';
    wrap.appendChild($detail);
    const linkId = wrap.dataset.linkId;
    vscode.postMessage({ type: 'expand', reqId, linkId });
  }

  function onDetail(reqId, detail) {
    const wrap = reqIdToWrap.get(reqId);
    if (!wrap) return;
    const $detail = wrap.querySelector(':scope > .detail');
    if (!$detail) return;
    $detail.innerHTML = '';
    const card = wrap._cardData || {};

    // contentText 已经包含正文文本 + [IMG:url] 占位符 (description 内嵌图 + raw.imgs/thumbs
    // 兜底图, 后端 stripHtmlPreserveImages 统一处理过). 前端 renderTextWithImages 按
    // imagesEnabled 决定渲染成 <img> 还是占位符. 不再有独立的 .detail-imgs 区段.
    if (detail.contentText) {
      const t = document.createElement('div');
      t.className = 'detail-section-title';
      t.textContent = '正文';
      $detail.appendChild(t);
      const c = document.createElement('div');
      c.className = 'detail-content';
      renderTextWithImages(c, detail.contentText);
      $detail.appendChild(c);
    } else {
      const e = document.createElement('div');
      e.className = 'detail-status';
      e.textContent = '该帖子无正文文本 (可能是视频或图集帖, 可点 "在浏览器打开" 查看)';
      $detail.appendChild(e);
    }

    const actions = document.createElement('div');
    actions.className = 'detail-actions';

    const cmtBtn = document.createElement('button');
    cmtBtn.className = 'detail-btn';
    const cmtNum = typeof detail.commentCount === 'number' ? detail.commentCount : 0;
    cmtBtn.textContent = cmtNum > 0 ? \`查看评论 (\${cmtNum})\` : '查看评论';
    cmtBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleComments(wrap, cmtBtn);
    });
    actions.appendChild(cmtBtn);

    if (card.shareUrl) {
      const extBtn = document.createElement('button');
      extBtn.className = 'detail-btn';
      extBtn.textContent = '在浏览器打开';
      extBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        vscode.postMessage({ type: 'openExternal', url: card.shareUrl });
      });
      actions.appendChild(extBtn);
    }

    $detail.appendChild(actions);
  }

  function onDetailError(reqId, message) {
    const wrap = reqIdToWrap.get(reqId);
    if (!wrap) return;
    const $detail = wrap.querySelector(':scope > .detail');
    if (!$detail) return;
    $detail.innerHTML = '';
    const e = document.createElement('div');
    e.className = 'detail-status error';
    e.textContent = '加载详情失败: ' + (message || '未知错误') + ' (再次点击卡片可重试)';
    $detail.appendChild(e);
    const retryBtn = document.createElement('button');
    retryBtn.className = 'detail-btn';
    retryBtn.textContent = '重试';
    retryBtn.style.marginTop = '8px';
    retryBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      reqIdToWrap.delete(reqId);
      delete wrap.dataset.reqId;
      $detail.remove();
      wrap.classList.remove('expanded');
      toggleExpand(wrap);
    });
    $detail.appendChild(retryBtn);
  }

  function toggleComments(wrap, btn) {
    const $detail = wrap.querySelector(':scope > .detail');
    if (!$detail) return;
    const existing = $detail.querySelector(':scope > .comments');
    if (existing) {
      if (existing.classList.contains('hidden')) {
        existing.classList.remove('hidden');
        btn.textContent = btn.textContent.replace(/^展开/, '折叠');
      } else {
        existing.classList.add('hidden');
        btn.textContent = btn.textContent.replace(/^折叠/, '展开').replace(/^查看/, '展开');
      }
      return;
    }
    const comments = document.createElement('div');
    comments.className = 'comments';
    comments.innerHTML = '<div class="detail-status">加载评论中…</div>';
    const cmtReqId = genReqId();
    wrap.dataset.cmtReqId = cmtReqId;
    reqIdToWrap.set(cmtReqId, wrap);
    comments._nextPage = 1;
    $detail.appendChild(comments);
    btn.textContent = btn.textContent.replace(/^查看/, '折叠');
    const linkId = wrap.dataset.linkId;
    vscode.postMessage({ type: 'comments', reqId: cmtReqId, linkId, page: 1 });
  }

  function onCommentsPage(reqId, msg) {
    const wrap = reqIdToWrap.get(reqId);
    if (!wrap) return;
    const $comments = wrap.querySelector(':scope > .detail > .comments');
    if (!$comments) return;
    if (msg.page === 1) {
      $comments.innerHTML = '';
    } else {
      const oldBtn = $comments.querySelector(':scope > .comments-loadmore');
      if (oldBtn) oldBtn.remove();
      const oldStatus = $comments.querySelector(':scope > .detail-status');
      if (oldStatus) oldStatus.remove();
    }
    if (msg.page === 1 && (!msg.comments || msg.comments.length === 0)) {
      const e = document.createElement('div');
      e.className = 'comments-empty';
      e.textContent = '暂无评论';
      $comments.appendChild(e);
      return;
    }
    msg.comments.forEach((cm) => $comments.appendChild(buildComment(cm)));
    $comments._nextPage = msg.page + 1;
    if (msg.hasMore) {
      const more = document.createElement('button');
      more.className = 'comments-loadmore';
      more.textContent = '加载更多评论';
      more.addEventListener('click', (ev) => {
        ev.stopPropagation();
        more.disabled = true;
        more.textContent = '加载中…';
        const cmtReqId = wrap.dataset.cmtReqId;
        vscode.postMessage({
          type: 'comments',
          reqId: cmtReqId,
          linkId: wrap.dataset.linkId,
          page: $comments._nextPage,
        });
      });
      $comments.appendChild(more);
    }
  }

  function onCommentsError(reqId, page, message) {
    const wrap = reqIdToWrap.get(reqId);
    if (!wrap) return;
    const $comments = wrap.querySelector(':scope > .detail > .comments');
    if (!$comments) return;
    if (page === 1) {
      $comments.innerHTML = '';
      const e = document.createElement('div');
      e.className = 'detail-status error';
      e.textContent = '加载评论失败: ' + (message || '未知错误');
      $comments.appendChild(e);
    } else {
      const old = $comments.querySelector(':scope > .comments-loadmore');
      if (old) {
        old.disabled = false;
        old.textContent = '加载失败, 点击重试';
      } else {
        const e = document.createElement('div');
        e.className = 'detail-status error';
        e.textContent = '加载下一页评论失败: ' + (message || '未知错误');
        $comments.appendChild(e);
      }
    }
  }

  function buildComment(cm) {
    const item = document.createElement('div');
    item.className = 'comment-item';
    item.dataset.commentId = cm.commentId;
    const ava = document.createElement('img');
    ava.className = 'comment-avatar';
    if (cm.avatar) {
      ava.src = cm.avatar;
      ava.referrerPolicy = 'no-referrer';
      ava.loading = 'lazy';
      ava.addEventListener('error', () => ava.remove());
    }
    item.appendChild(ava);
    const body = document.createElement('div');
    body.className = 'comment-body';
    const head = document.createElement('div');
    head.className = 'comment-head';
    if (cm.isTop) head.appendChild(makeBadge('top-flag', '置顶'));
    const u = document.createElement('span');
    u.className = 'username';
    u.textContent = cm.username || '匿名';
    head.appendChild(u);
    if (cm.level > 0) head.appendChild(makeBadge('level', 'Lv' + cm.level));
    if (cm.floorNum > 0) head.appendChild(makeText(cm.floorNum + 'F'));
    if (cm.ipLocation) head.appendChild(makeText(cm.ipLocation));
    body.appendChild(head);
    const text = document.createElement('div');
    text.className = 'comment-text';
    text.textContent = cm.text || '';
    body.appendChild(text);
    const foot = document.createElement('div');
    foot.className = 'comment-foot';
    if (cm.up > 0) foot.appendChild(makeText('👍 ' + cm.up));
    if (cm.childNum > 0) foot.appendChild(makeText('💬 ' + cm.childNum + ' 条回复'));
    if (foot.children.length > 0) body.appendChild(foot);
    item.appendChild(body);
    return item;
  }

  function showStatus(text, isError) {
    $status.textContent = text;
    $status.classList.toggle('error', !!isError);
    $status.classList.remove('hidden');
  }
  function hideStatus() { $status.classList.add('hidden'); }

  function updateLoadMore() {
    if (reachedEnd) {
      if ($list.children.length > 0) {
        $loadMore.textContent = '— 已经到底了 —';
        $loadMore.disabled = true;
        $loadMore.classList.remove('hidden');
      } else {
        $loadMore.classList.add('hidden');
      }
      return;
    }
    if (listLoading) {
      $loadMore.textContent = '加载中…';
      $loadMore.disabled = true;
      $loadMore.classList.remove('hidden');
      return;
    }
    if ($list.children.length === 0) {
      $loadMore.classList.add('hidden');
      return;
    }
    $loadMore.textContent = '加载更多';
    $loadMore.disabled = false;
    $loadMore.classList.remove('hidden');
  }

  $loadMore.addEventListener('click', () => {
    if (listLoading || reachedEnd) return;
    vscode.postMessage({ type: 'loadMore' });
  });

  window.addEventListener('scroll', () => {
    if (listLoading || reachedEnd) return;
    const scrollY = window.scrollY || document.documentElement.scrollTop;
    const viewH = window.innerHeight;
    const totalH = document.documentElement.scrollHeight;
    if (totalH - scrollY - viewH < 200) {
      vscode.postMessage({ type: 'loadMore' });
    }
  });

  // ---------- 设置面板 ----------
  $settingsBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
  });

  /**
   * 打开设置面板. 设计:
   *   - 单一列表: 内置板块复选 (双列 grid, home 项 disabled 永远 checked)
   *   - 底部: [取消] [保存]
   *
   * 保存时把 enabled (id 数组) post 回去, extension 写 globalState.
   *
   * @param builtin Array<{id, label, verified}>
   * @param enabled string[]
   */
  function openSettingsPanel(builtin, enabled) {
    $settingsRoot.innerHTML = '';
    const enabledSet = new Set(enabled);
    // 本地草稿副本 — 用户点保存才生效, 取消则丢弃
    const draftEnabled = new Set(enabledSet);

    const mask = document.createElement('div');
    mask.className = 'settings-mask';
    mask.addEventListener('click', (e) => {
      if (e.target === mask) closeSettings();
    });

    const panel = document.createElement('div');
    panel.className = 'settings-panel';

    // 标题
    const titleBar = document.createElement('div');
    titleBar.className = 'settings-title';
    titleBar.appendChild(makeText('小黑盒板块设置'));
    const closeBtn = document.createElement('button');
    closeBtn.className = 'settings-close';
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeSettings);
    titleBar.appendChild(closeBtn);
    panel.appendChild(titleBar);

    // 描述
    const desc = document.createElement('div');
    desc.className = 'settings-desc';
    desc.textContent =
      '勾选要显示的板块。主页 (🏠) 会把所有勾选的板块本地混排成"推荐流"，所以建议至少勾 3-5 个。';
    panel.appendChild(desc);

    // 内置板块
    const builtinTitle = document.createElement('div');
    builtinTitle.className = 'settings-section-title';
    builtinTitle.textContent = '内置板块';
    panel.appendChild(builtinTitle);

    const builtinList = document.createElement('div');
    builtinList.className = 'settings-list';
    // home 永远第一项, 不可取消
    builtinList.appendChild(buildSectionRow(
      { id: 'home', label: '主页 (推荐流)', verified: true },
      true,
      true, // disabled
      () => {},
    ));
    builtin.forEach((s) => {
      builtinList.appendChild(buildSectionRow(
        s,
        draftEnabled.has(s.id),
        false,
        (checked) => {
          if (checked) draftEnabled.add(s.id);
          else draftEnabled.delete(s.id);
        },
      ));
    });
    panel.appendChild(builtinList);

    // 底部按钮
    const actions = document.createElement('div');
    actions.className = 'settings-actions';
    const cancel = document.createElement('button');
    cancel.className = 'settings-btn secondary';
    cancel.textContent = '取消';
    cancel.addEventListener('click', closeSettings);
    actions.appendChild(cancel);
    const save = document.createElement('button');
    save.className = 'settings-btn primary';
    save.textContent = '保存';
    save.addEventListener('click', () => {
      // 兜底: enabled 只保留 builtin 里的 id (home + builtin)
      const validIds = new Set(['home', ...builtin.map((b) => b.id)]);
      const cleanEnabled = Array.from(draftEnabled).filter((id) => validIds.has(id));
      vscode.postMessage({
        type: 'saveSettings',
        enabled: cleanEnabled,
      });
      closeSettings();
    });
    actions.appendChild(save);
    panel.appendChild(actions);

    mask.appendChild(panel);
    $settingsRoot.appendChild(mask);
  }

  function buildSectionRow(s, checked, disabled, onChange) {
    const row = document.createElement('label');
    row.className = 'settings-row' + (disabled ? ' disabled' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    if (disabled) cb.disabled = true;
    cb.addEventListener('change', () => onChange(cb.checked));
    row.appendChild(cb);
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = s.label;
    row.appendChild(label);
    return row;
  }

  function closeSettings() {
    $settingsRoot.innerHTML = '';
  }

  // ---------- 图片渲染 / 开关 ----------
  /**
   * 把含 [IMG:url] 占位符的文本切片渲染到 container 里. 非图片部分作为文本节点保留
   * (.detail-content 的 white-space: pre-wrap 会保留换行); 图片部分根据 imagesEnabled
   * 渲染成 <img> 或占位 span.
   *
   * 正则锚住 [IMG: 起始 ] 结束, 中间允许除 ] 外任意字符 (后端 imgPlaceholder 已把 url
   * 里的 ] 转义成 %5D). 不容错 — 后端格式契约保证, 出错就当文本走.
   */
  function renderTextWithImages(container, text) {
    container.innerHTML = '';
    if (!text) return;
    const re = /\\[IMG:([^\\]]+)\\]/g;
    let lastIdx = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > lastIdx) {
        container.appendChild(document.createTextNode(text.slice(lastIdx, m.index)));
      }
      container.appendChild(
        imagesEnabled ? createImgNode(m[1]) : createImgPlaceholder(m[1]),
      );
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
  }

  /** 创建真实 <img> (图片开启态). 加载失败时降级为 inline-img-broken 占位. */
  function createImgNode(src) {
    const img = document.createElement('img');
    img.className = 'inline-img';
    img.dataset.src = src;
    img.src = src;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = '[图片]';
    img.addEventListener('error', () => {
      const fb = document.createElement('span');
      fb.className = 'inline-img-broken';
      fb.dataset.src = src;
      fb.textContent = '[图片加载失败]';
      img.replaceWith(fb);
    });
    return img;
  }

  /**
   * 创建占位 span (图片关闭态). data-src 留着, 切到开启时一键升级为 <img>.
   * 自身可点击 -> 直接开全局图片开关 (比工具栏 🖼️ 按钮更易被发现).
   */
  function createImgPlaceholder(src) {
    const span = document.createElement('span');
    span.className = 'inline-img-placeholder';
    span.dataset.src = src;
    span.textContent = '🖼️ 点击显示图片';
    span.title = '点击启用图片显示 (会显示所有正文图片). 原图: ' + src;
    span.addEventListener('click', (ev) => {
      // 阻止冒泡 -> 防止误触发卡片折叠 (上层 .card 有 click listener toggleExpand)
      ev.stopPropagation();
      setImagesEnabled(true);
    });
    return span;
  }

  /**
   * 把 DOM 里所有图片节点同步到当前 imagesEnabled 状态.
   *   开启 → .inline-img-placeholder / .inline-img-broken → <img>
   *   关闭 → <img.inline-img> / .inline-img-broken → .inline-img-placeholder
   * 用 data-src 做反向恢复. 全局扫描 (类名独特, 无副作用).
   */
  function syncImagesDom() {
    if (imagesEnabled) {
      document.querySelectorAll('.inline-img-placeholder, .inline-img-broken').forEach((el) => {
        const src = el.dataset.src;
        if (!src) return;
        el.replaceWith(createImgNode(src));
      });
    } else {
      document.querySelectorAll('img.inline-img, .inline-img-broken').forEach((el) => {
        const src = el.dataset.src;
        if (!src) return;
        el.replaceWith(createImgPlaceholder(src));
      });
    }
  }

  /** 同步图片开关按钮的视觉态 (class + title). */
  function updateImagesToggleBtn() {
    if (!$imagesToggleBtn) return;
    $imagesToggleBtn.classList.toggle('on', imagesEnabled);
    $imagesToggleBtn.title = imagesEnabled
      ? '当前: 显示正文图片 — 点击关闭 (摸鱼伪装感)'
      : '当前: 不显示正文图片 (默认, 不发任何请求) — 点击开启';
  }

  /**
   * 统一切换图片显示状态 — 改 imagesEnabled + 同步 DOM + 持久化到 extension.
   * 工具栏按钮 click / 占位 click 都走这个函数, 避免逻辑分叉.
   * 幂等: 目标态跟当前态相同时直接 return, 不重复 syncDom / postMessage.
   */
  function setImagesEnabled(enabled) {
    const next = !!enabled;
    if (imagesEnabled === next) return;
    imagesEnabled = next;
    updateImagesToggleBtn();
    syncImagesDom();
    vscode.postMessage({ type: 'setImagesEnabled', enabled: imagesEnabled });
  }

  // 工具栏 🖼️ 按钮 — 切换全局开关
  if ($imagesToggleBtn) {
    $imagesToggleBtn.addEventListener('click', () => {
      setImagesEnabled(!imagesEnabled);
    });
  }

  // ---------- 登录按钮 ----------
  /**
   * 同步登录按钮的视觉态 + tooltip.
   *   - 未登录: 默认灰色, hover 提示 "点击登录"
   *   - 已登录: 加 .on (绿色强调), hover 提示 "已登录, 点击可重新导入/退出"
   * 故意不显示用户名 — 1) 简化按钮, 不抢工具栏空间; 2) 不漏隐私 (摸鱼场景旁观者
   * 看不到账号信息)
   */
  function updateLoginBtn() {
    if (!$loginBtn) return;
    $loginBtn.classList.toggle('on', isLoggedIn);
    $loginBtn.title = isLoggedIn
      ? '当前: 已登录 (主页走个性化推荐流) — 点击可重新导入 Cookie 或退出登录'
      : '当前: 未登录 — 点击导入 Cookie 登录, 启用个性化推荐流';
  }

  // 点击 -> 交给 extension 决策 (extension 根据当前登录态弹 InputBox / QuickPick)
  if ($loginBtn) {
    $loginBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clickLoginBtn' });
    });
  }

  // ---------- tab-bar 高度 → CSS var --tab-bar-h ----------
  // 展开的 .card 用这个值做 sticky top, 紧贴 tab-bar 下方. 必须实时跟随:
  //   - vscode 字号变化: .tab 的实际像素高度会跟着变
  //   - 主题切换 / 用户拖宽 sidebar (引发 reflow)
  // ResizeObserver 安装后会立即回调一次, 不需要再手动调初始值. 老环境无该 API 时
  // 用一次性测量兜底 (大多数 vscode 版本都内置, 这里只是保险).
  const $tabBar = document.querySelector('.tab-bar');
  function syncTabBarHeight() {
    const h = $tabBar ? $tabBar.offsetHeight : 0;
    document.documentElement.style.setProperty('--tab-bar-h', h + 'px');
  }
  if ($tabBar) {
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(syncTabBarHeight).observe($tabBar);
    } else {
      syncTabBarHeight();
    }
    window.addEventListener('resize', syncTabBarHeight);
  }

  // ---------- ready ----------
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

/** 生成 CSP nonce */
function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}
