/* ============================================================================
   YancoRead — core controller (vanilla JS, no framework)
   - opens a file, detects its kind on the backend, and mounts the matching
     reader module, whose toolbar replaces the adaptive top bar.
   - provides shared UI helpers (toolbar DSL, sidebar, toasts) to readers.
   ========================================================================== */
(function () {
  'use strict';

  const KIND_LABEL = {
    pdf: 'PDF', comic: 'Comic', ebook: 'eBook',
    office: 'Doc', text: 'Text', image: 'Image',
  };
  const KIND_ICON = {
    pdf: '📕', comic: '📚', ebook: '📖',
    office: '📝', text: '🅣', image: '🖼️',
  };

  const state = { doc: null, reader: null, posTimer: null, leaveGuard: null };
  const el = {};

  // ── small fetch helpers ─────────────────────────────────────────────────
  async function getJSON(url) {
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }
  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── toasts ────────────────────────────────────────────────────────────────
  function toast(msg, type = '', ms = 3200) {
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    t.textContent = msg;
    el.toasts.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity 200ms';
      setTimeout(() => t.remove(), 220);
    }, ms);
  }

  // ── adaptive toolbar DSL (readers build their tools with these) ───────────
  const ui = {
    btn({ icon, label, title, active, id, onClick }) {
      const b = document.createElement('button');
      b.className = 'tb-btn' + (icon && !label ? ' icon' : '') + (active ? ' active' : '');
      if (title) b.title = title;
      if (id) b.id = id;
      b.innerHTML = (icon ? `<span>${icon}</span>` : '') +
        (label ? `<span>${escapeHtml(label)}</span>` : '');
      if (onClick) b.addEventListener('click', () => onClick(b));
      return b;
    },
    group(children) {
      const g = document.createElement('div');
      g.className = 'tb-group';
      children.filter(Boolean).forEach(c => g.appendChild(c));
      return g;
    },
    sep() { const s = document.createElement('span'); s.className = 'tb-sep'; return s; },
    label(text) {
      const s = document.createElement('span');
      s.className = 'tb-label'; s.textContent = text;
      return s;
    },
    range({ min, max, step, value, title, onInput }) {
      const r = document.createElement('input');
      r.type = 'range'; r.className = 'tb-range';
      r.min = min; r.max = max; r.step = step ?? 1; r.value = value;
      if (title) r.title = title;
      if (onInput) r.addEventListener('input', () => onInput(parseFloat(r.value)));
      return r;
    },
    select({ options, value, title, onChange }) {
      const s = document.createElement('select');
      s.className = 'tb-input';
      if (title) s.title = title;
      options.forEach(o => {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        if (o.value === value) opt.selected = true;
        s.appendChild(opt);
      });
      if (onChange) s.addEventListener('change', () => onChange(s.value));
      return s;
    },
    input({ placeholder, value, width, onEnter, onInput }) {
      const i = document.createElement('input');
      i.className = 'tb-input'; i.type = 'text';
      if (placeholder) i.placeholder = placeholder;
      if (value) i.value = value;
      if (width) i.style.width = width;
      if (onEnter) i.addEventListener('keydown', e => { if (e.key === 'Enter') onEnter(i.value); });
      if (onInput) i.addEventListener('input', () => onInput(i.value));
      return i;
    },
  };

  function setTools(nodes) {
    el.tools.innerHTML = '';
    (nodes || []).filter(Boolean).forEach(n => el.tools.appendChild(n));
  }

  // ── sidebar ─────────────────────────────────────────────────────────────
  const sidebar = {
    set(node) {
      el.sidebar.innerHTML = '';
      if (typeof node === 'string') el.sidebar.innerHTML = node;
      else if (node) el.sidebar.appendChild(node);
    },
    available(yes) { el.btnSidebar.classList.toggle('hidden', !yes); },
    show() { el.sidebar.classList.remove('collapsed'); },
    hide() { el.sidebar.classList.add('collapsed'); },
    toggle() { el.sidebar.classList.toggle('collapsed'); },
    isOpen() { return !el.sidebar.classList.contains('collapsed'); },
  };

  // ── stage helpers ───────────────────────────────────────────────────────
  function stageLoading(text = 'Opening…') {
    el.root.innerHTML =
      `<div class="stage-loading"><div class="yr-spinner"></div><div>${escapeHtml(text)}</div></div>`;
  }
  function stageError(msg) {
    el.root.innerHTML =
      `<div class="stage-error"><div class="big">Couldn’t open this file</div>` +
      `<div>${escapeHtml(msg)}</div></div>`;
  }

  // ── reading position (debounced save) ─────────────────────────────────────
  function savePosition(position, progress) {
    if (!state.doc) return;
    state.pendingPos = { position, progress };
    clearTimeout(state.posTimer);
    state.posTimer = setTimeout(flushPosition, 700);
  }
  function flushPosition() {
    if (!state.doc || !state.pendingPos) return;
    const { position, progress } = state.pendingPos;
    state.pendingPos = null;
    postJSON('/api/position', { path: state.doc.path, position, progress }).catch(() => {});
  }

  function savePrefs(kind, prefs) {
    postJSON('/api/prefs', { kind, prefs }).catch(() => {});
  }

  // ── bookmarks (shared across paged readers) ───────────────────────────────
  function closeBookmarkPop() { const p = document.querySelector('.bm-pop'); if (p) p.remove(); }

  // getMark() -> {page, label}; jump(mark) navigates there.
  function makeBookmarkTool(getMark, jump) {
    const btn = ui.btn({ icon: '☆', title: 'Bookmarks', onClick: () => {
      if (document.querySelector('.bm-pop')) { closeBookmarkPop(); return; }
      const pop = document.createElement('div');
      pop.className = 'bm-pop';
      document.body.appendChild(pop);
      const r = btn.getBoundingClientRect();
      pop.style.top = (r.bottom + 6) + 'px';
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 290)) + 'px';
      renderBookmarkPop(pop, getMark, jump);
    } });
    return btn;
  }

  async function renderBookmarkPop(pop, getMark, jump) {
    let marks = [];
    try { marks = (await getJSON('/api/bookmarks?path=' + encodeURIComponent(state.doc.path))).bookmarks || []; } catch (e) {}
    let html = '<button class="tb-btn" data-add style="width:100%;justify-content:center">＋ Bookmark this page</button>';
    if (!marks.length) html += '<div class="bm-empty">No bookmarks yet.</div>';
    else html += '<div class="bm-list">' + marks.map((m, i) =>
      `<div class="bm-item"><button class="bm-go" data-i="${i}">${escapeHtml(m.label || ('Page ' + ((m.page || 0) + 1)))}</button>` +
      `<button class="bm-x" data-x="${i}" title="Remove">✕</button></div>`).join('') + '</div>';
    pop.innerHTML = html;
    pop.querySelector('[data-add]').addEventListener('click', async () => {
      await postJSON('/api/bookmarks', { path: state.doc.path, mark: getMark() }).catch(() => {});
      toast('Bookmarked', 'success', 1500);
      renderBookmarkPop(pop, getMark, jump);
    });
    pop.querySelectorAll('.bm-go').forEach(b => b.addEventListener('click', () => { jump(marks[+b.dataset.i]); closeBookmarkPop(); }));
    pop.querySelectorAll('.bm-x').forEach(b => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      await postJSON('/api/bookmarks/remove', { path: state.doc.path, index: +b.dataset.x }).catch(() => {});
      renderBookmarkPop(pop, getMark, jump);
    }));
  }

  // ── unsaved-changes guard ───────────────────────────────────────────────
  // A reader (e.g. the docx editor) registers a function returning a warning
  // string while it holds unsaved work; navigating away first asks to confirm.
  function leaveMessage() {
    const g = state.leaveGuard;
    if (typeof g !== 'function') return '';
    try { return g() || ''; } catch (e) { return ''; }
  }
  function confirmLeave() {
    const msg = leaveMessage();
    return !msg || window.confirm(msg);
  }

  // ── open / route ──────────────────────────────────────────────────────────
  async function openFile(path) {
    if (!path) return;
    if (!confirmLeave()) return;
    el.home.classList.add('hidden');
    el.root.classList.remove('hidden');
    stageLoading();
    try {
      const data = await postJSON('/api/open', { path });
      if (data.status === 'locked') {        // password-protected — prompt, then retry
        promptPassword(data.path || path, data.name || '');
        return;
      }
      openDoc(data.doc);
    } catch (e) {
      stageError(e.message || 'Unknown error');
      toast(e.message || 'Could not open file', 'error');
    }
  }

  // Password gate for encrypted documents. Shown at the open layer (before any
  // reader mounts). The typed password is sent once to /api/unlock and is never
  // stored here — it's read straight off the input, passed through, and the
  // field is cleared. On success we simply re-open the file (now unlocked).
  function promptPassword(path, name) {
    document.querySelector('.pw-overlay')?.remove();
    const ov = document.createElement('div');
    ov.className = 'pw-overlay';
    ov.innerHTML =
      `<div class="pw-card" role="dialog" aria-modal="true" aria-label="Password required">
         <div class="pw-icon">🔒</div>
         <div class="pw-title">This document is password-protected</div>
         <div class="pw-sub">${name ? escapeHtml(name) : ''}</div>
         <input class="pw-input" type="password" autocomplete="current-password"
                placeholder="Enter password" aria-label="Password" />
         <div class="pw-error hidden" role="alert"></div>
         <div class="pw-actions">
           <button class="pw-cancel set-btn ghost">Cancel</button>
           <button class="pw-unlock set-btn primary">Unlock</button>
         </div>
       </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector('.pw-input');
    const errEl = ov.querySelector('.pw-error');
    const btnUnlock = ov.querySelector('.pw-unlock');
    const btnCancel = ov.querySelector('.pw-cancel');

    function close() {
      document.removeEventListener('keydown', onKey, true);
      input.value = '';                       // drop the password from the DOM
      ov.remove();
    }
    function cancel() { close(); goHome(); }
    function showErr(m) { errEl.textContent = m; errEl.classList.remove('hidden'); }
    async function submit() {
      const password = input.value;
      if (!password) { showErr('Please enter the password.'); input.focus(); return; }
      btnUnlock.disabled = btnCancel.disabled = true;
      btnUnlock.textContent = 'Unlocking…';
      errEl.classList.add('hidden');
      try {
        await postJSON('/api/unlock', { path, password });
        close();
        openFile(path);                       // re-open: now unlocked → renders
      } catch (e) {
        showErr(e.message || 'Incorrect password — please try again.');
        btnUnlock.disabled = btnCancel.disabled = false;
        btnUnlock.textContent = 'Unlock';
        input.value = ''; input.focus();
      }
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); submit(); }
    }
    btnUnlock.addEventListener('click', submit);
    btnCancel.addEventListener('click', cancel);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => input.focus(), 30);
  }

  function openDoc(doc) {
    unmountCurrent();
    state.doc = doc;

    el.docTitle.textContent = doc.name;
    el.docKind.textContent = KIND_LABEL[doc.kind] || doc.kind;
    el.docKind.classList.remove('hidden');
    el.btnHome.title = 'Back to library';
    document.title = doc.name + ' — YancoRead';

    setTools([]);
    sidebar.available(false);
    sidebar.hide();
    el.home.classList.add('hidden');
    el.root.classList.remove('hidden');
    el.root.innerHTML = '';

    const reader = YR.readers[doc.kind] || YR.readers.text;
    if (!reader) { stageError('No reader available for this format.'); return; }
    try {
      reader.mount(doc);
      state.reader = reader;
    } catch (e) {
      console.error(e);
      stageError(e.message || 'Reader failed to start');
    }
  }

  function unmountCurrent() {
    flushPosition();
    closeBookmarkPop();
    if (state.reader && typeof state.reader.unmount === 'function') {
      try { state.reader.unmount(); } catch (e) { console.error(e); }
    }
    state.reader = null;
    state.leaveGuard = null;
  }

  function goHome() {
    if (!confirmLeave()) return;
    unmountCurrent();
    state.doc = null;
    document.title = 'YancoRead';
    el.docKind.classList.add('hidden');
    el.docTitle.textContent = '';
    el.btnHome.title = 'Home';
    setTools([]);
    sidebar.available(false);
    sidebar.hide();
    el.root.classList.add('hidden');
    el.root.innerHTML = '';
    el.home.classList.remove('hidden');
    loadRecent();
  }

  // ── home / recent ──────────────────────────────────────────────────────────
  async function loadRecent() {
    let recent = [];
    try { recent = (await getJSON('/api/recent')).recent || []; } catch (e) { /* ignore */ }
    el.clearRecent.classList.toggle('hidden', recent.length === 0);
    if (!recent.length) {
      el.recentGrid.innerHTML =
        '<div class="empty-recent">No documents yet — open a file to get started.</div>';
      return;
    }
    el.recentGrid.innerHTML = '';
    recent.forEach(r => el.recentGrid.appendChild(recentCard(r)));
  }

  function recentCard(r) {
    const card = document.createElement('div');
    card.className = 'recent-card';
    const pct = Math.round((r.progress || 0) * 100);
    card.innerHTML = `
      <div class="recent-cover">
        <span class="kind-chip">${KIND_LABEL[r.kind] || r.kind}</span>
        <span>${KIND_ICON[r.kind] || '📄'}</span>
        ${pct ? `<div class="recent-progress"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      <div class="recent-meta"><div class="recent-name">${escapeHtml(r.name)}</div></div>
      <button class="recent-remove" title="Remove">✕</button>`;
    card.addEventListener('click', () => openFile(r.path));
    card.querySelector('.recent-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      await postJSON('/api/recent/remove', { path: r.path }).catch(() => {});
      loadRecent();
    });
    return card;
  }

  // ── native file dialog (via pywebview bridge) ────────────────────────────
  async function browseAndOpen() {
    const api = window.pywebview && window.pywebview.api;
    if (api && api.browse_file) {
      try {
        const path = await api.browse_file();
        if (path) openFile(path);
      } catch (e) { toast('File dialog failed', 'error'); }
    } else {
      toast('Open files from the File menu, or drag a file in.', '', 4000);
    }
  }

  function toggleFullscreen() {
    const api = window.pywebview && window.pywebview.api;
    if (api && api.toggle_fullscreen) { api.toggle_fullscreen(); return; }
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  // ── drag & drop ─────────────────────────────────────────────────────────
  // Only react to drags that carry actual OS files — not internal drags
  // (e.g. dragging a page image to pan a comic must NOT show the drop overlay).
  function dragHasFiles(e) {
    return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  }
  function wireDragDrop() {
    let depth = 0;
    window.addEventListener('dragenter', e => {
      if (!dragHasFiles(e)) return;
      e.preventDefault(); depth++; el.drop.classList.remove('hidden');
    });
    window.addEventListener('dragover', e => { if (dragHasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', e => {
      if (!dragHasFiles(e)) return;
      e.preventDefault(); depth = Math.max(0, depth - 1);
      if (!depth) el.drop.classList.add('hidden');
    });
    window.addEventListener('drop', e => {
      if (!dragHasFiles(e)) return;
      e.preventDefault(); depth = 0; el.drop.classList.add('hidden');
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      // pywebview exposes a real filesystem path on the dropped File object.
      if (f && f.path) openFile(f.path);
      else if (f) toast('Could not resolve the file path — use File ▸ Open.', 'error');
    });
  }

  // ── init ────────────────────────────────────────────────────────────────
  function init() {
    el.tools = document.getElementById('tb-tools');
    el.sidebar = document.getElementById('sidebar');
    el.stage = document.getElementById('stage');
    el.home = document.getElementById('home');
    el.recentGrid = document.getElementById('recent-grid');
    el.clearRecent = document.getElementById('clear-recent');
    el.docTitle = document.getElementById('doc-title');
    el.docKind = document.getElementById('doc-kind');
    el.btnHome = document.getElementById('btn-home');
    el.btnSidebar = document.getElementById('btn-sidebar');
    el.btnOpen = document.getElementById('btn-open');
    el.btnSettings = document.getElementById('btn-settings');
    el.btnFull = document.getElementById('btn-fullscreen');
    el.drop = document.getElementById('drop-overlay');
    el.toasts = document.getElementById('toasts');

    // a dedicated container for reader content (keeps #home in the DOM)
    el.root = document.createElement('div');
    el.root.id = 'reader-root';
    el.root.style.height = '100%';
    el.root.classList.add('hidden');
    el.stage.appendChild(el.root);

    el.btnHome.addEventListener('click', goHome);
    el.btnSidebar.addEventListener('click', () => sidebar.toggle());
    el.btnOpen.addEventListener('click', browseAndOpen);
    el.btnSettings.addEventListener('click', () => YR.openSettings && YR.openSettings());
    el.btnFull.addEventListener('click', toggleFullscreen);
    document.getElementById('home-open').addEventListener('click', browseAndOpen);
    el.clearRecent.addEventListener('click', async () => {
      await postJSON('/api/recent/clear', {}).catch(() => {});
      loadRecent();
    });

    // Hard reload / window close: warn if a reader holds unsaved work.
    window.addEventListener('beforeunload', (e) => {
      if (leaveMessage()) { e.preventDefault(); e.returnValue = ''; return ''; }
    });

    wireDragDrop();
    loadRecent();

    // Auto-open a file passed on the command line (double-click / "Open with").
    getJSON('/api/launch-file').then(d => { if (d.path) openFile(d.path); }).catch(() => {});
  }

  // ── public surface ────────────────────────────────────────────────────────
  window.YR = {
    init, openFile, openDoc, goHome,
    toast, ui, setTools, sidebar,
    getJSON, postJSON, escapeHtml,
    stageLoading, stageError,
    savePosition, flushPosition, savePrefs,
    makeBookmarkTool,
    setLeaveGuard(fn) { state.leaveGuard = (typeof fn === 'function') ? fn : null; },
    KIND_LABEL, KIND_ICON,
    readers: {},
    registerReader(kind, impl) { this.readers[kind] = impl; },
    get root() { return el.root; },
    get doc() { return state.doc; },
    showAbout() { toast('YancoRead — universal document reader · YancoVerse', '', 4500); },
  };
})();
