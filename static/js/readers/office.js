/* YancoRead — Office reader + tool profile (docx/pptx/xlsx).

   Rendering is fully native (no external engine). The backend reports a mode
   via doc.meta.render:
     'flow'         — lightweight mammoth/pptx/openpyxl → HTML (continuous flow).
     'unsupported'  — a legacy/OpenDocument format we can't open natively
                      (.doc .ppt .xls .rtf .odt .odp .ods).

   The flow view is a full "reading + working" surface:
     • Zoom, Find (with prev/next + match count)
     • AI assistant (summarize / key points / simplify / improve / translate / ask)
     • Read-aloud (Web Speech) with paragraph highlighting
     • Highlights & notes (selection → colored highlight + optional note),
       persisted per file and re-applied on open
     • Print / Save as PDF (system dialog)
*/
(function () {
  'use strict';

  const HL_COLORS = [
    { key: 'yellow', label: 'Yellow' },
    { key: 'green', label: 'Green' },
    { key: 'blue', label: 'Blue' },
    { key: 'pink', label: 'Pink' },
  ];

  function mount(doc) {
    const render = (doc.meta && doc.meta.render) || 'flow';
    if (render === 'unsupported') return mountUnsupported(doc);
    return mountFlow(doc);
  }

  // ══ unsupported: format we can't open natively ════════════════════════════
  function mountUnsupported(doc) {
    const ext = (doc.ext || (doc.meta && doc.meta.ext) || '').replace('.', '').toUpperCase() || 'this format';
    YR.setTools([]);
    YR.sidebar.available(false);
    YR.root.innerHTML = `
      <div class="stage-error">
        <div class="big">${YR.escapeHtml(ext)} files aren't supported</div>
        <div style="max-width:520px;line-height:1.5;margin-top:8px">
          YancoRead opens modern Office documents — <b>.docx, .pptx and .xlsx</b> —
          natively. Legacy and OpenDocument formats
          (<b>.doc .ppt .xls .rtf .odt .odp .ods</b>) can't be opened.
          <br><br>
          Re-save the file as <b>.docx</b>, <b>.pptx</b> or <b>.xlsx</b> and open
          it again.
        </div>
      </div>`;
  }

  // ══ flow: native HTML view + document tools ════════════════════════════════
  function mountFlow(doc) {
    const path = doc.path;
    const ext = (doc.ext || (doc.meta && doc.meta.ext) || '').toLowerCase();
    const isDocx = ext === '.docx' || /\.docx$/i.test(doc.name || path || '');
    const prefs = Object.assign({ zoom: 1.0 }, doc.prefs || {});
    const annos = ((doc.file_prefs && doc.file_prefs.annotations) || []).slice();
    const S = {
      zoom: prefs.zoom || 1.0,
      marks: [], markIdx: 0,
      annos,                 // [{id, start, end, quote, color, note}]
      reading: false, readEls: [], readIdx: 0,
      voicesReady: null, voices: [],
      sideMode: 'outline', outline: [],
      editing: false, dirty: false,
      fidelity: { lossy: false, features: [] },
      page: null,            // {size, orientation, width_in, height_in, margins{}}
    };

    const root = YR.root;
    YR.stageLoading('Rendering document…');

    const scroller = document.createElement('div');
    scroller.className = 'office-scroll';
    scroller.style.height = '100%';
    scroller.style.overflow = 'auto';

    YR.getJSON(`/api/office?path=${encodeURIComponent(path)}`).then(data => {
      root.innerHTML = '';
      scroller.innerHTML = data.html || '';
      scroller.style.zoom = S.zoom;
      root.appendChild(scroller);
      S.outline = data.outline || [];
      if (data.fidelity) S.fidelity = data.fidelity;
      if (data.page) S.page = data.page;
      applyPageSetup();
      renderHeaderFooter();
      applyAnnotations();
      buildTools();
      buildSidebar();
      wireSelection();
      const start = (doc.position && doc.position.scroll) || 0;
      if (start) scroller.scrollTop = start;
      scroller.addEventListener('scroll', onScroll, { passive: true });
    }).catch(e => YR.stageError(e.message || 'Could not render document'));

    let scrollTimer;
    function onScroll() {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const max = scroller.scrollHeight - scroller.clientHeight;
        YR.savePosition({ scroll: scroller.scrollTop }, max ? scroller.scrollTop / max : 0);
      }, 250);
    }

    // ── text helpers (char-offset anchoring for annotations) ─────────────────
    function textNodeList() {
      const out = [];
      // Skip header/footer bands, footnote markers and the footnotes section so
      // annotation char-offsets stay body-prose-relative (they were anchored
      // against the body text, before those auxiliary regions existed).
      const w = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT, {
        acceptNode: n => (n.parentElement && n.parentElement.closest('.doc-hf, .doc-footnotes, .fn-ref'))
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      let n; while ((n = w.nextNode())) out.push(n);
      return out;
    }
    function docText() { return scroller.innerText || scroller.textContent || ''; }
    function selectionText() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
      const r = sel.getRangeAt(0);
      if (!scroller.contains(r.commonAncestorContainer)) return '';
      return sel.toString();
    }
    // Global char offset of (node, offset) within the scroller text stream.
    function globalOffset(nodes, node, offset) {
      let total = 0;
      for (const tn of nodes) {
        if (tn === node) return total + offset;
        total += tn.nodeValue.length;
      }
      return total;
    }
    function selectionOffsets() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
      const r = sel.getRangeAt(0);
      if (!scroller.contains(r.commonAncestorContainer)) return null;
      const nodes = textNodeList();
      let start = globalOffset(nodes, r.startContainer, r.startOffset);
      let end = globalOffset(nodes, r.endContainer, r.endOffset);
      if (start > end) [start, end] = [end, start];
      if (end <= start) return null;
      return { start, end, quote: sel.toString() };
    }
    // Wrap [start,end) in <mark> tags (may span multiple text nodes).
    function highlightOffsets(start, end, colorClass, id) {
      const nodes = textNodeList();
      let acc = 0;
      for (const tn of nodes) {
        const ns = acc, ne = acc + tn.nodeValue.length;
        acc = ne;
        const a = Math.max(start, ns), b = Math.min(end, ne);
        if (a >= b) continue;
        let target = tn;
        const localStart = a - ns, localEnd = b - ns;
        if (localStart > 0) target = target.splitText(localStart);
        if (localEnd - localStart < target.nodeValue.length) target.splitText(localEnd - localStart);
        const mark = document.createElement('mark');
        mark.className = 'doc-hl c-' + colorClass;
        mark.dataset.anno = id;
        target.parentNode.insertBefore(mark, target);
        mark.appendChild(target);
      }
    }
    function applyAnnotations() {
      S.annos.forEach(a => {
        try { highlightOffsets(a.start, a.end, a.color, a.id); } catch (e) { /* ignore stale anchor */ }
      });
    }
    function persistAnnos() {
      YR.postJSON('/api/file-prefs', { path, prefs: { annotations: S.annos } }).catch(() => {});
    }
    function addAnnotation(color, note) {
      const off = selectionOffsets();
      if (!off) { YR.toast('Select some text first', '', 1800); return; }
      const a = { id: 'a' + Date.now().toString(36), start: off.start, end: off.end,
        quote: off.quote.slice(0, 240), color, note: note || '' };
      S.annos.push(a);
      highlightOffsets(a.start, a.end, a.color, a.id);
      persistAnnos();
      window.getSelection().removeAllRanges();
      if (S.sideMode === 'notes') renderSide();
      YR.toast(note ? 'Note added' : 'Highlighted', 'success', 1400);
    }
    function removeAnnotation(id) {
      S.annos = S.annos.filter(a => a.id !== id);
      scroller.querySelectorAll(`mark.doc-hl[data-anno="${id}"]`).forEach(m => {
        const t = document.createTextNode(m.textContent);
        m.replaceWith(t); if (t.parentNode) t.parentNode.normalize();
      });
      persistAnnos();
      if (S.sideMode === 'notes') renderSide();
    }
    function scrollToAnno(id) {
      const m = scroller.querySelector(`mark.doc-hl[data-anno="${id}"]`);
      if (m) m.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // ── selection popup (highlight / note / ask) ─────────────────────────────
    let selPop = null;
    function closeSelPop() { if (selPop) { selPop.remove(); selPop = null; } }
    function wireSelection() {
      scroller.addEventListener('mouseup', () => setTimeout(showSelPop, 10));
      document.addEventListener('mousedown', e => {
        if (selPop && !selPop.contains(e.target)) closeSelPop();
      });
    }
    function showSelPop() {
      if (S.editing) { closeSelPop(); return; }   // editing uses the ribbon, not highlights
      const txt = selectionText();
      if (!txt.trim()) { closeSelPop(); return; }
      const r = window.getSelection().getRangeAt(0).getBoundingClientRect();
      closeSelPop();
      selPop = document.createElement('div');
      selPop.className = 'doc-selpop';
      const swatches = HL_COLORS.map(c =>
        `<button class="hl-sw c-${c.key}" data-c="${c.key}" title="Highlight ${c.label}"></button>`).join('');
      selPop.innerHTML = `${swatches}
        <button class="sp-btn" data-act="note" title="Highlight + note">✎ Note</button>
        <button class="sp-btn" data-act="ask" title="Ask AI about this">✦ Ask</button>
        <button class="sp-btn" data-act="copy" title="Copy">⧉</button>`;
      document.body.appendChild(selPop);
      const top = Math.max(8, r.top - 44);
      selPop.style.top = top + 'px';
      selPop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - selPop.offsetWidth - 8)) + 'px';
      selPop.querySelectorAll('.hl-sw').forEach(b =>
        b.addEventListener('click', () => { addAnnotation(b.dataset.c); closeSelPop(); }));
      selPop.querySelector('[data-act="note"]').addEventListener('click', () => {
        const note = prompt('Note for the highlighted text:');
        if (note !== null) addAnnotation('yellow', note);
        closeSelPop();
      });
      selPop.querySelector('[data-act="ask"]').addEventListener('click', () => {
        mountAIRpanel(); YR.rpanel.show();
        setTimeout(() => runAI('ask', txt, 'What does this mean?'), 30);
        closeSelPop();
      });
      selPop.querySelector('[data-act="copy"]').addEventListener('click', () => {
        navigator.clipboard && navigator.clipboard.writeText(txt);
        YR.toast('Copied', '', 1200); closeSelPop();
      });
    }

    // ── zoom ─────────────────────────────────────────────────────────────────
    let zoomLabel;
    function setZoom(z) {
      S.zoom = Math.max(0.5, Math.min(2.5, z));
      scroller.style.zoom = S.zoom;
      zoomLabel.textContent = Math.round(S.zoom * 100) + '%';
      YR.savePrefs('office', { zoom: S.zoom });
    }

    // ── find (prev/next + count) ─────────────────────────────────────────────
    let countLabel, findBox;
    function clearMarks() {
      S.marks.forEach(m => {
        const t = document.createTextNode(m.textContent);
        m.replaceWith(t); if (t.parentNode) t.parentNode.normalize();
      });
      S.marks = []; S.markIdx = 0;
      if (countLabel) countLabel.textContent = '';
    }
    function runFind(q) {
      clearMarks();
      q = (q || '').trim();
      if (!q) return;
      const needle = q.toLowerCase();
      const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT, {
        acceptNode: n => (n.nodeValue && n.parentNode && n.parentNode.nodeName !== 'MARK'
          && n.nodeValue.toLowerCase().includes(needle))
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      const targets = [];
      let node;
      while ((node = walker.nextNode())) targets.push(node);
      targets.forEach(textNode => highlightInNode(textNode, needle));
      if (!S.marks.length) { if (countLabel) countLabel.textContent = '0/0'; YR.toast('No matches', '', 1600); return; }
      S.markIdx = -1; nextMatch();
    }
    function highlightInNode(textNode, needle) {
      const text = textNode.nodeValue;
      const low = text.toLowerCase();
      let idx = low.indexOf(needle), last = 0;
      if (idx === -1) return;
      const frag = document.createDocumentFragment();
      while (idx !== -1) {
        if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
        const mark = document.createElement('mark');
        mark.className = 'doc-find';
        mark.textContent = text.slice(idx, idx + needle.length);
        frag.appendChild(mark); S.marks.push(mark);
        last = idx + needle.length;
        idx = low.indexOf(needle, last);
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.replaceWith(frag);
    }
    function gotoMatch(i) {
      if (!S.marks.length) return;
      S.marks.forEach(m => m.classList.remove('active'));
      S.markIdx = (i + S.marks.length) % S.marks.length;
      const m = S.marks[S.markIdx];
      m.classList.add('active');
      m.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (countLabel) countLabel.textContent = (S.markIdx + 1) + '/' + S.marks.length;
      syncRpCount();
    }
    function nextMatch() { gotoMatch(S.markIdx + 1); }
    function prevMatch() { gotoMatch(S.markIdx - 1); }

    // ── replace (works in read or edit mode; marks the doc dirty when editing) ─
    function replaceCurrent(find, repl) {
      find = (find || '').trim();
      if (!find) return;
      repl = repl || '';
      if (!S.marks.length || S.markIdx < 0 || !S.marks[S.markIdx]) { runFind(find); return; }
      const m = S.marks[S.markIdx];
      const at = S.markIdx;
      const parent = m.parentNode;
      m.replaceWith(document.createTextNode(repl));
      if (parent) parent.normalize();
      if (S.editing) markDirty();
      runFind(find);                                  // rebuild marks on new text
      if (S.marks.length) gotoMatch(Math.min(at, S.marks.length - 1));
    }
    function replaceAll(find, repl) {
      clearMarks();
      find = (find || '').trim();
      if (!find) { return; }
      repl = repl || '';
      const needle = find.toLowerCase();
      const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT, {
        acceptNode: n => (n.nodeValue && n.parentNode && n.parentNode.nodeName !== 'MARK'
          && n.nodeValue.toLowerCase().includes(needle))
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      const targets = []; let node;
      while ((node = walker.nextNode())) targets.push(node);
      let count = 0;
      targets.forEach(tn => {
        const text = tn.nodeValue, low = text.toLowerCase();
        let idx = low.indexOf(needle), last = 0, res = '';
        while (idx !== -1) {
          res += text.slice(last, idx) + repl;
          last = idx + needle.length;
          idx = low.indexOf(needle, last);
          count++;
        }
        res += text.slice(last);
        if (res !== text) tn.nodeValue = res;
      });
      if (count && S.editing) markDirty();
      if (countLabel) countLabel.textContent = '';
      syncRpCount();
      YR.toast(count ? `Replaced ${count} ${count === 1 ? 'match' : 'matches'}` : 'No matches',
        count ? 'success' : '', 1800);
    }

    // ── find & replace floating panel (Word-style) ───────────────────────────
    let replacePop = null, rpCount = null;
    function closeReplacePop() {
      if (replacePop) { replacePop.remove(); replacePop = null; rpCount = null; }
    }
    function syncRpCount() {
      if (rpCount) rpCount.textContent = S.marks.length ? (S.markIdx + 1) + '/' + S.marks.length : '0';
    }
    function openReplacePop(anchor) {
      if (replacePop) { closeReplacePop(); return; }
      replacePop = document.createElement('div');
      replacePop.className = 'doc-replace-pop';
      replacePop.innerHTML = `
        <button class="rp-x" title="Close (Esc)">✕</button>
        <div class="rp-row">
          <input class="tb-input rp-find" placeholder="Find" spellcheck="false" />
          <button class="rp-btn" data-a="prev" title="Previous match">↑</button>
          <button class="rp-btn" data-a="next" title="Next match">↓</button>
          <span class="rp-count" title="Match count"></span>
        </div>
        <div class="rp-row">
          <input class="tb-input rp-repl" placeholder="Replace with" spellcheck="false" />
          <button class="rp-btn rp-go" data-a="one" title="Replace this match">Replace</button>
          <button class="rp-btn rp-go" data-a="all" title="Replace every match">All</button>
        </div>`;
      document.body.appendChild(replacePop);
      if (anchor && anchor.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        replacePop.style.top = (r.bottom + 6) + 'px';
        replacePop.style.left = Math.max(8, Math.min(r.left - 40,
          window.innerWidth - replacePop.offsetWidth - 8)) + 'px';
      } else {
        replacePop.style.top = '64px';
        replacePop.style.right = '18px';
      }
      const findInp = replacePop.querySelector('.rp-find');
      const replInp = replacePop.querySelector('.rp-repl');
      rpCount = replacePop.querySelector('.rp-count');
      findInp.value = (findBox && findBox.value) || selectionText().trim().slice(0, 80) || '';
      const doFind = () => { if (findBox) findBox.value = findInp.value; runFind(findInp.value); };
      findInp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doFind(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeReplacePop(); }
      });
      replInp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(findInp.value, replInp.value); }
        else if (e.key === 'Escape') { e.preventDefault(); closeReplacePop(); }
      });
      replacePop.querySelector('[data-a="prev"]').addEventListener('click', prevMatch);
      replacePop.querySelector('[data-a="next"]').addEventListener('click',
        () => { if (!S.marks.length) doFind(); else nextMatch(); });
      replacePop.querySelector('[data-a="one"]').addEventListener('click',
        () => replaceCurrent(findInp.value, replInp.value));
      replacePop.querySelector('[data-a="all"]').addEventListener('click',
        () => replaceAll(findInp.value, replInp.value));
      replacePop.querySelector('.rp-x').addEventListener('click', closeReplacePop);
      if (findInp.value) doFind();
      findInp.focus(); findInp.select();
    }

    // ── read-aloud (Web Speech) ──────────────────────────────────────────────
    function loadVoices() {
      if (S.voicesReady) return S.voicesReady;
      S.voicesReady = new Promise(resolve => {
        if (!window.speechSynthesis) { resolve([]); return; }
        const grab = () => { const v = window.speechSynthesis.getVoices() || []; if (v.length) { S.voices = v; return true; } return false; };
        if (grab()) { resolve(S.voices); return; }
        let done = false;
        const finish = () => { if (done) return; done = true; window.speechSynthesis.removeEventListener('voiceschanged', on); if (!S.voices.length) S.voices = window.speechSynthesis.getVoices() || []; resolve(S.voices); };
        const on = () => { if (grab()) finish(); };
        window.speechSynthesis.addEventListener('voiceschanged', on);
        setTimeout(finish, 1500);
      });
      return S.voicesReady;
    }
    function readableEls() {
      return Array.from(scroller.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, td, blockquote'))
        .filter(e => (e.innerText || '').trim().length > 1);
    }
    async function toggleRead(btn) {
      if (S.reading) { stopReading(); btn.classList.remove('active'); return; }
      if (!window.speechSynthesis) { YR.toast('Read-aloud not supported here', 'error'); return; }
      S.readEls = readableEls();
      if (!S.readEls.length) { YR.toast('Nothing to read', '', 1600); return; }
      // start at the element nearest the top of the viewport
      const top = scroller.scrollTop;
      S.readIdx = Math.max(0, S.readEls.findIndex(e => e.offsetTop >= top - 4));
      if (S.readIdx < 0) S.readIdx = 0;
      S.reading = true; btn.classList.add('active');
      await loadVoices();
      if (S.reading) speakNext();
    }
    function stopReading() {
      S.reading = false;
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      scroller.querySelectorAll('.doc-read-hl').forEach(e => e.classList.remove('doc-read-hl'));
    }
    function speakNext() {
      if (!S.reading) return;
      scroller.querySelectorAll('.doc-read-hl').forEach(e => e.classList.remove('doc-read-hl'));
      if (S.readIdx >= S.readEls.length) { stopReading(); document.getElementById('off-read')?.classList.remove('active'); YR.toast('Finished reading', '', 1800); return; }
      const elx = S.readEls[S.readIdx];
      const text = (elx.innerText || '').trim();
      if (text.length < 2) { S.readIdx++; speakNext(); return; }
      elx.classList.add('doc-read-hl');
      elx.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.0;
      let advanced = false;
      const go = () => { if (advanced) return; advanced = true; S.readIdx++; speakNext(); };
      u.onend = go; u.onerror = go;
      window.speechSynthesis.speak(u);
    }

    // ── page setup (size / orientation / margins) ─────────────────────────────
    // Friendly sizes in inches (portrait W×H). Used to size the on-screen page
    // and to drive the print @page box; the converter mirrors these on save.
    const PAGE_DIMS = { letter: [8.5, 11], legal: [8.5, 14], a4: [8.27, 11.69], a3: [11.69, 16.54], tabloid: [11, 17] };
    const MARGIN_PRESETS = {        // Word's familiar presets, inches
      normal: { top: 1, bottom: 1, left: 1, right: 1 },
      narrow: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      moderate: { top: 1, bottom: 1, left: 0.75, right: 0.75 },
      wide: { top: 1, bottom: 1, left: 2, right: 2 },
    };
    function pageDims(p) {
      let w = p && p.width_in, h = p && p.height_in;
      if ((!w || !h) && p && PAGE_DIMS[p.size]) { w = PAGE_DIMS[p.size][0]; h = PAGE_DIMS[p.size][1]; }
      if (!w || !h) { w = 8.5; h = 11; }
      const land = p && p.orientation === 'landscape';
      if (land && w < h) { const t = w; w = h; h = t; }
      if (!land && w > h) { const t = w; w = h; h = t; }
      return [w, h];
    }
    function marginPresetName(m) {
      if (!m) return '';
      for (const k in MARGIN_PRESETS) {
        const p = MARGIN_PRESETS[k];
        if (['top', 'bottom', 'left', 'right'].every(s => Math.abs((m[s] ?? -9) - p[s]) < 0.02)) return k;
      }
      return '';
    }
    // Size the on-screen page to reflect the real geometry (a faithful preview).
    function applyPageSetup() {
      const art = scroller.querySelector('article.doc-page');
      if (!art) return;
      if (!S.page) { art.style.maxWidth = ''; art.style.padding = ''; return; }
      const [w] = pageDims(S.page);
      art.style.maxWidth = Math.round(w * 96) + 'px';
      art.style.width = '100%';
      const m = S.page.margins || {};
      if (['top', 'right', 'bottom', 'left'].every(k => typeof m[k] === 'number')) {
        art.style.padding = `${m.top}in ${m.right}in ${m.bottom}in ${m.left}in`;
      }
    }

    let pageMenu = null;
    function closePageSetup() {
      if (!pageMenu) return;
      pageMenu.remove(); pageMenu = null;
      document.removeEventListener('mousedown', onPageMenuOutside, true);
    }
    function onPageMenuOutside(e) { if (pageMenu && !pageMenu.contains(e.target)) closePageSetup(); }
    function pageChanged() { applyPageSetup(); markDirty(); }
    function openPageSetup(btn) {
      if (pageMenu) { closePageSetup(); return; }
      if (!S.page) S.page = { size: 'letter', orientation: 'portrait', width_in: 8.5, height_in: 11, margins: Object.assign({}, MARGIN_PRESETS.normal) };
      const p = S.page;
      const sizeKey = (p.size && PAGE_DIMS[p.size]) ? p.size : 'custom';
      const sizeOpt = (k, label) => `<option value="${k}"${k === sizeKey ? ' selected' : ''}>${label}</option>`;
      const marKey = marginPresetName(p.margins) || 'custom';
      const marOpt = (k, label) => `<option value="${k}"${k === marKey ? ' selected' : ''}>${label}</option>`;
      pageMenu = document.createElement('div');
      pageMenu.className = 'office-menu office-pagesetup';
      pageMenu.innerHTML = `
        <div class="ps-row"><label>Size</label>
          <select data-ps="size">
            ${sizeOpt('letter', 'Letter (8.5×11)')}${sizeOpt('a4', 'A4')}${sizeOpt('legal', 'Legal (8.5×14)')}${sizeOpt('tabloid', 'Tabloid (11×17)')}${sizeOpt('a3', 'A3')}
            ${sizeKey === 'custom' ? '<option value="custom" selected>Custom</option>' : ''}
          </select></div>
        <div class="ps-row"><label>Orientation</label>
          <div class="ps-seg" data-ps="orient">
            <button data-or="portrait" class="${p.orientation !== 'landscape' ? 'on' : ''}">Portrait</button>
            <button data-or="landscape" class="${p.orientation === 'landscape' ? 'on' : ''}">Landscape</button>
          </div></div>
        <div class="ps-row"><label>Margins</label>
          <select data-ps="margins">
            ${marOpt('normal', 'Normal (1″)')}${marOpt('narrow', 'Narrow (0.5″)')}${marOpt('moderate', 'Moderate')}${marOpt('wide', 'Wide')}
            ${marKey === 'custom' ? '<option value="custom" selected>Custom</option>' : ''}
          </select></div>`;
      document.body.appendChild(pageMenu);
      const r = btn.getBoundingClientRect();
      pageMenu.style.top = (r.bottom + 4) + 'px';
      pageMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pageMenu.offsetWidth - 8)) + 'px';

      pageMenu.querySelector('[data-ps="size"]').addEventListener('change', e => {
        const v = e.target.value;
        if (PAGE_DIMS[v]) { S.page.size = v; const land = S.page.orientation === 'landscape'; S.page.width_in = land ? PAGE_DIMS[v][1] : PAGE_DIMS[v][0]; S.page.height_in = land ? PAGE_DIMS[v][0] : PAGE_DIMS[v][1]; pageChanged(); }
      });
      pageMenu.querySelectorAll('[data-ps="orient"] button').forEach(b => b.addEventListener('click', () => {
        S.page.orientation = b.dataset.or;
        const [w, h] = pageDims(S.page); S.page.width_in = w; S.page.height_in = h;
        pageMenu.querySelectorAll('[data-ps="orient"] button').forEach(x => x.classList.toggle('on', x === b));
        pageChanged();
      }));
      pageMenu.querySelector('[data-ps="margins"]').addEventListener('change', e => {
        const v = e.target.value;
        if (MARGIN_PRESETS[v]) { S.page.margins = Object.assign({}, MARGIN_PRESETS[v]); pageChanged(); }
      });
      setTimeout(() => document.addEventListener('mousedown', onPageMenuOutside, true), 0);
    }

    // ── headers & footers ──────────────────────────────────────────────────────
    // The primary header/footer ride along in S.page (the backend merges them
    // into the structure payload). They render as editable bands inside the page
    // and are stripped from the body HTML on save, then the converter writes
    // them back to the document's section.
    function ensurePage() {
      if (!S.page) S.page = { size: 'letter', orientation: 'portrait', width_in: 8.5, height_in: 11, margins: Object.assign({}, MARGIN_PRESETS.normal) };
      return S.page;
    }
    function pageNoChip() {
      const chip = document.createElement('span');
      chip.className = 'hf-pageno';
      chip.setAttribute('contenteditable', 'false');
      chip.title = 'Page number — Word fills in the real number';
      chip.textContent = '#';
      return chip;
    }
    function hfZone(kind, spec) {
      const z = document.createElement('div');
      z.className = 'doc-hf doc-' + kind;
      z.setAttribute('data-hf', kind);
      z.setAttribute('data-ph', kind === 'header' ? 'Header' : 'Footer');
      const text = (spec && spec.text) || '';
      if (text) z.appendChild(document.createTextNode(text));
      if (spec && spec.page_num) {
        if (text) z.appendChild(document.createTextNode(' '));
        z.appendChild(pageNoChip());
      }
      return z;
    }
    // Bands show whenever editing (so they can be filled) or when they carry
    // content (so a reader sees them); otherwise they stay out of the way.
    function renderHeaderFooter() {
      const art = scroller.querySelector('article.doc-page');
      if (!art) return;
      art.querySelectorAll('.doc-hf').forEach(z => z.remove());
      const hp = S.page && S.page.header, fp = S.page && S.page.footer;
      const hasH = !!(hp && (hp.text || hp.page_num));
      const hasF = !!(fp && (fp.text || fp.page_num));
      if (S.editing || hasH) art.insertBefore(hfZone('header', hp || {}), art.firstChild);
      if (S.editing || hasF) art.appendChild(hfZone('footer', fp || {}));
    }
    function readZone(which) {
      const art = scroller.querySelector('article.doc-page');
      const z = art && art.querySelector(which === 'header' ? '.doc-header' : '.doc-footer');
      if (!z) return { text: '', page_num: false };
      const page_num = !!z.querySelector('.hf-pageno');
      const clone = z.cloneNode(true);
      clone.querySelectorAll('.hf-pageno').forEach(e => e.remove());
      const text = (clone.innerText || clone.textContent || '').replace(/ /g, ' ').trim();
      return { text, page_num };
    }
    // Pull the bands' current content into S.page so the save payload is fresh.
    function syncHeaderFooter() {
      if (!scroller.querySelector('article.doc-page .doc-hf')) return;
      const h = readZone('header'), f = readZone('footer');
      if (h.text || h.page_num || f.text || f.page_num) ensurePage();
      if (S.page) { S.page.header = h; S.page.footer = f; }
    }
    function setPageNumberIn(which, on) {
      const art = scroller.querySelector('article.doc-page');
      const z = art && art.querySelector(which === 'header' ? '.doc-header' : '.doc-footer');
      if (!z) return;
      const existing = z.querySelector('.hf-pageno');
      if (on && !existing) {
        if (z.textContent.trim() && !/\s$/.test(z.textContent)) z.appendChild(document.createTextNode(' '));
        z.appendChild(pageNoChip());
      } else if (!on && existing) {
        existing.remove();
      }
      markDirty(); syncHeaderFooter();
    }

    let hfMenu = null;
    function closeHFMenu() {
      if (!hfMenu) return;
      hfMenu.remove(); hfMenu = null;
      document.removeEventListener('mousedown', onHFMenuOutside, true);
    }
    function onHFMenuOutside(e) { if (hfMenu && !hfMenu.contains(e.target)) closeHFMenu(); }
    function openHFMenu(btn) {
      if (hfMenu) { closeHFMenu(); return; }
      syncHeaderFooter();
      const hp = (S.page && S.page.header) || {}, fp = (S.page && S.page.footer) || {};
      hfMenu = document.createElement('div');
      hfMenu.className = 'office-menu office-hfmenu';
      hfMenu.innerHTML = `
        <div class="hf-hint">Click the header or footer band on the page to type. Add a live page number:</div>
        <label class="hf-check"><input type="checkbox" data-hf-pn="header"${hp.page_num ? ' checked' : ''}> Page number in header</label>
        <label class="hf-check"><input type="checkbox" data-hf-pn="footer"${fp.page_num ? ' checked' : ''}> Page number in footer</label>`;
      document.body.appendChild(hfMenu);
      const r = btn.getBoundingClientRect();
      hfMenu.style.top = (r.bottom + 4) + 'px';
      hfMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - hfMenu.offsetWidth - 8)) + 'px';
      hfMenu.querySelectorAll('input[data-hf-pn]').forEach(cb =>
        cb.addEventListener('change', () => setPageNumberIn(cb.dataset.hfPn, cb.checked)));
      setTimeout(() => document.addEventListener('mousedown', onHFMenuOutside, true), 0);
    }

    // ── print / save as PDF ──────────────────────────────────────────────────
    function printDoc() {
      // Mirror the page geometry onto the printed paper (orientation + size).
      let style = null;
      if (S.page) {
        const [w, h] = pageDims(S.page);
        style = document.createElement('style');
        style.id = 'yr-print-page';
        style.textContent = `@page { size: ${w}in ${h}in; margin: 0; }`;
        document.head.appendChild(style);
      }
      document.body.classList.add('printing-office');
      const cleanup = () => {
        document.body.classList.remove('printing-office');
        if (style && style.parentNode) style.remove();
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      setTimeout(() => window.print(), 60);
      setTimeout(cleanup, 60000);
    }

    // ── toolbar ──────────────────────────────────────────────────────────────
    function buildTools() {
      zoomLabel = YR.ui.label(Math.round(S.zoom * 100) + '%');
      countLabel = YR.ui.label('');
      countLabel.style.minWidth = '34px';
      findBox = YR.ui.input({ placeholder: 'Find in document…', width: '160px', onEnter: runFind });
      // Three Lanes — LEFT: View ▾ (zoom). CENTER: find cluster + Edit + Read +
      // Notes. RIGHT: Print. AI lives in the header. Read keeps its top-level
      // button since toggleRead expects a button arg for the .active class.
      const viewMenu = YR.ui.menu({
        icon: YR.glyph('view'), label: 'View',
        title: 'Zoom — in / out / 100%',
        items: () => [
          { icon: '＋', label: 'Zoom in',  hint: '+',    run: () => setZoom(S.zoom + 0.1) },
          { icon: '－', label: 'Zoom out', hint: '−',    run: () => setZoom(S.zoom - 0.1) },
          { icon: '1', label: 'Reset to 100%',          run: () => setZoom(1.0) },
        ],
      });
      const findCluster = YR.ui.group([
        YR.ui.btn({ icon: '↑', title: 'Previous match', onClick: prevMatch }),
        YR.ui.btn({ icon: '↓', title: 'Next match', onClick: nextMatch }),
        YR.ui.btn({ icon: '⇄', title: 'Find & replace', onClick: (b) => openReplacePop(b) }),
      ]);
      YR.setTools([
        viewMenu, zoomLabel,                                                    // LEFT
        YR.ui.sep(),
        findBox, findCluster, countLabel,                                       // CENTER: find
        isDocx && YR.ui.btn({ icon: YR.glyph('edit'), label: 'Edit', title: 'Edit this document', onClick: enterEdit }),
        YR.ui.btn({ id: 'off-read', icon: '🔊', label: 'Read', title: 'Read aloud', onClick: (b) => toggleRead(b) }),
        YR.ui.btn({ icon: YR.glyph('notes'), label: 'Notes', title: 'Highlights & notes', onClick: (b) => {
          // Toggle: if the Notes tab is already showing, close the sidebar.
          if (YR.sidebar.isOpen() && S.sideMode === 'notes') { YR.sidebar.hide(); b.classList.remove('active'); return; }
          S.sideMode = 'notes'; openSidebar(); renderSide();
          b.classList.add('active');
        } }),
        YR.ui.sep(),
        YR.ui.btn({ icon: YR.glyph('print'), title: 'Print / Save as PDF', onClick: printDoc }),  // RIGHT
      ]);
      YR.setHeaderActions([
        YR.ui.btn({ icon: YR.glyph('sparkles'), label: 'AI', title: 'AI assistant', onClick: () => toggleAIRpanel() }),
      ]);
    }

    // ── sidebar (Outline / AI / Notes) ───────────────────────────────────────
    const sideWrap = document.createElement('div');
    sideWrap.className = 'doc-side';
    function openSidebar() { YR.sidebar.available(true); YR.sidebar.set(sideWrap); YR.sidebar.show(); }
    function buildSidebar() {
      YR.sidebar.available(true);
      YR.sidebar.set(sideWrap);
      renderSide();
    }
    function tabBar() {
      return `<div class="doc-tabs">
        <button data-m="outline" class="${S.sideMode === 'outline' ? 'active' : ''}">Outline</button>
        <button data-m="notes" class="${S.sideMode === 'notes' ? 'active' : ''}">Notes</button>
      </div>`;
    }
    function renderSide() {
      // AI no longer lives in the sidebar — it's in the right panel via toggleAIRpanel.
      if (S.sideMode === 'ai') S.sideMode = 'outline';
      sideWrap.innerHTML = tabBar() + '<div class="doc-side-body"></div>';
      sideWrap.querySelectorAll('.doc-tabs button').forEach(b =>
        b.addEventListener('click', () => { S.sideMode = b.dataset.m; renderSide(); }));
      const body = sideWrap.querySelector('.doc-side-body');
      if (S.sideMode === 'outline') renderOutline(body);
      else renderNotes(body);
    }
    function renderOutline(body) {
      if (!S.outline.length) { body.innerHTML = '<div class="empty-recent">No headings in this document.</div>'; return; }
      body.innerHTML = '';
      S.outline.forEach(o => {
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
    function renderNotes(body) {
      if (!S.annos.length) {
        body.innerHTML = '<div class="empty-recent">No highlights yet. Select text in the document to highlight it or add a note.</div>';
        return;
      }
      body.innerHTML = '';
      S.annos.forEach(a => {
        const card = document.createElement('div');
        card.className = 'note-card';
        card.innerHTML = `<span class="note-dot c-${a.color}"></span>
          <div class="note-body">
            <div class="note-quote">${YR.escapeHtml(a.quote)}</div>
            ${a.note ? `<div class="note-text">${YR.escapeHtml(a.note)}</div>` : ''}
          </div>
          <button class="note-x" title="Remove">✕</button>`;
        card.querySelector('.note-body').addEventListener('click', () => scrollToAnno(a.id));
        card.querySelector('.note-x').addEventListener('click', (e) => { e.stopPropagation(); removeAnnotation(a.id); });
        body.appendChild(card);
      });
    }

    // ── AI panel (rpanel — moved from sidebar) ───────────────────────────────
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
            `<div class="rp-sub">${YR.escapeHtml(doc.name || '')}</div></div>` +
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
    }
    function toggleAIRpanel() {
      if (YR.rpanel.isOpen() && aiWrap) { YR.rpanel.hide(); return; }
      openAIRpanel();
    }

    const AI_ACTIONS = [
      { task: 'summarize', label: 'Summarize' },
      { task: 'keypoints', label: 'Key points' },
      { task: 'simplify', label: 'Simplify' },
      { task: 'rewrite', label: 'Improve' },
      { task: 'translate', label: 'Translate' },
    ];
    function renderAI(body) {
      const sel = selectionText();
      const scopeNote = sel.trim()
        ? `<div class="ai-scope">Working on your <b>selection</b> (${sel.trim().length} chars)</div>`
        : `<div class="ai-scope">Working on the <b>whole document</b>. Select text first to target a passage.</div>`;
      body.innerHTML = `
        ${scopeNote}
        <div class="ai-actions">
          ${AI_ACTIONS.map(a => `<button class="ai-act" data-task="${a.task}">${a.label}</button>`).join('')}
        </div>
        <div class="ai-ask">
          <input class="tb-input" id="ai-q" placeholder="Ask a question about this document…" />
          <button class="ai-act" id="ai-ask-btn">Ask</button>
        </div>
        <div class="ai-output" id="ai-out"></div>`;
      body.querySelectorAll('.ai-act[data-task]').forEach(b =>
        b.addEventListener('click', () => runAI(b.dataset.task, selectionText() || docText())));
      const q = body.querySelector('#ai-q');
      const ask = () => { const v = q.value.trim(); if (v) runAI('ask', selectionText() || docText(), v); };
      body.querySelector('#ai-ask-btn').addEventListener('click', ask);
      q.addEventListener('keydown', e => { if (e.key === 'Enter') ask(); });
    }
    async function runAI(task, text, question) {
      if (!aiWrap) { openAIRpanel(); return; }
      YR.rpanel.show();
      const out = aiWrap.querySelector('#ai-out');
      if (!out) return;
      if (!text || !text.trim()) { out.innerHTML = '<div class="ai-err">No document text available.</div>'; return; }
      out.innerHTML = '<div class="stage-loading" style="position:static;padding:18px"><div class="yr-spinner"></div></div>';
      try {
        const r = await YR.postJSON('/api/ai', { task, text, question });
        const result = r.result || '(no response)';
        out.innerHTML = `<div class="ai-result"></div>
          <button class="ai-act ai-copy">⧉ Copy</button>`;
        out.querySelector('.ai-result').textContent = result;
        out.querySelector('.ai-copy').addEventListener('click', () => {
          navigator.clipboard && navigator.clipboard.writeText(result);
          YR.toast('Copied', '', 1200);
        });
      } catch (e) {
        out.innerHTML = `<div class="ai-err">${YR.escapeHtml(e.message || 'AI request failed')}<br>
          <span style="opacity:.8">Set up a model in Settings ▸ AI.</span></div>`;
      }
    }

    // ── editor (docx only): contenteditable + formatting ribbon + save ───────
    // We own both the editor's HTML output and the server-side HTML→docx
    // converter, so the full feature set below round-trips faithfully.
    let ribbon = null;
    let fidelityBanner = null;
    let savedRange = null;
    let imgBar = null, selectedImg = null;

    function editTarget() { return scroller.querySelector('.doc-page') || scroller; }
    function selInside() {
      const s = window.getSelection();
      return !!(s && s.rangeCount && scroller.contains(s.getRangeAt(0).commonAncestorContainer));
    }
    function rememberSel() { if (selInside()) savedRange = window.getSelection().getRangeAt(0).cloneRange(); }
    function restoreSel() {
      if (!savedRange) return;
      const s = window.getSelection();
      s.removeAllRanges(); s.addRange(savedRange);
    }
    function focusEdit() { const t = editTarget(); if (!selInside()) { t.focus(); restoreSel(); } else { t.focus(); } }
    function markDirty() { S.dirty = true; const b = document.getElementById('off-save'); if (b) b.classList.add('tb-dirty'); updateCount(); updateStatusStrip(); }
    function clearDirty() { S.dirty = false; const b = document.getElementById('off-save'); if (b) b.classList.remove('tb-dirty'); updateStatusStrip(); }
    function updateCount() {
      const el = document.getElementById('off-count');
      if (!el) return;
      const text = (editTarget().textContent || '').replace(/ /g, ' ').trim();
      const words = (text.match(/\S+/g) || []).length;
      const label = words.toLocaleString() + (words === 1 ? ' word · ' : ' words · ') + text.length.toLocaleString() + ' chars';
      el.textContent = label;
      const ssCount = statusStrip && statusStrip.querySelector('#ss-count > span:last-child');
      if (ssCount) ssCount.textContent = label;
    }

    // ── Edit-mode status strip (bottom of #stage; auto-updates with edits) ───
    let statusStrip = null;
    function mountStatusStrip() {
      if (statusStrip) return;
      statusStrip = document.createElement('div');
      statusStrip.className = 'status-strip';
      statusStrip.innerHTML =
        '<span class="ss" id="ss-save"><span class="gl">●</span><span>Unsaved</span></span>' +
        '<span class="ss" id="ss-count"><span class="gl">¶</span><span></span></span>' +
        '<span class="grow"></span>' +
        '<span class="ss" id="ss-page"><span class="gl">▭</span><span></span></span>';
      const stage = document.getElementById('stage');
      if (stage) stage.appendChild(statusStrip);
      updateStatusStrip();
      updateCount();
    }
    function updateStatusStrip() {
      if (!statusStrip) return;
      const save = statusStrip.querySelector('#ss-save');
      if (save) {
        save.querySelector('.gl').textContent = S.dirty ? '●' : '✓';
        save.querySelector('span:last-child').textContent = S.dirty ? 'Unsaved changes' : 'Saved';
      }
      const pg = statusStrip.querySelector('#ss-page > span:last-child');
      if (pg) {
        const p = S.page || {};
        const sz = (p.size || 'custom');
        const orient = (p.orientation || '');
        pg.textContent = (sz.charAt(0).toUpperCase() + sz.slice(1)) +
          (orient ? ' · ' + orient.charAt(0).toUpperCase() + orient.slice(1) : '');
      }
    }
    function unmountStatusStrip() {
      if (statusStrip) { statusStrip.remove(); statusStrip = null; }
    }

    function exec(cmd, val) {
      focusEdit();
      try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
      document.execCommand(cmd, false, val);
      rememberSel(); markDirty(); refreshRibbonState();
    }
    function setBlock(tag) { exec('formatBlock', tag); }
    function setFont(name) { exec('fontName', name); }
    function setColor(hex) { exec('foreColor', hex); }
    function setHilite(hex) { exec('hiliteColor', hex); }
    function insertLink() { const u = prompt('Link address:', 'https://'); if (u) exec('createLink', u); }
    function clearFmt() { exec('removeFormat'); exec('unlink'); }
    function insertHR() { exec('insertHorizontalRule'); }
    // Title/Subtitle are Word paragraph styles, carried as classes that the
    // converter maps to those styles (and back, on open). Other styles are
    // plain formatBlock tags — clear the Title/Subtitle class when leaving them.
    function applyBlockStyle(val) {
      if (val === 'title' || val === 'subtitle') {
        exec('formatBlock', '<p>');
        selectedBlocks().forEach(b => { b.classList.remove('doc-title', 'doc-subtitle'); b.classList.add('doc-' + val); });
        rememberSel(); markDirty(); refreshRibbonState();
      } else {
        selectedBlocks().forEach(b => {
          b.classList.remove('doc-title', 'doc-subtitle');
          if (!b.getAttribute('class')) b.removeAttribute('class');
        });
        setBlock(val);
      }
    }

    // True point sizes: fontSize=7 emits <font size="7"> (CSS-off), which we
    // rewrite to an inline pt size the docx converter understands.
    function setFontSize(pt) {
      const t = editTarget();
      focusEdit();
      try { document.execCommand('styleWithCSS', false, false); } catch (e) {}
      document.execCommand('fontSize', false, '7');
      try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
      t.querySelectorAll('font[size="7"]').forEach(f => {
        f.removeAttribute('size'); f.style.fontSize = pt + 'pt';
      });
      rememberSel(); markDirty(); refreshRibbonState();
    }

    function selectedBlocks() {
      const t = editTarget();
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return [];
      const range = sel.getRangeAt(0);
      const out = new Set();
      t.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,blockquote,td').forEach(el => {
        if (range.intersectsNode(el)) out.add(el);
      });
      if (!out.size) {
        let n = range.startContainer;
        while (n && n !== t) {
          if (n.nodeType === 1 && /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|TD)$/.test(n.nodeName)) { out.add(n); break; }
          n = n.parentNode;
        }
      }
      return [...out];
    }
    function setLineSpacing(v) {
      focusEdit();
      const blocks = selectedBlocks();
      if (!blocks.length) { YR.toast('Click inside a paragraph first', '', 1600); return; }
      blocks.forEach(b => { b.style.lineHeight = v; });
      rememberSel(); markDirty(); refreshRibbonState();
    }

    function ribbonHTML() {
      const fonts = ['Default', 'Arial', 'Calibri', 'Times New Roman', 'Georgia',
        'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Comic Sans MS'];
      const sizes = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
      const fontOpts = ['<option value="">Font</option>']
        .concat(fonts.map(f => `<option value="${f === 'Default' ? '' : f}">${f}</option>`)).join('');
      const sizeOpts = ['<option value="">Size</option>']
        .concat(sizes.map(s => `<option value="${s}">${s}</option>`)).join('');
      return `
        <div class="rb-group">
          <select class="rb-sel" data-act="block" title="Paragraph style">
            <option value="">Style</option>
            <option value="&lt;p&gt;">Normal</option>
            <option value="title">Title</option>
            <option value="subtitle">Subtitle</option>
            <option value="&lt;h1&gt;">Heading 1</option>
            <option value="&lt;h2&gt;">Heading 2</option>
            <option value="&lt;h3&gt;">Heading 3</option>
            <option value="&lt;h4&gt;">Heading 4</option>
            <option value="&lt;blockquote&gt;">Quote</option>
          </select>
        </div>
        <span class="rb-sep"></span>
        <div class="rb-group">
          <select class="rb-sel" data-act="font" title="Font">${fontOpts}</select>
          <select class="rb-sel" data-act="size" title="Font size">${sizeOpts}</select>
        </div>
        <span class="rb-sep"></span>
        <div class="rb-group">
          <button class="rb-btn b" data-cmd="bold" title="Bold (Ctrl+B)">B</button>
          <button class="rb-btn i" data-cmd="italic" title="Italic (Ctrl+I)">I</button>
          <button class="rb-btn u" data-cmd="underline" title="Underline (Ctrl+U)">U</button>
          <button class="rb-btn s" data-cmd="strikeThrough" title="Strikethrough">S</button>
          <button class="rb-btn" data-cmd="superscript" title="Superscript">x²</button>
          <button class="rb-btn" data-cmd="subscript" title="Subscript">x₂</button>
          <label class="rb-color txt" title="Text colour"><span>A</span><input type="color" data-act="color" value="#1a2230"></label>
          <label class="rb-color" title="Highlight colour"><span>🖍</span><input type="color" data-act="hilite" value="#ffe066"></label>
        </div>
        <span class="rb-sep"></span>
        <div class="rb-group">
          <button class="rb-btn" data-cmd="justifyLeft" title="Align left">↤</button>
          <button class="rb-btn" data-cmd="justifyCenter" title="Centre">↔</button>
          <button class="rb-btn" data-cmd="justifyRight" title="Align right">↦</button>
          <button class="rb-btn" data-cmd="justifyFull" title="Justify">☰</button>
        </div>
        <span class="rb-sep"></span>
        <div class="rb-group">
          <button class="rb-btn" data-cmd="insertUnorderedList" title="Bulleted list">•</button>
          <button class="rb-btn" data-cmd="insertOrderedList" title="Numbered list">1.</button>
          <button class="rb-btn" data-cmd="outdent" title="Decrease indent">⇤</button>
          <button class="rb-btn" data-cmd="indent" title="Increase indent">⇥</button>
          <select class="rb-sel" data-act="line" title="Line spacing">
            <option value="">Spacing</option>
            <option value="1">1.0</option>
            <option value="1.15">1.15</option>
            <option value="1.5">1.5</option>
            <option value="2">2.0</option>
            <option value="3">3.0</option>
          </select>
        </div>
        <span class="rb-sep"></span>
        <div class="rb-group">
          <button class="rb-btn" data-act="image" title="Insert image">🖼</button>
          <button class="rb-btn rb-wide" data-act="tablemenu" title="Table — insert, rows, columns, merge, header">▦ ▾</button>
          <button class="rb-btn" data-act="link" title="Insert link (Ctrl+K)">🔗</button>
          <button class="rb-btn" data-act="hr" title="Horizontal rule">―</button>
          <button class="rb-btn" data-act="chars" title="Insert symbol">Ω</button>
        </div>
        <span class="rb-sep"></span>
        <div class="rb-group">
          <button class="rb-btn rb-wide" data-act="pagesetup" title="Page setup — size, orientation, margins">▭ Page ▾</button>
          <button class="rb-btn rb-wide" data-act="headerfooter" title="Header &amp; footer — text and page numbers">▤ H/F ▾</button>
        </div>
        <span class="rb-sep"></span>
        <div class="rb-group">
          <button class="rb-btn" data-act="painter" title="Format painter — copy formatting, then select text to apply">🖌</button>
          <button class="rb-btn" data-act="clear" title="Clear formatting">⌫</button>
          <button class="rb-btn" data-act="find" title="Find &amp; replace (Ctrl+H)">🔍</button>
          <button class="rb-btn" data-cmd="undo" title="Undo (Ctrl+Z)">↶</button>
          <button class="rb-btn" data-cmd="redo" title="Redo (Ctrl+Y)">↷</button>
        </div>`;
    }
    function wireRibbon() {
      ribbon.querySelectorAll('.rb-btn[data-cmd]').forEach(b => {
        b.addEventListener('mousedown', e => e.preventDefault());  // keep selection
        b.addEventListener('click', () => exec(b.dataset.cmd));
      });
      // Selects reflect the caret's current formatting (set by refreshRibbonState),
      // so we no longer reset them to a placeholder after use.
      const bindSelect = (sel, fn) => {
        if (!sel) return;
        sel.addEventListener('mousedown', rememberSel);
        sel.addEventListener('focus', rememberSel);
        sel.addEventListener('change', () => { if (sel.value !== '') fn(sel.value); });
      };
      const bindColor = (inp, fn, swatch) => {
        if (!inp) return;
        inp.addEventListener('mousedown', rememberSel);
        inp.addEventListener('change', () => { fn(inp.value); if (swatch) swatch.style.borderBottomColor = inp.value; });
      };
      bindSelect(ribbon.querySelector('[data-act="block"]'), applyBlockStyle);
      bindSelect(ribbon.querySelector('[data-act="font"]'), setFont);
      bindSelect(ribbon.querySelector('[data-act="size"]'), v => setFontSize(parseFloat(v)));
      bindSelect(ribbon.querySelector('[data-act="line"]'), setLineSpacing);
      const colorInp = ribbon.querySelector('[data-act="color"]');
      bindColor(colorInp, setColor, colorInp.closest('.rb-color'));
      bindColor(ribbon.querySelector('[data-act="hilite"]'), setHilite);
      const actions = {
        image: insertImage, tablemenu: (b) => openTableMenu(b),
        link: insertLink, clear: clearFmt, find: (b) => openReplacePop(b),
        hr: insertHR, chars: (b) => openCharMenu(b), painter: armPainter,
        pagesetup: (b) => openPageSetup(b), headerfooter: (b) => openHFMenu(b),
      };
      ribbon.querySelectorAll('.rb-btn[data-act]').forEach(b => {
        const fn = actions[b.dataset.act];
        if (!fn) return;
        b.addEventListener('mousedown', e => { e.preventDefault(); rememberSel(); });
        b.addEventListener('click', () => fn(b));
      });
    }

    // Reflect the caret's current formatting in the ribbon controls.
    function setSelectByValue(sel, val) {
      if (!sel) return;
      val = (val == null ? '' : String(val));
      let ok = false;
      for (const o of sel.options) { if (o.value === val) { ok = true; break; } }
      sel.value = ok ? val : '';
    }
    function currentFontSizePt() {
      const s = window.getSelection();
      if (!s || !s.rangeCount) return '';
      let node = s.getRangeAt(0).startContainer;
      if (node && node.nodeType === 3) node = node.parentNode;
      if (!node || !scroller.contains(node)) return '';
      const px = parseFloat(getComputedStyle(node).fontSize);
      return px ? String(Math.round(px * 0.75)) : '';   // px → pt
    }
    function refreshRibbonState() {
      if (!ribbon || !S.editing || !selInside()) return;
      const ae = document.activeElement;
      if (ae && ae.tagName === 'SELECT' && ribbon.contains(ae)) return;  // don't fight an open dropdown
      const q = (c) => { try { return document.queryCommandState(c); } catch (e) { return false; } };
      ribbon.querySelectorAll('.rb-btn[data-cmd]').forEach(b => {
        const c = b.dataset.cmd;
        if (c === 'undo' || c === 'redo') return;
        b.classList.toggle('active', q(c));
      });
      let font = '';
      try { font = (document.queryCommandValue('fontName') || '').split(',')[0].replace(/^["']|["']$/g, '').trim(); } catch (e) {}
      setSelectByValue(ribbon.querySelector('[data-act="font"]'), font);
      const blk = selectedBlocks()[0];
      let blockVal = '';
      if (blk && blk.classList && blk.classList.contains('doc-title')) blockVal = 'title';
      else if (blk && blk.classList && blk.classList.contains('doc-subtitle')) blockVal = 'subtitle';
      else {
        let block = '';
        try { block = (document.queryCommandValue('formatBlock') || '').toLowerCase(); } catch (e) {}
        blockVal = block ? '<' + block + '>' : '';
      }
      setSelectByValue(ribbon.querySelector('[data-act="block"]'), blockVal);
      setSelectByValue(ribbon.querySelector('[data-act="size"]'), currentFontSizePt());
      setSelectByValue(ribbon.querySelector('[data-act="line"]'), blk ? (blk.style.lineHeight || '') : '');
    }

    // ── insert: image / table / rows / columns ───────────────────────────────
    function insertImage() {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        if (f) {
          const rd = new FileReader();
          rd.onload = () => {
            focusEdit();
            document.execCommand('insertImage', false, rd.result);
            markDirty(); rememberSel(); refreshRibbonState();
          };
          rd.readAsDataURL(f);
        }
        inp.remove();
      });
      inp.click();
    }
    function insertTable() {
      const spec = prompt('Table size — rows × columns:', '3x3');
      if (!spec) return;
      const m = spec.match(/(\d+)\s*[x×,\s]\s*(\d+)/i);
      const rows = Math.max(1, Math.min(50, m ? +m[1] : 3));
      const cols = Math.max(1, Math.min(20, m ? +m[2] : 3));
      let html = '<table><tbody>';
      for (let r = 0; r < rows; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) html += '<td><br></td>';
        html += '</tr>';
      }
      html += '</tbody></table><p><br></p>';
      focusEdit();
      document.execCommand('insertHTML', false, html);
      markDirty(); rememberSel();
    }
    function currentCell() {
      const s = window.getSelection();
      if (!s || !s.rangeCount) return null;
      let n = s.getRangeAt(0).startContainer;
      if (n && n.nodeType === 3) n = n.parentNode;
      const t = editTarget();
      while (n && n !== t) {
        if (n.nodeName === 'TD' || n.nodeName === 'TH') return n;
        n = n.parentNode;
      }
      return null;
    }
    function addRow() {
      const cell = currentCell();
      if (!cell) { YR.toast('Click inside a table cell first', '', 1800); return; }
      const tr = cell.closest('tr');
      const n = tr.children.length;
      const row = document.createElement('tr');
      for (let i = 0; i < n; i++) { const td = document.createElement('td'); td.innerHTML = '<br>'; row.appendChild(td); }
      tr.after(row);
      markDirty(); rememberSel();
    }
    function addCol() {
      const cell = currentCell();
      if (!cell) { YR.toast('Click inside a table cell first', '', 1800); return; }
      const table = cell.closest('table');
      const idx = Array.prototype.indexOf.call(cell.parentNode.children, cell);
      table.querySelectorAll('tr').forEach(tr => {
        const ref = tr.children[idx];
        const td = document.createElement(ref && ref.nodeName === 'TH' ? 'th' : 'td');
        td.innerHTML = '<br>';
        if (ref) ref.after(td); else tr.appendChild(td);
      });
      markDirty(); rememberSel();
    }
    // ── table edit ops (delete / merge / header / width) ──────────────────────
    function caretInto(node) {
      if (!node) return;
      const r = document.createRange();
      r.selectNodeContents(node); r.collapse(true);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }
    function dropTable(table) {
      const p = document.createElement('p'); p.innerHTML = '<br>';
      table.replaceWith(p); caretInto(p);
      markDirty(); rememberSel();
    }
    function delRow() {
      const cell = currentCell(); if (!cell) return;
      const tr = cell.closest('tr'); const table = cell.closest('table');
      if (table.rows.length <= 1) { dropTable(table); return; }
      const fallback = (tr.nextElementSibling || tr.previousElementSibling);
      const idx = cell.cellIndex;
      tr.remove();
      if (fallback && fallback.cells[idx]) caretInto(fallback.cells[idx]);
      markDirty(); rememberSel();
    }
    function delCol() {
      const cell = currentCell(); if (!cell) return;
      const table = cell.closest('table');
      const idx = cell.cellIndex;
      const maxCells = Math.max(...[...table.rows].map(r => r.cells.length));
      if (maxCells <= 1) { dropTable(table); return; }
      [...table.rows].forEach(r => { if (r.cells[idx]) r.cells[idx].remove(); });
      markDirty(); rememberSel();
    }
    function moveCellContent(target, src) {
      if (!src || !src.textContent.trim()) return;
      if (target.textContent.trim()) target.appendChild(document.createElement('br'));
      while (src.firstChild) target.appendChild(src.firstChild);
    }
    function mergeCell(dir) {
      const cell = currentCell(); if (!cell) return;
      if (dir === 'right') {
        const next = cell.nextElementSibling;
        if (!next || !/^T[DH]$/.test(next.nodeName)) { YR.toast('No cell to the right', '', 1600); return; }
        cell.setAttribute('colspan', (parseInt(cell.getAttribute('colspan')) || 1) + (parseInt(next.getAttribute('colspan')) || 1));
        moveCellContent(cell, next); next.remove();
      } else {
        const table = cell.closest('table');
        const below = (table.rows[cell.closest('tr').rowIndex + 1] || {}).cells?.[cell.cellIndex];
        if (!below) { YR.toast('No cell below', '', 1600); return; }
        cell.setAttribute('rowspan', (parseInt(cell.getAttribute('rowspan')) || 1) + (parseInt(below.getAttribute('rowspan')) || 1));
        moveCellContent(cell, below); below.remove();
      }
      caretInto(cell); markDirty(); rememberSel();
    }
    function splitCell() {
      const cell = currentCell(); if (!cell) return;
      const cs = parseInt(cell.getAttribute('colspan')) || 1;
      const rs = parseInt(cell.getAttribute('rowspan')) || 1;
      if (cs === 1 && rs === 1) { YR.toast('This cell isn’t merged', '', 1600); return; }
      const table = cell.closest('table'); const rowIdx = cell.closest('tr').rowIndex; const idx = cell.cellIndex;
      cell.removeAttribute('colspan'); cell.removeAttribute('rowspan');
      const tag = cell.nodeName.toLowerCase();
      for (let k = 1; k < cs; k++) { const c = document.createElement(tag); c.innerHTML = '<br>'; cell.after(c); }
      for (let k = 1; k < rs; k++) {
        const row = table.rows[rowIdx + k]; if (!row) break;
        const c = document.createElement('td'); c.innerHTML = '<br>';
        const ref = row.cells[idx]; if (ref) ref.before(c); else row.appendChild(c);
      }
      markDirty(); rememberSel();
    }
    function toggleHeaderRow() {
      const cell = currentCell(); if (!cell) return;
      const row = cell.closest('table').rows[0]; if (!row) return;
      const isHeader = [...row.cells].every(c => c.nodeName === 'TH');
      [...row.cells].forEach(c => {
        const repl = document.createElement(isHeader ? 'td' : 'th');
        for (const a of c.attributes) repl.setAttribute(a.name, a.value);
        while (c.firstChild) repl.appendChild(c.firstChild);
        if (!repl.innerHTML) repl.innerHTML = '<br>';
        c.replaceWith(repl);
      });
      markDirty(); rememberSel();
    }
    function setColWidth() {
      const cell = currentCell(); if (!cell) return;
      const cur = (cell.style.width || '').replace(/[^0-9.]/g, '');
      const val = prompt('Column width as % of the page (5–100). Leave blank for automatic:', cur);
      if (val === null) return;
      const table = cell.closest('table'); const idx = cell.cellIndex;
      const w = val.trim();
      const pct = w === '' ? '' : Math.max(5, Math.min(100, parseFloat(w) || 0)) + '%';
      [...table.rows].forEach(r => { const c = r.cells[idx]; if (c) c.style.width = pct; });
      markDirty(); rememberSel();
    }

    // ── image edit (click to select → floating bar: size / align / alt / delete) ─
    // All four ops round-trip through officedoc.py: width via style="width:%",
    // alignment via the containing block's text-align, alt via the alt attribute.
    const IMG_BLOCK = /^(P|DIV|H[1-6]|FIGURE|LI|BLOCKQUOTE|PRE|SECTION|ARTICLE)$/;
    function imgBlock(img) {
      let n = img.parentNode, t = editTarget();
      while (n && n !== t) { if (IMG_BLOCK.test(n.nodeName)) return n; n = n.parentNode; }
      return null;
    }
    function setImgWidth(pct) {
      if (!selectedImg) return;
      selectedImg.style.height = '';           // keep the aspect ratio
      selectedImg.style.width = pct + '%';
      markDirty(); positionImgBar();
    }
    function setImgAlign(dir) {
      if (!selectedImg) return;
      let block = imgBlock(selectedImg);
      if (!block) {                            // bare top-level image → wrap so align attaches
        const p = document.createElement('p');
        selectedImg.replaceWith(p); p.appendChild(selectedImg);
        block = p;
      }
      block.style.textAlign = dir;
      markDirty(); positionImgBar();
    }
    function editImgAlt() {
      if (!selectedImg) return;
      const v = prompt('Describe this image (alt text for accessibility):', selectedImg.getAttribute('alt') || '');
      if (v === null) return;
      if (v.trim()) selectedImg.setAttribute('alt', v.trim()); else selectedImg.removeAttribute('alt');
      markDirty();
    }
    function deleteImg() {
      if (!selectedImg) return;
      const img = selectedImg, block = imgBlock(img);
      deselectImage();
      img.remove();
      if (block && block !== editTarget() && !block.textContent.trim() && !block.querySelector('img')) block.innerHTML = '<br>';
      markDirty(); rememberSel();
    }
    function positionImgBar() {
      if (!imgBar || !selectedImg) return;
      const r = selectedImg.getBoundingClientRect();
      const bw = imgBar.offsetWidth, bh = imgBar.offsetHeight;
      let top = r.top - bh - 6;
      if (top < 6) top = Math.min(r.bottom + 6, window.innerHeight - bh - 6);
      let left = r.left + (r.width - bw) / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
      imgBar.style.top = top + 'px'; imgBar.style.left = left + 'px';
    }
    function showImgBar() {
      if (imgBar) imgBar.remove();
      imgBar = document.createElement('div');
      imgBar.className = 'office-imgbar';
      imgBar.innerHTML =
        '<button data-w="25" title="Width 25%">25%</button>'
        + '<button data-w="50" title="Width 50%">50%</button>'
        + '<button data-w="75" title="Width 75%">75%</button>'
        + '<button data-w="100" title="Full width">100%</button>'
        + '<span class="ib-sep"></span>'
        + '<button data-al="left" title="Align left">◧</button>'
        + '<button data-al="center" title="Align centre">▣</button>'
        + '<button data-al="right" title="Align right">◨</button>'
        + '<span class="ib-sep"></span>'
        + '<button data-act="alt" title="Alt text (accessibility)">Alt</button>'
        + '<button data-act="del" title="Remove image">🗑</button>';
      imgBar.querySelectorAll('button').forEach(b => {
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', () => {
          if (b.dataset.w) setImgWidth(+b.dataset.w);
          else if (b.dataset.al) setImgAlign(b.dataset.al);
          else if (b.dataset.act === 'alt') editImgAlt();
          else if (b.dataset.act === 'del') deleteImg();
        });
      });
      document.body.appendChild(imgBar);
      positionImgBar();
    }
    function selectImage(img) {
      if (selectedImg === img) { positionImgBar(); return; }
      deselectImage();
      selectedImg = img;
      img.classList.add('img-selected');
      showImgBar();
      document.addEventListener('mousedown', onImgOutside, true);
      scroller.addEventListener('scroll', positionImgBar, true);
      window.addEventListener('resize', positionImgBar);
    }
    function deselectImage() {
      if (!selectedImg) return;
      selectedImg.classList.remove('img-selected');
      if (!selectedImg.getAttribute('class')) selectedImg.removeAttribute('class');
      selectedImg = null;
      if (imgBar) { imgBar.remove(); imgBar = null; }
      document.removeEventListener('mousedown', onImgOutside, true);
      scroller.removeEventListener('scroll', positionImgBar, true);
      window.removeEventListener('resize', positionImgBar);
    }
    function onImgOutside(e) {
      if (!selectedImg || e.target === selectedImg) return;
      if (imgBar && imgBar.contains(e.target)) return;
      deselectImage();
    }
    function onEditClick(e) {
      const n = e.target;
      if (n && n.nodeName === 'IMG' && editTarget().contains(n)) selectImage(n);
      else deselectImage();
    }

    // ── table tools popup menu (keeps the ribbon compact) ─────────────────────
    let tableMenu = null;
    function closeTableMenu() {
      if (!tableMenu) return;
      tableMenu.remove(); tableMenu = null;
      document.removeEventListener('mousedown', onTableMenuOutside, true);
    }
    function onTableMenuOutside(e) {
      if (tableMenu && !tableMenu.contains(e.target)) closeTableMenu();
    }
    function openTableMenu(btn) {
      if (tableMenu) { closeTableMenu(); return; }
      const inTable = !!currentCell();
      const items = [
        ['Insert table…', insertTable, true],
        ['—'],
        ['Add row', addRow, inTable],
        ['Add column', addCol, inTable],
        ['Delete row', delRow, inTable],
        ['Delete column', delCol, inTable],
        ['—'],
        ['Merge right →', () => mergeCell('right'), inTable],
        ['Merge down ↓', () => mergeCell('down'), inTable],
        ['Split cell', splitCell, inTable],
        ['—'],
        ['Toggle header row', toggleHeaderRow, inTable],
        ['Column width…', setColWidth, inTable],
      ];
      tableMenu = document.createElement('div');
      tableMenu.className = 'office-menu';
      items.forEach(it => {
        if (it[0] === '—') { const s = document.createElement('div'); s.className = 'om-sep'; tableMenu.appendChild(s); return; }
        const b = document.createElement('button');
        b.className = 'om-item'; b.textContent = it[0]; b.disabled = !it[2];
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', () => { closeTableMenu(); it[1](); });
        tableMenu.appendChild(b);
      });
      document.body.appendChild(tableMenu);
      const r = btn.getBoundingClientRect();
      tableMenu.style.top = (r.bottom + 4) + 'px';
      tableMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - tableMenu.offsetWidth - 8)) + 'px';
      setTimeout(() => document.addEventListener('mousedown', onTableMenuOutside, true), 0);
    }

    // ── special-character palette ─────────────────────────────────────────────
    const SPECIAL_CHARS = ['—', '–', '…', '•', '·', '©', '®', '™', '°', '§', '¶', '†',
      '‡', '×', '÷', '±', '≈', '≠', '≤', '≥', '→', '←', '↑', '↓', '«', '»', '“', '”',
      '‘', '’', '€', '£', '¥', '¢', '½', '¼', '¾', '²', '³', 'µ', 'π', 'Σ', '√', '∞',
      '✓', '★'];
    let charMenu = null;
    function closeCharMenu() {
      if (!charMenu) return;
      charMenu.remove(); charMenu = null;
      document.removeEventListener('mousedown', onCharMenuOutside, true);
    }
    function onCharMenuOutside(e) { if (charMenu && !charMenu.contains(e.target)) closeCharMenu(); }
    function openCharMenu(btn) {
      if (charMenu) { closeCharMenu(); return; }
      charMenu = document.createElement('div');
      charMenu.className = 'office-menu office-charmenu';
      SPECIAL_CHARS.forEach(ch => {
        const b = document.createElement('button');
        b.className = 'oc-ch'; b.textContent = ch; b.title = ch;
        b.addEventListener('mousedown', e => e.preventDefault());
        b.addEventListener('click', () => { exec('insertText', ch); });
        charMenu.appendChild(b);
      });
      document.body.appendChild(charMenu);
      const r = btn.getBoundingClientRect();
      charMenu.style.top = (r.bottom + 4) + 'px';
      charMenu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - charMenu.offsetWidth - 8)) + 'px';
      setTimeout(() => document.addEventListener('mousedown', onCharMenuOutside, true), 0);
    }

    // ── format painter (copy formatting once, then apply to the next selection) ─
    let painterStyle = null;
    function painterBtn() { return ribbon && ribbon.querySelector('[data-act="painter"]'); }
    function armPainter() {
      if (painterStyle) { disarmPainter(); return; }
      const q = c => { try { return document.queryCommandState(c); } catch (e) { return false; } };
      const v = c => { try { return document.queryCommandValue(c) || ''; } catch (e) { return ''; } };
      painterStyle = {
        bold: q('bold'), italic: q('italic'), underline: q('underline'), strike: q('strikeThrough'),
        font: (v('fontName') || '').split(',')[0].replace(/^["']|["']$/g, '').trim(),
        color: v('foreColor'), sizePt: currentFontSizePt(),
      };
      const b = painterBtn(); if (b) b.classList.add('active');
      YR.toast('Format painter — now select the text to format', '', 2200);
    }
    function disarmPainter() { painterStyle = null; const b = painterBtn(); if (b) b.classList.remove('active'); }
    function applyPainter() {
      const s = painterStyle; if (!s) return;
      focusEdit();
      try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
      if (document.queryCommandState('bold') !== s.bold) document.execCommand('bold');
      if (document.queryCommandState('italic') !== s.italic) document.execCommand('italic');
      if (document.queryCommandState('underline') !== s.underline) document.execCommand('underline');
      if (document.queryCommandState('strikeThrough') !== s.strike) document.execCommand('strikeThrough');
      if (s.font) document.execCommand('fontName', false, s.font);
      if (s.color) document.execCommand('foreColor', false, s.color);
      if (s.sizePt) setFontSize(parseFloat(s.sizePt));
      rememberSel(); markDirty(); refreshRibbonState();
    }
    function onEditMouseUp() {
      rememberSel();
      if (!painterStyle) return;
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.getRangeAt(0).collapsed && selInside()) { applyPainter(); disarmPainter(); }
    }

    // ── paste sanitisation (strip Word/web cruft, keep safe formatting) ───────
    const PASTE_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL',
      'SUP', 'SUB', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
      'A', 'SPAN', 'FONT', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'DIV', 'PRE', 'CODE', 'IMG', 'HR']);
    const PASTE_STYLES = new Set(['font-family', 'font-size', 'font-weight', 'font-style',
      'text-decoration', 'text-decoration-line', 'color', 'background-color', 'background',
      'text-align', 'line-height', 'vertical-align']);
    function cleanPasteStyle(value) {
      const keep = [];
      (value || '').split(';').forEach(part => {
        const i = part.indexOf(':');
        if (i < 0) return;
        const k = part.slice(0, i).trim().toLowerCase();
        const v = part.slice(i + 1).trim();
        if (PASTE_STYLES.has(k) && v && !/expression|url\s*\(|javascript:/i.test(v)) keep.push(k + ': ' + v);
      });
      return keep.join('; ');
    }
    function sanitizeInto(src, dest) {
      src.childNodes.forEach(child => {
        if (child.nodeType === 3) { dest.appendChild(document.createTextNode(child.nodeValue)); return; }
        if (child.nodeType !== 1) return;                       // skip comments etc.
        const tag = child.tagName.toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'META' || tag === 'LINK' || tag === 'O:P') return;
        if (!PASTE_TAGS.has(tag)) { sanitizeInto(child, dest); return; }   // unwrap, keep text
        const el = document.createElement(tag.toLowerCase());
        const st = cleanPasteStyle(child.getAttribute('style'));
        if (st) el.setAttribute('style', st);
        if (tag === 'A') { const h = (child.getAttribute('href') || '').trim(); if (/^(https?:|mailto:|#)/i.test(h)) el.setAttribute('href', h); }
        else if (tag === 'IMG') {
          const s = (child.getAttribute('src') || '').trim();
          if (!/^(data:image\/|https?:)/i.test(s)) return;       // drop unsafe images
          el.setAttribute('src', s);
          const alt = child.getAttribute('alt'); if (alt) el.setAttribute('alt', alt);
        } else if (tag === 'FONT') {
          const face = child.getAttribute('face'); if (face) el.setAttribute('face', face);
          const col = child.getAttribute('color'); if (col) el.setAttribute('color', col);
        } else if (tag === 'TD' || tag === 'TH') {
          ['colspan', 'rowspan'].forEach(a => { const v = child.getAttribute(a); if (v && /^\d+$/.test(v)) el.setAttribute(a, v); });
        }
        sanitizeInto(child, el);
        dest.appendChild(el);
      });
    }
    function sanitizePastedHTML(html) {
      let parsed;
      try { parsed = new DOMParser().parseFromString(html, 'text/html'); } catch (e) { return ''; }
      const out = document.createElement('div');
      if (parsed && parsed.body) sanitizeInto(parsed.body, out);
      return out.innerHTML;
    }
    function onPaste(e) {
      const cd = e.clipboardData || window.clipboardData;
      if (!cd) return;                                           // let the browser handle it
      const html = cd.getData && cd.getData('text/html');
      const text = cd.getData ? cd.getData('text/plain') : '';
      e.preventDefault();
      if (html) {
        const clean = sanitizePastedHTML(html);
        if (clean) document.execCommand('insertHTML', false, clean);
        else if (text) document.execCommand('insertText', false, text);
      } else if (text) {
        document.execCommand('insertText', false, text);
      }
      markDirty(); rememberSel();
    }
    function buildRibbon() {
      if (ribbon) return;
      ribbon = document.createElement('div');
      ribbon.className = 'office-ribbon';
      ribbon.innerHTML = ribbonHTML();
      root.insertBefore(ribbon, scroller);
      root.style.display = 'flex'; root.style.flexDirection = 'column';
      scroller.style.height = 'auto'; scroller.style.flex = '1 1 auto'; scroller.style.minHeight = '0';
      wireRibbon();
    }
    function removeRibbon() {
      removeFidelityBanner();
      closeTableMenu();
      closeCharMenu();
      closePageSetup();
      closeHFMenu();
      disarmPainter();
      deselectImage();
      if (ribbon) { ribbon.remove(); ribbon = null; }
      root.style.display = ''; root.style.flexDirection = '';
      scroller.style.flex = ''; scroller.style.minHeight = ''; scroller.style.height = '100%';
    }

    // When the source .docx holds structure the rebuild can't reproduce, warn
    // precisely and block the lossy overwrite (Save As still writes a clean copy).
    function fidelityLossy() { return !!(S.fidelity && S.fidelity.lossy && (S.fidelity.features || []).length); }
    function showFidelityBanner() {
      if (!fidelityLossy() || fidelityBanner) return;
      const feats = S.fidelity.features.map(f => YR.escapeHtml(f)).join(', ');
      fidelityBanner = document.createElement('div');
      fidelityBanner.className = 'office-fidelity-warn';
      fidelityBanner.innerHTML =
        `<span class="ofw-i">⚠</span><span class="ofw-t">This file has <b>${feats}</b>. `
        + `YancoRead can’t rewrite those, so <b>Save (overwrite) is disabled</b> — use <b>Save As…</b> to keep a clean copy.</span>`
        + `<button class="ofw-x" title="Dismiss">✕</button>`;
      fidelityBanner.querySelector('.ofw-x').addEventListener('click', () => { removeFidelityBanner(); });
      root.insertBefore(fidelityBanner, root.firstChild);
    }
    function removeFidelityBanner() {
      if (fidelityBanner) { fidelityBanner.remove(); fidelityBanner = null; }
    }

    function buildEditTools() {
      const count = YR.ui.label('');
      count.id = 'off-count';
      YR.setTools([
        YR.ui.btn({ icon: '✓', label: 'Done', title: 'Finish editing', onClick: exitEdit }),
        YR.ui.sep(),
        YR.ui.btn({ id: 'off-save', icon: '💾', label: 'Save', title: 'Save — overwrites the file (a .bak backup is kept)', onClick: save }),
        YR.ui.btn({ icon: '⤓', label: 'Save As…', title: 'Save a copy as a new .docx', onClick: saveAs }),
        YR.ui.sep(),
        count,
      ]);
      updateCount();
      if (S.dirty) markDirty();
      if (fidelityLossy()) {
        const b = document.getElementById('off-save');
        if (b) { b.disabled = true; b.title = 'Disabled for this file (it has features YancoRead can’t rewrite) — use Save As… instead'; }
      }
    }

    let rbTimer = null;
    function onEditInput() { if (selectedImg) deselectImage(); markDirty(); rememberSel(); }
    function onSelChange() {
      if (!S.editing) return;
      clearTimeout(rbTimer);
      rbTimer = setTimeout(refreshRibbonState, 40);
    }
    function onEditKey(e) {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); save(); return; }
      if ((e.ctrlKey || e.metaKey) && k === 'k') { e.preventDefault(); insertLink(); return; }
      if ((e.ctrlKey || e.metaKey) && (k === 'h' || k === 'f')) { e.preventDefault(); openReplacePop(); }
    }
    function leaveGuard() {
      return (S.editing && S.dirty)
        ? 'You have unsaved changes that haven’t been written to the file yet. Leave and discard them?'
        : null;
    }
    function enterEdit() {
      if (S.editing) return;
      clearMarks(); stopReading(); closeReplacePop();
      S.editing = true;
      const t = editTarget();
      t.setAttribute('contenteditable', 'true');
      t.classList.add('doc-editing');
      t.spellcheck = true;
      try { document.execCommand('styleWithCSS', false, true); } catch (e) {}
      t.addEventListener('input', onEditInput);
      t.addEventListener('keyup', rememberSel);
      t.addEventListener('mouseup', onEditMouseUp);
      t.addEventListener('keydown', onEditKey);
      t.addEventListener('paste', onPaste);
      t.addEventListener('click', onEditClick);
      document.addEventListener('selectionchange', onSelChange);
      if (YR.setLeaveGuard) YR.setLeaveGuard(leaveGuard);
      buildEditTools();
      buildRibbon();
      mountStatusStrip();
      showFidelityBanner();
      renderHeaderFooter();      // reveal editable header/footer bands
      t.focus();
      refreshRibbonState();
      YR.toast(fidelityLossy()
        ? 'Editing — this file needs “Save As…” (see the notice above)'
        : 'Editing — use the ribbon, then Save', '', 2600);
    }
    function exitEdit() {
      if (!S.editing) return;
      syncHeaderFooter();        // capture band edits into S.page before re-rendering
      const t = editTarget();
      t.removeAttribute('contenteditable');
      t.classList.remove('doc-editing');
      t.removeEventListener('input', onEditInput);
      t.removeEventListener('keyup', rememberSel);
      t.removeEventListener('mouseup', onEditMouseUp);
      t.removeEventListener('keydown', onEditKey);
      t.removeEventListener('paste', onPaste);
      t.removeEventListener('click', onEditClick);
      deselectImage();
      disarmPainter();
      closeCharMenu();
      closePageSetup();
      closeHFMenu();
      document.removeEventListener('selectionchange', onSelChange);
      clearTimeout(rbTimer);
      closeReplacePop();
      if (YR.setLeaveGuard) YR.setLeaveGuard(null);
      S.editing = false;
      removeRibbon();
      unmountStatusStrip();
      buildTools();
      renderHeaderFooter();      // collapse empty bands back to read view
      if (S.dirty) YR.toast('Changes aren’t saved to the file yet — click Edit ▸ Save', '', 3000);
    }

    function getEditHTML() {
      const clone = editTarget().cloneNode(true);
      clone.querySelectorAll('.doc-hf').forEach(z => z.remove());   // header/footer travel in S.page, not the body
      clone.querySelectorAll('mark.doc-find').forEach(m => m.replaceWith(document.createTextNode(m.textContent)));
      clone.querySelectorAll('.doc-read-hl').forEach(e => e.classList.remove('doc-read-hl'));
      clone.querySelectorAll('img.img-selected').forEach(i => { i.classList.remove('img-selected'); if (!i.getAttribute('class')) i.removeAttribute('class'); });
      return clone.innerHTML;
    }
    // First overwrite of a session warns that this is a lossy rebuild (a .bak is
    // always kept). Acknowledged once, then remembered.
    function confirmOverwrite() {
      try { if (localStorage.getItem('yr-office-overwrite-ack') === '1') return true; } catch (e) { return true; }
      const ok = window.confirm(
        'Save overwrites the original .docx.\n\n' +
        'YancoRead rebuilds the file from the editor. Your text, formatting, tables, ' +
        'images, links, page setup and header/footer are kept; any Word-only feature ' +
        'it can’t show may change. A “.bak” backup of the original is kept beside it.\n\n' +
        'Tip: use “Save As…” to write a separate copy instead.\n\n' +
        'Overwrite the original now?');
      if (ok) { try { localStorage.setItem('yr-office-overwrite-ack', '1'); } catch (e) {} }
      return ok;
    }
    async function save() {
      if (fidelityLossy()) {
        YR.toast('This file has features YancoRead can’t rewrite — use “Save As…” to keep a clean copy.', '', 4200);
        return;
      }
      if (!confirmOverwrite()) return;
      const btn = document.getElementById('off-save');
      if (btn) btn.disabled = true;
      try {
        syncHeaderFooter();
        const r = await YR.postJSON('/api/office/save', { path, html: getEditHTML(), mode: 'overwrite', page: S.page });
        clearDirty();
        YR.toast('Saved' + (r.backup ? ' · backup kept' : ''), 'success', 2200);
      } catch (e) {
        YR.toast(e.message || 'Could not save', 'error', 3200);
      } finally {
        if (btn) btn.disabled = false;
      }
    }
    async function saveAs() {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.save_file) { YR.toast('Save As needs the desktop app — use Save instead', '', 3200); return; }
      const sep = path.lastIndexOf('\\') >= 0 ? '\\' : '/';
      const i = path.lastIndexOf(sep);
      const dir = i >= 0 ? path.slice(0, i) : '';
      const base = (i >= 0 ? path.slice(i + 1) : (doc.name || 'document.docx')).replace(/\.[^.]+$/, '');
      let target = null;
      try { target = await api.save_file(base + ' (edited).docx', dir); } catch (e) { target = null; }
      if (!target) return;  // cancelled
      try {
        syncHeaderFooter();
        const r = await YR.postJSON('/api/office/save', { html: getEditHTML(), mode: 'saveas', target, page: S.page });
        clearDirty();
        YR.toast('Saved a copy: ' + (r.name || 'new file'), 'success', 2600);
      } catch (e) {
        YR.toast(e.message || 'Could not save', 'error', 3200);
      }
    }

    S._scroller = scroller;
    S._stop = () => {
      stopReading(); closeSelPop(); closeReplacePop();
      if (YR.setLeaveGuard) YR.setLeaveGuard(null);
      if (S.editing) { try { removeRibbon(); } catch (e) {} }
      try { unmountStatusStrip(); } catch (e) {}
    };

    // Command palette entries (auto-cleared on unmount).
    if (isDocx) {
      YR.registerCommand({ g: 'Office', ic: '✎', name: 'Edit document', run: () => enterEdit() });
    }
    YR.registerCommand({ g: 'Office', ic: '🔊', name: 'Read aloud', run: () => toggleRead(document.getElementById('off-read')) });
    YR.registerCommand({ g: 'Office', ic: '🔍', name: 'Find in document', hint: 'Ctrl+F', run: () => { if (findBox) findBox.focus(); } });
    YR.registerCommand({ g: 'Office', ic: '🖍', name: 'Highlights & notes', run: () => { S.sideMode = 'notes'; openSidebar(); renderSide(); } });
    YR.registerCommand({ g: 'Office', ic: '🖨', name: 'Print / Save as PDF', run: () => printDoc() });

    mount._S = S;
  }

  function unmount() {
    const S = mount._S;
    if (S && S._stop) { try { S._stop(); } catch (e) {} }
    mount._S = null;
  }

  YR.registerReader('office', { mount, unmount });
})();
