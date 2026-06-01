/* YancoRead — eBook reader + tool profile (epub/mobi/fb2/xps via PyMuPDF) */
(function () {
  'use strict';

  const RENDER_SCALE = Math.min(2, window.devicePixelRatio || 1);
  const THEME_FILTER = {
    light: 'none',
    sepia: 'sepia(0.55) contrast(0.96) brightness(0.98)',
    dark: 'invert(0.92) hue-rotate(180deg)',
  };

  function mount(doc) {
    const path = doc.path;
    const pageSize = doc.meta.page_size || { width: 720, height: 1000 };
    const reflowable = !!doc.meta.reflowable;
    const prefs = Object.assign({ fontsize: 11, theme: 'dark' }, doc.prefs || {});

    const S = {
      count: doc.meta.page_count || 1,
      fontsize: doc.meta.fontsize || prefs.fontsize,
      theme: prefs.theme, current: 0, observer: null, currentObs: null,
    };

    const root = YR.root;
    root.innerHTML = '';
    const view = document.createElement('div');
    view.className = 'ebook-view theme-' + S.theme;
    const scroll = document.createElement('div');
    scroll.className = 'pages-scroll';
    view.appendChild(scroll);
    root.appendChild(view);

    function effZoom() {
      const avail = Math.min(820, (YR.root.clientWidth || 800) - 40);
      return Math.max(0.3, Math.min(4, avail / pageSize.width));
    }

    function buildPages() {
      const z = effZoom();
      const cssW = pageSize.width * z;
      const cssH = pageSize.height * z;
      scroll.innerHTML = '';
      for (let i = 0; i < S.count; i++) {
        const wrap = document.createElement('div');
        wrap.className = 'page-wrap'; wrap.dataset.index = i;
        wrap.style.width = cssW + 'px'; wrap.style.minHeight = cssH + 'px';
        const img = document.createElement('img');
        img.className = 'page-canvas';
        img.style.width = cssW + 'px';
        img.style.filter = THEME_FILTER[S.theme] || 'none';
        img.dataset.index = i; img.alt = 'Page ' + (i + 1);
        wrap.appendChild(img);
        scroll.appendChild(wrap);
      }
      attachObservers(z);
    }

    function attachObservers(z) {
      if (S.observer) S.observer.disconnect();
      if (S.currentObs) S.currentObs.disconnect();
      const rootEl = YR.root.parentElement;
      S.observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const img = e.target.querySelector('img');
          if (img && !img.src)
            img.src = `/api/page?path=${encodeURIComponent(path)}&index=${img.dataset.index}&zoom=${(z * RENDER_SCALE).toFixed(3)}`;
          S.observer.unobserve(e.target);
        }
      }, { root: rootEl, rootMargin: '1400px' });
      S.currentObs = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio > 0.5) {
            S.current = parseInt(e.target.dataset.index, 10);
            updateProgress();
            YR.savePosition(S.current, S.count ? (S.current + 1) / S.count : 0);
          }
        }
      }, { root: rootEl, threshold: [0.5] });
      scroll.querySelectorAll('.page-wrap').forEach(w => { S.observer.observe(w); S.currentObs.observe(w); });
    }

    function gotoPage(i, smooth = true) {
      i = Math.max(0, Math.min(i, S.count - 1));
      const w = scroll.querySelector(`.page-wrap[data-index="${i}"]`);
      if (w) w.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
      S.current = i; updateProgress();
    }

    // ── toolbar ───────────────────────────────────────────────────────────
    let progLabel, pageBox, totalLabel, scrubber;
    let scrubbing = false, scrubRAF = 0, scrubTarget = 0;
    function updateProgress() {
      const pct = S.count ? Math.round(((S.current + 1) / S.count) * 100) : 0;
      if (progLabel) progLabel.textContent = pct + '%';
      if (totalLabel) totalLabel.textContent = '/ ' + S.count;
      if (pageBox && document.activeElement !== pageBox) pageBox.value = String(S.current + 1);
      if (scrubber && !scrubbing) { scrubber.max = String(Math.max(1, S.count)); scrubber.value = String(S.current + 1); }
    }
    function scrubTo(v) {
      scrubTarget = Math.max(0, Math.min(Math.round(v) - 1, S.count - 1));
      if (pageBox) pageBox.value = String(scrubTarget + 1);
      if (progLabel) progLabel.textContent = (S.count ? Math.round(((scrubTarget + 1) / S.count) * 100) : 0) + '%';
      if (scrubRAF) return;
      scrubRAF = requestAnimationFrame(() => { scrubRAF = 0; gotoPage(scrubTarget, false); });
    }
    function onKey(e) {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      let handled = true;
      switch (e.key) {
        case 'ArrowRight': case 'PageDown': gotoPage(S.current + 1); break;
        case 'ArrowLeft': case 'PageUp': gotoPage(S.current - 1); break;
        case ' ': gotoPage(S.current + (e.shiftKey ? -1 : 1)); break;
        case 'Home': gotoPage(0); break;
        case 'End': gotoPage(S.count - 1); break;
        case '+': case '=': if (reflowable) setFont(1); else handled = false; break;
        case '-': case '_': if (reflowable) setFont(-1); else handled = false; break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    }

    async function setFont(delta) {
      if (!reflowable) { YR.toast('This eBook has a fixed layout.'); return; }
      S.fontsize = Math.max(7, Math.min(28, S.fontsize + delta));
      YR.savePrefs('ebook', { fontsize: S.fontsize });
      const frac = (S.current + 1) / S.count;
      try {
        const r = await YR.postJSON('/api/relayout', { path, fontsize: S.fontsize });
        S.count = r.page_count || S.count;
      } catch (e) { YR.toast('Could not resize text', 'error'); }
      buildPages();
      gotoPage(Math.round(frac * S.count) - 1, false);
    }

    function setTheme(t) {
      S.theme = t;
      view.className = 'ebook-view theme-' + t;
      scroll.querySelectorAll('img').forEach(im => im.style.filter = THEME_FILTER[t] || 'none');
      YR.savePrefs('ebook', { theme: t });
    }

    const fontGroup = YR.ui.group([
      YR.ui.btn({ icon: 'A−', title: 'Smaller text', onClick: () => setFont(-1) }),
      YR.ui.btn({ icon: 'A＋', title: 'Larger text', onClick: () => setFont(1) }),
    ]);
    const themeSel = YR.ui.select({
      title: 'Reading theme',
      value: S.theme,
      options: [{ value: 'dark', label: '🌙 Dark' }, { value: 'sepia', label: '📜 Sepia' }, { value: 'light', label: '☀ Light' }],
      onChange: setTheme,
    });
    progLabel = YR.ui.label('0%');
    pageBox = YR.ui.input({
      value: '1', width: '40px',
      onEnter: v => { const n = parseInt(v, 10); if (!isNaN(n)) gotoPage(n - 1); },
    });
    pageBox.style.textAlign = 'center';
    pageBox.title = 'Go to page';
    totalLabel = YR.ui.label('/ ' + S.count);
    scrubber = YR.ui.range({
      min: 1, max: Math.max(1, S.count), step: 1, value: 1,
      title: 'Drag to move through the book',
      onInput: scrubTo,
    });
    scrubber.style.width = '120px';
    scrubber.addEventListener('pointerdown', () => { scrubbing = true; });
    const endScrub = () => { scrubbing = false; gotoPage(scrubTarget, false); };
    scrubber.addEventListener('pointerup', endScrub);
    scrubber.addEventListener('change', endScrub);

    YR.setTools([
      YR.ui.group([
        YR.ui.btn({ icon: '◀', title: 'Previous page (←)', onClick: () => gotoPage(S.current - 1) }),
        YR.ui.btn({ icon: '▶', title: 'Next page (→)', onClick: () => gotoPage(S.current + 1) }),
      ]),
      pageBox, totalLabel, scrubber, progLabel,
      YR.ui.sep(),
      reflowable ? fontGroup : null,
      themeSel,
      YR.ui.sep(),
      YR.ui.input({ placeholder: 'Search book…', width: '150px', onEnter: runSearch }),
      YR.ui.btn({ icon: '✦', label: 'AI', title: 'AI reading tools', onClick: () => { sideMode = 'ai'; mountSidebar(); YR.sidebar.show(); } }),
      YR.makeBookmarkTool(() => ({ page: S.current, label: 'Page ' + (S.current + 1) }),
        m => gotoPage(m.page)),
    ]);

    // ── sidebar: Contents + Search ──────────────────────────────────────────
    let sideMode = 'outline';
    const sideWrap = document.createElement('div');
    function renderSidebarHeader() {
      const tab = (m, label) =>
        `<button class="tb-btn ${sideMode === m ? 'active' : ''}" data-m="${m}" style="flex:1">${label}</button>`;
      return `<div style="display:flex;gap:6px;margin-bottom:10px">${tab('outline', 'Contents')}${tab('search', 'Search')}${tab('ai', '✦ AI')}</div>`;
    }
    function renderSideBody() {
      if (sideMode === 'search') renderSearchResults();
      else if (sideMode === 'ai') renderAIPanel();
      else loadOutline();
    }
    function mountSidebar() {
      sideWrap.innerHTML = renderSidebarHeader() + '<div id="side-body"></div>';
      sideWrap.querySelectorAll('[data-m]').forEach(b =>
        b.addEventListener('click', () => { sideMode = b.dataset.m; mountSidebar(); }));
      YR.sidebar.set(sideWrap);
      renderSideBody();
    }
    let outlineLoaded = false, outlineData = [];
    async function ensureOutline() {
      if (outlineLoaded) return outlineData;
      try { outlineData = (await YR.getJSON(`/api/outline?path=${encodeURIComponent(path)}`)).outline || []; }
      catch (e) { outlineData = []; }
      outlineLoaded = true;
      return outlineData;
    }
    async function loadOutline() {
      const body = sideWrap.querySelector('#side-body');
      if (!body) return;
      await ensureOutline();
      if (!outlineData.length) { body.innerHTML = '<div class="empty-recent">No table of contents.</div>'; return; }
      body.innerHTML = '';
      outlineData.forEach(o => {
        const b = document.createElement('button');
        b.className = 'outline-item';
        b.style.paddingLeft = (8 + (o.level - 1) * 12) + 'px';
        b.textContent = o.title || '(untitled)';
        b.addEventListener('click', () => gotoPage(o.page));
        body.appendChild(b);
      });
    }
    let searchResults = [], lastQuery = '';
    async function runSearch(q) {
      if (!q || !q.trim()) return;
      lastQuery = q.trim();
      sideMode = 'search'; mountSidebar();
      const body = sideWrap.querySelector('#side-body');
      body.innerHTML = '<div class="stage-loading" style="position:static;padding:20px"><div class="yr-spinner"></div></div>';
      YR.sidebar.show();
      try { searchResults = (await YR.getJSON(`/api/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(lastQuery)}`)).results || []; }
      catch (e) { searchResults = []; }
      renderSearchResults();
    }
    function renderSearchResults() {
      const body = sideWrap.querySelector('#side-body');
      if (!body) return;
      if (!lastQuery) { body.innerHTML = '<div class="empty-recent">Type a word above to search the whole book.</div>'; return; }
      if (!searchResults.length) { body.innerHTML = `<div class="empty-recent">No matches for “${YR.escapeHtml(lastQuery)}”.</div>`; return; }
      const total = searchResults.reduce((n, r) => n + (r.count || 1), 0);
      body.innerHTML = `<h3>${total} match${total === 1 ? '' : 'es'} · ${searchResults.length} page${searchResults.length === 1 ? '' : 's'}</h3>`;
      searchResults.forEach(r => {
        const b = document.createElement('button');
        b.className = 'outline-item';
        b.style.whiteSpace = 'normal';
        b.innerHTML = `<b style="color:var(--accent)">p.${r.page + 1}</b> — ${YR.escapeHtml(r.snippet)}`;
        b.addEventListener('click', () => gotoPage(r.page));
        body.appendChild(b);
      });
    }

    // ── AI reading tools (uses /api/doc-text + the shared /api/ai) ─────────────
    const AI_ACTIONS = [
      { task: 'summarize', label: 'Summarize' },
      { task: 'keypoints', label: 'Key points' },
      { task: 'simplify', label: 'Simplify' },
      { task: 'explain', label: 'Explain' },
    ];
    function chapterRange() {
      if (!outlineData || !outlineData.length) return [S.current, S.current + 1];
      let si = 0;
      for (let i = 0; i < outlineData.length; i++) {
        if (outlineData[i].page <= S.current) si = i; else break;
      }
      const start = outlineData[si].page;
      let end = S.count;
      for (let i = si + 1; i < outlineData.length; i++) {
        if (outlineData[i].page > start) { end = outlineData[i].page; break; }
      }
      return [start, Math.max(start + 1, end)];
    }
    function scopeRange(scope) {
      if (scope === 'chapter') return chapterRange();
      if (scope === 'book') return [0, S.count];
      return [S.current, S.current + 1];
    }
    async function renderAIPanel() {
      let body = sideWrap.querySelector('#side-body');
      if (!body) return;
      body.innerHTML = '<div class="stage-loading" style="position:static;padding:18px"><div class="yr-spinner"></div></div>';
      await ensureOutline();
      if (sideMode !== 'ai') return;
      body = sideWrap.querySelector('#side-body');
      if (!body) return;
      const hasToc = !!(outlineData && outlineData.length);
      body.innerHTML =
        '<div class="ai-scope">Work on ' +
          '<select class="tb-input" id="ai-scope" style="width:auto">' +
            '<option value="page">this page</option>' +
            (hasToc ? '<option value="chapter">this chapter</option>' : '') +
            '<option value="book">whole book</option>' +
          '</select></div>' +
        '<div class="ai-actions">' +
          AI_ACTIONS.map(a => `<button class="ai-act" data-task="${a.task}">${a.label}</button>`).join('') +
        '</div>' +
        '<div class="ai-ask">' +
          '<input class="tb-input" id="ai-q" placeholder="Ask about the book…" />' +
          '<button class="ai-act" id="ai-ask-btn">Ask</button>' +
        '</div>' +
        '<div class="ai-output" id="ai-out"></div>';
      body.querySelector('#ai-scope').value = hasToc ? 'chapter' : 'page';
      body.querySelectorAll('.ai-act[data-task]').forEach(b =>
        b.addEventListener('click', () => runEbookAI(b.dataset.task)));
      const q = body.querySelector('#ai-q');
      const ask = () => { const v = q.value.trim(); if (v) runEbookAI('ask', v); };
      body.querySelector('#ai-ask-btn').addEventListener('click', ask);
      q.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') ask(); });
    }
    async function runEbookAI(task, question) {
      if (sideMode !== 'ai') { sideMode = 'ai'; mountSidebar(); }
      YR.sidebar.show();
      const out = sideWrap.querySelector('#ai-out');
      if (!out) return;
      const scope = (sideWrap.querySelector('#ai-scope') || {}).value || 'page';
      out.innerHTML = '<div class="stage-loading" style="position:static;padding:18px"><div class="yr-spinner"></div></div>';
      let data;
      try {
        const [start, end] = scopeRange(scope);
        data = await YR.getJSON(`/api/doc-text?path=${encodeURIComponent(path)}&start=${start}&end=${end}`);
      } catch (e) {
        out.innerHTML = '<div class="ai-err">Could not read text from the book.</div>'; return;
      }
      if (!data.text || !data.text.trim()) {
        out.innerHTML = '<div class="ai-err">No selectable text on these pages — this book may be image-only.</div>'; return;
      }
      try {
        const r = await YR.postJSON('/api/ai', { task, text: data.text, question });
        const result = r.result || '(no response)';
        const note = data.truncated
          ? `<div class="ai-scope" style="margin:0 0 6px">Based on pages ${data.start + 1}–${data.end} (trimmed to fit).</div>` : '';
        out.innerHTML = note + '<div class="ai-result"></div><button class="ai-act ai-copy">⧉ Copy</button>';
        out.querySelector('.ai-result').textContent = result;
        out.querySelector('.ai-copy').addEventListener('click', () => {
          if (navigator.clipboard) navigator.clipboard.writeText(result);
          YR.toast('Copied', '', 1200);
        });
      } catch (e) {
        out.innerHTML = '<div class="ai-err">' + YR.escapeHtml(e.message || 'AI request failed') +
          '<br><span style="opacity:.8">Set up a model in Settings ▸ AI.</span></div>';
      }
    }

    YR.sidebar.available(true);
    mountSidebar();

    buildPages();
    const startPage = (typeof doc.position === 'number') ? doc.position : 0;
    if (startPage > 0) setTimeout(() => gotoPage(startPage, false), 60);
    else updateProgress();

    S._resize = () => { const keep = S.current; buildPages(); gotoPage(keep, false); };
    window.addEventListener('resize', S._resize);
    S._onKey = onKey;
    window.addEventListener('keydown', onKey);
    mount._S = S;
  }

  function unmount() {
    const S = mount._S;
    if (S) {
      if (S.observer) S.observer.disconnect();
      if (S.currentObs) S.currentObs.disconnect();
      if (S._resize) window.removeEventListener('resize', S._resize);
      if (S._onKey) window.removeEventListener('keydown', S._onKey);
    }
    mount._S = null;
  }

  YR.registerReader('ebook', { mount, unmount });
})();
