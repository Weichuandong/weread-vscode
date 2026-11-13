import { decodeEntities } from '../../qidian/api/qidianParse';
import { WebChapterPage } from '../types';
import {
  CHAPTER_LIKE,
  HtmlLink,
  cjkCount,
  cleanBookTitle,
  extractLinks,
  metaContent,
  navText,
  normalizeChapterTitle,
  stripNonContent,
  tagTexts,
  titleKey,
  titleSegments,
  urlKey,
} from './htmlUtil';

/**
 * Codex 章节页解析 (通用启发式, 不写死站点)。
 *
 *   - 正文: 优先常见 id/class 容器 (#content / #chaptercontent / .readcontent ...),
 *           兜底"中文字数最多且最深"的块
 *   - 导航: 按链接文字识别 上一页 / 下一页 / 上一章 / 下一章 / 目录
 *   - 去噪: 站点水印 / "请退出阅读模式" / 网址广告等短行
 *   - 跨页拼接: 见 mergePages
 */

// ---------------- 正文容器 ----------------

const CONTENT_IDS = new Set([
  'chaptercontent', 'chapter-content', 'chapter_content', 'content', 'booktxt', 'htmlcontent', 'nr1', 'nr',
  'textcontent', 'txt', 'booktext', 'acontent', 'novelcontent', 'contentbox', 'readcontent', 'read-content',
  'chaptertxt', 'chapter_text', 'text', 'article', 'cont-body', 'txtcontent', 'bookcontent',
]);
const CONTENT_CLASSES = new Set([
  'readcontent', 'read-content', 'chapter-content', 'chaptercontent', 'chapter_content', 'content', 'txt',
  'readarea', 'article-content', 'novelcontent', 'text-content', 'book-content', 'txtnav', 'yd_text2',
  'showtxt', 'content-body', 'read_txt',
]);

interface Block {
  start: number;
  end: number;
  inner: string;
  cjk: number;
}

function balancedInner(html: string, openEnd: number, tag: string): { inner: string; end: number } {
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = openEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0].endsWith('/>')) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return { inner: html.slice(openEnd, m.index), end: re.lastIndex };
  }
  return { inner: html.slice(openEnd), end: html.length };
}

function blockCjk(inner: string): number {
  return cjkCount(inner.replace(/<a\b[\s\S]*?<\/a>/gi, '').replace(/<[^>]+>/g, ''));
}

/** 中文字数最多的块; 若其内部还有字数 ≥ 70% 的子块, 取更深那个 (剥掉外层壳) */
function pickBest(blocks: Block[]): Block | undefined {
  if (!blocks.length) return undefined;
  const sorted = [...blocks].sort((a, b) => b.cjk - a.cjk);
  let best = sorted[0];
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of sorted) {
      if (b === best) continue;
      if (b.start > best.start && b.end <= best.end && b.cjk >= best.cjk * 0.7) {
        best = b;
        changed = true;
      }
    }
  }
  return best;
}

export function extractContentBlock(html: string): string | undefined {
  const clean = stripNonContent(html);
  const openRe = /<(div|article|section|td|dd)\b([^>]*)>/gi;
  const named: Block[] = [];
  const all: Block[] = [];
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(clean))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    const openEnd = m.index + m[0].length;
    const { inner, end } = balancedInner(clean, openEnd, tag);
    const block: Block = { start: m.index, end, inner, cjk: blockCjk(inner) };
    const id = (/\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '').toLowerCase();
    const classes = (/\bclass\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? '').toLowerCase().split(/\s+/);
    if (CONTENT_IDS.has(id) || classes.some((c) => CONTENT_CLASSES.has(c))) named.push(block);
    if (block.cjk >= 30) all.push(block);
  }
  // 命名容器优先; 都很短时 (例如分页尾页只剩半句话 "。") 也仍然用命名容器, 而不是去全页瞎猜
  const best = named.length
    ? pickBest(named.filter((b) => b.cjk >= 50)) ??
      pickBest(named.filter((b) => b.cjk > 0)) ??
      [...named].sort((a, b) => a.inner.length - b.inner.length)[0]
    : pickBest(all);
  return best?.inner;
}

// ---------------- 段落 + 去噪 ----------------

const NOISE_RULES: RegExp[] = [
  /章节内容不完整/,
  /(退出|关闭)(阅读|畅读|转码)模式/,
  /加入书签|加入书架|方便(下次)?阅读/,
  /本章未完.{0,8}(点击|下一页)/,
  /点击下一页继续/,
  /(本站|最新|永久|备用|新)(网址|域名|地址)/,
  /(记住|收藏)本站/,
  /一秒记住/,
  /(手机|移动)(版|端)?(阅读|访问)?(网址|地址)/,
  /最快更新|无弹窗|首发网址|免费阅读网/,
];
const NOISE_URL = /(https?:\/\/|www\.|\.(com|net|org|cc|la|cn|info|me|vip|xyz|top|tw)\b)/i;

function isNoiseLine(t: string): boolean {
  // 省略号 / 破折号独立成段是正文常见写法, 保留
  if (/^[…—.。！？!?]+$/.test(t)) return false;
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(t)) return true;
  if (t.length > 80) return false;
  return NOISE_RULES.some((r) => r.test(t)) || NOISE_URL.test(t);
}

export function blockToParagraphs(
  block: string,
  chapterTitle: string,
): { paragraphs: string[]; firstIndented: boolean; indentRatio: number } {
  let s = stripNonContent(block)
    .replace(/<a\b[\s\S]*?<\/a>/gi, '')
    .replace(/<(h[1-6])\b[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|ul|ol|section|article|dd|dt|tr|td|table|blockquote|center)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/\r/g, '');

  const paragraphs: string[] = [];
  const indents: boolean[] = [];
  for (const raw of s.split('\n')) {
    // 全角空格是缩进不是正文, 直接去掉; 其余连续空白折叠成一个
    const t = raw.replace(/\u3000/g, '').replace(/[\s\u00a0]+/g, ' ').trim();
    if (!t || isNoiseLine(t)) continue;
    paragraphs.push(t);
    indents.push(/^[ \t\u00a0\u3000]/.test(raw));
  }
  // 正文首行重复章节标题时去掉
  const tk = titleKey(chapterTitle);
  if (tk && paragraphs.length && titleKey(paragraphs[0]) === tk) {
    paragraphs.shift();
    indents.shift();
  }
  const indentRatio = indents.length ? indents.filter(Boolean).length / indents.length : 0;
  return { paragraphs, firstIndented: indents[0] ?? true, indentRatio };
}

const SENTENCE_END = /[。！？!?…”」』）)\]】~～—.:：;；"'》*]$/;

/**
 * 把多页正文拼成一整章。
 * 站点按字数硬切分页, 段落经常被腰斩 (上页末尾 "丁松言" + 下页开头 "疑惑拿起…"),
 * 两种信号任一命中就把下页首段接回上页末段:
 *   1) 上页末段没有句末标点
 *   2) 站点正常段落都有缩进 (≥60%), 而下页首段没有缩进
 */
export function mergePages(pages: WebChapterPage[]): string[] {
  const out: string[] = [];
  let prev: WebChapterPage | undefined;
  for (const p of pages) {
    const paras = [...p.paragraphs];
    if (prev && out.length && paras.length) {
      const last = out[out.length - 1];
      const open = !SENTENCE_END.test(last);
      const indentBroken = prev.indentRatio >= 0.6 && !p.firstIndented;
      if (open || indentBroken) out[out.length - 1] = last + paras.shift();
    }
    out.push(...paras);
    prev = p;
  }
  return out;
}

// ---------------- 导航链接 ----------------

const RE_PREV_PAGE = /^(上一页|上页|上一頁)$/;
const RE_NEXT_PAGE = /^(下一页|下页|下一頁)$/;
const RE_PREV_CH = /^(上一章|上章|上一节|上一回|前一章)$/;
const RE_NEXT_CH = /^(下一章|下章|下一节|下一回|后一章)$/;
const RE_CATALOG = /^(目录|章节目录|返回目录|回目录|书目录|章节列表|返回书页|书页|返回列表|全部章节|查看目录|目錄)$/;

export interface NavLinks {
  prevPageUrl?: string;
  nextPageUrl?: string;
  prevChapterUrl?: string;
  nextChapterUrl?: string;
  catalogUrl?: string;
}

export function findNavLinks(links: HtmlLink[], pageUrl: string): NavLinks {
  const self = urlKey(pageUrl);
  let home = '';
  try {
    home = urlKey(new URL(pageUrl).origin + '/');
  } catch {
    /* ignore */
  }
  const first = (re: RegExp, extra?: (l: HtmlLink) => boolean) =>
    links.find((l) => l.href && urlKey(l.href) !== self && re.test(navText(l.text)) && (!extra || extra(l)))?.href;
  return {
    prevPageUrl: first(RE_PREV_PAGE),
    nextPageUrl: first(RE_NEXT_PAGE),
    prevChapterUrl: first(RE_PREV_CH),
    nextChapterUrl: first(RE_NEXT_CH),
    // 目录不能是站点首页
    catalogUrl: first(RE_CATALOG, (l) => urlKey(l.href) !== home),
  };
}

// ---------------- 章节页 ----------------

function pickChapterTitle(html: string): string {
  const h1 = tagTexts(html, 'h1');
  const segs = titleSegments(html);
  const h2 = tagTexts(html, 'h2');
  const candidates = [...h1, segs[0] ?? '', ...h2].map(normalizeChapterTitle).filter(Boolean);
  const hit = candidates.find((c) => CHAPTER_LIKE.test(c) && c.length <= 80);
  return hit ?? normalizeChapterTitle(segs[0] ?? h1[0] ?? '');
}

export function parseChapterPage(html: string, url: string): WebChapterPage {
  const links = extractLinks(stripNonContent(html), url);
  const nav = findNavLinks(links, url);
  const title = pickChapterTitle(html);
  const block = extractContentBlock(html);
  const parsed = block
    ? blockToParagraphs(block, title)
    : { paragraphs: [] as string[], firstIndented: true, indentRatio: 0 };

  const keywords = (metaContent(html, 'keywords') ?? '').split(/[,，]/).map((s) => s.trim());
  const segs = titleSegments(html);
  const bookTitle = cleanBookTitle(metaContent(html, 'og:novel:book_name') ?? (keywords[1] || segs[1]));
  return {
    url,
    title,
    bookTitle,
    author: metaContent(html, 'og:novel:author'),
    paragraphs: parsed.paragraphs,
    firstIndented: parsed.firstIndented,
    indentRatio: parsed.indentRatio,
    ...nav,
    textLength: cjkCount(parsed.paragraphs.join('')),
  };
}

/** 两个分页是否属于同一章 (标题去掉分页后缀后相同; 拿不到标题时默认同章) */
export function isSameChapter(a: WebChapterPage, b: WebChapterPage): boolean {
  const ka = titleKey(a.title);
  const kb = titleKey(b.title);
  if (!ka || !kb) return true;
  return ka === kb;
}
