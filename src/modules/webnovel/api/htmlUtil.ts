import { decodeEntities } from '../../qidian/api/qidianParse';

/**
 * Codex HTML 基础工具 (纯函数, 不依赖 DOM 库, 不引入新依赖)。
 */

export interface HtmlLink {
  /** 解析后的绝对 URL; javascript: / 空 href 为 '' */
  href: string;
  text: string;
  start: number;
  end: number;
}

export function resolveUrl(href: string, base: string): string | undefined {
  const h = decodeEntities(String(href ?? '').trim());
  if (!h || /^(javascript:|mailto:|tel:|#)/i.test(h)) return undefined;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    u.hash = '';
    return u.toString();
  } catch {
    return undefined;
  }
}

/** 规范化 URL 用于比较: 忽略协议 / hash / 末尾斜杠 */
export function urlKey(u: string | undefined): string {
  if (!u) return '';
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname.replace(/\/+$/, '')}${x.search}`;
  } catch {
    return u;
  }
}

/** 只看路径 (跨 m. / www. 子域时兜底匹配) */
export function urlPathKey(u: string | undefined): string {
  if (!u) return '';
  try {
    const x = new URL(u);
    return `${x.pathname.replace(/\/+$/, '')}${x.search}`;
  } catch {
    return u;
  }
}

/** URL 模板: 数字段替换成 #, 用来识别"同类链接" (如 host/chapter/#/#.html) */
export function urlTemplate(u: string): string {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname.replace(/\d+/g, '#')}`;
  } catch {
    return u;
  }
}

export function sameHost(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

export function hostOf(u: string | undefined): string {
  if (!u) return '';
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

/** 路径里最长的数字串 (≥3 位), 通常就是书 id */
export function bookIdOf(u: string): string | undefined {
  try {
    const nums = new URL(u).pathname.match(/\d{3,}/g) ?? [];
    return nums.sort((a, b) => b.length - a.length)[0];
  } catch {
    return undefined;
  }
}

export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/[\s\u00a0\u3000]+/g, ' ')
    .trim();
}

export function cjkCount(s: string): number {
  const m = s.match(/[\u4e00-\u9fff]/g);
  return m ? m.length : 0;
}

export function stripNonContent(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

export function extractLinks(html: string, base: string): HtmlLink[] {
  const out: HtmlLink[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const hrefM = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const raw = hrefM ? hrefM[1] ?? hrefM[2] ?? hrefM[3] ?? '' : '';
    out.push({
      href: (raw && resolveUrl(raw, base)) || '',
      text: textOf(m[2]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

export function metaContent(html: string, key: string): string | undefined {
  const re = /<meta\b[^>]*>/gi;
  const want = key.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const nm = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!nm || nm[1].toLowerCase() !== want) continue;
    const c = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    const v = c ? decodeEntities(c[1] ?? c[2] ?? '').trim() : '';
    if (v) return v;
  }
  return undefined;
}

export function tagTexts(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = textOf(m[1]);
    if (t) out.push(t);
  }
  return out;
}

/** <title> 按 "_" / "|" / " - " 切段 */
export function titleSegments(html: string): string[] {
  const t = tagTexts(html, 'title')[0] ?? '';
  return t
    .split(/_|\||\s[-–—]\s/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const CHAPTER_LIKE =
  /第\s*[0-9０-９零〇一二两三四五六七八九十百千万]+\s*[章节回卷集部篇话]|^\s*(chapter|ch\.?)\s*\d+|^\s*\d+[.、\s]/i;

/** 去掉分页后缀: "第三章 xx（2 / 4）" / "第三章 xx(第2页)" */
export function normalizeChapterTitle(t: string): string {
  return String(t ?? '')
    .replace(/\s*[（(]\s*\d+\s*\/\s*\d+\s*[)）]\s*$/, '')
    .replace(/\s*[（(]?\s*第\s*\d+\s*页\s*[)）]?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 标题比较用的 key: 去空白与标点 */
export function titleKey(t: string): string {
  return normalizeChapterTitle(t)
    .replace(/[\s\u00a0\u3000，。、！？!?,.:：;；“”"'‘’（）()【】[\]《》<>·…—\-_]/g, '')
    .toLowerCase();
}

/** 去掉 SEO 尾巴: "剑烛大荒小说txt下载最新章节列表" → "剑烛大荒" */
export function cleanBookTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let s = raw.split(/[,，_|]/)[0].replace(/[《》]/g, '').trim();
  const rules = [
    /(最新章节(列表|目录)?|章节(列表|目录)|(全文|免费|在线)+阅读|无弹窗|全文|全集|全本)$/i,
    /(小说)?txt(全集|全文)?(免费)?(下载)?$/i,
    /(小说)?(免费)?下载$/,
  ];
  for (let i = 0; i < 4; i++) {
    let next = s;
    for (const r of rules) next = next.replace(r, '').trim();
    if (!next || next === s) break;
    s = next;
  }
  return s || undefined;
}

export function pickAuthor(html: string): string | undefined {
  const og = metaContent(html, 'og:novel:author');
  if (og) return og;
  const body = textOf(stripNonContent(html).slice(0, 80000));
  const m = /作\s*者\s*[：:]\s*([^\s|/，,]{1,20})/.exec(body);
  return m ? m[1] : undefined;
}

/** 导航链接文字归一: 去掉空白和箭头 */
export function navText(t: string): string {
  return t.replace(/[\s←→<>«»‹›]/g, '');
}
