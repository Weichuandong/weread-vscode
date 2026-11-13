import * as vscode from 'vscode';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import { QidianAuthService } from '../auth/AuthService';
import {
  QidianBook,
  QidianCatalog,
  QidianChapter,
  QidianChapterContent,
  QidianReadStatus,
  QidianSearchResult,
  QidianShelfData,
  QidianShelfGroup,
  QidianUser,
} from '../types';
import {
  chapterContentToHtml,
  getChapterUrl,
  getRankDef,
  normalizeBooks,
  normalizeGroups,
  parseCatalog,
  plainText,
} from './qidianParse';

/** 起点接口业务错误 (code ≠ 0) */
export class QidianApiError extends Error {
  constructor(
    message: string,
    public readonly code: number | string | undefined,
    /** 是否为"未登录 / 登录失效" */
    public readonly needLogin = false,
  ) {
    super(message);
    this.name = 'QidianApiError';
  }
}

interface ApiEnvelope {
  code?: number | string;
  msg?: string;
  message?: string;
  data?: unknown;
}

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

/** 书架单次最多翻多少页 (每页 20 本), 防止接口异常时死循环 */
const SHELF_MAX_PAGES = 50;
/** 拉"每个分组里有哪些书"时最多处理多少个分组 */
const SHELF_MAX_GROUPS = 20;

/**
 * 起点 HTTP 客户端 (m.qidian.com `/webcommon/*` 接口)。
 *
 * 关键约定:
 *   - CSRF 双提交: 每个请求都在 Cookie 与查询参数里带同一个 `_csrfToken`。
 *     用户 Cookie 里有就用用户的, 没有 (未登录) 就本地生成一个 40 位随机串 —
 *     起点只校验两者一致, 不校验来源。
 *   - 未登录 / 失效: code 1000 ("未登录") 或 401 → 通知 AuthService 挂横幅, 抛 needLogin 错误。
 *   - WAF: 起点主站接了腾讯云 WAF, 被拦时返回 HTTP 202 + probe.js 挑战页。
 *     这里只识别并给出明确提示, 不尝试绕过。
 *
 * 风险声明: 起点没有开放 API, 这些是 m 站前端自己在用的接口, 可能随时变化。
 */
export class QidianClient {
  private static readonly BASE_URL = 'https://m.qidian.com';

  private http: AxiosInstance;
  /** 未登录时使用的本地 CSRF token (进程内固定) */
  private readonly anonCsrf = randomToken(40);

  constructor(private readonly auth: QidianAuthService) {
    this.http = this.buildHttpClient();
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('qidian')) this.http = this.buildHttpClient();
    });
  }

  private buildHttpClient(): AxiosInstance {
    const config = vscode.workspace.getConfiguration('qidian');
    const timeout = config.get<number>('requestTimeout', 15000);
    const userAgent = config.get<string>('userAgent', DEFAULT_UA) || DEFAULT_UA;
    const instance = axios.create({
      baseURL: QidianClient.BASE_URL,
      timeout,
      headers: {
        'User-Agent': userAgent,
        Referer: 'https://m.qidian.com/',
        Accept: 'application/json, text/plain, */*',
      },
      // 4xx 也交给业务层看 body (起点 401 也带 JSON)
      validateStatus: (status) => status >= 200 && status < 500,
      // 登录失效时起点回 302 → passport 登录页 (body 仍是 {"code":1000}); 不跟随跳转,
      // 否则拿到的是一整页登录 HTML, 识别不出"登录失效"
      maxRedirects: 0,
    });
    instance.interceptors.response.use((response) => {
      const setCookie = response.headers?.['set-cookie'];
      if (Array.isArray(setCookie) && setCookie.length > 0) {
        void this.auth.mergeAndPersistCookies(setCookie);
      }
      return response;
    });
    return instance;
  }

  // ---------------- 基础请求 ----------------

  /** 当前请求使用的 CSRF token: 优先用户 cookie 里的, 否则本地生成的 */
  private csrfToken(): string {
    const jar = this.auth.getCookieJar();
    return jar['_csrfToken'] || this.anonCsrf;
  }

  /** 拼 Cookie 头: 用户 cookie + 确保带上 _csrfToken */
  private cookieHeader(token: string): string {
    const raw = this.auth.getCookieHeader().trim();
    const jar = this.auth.getCookieJar();
    if (jar['_csrfToken']) return raw;
    return raw ? `${raw.replace(/;\s*$/, '')}; _csrfToken=${token}` : `_csrfToken=${token}`;
  }

  private async request(
    method: 'GET' | 'POST',
    url: string,
    params: Record<string, string | number | undefined>,
    opts: { requireLogin?: boolean; form?: Record<string, string | number | undefined> } = {},
  ): Promise<unknown> {
    if (opts.requireLogin && !this.auth.isLoggedIn()) {
      throw new QidianApiError('需要先登录起点（导入 Cookie）', 1000, true);
    }
    const token = this.csrfToken();
    const query: Record<string, string | number> = { _csrfToken: token };
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') query[k] = v;
    }
    let res: AxiosResponse;
    try {
      if (method === 'GET') {
        res = await this.http.get(url, { params: query, headers: { Cookie: this.cookieHeader(token) } });
      } else {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries({ ...(opts.form ?? {}), _csrfToken: token })) {
          if (v !== undefined) body.append(k, String(v));
        }
        res = await this.http.post(url, body.toString(), {
          params: query,
          headers: {
            Cookie: this.cookieHeader(token),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new QidianApiError(`网络请求失败: ${msg}`, undefined);
    }
    return this.unwrap(res, url);
  }

  /** 统一解包 {code, msg, data}, 识别登录失效 / WAF / CSRF */
  private unwrap(res: AxiosResponse, url: string): unknown {
    let body = res.data as unknown;
    if (typeof body === 'string' && /^\s*\{/.test(body)) {
      try {
        body = JSON.parse(body);
      } catch {
        /* 保持字符串, 走下面的非 JSON 分支 */
      }
    }
    const location = String(res.headers?.['location'] ?? '');
    if (res.status >= 300 && res.status < 400 && (typeof body !== 'object' || body === null)) {
      if (/passport|login/i.test(location)) {
        this.auth.notifyExpired();
        throw new QidianApiError(
          this.auth.isLoggedIn() ? '起点登录已失效，请重新导入 Cookie' : '需要先登录起点（导入 Cookie）',
          1000,
          true,
        );
      }
      throw new QidianApiError(`接口被重定向 (HTTP ${res.status} → ${location || '未知'})`, res.status);
    }
    if (typeof body === 'string') {
      if (res.status === 202 || /probe\.js|x-waf|TencentCaptcha/i.test(body)) {
        throw new QidianApiError(
          '被起点风控 (WAF) 拦截了请求。请在浏览器打开 m.qidian.com 完成验证后, 重新复制 Cookie 导入; 或稍后再试。',
          res.status,
        );
      }
      throw new QidianApiError(`接口返回了非 JSON 内容 (HTTP ${res.status}, ${url})`, res.status);
    }
    const env = (body ?? {}) as ApiEnvelope;
    const code = env.code;
    const msg = env.msg || env.message || '';
    if (code === 0 || code === '0') {
      if (this.auth.isLoggedIn() && url.includes('bookshelf')) this.auth.notifyValid();
      return env.data;
    }
    if (code === 1000 || code === 401 || code === '1000' || code === '401' || res.status === 401) {
      this.auth.notifyExpired();
      throw new QidianApiError(
        this.auth.isLoggedIn() ? '起点登录已失效，请重新导入 Cookie' : '需要先登录起点（导入 Cookie）',
        code,
        true,
      );
    }
    if (code === 1403 || code === '1403') {
      throw new QidianApiError('CSRF 校验失败 (code 1403)，请尝试重新导入 Cookie', code);
    }
    throw new QidianApiError(msg ? `${msg} (code ${code})` : `接口错误 code=${String(code)} HTTP ${res.status}`, code);
  }

  // ---------------- 账号 ----------------

  public async getCurrentUser(): Promise<QidianUser> {
    const data = (await this.request('GET', '/webcommon/user/getUserInfo', {}, { requireLogin: true })) as
      | Record<string, unknown>
      | null;
    const o = data ?? {};
    const isLogin = o.isLogin === true || Number(o.isLogin) === 1;
    if (!isLogin) {
      this.auth.notifyExpired();
      throw new QidianApiError('Cookie 未处于登录状态 (isLogin=false)', 1000, true);
    }
    this.auth.notifyValid();
    return {
      isLogin,
      nickName: plainText(o.nickName),
      guid: o.guid !== undefined ? String(o.guid) : undefined,
    };
  }

  // ---------------- 书架 ----------------

  /**
   * 拉某个分组的全部书 (自动翻页)。
   * @param sort 2 = 按阅读时间 (默认), 0 = 按更新时间 — 与 m 站书架页的两个选项一致
   */
  private async getShelfList(gid: string, sort: number): Promise<QidianBook[]> {
    const all: QidianBook[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= SHELF_MAX_PAGES; page++) {
      const data = (await this.request(
        'GET',
        '/webcommon/bookshelf/mlist',
        { gid, sort, pageNum: page, pageSize: 20, sortChange: 0 },
        { requireLogin: true },
      )) as { list?: unknown; page?: { isLast?: number | boolean } } | null;
      const books = normalizeBooks(data?.list);
      for (const b of books) {
        if (!seen.has(b.bookId)) {
          seen.add(b.bookId);
          all.push(b);
        }
      }
      const isLast = data?.page?.isLast;
      if (books.length === 0 || isLast === 1 || isLast === true || data?.page === undefined) break;
    }
    return all;
  }

  public async getShelfGroups(): Promise<QidianShelfGroup[]> {
    const data = await this.request('GET', '/webcommon/bookshelf/mgroups', {}, { requireLogin: true });
    return normalizeGroups(data);
  }

  /**
   * 拉完整书架: 默认书架 (gid=-100) + 每个自建分组。
   *
   * 起点书架接口是"按分组分页"的, 没有"一次给全部书 + 每本书属于哪个分组"的接口,
   * 所以这里: 先拉分组列表 → 并行拉每个分组的书 → 按 bookId 合并, 回填 groupIds。
   * 分组列表拉失败时退化为只拉默认书架, 不影响主流程。
   */
  public async getBookshelf(sort = 2): Promise<QidianShelfData> {
    let groups: QidianShelfGroup[] = [];
    try {
      groups = await this.getShelfGroups();
    } catch (e) {
      if (e instanceof QidianApiError && e.needLogin) throw e;
      console.warn('[qidian] 拉书架分组失败, 只加载默认书架', e);
    }
    if (!groups.some((g) => g.groupId === '-100')) {
      groups.unshift({ groupId: '-100', name: '默认书架', bookCount: 0 });
    }
    const targets = groups
      .filter((g) => g.groupId === '-100' || g.bookCount !== 0)
      .slice(0, SHELF_MAX_GROUPS);

    const results = await Promise.allSettled(targets.map((g) => this.getShelfList(g.groupId, sort)));

    const byId = new Map<string, QidianBook>();
    const order: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const g = targets[i];
      if (r.status !== 'fulfilled') {
        // 默认书架都拉不下来 → 把错误抛出去 (多半是登录失效)
        if (g.groupId === '-100') throw r.reason;
        console.warn(`[qidian] 分组 ${g.name} 拉取失败, 跳过`, r.reason);
        continue;
      }
      for (const b of r.value) {
        const existing = byId.get(b.bookId);
        if (existing) {
          existing.groupIds = Array.from(new Set([...(existing.groupIds ?? []), g.groupId]));
        } else {
          byId.set(b.bookId, { ...b, groupIds: [g.groupId] });
          order.push(b.bookId);
        }
      }
    }
    return {
      books: order.map((id) => byId.get(id)!),
      groups,
    };
  }

  /** 加入书架 (默认分组) */
  public async addToShelf(bookId: string): Promise<'added' | 'exists'> {
    try {
      await this.request(
        'POST',
        '/webcommon/bookshelf/addbooks',
        {},
        { requireLogin: true, form: { bookId } },
      );
      return 'added';
    } catch (e) {
      if (e instanceof QidianApiError) {
        // 错误码取自 m 站前端: 1002 已在书架 / 1003 书架已满 / 1004 加入失败
        if (String(e.code) === '1002') return 'exists';
        if (String(e.code) === '1003') throw new QidianApiError('书架已满，请先在起点里清理书架', e.code);
      }
      throw e;
    }
  }

  // ---------------- 书城 ----------------

  public async searchBooks(keyword: string, pageNum = 1, orderBy = ''): Promise<QidianSearchResult> {
    const data = (await this.request('GET', '/webcommon/search/list', {
      kw: keyword,
      pageNum,
      orderBy: orderBy || undefined,
    })) as { bookInfo?: { records?: unknown; total?: number; isLast?: number | boolean } } | null;
    const info = data?.bookInfo ?? {};
    const books = normalizeBooks(info.records);
    const isLast = info.isLast === 1 || info.isLast === true;
    return {
      books,
      total: typeof info.total === 'number' ? info.total : books.length,
      hasMore: !isLast && books.length > 0,
    };
  }

  /** 榜单 (男频), catId=-1 为全站 */
  public async getRankBooks(rankKey: string, catId = -1, pageNum = 1): Promise<QidianSearchResult> {
    const def = getRankDef(rankKey);
    const data = (await this.request('GET', `/webcommon/rank/${def.api}list`, {
      gender: 'male',
      pageNum,
      catId,
    })) as { records?: unknown; total?: number; isLast?: number | boolean } | null;
    const books = normalizeBooks(data?.records);
    const isLast = data?.isLast === 1 || data?.isLast === true;
    return {
      books,
      total: typeof data?.total === 'number' ? data.total : books.length,
      hasMore: !isLast && books.length > 0,
    };
  }

  // ---------------- 阅读 ----------------

  public async getCatalog(bookId: string): Promise<QidianCatalog> {
    const data = await this.request('GET', '/webcommon/book/mCategory', { bookId });
    const catalog = parseCatalog(bookId, data);
    if (catalog.chapters.length === 0) {
      throw new QidianApiError('目录为空（这本书可能已下架或不支持网页阅读）', undefined);
    }
    return catalog;
  }

  public async getChapter(bookId: string, chapter: Pick<QidianChapter, 'chapterId' | 'title' | 'vip'>): Promise<QidianChapterContent> {
    const fallbackUrl = getChapterUrl(bookId, chapter.chapterId);
    const data = (await this.request('GET', '/webcommon/chapter/getMChapterInfo', {
      bookId,
      chapterId: chapter.chapterId,
    })) as Record<string, unknown> | null;
    const d = data ?? {};
    const ci = (d.chapterInfo ?? {}) as Record<string, unknown>;
    const risk = (d.riskInfo ?? {}) as Record<string, unknown>;

    const vip = Number(ci.vipStatus) === 1 || chapter.vip;
    const bought = Number(ci.isBuy) === 1;
    const limitFree = Number(ci.limitFree) === 1;
    const encrypted = Number(ci.cES ?? 0) !== 0;
    const fontEncrypted = Number(ci.fEnS ?? 0) !== 0 || !!plainText(ci.randomFont);
    const banId = Number(risk.banId ?? 0);
    const rawContent = typeof ci.content === 'string' ? ci.content : '';

    const result: QidianChapterContent = {
      chapterId: String(ci.chapterId ?? chapter.chapterId),
      title: plainText(ci.chapterName) ?? chapter.title,
      html: null,
      authorSay: plainText(ci.authorSay) ?? plainText((ci.authorWords as Record<string, unknown> | undefined)?.content),
      vip,
      bought,
      preview: false,
      nextId: validId(ci.next),
      prevId: validId(ci.prev),
      wordCount: typeof ci.actualWords === 'number' ? ci.actualWords : undefined,
      updateTime: plainText(ci.updateTime),
      diagnostics: `vipStatus=${String(ci.vipStatus)} isBuy=${String(ci.isBuy)} cES=${String(ci.cES)} fEnS=${String(ci.fEnS)} limitFree=${String(ci.limitFree)} banId=${banId} contentLen=${rawContent.length}`,
      fallbackUrl,
    };

    if (banId !== 0 && banId !== 4) {
      result.blockedReason =
        plainText(risk.banMessage) || '起点判定当前网络环境存在风险，暂时无法获取章节内容，请稍后或在浏览器中阅读';
      return result;
    }
    if (encrypted) {
      result.blockedReason = '本章正文由起点加密下发（VIP 章节），插件不做破解，请在浏览器或起点 APP 中阅读';
      return result;
    }
    if (fontEncrypted) {
      result.blockedReason = '本章正文启用了起点字体反爬，文字无法正常显示，请在浏览器或起点 APP 中阅读';
      return result;
    }
    const html = chapterContentToHtml(rawContent);
    if (!html) {
      result.blockedReason = vip && !bought ? '本章为 VIP 章节，需要在起点订阅后阅读' : '本章没有可显示的正文';
      return result;
    }
    result.html = html;
    // 未购买的 VIP 章节只下发前几段试读, 末尾以 "..." 收尾
    if (vip && !bought && !limitFree) {
      result.preview = true;
      result.blockedReason = '以上为试读片段：本章为 VIP 付费章节，需要在起点订阅后阅读全文';
    }
    return result;
  }

  /** 云端阅读进度 (仅登录态; 失败返回 null, 不打断阅读) */
  public async getReadStatus(bookId: string, chapter?: QidianChapter): Promise<QidianReadStatus | null> {
    if (!this.auth.isLoggedIn()) return null;
    try {
      const data = (await this.request(
        'GET',
        '/webcommon/chapter/getReadStatus',
        {
          bookId,
          chapterId: chapter?.chapterId,
          chapterName: chapter?.title,
          isVip: chapter ? (chapter.vip ? 1 : 0) : undefined,
          chapterUpdateTime: chapter?.updateTime,
        },
        { requireLogin: true },
      )) as Record<string, unknown> | null;
      if (!data) return null;
      return {
        readChapterId: validId(data.readChapterId),
        isInBookShelf: data.isInBookShelf === undefined ? undefined : Number(data.isInBookShelf) === 1,
      };
    } catch (e) {
      console.warn('[qidian] getReadStatus 失败', e instanceof Error ? e.message : e);
      return null;
    }
  }

  /** 上报阅读进度到起点云端 (与手机 / 网页互通); 失败静默 */
  public async reportReadStatus(bookId: string, chapter: QidianChapter): Promise<void> {
    if (!this.auth.isLoggedIn()) return;
    try {
      await this.request(
        'POST',
        '/webcommon/chapter/updReadStatus',
        {},
        {
          requireLogin: true,
          form: {
            bookId,
            chapterId: chapter.chapterId,
            chapterName: chapter.title,
            isVip: chapter.vip ? 1 : 0,
            chapterUpdateTime: chapter.updateTime ?? '',
          },
        },
      );
    } catch (e) {
      console.warn('[qidian] 上报阅读进度失败', e instanceof Error ? e.message : e);
    }
  }
}

function validId(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (!s || s === '-1' || s === '0') return undefined;
  return s;
}

function randomToken(len: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
