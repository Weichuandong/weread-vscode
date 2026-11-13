import { QidianBook, QidianChapter } from '../types';
import {
  RANK_CATEGORIES,
  RANK_DEFS,
  SEARCH_SORTS,
  escapeHtml,
  getRankDef,
} from '../api/qidianParse';
import {
  FONT_FAMILY_STEPS,
  FONT_SIZE_STEPS,
  LINE_HEIGHT_STEPS,
  PAGE_WIDTH_STEPS,
  PARAGRAPH_SPACING_STEPS,
  ReadingPrefs,
  renderReadingPrefsCssBlock,
} from '../../weread/views/readingPrefs';
import { getKeyboardScrollScript } from '../../../core/keyboardScroll';
import { QidianViewState, SHELF_GROUPS, SHELF_SORTS } from './viewState';
import { getQidianCss } from './qidianStyles';
import { getQidianScript } from './qidianScript';

/**
 * Saga 视图 HTML 渲染 (纯函数: 状态快照 → 整页 HTML)。
 *
 * 结构、class 命名与 Folio (微信读书) 视图保持一致, 视觉语言统一:
 *   tabbar → (书架 | 书城 | 在读) → 阅读页 footer / 目录抽屉 / Aa 设置 popover
 */
export function renderQidianHtml(st: QidianViewState): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: ${st.cspSource}; style-src 'unsafe-inline' ${st.cspSource}; script-src 'unsafe-inline' ${st.cspSource};" />`;
  const banner = st.showInvalidBanner ? buildInvalidBannerHtml() : '';
  const body = `${banner}${buildTabBarHtml(st)}${buildContentHtml(st)}`;
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
${csp}
<style>${getQidianCss()}</style>
${renderReadingPrefsCssBlock(st.readingPrefs)}
</head>
<body>
  ${body}
  <script>${getQidianScript()}</script>
  <script>${getKeyboardScrollScript()}</script>
</body>
</html>`;
}

const attr = escapeHtml;

/** 骨架屏 (Codex 网页小说阅读器也复用) */
export function skeletonHtml(lines = 4): string {
  let html = '';
  for (let i = 0; i < lines; i++) {
    const w = 60 + ((i * 37) % 35);
    html += `<div class="skeleton-line" style="width:${w}%"></div>`;
  }
  return `<div class="skeleton">${html}</div>`;
}

function buildInvalidBannerHtml(): string {
  return /* html */ `
    <div class="invalid-banner" role="alert">
      <span class="invalid-banner-icon" aria-hidden="true">⚠️</span>
      <span class="invalid-banner-text">起点 Cookie 已失效或被服务器拒绝，书架 / 进度同步可能失败</span>
      <button class="invalid-banner-btn" type="button" data-act="login">重新导入</button>
      <button class="invalid-banner-close" type="button" data-act="dismissInvalidBanner" title="关闭提示" aria-label="关闭提示">×</button>
    </div>`;
}

function buildLoginCardHtml(): string {
  return /* html */ `
    <div class="login-card">
      <div class="login-logo">📜</div>
      <h2>起点中文网</h2>
      <p class="muted">在浏览器登录 m.qidian.com 后，复制 Cookie 粘贴到这里即可查看你的书架。</p>
      <div class="login-actions">
        <button class="primary" data-act="login">导入 Cookie</button>
      </div>
      <p class="muted">不想登录？可以直接去 <a href="#" data-tab="store">书城</a> 搜书、逛榜单，免费章节无需登录也能读。</p>
      <details class="help">
        <summary>如何获取 Cookie?</summary>
        <ol>
          <li>浏览器登录 <code>m.qidian.com</code>（或 www.qidian.com）</li>
          <li>F12 → Network → 刷新页面 → 点任意 qidian.com 请求</li>
          <li>Request Headers → 复制完整 <code>Cookie</code> 字段（需含 <code>ywkey</code>）</li>
          <li>点上面的「导入 Cookie」，在弹出的输入框中粘贴</li>
        </ol>
      </details>
    </div>`;
}

function buildTabBarHtml(st: QidianViewState): string {
  const book = st.currentBook;
  const readerLabel = book?.title ? escapeHtml(book.title) : '在读';
  const readerTip = book ? `${book.title ?? ''}${book.author ? ' · ' + book.author : ''}` : '正在阅读';
  const actions: string[] = [];
  if (st.tab === 'shelf' && st.loggedIn) {
    actions.push(
      `<button class="icon-btn" data-act="expandAll" title="全部展开">▾</button>`,
      `<button class="icon-btn" data-act="collapseAll" title="全部折叠">▸</button>`,
      `<button class="icon-btn" data-act="refreshShelf" title="刷新书架">⟳</button>`,
    );
  }
  if (st.tab === 'store') actions.push(`<button class="icon-btn" data-act="storeRefresh" title="刷新书城">⟳</button>`);
  if (st.tab === 'reader' && book) {
    actions.push(`<button class="icon-btn" data-act="openInBrowser" title="在浏览器打开本章">↗</button>`);
  }
  return /* html */ `
    <nav class="tabbar ${st.tab === 'reader' && book ? 'reader-active' : ''}">
      <div class="tabs">
        <button class="tab ${st.tab === 'shelf' ? 'active' : ''}" data-tab="shelf" title="我的书架">
          <span class="icon">📚</span><span class="label">书架</span>
        </button>
        <button class="tab ${st.tab === 'store' ? 'active' : ''}" data-tab="store" title="书城 — 榜单 / 搜索">
          <span class="icon">🔍</span><span class="label">书城</span>
        </button>
        <button class="tab tab-reader ${st.tab === 'reader' ? 'active' : ''}" data-tab="reader" title="${attr(readerTip)}" ${book ? '' : 'disabled'}>
          <span class="icon">📖</span><span class="label">${readerLabel}</span>
        </button>
      </div>
      <div class="actions">${actions.join('')}</div>
    </nav>`;
}

function buildContentHtml(st: QidianViewState): string {
  // 书城与阅读 (免费章节) 不依赖登录; 只有书架需要
  if (st.tab === 'store') return buildStoreHtml(st);
  if (st.tab === 'reader') return buildReaderHtml(st);
  if (!st.loggedIn) return `<main class="content" data-scroll-key="login">${buildLoginCardHtml()}</main>`;
  return buildShelfHtml(st);
}

// ---------------- 书架 ----------------

function buildShelfHtml(st: QidianViewState): string {
  if (st.shelfLoading) {
    return `<main class="content shelf"><div class="hint">${skeletonHtml(6)}</div></main>`;
  }
  if (st.shelfError) {
    return `<main class="content shelf">
      <div class="error-card">
        <h4>书架加载失败</h4>
        <p>${escapeHtml(st.shelfError)}</p>
        <div class="row-actions">
          <button class="ghost" data-act="refreshShelf">重试</button>
          <button class="ghost" data-act="login">重新导入 Cookie</button>
        </div>
      </div>
    </main>`;
  }
  if (st.books.length === 0) {
    return `<main class="content shelf"><div class="empty"><p>书架为空</p><p class="muted">去 <a href="#" data-tab="store">书城</a> 找几本书加进来吧。</p></div></main>`;
  }

  const customGroups = st.groups.filter((g) => g.groupId !== '-100');
  const tip =
    st.shelfGroupBy === 'group' && customGroups.length === 0
      ? `<div class="shelf-tip">还没有自建分组。分组需要在起点 APP / 网页书架里创建，这里点 ⟳ 刷新即可同步。</div>`
      : '';

  // book-list 无论展开与否都渲染, 折叠靠 CSS — 前端搜索才能过滤到折叠分组里的书 (不触发 render, 不打断输入法)
  const sections = st.shelfGroups
    .map((g) => {
      const open = st.expandedGroups.has(g.name);
      return `<section class="shelf-section ${open ? 'open' : 'closed'}">
        <button class="shelf-section-title" data-toggle="${attr(g.name)}">
          <span class="arrow">${open ? '▾' : '▸'}</span>
          <span class="name">${escapeHtml(g.name)}</span>
          <span class="count" data-total="${g.books.length}">${g.books.length}</span>
        </button>
        <div class="book-list">${g.books.map(bookCardHtml).join('')}</div>
      </section>`;
    })
    .join('');

  const noResult = `<div class="empty" id="shelf-no-result" hidden>
    <p>没有匹配的书</p>
    <button class="ghost" id="shelf-no-result-clear">清除搜索</button>
  </div>`;

  return `<main class="content shelf" id="shelf-main" data-scroll-key="shelf">${buildShelfToolbarHtml(st)}${tip}${sections}${noResult}</main>`;
}

function buildShelfToolbarHtml(st: QidianViewState): string {
  const groupChips = SHELF_GROUPS.map(
    (g) =>
      `<button class="sort-chip ${st.shelfGroupBy === g.key ? 'active' : ''}" data-shelf-group="${g.key}" title="${attr(g.tip)}">${escapeHtml(g.label)}</button>`,
  ).join('');
  const sortChips = SHELF_SORTS.map(
    (s) =>
      `<button class="sort-chip ${st.shelfSortBy === s.key ? 'active' : ''}" data-shelf-sort="${s.key}" title="${attr(s.tip)}">${escapeHtml(s.label)}</button>`,
  ).join('');
  return `
    <div class="shelf-toolbar">
      <div class="store-search">
        <span class="ss-icon" aria-hidden="true">🔎</span>
        <input id="shelf-search-input" class="ss-input" type="text" spellcheck="false"
               placeholder="在书架里找书名 / 作者" value="${attr(st.shelfKeyword)}" />
        <button class="ss-btn" id="shelf-search-clear" title="清除搜索" ${st.shelfKeyword ? '' : 'hidden'}>✕</button>
      </div>
      <div class="shelf-view-row"><span class="svr-label">分组</span><span class="store-sort">${groupChips}</span></div>
      <div class="shelf-view-row"><span class="svr-label">排序</span><span class="store-sort">${sortChips}</span></div>
    </div>`;
}

/** 封面 (加载失败回退为书名首字); overlay 是叠在封面上的角标 (如榜单名次) */
function coverHtml(b: QidianBook, extraClass = '', overlay = ''): string {
  const cover = b.cover ? attr(b.cover) : '';
  const img = cover
    ? `<img class="cover" src="${cover}" alt="" loading="lazy" onerror="this.style.display='none';this.parentNode.classList.add('no-cover');" />`
    : '';
  return `<div class="cover-wrap ${extraClass} ${cover ? '' : 'no-cover'}">${img}<div class="cover-fallback">${escapeHtml(
    (b.title || '?').slice(0, 1),
  )}</div>${overlay}</div>`;
}

function bookCardHtml(b: QidianBook): string {
  const searchKey = `${b.title ?? ''} ${b.author ?? ''}`.toLowerCase();
  const progress = b.readChapterName
    ? `<div class="sub" title="${attr('读至 ' + b.readChapterName)}">读至 ${escapeHtml(b.readChapterName)}</div>`
    : `<div class="sub muted">${b.isRead ? '已开始阅读' : '未读'}</div>`;
  const latest = b.latestChapterName
    ? `<div class="sub latest ${b.hasUpdate ? 'has-update' : ''}" title="${attr('更新至 ' + b.latestChapterName)}">${
        b.hasUpdate ? '<span class="dot" aria-label="有更新"></span>' : ''
      }更新至 ${escapeHtml(b.latestChapterName)}</div>`
    : '';
  return `
    <button class="book-card ${b.accessDenied ? 'denied' : ''}" data-book-id="${attr(b.bookId)}" data-search-key="${attr(searchKey)}" title="${attr(b.title)}">
      ${coverHtml(b)}
      <div class="meta">
        <div class="title">${escapeHtml(b.title || '(未命名)')}</div>
        <div class="author">${escapeHtml(b.author ?? '')}${b.accessDenied ? ' · <span class="warn">不可读</span>' : ''}</div>
        ${progress}
        ${latest}
      </div>
    </button>`;
}

// ---------------- 书城 ----------------

function buildStoreHtml(st: QidianViewState): string {
  const search = buildStoreSearchHtml(st);
  const chips = st.storeMode === 'rank' ? buildRankChipsHtml(st) : '';
  const scrollKey =
    st.storeMode === 'search'
      ? `store:search:${st.storeKeyword}:${st.searchSortKey}`
      : `store:rank:${st.rankKey}:${st.rankCatId}`;
  const wrap = (inner: string) =>
    `<main class="content store" data-scroll-key="${attr(scrollKey)}">${search}${chips}${inner}</main>`;

  if (st.storeLoading) return wrap(`<div class="hint">${skeletonHtml(6)}</div>`);
  if (st.storeError) {
    return wrap(`<div class="error-card">
        <h4>${st.storeMode === 'search' ? '搜索失败' : '榜单加载失败'}</h4>
        <p>${escapeHtml(st.storeError)}</p>
        <button class="ghost" data-act="storeRefresh">重试</button>
      </div>`);
  }
  if (st.storeBooks.length === 0) {
    const tip =
      st.storeMode === 'search' ? `没有找到与「${escapeHtml(st.storeKeyword)}」相关的书` : '这个榜单暂时没有内容';
    return wrap(`<div class="empty"><p>${tip}</p></div>`);
  }

  const rankDef = getRankDef(st.rankKey);
  const catTitle = RANK_CATEGORIES.find((c) => c.id === st.rankCatId)?.title ?? '全站';
  const summary =
    st.storeMode === 'search'
      ? `找到 ${st.storeTotal || st.storeBooks.length} 本 · 已显示 ${st.storeBooks.length}`
      : `${rankDef.title} · ${catTitle} · 已显示 ${st.storeBooks.length}`;
  const sortChips =
    st.storeMode === 'search'
      ? `<span class="store-sort">${SEARCH_SORTS.map(
          (s) =>
            `<button class="sort-chip ${st.searchSortKey === s.key ? 'active' : ''}" data-store-sort="${s.key}" title="${attr(s.tip)}">${escapeHtml(s.label)}</button>`,
        ).join('')}</span>`
      : '';
  const more = st.storeHasMore
    ? `<div class="store-more"><button class="ghost" data-act="storeLoadMore" ${st.storeLoadingMore ? 'disabled' : ''}>${
        st.storeLoadingMore ? '加载中…' : '加载更多'
      }</button></div>`
    : `<div class="store-more muted">已经到底啦</div>`;

  return wrap(`
    <div class="store-summary"><span class="ssum-text">${escapeHtml(summary)}</span>${sortChips}</div>
    <div class="store-list">${st.storeBooks.map((b, i) => storeCardHtml(b, i, st.storeMode === 'rank')).join('')}</div>
    ${more}`);
}

function buildStoreSearchHtml(st: QidianViewState): string {
  const searching = st.storeMode === 'search' && !!st.storeKeyword;
  return `
    <div class="store-search">
      <span class="ss-icon" aria-hidden="true">🔍</span>
      <input id="store-search-input" class="ss-input" type="text" spellcheck="false"
             placeholder="搜索书名 / 作者，回车开搜" value="${attr(st.storeKeyword)}"
             data-autofocus="${st.storeFocusSearch ? '1' : '0'}" />
      ${
        searching
          ? `<button class="ss-btn" id="store-search-clear" title="清除搜索，回到榜单">✕</button>`
          : `<button class="ss-btn" id="store-search-go" title="搜索">搜索</button>`
      }
    </div>`;
}

/** 两行 chips: ① 榜单 ② 题材 (默认露 8 个 + 更多; 当前选中的被折叠时顶到可见位置) */
function buildRankChipsHtml(st: QidianViewState): string {
  const rankRow = `<div class="store-chips rank-row">${RANK_DEFS.map(
    (r) => `<button class="store-chip ${st.rankKey === r.key ? 'active' : ''}" data-store-rank="${r.key}">${escapeHtml(r.title)}</button>`,
  ).join('')}</div>`;

  const COLLAPSED = 8;
  let cats = RANK_CATEGORIES;
  let moreBtn = '';
  if (!st.storeCatsExpanded && cats.length > COLLAPSED) {
    cats = cats.slice(0, COLLAPSED);
    if (!cats.some((c) => c.id === st.rankCatId)) {
      const active = RANK_CATEGORIES.find((c) => c.id === st.rankCatId);
      if (active) cats = [...cats.slice(0, COLLAPSED - 1), active];
    }
    moreBtn = `<button class="store-chip more" data-act="storeToggleMoreCats">更多 ${RANK_CATEGORIES.length - cats.length} ▾</button>`;
  } else if (st.storeCatsExpanded) {
    moreBtn = `<button class="store-chip more" data-act="storeToggleMoreCats">收起 ▴</button>`;
  }
  const catRow = `<div class="store-chips cat-row">${cats
    .map(
      (c) =>
        `<button class="store-chip ${st.rankCatId === c.id ? 'active' : ''}" data-store-cat="${c.id}">${escapeHtml(c.title)}</button>`,
    )
    .join('')}${moreBtn}</div>`;
  return rankRow + catRow;
}

function storeCardHtml(b: QidianBook, idx: number, isRank: boolean): string {
  const rankNo = typeof b.rankNum === 'number' && b.rankNum > 0 ? b.rankNum : idx + 1;
  const rankBadge = isRank
    ? `<span class="sc-rank ${rankNo <= 3 ? 'top' : ''}" title="${attr(`榜单第 ${rankNo} 名`)}">${rankNo}</span>`
    : '';
  const badges: string[] = [];
  if (isRank && b.rankCnt) badges.push(`<span class="sc-badge hot">${escapeHtml(b.rankCnt)}</span>`);
  if (b.favoriteCnt) badges.push(`<span class="sc-badge" title="收藏数">${escapeHtml(b.favoriteCnt)}收藏</span>`);
  if (b.wordCount) badges.push(`<span class="sc-badge">${escapeHtml(b.wordCount)}</span>`);
  if (b.status) badges.push(`<span class="sc-badge ${b.status.includes('完') ? 'done' : ''}">${escapeHtml(b.status)}</span>`);
  if (b.isVip === false) badges.push(`<span class="sc-badge free">免费</span>`);

  const meta = [b.author, b.category && b.subCategory ? `${b.category}·${b.subCategory}` : b.category]
    .filter(Boolean)
    .join(' · ');
  const latest = b.latestChapterName
    ? `<div class="sc-latest" title="${attr(b.latestChapterName)}">最新：${escapeHtml(b.latestChapterName)}${
        b.lastUpdate ? ` <span class="muted">· ${escapeHtml(b.lastUpdate)}</span>` : ''
      }</div>`
    : '';
  const intro = b.intro ? `<div class="sc-intro" title="点击展开/收起简介">${escapeHtml(b.intro)}</div>` : '';
  const shelfBtn = b.inShelf
    ? `<button class="sc-act done" disabled>✓ 已在书架</button>`
    : `<button class="sc-act" data-store-add="${attr(b.bookId)}">+ 加入书架</button>`;

  return `
    <div class="store-card" data-store-card="${attr(b.bookId)}">
      ${coverHtml(b, 'sc-cover', rankBadge)}
      <div class="sc-main">
        <div class="sc-title">${escapeHtml(b.title)}</div>
        <div class="sc-author">${escapeHtml(meta)}</div>
        <div class="sc-badges">${badges.join('')}</div>
        ${latest}
        ${intro}
        <div class="sc-actions">
          <button class="sc-act primary" data-store-read="${attr(b.bookId)}">开始阅读</button>
          ${shelfBtn}
          <button class="sc-act icon" data-store-browser="${attr(b.bookId)}" title="在浏览器打开">↗</button>
        </div>
      </div>
    </div>`;
}

// ---------------- 阅读器 ----------------

function buildReaderHtml(st: QidianViewState): string {
  const book = st.currentBook;
  if (!book) {
    return `<main class="content reader"><div class="empty"><p>去<a href="#" data-tab="shelf">书架</a>或<a href="#" data-tab="store">书城</a>选一本书。</p></div></main>`;
  }
  const chapters = st.chapters;
  const idx = st.currentIdx;
  const ch: QidianChapter | undefined = idx >= 0 ? chapters[idx] : undefined;

  let article: string;
  if (st.catalogError) {
    article = unavailableHtml('目录加载失败', st.catalogError, '');
  } else if (st.chapterLoading) {
    article = `<article class="reading">${skeletonHtml(10)}</article>`;
  } else if (st.chapterError) {
    article = unavailableHtml('本章加载失败', st.chapterError, '');
  } else if (st.content) {
    const c = st.content;
    const title = `<h2 class="ch-title">${escapeHtml(c.title || ch?.title || '')}</h2>`;
    const info = [ch?.volumeName, c.wordCount ? `${c.wordCount} 字` : '', c.updateTime ?? '']
      .filter(Boolean)
      .map((x) => escapeHtml(String(x)))
      .join(' · ');
    const infoLine = info ? `<div class="ch-info">${info}${c.vip ? ' · <span class="vip-tag">VIP</span>' : ''}</div>` : '';
    const body = c.html ? `<div class="rich-body ${c.preview ? 'preview' : ''}">${c.html}</div>` : '';
    const say = c.authorSay && !c.preview && c.html
      ? `<aside class="author-say"><div class="as-label">作家的话</div><div class="as-text">${escapeHtml(c.authorSay)}</div></aside>`
      : '';
    const blocked = c.blockedReason ? blockedCardHtml(c.blockedReason, c.diagnostics, !!c.html) : '';
    article = `<article class="reading rich">${title}${infoLine}${body}${say}${blocked}</article>`;
  } else {
    article = `<article class="reading"><p class="hint">尚未加载</p></article>`;
  }

  const shelfAction =
    book.inShelf === false && !st.chapterLoading && !st.catalogError
      ? `<div class="reader-shelf-hint">《${escapeHtml(book.title)}》还不在你的书架里 <button class="ghost mini" data-act="addCurrentToShelf">+ 加入书架</button></div>`
      : '';

  const tocBtn = chapters.length
    ? `<button class="toc-trigger footer-mini" id="toc-trigger" title="${attr(
        ch ? `${ch.title} · 第 ${idx + 1}/${chapters.length} 章 · 点击打开目录` : '打开目录',
      )}"><span class="ft-icon">📑</span><span class="ft-label">目录</span><span class="ft-badge">${idx + 1}/${chapters.length}</span></button>`
    : '';
  const settingsBtn = `<button class="toc-trigger footer-mini" id="settings-trigger" title="阅读设置 (字号/行距/段距/页边/字体)"><span class="ft-icon">Aa</span></button>`;
  const footer = `
    <footer class="reader-footer">
      <button class="ghost" data-act="prev" ${idx <= 0 ? 'disabled' : ''}>◀ 上一章</button>
      <div class="footer-mid-group">${tocBtn}${settingsBtn}</div>
      <button class="ghost" data-act="next" ${idx < 0 || idx >= chapters.length - 1 ? 'disabled' : ''}>下一章 ▶</button>
    </footer>`;

  const prefsMeta = JSON.stringify({
    fontSizes: FONT_SIZE_STEPS,
    fontFamilies: FONT_FAMILY_STEPS.map((s) => ({ key: s.key, stack: s.stack })),
    current: st.readingPrefs,
  }).replace(/</g, '\\u003c');

  const scrollKey = `reader:${book.bookId}:${ch?.chapterId ?? ''}:${st.chapterLoading ? 'loading' : 'ready'}`;
  return `<main class="content reader">${shelfAction}<div class="reader-body" data-scroll-key="${attr(scrollKey)}">${article}</div>${footer}${
    chapters.length ? buildTocDrawerHtml(st) : ''
  }${buildSettingsPopoverHtml(st.readingPrefs)}<script id="qd-reading-prefs-meta" type="application/json">${prefsMeta}</script></main>`;
}

function unavailableHtml(title: string, detail: string, diag: string): string {
  return `
    <div class="reading unavailable">
      <h4>${escapeHtml(title)}</h4>
      <p class="muted">${escapeHtml(detail)}</p>
      <div class="actions">
        <button class="primary" data-act="retry">重试</button>
        <button class="ghost" data-act="openInBrowser">在浏览器打开</button>
      </div>
      ${diag ? `<details class="diag"><summary>诊断信息</summary><pre>${escapeHtml(diag)}</pre></details>` : ''}
    </div>`;
}

function blockedCardHtml(reason: string, diag: string, afterPreview: boolean): string {
  return `
    <div class="blocked-card ${afterPreview ? 'after-preview' : ''}">
      <div class="bc-icon">🔒</div>
      <p>${escapeHtml(reason)}</p>
      <div class="actions">
        <button class="primary" data-act="openInBrowser">在浏览器打开</button>
        <button class="ghost" data-act="next">跳过，下一章 ▶</button>
      </div>
      <details class="diag"><summary>诊断信息</summary><pre>${escapeHtml(diag)}</pre></details>
    </div>`;
}

/** 目录抽屉: 按卷分组 (卷标题不可点), 章节可搜索, VIP 章节打标 */
function buildTocDrawerHtml(st: QidianViewState): string {
  const items: string[] = [];
  let lastVol: string | null = null;
  st.chapters.forEach((c, i) => {
    if (c.volumeName !== lastVol) {
      lastVol = c.volumeName;
      const vol = st.volumes.find((v) => v.name === c.volumeName);
      items.push(
        `<li class="toc-vol">${escapeHtml(c.volumeName || '正文')}${vol?.vip ? '<span class="toc-badge paid">VIP卷</span>' : ''}<span class="toc-vol-count">${
          vol?.chapterCount ?? ''
        }</span></li>`,
      );
    }
    const active = i === st.currentIdx;
    items.push(`
      <li class="toc-item ${active ? 'active' : ''}" data-toc-idx="${i}" data-toc-key="${attr(c.title.toLowerCase())}">
        <span class="toc-row">
          <span class="toc-no">${i + 1}</span>
          <span class="toc-name" title="${attr(c.title)}">${escapeHtml(c.title)}</span>
          ${c.vip ? '<span class="toc-badge paid">VIP</span>' : ''}
        </span>
      </li>`);
  });
  return `
    <div class="toc-backdrop" id="toc-backdrop"></div>
    <aside class="toc-drawer" id="toc-drawer" aria-hidden="true">
      <header class="toc-head">
        <div class="toc-head-title">
          <span class="toc-head-name">目录</span>
          <span class="toc-head-count">${st.chapters.length} 章</span>
        </div>
        <button class="toc-close" id="toc-close" title="关闭">✕</button>
      </header>
      <div class="toc-search-wrap">
        <input id="toc-search" class="toc-search" type="text" placeholder="搜索章节…" autocomplete="off" spellcheck="false" />
      </div>
      <ul class="toc-list" id="toc-list">${items.join('')}</ul>
      <div class="toc-empty" id="toc-empty" hidden>无匹配章节</div>
    </aside>`;
}

/** Aa 阅读设置 popover (Codex 网页小说阅读器也复用, 前端行为见 qidianScript setupSettings) */
export function buildSettingsPopoverHtml(p: ReadingPrefs): string {
  const sizeIdx = FONT_SIZE_STEPS.indexOf(p.fontSize);
  const chips = (
    key: keyof ReadingPrefs,
    options: { label: string; value: string | number }[],
    current: string | number,
  ) =>
    options
      .map(
        (o) =>
          `<button class="sp-chip${o.value === current ? ' active' : ''}" data-pref-key="${key}" data-pref-value="${attr(
            String(o.value),
          )}">${escapeHtml(o.label)}</button>`,
      )
      .join('');
  return `<div class="settings-popover" id="settings-popover" hidden>
    <div class="sp-row">
      <span class="sp-label">字号</span>
      <div class="sp-chips" style="flex: 0 0 auto;">
        <div class="sp-stepper">
          <button id="sp-size-minus" ${sizeIdx <= 0 ? 'disabled' : ''} title="减小字号">−</button>
          <span class="sp-val" id="sp-size-val">${p.fontSize}</span>
          <button id="sp-size-plus" ${sizeIdx >= FONT_SIZE_STEPS.length - 1 ? 'disabled' : ''} title="增大字号">+</button>
        </div>
      </div>
    </div>
    <div class="sp-row"><span class="sp-label">行距</span><div class="sp-chips">${chips('lineHeight', LINE_HEIGHT_STEPS, p.lineHeight)}</div></div>
    <div class="sp-row"><span class="sp-label">段距</span><div class="sp-chips">${chips('paragraphSpacing', PARAGRAPH_SPACING_STEPS, p.paragraphSpacing)}</div></div>
    <div class="sp-row"><span class="sp-label">页边</span><div class="sp-chips">${chips('pageWidth', PAGE_WIDTH_STEPS, p.pageWidth)}</div></div>
    <div class="sp-row"><span class="sp-label">字体</span><div class="sp-chips">${chips(
      'fontFamily',
      FONT_FAMILY_STEPS.map((s) => ({ label: s.label, value: s.key })),
      p.fontFamily,
    )}</div></div>
    <div class="sp-footer"><button class="sp-reset" id="sp-reset" title="恢复默认排版">恢复默认</button></div>
  </div>`;
}
