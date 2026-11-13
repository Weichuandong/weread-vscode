import { WebChapterLink } from '../types';
import {
  CHAPTER_LIKE,
  HtmlLink,
  bookIdOf,
  cleanBookTitle,
  extractLinks,
  metaContent,
  navText,
  pickAuthor,
  resolveUrl,
  sameHost,
  stripNonContent,
  tagTexts,
  textOf,
  titleSegments,
  urlKey,
  urlTemplate,
} from './htmlUtil';

/**
 * Codex 目录页解析 (通用启发式)。
 *
 * 思路: 章节链接 = 与"已知章节 URL"同模板 (数字替换成 #) 的链接;
 * 不知道章节 URL 时 (用户直接贴目录页), 取"出现最多 + 文字像第x章"的那类模板。
 * 再按"连续成片"分组, 丢掉"最新章节"那一小撮 (模板站目录页顶部都会放几章最新的),
 * 剩下的按页面顺序拼接 + 去重。
 */

const LINK_BLACKLIST =
  /^(开始阅读|从头阅读|继续阅读|加入书架|加入书签|我的书架|阅读记录|首页|上一页|下一页|上一章|下一章|目录|返回|更多|查看更多|展开|收起|倒序|正序|排序|登录|注册|TXT下载|下载|投票|推荐|尾页|末页)$/i;

const RE_NEXT_PAGE = /^(下一页|下页|下一頁)$/;

/** 没有已知章节 URL 时, 从目录页猜章节链接模板 */
export function guessChapterTemplate(links: HtmlLink[], pageUrl: string): string | undefined {
  const score = new Map<string, number>();
  const count = new Map<string, number>();
  const self = urlKey(pageUrl);
  for (const l of links) {
    if (!l.href || !sameHost(l.href, pageUrl) || urlKey(l.href) === self) continue;
    if (!l.text || LINK_BLACKLIST.test(navText(l.text))) continue;
    const tpl = urlTemplate(l.href);
    if (!tpl.includes('#')) continue;
    count.set(tpl, (count.get(tpl) ?? 0) + 1);
    score.set(tpl, (score.get(tpl) ?? 0) + 1 + (CHAPTER_LIKE.test(l.text) ? 2 : 0));
  }
  let best: string | undefined;
  let bestScore = 0;
  for (const [tpl, s] of score) {
    if ((count.get(tpl) ?? 0) < 2) continue;
    if (s > bestScore) {
      best = tpl;
      bestScore = s;
    }
  }
  return best;
}

export interface CatalogPageResult {
  chapters: WebChapterLink[];
  bookTitle?: string;
  author?: string;
  /** 从 <select> 分页下拉里找到的全部目录页 (按下拉顺序) */
  pageUrls: string[];
  /** "下一页" 链接 (没有分页下拉时逐页翻) */
  nextPageUrl?: string;
  chapterTemplate?: string;
}

interface Run {
  items: HtmlLink[];
  end: number;
  latest: boolean;
}

function splitRuns(clean: string, links: HtmlLink[], isChapter: (l: HtmlLink) => boolean): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (!isChapter(l)) {
      // 中间夹了别的链接 (含无 href 的标题链接) → 断开
      if (cur) runs.push(cur);
      cur = null;
      continue;
    }
    if (cur) {
      const gap = clean.slice(cur.end, l.start);
      if (gap.length > 800 || /<h[1-6]\b/i.test(gap)) {
        runs.push(cur);
        cur = null;
      }
    }
    if (!cur) {
      // 这一片前面的上下文 (含上一个链接的文字), 用来识别"最新章节"区块
      const prev = links[i - 1];
      const ctxStart = Math.max(prev ? prev.start : 0, l.start - 300);
      cur = { items: [], end: l.end, latest: /最新/.test(textOf(clean.slice(ctxStart, l.start))) };
    }
    cur.items.push(l);
    cur.end = l.end;
  }
  if (cur) runs.push(cur);
  return runs;
}

/** 有的站点目录是倒序 (最新在前): URL 里的数字大多递减就翻转 */
export function fixOrder(chapters: WebChapterLink[]): WebChapterLink[] {
  if (chapters.length < 4) return chapters;
  const nums = chapters.map((c) => {
    const m = c.url.match(/(\d+)(?!.*\d)/);
    return m ? Number(m[1]) : NaN;
  });
  let dec = 0;
  let total = 0;
  for (let i = 1; i < nums.length; i++) {
    if (!Number.isFinite(nums[i]) || !Number.isFinite(nums[i - 1]) || nums[i] === nums[i - 1]) continue;
    total++;
    if (nums[i] < nums[i - 1]) dec++;
  }
  return total > 0 && dec / total >= 0.7 ? [...chapters].reverse() : chapters;
}

export function parseCatalogPage(html: string, pageUrl: string, chapterTemplate?: string): CatalogPageResult {
  const clean = stripNonContent(html);
  const links = extractLinks(clean, pageUrl);
  const tpl = chapterTemplate ?? guessChapterTemplate(links, pageUrl);

  const isChapter = (l: HtmlLink) =>
    !!tpl && !!l.href && urlTemplate(l.href) === tpl && !!l.text && !LINK_BLACKLIST.test(navText(l.text));

  const runs = splitRuns(clean, links, isChapter);
  let kept = runs.filter((r) => !r.latest);
  if (!kept.length) kept = runs;
  // 有成片的目录时, 丢掉零星的、文字不像章节名的链接 (推荐位 / 广告位)
  if (kept.some((r) => r.items.length >= 3)) {
    kept = kept.filter((r) => r.items.length >= 3 || r.items.every((l) => CHAPTER_LIKE.test(l.text)));
  }
  const seen = new Set<string>();
  const chapters: WebChapterLink[] = [];
  for (const r of kept) {
    for (const l of r.items) {
      const k = urlKey(l.href);
      if (seen.has(k)) continue;
      seen.add(k);
      chapters.push({ title: l.text, url: l.href });
    }
  }

  // 目录分页: <select> 下拉 / "下一页" 链接; 只认同站 + 路径里带书 id 的
  const bookId = bookIdOf(pageUrl);
  const accept = (u: string | undefined): u is string =>
    !!u && sameHost(u, pageUrl) && (!bookId || u.includes(bookId)) && (!tpl || urlTemplate(u) !== tpl);
  const pageUrls: string[] = [];
  const selectRe = /<select\b[\s\S]*?<\/select>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = selectRe.exec(clean))) {
    const optRe = /<option\b[^>]*\bvalue\s*=\s*["']([^"']+)["']/gi;
    let om: RegExpExecArray | null;
    while ((om = optRe.exec(sm[0]))) {
      const u = resolveUrl(om[1], pageUrl);
      if (accept(u) && !pageUrls.some((x) => urlKey(x) === urlKey(u))) pageUrls.push(u);
    }
  }
  const nextLink = links.find(
    (l) => l.href && urlKey(l.href) !== urlKey(pageUrl) && RE_NEXT_PAGE.test(navText(l.text)) && accept(l.href),
  );

  const h1 = tagTexts(clean, 'h1')[0];
  const bookTitle = cleanBookTitle(metaContent(html, 'og:novel:book_name') ?? h1 ?? titleSegments(html)[0]);

  return {
    chapters,
    bookTitle,
    author: pickAuthor(html),
    pageUrls,
    nextPageUrl: nextLink?.href,
    chapterTemplate: tpl,
  };
}
