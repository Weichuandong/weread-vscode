import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import { TextDecoder } from 'util';
import { WebCatalog, WebChapterContent, WebChapterLink, WebChapterPage, WebProbeResult } from '../types';
import { isSameChapter, mergePages, parseChapterPage } from './chapterParse';
import { CatalogPageResult, fixOrder, parseCatalogPage } from './catalogParse';
import { urlKey, urlTemplate } from './htmlUtil';

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

/** 一章最多合并多少页 (防止站点导航异常时死循环) */
const MAX_CHAPTER_PAGES = 30;
/** 目录最多翻多少页 */
const MAX_CATALOG_PAGES = 200;
/** 目录分页并发数 */
const CATALOG_CONCURRENCY = 4;
/** 正文 CJK 字数达到多少才认定为"章节页" (否则按目录页处理) */
const CHAPTER_MIN_TEXT = 150;

/**
 * Codex HTTP 客户端: 抓网页 → 解码 (自动识别 GBK / UTF-8) → 交给解析器。
 *
 * 不需要登录, 不带 Cookie。只做"读", 不做任何写操作。
 */
export class WebNovelClient implements vscode.Disposable {
  private http: AxiosInstance;
  private readonly configListener: vscode.Disposable;

  constructor() {
    this.http = this.buildHttpClient();
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('webnovel')) this.http = this.buildHttpClient();
    });
  }

  dispose(): void {
    this.configListener.dispose();
  }

  private buildHttpClient(): AxiosInstance {
    const config = vscode.workspace.getConfiguration('webnovel');
    const timeout = config.get<number>('requestTimeout', 15000);
    const userAgent = config.get<string>('userAgent', DEFAULT_UA) || DEFAULT_UA;
    return axios.create({
      timeout,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      headers: {
        'User-Agent': userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      validateStatus: () => true,
    });
  }

  /** 抓取并解码网页; 网络错误重试一次 */
  async fetchHtml(url: string): Promise<{ html: string; url: string }> {
    let referer = '';
    try {
      referer = new URL(url).origin + '/';
    } catch {
      throw new Error(`不是有效的网址：${url}`);
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.http.get<ArrayBuffer>(url, { headers: { Referer: referer } });
        if (res.status >= 400) {
          throw new HttpStatusError(res.status);
        }
        const buf = Buffer.from(res.data);
        // node http adapter 跟随重定向后的最终地址
        const finalUrl: string = (res.request as { res?: { responseUrl?: string } })?.res?.responseUrl || url;
        return { html: decodeHtml(buf, String(res.headers['content-type'] ?? '')), url: finalUrl };
      } catch (e) {
        lastErr = e;
        if (e instanceof HttpStatusError && e.status < 500) break;
      }
    }
    throw new Error(`请求失败：${describeError(lastErr)}`);
  }

  /** 判断用户贴进来的 URL 是章节页还是目录页 */
  async probe(url: string): Promise<WebProbeResult> {
    const { html, url: finalUrl } = await this.fetchHtml(url);
    const page = parseChapterPage(html, finalUrl);
    if (page.textLength >= CHAPTER_MIN_TEXT) return { kind: 'chapter', page };
    return { kind: 'catalog', url: finalUrl, html };
  }

  /**
   * 拉一整章: 先顺着"上一页"回溯到本章第一页, 再顺着"下一页"拼到最后一页。
   * 用户贴的是 xxx_2.html 也能拿到完整一章。
   */
  async getChapter(url: string, preloaded?: WebChapterPage): Promise<WebChapterContent> {
    const cache = new Map<string, WebChapterPage>();
    if (preloaded) {
      cache.set(urlKey(url), preloaded);
      cache.set(urlKey(preloaded.url), preloaded);
    }
    const load = async (u: string): Promise<WebChapterPage> => {
      const hit = cache.get(urlKey(u));
      if (hit) return hit;
      const { html, url: finalUrl } = await this.fetchHtml(u);
      const p = parseChapterPage(html, finalUrl);
      cache.set(urlKey(u), p);
      cache.set(urlKey(finalUrl), p);
      return p;
    };

    const entry = await load(url);
    if (entry.paragraphs.length === 0) {
      throw new Error('没有在页面里识别到正文（可能不是章节页，或站点结构暂不支持）');
    }

    // 1) 回溯到本章第一页
    let first = entry;
    let prevChapterUrl: string | undefined;
    for (let i = 0; i < MAX_CHAPTER_PAGES && first.prevPageUrl; i++) {
      let p: WebChapterPage;
      try {
        p = await load(first.prevPageUrl);
      } catch {
        break;
      }
      if (!isSameChapter(p, first)) {
        // "上一页"其实跳到了上一章 (有的站点不区分上一页 / 上一章)
        prevChapterUrl = first.prevPageUrl;
        break;
      }
      first = p;
    }
    prevChapterUrl = first.prevChapterUrl ?? prevChapterUrl;

    // 2) 向后拼完整章
    const pages: WebChapterPage[] = [first];
    const seen = new Set([urlKey(first.url)]);
    let last = first;
    let nextChapterUrl: string | undefined;
    for (let i = 0; i < MAX_CHAPTER_PAGES && last.nextPageUrl; i++) {
      const nextUrl = last.nextPageUrl;
      let p: WebChapterPage;
      try {
        p = await load(nextUrl);
      } catch {
        break;
      }
      if (!isSameChapter(p, last)) {
        nextChapterUrl = nextUrl;
        break;
      }
      if (seen.has(urlKey(p.url))) break;
      seen.add(urlKey(p.url));
      pages.push(p);
      last = p;
    }
    nextChapterUrl = last.nextChapterUrl ?? nextChapterUrl;

    const paragraphs = mergePages(pages);
    return {
      url: first.url,
      title: first.title || entry.title || '未命名章节',
      paragraphs,
      pageCount: pages.length,
      prevChapterUrl,
      nextChapterUrl,
      catalogUrl: first.catalogUrl ?? entry.catalogUrl,
      bookTitle: first.bookTitle ?? entry.bookTitle,
      author: first.author ?? entry.author,
      wordCount: paragraphs.reduce((n, p) => n + p.replace(/\s/g, '').length, 0),
    };
  }

  /**
   * 拉完整目录 (自动合并分页)。
   * @param chapterUrlHint 已知的某个章节 URL — 用它的模板识别章节链接, 比瞎猜准
   * @param preloadedHtml  probe 阶段已经抓过的目录页 HTML, 省一次请求
   */
  async getCatalog(catalogUrl: string, chapterUrlHint?: string, preloadedHtml?: string): Promise<WebCatalog> {
    const firstRes = preloadedHtml !== undefined ? { html: preloadedHtml, url: catalogUrl } : await this.fetchHtml(catalogUrl);
    let first = parseCatalogPage(firstRes.html, firstRes.url, chapterUrlHint ? urlTemplate(chapterUrlHint) : undefined);
    // 已知模板对不上 (比如目录页章节链接走了另一个子域) → 退回自动识别
    if (first.chapters.length === 0 && chapterUrlHint) first = parseCatalogPage(firstRes.html, firstRes.url);
    const tpl = first.chapterTemplate;

    const results: CatalogPageResult[] = [];
    if (first.pageUrls.length >= 2) {
      const urls = first.pageUrls.slice(0, MAX_CATALOG_PAGES);
      if (!urls.some((u) => urlKey(u) === urlKey(firstRes.url))) urls.unshift(firstRes.url);
      const fetched = await mapLimit(urls, CATALOG_CONCURRENCY, async (u) => {
        if (urlKey(u) === urlKey(firstRes.url)) return first;
        try {
          const r = await this.fetchHtml(u);
          return parseCatalogPage(r.html, r.url, tpl);
        } catch {
          return undefined;
        }
      });
      fetched.forEach((r) => r && results.push(r));
    } else {
      results.push(first);
      const seen = new Set([urlKey(firstRes.url)]);
      let next = first.nextPageUrl;
      while (next && !seen.has(urlKey(next)) && seen.size < MAX_CATALOG_PAGES) {
        seen.add(urlKey(next));
        try {
          const r = await this.fetchHtml(next);
          const parsed = parseCatalogPage(r.html, r.url, tpl);
          if (parsed.chapters.length === 0) break;
          results.push(parsed);
          next = parsed.nextPageUrl;
        } catch {
          break;
        }
      }
    }

    const seenCh = new Set<string>();
    const chapters: WebChapterLink[] = [];
    for (const r of results) {
      for (const c of r.chapters) {
        const k = urlKey(c.url);
        if (seenCh.has(k)) continue;
        seenCh.add(k);
        chapters.push(c);
      }
    }
    if (chapters.length === 0) {
      throw new Error('没有在目录页识别到章节列表（站点结构暂不支持）');
    }
    return {
      catalogUrl: firstRes.url,
      bookTitle: first.bookTitle,
      author: first.author,
      chapters: fixOrder(chapters),
      pageCount: results.length,
    };
  }
}

class HttpStatusError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function describeError(e: unknown): string {
  if (e instanceof HttpStatusError) return e.message;
  if (axios.isAxiosError(e)) {
    if (e.code === 'ECONNABORTED') return '请求超时';
    if (e.code === 'ENOTFOUND') return '域名无法解析';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** 识别编码: Content-Type → <meta charset> → 默认 UTF-8; GB2312/GBK 统一按 GB18030 (超集) 解 */
function decodeHtml(buf: Buffer, contentType: string): string {
  let cs = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!cs) {
    const head = buf.subarray(0, 4096).toString('latin1');
    cs = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  let label = (cs ?? 'utf-8').toLowerCase();
  if (/^(gb2312|gbk|x-gbk|gb_2312|cp936)/.test(label)) label = 'gb18030';
  try {
    return new TextDecoder(label).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
