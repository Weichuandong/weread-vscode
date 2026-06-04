import * as vscode from 'vscode';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { AuthService } from '../auth/AuthService';
import { getBookReaderUrl } from './wereadUrl';
import { calcHash, sign, currentTime } from './wereadSign';
import { chk, dH, dS, dT } from './wereadDecrypt';
import {
  BookProgress,
  BookshelfData,
  BookshelfResponse,
  ChapterInfosResponse,
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
}
