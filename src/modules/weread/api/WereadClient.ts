import * as vscode from 'vscode';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { AuthService } from '../auth/AuthService';
import { getBookReaderUrl } from './wereadUrl';
import { calcHash, sign, currentTime } from './wereadSign';
import { chk, dH, dS, dT } from './wereadDecrypt';
import { normalizeStoreBook, parseCategoryBooks, parseCategoryTree } from './wereadStore';
import {
  BestBookmark,
  BookProgress,
  BookshelfData,
  BookshelfResponse,
  ChapterInfosResponse,
  ChapterUnderline,
  Review,
  ReviewAuthor,
  StoreBook,
  StoreCategoryTree,
  StoreSearchResult,
  WereadArchive,
  WereadBook,
  WereadChapter,
  WereadUser,
} from '../types';

/**
 * 章节内容抓取结果。
 *
 * 微信读书 web 端章节正文采用「分片 + 签名 + 自定义解密」的方式下发,
 * 解密成功后即可拿到原始 HTML/TXT, 无需字体映射。
 *
 * 字段含义:
 * - `html`     成功时为解密后的章节正文 HTML(可直接放进 iframe srcdoc)
 * - `style`    成功时为章节专属的内联 CSS(epub 才有, 已 dS 解密)
 * - `format`   epub / pdf / txt，便于 UI 决定渲染方式
 * - `content`  txt 类型的纯文本; epub 时为 null
 * - `diagnostics` 抓取过程的关键日志(成功/失败都会填充, 便于排障)
 * - `fallbackUrl` 失败时用于"在浏览器中打开"按钮的 URL
 */
export interface ChapterFetchResult {
  /** 解密后的 HTML(epub/pdf) — null 表示该路径不可用 */
  html: string | null;
  /** 解密后的内联 CSS(epub/pdf) — null 表示无 */
  style: string | null;
  /** 解密后的纯文本(txt) — null 表示该路径不可用 */
  content: string | null;
  /** 后端报告的图书格式 */
  format: string | null;
  /** 诊断日志 */
  diagnostics: string;
  /** 用于跳浏览器的最终 chapter URL */
  fallbackUrl: string;
}

/**
 * 微信读书 HTTP 客户端。
 *
 * 设计要点：
 * - 统一通过 axios 实例发送请求，自动注入 Cookie 与 UA。
 * - 接口路径基于社区已知的网页端 endpoint，所有调用均为只读 GET/POST。
 * - 对 401/登录失效进行识别，提示用户重新导入 Cookie。
 *
 * 风险声明：微信读书未提供官方 API，本客户端使用的接口可能随时变更或失效。
 */
export class WereadClient {
  private static readonly BASE_URL = 'https://weread.qq.com';

  private http: AxiosInstance;

  /**
   * 最近一次成功(非异常)收到 response 的时间戳。
   *
   * 用途: 兜底体检 / 调试日志。注意 **不要** 拿这个字段做"是否需要续 cookie"的节流判断 —
   * 业务请求并不下发 Set-Cookie 续 wr_skey (见 refreshCookieByHomepage 注释),
   * 用它做节流会让续命心跳被业务请求 "假阳性" 地跳过, 翻几章就过期。
   * 真正的续命节流应该用 lastHomepageRefreshAt。
   */
  public lastResponseAt = 0;

  /**
   * 最近一次 HEAD / 续命 **成功** (拿到 Set-Cookie) 的时间戳。
   *
   * 这才是定时/聚焦心跳应该看的字段。
   *
   * 设计动机: 之前的 tryRefreshCookie 用 lastResponseAt 做节流, 但用户连续翻章节时
   * 业务响应一直刷新 lastResponseAt, 25min 定时永远 < 节流窗口, 一次都不会真正
   * 触发 HEAD / — 表现就是用户日志里报的 "看了一章下一章就 -2012 登录超时"。
   *
   * 注意只在 **拿到 Set-Cookie** 时更新, 失败 / 没拿到 Set-Cookie 都不更新,
   * 让下次心跳能立即重试 (HEAD / 本身代价很低)。
   */
  public lastHomepageRefreshAt = 0;

  /**
   * 最近一次"章节失败兜底体检"的时间戳, 用于节流。
   *
   * 背景: weread 的章节加密分片接口 (`/web/book/chapter/e_*`) 在 cookie 失效时
   * **不返回 401**, 而是返回 200 + chk() 校验不过的乱码。response interceptor 里的
   * isUnauthorized 识别不到, 用户看到的兜底提示是"可能是付费/试读/接口变更",
   * 完全意识不到其实是登录失效, 必须手动去命令面板才能重登。
   *
   * 修复: 在 fetchChapterContent 解密失败时, 主动打一发 /web/user 做登录体检 —
   * 若 /web/user 401/errcode, response interceptor 会自动 notifyExpired 弹通知,
   * 让用户拿到准确反馈。
   *
   * 节流 30s 是为了避免用户连续翻多个章节都失败时一直戳 /web/user。
   */
  private lastHealthCheckAt = 0;

  /**
   * 标志: server 已经废弃了我们的 wr_rt — 续命彻底失败, 任何重试都是徒劳。
   *
   * 触发条件: /web/login/renewal 返回 errCode=-2013 (鉴权失败) 或 -12013 (授权过期)。
   *
   * 触发后的行为变化:
   *   1) 后续 renewWebLogin 直接 return false, 不再打无效请求
   *   2) fetchChapterContentOnce 收到 /web/book/info 的 -2012 时, 直接判定为"登录已失效",
   *      不再走"体检通过 → 提示付费/试读"的误导路径
   *   3) 心跳定时/聚焦续命直接跳过, 不再骚扰 server
   *
   * 重置时机: 用户成功导入新 cookie 后 (AuthService.importCookie 成功调用 markRenewalAlive)
   */
  private renewalDead = false;

  /**
   * 图片 dataURL 缓存: url → Promise<dataURL|null>。
   *
   * 为什么用 Promise 而不是直接 string?
   *   1) 多个并发请求同一张图(同章节里 srcset / 多次出现)只发一次 axios
   *   2) 章节"二次渲染"(先无 underlines 兜底, underlines 到了再重渲)
   *      不会重复下载 — 第二轮 rewriteImageSrcsToDataUrls 直接 hit 缓存
   *
   * 不上 LRU: 一本书的图片总数有限(几百张顶天), 切书也罕见到要清, 简单 Map 够用。
   */
  private imageDataUrlCache: Map<string, Promise<string | null>> = new Map();

  /**
   * 书城榜单/分类的内存缓存: categoryId → { 拉取时刻, 书单 }。
   *
   * 榜单要拉一整张 SSR 页面 (600KB+), 但内容变化以天计, 用户在 chip 之间来回切
   * 不该反复打网络。TTL 10 分钟, 顶部"刷新"按钮走 force 绕过。
   * 进程级缓存, 不落盘 — 重启 VSCode 自然失效, 不需要考虑陈旧数据治理。
   */
  private categoryCache: Map<string, { at: number; books: StoreBook[] }> = new Map();
  private static readonly CATEGORY_TTL_MS = 10 * 60 * 1000;

  /**
   * 书城分类树缓存 (GET /web/categories 的解析结果)。
   *
   * 那个接口一次 430KB, 但内容是"微信读书有哪些分类", 属于半年都不带变的元数据,
   * 所以缓存 6 小时。UI 侧还会先用内置常量把 chips 画出来, 树到了再无感替换,
   * 用户永远不会对着空白等这 430KB。
   */
  private categoryTreeCache: { at: number; tree: StoreCategoryTree } | null = null;
  private static readonly CATEGORY_TREE_TTL_MS = 6 * 60 * 60 * 1000;

  constructor(private readonly auth: AuthService) {
    this.http = this.buildHttpClient();
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('weread')) {
        this.http = this.buildHttpClient();
      }
    });
  }

  private buildHttpClient(): AxiosInstance {
    const config = vscode.workspace.getConfiguration('weread');
    const timeout = config.get<number>('requestTimeout', 15000);
    const userAgent = config.get<string>(
      'userAgent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );
    const instance = axios.create({
      baseURL: WereadClient.BASE_URL,
      timeout,
      headers: {
        'User-Agent': userAgent,
        Referer: 'https://weread.qq.com/',
        Accept: 'application/json, text/plain, */*',
      },
      validateStatus: (status) => status >= 200 && status < 500,
    });

    // ---- Cookie 保活 interceptor ----
    //
    // 在裸 axios + 手动拼 Cookie 头的架构里, 浏览器自动处理的两件事必须我们自己做:
    //
    //   1) wr_skey 续签
    //      微信读书 server 会在某些响应里下发 `Set-Cookie: wr_skey=xxx; ...` 续期,
    //      浏览器会自动覆盖本地 cookie。我们这里把它合并回 SecretStorage,
    //      下一次 buildHeaders() 就会带上新的 wr_skey,
    //      理论上只要插件在跑、定期有请求, wr_skey 永远不会因自然到期而失效。
    //
    //   2) 失效感知
    //      之前的代码 (isUnauthorized) 只是在某些方法里 throw,
    //      抛上去也仅仅是个红字 errorMessage,用户得手动去点"导入 Cookie"。
    //      在 interceptor 统一拦截后, 任何接口失效都会触发 notifyExpired()
    //      弹一个带"重新导入"按钮的通知,降低断流成本。
    //
    // 注意: interceptor 返回的是 Promise, 但我们 *不 await* mergeAndPersistCookies / notifyExpired,
    // 否则会拖慢业务响应 — 这两个副作用对调用方都是透明的,失败也只是少续一次,无需阻塞。
    instance.interceptors.response.use(
      (response) => {
        this.lastResponseAt = Date.now();
        const setCookie = response.headers?.['set-cookie'];
        if (Array.isArray(setCookie) && setCookie.length > 0) {
          void this.auth.mergeAndPersistCookies(setCookie);
        }
        if (this.isUnauthorized(response.status, response.data)) {
          // 诊断日志: 同时打印 errcode 和 errCode (两种大小写),
          // 之前只取 errcode 导致 "status=200 errcode=(none) 却被判失效" 的欺骗性日志,
          // 真相是 server 用了 errCode (大写 C), 触发了判定但日志看起来一切正常。
          const url = response.config?.url ?? '(unknown)';
          const obj = response.data as Record<string, unknown> | null;
          const errcode = obj?.errcode;
          const errCode = obj?.errCode;
          console.log(
            `[weread-vscode] 检测到登录失效信号: url=${url} status=${response.status} errcode=${errcode ?? '(none)'} errCode=${errCode ?? '(none)'}`,
          );
          void this.auth.notifyExpired();
        }
        return response;
      },
      (error) => Promise.reject(error),
    );

    return instance;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const cookie = this.auth.getCookieHeader();
    return {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(extra ?? {}),
    };
  }

  private isUnauthorized(status: number, data: unknown): boolean {
    // 强信号: HTTP 401/403 直接判失效, 这是 cookie 过期最可靠的标志
    if (status === 401 || status === 403) {
      return true;
    }
    // 弱信号: 仅当 status 也异常 (>=400) 时, 才看 body 里的 errcode/errCode 黑名单。
    //
    // 修复历史 (2026-06): 之前不要求 status 异常就看 errcode, 结果 weread 的部分接口
    // (实测 /web/book/info) 在 status=200 时会回带某个业务用途的 errCode 字段,
    // 数值刚好落在我们的失效黑名单里, 导致每隔几分钟误弹"登录失效"通知,
    // 但 wr_skey 续签 / 上报阅读进度 / 章节解密全程正常 — 妥妥的 false positive。
    //
    // 收紧到"HTTP 异常 + errcode 命中"的双重信号后, 误报应该消失;
    // 真的失效场景 (server 返 4xx) 仍然能被准确捕获。
    // 失效码黑名单参考 touchfish 反编译: -2010 / -2012 / -2013 / -12013。
    if (status >= 400 && data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      const code = obj.errcode ?? obj.errCode;
      if (
        code === -2010 ||
        code === -2012 ||
        code === -2013 ||
        code === -12013
      ) {
        return true;
      }
    }
    return false;
  }

  private handleError(scene: string, error: unknown): never {
    if (axios.isAxiosError(error)) {
      const err = error as AxiosError;
      const msg = err.message || '未知网络错误';
      throw new Error(`[微信读书] ${scene}失败：${msg}`);
    }
    if (error instanceof Error) {
      throw new Error(`[微信读书] ${scene}失败：${error.message}`);
    }
    throw new Error(`[微信读书] ${scene}失败：未知错误`);
  }

  public ensureLogin(): void {
    if (!this.auth.isLoggedIn()) {
      throw new Error('未登录，请先导入 Cookie');
    }
  }

  /**
   * 主动续 wr_skey 的官方接口: POST /web/login/renewal
   *
   * 这是微信读书 web 端**主动续 token 的官方接口** (touchFish 项目验证),
   * 行为远比 HEAD / 可靠:
   *
   *   接口: POST https://weread.qq.com/web/login/renewal
   *   body: { rq: encodeURIComponent(<原请求路径>) }
   *   header: Cookie
   *   响应:
   *     成功: { succ: 1 } + Set-Cookie 头里下发新的 wr_skey / wr_vid / wr_rt
   *     失败: { errCode: -2013, errMsg: "鉴权失败" } / { errCode: -12013, errMsg: "授权过期" }
   *
   * 历史教训:
   *   - 之前我们用 HEAD / 续命, 表面看也能"偶尔"拿到 Set-Cookie, 但实测 weread server
   *     对 HEAD / 是否下发新 wr_skey 没有保证 (取决于内部策略), 用户连续翻几章后
   *     /web/book/info 仍会先死, 报 errCode=-2012, 体感就是"几分钟就失效"。
   *   - /web/login/renewal 是 server 显式定义的续命入口, 只要 wr_rt (refresh token)
   *     还有效就一定下发新 skey, 比 HEAD / 稳定一个数量级。
   *
   * Set-Cookie 的 merge 由 response interceptor 自动完成 (mergeAndPersistCookies),
   * 这里只判断 succ === 1 即可。
   *
   * @param rq  原请求路径, 默认填首页, 一般无需关心
   * @returns true 表示续命成功 (succ=1)
   */
  public async renewWebLogin(rq: string = 'https://weread.qq.com/'): Promise<boolean> {
    if (!this.auth.isLoggedIn()) return false;
    // 锁: renewal 已被 server 判定彻底失败 (-2013/-12013), 重试无意义
    if (this.renewalDead) {
      console.log('[weread-vscode] renewalDead=true, 跳过 renewal (用户需重新登录浏览器)');
      return false;
    }
    // 前置体检: 没有 wr_rt (refresh token) 的话 renewal 是必败的, 直接告警让用户重导
    const jar = this.auth.getCookieJar();
    if (!jar['wr_rt']) {
      console.warn(
        '[weread-vscode] /web/login/renewal 前置检查失败 — 当前 cookie 缺少 wr_rt, ' +
          'renewal 接口必然返回鉴权失败。请重新导入 Cookie, 务必从 Network → Request Headers → Cookie 复制完整字符串。',
      );
      // 主动弹通知, 否则用户只能看几分钟就 -2012 而不知道原因
      this.renewalDead = true;
      void this.auth.notifyRenewalDead('missing_wr_rt');
      return false;
    }
    try {
      const res = await this.http.post(
        '/web/login/renewal',
        { rq: encodeURIComponent(rq) },
        {
          headers: this.buildHeaders({
            'Content-Type': 'application/json',
            // weread server 对 renewal 接口校验 Origin/Referer 比较严, 显式补齐确保通过
            Origin: 'https://weread.qq.com',
            Referer: 'https://weread.qq.com/',
          }),
        },
      );
      const data = (res.data ?? {}) as Record<string, unknown>;
      const succ = data.succ === 1 || data.succ === '1';
      const setCookie = res.headers?.['set-cookie'];
      const cookieCnt = Array.isArray(setCookie) ? setCookie.length : 0;
      // 把每条 Set-Cookie 的 key 列出来, 便于排查 server 到底续了什么字段
      const cookieKeys: string[] = Array.isArray(setCookie)
        ? (setCookie as string[])
            .map((h) => {
              const semi = h.indexOf(';');
              const pair = semi >= 0 ? h.slice(0, semi) : h;
              const eq = pair.indexOf('=');
              return eq > 0 ? pair.slice(0, eq).trim() : '?';
            })
            .filter(Boolean)
        : [];
      console.log(
        `[weread-vscode] /web/login/renewal status=${res.status} succ=${succ} Set-Cookie=${cookieCnt} 条 [${cookieKeys.join(', ')}]` +
          (!succ ? ` errCode=${data.errCode ?? '(none)'} errMsg=${data.errMsg ?? ''}` : ''),
      );
      if (succ) {
        this.lastHomepageRefreshAt = Date.now();
        return true;
      }
      // -2013 鉴权失败 / -12013 授权过期: refresh token 在 server 端已被废弃
      // (可能用户在浏览器点了退出 / 异地登录被踢 / weread 主动清退), 此时 wr_rt
      // 本身完好但 server 不认 — 重复调用 renewal 完全没用, 必须用户**重新登录浏览器**
      // 再复制 cookie (而不是再复制一次同一份 cookie)。
      if (data.errCode === -2013 || data.errCode === -12013) {
        console.warn(
          '[weread-vscode] renewal 鉴权失败 (errCode 命中续命彻底失败码), 锁定 renewalDead, 通知用户重新登录浏览器',
        );
        this.renewalDead = true;
        void this.auth.notifyRenewalDead(
          data.errCode === -12013 ? 'auth_expired' : 'auth_failed',
        );
      }
      return false;
    } catch (e) {
      console.warn('[weread-vscode] /web/login/renewal 异常:', (e as Error)?.message);
      return false;
    }
  }

  /**
   * 主动续 wr_skey 的统一入口 (含降级兜底)。
   *
   * 策略 (touchFish 反编译参考):
   *   1. 先打官方续命接口 POST /web/login/renewal — 99% 的情况这里就续上了
   *   2. renewal 失败再试 HEAD / 兜底 — **仅当不是鉴权失败时** 才走这一步
   *
   * 重要: renewalDead 锁定后不要再走 HEAD / 兜底 —
   *   实测当 wr_rt 在 server 端已被废弃时, HEAD / 表面续到的"新 wr_skey" 实际上对
   *   `/web/book/info` 这类校验严的接口完全无效 (体感: HEAD 续了 → /web/user 通过 →
   *   /web/book/info 仍 -2012)。这种"假续命"反而让用户以为 cookie 没事, 继续翻章节
   *   不断撞墙。锁定后直接返回 false, 让上层走"清退本地 cookie 提示重登"。
   *
   * 命名保留 `refreshCookieByHomepage` 是为了兼容外部调用方 (index.ts 心跳 /
   * fetchChapterContent 重试外壳), 但实际不一定走 HEAD / 了。
   */
  public async refreshCookieByHomepage(): Promise<boolean> {
    if (!this.auth.isLoggedIn()) return false;

    // 优先: 官方续命接口
    if (await this.renewWebLogin()) {
      return true;
    }

    // renewal 已被 server 判定彻底失败时, HEAD / 即使返回 Set-Cookie 也是无效的"幽灵续命"
    // 直接放弃, 让上层走重登提示链路
    if (this.renewalDead) {
      return false;
    }

    // 兜底: HEAD / — 仅在 renewal 网络异常时再赌一次
    try {
      const res = await this.http.head('/', { headers: this.buildHeaders() });
      const setCookie = res.headers?.['set-cookie'];
      const got = Array.isArray(setCookie) && setCookie.length > 0;
      console.log(
        `[weread-vscode] HEAD / (兜底) status=${res.status} Set-Cookie=${got ? (setCookie as string[]).length + ' 条' : '无'}`,
      );
      if (got) {
        this.lastHomepageRefreshAt = Date.now();
      }
      return got;
    } catch (e) {
      console.warn('[weread-vscode] HEAD / (兜底) 异常:', (e as Error)?.message);
      return false;
    }
  }

  /** 用户成功导入新 cookie 后由外部调用, 重置 renewal 状态 */
  public markRenewalAlive(): void {
    if (this.renewalDead) {
      console.log('[weread-vscode] renewalDead 已重置 — 新 cookie 已生效, 续命链路重新激活');
    }
    this.renewalDead = false;
  }

  /** 当前 renewal 是否处于"死锁"状态 (UI 层判断时用) */
  public isRenewalDead(): boolean {
    return this.renewalDead;
  }

  /** 获取当前用户信息（用作登录态验证） */
  public async getCurrentUser(): Promise<WereadUser | null> {
    this.ensureLogin();
    const jar = this.auth.getCookieJar();
    const vid = jar['wr_vid'];
    if (!vid) {
      throw new Error('Cookie 中缺少 wr_vid，无法识别用户');
    }
    try {
      const res = await this.http.get('/web/user', {
        params: { userVid: vid },
        headers: this.buildHeaders(),
      });
      if (this.isUnauthorized(res.status, res.data)) {
        throw new Error('登录已失效，请重新导入 Cookie');
      }
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.data as WereadUser;
    } catch (e) {
      this.handleError('获取用户信息', e);
    }
  }

  /**
   * 同步获取书架(含云端进度索引)。
   *
   * 接口 `/web/shelf/sync` 同时返回:
   *   - books         所有书的精简信息
   *   - archive       用户自建的"分组"列表(每个分组带 bookIds)
   *   - bookProgress  阅读进度(含 chapterUid / chapterIdx / updateTime)
   *
   * 之前的版本只取了 books, 然后按 `book.category` (官方分类)分组, 与微信读书
   * web/客户端里的"我建的分组"对不上。这里改为返回完整的 archive 信息和
   * progressMap, 让 UI 既能正确分组, 也能做"最近在读"恢复。
   */
  public async getBookshelf(): Promise<BookshelfData> {
    this.ensureLogin();
    try {
      const res = await this.http.get<BookshelfResponse>('/web/shelf/sync', {
        headers: this.buildHeaders(),
      });
      if (this.isUnauthorized(res.status, res.data)) {
        throw new Error('登录已失效，请重新导入 Cookie');
      }
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = res.data ?? {};
      const books = Array.isArray(data.books) ? data.books : [];

      // ---- 整理云端进度索引 ----
      const progressMap = new Map<string, BookProgress>();
      let lastReadBookId: string | undefined;
      let lastUpdateTime = -1;
      for (const p of data.bookProgress ?? []) {
        if (!p?.bookId) continue;
        const bp: BookProgress = {
          bookId: p.bookId,
          chapterUid: typeof p.chapterUid === 'number' ? p.chapterUid : undefined,
          chapterIdx: typeof p.chapterIdx === 'number' ? p.chapterIdx : undefined,
          progress: typeof p.progress === 'number' ? p.progress : undefined,
          finished: typeof p.finished === 'boolean' ? p.finished : undefined,
          updateTime: typeof p.updateTime === 'number' ? p.updateTime : undefined,
        };
        progressMap.set(p.bookId, bp);
        if (typeof bp.updateTime === 'number' && bp.updateTime > lastUpdateTime) {
          lastUpdateTime = bp.updateTime;
          lastReadBookId = p.bookId;
        }
      }

      const enrichedBooks = books.map((b) => {
        const p = progressMap.get(b.bookId);
        return {
          ...b,
          progress: b.progress ?? p?.progress,
          finished: b.finished ?? p?.finished,
        };
      });

      const rawArchives = Array.isArray(data.archive) ? data.archive : [];
      const archives: WereadArchive[] = rawArchives
        .filter((a) => a && Array.isArray(a.bookIds))
        .map((a) => ({
          archiveId: a.archiveId,
          name: typeof a.name === 'string' && a.name.trim() ? a.name : '未命名分组',
          bookIds: a.bookIds,
        }));

      return { books: enrichedBooks, archives, progressMap, lastReadBookId };
    } catch (e) {
      this.handleError('获取书架', e);
    }
  }

  /**
   * 拉取单本书的云端阅读进度。
   *
   * 接口 `/web/book/getProgress?bookId=xxx` 返回:
   *   { synckey, book: { chapterUid, chapterIdx, progress, updateTime, ... } }
   *
   * 用来在"打开某本书"时把游标定位到上次阅读的章节, 实现多端互通。
   * 失败/未登录都返回 null, 不抛错(进度恢复属于增强体验, 不阻断主流程)。
   */
  public async getBookProgress(bookId: string): Promise<BookProgress | null> {
    if (!this.auth.isLoggedIn()) return null;
    try {
      const res = await this.http.get('/web/book/getProgress', {
        params: { bookId },
        headers: this.buildHeaders(),
      });
      if (res.status < 200 || res.status >= 300) return null;
      const data = (res.data ?? {}) as Record<string, unknown>;
      const book = ((data.book as Record<string, unknown>) ?? data) as Record<string, unknown>;
      if (!book) return null;
      const pick = (k: string) => (typeof book[k] === 'number' ? (book[k] as number) : undefined);
      return {
        bookId,
        chapterUid: pick('chapterUid'),
        chapterIdx: pick('chapterIdx'),
        progress: pick('progress'),
        updateTime: pick('updateTime') ?? pick('readUpdateTime'),
      };
    } catch {
      return null;
    }
  }

  /**
   * 把"当前正在读的章节"上报到云端, 让微信读书 App / 其它设备同步看到。
   *
   * 接口 `/web/book/read` 的 payload 沿用与章节抓取相同的签名约定(calcHash + sign),
   * 字段含义参考社区逆向 (touchFish/wereader 等):
   *   - b/c   bookId / chapterUid 的 hash
   *   - ci    章节序号
   *   - co    章节内偏移(我们暂时上报 0, 章节级精度足够)
   *   - rt    本次阅读时长秒
   *   - ts    毫秒时间戳, ct 秒时间戳
   *   - pr    章节内进度 0-100
   *   - ps/pc 客户端"会话标识", 用与抓章节相同的常量
   *
   * 全程 best-effort, 任何异常都吞掉只返回 false, 不影响 UI。
   */
  public async reportReadProgress(
    bookId: string,
    chapterUid: number,
    chapterIdx?: number,
  ): Promise<boolean> {
    if (!this.auth.isLoggedIn()) return false;
    try {
      const payload: Record<string, string | number> = {
        appId: 'wereader.vscode',
        b: calcHash(bookId),
        c: calcHash(chapterUid),
        ci: chapterIdx ?? 0,
        co: 0,
        sm: '',
        pr: 0,
        rt: 5,
        ts: Date.now(),
        rn: Math.floor(Math.random() * 1000),
        ps: 'a2b325707a19e580g0186a2',
        pc: '430321207a19e581g013ab0',
        ct: currentTime(),
      };
      payload.s = sign(payload);
      const res = await this.http.post('/web/book/read', payload, {
        headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
      });
      const ok = res.status >= 200 && res.status < 300;
      console.log(`[weread-vscode] 上报阅读进度 ${ok ? 'OK' : 'FAIL'} status=${res.status} bookId=${bookId} chapterUid=${chapterUid}`);
      return ok;
    } catch (e) {
      console.warn('[weread-vscode] 上报阅读进度异常', e);
      return false;
    }
  }

  /** 获取章节目录 */
  public async getChapters(bookId: string): Promise<WereadChapter[]> {
    this.ensureLogin();
    try {
      const res = await this.http.post<ChapterInfosResponse>(
        '/web/book/chapterInfos',
        { bookIds: [bookId], synckeys: [0] },
        { headers: this.buildHeaders({ 'Content-Type': 'application/json' }) },
      );
      if (this.isUnauthorized(res.status, res.data)) {
        throw new Error('登录已失效，请重新导入 Cookie');
      }
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = res.data ?? {};
      const entry = (data.data ?? []).find((d) => d.bookId === bookId);
      return entry?.updated ?? [];
    } catch (e) {
      this.handleError('获取章节列表', e);
    }
  }

  /** 获取书籍详情 */
  public async getBookInfo(bookId: string): Promise<WereadBook | null> {
    this.ensureLogin();
    try {
      const res = await this.http.get('/web/book/info', {
        params: { bookId },
        headers: this.buildHeaders(),
      });
      if (this.isUnauthorized(res.status, res.data)) {
        throw new Error('登录已失效，请重新导入 Cookie');
      }
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }
      return res.data as WereadBook;
    } catch (e) {
      this.handleError('获取书籍详情', e);
    }
  }

  /**
   * 抓取章节内容 (带"失败自动续 wr_skey 重试一次"的外壳)。
   *
   * 背景: weread 的 /web/book/info 在 wr_skey 弱化但未完全过期时会先于其它接口
   * 返回 `status=200 + errCode=-2012 "登录超时"`, 同期 /web/book/read 和 /web/user
   * 仍然 OK — 表现就是 "看了一章下一章就报登录超时, 而体检又说没事"。
   *
   * 这种 "部分接口失活" 通过 /web/login/renewal 续 wr_skey 立即能恢复 (touchFish 同款做法),
   * 不需要让用户重新粘 cookie。
   *
   * 流程: 抓一次 → 失败 → renewal 续命 → 再抓一次 → 还失败才走兜底体检。
   * 用户视角: 翻章节最多多花一次 renewal 的时间 (~200ms), 而非要求重新登录。
   *
   * 真正的章节抓取逻辑在 fetchChapterContentOnce, 这里只编排。
   */
  public async fetchChapterContent(
    bookId: string,
    chapterUid: number | string,
  ): Promise<ChapterFetchResult> {
    const first = await this.fetchChapterContentOnce(bookId, chapterUid);
    if (this.chapterFetchSucceeded(first)) {
      return first;
    }

    // renewalDead 状态: server 已经废弃会话, 再续也是徒劳, 而且体检通过会让用户以为
    // "可能是付费/试读"——这是上一版本最坑的误导路径。直接打明确日志 + 触发重登通知。
    if (this.renewalDead) {
      console.warn(
        '[weread-vscode] 章节抓取失败且 renewalDead=true — server 已废弃会话, 跳过重试/体检, 通知用户重新登录浏览器',
      );
      void this.auth.notifyRenewalDead('auth_failed');
      first.diagnostics =
        (first.diagnostics ? first.diagnostics + '\n' : '') +
        '[登录已失效] server 端会话已被废弃, 必须在浏览器里重新登录 weread.qq.com 再导入新 Cookie。';
      return first;
    }

    console.log(
      '[weread-vscode] 章节抓取失败 → 主动续 wr_skey (/web/login/renewal) 后重试一次',
    );
    const refreshed = await this.refreshCookieByHomepage();
    if (!refreshed) {
      // 续命接口没拿到新 wr_skey 说明 wr_rt 也死了 (或服务器异常),
      // 重试基本拿不到不同结果, 没必要再叠一次接口压力 → 直接走体检, 让用户重登
      console.log('[weread-vscode] 续命未成功, 跳过重试, 启动体检');
      void this.healthCheckAfterChapterFailure();
      return first;
    }

    const second = await this.fetchChapterContentOnce(bookId, chapterUid);
    // 拼接两轮 diagnostics 方便排障 (用户点"诊断当前章节"能看到)
    const combinedDiag = (label: string) =>
      [first.diagnostics, `[第二轮: 续 wr_skey 后${label}]`, second.diagnostics]
        .filter(Boolean)
        .join('\n');
    if (this.chapterFetchSucceeded(second)) {
      console.log('[weread-vscode] 续命重试成功 ✓');
      second.diagnostics = combinedDiag('重试成功');
      return second;
    }
    console.log('[weread-vscode] 续命重试仍失败 → 启动体检');
    second.diagnostics = combinedDiag('重试仍失败');
    void this.healthCheckAfterChapterFailure();
    return second;
  }

  /** 章节抓取结果是否拿到了正文 (html 或 content 任一非空) */
  private chapterFetchSucceeded(r: ChapterFetchResult): boolean {
    return (
      (typeof r.html === 'string' && r.html.length > 0) ||
      (typeof r.content === 'string' && r.content.length > 0)
    );
  }

  /**
   * 抓取章节内容 — 单次实现, 不带重试。
   *
   * 真接口策略(参考 touchFish 项目):
   *   1. 先 GET /web/book/info?bookId=xxx 拿到 format(epub|pdf|txt)
   *   2. epub/pdf  → 并行 POST /web/book/chapter/e_0..e_3, e_2 是 style, e_0+e_1+e_3 拼接为正文
   *      txt       → 并行 POST /web/book/chapter/t_0..t_1, 拼接后解密为纯文本
   *   3. 每个分片响应都先 chk() 做 MD5 校验, 再 dH/dS/dT 解密
   *
   * 失败时返回详细 diagnostics, UI 仍可展示「在浏览器中打开」兜底。
   *
   * 注意: 这一层不做 healthCheckAfterChapterFailure 调用, 体检由外层 fetchChapterContent
   * 统一编排, 避免重试两次都体检导致节流命中却"假成功"的假象。
   */
  private async fetchChapterContentOnce(
    bookId: string,
    chapterUid: number | string,
  ): Promise<ChapterFetchResult> {
    this.ensureLogin();
    const diag: string[] = [];
    const log = (msg: string) => {
      diag.push(msg);
      console.log('[weread-vscode]', msg);
    };

    const fallbackUrl = getBookReaderUrl(bookId);
    const uidNum = Number(chapterUid);
    const result: ChapterFetchResult = {
      html: null,
      style: null,
      content: null,
      format: null,
      diagnostics: '',
      fallbackUrl,
    };

    // ---- 步骤 1: 拿图书格式 ----
    let format = '';
    try {
      const infoRes = await this.http.get('/web/book/info', {
        params: { bookId },
        headers: this.buildHeaders(),
      });
      if (this.isUnauthorized(infoRes.status, infoRes.data)) {
        log('登录失效, /web/book/info 返回 401/403');
        result.diagnostics = diag.join('\n');
        return result;
      }
      const info = (infoRes.data ?? {}) as { format?: string; errCode?: number; errcode?: number };
      // /web/book/info 在 wr_skey 弱化 / 会话被废弃时常见返回 status=200 + errCode=-2012 (登录超时),
      // 这条不会被 isUnauthorized 命中 (我们要求 status>=400), 必须显式识别 — 否则只看到
      // "未取到 format" 的兜底日志, 体检又通过, 用户会被引导到"可能是付费/试读"的死路。
      const bizCode = info?.errCode ?? info?.errcode;
      if (bizCode === -2012 || bizCode === -2010 || bizCode === -2013 || bizCode === -12013) {
        log(
          `/web/book/info status=${infoRes.status} errCode=${bizCode} — 业务层登录失效信号 (无 format)`,
        );
        // -2013/-12013 直接锁死并通知; -2012/-2010 交给外层续命重试链路
        if (bizCode === -2013 || bizCode === -12013) {
          this.renewalDead = true;
          void this.auth.notifyRenewalDead(
            bizCode === -12013 ? 'auth_expired' : 'auth_failed',
          );
        }
        result.diagnostics = diag.join('\n');
        return result;
      }
      format = info?.format ?? '';
      result.format = format;
      log(`图书格式: ${format || '(空)'}`);
      // 诊断日志: format 为空时把完整 body 打出来, 用来判断 server 到底返了什么
      // (可能是 errcode、可能是某种"限制"提示、可能是真无 format 字段)
      if (!format) {
        try {
          const bodyPreview = JSON.stringify(infoRes.data).slice(0, 800);
          log(`/web/book/info status=${infoRes.status} body=${bodyPreview}`);
        } catch {
          log(`/web/book/info status=${infoRes.status} body=(无法序列化)`);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`获取图书信息异常: ${msg}`);
      result.diagnostics = diag.join('\n');
      return result;
    }

    if (!format) {
      log('未取到 format, 无法决定走 e_* 还是 t_* 接口');
      // 体检 / 续命重试由外层 fetchChapterContent 编排, 这里只返回失败结果
      result.diagnostics = diag.join('\n');
      return result;
    }

    // ---- 步骤 2: 拉分片并解密 ----
    try {
      if (format === 'epub' || format === 'pdf') {
        log('调用 /web/book/chapter/e_0..e_3 (并行)');
        const [r0, r1, r2, r3] = await Promise.all([
          this.fetchChapterShard('e_0', bookId, uidNum, 0, log),
          this.fetchChapterShard('e_1', bookId, uidNum, 0, log),
          this.fetchChapterShard('e_2', bookId, uidNum, 1, log),
          this.fetchChapterShard('e_3', bookId, uidNum, 0, log),
        ]);
        if (r0 && r1 && r3) {
          result.html = dH(r0 + r1 + r3);
          result.style = r2 ? dS(r2) : '';
          log(`解密完成: html 长度 ${result.html.length}, style 长度 ${result.style?.length ?? 0}`);
        } else {
          log(`分片校验失败: r0=${!!r0} r1=${!!r1} r2=${!!r2} r3=${!!r3}`);
        }
      } else if (format === 'txt') {
        log('调用 /web/book/chapter/t_0..t_1 (并行)');
        const [t0, t1] = await Promise.all([
          this.fetchChapterShard('t_0', bookId, uidNum, 0, log),
          this.fetchChapterShard('t_1', bookId, uidNum, 1, log),
        ]);
        if (t0 && t1) {
          result.content = dT(t0 + t1);
          log(`解密完成: content 长度 ${result.content.length}`);
        } else {
          log(`分片校验失败: t0=${!!t0} t1=${!!t1}`);
        }
      } else {
        log(`暂不支持的格式: ${format}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`分片请求异常: ${msg}`);
    }

    // 体检 / 续命重试由外层 fetchChapterContent 统一编排
    result.diagnostics = diag.join('\n');
    return result;
  }

  /**
   * 章节抓取失败后的"登录态体检"。
   *
   * 节流 30s: 用户连续翻多个失败章节时不会一直戳 /web/user。
   *
   * 不抛错: 体检本身的失败只用来触发 interceptor 的 notifyExpired,
   * 不影响调用方的章节失败兜底逻辑。
   */
  private async healthCheckAfterChapterFailure(): Promise<void> {
    // renewalDead: server 已废弃会话, 体检纯属浪费请求 (而且 /web/user 校验最宽松,
    // 还可能"通过"给用户进一步制造"cookie 没事"的假象 → 必须跳过)
    if (this.renewalDead) {
      console.log(
        '[weread-vscode] 跳过体检 (renewalDead=true) — server 端会话已废弃, 重登提示已发送',
      );
      return;
    }
    const now = Date.now();
    if (now - this.lastHealthCheckAt < 30_000) {
      return;
    }
    this.lastHealthCheckAt = now;
    console.log('[weread-vscode] 章节抓取失败 → 启动登录态体检 /web/user');
    try {
      await this.getCurrentUser();
      // 严谨化文案: 之前"大概率是付费/试读"被用户报告"严重误导" (实测当 wr_rt 在 server
      // 端被废弃时, /web/user 校验最松, 即便会话已废仍可能通过, 用户依此判断会延误重登)。
      // 现在的兜底文案明确把"登录失效"列为同等可能性, 让用户自己看 /web/book/info 的报错码。
      console.log(
        '[weread-vscode] 登录态体检通过 — 但 /web/book/info 失败可能仍是登录问题 ' +
          '(server 校验 /web/user 最松), 若反复失败请执行 weread.diagnoseCookie 确认',
      );
    } catch (e) {
      // notifyExpired 已在 response interceptor 里触发, 这里只记日志便于排障
      console.log(
        '[weread-vscode] 登录态体检失败 — cookie 大概率已失效, 通知应已弹出:',
        (e as Error)?.message,
      );
    }
  }

  /**
   * 拉取并校验一个章节分片。
   *
   * 返回 chk() 通过后的 body 字符串(还未 base64 解密), 失败返回空串。
   *
   * @param shard  e_0 / e_1 / e_2 / e_3 / t_0 / t_1
   * @param st     接口的 st 字段。e_2 与 t_1 是 1, 其它是 0
   */
  private async fetchChapterShard(
    shard: 'e_0' | 'e_1' | 'e_2' | 'e_3' | 't_0' | 't_1',
    bookId: string,
    chapterUid: number,
    st: 0 | 1,
    log: (msg: string) => void,
  ): Promise<string> {
    const payload: Record<string, string | number> = {
      b: calcHash(bookId),
      c: calcHash(chapterUid),
      r: Math.pow(Math.floor(10_000 * Math.random()), 2),
      st,
      ct: currentTime(),
      ps: 'a2b325707a19e580g0186a2',
      pc: '430321207a19e581g013ab0',
    };
    payload.s = sign(payload);

    const path = `/web/book/chapter/${shard}`;
    try {
      const res = await this.http.post(path, payload, {
        headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
        responseType: 'text',
        transformResponse: [(d) => d],
      });
      const raw = typeof res.data === 'string' ? res.data : '';
      log(`  ${shard}: HTTP ${res.status}, body 长度 ${raw.length}`);
      if (res.status < 200 || res.status >= 400 || raw.length === 0) {
        return '';
      }
      const body = chk(raw);
      if (!body) {
        log(`  ${shard}: chk() MD5 校验未通过, 丢弃`);
      }
      return body;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ${shard}: 异常 ${msg}`);
      return '';
    }
  }

  // ============================================================
  // 社交内容(只读): 想法 / 划线 / 书评
  // ============================================================

  /**
   * 拉取某一章的"想法"列表。
   *
   * 接口: GET /web/review/list?bookId=&chapterUid=&listType=11&count=20&maxIdx=0&synckey=0
   * - listType=11 是社区逆向出来的"章节维度的想法/评论"
   * - 返回结构里 reviews 是数组, 每项形如 { review: { ... }, ... }
   * - 失败/未登录都返回空数组, 不抛错(社交内容属于增强体验, 不应阻断正文)
   */
  public async getChapterReviews(bookId: string, chapterUid: number | string): Promise<Review[]> {
    if (!this.auth.isLoggedIn()) return [];
    try {
      const res = await this.http.get('/web/review/list', {
        params: {
          bookId,
          chapterUid,
          listType: 11,
          maxIdx: 0,
          count: 20,
          synckey: 0,
        },
        headers: this.buildHeaders(),
      });
      if (res.status < 200 || res.status >= 300) return [];
      return this.normalizeReviewList(res.data);
    } catch (e) {
      console.warn('[weread-vscode] getChapterReviews 失败', e);
      return [];
    }
  }

  /**
   * 拉取一本书的"书评"列表(全书维度, 非章节维度)。
   *
   * 接口: GET /web/review/list?bookId=&listType=4&maxIdx=0&count=20
   * - listType=4 是社区习惯的"全书书评"
   */
  public async getBookReviews(bookId: string, count = 20): Promise<Review[]> {
    if (!this.auth.isLoggedIn()) return [];
    try {
      const res = await this.http.get('/web/review/list', {
        params: {
          bookId,
          listType: 4,
          maxIdx: 0,
          count,
          synckey: 0,
        },
        headers: this.buildHeaders(),
      });
      if (res.status < 200 || res.status >= 300) return [];
      return this.normalizeReviewList(res.data);
    } catch (e) {
      console.warn('[weread-vscode] getBookReviews 失败', e);
      return [];
    }
  }

  /**
   * 拉取一本书的"热门划线"。
   *
   * 接口: GET /web/book/bestbookmarks?bookId=  (可选 chapterUid 限定到某章)
   * - 返回结构: { updated: [ { bookmarkId, markText, chapterUid, totalCount, ... } ] }
   */
  public async getBestBookmarks(
    bookId: string,
    chapterUid?: number | string,
  ): Promise<BestBookmark[]> {
    if (!this.auth.isLoggedIn()) return [];
    try {
      const params: Record<string, string | number> = { bookId };
      if (chapterUid !== undefined && chapterUid !== '') {
        params.chapterUid = chapterUid;
      }
      const res = await this.http.get('/web/book/bestbookmarks', {
        params,
        headers: this.buildHeaders(),
      });
      if (res.status < 200 || res.status >= 300) return [];
      const data = (res.data ?? {}) as Record<string, unknown>;
      const arr = Array.isArray(data.updated)
        ? (data.updated as Array<Record<string, unknown>>)
        : Array.isArray(data.items)
        ? (data.items as Array<Record<string, unknown>>)
        : [];
      const out: BestBookmark[] = [];
      for (const it of arr) {
        if (!it) continue;
        const markText = typeof it.markText === 'string' ? it.markText : '';
        const bookmarkId =
          typeof it.bookmarkId === 'string'
            ? it.bookmarkId
            : typeof it.bookMarkId === 'string'
            ? (it.bookMarkId as string)
            : '';
        if (!markText) continue;
        out.push({
          bookmarkId: bookmarkId || `bm-${out.length}`,
          markText,
          chapterUid: typeof it.chapterUid === 'number' ? (it.chapterUid as number) : undefined,
          totalCount: typeof it.totalCount === 'number' ? (it.totalCount as number) : undefined,
          // range 是 EPUB 原始 HTML 中的字符偏移 "start-end",
          // 给 MainViewProvider.injectHotUnderlinesIntoHtml 用来在正文 inline 渲染时
          // 把热门划线包成 <span class="hot-underline">, 模仿 touchFish 体验。
          range: typeof it.range === 'string' ? (it.range as string) : undefined,
        });
      }
      return out;
    } catch (e) {
      console.warn('[weread-vscode] getBestBookmarks 失败', e);
      return [];
    }
  }

  /**
   * 拉取章节级"热门划线"(touchFish 实测在用的接口)。
   *
   * 接口: GET /web/book/underlines?bookId=&chapterUid=
   * - 返回结构: { underlines: [ { range, count, type, ... } ] }
   * - 相比 bestbookmarks, 这里 range 字段是稳定返回的, 直接用来在章节 HTML 上
   *   inline 渲染热门划线最稳。markText 这个接口不给, 因此 popover 里要展示
   *   "划过的原文片段" 时, 由前端用 range 反 slice 出来即可。
   */
  public async getChapterUnderlines(
    bookId: string,
    chapterUid: number | string,
  ): Promise<ChapterUnderline[]> {
    if (!this.auth.isLoggedIn()) return [];
    try {
      const res = await this.http.get('/web/book/underlines', {
        params: { bookId, chapterUid },
        headers: this.buildHeaders(),
      });
      if (res.status < 200 || res.status >= 300) return [];
      const data = (res.data ?? {}) as Record<string, unknown>;
      const arr = Array.isArray(data.underlines)
        ? (data.underlines as Array<Record<string, unknown>>)
        : Array.isArray(data.updated)
        ? (data.updated as Array<Record<string, unknown>>)
        : [];
      const out: ChapterUnderline[] = [];
      for (const it of arr) {
        if (!it) continue;
        const range = typeof it.range === 'string' ? (it.range as string) : '';
        if (!range || !/^\d+-\d+$/.test(range)) continue;
        out.push({
          range,
          count: typeof it.count === 'number' ? (it.count as number) : undefined,
          type: typeof it.type === 'number' ? (it.type as number) : undefined,
        });
      }
      return out;
    } catch (e) {
      console.warn('[weread-vscode] getChapterUnderlines 失败', e);
      return [];
    }
  }

  /**
   * 拉取章节内某 range 的"热门想法"(点击章节内划线时弹出 popover 用)。
   *
   * 接口: POST https://weread.qq.com/web/book/readReviews
   * body:
   *   {
   *     bookId,
   *     chapterUid,
   *     reviews: [{ range, maxIdx: 0, count: 30, synckey: 0 }]
   *   }
   * 响应:
   *   {
   *     reviews: [
   *       {
   *         range: "457-485",
   *         pageReviews: [ { review: {...}, likesCount?: number, ... }, ... ]
   *       },
   *       ...
   *     ]
   *   }
   *
   * 说明: 这个接口是**书内章节 + range 维度的热门评论**, 跟 `/web/review/list?listType=11`
   * (全书 / 全平台维度) 不是一个东西。touchFish 同款做法 — 之前误用 listType=11 拉的多是
   * 整书想法, 用 range 兜底常常 0 命中, 所以划线 popover 始终为空。
   */
  public async getReadReviewsByRange(
    bookId: string,
    chapterUid: number | string,
    range: string,
    count = 30,
  ): Promise<Review[]> {
    if (!this.auth.isLoggedIn()) return [];
    try {
      const res = await this.http.post(
        '/web/book/readReviews',
        {
          bookId,
          chapterUid: typeof chapterUid === 'string' ? Number(chapterUid) : chapterUid,
          reviews: [{ range, maxIdx: 0, count, synckey: 0 }],
        },
        {
          headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
        },
      );
      if (res.status < 200 || res.status >= 300) return [];
      return this.normalizeReadReviewsResponse(res.data);
    } catch (e) {
      console.warn('[weread-vscode] getReadReviewsByRange 失败', e);
      return [];
    }
  }

  /**
   * /web/book/readReviews 返回结构特殊: `reviews[].pageReviews[].review`,
   * 跟 /web/review/list 的 `reviews[].review` 多套了一层 pageReviews。
   * 这里把 pageReviews 展平回 normalizeReviewList 期望的形态再复用归一化逻辑。
   *
   * 同时 pageReviews 把 `likesCount` 提到了外层(原始 review 里没有), 这里回填,
   * 以保证 popover 显示点赞数。
   */
  private normalizeReadReviewsResponse(raw: unknown): Review[] {
    if (!raw || typeof raw !== 'object') return [];
    const data = raw as Record<string, unknown>;
    const groups = Array.isArray(data.reviews)
      ? (data.reviews as Array<Record<string, unknown>>)
      : [];
    const flat: Array<Record<string, unknown>> = [];
    for (const group of groups) {
      if (!group) continue;
      const pageReviews = Array.isArray(group.pageReviews)
        ? (group.pageReviews as Array<Record<string, unknown>>)
        : [];
      const groupRange =
        typeof group.range === 'string' ? (group.range as string) : undefined;
      for (const pr of pageReviews) {
        if (!pr) continue;
        const r = (pr.review ?? pr) as Record<string, unknown>;
        if (!r || typeof r !== 'object') continue;
        // pageReviews 把 likesCount 抽到了外层, 给原始 review 补上, normalizeReviewList 才能拿到
        if (typeof pr.likesCount === 'number' && typeof r.likesCount !== 'number') {
          (r as Record<string, unknown>).likesCount = pr.likesCount;
        }
        // 若原始 review 没 range, 用 group 上的 range 兜底, 方便前端调试
        if (groupRange && typeof r.range !== 'string') {
          (r as Record<string, unknown>).range = groupRange;
        }
        flat.push(pr);
      }
    }
    return this.normalizeReviewList({ reviews: flat });
  }

  /**
   * 拉取一张图片并转成 data URL(给 webview 用)。
   *
   * 为什么需要这个? 微信读书章节 HTML 里很多 `<img src>` 是相对路径
   * (EPUB 内部资源, 比如 `../Images/cover.jpg`) 或者带防盗链 referer 校验,
   * webview 直接渲染会 404 / 黑白空白。这里走 axios(带 cookie+referer)
   * 把图二进制拿回来, 再 base64 内嵌到 src。
   *
   * 失败返回 null, 调用方负责保留原 src(至少不破图)。
   */
  public async fetchImageAsDataUrl(imgUrl: string): Promise<string | null> {
    if (!imgUrl) return null;
    // 缓存命中: 直接复用上次的 Promise (无论成功/失败都不重试, 失败 retry 留给手动 reload)
    const cached = this.imageDataUrlCache.get(imgUrl);
    if (cached) return cached;
    const task = (async (): Promise<string | null> => {
      try {
        const res = await this.http.get(imgUrl, {
          responseType: 'arraybuffer',
          headers: {
            ...this.buildHeaders(),
            // 防盗链: 必须带 weread referer, 否则 res.weread.qq.com 等 CDN 会 403
            Referer: 'https://weread.qq.com/',
          },
          // 给图片单独放宽超时, 避免章节有大图时整页卡死
          timeout: 8000,
        });
        if (res.status < 200 || res.status >= 300) return null;
        const buf = Buffer.from(res.data as ArrayBuffer);
        // 尝试从响应头读 mime, 兜底用 image/jpeg
        const ct = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) as
          | string
          | undefined;
        const mime = (ct && ct.split(';')[0].trim()) || 'image/jpeg';
        return `data:${mime};base64,${buf.toString('base64')}`;
      } catch (e) {
        // 仅 warn, 不抛: 单张图失败不应阻塞整章渲染
        console.warn('[weread-vscode] fetchImageAsDataUrl 失败', imgUrl, (e as Error)?.message);
        return null;
      }
    })();
    this.imageDataUrlCache.set(imgUrl, task);
    return task;
  }

  /**
   * 把 `/web/review/list` 返回的杂乱结构, 归一化成统一的 `Review[]`。
   *
   * 接口实际形态: { reviews: [ { review: {...}, ... }, ... ] }
   * - review 字段是真正的数据载荷
   * - user 通常在 review.user 下, 偶尔出现在外层, 这里统一兜底
   */
  private normalizeReviewList(raw: unknown): Review[] {
    if (!raw || typeof raw !== 'object') return [];
    const data = raw as Record<string, unknown>;
    const list = Array.isArray(data.reviews) ? (data.reviews as Array<Record<string, unknown>>) : [];
    const out: Review[] = [];
    for (const item of list) {
      if (!item) continue;
      const r = (item.review ?? item) as Record<string, unknown>;
      if (!r || typeof r !== 'object') continue;
      const reviewId =
        typeof r.reviewId === 'string'
          ? r.reviewId
          : typeof r.reviewId === 'number'
          ? String(r.reviewId)
          : '';
      if (!reviewId) continue;

      const userRaw =
        (r.user as Record<string, unknown> | undefined) ??
        (item.user as Record<string, unknown> | undefined);
      const author: ReviewAuthor = {
        vid:
          typeof userRaw?.vid === 'number' || typeof userRaw?.vid === 'string'
            ? (userRaw?.vid as number | string)
            : typeof userRaw?.userVid === 'number'
            ? (userRaw?.userVid as number)
            : undefined,
        name: typeof userRaw?.name === 'string' ? (userRaw?.name as string) : undefined,
        avatar: typeof userRaw?.avatar === 'string' ? (userRaw?.avatar as string) : undefined,
      };

      out.push({
        reviewId,
        author,
        content: typeof r.content === 'string' ? (r.content as string) : undefined,
        markText: typeof r.abstract === 'string'
          ? (r.abstract as string)
          : typeof r.markText === 'string'
          ? (r.markText as string)
          : undefined,
        chapterUid: typeof r.chapterUid === 'number' ? (r.chapterUid as number) : undefined,
        chapterIdx: typeof r.chapterIdx === 'number' ? (r.chapterIdx as number) : undefined,
        createTime: typeof r.createTime === 'number' ? (r.createTime as number) : undefined,
        likesCount: typeof r.likesCount === 'number' ? (r.likesCount as number) : undefined,
        commentsCount: typeof r.commentsCount === 'number' ? (r.commentsCount as number) : undefined,
        type: typeof r.type === 'number' ? (r.type as number) : undefined,
        range: typeof r.range === 'string' ? (r.range as string) : undefined,
      });
    }
    return out;
  }

  // ============================================================
  // 书城(发现): 搜索 / 榜单分类 / 加入书架
  // ============================================================

  /**
   * 全局搜索图书。
   *
   * 接口: GET /web/search/global?keyword=&maxIdx=&fragmentSize=&count=
   * 返回: { books: [{ bookInfo, searchIdx, readingCount, ... }], totalCount, hasMore }
   *
   * 特点(实测):
   *   - **不需要登录** 也能搜 — 未导入 cookie 时同样返回完整结果, 因此这里不 ensureLogin,
   *     用户可以先逛后登录 (真正要"读"时才需要 cookie)。
   *   - maxIdx 就是"已拿到的条数", 传 20 拿第 21 条起, 配合 hasMore 做无限加载。
   *   - fragmentSize 只影响服务端返回的高亮片段长度, 我们不用高亮, 给个常规值即可。
   */
  public async searchBooks(
    keyword: string,
    maxIdx = 0,
    count = 20,
  ): Promise<StoreSearchResult> {
    const kw = (keyword ?? '').trim();
    if (!kw) {
      return { books: [], totalCount: 0, hasMore: false, nextMaxIdx: 0 };
    }
    try {
      const res = await this.http.get('/web/search/global', {
        params: { keyword: kw, maxIdx, fragmentSize: 120, count },
        headers: this.buildHeaders(),
      });
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (res.data ?? {}) as Record<string, unknown>;
      const rawList = Array.isArray(data.books) ? (data.books as Array<Record<string, unknown>>) : [];
      const books: StoreBook[] = [];
      for (const item of rawList) {
        const book = normalizeStoreBook(item?.bookInfo, {
          rank: typeof item?.searchIdx === 'number' ? (item.searchIdx as number) : undefined,
          readingCount:
            typeof item?.readingCount === 'number' ? (item.readingCount as number) : undefined,
        });
        if (book) books.push(book);
      }
      const totalCount = typeof data.totalCount === 'number' ? data.totalCount : books.length;
      // hasMore 服务端给的是 0/1; 再叠一层"这一页真的拿到东西了"的保护, 防止 hasMore 恒 1 导致死循环
      const hasMore = (data.hasMore === 1 || data.hasMore === true) && books.length > 0;
      console.log(
        `[weread-vscode] 书城搜索 "${kw}" maxIdx=${maxIdx} → ${books.length} 条 (total=${totalCount}, hasMore=${hasMore})`,
      );
      return { books, totalCount, hasMore, nextMaxIdx: maxIdx + books.length };
    } catch (e) {
      this.handleError('搜索图书', e);
    }
  }

  /**
   * 拉完整的书城分类树: 7 个榜单 + 22 个一级分类(每个带 2~21 个二级分类)。
   *
   * 接口: GET /web/categories → { synckey, data: [ { categories: [...] }, ... ] }
   * 无需登录。响应 430KB 但属于元数据, 缓存 6 小时 (见 categoryTreeCache)。
   *
   * 失败不抛错而是返回 null —— 分类树只是"导航增强", 拿不到时 UI 会退回内置常量清单,
   * 用户照样能点飙升榜/精品小说, 不该因为导航拉不到就把整个书城判死。
   */
  public async getCategoryTree(force = false): Promise<StoreCategoryTree | null> {
    const cached = this.categoryTreeCache;
    if (!force && cached && Date.now() - cached.at < WereadClient.CATEGORY_TREE_TTL_MS) {
      return cached.tree;
    }
    try {
      const res = await this.http.get('/web/categories', { headers: this.buildHeaders() });
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }
      const tree = parseCategoryTree(res.data);
      const subTotal = tree.categories.reduce((a, c) => a + (c.children?.length ?? 0), 0);
      console.log(
        `[weread-vscode] 书城分类树: ${tree.ranks.length} 个榜单 / ${tree.categories.length} 个一级分类 / ${subTotal} 个二级分类`,
      );
      if (tree.ranks.length === 0 && tree.categories.length === 0) {
        return null;
      }
      this.categoryTreeCache = { at: Date.now(), tree };
      return tree;
    } catch (e) {
      console.warn('[weread-vscode] 获取书城分类树失败, 将回落到内置清单:', (e as Error)?.message);
      return null;
    }
  }

  /**
   * 拉某个榜单 / 分类下的书 (固定 20 条, 服务端直出的首屏量)。
   *
   * 微信读书 web 端没有给榜单开 JSON 接口 (社区流传的 /web/bookListInCategory 等全 404),
   * 列表数据塞在页面 https://weread.qq.com/web/category/{id} 的 `window.__INITIAL_STATE__` 里。
   * 所以这里按 text 拉 HTML, 再交给 parseCategoryBooks 抠数据。
   *
   * 因为一次响应 600KB+ 且榜单变化很慢, 内存里按 categoryId 缓存 10 分钟,
   * 用户来回切 chip 不会反复打网络; 顶部"刷新"按钮走 force=true 绕过缓存。
   */
  public async getCategoryBooks(categoryId: string, force = false): Promise<StoreBook[]> {
    const id = (categoryId ?? '').trim();
    if (!id) return [];

    const cached = this.categoryCache.get(id);
    if (!force && cached && Date.now() - cached.at < WereadClient.CATEGORY_TTL_MS) {
      console.log(`[weread-vscode] 书城榜单 ${id} 命中内存缓存 (${cached.books.length} 本)`);
      return cached.books;
    }

    try {
      const res = await this.http.get(`/web/category/${encodeURIComponent(id)}`, {
        headers: this.buildHeaders({ Accept: 'text/html,application/xhtml+xml' }),
        responseType: 'text',
        transformResponse: [(d) => d],
      });
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }
      const html = typeof res.data === 'string' ? res.data : '';
      const books = parseCategoryBooks(html);
      console.log(
        `[weread-vscode] 书城榜单 ${id} 拉取完成: HTML ${html.length} 字符 → ${books.length} 本`,
      );
      if (books.length === 0) {
        // 页面结构变了 / 被风控挡了 — 明确抛错, 让 UI 展示"重试"而不是一个空白列表
        throw new Error('未能从页面解析出书单 (接口结构可能已变更)');
      }
      this.categoryCache.set(id, { at: Date.now(), books });
      return books;
    } catch (e) {
      this.handleError('获取书城榜单', e);
    }
  }

  /**
   * 把书加入我的书架。
   *
   * 接口: POST /web/shelf/add  body: { bookIds: [...] } → { succ: 1 }
   * (路径与 payload 取自 weread web 端 app.js 里的 FETCH_ADD_SHELF_FORCE 分支)
   *
   * 必须登录; 失败时抛错让 UI 提示, 因为这是用户主动触发的写操作, 静默失败最糟。
   */
  public async addBooksToShelf(bookIds: string[]): Promise<boolean> {
    this.ensureLogin();
    const ids = (bookIds ?? []).filter((x) => !!x);
    if (ids.length === 0) return false;
    try {
      const res = await this.http.post(
        '/web/shelf/add',
        { bookIds: ids },
        {
          headers: this.buildHeaders({
            'Content-Type': 'application/json',
            Origin: 'https://weread.qq.com',
            Referer: 'https://weread.qq.com/',
          }),
        },
      );
      const data = (res.data ?? {}) as Record<string, unknown>;
      const errCode = data.errCode ?? data.errcode;
      const ok = res.status >= 200 && res.status < 300 && errCode === undefined;
      console.log(
        `[weread-vscode] 加入书架 ${ok ? 'OK' : 'FAIL'} status=${res.status} ids=${ids.join(',')}` +
          (errCode !== undefined ? ` errCode=${errCode} errMsg=${data.errMsg ?? ''}` : ''),
      );
      if (!ok) {
        throw new Error(
          typeof data.errMsg === 'string' && data.errMsg
            ? String(data.errMsg)
            : `服务端拒绝 (status=${res.status}${errCode !== undefined ? `, errCode=${errCode}` : ''})`,
        );
      }
      // 加入书架会改变榜单里的 isBookInMyShelf, 缓存里的旧值就地更新一下,
      // 免得切回榜单还显示"加入书架"按钮。
      for (const entry of this.categoryCache.values()) {
        for (const b of entry.books) {
          if (ids.includes(b.bookId)) b.inShelf = true;
        }
      }
      return true;
    } catch (e) {
      this.handleError('加入书架', e);
    }
  }
}
