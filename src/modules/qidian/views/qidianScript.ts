/**
 * Saga (起点) webview 前端脚本。
 *
 * 行为与 Folio (微信读书) 对齐, 关键约定:
 *   - 整页重建模式: extension 每次 render 覆盖 webview.html, 这里每次都重新绑定
 *   - 书架搜索纯前端过滤 + IME 保护 (compositionstart/end), 不回传 render, 不打断中文输入
 *   - 书城搜索回车提交 (e.isComposing 时放行, 中文候选框里的回车是选词)
 *   - 滚动位置: 容器上的 data-scroll-key 作 key 存进 vscode.setState, 重建后恢复
 *     → "加载更多"、加书架、切 tab 回来都不会跳回顶部; 切到新章节 key 变了自然从顶部开始
 *   - 阅读快捷键: ↑/↓ 小步、Space/PgDn 翻页、←/→ 切章、Home/End 章首尾
 *
 * 注意: 本文件内容会被拼进 TS 模板字符串, 脚本里不要出现反引号和 "${"。
 */
export function getQidianScript(): string {
  return /* js */ `
(function () {
  // acquireVsCodeApi 每个 webview 只能调一次; 挂到 window 上, 复用本脚本的模块 (Codex) 的附加脚本共用同一个实例
  const vscode = window.__qdVscode || (window.__qdVscode = acquireVsCodeApi());
  function post(type, payload) { vscode.postMessage({ type: type, payload: payload }); }

  // ===== 滚动位置保持 =====
  (function setupScrollMemory() {
    const el = document.querySelector('[data-scroll-key]');
    if (!el) return;
    const key = el.getAttribute('data-scroll-key') || '';
    const st = vscode.getState() || {};
    const saved = st.scroll && st.scroll[key];
    if (typeof saved === 'number' && saved > 0) {
      el.scrollTop = saved;
      // 封面图懒加载可能稍后撑高内容, 下一帧再校正一次
      requestAnimationFrame(function () { el.scrollTop = saved; });
    }
    let timer = null;
    el.addEventListener('scroll', function () {
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        const s = vscode.getState() || {};
        s.scroll = s.scroll || {};
        delete s.scroll[key];
        s.scroll[key] = el.scrollTop;
        const keys = Object.keys(s.scroll);
        while (keys.length > 40) { delete s.scroll[keys.shift()]; }
        vscode.setState(s);
      }, 150);
    }, { passive: true });
  })();

  // ===== tab / 通用动作 =====
  document.querySelectorAll('.tabbar .tab').forEach(function (el) {
    el.addEventListener('click', function () {
      const tab = el.getAttribute('data-tab');
      if (tab) post('switchTab', { tab: tab });
    });
  });
  document.querySelectorAll('[data-act]').forEach(function (el) {
    el.addEventListener('click', function (ev) {
      ev.preventDefault();
      const act = el.getAttribute('data-act');
      if (act) post(act);
    });
  });
  document.querySelectorAll('a[data-tab]').forEach(function (el) {
    el.addEventListener('click', function (ev) {
      ev.preventDefault();
      post('switchTab', { tab: el.getAttribute('data-tab') });
    });
  });

  // ===== 书架 =====
  document.querySelectorAll('.book-card[data-book-id]').forEach(function (el) {
    el.addEventListener('click', function () { post('openBook', { bookId: el.getAttribute('data-book-id') }); });
  });

  function shelfKeywordNow() {
    const el = document.getElementById('shelf-search-input');
    return el ? el.value : '';
  }
  document.querySelectorAll('.shelf-section-title[data-toggle]').forEach(function (el) {
    el.addEventListener('click', function () {
      post('toggleGroup', { name: el.getAttribute('data-toggle'), keyword: shelfKeywordNow() });
    });
  });

  (function setupShelfToolbar() {
    document.querySelectorAll('[data-shelf-group]').forEach(function (el) {
      el.addEventListener('click', function () {
        post('shelfGroupBy', { key: el.getAttribute('data-shelf-group'), keyword: shelfKeywordNow() });
      });
    });
    document.querySelectorAll('[data-shelf-sort]').forEach(function (el) {
      el.addEventListener('click', function () {
        post('shelfSortBy', { key: el.getAttribute('data-shelf-sort'), keyword: shelfKeywordNow() });
      });
    });

    const shelfMain = document.getElementById('shelf-main');
    const input = document.getElementById('shelf-search-input');
    if (!shelfMain || !input) return;
    const clearBtn = document.getElementById('shelf-search-clear');
    const noResult = document.getElementById('shelf-no-result');
    const noResultClear = document.getElementById('shelf-no-result-clear');
    const cards = Array.prototype.slice.call(shelfMain.querySelectorAll('.book-card[data-search-key]'));
    const sections = Array.prototype.slice.call(shelfMain.querySelectorAll('.shelf-section'));
    const tip = shelfMain.querySelector('.shelf-tip');

    function applyFilter(raw) {
      const kw = (raw || '').trim().toLowerCase();
      const searching = kw.length > 0;
      shelfMain.classList.toggle('searching', searching);
      if (tip) tip.hidden = searching;
      let total = 0;
      cards.forEach(function (card) {
        const ok = !searching || (card.getAttribute('data-search-key') || '').indexOf(kw) >= 0;
        card.hidden = !ok;
        if (ok) total++;
      });
      sections.forEach(function (sec) {
        const badge = sec.querySelector('.count');
        if (!searching) {
          sec.hidden = false;
          if (badge) badge.textContent = badge.getAttribute('data-total') || badge.textContent;
          return;
        }
        const hit = sec.querySelectorAll('.book-card[data-search-key]:not([hidden])').length;
        sec.hidden = hit === 0;
        if (badge) badge.textContent = String(hit);
      });
      if (noResult) noResult.hidden = !(searching && total === 0);
      if (clearBtn) clearBtn.hidden = !searching;
    }
    function clearSearch() {
      input.value = '';
      applyFilter('');
      post('shelfSearchState', { keyword: '' });
      input.focus();
    }
    let composing = false;
    let timer = null;
    function syncState() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { post('shelfSearchState', { keyword: input.value }); }, 400);
    }
    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () { composing = false; applyFilter(input.value); syncState(); });
    input.addEventListener('input', function () { if (composing) return; applyFilter(input.value); syncState(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); if (input.value) clearSearch(); }
    });
    if (clearBtn) clearBtn.addEventListener('click', clearSearch);
    if (noResultClear) noResultClear.addEventListener('click', clearSearch);
    if (input.value) applyFilter(input.value);
  })();

  // ===== 书城 =====
  (function setupStore() {
    const input = document.getElementById('store-search-input');
    if (input) {
      if (input.getAttribute('data-autofocus') === '1') {
        setTimeout(function () {
          try { input.focus(); const v = input.value; input.setSelectionRange(v.length, v.length); } catch (e) {}
        }, 30);
      }
      input.addEventListener('keydown', function (e) {
        if (e.isComposing) return;
        if (e.key === 'Enter') { e.preventDefault(); post('storeSearch', { keyword: input.value }); }
        else if (e.key === 'Escape') { e.preventDefault(); if (input.value) { input.value = ''; post('storeClearSearch'); } }
      });
    }
    const goBtn = document.getElementById('store-search-go');
    if (goBtn) goBtn.addEventListener('click', function () { post('storeSearch', { keyword: input ? input.value : '' }); });
    const clearBtn = document.getElementById('store-search-clear');
    if (clearBtn) clearBtn.addEventListener('click', function () { post('storeClearSearch'); });

    document.querySelectorAll('[data-store-rank]').forEach(function (el) {
      el.addEventListener('click', function () { post('storeSelectRank', { key: el.getAttribute('data-store-rank') }); });
    });
    document.querySelectorAll('[data-store-cat]').forEach(function (el) {
      el.addEventListener('click', function () { post('storeSelectCat', { id: Number(el.getAttribute('data-store-cat')) }); });
    });
    document.querySelectorAll('[data-store-sort]').forEach(function (el) {
      el.addEventListener('click', function () { post('storeSort', { key: el.getAttribute('data-store-sort') }); });
    });

    const list = document.querySelector('.store-list');
    if (!list) return;
    list.addEventListener('click', function (e) {
      const t = e.target;
      if (!t || !t.closest) return;
      const read = t.closest('[data-store-read]');
      if (read) { e.preventDefault(); post('storeOpenBook', { bookId: read.getAttribute('data-store-read') }); return; }
      const add = t.closest('[data-store-add]');
      if (add) {
        e.preventDefault();
        add.setAttribute('disabled', '');
        add.textContent = '加入中…';
        post('storeAddShelf', { bookId: add.getAttribute('data-store-add') });
        return;
      }
      const br = t.closest('[data-store-browser]');
      if (br) { e.preventDefault(); post('storeOpenInBrowser', { bookId: br.getAttribute('data-store-browser') }); return; }
      const intro = t.closest('.sc-intro');
      if (intro) intro.classList.toggle('expanded');
    });
  })();

  // ===== 目录抽屉 =====
  (function setupToc() {
    const trigger = document.getElementById('toc-trigger');
    const drawer = document.getElementById('toc-drawer');
    const backdrop = document.getElementById('toc-backdrop');
    const close = document.getElementById('toc-close');
    const list = document.getElementById('toc-list');
    const search = document.getElementById('toc-search');
    const empty = document.getElementById('toc-empty');
    if (!drawer || !list) return;

    function filterToc(q) {
      const kw = (q || '').trim().toLowerCase();
      let hit = 0;
      list.querySelectorAll('.toc-item').forEach(function (li) {
        const ok = !kw || (li.getAttribute('data-toc-key') || '').indexOf(kw) >= 0;
        li.hidden = !ok;
        if (ok) hit++;
      });
      // 搜索时隐藏卷标题, 结果平铺更紧凑
      list.querySelectorAll('.toc-vol').forEach(function (v) { v.hidden = !!kw; });
      if (empty) empty.hidden = hit !== 0;
    }
    function openDrawer() {
      const sp = document.getElementById('settings-popover');
      if (sp) sp.hidden = true;
      drawer.classList.add('open');
      if (backdrop) backdrop.classList.add('open');
      drawer.setAttribute('aria-hidden', 'false');
      const active = list.querySelector('.toc-item.active');
      if (active) requestAnimationFrame(function () { active.scrollIntoView({ block: 'center' }); });
      setTimeout(function () { if (search) search.focus(); }, 100);
    }
    function closeDrawer() {
      drawer.classList.remove('open');
      if (backdrop) backdrop.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
      if (search) { search.value = ''; filterToc(''); }
    }
    if (trigger) trigger.addEventListener('click', openDrawer);
    if (close) close.addEventListener('click', closeDrawer);
    if (backdrop) backdrop.addEventListener('click', closeDrawer);
    if (search) search.addEventListener('input', function (e) { filterToc(e.target.value); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
    });
    list.addEventListener('click', function (e) {
      const li = e.target && e.target.closest && e.target.closest('.toc-item');
      if (!li) return;
      const idx = Number(li.getAttribute('data-toc-idx'));
      if (Number.isInteger(idx)) { closeDrawer(); post('selectChapter', { idx: idx }); }
    });
  })();

  // ===== 阅读设置 popover (Aa) =====
  (function setupSettings() {
    const trigger = document.getElementById('settings-trigger');
    const popover = document.getElementById('settings-popover');
    if (!trigger || !popover) return;
    let meta = { fontSizes: [12, 13, 14, 15, 16, 18, 20, 22], fontFamilies: [], current: {} };
    try {
      const node = document.getElementById('qd-reading-prefs-meta');
      if (node && node.textContent) meta = JSON.parse(node.textContent) || meta;
    } catch (e) {}
    const familyMap = {};
    (meta.fontFamilies || []).forEach(function (f) { familyMap[f.key] = f.stack; });
    let curFontSize = Number(meta.current.fontSize) || 15;

    function position() {
      const rect = trigger.getBoundingClientRect();
      popover.hidden = false;
      popover.style.visibility = 'hidden';
      const pw = popover.offsetWidth, ph = popover.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      let top = rect.top - ph - 6;
      if (top < 8) top = Math.min(vh - ph - 8, rect.bottom + 6);
      let left = rect.left + rect.width / 2 - pw / 2;
      if (left + pw > vw - 8) left = Math.max(8, vw - pw - 8);
      if (left < 8) left = 8;
      popover.style.top = top + 'px';
      popover.style.left = left + 'px';
      popover.style.visibility = '';
    }
    function closePopover() { popover.hidden = true; }
    trigger.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (popover.hidden) position(); else closePopover();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !popover.hidden) closePopover(); });
    document.addEventListener('click', function (e) {
      if (popover.hidden || popover.contains(e.target) || trigger.contains(e.target)) return;
      closePopover();
    });
    window.addEventListener('resize', function () { if (!popover.hidden) position(); });

    function apply(key, value) {
      const root = document.documentElement;
      if (key === 'fontSize') root.style.setProperty('--rd-font-size', value + 'px');
      else if (key === 'lineHeight') root.style.setProperty('--rd-line-height', String(value));
      else if (key === 'paragraphSpacing') root.style.setProperty('--rd-paragraph-spacing', value + 'em');
      else if (key === 'pageWidth') root.style.setProperty('--rd-page-width', value === 'full' ? '100%' : value + 'px');
      else if (key === 'fontFamily') root.style.setProperty('--rd-font-family', familyMap[value] || 'serif');
    }

    popover.addEventListener('click', function (e) {
      const t = e.target;
      const chip = t && t.closest && t.closest('.sp-chip');
      if (chip) {
        e.preventDefault();
        const key = chip.getAttribute('data-pref-key');
        const raw = chip.getAttribute('data-pref-value');
        if (!key || raw == null) return;
        let value;
        if (key === 'lineHeight' || key === 'paragraphSpacing') { value = Number(raw); if (!isFinite(value)) return; }
        else if (key === 'pageWidth') { value = raw === 'full' ? 'full' : Number(raw); if (value !== 'full' && !isFinite(value)) return; }
        else if (key === 'fontFamily') { value = raw; }
        else return;
        const row = chip.parentElement;
        if (row) row.querySelectorAll('.sp-chip').forEach(function (c) { c.classList.remove('active'); });
        chip.classList.add('active');
        apply(key, value);
        post('updateReadingPref', { key: key, value: value });
        return;
      }
      const step = t && t.closest && t.closest('#sp-size-minus, #sp-size-plus');
      if (step) {
        e.preventDefault();
        const sizes = meta.fontSizes;
        const i = sizes.indexOf(curFontSize);
        const next = i < 0 ? sizes.indexOf(15) : i + (step.id === 'sp-size-plus' ? 1 : -1);
        if (next < 0 || next >= sizes.length) return;
        curFontSize = sizes[next];
        const val = document.getElementById('sp-size-val');
        const minus = document.getElementById('sp-size-minus');
        const plus = document.getElementById('sp-size-plus');
        if (val) val.textContent = String(curFontSize);
        if (minus) { if (next <= 0) minus.setAttribute('disabled', ''); else minus.removeAttribute('disabled'); }
        if (plus) { if (next >= sizes.length - 1) plus.setAttribute('disabled', ''); else plus.removeAttribute('disabled'); }
        apply('fontSize', curFontSize);
        post('updateReadingPref', { key: 'fontSize', value: curFontSize });
        return;
      }
      const reset = t && t.closest && t.closest('#sp-reset');
      if (reset) { e.preventDefault(); closePopover(); post('resetReadingPrefs'); }
    });
  })();

  // ===== 阅读快捷键 =====
  (function setupReaderShortcuts() {
    const body = document.querySelector('.reader-body');
    if (!body) return;
    if (!body.hasAttribute('tabindex')) body.setAttribute('tabindex', '-1');
    const OVERLAP = 60, STEP = 100;
    function typing(t) {
      if (!t) return false;
      const tag = (t.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || !!t.isContentEditable;
    }
    function overlayOpen() {
      const sp = document.getElementById('settings-popover');
      return !!document.querySelector('#toc-drawer.open') || !!(sp && !sp.hidden);
    }
    function scrollBy(dy) {
      try { body.scrollBy({ top: dy, behavior: 'smooth' }); } catch (e) { body.scrollBy(0, dy); }
    }
    function page(dir) {
      const h = body.clientHeight;
      if (h > 0) scrollBy(dir * Math.max(h - OVERLAP, Math.floor(h * 0.7)));
    }
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (typing(e.target) || overlayOpen()) return;
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); scrollBy(STEP); break;
        case 'ArrowUp': e.preventDefault(); scrollBy(-STEP); break;
        case 'PageDown': case ' ': e.preventDefault(); page(e.shiftKey ? -1 : 1); break;
        case 'PageUp': e.preventDefault(); page(-1); break;
        case 'ArrowLeft': e.preventDefault(); post('prev'); break;
        case 'ArrowRight': e.preventDefault(); post('next'); break;
        case 'Home': e.preventDefault(); body.scrollTop = 0; break;
        case 'End': e.preventDefault(); body.scrollTop = body.scrollHeight; break;
      }
    });
  })();
})();
`;
}
