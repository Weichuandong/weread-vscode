/**
 * Saga (起点) 视图样式。
 *
 * 视觉语言与 Folio (微信读书) 保持一致: 同一套 class 命名、色板全部取 VSCode 主题变量,
 * 阅读区尺寸 / 字体由 :root --rd-* CSS 变量驱动 (见 weread/views/readingPrefs.ts)。
 * 只保留起点用得到的部分, 并补充起点特有的: 卷标题、VIP 角标、作家的话、付费拦截卡。
 */
export function getQidianCss(): string {
  return /* css */ `
:root { color-scheme: light dark; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin:0; padding:0; height:100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  font-size: 13px; line-height: 1.55;
  display: flex; flex-direction: column; height: 100vh;
}
a { color: var(--vscode-textLink-foreground); text-decoration: none; }
a:hover { text-decoration: underline; }
button { font: inherit; cursor: pointer; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: rgba(127,127,127,.35); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(127,127,127,.55); }
.muted { color: var(--vscode-descriptionForeground); }
.hint { color: var(--vscode-descriptionForeground); padding: 8px 0; }
.empty { padding: 24px 14px; color: var(--vscode-descriptionForeground); text-align: center; }
.warn { color: var(--vscode-errorForeground); }

/* ====== TabBar ====== */
.tabbar {
  flex-shrink: 0; display: flex; align-items: center; justify-content: space-between;
  padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border);
  background: var(--vscode-sideBarSectionHeader-background, transparent);
}
.tabbar .tabs { display: flex; gap: 2px; min-width: 0; flex: 0 1 auto; }
.tabbar.reader-active .tabs { flex: 1 1 auto; }
.tabbar .tab {
  display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 12px;
  background: transparent; color: var(--vscode-foreground); border: none; border-radius: 4px;
  opacity: .65; transition: all .15s ease; min-width: 0;
}
.tabbar .tab .icon { font-size: 13px; flex-shrink: 0; }
.tabbar .tab .label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tabbar .tab:hover:not([disabled]) { opacity: .9; background: var(--vscode-list-hoverBackground); }
.tabbar .tab.active {
  opacity: 1; font-weight: 600;
  background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
}
.tabbar .tab[disabled] { opacity: .35; cursor: not-allowed; }
.tabbar.reader-active .tab-reader.active { flex: 1 1 auto; max-width: 260px; }
.tabbar .actions { display: flex; gap: 4px; flex-shrink: 0; }
.tabbar .icon-btn {
  width: 24px; height: 24px; padding: 0; background: transparent; color: var(--vscode-foreground);
  border: none; border-radius: 4px; font-size: 14px; opacity: .7;
}
.tabbar .icon-btn:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
.content { flex: 1; overflow-y: auto; overflow-x: hidden; }

/* ====== 书架 ====== */
.shelf { padding: 4px 6px 14px; }
.shelf-toolbar {
  position: sticky; top: 0; z-index: 5; padding: 2px 2px 6px; margin-bottom: 2px;
  background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border);
}
.shelf-toolbar .store-search { position: static; padding: 2px 0 6px; }
.shelf-view-row { display: flex; align-items: center; gap: 6px; padding: 1px 2px; }
.shelf-view-row .svr-label { flex-shrink: 0; width: 26px; font-size: 10.5px; color: var(--vscode-descriptionForeground); opacity: .85; }
.shelf-view-row .store-sort { flex-wrap: wrap; }
.shelf-tip {
  margin: 6px 4px 2px; padding: 5px 8px; border-left: 2px solid var(--vscode-panel-border);
  font-size: 11px; line-height: 1.5; color: var(--vscode-descriptionForeground);
  background: rgba(127,127,127,.07); border-radius: 0 4px 4px 0;
}
.shelf-section { margin-top: 2px; }
.shelf-section-title {
  display: flex; align-items: center; gap: 6px; width: 100%; margin: 0; padding: 5px 6px;
  background: transparent; color: var(--vscode-foreground); border: none; border-radius: 4px;
  text-align: left; font-size: 12px; font-weight: 600; letter-spacing: .02em;
}
.shelf-section-title:hover { background: var(--vscode-list-hoverBackground); }
.shelf-section-title .arrow { display: inline-block; width: 12px; font-size: 10px; opacity: .7; }
.shelf-section-title .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.shelf-section-title .count {
  font-size: 10.5px; font-weight: 400; padding: 0 6px; border-radius: 8px;
  background: rgba(127,127,127,.18); color: var(--vscode-descriptionForeground);
}
.book-list { display: flex; flex-direction: column; gap: 2px; padding: 2px 0 4px 14px; }
.shelf-section.closed .book-list { display: none; }
.shelf.searching .shelf-section.closed .book-list { display: flex; }
.shelf .book-card[hidden], .shelf .shelf-section[hidden], .shelf .shelf-tip[hidden] { display: none !important; }
.book-card {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 8px;
  background: transparent; color: inherit; border: 1px solid transparent; border-radius: 6px;
  text-align: left; transition: all .12s ease;
}
.book-card:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-contrastBorder, transparent); }
.book-card.denied { opacity: .55; }
.cover-wrap {
  position: relative; flex-shrink: 0; width: 38px; height: 52px; border-radius: 3px; overflow: hidden;
  background: linear-gradient(135deg, #e0864a, #c0392b); box-shadow: 0 1px 3px rgba(0,0,0,.15);
}
.cover-wrap .cover { width: 100%; height: 100%; object-fit: cover; display: block; }
.cover-wrap .cover-fallback {
  position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
  color: rgba(255,255,255,.92); font-weight: 600; font-size: 18px;
}
.cover-wrap.no-cover .cover-fallback { display: flex; }
.meta { flex: 1; min-width: 0; }
.meta .title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta .author, .meta .sub {
  font-size: 11px; color: var(--vscode-descriptionForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px;
}
.meta .sub.latest { opacity: .85; }
.meta .sub.latest.has-update { color: var(--vscode-foreground); opacity: 1; }
.meta .dot {
  display: inline-block; width: 6px; height: 6px; margin-right: 4px; border-radius: 50%;
  background: rgb(230, 80, 60); vertical-align: middle; position: relative; top: -1px;
}

/* ====== 书城 ====== */
.store { padding: 6px 8px 16px; }
.store-search {
  position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 6px;
  padding: 4px 2px 8px; background: var(--vscode-sideBar-background);
}
.store-search .ss-icon { font-size: 12px; opacity: .6; flex-shrink: 0; }
.store-search .ss-input {
  flex: 1; min-width: 0; padding: 5px 9px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px;
  font-size: 12px; font-family: inherit; outline: none;
}
.store-search .ss-input:focus { border-color: var(--vscode-focusBorder); }
.store-search .ss-btn {
  flex-shrink: 0; padding: 5px 10px;
  background: var(--vscode-button-secondaryBackground, transparent);
  color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-panel-border); border-radius: 4px; font-size: 11.5px;
}
.store-search .ss-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
.store-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 0 2px 5px; }
.store-chips.cat-row { padding-top: 4px; border-top: 1px dashed var(--vscode-panel-border); }
.store-chip {
  padding: 2px 9px; background: transparent; color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border); border-radius: 10px; font-size: 11px; opacity: .8;
  transition: all .12s ease;
}
.store-chip:hover:not(.active) { background: var(--vscode-list-hoverBackground); opacity: 1; }
.store-chip.active {
  opacity: 1; font-weight: 600;
  background: var(--vscode-list-activeSelectionBackground, var(--vscode-button-background));
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-button-foreground));
  border-color: var(--vscode-focusBorder, transparent);
}
.store-chip.more { border-color: transparent; color: var(--vscode-textLink-foreground); }
.store-summary {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: 2px 4px 6px; font-size: 10.5px; color: var(--vscode-descriptionForeground);
}
.store-sort { display: inline-flex; align-items: center; gap: 1px; flex-shrink: 0; flex-wrap: wrap; }
.sort-chip {
  padding: 1px 7px; background: transparent; color: var(--vscode-descriptionForeground);
  border: 1px solid transparent; border-radius: 9px; font-size: 10.5px; transition: all .12s ease;
}
.sort-chip:hover:not(.active) { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
.sort-chip.active {
  background: var(--vscode-list-activeSelectionBackground, var(--vscode-button-background));
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-button-foreground)); font-weight: 600;
}
.store-list { display: flex; flex-direction: column; gap: 6px; }
.store-card {
  display: flex; gap: 10px; padding: 8px 9px; border: 1px solid var(--vscode-panel-border); border-radius: 6px;
  background: var(--vscode-editor-background, transparent); transition: border-color .12s ease;
}
.store-card:hover { border-color: var(--vscode-focusBorder, var(--vscode-panel-border)); }
.store-card .sc-cover { width: 46px; height: 64px; }
.store-card .sc-rank {
  position: absolute; left: 0; top: 0; min-width: 16px; height: 15px; padding: 0 3px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 9.5px; font-weight: 600; font-variant-numeric: tabular-nums;
  background: rgba(0,0,0,.55); color: #fff; border-radius: 3px 0 4px 0;
}
.store-card .sc-rank.top { background: rgba(220, 150, 40, .95); }
.store-card .sc-main { flex: 1; min-width: 0; }
.store-card .sc-title { font-size: 13px; font-weight: 600; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.store-card .sc-author { margin-top: 1px; font-size: 11px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.store-card .sc-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.store-card .sc-badge {
  font-size: 10px; padding: 0 6px; border-radius: 8px; background: rgba(127,127,127,.18);
  color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums;
}
.store-card .sc-badge.hot { background: rgba(230, 90, 60, .18); color: rgb(225, 95, 65); font-weight: 600; }
.store-card .sc-badge.done { background: rgba(60,180,120,.18); color: rgb(60,170,110); }
.store-card .sc-badge.free { background: rgba(60,140,230,.18); color: rgb(70,140,220); }
.store-card .sc-latest {
  margin-top: 4px; font-size: 11px; color: var(--vscode-descriptionForeground);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.store-card .sc-intro {
  margin-top: 5px; font-size: 11.5px; line-height: 1.5; color: var(--vscode-descriptionForeground); cursor: pointer;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word;
}
.store-card .sc-intro.expanded { -webkit-line-clamp: unset; display: block; }
.store-card .sc-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
.store-card .sc-act {
  padding: 3px 10px; font-size: 11px; border-radius: 4px; background: transparent;
  color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border);
}
.store-card .sc-act:hover:not([disabled]) { background: var(--vscode-list-hoverBackground); }
.store-card .sc-act.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
.store-card .sc-act.primary:hover { background: var(--vscode-button-hoverBackground); }
.store-card .sc-act.done { color: rgb(60,180,120); border-color: rgba(60,180,120,.4); opacity: .9; }
.store-card .sc-act.icon { padding: 3px 8px; }
.store-more { display: flex; justify-content: center; padding: 10px 0 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }

/* ====== 阅读器 ====== */
.reader { display: flex; flex-direction: column; padding: 0; height: 100%; }
.reader-shelf-hint {
  flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 4px 10px; font-size: 11px; color: var(--vscode-descriptionForeground);
  border-bottom: 1px solid var(--vscode-panel-border);
}
button.ghost.mini { padding: 1px 8px; font-size: 11px; }
.reader-body {
  flex: 1; overflow-y: auto; padding: 10px 10px 18px; outline: none;
  background: var(--vscode-editor-background, var(--vscode-sideBar-background));
}
.reading {
  max-width: var(--rd-page-width, 720px); margin: 6px auto 14px; padding: 18px 24px 28px;
  background: var(--vscode-editor-background); color: var(--vscode-editor-foreground, var(--vscode-foreground));
  border-radius: 6px; border: 1px solid var(--vscode-panel-border, transparent);
  font-family: var(--rd-font-family, "Songti SC", "STSong", serif);
  font-size: var(--rd-font-size, 15px); line-height: var(--rd-line-height, 1.85);
}
.reading .ch-title {
  margin: 0 0 6px; font-size: 18px; font-weight: 600; text-align: center; letter-spacing: .04em;
  font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; color: var(--vscode-foreground);
}
.reading .ch-info {
  text-align: center; font-size: 11px; color: var(--vscode-descriptionForeground);
  font-family: -apple-system, "PingFang SC", sans-serif;
  padding-bottom: 14px; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border);
}
.vip-tag { padding: 0 5px; border-radius: 6px; background: rgba(220,165,60,.25); color: rgb(210,140,30); font-weight: 600; }
.reading .rich-body p { margin: 0 0 var(--rd-paragraph-spacing, 0.95em); text-indent: 2em; text-align: justify; }
.reading .rich-body.preview { position: relative; }
.reading .rich-body.preview::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 4em;
  background: linear-gradient(to bottom, transparent, var(--vscode-editor-background));
  pointer-events: none;
}
.author-say {
  margin-top: 22px; padding: 10px 12px; border-left: 3px solid rgba(220,150,40,.6);
  background: rgba(127,127,127,.08); border-radius: 0 4px 4px 0;
  font-size: .88em; line-height: 1.7; font-family: -apple-system, "PingFang SC", sans-serif;
}
.author-say .as-label { font-size: 11px; font-weight: 600; color: rgb(210,140,30); margin-bottom: 4px; }
.author-say .as-text { white-space: pre-wrap; color: var(--vscode-descriptionForeground); }
.blocked-card {
  margin-top: 10px; padding: 18px 16px; text-align: center;
  border: 1px dashed rgba(127,127,127,.4); border-radius: 8px;
  font-family: -apple-system, "PingFang SC", sans-serif; font-size: 12.5px; line-height: 1.65;
}
.blocked-card.after-preview { margin-top: 18px; }
.blocked-card .bc-icon { font-size: 26px; opacity: .8; }
.blocked-card p { margin: 6px 0 12px; text-indent: 0; }
.blocked-card .actions, .reading.unavailable .actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
.blocked-card details.diag, .reading.unavailable details.diag { margin-top: 12px; text-align: left; }
details.diag summary { cursor: pointer; font-size: 11px; color: var(--vscode-textLink-foreground); }
details.diag pre {
  background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.08)); padding: 8px; border-radius: 4px;
  font-size: 11px; max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-all;
}
.reading.unavailable { font-family: inherit; font-size: 13px; line-height: 1.6; }
.reading.unavailable h4 { margin: 0 0 8px; font-size: 13px; }
.reading.unavailable .actions { justify-content: flex-start; margin: 10px 0 0; }
.reader-footer {
  flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px;
  border-top: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBarSectionHeader-background, transparent);
}
.footer-mid-group { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 4px; overflow: hidden; }
.toc-trigger.footer-mini {
  display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; background: transparent;
  border: 1px solid transparent; border-radius: 4px; color: var(--vscode-foreground); font-size: 11.5px; min-width: 0;
}
.toc-trigger.footer-mini:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-panel-border); }
.toc-trigger.footer-mini .ft-icon { font-size: 12px; opacity: .8; }
.toc-trigger.footer-mini .ft-badge {
  font-size: 10px; font-variant-numeric: tabular-nums; padding: 0 5px; border-radius: 7px;
  background: rgba(127,127,127,.2); color: var(--vscode-descriptionForeground);
}

/* ---- 目录抽屉 ---- */
.toc-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.42); backdrop-filter: blur(2px);
  opacity: 0; pointer-events: none; transition: opacity .22s ease; z-index: 90;
}
.toc-backdrop.open { opacity: 1; pointer-events: auto; }
.toc-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(86vw, 320px);
  background: var(--vscode-sideBar-background); border-left: 1px solid var(--vscode-panel-border);
  box-shadow: -6px 0 28px rgba(0,0,0,.32); transform: translateX(100%);
  transition: transform .26s cubic-bezier(.4,0,.2,1); display: flex; flex-direction: column; z-index: 100;
}
.toc-drawer.open { transform: translateX(0); }
.toc-head { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
.toc-head-title { display: flex; align-items: baseline; gap: 8px; }
.toc-head-name { font-size: 14px; font-weight: 600; letter-spacing: .04em; }
.toc-head-count { font-size: 10.5px; padding: 1px 7px; border-radius: 8px; background: rgba(127,127,127,.18); color: var(--vscode-descriptionForeground); }
.toc-close {
  width: 26px; height: 26px; background: transparent; border: none; border-radius: 4px;
  color: var(--vscode-foreground); opacity: .65; font-size: 14px;
}
.toc-close:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
.toc-search-wrap { flex-shrink: 0; padding: 8px 12px 6px; }
.toc-search {
  width: 100%; padding: 5px 9px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; font-size: 12px; outline: none;
}
.toc-search:focus { border-color: var(--vscode-focusBorder); }
.toc-list { flex: 1; overflow-y: auto; list-style: none; margin: 0; padding: 4px 0 12px; }
.toc-vol {
  position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 6px;
  padding: 6px 12px; font-size: 11.5px; font-weight: 600; color: var(--vscode-descriptionForeground);
  background: var(--vscode-sideBar-background); border-bottom: 1px solid rgba(127,127,127,.15);
}
.toc-vol .toc-vol-count { margin-left: auto; font-weight: 400; font-size: 10.5px; opacity: .8; }
.toc-vol[hidden], .toc-item[hidden] { display: none !important; }
.toc-item { display: block; position: relative; cursor: pointer; }
.toc-item .toc-row { display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 10px; min-height: 28px; font-size: 12.5px; line-height: 1.4; }
.toc-item .toc-no { font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); opacity: .65; flex-shrink: 0; min-width: 26px; text-align: right; }
.toc-item .toc-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.toc-badge { flex-shrink: 0; font-size: 9.5px; padding: 0 5px; border-radius: 6px; background: rgba(220,165,60,.25); color: rgb(210,140,30); font-weight: 400; }
.toc-item:hover { background: var(--vscode-list-hoverBackground); }
.toc-item.active {
  background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
}
.toc-item.active .toc-name { font-weight: 600; }
.toc-item.active::before {
  content: ''; position: absolute; left: 0; top: 4px; bottom: 4px; width: 3px; border-radius: 0 2px 2px 0;
  background: var(--vscode-focusBorder, rgb(60,160,230));
}
.toc-empty { padding: 18px 14px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 12px; }

/* ---- 阅读设置 popover (Aa) ---- */
.settings-popover {
  position: fixed; z-index: 120; width: min(320px, calc(100vw - 24px)); padding: 12px 14px 10px;
  background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
  border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
  border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.42); font-size: 12.5px;
}
.settings-popover[hidden] { display: none; }
.settings-popover .sp-row { display: flex; align-items: center; gap: 10px; margin: 0 0 9px; }
.settings-popover .sp-label { flex-shrink: 0; width: 38px; font-size: 11.5px; color: var(--vscode-descriptionForeground); }
.settings-popover .sp-chips { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
.settings-popover .sp-chip {
  min-width: 28px; height: 24px; padding: 0 9px; background: transparent; color: var(--vscode-foreground);
  border: 1px solid var(--vscode-panel-border); border-radius: 4px; font-size: 11.5px;
}
.settings-popover .sp-chip:hover:not(.active) { background: var(--vscode-list-hoverBackground); }
.settings-popover .sp-chip.active {
  background: var(--vscode-list-activeSelectionBackground, var(--vscode-button-background));
  color: var(--vscode-list-activeSelectionForeground, var(--vscode-button-foreground));
  border-color: var(--vscode-focusBorder, transparent); font-weight: 600;
}
.settings-popover .sp-stepper { display: inline-flex; align-items: center; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
.settings-popover .sp-stepper button { width: 26px; height: 24px; padding: 0; background: transparent; color: var(--vscode-foreground); border: none; font-size: 14px; }
.settings-popover .sp-stepper button:hover:not([disabled]) { background: var(--vscode-list-hoverBackground); }
.settings-popover .sp-stepper .sp-val {
  min-width: 38px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 11.5px; font-weight: 600; border-left: 1px solid var(--vscode-panel-border); border-right: 1px solid var(--vscode-panel-border);
}
.settings-popover .sp-footer { display: flex; justify-content: flex-end; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
.settings-popover .sp-reset { background: transparent; color: var(--vscode-descriptionForeground); border: none; padding: 3px 8px; font-size: 11px; border-radius: 4px; }
.settings-popover .sp-reset:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }

/* ====== 通用按钮 / 卡片 ====== */
button.primary, button.ghost { font-size: 12px; padding: 5px 12px; border-radius: 4px; }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid transparent; }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button.ghost { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
button.ghost:hover:not([disabled]) { background: var(--vscode-list-hoverBackground); }
button[disabled] { opacity: .4; cursor: not-allowed; }
.login-card {
  margin: 24px 16px; padding: 22px 18px; border: 1px solid var(--vscode-panel-border); border-radius: 8px;
  background: var(--vscode-editor-background, transparent); text-align: center;
}
.login-card .login-logo { font-size: 32px; margin-bottom: 6px; }
.login-card h2 { margin: 4px 0 8px; font-size: 16px; }
.login-card p.muted { font-size: 12px; margin: 0 0 14px; line-height: 1.5; }
.login-card .login-actions { display: flex; flex-direction: column; gap: 8px; align-items: center; margin: 4px 0 12px; }
.login-card details.help { margin-top: 12px; text-align: left; }
.login-card details.help summary { cursor: pointer; font-size: 11px; color: var(--vscode-textLink-foreground); }
.login-card details.help ol { font-size: 11.5px; line-height: 1.7; padding-left: 20px; margin-top: 6px; }
.login-card code { font-family: var(--vscode-editor-font-family, monospace); background: rgba(127,127,127,.18); padding: 0 4px; border-radius: 3px; font-size: 11px; }
.error-card {
  margin: 14px; padding: 12px 14px; border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
  border-radius: 6px; background: var(--vscode-inputValidation-errorBackground, transparent);
}
.error-card h4 { margin: 0 0 6px; font-size: 12px; color: var(--vscode-errorForeground); }
.error-card p { margin: 0 0 8px; font-size: 12px; }
.error-card .row-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.skeleton { padding: 14px; }
.skeleton-line {
  height: 12px; margin: 0 0 10px; border-radius: 3px; animation: shimmer 1.4s linear infinite;
  background: linear-gradient(90deg, rgba(127,127,127,.12) 25%, rgba(127,127,127,.22) 50%, rgba(127,127,127,.12) 75%);
  background-size: 200% 100%;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* ====== Cookie 失效横幅 ====== */
.invalid-banner {
  display: flex; align-items: center; gap: 6px; padding: 3px 6px 3px 8px; font-size: 11px; line-height: 1.3;
  background: var(--vscode-inputValidation-warningBackground, rgba(244,130,31,.12));
  color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
  border-bottom: 1px solid var(--vscode-inputValidation-warningBorder, rgba(244,130,31,.35));
}
.invalid-banner-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.invalid-banner-btn {
  flex: 0 0 auto; padding: 1px 6px; font-size: 11px; border-radius: 2px;
  background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
  border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
}
.invalid-banner-close {
  flex: 0 0 auto; width: 18px; height: 18px; padding: 0; background: transparent; color: inherit;
  border: none; border-radius: 3px; font-size: 14px; line-height: 1; opacity: .7;
}
.invalid-banner-close:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,.1)); }
`;
}
