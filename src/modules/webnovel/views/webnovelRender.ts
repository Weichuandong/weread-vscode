import { escapeHtml } from '../../qidian/api/qidianParse';
import { buildSettingsPopoverHtml, skeletonHtml } from '../../qidian/views/qidianRender';
import { getQidianCss } from '../../qidian/views/qidianStyles';
import { getQidianScript } from '../../qidian/views/qidianScript';
import {
  FONT_FAMILY_STEPS,
  FONT_SIZE_STEPS,
  ReadingPrefs,
  renderReadingPrefsCssBlock,
} from '../../weread/views/readingPrefs';
import { getKeyboardScrollScript } from '../../../core/keyboardScroll';
import { WebBookRecord, WebChapterContent, WebChapterLink } from '../types';
import { hostOf } from '../api/htmlUtil';
import { CacheJobState } from '../services/CacheDownloader';
import { getWebNovelCss, getWebNovelScript } from './webnovelAssets';

export type WebNovelTab = 'home' | 'reader';

export interface WebNovelViewState {
  cspSource: string;
  tab: WebNovelTab;
  records: WebBookRecord[];
  /** 当前书 */
  bookKey?: string;
  bookTitle?: string;
  author?: string;
  catalogUrl?: string;
  chapters: WebChapterLink[];
  currentIdx: number;
  catalogLoading: boolean;
  catalogError: string | null;
  /** 整页目录模式 (用户贴的是目录页, 或在抽屉里点了"整页目录") */
  catalogView: boolean;
  catalogAutoScroll: boolean;
  content: WebChapterContent | null;
  chapterLoading: boolean;
  chapterError: string | null;
  /** 正在打开的 URL (加载 / 出错时展示) */
  pendingUrl?: string;
  hasPrev: boolean;
  hasNext: boolean;
  readingPrefs: ReadingPrefs;
  /** 与 chapters 一一对应: 该章是否已离线缓存 */
  cachedFlags: boolean[];
  /** 当前书已缓存章数 */
  cachedCount: number;
  /** 当前书正在进行的缓存任务 */
  cacheJob?: CacheJobState;
  /** 最近阅读里每本书已缓存的章数 */
  recordsCached: Record<string, number>;
}

const attr = escapeHtml;

/**
 * Codex 视图 HTML 渲染 (纯函数: 状态快照 → 整页 HTML)。
 *
 * 结构 / class 与 Saga 完全一致, 直接复用 Saga 的样式与前端脚本
 * (tabbar、阅读区、目录抽屉、Aa 排版设置、键盘翻页、滚动记忆),
 * 只额外拼上 Codex 独有的: 链接输入 + 最近阅读 + 整页目录。
 */
export function renderWebNovelHtml(st: WebNovelViewState): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data: ${st.cspSource}; style-src 'unsafe-inline' ${st.cspSource}; script-src 'unsafe-inline' ${st.cspSource};" />`;
  const content = st.tab === 'home' ? buildHomeHtml(st) : st.catalogView ? buildCatalogViewHtml(st) : buildReaderHtml(st);
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
${csp}
<style>${getQidianCss()}${getWebNovelCss()}</style>
${renderReadingPrefsCssBlock(st.readingPrefs)}
</head>
<body>
  ${buildTabBarHtml(st)}${content}
  <script>${getQidianScript()}</script>
  <script>${getWebNovelScript()}</script>
  <script>${getKeyboardScrollScript()}</script>
</body>
</html>`;
}

function buildTabBarHtml(st: WebNovelViewState): string {
  const hasBook = !!(st.content || st.catalogUrl || st.chapterLoading || st.chapterError);
  const label = st.bookTitle || st.content?.title || '在读';
  const actions: string[] = [];
  if (st.tab === 'reader' && hasBook) {
    actions.push(`<button class="icon-btn" data-act="retry" title="重新加载">⟳</button>`);
    actions.push(`<button class="icon-btn" data-act="openInBrowser" title="在浏览器打开当前页">↗</button>`);
  }
  return /* html */ `
    <nav class="tabbar ${st.tab === 'reader' && hasBook ? 'reader-active' : ''}">
      <div class="tabs">
        <button class="tab ${st.tab === 'home' ? 'active' : ''}" data-tab="home" title="打开链接 / 最近阅读">
          <span class="icon">🔗</span><span class="label">书签</span>
        </button>
        <button class="tab tab-reader ${st.tab === 'reader' ? 'active' : ''}" data-tab="reader" title="${attr(
          [st.bookTitle, st.author].filter(Boolean).join(' · ') || '正在阅读',
        )}" ${hasBook ? '' : 'disabled'}>
          <span class="icon">📖</span><span class="label">${escapeHtml(label)}</span>
        </button>
      </div>
      <div class="actions">${actions.join('')}</div>
    </nav>`;
}

// ---------------- 书签 (链接输入 + 最近阅读) ----------------

function buildHomeHtml(st: WebNovelViewState): string {
  const open = `
    <div class="wn-open-card">
      <div class="wn-open-title">打开网页小说</div>
      <div class="store-search">
        <span class="ss-icon" aria-hidden="true">🔗</span>
        <input id="wn-url-input" class="ss-input" type="text" spellcheck="false" autocomplete="off"
               placeholder="粘贴章节页或目录页链接，回车打开" />
        <button class="ss-btn" id="wn-url-go" title="打开">打开</button>
      </div>
      <p class="muted wn-tip">
        支持大多数「笔趣阁」类小说站：自动识别正文、合并分页（如 <code>xxx_2.html</code>）、过滤站点水印，并解析整本目录。
        贴<strong>章节页</strong>直接开读，贴<strong>目录页</strong>先看章节列表。
      </p>
    </div>`;

  const records = st.records.length
    ? st.records.map((r) => recordCardHtml(r, r.key === st.bookKey, st.recordsCached[r.key] ?? 0)).join('')
    : `<div class="empty"><p>还没有阅读记录</p><p class="muted">在上面粘贴一个小说章节链接试试。</p></div>`;

  return `<main class="content wn-home" data-scroll-key="home">${open}
    <div class="wn-section-title">最近阅读 <span class="count">${st.records.length}</span></div>
    <div id="wn-records">${records}</div>
  </main>`;
}

function recordCardHtml(r: WebBookRecord, active: boolean, cached: number): string {
  const meta = [r.author, r.site, cached ? `已缓存 ${cached} 章` : ''].filter(Boolean).join(' · ');
  return `
    <div class="wn-record ${active ? 'active' : ''}" data-wn-open="${attr(r.key)}" title="${attr(`${r.bookTitle}\n读至：${r.chapterTitle}\n${r.chapterUrl}`)}">
      <div class="cover-wrap no-cover"><div class="cover-fallback">${escapeHtml((r.bookTitle || '?').slice(0, 1))}</div></div>
      <div class="meta">
        <div class="title">${escapeHtml(r.bookTitle || '(未命名)')}</div>
        <div class="author">${escapeHtml(meta)}</div>
        <div class="sub">读至 ${escapeHtml(r.chapterTitle || '—')} · ${escapeHtml(timeAgo(r.updatedAt))}</div>
      </div>
      <button class="wn-record-del" data-wn-remove="${attr(r.key)}" title="从最近阅读中移除">✕</button>
    </div>`;
}

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

// ---------------- 整页目录 ----------------

const CACHED_BADGE = '<span class="toc-badge cached" title="已离线缓存">已缓存</span>';

function tocItemsHtml(chapters: WebChapterLink[], currentIdx: number, idxAttr: string, cached: boolean[]): string {
  return chapters
    .map(
      (c, i) => `
      <li class="toc-item ${i === currentIdx ? 'active' : ''}" ${idxAttr}="${i}" data-toc-key="${attr(c.title.toLowerCase())}">
        <span class="toc-row">
          <span class="toc-no">${i + 1}</span>
          <span class="toc-name" title="${attr(c.title)}">${escapeHtml(c.title)}</span>
          ${cached[i] ? CACHED_BADGE : ''}
        </span>
      </li>`,
    )
    .join('');
}

function buildCatalogViewHtml(st: WebNovelViewState): string {
  const meta = [st.author, st.chapters.length ? `${st.chapters.length} 章` : '', hostOf(st.catalogUrl)]
    .filter(Boolean)
    .join(' · ');
  const back = st.content
    ? `<button class="ghost" data-act="hideCatalogView">← 返回正文</button>`
    : '';
  const head = `
    <div class="wn-cat-head">
      <div class="wn-cat-title" title="${attr(st.bookTitle ?? '')}">${escapeHtml(st.bookTitle || '目录')}</div>
      <div class="wn-cat-meta muted">${escapeHtml(meta)}</div>
      <div class="wn-cat-actions">${back}<button class="ghost" data-act="openInBrowser">↗ 浏览器打开目录页</button></div>
      ${st.chapters.length ? `<input id="wn-cat-search" class="toc-search" type="text" placeholder="搜索章节…" autocomplete="off" spellcheck="false" />` : ''}
    </div>`;

  let body: string;
  if (st.catalogLoading) {
    body = `<div class="hint">${skeletonHtml(10)}</div>`;
  } else if (st.catalogError) {
    body = `<div class="error-card">
        <h4>目录加载失败</h4>
        <p>${escapeHtml(st.catalogError)}</p>
        <div class="row-actions">
          <button class="ghost" data-act="retryCatalog">重试</button>
          <button class="ghost" data-act="openInBrowser">在浏览器打开</button>
        </div>
      </div>`;
  } else {
    body = `<ul class="toc-list wn-cat-list" id="wn-cat-list">${tocItemsHtml(st.chapters, st.currentIdx, 'data-cat-idx', st.cachedFlags)}</ul>
      <div class="toc-empty" id="wn-cat-empty" hidden>无匹配章节</div>`;
  }
  return `<main class="content wn-catalog" data-scroll-key="${attr(`catalog:${st.catalogUrl ?? ''}`)}" data-autoscroll="${
    st.catalogAutoScroll ? '1' : '0'
  }">${head}${body}</main>`;
}

// ---------------- 阅读 ----------------

function buildReaderHtml(st: WebNovelViewState): string {
  const c = st.content;
  if (!c && !st.chapterLoading && !st.chapterError) {
    return `<main class="content reader"><div class="empty"><p>去<a href="#" data-tab="home">书签</a>粘贴一个小说链接开始阅读。</p></div></main>`;
  }
  const idx = st.currentIdx;
  const total = st.chapters.length;

  let article: string;
  if (st.chapterLoading) {
    article = `<article class="reading">${skeletonHtml(10)}</article>`;
  } else if (st.chapterError) {
    article = `
      <div class="reading unavailable">
        <h4>本章加载失败</h4>
        <p class="muted">${escapeHtml(st.chapterError)}</p>
        ${st.pendingUrl ? `<p class="muted" style="word-break:break-all">${escapeHtml(st.pendingUrl)}</p>` : ''}
        <div class="actions">
          <button class="primary" data-act="retry">重试</button>
          <button class="ghost" data-act="openInBrowser">在浏览器打开</button>
        </div>
      </div>`;
  } else if (c) {
    const info = [
      st.bookTitle || c.bookTitle,
      idx >= 0 && total ? `第 ${idx + 1}/${total} 章` : '',
      c.wordCount ? `${c.wordCount} 字` : '',
      c.pageCount > 1 ? `已合并 ${c.pageCount} 页` : '',
    ]
      .filter(Boolean)
      .map((x) => escapeHtml(String(x)))
      .join(' · ');
    const site = hostOf(c.url);
    const paras = c.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
    const endNav = `
      <div class="wn-end-nav">
        <button class="ghost" data-act="prev" ${st.hasPrev ? '' : 'disabled'}>◀ 上一章</button>
        <button class="primary" data-act="next" ${st.hasNext ? '' : 'disabled'}>${st.hasNext ? '下一章 ▶' : '已是最后一章'}</button>
      </div>`;
    article = `<article class="reading rich">
      <h2 class="ch-title">${escapeHtml(c.title)}</h2>
      <div class="ch-info">${info}${site ? ` · <span class="wn-site">${escapeHtml(site)}</span>` : ''}</div>
      <div class="rich-body">${paras}</div>
      ${endNav}
    </article>`;
  } else {
    article = `<article class="reading"><p class="hint">尚未加载</p></article>`;
  }

  let tocBtn = '';
  if (total) {
    tocBtn = `<button class="toc-trigger footer-mini" id="toc-trigger" title="${attr(
      idx >= 0 ? `第 ${idx + 1}/${total} 章 · 点击打开目录` : '打开目录',
    )}"><span class="ft-icon">📑</span><span class="ft-label">目录</span><span class="ft-badge">${
      idx >= 0 ? `${idx + 1}/${total}` : `${total} 章`
    }</span></button>`;
  } else if (st.catalogLoading) {
    tocBtn = `<button class="toc-trigger footer-mini" disabled title="正在解析目录…"><span class="ft-icon">📑</span><span class="ft-label">目录加载中…</span></button>`;
  } else if (st.catalogError) {
    tocBtn = `<button class="toc-trigger footer-mini" data-act="retryCatalog" title="${attr(
      '目录加载失败：' + st.catalogError + '（点击重试）',
    )}"><span class="ft-icon">⚠</span><span class="ft-label">目录重试</span></button>`;
  }
  const settingsBtn = `<button class="toc-trigger footer-mini" id="settings-trigger" title="阅读设置 (字号/行距/段距/页边/字体)"><span class="ft-icon">Aa</span></button>`;
  const job = st.cacheJob;
  const cacheBtn = c
    ? `<button class="toc-trigger footer-mini ${job ? 'running' : ''}" id="wn-cache-btn" data-act="cacheMenu" title="${attr(
        job
          ? `正在缓存 ${job.done}/${job.total}，点击可停止`
          : `离线缓存后续章节 / 全书（已缓存 ${st.cachedCount} 章）`,
      )}"><span class="ft-icon">⤓</span><span class="ft-label" id="wn-cache-label">${
        job ? `${job.done}/${job.total}` : st.cachedCount ? String(st.cachedCount) : '缓存'
      }</span></button>`
    : '';
  const footer = `
    <footer class="reader-footer">
      <button class="ghost" data-act="prev" ${st.hasPrev && !st.chapterLoading ? '' : 'disabled'}>◀ 上一章</button>
      <div class="footer-mid-group">${tocBtn}${settingsBtn}${cacheBtn}</div>
      <button class="ghost" data-act="next" ${st.hasNext && !st.chapterLoading ? '' : 'disabled'}>下一章 ▶</button>
    </footer>`;

  const prefsMeta = JSON.stringify({
    fontSizes: FONT_SIZE_STEPS,
    fontFamilies: FONT_FAMILY_STEPS.map((s) => ({ key: s.key, stack: s.stack })),
    current: st.readingPrefs,
  }).replace(/</g, '\\u003c');

  const scrollKey = `reader:${c?.url ?? st.pendingUrl ?? ''}:${st.chapterLoading ? 'loading' : 'ready'}`;
  return `<main class="content reader"><div class="reader-body" data-scroll-key="${attr(scrollKey)}">${article}</div>${footer}${
    total ? buildTocDrawerHtml(st) : ''
  }${buildSettingsPopoverHtml(st.readingPrefs)}<script id="qd-reading-prefs-meta" type="application/json">${prefsMeta}</script></main>`;
}

/** 目录抽屉: id / class 与 Saga 一致, 交互由 qidianScript setupToc 驱动 */
function buildTocDrawerHtml(st: WebNovelViewState): string {
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
      <ul class="toc-list" id="toc-list">${tocItemsHtml(st.chapters, st.currentIdx, 'data-toc-idx', st.cachedFlags)}</ul>
      <div class="toc-empty" id="toc-empty" hidden>无匹配章节</div>
    </aside>`;
}
