/* YancoRead — Comic reader v3 + tool profile (cbz/cbr/cb7/cbt)
   Modes: single / two-page spread / webtoon (vertical scroll).
   Guided View (panel-by-panel, smooth zoom/pan), manual zoom & pan, rotate,
   reading-direction (Auto/LTR/RTL with per-file memory + OCR detection),
   background color, auto-advance, page slider + thumbnails, full keyboard. */
(function () {
  'use strict';

  const elc = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  function mount(doc) {
    const path = doc.path;
    const count = doc.meta.page_count || 0;
    const gp = Object.assign({ mode: 'single', fit: 'height', guided: false, bg: 'black', autoSec: 6, enhance: false,
                              imgBright: 100, imgContrast: 100, imgGray: false, imgInvert: false }, doc.prefs || {});
    const fileDir = (doc.file_prefs && doc.file_prefs.dir) || 'auto';

    // Resume where you left off — but if you'd finished (on/after the last page),
    // start at the beginning rather than reopening on the final page.
    let startIndex = (typeof doc.position === 'number') ? doc.position : 0;
    if (startIndex >= count - 1) startIndex = 0;
    startIndex = Math.max(0, Math.min(startIndex, Math.max(count - 1, 0)));

    const S = {
      index: startIndex,
      mode: gp.mode, guided: !!gp.guided, fit: gp.fit, bg: gp.bg,
      dirMode: fileDir, detected: 'unknown', rtl: fileDir === 'rtl',
      rotate: 0, zoom: 1, panels: [], panel: 0, panelsReady: false,
      natW: 0, natH: 0, panelCache: {},
      enhance: !!gp.enhance, translate: false, reading: false,
      img: { bright: gp.imgBright, contrast: gp.imgContrast, gray: !!gp.imgGray, invert: !!gp.imgInvert },
      auto: { on: false, sec: gp.autoSec || 6, timer: null },
      numBuf: '', numTimer: null, helpOpen: false, popOpen: false, wantLast: false,
      thumbObs: null, lazyObs: null, drag: null, series: null, touch: null,
    };

    const pageURL = (i, enh) => `/api/comic-page?path=${encodeURIComponent(path)}&index=${i}`
      + ((enh === undefined ? S.enhance : enh) ? '&enhance=1' : '');
    const clamp = (i) => Math.max(0, Math.min(i, count - 1));
    const stepN = () => (S.mode === 'spread' ? 2 : 1);
    const resolveRtl = () => S.dirMode === 'rtl' ? true : S.dirMode === 'ltr' ? false : S.detected === 'rtl';

    // ── DOM ───────────────────────────────────────────────────────────────
    const root = YR.root; root.innerHTML = '';
    const reader = elc('div', 'comic-reader');
    const stage = elc('div', 'comic-stage');
    const pan = elc('div', 'comic-pan');
    const prevZone = elc('div', 'comic-nav-zone prev');
    const nextZone = elc('div', 'comic-nav-zone next');
    stage.append(pan, prevZone, nextZone);
    const bottom = elc('div', 'comic-bottombar');
    const slider = elc('input', 'comic-slider');
    slider.type = 'range'; slider.min = '1'; slider.max = String(Math.max(count, 1)); slider.value = String(S.index + 1);
    const pagelabel = elc('span', 'comic-pagelabel');
    const panelInd = elc('span', 'panel-indicator'); panelInd.classList.add('hidden');
    bottom.append(panelInd, slider, pagelabel);
    reader.append(stage, bottom); root.appendChild(reader);

    prevZone.addEventListener('click', () => (S.rtl ? next() : prev()));
    nextZone.addEventListener('click', () => (S.rtl ? prev() : next()));
    slider.addEventListener('input', () => { pagelabel.textContent = slider.value + ' / ' + count; });
    slider.addEventListener('change', () => goPage(parseInt(slider.value, 10) - 1, 0));

    function applyBg() { stage.classList.remove('bg-black', 'bg-gray', 'bg-white'); stage.classList.add('bg-' + S.bg); }

    // Display-only image adjustments — a CSS filter on .comic-page via a custom
    // property on the reader, so every page (incl. lazily-loaded webtoon images)
    // picks it up without re-fetching bytes. Night mode = colour invert.
    function applyImageFilter() {
      const im = S.img; let f = '';
      if (im.bright !== 100) f += ` brightness(${im.bright}%)`;
      if (im.contrast !== 100) f += ` contrast(${im.contrast}%)`;
      if (im.gray) f += ' grayscale(1)';
      if (im.invert) f += ' invert(1)';
      reader.style.setProperty('--comic-filter', f.trim() || 'none');
    }
    function setImg(patch, prefs) { Object.assign(S.img, patch); applyImageFilter(); YR.savePrefs('comic', prefs); }

    function updateChrome() {
      slider.value = String(S.index + 1);
      // In RTL the scrubber is mirrored so page 1 sits on the right (manga convention).
      slider.classList.toggle('rtl', S.rtl && S.mode !== 'webtoon');
      pagelabel.textContent = (S.index + 1) + ' / ' + count;
      if (pageInput) pageInput.value = String(S.index + 1);
      const show = S.guided && S.mode === 'single' && S.panels.length > 0;
      panelInd.classList.toggle('hidden', !show);
      if (show) panelInd.textContent = `▣ ${S.panel + 1} / ${S.panels.length}`;
      highlightThumb();
    }

    // ── render dispatch ───────────────────────────────────────────────────────
    function renderCurrent(dir) {
      prevZone.style.display = nextZone.style.display = (S.mode === 'webtoon') ? 'none' : '';
      if (S.mode === 'webtoon') renderWebtoon();
      else if (S.mode === 'spread') renderPaged(dir, true);
      else renderPaged(dir, false);
      YR.savePosition(S.index, count ? (S.index + 1) / count : 0);
    }

    // ── single / spread ───────────────────────────────────────────────────────
    function renderPaged(dir, spread) {
      if (S.lazyObs) { S.lazyObs.disconnect(); S.lazyObs = null; }
      pan.innerHTML = '';
      const guided = S.guided && !spread;
      stage.className = 'comic-stage bg-' + S.bg
        + (guided ? ' guided' : ' ' + (S.fit === 'width' ? 'fit-width' : 'fit-height'))
        + (S.rtl ? ' rtl' : '')
        + (!guided && S.zoom > 1 ? ' pannable' : '');

      const idxs = [S.index];
      if (spread && S.index + 1 < count) idxs.push(S.index + 1);
      const useHolder = !guided && !spread;   // single page → wrap for translation overlay
      let first = null, holder = null;
      idxs.forEach((i, k) => {
        const im = elc('img', 'comic-page'); im.src = pageURL(i); im.alt = 'Page ' + (i + 1);
        im.draggable = false;
        if (k === 0) first = im;
        if (useHolder) { holder = elc('div', 'cpage-holder'); holder.appendChild(im); pan.appendChild(holder); }
        else pan.appendChild(im);
      });
      S._holder = holder;   // single-page holder for translation / read-aloud overlays
      updateChrome(); preload();

      if (guided) {
        S.panels = []; S.panelsReady = false; panelInd.classList.add('hidden');
        const onload = () => {
          S.natW = first.naturalWidth; S.natH = first.naturalHeight;
          first.style.width = S.natW + 'px'; first.style.height = S.natH + 'px';
          fetchPanels(S.index).then(panels => {
            S.panels = panels;
            S.panel = (S.wantLast && panels.length) ? panels.length - 1 : 0;
            S.wantLast = false; S.panelsReady = true;
            applyPanel(false); updateChrome();
          });
        };
        if (first.complete && first.naturalWidth) onload(); else first.onload = onload;
      } else {
        // page-turn motion
        pan.style.transition = 'none';
        pan.style.transform = `translateX(${(dir || 0) * 42}px)`;
        pan.classList.add('turning');
        void pan.offsetWidth; pan.style.transition = '';
        requestAnimationFrame(() => { pan.classList.remove('turning'); pan.style.transform = 'translateX(0)'; });
        const ready = () => { layoutPaged(first); if (S.translate && useHolder && holder) mountTransOverlay(holder); };
        if (first.complete && first.naturalWidth) ready();
        else first.onload = ready;
      }
    }

    // ── translation overlay (single-page) ─────────────────────────────────────
    function setTranslate(on) {
      S.translate = on;
      if (on) { S.guided = false; S.mode = 'single'; }   // overlay needs single-page view
      buildTools(); renderCurrent(0);
    }
    async function mountTransOverlay(holder) {
      let ov = holder.querySelector('.trans-overlay');
      if (ov) ov.remove();
      ov = elc('div', 'trans-overlay', '<div class="trans-loading">Translating…</div>');
      holder.appendChild(ov);
      const forIndex = S.index;
      try {
        const r = await YR.getJSON(`/api/comic-translate?path=${encodeURIComponent(path)}&index=${forIndex}&rtl=${S.rtl}`);
        if (!S.translate || S.index !== forIndex || !holder.isConnected) { ov.remove(); return; }
        const blocks = r.blocks || [];
        ov.innerHTML = '';
        if (!blocks.length) {
          ov.innerHTML = `<div class="trans-loading">${YR.escapeHtml(r.note || 'No text detected')}</div>`;
          setTimeout(() => { if (ov.isConnected) ov.remove(); }, 2200);
          return;
        }
        blocks.forEach(b => {
          const box = elc('div', 'trans-box');
          box.style.left = (b.box.x * 100) + '%'; box.style.top = (b.box.y * 100) + '%';
          box.style.width = (b.box.w * 100) + '%'; box.style.height = (b.box.h * 100) + '%';
          box.textContent = b.translated || b.text;
          box.title = b.text;
          ov.appendChild(box);
        });
      } catch (e) {
        ov.innerHTML = `<div class="trans-loading err">${YR.escapeHtml(e.message || 'Translation failed')}</div>`;
        setTimeout(() => { if (ov.isConnected) ov.remove(); }, 2800);
      }
    }

    function layoutPaged(img) {
      if (!img || S.guided) return;
      S.natW = img.naturalWidth || S.natW; S.natH = img.naturalHeight || S.natH;
      if (!S.natW) return;
      const rot = ((S.rotate % 360) + 360) % 360;
      img.style.transform = rot ? `rotate(${rot}deg)` : '';
      img.style.transformOrigin = 'center center';
      // manual zoom: scale the page up; the scrollable stage provides panning
      if (S.zoom > 1 && S.mode === 'single') {
        const swapped = rot === 90 || rot === 270;
        const cW = swapped ? S.natH : S.natW, cH = swapped ? S.natW : S.natH;
        const base = S.fit === 'width' ? stage.clientWidth / cW : stage.clientHeight / cH;
        const eff = base * S.zoom;
        img.style.width = (S.natW * eff) + 'px';
        img.style.height = (S.natH * eff) + 'px';
        img.style.maxWidth = 'none'; img.style.maxHeight = 'none';
      } else {
        img.style.width = ''; img.style.height = ''; img.style.maxWidth = ''; img.style.maxHeight = '';
      }
    }

    function panelTransform(mul) {
      const W = stage.clientWidth, H = stage.clientHeight;
      let s, cx, cy;
      if (!S.panels.length) {
        s = Math.min(W / S.natW, H / S.natH); cx = S.natW / 2; cy = S.natH / 2;
      } else {
        const b = S.panels[S.panel], pad = 0.06;
        const rw = b.w * S.natW, rh = b.h * S.natH, rx = b.x * S.natW, ry = b.y * S.natH;
        s = Math.max(0.2, Math.min(Math.min(W / (rw * (1 + pad * 2)), H / (rh * (1 + pad * 2))), 5));
        cx = rx + rw / 2; cy = ry + rh / 2;
      }
      s *= (mul || 1);
      return `translate(${W / 2 - cx * s}px,${H / 2 - cy * s}px) scale(${s})`;
    }
    function applyPanel(animate, mul) {
      pan.style.transition = animate ? '' : 'none';
      pan.style.transform = panelTransform(mul);
      if (!animate) { void pan.offsetWidth; pan.style.transition = ''; }
    }

    // ── webtoon (vertical continuous) ───────────────────────────────────────────
    function renderWebtoon() {
      pan.innerHTML = '';
      stage.className = 'comic-stage webtoon pannable bg-' + S.bg;
      const strip = elc('div', 'webtoon-strip');
      for (let i = 0; i < count; i++) {
        const im = elc('img', 'comic-page'); im.dataset.src = pageURL(i); im.dataset.index = i;
        im.alt = 'Page ' + (i + 1); im.draggable = false; strip.appendChild(im);
      }
      pan.appendChild(strip);
      if (S.lazyObs) S.lazyObs.disconnect();
      S.lazyObs = new IntersectionObserver((ents) => {
        for (const e of ents) {
          const im = e.target;
          if (e.isIntersecting && !im.src) im.src = im.dataset.src;
          if (e.isIntersecting && e.intersectionRatio > 0.5) {
            S.index = parseInt(im.dataset.index, 10); updateChrome();
            YR.savePosition(S.index, count ? (S.index + 1) / count : 0);
          }
        }
      }, { root: stage, rootMargin: '800px', threshold: [0, 0.5] });
      strip.querySelectorAll('img').forEach(im => S.lazyObs.observe(im));
      // jump to current page
      requestAnimationFrame(() => {
        const target = strip.querySelector(`img[data-index="${S.index}"]`);
        if (target) target.scrollIntoView({ block: 'start' });
      });
      updateChrome();
    }

    async function fetchPanels(i) {
      if (S.panelCache[i]) return S.panelCache[i];
      try {
        const r = await YR.getJSON(`/api/comic-panels?path=${encodeURIComponent(path)}&index=${i}&rtl=${S.rtl}`);
        S.panelCache[i] = r.panels || [];
      } catch (e) { S.panelCache[i] = []; }
      return S.panelCache[i];
    }
    function preload() {
      [S.index - 1, S.index + 1].forEach(i => { if (i >= 0 && i < count) { const im = new Image(); im.src = pageURL(i); } });
      if (S.guided && S.index + 1 < count) fetchPanels(S.index + 1);
    }

    // ── navigation ──────────────────────────────────────────────────────────
    function next() {
      if (S.mode === 'webtoon') {
        if (atEnd()) { endOfIssue(); return; }
        hideEndCard(); stage.scrollBy({ top: stage.clientHeight * 0.9, behavior: 'smooth' }); return;
      }
      if (S.guided && S.mode === 'single') {
        if (!S.panelsReady) return;
        if (S.panels.length && S.panel < S.panels.length - 1) { S.panel++; applyPanel(true); updateChrome(); return; }
        if (S.index < count - 1) { goPage(S.index + 1, 1); return; }
        endOfIssue(); return;
      }
      if (S.index + stepN() < count) goPage(S.index + stepN(), 1);
      else if (S.mode === 'spread' && S.index < count - 1) goPage(count - 1, 1);
      else endOfIssue();
    }
    function prev() {
      hideEndCard();
      if (S.mode === 'webtoon') { stage.scrollBy({ top: -stage.clientHeight * 0.9, behavior: 'smooth' }); return; }
      if (S.guided && S.mode === 'single') {
        if (!S.panelsReady) return;
        if (S.panels.length && S.panel > 0) { S.panel--; applyPanel(true); updateChrome(); return; }
        if (S.index > 0) { S.wantLast = true; goPage(S.index - 1, -1); }
        return;
      }
      if (S.index - stepN() >= 0) goPage(S.index - stepN(), -1);
      else if (S.index > 0) goPage(0, -1);
    }
    function goPage(i, dir) {
      i = clamp(i);
      hideEndCard();
      if (S.mode === 'webtoon') {
        S.index = i;
        const t = pan.querySelector(`img[data-index="${i}"]`);
        if (t) t.scrollIntoView({ block: 'start', behavior: 'smooth' });
        updateChrome(); return;
      }
      S.index = i; S.panel = 0; S.zoom = 1; renderCurrent(dir);
    }

    // ── series auto-continue (sibling issues in the same folder) ───────────────
    // Functions below are hoisted, so next()/goPage() above can call them safely.
    function openSibling(p) { if (p) { hideEndCard(); YR.openFile(p); } }
    function gotoIssue(delta) {
      if (!S.series) return;
      const t = S.series.index + delta;
      if (t < 0 || t >= S.series.files.length) {
        YR.toast(delta > 0 ? 'Last issue in this folder' : 'First issue in this folder', '', 1800);
        return;
      }
      openSibling(S.series.files[t].path);
    }
    function atEnd() {
      if (S.mode === 'webtoon') return stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 4;
      if (S.guided && S.mode === 'single') return S.index >= count - 1 && (!S.panels.length || S.panel >= S.panels.length - 1);
      return S.index >= count - 1;
    }
    function endOfIssue() { showEndCard(); }
    // Anchored to .comic-reader (not the stage) so it stays centred in the
    // visible area even in webtoon mode, where the stage is scrolled to its end.
    function hideEndCard() { const c = reader.querySelector('.comic-endcard'); if (c) c.remove(); }
    function showEndCard() {
      if (reader.querySelector('.comic-endcard')) return;
      const nextPath = S.series && S.series.next;
      const nextName = nextPath ? S.series.files[S.series.index + 1].name : '';
      const title = (S.series && S.series.files[S.series.index] && S.series.files[S.series.index].name) || doc.name || '';
      const c = elc('div', 'comic-endcard');
      c.innerHTML = `<div class="card">
          <div class="eyebrow">Finished</div>
          <div class="title">${YR.escapeHtml(title)}</div>
          ${nextPath
            ? `<button class="tb-btn primary" data-next>▶ Next issue<small>${YR.escapeHtml(nextName)}</small></button>`
            : (S.series ? '<div class="last">Last issue in this folder.</div>' : '')}
          <div class="endrow">
            <button class="tb-btn" data-stay>Keep reading</button>
            <button class="tb-btn" data-home>Library</button>
          </div>
        </div>`;
      c.addEventListener('click', (e) => { if (e.target === c) hideEndCard(); });
      const nb = c.querySelector('[data-next]');
      if (nb) nb.addEventListener('click', () => openSibling(nextPath));
      c.querySelector('[data-stay]').addEventListener('click', hideEndCard);
      c.querySelector('[data-home]').addEventListener('click', () => YR.goHome());
      reader.appendChild(c);
    }
    // Discover sibling issues in the background; the end card and Options ▸ Series
    // light up once this resolves (count > 1 means it's part of a series folder).
    (async () => {
      try {
        const r = await YR.getJSON(`/api/comic-siblings?path=${encodeURIComponent(path)}`);
        if (r && r.count > 1 && r.index >= 0) { S.series = r; if (S.popOpen) buildPopover(); }
      } catch (e) { /* solo file — no series controls */ }
    })();

    // ── manual zoom + drag pan (single, non-guided) ────────────────────────────
    function canZoom() { return S.mode === 'single' && !S.guided; }
    function setZoom(z) {
      if (!canZoom()) return;
      S.zoom = Math.max(1, Math.min(z, 5));
      const img = pan.querySelector('.comic-page');
      stage.classList.toggle('pannable', S.zoom > 1);
      layoutPaged(img);
    }
    stage.addEventListener('wheel', (e) => {
      if (!canZoom() || !(e.ctrlKey || e.metaKey || S.zoom > 1)) return;
      e.preventDefault();
      setZoom(S.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    }, { passive: false });
    stage.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (!stage.classList.contains('pannable') && S.mode !== 'webtoon') return;
      e.preventDefault();  // stop native image/text drag while panning
      S.drag = { x: e.clientX, y: e.clientY, l: stage.scrollLeft, t: stage.scrollTop };
      stage.classList.add('panning');
    });
    function onDrag(e) {
      if (!S.drag) return;
      stage.scrollLeft = S.drag.l - (e.clientX - S.drag.x);
      stage.scrollTop = S.drag.t - (e.clientY - S.drag.y);
    }
    function endDrag() { if (S.drag) { S.drag = null; stage.classList.remove('panning'); } }
    S._onDrag = onDrag; S._endDrag = endDrag;
    window.addEventListener('mousemove', onDrag);
    window.addEventListener('mouseup', endDrag);

    // ── touch gestures (swipe-turn · pinch-zoom · drag-pan · double-tap) ────────
    // Listeners live on the stage element, so they're discarded with it on unmount.
    // They coexist with the edge tap-zones (mouse clicks) and webtoon's native
    // scroll. Double-tap-to-zoom is limited to the centre band between the 32%
    // tap-zones, so it never fights tap-to-turn (a lone centre tap is a no-op).
    const T = { TAP: 12, SWIPE: 45, OFFAXIS: 70, DTAP_MS: 300, ZOOM_TO: 2.4 };
    let lastTap = 0;
    const touchDist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    function zoomToPoint(clientX, clientY, z) {
      if (!canZoom()) return;
      const r = stage.getBoundingClientRect();
      const ox = clientX - r.left, oy = clientY - r.top;
      const px = stage.scrollLeft + ox, py = stage.scrollTop + oy;
      const target = Math.max(1, Math.min(z, 5)), ratio = target / S.zoom;
      if (ratio === 1) return;
      setZoom(target);                              // re-layouts the page at the new size
      stage.scrollLeft = px * ratio - ox;           // keep the touched point under the finger
      stage.scrollTop = py * ratio - oy;
    }
    function inCenterBand(clientX) {
      const r = stage.getBoundingClientRect();
      const f = (clientX - r.left) / r.width;
      return f > 0.33 && f < 0.67;                  // gap between the edge tap-zones
    }
    stage.addEventListener('touchstart', (e) => {
      if (S.mode === 'webtoon') return;             // leave native vertical scroll alone
      if (e.touches.length === 2) {
        if (!canZoom()) return;
        S.touch = { kind: 'pinch', d0: touchDist(e.touches[0], e.touches[1]), z0: S.zoom };
        e.preventDefault(); return;
      }
      if (e.touches.length === 1) {
        const t = e.touches[0];
        S.touch = { kind: 'tap', x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY,
                    panL: stage.scrollLeft, panT: stage.scrollTop,
                    pannable: stage.classList.contains('pannable') };
      }
    }, { passive: false });
    stage.addEventListener('touchmove', (e) => {
      const tc = S.touch; if (!tc) return;
      if (tc.kind === 'pinch') {
        if (e.touches.length < 2) return;
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        zoomToPoint(mx, my, tc.z0 * (touchDist(e.touches[0], e.touches[1]) / tc.d0));
        e.preventDefault(); return;
      }
      if (e.touches.length !== 1) return;
      const t = e.touches[0]; tc.x = t.clientX; tc.y = t.clientY;
      const dx = t.clientX - tc.x0, dy = t.clientY - tc.y0;
      if (tc.pannable) {                            // one finger pans a zoomed page
        tc.kind = 'pan';
        stage.scrollLeft = tc.panL - dx; stage.scrollTop = tc.panT - dy;
        e.preventDefault(); return;
      }
      if (tc.kind === 'tap' && Math.abs(dx) > T.TAP && Math.abs(dx) > Math.abs(dy)) tc.kind = 'swipe';
      if (tc.kind === 'swipe') e.preventDefault();   // claim the horizontal swipe
    }, { passive: false });
    stage.addEventListener('touchend', (e) => {
      const tc = S.touch; if (!tc) return;
      S.touch = null;
      if (tc.kind === 'pinch' || tc.kind === 'pan') return;
      const dx = tc.x - tc.x0, dy = tc.y - tc.y0, adx = Math.abs(dx), ady = Math.abs(dy);
      if (tc.kind === 'swipe' || (adx > T.SWIPE && ady < T.OFFAXIS && adx > ady)) {
        (dx < 0 ? (S.rtl ? prev : next) : (S.rtl ? next : prev))();   // swipe-left = forward (LTR)
        e.preventDefault(); return;
      }
      if (adx < T.TAP && ady < T.TAP) {              // a genuine tap (not a drag)
        const now = Date.now();
        if (inCenterBand(tc.x) && canZoom()) {
          if (now - lastTap < T.DTAP_MS) {           // second centre tap → toggle zoom
            lastTap = 0;
            if (S.zoom > 1) setZoom(1); else zoomToPoint(tc.x, tc.y, T.ZOOM_TO);
            e.preventDefault(); return;              // swallow → no page turn
          }
          lastTap = now;
        } else {
          lastTap = 0;                               // edge tap turns via its native click
        }
      }
    }, { passive: false });

    // ── direction ─────────────────────────────────────────────────────────────
    function setDirMode(m) {
      S.dirMode = m; const newRtl = resolveRtl();
      YR.postJSON('/api/file-prefs', { path, prefs: { dir: m } }).catch(() => {});
      if (newRtl !== S.rtl) { S.rtl = newRtl; S.panelCache = {}; }
      buildTools(); renderCurrent(0); if (S.popOpen) buildPopover();
    }
    (async () => {
      try {
        const info = await YR.getJSON(`/api/comic-info?path=${encodeURIComponent(path)}`);
        S.detected = info.direction || 'unknown'; S.ocrAvail = info.ocr_available;
        if (S.dirMode === 'auto' && (S.detected === 'rtl' || S.detected === 'ltr')) {
          const nr = S.detected === 'rtl';
          if (nr !== S.rtl) {
            S.rtl = nr; S.panelCache = {}; renderCurrent(0);
            YR.toast('Detected ' + (nr ? 'right-to-left' : 'left-to-right') + ' reading', '', 2600);
          }
          buildTools();
        }
        if (S.popOpen) buildPopover();
      } catch (e) { /* ignore */ }
    })();

    // ── auto-advance ────────────────────────────────────────────────────────────
    function clearAuto() {
      clearInterval(S.auto.timer); clearTimeout(S.auto.timer);
      clearTimeout(S.auto.timer2); clearInterval(S.auto.timer2);
    }
    function toggleAuto(on) {
      S.auto.on = on; clearAuto();
      if (on) {
        if (S.mode === 'webtoon') {
          S.auto.timer = setInterval(() => stage.scrollBy({ top: 80, behavior: 'auto' }), 40);
        } else if (S.guided && S.mode === 'single') {
          motionTick();   // cinematic: drift each panel, then advance
        } else {
          S.auto.timer = setInterval(() => next(), S.auto.sec * 1000);
        }
      } else if (S.guided && S.mode === 'single' && S.natW) {
        applyPanel(false);  // snap back to a clean frame when stopping
      }
      if (S.popOpen) buildPopover();
    }
    // Ken-Burns: slow zoom-in on the current panel, then step to the next.
    function motionTick() {
      if (!S.auto.on) return;
      S.auto.timer2 = setTimeout(() => {
        if (!S.auto.on) return;
        pan.style.transition = `transform ${(S.auto.sec * 0.85).toFixed(2)}s ease-out`;
        pan.style.transform = panelTransform(1.12);
      }, 480);  // start drift after the step transition settles
      S.auto.timer = setTimeout(() => {
        if (!S.auto.on) return;
        next(); motionTick();
      }, S.auto.sec * 1000);
    }

    // ── read-aloud (Web Speech API + balloon highlight) ───────────────────────
    // Voices populate asynchronously: getVoices() is empty until 'voiceschanged'
    // fires (notably on the first call in Chromium/Edge WebView). Warm them up
    // once and cache, so voice selection — and the "no voice installed" warning —
    // aren't a race that fires before the list is ready.
    let _voices = [];
    let _voicesReady = null;
    function loadVoices() {
      if (_voicesReady) return _voicesReady;
      _voicesReady = new Promise(resolve => {
        if (!window.speechSynthesis) { resolve([]); return; }
        const grab = () => {
          const vs = window.speechSynthesis.getVoices() || [];
          if (vs.length) { _voices = vs; return true; }
          return false;
        };
        if (grab()) { resolve(_voices); return; }
        let done = false;
        const finish = () => {
          if (done) return; done = true;
          window.speechSynthesis.removeEventListener('voiceschanged', onChange);
          if (!_voices.length) _voices = window.speechSynthesis.getVoices() || [];
          resolve(_voices);
        };
        const onChange = () => { if (grab()) finish(); };
        window.speechSynthesis.addEventListener('voiceschanged', onChange);
        setTimeout(finish, 1500);  // resolve even if no voices ever arrive
      });
      return _voicesReady;
    }
    function pickVoice(prefix) {
      return _voices.find(v => (v.lang || '').toLowerCase().startsWith(prefix)) || null;
    }
    async function setReadAloud(on) {
      if (on) {
        if (!window.speechSynthesis) { YR.toast('Read-aloud not supported here', 'error'); return; }
        S.guided = false; S.mode = 'single'; S.reading = true;
        buildTools(); renderCurrent(0);
        await loadVoices();
        if (!S.reading) return;  // user toggled off while voices loaded
        if (S.rtl && !pickVoice('ar'))
          YR.toast('No Arabic voice installed — narration may be wrong. Add one in Windows Settings ▸ Time & language ▸ Speech.', '', 6000);
        setTimeout(readCurrentPage, 400);
      } else { stopReading(); buildTools(); }
    }
    function stopReading() {
      S.reading = false;
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      const hl = S._holder && S._holder.querySelector('.read-hl');
      if (hl) hl.remove();
    }
    async function readCurrentPage() {
      if (!S.reading) return;
      let blocks = [];
      try { blocks = (await YR.getJSON(`/api/comic-ocr?path=${encodeURIComponent(path)}&index=${S.index}&rtl=${S.rtl}`)).blocks || []; }
      catch (e) {}
      if (!S.reading) return;
      if (!blocks.length) { advancePageOrStop(); return; }
      speakBlock(blocks, 0);
    }
    function advancePageOrStop() {
      if (S.index < count - 1) { goPage(S.index + 1, 1); setTimeout(() => { if (S.reading) readCurrentPage(); }, 700); }
      else { stopReading(); buildTools(); YR.toast('Finished reading', '', 2000); }
    }
    function highlight(box) {
      if (!S._holder) return;
      let hl = S._holder.querySelector('.read-hl');
      if (!hl) { hl = elc('div', 'read-hl'); S._holder.appendChild(hl); }
      hl.style.left = (box.x * 100) + '%'; hl.style.top = (box.y * 100) + '%';
      hl.style.width = (box.w * 100) + '%'; hl.style.height = (box.h * 100) + '%';
    }
    function speakBlock(blocks, i) {
      if (!S.reading) return;
      if (i >= blocks.length) { advancePageOrStop(); return; }
      const text = (blocks[i].text || '').trim();
      if (text.length < 2) { speakBlock(blocks, i + 1); return; }   // skip empty/noise blocks
      highlight(blocks[i].box);
      const u = new SpeechSynthesisUtterance(text);
      const v = pickVoice(S.rtl ? 'ar' : 'en');
      if (v) u.voice = v;
      u.lang = S.rtl ? 'ar-SA' : 'en-US';
      u.rate = 0.97;
      let advanced = false;
      const nextOne = () => { if (advanced) return; advanced = true; speakBlock(blocks, i + 1); };
      u.onend = nextOne; u.onerror = nextOne;   // guard: never advance twice
      window.speechSynthesis.speak(u);
    }

    // ── toolbar (contextual) ─────────────────────────────────────────────────
    const pageInput = YR.ui.input({ value: String(S.index + 1), width: '46px', onEnter: v => { const n = parseInt(v, 10); if (n) goPage(n - 1, 0); } });
    pageInput.style.textAlign = 'center';

    function modeBtn(label, m, title) {
      return YR.ui.btn({ label, title, active: S.mode === m, onClick: () => setMode(m) });
    }
    function setMode(m) {
      if (m !== 'single') S.guided = false;
      S.mode = m; S.zoom = 1;
      YR.savePrefs('comic', { mode: m, guided: S.guided });
      buildTools(); renderCurrent(0);
    }
    function setFit(f) { S.fit = f; YR.savePrefs('comic', { fit: f }); buildTools(); if (!(S.guided && S.mode === 'single')) renderCurrent(0); }
    function setGuided(on) { S.guided = on; if (on) { S.mode = 'single'; S.zoom = 1; } YR.savePrefs('comic', { guided: on, mode: S.mode }); buildTools(); renderCurrent(0); }

    function dirLabel() {
      if (S.dirMode === 'ltr') return '→ LTR';
      if (S.dirMode === 'rtl') return '← RTL';
      return S.rtl ? '⇄ Auto·RTL' : '⇄ Auto';
    }
    function cycleDir() { const order = ['auto', 'ltr', 'rtl']; setDirMode(order[(order.indexOf(S.dirMode) + 1) % 3]); }

    function buildTools() {
      // LEFT lane — View ▾ groups page-mode, fit, and Guided into one menu.
      // Items are conditional on the active page-mode (Fit only when not
      // webtoon; Guided only when single page).
      const viewMenu = YR.ui.menu({
        icon: YR.glyph('view'), label: 'View',
        title: 'View — page mode, fit, guided',
        items: () => {
          const items = [
            { icon: '▣', label: 'Single page',     active: S.mode === 'single',  run: () => setMode('single') },
            { icon: '▥', label: 'Two-page spread', active: S.mode === 'spread',  hint: 'd', run: () => setMode('spread') },
            { icon: '▤', label: 'Webtoon (vertical)', active: S.mode === 'webtoon', hint: 'v', run: () => setMode('webtoon') },
          ];
          if (S.mode !== 'webtoon') {
            items.push({ separator: true });
            items.push({ icon: '↕', label: 'Fit height', active: S.fit === 'height', hint: 'h', run: () => setFit('height') });
            items.push({ icon: '↔', label: 'Fit width',  active: S.fit === 'width',  hint: 'w', run: () => setFit('width') });
          }
          if (S.mode === 'single') {
            items.push({ separator: true });
            items.push({ icon: '⚐', label: 'Guided View', active: S.guided, hint: 'g', run: () => setGuided(!S.guided) });
          }
          return items;
        },
      });

      // CENTER lane — nav, page input, Reading ▾.
      const readingMenu = YR.ui.menu({
        icon: YR.glyph('reading'), label: 'Reading',
        title: 'Reading tools — direction, translate, read aloud, scan enhance',
        items: () => [
          { icon: '🅰', label: 'Direction: Auto',          active: S.dirMode === 'auto', run: () => setDirMode('auto') },
          { icon: '→', label: 'Direction: Left-to-right', active: S.dirMode === 'ltr',  run: () => setDirMode('ltr') },
          { icon: '←', label: 'Direction: Right-to-left (manga)', active: S.dirMode === 'rtl', run: () => setDirMode('rtl') },
          { separator: true },
          { icon: '🌐', label: 'Translate speech bubbles', hint: 'single-page', active: S.translate, run: () => setTranslate(!S.translate) },
          { icon: '🔊', label: 'Read aloud (TTS)',          active: S.reading,   run: () => setReadAloud(!S.reading) },
          { icon: '✨', label: 'Scan enhance',              active: S.enhance,   run: () => { S.enhance = !S.enhance; YR.savePrefs('comic', { enhance: S.enhance }); renderCurrent(0); } },
        ],
      });

      // RIGHT lane — bookmark, options popover, help.
      const tools = [
        viewMenu,
        YR.ui.sep(),
        YR.ui.group([
          YR.ui.btn({ icon: '◀', title: 'Previous', onClick: prev }),
          YR.ui.btn({ icon: '▶', title: 'Next', onClick: next }),
        ]),
        pageInput, YR.ui.label('/ ' + count),
        readingMenu,
        YR.ui.sep(),
        YR.makeBookmarkTool(() => ({ page: S.index, label: 'Page ' + (S.index + 1) }), m => goPage(m.page, 0)),
        YR.ui.btn({ icon: YR.glyph('gear'), title: 'More options — background, rotate, zoom, auto-advance, filters (O)', onClick: () => togglePopover() }),
        YR.ui.btn({ icon: YR.glyph('help'), title: 'Keyboard shortcuts (?)', onClick: () => toggleHelp(true) }),
      ];
      YR.setTools(tools);
    }

    // ── options popover ─────────────────────────────────────────────────────
    function togglePopover() { S.popOpen ? closePopover() : (S.popOpen = true, buildPopover()); }
    function closePopover() { S.popOpen = false; const p = document.querySelector('.cpop'); if (p) p.remove(); }

    // ── export / share ────────────────────────────────────────────────────────
    // Each action asks the native Save dialog for a destination (desktop app
    // only), then streams the bytes server-side to the chosen path. Display-only
    // tweaks (brightness/night) are never baked in — exports are the true page.
    const IMG_TYPES = ['PNG image (*.png)', 'JPEG image (*.jpg)', 'All files (*.*)'];
    function _pathParts() {
      const sep = path.lastIndexOf('\\') >= 0 ? '\\' : '/';
      const i = path.lastIndexOf(sep);
      return {
        dir: i >= 0 ? path.slice(0, i) : '',
        base: (i >= 0 ? path.slice(i + 1) : (doc.name || 'comic')).replace(/\.[^.]+$/, ''),
      };
    }
    async function _saveVia(suggested, fileTypes, route, extra, busyMsg) {
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.save_file) { YR.toast('Saving needs the desktop app', '', 3200); return; }
      const { dir } = _pathParts();
      let target = null;
      try { target = await api.save_file(suggested, dir, fileTypes); } catch (e) { target = null; }
      if (!target) return;  // cancelled
      if (busyMsg) YR.toast(busyMsg, '', 2600);
      try {
        const r = await YR.postJSON(route, Object.assign({ path, target }, extra));
        YR.toast('Saved ' + (r.name || 'file'), 'success', 2600);
      } catch (e) {
        YR.toast(e.message || 'Could not save', 'error', 3600);
      }
    }
    function savePageImage() {
      const { base } = _pathParts();
      _saveVia(`${base} p${S.index + 1}.png`, IMG_TYPES, '/api/comic/save-page',
        { index: S.index, enhance: S.enhance });
    }
    function savePanelImage() {
      if (!(S.guided && S.mode === 'single' && S.panels.length)) return;
      const b = S.panels[S.panel];
      const { base } = _pathParts();
      _saveVia(`${base} p${S.index + 1} panel${S.panel + 1}.png`, IMG_TYPES, '/api/comic/save-page',
        { index: S.index, enhance: S.enhance, crop: { x: b.x, y: b.y, w: b.w, h: b.h } });
    }
    function exportPdf() {
      const { base } = _pathParts();
      _saveVia(`${base}.pdf`, ['PDF document (*.pdf)', 'All files (*.*)'], '/api/comic/export-pdf',
        {}, 'Building PDF… this can take a moment');
    }

    function buildPopover() {
      let p = document.querySelector('.cpop');
      if (!p) { p = elc('div', 'cpop'); document.body.appendChild(p); }
      const seg = (label, val, cur, on) => `<button class="tb-btn ${cur === val ? 'active' : ''}" data-act="${on}" data-val="${val}">${label}</button>`;
      const detTxt = S.detected === 'unknown' ? (S.ocrAvail ? 'no metadata' : 'install Tesseract for OCR') : ('detected ' + S.detected.toUpperCase());
      const seriesHtml = S.series ? `
         <h4>Series <span style="color:var(--text-faint);text-transform:none">(issue ${S.series.index + 1} of ${S.series.count})</span></h4>
         <div class="seg">
           <button class="tb-btn" data-act="issue" data-val="-1" ${S.series.prev ? '' : 'disabled'}>◀ Prev issue</button>
           <button class="tb-btn" data-act="issue" data-val="1" ${S.series.next ? '' : 'disabled'}>Next issue ▶</button>
         </div>` : '';
      const im = S.img;
      const imgDirty = im.bright !== 100 || im.contrast !== 100 || im.gray || im.invert;
      const imgHtml = `
         <h4>Image</h4>
         <div class="row"><label>Brightness <span class="val">${im.bright}%</span></label><input class="crange" type="range" min="50" max="150" step="5" value="${im.bright}" data-act="bright"></div>
         <div class="row"><label>Contrast <span class="val">${im.contrast}%</span></label><input class="crange" type="range" min="50" max="150" step="5" value="${im.contrast}" data-act="contrast"></div>
         <div class="row"><label>Night · Mono</label><span><button class="tb-btn ${im.invert ? 'active' : ''}" data-act="invert" title="Invert colours — night mode (N)">🌙 Night</button> <button class="tb-btn ${im.gray ? 'active' : ''}" data-act="gray">Mono</button>${imgDirty ? ' <button class="tb-btn" data-act="imgreset">Reset</button>' : ''}</span></div>`;
      const guidedPanel = S.guided && S.mode === 'single' && S.panels.length > 0;
      const exportHtml = `
         <h4>Export</h4>
         <div class="row"><label>This page</label><button class="tb-btn" data-act="savepage" title="Save the current page as a PNG/JPEG">⤓ Save image</button></div>` +
        (guidedPanel ? `<div class="row"><label>This panel</label><button class="tb-btn" data-act="savepanel" title="Save just the current panel">⤓ Save panel</button></div>` : '') +
        `<div class="row"><label>Whole comic</label><button class="tb-btn" data-act="exportpdf" title="Combine all pages into one PDF">⤓ Export PDF</button></div>`;
      p.innerHTML = seriesHtml +
        `<h4>Reading direction <span style="color:var(--text-faint);text-transform:none">(${detTxt})</span></h4>
         <div class="seg">${seg('Auto', 'auto', S.dirMode, 'dir')}${seg('LTR', 'ltr', S.dirMode, 'dir')}${seg('RTL', 'rtl', S.dirMode, 'dir')}</div>
         <h4>Background</h4>
         <div class="seg">${seg('Black', 'black', S.bg, 'bg')}${seg('Gray', 'gray', S.bg, 'bg')}${seg('White', 'white', S.bg, 'bg')}</div>` +
        imgHtml +
        `<h4>Page</h4>
         <div class="row"><label>Rotate 90°</label><button class="tb-btn" data-act="rotate">↻ ${S.rotate}°</button></div>
         <div class="row"><label>Zoom</label><span><button class="tb-btn" data-act="zoom" data-val="out">－</button> <button class="tb-btn" data-act="zoom" data-val="reset">${Math.round(S.zoom * 100)}%</button> <button class="tb-btn" data-act="zoom" data-val="in">＋</button></span></div>
         <div class="row"><label>Enhance scan</label><button class="tb-btn ${S.enhance ? 'active' : ''}" data-act="enhance">${S.enhance ? 'On' : 'Off'}</button></div>
         <h4>Auto-advance</h4>
         <div class="row"><label><button class="tb-btn ${S.auto.on ? 'active' : ''}" data-act="auto">${S.auto.on ? '⏸ Stop' : '▶ Play'}</button></label>
           <span>every <input class="tb-input num" type="number" min="1" max="60" value="${S.auto.sec}" data-act="sec"> s</span></div>` +
        exportHtml;
      p.querySelectorAll('[data-act]').forEach(b => {
        const act = b.dataset.act;
        if (act === 'sec') { b.addEventListener('change', () => { S.auto.sec = Math.max(1, Math.min(60, parseInt(b.value, 10) || 6)); YR.savePrefs('comic', { autoSec: S.auto.sec }); if (S.auto.on) toggleAuto(true); }); return; }
        if (act === 'bright' || act === 'contrast') {
          b.addEventListener('input', () => {
            const v = Math.max(50, Math.min(150, parseInt(b.value, 10) || 100));
            S.img[act] = v;
            const out = b.parentElement.querySelector('.val'); if (out) out.textContent = v + '%';
            applyImageFilter();
            YR.savePrefs('comic', act === 'bright' ? { imgBright: v } : { imgContrast: v });
          });
          return;
        }
        b.addEventListener('click', () => {
          if (act === 'issue') gotoIssue(parseInt(b.dataset.val, 10));
          else if (act === 'gray') { setImg({ gray: !S.img.gray }, { imgGray: !S.img.gray }); buildPopover(); }
          else if (act === 'invert') { setImg({ invert: !S.img.invert }, { imgInvert: !S.img.invert }); buildPopover(); }
          else if (act === 'imgreset') { setImg({ bright: 100, contrast: 100, gray: false, invert: false }, { imgBright: 100, imgContrast: 100, imgGray: false, imgInvert: false }); buildPopover(); }
          else if (act === 'savepage') { closePopover(); savePageImage(); }
          else if (act === 'savepanel') { closePopover(); savePanelImage(); }
          else if (act === 'exportpdf') { closePopover(); exportPdf(); }
          else if (act === 'dir') setDirMode(b.dataset.val);
          else if (act === 'bg') { S.bg = b.dataset.val; applyBg(); YR.savePrefs('comic', { bg: S.bg }); buildPopover(); }
          else if (act === 'rotate') { S.rotate = (S.rotate + 90) % 360; layoutPaged(pan.querySelector('.comic-page')); buildPopover(); }
          else if (act === 'zoom') { if (b.dataset.val === 'in') setZoom(S.zoom * 1.25); else if (b.dataset.val === 'out') setZoom(S.zoom / 1.25); else setZoom(1); buildPopover(); }
          else if (act === 'enhance') { S.enhance = !S.enhance; YR.savePrefs('comic', { enhance: S.enhance }); renderCurrent(0); buildPopover(); }
          else if (act === 'auto') toggleAuto(!S.auto.on);
        });
      });
    }

    // ── thumbnails ──────────────────────────────────────────────────────────
    const thumbWrap = elc('div', 'comic-thumbs');
    function buildThumbs() {
      thumbWrap.innerHTML = '';
      if (S.thumbObs) S.thumbObs.disconnect();
      S.thumbObs = new IntersectionObserver((entries) => {
        for (const e of entries) { if (!e.isIntersecting) continue; const im = e.target.querySelector('img'); if (im && !im.src) im.src = im.dataset.src; S.thumbObs.unobserve(e.target); }
      }, { root: document.getElementById('sidebar'), rootMargin: '500px' });
      for (let i = 0; i < count; i++) {
        const row = elc('div', 'comic-thumb-row'); row.dataset.index = i;
        const im = elc('img'); im.dataset.src = pageURL(i, false); im.alt = 'Page ' + (i + 1);
        row.append(im, elc('span', 'tnum', String(i + 1)));
        row.addEventListener('click', () => goPage(i, 0));
        thumbWrap.appendChild(row); S.thumbObs.observe(row);
      }
      YR.sidebar.set(elc('div', null, '<h3>Pages</h3>'));
      document.getElementById('sidebar').appendChild(thumbWrap);
    }
    function highlightThumb() {
      thumbWrap.querySelectorAll('.comic-thumb-row').forEach(r => {
        const on = parseInt(r.dataset.index, 10) === S.index;
        r.classList.toggle('active', on);
        if (on && YR.sidebar.isOpen()) r.scrollIntoView({ block: 'nearest' });
      });
    }
    YR.sidebar.available(true); buildThumbs();

    // ── help + goto indicator ─────────────────────────────────────────────────
    function showGoto() { let g = stage.querySelector('.goto-indicator'); if (!g) { g = elc('div', 'goto-indicator'); stage.appendChild(g); } g.textContent = 'Go to page ' + S.numBuf; }
    function hideGoto() { const g = stage.querySelector('.goto-indicator'); if (g) g.remove(); }
    const SHORTCUTS = [
      ['Next / panel', 'Space · → · PgDn'], ['Previous / panel', 'Shift+Space · ← · PgUp'],
      ['First / last page', 'Home · End'], ['Jump to page', 'number, Enter'],
      ['Previous / next issue', '[ · ]'],
      ['Guided (panel) view', 'G'], ['Two-page spread', 'D'], ['Webtoon scroll', 'V'],
      ['Zoom in / out / reset', '+ · - · 0'], ['Fit width / height', 'W · H'],
      ['Rotate 90°', 'R'], ['Night mode (invert)', 'N'], ['Options', 'O'], ['Thumbnails', 'T'], ['Fullscreen', 'F'], ['This help', '?'],
    ];
    function toggleHelp(open) {
      S.helpOpen = open; let h = stage.querySelector('.kbd-help');
      if (!open) { if (h) h.remove(); return; }
      if (h) return;
      const rows = SHORTCUTS.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v.split(' · ').map(x => '<kbd>' + YR.escapeHtml(x) + '</kbd>').join(' ')}</span></div>`).join('');
      h = elc('div', 'kbd-help', `<div class="card"><h3>Comic reader shortcuts</h3><div class="hint">Click anywhere or press Esc to close</div>${rows}</div>`);
      h.addEventListener('click', () => toggleHelp(false));
      stage.appendChild(h);
    }
    function toggleFs() { const api = window.pywebview && window.pywebview.api; if (api && api.toggle_fullscreen) api.toggle_fullscreen(); else if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.(); }

    // ── keyboard ──────────────────────────────────────────────────────────────
    S._key = (e) => {
      if (S.helpOpen) { if (e.key === 'Escape' || e.key === '?') toggleHelp(false); return; }
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (/^[0-9]$/.test(e.key)) { S.numBuf += e.key; showGoto(); clearTimeout(S.numTimer); S.numTimer = setTimeout(() => { S.numBuf = ''; hideGoto(); }, 1300); e.preventDefault(); return; }
      switch (e.key) {
        case 'Enter': if (S.numBuf) { const n = parseInt(S.numBuf, 10); S.numBuf = ''; hideGoto(); if (n >= 1 && n <= count) goPage(n - 1, 0); } break;
        case 'ArrowRight': S.rtl ? prev() : next(); e.preventDefault(); break;
        case 'ArrowLeft': S.rtl ? next() : prev(); e.preventDefault(); break;
        case ' ': e.shiftKey ? prev() : next(); e.preventDefault(); break;
        case 'PageDown': next(); e.preventDefault(); break;
        case 'PageUp': prev(); e.preventDefault(); break;
        case 'ArrowDown': if (S.guided || S.mode === 'webtoon') { return; } break;
        case 'ArrowUp': if (S.guided || S.mode === 'webtoon') { return; } break;
        case 'Home': goPage(0, -1); e.preventDefault(); break;
        case 'End': goPage(count - 1, 1); e.preventDefault(); break;
        case '[': gotoIssue(-1); e.preventDefault(); break;
        case ']': gotoIssue(1); e.preventDefault(); break;
        case '+': case '=': setZoom(S.zoom * 1.25); e.preventDefault(); break;
        case '-': case '_': setZoom(S.zoom / 1.25); e.preventDefault(); break;
        case '0': setZoom(1); break;
        case 'f': case 'F': toggleFs(); break;
        case 'd': case 'D': setMode(S.mode === 'spread' ? 'single' : 'spread'); break;
        case 'v': case 'V': setMode(S.mode === 'webtoon' ? 'single' : 'webtoon'); break;
        case 'g': case 'G': if (S.mode === 'single') setGuided(!S.guided); break;
        case 'w': case 'W': setFit('width'); break;
        case 'h': case 'H': setFit('height'); break;
        case 'r': case 'R': S.rotate = (S.rotate + 90) % 360; layoutPaged(pan.querySelector('.comic-page')); break;
        case 'o': case 'O': togglePopover(); break;
        case 't': case 'T': YR.sidebar.toggle(); break;
        case 'n': case 'N': setImg({ invert: !S.img.invert }, { imgInvert: !S.img.invert }); if (S.popOpen) buildPopover(); break;
        case '?': toggleHelp(true); e.preventDefault(); break;
        case 'Escape': if (S.popOpen) closePopover(); else if (document.fullscreenElement) document.exitFullscreen?.(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', S._key);
    // Coalesce resize bursts to one relayout per frame (dragging the window edge
    // fires resize continuously; applyPanel/layoutPaged each read+write layout).
    let resizeRAF = 0;
    S._resize = () => {
      cancelAnimationFrame(resizeRAF);
      resizeRAF = requestAnimationFrame(() => {
        if (S.guided && S.mode === 'single' && S.natW) applyPanel(false);
        else if (S.zoom > 1) layoutPaged(pan.querySelector('.comic-page'));
      });
    };
    window.addEventListener('resize', S._resize);

    applyBg(); applyImageFilter(); buildTools(); renderCurrent(0);

    // ── Right-click context menus ────────────────────────────────────────
    YR.bindContextMenu(YR.root, (ctx, e) => {
      const transBox = e.target.closest && e.target.closest('.trans-box');
      if (transBox) {
        const translated = transBox.textContent || '';
        const original = transBox.title || '';
        return [
          { icon: '⧉', label: 'Copy translation', run: () => { try { navigator.clipboard.writeText(translated); YR.toast('Copied', '', 1200); } catch (_) {} } },
          { icon: '⧉', label: 'Copy original',    disabled: !original, run: () => { try { navigator.clipboard.writeText(original); YR.toast('Copied', '', 1200); } catch (_) {} } },
        ];
      }
      // Default — page-level actions.
      return [
        { icon: '#', label: 'Go to page…', hint: 'g', run: () => { if (pageInput) { pageInput.focus(); pageInput.select(); } } },
        { icon: '★', label: 'Bookmark this page', run: () => YR.postJSON('/api/bookmarks', { path, mark: { page: S.index, label: 'Page ' + (S.index + 1) } }).then(() => YR.toast('Bookmarked', 'success', 1500)).catch(() => {}) },
        { separator: true },
        { icon: '⚐', label: 'Toggle Guided View', active: S.guided, disabled: S.mode !== 'single', hint: 'g', run: () => setGuided(!S.guided) },
        { icon: '🌐', label: 'Toggle translation', active: S.translate, run: () => setTranslate(!S.translate) },
        { icon: '✨', label: 'Toggle scan enhance', active: S.enhance, run: () => { S.enhance = !S.enhance; YR.savePrefs('comic', { enhance: S.enhance }); renderCurrent(0); } },
        { separator: true },
        { icon: '⤓', label: 'Save this page as image…',  run: () => savePageImage() },
        { icon: '⤓', label: 'Save current panel as image', disabled: !(S.guided && S.mode === 'single'), run: () => savePanelImage() },
        { icon: '📕', label: 'Export comic as PDF…',     run: () => exportPdf() },
      ];
    });
    YR.bindContextMenu(document.getElementById('sidebar'), (ctx, e) => {
      const thumb = e.target.closest && e.target.closest('.comic-thumb-row');
      if (thumb) {
        const idx = parseInt(thumb.dataset.index || '0', 10);
        return [
          { icon: '→', label: 'Go to this page',       run: () => goPage(idx, 0) },
          { icon: '★', label: 'Bookmark this page',    run: () => YR.postJSON('/api/bookmarks', { path, mark: { page: idx, label: 'Page ' + (idx + 1) } }).then(() => YR.toast('Bookmarked', 'success', 1500)).catch(() => {}) },
        ];
      }
      return null;
    });

    // Command palette entries (auto-cleared on unmount).
    YR.registerCommand({ g: 'Comic', ic: '▣', name: 'Single page', run: () => setMode('single') });
    YR.registerCommand({ g: 'Comic', ic: '▥', name: 'Two-page spread', run: () => setMode('spread') });
    YR.registerCommand({ g: 'Comic', ic: '▤', name: 'Webtoon (vertical scroll)', run: () => setMode('webtoon') });
    YR.registerCommand({ g: 'Comic', ic: '⚐', name: 'Toggle Guided View', run: () => setGuided(!S.guided) });
    YR.registerCommand({ g: 'Comic', ic: '↔', name: 'Cycle reading direction (auto / LTR / RTL)', run: () => cycleDir() });
    YR.registerCommand({ g: 'Comic', ic: '🌐', name: 'Toggle translation overlay', run: () => setTranslate(!S.translate) });
    YR.registerCommand({ g: 'Comic', ic: '✨', name: 'Toggle scan enhance', run: () => { S.enhance = !S.enhance; YR.savePrefs('comic', { enhance: S.enhance }); renderCurrent(0); } });

    mount._S = S;
  }

  function unmount() {
    const S = mount._S;
    if (S) {
      if (S._key) window.removeEventListener('keydown', S._key);
      if (S._resize) window.removeEventListener('resize', S._resize);
      if (S.thumbObs) S.thumbObs.disconnect();
      if (S.lazyObs) S.lazyObs.disconnect();
      if (S._onDrag) window.removeEventListener('mousemove', S._onDrag);
      if (S._endDrag) window.removeEventListener('mouseup', S._endDrag);
      clearTimeout(S.numTimer);
      clearInterval(S.auto.timer); clearTimeout(S.auto.timer);
      clearTimeout(S.auto.timer2); clearInterval(S.auto.timer2);
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    const p = document.querySelector('.cpop'); if (p) p.remove();
    mount._S = null;
  }

  YR.registerReader('comic', { mount, unmount });
})();
