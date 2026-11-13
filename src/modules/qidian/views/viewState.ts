import { QidianBook, QidianChapter, QidianChapterContent, QidianShelfGroup, QidianVolume } from '../types';
import { ReadingPrefs } from '../../weread/views/readingPrefs';

export type Tab = 'shelf' | 'store' | 'reader';
export type StoreMode = 'rank' | 'search';

/**
 * 书架分组方式。
 *   group  起点 APP / 网页里用户自建的书架分组 (只读, 分组管理请去起点里做)
 *   status 在读 / 未开始
 *   none   不分组
 */
export type ShelfGroupBy = 'group' | 'status' | 'none';

/**
 * 书架排序。
 *   default 接口原序 = 起点"按阅读时间"排序 (最近读的在前)
 *   update  有新章节的优先, 其余保持原序
 *   title   书名 (zh-CN 拼音序)
 */
export type ShelfSortBy = 'default' | 'update' | 'title';

export const SHELF_GROUPS: { key: ShelfGroupBy; label: string; tip: string }[] = [
  {
    key: 'group',
    label: '云端分组',
    tip: '按起点 APP / 网页里自建的书架分组分桶；分组本身请到起点里管理，这里刷新即可同步',
  },
  { key: 'status', label: '阅读状态', tip: '按 在读 / 未开始 分桶' },
  { key: 'none', label: '不分组', tip: '所有书平铺一个列表' },
];

export const SHELF_SORTS: { key: ShelfSortBy; label: string; tip: string }[] = [
  { key: 'default', label: '最近', tip: '起点云端顺序：最近阅读的在前' },
  { key: 'update', label: '有更新', tip: '有新章节的书排在前面' },
  { key: 'title', label: '书名', tip: '按书名拼音排序' },
];

export interface ShelfGroupView {
  name: string;
  books: QidianBook[];
}

/** 渲染层需要的只读状态快照 (由 QidianMainViewProvider 组装) */
export interface QidianViewState {
  cspSource: string;
  tab: Tab;
  loggedIn: boolean;
  showInvalidBanner: boolean;

  // 书架
  shelfLoading: boolean;
  shelfError: string | null;
  books: QidianBook[];
  groups: QidianShelfGroup[];
  shelfGroups: ShelfGroupView[];
  expandedGroups: Set<string>;
  shelfKeyword: string;
  shelfGroupBy: ShelfGroupBy;
  shelfSortBy: ShelfSortBy;

  // 书城
  storeMode: StoreMode;
  rankKey: string;
  rankCatId: number;
  storeKeyword: string;
  searchSortKey: string;
  storeBooks: QidianBook[];
  storeLoading: boolean;
  storeLoadingMore: boolean;
  storeError: string | null;
  storeHasMore: boolean;
  storeTotal: number;
  storeFocusSearch: boolean;
  storeCatsExpanded: boolean;

  // 阅读
  currentBook: QidianBook | undefined;
  chapters: QidianChapter[];
  volumes: QidianVolume[];
  currentIdx: number;
  content: QidianChapterContent | null;
  chapterLoading: boolean;
  chapterError: string | null;
  catalogError: string | null;
  readingPrefs: ReadingPrefs;
}
