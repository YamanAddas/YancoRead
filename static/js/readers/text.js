/* YancoRead — Text / Markdown / code reader + tool profile */
(function () {
  'use strict';

  function ensurePygmentsCss(css) {
    if (!css) return;
    let style = document.getElementById('yr-pygments');
    if (!style) {
      style = document.createElement('style');
      style.id = 'yr-pygments';
      document.head.appendChild(style);
    }
    style.textContent = css;
  }

  function mount(doc) {
    const path = doc.path;
    const name = doc.name || path.split(/[\\/]/).pop();
    const prefs = Object.assign({ theme: 'dark', wrap: true, zoom: 1.0 }, doc.prefs || {});
    const S = { zoom: prefs.zoom || 1.0, wrap: prefs.wrap !== false, theme: prefs.theme, mode: null, raw: false, data: null,
                marks: [], markIdx: 0, find: { open: false, term: '', caseSensitive: false, regex: false },
                taRanges: [], taIdx: -1,
                editing: false, dirty: false, source: '', meta: {}, editor: null, preview: null,
                dataKind: null, dataView: false,
                sideMode: 'outline', outline: [] };

    const root = YR.root;
    root.style.position = 'relative';   // anchor the floating find bar
    YR.stageLoading('Loading…');
    const scroller = document.createElement('div');
    scroller.style.height = '100%';
    scroller.style.overflow = 'auto';

    YR.getJSON(`/api/text?path=${encodeURIComponent(path)}`).then(data => {
      S.data = data; S.mode = data.mode;
      S.source = data.raw != null ? data.raw : '';
      S.meta = { editable: !!data.editable, eol: data.eol || 'lf',
                 encoding: data.encoding || 'utf-8', bom: !!data.bom };
      if (data.css) ensurePygmentsCss(data.css);
      S.dataKind = detectDataKind();
      S.dataView = !!S.dataKind;          // open data files in their smart view
      root.innerHTML = '';
      root.appendChild(scroller);
      renderContent();
      buildTools();
      S.outline = data.mode === 'markdown' ? (data.outline || []) : [];
      S.sideMode = data.mode === 'markdown' ? 'outline' : 'ai';
      buildSidebar();
      if (data.truncated) YR.toast('Large file — showing the first part only.', '', 4000);
      const start = (doc.position && doc.position.scroll) || 0;
      if (start) scroller.scrollTop = start;
      scroller.addEventListener('scroll', onScroll, { passive: true });
    }).catch(e => YR.stageError(e.message || 'Could not read file'));

    function renderContent() {
      closeSelBubble();
      const d = S.data;
      let jsonVal, dataTable;
      if (S.dataView && S.dataKind === 'json') {
        const parsed = parseJSONLoose(S.source);
        if (parsed.ok) jsonVal = parsed;
        else { S.dataView = false; YR.toast("Couldn't parse JSON — showing source", '', 2600); }
      } else if (S.dataView && (S.dataKind === 'csv' || S.dataKind === 'tsv')) {
        const rows = parseDelimited(S.source, S.dataKind === 'tsv' ? '\t' : ',');
        if (rows.length) dataTable = buildDataTable(rows);
        else S.dataView = false;   // empty file → fall through to the source view
      }
      if (jsonVal) {
        scroller.innerHTML = '';
        scroller.appendChild(buildJSONTree(jsonVal.value));
      } else if (dataTable) {
        scroller.innerHTML = '';
        scroller.appendChild(dataTable);
      } else if (d.mode === 'markdown') {
        scroller.innerHTML = S.raw
          ? `<pre class="plain-text${S.wrap ? '' : ' nowrap'}">${YR.escapeHtml(d.raw || '')}</pre>`
          : d.html;
        const article = scroller.querySelector('.doc-page');
        if (article) article.classList.toggle('theme-dark', S.theme === 'dark');
      } else if (d.mode === 'code') {
        scroller.innerHTML = `<div class="code-wrap ${S.wrap ? 'wrap' : 'nowrap'}">${d.html}</div>`;
      } else {
        scroller.innerHTML = `<pre class="plain-text${S.wrap ? '' : ' nowrap'}">${stripPre(d.html)}</pre>`;
      }
      scroller.style.zoom = S.zoom;
      addCopyButtons();
      // A re-render drops any <mark>s; re-run an open search on the fresh DOM.
      S.marks = []; S.markIdx = 0;
      if (S.find.open && S.find.term) runFind(S.find.term);
    }
    function stripPre(html) {
      // backend already returns <pre class=plain-text>…</pre>; reuse inner if so
      const m = html.match(/^<pre[^>]*>([\s\S]*)<\/pre>$/);
      return m ? m[1] : html;
    }

    let scrollTimer;
    function onScroll() {
      closeSelBubble();           // a floating selection bubble would drift on scroll
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const max = scroller.scrollHeight - scroller.clientHeight;
        YR.savePosition({ scroll: scroller.scrollTop }, max ? scroller.scrollTop / max : 0);
      }, 250);
    }

    // ── tools ─────────────────────────────────────────────────────────────
    let zoomLabel;
    function setZoom(z) {
      S.zoom = Math.max(0.5, Math.min(3, z));
      scroller.style.zoom = S.zoom;
      zoomLabel.textContent = Math.round(S.zoom * 100) + '%';
      YR.savePrefs('text', { zoom: S.zoom });
    }
    function buildTools() {
      zoomLabel = YR.ui.label(Math.round(S.zoom * 100) + '%');

      // LEFT lane — View ▾ groups zoom, wrap, theme/raw (md), tree/format/minify
      // (json), table (csv). Items appear conditionally based on file kind +
      // edit state so the same menu serves every mode.
      const viewMenu = YR.ui.menu({
        icon: YR.glyph('view'), label: 'View',
        title: 'Zoom, wrap, theme, data views',
        items: () => {
          const items = [
            { icon: '＋', label: 'Zoom in',         run: () => setZoom(S.zoom + 0.1) },
            { icon: '－', label: 'Zoom out',        run: () => setZoom(S.zoom - 0.1) },
            { icon: '1', label: 'Reset to 100%',   run: () => setZoom(1.0) },
          ];
          if (S.editing || S.mode === 'code' || S.mode === 'plain') {
            items.push({ separator: true });
            items.push({ icon: '⏎', label: 'Word wrap', active: S.wrap, run: () => {
              S.wrap = !S.wrap; YR.savePrefs('text', { wrap: S.wrap });
              if (S.editing && S.editor) S.editor.classList.toggle('nowrap', !S.wrap);
              else renderContent();
            } });
          }
          if (S.mode === 'markdown') {
            items.push({ separator: true });
            if (!S.editing) {
              items.push({ icon: '📝', label: 'Raw source', active: S.raw, run: () => { S.raw = !S.raw; renderContent(); } });
            }
            items.push({ icon: '🌙', label: 'Dark theme',  active: S.theme === 'dark',  run: () => { S.theme = 'dark'; YR.savePrefs('text', { theme: 'dark' }); if (S.editing) renderPreview(); else renderContent(); } });
            items.push({ icon: '☀', label: 'Light theme', active: S.theme === 'light', run: () => { S.theme = 'light'; YR.savePrefs('text', { theme: 'light' }); if (S.editing) renderPreview(); else renderContent(); } });
            if (S.editing) {
              items.push({ icon: '⊞', label: 'Tidy pipe tables', run: tidyTablesAction });
            }
          }
          if (S.dataKind === 'json') {
            items.push({ separator: true });
            if (!S.editing) {
              items.push({ icon: '🌳', label: 'Tree view',  active: S.dataView, run: () => { S.dataView = !S.dataView; renderContent(); } });
            }
            if (S.data && S.data.editable) {
              items.push({ icon: '✨', label: 'Format JSON', run: () => jsonReformat(false) });
              items.push({ icon: '⤓', label: 'Minify JSON', run: () => jsonReformat(true) });
            }
          }
          if (S.dataKind === 'csv' || S.dataKind === 'tsv') {
            items.push({ separator: true });
            if (!S.editing) {
              items.push({ icon: '▦', label: 'Table view', active: S.dataView, run: () => { S.dataView = !S.dataView; renderContent(); } });
            }
          }
          return items;
        },
      });

      // CENTER lane — Find + (Edit / Save / Save As / Done depending on state).
      const center = [
        YR.ui.btn({ icon: YR.glyph('search'), title: 'Find & replace (Ctrl+F)', onClick: openFind }),
      ];
      if (S.data && S.data.editable) {
        if (!S.editing) {
          center.push(YR.ui.btn({ icon: YR.glyph('edit'), label: 'Edit', title: 'Edit this file', onClick: enterEdit }));
        } else {
          saveBtn = YR.ui.btn({ icon: YR.glyph('save'), label: 'Save', title: 'Save (Ctrl+S)', onClick: save });
          if (S.dirty) saveBtn.classList.add('tb-dirty');
          center.push(saveBtn);
          center.push(YR.ui.btn({ label: 'Save As…', title: 'Save a copy', onClick: saveAs }));
          center.push(YR.ui.btn({ icon: '✓', label: 'Done', title: 'Finish editing', onClick: exitEdit }));
        }
      }
      if (!S.editing && S.mode === 'code' && S.data.lang) {
        center.push(YR.ui.label(S.data.lang));
      }

      YR.setTools([
        viewMenu, zoomLabel,                       // LEFT
        YR.ui.sep(),
        ...center,                                  // CENTER
        YR.ui.sep(),
        YR.ui.btn({ icon: '⤓', label: 'Export', title: 'Export & word count', onClick: openExport }),  // RIGHT
      ]);
      YR.setHeaderActions([
        YR.ui.btn({ icon: YR.glyph('sparkles'), label: 'AI', title: 'AI assistant', onClick: () => toggleAIRpanel() }),
      ]);
    }

    // ── sidebar (Outline only — for Markdown) + AI rpanel ──────────────────
    const sideWrap = document.createElement('div');
    sideWrap.className = 'doc-side';
    function buildSidebar() {
      if (S.mode !== 'markdown') return;        // non-markdown has no sidebar
      YR.sidebar.available(true);
      YR.sidebar.set(sideWrap);
      renderSide();
    }
    function setOutline(list) {
      S.outline = list || [];
      if (S.mode === 'markdown') renderSide();
    }
    function renderSide() {
      sideWrap.innerHTML = '<div class="doc-side-body"></div>';
      renderOutline(sideWrap.querySelector('.doc-side-body'));
    }

    // AI rpanel (replaces the old sidebar AI tab)
    let aiWrap = null;
    function mountAIRpanel() {
      aiWrap = document.createElement('div');
      aiWrap.style.display = 'flex';
      aiWrap.style.flexDirection = 'column';
      aiWrap.style.height = '100%';
      aiWrap.innerHTML =
        '<div class="rp-head">' +
          '<div class="rp-icon">✦</div>' +
          '<div><div class="rp-title">AI Assistant</div>' +
            `<div class="rp-sub">${YR.escapeHtml(name)}</div></div>` +
          '<button class="rp-close" title="Close (Ctrl+J)">✕</button>' +
        '</div>' +
        '<div class="rp-body"></div>';
      aiWrap.querySelector('.rp-close').addEventListener('click', () => YR.rpanel.hide());
      renderAI(aiWrap.querySelector('.rp-body'));
      YR.rpanel.set(aiWrap);
    }
    function openAIRpanel() {
      mountAIRpanel();
      YR.rpanel.show();
      const q = aiWrap.querySelector('#ai-q'); if (q) q.focus();
    }
    function toggleAIRpanel() {
      if (YR.rpanel.isOpen() && aiWrap) { YR.rpanel.hide(); return; }
      openAIRpanel();
    }
    function renderOutline(body) {
      if (!S.outline.length) { body.innerHTML = '<div class="empty-recent">No headings in this file.</div>'; return; }
      body.innerHTML = '';
      S.outline.forEach(o => {
        if (!o.anchor) return;
        const b = document.createElement('button');
        b.className = 'outline-item';
        b.style.paddingLeft = (8 + ((o.level || 1) - 1) * 12) + 'px';
        b.textContent = o.title || '(untitled)';
        b.addEventListener('click', () => {
          const t = scroller.querySelector('#' + CSS.escape(o.anchor));
          if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        body.appendChild(b);
      });
    }

    // ── AI panel (uses the shared /api/ai backend) ───────────────────────────
    const AI_ACTIONS = [
      { task: 'summarize', label: 'Summarize' },
      { task: 'keypoints', label: 'Key points' },
      { task: 'simplify', label: 'Simplify' },
      { task: 'explain', label: 'Explain' },
      { task: 'rewrite', label: 'Improve' },
    ];
    function docText() { return S.source || ''; }
    function selectionText() {
      if (S.editing && S.editor) {   // prefer the textarea's own selection while editing
        const ta = S.editor;
        return (ta.selectionEnd > ta.selectionStart)
          ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
      }
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return '';
      return (sel.anchorNode && scroller.contains(sel.anchorNode)) ? String(sel) : '';
    }
    function renderAI(body) {
      const sel = selectionText();
      const scopeNote = sel.trim()
        ? '<div class="ai-scope">Working on your <b>selection</b> (' + sel.trim().length + ' chars)</div>'
        : '<div class="ai-scope">Working on the <b>whole file</b>. Select text first to target a passage.</div>';
      body.innerHTML = scopeNote +
        '<div class="ai-actions">' +
        AI_ACTIONS.map(a => '<button class="ai-act" data-task="' + a.task + '">' + a.label + '</button>').join('') +
        '</div>' +
        '<div class="ai-ask">' +
        '<input class="tb-input" id="ai-q" placeholder="Ask about this file…" />' +
        '<button class="ai-act" id="ai-ask-btn">Ask</button>' +
        '</div>' +
        '<div class="ai-output" id="ai-out"></div>';
      body.querySelectorAll('.ai-act[data-task]').forEach(b =>
        b.addEventListener('click', () => runAI(b.dataset.task, selectionText() || docText())));
      const q = body.querySelector('#ai-q');
      const ask = () => { const v = q.value.trim(); if (v) runAI('ask', selectionText() || docText(), v); };
      body.querySelector('#ai-ask-btn').addEventListener('click', ask);
      q.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') ask(); });
    }
    async function runAI(task, text, question) {
      if (!aiWrap) { openAIRpanel(); return; }
      YR.rpanel.show();
      const out = aiWrap.querySelector('#ai-out');
      if (!out) return;
      if (!text || !text.trim()) { out.innerHTML = '<div class="ai-err">No text available.</div>'; return; }
      out.innerHTML = '<div class="stage-loading" style="position:static;padding:18px"><div class="yr-spinner"></div></div>';
      try {
        const r = await YR.postJSON('/api/ai', { task, text, question });
        const result = r.result || '(no response)';
        out.innerHTML = '<div class="ai-result"></div><button class="ai-act ai-copy">⧉ Copy</button>';
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

    // ── selection AI bubble (floats by a selection; reuses /api/ai) ───────────
    let selBubble = null;
    const SEL_AI = [
      { task: 'translate', label: '🌐 Translate' },
      { task: 'explain', label: '💡 Explain' },
      { task: 'summarize', label: '✦ Summarize' },
    ];
    function closeSelBubble() { if (selBubble) { selBubble.remove(); selBubble = null; } }
    function selAnchorRect(e) {
      // The editor textarea exposes no DOM range for its selection — anchor at the
      // pointer where the drag ended; the rendered view uses the range's box.
      if (S.editing && S.editor && (e.target === S.editor || S.editor.contains(e.target))) {
        return { left: e.clientX, top: e.clientY, bottom: e.clientY, width: 0 };
      }
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r && (r.width || r.height)) return r;
      }
      return null;
    }
    function showSelBubble(rect, txt) {
      closeSelBubble();
      selBubble = document.createElement('div');
      selBubble.className = 'doc-selpop';
      selBubble.innerHTML =
        SEL_AI.map(a => '<button class="sp-btn" data-task="' + a.task + '">' + a.label + '</button>').join('') +
        '<button class="sp-btn" data-act="copy" title="Copy">⧉</button>';
      // Keep the selection alive while a button is pressed (don't steal focus / collapse it).
      selBubble.addEventListener('mousedown', e => e.preventDefault());
      document.body.appendChild(selBubble);
      const above = rect.top - selBubble.offsetHeight - 8;
      selBubble.style.top = (above < 8 ? rect.bottom + 8 : above) + 'px';
      const mid = rect.left + (rect.width || 0) / 2;
      selBubble.style.left =
        Math.max(8, Math.min(mid - selBubble.offsetWidth / 2,
                             window.innerWidth - selBubble.offsetWidth - 8)) + 'px';
      selBubble.querySelectorAll('.sp-btn[data-task]').forEach(b =>
        b.addEventListener('click', () => runAIFromSelection(b.dataset.task, txt)));
      selBubble.querySelector('[data-act="copy"]').addEventListener('click', () => {
        if (navigator.clipboard) navigator.clipboard.writeText(txt);
        YR.toast('Copied', '', 1200); closeSelBubble();
      });
    }
    function runAIFromSelection(task, txt) {
      closeSelBubble();
      const text = (txt || '').trim();
      if (!text) return;
      mountAIRpanel();
      YR.rpanel.show();
      runAI(task, text);      // fills #ai-out with the result
    }
    function onSelMouseUp(e) {
      if (selBubble && selBubble.contains(e.target)) return;   // a click on the bubble itself
      const txt = selectionText();
      if (!txt || !txt.trim()) { closeSelBubble(); return; }
      const rect = selAnchorRect(e);
      if (rect) showSelBubble(rect, txt); else closeSelBubble();
    }
    function selBubbleOutside(e) { if (selBubble && !selBubble.contains(e.target)) closeSelBubble(); }
    scroller.addEventListener('mouseup', e => setTimeout(() => onSelMouseUp(e), 10));
    document.addEventListener('mousedown', selBubbleOutside);

    // ── smart data views (JSON tree + format/minify) ─────────────────────────
    function detectDataKind() {
      const ext = (name.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
      if (ext === '.csv') return 'csv';
      if (ext === '.tsv') return 'tsv';
      if (ext === '.json' || ext === '.jsonc' || ext === '.json5') return 'json';
      // content sniff: a strict-JSON body in a non-data extension (e.g. .txt)
      const t = (S.source || '').trim();
      if (t && (t[0] === '{' || t[0] === '[')) {
        try { JSON.parse(t); return 'json'; } catch (e) { /* not JSON */ }
      }
      return null;
    }
    function parseJSONLoose(text) {
      try { return { ok: true, value: JSON.parse(text) }; } catch (e1) { /* try jsonc */ }
      try {
        const s = stripJsonComments(String(text)).replace(/,(\s*[}\]])/g, '$1'); // drop trailing commas
        return { ok: true, value: JSON.parse(s) };
      } catch (e2) { return { ok: false, error: e2.message }; }
    }
    // Remove // line and /* */ block comments, but never inside string literals.
    function stripJsonComments(src) {
      let out = '', i = 0; const n = src.length;
      let inStr = false, q = '', esc = false;
      while (i < n) {
        const c = src[i], d = src[i + 1];
        if (inStr) {
          out += c;
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === q) inStr = false;
          i++; continue;
        }
        if (c === '"' || c === "'") { inStr = true; q = c; out += c; i++; continue; }
        if (c === '/' && d === '/') { i += 2; while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
        out += c; i++;
      }
      return out;
    }
    function buildJSONTree(value) {
      const root = document.createElement('div');
      root.className = 'json-tree-wrap';
      const tree = document.createElement('div');
      tree.className = 'json-tree';
      tree.appendChild(jsonNode(value, null, false));
      root.appendChild(tree);
      return root;
    }
    function jsonNode(value, key, isIndex) {
      const node = document.createElement('div');
      node.className = 'jt-node';
      const t = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
      const keyHtml = key === null ? '' :
        `<span class="jt-key${isIndex ? ' jt-index' : ''}">${YR.escapeHtml(String(key))}</span><span class="jt-colon">:</span> `;
      if (t === 'object' || t === 'array') {
        const entries = t === 'array'
          ? value.map((v, i) => [i, v, true])
          : Object.keys(value).map(k => [k, value[k], false]);
        const o = t === 'array' ? '[' : '{', c = t === 'array' ? ']' : '}';
        if (entries.length === 0) {
          const row = document.createElement('div');
          row.className = 'jt-row jt-leaf';
          row.innerHTML = keyHtml + `<span class="jt-punc">${o}${c}</span>`;
          node.appendChild(row);
          return node;
        }
        const row = document.createElement('div');
        row.className = 'jt-row jt-branch';
        row.innerHTML =
          `<span class="jt-tog">▾</span>${keyHtml}<span class="jt-punc">${o}</span>` +
          `<span class="jt-more">… <span class="jt-punc">${c}</span></span>` +
          `<span class="jt-count">${entries.length} ${t === 'array' ? 'items' : 'keys'}</span>`;
        const kids = document.createElement('div');
        kids.className = 'jt-kids';
        entries.forEach(([k, v, idx]) => kids.appendChild(jsonNode(v, k, idx)));
        const foot = document.createElement('div');
        foot.className = 'jt-foot';
        foot.innerHTML = `<span class="jt-punc">${c}</span>`;
        row.addEventListener('click', e => {
          e.stopPropagation();
          const collapsed = node.classList.toggle('collapsed');
          row.querySelector('.jt-tog').textContent = collapsed ? '▸' : '▾';
        });
        node.appendChild(row); node.appendChild(kids); node.appendChild(foot);
      } else {
        const row = document.createElement('div');
        row.className = 'jt-row jt-leaf';
        const disp = t === 'string' ? JSON.stringify(value) : String(value);
        row.innerHTML = keyHtml + `<span class="jt-val jt-${t}">${YR.escapeHtml(disp)}</span>`;
        node.appendChild(row);
      }
      return node;
    }
    function jsonReformat(minify) {
      const parsed = parseJSONLoose(S.source);
      if (!parsed.ok) {
        YR.toast("Invalid JSON — can't " + (minify ? 'minify' : 'format'), 'error', 3200);
        return;
      }
      const next = minify ? JSON.stringify(parsed.value) : JSON.stringify(parsed.value, null, 2);
      S.source = next;
      if (S.editing && S.editor) {
        S.editor.value = next;
        S.editor.setSelectionRange(0, 0);
        markDirty();
      } else {
        S.dataView = false;       // drop into the editor so the result is visible + saveable
        enterEdit();              // renders the textarea from the now-reformatted source
        markDirty();
      }
      YR.toast(minify ? 'Minified — Ctrl+S to save' : 'Formatted — Ctrl+S to save', 'success', 2200);
    }

    // CSV/TSV → rows. RFC-4180-ish: quoted fields, "" escapes, embedded
    // delimiters/newlines, and CRLF / lone-CR / LF row terminators.
    function parseDelimited(text, delim) {
      const s = String(text), n = s.length, rows = [];
      let row = [], field = '', i = 0, inQ = false;
      while (i < n) {
        const c = s[i];
        if (inQ) {
          if (c === '"') {
            if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
            inQ = false; i++; continue;
          }
          field += c; i++; continue;
        }
        if (c === '"') { inQ = true; i++; continue; }
        if (c === delim) { row.push(field); field = ''; i++; continue; }
        if (c === '\r') { row.push(field); rows.push(row); row = []; field = ''; i += (s[i + 1] === '\n' ? 2 : 1); continue; }
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
        field += c; i++;
      }
      if (field !== '' || row.length) { row.push(field); rows.push(row); }
      // a trailing newline leaves one stray single-empty-cell row — drop it
      const last = rows[rows.length - 1];
      if (last && last.length === 1 && last[0] === '') rows.pop();
      return rows;
    }
    function numVal(v) {
      if (v == null) return null;
      const s = String(v).trim().replace(/,/g, '');   // 1,234.5 → 1234.5
      if (s === '' || !/^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(s)) return null;
      const num = parseFloat(s);
      return isNaN(num) ? null : num;
    }
    function cmpCell(a, b) {
      const na = numVal(a), nb = numVal(b);
      if (na !== null && nb !== null) return na - nb;   // both numeric
      if (na !== null) return -1;                       // numbers before text
      if (nb !== null) return 1;
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    }
    function buildDataTable(rows) {
      const wrap = document.createElement('div');
      wrap.className = 'data-table-wrap';
      const table = document.createElement('table');
      table.className = 'data-table';
      const header = rows[0] || [];
      const body = rows.slice(1);
      let cols = header.length;
      body.forEach(r => { if (r.length > cols) cols = r.length; });

      const thead = document.createElement('thead');
      const htr = document.createElement('tr');
      const corner = document.createElement('th');
      corner.className = 'dt-rownum';
      corner.textContent = '#';
      htr.appendChild(corner);
      const sortState = { col: -1, dir: 1 };
      for (let ci = 0; ci < cols; ci++) {
        const th = document.createElement('th');
        const label = document.createElement('span');
        label.className = 'dt-th-label';
        label.textContent = header[ci] != null ? header[ci] : '';
        const arrow = document.createElement('span');
        arrow.className = 'dt-arrow';
        th.appendChild(label); th.appendChild(arrow);
        th.title = 'Sort by this column';
        th.addEventListener('click', () => sortBy(ci));
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      table.appendChild(tbody);

      function render(data) {
        const frag = document.createDocumentFragment();
        data.forEach((r, ri) => {
          const tr = document.createElement('tr');
          const num = document.createElement('td');
          num.className = 'dt-rownum';
          num.textContent = ri + 1;
          tr.appendChild(num);
          for (let ci = 0; ci < cols; ci++) {
            const td = document.createElement('td');
            td.textContent = r[ci] != null ? r[ci] : '';
            tr.appendChild(td);
          }
          frag.appendChild(tr);
        });
        tbody.innerHTML = '';
        tbody.appendChild(frag);
      }
      function sortBy(ci) {
        if (sortState.col === ci) sortState.dir = -sortState.dir;
        else { sortState.col = ci; sortState.dir = 1; }
        const dir = sortState.dir;
        const sorted = body.slice().sort((ra, rb) =>
          cmpCell(ra[ci] != null ? ra[ci] : '', rb[ci] != null ? rb[ci] : '') * dir);
        render(sorted);
        htr.querySelectorAll('.dt-arrow').forEach((el, idx) => {
          el.textContent = idx === ci ? (dir > 0 ? ' ▲' : ' ▼') : '';
        });
      }

      render(body);
      wrap.appendChild(table);
      return wrap;
    }

    // Tidy GitHub-style pipe tables in Markdown source: pad columns to equal
    // width and normalize the header separator, honouring :--- alignment.
    function tidyMarkdownTables(src) {
      const lines = String(src).split('\n');
      const out = [];
      let i = 0, fence = null, changed = 0;
      const hasPipe = (s) => s.indexOf('|') >= 0;
      const isSep = (s) => s.indexOf('-') >= 0 &&
        /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
      const fenceOf = (s) => (s.match(/^\s*(```+|~~~+)/) || [])[1];
      while (i < lines.length) {
        const line = lines[i];
        const fm = fenceOf(line);
        if (fm) {                                   // never touch fenced code
          if (!fence) fence = fm[0]; else if (line.indexOf(fence) >= 0) fence = null;
          out.push(line); i++; continue;
        }
        if (fence) { out.push(line); i++; continue; }
        if (hasPipe(line) && i + 1 < lines.length && hasPipe(lines[i + 1]) && isSep(lines[i + 1])) {
          const block = [line, lines[i + 1]];
          let j = i + 2;
          while (j < lines.length && hasPipe(lines[j]) && lines[j].trim() !== '' && !fenceOf(lines[j])) {
            block.push(lines[j]); j++;
          }
          const tidied = tidyOneTable(block);
          if (tidied) { out.push.apply(out, tidied); changed++; }
          else out.push.apply(out, block);
          i = j; continue;
        }
        out.push(line); i++;
      }
      return { text: out.join('\n'), count: changed };
    }
    function splitTableRow(s) {
      let t = s.trim();
      if (t.charAt(0) === '|') t = t.slice(1);
      if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
      const cells = []; let cur = '', k = 0;
      while (k < t.length) {
        if (t[k] === '\\' && t[k + 1] === '|') { cur += '\\|'; k += 2; continue; }
        if (t[k] === '|') { cells.push(cur); cur = ''; k++; continue; }
        cur += t[k]; k++;
      }
      cells.push(cur);
      return cells.map(x => x.trim());
    }
    function alignOf(cell) {
      const c = cell.trim(), l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
      return l && r ? 'center' : r ? 'right' : l ? 'left' : 'none';
    }
    function tidyOneTable(block) {
      const header = splitTableRow(block[0]);
      const aligns = splitTableRow(block[1]).map(alignOf);
      const body = block.slice(2).map(splitTableRow);
      let ncol = header.length;
      aligns.forEach((_, c) => { ncol = Math.max(ncol, c + 1); });
      body.forEach(r => { ncol = Math.max(ncol, r.length); });
      if (!ncol) return null;
      const pad = (a) => { while (a.length < ncol) a.push(''); return a; };
      pad(header); pad(aligns); body.forEach(pad);
      for (let c = 0; c < ncol; c++) if (!aligns[c]) aligns[c] = 'none';
      const width = [];
      for (let c = 0; c < ncol; c++) {
        let w = header[c].length;
        body.forEach(r => { w = Math.max(w, r[c].length); });
        width[c] = Math.max(w, 3);            // separators need ≥3 dashes
      }
      const cell = (txt, c) => {
        const space = width[c] - txt.length, a = aligns[c];
        if (a === 'right') return ' '.repeat(space) + txt;
        if (a === 'center') { const lft = Math.floor(space / 2); return ' '.repeat(lft) + txt + ' '.repeat(space - lft); }
        return txt + ' '.repeat(space);       // left / none
      };
      const sep = (c) => {
        const w = width[c], a = aligns[c];
        if (a === 'center') return ':' + '-'.repeat(w - 2) + ':';
        if (a === 'right') return '-'.repeat(w - 1) + ':';
        if (a === 'left') return ':' + '-'.repeat(w - 1);
        return '-'.repeat(w);
      };
      const row = (cells) => '| ' + cells.map(cell).join(' | ') + ' |';
      return [row(header), '| ' + aligns.map((a, c) => sep(c)).join(' | ') + ' |']
        .concat(body.map(row));
    }
    function tidyTablesAction() {
      if (!S.editor) return;
      const res = tidyMarkdownTables(S.source);
      if (!res.count) { YR.toast('No Markdown tables found', '', 2200); return; }
      const pos = Math.min(S.editor.selectionStart || 0, res.text.length);
      S.source = res.text;
      S.editor.value = res.text;
      try { S.editor.setSelectionRange(pos, pos); } catch (e) { /* noop */ }
      markDirty();
      schedulePreview();
      YR.toast('Tidied ' + res.count + (res.count === 1 ? ' table' : ' tables'), 'success', 1800);
    }

    // ── edit & save ─────────────────────────────────────────────────────────
    let saveBtn, previewTimer;
    function splitPath(p) {
      const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
      return { dir: i >= 0 ? p.slice(0, i) : '', base: i >= 0 ? p.slice(i + 1) : p };
    }
    function fileTypesFor() {
      if (S.mode === 'markdown') return ['Markdown (*.md)', 'Text (*.txt)', 'All files (*.*)'];
      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : '';
      if (ext) return [`${ext.slice(1).toUpperCase()} file (*${ext})`, 'All files (*.*)'];
      return ['Text (*.txt)', 'All files (*.*)'];
    }
    function markDirty() {
      if (S.dirty) return;
      S.dirty = true;
      if (saveBtn) saveBtn.classList.add('tb-dirty');
      YR.setLeaveGuard(() => S.dirty ? 'You have unsaved changes. Leave without saving?' : '');
    }
    function clearDirty() {
      S.dirty = false;
      if (saveBtn) saveBtn.classList.remove('tb-dirty');
      YR.setLeaveGuard(null);
    }
    function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 350); }
    function renderPreview() {
      if (!S.preview) return;
      YR.postJSON('/api/text/render', { content: S.source, name }).then(res => {
        if (!S.preview) return;
        S.preview.innerHTML = res.html || '';
        const a = S.preview.querySelector('.doc-page');
        if (a) a.classList.toggle('theme-dark', S.theme === 'dark');
      }).catch(() => {});
    }
    function renderEditor() {
      closeFind(); closeSelBubble();
      const split = (S.mode === 'markdown');
      scroller.innerHTML = '';
      scroller.style.zoom = S.zoom;
      const ta = document.createElement('textarea');
      ta.className = 'txt-editor' + (S.wrap ? '' : ' nowrap');
      ta.spellcheck = false;
      ta.value = S.source;
      S.editor = ta;
      ta.addEventListener('input', () => { S.source = ta.value; markDirty(); if (split) schedulePreview(); });
      ta.addEventListener('keydown', e => {
        if (e.key === 'Tab') {                         // insert two spaces, keep focus
          e.preventDefault();
          const s = ta.selectionStart, en = ta.selectionEnd;
          ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
          ta.selectionStart = ta.selectionEnd = s + 2;
          S.source = ta.value; markDirty(); if (split) schedulePreview();
        }
      });
      if (split) {
        const wrap = document.createElement('div'); wrap.className = 'txt-split';
        const left = document.createElement('div'); left.className = 'txt-pane'; left.appendChild(ta);
        const right = document.createElement('div'); right.className = 'txt-pane txt-preview';
        S.preview = right;
        wrap.appendChild(left); wrap.appendChild(right);
        scroller.appendChild(wrap);
        renderPreview();
      } else {
        S.preview = null;
        scroller.appendChild(ta);
      }
      ta.focus();
    }
    function refreshViewFromSource() {
      return YR.postJSON('/api/text/render', { content: S.source, name }).then(res => {
        S.data = Object.assign({}, S.data, res, { raw: S.source });
        S.mode = res.mode || S.mode;
        if (res.css) ensurePygmentsCss(res.css);
        renderContent();
        setOutline(res.mode === 'markdown' ? (res.outline || []) : []);
      }).catch(() => renderContent());
    }
    function enterEdit() {
      if (!S.meta.editable) { YR.toast('This file is too large to edit here.', '', 3200); return; }
      S.editing = true; S.preview = null; S.editor = null;
      renderEditor(); buildTools();
    }
    function exitEdit() {
      S.editing = false; S.preview = null; S.editor = null;
      closeFind();                       // drop the edit-mode replace row
      buildTools();
      refreshViewFromSource();
    }
    async function save() {
      if (!S.meta.editable) return;
      try {
        const r = await YR.postJSON('/api/text/save', {
          path, content: S.source, eol: S.meta.eol, encoding: S.meta.encoding, bom: S.meta.bom });
        clearDirty();
        YR.toast('Saved ' + (r.name || ''), 'success', 1800);
      } catch (e) { YR.toast(e.message || 'Could not save', 'error', 3200); }
    }
    async function saveAs() {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.save_file) { YR.toast('Save As needs the desktop app', '', 3200); return; }
      let target = null;
      try { target = await api.save_file(name, splitPath(path).dir, fileTypesFor()); } catch (e) { target = null; }
      if (!target) return;
      try {
        const r = await YR.postJSON('/api/text/save', {
          path, target, content: S.source, eol: S.meta.eol, encoding: S.meta.encoding, bom: S.meta.bom });
        clearDirty();
        YR.toast('Saved ' + (r.name || ''), 'success', 1800);
        if (r.path && r.path !== path) YR.openFile(r.path);   // continue in the new file
      } catch (e) { YR.toast(e.message || 'Could not save', 'error', 3200); }
    }

    // ── export & counts ──────────────────────────────────────────────────────
    let exportPop;
    function counts() {
      const s = S.source || '';
      return {
        words: (s.match(/\S+/g) || []).length,
        lines: s ? s.split(/\r\n|\r|\n/).length : 0,
        chars: s.length,
      };
    }
    function openExport() {
      closeFind();
      if (!exportPop) {
        exportPop = document.createElement('div');
        exportPop.className = 'txt-pop hidden';
        root.appendChild(exportPop);
      }
      const c = counts();
      exportPop.innerHTML =
        '<h4>This file</h4>' +
        '<div class="txt-counts"><b>' + c.words.toLocaleString() + '</b> words · <b>' +
        c.lines.toLocaleString() + '</b> lines · <b>' + c.chars.toLocaleString() + '</b> chars</div>' +
        '<button data-x="pdf">⤓ Export as PDF…</button>' +
        '<button data-x="html">⤓ Export as HTML…</button>' +
        '<button data-x="copy">⧉ Copy all text</button>';
      exportPop.classList.remove('hidden');
      exportPop.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
        const x = b.dataset.x;
        if (x === 'copy') {
          if (navigator.clipboard) navigator.clipboard.writeText(S.source || '');
          YR.toast('Copied', '', 1200); closeExport();
        } else exportAs(x);
      }));
      setTimeout(() => document.addEventListener('mousedown', exportOutside), 0);
    }
    function exportOutside(e) { if (exportPop && !exportPop.contains(e.target)) closeExport(); }
    function closeExport() {
      if (exportPop) exportPop.classList.add('hidden');
      document.removeEventListener('mousedown', exportOutside);
    }
    async function exportAs(fmt) {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.save_file) { YR.toast('Export needs the desktop app', '', 3200); return; }
      const base = name.replace(/\.[^.]+$/, '');
      const suggested = base + (fmt === 'pdf' ? '.pdf' : '.html');
      const filt = fmt === 'pdf' ? ['PDF (*.pdf)'] : ['HTML (*.html)'];
      let target = null;
      try { target = await api.save_file(suggested, splitPath(path).dir, filt); } catch (e) { target = null; }
      if (!target) return;
      closeExport();
      YR.toast('Exporting…', '', 1400);
      try {
        const r = await YR.postJSON('/api/text/export', { content: S.source, name, format: fmt, target });
        YR.toast('Exported ' + (r.name || ''), 'success', 2200);
      } catch (e) { YR.toast(e.message || 'Export failed', 'error', 3200); }
    }
    function mkCopyBtn(getText) {
      const b = document.createElement('button');
      b.className = 'code-copy'; b.type = 'button'; b.textContent = '⧉ Copy';
      b.addEventListener('click', e => {
        e.stopPropagation();
        if (navigator.clipboard) navigator.clipboard.writeText(getText() || '');
        YR.toast('Copied', '', 1200);
      });
      return b;
    }
    function addCopyButtons() {
      if (S.mode === 'code') {
        const wrap = scroller.querySelector('.code-wrap');
        if (wrap && !wrap.querySelector('.code-copy')) {
          wrap.style.position = 'relative';
          wrap.appendChild(mkCopyBtn(() => S.source || ''));   // copy source, not the line-number gutter
        }
      } else if (S.mode === 'markdown' && !S.raw) {
        scroller.querySelectorAll('.doc-page pre').forEach(pre => {
          if (pre.querySelector('.code-copy')) return;
          const codeEl = pre.querySelector('code');
          const text = codeEl ? codeEl.textContent : pre.textContent;
          pre.style.position = 'relative';
          pre.appendChild(mkCopyBtn(() => text));
        });
      }
    }

    // ── find / replace (Ctrl+F) ─────────────────────────────────────────────
    // Two engines behind one bar: view mode highlights <mark>s in the rendered
    // DOM (find-only); edit mode searches & replaces inside the editor textarea.
    let findBar, findInput, replaceInput, findCount, findErr;
    function searchRoot() {
      // In code view, skip the line-number gutter so a query like "12" doesn't
      // match line numbers.
      if (S.mode === 'code') return scroller.querySelector('.code-wrap .code') || scroller;
      return scroller;
    }
    function compileRe() {
      const term = S.find.term || '';
      if (!term) { if (findErr) findErr.textContent = ''; return null; }
      const flags = S.find.caseSensitive ? 'g' : 'gi';
      const src = S.find.regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      try {
        const re = new RegExp(src, flags);
        if (findErr) findErr.textContent = '';
        return re;
      } catch (e) {
        if (findErr) findErr.textContent = '!';   // invalid regular expression
        return null;
      }
    }

    // — view mode: highlight matches as <mark>s in the rendered DOM —
    function clearMarks() {
      S.marks.forEach(m => {
        const t = document.createTextNode(m.textContent);
        m.replaceWith(t); if (t.parentNode) t.parentNode.normalize();
      });
      S.marks = []; S.markIdx = 0;
    }
    function highlightInNode(textNode, re) {
      const text = textNode.nodeValue; re.lastIndex = 0;
      let m, last = 0, any = false;
      const frag = document.createDocumentFragment();
      while ((m = re.exec(text)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        any = true;
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const mark = document.createElement('mark');
        mark.className = 'doc-find'; mark.textContent = m[0];
        frag.appendChild(mark); S.marks.push(mark);
        last = m.index + m[0].length;
      }
      if (!any) return;
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.replaceWith(frag);
    }
    function runFindDOM() {
      clearMarks();
      const re = compileRe();
      if (!re) { if (findCount) findCount.textContent = ''; return; }
      const walker = document.createTreeWalker(searchRoot(), NodeFilter.SHOW_TEXT, {
        acceptNode: n => {
          if (!n.nodeValue || !n.parentNode) return NodeFilter.FILTER_REJECT;
          if (n.parentNode.nodeName === 'MARK') return NodeFilter.FILTER_REJECT;
          if (n.parentElement && n.parentElement.closest('.linenos, .linenodiv'))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const targets = []; let node;
      while ((node = walker.nextNode())) targets.push(node);
      targets.forEach(tn => highlightInNode(tn, re));
      if (!S.marks.length) { if (findCount) findCount.textContent = '0/0'; return; }
      S.markIdx = -1; gotoMatchDOM(0);
    }
    function gotoMatchDOM(i) {
      if (!S.marks.length) return;
      S.marks.forEach(m => m.classList.remove('active'));
      S.markIdx = (i + S.marks.length) % S.marks.length;
      const m = S.marks[S.markIdx];
      m.classList.add('active');
      m.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (findCount) findCount.textContent = (S.markIdx + 1) + '/' + S.marks.length;
    }

    // — edit mode: search / replace inside the editor textarea —
    function computeTARanges() {
      S.taRanges = [];
      const re = compileRe(), ta = S.editor;
      if (!re || !ta) return null;
      re.lastIndex = 0; let m;
      while ((m = re.exec(ta.value)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        S.taRanges.push([m.index, m.index + m[0].length]);
      }
      return re;
    }
    function scrollTAToOffset(ta, off) {
      const line = (ta.value.slice(0, off).match(/\n/g) || []).length;
      const cs = getComputedStyle(ta);
      const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 13) * 1.4;
      ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 2);
    }
    function selectTA(i) {
      const len = S.taRanges.length; if (!len) return;
      S.taIdx = ((i % len) + len) % len;
      const r = S.taRanges[S.taIdx], ta = S.editor;
      ta.setSelectionRange(r[0], r[1]);   // visible once the textarea regains focus
      scrollTAToOffset(ta, r[0]);
      if (findCount) findCount.textContent = (S.taIdx + 1) + '/' + len;
    }
    function runFindTA() {
      const re = computeTARanges();
      if (!re) { if (findCount) findCount.textContent = ''; return; }
      if (!S.taRanges.length) { S.taIdx = -1; if (findCount) findCount.textContent = '0/0'; return; }
      selectTA(0);
    }
    function navTA(dir) {
      if (!computeTARanges()) return;
      if (!S.taRanges.length) { if (findCount) findCount.textContent = '0/0'; return; }
      const cur = S.editor.selectionStart || 0;
      let idx;
      if (dir > 0) {
        idx = S.taRanges.findIndex(r => r[0] > cur);
        if (idx < 0) idx = 0;
      } else {
        idx = -1;
        for (let j = S.taRanges.length - 1; j >= 0; j--) { if (S.taRanges[j][0] < cur) { idx = j; break; } }
        if (idx < 0) idx = S.taRanges.length - 1;
      }
      selectTA(idx);
    }
    function replaceCurrent() {
      if (!S.editing || !S.editor) return;
      const re = compileRe(), ta = S.editor;
      if (!re) return;
      const from = ta.selectionStart || 0;
      re.lastIndex = 0; let m, target = null;
      while ((m = re.exec(ta.value)) !== null) {
        if (m[0] === '') { re.lastIndex++; continue; }
        if (m.index >= from) { target = m; break; }
      }
      if (!target) { re.lastIndex = 0; const m0 = re.exec(ta.value); if (m0 && m0[0] !== '') target = m0; }
      if (!target) { if (findCount) findCount.textContent = '0/0'; return; }
      const s = target.index, e = s + target[0].length;
      const rep = replaceInput ? replaceInput.value : '';
      ta.value = ta.value.slice(0, s) + rep + ta.value.slice(e);
      S.source = ta.value; markDirty(); if (S.mode === 'markdown') schedulePreview();
      computeTARanges();
      if (!S.taRanges.length) { if (findCount) findCount.textContent = '0/0'; return; }
      const j = S.taRanges.findIndex(r => r[0] >= s + rep.length);
      selectTA(j < 0 ? 0 : j);
    }
    function replaceAll() {
      if (!S.editing || !S.editor) return;
      const re = compileRe(), ta = S.editor;
      if (!re) return;
      const rep = replaceInput ? replaceInput.value : '';
      let n = 0, m; re.lastIndex = 0;
      while ((m = re.exec(ta.value)) !== null) { if (m[0] === '') { re.lastIndex++; continue; } n++; }
      if (!n) { YR.toast('No matches', '', 1400); return; }
      const re2 = compileRe();
      ta.value = ta.value.replace(re2, S.find.regex ? rep : () => rep);
      S.source = ta.value; markDirty(); if (S.mode === 'markdown') schedulePreview();
      runFindTA();
      YR.toast('Replaced ' + n + (n === 1 ? ' match' : ' matches'), 'success', 1800);
    }

    // — shared dispatchers (route to the engine for the current mode) —
    function runFind(q) {
      if (q != null) S.find.term = q;
      if (S.editing && S.editor) runFindTA(); else runFindDOM();
    }
    function nextMatch() { if (S.editing && S.editor) navTA(1); else gotoMatchDOM(S.markIdx + 1); }
    function prevMatch() { if (S.editing && S.editor) navTA(-1); else gotoMatchDOM(S.markIdx - 1); }
    function hasMatches() { return (S.editing && S.editor) ? S.taRanges.length : S.marks.length; }

    function buildFindBar() {
      findBar = document.createElement('div');
      findBar.className = 'txt-find hidden';
      findBar.innerHTML =
        '<div class="txt-find-row">' +
          '<input class="txt-find-input" type="text" placeholder="Find" spellcheck="false" />' +
          '<button class="txt-find-toggle" data-t="case" title="Match case">Aa</button>' +
          '<button class="txt-find-toggle" data-t="regex" title="Regular expression">.*</button>' +
          '<span class="txt-find-count"></span>' +
          '<span class="txt-find-err"></span>' +
          '<button class="txt-find-btn" data-f="prev" title="Previous (Shift+Enter)">↑</button>' +
          '<button class="txt-find-btn" data-f="next" title="Next (Enter)">↓</button>' +
          '<button class="txt-find-btn" data-f="close" title="Close (Esc)">✕</button>' +
        '</div>' +
        '<div class="txt-find-row txt-find-replace">' +
          '<input class="txt-find-rinput" type="text" placeholder="Replace" spellcheck="false" />' +
          '<button class="txt-find-btn wide" data-f="rep" title="Replace (Enter)">Replace</button>' +
          '<button class="txt-find-btn wide" data-f="repall" title="Replace all (Shift+Enter)">All</button>' +
        '</div>';
      root.appendChild(findBar);
      findInput = findBar.querySelector('.txt-find-input');
      replaceInput = findBar.querySelector('.txt-find-rinput');
      findCount = findBar.querySelector('.txt-find-count');
      findErr = findBar.querySelector('.txt-find-err');
      let t;
      findInput.addEventListener('input', () => {
        clearTimeout(t); const v = findInput.value;
        t = setTimeout(() => runFind(v), 160);
      });
      findInput.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prevMatch() : nextMatch(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      });
      replaceInput.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? replaceAll() : replaceCurrent(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
      });
      findBar.querySelectorAll('.txt-find-toggle').forEach(b =>
        b.addEventListener('click', () => {
          const key = b.dataset.t === 'case' ? 'caseSensitive' : 'regex';
          S.find[key] = !S.find[key];
          b.classList.toggle('active', S.find[key]);
          runFind(findInput.value); findInput.focus();
        }));
      findBar.querySelectorAll('.txt-find-btn').forEach(b =>
        b.addEventListener('click', () => {
          const f = b.dataset.f;
          if (f === 'next') nextMatch();
          else if (f === 'prev') prevMatch();
          else if (f === 'rep') replaceCurrent();
          else if (f === 'repall') replaceAll();
          else closeFind();
        }));
    }
    function openFind() {
      if (!findBar) buildFindBar();
      S.find.open = true;
      findBar.classList.remove('hidden');
      findBar.classList.toggle('editing', !!(S.editing && S.editor));   // show replace row only when editing
      findBar.querySelector('[data-t="case"]').classList.toggle('active', S.find.caseSensitive);
      findBar.querySelector('[data-t="regex"]').classList.toggle('active', S.find.regex);
      const sel = (S.editing && S.editor)
        ? (S.editor.selectionEnd > S.editor.selectionStart
            ? S.editor.value.slice(S.editor.selectionStart, S.editor.selectionEnd) : '')
        : String(window.getSelection() || '').trim();
      if (sel && sel.length <= 80 && sel.indexOf('\n') < 0) findInput.value = sel;
      findInput.focus(); findInput.select();
      if (findInput.value) runFind(findInput.value);
    }
    function closeFind() {
      S.find.open = false;
      clearMarks();
      S.taRanges = []; S.taIdx = -1;
      if (findCount) findCount.textContent = '';
      if (findErr) findErr.textContent = '';
      if (findBar) findBar.classList.add('hidden');
      if (S.editing && S.editor) S.editor.focus();
    }
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();                       // suppress the browser save dialog
        if (S.meta.editable && S.editing) save();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault(); openFind();
      } else if (e.key === 'F3') {
        e.preventDefault(); if (hasMatches()) (e.shiftKey ? prevMatch() : nextMatch());
      } else if (e.key === 'Escape' && selBubble) {
        closeSelBubble();
      }
    }
    document.addEventListener('keydown', onKey);
    mount._cleanup = () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', exportOutside);
      document.removeEventListener('mousedown', selBubbleOutside);
      closeSelBubble();
      if (findBar) { findBar.remove(); findBar = null; }
      if (exportPop) { exportPop.remove(); exportPop = null; }
      clearTimeout(previewTimer);
      YR.setLeaveGuard(null);
    };

    // Command palette entries (auto-cleared on unmount).
    YR.registerCommand({ g: 'Text', ic: '🔍', name: 'Find & replace', hint: 'Ctrl+F', run: () => openFind() });
    YR.registerCommand({ g: 'Text', ic: '⤓', name: 'Export & word count…', run: () => openExport() });
    YR.registerCommand({ g: 'Text', ic: '⏎', name: 'Toggle word wrap', run: () => { S.wrap = !S.wrap; YR.savePrefs('text', { wrap: S.wrap }); if (S.editing && S.editor) S.editor.classList.toggle('nowrap', !S.wrap); else renderContent(); buildTools(); } });
    if (S.data && S.data.editable) {
      YR.registerCommand({ g: 'Text', ic: '✎', name: S.editing ? 'Done editing' : 'Edit & save', run: () => S.editing ? exitEdit() : enterEdit() });
    }

    // ── Right-click context menus ────────────────────────────────────────
    YR.bindContextMenu(YR.root, (ctx, e) => {
      // Selected text
      if (ctx.kind === 'text' && ctx.text) {
        const txt = ctx.text;
        if (S.editing && S.editor) {
          // Edit mode — cut/copy/paste + find + AI rewrite/improve.
          return [
            { icon: '✂', label: 'Cut',  hint: 'Ctrl+X', run: async () => {
              try {
                const ta = S.editor;
                const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
                if (sel) { await navigator.clipboard.writeText(sel); ta.setRangeText('', ta.selectionStart, ta.selectionEnd, 'start'); markDirty(); }
              } catch (_) {}
            } },
            { icon: '⧉', label: 'Copy', hint: 'Ctrl+C', run: async () => { try { await navigator.clipboard.writeText(txt); YR.toast('Copied', '', 1200); } catch (_) {} } },
            { icon: '📋', label: 'Paste', hint: 'Ctrl+V', run: async () => {
              try { const t = await navigator.clipboard.readText(); if (t && S.editor) { S.editor.setRangeText(t, S.editor.selectionStart, S.editor.selectionEnd, 'end'); markDirty(); } } catch (_) {}
            } },
            { separator: true },
            { icon: '🔍', label: 'Replace selection…', run: () => openFind() },
            { separator: true },
            { icon: '🌐', label: 'Translate', run: () => runAI('translate', txt) },
            { icon: '💡', label: 'Explain',   run: () => runAI('explain', txt) },
            { icon: '✨', label: 'Rewrite',   run: () => runAI('rewrite', txt) },
          ];
        }
        // View mode — copy + AI + find selection.
        return [
          { icon: '⧉', label: 'Copy', hint: 'Ctrl+C', run: async () => { try { await navigator.clipboard.writeText(txt); YR.toast('Copied', '', 1200); } catch (_) {} } },
          { separator: true },
          { icon: '🌐', label: 'Translate', run: () => runAI('translate', txt) },
          { icon: '💡', label: 'Explain',   run: () => runAI('explain', txt) },
          { icon: '✨', label: 'Summarize',  run: () => runAI('summarize', txt) },
          { separator: true },
          { icon: '🔍', label: 'Find this in file', run: () => { openFind(); /* user types it in the find bar */ } },
        ];
      }
      // Plain area
      if (S.editing) {
        return [
          { icon: '📋', label: 'Paste', hint: 'Ctrl+V', run: async () => { try { const t = await navigator.clipboard.readText(); if (t && S.editor) { S.editor.setRangeText(t, S.editor.selectionStart, S.editor.selectionEnd, 'end'); markDirty(); } } catch (_) {} } },
          { icon: '🔍', label: 'Find & replace', hint: 'Ctrl+F', run: () => openFind() },
          { separator: true },
          { icon: '💾', label: 'Save',   hint: 'Ctrl+S', run: () => save() },
          { icon: '✓', label: 'Done editing', run: () => exitEdit() },
        ];
      }
      const items = [
        { icon: '⧉', label: 'Copy all', run: async () => { try { await navigator.clipboard.writeText(S.source || ''); YR.toast('Copied', '', 1200); } catch (_) {} } },
        { icon: '🔍', label: 'Find',     hint: 'Ctrl+F', run: () => openFind() },
        { separator: true },
        { icon: '⏎', label: 'Toggle word wrap', active: S.wrap, run: () => { S.wrap = !S.wrap; YR.savePrefs('text', { wrap: S.wrap }); renderContent(); buildTools(); } },
      ];
      if (S.mode === 'markdown') {
        items.push({ icon: '📝', label: 'Toggle raw source', active: S.raw, run: () => { S.raw = !S.raw; renderContent(); } });
      }
      if (S.dataKind === 'json') {
        items.push({ icon: '🌳', label: 'Toggle tree view', active: S.dataView, run: () => { S.dataView = !S.dataView; renderContent(); } });
      }
      if (S.dataKind === 'csv' || S.dataKind === 'tsv') {
        items.push({ icon: '▦', label: 'Toggle table view', active: S.dataView, run: () => { S.dataView = !S.dataView; renderContent(); } });
      }
      if (S.data && S.data.editable) {
        items.push({ separator: true });
        items.push({ icon: '✎', label: 'Edit file', run: () => enterEdit() });
      }
      items.push({ separator: true });
      items.push({ icon: '⤓', label: 'Export…', run: () => openExport() });
      return items;
    });

    // Sidebar (Markdown outline only)
    YR.bindContextMenu(document.getElementById('sidebar'), (ctx, e) => {
      const ol = e.target.closest && e.target.closest('.outline-item');
      if (ol) {
        return [
          { icon: '→', label: 'Go to', run: () => ol.click() },
          { icon: '⧉', label: 'Copy heading', run: () => { try { navigator.clipboard.writeText((ol.textContent || '').trim()); YR.toast('Copied', '', 1200); } catch (_) {} } },
        ];
      }
      return null;
    });

    mount._S = S;
  }

  function unmount() {
    if (mount._cleanup) { try { mount._cleanup(); } catch (e) {} mount._cleanup = null; }
    mount._S = null;
  }

  YR.registerReader('text', { mount, unmount });
})();
