import { StoreBook, StoreCategoryDef, StoreCategoryNode, StoreCategoryTree } from '../types';

/**
 * 书城(发现页)相关的纯函数工具: 榜单/分类定义 + SSR 页面解析 + bookInfo 归一化。
 *
 * 为什么榜单要解析 SSR 而不是打 JSON 接口?
 *   微信读书 web 端的榜单/分类列表 **没有** 独立的 XHR 接口 —— 实测
 *   /web/bookListInCategory、/web/store/categoryList 等社区流传的路径全是 404,
 *   页面 https://weread.qq.com/web/category/{id} 是服务端直出, 列表数据塞在
 *   `window.__INITIAL_STATE__` 里 (categoryStoreModule.categoryBookList, 20 条)。
 *   所以这里走"拉 HTML → 抠 __INITIAL_STATE__ → 取 categoryBookList"的路子。
 *
 *   搜索则相反, /web/search/global 是标准 JSON 接口 (且无需登录), 直接在
 *   WereadClient 里请求即可, 不经过这里。
 */

/**
 * 榜单 / 一级分类的**兜底**清单。
 *
 * 真正展示的分类树来自 `GET /web/categories` (见 parseCategoryTree), 那份数据完整得多:
 * 7 个榜单 + 22 个一级分类 + 100 多个二级分类。这里的常量只在两个场景生效:
 *   1) 首屏 — 分类树还在路上时先把 chips 画出来, 不让用户对着空白等
 *   2) 兜底 — /web/categories 挂了 / 结构变更导致解析失败时, 至少这些常用入口还能点
 *
 * id 与标题都取自该接口的真实返回, 常年稳定 (rising / newbook / 100000 …)。
 */
export const STORE_CATEGORIES: StoreCategoryDef[] = [
  { id: 'rising', title: '飙升', kind: 'rank' },
  { id: 'newbook', title: '新书', kind: 'rank' },
  { id: 'general_novel_rising', title: '小说榜', kind: 'rank' },
  { id: 'all', title: '总榜', kind: 'rank' },
  { id: 'hot_search', title: '热搜榜', kind: 'rank' },
  { id: 'newrating_publish', title: '神作榜', kind: 'rank' },
  { id: 'newrating_potential_publish', title: '神作潜力榜', kind: 'rank' },
  { id: '100000', title: '精品小说', kind: 'category' },
  { id: '200000', title: '历史', kind: 'category' },
  { id: '300000', title: '文学', kind: 'category' },
  { id: '400000', title: '艺术', kind: 'category' },
  { id: '500000', title: '人物传记', kind: 'category' },
  { id: '600000', title: '哲学宗教', kind: 'category' },
  { id: '700000', title: '计算机', kind: 'category' },
  { id: '800000', title: '心理', kind: 'category' },
  { id: '900000', title: '社会文化', kind: 'category' },
  { id: '1000000', title: '个人成长', kind: 'category' },
  { id: '1100000', title: '经济理财', kind: 'category' },
  { id: '1200000', title: '政治军事', kind: 'category' },
  { id: '1300000', title: '童书', kind: 'category' },
  { id: '1400000', title: '教育学习', kind: 'category' },
  { id: '1500000', title: '科学技术', kind: 'category' },
  { id: '1600000', title: '生活百科', kind: 'category' },
  { id: '1700000', title: '期刊杂志', kind: 'category' },
  { id: '1800000', title: '原版书', kind: 'category' },
  { id: '2100000', title: '医学健康', kind: 'category' },
  { id: '2400000', title: '漫画', kind: 'category' },
];

/** 兜底分类树 — 由 STORE_CATEGORIES 拼出来, 没有二级分类 */
export const FALLBACK_CATEGORY_TREE: StoreCategoryTree = {
  ranks: STORE_CATEGORIES.filter((c) => c.kind === 'rank').map((c) => ({
    id: c.id,
    title: c.title,
  })),
  categories: STORE_CATEGORIES.filter((c) => c.kind === 'category').map((c) => ({
    id: c.id,
    title: c.title,
  })),
};

/** 默认打开书城时展示的榜单 */
export const DEFAULT_STORE_CATEGORY = 'rising';

/**
 * 找一个榜单/分类的展示名。
 *
 * 优先查动态分类树(含二级分类), 没有树或没命中再退到内置常量, 最后回落成 id 本身。
 */
export function getStoreCategoryTitle(id: string, tree?: StoreCategoryTree | null): string {
  if (tree) {
    const hit = findCategoryNode(tree, id);
    if (hit) {
      // 二级分类带上父级前缀, 免得"财经"这种在多个分类下重名的标题看不出出处
      return hit.parent ? `${hit.parent.title} · ${hit.node.title}` : hit.node.title;
    }
  }
  return STORE_CATEGORIES.find((c) => c.id === id)?.title ?? id;
}

/**
 * 在分类树里定位一个 id。
 *
 * 返回命中的节点, 以及它的父节点(仅二级分类才有)。榜单命中时 parent 为 undefined。
 * UI 用它来决定"要不要画第三行子分类 chips, 以及哪个子分类是选中态"。
 */
export function findCategoryNode(
  tree: StoreCategoryTree,
  id: string,
): { node: StoreCategoryNode; parent?: StoreCategoryNode } | null {
  for (const r of tree.ranks) {
    if (r.id === id) return { node: r };
  }
  for (const c of tree.categories) {
    if (c.id === id) return { node: c };
    for (const sub of c.children ?? []) {
      if (sub.id === id) return { node: sub, parent: c };
    }
  }
  return null;
}

/**
 * 解析 `GET /web/categories` 的返回 → 榜单 + 分类树。
 *
 * 返回结构 (实测):
 *   { synckey, data: [
 *       { name: '排行榜', type: 28, categories: [{ CategoryId: 'rising', title: '飙升·出版', ranklist: 1 }] },
 *       { categories: [{ CategoryId: '100000', title: '精品小说', totalCount, sublist: [{ CategoryId: '100001', title: '社会小说' }] }] },
 *       ...
 *   ]}
 *
 * 处理要点:
 *   - **榜单与分类靠 ranklist 字段区分**, 而不是靠 section 顺序 (顺序不保证稳定)
 *   - **过滤讲书 / 有声榜** (CategoryId '6100' / '6200'): 那是音频内容, /web/category/6100
 *     实测返回 0 本书, 点进去只会得到一个空列表, 不如不给入口
 *   - 标题里的 "·出版" 后缀去掉 — chips 空间寸土寸金, "飙升·出版" 挤且没信息量
 */
export function parseCategoryTree(raw: unknown): StoreCategoryTree {
  const tree: StoreCategoryTree = { ranks: [], categories: [] };
  if (!raw || typeof raw !== 'object') return tree;
  const sections = (raw as Record<string, unknown>).data;
  if (!Array.isArray(sections)) return tree;

  const toNode = (c: Record<string, unknown>): StoreCategoryNode | null => {
    const id =
      typeof c.CategoryId === 'string'
        ? c.CategoryId
        : typeof c.CategoryId === 'number'
        ? String(c.CategoryId)
        : '';
    const title = typeof c.title === 'string' ? c.title.replace(/·出版$/, '').trim() : '';
    if (!id || !title) return null;
    return {
      id,
      title,
      totalCount: typeof c.totalCount === 'number' ? c.totalCount : undefined,
    };
  };

  // 音频类目 (讲书榜 / 有声小说榜) — 阅读器打不开, 页面也返回 0 本
  const AUDIO_CATEGORY_IDS = new Set(['6100', '6200']);

  for (const section of sections) {
    if (!section || typeof section !== 'object') continue;
    const cats = (section as Record<string, unknown>).categories;
    if (!Array.isArray(cats)) continue;

    for (const item of cats) {
      if (!item || typeof item !== 'object') continue;
      const c = item as Record<string, unknown>;
      const node = toNode(c);
      if (!node || AUDIO_CATEGORY_IDS.has(node.id)) continue;

      if (c.ranklist === 1 || c.ranklist === true) {
        tree.ranks.push(node);
        continue;
      }

      const sublist = Array.isArray(c.sublist) ? c.sublist : [];
      const children: StoreCategoryNode[] = [];
      for (const s of sublist) {
        if (!s || typeof s !== 'object') continue;
        const child = toNode(s as Record<string, unknown>);
        if (child) children.push(child);
      }
      if (children.length > 0) node.children = children;
      tree.categories.push(node);
    }
  }
  return tree;
}

/**
 * 从 SSR HTML 里抠出 `window.__INITIAL_STATE__` 对应的 JSON。
 *
 * 不能简单地 `slice(start, indexOf('</script>'))` 再 JSON.parse —— 赋值语句后面还跟着
 * 其它初始化代码 (`;(function(){…})()`), JSON.parse 会因 "Extra data" 直接失败。
 * 这里用括号配平扫描, 并正确跳过字符串字面量与转义, 精准截出对象的结束位置。
 *
 * 解析失败一律返回 null, 由调用方决定兜底 (书城模块的策略是显示"榜单加载失败 + 重试")。
 */
export function extractInitialState(html: string): Record<string, unknown> | null {
  if (typeof html !== 'string' || !html) return null;
  const marker = 'window.__INITIAL_STATE__=';
  const at = html.indexOf(marker);
  if (at < 0) return null;

  const start = html.indexOf('{', at + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 把接口给的 bookInfo 归一化成 StoreBook。
 *
 * `extra` 用来补那些挂在 bookInfo **外层** 的字段:
 *   - 搜索:   { searchIdx, readingCount }
 *   - 榜单:   { searchIdx, readingCount, isBookInMyShelf }
 */
export function normalizeStoreBook(
  raw: unknown,
  extra?: { rank?: number; readingCount?: number; inShelf?: boolean },
): StoreBook | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const bookId = typeof b.bookId === 'string' ? b.bookId : String(b.bookId ?? '');
  if (!bookId) return null;

  const num = (k: string): number | undefined =>
    typeof b[k] === 'number' ? (b[k] as number) : undefined;
  const str = (k: string): string | undefined =>
    typeof b[k] === 'string' && b[k] ? (b[k] as string) : undefined;

  const ratingDetail = b.newRatingDetail as { title?: string } | undefined;

  return {
    bookId,
    title: str('title') ?? '(未命名)',
    author: str('author'),
    translator: str('translator'),
    cover: str('cover'),
    // 简介里有大量连续换行/空格, 卡片是两行截断展示, 这里先压平
    intro: str('intro')?.replace(/\s+/g, ' ').trim(),
    publisher: str('publisher'),
    price: num('price'),
    format: str('format'),
    // 接口用 0/1 表示 finished
    finished: b.finished === 1 || b.finished === true,
    newRating: num('newRating'),
    newRatingCount: num('newRatingCount'),
    newRatingTitle:
      ratingDetail && typeof ratingDetail.title === 'string' ? ratingDetail.title : undefined,
    readingCount: extra?.readingCount,
    rank: extra?.rank,
    inShelf: extra?.inShelf,
  };
}

/**
 * 解析榜单/分类页 HTML → 书列表。
 *
 * 数据路径: __INITIAL_STATE__.categoryStoreModule.categoryBookList[]
 *   每项: { searchIdx, readingCount, isBookInMyShelf, bookInfo: {...} }
 */
export function parseCategoryBooks(html: string): StoreBook[] {
  const state = extractInitialState(html);
  if (!state) return [];
  const mod = state.categoryStoreModule as Record<string, unknown> | undefined;
  const list = mod?.categoryBookList;
  if (!Array.isArray(list)) return [];

  const books: StoreBook[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const book = normalizeStoreBook(it.bookInfo, {
      rank: typeof it.searchIdx === 'number' ? it.searchIdx : undefined,
      readingCount: typeof it.readingCount === 'number' ? it.readingCount : undefined,
      inShelf: it.isBookInMyShelf === 1 || it.isBookInMyShelf === true,
    });
    if (book) books.push(book);
  }
  return books;
}

/** 把 8.79 分制的 newRating(0-1000) 转成 "8.8" 这样的展示文案; 无分返回 null */
export function formatRating(newRating?: number): string | null {
  if (typeof newRating !== 'number' || newRating <= 0) return null;
  return (newRating / 100).toFixed(1);
}

/** 12345 → "1.2万", 987 → "987" — 在读人数/评分人数用 */
export function formatCount(n?: number): string | null {
  if (typeof n !== 'number' || n <= 0) return null;
  if (n < 10_000) return String(n);
  return `${(n / 10_000).toFixed(1)}万`;
}
