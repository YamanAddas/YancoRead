/* YancoRead — PDF reader + tool profile (PyMuPDF-backed) */
(function () {
  'use strict';

  const RENDER_SCALE = Math.min(2, window.devicePixelRatio || 1);
  const LAZY_MARGIN = '1400px';
  // Reading-comfort filters applied to the rendered page images (CSS only — the
  // source PNGs are untouched). 'dark' is a true night mode: invert + hue-rotate
  // keeps colour photos roughly right while flipping white paper to near-black.
  const THEME_FILTER = {
    light: 'none',
    sepia: 'sepia(0.5) contrast(0.95) brightness(0.97)',
    dark: 'invert(0.92) hue-rotate(180deg)',
  };

  // Read-aloud (v2-4): the speech-synthesis voice list is fetched asynchronously
  // by the browser — getVoices() is empty until a 'voiceschanged' event fires.
  // Resolve once and cache at module scope so reopening documents is instant.
  let _ttsVoices = null, _ttsVoicesPromise = null;
  function loadVoices() {
    if (_ttsVoices) return Promise.resolve(_ttsVoices);
    if (_ttsVoicesPromise) return _ttsVoicesPromise;
    _ttsVoicesPromise = new Promise(resolve => {
      const synth = window.speechSynthesis;
      if (!synth) { _ttsVoices = []; resolve(_ttsVoices); return; }
      const ready = synth.getVoices();
      if (ready && ready.length) { _ttsVoices = ready; resolve(_ttsVoices); return; }
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        _ttsVoices = synth.getVoices() || [];
        resolve(_ttsVoices);
      };
      try { synth.addEventListener('voiceschanged', finish, { once: true }); } catch (_) { synth.onvoiceschanged = finish; }
      setTimeout(finish, 1500);   // fallback: some engines never fire the event
    });
    return _ttsVoicesPromise;
  }

  function mount(doc) {
    const path = doc.path;
    const count = doc.meta.page_count || 1;
    const pageSize = doc.meta.page_size || { width: 612, height: 792 };
    const prefs = Object.assign({ fit: 'width', zoom: 1.0, scroll: 'continuous', theme: 'light', spread: false, ttsRate: 1.0, ttsVoice: '' }, doc.prefs || {});

    const S = {
      fit: prefs.fit, userZoom: prefs.zoom || 1.0, scroll: prefs.scroll,
      theme: THEME_FILTER[prefs.theme] ? prefs.theme : 'light',
      spread: !!prefs.spread,
      rotate: 0, current: 0, observer: null, currentObs: null, thumbObs: null,
      searchHits: {},
      // text layer (v2-1): per-page word boxes cached from /api/pdf/words, used
      // to overlay invisible, selectable spans → native drag-select + copy.
      wordsCache: {}, textLayer: true,
      // markup (P5c): annotation mode, current tool/colour, unsaved state, and
      // per-page caches (annotation lists + image cache-bust versions).
      markup: false, tool: 'highlight', color: '#ffd54a',
      dirty: false, annotCache: {}, imgVer: {},
      // organize (P5d-2): a staged page plan committed to a NEW pdf on export;
      // it never mutates the working doc, so there's no dirty/leave-guard tie-in.
      org: { on: false, plan: null, drag: -1 },
      // fill (P7b): form-field mode. `fields` caches the widget descriptors from
      // /api/pdf/fields (null = not loaded yet); `edited` is the set of page
      // indices whose widget values changed (refreshed when leaving fill mode).
      fill: false, fields: null, fillEdited: {},
      // redaction (v2-2): stage black-out boxes locally, then bake them into a
      // NEW file (the working doc is never touched). `redRegions` maps a page
      // index → list of [x0,y0,x1,y1] rects in unrotated points; `redTool` is the
      // 'area' (drag a box) or 'text' (select words) sub-tool; the two booleans
      // are the apply-time options (echoed to /api/pdf/redact).
      redact: false, redTool: 'area', redRegions: {}, redImages: true, redScrub: false,
      // read-aloud (v2-4): TTS over the page text. Reuses /api/pdf/words for both
      // the words to speak (grouped into lines via the per-page line index) and
      // the boxes to highlight. Reads line-by-line, auto-advancing across pages —
      // one interactive mode + a playbar, mirroring markup/redact. No page overlay
      // captures pointers (the highlight is pointer-events:none), so it never
      // blocks selection; the moving highlight is only drawn upright (rot 0).
      tts: false, ttsPlaying: false, ttsPaused: false, ttsPage: 0, ttsLines: null,
      ttsIdx: 0, ttsGen: 0, ttsCurBox: null, ttsCurPage: -1, ttsUtter: null,
      ttsRate: +prefs.ttsRate || 1.0, ttsVoiceURI: prefs.ttsVoice || '',
    };
    const SPREAD_GAP = 16; // must match .page-row gap in readers.css

    // ── DOM ───────────────────────────────────────────────────────────────
    const root = YR.root;
    root.innerHTML = '';
    // the sign modal lives on <body> (outside YR.root) — clear any stray one left
    // over if a previous document was closed mid-signing.
    document.querySelectorAll('.sign-overlay, .sign-place, .ms-overlay, .xi-overlay').forEach(el => el.remove());
    const scroll = document.createElement('div');
    scroll.className = 'pages-scroll';
    root.appendChild(scroll);

    function stageWidth() {
      return YR.root.clientWidth || 900;
    }
    // Effective on-screen page dimensions at the current rotation: at 90°/270°
    // the rendered image's width and height swap, so all layout math must too.
    function pageDims() {
      const r = ((S.rotate % 360) + 360) % 360;
      return (r === 90 || r === 270)
        ? { w: pageSize.height, h: pageSize.width }
        : { w: pageSize.width, h: pageSize.height };
    }
    function fitZoom() {
      const dims = pageDims();
      const cols = S.spread ? 2 : 1;                 // two-up needs half the width per page
      const avail = (stageWidth() - 40 - (cols - 1) * SPREAD_GAP) / cols;
      if (S.fit === 'page') {
        const availH = (window.innerHeight - 54 - 48);
        return Math.min(avail / dims.w, availH / dims.h);
      }
      if (S.fit === 'actual') return 1.0;
      return avail / dims.w; // fit-width
    }
    function effZoom() {
      return Math.max(0.15, Math.min(6, fitZoom() * S.userZoom));
    }

    // ── page list ───────────────────────────────────────────────────────────
    function makePageWrap(i, cssW, cssH) {
      const wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.dataset.index = i;
      wrap.style.width = cssW + 'px';
      wrap.style.minHeight = cssH + 'px';
      const img = document.createElement('img');
      img.className = 'page-canvas';
      img.style.width = cssW + 'px';
      img.style.filter = THEME_FILTER[S.theme] || 'none';
      img.alt = 'Page ' + (i + 1);
      img.dataset.index = i;
      const tag = document.createElement('div');
      tag.className = 'page-num-tag';
      tag.textContent = (i + 1);
      wrap.appendChild(img);
      wrap.appendChild(tag);
      return wrap;
    }
    function buildPages() {
      const z = effZoom();
      const dims = pageDims();
      const cssW = dims.w * z;
      const cssH = dims.h * z;
      scroll.innerHTML = '';
      if (S.spread) {
        // book layout: pair pages into rows (0,1) (2,3) …; last odd page sits alone
        for (let i = 0; i < count; i += 2) {
          const row = document.createElement('div');
          row.className = 'page-row';
          row.appendChild(makePageWrap(i, cssW, cssH));
          if (i + 1 < count) row.appendChild(makePageWrap(i + 1, cssW, cssH));
          scroll.appendChild(row);
        }
      } else {
        for (let i = 0; i < count; i++) scroll.appendChild(makePageWrap(i, cssW, cssH));
      }
      attachObservers(z);
      drawSearchHighlights(z);
      syncMarkupLayers();
      syncFormLayers();
      syncRedactLayers();
    }

    function attachObservers(z) {
      if (S.observer) S.observer.disconnect();
      if (S.currentObs) S.currentObs.disconnect();

      // lazy-load page images as they near the viewport
      S.observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const img = e.target.querySelector('img');
          if (img && !img.src) {
            const v = S.imgVer[img.dataset.index] || 0;
            img.src = `/api/page?path=${encodeURIComponent(path)}&index=${img.dataset.index}&zoom=${(z * RENDER_SCALE).toFixed(3)}&rot=${S.rotate || 0}&v=${v}`;
          }
          ensureTextLayer(e.target, parseInt(e.target.dataset.index, 10), z);
          S.observer.unobserve(e.target);
        }
      }, { root: YR.root.parentElement, rootMargin: LAZY_MARGIN });

      // track the most-visible page for the indicator + position save
      S.currentObs = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio > 0.5) {
            S.current = parseInt(e.target.dataset.index, 10);
            updateIndicator();
            YR.savePosition(S.current, (S.current + 1) / count);
          }
        }
      }, { root: YR.root.parentElement, threshold: [0.5, 0.75] });

      scroll.querySelectorAll('.page-wrap').forEach(w => {
        S.observer.observe(w);
        S.currentObs.observe(w);
      });
    }

    function rerender() {
      const keep = S.current;
      closeSelPop();          // the rebuild destroys the live selection the bubble points at
      buildPages();
      gotoPage(keep, false);
      redrawTtsHighlight();   // the read-aloud highlight lived on an old page-wrap
    }

    // Overlay translucent boxes on matched pages. Rects come from the backend in
    // unrotated page points, so they only line up at rot=0; at other angles we
    // simply skip drawing (the stale boxes were already cleared by buildPages).
    function drawSearchHighlights(z) {
      scroll.querySelectorAll('.search-hl').forEach(el => el.remove());
      const hits = S.searchHits || {};
      if (S.rotate % 360 !== 0) return;
      Object.keys(hits).forEach(key => {
        const pi = parseInt(key, 10);
        const wrap = scroll.querySelector(`.page-wrap[data-index="${pi}"]`);
        if (!wrap) return;
        (hits[key] || []).forEach(rc => {
          const box = document.createElement('div');
          box.className = 'search-hl';
          box.style.left = (rc[0] * z) + 'px';
          box.style.top = (rc[1] * z) + 'px';
          box.style.width = Math.max(2, (rc[2] - rc[0]) * z) + 'px';
          box.style.height = Math.max(2, (rc[3] - rc[1]) * z) + 'px';
          wrap.appendChild(box);
        });
      });
    }

    // Briefly pulse a box around one annotation (used by the Notes manager's
    // jump-to). Like the search highlight it lives in unrotated page points, so
    // it's only coherent upright; at other angles we just skip the flash and
    // still scroll. Pointer-transparent, self-removing.
    function flashAnnot(page, rect) {
      if (!rect || rect.length < 4 || S.rotate % 360 !== 0) return;
      const draw = () => {
        const wrap = scroll.querySelector(`.page-wrap[data-index="${page}"]`);
        if (!wrap) return;
        const z = effZoom();
        const box = document.createElement('div');
        box.className = 'annot-flash';
        box.style.cssText =
          `position:absolute;left:${rect[0] * z}px;top:${rect[1] * z}px;` +
          `width:${Math.max(8, (rect[2] - rect[0]) * z)}px;` +
          `height:${Math.max(8, (rect[3] - rect[1]) * z)}px;` +
          'border:2px solid var(--accent);border-radius:4px;' +
          'box-shadow:0 0 0 3px rgba(124,154,255,.35);pointer-events:none;' +
          'z-index:5;opacity:1;transition:opacity .55s ease';
        wrap.appendChild(box);
        setTimeout(() => { box.style.opacity = '0'; }, 750);
        setTimeout(() => box.remove(), 1400);
      };
      setTimeout(draw, 60);   // let gotoPage's scroll settle so we measure the live zoom
    }

    // ── selectable text layer (v2-1) ──────────────────────────────────────────
    // Lay an invisible, selectable HTML text layer over each rendered page so an
    // image-based PDF gains native drag-select + copy. Word boxes arrive from the
    // backend in displayed page points; we scale them by the same zoom the search
    // highlights use, so each span sits over its glyphs. Words are grouped into
    // per-line blocks so a native copy emits spaces between words and newlines
    // between lines. Like search highlights, it's only coherent upright (rot 0).
    function ensureTextLayer(wrap, idx, z) {
      if (!S.textLayer || S.rotate % 360 !== 0) return;
      if (S.wordsCache[idx]) { buildTextLayer(wrap, idx, z); return; }
      YR.getJSON(`/api/pdf/words?path=${encodeURIComponent(path)}&page=${idx}`)
        .then(data => {
          S.wordsCache[idx] = data || { words: [] };
          const w = scroll.querySelector(`.page-wrap[data-index="${idx}"]`);
          if (w) buildTextLayer(w, idx, effZoom());   // zoom may have moved while fetching
        })
        .catch(() => { S.wordsCache[idx] = { words: [] }; });
    }
    function buildTextLayer(wrap, idx, z) {
      const old = wrap.querySelector('.text-layer');
      if (old) old.remove();
      if (!S.textLayer || S.rotate % 360 !== 0) return;
      const data = S.wordsCache[idx];
      const words = (data && data.words) || [];
      if (!words.length) return;
      const layer = document.createElement('div');
      layer.className = 'text-layer';
      layer._page = idx;                            // for the selection bubble's highlight action
      const spans = [];
      let line = null, lineKey = -1;
      words.forEach(w => {
        const x0 = w[0], y0 = w[1], x1 = w[2], y1 = w[3], t = w[4], lk = w[5];
        if (!line || lk !== lineKey) {              // new line → new block parent (for copy newlines)
          line = document.createElement('div');
          line.className = 'tl-line';
          layer.appendChild(line);
          lineKey = lk;
        }
        const sp = document.createElement('span');
        sp._box = [x0, y0, x1, y1];                 // word rect in page points → anchors a real highlight
        // trailing space lives INSIDE the span (white-space:pre keeps it from
        // collapsing) so a native copy separates words; scaleX below targets the
        // word-only box, so the visible selection highlight still hugs the glyphs.
        sp.textContent = t + ' ';
        sp.style.left = (x0 * z) + 'px';
        sp.style.top = (y0 * z) + 'px';
        sp.style.fontSize = ((y1 - y0) * z) + 'px';
        sp._tw = (x1 - x0) * z;                     // target on-screen width (word only)
        line.appendChild(sp);
        spans.push(sp);
      });
      wrap.appendChild(layer);
      // one batched reflow: squeeze each span horizontally so its (transparent)
      // glyphs — and thus the native selection highlight — match the word's width.
      spans.forEach(sp => {
        const natural = sp.getBoundingClientRect().width;
        if (natural > 0 && sp._tw > 0) sp.style.transform = `scaleX(${(sp._tw / natural).toFixed(4)})`;
      });
    }

    // ── selection bubble (v2-1c) ──────────────────────────────────────────────
    // When the user drag-selects across the invisible text layer, float a compact
    // action bubble (mirrors the text reader's .doc-selpop): Copy the text, anchor
    // a real word-shaped highlight/underline/strikeout on the selected words, or
    // send the selection to the AI panel. It's naturally gated — in markup/fill/
    // sign modes the annotation/form/placement overlay sits above the text layer,
    // so no selection can start there — and we belt-and-braces guard on those flags.
    let selPop = null;
    const SEL_MARK = [
      ['highlight', '🖍', 'Highlight these words'],
      ['underline', 'U̲', 'Underline these words'],
      ['strikeout', 'S̶', 'Strike out these words'],
    ];
    const SEL_AI_PDF = [
      ['explain', '💡 Explain'],
      ['summarize', '✦ Summarize'],
    ];
    function closeSelPop() { if (selPop) { selPop.remove(); selPop = null; } }

    // The trimmed selection text, but only when the selection actually lives inside
    // one of our text layers (so selecting sidebar/toolbar text never triggers it).
    function selectionInLayer() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return '';
      const txt = sel.toString().trim();
      if (!txt) return '';
      const inLayer = n => {
        const el = n && (n.nodeType === 1 ? n : n.parentElement);
        return !!(el && el.closest && el.closest('.text-layer'));
      };
      return (inLayer(sel.anchorNode) || inLayer(sel.focusNode)) ? txt : '';
    }

    // Collect the page-point word boxes that intersect the selection, grouped by
    // the page index each text layer carries — this anchors a real, saveable mark.
    function selectedWordRectsByPage() {
      const sel = window.getSelection();
      const out = {};
      if (!sel || sel.isCollapsed || !sel.rangeCount) return out;
      scroll.querySelectorAll('.text-layer').forEach(layer => {
        const pg = layer._page;
        layer.querySelectorAll('span').forEach(sp => {
          if (sp._box && sel.containsNode(sp, true)) (out[pg] || (out[pg] = [])).push(sp._box);
        });
      });
      return out;
    }

    async function markSelection(kind) {
      const byPage = selectedWordRectsByPage();
      const pages = Object.keys(byPage);
      closeSelPop();
      if (!pages.length) return;
      try { window.getSelection().removeAllRanges(); } catch (_) { /* non-fatal */ }
      let total = 0;
      for (const pg of pages) {
        total += byPage[pg].length;
        await postAnnot(parseInt(pg, 10), { kind, rects: byPage[pg], color: S.color });
      }
      const verb = kind === 'underline' ? 'Underlined' : kind === 'strikeout' ? 'Struck out' : 'Highlighted';
      YR.toast(`${verb} ${total} word${total === 1 ? '' : 's'} · 💾 Save to keep it in the PDF`, 'success', 2600);
    }

    async function askAIOnSelection(task, txt) {
      const text = (txt || '').trim();
      if (!text) return;
      closeSelPop();
      mountAIRpanel();
      YR.rpanel.show();
      await renderAIPanel();          // builds the AI panel (incl. #ai-out)
      if (!aiWrap) return;
      const out = aiWrap.querySelector('#ai-out');
      if (!out) return;
      const note = `<div class="ai-scope" style="margin:0 0 6px">Working on your selection · ` +
        `${text.length.toLocaleString()} character${text.length === 1 ? '' : 's'}.</div>`;
      await aiComplete(out, task, text, undefined, note);
    }

    function showSelPop(rect, txt) {
      closeSelPop();
      const sw = (S.color || '#ffd54a');
      selPop = document.createElement('div');
      selPop.className = 'doc-selpop';
      selPop.innerHTML =
        '<button class="sp-btn" data-act="copy" title="Copy">⧉</button>' +
        '<span class="hl-sw" title="Mark colour (set in Markup)" style="background:' + sw + '"></span>' +
        SEL_MARK.map(m => `<button class="sp-btn" data-mark="${m[0]}" title="${m[2]}">${m[1]}</button>`).join('') +
        SEL_AI_PDF.map(a => `<button class="sp-btn" data-task="${a[0]}">${a[1]}</button>`).join('');
      // keep the selection alive while a button is pressed (don't steal focus)
      selPop.addEventListener('mousedown', e => e.preventDefault());
      document.body.appendChild(selPop);
      const above = rect.top - selPop.offsetHeight - 8;
      selPop.style.top = (above < 8 ? rect.bottom + 8 : above) + 'px';
      const mid = rect.left + (rect.width || 0) / 2;
      selPop.style.left =
        Math.max(8, Math.min(mid - selPop.offsetWidth / 2,
                             window.innerWidth - selPop.offsetWidth - 8)) + 'px';
      selPop.querySelector('[data-act="copy"]').addEventListener('click', () => {
        if (navigator.clipboard) navigator.clipboard.writeText(txt);
        YR.toast('Copied', '', 1200); closeSelPop();
      });
      selPop.querySelectorAll('.sp-btn[data-mark]').forEach(b =>
        b.addEventListener('click', () => markSelection(b.dataset.mark)));
      selPop.querySelectorAll('.sp-btn[data-task]').forEach(b =>
        b.addEventListener('click', () => askAIOnSelection(b.dataset.task, txt)));
    }

    function onSelMouseUp(e) {
      if (selPop && selPop.contains(e.target)) return;          // a click on the bubble itself
      if (S.redact) {                                           // redaction owns text selection
        if (S.redTool === 'text') addSelectionToRedaction();    // stage the selected words
        closeSelPop(); return;
      }
      if (S.markup || S.fill || placeBox) { closeSelPop(); return; }  // an overlay owns the page
      const txt = selectionInLayer();
      if (!txt) { closeSelPop(); return; }
      const sel = window.getSelection();
      const r = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      if (r && (r.width || r.height)) showSelPop(r, txt); else closeSelPop();
    }
    function selPopOutside(e) { if (selPop && !selPop.contains(e.target)) closeSelPop(); }

    function gotoPage(i, smooth = true) {
      i = Math.max(0, Math.min(i, count - 1));
      const w = scroll.querySelector(`.page-wrap[data-index="${i}"]`);
      if (w) w.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
      S.current = i;
      updateIndicator();
    }

    // ── toolbar ─────────────────────────────────────────────────────────────
    let pageInput, zoomLabel, scrubber, progLabel;
    let scrubbing = false, scrubRAF = 0, scrubTarget = 0;
    function updateIndicator() {
      if (pageInput && document.activeElement !== pageInput) pageInput.value = (S.current + 1);
      if (progLabel) progLabel.textContent = (count ? Math.round(((S.current + 1) / count) * 100) : 0) + '%';
      if (scrubber && !scrubbing) scrubber.value = String(S.current + 1);
      if (sideMode === 'thumbs') syncThumbActive();
    }
    function scrubTo(v) {
      scrubTarget = Math.max(0, Math.min(Math.round(v) - 1, count - 1));
      if (pageInput) pageInput.value = String(scrubTarget + 1);
      if (progLabel) progLabel.textContent = (count ? Math.round(((scrubTarget + 1) / count) * 100) : 0) + '%';
      if (scrubRAF) return;
      scrubRAF = requestAnimationFrame(() => { scrubRAF = 0; gotoPage(scrubTarget, false); });
    }
    function setTheme(t) {
      S.theme = THEME_FILTER[t] ? t : 'light';
      scroll.querySelectorAll('img.page-canvas').forEach(im => im.style.filter = THEME_FILTER[S.theme] || 'none');
      YR.savePrefs('pdf', { theme: S.theme });
    }
    function setZoom(mult) {
      S.userZoom = Math.max(0.25, Math.min(5, mult));
      zoomLabel.textContent = Math.round(S.userZoom * 100) + '%';
      YR.savePrefs('pdf', { zoom: S.userZoom });
      rerender();
    }
    function setFit(fit) {
      S.fit = fit; S.userZoom = 1.0;
      YR.savePrefs('pdf', { fit });
      fitWidthBtn.classList.toggle('active', fit === 'width');
      fitPageBtn.classList.toggle('active', fit === 'page');
      actualBtn.classList.toggle('active', fit === 'actual');
      zoomLabel.textContent = '100%';
      rerender();
    }
    function rotateBy(delta) {
      if (S.markup || S.redact) return;   // markup/redact need an upright, unrotated coordinate frame
      S.rotate = ((((S.rotate + delta) % 360) + 360) % 360);
      if (rotateBtn) rotateBtn.classList.toggle('active', S.rotate !== 0);
      rerender();   // rebuild boxes (dims swap) + re-fetch images at the new angle
    }
    function toggleSpread() {
      S.spread = !S.spread;
      if (spreadBtn) spreadBtn.classList.toggle('active', S.spread);
      YR.savePrefs('pdf', { spread: S.spread });
      rerender();   // re-pair pages into rows (or back to a single column)
    }
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveDoc(); return; }
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      let handled = true;
      switch (e.key) {
        case 'ArrowRight': case 'PageDown': gotoPage(S.current + 1); break;
        case 'ArrowLeft': case 'PageUp': gotoPage(S.current - 1); break;
        case ' ': gotoPage(S.current + (e.shiftKey ? -1 : 1)); break;
        case 'Home': gotoPage(0); break;
        case 'End': gotoPage(count - 1); break;
        case '+': case '=': setZoom(S.userZoom + 0.1); break;
        case '-': case '_': setZoom(S.userZoom - 0.1); break;
        case '0': setZoom(1.0); break;
        case 'r': case 'R': rotateBy(e.shiftKey ? -90 : 90); break;
        case 'd': case 'D': toggleSpread(); break;
        case 'm': case 'M': toggleMarkup(); break;
        case 't': case 'T': toggleRead(); break;
        case 'Escape':
          if (S.tts) toggleRead();
          else if (S.redact) toggleRedact();
          else if (S.markup) toggleMarkup();
          else handled = false;
          break;
        case 'g': case 'G': if (pageInput) { pageInput.focus(); pageInput.select(); } break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    }

    pageInput = YR.ui.input({
      value: '1', width: '46px',
      onEnter: v => { const n = parseInt(v, 10); if (n) gotoPage(n - 1); },
    });
    pageInput.style.textAlign = 'center';
    pageInput.title = 'Go to page (g)';
    zoomLabel = YR.ui.label('100%');
    progLabel = YR.ui.label('0%');

    const fitWidthBtn = YR.ui.btn({ label: 'Width', title: 'Fit width', active: S.fit === 'width', onClick: () => setFit('width') });
    const fitPageBtn = YR.ui.btn({ label: 'Page', title: 'Fit page', active: S.fit === 'page', onClick: () => setFit('page') });
    const actualBtn = YR.ui.btn({ label: '1:1', title: 'Actual size', active: S.fit === 'actual', onClick: () => setFit('actual') });
    const rotateBtn = YR.ui.btn({ icon: '⟳', title: 'Rotate 90° clockwise (r · Shift+r reverses)', onClick: () => rotateBy(90) });
    const spreadBtn = YR.ui.btn({ icon: '◫', title: 'Two-page spread · book view (d)', active: S.spread, onClick: () => toggleSpread() });

    const navGroup = YR.ui.group([
      YR.ui.btn({ icon: '◀', title: 'Previous page (←)', onClick: () => gotoPage(S.current - 1) }),
      YR.ui.btn({ icon: '▶', title: 'Next page (→)', onClick: () => gotoPage(S.current + 1) }),
    ]);
    const zoomGroup = YR.ui.group([
      YR.ui.btn({ icon: '－', title: 'Zoom out (-)', onClick: () => setZoom(S.userZoom - 0.1) }),
      zoomLabel,
      YR.ui.btn({ icon: '＋', title: 'Zoom in (+)', onClick: () => setZoom(S.userZoom + 0.1) }),
    ]);

    scrubber = YR.ui.range({
      min: 1, max: Math.max(1, count), step: 1, value: 1,
      title: 'Drag to move through the document',
      onInput: scrubTo,
    });
    scrubber.style.width = '120px';
    scrubber.addEventListener('pointerdown', () => { scrubbing = true; });
    const endScrub = () => { scrubbing = false; gotoPage(scrubTarget, false); };
    scrubber.addEventListener('pointerup', endScrub);
    scrubber.addEventListener('change', endScrub);

    const themeSel = YR.ui.select({
      title: 'Reading theme / night mode',
      value: S.theme,
      options: [{ value: 'light', label: '☀ Light' }, { value: 'sepia', label: '📜 Sepia' }, { value: 'dark', label: '🌙 Dark' }],
      onChange: setTheme,
    });

    const searchBox = YR.ui.input({
      placeholder: 'Search…', width: '150px',
      onEnter: runSearch,
    });

    // Mode buttons keep their labels — with AI now living in .tb-right, the
    // top bar has enough room. Labels matter for discoverability of modes.
    const markupBtn = YR.ui.btn({ icon: '✎', label: 'Markup', title: 'Annotate / mark up (m)', onClick: () => toggleMarkup() });
    const redactBtn = YR.ui.btn({ icon: '⬛', label: 'Redact', title: 'Redact — permanently black out text or areas, then save a new copy (your original PDF is never changed)', onClick: () => toggleRedact() });
    const signBtn = YR.ui.btn({ icon: '✍', label: 'Sign', title: 'Sign & stamp — draw, type or import a signature, then place it on the page', onClick: () => openSignPanel() });
    const fillBtn = YR.ui.btn({ icon: '📝', label: 'Fill', title: 'Fill form fields — type into the PDF’s boxes, ticks and dropdowns, then Save', onClick: () => toggleFill() });
    const readBtn = YR.ui.btn({ icon: '🔊', label: 'Read aloud', title: 'Read aloud — have the page read to you, line by line, with the current line highlighted (t)', onClick: () => toggleRead() });
    const saveBtn = YR.ui.btn({ id: 'pdf-save', icon: '💾', label: 'Save', title: 'Save annotations to the PDF (Ctrl+S)', onClick: () => saveDoc() });
    const organizeBtn = YR.ui.btn({ icon: '🗂', label: 'Organize', title: 'Organize pages — reorder, rotate, delete, then export a new PDF', onClick: () => openOrganizer() });
    const mergeBtn = YR.ui.btn({ icon: '🔗', label: 'Combine', title: 'Merge or split — join PDFs together or pull page ranges into new files (your original is never changed)', onClick: () => openMergeSplit() });
    const exportBtn = YR.ui.btn({ icon: '📤', label: 'Export', title: 'Export & optimize — save pages as images or write a smaller, optimized copy (your original PDF is never changed)', onClick: () => openExportHub() });

    // Page navigation + zoom live on a floating bottom bar (2026 redesign);
    // top bar carries mode-specific actions only.
    YR.bottomBar([
      navGroup,
      pageInput, YR.ui.label('/ ' + count),
      scrubber, progLabel,
      YR.ui.sep(),
      zoomGroup,
    ]);

    // Categorize less-frequent actions under dropdown menus so the top bar
    // doesn't overflow at typical desktop widths. Modes stay individually
    // visible (one-button-per-mode discipline). View groups fit/rotate/spread;
    // Tools groups produce-new-file ops (organize/merge/export).
    const viewMenu = YR.ui.menu({
      icon: YR.glyph('view'),
      label: 'View',
      title: 'Page view — fit, rotate, spread, theme',
      items: () => [
        { icon: '↔', label: 'Fit width',   active: S.fit === 'width',  run: () => setFit('width') },
        { icon: '⤢', label: 'Fit page',    active: S.fit === 'page',   run: () => setFit('page') },
        { icon: '1', label: 'Actual size', active: S.fit === 'actual', run: () => setFit('actual') },
        { separator: true },
        { icon: '⟳', label: 'Rotate 90° clockwise', hint: 'r', run: () => rotateBy(90) },
        { icon: '⟲', label: 'Rotate 90° counter-clockwise', hint: 'Shift+R', run: () => rotateBy(-90) },
        { separator: true },
        { icon: '◫', label: 'Two-page spread', active: S.spread, hint: 'd', run: () => toggleSpread() },
        { separator: true },
        { icon: '🌙', label: 'Dark theme',  active: S.theme === 'dark',  run: () => setTheme('dark') },
        { icon: '📜', label: 'Sepia theme', active: S.theme === 'sepia', run: () => setTheme('sepia') },
        { icon: '☀', label: 'Light theme', active: S.theme === 'light', run: () => setTheme('light') },
      ],
    });
    const toolsMenu = YR.ui.menu({
      icon: YR.glyph('tools'),
      label: 'Tools',
      title: 'Pages, merge, export & optimize',
      items: [
        { icon: '🗂', label: 'Organize pages…',     run: () => openOrganizer() },
        { icon: '🔗', label: 'Merge or split PDFs…', run: () => openMergeSplit() },
        { icon: '📤', label: 'Export & optimize…',   run: () => openExportHub() },
      ],
    });

    // Three Lanes layout: View ▾ on the left, primary action + secondary modes
    // in the center, workflow exits on the right. Markup is the visible
    // primary mode (most-used); Redact/Sign/Fill/Read fold into Modes ▾ with
    // active dots, and the menu button glows when any of them is on.
    const modesMenu = YR.ui.menu({
      icon: YR.glyph('modes'), label: 'Modes',
      title: 'Other modes — Redact / Sign & stamp / Fill / Read aloud',
      items: () => [
        { icon: '⬛', label: 'Redact',       active: S.redact, run: () => toggleRedact() },
        { icon: '✍', label: 'Sign & stamp…',                  run: () => openSignPanel() },
        { icon: '📝', label: 'Fill forms',   active: S.fill,   run: () => toggleFill() },
        { icon: '🔊', label: 'Read aloud',   active: S.tts, hint: 't', run: () => toggleRead() },
      ],
    });
    S._modesMenu = modesMenu;        // referenced by mode togglers below to refresh active state

    YR.setTools([
      viewMenu,                       // LEFT lane
      YR.ui.sep(),
      searchBox, markupBtn, modesMenu, // CENTER lane: search + primary mode + secondary modes
      YR.ui.sep(),
      saveBtn, toolsMenu,             // RIGHT lane: workflow
      YR.makeBookmarkTool(() => ({ page: S.current, label: 'Page ' + (S.current + 1) }),
        m => gotoPage(m.page)),
    ]);
    // AI lives in .tb-right (always visible, outside .tb-tools overflow).
    YR.setHeaderActions([
      YR.ui.btn({ icon: YR.glyph('sparkles'), label: 'AI', title: 'AI reading tools', onClick: () => toggleAIRpanel() }),
    ]);

    // Command palette entries for this reader (auto-cleared on unmount).
    YR.registerCommand({ g: 'PDF', ic: '✎', name: 'Markup — annotate & highlight', hint: 'm', run: () => toggleMarkup() });
    YR.registerCommand({ g: 'PDF', ic: '⬛', name: 'Redact — black out text or areas', run: () => toggleRedact() });
    YR.registerCommand({ g: 'PDF', ic: '✍', name: 'Sign & stamp…', run: () => openSignPanel() });
    YR.registerCommand({ g: 'PDF', ic: '📝', name: 'Fill form fields', run: () => toggleFill() });
    YR.registerCommand({ g: 'PDF', ic: '🔊', name: 'Read aloud', hint: 't', run: () => toggleRead() });
    YR.registerCommand({ g: 'PDF', ic: '💾', name: 'Save', hint: 'Ctrl+S', run: () => saveDoc() });
    YR.registerCommand({ g: 'PDF', ic: '🗂', name: 'Organize pages…', run: () => openOrganizer() });
    YR.registerCommand({ g: 'PDF', ic: '🔗', name: 'Merge or split PDFs…', run: () => openMergeSplit() });
    YR.registerCommand({ g: 'PDF', ic: '📤', name: 'Export & optimize…', run: () => openExportHub() });

    // ── sidebar: outline + search ─────────────────────────────────────────────
    let sideMode = 'outline';
    const sideWrap = document.createElement('div');
    function renderSidebarHeader() {
      const tab = (m, label) => `<button class="tb-btn ${sideMode === m ? 'active' : ''}" data-m="${m}" style="flex:1 1 auto;min-width:44px;padding-left:6px;padding-right:6px">${label}</button>`;
      return `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px">${tab('outline', 'Outline')}${tab('thumbs', 'Pages')}${tab('search', 'Search')}${tab('notes', 'Notes')}${tab('info', 'Info')}</div>`;
    }
    function mountSidebar() {
      sideWrap.innerHTML = renderSidebarHeader() + '<div id="side-body"></div>';
      sideWrap.querySelectorAll('[data-m]').forEach(b =>
        b.addEventListener('click', () => { sideMode = b.dataset.m; mountSidebar(); }));
      YR.sidebar.set(sideWrap);
      renderSideBody();
    }
    function renderSideBody() {
      if (sideMode === 'search') renderSearchResults();
      else if (sideMode === 'notes') renderNotes();
      else if (sideMode === 'info') renderInfo();
      else if (sideMode === 'thumbs') renderThumbs();
      else loadOutline();
    }
    let outlineLoaded = false, outlineData = [], outlinePromise = null;
    async function ensureOutline() {
      if (outlineLoaded) return outlineData;
      if (outlinePromise) return outlinePromise;     // dedupe concurrent callers → one fetch
      outlinePromise = (async () => {
        try { outlineData = (await YR.getJSON(`/api/outline?path=${encodeURIComponent(path)}`)).outline || []; }
        catch (e) { outlineData = []; }
        outlineLoaded = true;
        return outlineData;
      })();
      return outlinePromise;
    }
    async function loadOutline() {
      const body = sideWrap.querySelector('#side-body');
      if (!body) return;
      await ensureOutline();
      if (!outlineData.length) { body.innerHTML = '<div class="empty-recent">No outline in this document.</div>'; return; }
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
    let searchResults = [];
    async function runSearch(q) {
      if (!q || !q.trim()) return;
      sideMode = 'search'; mountSidebar();
      const body = sideWrap.querySelector('#side-body');
      body.innerHTML = '<div class="stage-loading" style="position:static;padding:20px"><div class="yr-spinner"></div></div>';
      YR.sidebar.show();
      try { searchResults = (await YR.getJSON(`/api/search?path=${encodeURIComponent(path)}&q=${encodeURIComponent(q)}`)).results || []; }
      catch (e) { searchResults = []; }
      applySearchHits();
      renderSearchResults();
    }
    function applySearchHits() {
      const hits = {};
      for (const r of searchResults) {
        if (r.rects && r.rects.length) hits[r.page] = r.rects;
      }
      S.searchHits = hits;
      drawSearchHighlights(effZoom());
    }
    function clearSearch() {
      searchResults = [];
      S.searchHits = {};
      drawSearchHighlights(effZoom());
      if (sideMode === 'search') renderSearchResults();
    }
    function renderSearchResults() {
      const body = sideWrap.querySelector('#side-body');
      if (!body) return;
      if (!searchResults.length) { body.innerHTML = '<div class="empty-recent">No matches.</div>'; return; }
      const totalHits = searchResults.reduce((s, r) => s + (r.count || 0), 0);
      body.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">' +
          `<h3 style="margin:0">${totalHits} match${totalHits === 1 ? '' : 'es'} · ${searchResults.length} pg</h3>` +
          '<button class="ai-act" id="search-clear" style="padding:3px 9px">Clear</button></div>';
      const clearBtn = body.querySelector('#search-clear');
      if (clearBtn) clearBtn.addEventListener('click', clearSearch);
      searchResults.forEach(r => {
        const b = document.createElement('button');
        b.className = 'outline-item';
        b.innerHTML = `<b style="color:var(--accent)">p.${r.page + 1}</b> — ${YR.escapeHtml(r.snippet)}`;
        b.style.whiteSpace = 'normal';
        b.addEventListener('click', () => gotoPage(r.page));
        body.appendChild(b);
      });
    }

    // ── sidebar: notes (v2-5 annotation manager) ──────────────────────────────
    // A document-wide list of every annotation (all pages, page-ordered) with
    // jump-to-and-flash, inline note/colour editing, and delete — no new toolbar
    // buttons. Edits go through /api/pdf/annotation/update; deletes reuse the
    // markup delete route. Markup itself still adds annotations; this just
    // manages them.
    const KIND_LABEL = {
      Highlight: 'Highlight', Underline: 'Underline', StrikeOut: 'Strikeout',
      Squiggly: 'Squiggly', Square: 'Rectangle', Circle: 'Oval', Line: 'Line',
      Ink: 'Drawing', Text: 'Note', FreeText: 'Text box', Polygon: 'Polygon',
      PolyLine: 'Polyline', Stamp: 'Stamp',
    };
    const NOTE_COLORS = ['#ffd54a', '#ff5252', '#4caf50', '#42a5f5', '#ab47bc', '#1a1a1a'];
    function rgbToHex(c) {
      if (!Array.isArray(c) || c.length < 3) return '';
      const h = n => Math.round(Math.max(0, Math.min(1, +n)) * 255).toString(16).padStart(2, '0');
      return '#' + h(c[0]) + h(c[1]) + h(c[2]);
    }
    let notesData = [];
    async function renderNotes() {
      const body = sideWrap.querySelector('#side-body');
      if (!body) return;
      body.innerHTML = '<div class="stage-loading" style="position:static;padding:20px"><div class="yr-spinner"></div></div>';
      try { notesData = (await YR.getJSON(`/api/pdf/annotations?path=${encodeURIComponent(path)}`)).annotations || []; }
      catch (e) { notesData = []; }
      if (sideMode !== 'notes') return;                  // user switched tabs while fetching
      const b = sideWrap.querySelector('#side-body');
      if (!b) return;
      b.innerHTML = '';
      b.appendChild(notesToolbar());                     // count + export/import (always shown)
      if (!notesData.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-recent';
        empty.innerHTML = 'No annotations yet.<br>Turn on <b>Markup</b> to highlight, note or draw — or <b>Import</b> a .json / .xfdf file.';
        b.appendChild(empty);
        return;
      }
      let lastPage = -1;
      notesData.forEach(a => {
        if (a.page !== lastPage) {
          const hd = document.createElement('div');
          hd.textContent = 'Page ' + (a.page + 1);
          hd.style.cssText = 'font-size:11px;font-weight:700;opacity:.55;margin:10px 0 4px;letter-spacing:.04em;text-transform:uppercase';
          b.appendChild(hd);
          lastPage = a.page;
        }
        b.appendChild(noteRow(a));
      });
    }
    // count + export/import controls — lives in the Notes tab so the top toolbar
    // gains no new buttons. Export uses the native save dialog when running in
    // the app (else writes alongside the PDF); import reads a local .json / .xfdf.
    function notesToolbar() {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-bottom:10px';
      const h3 = document.createElement('h3');
      h3.style.cssText = 'margin:0 0 6px';
      h3.textContent = notesData.length
        ? `${notesData.length} annotation${notesData.length === 1 ? '' : 's'}`
        : 'Annotations';
      wrap.appendChild(h3);
      const acts = document.createElement('div');
      acts.style.cssText = 'display:flex;gap:5px;flex-wrap:wrap';
      const mk = (label, title, fn) => {
        const x = document.createElement('button');
        x.className = 'ai-act'; x.textContent = label; x.title = title;
        x.style.cssText = 'padding:3px 9px;font-size:12px';
        x.addEventListener('click', fn);
        return x;
      };
      if (notesData.length) {
        acts.appendChild(mk('⬆ JSON', 'Export all annotations as a YancoRead .json file (full fidelity — best for backup/restore in YancoRead)', () => exportNotes('json')));
        acts.appendChild(mk('⬆ XFDF', 'Export all annotations as an .xfdf file (Adobe interchange — opens in Acrobat and other PDF tools)', () => exportNotes('xfdf')));
      }
      acts.appendChild(mk('⬇ Import', 'Import annotations from a .json or .xfdf file (added on top of the current ones)', importNotes));
      wrap.appendChild(acts);
      return wrap;
    }
    async function exportNotes(fmt) {
      const api = window.pywebview && window.pywebview.api;
      const payload = { path, fmt };
      if (api && api.save_file) {
        const { dir, base } = splitPath(path);
        let dest = null;
        try {
          dest = await api.save_file(`${base || 'document'}-annotations.${fmt}`, dir,
            [(fmt === 'xfdf' ? 'XFDF annotations (*.xfdf)' : 'JSON annotations (*.json)'), 'All files (*.*)']);
        } catch (_) { dest = null; }
        if (!dest) return;                               // user cancelled the dialog
        payload.dest = dest;
      }
      try {
        const r = await YR.postJSON('/api/pdf/annotations/export', payload);
        YR.toast(`Exported ${notesData.length} annotation${notesData.length === 1 ? '' : 's'} → ${r.name}`, 'success', 3400);
      } catch (e) {
        YR.toast('Export failed: ' + (e.message || 'error'), 'error', 3200);
      }
    }
    function importNotes() {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,.xfdf,.xml,application/json,application/xml';
      inp.style.display = 'none';
      inp.addEventListener('change', async () => {
        const f = inp.files && inp.files[0];
        inp.remove();
        if (!f) return;
        let text;
        try { text = await f.text(); }
        catch (e) { YR.toast('Could not read that file', 'error', 2800); return; }
        const ext = (f.name.split('.').pop() || '').toLowerCase();
        const fmt = (ext === 'xfdf' || ext === 'xml') ? 'xfdf' : (ext === 'json' ? 'json' : '');
        try {
          const r = await YR.postJSON('/api/pdf/annotations/import', { path, fmt, data: text });
          for (let i = 0; i < count; i++) { S.annotCache[i] = null; S.imgVer[i] = (S.imgVer[i] || 0) + 1; }
          setDirty(true);
          rerender();                                    // repaint every page with the imported markup
          if (sideMode === 'notes') renderNotes();
          const msg = `Imported ${r.added} annotation${r.added === 1 ? '' : 's'}`
            + (r.skipped ? ` · ${r.skipped} skipped` : '');
          YR.toast(msg, r.added ? 'success' : '', 3600);
        } catch (e) {
          YR.toast('Import failed: ' + (e.message || 'error'), 'error', 3800);
        }
      });
      document.body.appendChild(inp);
      inp.click();
    }
    function noteRow(a) {
      const wrap = document.createElement('div');
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:6px;margin-bottom:4px';
      wrap.appendChild(row);

      const jump = document.createElement('button');
      jump.className = 'outline-item';
      jump.style.cssText = 'flex:1 1 auto;white-space:normal;display:flex;gap:8px;align-items:flex-start';
      const hex = rgbToHex(a.color);
      const sw = `<span style="flex:none;width:13px;height:13px;border-radius:3px;margin-top:2px;${hex ? `background:${hex};border:1px solid rgba(0,0,0,.25)` : 'border:1px dashed var(--border)'}"></span>`;
      const label = KIND_LABEL[a.kind] || a.kind || 'Annotation';
      const note = (a.content || '').trim();
      jump.innerHTML = sw + (note
        ? `<span><b>${YR.escapeHtml(label)}</b> — ${YR.escapeHtml(note)}</span>`
        : `<span style="opacity:.7"><b>${YR.escapeHtml(label)}</b></span>`);
      jump.addEventListener('click', () => { gotoPage(a.page); flashAnnot(a.page, a.rect); });
      row.appendChild(jump);

      const edit = document.createElement('button');
      edit.className = 'ai-act'; edit.textContent = '✎'; edit.title = 'Edit note / colour';
      edit.style.cssText = 'flex:none;padding:3px 8px';
      edit.addEventListener('click', () => {
        const open = wrap.querySelector('.note-editor');
        if (open) { open.remove(); return; }             // toggle off
        wrap.appendChild(noteEditor(a));
      });
      row.appendChild(edit);

      const del = document.createElement('button');
      del.className = 'ai-act'; del.textContent = '✕'; del.title = 'Delete annotation';
      del.style.cssText = 'flex:none;padding:3px 8px';
      del.addEventListener('click', () => deleteAnnot(a.page, a.id));   // hook re-renders this list
      row.appendChild(del);
      return wrap;
    }
    function noteEditor(a) {
      const ed = document.createElement('div');
      ed.className = 'note-editor';
      ed.style.cssText = 'padding:8px;margin:2px 0 10px;border:1px solid var(--border);border-radius:8px';
      const ta = document.createElement('textarea');
      ta.value = a.content || '';
      ta.placeholder = 'Note text…';
      ta.rows = 2;
      ta.style.cssText = 'width:100%;box-sizing:border-box;resize:vertical;margin-bottom:8px;font:inherit';
      ed.appendChild(ta);

      let chosen = rgbToHex(a.color) || '';
      const pal = document.createElement('div');
      pal.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px';
      const swatches = [];
      const markSel = () => swatches.forEach(s =>
        s.style.outline = (s.dataset.hex.toLowerCase() === chosen.toLowerCase() ? '2px solid var(--accent)' : 'none'));
      NOTE_COLORS.forEach(c => {
        const s = document.createElement('button');
        s.dataset.hex = c; s.title = c;
        s.style.cssText = `width:20px;height:20px;border-radius:4px;border:1px solid rgba(0,0,0,.3);background:${c};outline-offset:1px;cursor:pointer`;
        s.addEventListener('click', () => { chosen = c; markSel(); });
        swatches.push(s); pal.appendChild(s);
      });
      const custom = document.createElement('input');
      custom.type = 'color';
      custom.value = /^#[0-9a-f]{6}$/i.test(chosen) ? chosen : '#ffd54a';
      custom.title = 'Custom colour';
      custom.style.cssText = 'width:28px;height:24px;padding:0;border:1px solid var(--border);border-radius:4px;background:none;cursor:pointer';
      custom.addEventListener('input', () => { chosen = custom.value; markSel(); });
      pal.appendChild(custom);
      ed.appendChild(pal);
      markSel();

      const acts = document.createElement('div');
      acts.style.cssText = 'display:flex;gap:6px;justify-content:flex-end';
      const cancel = document.createElement('button');
      cancel.className = 'ai-act'; cancel.textContent = 'Cancel';
      cancel.style.padding = '3px 10px';
      cancel.addEventListener('click', () => ed.remove());
      const save = document.createElement('button');
      save.textContent = 'Save';
      save.style.cssText = 'padding:3px 12px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer';
      save.addEventListener('click', async () => {
        save.disabled = true;
        const spec = { text: ta.value };
        if (chosen) spec.color = chosen;
        const r = await updateAnnot(a.page, a.id, spec);   // success re-renders the whole list
        if (r) flashAnnot(a.page, a.rect); else save.disabled = false;
      });
      acts.appendChild(cancel); acts.appendChild(save);
      ed.appendChild(acts);
      return ed;
    }

    // ── sidebar: info (document properties + copy text) ───────────────────────
    let infoData = null, infoErr = '', infoLoading = false;
    function ii(label, val) {
      return `<div class="ii-row"><span class="ii-k">${YR.escapeHtml(label)}</span>` +
        `<span class="ii-v">${YR.escapeHtml(val)}</span></div>`;
    }
    function infoHTML(d) {
      const meta = [];
      if (d.title) meta.push(ii('Title', d.title));
      if (d.author) meta.push(ii('Author', d.author));
      if (d.subject) meta.push(ii('Subject', d.subject));
      if (d.keywords) meta.push(ii('Keywords', d.keywords));
      const file = [ii('Format', d.format || 'PDF'), ii('Pages', String(d.page_count))];
      if (d.page_width && d.page_height) file.push(ii('Page size', `${d.page_width} × ${d.page_height} pt`));
      file.push(ii('File size', d.size_human || '—'));
      file.push(ii('Encrypted', d.encrypted ? 'Yes' : 'No'));
      const origin = [];
      if (d.creator) origin.push(ii('Creator', d.creator));
      if (d.producer) origin.push(ii('Producer', d.producer));
      if (d.created) origin.push(ii('Created', d.created));
      if (d.modified) origin.push(ii('Modified', d.modified));
      let html = '';
      if (meta.length) html += `<div class="ii-sec"><h4>Document</h4>${meta.join('')}</div>`;
      html += `<div class="ii-sec"><h4>File</h4>${file.join('')}</div>`;
      if (origin.length) html += `<div class="ii-sec"><h4>Origin</h4>${origin.join('')}</div>`;
      html += '<div class="ii-sec"><h4>Copy text</h4>' +
        '<div class="ai-actions">' +
        '<button class="ai-act" id="pdf-copy-page">This page</button>' +
        '<button class="ai-act" id="pdf-copy-all">Whole document</button>' +
        '</div></div>';
      return html;
    }
    async function copyText(start, end, btn, scope) {
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Copying…';
      try {
        const d = await YR.getJSON(
          `/api/doc-text?path=${encodeURIComponent(path)}&start=${start}&end=${end}&max=2000000`);
        const text = (d && d.text) || '';
        if (!text.trim()) { YR.toast('No selectable text ' + scope + ' (it may be scanned images)', '', 3000); return; }
        await navigator.clipboard.writeText(text);
        YR.toast(`Copied ${text.length.toLocaleString()} characters` + (d.truncated ? ' (truncated)' : ''), 'success', 1800);
      } catch (e) {
        YR.toast('Copy failed: ' + ((e && e.message) || 'unknown error'), 'error', 2800);
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    }
    function renderInfo() {
      const body = sideWrap.querySelector('#side-body');
      if (!body) return;
      if (infoErr) { body.innerHTML = `<div class="ai-err">${YR.escapeHtml(infoErr)}</div>`; return; }
      if (infoData) {
        body.innerHTML = infoHTML(infoData);
        const pageBtn = body.querySelector('#pdf-copy-page');
        const allBtn = body.querySelector('#pdf-copy-all');
        if (pageBtn) pageBtn.addEventListener('click', () => copyText(S.current, S.current + 1, pageBtn, 'on this page'));
        if (allBtn) allBtn.addEventListener('click', () => copyText(0, count, allBtn, 'in this document'));
        return;
      }
      body.innerHTML = '<div class="stage-loading" style="position:static;padding:18px"><div class="yr-spinner"></div></div>';
      if (infoLoading) return;
      infoLoading = true;
      YR.getJSON(`/api/pdf-info?path=${encodeURIComponent(path)}`)
        .then(d => { infoData = d; infoLoading = false; if (sideMode === 'info') renderInfo(); })
        .catch(e => { infoErr = (e && e.message) || 'Could not read document info'; infoLoading = false; if (sideMode === 'info') renderInfo(); });
    }

    // ── rpanel: AI reading tools (uses /api/doc-text + the shared /api/ai) ────
    // The AI panel lives in the right panel (#rpanel) — not the left sidebar.
    // mountAIRpanel builds the wrap structure (.rp-head + .rp-body + #side-body)
    // into the rpanel; renderAIPanel fills #side-body with the controls. The
    // sidebar's AI tab has been removed; askAIOnSelection re-routes here too.
    let aiWrap = null;
    function mountAIRpanel() {
      const wrap = document.createElement('div');
      wrap.style.display = 'flex';
      wrap.style.flexDirection = 'column';
      wrap.style.height = '100%';
      wrap.innerHTML =
        '<div class="rp-head">' +
          '<div class="rp-icon">✦</div>' +
          '<div><div class="rp-title">AI Reading Tools</div>' +
            `<div class="rp-sub">${YR.escapeHtml(doc.name || '')}</div></div>` +
          '<button class="rp-close" title="Close (Ctrl+J)">✕</button>' +
        '</div>' +
        '<div class="rp-body"><div id="side-body"></div></div>';
      wrap.querySelector('.rp-close').addEventListener('click', () => YR.rpanel.hide());
      aiWrap = wrap;
      YR.rpanel.set(wrap);
    }
    function openAIRpanel() {
      mountAIRpanel();
      renderAIPanel();
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
      { task: 'explain', label: 'Explain' },
    ];
    function sectionRange() {
      if (!outlineData || !outlineData.length) return [S.current, S.current + 1];
      let si = 0;
      for (let i = 0; i < outlineData.length; i++) {
        if (outlineData[i].page <= S.current) si = i; else break;
      }
      const start = outlineData[si].page;
      let end = count;
      for (let i = si + 1; i < outlineData.length; i++) {
        if (outlineData[i].page > start) { end = outlineData[i].page; break; }
      }
      return [start, Math.max(start + 1, end)];
    }
    function scopeRange(scope) {
      if (scope === 'section') return sectionRange();
      if (scope === 'document') return [0, count];
      return [S.current, S.current + 1];
    }
    async function renderAIPanel() {
      if (!aiWrap) return;
      let body = aiWrap.querySelector('#side-body');
      if (!body) return;
      body.innerHTML = '<div class="stage-loading" style="position:static;padding:18px"><div class="yr-spinner"></div></div>';
      await ensureOutline();
      if (!aiWrap || !YR.rpanel.isOpen()) return;
      body = aiWrap.querySelector('#side-body');
      if (!body) return;
      const hasToc = !!(outlineData && outlineData.length);
      body.innerHTML =
        '<div class="ai-scope">Work on ' +
          '<select class="tb-input" id="ai-scope" style="width:auto">' +
            '<option value="page">this page</option>' +
            (hasToc ? '<option value="section">this section</option>' : '') +
            '<option value="document">whole document</option>' +
          '</select></div>' +
        '<div class="ai-actions">' +
          AI_ACTIONS.map(a => `<button class="ai-act" data-task="${a.task}">${a.label}</button>`).join('') +
        '</div>' +
        '<div class="ai-ask">' +
          '<input class="tb-input" id="ai-q" placeholder="Ask about this document…" />' +
          '<button class="ai-act" id="ai-ask-btn">Ask</button>' +
        '</div>' +
        '<div class="ai-output" id="ai-out"></div>';
      body.querySelector('#ai-scope').value = hasToc ? 'section' : 'page';
      body.querySelectorAll('.ai-act[data-task]').forEach(b =>
        b.addEventListener('click', () => runPdfAI(b.dataset.task)));
      const q = body.querySelector('#ai-q');
      const ask = () => { const v = q.value.trim(); if (v) runPdfAI('ask', v); };
      body.querySelector('#ai-ask-btn').addEventListener('click', ask);
      q.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') ask(); });
    }
    // Run one AI task against an explicit block of text and render it into `out`
    // (the #ai-out container). Shared by the scope-based panel actions and the
    // selection bubble so both show an identical result + Copy affordance.
    async function aiComplete(out, task, text, question, noteHTML) {
      if (!out) return;
      out.innerHTML = '<div class="stage-loading" style="position:static;padding:18px"><div class="yr-spinner"></div></div>';
      try {
        const r = await YR.postJSON('/api/ai', { task, text, question });
        const result = r.result || '(no response)';
        out.innerHTML = (noteHTML || '') + '<div class="ai-result"></div><button class="ai-act ai-copy">⧉ Copy</button>';
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
    async function runPdfAI(task, question) {
      if (!aiWrap) { openAIRpanel(); return; }     // re-mount if the user closed the panel
      YR.rpanel.show();
      const out = aiWrap.querySelector('#ai-out');
      if (!out) return;
      const scope = (aiWrap.querySelector('#ai-scope') || {}).value || 'page';
      out.innerHTML = '<div class="stage-loading" style="position:static;padding:18px"><div class="yr-spinner"></div></div>';
      let data;
      try {
        const [start, end] = scopeRange(scope);
        data = await YR.getJSON(`/api/doc-text?path=${encodeURIComponent(path)}&start=${start}&end=${end}`);
      } catch (e) {
        out.innerHTML = '<div class="ai-err">Could not read text from the document.</div>'; return;
      }
      if (!data.text || !data.text.trim()) {
        out.innerHTML = '<div class="ai-err">No selectable text on these pages — this PDF may be scanned images.</div>'; return;
      }
      const note = data.truncated
        ? `<div class="ai-scope" style="margin:0 0 6px">Based on pages ${data.start + 1}–${data.end} (trimmed to fit).</div>` : '';
      await aiComplete(out, task, data.text, question, note);
    }

    // ── sidebar: thumbnails (lazy page grid for quick navigation) ─────────────
    function thumbZoom() {
      // Render small: target ~150 CSS px wide regardless of the page's point size.
      const w = pageSize.width || 612;
      return Math.max(0.05, Math.min(0.5, 150 / w));
    }
    function renderThumbs() {
      const body = sideWrap.querySelector('#side-body');
      if (!body) return;
      if (S.org && S.org.on) return renderOrganize();
      const z = (thumbZoom() * RENDER_SCALE).toFixed(3);
      const ratio = `${pageSize.width} / ${pageSize.height}`;
      const grid = document.createElement('div');
      grid.className = 'thumb-grid';
      for (let i = 0; i < count; i++) {
        const cell = document.createElement('button');
        cell.className = 'thumb-cell' + (i === S.current ? ' active' : '');
        cell.dataset.index = i;
        cell.style.aspectRatio = ratio;
        cell.title = 'Page ' + (i + 1);
        const img = document.createElement('img');
        img.className = 'thumb-img';
        img.alt = 'Page ' + (i + 1);
        // thumbnails always render upright (rot=0) — the badge tells you the page.
        img.dataset.src = `/api/page?path=${encodeURIComponent(path)}&index=${i}&zoom=${z}&rot=0`;
        const num = document.createElement('div');
        num.className = 'thumb-num';
        num.textContent = (i + 1);
        cell.appendChild(img);
        cell.appendChild(num);
        cell.addEventListener('click', () => gotoPage(i));
        grid.appendChild(cell);
      }
      body.innerHTML = '';
      body.appendChild(makeOrganizeLauncher());
      body.appendChild(grid);
      attachThumbObserver(grid);
      requestAnimationFrame(syncThumbActive);
    }
    function attachThumbObserver(grid) {
      if (S.thumbObs) S.thumbObs.disconnect();
      const rootEl = document.getElementById('sidebar');
      S.thumbObs = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const img = e.target.querySelector('img.thumb-img');
          if (img && !img.src && img.dataset.src) img.src = img.dataset.src;
          S.thumbObs.unobserve(e.target);
        }
      }, { root: rootEl, rootMargin: '400px' });
      grid.querySelectorAll('.thumb-cell, .org-cell').forEach(c => S.thumbObs.observe(c));
    }
    function syncThumbActive() {
      const grid = sideWrap.querySelector('.thumb-grid');
      if (!grid) return;
      grid.querySelectorAll('.thumb-cell.active').forEach(c => c.classList.remove('active'));
      const cur = grid.querySelector(`.thumb-cell[data-index="${S.current}"]`);
      if (cur) { cur.classList.add('active'); cur.scrollIntoView({ block: 'nearest' }); }
    }

    // ── organize pages (P5d-2) ────────────────────────────────────────────────
    // A staged "page plan" — an ordered list of {src, rot} items — committed to a
    // brand-new PDF on export. It never mutates the open document, so there's no
    // dirty flag or leave-guard: the original file on disk is untouched until the
    // user explicitly exports a copy. Reorder by drag, rotate/remove per cell.
    function ensurePlan() {
      if (!S.org.plan) S.org.plan = Array.from({ length: count }, (_, i) => ({ src: i, rot: 0 }));
    }
    function openOrganizer() {
      S.org.on = true;
      ensurePlan();
      sideMode = 'thumbs';
      mountSidebar();
      YR.sidebar.show();
    }
    function closeOrganizer() {
      S.org.on = false;
      mountSidebar();              // back to the normal thumbnail grid
    }
    function organizeReset() {
      S.org.plan = Array.from({ length: count }, (_, i) => ({ src: i, rot: 0 }));
      renderOrganize();
    }
    function makeOrganizeLauncher() {
      const wrap = document.createElement('div');
      wrap.className = 'org-launch';
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'org-launch-btn';
      b.textContent = '🗂 Organize pages';
      b.title = 'Reorder, rotate or remove pages, then export a new PDF';
      b.addEventListener('click', openOrganizer);
      wrap.appendChild(b);
      return wrap;
    }
    function orgThumbSrc(it, z) {
      return `/api/page?path=${encodeURIComponent(path)}&index=${it.src}&zoom=${z}&rot=${it.rot || 0}`;
    }
    function renderOrganize() {
      const body = sideWrap.querySelector('#side-body');
      if (!body) return;
      ensurePlan();
      const z = (thumbZoom() * RENDER_SCALE).toFixed(3);
      const ratio = `${pageSize.width} / ${pageSize.height}`;

      const head = document.createElement('div');
      head.className = 'org-head';
      head.innerHTML =
        '<div class="org-title">🗂 Organize</div>' +
        '<div class="org-sum"></div>' +
        '<button class="org-done" type="button" title="Leave organize mode">Done</button>';

      const hint = document.createElement('div');
      hint.className = 'org-hint';
      hint.textContent = 'Drag to reorder. Use the buttons to rotate or remove a page, then export a new PDF — your original file is never changed.';

      const grid = document.createElement('div');
      grid.className = 'thumb-grid org-grid';

      S.org.plan.forEach((it, pos) => {
        const cell = document.createElement('div');
        cell.className = 'org-cell';
        cell.draggable = true;
        cell.dataset.pos = pos;
        cell.style.aspectRatio = ratio;

        const img = document.createElement('img');
        img.className = 'thumb-img';
        img.alt = 'Page ' + (it.src + 1);
        img.dataset.src = orgThumbSrc(it, z);

        const num = document.createElement('div');
        num.className = 'thumb-num';
        num.textContent = (it.src + 1) + (it.rot ? ` · ${it.rot}°` : '');

        const ctl = document.createElement('div');
        ctl.className = 'org-ctl';
        const mk = (icon, title, fn) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'org-btn';
          b.textContent = icon;
          b.title = title;
          b.draggable = false;
          b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
          return b;
        };
        ctl.appendChild(mk('⟲', 'Rotate left', () => rotateCell(pos, -90)));
        ctl.appendChild(mk('⟳', 'Rotate right', () => rotateCell(pos, 90)));
        ctl.appendChild(mk('🗑', 'Remove this page', () => deleteCell(pos)));

        cell.appendChild(img);
        cell.appendChild(num);
        cell.appendChild(ctl);

        cell.addEventListener('dragstart', (e) => {
          S.org.drag = pos;
          cell.classList.add('dragging');
          try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(pos)); } catch (_) {}
        });
        cell.addEventListener('dragend', () => { cell.classList.remove('dragging'); clearDropMarks(); S.org.drag = -1; });
        cell.addEventListener('dragover', (e) => {
          if (S.org.drag < 0) return;
          e.preventDefault();
          try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
          const r = cell.getBoundingClientRect();
          const before = (e.clientY - r.top) < r.height / 2;
          clearDropMarks();
          cell.classList.add(before ? 'drop-before' : 'drop-after');
        });
        cell.addEventListener('drop', (e) => {
          if (S.org.drag < 0) return;
          e.preventDefault();
          const r = cell.getBoundingClientRect();
          const before = (e.clientY - r.top) < r.height / 2;
          clearDropMarks();
          dropAt(pos, before);
        });

        grid.appendChild(cell);
      });

      const foot = document.createElement('div');
      foot.className = 'org-foot';
      const resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'org-act';
      resetBtn.textContent = 'Reset';
      resetBtn.title = 'Restore the original page order';
      resetBtn.addEventListener('click', organizeReset);
      const exportBtn = document.createElement('button');
      exportBtn.type = 'button';
      exportBtn.className = 'org-act primary';
      exportBtn.textContent = '💾 Export PDF…';
      exportBtn.title = 'Write these pages to a new PDF file';
      exportBtn.addEventListener('click', () => exportPlan(exportBtn));
      foot.appendChild(resetBtn);
      foot.appendChild(exportBtn);

      body.innerHTML = '';
      body.appendChild(head);
      body.appendChild(hint);
      body.appendChild(grid);
      body.appendChild(foot);
      head.querySelector('.org-done').addEventListener('click', closeOrganizer);
      updateOrgSummary();
      attachThumbObserver(grid);
    }
    function clearDropMarks() {
      sideWrap.querySelectorAll('.drop-before, .drop-after')
        .forEach(c => c.classList.remove('drop-before', 'drop-after'));
    }
    function updateOrgSummary() {
      const sum = sideWrap.querySelector('.org-sum');
      if (!sum || !S.org.plan) return;
      const n = S.org.plan.length;
      const rot = S.org.plan.filter(it => it.rot).length;
      const dropped = count - new Set(S.org.plan.map(it => it.src)).size;
      const bits = [`${n} page${n === 1 ? '' : 's'}`];
      if (rot) bits.push(`${rot} rotated`);
      if (dropped > 0) bits.push(`${dropped} removed`);
      sum.textContent = bits.join(' · ');
    }
    function rotateCell(pos, delta) {
      const it = S.org.plan[pos];
      if (!it) return;
      it.rot = (((it.rot || 0) + delta) % 360 + 360) % 360;
      const cell = sideWrap.querySelector(`.org-cell[data-pos="${pos}"]`);
      if (cell) {
        const z = (thumbZoom() * RENDER_SCALE).toFixed(3);
        const img = cell.querySelector('img.thumb-img');
        const src = orgThumbSrc(it, z);
        if (img) { img.src = src; img.dataset.src = src; }
        const num = cell.querySelector('.thumb-num');
        if (num) num.textContent = (it.src + 1) + (it.rot ? ` · ${it.rot}°` : '');
      }
      updateOrgSummary();
    }
    function deleteCell(pos) {
      if (!S.org.plan || S.org.plan.length <= 1) { YR.toast('Keep at least one page', '', 1600); return; }
      S.org.plan.splice(pos, 1);
      renderOrganize();
    }
    function dropAt(targetPos, before) {
      const from = S.org.drag;
      if (from < 0 || !S.org.plan) return;
      let to = targetPos + (before ? 0 : 1);
      const [item] = S.org.plan.splice(from, 1);
      if (from < to) to--;                    // removal shifts later indices down
      S.org.plan.splice(to, 0, item);
      S.org.drag = -1;
      renderOrganize();
    }
    function splitPath(p) {
      const s = String(p || '');
      const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
      const dir = i >= 0 ? s.slice(0, i) : '';
      let base = i >= 0 ? s.slice(i + 1) : s;
      const dot = base.lastIndexOf('.');
      if (dot > 0) base = base.slice(0, dot);
      return { dir, base };
    }
    async function exportPlan(btn) {
      const items = S.org.plan || [];
      if (!items.length) { YR.toast('Nothing to export', '', 1600); return; }
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.save_file) { YR.toast('Export needs the desktop app', '', 2400); return; }
      const { dir, base } = splitPath(path);
      const suggested = `${base} (organized).pdf`;
      let target = null;
      try {
        target = await api.save_file(suggested, dir, ['PDF document (*.pdf)', 'All files (*.*)']);
      } catch (_) { target = null; }
      if (!target) return;                    // user cancelled
      const plan = items.map(it => ({ src: it.src, rotate: it.rot || 0 }));
      if (btn) btn.disabled = true;
      try {
        const res = await YR.postJSON('/api/pdf/organize', { path, target, plan });
        YR.toast(`Saved ${res.pages}-page PDF · ${res.name}`, 'success', 2600);
      } catch (e) {
        YR.toast('Export failed: ' + (e.message || 'unknown'), 'error', 3200);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    // ── markup / annotations (P5c) ────────────────────────────────────────────
    // PyMuPDF renders annotations into the page PNG, so adding one just means
    // re-fetching that page image with a cache-busting &v=. The overlay layer
    // only captures drawing input and hosts delete hotspots in Select mode.
    const MK_COLORS = ['#ffd54a', '#7ed957', '#ff6b6b', '#4dabf7', '#b197fc', '#ffffff', '#000000'];
    const MK_TOOLS = [
      ['highlight', '🖍', 'Highlight — drag across text'],
      ['underline', 'U̲', 'Underline — drag across text'],
      ['strikeout', 'S̶', 'Strikeout — drag across text'],
      ['draw', '✎', 'Freehand pen'],
      ['rect', '▭', 'Rectangle'],
      ['oval', '◯', 'Oval'],
      ['note', '🗨', 'Sticky note — click a spot'],
      ['select', '🗑', 'Select / delete an annotation'],
    ];
    const markupBar = document.createElement('div');
    markupBar.className = 'markup-bar hidden';
    MK_TOOLS.forEach(([tool, icon, title]) => {
      const b = document.createElement('button');
      b.className = 'mk-tool' + (tool === S.tool ? ' active' : '');
      b.dataset.tool = tool; b.title = title; b.textContent = icon;
      b.addEventListener('click', () => setTool(tool));
      markupBar.appendChild(b);
    });
    const mkSep = document.createElement('span'); mkSep.className = 'mk-sep'; markupBar.appendChild(mkSep);
    MK_COLORS.forEach(c => {
      const s = document.createElement('button');
      s.className = 'mk-swatch' + (c === S.color ? ' active' : '');
      s.dataset.color = c; s.style.background = c; s.title = c;
      s.addEventListener('click', () => setColor(c));
      markupBar.appendChild(s);
    });
    const mkColor = document.createElement('input');
    mkColor.type = 'color'; mkColor.className = 'mk-color'; mkColor.value = S.color;
    mkColor.title = 'Custom colour';
    mkColor.addEventListener('input', () => setColor(mkColor.value));
    markupBar.appendChild(mkColor);
    YR.root.appendChild(markupBar);

    function setTool(t) {
      S.tool = t;
      markupBar.querySelectorAll('.mk-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
      syncMarkupLayers();
    }
    function setColor(c) {
      S.color = c;
      markupBar.querySelectorAll('.mk-swatch').forEach(s => s.classList.toggle('active', s.dataset.color === c));
      if (mkColor.value !== c && /^#[0-9a-fA-F]{6}$/.test(c)) mkColor.value = c;
    }
    function toggleMarkup() {
      S.markup = !S.markup;
      if (S.markup && S.redact) toggleRedact();   // mutually exclusive page overlays
      if (S.markup && S.tts) toggleRead();        // drawing and reading-aloud don't mix
      markupBtn.classList.toggle('active', S.markup);
      markupBar.classList.toggle('hidden', !S.markup);
      if (rotateBtn) rotateBtn.disabled = S.markup;
      if (S.markup && (S.rotate % 360 !== 0)) {
        S.rotate = 0;                       // markup is only coherent upright
        if (rotateBtn) rotateBtn.classList.remove('active');
        rerender();                         // rebuild → buildPages re-adds layers
      } else {
        syncMarkupLayers();
      }
      if (S.markup) YR.toast('Markup on — pick a tool, then draw on the page', '', 2400);
    }

    function syncMarkupLayers() {
      const on = S.markup && (S.rotate % 360 === 0);
      scroll.querySelectorAll('.page-wrap').forEach(wrap => {
        let layer = wrap.querySelector('.annot-layer');
        if (on) {
          if (!layer) {
            layer = document.createElement('div');
            layer.className = 'annot-layer';
            const idx = parseInt(wrap.dataset.index, 10);
            layer.addEventListener('pointerdown', e => onPointerDown(e, layer, idx));
            wrap.appendChild(layer);
          }
          refreshLayer(wrap, layer);
        } else if (layer) {
          layer.remove();
        }
      });
    }
    function refreshLayer(wrap, layer) {
      const idx = parseInt(wrap.dataset.index, 10);
      const sel = S.tool === 'select';
      layer.classList.toggle('sel', sel);
      layer.querySelectorAll('.annot-hotspot').forEach(el => el.remove());
      if (sel) renderHotspots(layer, idx);
    }
    async function renderHotspots(layer, idx) {
      let list = S.annotCache[idx];
      if (!list) {
        try { list = (await YR.getJSON(`/api/pdf/annotations?path=${encodeURIComponent(path)}&page=${idx}`)).annotations || []; }
        catch (e) { list = []; }
        S.annotCache[idx] = list;
      }
      if (S.tool !== 'select' || !layer.isConnected) return;
      layer.querySelectorAll('.annot-hotspot').forEach(el => el.remove());
      const z = effZoom();
      list.forEach(a => {
        const r = a.rect || [0, 0, 0, 0];
        const hs = document.createElement('div');
        hs.className = 'annot-hotspot';
        hs.style.left = (r[0] * z) + 'px';
        hs.style.top = (r[1] * z) + 'px';
        hs.style.width = Math.max(10, (r[2] - r[0]) * z) + 'px';
        hs.style.height = Math.max(10, (r[3] - r[1]) * z) + 'px';
        hs.title = a.kind + (a.content ? ' — ' + a.content : '');
        const x = document.createElement('button');
        x.className = 'annot-del'; x.textContent = '✕'; x.title = 'Delete';
        x.addEventListener('click', ev => { ev.stopPropagation(); deleteAnnot(idx, a.id); });
        hs.appendChild(x);
        layer.appendChild(hs);
      });
    }

    function layerPoint(e, layer, z) {
      const rect = layer.getBoundingClientRect();
      return { x: (e.clientX - rect.left) / z, y: (e.clientY - rect.top) / z };
    }
    function onPointerDown(e, layer, idx) {
      if (e.button !== 0 || S.tool === 'select') return;
      const z = effZoom();
      const p = layerPoint(e, layer, z);
      if (S.tool === 'note') { addNote(idx, p); return; }
      e.preventDefault();
      try { layer.setPointerCapture(e.pointerId); } catch (_) { /* non-fatal */ }
      if (S.tool === 'draw') beginInk(layer, idx, p, z);
      else beginShape(layer, idx, p, z);
    }
    function beginShape(layer, idx, start, z) {
      const draft = document.createElement('div');
      draft.className = 'annot-draft tool-' + S.tool;
      if (S.tool === 'highlight') draft.style.background = hexToRgba(S.color, 0.35);
      else draft.style.borderColor = S.color;
      layer.appendChild(draft);
      let cx = start.x, cy = start.y;
      const place = () => {
        const x0 = Math.min(start.x, cx), y0 = Math.min(start.y, cy);
        const x1 = Math.max(start.x, cx), y1 = Math.max(start.y, cy);
        draft.style.left = (x0 * z) + 'px'; draft.style.top = (y0 * z) + 'px';
        draft.style.width = ((x1 - x0) * z) + 'px'; draft.style.height = ((y1 - y0) * z) + 'px';
      };
      place();
      const move = ev => {
        const rect = layer.getBoundingClientRect();
        cx = (ev.clientX - rect.left) / z; cy = (ev.clientY - rect.top) / z; place();
      };
      const up = () => {
        layer.removeEventListener('pointermove', move);
        layer.removeEventListener('pointerup', up);
        layer.removeEventListener('pointercancel', up);
        draft.remove();
        const x0 = Math.min(start.x, cx), y0 = Math.min(start.y, cy);
        const x1 = Math.max(start.x, cx), y1 = Math.max(start.y, cy);
        if ((x1 - x0) < 3 || (y1 - y0) < 3) return;   // ignore accidental taps
        postAnnot(idx, { kind: S.tool, rects: [[x0, y0, x1, y1]], color: S.color });
      };
      layer.addEventListener('pointermove', move);
      layer.addEventListener('pointerup', up);
      layer.addEventListener('pointercancel', up);
    }
    function beginInk(layer, idx, start, z) {
      const pts = [[start.x, start.y]];
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'annot-ink-draft');
      const poly = document.createElementNS(NS, 'polyline');
      poly.setAttribute('fill', 'none');
      poly.setAttribute('stroke', S.color);
      poly.setAttribute('stroke-width', '2');
      poly.setAttribute('stroke-linecap', 'round');
      poly.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(poly);
      layer.appendChild(svg);
      const draw = () => poly.setAttribute('points', pts.map(p => `${p[0] * z},${p[1] * z}`).join(' '));
      draw();
      const move = ev => {
        const rect = layer.getBoundingClientRect();
        pts.push([(ev.clientX - rect.left) / z, (ev.clientY - rect.top) / z]); draw();
      };
      const up = () => {
        layer.removeEventListener('pointermove', move);
        layer.removeEventListener('pointerup', up);
        layer.removeEventListener('pointercancel', up);
        svg.remove();
        if (pts.length < 2) return;
        postAnnot(idx, { kind: 'ink', strokes: [pts], color: S.color, width: 2 });
      };
      layer.addEventListener('pointermove', move);
      layer.addEventListener('pointerup', up);
      layer.addEventListener('pointercancel', up);
    }
    async function addNote(idx, p) {
      const text = window.prompt('Note text:');
      if (text === null) return;                 // cancelled
      await postAnnot(idx, { kind: 'note', point: [p.x, p.y], text: text || ' ' });
    }
    async function postAnnot(idx, spec) {
      try {
        await YR.postJSON('/api/pdf/annotate', Object.assign({ path, page: idx }, spec));
        S.annotCache[idx] = null;                // force a refetch of hotspots
        setDirty(true);
        refreshPage(idx);
        if (sideMode === 'notes') renderNotes();  // keep the manager list live
      } catch (e) {
        YR.toast('Could not add annotation: ' + (e.message || 'error'), 'error', 3200);
      }
    }
    async function deleteAnnot(idx, id) {
      try {
        await YR.postJSON('/api/pdf/annotation/delete', { path, page: idx, id });
        S.annotCache[idx] = null;
        setDirty(true);
        refreshPage(idx);
        syncMarkupLayers();
        if (sideMode === 'notes') renderNotes();
      } catch (e) {
        YR.toast('Delete failed: ' + (e.message || 'error'), 'error', 3000);
      }
    }
    // v2-5: edit an existing annotation's note text and/or colour in place.
    async function updateAnnot(idx, id, spec) {
      try {
        const r = await YR.postJSON('/api/pdf/annotation/update', Object.assign({ path, page: idx, id }, spec));
        S.annotCache[idx] = null;
        setDirty(true);
        refreshPage(idx);
        if (sideMode === 'notes') renderNotes();
        return r;
      } catch (e) {
        YR.toast('Update failed: ' + (e.message || 'error'), 'error', 3000);
        return null;
      }
    }
    function refreshPage(i) {
      S.imgVer[i] = (S.imgVer[i] || 0) + 1;      // bust the browser's page-image cache
      const wrap = scroll.querySelector(`.page-wrap[data-index="${i}"]`);
      const img = wrap && wrap.querySelector('img.page-canvas');
      if (!img) return;
      const z = effZoom();
      img.src = `/api/page?path=${encodeURIComponent(path)}&index=${i}&zoom=${(z * RENDER_SCALE).toFixed(3)}&rot=${S.rotate || 0}&v=${S.imgVer[i]}`;
    }
    function leaveGuard() { return S.dirty ? 'You have unsaved PDF changes — leave without saving?' : ''; }
    function setDirty(v) {
      S.dirty = !!v;
      if (saveBtn) saveBtn.classList.toggle('tb-dirty', S.dirty);
      if (YR.setLeaveGuard) YR.setLeaveGuard(S.dirty ? leaveGuard : null);
    }
    async function saveDoc() {
      if (!S.dirty) { YR.toast('No unsaved markups', '', 1400); return; }
      if (saveBtn) saveBtn.disabled = true;
      try {
        const r = await YR.postJSON('/api/pdf/save', { path });
        setDirty(false);
        YR.toast(r && r.saved ? 'Saved to PDF' : 'Up to date', 'success', 1800);
      } catch (e) {
        YR.toast('Save failed: ' + (e.message || 'unknown'), 'error', 3200);
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }
    function hexToRgba(hex, a) {
      const s = String(hex).replace('#', '');
      if (s.length !== 6) return `rgba(255,213,74,${a})`;
      return `rgba(${parseInt(s.slice(0, 2), 16)},${parseInt(s.slice(2, 4), 16)},${parseInt(s.slice(4, 6), 16)},${a})`;
    }

    // ── redact (v2-2: true black-out) ─────────────────────────────────────────
    // Redaction is an interactive MODE (one toolbar button, peer of Markup / Sign
    // / Fill). You stage black boxes — by dragging a rectangle (Area) or selecting
    // words (Text) — then "Apply" writes a NEW copy in which the covered glyphs,
    // line-art and image pixels are permanently REMOVED (not just painted over).
    // The open document is never mutated and the original file on disk is untouched.
    // Coordinates live in unrotated page points (÷ effZoom()), exactly like markup,
    // so redaction is only coherent upright → entering the mode forces rotate = 0.
    const RED_TOOLS = [
      ['area', '▭', 'Area — drag a box over anything to black it out'],
      ['text', '🔤', 'Text — select words to black them out'],
    ];
    let redactOverlay = null;                  // the apply-time confirm modal
    const redactBar = document.createElement('div');
    redactBar.className = 'markup-bar redact-bar hidden';
    RED_TOOLS.forEach(([tool, icon, title]) => {
      const b = document.createElement('button');
      b.className = 'mk-tool' + (tool === S.redTool ? ' active' : '');
      b.dataset.rtool = tool; b.title = title; b.textContent = icon;
      b.addEventListener('click', () => setRedTool(tool));
      redactBar.appendChild(b);
    });
    const redSep = document.createElement('span'); redSep.className = 'mk-sep'; redactBar.appendChild(redSep);
    const rbCount = document.createElement('span');
    rbCount.className = 'rb-count'; rbCount.textContent = 'No areas yet';
    redactBar.appendChild(rbCount);
    const rbClear = document.createElement('button');
    rbClear.className = 'mk-tool'; rbClear.textContent = '🧹'; rbClear.title = 'Clear all staged areas';
    rbClear.addEventListener('click', clearRedaction);
    redactBar.appendChild(rbClear);
    const rbApply = document.createElement('button');
    rbApply.className = 'rb-apply'; rbApply.textContent = '⬛ Apply…';
    rbApply.title = 'Permanently black out the staged areas and save a new copy';
    rbApply.addEventListener('click', openRedactApply);
    redactBar.appendChild(rbApply);
    YR.root.appendChild(redactBar);

    function setRedTool(t) {
      S.redTool = t;
      redactBar.querySelectorAll('.mk-tool[data-rtool]').forEach(b => b.classList.toggle('active', b.dataset.rtool === t));
      syncRedactLayers();                      // text mode lets selection through; area captures drags
      YR.toast(t === 'text' ? 'Text mode — select words to stage them' : 'Area mode — drag a box over anything', '', 1800);
    }
    function toggleRedact() {
      S.redact = !S.redact;
      redactBtn.classList.toggle('active', S.redact);
      redactBar.classList.toggle('hidden', !S.redact);
      if (S._modesMenu && S._modesMenu._refreshMenuActive) S._modesMenu._refreshMenuActive();
      if (S.redact) {
        if (S.markup) toggleMarkup();          // mutually exclusive page overlays
        if (S.fill) toggleFill();
        if (S.tts) toggleRead();
        cancelPlacement();
        closeSignPanel();
        if (rotateBtn) rotateBtn.disabled = true;
        if (S.rotate % 360 !== 0) {
          S.rotate = 0;                        // redaction is only coherent upright
          if (rotateBtn) rotateBtn.classList.remove('active');
          rerender();                          // rebuild → buildPages re-adds layers
        } else {
          syncRedactLayers();
        }
        updateRedactBar();
        YR.toast('Redact on — stage black boxes, then ⬛ Apply to save a new copy. Your original is never changed.', '', 3600);
      } else {
        if (rotateBtn) rotateBtn.disabled = false;
        closeRedactApply();
        syncRedactLayers();                     // tears the layers down
      }
    }

    function syncRedactLayers() {
      const on = S.redact && (S.rotate % 360 === 0);
      const textTool = S.redTool === 'text';
      scroll.querySelectorAll('.page-wrap').forEach(wrap => {
        const idx = parseInt(wrap.dataset.index, 10);
        let layer = wrap.querySelector('.redact-layer');
        if (on) {
          if (!layer) {
            layer = document.createElement('div');
            layer.className = 'redact-layer';
            layer.addEventListener('pointerdown', e => onRedactPointerDown(e, layer, idx));
            wrap.appendChild(layer);
          }
          // In Text mode the layer must let a drag-selection reach the text-layer
          // beneath it, so it goes pointer-events:none; the staged boxes keep their
          // own pointer events (so their ✕ stays clickable) via .redact-box CSS.
          layer.classList.toggle('passthrough', textTool);
          renderRedactBoxes(layer, idx);
        } else if (layer) {
          layer.remove();
        }
      });
    }
    function renderRedactBoxes(layer, idx) {
      layer.querySelectorAll('.redact-box').forEach(el => el.remove());
      const rects = S.redRegions[idx];
      if (!rects || !rects.length) return;
      const z = effZoom();
      rects.forEach((r, i) => {
        const box = document.createElement('div');
        box.className = 'redact-box';
        box.style.left = (r[0] * z) + 'px';
        box.style.top = (r[1] * z) + 'px';
        box.style.width = ((r[2] - r[0]) * z) + 'px';
        box.style.height = ((r[3] - r[1]) * z) + 'px';
        const del = document.createElement('button');
        del.className = 'redact-del'; del.textContent = '✕'; del.title = 'Remove this box';
        del.addEventListener('pointerdown', ev => ev.stopPropagation());   // don't start a new draft
        del.addEventListener('click', ev => { ev.stopPropagation(); removeRedactRect(idx, i); });
        box.appendChild(del);
        layer.appendChild(box);
      });
    }
    function onRedactPointerDown(e, layer, idx) {
      if (e.button !== 0 || S.redTool !== 'area') return;   // text mode selects via the text-layer
      e.preventDefault();
      const z = effZoom();
      const start = layerPoint(e, layer, z);
      try { layer.setPointerCapture(e.pointerId); } catch (_) { /* non-fatal */ }
      const draft = document.createElement('div');
      draft.className = 'redact-draft';
      layer.appendChild(draft);
      let cx = start.x, cy = start.y;
      const place = () => {
        const x0 = Math.min(start.x, cx), y0 = Math.min(start.y, cy);
        const x1 = Math.max(start.x, cx), y1 = Math.max(start.y, cy);
        draft.style.left = (x0 * z) + 'px'; draft.style.top = (y0 * z) + 'px';
        draft.style.width = ((x1 - x0) * z) + 'px'; draft.style.height = ((y1 - y0) * z) + 'px';
      };
      place();
      const move = ev => {
        const rect = layer.getBoundingClientRect();
        cx = (ev.clientX - rect.left) / z; cy = (ev.clientY - rect.top) / z; place();
      };
      const up = () => {
        layer.removeEventListener('pointermove', move);
        layer.removeEventListener('pointerup', up);
        layer.removeEventListener('pointercancel', up);
        draft.remove();
        const x0 = Math.min(start.x, cx), y0 = Math.min(start.y, cy);
        const x1 = Math.max(start.x, cx), y1 = Math.max(start.y, cy);
        if ((x1 - x0) < 3 || (y1 - y0) < 3) return;       // ignore accidental taps
        addRedactRect(idx, [x0, y0, x1, y1]);
      };
      layer.addEventListener('pointermove', move);
      layer.addEventListener('pointerup', up);
      layer.addEventListener('pointercancel', up);
    }
    function addRedactRect(idx, rect) {
      (S.redRegions[idx] || (S.redRegions[idx] = [])).push(rect);
      const layer = scroll.querySelector(`.page-wrap[data-index="${idx}"] .redact-layer`);
      if (layer) renderRedactBoxes(layer, idx);
      updateRedactBar();
    }
    function addSelectionToRedaction() {
      const byPage = selectedWordRectsByPage();
      const pages = Object.keys(byPage);
      if (!pages.length) return;
      let added = 0;
      pages.forEach(pg => {
        const idx = parseInt(pg, 10);
        const list = S.redRegions[idx] || (S.redRegions[idx] = []);
        byPage[pg].forEach(b => { list.push(b.slice()); added++; });   // copy: don't alias span boxes
        const layer = scroll.querySelector(`.page-wrap[data-index="${idx}"] .redact-layer`);
        if (layer) renderRedactBoxes(layer, idx);
      });
      try { window.getSelection().removeAllRanges(); } catch (_) { /* non-fatal */ }
      updateRedactBar();
      if (added) YR.toast(`Staged ${added} word${added === 1 ? '' : 's'} to black out`, '', 1600);
    }
    function removeRedactRect(idx, i) {
      const list = S.redRegions[idx];
      if (!list) return;
      list.splice(i, 1);
      if (!list.length) delete S.redRegions[idx];
      const layer = scroll.querySelector(`.page-wrap[data-index="${idx}"] .redact-layer`);
      if (layer) renderRedactBoxes(layer, idx);
      updateRedactBar();
    }
    function clearRedaction() {
      const n = redactCount();
      S.redRegions = {};
      scroll.querySelectorAll('.redact-layer .redact-box').forEach(el => el.remove());
      updateRedactBar();
      if (n) YR.toast('Cleared all staged areas', '', 1400);
    }
    function redactCount() {
      return Object.values(S.redRegions).reduce((sum, list) => sum + (list ? list.length : 0), 0);
    }
    function redactRegionsPayload() {
      return Object.keys(S.redRegions)
        .map(k => ({ page: parseInt(k, 10), rects: S.redRegions[k] }))
        .filter(it => it.rects && it.rects.length);
    }
    function updateRedactBar() {
      const n = redactCount();
      const pages = redactRegionsPayload().length;
      rbCount.textContent = n
        ? `${n} area${n === 1 ? '' : 's'} · ${pages} page${pages === 1 ? '' : 's'}`
        : 'No areas yet';
      rbApply.disabled = !n;
      rbClear.disabled = !n;
    }

    function openRedactApply() {
      if (redactOverlay) return;
      const n = redactCount();
      if (!n) { YR.toast('Add at least one area to black out first', '', 2200); return; }
      const pages = redactRegionsPayload().length;
      const ov = document.createElement('div');
      ov.className = 'xi-overlay';
      ov.innerHTML =
        '<div class="sign-card" role="dialog" aria-label="Apply redaction">' +
        '<div class="sign-head"><span class="sign-title">⬛ Redact &amp; save a copy</span>' +
        '<button class="sign-x" type="button" title="Close (Esc)">✕</button></div>' +
        '<div class="sign-body"></div></div>';
      redactOverlay = ov;
      document.body.appendChild(ov);
      const body = ov.querySelector('.sign-body');

      const hint = document.createElement('div');
      hint.className = 'ms-hint';
      hint.innerHTML = `You're about to permanently black out <b>${n} area${n === 1 ? '' : 's'}</b> on ` +
        `<b>${pages} page${pages === 1 ? '' : 's'}</b>. The text, drawings and image pixels under each box are ` +
        `<b>removed</b> — not just hidden — so they can't be copied or recovered. This writes a <b>new copy</b>; ` +
        `your original PDF is never changed.`;
      body.appendChild(hint);

      const imgChk = document.createElement('label'); imgChk.className = 'ms-check';
      const ic = document.createElement('input');
      ic.type = 'checkbox'; ic.checked = S.redImages;
      ic.addEventListener('change', () => { S.redImages = ic.checked; });
      const it = document.createElement('span');
      it.textContent = 'Erase image pixels under each box (recommended)';
      imgChk.appendChild(ic); imgChk.appendChild(it);
      body.appendChild(imgChk);

      const scrubChk = document.createElement('label'); scrubChk.className = 'ms-check';
      const sc = document.createElement('input');
      sc.type = 'checkbox'; sc.checked = S.redScrub;
      sc.addEventListener('change', () => { S.redScrub = sc.checked; });
      const st = document.createElement('span');
      st.textContent = 'Also scrub hidden metadata (title, author, edit history)';
      scrubChk.appendChild(sc); scrubChk.appendChild(st);
      body.appendChild(scrubChk);

      const acts = document.createElement('div'); acts.className = 'ms-acts';
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'ms-act primary'; go.textContent = '⬛ Redact & save copy…';
      go.addEventListener('click', () => doRedact(go));
      acts.appendChild(go); body.appendChild(acts);

      ov.querySelector('.sign-x').addEventListener('click', closeRedactApply);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeRedactApply(); });
      ov._esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeRedactApply(); } };
      document.addEventListener('keydown', ov._esc, true);
    }
    function closeRedactApply() {
      if (!redactOverlay) return;
      document.removeEventListener('keydown', redactOverlay._esc, true);
      redactOverlay.remove();
      redactOverlay = null;
    }
    async function doRedact(btn) {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.save_file) { YR.toast('Saving needs the desktop app', '', 2400); return; }
      const regions = redactRegionsPayload();
      if (!regions.length) { YR.toast('Nothing staged to redact', '', 2000); return; }
      const { dir, base } = splitPath(path);
      let target = null;
      try {
        target = await api.save_file(`${base || 'document'} (redacted).pdf`, dir,
          ['PDF document (*.pdf)', 'All files (*.*)']);
      } catch (_) { target = null; }
      if (!target) return;                    // user cancelled
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = '⬛ Working… removing content';
      try {
        const res = await YR.postJSON('/api/pdf/redact', {
          path, target, regions,
          remove_images: S.redImages, scrub: S.redScrub,
        });
        YR.toast(`Redacted ${res.boxes} area${res.boxes === 1 ? '' : 's'} on ${res.pages} page${res.pages === 1 ? '' : 's'} · ${res.name}`, 'success', 4200);
        closeRedactApply();
        clearRedaction();
        toggleRedact();                       // leave redact mode — the job is done
      } catch (e) {
        YR.toast('Redaction failed: ' + (e.message || 'unknown'), 'error', 3800);
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    }

    // ── read aloud / TTS (v2-4) ───────────────────────────────────────────────
    // One interactive mode + a floating playbar (mirrors the markup/redact bar).
    // Text comes from /api/pdf/words, grouped into the page's reading-order lines;
    // each line is spoken as one utterance (short chunks dodge the Chromium
    // long-utterance cut-off bug) and its union box is highlighted on the page.
    // Reading auto-advances line→line then page→page using the same per-page word
    // cache the selectable text layer fills, so nothing is fetched twice.
    const TTS_RATES = [
      ['0.75', 0.75], ['1×', 1.0], ['1.25', 1.25], ['1.5', 1.5], ['1.75', 1.75], ['2×', 2.0],
    ];
    const ttsBar = document.createElement('div');
    ttsBar.className = 'markup-bar tts-bar hidden';
    const ttsPlayBtn = document.createElement('button');
    ttsPlayBtn.className = 'mk-tool tts-play'; ttsPlayBtn.textContent = '▶';
    ttsPlayBtn.title = 'Play / Pause';
    ttsPlayBtn.addEventListener('click', ttsPlayPause);
    ttsBar.appendChild(ttsPlayBtn);
    const ttsStopBtn = document.createElement('button');
    ttsStopBtn.className = 'mk-tool'; ttsStopBtn.textContent = '⏹';
    ttsStopBtn.title = 'Stop and clear the highlight';
    ttsStopBtn.addEventListener('click', () => { stopRead(); setTtsStatus('Stopped'); });
    ttsBar.appendChild(ttsStopBtn);
    const ttsSep1 = document.createElement('span'); ttsSep1.className = 'mk-sep'; ttsBar.appendChild(ttsSep1);
    const ttsStatus = document.createElement('span');
    ttsStatus.className = 'rb-count tts-status'; ttsStatus.textContent = 'Ready';
    ttsBar.appendChild(ttsStatus);
    const ttsSep2 = document.createElement('span'); ttsSep2.className = 'mk-sep'; ttsBar.appendChild(ttsSep2);
    const ttsVoiceSel = document.createElement('select');
    ttsVoiceSel.className = 'tts-sel tts-voice'; ttsVoiceSel.title = 'Voice';
    ttsVoiceSel.addEventListener('change', () => {
      S.ttsVoiceURI = ttsVoiceSel.value;
      YR.savePrefs('pdf', { ttsVoice: S.ttsVoiceURI });
    });
    ttsBar.appendChild(ttsVoiceSel);
    const ttsRateSel = document.createElement('select');
    ttsRateSel.className = 'tts-sel tts-rate'; ttsRateSel.title = 'Reading speed';
    TTS_RATES.forEach(([label, val]) => {
      const o = document.createElement('option');
      o.value = String(val); o.textContent = label;
      if (Math.abs(val - S.ttsRate) < 0.001) o.selected = true;
      ttsRateSel.appendChild(o);
    });
    ttsRateSel.addEventListener('change', () => {
      S.ttsRate = +ttsRateSel.value || 1.0;
      YR.savePrefs('pdf', { ttsRate: S.ttsRate });
      // The new speed takes effect on the next line — restarting the current line
      // mid-sentence would re-read it (and racing cancel()'s onerror is fragile).
      if (S.tts && S.ttsPlaying) setTtsStatus(`Speed ${ttsRateSel.options[ttsRateSel.selectedIndex].text} · from next line`);
    });
    ttsBar.appendChild(ttsRateSel);
    YR.root.appendChild(ttsBar);

    async function populateVoices() {
      const voices = await loadVoices();
      ttsVoiceSel.innerHTML = '';
      if (!voices.length) {
        const o = document.createElement('option'); o.value = ''; o.textContent = 'Default voice';
        ttsVoiceSel.appendChild(o); return;
      }
      voices.forEach(v => {
        const o = document.createElement('option');
        o.value = v.voiceURI;
        o.textContent = `${v.name} (${v.lang})`;
        if (v.voiceURI === S.ttsVoiceURI) o.selected = true;
        ttsVoiceSel.appendChild(o);
      });
      // no saved/valid choice yet → default to an English voice, else the first
      if (!S.ttsVoiceURI || !voices.some(v => v.voiceURI === S.ttsVoiceURI)) {
        const def = voices.find(v => /^en/i.test(v.lang)) || voices[0];
        S.ttsVoiceURI = def.voiceURI;
        ttsVoiceSel.value = def.voiceURI;
      }
    }
    function ttsPickVoice() {
      const voices = _ttsVoices || [];
      return voices.find(v => v.voiceURI === S.ttsVoiceURI)
        || voices.find(v => /^en/i.test(v.lang)) || voices[0] || null;
    }

    function setTtsStatus(msg) { ttsStatus.textContent = msg; }
    function updateTtsPlayBtn() {
      const playing = S.ttsPlaying && !S.ttsPaused;
      ttsPlayBtn.textContent = playing ? '⏸' : '▶';
      ttsPlayBtn.classList.toggle('active', playing);
    }

    function toggleRead() {
      S.tts = !S.tts;
      readBtn.classList.toggle('active', S.tts);
      ttsBar.classList.toggle('hidden', !S.tts);
      if (S._modesMenu && S._modesMenu._refreshMenuActive) S._modesMenu._refreshMenuActive();
      if (S.tts) {
        if (S.markup) toggleMarkup();          // mutually exclusive interactive modes
        if (S.redact) toggleRedact();
        if (S.fill) toggleFill();
        cancelPlacement();
        closeSignPanel();
        populateVoices();
        setTtsStatus('Ready');
        updateTtsPlayBtn();
        YR.toast('Read aloud on — press ▶ to start from the page you’re on. The current line is highlighted.', '', 3200);
      } else {
        stopRead();
      }
    }

    function startRead() {
      if (!window.speechSynthesis) { YR.toast('Read-aloud isn’t available in this app build', 'error', 2600); return; }
      S.ttsGen++;                                // invalidate any in-flight page fetch
      S.ttsPlaying = true; S.ttsPaused = false;
      updateTtsPlayBtn();
      ttsPlayFrom(S.current);
    }
    function stopRead() {
      S.ttsGen++;                                // any awaited fetch will bail
      S.ttsPlaying = false; S.ttsPaused = false;
      if (S.ttsUtter) { S.ttsUtter.onend = null; S.ttsUtter.onerror = null; S.ttsUtter = null; }
      try { window.speechSynthesis.cancel(); } catch (_) { /* non-fatal */ }
      clearTtsHighlight();
      S.ttsLines = null; S.ttsIdx = 0; S.ttsCurBox = null; S.ttsCurPage = -1;
      updateTtsPlayBtn();
    }
    function ttsPlayPause() {
      const synth = window.speechSynthesis;
      if (!S.ttsPlaying) { startRead(); return; }
      if (S.ttsPaused) {
        S.ttsPaused = false; try { synth.resume(); } catch (_) {}
        setTtsStatus(`Reading · page ${S.ttsCurPage + 1} of ${count}`);
      } else {
        S.ttsPaused = true; try { synth.pause(); } catch (_) {}
        setTtsStatus('Paused');
      }
      updateTtsPlayBtn();
    }

    // Group a page's word boxes into reading-order lines: words sharing the per-page
    // line index (w[5]) join with spaces; the line's highlight box is their union.
    function linesFromWords(words) {
      const lines = [];
      let cur = null, key = -1;
      (words || []).forEach(w => {
        const t = (w[4] || '').trim();
        if (!t) return;
        if (!cur || w[5] !== key) {
          cur = { text: '', box: [w[0], w[1], w[2], w[3]] };
          lines.push(cur); key = w[5];
        }
        cur.text += (cur.text ? ' ' : '') + t;
        cur.box[0] = Math.min(cur.box[0], w[0]); cur.box[1] = Math.min(cur.box[1], w[1]);
        cur.box[2] = Math.max(cur.box[2], w[2]); cur.box[3] = Math.max(cur.box[3], w[3]);
      });
      return lines.filter(l => l.text.length > 1);
    }
    async function ttsLoadPageLines(pi) {
      if (!S.wordsCache[pi]) {
        try { S.wordsCache[pi] = await YR.getJSON(`/api/pdf/words?path=${encodeURIComponent(path)}&page=${pi}`); }
        catch (_) { S.wordsCache[pi] = { words: [] }; }
      }
      return linesFromWords((S.wordsCache[pi] || {}).words);
    }
    async function ttsPlayFrom(pi) {
      const gen = S.ttsGen;
      let p = Math.max(0, Math.min(pi, count - 1));
      let lines = await ttsLoadPageLines(p);
      if (gen !== S.ttsGen) return;              // stopped/restarted while fetching
      while (!lines.length && p < count - 1) {   // skip image-only pages
        p++;
        lines = await ttsLoadPageLines(p);
        if (gen !== S.ttsGen) return;
      }
      if (!lines.length) {
        setTtsStatus('No readable text');
        S.ttsPlaying = false; updateTtsPlayBtn();
        YR.toast('No selectable text from here on. If this is a scan, run OCR first (Export ▸ Make searchable).', '', 4200);
        return;
      }
      S.ttsPage = p; S.ttsLines = lines; S.ttsIdx = 0;
      ttsSpeakNext();
    }
    function ttsSpeakNext() {
      if (!S.tts || !S.ttsPlaying) return;
      const synth = window.speechSynthesis;
      // page exhausted → move to the next page that has text (or stop at the end)
      if (!S.ttsLines || S.ttsIdx >= S.ttsLines.length) {
        if (S.ttsPage >= count - 1) {
          setTtsStatus('Finished');
          stopRead();
          YR.toast('Reached the end of the document', '', 2200);
          return;
        }
        ttsPlayFrom(S.ttsPage + 1);
        return;
      }
      const line = S.ttsLines[S.ttsIdx];
      S.ttsCurPage = S.ttsPage; S.ttsCurBox = line.box;
      drawTtsHighlight(S.ttsPage, line.box);
      setTtsStatus(`Reading · page ${S.ttsPage + 1} of ${count}`);
      const u = new SpeechSynthesisUtterance(line.text);
      const voice = ttsPickVoice();
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = S.ttsRate;
      let advanced = false;
      const advance = () => {
        if (advanced) return; advanced = true;
        if (!S.tts || !S.ttsPlaying) return;
        S.ttsIdx++;
        ttsSpeakNext();
      };
      u.onend = advance;
      u.onerror = advance;
      S.ttsUtter = u;                            // tracked so a deliberate cancel can detach it
      try { synth.cancel(); synth.speak(u); }   // cancel() clears any stuck queue first
      catch (_) { advance(); }
    }

    // The moving highlight: a box positioned in page points × zoom, attached to the
    // page-wrap (which always exists — only the image is lazy). Only coherent upright,
    // matching the search highlights and text layer; otherwise we just skip drawing.
    function clearTtsHighlight() { scroll.querySelectorAll('.pdf-tts-hl').forEach(el => el.remove()); }
    function drawTtsHighlight(pi, box) {
      clearTtsHighlight();
      if (!box || S.rotate % 360 !== 0) return;
      const wrap = scroll.querySelector(`.page-wrap[data-index="${pi}"]`);
      if (!wrap) return;
      const z = effZoom();
      const hl = document.createElement('div');
      hl.className = 'pdf-tts-hl';
      hl.style.left = (box[0] * z) + 'px';
      hl.style.top = (box[1] * z) + 'px';
      hl.style.width = Math.max(4, (box[2] - box[0]) * z) + 'px';
      hl.style.height = Math.max(4, (box[3] - box[1]) * z) + 'px';
      wrap.appendChild(hl);
      ensureTtsVisible(wrap, hl);
      if (S.current !== pi) { S.current = pi; updateIndicator(); }
    }
    // Scroll the spoken line into view only when it isn't already comfortably on
    // screen, so steady reading doesn't jiggle the page on every line.
    function ensureTtsVisible(wrap, hl) {
      const stage = YR.root.parentElement;
      if (!stage) return;
      const r = hl.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const pad = 40;
      if (r.top < s.top + pad || r.bottom > s.bottom - pad) {
        try { hl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { hl.scrollIntoView(); }
      }
    }
    // Re-anchor the highlight after a rebuild (zoom/rotate/spread) so it tracks.
    function redrawTtsHighlight() {
      if (S.tts && S.ttsPlaying && S.ttsCurBox && S.ttsCurPage >= 0) drawTtsHighlight(S.ttsCurPage, S.ttsCurBox);
    }

    // ── sign & stamp (P6b creation UI + P6c placement) ────────────────────────
    // A signature is a transparent PNG kept in the per-user library, then stamped
    // onto the page — baked into content (not a deletable annotation) so it rides
    // the normal 💾 Save. Three free, offline ways to make one: Draw, Type, Import.
    const SIGN_COLORS = ['#161616', '#0a3d91', '#7a1320'];
    const SIGN_FONTS = [
      { css: '"Segoe Script", "Bradley Hand", "Brush Script MT", cursive', label: 'Script' },
      { css: '"Brush Script MT", "Segoe Script", cursive', label: 'Brush' },
      { css: '"Comic Sans MS", "Comic Sans", "Segoe Print", cursive', label: 'Casual' },
      { css: 'Georgia, "Times New Roman", serif', label: 'Formal' },
    ];
    let signOverlay = null;   // creation modal element (or null)
    let placeBox = null;      // { box, wrap, idx, entry, aspect } while placing

    function openSignPanel() {
      if (signOverlay) return;
      if (S.redact) toggleRedact();           // never sign while staging redactions
      cancelPlacement();
      const ov = document.createElement('div');
      ov.className = 'sign-overlay';
      ov.innerHTML =
        '<div class="sign-card" role="dialog" aria-label="Sign and stamp">' +
        '<div class="sign-head"><span class="sign-title">✍ Sign &amp; stamp</span>' +
        '<button class="sign-x" type="button" title="Close (Esc)">✕</button></div>' +
        '<div class="sign-tabs">' +
        '<button class="sign-tab active" data-t="lib">My signatures</button>' +
        '<button class="sign-tab" data-t="draw">Draw</button>' +
        '<button class="sign-tab" data-t="type">Type</button>' +
        '<button class="sign-tab" data-t="import">Import</button></div>' +
        '<div class="sign-body"></div></div>';
      signOverlay = ov;
      document.body.appendChild(ov);
      const body = ov.querySelector('.sign-body');
      const tabs = ov.querySelectorAll('.sign-tab');
      const select = (t) => {
        tabs.forEach(b => b.classList.toggle('active', b.dataset.t === t));
        if (t === 'lib') renderLibrary(body);
        else if (t === 'draw') renderDraw(body);
        else if (t === 'type') renderType(body);
        else renderImport(body);
      };
      tabs.forEach(b => b.addEventListener('click', () => select(b.dataset.t)));
      ov.querySelector('.sign-x').addEventListener('click', closeSignPanel);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeSignPanel(); });
      ov._esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSignPanel(); } };
      document.addEventListener('keydown', ov._esc, true);
      select('lib');
    }
    function closeSignPanel() {
      if (!signOverlay) return;
      document.removeEventListener('keydown', signOverlay._esc, true);
      signOverlay.remove();
      signOverlay = null;
    }

    async function renderLibrary(body) {
      body.innerHTML = '<div class="sign-msg">Loading…</div>';
      let items = [];
      try { items = (await YR.getJSON('/api/signatures')).signatures || []; }
      catch (e) { body.innerHTML = '<div class="sign-msg">Could not load your signatures.</div>'; return; }
      if (!items.length) {
        body.innerHTML = '<div class="sign-msg">No saved signatures yet.<br><br>' +
          'Use <b>Draw</b>, <b>Type</b> or <b>Import</b> above to make one. ' +
          'It’s saved privately on this computer for reuse — never inside the PDF until you place it.</div>';
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'sign-grid';
      items.forEach(it => {
        const cell = document.createElement('div');
        cell.className = 'sign-cell';
        const thumb = document.createElement('div');
        thumb.className = 'sign-thumb';
        const img = document.createElement('img');
        img.src = `/api/signatures/${it.id}.png`;
        img.alt = it.name || 'Signature';
        thumb.appendChild(img);
        const name = document.createElement('div');
        name.className = 'sign-name';
        name.textContent = it.name || 'Signature';
        const act = document.createElement('div');
        act.className = 'sign-cell-act';
        const use = document.createElement('button');
        use.type = 'button'; use.className = 'sign-use'; use.textContent = 'Place ✍';
        use.title = 'Place this signature on the current page';
        use.addEventListener('click', () => { closeSignPanel(); beginPlacement(it); });
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'sign-del'; del.textContent = '🗑';
        del.title = 'Delete from library';
        del.addEventListener('click', async () => {
          try { await YR.postJSON('/api/signatures/delete', { id: it.id }); renderLibrary(body); }
          catch (e) { YR.toast('Delete failed: ' + (e.message || 'error'), 'error', 2600); }
        });
        act.appendChild(use); act.appendChild(del);
        cell.appendChild(thumb); cell.appendChild(name); cell.appendChild(act);
        grid.appendChild(cell);
      });
      body.innerHTML = '';
      body.appendChild(grid);
    }

    function renderDraw(body) {
      body.innerHTML = '';
      const wrap = document.createElement('div'); wrap.className = 'sign-pad-wrap';
      const canvas = document.createElement('canvas');
      canvas.className = 'sign-pad'; canvas.width = 760; canvas.height = 280;
      const ctx = canvas.getContext('2d');
      const line = document.createElement('div'); line.className = 'sign-baseline';
      wrap.appendChild(canvas); wrap.appendChild(line);
      let color = SIGN_COLORS[0], width = 3;
      const undo = [];
      const ctl = makeInkControls(
        (c) => { color = c; },
        (w) => { width = w; },
        () => { ctx.clearRect(0, 0, canvas.width, canvas.height); undo.length = 0; },
        () => { if (undo.length) ctx.putImageData(undo.pop(), 0, 0); });
      let drawing = false, last = null;
      const pt = (e) => {
        const r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
      };
      canvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        undo.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
        if (undo.length > 20) undo.shift();
        drawing = true; last = pt(e);
        try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* non-fatal */ }
        ctx.fillStyle = color; ctx.beginPath();
        ctx.arc(last.x, last.y, width / 2, 0, Math.PI * 2); ctx.fill();
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drawing) return;
        const p = pt(e);
        ctx.strokeStyle = color; ctx.lineWidth = width;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        last = p;
      });
      const end = () => { drawing = false; };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
      canvas.addEventListener('pointerleave', end);
      wrap.appendChild(ctl);
      body.appendChild(wrap);
      body.appendChild(makeSaveFoot('draw', () => trimCanvas(canvas),
        'Draw your signature above with the mouse, trackpad or your finger.'));
    }

    function renderType(body) {
      body.innerHTML = '';
      const wrap = document.createElement('div'); wrap.className = 'sign-type-wrap';
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'sign-typetext';
      input.placeholder = 'Type your name…'; input.maxLength = 48;
      const fontRow = document.createElement('div'); fontRow.className = 'sign-fonts';
      let font = SIGN_FONTS[0].css, color = SIGN_COLORS[0];
      SIGN_FONTS.forEach((f, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sign-font' + (i === 0 ? ' active' : '');
        b.style.fontFamily = f.css; b.textContent = f.label;
        b.addEventListener('click', () => {
          font = f.css;
          fontRow.querySelectorAll('.sign-font').forEach(x => x.classList.remove('active'));
          b.classList.add('active'); redraw();
        });
        fontRow.appendChild(b);
      });
      const sw = document.createElement('div'); sw.className = 'sign-swatches';
      SIGN_COLORS.forEach((c, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sign-swatch' + (i === 0 ? ' active' : '');
        b.style.background = c; b.title = c;
        b.addEventListener('click', () => {
          color = c;
          sw.querySelectorAll('.sign-swatch').forEach(x => x.classList.remove('active'));
          b.classList.add('active'); redraw();
        });
        sw.appendChild(b);
      });
      const preview = document.createElement('canvas');
      preview.className = 'sign-typeprev'; preview.width = 760; preview.height = 200;
      const redraw = () => {
        const c = preview.getContext('2d');
        c.clearRect(0, 0, preview.width, preview.height);
        const text = input.value.trim();
        if (!text) return;
        c.fillStyle = color; c.textBaseline = 'middle'; c.textAlign = 'center';
        let size = 120; c.font = `${size}px ${font}`;
        while (size > 22 && c.measureText(text).width > preview.width - 48) { size -= 4; c.font = `${size}px ${font}`; }
        c.fillText(text, preview.width / 2, preview.height / 2);
      };
      input.addEventListener('input', redraw);
      const ctl = document.createElement('div'); ctl.className = 'sign-ctl';
      const lbl = document.createElement('span'); lbl.className = 'sign-lbl'; lbl.textContent = 'Ink';
      ctl.appendChild(lbl); ctl.appendChild(sw);
      wrap.appendChild(input); wrap.appendChild(fontRow); wrap.appendChild(ctl); wrap.appendChild(preview);
      body.appendChild(wrap);
      body.appendChild(makeSaveFoot('type',
        () => { redraw(); return input.value.trim() ? trimCanvas(preview) : null; },
        'Pick a handwriting style and ink colour, then save.'));
      setTimeout(() => input.focus(), 40);
    }

    function renderImport(body) {
      body.innerHTML = '';
      const wrap = document.createElement('div'); wrap.className = 'sign-import-wrap';
      const file = document.createElement('input');
      file.type = 'file'; file.accept = 'image/*'; file.className = 'sign-file';
      const knock = document.createElement('label'); knock.className = 'sign-knock';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
      knock.appendChild(cb);
      knock.appendChild(document.createTextNode(' Make white background transparent'));
      const canvas = document.createElement('canvas');
      canvas.className = 'sign-import-prev'; canvas.width = 760; canvas.height = 280;
      let srcImg = null, loaded = false;
      const redraw = () => {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!srcImg) return;
        const scale = Math.min(canvas.width / srcImg.width, canvas.height / srcImg.height, 1);
        const w = srcImg.width * scale, h = srcImg.height * scale;
        ctx.drawImage(srcImg, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
        if (cb.checked) knockoutWhite(ctx, canvas);
        loaded = true;
      };
      file.addEventListener('change', () => {
        const f = file.files && file.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => { const im = new Image(); im.onload = () => { srcImg = im; redraw(); }; im.src = rd.result; };
        rd.readAsDataURL(f);
      });
      cb.addEventListener('change', redraw);
      wrap.appendChild(file); wrap.appendChild(knock); wrap.appendChild(canvas);
      body.appendChild(wrap);
      body.appendChild(makeSaveFoot('import', () => loaded ? trimCanvas(canvas) : null,
        'Choose an image of your signature — a phone photo on white paper works well.'));
    }

    function makeInkControls(onColor, onWidth, onClear, onUndo) {
      const bar = document.createElement('div'); bar.className = 'sign-ctl';
      const lbl = (t) => { const s = document.createElement('span'); s.className = 'sign-lbl'; s.textContent = t; return s; };
      const sw = document.createElement('div'); sw.className = 'sign-swatches';
      SIGN_COLORS.forEach((c, i) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'sign-swatch' + (i === 0 ? ' active' : '');
        b.style.background = c; b.title = c;
        b.addEventListener('click', () => {
          sw.querySelectorAll('.sign-swatch').forEach(x => x.classList.remove('active'));
          b.classList.add('active'); onColor(c);
        });
        sw.appendChild(b);
      });
      const range = document.createElement('input');
      range.type = 'range'; range.min = '1'; range.max = '8'; range.value = '3';
      range.className = 'sign-range'; range.title = 'Pen thickness';
      range.addEventListener('input', () => onWidth(parseInt(range.value, 10)));
      const mini = (t, fn) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'sign-mini'; b.textContent = t; b.addEventListener('click', fn); return b; };
      bar.appendChild(lbl('Ink')); bar.appendChild(sw);
      bar.appendChild(lbl('Pen')); bar.appendChild(range);
      bar.appendChild(mini('↺ Undo', onUndo));
      bar.appendChild(mini('Clear', onClear));
      return bar;
    }

    function makeSaveFoot(kind, getCanvas, hint) {
      const foot = document.createElement('div'); foot.className = 'sign-foot';
      const h = document.createElement('div'); h.className = 'sign-hint'; h.textContent = hint || '';
      const row = document.createElement('div'); row.className = 'sign-foot-row';
      const name = document.createElement('input');
      name.type = 'text'; name.className = 'sign-nameinput'; name.placeholder = 'Name (optional)'; name.maxLength = 60;
      const save = document.createElement('button');
      save.type = 'button'; save.className = 'sign-save'; save.textContent = 'Save & place ✍';
      save.addEventListener('click', async () => {
        const c = getCanvas();
        if (!c) { YR.toast('Nothing to save yet', '', 1700); return; }
        save.disabled = true;
        try {
          const entry = await saveSignature(c.toDataURL('image/png'), kind, name.value);
          closeSignPanel();
          beginPlacement(entry);
        } catch (e) {
          YR.toast('Could not save: ' + (e.message || 'error'), 'error', 3000);
          save.disabled = false;
        }
      });
      row.appendChild(name); row.appendChild(save);
      foot.appendChild(h); foot.appendChild(row);
      return foot;
    }
    async function saveSignature(dataURL, kind, name) {
      const r = await YR.postJSON('/api/signatures', { png: dataURL, kind, name: (name || '').trim() });
      return r.signature;
    }

    // Knock near-white pixels out to transparent (soft edge in a small band) so an
    // imported photo of a signature on paper drops its background.
    function knockoutWhite(ctx, canvas) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const m = Math.min(d[i], d[i + 1], d[i + 2]);
        if (m > 205) d[i + 3] = 0;
        else if (m > 165) d[i + 3] = Math.round(d[i + 3] * (205 - m) / 40);
      }
      ctx.putImageData(img, 0, 0);
    }

    // Crop a canvas to its non-transparent bounds (+pad). Returns a new canvas, or
    // null if nothing was drawn.
    function trimCanvas(src) {
      const w = src.width, h = src.height;
      let data;
      try { data = src.getContext('2d').getImageData(0, 0, w, h).data; }
      catch (_) { return src; }
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (data[(y * w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return null;
      const pad = 6;
      minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
      maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
      const cw = maxX - minX + 1, ch = maxY - minY + 1;
      const out = document.createElement('canvas');
      out.width = cw; out.height = ch;
      out.getContext('2d').drawImage(src, minX, minY, cw, ch, 0, 0, cw, ch);
      return out;
    }

    // ── placement overlay (P6c) ──────────────────────────────────────────────
    function beginPlacement(entry) {
      cancelPlacement();
      if (!entry || !entry.id) return;
      // Placement maths + the backend rect are in unrotated page points, so force
      // an upright view first (mirrors what markup mode does).
      if (S.rotate % 360 !== 0) {
        S.rotate = 0;
        if (rotateBtn) rotateBtn.classList.remove('active');
        rerender();
      }
      const idx = S.current;
      const wrap = scroll.querySelector(`.page-wrap[data-index="${idx}"]`);
      if (!wrap) { YR.toast('Scroll to the page you want to sign first', '', 2200); return; }
      const z = effZoom();
      const dims = pageDims();
      const aspect = (entry.h && entry.w) ? entry.h / entry.w : 0.4;
      let boxW = Math.min(dims.w * 0.36, 240);
      let boxH = boxW * aspect;
      if (boxH > dims.h * 0.4) { boxH = dims.h * 0.4; boxW = boxH / aspect; }
      let left = Math.max(12, dims.w - boxW - 44);   // default lower-right
      let top = Math.max(12, dims.h - boxH - 52);

      const box = document.createElement('div');
      box.className = 'sign-place';
      box.style.left = (left * z) + 'px'; box.style.top = (top * z) + 'px';
      box.style.width = (boxW * z) + 'px'; box.style.height = (boxH * z) + 'px';
      const img = document.createElement('img');
      img.className = 'sign-place-img'; img.draggable = false;
      img.src = `/api/signatures/${entry.id}.png`;
      const handle = document.createElement('div'); handle.className = 'sign-handle'; handle.title = 'Drag to resize';
      const bar = document.createElement('div'); bar.className = 'sign-place-bar';
      const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'sign-apply'; ok.textContent = '✓ Place'; ok.title = 'Stamp onto the page';
      const no = document.createElement('button'); no.type = 'button'; no.className = 'sign-cancel'; no.textContent = '✕'; no.title = 'Cancel';
      bar.appendChild(ok); bar.appendChild(no);
      box.appendChild(img); box.appendChild(handle); box.appendChild(bar);
      wrap.appendChild(box);
      placeBox = { box, wrap, idx, entry, aspect };
      // the default lower-right spot is often below the fold — bring it into view
      try { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { /* non-fatal */ }

      box.addEventListener('pointerdown', (e) => {           // drag to move
        if (e.target === handle || e.target === ok || e.target === no) return;
        e.preventDefault();
        const sx = e.clientX, sy = e.clientY;
        const ol = parseFloat(box.style.left), ot = parseFloat(box.style.top);
        const ww = wrap.clientWidth, wh = wrap.clientHeight;
        const bw = box.offsetWidth, bh = box.offsetHeight;
        const move = (ev) => {
          let nl = Math.max(0, Math.min(ol + (ev.clientX - sx), ww - bw));
          let nt = Math.max(0, Math.min(ot + (ev.clientY - sy), wh - bh));
          box.style.left = nl + 'px'; box.style.top = nt + 'px';
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      handle.addEventListener('pointerdown', (e) => {        // resize (keep aspect)
        e.preventDefault(); e.stopPropagation();
        const sx = e.clientX;
        const ol = parseFloat(box.style.left), ot = parseFloat(box.style.top);
        const bw0 = box.offsetWidth;
        const ww = wrap.clientWidth, wh = wrap.clientHeight;
        const move = (ev) => {
          let nw = Math.max(28, Math.min(bw0 + (ev.clientX - sx), ww - ol));
          let nh = nw * placeBox.aspect;
          if (nh > wh - ot) { nh = wh - ot; nw = nh / placeBox.aspect; }
          box.style.width = nw + 'px'; box.style.height = nh + 'px';
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      ok.addEventListener('click', applyPlacement);
      no.addEventListener('click', cancelPlacement);
      YR.toast('Drag to position · pull the corner to resize · then ✓ Place', '', 3400);
    }
    function cancelPlacement() {
      if (placeBox) { placeBox.box.remove(); placeBox = null; }
    }
    async function applyPlacement() {
      if (!placeBox) return;
      const { box, idx, entry } = placeBox;
      const z = effZoom();
      const left = parseFloat(box.style.left), top = parseFloat(box.style.top);
      const w = box.offsetWidth, h = box.offsetHeight;
      const rect = [left / z, top / z, (left + w) / z, (top + h) / z];
      const ok = box.querySelector('.sign-apply');
      if (ok) ok.disabled = true;
      try {
        await YR.postJSON('/api/pdf/stamp', { path, page: idx, rect, signature: entry.id, keep_proportion: true });
        cancelPlacement();
        setDirty(true);
        refreshPage(idx);
        YR.toast('Signature placed — click 💾 Save to write it into the PDF', 'success', 2800);
      } catch (e) {
        if (ok) ok.disabled = false;
        YR.toast('Could not place: ' + (e.message || 'error'), 'error', 3200);
      }
    }

    // ── fill: interactive form fields (P7b) ─────────────────────────────────────
    // Mirrors markup mode: a per-page `.form-layer` overlay carries HTML inputs
    // positioned over each AcroForm widget (rects are in unrotated page points, so
    // forms only line up at rot=0). Editing a control POSTs to /api/pdf/field —
    // which mutates the cached doc in memory and marks it dirty — and the existing
    // 💾 Save writes the values into the PDF.
    async function loadFields() {
      if (S.fields) return S.fields;
      try {
        const r = await YR.getJSON(`/api/pdf/fields?path=${encodeURIComponent(path)}`);
        S.fields = (r && r.fields) || [];
      } catch (e) {
        S.fields = [];
      }
      return S.fields;
    }

    async function toggleFill() {
      if (!S.fill) {
        if (S.markup) toggleMarkup();            // mutually exclusive overlays
        if (S.redact) toggleRedact();
        if (S.tts) toggleRead();
        cancelPlacement();
        const fields = await loadFields();
        if (!fields.length) { YR.toast('This PDF has no fillable form fields', '', 2600); return; }
        S.fill = true;
        fillBtn.classList.add('active');
        if (S._modesMenu && S._modesMenu._refreshMenuActive) S._modesMenu._refreshMenuActive();
        if (rotateBtn) rotateBtn.disabled = true;
        if (S.rotate % 360 !== 0) {
          S.rotate = 0;
          if (rotateBtn) rotateBtn.classList.remove('active');
          rerender();                            // buildPages re-adds the layers
        } else {
          syncFormLayers();
        }
        const n = fields.filter(f => !f.readonly && f.kind !== 'signature').length;
        YR.toast(`Fill mode on — ${n} field${n === 1 ? '' : 's'} to complete · 💾 Save when done`, '', 3200);
      } else {
        S.fill = false;
        fillBtn.classList.remove('active');
        if (S._modesMenu && S._modesMenu._refreshMenuActive) S._modesMenu._refreshMenuActive();
        if (rotateBtn) rotateBtn.disabled = false;
        syncFormLayers();                        // tears the layers down
        // re-render the pages that changed so the baked-in widget values show
        Object.keys(S.fillEdited).forEach(k => refreshPage(parseInt(k, 10)));
        S.fillEdited = {};
      }
    }

    function syncFormLayers() {
      const on = S.fill && (S.rotate % 360 === 0) && S.fields && S.fields.length;
      const z = effZoom();
      scroll.querySelectorAll('.page-wrap').forEach(wrap => {
        const idx = parseInt(wrap.dataset.index, 10);
        let layer = wrap.querySelector('.form-layer');
        if (on) {
          const mine = S.fields.filter(f => f.page === idx);
          if (!mine.length) { if (layer) layer.remove(); return; }
          if (!layer) {
            layer = document.createElement('div');
            layer.className = 'form-layer';
            wrap.appendChild(layer);
          }
          layer.innerHTML = '';
          mine.forEach(f => layer.appendChild(buildFieldControl(f, z)));
        } else if (layer) {
          layer.remove();
        }
      });
    }

    function buildFieldControl(f, z) {
      const r = f.rect || [0, 0, 0, 0];
      const cell = document.createElement('div');
      cell.className = 'form-field kind-' + f.kind + (f.readonly ? ' ro' : '');
      cell.style.left = (r[0] * z) + 'px';
      cell.style.top = (r[1] * z) + 'px';
      cell.style.width = Math.max(8, (r[2] - r[0]) * z) + 'px';
      cell.style.height = Math.max(8, (r[3] - r[1]) * z) + 'px';
      const fs = Math.max(9, Math.min(16, (r[3] - r[1]) * z * 0.6));

      if (f.kind === 'checkbox') {
        const box = document.createElement('button');
        box.type = 'button';
        box.className = 'form-check' + (f.checked ? ' on' : '');
        box.textContent = f.checked ? '✓' : '';
        box.title = f.name || 'Checkbox';
        box.disabled = !!f.readonly;
        box.style.fontSize = fs + 'px';
        if (!f.readonly) box.addEventListener('click', () => {
          const next = !box.classList.contains('on');
          box.classList.toggle('on', next);
          box.textContent = next ? '✓' : '';
          f.checked = next; f.value = next ? (f.on || 'Yes') : 'Off';
          postField(f, next);
        });
        cell.appendChild(box);
      } else if (f.kind === 'radio') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'form-radio' + (String(f.value) === String(f.on) ? ' on' : '');
        btn.title = (f.name || 'Option') + ' → ' + (f.on || '');
        btn.disabled = !!f.readonly;
        if (!f.readonly) btn.addEventListener('click', () => {
          (S.fields || []).forEach(g => { if (g.name === f.name) g.value = f.on; });
          postField(f, f.on);
          syncFormLayers();                      // reflect single selection in the group
        });
        cell.appendChild(btn);
      } else if (f.kind === 'combo' || f.kind === 'list') {
        const sel = document.createElement('select');
        sel.className = 'form-input';
        sel.disabled = !!f.readonly;
        sel.style.fontSize = fs + 'px';
        const opts = (f.options || []).slice();
        const cur = f.value == null ? '' : String(f.value);
        if (cur && !opts.includes(cur)) opts.unshift(cur);
        const blank = document.createElement('option'); blank.value = ''; blank.textContent = '—';
        sel.appendChild(blank);
        opts.forEach(o => {
          const op = document.createElement('option'); op.value = o; op.textContent = o;
          if (o === cur) op.selected = true;
          sel.appendChild(op);
        });
        if (!f.readonly) sel.addEventListener('change', () => { f.value = sel.value; postField(f, sel.value); });
        cell.appendChild(sel);
      } else {                                    // text (single line or multiline)
        const inp = document.createElement(f.multiline ? 'textarea' : 'input');
        if (!f.multiline) inp.type = 'text';
        inp.className = 'form-input';
        inp.value = f.value == null ? '' : String(f.value);
        inp.disabled = !!f.readonly;
        inp.style.fontSize = fs + 'px';
        if (f.maxlen && f.maxlen > 0) inp.maxLength = f.maxlen;
        if (!f.readonly) {
          inp.addEventListener('change', () => { f.value = inp.value; postField(f, inp.value); });
          if (!f.multiline) inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
        }
        cell.appendChild(inp);
      }
      return cell;
    }

    async function postField(f, value) {
      try {
        await YR.postJSON('/api/pdf/field', { path, page: f.page, name: f.name, value });
        S.fillEdited[f.page] = true;
        setDirty(true);
      } catch (e) {
        YR.toast('Could not set “' + (f.name || 'field') + '”: ' + (e.message || 'error'), 'error', 3200);
      }
    }

    // ── merge & split (P8b) ───────────────────────────────────────────────────
    // A focused modal with two tabs. Both write NEW files through native dialogs
    // and never mutate the open document, so there's no dirty flag or leave-guard.
    //   Merge: an ordered list whose first row is "this document" ('self' to the
    //   backend, carrying any unsaved edits); add more PDFs, reorder, then Combine.
    //   Split: carve the open PDF into per-page / fixed-chunk / custom ranges.
    let msOverlay = null;
    let msMerge = null;                       // [{kind:'self'|'file', name, path}]
    const msSplit = { mode: 'each', n: 1, custom: '', dir: '', stem: '' };

    function openMergeSplit() {
      if (msOverlay) return;
      closeSignPanel();                       // never stack on the sign modal
      const { dir, base } = splitPath(path);
      const selfSeg = String(path).split(/[\\/]/).pop() || 'This document';
      if (!msMerge) msMerge = [{ kind: 'self', name: selfSeg + '  · this file', path }];
      if (!msSplit.dir) msSplit.dir = dir;
      if (!msSplit.stem) msSplit.stem = base || 'page';
      const ov = document.createElement('div');
      ov.className = 'ms-overlay';
      ov.innerHTML =
        '<div class="sign-card" role="dialog" aria-label="Merge and split PDF">' +
        '<div class="sign-head"><span class="sign-title">🔗 Merge &amp; split</span>' +
        '<button class="sign-x" type="button" title="Close (Esc)">✕</button></div>' +
        '<div class="sign-tabs">' +
        '<button class="sign-tab active" data-t="merge">Merge</button>' +
        '<button class="sign-tab" data-t="split">Split</button></div>' +
        '<div class="sign-body"></div></div>';
      msOverlay = ov;
      document.body.appendChild(ov);
      const body = ov.querySelector('.sign-body');
      const tabs = ov.querySelectorAll('.sign-tab');
      const select = (t) => {
        tabs.forEach(b => b.classList.toggle('active', b.dataset.t === t));
        if (t === 'merge') renderMergeTab(body);
        else renderSplitTab(body);
      };
      tabs.forEach(b => b.addEventListener('click', () => select(b.dataset.t)));
      ov.querySelector('.sign-x').addEventListener('click', closeMergeSplit);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeMergeSplit(); });
      ov._esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMergeSplit(); } };
      document.addEventListener('keydown', ov._esc, true);
      select('merge');
    }
    function closeMergeSplit() {
      if (!msOverlay) return;
      document.removeEventListener('keydown', msOverlay._esc, true);
      msOverlay.remove();
      msOverlay = null;
    }
    function msBody() { return msOverlay && msOverlay.querySelector('.sign-body'); }

    // ── merge tab ──────────────────────────────────────────────────────────────
    function renderMergeTab(body) {
      body.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = 'ms-hint';
      hint.textContent = 'Join this PDF with others into one new file. Use ↑ ↓ to set the order. Your original file is never changed.';
      body.appendChild(hint);

      const list = document.createElement('div');
      list.className = 'ms-list';
      msMerge.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'ms-row' + (it.kind === 'self' ? ' self' : '');
        const idx = document.createElement('span'); idx.className = 'ms-idx'; idx.textContent = (i + 1);
        const name = document.createElement('span'); name.className = 'ms-name';
        name.textContent = it.name; name.title = it.path;
        const ctl = document.createElement('span'); ctl.className = 'ms-row-ctl';
        const mk = (icon, title, fn, dis) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'ms-mini'; b.textContent = icon; b.title = title;
          if (dis) b.disabled = true; else b.addEventListener('click', fn);
          return b;
        };
        ctl.appendChild(mk('↑', 'Move up', () => moveMergeRow(i, -1), i === 0));
        ctl.appendChild(mk('↓', 'Move down', () => moveMergeRow(i, 1), i === msMerge.length - 1));
        ctl.appendChild(mk('✕', 'Remove from list', () => removeMergeRow(i), false));
        row.appendChild(idx); row.appendChild(name); row.appendChild(ctl);
        list.appendChild(row);
      });
      body.appendChild(list);

      const acts = document.createElement('div');
      acts.className = 'ms-acts';
      const add = document.createElement('button');
      add.type = 'button'; add.className = 'ms-act'; add.textContent = '➕ Add PDFs…';
      add.title = 'Pick one or more PDFs to append';
      add.addEventListener('click', addMergeFiles);
      const combine = document.createElement('button');
      combine.type = 'button'; combine.className = 'ms-act primary'; combine.textContent = '🔗 Combine → save…';
      combine.disabled = msMerge.length < 2;
      combine.addEventListener('click', () => doMerge(combine));
      acts.appendChild(add); acts.appendChild(combine);
      body.appendChild(acts);

      const sum = document.createElement('div');
      sum.className = 'ms-sum';
      sum.textContent = msMerge.length < 2
        ? 'Add at least one more PDF to combine.'
        : `${msMerge.length} files will be combined, top to bottom.`;
      body.appendChild(sum);
    }
    async function addMergeFiles() {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.browse_pdfs) { YR.toast('Adding files needs the desktop app', '', 2400); return; }
      let picked = [];
      try { picked = await api.browse_pdfs(); } catch (_) { picked = []; }
      if (!picked || !picked.length) return;
      picked.forEach(p => {
        const seg = String(p).split(/[\\/]/).pop() || 'document.pdf';
        msMerge.push({ kind: 'file', name: seg, path: String(p) });
      });
      const body = msBody(); if (body) renderMergeTab(body);
    }
    function moveMergeRow(i, dir) {
      const j = i + dir;
      if (j < 0 || j >= msMerge.length) return;
      const [it] = msMerge.splice(i, 1);
      msMerge.splice(j, 0, it);
      const body = msBody(); if (body) renderMergeTab(body);
    }
    function removeMergeRow(i) {
      msMerge.splice(i, 1);
      const body = msBody(); if (body) renderMergeTab(body);
    }
    async function doMerge(btn) {
      if (msMerge.length < 2) { YR.toast('Add at least one more PDF', '', 1800); return; }
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.save_file) { YR.toast('Saving needs the desktop app', '', 2400); return; }
      const { dir, base } = splitPath(path);
      let target = null;
      try {
        target = await api.save_file(`${base || 'merged'} (combined).pdf`, dir,
          ['PDF document (*.pdf)', 'All files (*.*)']);
      } catch (_) { target = null; }
      if (!target) return;                    // user cancelled
      const sequence = msMerge.map(it => it.kind === 'self' ? 'self' : it.path);
      btn.disabled = true;
      try {
        const res = await YR.postJSON('/api/pdf/merge', { path, target, sequence });
        YR.toast(`Combined ${res.pages}-page PDF · ${res.name}`, 'success', 2800);
        closeMergeSplit();
      } catch (e) {
        YR.toast('Merge failed: ' + (e.message || 'unknown'), 'error', 3400);
      } finally {
        btn.disabled = false;
      }
    }

    // ── split tab ──────────────────────────────────────────────────────────────
    function renderSplitTab(body) {
      body.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = 'ms-hint';
      hint.textContent = `Break this ${count}-page PDF into separate files. Your original file is never changed.`;
      body.appendChild(hint);

      const modeWrap = document.createElement('div');
      modeWrap.className = 'ms-field';
      modeWrap.innerHTML = '<label class="ms-label">How to split</label>';
      const seg = document.createElement('div'); seg.className = 'ms-seg';
      [['each', 'Each page'], ['every', 'Every N pages'], ['custom', 'Custom ranges']].forEach(([m, lbl]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ms-seg-btn' + (msSplit.mode === m ? ' active' : '');
        b.textContent = lbl;
        b.addEventListener('click', () => { msSplit.mode = m; renderSplitTab(body); });
        seg.appendChild(b);
      });
      modeWrap.appendChild(seg);
      body.appendChild(modeWrap);

      if (msSplit.mode === 'every') {
        const f = document.createElement('div'); f.className = 'ms-field';
        f.innerHTML = '<label class="ms-label">Pages per file</label>';
        const inp = document.createElement('input');
        inp.type = 'number'; inp.min = '1'; inp.max = String(count);
        inp.value = String(msSplit.n || 1); inp.className = 'ms-input';
        inp.addEventListener('change', () => {
          msSplit.n = Math.max(1, Math.min(count, parseInt(inp.value, 10) || 1));
          inp.value = String(msSplit.n); updateSplitPreview(body);
        });
        f.appendChild(inp); body.appendChild(f);
      } else if (msSplit.mode === 'custom') {
        const f = document.createElement('div'); f.className = 'ms-field';
        f.innerHTML = `<label class="ms-label">Ranges (pages 1–${count})</label>`;
        const inp = document.createElement('input');
        inp.type = 'text'; inp.placeholder = 'e.g. 1-3, 5, 8-10';
        inp.value = msSplit.custom || ''; inp.className = 'ms-input';
        inp.addEventListener('input', () => { msSplit.custom = inp.value; updateSplitPreview(body); });
        f.appendChild(inp); body.appendChild(f);
      }

      const folderF = document.createElement('div'); folderF.className = 'ms-field';
      folderF.innerHTML = '<label class="ms-label">Save into folder</label>';
      const folderRow = document.createElement('div'); folderRow.className = 'ms-folder';
      const folderTxt = document.createElement('span'); folderTxt.className = 'ms-folder-path';
      folderTxt.textContent = msSplit.dir || '(choose a folder)'; folderTxt.title = msSplit.dir || '';
      const chooseBtn = document.createElement('button');
      chooseBtn.type = 'button'; chooseBtn.className = 'ms-mini wide'; chooseBtn.textContent = '📁 Choose…';
      chooseBtn.addEventListener('click', chooseSplitDir);
      folderRow.appendChild(folderTxt); folderRow.appendChild(chooseBtn);
      folderF.appendChild(folderRow); body.appendChild(folderF);

      const stemF = document.createElement('div'); stemF.className = 'ms-field';
      stemF.innerHTML = '<label class="ms-label">File name prefix</label>';
      const stemInp = document.createElement('input');
      stemInp.type = 'text'; stemInp.className = 'ms-input'; stemInp.value = msSplit.stem || '';
      stemInp.addEventListener('input', () => { msSplit.stem = stemInp.value; });
      stemF.appendChild(stemInp); body.appendChild(stemF);

      const prev = document.createElement('div'); prev.className = 'ms-sum ms-preview';
      body.appendChild(prev);
      const acts = document.createElement('div'); acts.className = 'ms-acts';
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'ms-act primary'; go.textContent = '✂ Split';
      go.addEventListener('click', () => doSplit(go));
      acts.appendChild(go); body.appendChild(acts);
      updateSplitPreview(body);
    }
    function computeSplitRanges() {
      const n = count;
      if (msSplit.mode === 'each') return { ranges: Array.from({ length: n }, (_, i) => [i, i]) };
      if (msSplit.mode === 'every') {
        const step = Math.max(1, Math.min(n, msSplit.n || 1));
        const out = [];
        for (let a = 0; a < n; a += step) out.push([a, Math.min(a + step - 1, n - 1)]);
        return { ranges: out };
      }
      const txt = (msSplit.custom || '').trim();
      if (!txt) return { ranges: [], error: 'Enter one or more ranges, e.g. 1-3, 5' };
      const out = [];
      for (const part of txt.split(',')) {
        const s = part.trim();
        if (!s) continue;
        const m = s.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
        if (!m) return { ranges: [], error: `“${s}” isn’t a valid page or range` };
        let a = parseInt(m[1], 10);
        let b = m[2] ? parseInt(m[2], 10) : a;
        if (a < 1 || b < 1 || a > n || b > n) return { ranges: [], error: `Pages must be between 1 and ${n}` };
        if (a > b) { const t = a; a = b; b = t; }
        out.push([a - 1, b - 1]);
      }
      if (!out.length) return { ranges: [], error: 'Enter one or more ranges' };
      return { ranges: out };
    }
    function updateSplitPreview(body) {
      const prev = body.querySelector('.ms-preview');
      if (!prev) return;
      const { ranges, error } = computeSplitRanges();
      if (error) { prev.textContent = error; prev.classList.add('warn'); return; }
      prev.classList.remove('warn');
      const total = ranges.reduce((s, [a, b]) => s + (b - a + 1), 0);
      prev.textContent = `${ranges.length} file${ranges.length === 1 ? '' : 's'} · ${total} page${total === 1 ? '' : 's'} total`;
    }
    async function chooseSplitDir() {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.browse_folder) { YR.toast('Choosing a folder needs the desktop app', '', 2400); return; }
      let d = null;
      try { d = await api.browse_folder(); } catch (_) { d = null; }
      if (!d) return;
      msSplit.dir = d;
      const body = msBody(); if (body) renderSplitTab(body);
    }
    async function doSplit(btn) {
      const { ranges, error } = computeSplitRanges();
      if (error) { YR.toast(error, '', 2400); return; }
      if (!ranges.length) { YR.toast('Nothing to split', '', 1800); return; }
      if (!msSplit.dir) { YR.toast('Choose a folder to save into', '', 2200); return; }
      const stem = (msSplit.stem || '').trim() || undefined;
      btn.disabled = true;
      try {
        const res = await YR.postJSON('/api/pdf/split', { path, dir: msSplit.dir, ranges, stem });
        YR.toast(`Split into ${res.count} file${res.count === 1 ? '' : 's'} · saved to ${msSplit.dir}`, 'success', 3200);
        closeMergeSplit();
      } catch (e) {
        YR.toast('Split failed: ' + (e.message || 'unknown'), 'error', 3400);
      } finally {
        btn.disabled = false;
      }
    }

    // ── export & optimize hub (P9b images + P10b compress + P11b OCR) ─────────
    // One modal, three tabs that all *produce a new file* and never touch the open
    // PDF: 🖼 Images renders pages to PNG/JPG via /api/pdf/export-images,
    // 🗜 Compress writes a smaller copy via /api/pdf/compress, and 🔎 OCR writes a
    // searchable copy via /api/pdf/ocr. No dirty flag, no leave-guard — the source
    // is read-only here.
    let xiOverlay = null;
    const xiState = { range: 'all', custom: '', fmt: 'png', dpi: 150, dir: '', stem: '' };
    const xcState = { level: 'balanced' };
    const ocState = { scope: 'all', custom: '', lang: 'eng', skipText: true, status: null };
    // Tesseract language codes → friendly names (only the common ones; anything
    // else falls back to its uppercased code via ocrLangLabel).
    const OCR_LANG_NAMES = {
      eng: 'English', ara: 'Arabic', fra: 'French', deu: 'German', spa: 'Spanish',
      ita: 'Italian', por: 'Portuguese', nld: 'Dutch', rus: 'Russian', tur: 'Turkish',
      chi_sim: 'Chinese (Simplified)', chi_tra: 'Chinese (Traditional)', jpn: 'Japanese',
      kor: 'Korean', hin: 'Hindi', fas: 'Persian', urd: 'Urdu', ell: 'Greek',
      heb: 'Hebrew', pol: 'Polish', ukr: 'Ukrainian', swe: 'Swedish', ces: 'Czech',
    };
    function ocrLangLabel(code) { return OCR_LANG_NAMES[code] || code.toUpperCase(); }
    // level → [id, label, what-it-does]; mirrors fitzdoc._COMPRESS_LEVELS.
    const XC_LEVELS = [
      ['light', 'Light', 'Lossless tidy-up — restructures and re-compresses the file without touching image quality. Safest; best on text-heavy PDFs.'],
      ['balanced', 'Balanced', 'Recommended. Downsizes oversized images to ~150 dpi and re-encodes them — big shrink with little visible change. Ideal for scans.'],
      ['strong', 'Strong', 'Smallest file. Aggressively downsizes images to ~96 dpi at lower quality. Best for screen-only sharing where size matters most.'],
    ];

    function openExportHub(tab) {
      if (xiOverlay) return;
      closeSignPanel();                       // never stack on other modals
      closeMergeSplit();
      const { dir, base } = splitPath(path);
      if (!xiState.dir) xiState.dir = dir;
      if (!xiState.stem) xiState.stem = base || 'page';
      const ov = document.createElement('div');
      ov.className = 'xi-overlay';
      ov.innerHTML =
        '<div class="sign-card" role="dialog" aria-label="Export and optimize PDF">' +
        '<div class="sign-head"><span class="sign-title">📤 Export &amp; optimize</span>' +
        '<button class="sign-x" type="button" title="Close (Esc)">✕</button></div>' +
        '<div class="sign-tabs">' +
        '<button class="sign-tab active" data-t="images">🖼 Images</button>' +
        '<button class="sign-tab" data-t="compress">🗜 Compress</button>' +
        '<button class="sign-tab" data-t="ocr">🔎 OCR</button></div>' +
        '<div class="sign-body"></div></div>';
      xiOverlay = ov;
      document.body.appendChild(ov);
      const body = ov.querySelector('.sign-body');
      const tabs = ov.querySelectorAll('.sign-tab');
      const select = (t) => {
        tabs.forEach(b => b.classList.toggle('active', b.dataset.t === t));
        if (t === 'compress') renderCompressTab(body);
        else if (t === 'ocr') renderOcrTab(body);
        else renderImagesTab(body);
      };
      tabs.forEach(b => b.addEventListener('click', () => select(b.dataset.t)));
      ov.querySelector('.sign-x').addEventListener('click', closeExportHub);
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeExportHub(); });
      ov._esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeExportHub(); } };
      document.addEventListener('keydown', ov._esc, true);
      select(['compress', 'ocr'].includes(tab) ? tab : 'images');
    }
    function closeExportHub() {
      if (!xiOverlay) return;
      document.removeEventListener('keydown', xiOverlay._esc, true);
      xiOverlay.remove();
      xiOverlay = null;
    }
    function xiBody() { return xiOverlay && xiOverlay.querySelector('.sign-body'); }

    function renderImagesTab(body) {
      body.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = 'ms-hint';
      hint.textContent = `Save pages from this ${count}-page PDF as image files. Your original PDF is never changed.`;
      body.appendChild(hint);

      // which pages
      const rangeF = document.createElement('div'); rangeF.className = 'ms-field';
      rangeF.innerHTML = '<label class="ms-label">Which pages</label>';
      const rseg = document.createElement('div'); rseg.className = 'ms-seg';
      [['current', 'This page'], ['all', 'All pages'], ['custom', 'Custom…']].forEach(([m, lbl]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ms-seg-btn' + (xiState.range === m ? ' active' : '');
        b.textContent = lbl;
        b.addEventListener('click', () => { xiState.range = m; renderImagesTab(body); });
        rseg.appendChild(b);
      });
      rangeF.appendChild(rseg); body.appendChild(rangeF);

      if (xiState.range === 'custom') {
        const f = document.createElement('div'); f.className = 'ms-field';
        f.innerHTML = `<label class="ms-label">Pages (1–${count})</label>`;
        const inp = document.createElement('input');
        inp.type = 'text'; inp.placeholder = 'e.g. 1-3, 5, 8-10';
        inp.value = xiState.custom || ''; inp.className = 'ms-input';
        inp.addEventListener('input', () => { xiState.custom = inp.value; updateExportPreview(body); });
        f.appendChild(inp); body.appendChild(f);
      }

      // format
      const fmtF = document.createElement('div'); fmtF.className = 'ms-field';
      fmtF.innerHTML = '<label class="ms-label">Format</label>';
      const fseg = document.createElement('div'); fseg.className = 'ms-seg';
      [['png', 'PNG · lossless'], ['jpg', 'JPG · smaller']].forEach(([m, lbl]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ms-seg-btn' + (xiState.fmt === m ? ' active' : '');
        b.textContent = lbl;
        b.addEventListener('click', () => { xiState.fmt = m; renderImagesTab(body); });
        fseg.appendChild(b);
      });
      fmtF.appendChild(fseg); body.appendChild(fmtF);

      // resolution (the chosen dpi is also echoed in the summary line below)
      const dpiF = document.createElement('div'); dpiF.className = 'ms-field';
      dpiF.innerHTML = '<label class="ms-label">Resolution</label>';
      const dseg = document.createElement('div'); dseg.className = 'ms-seg';
      [[96, 'Screen'], [150, 'Good'], [300, 'High'], [600, 'Max']].forEach(([v, lbl]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ms-seg-btn' + (xiState.dpi === v ? ' active' : '');
        b.textContent = lbl; b.title = `${v} dpi`;
        b.addEventListener('click', () => { xiState.dpi = v; renderImagesTab(body); });
        dseg.appendChild(b);
      });
      dpiF.appendChild(dseg); body.appendChild(dpiF);

      // destination folder
      const folderF = document.createElement('div'); folderF.className = 'ms-field';
      folderF.innerHTML = '<label class="ms-label">Save into folder</label>';
      const folderRow = document.createElement('div'); folderRow.className = 'ms-folder';
      const folderTxt = document.createElement('span'); folderTxt.className = 'ms-folder-path';
      folderTxt.textContent = xiState.dir || '(choose a folder)'; folderTxt.title = xiState.dir || '';
      const chooseBtn = document.createElement('button');
      chooseBtn.type = 'button'; chooseBtn.className = 'ms-mini wide'; chooseBtn.textContent = '📁 Choose…';
      chooseBtn.addEventListener('click', chooseExportDir);
      folderRow.appendChild(folderTxt); folderRow.appendChild(chooseBtn);
      folderF.appendChild(folderRow); body.appendChild(folderF);

      // file-name prefix → files are named "<prefix> (p1).png", "<prefix> (p2).png", …
      const stemF = document.createElement('div'); stemF.className = 'ms-field';
      stemF.innerHTML = '<label class="ms-label">File name prefix</label>';
      const stemInp = document.createElement('input');
      stemInp.type = 'text'; stemInp.className = 'ms-input'; stemInp.value = xiState.stem || '';
      stemInp.addEventListener('input', () => { xiState.stem = stemInp.value; updateExportPreview(body); });
      stemF.appendChild(stemInp); body.appendChild(stemF);

      const prev = document.createElement('div'); prev.className = 'ms-sum ms-xi-preview';
      body.appendChild(prev);
      const acts = document.createElement('div'); acts.className = 'ms-acts';
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'ms-act primary'; go.textContent = '🖼 Export';
      go.addEventListener('click', () => doExportImages(go));
      acts.appendChild(go); body.appendChild(acts);
      updateExportPreview(body);
    }
    // Parse a "1-3, 5, 8-10" page string → { pages:[0-based ints] } or { pages:[], error }.
    // Shared by the Images and OCR tabs so the two never drift apart.
    function parseCustomPages(raw) {
      const txt = (raw || '').trim();
      if (!txt) return { pages: [], error: 'Enter one or more pages, e.g. 1-3, 5' };
      const set = [], seen = new Set();
      for (const part of txt.split(',')) {
        const s = part.trim(); if (!s) continue;
        const m = s.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
        if (!m) return { pages: [], error: `“${s}” isn’t a valid page or range` };
        let a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
        if (a < 1 || b < 1 || a > count || b > count) return { pages: [], error: `Pages must be between 1 and ${count}` };
        if (a > b) { const t = a; a = b; b = t; }
        for (let p = a; p <= b; p++) if (!seen.has(p)) { seen.add(p); set.push(p - 1); }
      }
      if (!set.length) return { pages: [], error: 'Enter at least one page' };
      return { pages: set };
    }
    function exportPageList() {
      if (xiState.range === 'current') return { pages: [S.current] };
      if (xiState.range === 'all') return { pages: null };       // null → all pages
      return parseCustomPages(xiState.custom);
    }
    function updateExportPreview(body) {
      const prev = body.querySelector('.ms-xi-preview');
      if (!prev) return;
      const { pages, error } = exportPageList();
      if (error) { prev.textContent = error; prev.classList.add('warn'); return; }
      if (!xiState.dir) { prev.textContent = 'Choose a folder to export into.'; prev.classList.add('warn'); return; }
      prev.classList.remove('warn');
      const n = pages === null ? count : pages.length;
      const ext = xiState.fmt === 'jpg' ? 'JPG' : 'PNG';
      prev.textContent = `${n} ${ext} image${n === 1 ? '' : 's'} · ${xiState.dpi} dpi → ${xiState.dir}`;
    }
    async function chooseExportDir() {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.browse_folder) { YR.toast('Choosing a folder needs the desktop app', '', 2400); return; }
      let d = null;
      try { d = await api.browse_folder(); } catch (_) { d = null; }
      if (!d) return;
      xiState.dir = d;
      const body = xiBody(); if (body) renderImagesTab(body);
    }
    async function doExportImages(btn) {
      const { pages, error } = exportPageList();
      if (error) { YR.toast(error, '', 2400); return; }
      if (!xiState.dir) { YR.toast('Choose a folder to export into', '', 2200); return; }
      const stem = (xiState.stem || '').trim() || undefined;
      const payload = { path, dir: xiState.dir, format: xiState.fmt, dpi: xiState.dpi, stem };
      if (pages !== null) payload.pages = pages;        // omit → backend exports all pages
      btn.disabled = true;
      try {
        const res = await YR.postJSON('/api/pdf/export-images', payload);
        YR.toast(`Exported ${res.count} image${res.count === 1 ? '' : 's'} → ${xiState.dir}`, 'success', 3200);
        closeExportHub();
      } catch (e) {
        YR.toast('Export failed: ' + (e.message || 'unknown'), 'error', 3400);
      } finally {
        btn.disabled = false;
      }
    }

    // ── compress tab (P10b) ──────────────────────────────────────────────────
    // Writes a smaller COPY via /api/pdf/compress. The destination is chosen with
    // the native save dialog; the open PDF is never modified.
    function renderCompressTab(body) {
      body.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = 'ms-hint';
      hint.textContent = 'Write a smaller, optimized copy of this PDF. Your original file is never changed — you choose where the new copy is saved.';
      body.appendChild(hint);

      // squeeze level
      const lvlF = document.createElement('div'); lvlF.className = 'ms-field';
      lvlF.innerHTML = '<label class="ms-label">How hard to squeeze</label>';
      const seg = document.createElement('div'); seg.className = 'ms-seg';
      XC_LEVELS.forEach(([id, lbl]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ms-seg-btn' + (xcState.level === id ? ' active' : '');
        b.textContent = lbl;
        b.addEventListener('click', () => { xcState.level = id; renderCompressTab(body); });
        seg.appendChild(b);
      });
      lvlF.appendChild(seg); body.appendChild(lvlF);

      // live description of the chosen level
      const desc = document.createElement('div'); desc.className = 'ms-hint';
      const meta = XC_LEVELS.find(l => l[0] === xcState.level) || XC_LEVELS[1];
      desc.textContent = meta[2];
      body.appendChild(desc);

      const acts = document.createElement('div'); acts.className = 'ms-acts';
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'ms-act primary'; go.textContent = '🗜 Compress → save…';
      go.addEventListener('click', () => doCompress(go));
      acts.appendChild(go); body.appendChild(acts);

      const sum = document.createElement('div'); sum.className = 'ms-sum';
      sum.textContent = 'Tip: image-heavy scans shrink the most. Text-only PDFs are usually already small, so the savings may be modest.';
      body.appendChild(sum);
    }
    function _fmtBytes(n) {
      if (!n || n < 0) return '0 KB';
      if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
      return Math.max(1, Math.round(n / 1024)) + ' KB';
    }
    async function doCompress(btn) {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.save_file) { YR.toast('Saving needs the desktop app', '', 2400); return; }
      const { dir, base } = splitPath(path);
      let target = null;
      try {
        target = await api.save_file(`${base || 'document'} (compressed).pdf`, dir,
          ['PDF document (*.pdf)', 'All files (*.*)']);
      } catch (_) { target = null; }
      if (!target) return;                    // user cancelled
      btn.disabled = true;
      try {
        const res = await YR.postJSON('/api/pdf/compress', { path, target, level: xcState.level });
        if (res.saved > 0) {
          YR.toast(`Compressed ${res.saved_pct}% smaller · ${_fmtBytes(res.before)} → ${_fmtBytes(res.after)} · ${res.name}`, 'success', 3800);
        } else {
          YR.toast(`Saved ${res.name} — this PDF was already well optimized, so the copy isn’t smaller.`, '', 4200);
        }
        closeExportHub();
      } catch (e) {
        YR.toast('Compress failed: ' + (e.message || 'unknown'), 'error', 3600);
      } finally {
        btn.disabled = false;
      }
    }

    // ── OCR tab (P11b) ───────────────────────────────────────────────────────
    // Writes a *searchable* COPY via /api/pdf/ocr: each selected page is rendered
    // and run through Tesseract, which lays an invisible text layer behind the
    // image. Gated on /api/ocr-status so we never offer OCR the engine can't do.
    async function renderOcrTab(body) {
      body.innerHTML = '';
      const hint = document.createElement('div');
      hint.className = 'ms-hint';
      hint.textContent = 'Make a scanned PDF searchable. Each selected page is read by the free Tesseract engine, which lays an invisible text layer behind the image — so you can select, copy and find its words. Your original PDF is never changed.';
      body.appendChild(hint);

      // availability gate: fetch /api/ocr-status once, cache it, then re-render
      if (!ocState.status) {
        const checking = document.createElement('div');
        checking.className = 'ms-hint';
        checking.textContent = 'Checking the OCR engine…';
        body.appendChild(checking);
        let st;
        try { st = await YR.getJSON('/api/ocr-status'); }
        catch (_) { st = { available: false }; }
        ocState.status = st;
        // only repaint if the user is still looking at this OCR tab
        const active = xiOverlay && xiOverlay.querySelector('.sign-tab.active');
        if (xiBody() === body && active && active.dataset.t === 'ocr') renderOcrTab(body);
        return;
      }

      const status = ocState.status;
      if (!status.available) {
        const warn = document.createElement('div');
        warn.className = 'ms-sum warn';
        warn.innerHTML = 'OCR needs the free <b>Tesseract</b> engine, which isn’t installed on this computer. Install Tesseract OCR (plus any language packs you need), then reopen this panel.';
        body.appendChild(warn);
        return;
      }

      // language — drop 'osd' (orientation/script detection, not a real language)
      const langs = (status.langs || []).filter(l => l && l !== 'osd');
      if (!langs.length) langs.push('eng');
      if (!langs.includes(ocState.lang)) ocState.lang = langs.includes('eng') ? 'eng' : langs[0];
      const langF = document.createElement('div'); langF.className = 'ms-field';
      langF.innerHTML = '<label class="ms-label">Language</label>';
      const sel = document.createElement('select'); sel.className = 'ms-input';
      langs.forEach(code => {
        const o = document.createElement('option');
        o.value = code; o.textContent = ocrLangLabel(code);
        if (code === ocState.lang) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => { ocState.lang = sel.value; });
      langF.appendChild(sel); body.appendChild(langF);

      // which pages
      const rangeF = document.createElement('div'); rangeF.className = 'ms-field';
      rangeF.innerHTML = '<label class="ms-label">Which pages</label>';
      const rseg = document.createElement('div'); rseg.className = 'ms-seg';
      [['current', 'This page'], ['all', 'All pages'], ['custom', 'Custom…']].forEach(([m, lbl]) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'ms-seg-btn' + (ocState.scope === m ? ' active' : '');
        b.textContent = lbl;
        b.addEventListener('click', () => { ocState.scope = m; renderOcrTab(body); });
        rseg.appendChild(b);
      });
      rangeF.appendChild(rseg); body.appendChild(rangeF);

      if (ocState.scope === 'custom') {
        const f = document.createElement('div'); f.className = 'ms-field';
        f.innerHTML = `<label class="ms-label">Pages (1–${count})</label>`;
        const inp = document.createElement('input');
        inp.type = 'text'; inp.placeholder = 'e.g. 1-3, 5, 8-10';
        inp.value = ocState.custom || ''; inp.className = 'ms-input';
        inp.addEventListener('input', () => { ocState.custom = inp.value; });
        f.appendChild(inp); body.appendChild(f);
      }

      // skip-text toggle
      const skip = document.createElement('label'); skip.className = 'ms-check';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = ocState.skipText;
      cb.addEventListener('change', () => { ocState.skipText = cb.checked; });
      const cbTxt = document.createElement('span');
      cbTxt.textContent = 'Skip pages that already have selectable text (recommended)';
      skip.appendChild(cb); skip.appendChild(cbTxt);
      body.appendChild(skip);

      const note = document.createElement('div'); note.className = 'ms-hint';
      note.textContent = 'OCR runs entirely on your computer and can take a few seconds per page — larger scans take longer.';
      body.appendChild(note);

      const acts = document.createElement('div'); acts.className = 'ms-acts';
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'ms-act primary'; go.textContent = '🔎 Make searchable → save…';
      go.addEventListener('click', () => doOcr(go));
      acts.appendChild(go); body.appendChild(acts);
    }
    function ocrPageList() {
      if (ocState.scope === 'current') return { pages: [S.current] };
      if (ocState.scope === 'all') return { pages: null };       // null → all pages
      return parseCustomPages(ocState.custom);
    }
    async function doOcr(btn) {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.save_file) { YR.toast('Saving needs the desktop app', '', 2400); return; }
      const { pages, error } = ocrPageList();
      if (error) { YR.toast(error, '', 2400); return; }
      const { dir, base } = splitPath(path);
      let target = null;
      try {
        target = await api.save_file(`${base || 'document'} (searchable).pdf`, dir,
          ['PDF document (*.pdf)', 'All files (*.*)']);
      } catch (_) { target = null; }
      if (!target) return;                    // user cancelled
      const payload = { path, target, language: ocState.lang, skip_text: ocState.skipText };
      if (pages !== null) payload.pages = pages;     // omit → OCR all pages
      const label = btn.textContent;
      btn.disabled = true; btn.textContent = '🔎 Working… recognising text';
      try {
        const res = await YR.postJSON('/api/pdf/ocr', payload);
        if (res.ocr_pages > 0) {
          YR.toast(`Made searchable · ${res.ocr_pages} of ${res.pages} page${res.pages === 1 ? '' : 's'} read · ${res.name}`, 'success', 3800);
        } else {
          YR.toast(`Saved ${res.name} — every selected page already had selectable text, so nothing needed OCR.`, '', 4400);
        }
        closeExportHub();
      } catch (e) {
        YR.toast('OCR failed: ' + (e.message || 'unknown'), 'error', 3800);
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    }

    YR.sidebar.available(true);
    mountSidebar();

    // ── go ────────────────────────────────────────────────────────────────
    buildPages();
    const startPage = (typeof doc.position === 'number') ? doc.position : 0;
    if (startPage > 0) setTimeout(() => gotoPage(startPage, false), 60);
    else updateIndicator();

    S._resize = () => rerender();
    window.addEventListener('resize', S._resize);
    S._onKey = onKey;
    window.addEventListener('keydown', onKey);
    S._stopTts = stopRead;   // cancel any read-aloud when the document is closed

    // selection bubble (v2-1c): debounce the mouseup a touch so the browser has
    // settled the selection; dismiss on an outside click or a stage scroll (the
    // bubble is position:fixed and would otherwise drift away from its words).
    const selMouseUp = e => setTimeout(() => onSelMouseUp(e), 10);
    const stage = YR.root.parentElement;
    scroll.addEventListener('mouseup', selMouseUp);
    document.addEventListener('mousedown', selPopOutside);
    if (stage) stage.addEventListener('scroll', closeSelPop, { passive: true });
    S._selTeardown = () => {
      closeSelPop();
      scroll.removeEventListener('mouseup', selMouseUp);
      document.removeEventListener('mousedown', selPopOutside);
      if (stage) stage.removeEventListener('scroll', closeSelPop);
    };

    mount._S = S;
  }

  function unmount() {
    const S = mount._S;
    if (S) {
      if (S.observer) S.observer.disconnect();
      if (S.currentObs) S.currentObs.disconnect();
      if (S.thumbObs) S.thumbObs.disconnect();
      if (S._resize) window.removeEventListener('resize', S._resize);
      if (S._onKey) window.removeEventListener('keydown', S._onKey);
      if (S._selTeardown) S._selTeardown();
      if (S._stopTts) S._stopTts();
    }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (_) { /* belt & braces */ }
    mount._S = null;
  }

  YR.registerReader('pdf', { mount, unmount });
})();
