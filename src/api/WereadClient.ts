import * as vscode from 'vscode';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { AuthService } from '../auth/AuthService';
import { getBookReaderUrl } from './wereadUrl';
import { calcHash, sign, currentTime } from './wereadSign';
import { chk, dH, dS, dT } from './wereadDecrypt';
import {
  BestBookmark,
  BookProgress,
  BookshelfData,
  BookshelfResponse,
  ChapterInfosResponse,
  ChapterUnderline,
  Review,
  ReviewAuthor,
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
    return axios.create({
      baseURL: WereadClient.BASE_URL,
      timeout,
      headers: {
        'User-Agent': userAgent,
        Referer: 'https://weread.qq.com/',
        Accept: 'application/json, text/plain, */*',
      },
      validateStatus: (status) => status >= 200 && status < 500,
    });
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const cookie = this.auth.getCookieHeader();
    return {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(extra ?? {}),
    };
  }

  private isUnauthorized(status: number, data: unknown): boolean {
    if (status === 401 || status === 403) {
      return true;
    }
    if (data && typeof data === 'object') {
      const errcode = (data as Record<string, unknown>).errcode;
      if (errcode === -2010 || errcode === -2012 || errcode === -2013) {
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
   * 抓取章节内容。
   *
   * 真接口策略(参考 touchFish 项目):
   *   1. 先 GET /web/book/info?bookId=xxx 拿到 format(epub|pdf|txt)
   *   2. epub/pdf  → 并行 POST /web/book/chapter/e_0..e_3, e_2 是 style, e_0+e_1+e_3 拼接为正文
   *      txt       → 并行 POST /web/book/chapter/t_0..t_1, 拼接后解密为纯文本
   *   3. 每个分片响应都先 chk() 做 MD5 校验, 再 dH/dS/dT 解密
   *
   * 失败时返回详细 diagnostics, UI 仍可展示「在浏览器中打开」兜底。
   */
  public async fetchChapterContent(
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
      const info = infoRes.data as { format?: string };
      format = info?.format ?? '';
      result.format = format;
      log(`图书格式: ${format || '(空)'}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`获取图书信息异常: ${msg}`);
      result.diagnostics = diag.join('\n');
      return result;
    }

    if (!format) {
      log('未取到 format, 无法决定走 e_* 还是 t_* 接口');
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

    result.diagnostics = diag.join('\n');
    return result;
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
}
