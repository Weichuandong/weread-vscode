/**
 * 起点数据解析 / 归一化 / URL 工具 (纯函数, 不依赖 vscode, 方便单独测试)。
 */
import {
  QidianBook,
  QidianCatalog,
  QidianChapter,
  QidianShelfGroup,
  QidianVolume,
} from '../types';

// ---------------- URL ----------------

export function getBookUrl(bookId: string): string {
  return `https://www.qidian.com/book/${encodeURIComponent(bookId)}/`;
}

export function getChapterUrl(bookId: string, chapterId: string): string {
  return `https://www.qidian.com/chapter/${encodeURIComponent(bookId)}/${encodeURIComponent(chapterId)}/`;
}

/** 封面: 接口给的是 `//bookcover.yuewen.com/...` 协议相对地址; 没给时按 bid 拼标准封面地址 */
export function normalizeCover(raw: unknown, bookId: string): string {
  if (typeof raw === 'string' && raw.trim()) {
    const s = raw.trim();
    if (s.startsWith('//')) return `https:${s}`;
    if (/^https?:\/\//i.test(s)) return s.replace(/^http:/i, 'https:');
  }
  return bookId ? `https://bookcover.yuewen.com/qdbimg/349573/${bookId}/180` : '';
}

// ---------------- 榜单 / 搜索排序定义 ----------------

export interface RankDef {
  /** UI / 持久化用的 key */
  key: string;
  /** 接口路径段: /webcommon/rank/{api}list */
  api: string;
  title: string;
}

/**
 * 男频 (起点主站) 榜单。来源: m 站 rankDetail 页面里的配置表
 * (`yuepiao/hotsales/readindex/newfans/rec/update/sign/newbook/newauthor`),
 * 其中 readindex 的接口段是驼峰 `readIndex`。
 */
export const RANK_DEFS: RankDef[] = [
  { key: 'yuepiao', api: 'yuepiao', title: '月票榜' },
  { key: 'hotsales', api: 'hotsales', title: '畅销榜' },
  { key: 'readindex', api: 'readIndex', title: '阅读榜' },
  { key: 'rec', api: 'rec', title: '推荐榜' },
  { key: 'newfans', api: 'newfans', title: '书友榜' },
  { key: 'update', api: 'update', title: '更新榜' },
  { key: 'sign', api: 'sign', title: '签约榜' },
  { key: 'newbook', api: 'newbook', title: '新书榜' },
  { key: 'newauthor', api: 'newauthor', title: '新人榜' },
];

export const DEFAULT_RANK = 'yuepiao';

/** 榜单可按题材过滤 (catId), -1 = 全站。取自榜单页 filters。 */
export const RANK_CATEGORIES: { id: number; title: string }[] = [
  { id: -1, title: '全站' },
  { id: 21, title: '玄幻' },
  { id: 1, title: '奇幻' },
  { id: 2, title: '武侠' },
  { id: 22, title: '仙侠' },
  { id: 4, title: '都市' },
  { id: 15, title: '现实' },
  { id: 6, title: '军事' },
  { id: 5, title: '历史' },
  { id: 7, title: '游戏' },
  { id: 8, title: '体育' },
  { id: 9, title: '科幻' },
  { id: 10, title: '悬疑灵异' },
  { id: 20109, title: '诸天无限' },
  { id: 12, title: '轻小说' },
];

export function getRankDef(key: string): RankDef {
  return RANK_DEFS.find((r) => r.key === key) ?? RANK_DEFS[0];
}

/**
 * 搜索排序 —— 起点搜索接口**服务端支持** orderBy (不同于微信读书只能客户端排),
 * 所以切排序会重新请求第一页, 排的是全量结果而不只是已加载的部分。
 * value 取自搜索结果页的 orderBy 选项 ('' = 默认相关度/人气)。
 */
export const SEARCH_SORTS: { key: string; value: string; label: string; tip: string }[] = [
  { key: 'default', value: '', label: '综合', tip: '起点默认排序（相关度 + 人气）' },
  { key: 'collect', value: '11', label: '收藏', tip: '按收藏数从高到低（服务端排序，作用于全部结果）' },
  { key: 'yuepiao', value: '12', label: '月票', tip: '按月票从高到低（服务端排序）' },
  { key: 'rec', value: '9', label: '推荐', tip: '按推荐票从高到低（服务端排序）' },
  { key: 'words', value: '3', label: '字数', tip: '按总字数从多到少（服务端排序）' },
  { key: 'update', value: '4', label: '更新', tip: '按最近更新时间（服务端排序）' },
];

// ---------------- 归一化 ----------------

type Raw = Record<string, unknown>;

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function pick(o: Raw, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** 剥 HTML 标签 + 常见实体, 用于简介 / 章节名这类纯文本字段 */
export function plainText(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  return t || undefined;
}

/** 搜索结果 / 榜单 / 书架 的书 → QidianBook (三处字段名大体同源, 统一兜底) */
export function normalizeBook(raw: unknown): QidianBook | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Raw;
  const bookId = str(pick(o, 'bid', 'bookId', 'BookId'));
  if (!bookId) return null;
  const title = plainText(pick(o, 'bName', 'bookName', 'BookName')) ?? '';
  const book: QidianBook = {
    bookId,
    title,
    author: plainText(pick(o, 'bAuth', 'authorName', 'author', 'AuthorName')),
    cover: normalizeCover(pick(o, 'imgUrl', 'cover', 'bookCover'), bookId),
    intro: plainText(pick(o, 'desc', 'intro', 'description')),
    category: plainText(pick(o, 'cat', 'catName', 'chanName')),
    subCategory: plainText(pick(o, 'subCateName', 'subCat', 'subCatName')),
    status: plainText(pick(o, 'state', 'bookStatus', 'actionStatus')),
    wordCount: plainText(pick(o, 'cnt', 'wordsCnt', 'wordCount')),
    latestChapterName: plainText(pick(o, 'cnameStr', 'lastChapterName', 'updChapterName')),
    lastUpdate: plainText(pick(o, 'lastUpdateTime', 'updateTime', 'updTime')),
    favoriteCnt: plainText(o.favoriteCnt),
    recommendCnt: num(o.recomendCnt),
    rankNum: num(o.rankNum),
    rankCnt: plainText(o.rankCnt),
    signStatus: plainText(o.signStatus),
  };
  if (o.isVip !== undefined) book.isVip = Number(o.isVip) === 1;
  if (o.isInShelf !== undefined) book.inShelf = Number(o.isInShelf) === 1;

  // ---- 书架字段 ----
  const readCid = str(o.readCid);
  if (readCid && readCid !== '0') book.readChapterId = readCid;
  const readCname = plainText(o.readCname);
  if (readCname) book.readChapterName = readCname;
  if (o.isRead !== undefined) book.isRead = Number(o.isRead) === 1 || o.isRead === true;
  if (o.isNewChapter !== undefined) {
    book.hasUpdate = Number(o.isNewChapter) === 1 || o.isNewChapter === true;
  }
  if (o.accessRead !== undefined && o.accessRead !== null) {
    book.accessDenied = !o.accessRead || Number(o.accessRead) === 0;
  }
  return book;
}

export function normalizeBooks(list: unknown): QidianBook[] {
  if (!Array.isArray(list)) return [];
  const out: QidianBook[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    const b = normalizeBook(it);
    if (b && !seen.has(b.bookId)) {
      seen.add(b.bookId);
      out.push(b);
    }
  }
  return out;
}

/** /webcommon/bookshelf/mgroups 的返回 (数组, 或 {groups|list: []}) → 分组 */
export function normalizeGroups(data: unknown): QidianShelfGroup[] {
  let arr: unknown = data;
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const o = data as Raw;
    arr = o.groups ?? o.list ?? o.groupList ?? [];
  }
  if (!Array.isArray(arr)) return [];
  const out: QidianShelfGroup[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Raw;
    const groupId = str(pick(o, 'groupId', 'gid', 'id'));
    if (!groupId) continue;
    const isDefault = groupId === '-100';
    out.push({
      groupId,
      name: isDefault ? '默认书架' : plainText(pick(o, 'groupName', 'gName', 'name')) ?? `分组 ${groupId}`,
      bookCount: num(pick(o, 'bookCount', 'count')) ?? 0,
    });
  }
  return out;
}

/**
 * /webcommon/book/mCategory 的 data → 目录。
 *
 * 卷字段: vId / vN(卷名) / vS(1 = VIP 卷) / cs(章节数组)
 * 章字段: id / cN(章名) / sS / cnt(字数) / uT(更新时间)
 *
 * VIP 判定沿用 m 站前端的逻辑: VIP 卷里 sS=0 的才是付费章 (sS=1 为卷内免费章, 例如上架感言)。
 */
export function parseCatalog(bookId: string, data: unknown): QidianCatalog {
  const o = (data && typeof data === 'object' ? data : {}) as Raw;
  const vs = Array.isArray(o.vs) ? (o.vs as Raw[]) : [];
  const chapters: QidianChapter[] = [];
  const volumes: QidianVolume[] = [];
  for (const v of vs) {
    if (!v || typeof v !== 'object') continue;
    const volVip = Number(v.vS) === 1;
    const volName = plainText(v.vN) ?? '';
    const cs = Array.isArray(v.cs) ? (v.cs as Raw[]) : [];
    let count = 0;
    for (const c of cs) {
      if (!c || typeof c !== 'object') continue;
      const chapterId = str(c.id);
      if (!chapterId) continue;
      chapters.push({
        chapterId,
        title: plainText(c.cN) ?? `第 ${chapters.length + 1} 章`,
        idx: chapters.length,
        volumeName: volName,
        vip: volVip && Number(c.sS) === 0,
        wordCount: num(c.cnt),
        updateTime: str(c.uT),
      });
      count++;
    }
    volumes.push({
      volumeId: str(v.vId) ?? String(volumes.length),
      name: volName,
      vip: volVip,
      chapterCount: count,
    });
  }
  return {
    bookId,
    bookName: plainText(o.bookName),
    bookStatus: plainText(o.bookStatus),
    chapters,
    volumes,
  };
}

// ---------------- 正文 ----------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  hellip: '…',
  mdash: '—',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code < 0x110000) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const hit = NAMED_ENTITIES[body.toLowerCase()];
    return hit ?? m;
  });
}

export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 起点章节正文 → 安全的段落 HTML。
 *
 * 接口返回形如 `<p>　　痛！<p>　　好痛！...` (p 标签不闭合, 行首两个全角空格缩进)。
 * 这里**不信任**任何标签: 按 <p>/<br>/换行切段 → 剥标签 → 反解实体 → 去掉行首全角缩进
 * (由 CSS text-indent 统一缩进) → 逐段转义后重新包 <p>。这样正文里不可能混入脚本或样式,
 * 主题色完全交给外层 VSCode 变量。
 */
export function chapterContentToHtml(raw: string | null | undefined): string {
  if (!raw) return '';
  const normalized = String(raw)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?p\b[^>]*>/gi, '\n')
    .replace(/<\/?div\b[^>]*>/gi, '\n');
  const paragraphs = normalized
    .split(/\n+/)
    .map((p) => decodeEntities(p.replace(/<[^>]+>/g, '')))
    .map((p) => p.replace(/^[\s\u3000\u00a0]+|[\s\u3000\u00a0]+$/g, ''))
    .filter((p) => p.length > 0);
  return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
}

/** 统计净化后的段落数 (测试 / 诊断用) */
export function countParagraphs(html: string): number {
  return (html.match(/<p>/g) ?? []).length;
}
