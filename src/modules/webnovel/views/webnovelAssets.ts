/**
 * Codex (网页小说阅读器) 视图专属的样式与前端脚本。
 *
 * 公共部分 (tabbar / 阅读区 / 目录抽屉 / Aa 设置 / 阅读快捷键 / 滚动记忆) 直接复用 Saga 的
 * getQidianCss() / getQidianScript(), 这里只补 Codex 独有的: 链接输入卡片、最近阅读列表、整页目录。
 *
 * 注意: 脚本会被拼进 TS 模板字符串, 里面不要出现反引号和 "${"。
 */
export function getWebNovelCss(): string {
  return /* css */ `
.wn-home { padding: 8px 8px 16px; }
.wn-open-card {
  padding: 10px 10px 6px; margin-bottom: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 8px;
  background: var(--vscode-editor-background, transparent);
}
.wn-open-title { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.wn-open-card .store-search { position: static; padding: 0 0 6px; background: transparent; }
.wn-tip { font-size: 11px; line-height: 1.55; margin: 2px 0 4px; }
.wn-tip code { font-family: var(--vscode-editor-font-family, monospace); background: rgba(127,127,127,.18); padding: 0 4px; border-radius: 3px; font-size: 10.5px; }
.wn-section-title { display: flex; align-items: center; gap: 6px; padding: 4px 4px 6px; font-size: 12px; font-weight: 600; }
.wn-section-title .count {
  font-size: 10.5px; font-weight: 400; padding: 0 6px; border-radius: 8px;
  background: rgba(127,127,127,.18); color: var(--vscode-descriptionForeground);
}
.wn-record {
  display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid transparent; transition: all .12s ease;
}
.wn-record:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-contrastBorder, transparent); }
.wn-record.active { border-color: var(--vscode-focusBorder, var(--vscode-panel-border)); }
.wn-record .cover-wrap { background: linear-gradient(135deg, #5b8def, #3a5bbf); }
.wn-record-del {
  flex-shrink: 0; width: 22px; height: 22px; padding: 0; border: none; border-radius: 4px; background: transparent;
  color: var(--vscode-descriptionForeground); opacity: 0; transition: opacity .12s ease;
}
.wn-record:hover .wn-record-del { opacity: .8; }
.wn-record-del:hover { opacity: 1 !important; background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.2)); }

/* 整页目录 */
.wn-catalog { padding: 0 0 16px; }
.wn-cat-head {
  position: sticky; top: 0; z-index: 5; padding: 10px 12px 8px;
  background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border);
}
.wn-cat-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wn-cat-meta { font-size: 11px; margin: 2px 0 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wn-cat-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.wn-cat-actions button { padding: 3px 10px; font-size: 11px; }
.wn-cat-list { overflow: visible; padding-top: 4px; }
.wn-cat-list .toc-item[hidden] { display: none !important; }

/* 离线缓存 */
.toc-badge.cached { background: rgba(60,180,120,.18); color: rgb(60,170,110); }
#wn-cache-btn .ft-label { font-variant-numeric: tabular-nums; }
#wn-cache-btn.running .ft-icon { animation: wn-pulse 1.2s ease-in-out infinite; }
@keyframes wn-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }

/* 章末导航 */
.wn-end-nav {
  display: flex; justify-content: center; gap: 8px; margin-top: 26px; padding-top: 14px;
  border-top: 1px dashed var(--vscode-panel-border); font-family: -apple-system, "PingFang SC", sans-serif;
}
.reading .ch-info .wn-site { opacity: .75; }
`;
}

export function getWebNovelScript(): string {
  return /* js */ `
(function () {
  // 与 Saga 脚本共用同一个 vscode api 实例 (见 qidianScript 顶部)
  const vscode = window.__qdVscode || (window.__qdVscode = acquireVsCodeApi());
  function post(type, payload) { vscode.postMessage({ type: type, payload: payload }); }

  // ===== 链接输入 =====
  (function setupUrlInput() {
    const input = document.getElementById('wn-url-input');
    const go = document.getElementById('wn-url-go');
    if (!input) return;
    function submit() {
      const v = (input.value || '').trim();
      if (!v) { input.focus(); return; }
      post('openUrl', { url: v });
    }
    input.addEventListener('keydown', function (e) {
      if (e.isComposing) return;
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    // 记住草稿: 切 tab 整页重建后输入框内容不丢
    input.addEventListener('input', function () {
      const s = vscode.getState() || {};
      s.urlDraft = input.value;
      vscode.setState(s);
    });
    if (!input.value) {
      const s = vscode.getState() || {};
      if (s.urlDraft) input.value = s.urlDraft;
    }
    if (go) go.addEventListener('click', submit);
  })();

  // ===== 最近阅读 =====
  (function setupRecords() {
    const list = document.getElementById('wn-records');
    if (!list) return;
    list.addEventListener('click', function (e) {
      const t = e.target;
      if (!t || !t.closest) return;
      const del = t.closest('[data-wn-remove]');
      if (del) { e.preventDefault(); e.stopPropagation(); post('removeRecord', { key: del.getAttribute('data-wn-remove') }); return; }
      const card = t.closest('[data-wn-open]');
      if (card) post('openRecord', { key: card.getAttribute('data-wn-open') });
    });
  })();

  // ===== 整页目录 =====
  (function setupCatalogView() {
    const list = document.getElementById('wn-cat-list');
    if (!list) return;
    const search = document.getElementById('wn-cat-search');
    const empty = document.getElementById('wn-cat-empty');
    list.addEventListener('click', function (e) {
      const li = e.target && e.target.closest && e.target.closest('[data-cat-idx]');
      if (!li) return;
      const idx = Number(li.getAttribute('data-cat-idx'));
      if (Number.isInteger(idx)) post('selectChapter', { idx: idx });
    });
    if (search) {
      search.addEventListener('input', function () {
        const kw = (search.value || '').trim().toLowerCase();
        let hit = 0;
        list.querySelectorAll('[data-cat-idx]').forEach(function (li) {
          const ok = !kw || (li.getAttribute('data-toc-key') || '').indexOf(kw) >= 0;
          li.hidden = !ok;
          if (ok) hit++;
        });
        if (empty) empty.hidden = hit !== 0;
      });
    }
    // 贴目录页进来: 定位到当前章 (有的话)
    const main = document.querySelector('.wn-catalog');
    if (main && main.getAttribute('data-autoscroll') === '1') {
      const active = list.querySelector('.toc-item.active');
      if (active) requestAnimationFrame(function () { active.scrollIntoView({ block: 'center' }); });
    }
  })();

  // ===== 离线缓存进度 (extension postMessage, 局部更新, 不整页重建以免打断阅读) =====
  window.addEventListener('message', function (ev) {
    const m = ev.data || {};
    if (m.type !== 'wnCacheProgress') return;
    const btn = document.getElementById('wn-cache-btn');
    const label = document.getElementById('wn-cache-label');
    if (btn) {
      btn.classList.toggle('running', !!m.running);
      btn.title = m.running
        ? '正在缓存 ' + m.done + '/' + m.total + (m.failed ? '（失败 ' + m.failed + '）' : '') + '，点击可停止'
        : '离线缓存后续章节 / 全书（已缓存 ' + m.cachedCount + ' 章）';
    }
    if (label) label.textContent = m.running ? (m.done + '/' + m.total) : (m.cachedCount ? String(m.cachedCount) : '缓存');
    (m.idxs || []).forEach(function (i) {
      document.querySelectorAll('[data-toc-idx="' + i + '"] .toc-row, [data-cat-idx="' + i + '"] .toc-row').forEach(function (row) {
        if (row.querySelector('.toc-badge.cached')) return;
        const b = document.createElement('span');
        b.className = 'toc-badge cached';
        b.title = '已离线缓存';
        b.textContent = '已缓存';
        row.appendChild(b);
      });
    });
  });
})();
`;
}
