/* ============================================================================
   YancoRead — core controller (vanilla JS, no framework)
   - opens a file, detects its kind on the backend, and mounts the matching
     reader module, whose toolbar replaces the adaptive top bar.
   - provides shared UI helpers (toolbar DSL, sidebar, rpanel, rail, palette,
     bottomBar, toasts) to readers.
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

  // ── Mode icons (duotone, colored per mode — Lucide-inspired + BAM! bubble) ─
  // Each entry is the inner <path>/<text> markup of a 24×24 SVG. The wrapping
  // <svg> is built by icon() and gets its own inline color (currentColor drives
  // both stroke and fill via the duotone fill-opacity in each path).
  const MODE_COLORS = {
    home: '#21e08c', pdf: '#4aa6ff', comic: '#a78bff', ebook: '#f5b14e',
    office: '#ff7d6b', text: '#34e6a4', image: '#21e08c', gear: '#9aa7b2',
  };
  const ICONS = {
    home:  '<path d="M4 11.3 12 4l8 7.3V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" fill="currentColor" fill-opacity=".24"/><path d="M4 11.3 12 4l8 7.3"/><path d="M9.5 21v-6.3h5V21"/>',
    pdf:   '<path d="M7.5 3h6.1L18 7.4V20a1 1 0 0 1-1 1H7.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" fill-opacity=".24"/><path d="M7.5 3h6.1L18 7.4V20a1 1 0 0 1-1 1H7.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M13.5 3v4.4H18"/><path d="M9.3 13h5.4M9.3 16.4h3.4"/>',
    comic: '<path d="M12 3.4c5.3 0 9.6 2.8 9.6 6.4 0 3.5-4.3 6.4-9.6 6.4-.9 0-1.8-.1-2.7-.3L5 19.8l1.1-3.7C4 14.9 2.4 13.2 2.4 9.8 2.4 6.2 6.7 3.4 12 3.4Z" fill="currentColor" fill-opacity=".24"/><path d="M12 3.4c5.3 0 9.6 2.8 9.6 6.4 0 3.5-4.3 6.4-9.6 6.4-.9 0-1.8-.1-2.7-.3L5 19.8l1.1-3.7C4 14.9 2.4 13.2 2.4 9.8 2.4 6.2 6.7 3.4 12 3.4Z" stroke-linejoin="round"/><text x="12" y="12.1" text-anchor="middle" font-family="Inter, Arial, sans-serif" font-size="6.6" font-weight="800" fill="#fff" stroke="none" letter-spacing="-.4">BAM!</text>',
    ebook: '<path d="M12 6.3C10.3 5.1 8 4.5 5 4.5V18.1c3 0 5.3.6 7 1.8 1.7-1.2 4-1.8 7-1.8V4.5c-3 0-5.3.6-7 1.8z" fill="currentColor" fill-opacity=".24"/><path d="M12 6.3C10.3 5.1 8 4.5 5 4.5V18.1c3 0 5.3.6 7 1.8 1.7-1.2 4-1.8 7-1.8V4.5c-3 0-5.3.6-7 1.8z"/><path d="M12 6.3v13.6"/>',
    office:'<rect x="5" y="3.4" width="14" height="17.2" rx="2" fill="currentColor" fill-opacity=".24"/><rect x="5" y="3.4" width="14" height="17.2" rx="2"/><path d="M8.4 8h7.2" stroke-width="2.4"/><path d="M8.4 12h7.2M8.4 15.4h4.6"/>',
    text:  '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4" fill="currentColor" fill-opacity=".24"/><rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4"/><path d="M9.4 9.6 7 12l2.4 2.4M14.6 9.6 17 12l-2.4 2.4"/>',
    image: '<rect x="3.5" y="5" width="17" height="14" rx="2.4" fill="currentColor" fill-opacity=".24"/><rect x="3.5" y="5" width="17" height="14" rx="2.4"/><circle cx="8.6" cy="10" r="1.6" fill="currentColor" stroke="none"/><path d="M4 16.6 9.2 11.6l3.3 3.3L16 11l4.5 4.6"/>',
    gear:  '<path d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V20a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V4a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" fill="currentColor" fill-opacity=".24"/><path d="M19.4 13a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V20a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V4a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/><circle cx="12" cy="12" r="3"/>',
  };
  function icon(kind, size) {
    const c = MODE_COLORS[kind] || 'currentColor';
    const s = size || 23;
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:${c}">${ICONS[kind] || ICONS.pdf}</svg>`;
  }

  // ── Topbar / menu glyphs (Lucide-style line icons) ──────────────────────
  // Used for the topbar icon buttons (home, sidebar toggle, +, ⚙, ⛶) and for
  // category menu buttons (View ▾, Tools ▾, etc.). Different from MODE icons
  // (above) which carry per-mode color — these inherit currentColor so they
  // blend with the toolbar's text color and the active-state mode glow.
  const GLYPHS = {
    home:      '<path d="M3 11 L12 4 L21 11"/><path d="M5 10 V20 a1 1 0 0 0 1 1 H9 V14 H15 V21 H19 a1 1 0 0 0 1 -1 V10"/>',
    sidebar:   '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>',
    plus:      '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    gear:      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15 a1.65 1.65 0 0 0 .33 1.82 l.06 .06 a2 2 0 0 1 -2.83 2.83 l-.06 -.06 a1.65 1.65 0 0 0 -1.82 -.33 a1.65 1.65 0 0 0 -1 1.51 V21 a2 2 0 0 1 -4 0 v-.09 a1.65 1.65 0 0 0 -1 -1.51 a1.65 1.65 0 0 0 -1.82 .33 l-.06 .06 a2 2 0 0 1 -2.83 -2.83 l.06 -.06 a1.65 1.65 0 0 0 .33 -1.82 a1.65 1.65 0 0 0 -1.51 -1 H3 a2 2 0 0 1 0 -4 h.09 a1.65 1.65 0 0 0 1.51 -1 a1.65 1.65 0 0 0 -.33 -1.82 l-.06 -.06 a2 2 0 0 1 2.83 -2.83 l.06 .06 a1.65 1.65 0 0 0 1.82 .33 H9 a1.65 1.65 0 0 0 1 -1.51 V3 a2 2 0 0 1 4 0 v.09 a1.65 1.65 0 0 0 1 1.51 a1.65 1.65 0 0 0 1.82 -.33 l.06 -.06 a2 2 0 0 1 2.83 2.83 l-.06 .06 a1.65 1.65 0 0 0 -.33 1.82 V9 a1.65 1.65 0 0 0 1.51 1 H21 a2 2 0 0 1 0 4 h-.09 a1.65 1.65 0 0 0 -1.51 1 z"/>',
    expand:    '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    search:    '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.6" y2="16.6"/>',
    more:      '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    view:      '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
    tools:     '<path d="M14.7 6.3 a4 4 0 0 0 -5.4 -5.4 l2.4 2.4 a1.4 1.4 0 0 1 0 2 a1.4 1.4 0 0 1 -2 0 L7.3 2.9 a4 4 0 0 0 5.4 5.4 l7.6 7.6 a1.4 1.4 0 0 0 2 -2 z"/>',
    modes:     '<polygon points="12 2 22 8 12 14 2 8"/><polyline points="2 14 12 20 22 14"/><polyline points="2 8 2 16"/><polyline points="22 8 22 16"/>',
    sparkles:  '<path d="M12 3 L13.5 9 L19 10 L13.5 11 L12 17 L10.5 11 L5 10 L10.5 9 z" fill="currentColor"/><path d="M19 14 L19.6 16 L21.5 16.5 L19.6 17 L19 19 L18.4 17 L16.5 16.5 L18.4 16 z" fill="currentColor"/>',
    bookmark:  '<path d="M12 2 L14.6 8.5 L21.5 9 L16.2 13.5 L17.9 20.5 L12 16.7 L6.1 20.5 L7.8 13.5 L2.5 9 L9.4 8.5 z"/>',
    save:      '<path d="M19 21 H5 a2 2 0 0 1 -2 -2 V5 a2 2 0 0 1 2 -2 h11 l5 5 v11 a2 2 0 0 1 -2 2 z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
    reading:   '<path d="M12 6.3 C 10.3 5.1 8 4.5 5 4.5 V18.1 c 3 0 5.3 .6 7 1.8 c 1.7 -1.2 4 -1.8 7 -1.8 V4.5 c -3 0 -5.3 .6 -7 1.8 z"/><path d="M12 6.3 V19.9"/>',
    transform: '<polyline points="3 4 7 4 7 8"/><path d="M7 4 A8 8 0 0 1 21 13"/><polyline points="21 20 17 20 17 16"/><path d="M17 20 A8 8 0 0 1 3 11"/>',
    notes:     '<path d="M14 2 H6 a2 2 0 0 0 -2 2 v16 a2 2 0 0 0 2 2 h12 a2 2 0 0 0 2 -2 V8 z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/>',
    print:     '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18 H4 a2 2 0 0 1 -2 -2 v-5 a2 2 0 0 1 2 -2 h16 a2 2 0 0 1 2 2 v5 a2 2 0 0 1 -2 2 h-2"/><rect x="6" y="14" width="12" height="8"/>',
    help:      '<circle cx="12" cy="12" r="9"/><path d="M9.5 9 a2.5 2.5 0 1 1 4 2 c -1 .5 -1.5 1 -1.5 2"/><circle cx="12" cy="17" r=".8" fill="currentColor"/>',
    edit:      '<path d="M12 20 H21"/><path d="M16.5 3.5 a2.12 2.12 0 0 1 3 3 L7 19 L3 20 L4 16 z"/>',
    chat:      '<path d="M21 12 a8 8 0 0 1 -11 7.4 L3 21 l1.6 -7 A8 8 0 1 1 21 12 z"/>',
  };
  function glyph(name, size) {
    size = size || 18;
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[name] || ''}</svg>`;
  }

  const state = { doc: null, reader: null, posTimer: null, leaveGuard: null, cmds: [], toolNodes: null, ctxBindings: [], pendingPrefs: {}, prefsTimer: null };
  const el = {};

  // ── small fetch helpers ─────────────────────────────────────────────────
  // Per-session token (minted server-side, injected into the page) — sent on
  // every state-changing API call so other local processes / cross-origin pages
  // can't trigger writes. They never see this token.
  const API_TOKEN = (document.querySelector('meta[name="yr-api-token"]') || {}).content || '';
  async function getJSON(url) {
    const r = await fetch(url, { headers: { 'X-YR-Token': API_TOKEN } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }
  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-YR-Token': API_TOKEN },
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

  // Document-kind badge label. Uses the file extension (uppercased) so DOCX/
  // PPTX/XLSX/EPUB/MOBI/CBR each show their own name instead of all collapsing
  // to a generic "Doc". Falls back to the kind name for extensionless files.
  function labelForDoc(doc) {
    if (!doc) return '';
    const ext = (doc.ext || '').replace(/^\./, '').toUpperCase();
    if (ext) return ext;
    return KIND_LABEL[doc.kind] || doc.kind;
  }

  // ── toasts ────────────────────────────────────────────────────────────────
  function toast(msg, type = '', ms = 3200) {
    const t = document.createElement('div');
    t.className = 'toast' + (type ? ' ' + type : '');
    if (type === 'error') t.setAttribute('role', 'alert');   // assertively announced
    t.textContent = msg;
    el.toasts.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      t.style.transition = 'opacity 200ms';
      setTimeout(() => t.remove(), 220);
    }, ms);
  }

  // Focusable descendants of a container, in DOM order (skips hidden + tabindex=-1).
  function focusablesIn(root) {
    return Array.from(root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
      'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetParent !== null || el === document.activeElement);
  }

  // Global modal focus trap: while any [role="dialog"] is open, keep Tab inside
  // it (and pull focus in on the first Tab). One listener, fires only on Tab —
  // covers every modal (password, PDF redact/sign/merge/export, …) with no
  // per-dialog wiring. Each dialog still owns its own Esc / close.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const dialogs = document.querySelectorAll('[role="dialog"]');
    const dialog = dialogs[dialogs.length - 1];   // topmost
    if (!dialog) return;
    const f = focusablesIn(dialog);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1], active = document.activeElement;
    if (!dialog.contains(active)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }, true);

  // ── menu accessibility (shared by ui.menu and contextMenu) ────────────────
  // Makes a .ui-menu popover keyboard- and screen-reader-operable: role=menu /
  // menuitem, arrow-key navigation, Home/End, Enter/Space to activate, and Tab
  // to dismiss. Focus moves into the menu on open and is restored to `restoreEl`
  // when it closes via the keyboard.
  function installMenuA11y(menuEl, closeFn, restoreEl) {
    menuEl.setAttribute('role', 'menu');
    menuEl.querySelectorAll('.ui-menu-item').forEach(r => {
      r.setAttribute('role', 'menuitem');
      r.tabIndex = -1;
      if (r.classList.contains('disabled')) r.setAttribute('aria-disabled', 'true');
      if (r.classList.contains('active')) r.setAttribute('aria-current', 'true');
    });
    const items = () => Array.from(menuEl.querySelectorAll('.ui-menu-item:not(.disabled)'));
    const focusAt = (i) => { const l = items(); if (l.length) l[(i + l.length) % l.length].focus(); };
    const idx = () => items().indexOf(document.activeElement);
    menuEl.addEventListener('keydown', (e) => {
      const l = items();
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); focusAt(idx() + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); focusAt(idx() - 1); }
      else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
      else if (e.key === 'End') { e.preventDefault(); focusAt(l.length - 1); }
      else if (e.key === 'Enter' || e.key === ' ') {
        const a = document.activeElement;
        if (a && a.classList.contains('ui-menu-item')) { e.preventDefault(); e.stopPropagation(); a.click(); }
      } else if (e.key === 'Tab') { closeFn(); }   // dismiss; let focus move on
    });
    menuEl._restoreEl = restoreEl || null;
    setTimeout(() => { (menuEl.querySelector('.ui-menu-item.active') || items()[0] || menuEl).focus(); }, 0);
  }

  // ── adaptive toolbar DSL (readers build their tools with these) ───────────
  const ui = {
    btn({ icon, label, title, active, id, onClick }) {
      const b = document.createElement('button');
      b.className = 'tb-btn' + (icon && !label ? ' icon' : '') + (active ? ' active' : '');
      if (title) b.title = title;
      if (icon && !label && title) b.setAttribute('aria-label', title);   // icon-only → labelled for AT
      if (active) b.setAttribute('aria-pressed', 'true');
      if (id) b.id = id;
      b.innerHTML = (icon ? `<span aria-hidden="true">${icon}</span>` : '') +
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
    // ── new DSL (2026 redesign) ──────────────────────────────────────────
    // Segmented control (View/Edit, Code/Preview, etc.) — opt-in for readers.
    seg(items, value, onChange) {
      const g = document.createElement('div');
      g.className = 'seg';
      g.setAttribute('role', 'tablist');
      const btns = [];
      items.forEach(it => {
        const b = document.createElement('button');
        const on = it.value === value;
        if (on) b.className = 'on';
        if (it.title) { b.title = it.title; if (it.icon && !it.label) b.setAttribute('aria-label', it.title); }
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;                 // roving tabindex
        b.innerHTML = (it.icon ? `<span class="gl" aria-hidden="true">${it.icon}</span>` : '') +
          (it.label ? `<span>${escapeHtml(it.label)}</span>` : '');
        b.addEventListener('click', () => onChange && onChange(it.value));
        btns.push(b);
        g.appendChild(b);
      });
      g.addEventListener('keydown', (e) => {
        const i = btns.indexOf(document.activeElement);
        if (i < 0) return;
        let j = i;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % btns.length;
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + btns.length) % btns.length;
        else return;
        e.preventDefault();
        btns[j].focus();
        btns[j].click();
      });
      return g;
    },
    // Compact numeric field with optional unit + stepper (page X / Y).
    field({ value, sub, width, title, onUp, onDown, onEnter }) {
      const w = document.createElement('div');
      w.className = 'tb-field';
      if (title) w.title = title;
      const inp = document.createElement('input');
      inp.type = 'text'; inp.value = value ?? '';
      if (width) inp.style.width = width;
      if (onEnter) inp.addEventListener('keydown', e => { if (e.key === 'Enter') onEnter(inp.value); });
      w.appendChild(inp);
      if (sub) {
        const s = document.createElement('span');
        s.className = 'sub'; s.textContent = sub;
        w.appendChild(s);
      }
      if (onUp || onDown) {
        const st = document.createElement('div'); st.className = 'stepper';
        const up = document.createElement('button'); up.innerHTML = '▲';
        const dn = document.createElement('button'); dn.innerHTML = '▼';
        if (onUp) up.addEventListener('click', onUp);
        if (onDown) dn.addEventListener('click', onDown);
        st.appendChild(up); st.appendChild(dn); w.appendChild(st);
      }
      return w;
    },
    // Collapsible search pill (icon → expands on focus).
    search({ placeholder, kbd, onInput, onEnter }) {
      const w = document.createElement('label');
      w.className = 'tb-search';
      w.innerHTML = `<span class="gl">⌕</span>`;
      const inp = document.createElement('input');
      inp.type = 'text';
      if (placeholder) inp.placeholder = placeholder;
      if (onInput) inp.addEventListener('input', () => onInput(inp.value));
      if (onEnter) inp.addEventListener('keydown', e => { if (e.key === 'Enter') onEnter(inp.value); });
      w.appendChild(inp);
      if (kbd) {
        const k = document.createElement('span');
        k.className = 'kbd'; k.textContent = kbd;
        w.appendChild(k);
      }
      return w;
    },
    // On/off pill switch (state held on the element via .on class).
    toggle(initial, onChange) {
      const t = document.createElement('div');
      t.className = 'toggle' + (initial ? ' on' : '');
      t.setAttribute('role', 'switch');
      t.setAttribute('aria-checked', initial ? 'true' : 'false');
      t.tabIndex = 0;
      const flip = () => {
        const next = !t.classList.contains('on');
        t.classList.toggle('on', next);
        t.setAttribute('aria-checked', next ? 'true' : 'false');
        if (onChange) onChange(next);
      };
      t.addEventListener('click', flip);
      t.addEventListener('keydown', e => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
      });
      return t;
    },
    // Dropdown menu — a button with a chevron that opens a glass popover of
    // items. items can be an array OR a function that returns an array (called
    // at open time, so .active flags can reflect live state). Each item is
    // { label, icon?, hint?, active?, run? } or { separator: true }.
    menu({ icon, label, title, items }) {
      let openMenu = null;
      const b = document.createElement('button');
      b.className = 'tb-btn' + (icon && !label ? ' icon' : '') + ' has-menu';
      if (title) b.title = title;
      if (icon && !label && title) b.setAttribute('aria-label', title);
      b.setAttribute('aria-haspopup', 'menu');
      b.setAttribute('aria-expanded', 'false');
      b.innerHTML =
        (icon ? `<span aria-hidden="true">${icon}</span>` : '') +
        (label ? `<span>${escapeHtml(label)}</span>` : '') +
        `<span class="caret" aria-hidden="true">▾</span>`;
      // Re-evaluate items and toggle .has-active on the button if any item is
      // currently active. Called on every open and after any item action runs,
      // so the parent button glows whenever a hidden mode is on.
      function refreshActive() {
        const list = (typeof items === 'function' ? items() : items) || [];
        b.classList.toggle('has-active', list.some(it => it && it.active));
      }
      b._refreshMenuActive = refreshActive;     // public hook for external state changes
      function close() {
        if (!openMenu) return;
        const m = openMenu; openMenu = null;
        const refocus = m.contains(document.activeElement);   // keyboard close → restore focus
        m.classList.add('closing');
        setTimeout(() => m.remove(), 150);   // matches @keyframes pop-out
        document.removeEventListener('mousedown', outside, true);
        document.removeEventListener('keydown', esc, true);
        b.classList.remove('open');
        b.setAttribute('aria-expanded', 'false');
        if (refocus) b.focus();
      }
      function outside(e) { if (openMenu && !openMenu.contains(e.target) && e.target !== b && !b.contains(e.target)) close(); }
      function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
      b.addEventListener('click', () => {
        if (openMenu) { close(); return; }
        const list = (typeof items === 'function' ? items() : items) || [];
        refreshActive();                          // reflect current state before opening
        const m = document.createElement('div');
        m.className = 'ui-menu';
        list.forEach(it => {
          if (it && it.separator) {
            const s = document.createElement('div');
            s.className = 'ui-menu-sep';
            m.appendChild(s);
            return;
          }
          if (!it) return;
          const row = document.createElement('div');
          row.className = 'ui-menu-item' + (it.active ? ' active' : '');
          if (it.title) row.title = it.title;
          row.innerHTML =
            (it.icon ? `<span class="gl">${it.icon}</span>` : '<span class="gl"></span>') +
            `<span class="lab">${escapeHtml(it.label || '')}</span>` +
            (it.hint ? `<span class="hint">${escapeHtml(it.hint)}</span>` : '');
          row.addEventListener('click', () => {
            close();
            if (typeof it.run === 'function') it.run();
            refreshActive();                      // state likely changed — re-evaluate
          });
          m.appendChild(row);
        });
        document.body.appendChild(m);
        openMenu = m;
        b.classList.add('open');
        b.setAttribute('aria-expanded', 'true');
        installMenuA11y(m, close, b);
        const r = b.getBoundingClientRect();
        // Position below the button, clamped to the viewport.
        const mw = Math.max(220, m.offsetWidth || 220);
        m.style.top = (r.bottom + 6) + 'px';
        m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + 'px';
        setTimeout(() => {
          document.addEventListener('mousedown', outside, true);
          document.addEventListener('keydown', esc, true);
        }, 0);
      });
      return b;
    },
  };

  function setTools(nodes) {
    el.tools.innerHTML = '';
    state.toolNodes = (nodes || []).filter(Boolean);
    state.toolNodes.forEach(n => el.tools.appendChild(n));
    // After the next paint, fold trailing items into a More ▾ if they overflow.
    requestAnimationFrame(refitTools);
  }

  // Auto-overflow: when .tb-tools content is wider than its container, hide
  // trailing items and append a "More ▾" menu containing them. Items keep
  // their click handlers (the menu item's run calls node.click()) and active
  // state propagates (items recomputed on each menu open). Re-runs on resize.
  function refitTools() {
    if (!el.tools || !state.toolNodes || !state.toolNodes.length) {
      const stale = el.tools && el.tools.querySelector('.tb-overflow');
      if (stale) stale.remove();
      return;
    }
    // Restore everything to visible before re-measuring.
    state.toolNodes.forEach(n => { if (n.style && n.style.display === 'none') n.style.display = ''; });
    const oldMore = el.tools.querySelector('.tb-overflow');
    if (oldMore) oldMore.remove();
    // No overflow → done.
    if (el.tools.scrollWidth <= el.tools.clientWidth + 2) return;

    // Build the More menu. items as a function so .active reflects current state.
    const hidden = [];
    const moreBtn = ui.menu({
      icon: '⋯', label: 'More', title: 'More tools that didn’t fit',
      items: () => hidden.map(n => {
        const spans = n.querySelectorAll('span:not(.caret)');
        let ic = '', lab = '';
        if (spans.length >= 2) { ic = spans[0].textContent || ''; lab = spans[1].textContent || ''; }
        else if (spans.length === 1) { ic = spans[0].textContent || ''; lab = n.title || ic; }
        return {
          icon: ic, label: lab || n.title || '(action)',
          active: n.classList.contains('active'),
          run: () => n.click(),
        };
      }),
    });
    moreBtn.classList.add('tb-overflow');
    el.tools.appendChild(moreBtn);

    // Fold trailing items until it fits. Skip menus (their dropdowns position
    // relative to their button rect, which breaks under display:none).
    for (let i = state.toolNodes.length - 1; i >= 0; i--) {
      if (el.tools.scrollWidth <= el.tools.clientWidth + 2) break;
      const n = state.toolNodes[i];
      if (n.classList.contains('has-menu')) continue;
      n.style.display = 'none';
      if (n.classList.contains('tb-sep') || n.classList.contains('tb-divider')) continue;
      if (!n.classList.contains('tb-btn')) continue;
      hidden.unshift(n);
    }
    // If we hid nothing (only menus or non-buttons trailing), drop the More button.
    if (!hidden.length) moreBtn.remove();
    // Reflect overflow active state on the More button itself.
    if (hidden.some(n => n.classList.contains('active'))) moreBtn.classList.add('has-active');
  }

  // Per-reader buttons mounted into .tb-right (alongside the global + / ⚙ / ⛶
  // icons), guaranteed visible regardless of .tb-tools overflow. Use this for
  // high-priority reader actions like AI that must never get scroll-clipped.
  function setHeaderActions(nodes) {
    el.actions.innerHTML = '';
    (nodes || []).filter(Boolean).forEach(n => el.actions.appendChild(n));
    if (el.actionsSep) el.actionsSep.hidden = !el.actions.children.length;
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

  // ── right panel (AI / info / tools) — mirrors the sidebar shape ──────────
  const rpanel = {
    set(node) {
      el.rpanel.innerHTML = '';
      if (typeof node === 'string') el.rpanel.innerHTML = node;
      else if (node) el.rpanel.appendChild(node);
    },
    show() { el.rpanel.classList.remove('collapsed'); },
    hide() { el.rpanel.classList.add('collapsed'); },
    toggle() { el.rpanel.classList.toggle('collapsed'); },
    isOpen() { return !el.rpanel.classList.contains('collapsed'); },
    clear() { el.rpanel.innerHTML = ''; el.rpanel.classList.add('collapsed'); },
  };

  // ── floating bottom bar (readers opt in) ─────────────────────────────────
  function bottomBar(nodes) {
    // remove any prior bar
    document.querySelectorAll('#stage > .bottombar, #stage > .cine').forEach(n => n.remove());
    if (!nodes || !nodes.length) return null;
    const bar = document.createElement('div');
    bar.className = 'bottombar';
    nodes.filter(Boolean).forEach(n => bar.appendChild(n));
    el.stage.appendChild(bar);
    return bar;
  }

  // ── command palette (Ctrl/Cmd+K) ─────────────────────────────────────────
  const palette = {
    coreCommands() {
      // Always-available commands — readers append their own via registerCommand.
      const cmds = [
        { g: 'View', ic: '☰', name: 'Toggle sidebar', hint: 'Ctrl+B', run: () => sidebar.toggle() },
        { g: 'View', ic: '✦', name: 'Toggle AI panel', hint: 'Ctrl+J', run: () => rpanel.toggle() },
        { g: 'View', ic: '⛶', name: 'Toggle fullscreen', hint: '',     run: () => toggleFullscreen() },
        { g: 'App',  ic: '⌂', name: 'Go to Home',       hint: '',     run: () => goHome() },
        { g: 'App',  ic: '＋', name: 'Open a file…',     hint: '',     run: () => browseAndOpen() },
        { g: 'App',  ic: '⚙', name: 'Settings',         hint: '',     run: () => YR.openSettings && YR.openSettings() },
      ];
      return cmds.concat(state.cmds);
    },
    open() {
      this.close();
      let sel = 0;
      let filtered = this.coreCommands();
      const ov = document.createElement('div');
      ov.className = 'overlay';
      const card = document.createElement('div');
      card.className = 'palette';
      card.innerHTML =
        '<div class="pal-search">' +
          '<span class="gl">⌕</span>' +
          '<input type="text" placeholder="Search files, modes, actions…" />' +
          '<span class="kbd">esc</span>' +
        '</div>' +
        '<div class="pal-list"></div>';
      ov.appendChild(card);
      ov.addEventListener('mousedown', e => { if (e.target === ov) palette.close(); });
      document.body.appendChild(ov);
      const input = card.querySelector('input');
      const list = card.querySelector('.pal-list');
      const paint = () => {
        list.innerHTML = '';
        let group = '';
        filtered.forEach((c, i) => {
          if (c.g !== group) {
            group = c.g;
            const gh = document.createElement('div');
            gh.className = 'pal-group'; gh.textContent = group;
            list.appendChild(gh);
          }
          const it = document.createElement('div');
          it.className = 'pal-item' + (i === sel ? ' sel' : '');
          it.innerHTML =
            `<span class="pal-ic">${c.ic || '·'}</span>` +
            `<span class="pal-name">${escapeHtml(c.name)}</span>` +
            (c.hint ? `<span class="pal-hint">${escapeHtml(c.hint)}</span>` : '');
          it.addEventListener('click', () => { c.run(); palette.close(); });
          list.appendChild(it);
        });
      };
      input.addEventListener('input', () => {
        const q = input.value.toLowerCase();
        const all = palette.coreCommands();
        filtered = !q ? all : all.filter(c => (c.name + ' ' + (c.hint || '') + ' ' + c.g).toLowerCase().includes(q));
        sel = 0; paint();
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown')   { sel = Math.min(filtered.length - 1, sel + 1); paint(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); paint(); e.preventDefault(); }
        else if (e.key === 'Enter')   { if (filtered[sel]) { filtered[sel].run(); palette.close(); } }
        else if (e.key === 'Escape')  { palette.close(); }
        // Stop bubbling so the reader doesn't think Ctrl+F etc. were pressed.
        e.stopPropagation();
      });
      paint();
      setTimeout(() => input.focus(), 20);
    },
    close() {
      document.querySelectorAll('.overlay').forEach(o => o.remove());
    },
  };

  function registerCommand(cmd) {
    if (!cmd || typeof cmd.run !== 'function') return;
    state.cmds.push(Object.assign({ g: 'Reader', ic: '·', name: '', hint: '' }, cmd));
  }
  function clearCommands() { state.cmds = []; }

  // ── Right-click context menu ────────────────────────────────────────────
  // contextMenu(items, x, y) — positioned popup that reuses the .ui-menu
  // glass styling. Items: { label, icon?, hint?, active?, disabled?, run } or
  // { separator: true }. Closes on outside click, Esc, or another right-click.
  function contextMenu(items, x, y) {
    document.querySelectorAll('.ui-menu.ctx-menu').forEach(m => m.remove());
    items = (items || []).filter(Boolean);
    if (!items.length) return null;
    const prevFocus = document.activeElement;

    const m = document.createElement('div');
    m.className = 'ui-menu ctx-menu';
    items.forEach(it => {
      if (it.separator) {
        const s = document.createElement('div');
        s.className = 'ui-menu-sep';
        m.appendChild(s);
        return;
      }
      const row = document.createElement('div');
      row.className = 'ui-menu-item' + (it.active ? ' active' : '') + (it.disabled ? ' disabled' : '');
      if (it.title) row.title = it.title;
      row.innerHTML =
        (it.icon ? `<span class="gl">${it.icon}</span>` : '<span class="gl"></span>') +
        `<span class="lab">${escapeHtml(it.label || '')}</span>` +
        (it.hint ? `<span class="hint">${escapeHtml(it.hint)}</span>` : '');
      if (!it.disabled && typeof it.run === 'function') {
        row.addEventListener('click', () => { close(); it.run(); });
      }
      m.appendChild(row);
    });

    document.body.appendChild(m);
    // Position clamped to viewport; flip up/left if it would overflow.
    const mw = m.offsetWidth || 220;
    const mh = m.offsetHeight || 100;
    const left = Math.min(Math.max(8, x), window.innerWidth - mw - 8);
    let top = y + 4;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, y - mh - 4);
    m.style.top = top + 'px';
    m.style.left = left + 'px';

    function close() {
      if (!m.parentNode) return;
      const refocus = m.contains(document.activeElement);
      m.classList.add('closing');
      setTimeout(() => m.remove(), 150);
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', esc, true);
      document.removeEventListener('contextmenu', anotherCtx, true);
      if (refocus && prevFocus && prevFocus.focus) prevFocus.focus();
    }
    function outside(e) { if (!m.contains(e.target)) close(); }
    function esc(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
    function anotherCtx(e) { if (!m.contains(e.target)) close(); }
    installMenuA11y(m, close, prevFocus);
    setTimeout(() => {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', esc, true);
      document.addEventListener('contextmenu', anotherCtx, true);
    }, 0);
    return m;
  }

  // contextDetect(e, rootEl) — classify the right-click target into a context
  // object. Used by reader-specific factories to branch their menu items.
  function contextDetect(e, rootEl) {
    const target = e.target;
    const ctx = { target, kind: 'plain' };

    // Annotation hotspot (PDF) — checked first, most specific.
    const annot = target && target.closest && target.closest('.annot-hotspot, .anno-hl, .anno-note, .doc-comment');
    if (annot) { ctx.kind = 'annotation'; ctx.annot = annot; return ctx; }

    // Link
    const link = target && target.closest && target.closest('a[href]');
    if (link) { ctx.kind = 'link'; ctx.link = link; ctx.href = link.href; return ctx; }

    // Image inside the document
    if (target && (target.tagName === 'IMG' || target.tagName === 'CANVAS')) {
      ctx.kind = 'image'; ctx.image = target; return ctx;
    }

    // Selection (must intersect rootEl)
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      const anchor = sel.anchorNode;
      if (anchor && (!rootEl || rootEl.contains(anchor) || rootEl.contains(target))) {
        const text = String(sel).trim();
        if (text) { ctx.kind = 'text'; ctx.text = text; ctx.selection = sel; return ctx; }
      }
    }

    return ctx;
  }

  // bindContextMenu(root, factory) — register a per-reader factory. The
  // document-level dispatcher (below) walks bindings and uses the first whose
  // root contains the target. Returns an unregister function — readers call
  // it in unmount to clean up (also auto-cleared on goHome / openDoc).
  function bindContextMenu(root, factory) {
    if (!root || typeof factory !== 'function') return () => {};
    const entry = { root, factory };
    state.ctxBindings.push(entry);
    return () => {
      const i = state.ctxBindings.indexOf(entry);
      if (i !== -1) state.ctxBindings.splice(i, 1);
    };
  }

  // Single document-level contextmenu listener. Walks bindings; first one that
  // contains the target wins. Shift+Right-Click bypasses ours and lets the
  // native browser menu through (escape hatch for spell-check etc.).
  document.addEventListener('contextmenu', (e) => {
    if (e.shiftKey) return;
    for (let i = state.ctxBindings.length - 1; i >= 0; i--) {     // newest first
      const { root, factory } = state.ctxBindings[i];
      if (!root.contains(e.target)) continue;
      let items;
      try { items = factory(contextDetect(e, root), e); }
      catch (err) { console.error('context-menu factory failed', err); items = null; }
      if (items && items.length) {
        e.preventDefault();
        contextMenu(items, e.clientX, e.clientY);
        return;
      }
    }
  });

  // ── rail (always-present left column) ────────────────────────────────────
  function buildRail() {
    const items = [
      { k: 'home',   tip: 'Home' },
      { k: 'pdf',    tip: 'PDF' },
      { k: 'comic',  tip: 'Comic' },
      { k: 'ebook',  tip: 'eBook' },
      { k: 'office', tip: 'Office' },
      { k: 'text',   tip: 'Text / Code' },
      { k: 'image',  tip: 'Image' },
    ];
    el.rail.innerHTML = '';
    // Brand mark at the top of the rail
    const mark = document.createElement('div');
    mark.className = 'rail-mark';
    mark.innerHTML = `<img src="/static/assets/logo-mark.png" alt="YancoRead">`;
    el.rail.appendChild(mark);
    items.forEach(it => {
      const b = document.createElement('button');
      b.className = 'rail-btn';
      b.dataset.kind = it.k;
      b.title = it.tip;
      b.innerHTML = icon(it.k) + `<span class="rail-tip">${it.tip}</span>`;
      b.addEventListener('click', () => {
        if (it.k === 'home') { goHome(); return; }
        browseAndOpenKind(it.k);
      });
      el.rail.appendChild(b);
    });
    const sp = document.createElement('div'); sp.className = 'rail-spacer';
    el.rail.appendChild(sp);
    const gear = document.createElement('button');
    gear.className = 'rail-btn'; gear.title = 'Settings';
    gear.innerHTML = icon('gear') + `<span class="rail-tip">Settings</span>`;
    gear.addEventListener('click', () => YR.openSettings && YR.openSettings());
    el.rail.appendChild(gear);
  }
  function syncRail() {
    const kind = (state.doc && state.doc.kind) || 'home';
    el.rail.querySelectorAll('.rail-btn[data-kind]').forEach(b => {
      b.classList.toggle('on', b.dataset.kind === kind);
    });
  }

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

  // Preferences are debounced and coalesced per kind. The backend merges
  // partials and rewrites userdata.json on every POST, so an un-debounced call
  // from a slider's `input` handler (brightness, contrast, adjust…) used to fire
  // one synchronous disk-writing request per pixel of drag — a real source of
  // stutter. Now rapid changes collapse into a single write 400ms after the last.
  function savePrefs(kind, prefs) {
    const pend = (state.pendingPrefs[kind] = state.pendingPrefs[kind] || {});
    Object.assign(pend, prefs);
    clearTimeout(state.prefsTimer);
    state.prefsTimer = setTimeout(flushPrefs, 400);
  }
  function flushPrefs() {
    clearTimeout(state.prefsTimer);
    const all = state.pendingPrefs;
    state.pendingPrefs = {};
    for (const kind in all) postJSON('/api/prefs', { kind, prefs: all[kind] }).catch(() => {});
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
    const prevFocus = document.activeElement;
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
      if (prevFocus && prevFocus.focus) prevFocus.focus();   // restore focus
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
    function onKey(e) {                            // Tab-trap is handled globally
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

    // Drive the per-mode accent channel — one attribute re-themes everything.
    el.app.dataset.mode = doc.kind || 'home';

    el.docTitle.textContent = doc.name;
    el.docKind.textContent = labelForDoc(doc);
    el.docKind.classList.remove('hidden');
    el.btnHome.title = 'Back to library';
    document.title = doc.name + ' — YancoRead';

    setTools([]);
    setHeaderActions([]);
    sidebar.available(false);
    sidebar.hide();
    rpanel.clear();                            // right panel closed by default
    el.home.classList.add('hidden');
    el.root.classList.remove('hidden');
    el.root.innerHTML = '';
    syncRail();

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
    flushPrefs();
    closeBookmarkPop();
    if (state.reader && typeof state.reader.unmount === 'function') {
      try { state.reader.unmount(); } catch (e) { console.error(e); }
    }
    state.reader = null;
    state.leaveGuard = null;
    clearCommands();
    state.ctxBindings = [];                  // drop per-reader right-click factories
    // Tear down any per-reader bottom bar.
    document.querySelectorAll('#stage > .bottombar, #stage > .cine').forEach(n => n.remove());
  }

  function goHome() {
    if (!confirmLeave()) return;
    unmountCurrent();
    state.doc = null;
    el.app.dataset.mode = 'home';
    document.title = 'YancoRead';
    el.docKind.classList.add('hidden');
    el.docTitle.textContent = '';
    el.btnHome.title = 'Home';
    setTools([]);
    setHeaderActions([]);
    sidebar.available(false);
    sidebar.hide();
    rpanel.clear();
    el.root.classList.add('hidden');
    el.root.innerHTML = '';
    el.home.classList.remove('hidden');
    syncRail();
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
    card.dataset.kind = r.kind || '';
    const pct = Math.round((r.progress || 0) * 100);
    card.innerHTML = `
      <div class="recent-cover">
        <span class="kind-chip">${KIND_LABEL[r.kind] || r.kind}</span>
        <span class="cov-glyph">${KIND_ICON[r.kind] || '📄'}</span>
        ${pct ? `<div class="recent-progress"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      <div class="recent-meta"><div class="recent-name">${escapeHtml(r.name)}</div></div>
      <button class="recent-remove" title="Remove">✕</button>`;
    // Apply per-kind hue to the card so the cover glows in its mode color.
    const hue = MODE_COLORS[r.kind];
    if (hue) {
      card.style.setProperty('--mode', hue);
      card.style.setProperty('--mode-glow', hue + '4d');
      card.style.setProperty('--mode-soft', hue + '22');
      card.style.setProperty('--border-mode', hue + '80');
    }
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
  // Kind-filtered open (used by the left rail tiles). Falls back to the
  // unfiltered dialog when the Api is older (running pre-P5f window.py).
  async function browseAndOpenKind(kind) {
    const api = window.pywebview && window.pywebview.api;
    if (api && api.browse_file_kind) {
      try {
        const path = await api.browse_file_kind(kind);
        if (path) openFile(path);
      } catch (e) { toast('File dialog failed', 'error'); }
    } else {
      browseAndOpen();
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
    el.app = document.getElementById('app');
    el.tools = document.getElementById('tb-tools');
    el.actions = document.getElementById('tb-actions');
    el.actionsSep = document.getElementById('tb-actions-sep');
    el.sidebar = document.getElementById('sidebar');
    el.rpanel = document.getElementById('rpanel');
    el.rail = document.getElementById('rail');
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

    // Replace the unicode glyphs in the static topbar buttons with Lucide-style
    // SVGs — the characters render unevenly inside the hex tiles.
    el.btnHome.innerHTML = `<span>${glyph('home', 18)}</span>`;
    el.btnSidebar.innerHTML = `<span>${glyph('sidebar', 18)}</span>`;
    el.btnOpen.innerHTML = `<span>${glyph('plus', 18)}</span>`;
    el.btnSettings.innerHTML = `<span>${glyph('gear', 18)}</span>`;
    el.btnFull.innerHTML = `<span>${glyph('expand', 18)}</span>`;

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
      flushPosition(); flushPrefs();   // don't lose a debounced position/pref on exit
      if (leaveMessage()) { e.preventDefault(); e.returnValue = ''; return ''; }
    });

    // The NATIVE window close (X / Alt-F4 / File→Exit) can't call back into JS —
    // pywebview's close runs on the GUI thread, so an evaluate_js from there would
    // deadlock. Instead we PUSH the unsaved-changes flag to the backend, which the
    // close handler reads over HTTP. Report on change (cheap 1s poll) and flush
    // the debounced position/prefs when the window is hidden/closing.
    let _lastDirty = null;
    function reportDirty(force) {
      const d = !!leaveMessage();
      if (d === _lastDirty && !force) return;
      _lastDirty = d;
      postJSON('/api/ui-state', { dirty: d }).catch(() => {});
    }
    setInterval(reportDirty, 1000);
    reportDirty(true);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { flushPosition(); flushPrefs(); reportDirty(true); }
    });
    window.addEventListener('pagehide', () => { flushPosition(); flushPrefs(); });

    // ── Global keyboard map ────────────────────────────────────────────────
    document.addEventListener('keydown', e => {
      // Skip when typing in an input/textarea/contentEditable (let the field own it).
      const ae = document.activeElement;
      const isTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable);
      const meta = e.metaKey || e.ctrlKey;
      // Esc closes overlays / popovers — even when typing.
      if (e.key === 'Escape') {
        const overlay = document.querySelector('.overlay');
        if (overlay) { palette.close(); e.preventDefault(); return; }
        if (document.querySelector('.bm-pop')) { closeBookmarkPop(); e.preventDefault(); return; }
      }
      if (isTyping) return;
      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault(); palette.open();
      } else if (meta && e.key.toLowerCase() === 'b') {
        e.preventDefault(); sidebar.toggle();
      } else if (meta && e.key.toLowerCase() === 'j') {
        e.preventDefault(); rpanel.toggle();
      }
      // NOTE: Ctrl+F is intentionally NOT bound here — readers own their find.
    });

    buildRail();
    syncRail();
    el.app.dataset.mode = 'home';

    wireDragDrop();
    loadRecent();

    // Re-fit the toolbar on window resize (debounced via rAF).
    let resizeRAF = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(resizeRAF);
      resizeRAF = requestAnimationFrame(refitTools);
    });

    // Auto-open a file passed on the command line (double-click / "Open with").
    getJSON('/api/launch-file').then(d => { if (d.path) openFile(d.path); }).catch(() => {});
  }

  // ── public surface ────────────────────────────────────────────────────────
  // ── in-place DOM translation (office + text readers) ──────────────────────
  // These readers render to HTML, so "translation" is a geometry-free swap of
  // each block's text — no overlay. makeTranslateTool returns toolbar widgets
  // (language picker + a toggle) bound to a controller that walks the innermost
  // block elements, translates them via /api/translate/blocks, swaps the text in
  // place (storing the original HTML), and restores it on toggle-off.
  const TRANSLATE_BLOCK_SEL =
    'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd, figcaption, caption';
  const TRANSLATE_LANGS = ['Arabic', 'English', 'French', 'Spanish', 'German',
    'Italian', 'Japanese', 'Korean', 'Chinese', 'Portuguese', 'Russian', 'Turkish'];

  function makeTranslateTool(getRoot) {
    let on = false, busy = false, seq = 0, target = 'Arabic', btn = null;

    const leafBlocks = (root) =>
      Array.from(root.querySelectorAll(TRANSLATE_BLOCK_SEL)).filter(el =>
        (el.textContent || '').trim() && !el.querySelector(TRANSLATE_BLOCK_SEL));

    function restore(root) {
      root.querySelectorAll('[data-tx-orig]').forEach(el => {
        el.innerHTML = el.dataset.txOrig;
        // Restore the element's OWN original dir + inline text-align (a docx
        // paragraph may carry text-align:center) instead of blanking them.
        if (el.dataset.txDir) el.setAttribute('dir', el.dataset.txDir);
        else el.removeAttribute('dir');
        el.style.textAlign = el.dataset.txAlign || '';
        delete el.dataset.txOrig;
        delete el.dataset.txDir;
        delete el.dataset.txAlign;
        if (!el.getAttribute('style')) el.removeAttribute('style');
      });
    }
    function syncBtn() {
      if (!btn) return;
      btn.classList.toggle('active', on || busy);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    async function translateNow() {
      const root = getRoot();
      if (!root) { on = false; syncBtn(); return; }
      const my = ++seq;
      const rtl = /arab/i.test(target);
      const els = leafBlocks(root);
      const blocks = [];
      els.forEach((el, i) => {
        if (!el.dataset.txId) el.dataset.txId = 'tx' + i;
        blocks.push({ id: el.dataset.txId, text: el.textContent });
      });
      if (!blocks.length) { toast('No text to translate here', '', 1800); on = false; syncBtn(); return; }
      busy = true; syncBtn(); toast('Translating…', '', 1400);
      let res;
      try {
        res = await postJSON('/api/translate/blocks', { blocks, target, source: 'auto' });
      } catch (e) {
        if (my !== seq) return;   // superseded (lang change / toggled off / unmounted) — stay silent
        busy = false; on = false; syncBtn();
        toast('Translation failed: ' + (e.message || ''), 'error');
        return;
      }
      if (my !== seq) return;     // superseded success — leave the live request's state alone
      busy = false;
      if (!on) { syncBtn(); return; }   // toggled off mid-flight
      const byId = {};
      (res.translations || []).forEach(t => { byId[t.id] = t.t; });
      els.forEach(el => {
        const tr = byId[el.dataset.txId];
        if (tr == null) return;
        if (el.dataset.txOrig == null) {
          el.dataset.txOrig = el.innerHTML;                    // lossless restore
          el.dataset.txDir = el.getAttribute('dir') || '';     // snapshot own dir + align
          el.dataset.txAlign = el.style.textAlign || '';
        }
        el.textContent = tr;
        if (rtl) { el.dir = 'rtl'; el.style.textAlign = 'start'; }
        else {
          // LTR target: keep the document's own dir/align rather than blanking it.
          if (el.dataset.txDir) el.setAttribute('dir', el.dataset.txDir);
          else el.removeAttribute('dir');
          el.style.textAlign = el.dataset.txAlign || '';
        }
      });
      syncBtn();
    }
    function disable() {
      on = false; busy = false; seq++;   // reset busy so a re-enable click isn't swallowed
      const root = getRoot();
      if (root) restore(root);
      syncBtn();
    }
    function toggle() {
      if (on || busy) disable();
      else { on = true; translateNow(); }
    }
    const sel = ui.select({
      title: 'Translation language', value: target,
      options: TRANSLATE_LANGS.map(l => ({ value: l, label: l })),
      onChange: (v) => {
        target = v;
        if (on) { const root = getRoot(); if (root) restore(root); translateNow(); }
      },
    });
    btn = ui.btn({ icon: '🌐', label: 'Translate', title: 'Translate the document text in place', onClick: toggle });
    syncBtn();
    return { items: [sel, btn], disable, isOn: () => on };
  }

  window.YR = {
    init, openFile, openDoc, goHome,
    toast, ui, setTools, setHeaderActions, sidebar, rpanel, makeTranslateTool,
    bottomBar,
    openPalette: () => palette.open(),
    registerCommand, clearCommands,
    contextMenu, bindContextMenu, contextDetect,
    icon, glyph, MODE_COLORS,
    getJSON, postJSON, escapeHtml,
    stageLoading, stageError,
    savePosition, flushPosition, savePrefs, flushPrefs,
    makeBookmarkTool,
    setLeaveGuard(fn) { state.leaveGuard = (typeof fn === 'function') ? fn : null; },
    // Used by the native window's close handler (window.py) to prompt before
    // discarding unsaved edits on an OS-level close / File ▸ Exit.
    hasUnsavedChanges() { return !!leaveMessage(); },
    KIND_LABEL, KIND_ICON,
    readers: {},
    registerReader(kind, impl) { this.readers[kind] = impl; },
    get root() { return el.root; },
    get doc() { return state.doc; },
    showAbout() { toast('YancoRead — universal document reader · YancoVerse', '', 4500); },
  };
})();
