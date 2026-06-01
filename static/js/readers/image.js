/* YancoRead — Image viewer + tool profile.
   Deep viewer: zoom (wheel zoom-to-cursor, buttons, double-tap), drag-to-pan,
   rotate 90°, flip H/V, fit/actual sizing, transparency backdrop, full
   keyboard. The image is a single <img> transformed in screen space:
     translate(pan) · scale(zoom) · rotate · scale(flip)
   so zoom-to-cursor math works regardless of rotation/flip (we only ever
   reason about the image centre's screen position). */
(function () {
  'use strict';

  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
  const MIN_SCALE = 0.1, MAX_SCALE = 8;
  const BGS = ['dark', 'light', 'checker'];
  const SLIDE_MS = 4000;
  // Slideshow state lives at module scope so it survives the re-mount that each
  // gallery advance triggers (openFile → unmount old → mount new). slideAdvancing
  // marks a hop that stays inside the folder, so unmount knows not to cancel.
  let slideOn = false, slideTimer = 0, slideAdvancing = false;

  function mount(doc) {
    const path = doc.path;
    const prefs = Object.assign({ fit: 'contain', bg: 'dark' }, doc.prefs || {});
    const S = {
      fit: prefs.fit === 'actual' ? 'actual' : 'contain',
      bg: BGS.includes(prefs.bg) ? prefs.bg : 'dark',
      scale: 1, tx: 0, ty: 0, rot: 0, flipH: false, flipV: false,
      natW: 0, natH: 0,
    };

    // ── DOM ──────────────────────────────────────────────────────────────────
    const root = YR.root; root.innerHTML = '';
    const reader = el('div', 'image-reader');
    const stage = el('div', 'image-stage bg-' + S.bg + (S.fit === 'actual' ? ' actual' : ''));
    const img = el('img', 'image-canvas');
    img.alt = doc.name || ''; img.draggable = false;
    const readout = el('div', 'image-readout');
    stage.append(img, readout);
    reader.appendChild(stage);
    root.appendChild(reader);
    img.src = `/api/image?path=${encodeURIComponent(path)}`;

    // ── transform ──────────────────────────────────────────────────────────────
    const clampScale = (z) => Math.max(MIN_SCALE, Math.min(z, MAX_SCALE));
    let flashTimer = 0;
    function apply() {
      const fx = S.flipH ? -1 : 1, fy = S.flipV ? -1 : 1;
      img.style.transform =
        `translate(${S.tx}px, ${S.ty}px) scale(${S.scale}) rotate(${S.rot}deg) scale(${fx}, ${fy})`;
      updateReadout();
    }
    function updateReadout() {
      const pct = Math.round(S.scale * 100);
      if (zoomLabel) zoomLabel.textContent = pct + '%';
      const dim = S.natW ? `${S.natW}×${S.natH}px` : '';
      readout.innerHTML = `<span>${pct}%</span>` +
        (dim ? `<span class="ir-sep">·</span><span>${dim}</span>` : '');
      readout.classList.add('show');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => readout.classList.remove('show'), 1100);
    }

    // Zoom keeping the point under (clientX, clientY) fixed on screen.
    function zoomAt(clientX, clientY, factor) {
      const r = stage.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const ns = clampScale(S.scale * factor);
      const k = ns / S.scale;
      if (k === 1) return;
      S.tx += (clientX - cx - S.tx) * (1 - k);
      S.ty += (clientY - cy - S.ty) * (1 - k);
      S.scale = ns;
      apply();
    }
    function zoomCenter(factor) {
      const r = stage.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, factor);
    }

    function resetView(full) {
      S.scale = 1; S.tx = 0; S.ty = 0;
      if (full) { S.rot = 0; S.flipH = false; S.flipV = false; }
      apply(); syncButtons();
    }
    function setFit(f) {
      S.fit = f === 'actual' ? 'actual' : 'contain';
      stage.classList.toggle('actual', S.fit === 'actual');
      YR.savePrefs('image', { fit: S.fit });
      resetView(false);
    }
    function rotate(deg) { S.rot = (((S.rot + deg) % 360) + 360) % 360; S.tx = 0; S.ty = 0; apply(); }
    function flip(axis) { if (axis === 'h') S.flipH = !S.flipH; else S.flipV = !S.flipV; apply(); syncButtons(); }
    function setBg(b) {
      if (!BGS.includes(b)) return;
      S.bg = b;
      BGS.forEach(x => stage.classList.toggle('bg-' + x, x === b));
      YR.savePrefs('image', { bg: b });
    }

    // ── interactions ───────────────────────────────────────────────────────────
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, tx: S.tx, ty: S.ty };
      stage.classList.add('panning');
      try { stage.setPointerCapture(e.pointerId); } catch (_) {}
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      S.tx = drag.tx + (e.clientX - drag.x);
      S.ty = drag.ty + (e.clientY - drag.y);
      apply();
    });
    const endDrag = () => { if (drag) { drag = null; stage.classList.remove('panning'); } };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('dblclick', (e) => {
      if (S.scale > 1.01) resetView(false); else zoomAt(e.clientX, e.clientY, 2.2);
    });

    function onKey(e) {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      let h = true;
      switch (e.key) {
        case '+': case '=': zoomCenter(1.2); break;
        case '-': case '_': zoomCenter(1 / 1.2); break;
        case '0': resetView(true); break;
        case 'r': rotate(90); break;
        case 'R': rotate(-90); break;
        case 'f': flip('h'); break;
        case 'F': flip('v'); break;
        case '1': setFit('actual'); break;
        case '9': setFit('contain'); break;
        case 'ArrowLeft': S.tx += 60; apply(); break;
        case 'ArrowRight': S.tx -= 60; apply(); break;
        case 'ArrowUp': S.ty += 60; apply(); break;
        case 'ArrowDown': S.ty -= 60; apply(); break;
        case 'i': case 'I': openSide('info', true); break;
        case 'a': case 'A': openSide('ai', true); break;
        case '[': case 'PageUp': goSibling(-1); break;
        case ']': case 'PageDown': goSibling(1); break;
        case 'c': case 'C': copyImage(); break;
        case 's': case 'S': toggleSlide(); break;
        case 'Escape': if (slideOn) stopSlide(); else h = false; break;
        default: h = false;
      }
      if (h) e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    S._onKey = onKey;

    img.addEventListener('load', () => {
      S.natW = img.naturalWidth; S.natH = img.naturalHeight;
      updateReadout();
    });

    // ── sidebar: image info / EXIF + AI (describe / read text / caption / ask) ──
    const sideWrap = el('div', 'image-side');
    let sideMode = 'info';
    let infoData = null, infoLoading = false, infoErr = '';
    let aiLast = null, aiBusy = '', aiErr = '';   // AI panel state (survives tab switches)
    const SIDE_TABS = [['info', 'ⓘ Info'], ['ai', '✦ AI']];
    const IMAGE_AI_ACTIONS = [
      { task: 'describe', label: 'Describe' },
      { task: 'ocr', label: 'Read text' },
      { task: 'caption', label: 'Caption' },
      { task: 'tags', label: 'Tags' },
      { task: 'alt', label: 'Alt text' },
    ];
    const AI_SPINNER = '<div class="stage-loading" style="position:static;padding:18px"><div class="yr-spinner"></div></div>';

    function openSide(mode, toggle) {
      if (toggle && YR.rpanel.isOpen() && sideMode === mode) { YR.rpanel.hide(); return; }
      sideMode = mode; renderSidebar(); YR.rpanel.show();
    }
    function renderSidebar() {
      const tabs = SIDE_TABS.length > 1
        ? '<div class="image-side-tabs">' + SIDE_TABS.map(([m, lbl]) =>
            `<button class="rp-tab ${sideMode === m ? 'on' : ''}" data-m="${m}" style="flex:1">${lbl}</button>`).join('') + '</div>'
        : '';
      sideWrap.innerHTML = tabs + '<div class="image-side-body"></div>';
      sideWrap.querySelectorAll('[data-m]').forEach(b =>
        b.addEventListener('click', () => { sideMode = b.dataset.m; renderSidebar(); }));
      YR.rpanel.set(sideWrap);
      renderSideBody();
    }
    function renderSideBody() {
      const body = sideWrap.querySelector('.image-side-body');
      if (!body) return;
      if (sideMode === 'ai') renderAIPanel(body);
      else renderInfo(body);
    }
    function ii(label, val) {
      return `<div class="ii-row"><span class="ii-k">${YR.escapeHtml(label)}</span>` +
        `<span class="ii-v">${YR.escapeHtml(val)}</span></div>`;
    }
    function infoHTML(d) {
      const b = [];
      if (d.format) b.push(ii('Format', d.format));
      b.push(ii('Dimensions', `${d.width} × ${d.height} px` + (d.megapixels ? ` · ${d.megapixels} MP` : '')));
      if (d.mode) b.push(ii('Color mode', d.mode));
      b.push(ii('Transparency', d.has_alpha ? 'Yes (alpha)' : 'No'));
      if (d.dpi) b.push(ii('Resolution', d.dpi + ' DPI'));
      if (d.frames > 1) b.push(ii('Frames', d.frames + ' (animated)'));
      b.push(ii('File size', d.size_human));
      let html = `<div class="ii-sec"><h4>Image</h4>${b.join('')}</div>`;
      if (d.exif && d.exif.length)
        html += `<div class="ii-sec"><h4>Photo · EXIF</h4>${d.exif.map(p => ii(p[0], p[1])).join('')}</div>`;
      if (d.gps) {
        html += `<div class="ii-sec"><h4>Location</h4>${ii('Coordinates', d.gps.text)}` +
          `<div class="ii-actions">` +
          `<button class="ai-act" data-copy="${YR.escapeHtml(d.gps.text)}">Copy</button>` +
          `<a class="ai-act" href="https://www.openstreetmap.org/?mlat=${d.gps.lat}&mlon=${d.gps.lon}#map=14/${d.gps.lat}/${d.gps.lon}" target="_blank" rel="noopener">Open map ↗</a>` +
          `</div></div>`;
      }
      return html;
    }
    function renderInfo(body) {
      if (infoErr) { body.innerHTML = `<div class="ai-err">${YR.escapeHtml(infoErr)}</div>`; return; }
      if (infoData) {
        body.innerHTML = infoHTML(infoData);
        const c = body.querySelector('[data-copy]');
        if (c) c.addEventListener('click', () => {
          try { navigator.clipboard.writeText(c.dataset.copy); } catch (_) {}
          YR.toast('Copied coordinates', '', 1500);
        });
        return;
      }
      body.innerHTML = '<div class="image-side-loading">Reading image info…</div>';
      if (infoLoading) return;
      infoLoading = true;
      YR.getJSON(`/api/image-info?path=${encodeURIComponent(path)}`)
        .then(d => { infoData = d; S._info = d; infoLoading = false; if (sideMode === 'info') renderSideBody(); })
        .catch(e => { infoErr = (e && e.message) || 'Could not read image info'; infoLoading = false; if (sideMode === 'info') renderSideBody(); });
    }

    // ── AI panel: vision model looks at the picture itself (/api/image-ai) ──────
    function renderAIPanel(body) {
      body.innerHTML =
        '<div class="ai-scope">Ask the AI about <b>this image</b> — it looks at the picture itself.</div>' +
        '<div class="ai-actions">' +
        IMAGE_AI_ACTIONS.map(a => `<button class="ai-act" data-task="${a.task}">${YR.escapeHtml(a.label)}</button>`).join('') +
        '</div>' +
        '<div class="ai-ask">' +
        '<input class="tb-input" id="img-ai-q" placeholder="Ask about this image…" />' +
        '<button class="ai-act" id="img-ai-ask">Ask</button>' +
        '</div>' +
        '<div class="ai-output" id="img-ai-out"></div>';
      body.querySelectorAll('.ai-act[data-task]').forEach(b =>
        b.addEventListener('click', () => runImageAI(b.dataset.task)));
      const q = body.querySelector('#img-ai-q');
      const ask = () => { const v = q.value.trim(); if (v) runImageAI('ask', v); };
      body.querySelector('#img-ai-ask').addEventListener('click', ask);
      q.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') ask(); });
      const out = body.querySelector('#img-ai-out');
      if (aiBusy) out.innerHTML = AI_SPINNER;
      else if (aiErr) out.innerHTML = `<div class="ai-err">${YR.escapeHtml(aiErr)}</div>`;
      else if (aiLast) fillAIOutput(out, aiLast);
    }
    function fillAIOutput(out, data) {
      if (!out) return;
      out.innerHTML = '<div class="ai-result"></div><button class="ai-act ai-copy">⧉ Copy</button>';
      out.querySelector('.ai-result').textContent = data.result;
      out.querySelector('.ai-copy').addEventListener('click', () => {
        try { navigator.clipboard.writeText(data.result); } catch (_) {}
        YR.toast('Copied', '', 1200);
      });
    }
    async function runImageAI(task, question) {
      if (sideMode !== 'ai') { sideMode = 'ai'; renderSidebar(); YR.rpanel.show(); }
      let out = sideWrap.querySelector('#img-ai-out');
      if (!out) return;
      aiErr = ''; aiLast = null; aiBusy = task;
      out.innerHTML = AI_SPINNER;
      try {
        const r = await YR.postJSON('/api/image-ai', { path, task, question });
        aiBusy = '';
        aiLast = { task, result: (r.result || '').trim() || '(no response)' };
        if (sideMode === 'ai') fillAIOutput(sideWrap.querySelector('#img-ai-out'), aiLast);
      } catch (e) {
        aiBusy = '';
        aiErr = (e && e.message) || 'AI request failed';
        if (sideMode === 'ai') {
          out = sideWrap.querySelector('#img-ai-out');
          if (out) out.innerHTML = `<div class="ai-err">${YR.escapeHtml(aiErr)}</div>`;
        }
      }
    }

    // ── toolbar ────────────────────────────────────────────────────────────────
    const zoomLabel = YR.ui.label('100%');
    zoomLabel.style.minWidth = '46px'; zoomLabel.style.textAlign = 'center';
    const fitBtn = YR.ui.btn({ label: 'Fit', title: 'Fit to window (9)', active: S.fit === 'contain', onClick: () => setFit('contain') });
    const actualBtn = YR.ui.btn({ label: '1:1', title: 'Actual size (1)', active: S.fit === 'actual', onClick: () => setFit('actual') });
    const flipHBtn = YR.ui.btn({ icon: '⇋', title: 'Flip horizontal (f)', onClick: () => flip('h') });
    const flipVBtn = YR.ui.btn({ icon: '⥯', title: 'Flip vertical (Shift+F)', onClick: () => flip('v') });
    function syncButtons() {
      fitBtn.classList.toggle('active', S.fit === 'contain');
      actualBtn.classList.toggle('active', S.fit === 'actual');
      flipHBtn.classList.toggle('active', S.flipH);
      flipVBtn.classList.toggle('active', S.flipV);
    }

    // ── copy image to clipboard (PNG via canvas) ────────────────────────────────
    function imageToPngBlob() {
      return new Promise((resolve, reject) => {
        const w = S.natW || img.naturalWidth, h = S.natH || img.naturalHeight;
        if (!w || !h) { reject(new Error('Image is still loading')); return; }
        try {
          const c = el('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);   // same-origin src → canvas isn't tainted
          c.toBlob(b => b ? resolve(b) : reject(new Error('Could not encode PNG')), 'image/png');
        } catch (err) { reject(err); }
      });
    }
    async function copyImage() {
      if (!window.ClipboardItem || !navigator.clipboard || !navigator.clipboard.write) {
        YR.toast('This browser can’t copy images to the clipboard', 'error', 2800); return;
      }
      try {
        const blob = await imageToPngBlob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        YR.toast('Image copied to clipboard', 'success', 1500);
      } catch (e) {
        YR.toast('Copy failed: ' + ((e && e.message) || 'unknown error'), 'error', 2800);
      }
    }
    const copyBtn = YR.ui.btn({ icon: '⧉', label: 'Copy', title: 'Copy image to clipboard (c)', onClick: copyImage });

    // ── slideshow: auto-advance through the folder (state at module scope) ───────
    function reflectSlide() {
      slideBtn.classList.toggle('active', slideOn);
      if (slideBtn.children[0]) slideBtn.children[0].textContent = slideOn ? '❚❚' : '▷';
      if (slideBtn.children[1]) slideBtn.children[1].textContent = slideOn ? 'Stop' : 'Slideshow';
    }
    function armSlide() {
      clearTimeout(slideTimer);
      if (slideOn) slideTimer = setTimeout(slideTick, SLIDE_MS);
    }
    function slideTick() {
      if (!slideOn) return;
      if (!sibs || !sibs.files || sibs.files.length < 2) { armSlide(); return; }  // siblings not loaded → wait a beat
      goSibling(1, true);   // wrap at the end → endless loop
    }
    function startSlide() {
      if (!sibs || sibs.count <= 1) { YR.toast('No other images in this folder', '', 2200); return; }
      slideOn = true; reflectSlide(); armSlide();
      YR.toast('Slideshow started — press s or Esc to stop', '', 2400);
    }
    function stopSlide() { slideOn = false; clearTimeout(slideTimer); slideTimer = 0; reflectSlide(); }
    function toggleSlide() { slideOn ? stopSlide() : startSlide(); }
    const slideBtn = YR.ui.btn({ icon: '▷', label: 'Slideshow', title: 'Auto-advance through the folder (s)', onClick: toggleSlide });

    // ── folder gallery: browse sibling images like a photo viewer ───────────────
    let sibs = null;   // { files:[{path,name}], index, count, prev, next }
    const galPrev = YR.ui.btn({ icon: '‹', title: 'Previous image ([ or PageUp)', onClick: () => goSibling(-1) });
    const galNext = YR.ui.btn({ icon: '›', title: 'Next image (] or PageDown)', onClick: () => goSibling(1) });
    const galCounter = YR.ui.label('—');
    galCounter.style.minWidth = '64px';
    const galGroup = YR.ui.group([galPrev, galCounter, galNext, slideBtn]);
    galGroup.style.display = 'none';   // revealed once we know the folder has siblings
    function syncGallery() {
      if (!sibs || sibs.count <= 1) { galGroup.style.display = 'none'; if (slideOn) stopSlide(); return; }
      galGroup.style.display = '';
      galCounter.textContent = (sibs.index + 1) + ' / ' + sibs.count;
      galPrev.disabled = !sibs.prev;
      galNext.disabled = !sibs.next;
    }
    function goSibling(delta, wrap) {
      if (!sibs || !sibs.files || sibs.files.length < 2) return;
      let ni = sibs.index + delta;
      if (wrap) ni = ((ni % sibs.files.length) + sibs.files.length) % sibs.files.length;
      if (ni < 0 || ni >= sibs.files.length) return;
      slideAdvancing = true;            // in-folder hop: let any running slideshow survive the re-mount
      YR.openFile(sibs.files[ni].path); // re-mounts the reader on the new file
    }
    YR.getJSON(`/api/image-siblings?path=${encodeURIComponent(path)}`)
      .then(d => { sibs = d; S._sibs = d; syncGallery(); reflectSlide(); })
      .catch(() => {});

    // Three Lanes — LEFT: gallery (when siblings) + View ▾ (zoom/fit/backdrop).
    // CENTER: Transform ▾ (rotate/flip) + Reset + Copy. RIGHT: Info.
    const viewMenu = YR.ui.menu({
      icon: YR.glyph('view'), label: 'View',
      title: 'Zoom, fit, backdrop',
      items: () => [
        { icon: '＋', label: 'Zoom in',  hint: '+', run: () => zoomCenter(1.2) },
        { icon: '－', label: 'Zoom out', hint: '−', run: () => zoomCenter(1 / 1.2) },
        { separator: true },
        { icon: '⛶', label: 'Fit to window', active: S.fit === 'contain', hint: '9', run: () => setFit('contain') },
        { icon: '1:1', label: 'Actual size',  active: S.fit === 'actual',  hint: '1', run: () => setFit('actual') },
        { separator: true },
        { icon: '🌑', label: 'Dark backdrop',    active: S.bg === 'dark',    run: () => setBg('dark') },
        { icon: '☀', label: 'Light backdrop',   active: S.bg === 'light',   run: () => setBg('light') },
        { icon: '▦', label: 'Checker backdrop', active: S.bg === 'checker', run: () => setBg('checker') },
      ],
    });
    const transformMenu = YR.ui.menu({
      icon: YR.glyph('transform'), label: 'Transform',
      title: 'Rotate and flip',
      items: () => [
        { icon: '↻', label: 'Rotate right', hint: 'r',       run: () => rotate(90) },
        { icon: '↺', label: 'Rotate left',  hint: 'Shift+R', run: () => rotate(-90) },
        { separator: true },
        { icon: '⇋', label: 'Flip horizontal', active: S.flipH, hint: 'f',       run: () => flip('h') },
        { icon: '⥯', label: 'Flip vertical',   active: S.flipV, hint: 'Shift+F', run: () => flip('v') },
      ],
    });

    YR.setTools([
      galGroup,                                                              // LEFT (gallery — when applicable)
      viewMenu, zoomLabel,                                                   // LEFT (view + zoom %)
      YR.ui.sep(),
      transformMenu,                                                         // CENTER
      YR.ui.btn({ icon: '⤢', label: 'Reset', title: 'Reset view (0)', onClick: () => resetView(true) }),
      copyBtn,
      YR.ui.sep(),
      YR.ui.btn({ icon: 'ⓘ', label: 'Info', title: 'Image info & EXIF (i)', onClick: () => openSide('info', true) }),  // RIGHT
    ]);
    YR.setHeaderActions([
      YR.ui.btn({ icon: YR.glyph('sparkles'), label: 'AI', title: 'Describe, read text, caption… (a)', onClick: () => openSide('ai', true) }),
    ]);
    syncButtons();
    reflectSlide();            // reflect any slideshow carried over from the previous image
    renderSidebar();           // pre-build into the rpanel (stays collapsed until Info/AI opens it)
    apply();
    if (slideOn) armSlide();   // resumed slideshow → schedule the next hop

    // Command palette entries (auto-cleared on unmount).
    YR.registerCommand({ g: 'Image', ic: '↻', name: 'Rotate right', hint: 'r', run: () => rotate(90) });
    YR.registerCommand({ g: 'Image', ic: '↺', name: 'Rotate left', hint: 'Shift+R', run: () => rotate(-90) });
    YR.registerCommand({ g: 'Image', ic: '⇋', name: 'Flip horizontal', hint: 'f', run: () => flip('h') });
    YR.registerCommand({ g: 'Image', ic: '⥯', name: 'Flip vertical', hint: 'Shift+F', run: () => flip('v') });
    YR.registerCommand({ g: 'Image', ic: '⧉', name: 'Copy image to clipboard', hint: 'c', run: () => copyImage() });
    YR.registerCommand({ g: 'Image', ic: '▷', name: 'Toggle slideshow', hint: 's', run: () => toggleSlide() });
    YR.registerCommand({ g: 'Image', ic: '⤢', name: 'Reset view', hint: '0', run: () => resetView(true) });
    YR.registerCommand({ g: 'Image', ic: '⛶', name: 'Fit to window', hint: '9', run: () => setFit('contain') });
    YR.registerCommand({ g: 'Image', ic: '1:1', name: 'Actual size', hint: '1', run: () => setFit('actual') });

    mount._S = S;
  }

  function unmount() {
    const S = mount._S;
    if (S && S._onKey) window.removeEventListener('keydown', S._onKey);
    clearTimeout(slideTimer); slideTimer = 0;
    if (!slideAdvancing) slideOn = false;   // navigated away (Home / other file) → end slideshow
    slideAdvancing = false;                 // consume the in-folder-hop flag
    mount._S = null;
  }

  YR.registerReader('image', { mount, unmount });
})();
