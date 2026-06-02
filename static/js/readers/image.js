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

    // Edit-mode (paint/draw) state. The image is a single <img> when viewing; in
    // edit mode we draw onto a same-resolution <canvas> overlay and can save it
    // back to disk. Undo/redo keep full-canvas ImageData snapshots, bounded by
    // both a count and a total-bytes ceiling so huge images can't exhaust memory.
    const ED = {
      on: false, canvas: null, ctx: null,
      tool: 'brush', color: '#e23b3b', size: 8, opacity: 1, fillShapes: false,
      undo: [], redo: [], undoBytes: 0,
      dirty: false, savedOnce: false, overwrote: false,
      drawing: false, start: null, last: null, snapshot: null, textInput: null,
    };
    const UNDO_MAX = 40;
    const UNDO_BYTES_CAP = 300 * 1024 * 1024;   // ~300 MB across the whole stack
    const EDIT_PALETTE = ['#000000', '#ffffff', '#e23b3b', '#f59e0b', '#22c55e',
                          '#3b82f6', '#a855f7', '#ec4899'];
    const IMG_TYPES = ['PNG image (*.png)', 'JPEG image (*.jpg)',
                       'WebP image (*.webp)', 'All files (*.*)'];

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
      if (ED.on) return;                 // edit mode owns the canvas; no zoom-pan
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (ED.on || e.button !== 0) return;
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
      if (ED.on) return;
      if (S.scale > 1.01) resetView(false); else zoomAt(e.clientX, e.clientY, 2.2);
    });

    function onKey(e) {
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      if (ED.on) { handleEditKey(e); return; }   // edit mode has its own shortcuts
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
      if (ED.on) { YR.toast('Exit edit mode before changing image', '', 2200); return; }
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

    // ── EDIT MODE: paint / draw on a canvas, then save back to disk ──────────────
    // One toolbar button toggles the mode; all sub-tools live in this floating bar
    // (mirrors the PDF "Markup" mode — top toolbar stays a single button).
    let editBar = null, editBtn = null;

    function pathParts() {
      const sep = path.lastIndexOf('\\') >= 0 ? '\\' : '/';
      const i = path.lastIndexOf(sep);
      const dir = i >= 0 ? path.slice(0, i) : '';
      const full = i >= 0 ? path.slice(i + 1) : (doc.name || 'image');
      const dot = full.lastIndexOf('.');
      return { dir, base: dot > 0 ? full.slice(0, dot) : full };
    }
    function hexToRgb(h) {
      const m = /^#?([0-9a-f]{6})$/i.exec((h || '').trim());
      if (!m) return [0, 0, 0];
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const rgbToHex = (r, g, b) =>
      '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

    // Pointer position → canvas bitmap coords. `scale` = bitmap px per CSS px, so
    // brush/shape widths track what the user sees regardless of the fit zoom.
    function canvasXY(e) {
      const r = ED.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) / r.width * ED.canvas.width,
        y: (e.clientY - r.top) / r.height * ED.canvas.height,
        scale: ED.canvas.width / r.width,
      };
    }
    const strokeW = (sc) => Math.max(1, ED.size * sc);

    function pushUndo() {
      try {
        const snap = ED.ctx.getImageData(0, 0, ED.canvas.width, ED.canvas.height);
        ED.undo.push(snap);
        ED.undoBytes += snap.data.byteLength;
        ED.redo.length = 0;                       // a fresh action invalidates redo
        while (ED.undo.length > 1 &&
               (ED.undo.length > UNDO_MAX || ED.undoBytes > UNDO_BYTES_CAP)) {
          ED.undoBytes -= ED.undo.shift().data.byteLength;
        }
      } catch (_) { /* same-origin canvas → won't taint; ignore if it ever does */ }
      markDirty();
    }
    function undo() {
      if (!ED.undo.length) return;
      const cur = ED.ctx.getImageData(0, 0, ED.canvas.width, ED.canvas.height);
      ED.redo.push(cur);
      const prev = ED.undo.pop(); ED.undoBytes -= prev.data.byteLength;
      ED.ctx.putImageData(prev, 0, 0);
      markDirty();
    }
    function redo() {
      if (!ED.redo.length) return;
      const cur = ED.ctx.getImageData(0, 0, ED.canvas.width, ED.canvas.height);
      ED.undo.push(cur); ED.undoBytes += cur.data.byteLength;
      const nx = ED.redo.pop();
      ED.ctx.putImageData(nx, 0, 0);
      markDirty();
    }
    function markDirty() { ED.dirty = true; reflectEdit(); }

    // ── tool implementations ───────────────────────────────────────────────────
    function freehandDown(p) {
      const c = ED.ctx;
      c.save();
      c.lineCap = 'round'; c.lineJoin = 'round';
      c.lineWidth = strokeW(p.scale);
      if (ED.tool === 'eraser') {
        c.globalCompositeOperation = 'destination-out';
        c.globalAlpha = ED.opacity; c.strokeStyle = '#000'; c.fillStyle = '#000';
      } else {
        c.globalCompositeOperation = 'source-over';
        c.globalAlpha = ED.tool === 'pencil' ? 1 : ED.opacity;
        c.strokeStyle = ED.color; c.fillStyle = ED.color;
      }
      c.beginPath();                                  // an initial dot, so a click marks
      c.arc(p.x, p.y, Math.max(0.5, c.lineWidth / 2), 0, Math.PI * 2);
      c.fill();
      ED.last = p;
    }
    function freehandMove(p) {
      const c = ED.ctx;
      c.beginPath(); c.moveTo(ED.last.x, ED.last.y); c.lineTo(p.x, p.y); c.stroke();
      ED.last = p;
    }
    function freehandUp() { ED.ctx.restore(); }

    function drawShape(a, b) {
      const c = ED.ctx;
      c.save();
      c.globalAlpha = ED.opacity; c.lineCap = 'round'; c.lineJoin = 'round';
      c.lineWidth = strokeW(a.scale);
      c.strokeStyle = ED.color; c.fillStyle = ED.color;
      if (ED.tool === 'line') {
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      } else if (ED.tool === 'rect') {
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        if (ED.fillShapes) c.fillRect(x, y, w, h);
        c.strokeRect(x, y, w, h);
      } else if (ED.tool === 'ellipse') {
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
        c.beginPath(); c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        if (ED.fillShapes) c.fill();
        c.stroke();
      }
      c.restore();
    }

    function floodFill(p) {
      const w = ED.canvas.width, h = ED.canvas.height;
      const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
      if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;
      const img = ED.ctx.getImageData(0, 0, w, h), d = img.data;
      const i0 = (y0 * w + x0) * 4;
      const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], ta = d[i0 + 3];
      const [nr, ng, nb] = hexToRgb(ED.color), na = 255;
      if (nr === tr && ng === tg && nb === tb && na === ta) return;   // nothing to do
      const tol = 32;
      const match = (i) => Math.abs(d[i] - tr) <= tol && Math.abs(d[i + 1] - tg) <= tol &&
                           Math.abs(d[i + 2] - tb) <= tol && Math.abs(d[i + 3] - ta) <= tol;
      const seen = new Uint8Array(w * h);
      const stack = [x0, y0];                                   // flat [x,y,x,y,…] stack
      while (stack.length) {
        const y = stack.pop(), x = stack.pop();
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const pi = y * w + x;
        if (seen[pi]) continue;
        const i = pi * 4;
        if (!match(i)) continue;
        seen[pi] = 1;
        d[i] = nr; d[i + 1] = ng; d[i + 2] = nb; d[i + 3] = na;
        stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
      }
      ED.ctx.putImageData(img, 0, 0);
    }

    function pick(p) {
      const x = Math.max(0, Math.min(ED.canvas.width - 1, Math.floor(p.x)));
      const y = Math.max(0, Math.min(ED.canvas.height - 1, Math.floor(p.y)));
      const d = ED.ctx.getImageData(x, y, 1, 1).data;
      setColor(rgbToHex(d[0], d[1], d[2]));
      YR.toast('Picked ' + ED.color, '', 1200);
    }

    // ── text tool: a floating input placed at the click, baked on commit ────────
    function placeText(e) {
      removeTextInput();
      const p = canvasXY(e);
      const inp = el('input', 'edit-text-input');
      inp.type = 'text';
      inp.style.left = e.clientX + 'px';
      inp.style.top = e.clientY + 'px';
      inp.style.color = ED.color;
      inp.style.font = `${Math.max(12, ED.size * 3)}px sans-serif`;
      document.body.appendChild(inp);
      ED.textInput = inp; ED.textPos = p;
      setTimeout(() => inp.focus(), 0);
      inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') commitText();
        else if (ev.key === 'Escape') removeTextInput();
      });
      inp.addEventListener('blur', commitText);
    }
    function commitText() {
      const inp = ED.textInput; if (!inp) return;
      const val = inp.value, p = ED.textPos;
      removeTextInput();
      if (!val.trim()) return;
      pushUndo();
      const c = ED.ctx;
      c.save();
      c.globalAlpha = ED.opacity; c.fillStyle = ED.color; c.textBaseline = 'top';
      c.font = `${Math.max(4, ED.size * 3 * p.scale)}px sans-serif`;
      c.fillText(val, p.x, p.y);
      c.restore();
    }
    function removeTextInput() {
      const i = ED.textInput;
      if (i) { ED.textInput = null; if (i.parentNode) i.parentNode.removeChild(i); }
    }

    // ── canvas pointer routing ───────────────────────────────────────────────────
    function onCanvasDown(e) {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const p = canvasXY(e);
      if (ED.tool === 'eyedropper') { pick(p); return; }
      if (ED.tool === 'text') { placeText(e); return; }
      if (ED.tool === 'fill') { pushUndo(); floodFill(p); return; }
      pushUndo();
      ED.drawing = true;
      try { ED.canvas.setPointerCapture(e.pointerId); } catch (_) {}
      if (ED.tool === 'brush' || ED.tool === 'pencil' || ED.tool === 'eraser') freehandDown(p);
      else { ED.start = p; ED.snapshot = ED.ctx.getImageData(0, 0, ED.canvas.width, ED.canvas.height); }
    }
    function onCanvasMove(e) {
      if (!ED.drawing) return;
      const p = canvasXY(e);
      if (ED.tool === 'brush' || ED.tool === 'pencil' || ED.tool === 'eraser') freehandMove(p);
      else { ED.ctx.putImageData(ED.snapshot, 0, 0); drawShape(ED.start, p); }
    }
    function onCanvasUp(e) {
      if (!ED.drawing) return;
      ED.drawing = false;
      try { ED.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      if (ED.tool === 'brush' || ED.tool === 'pencil' || ED.tool === 'eraser') freehandUp();
      else { const p = canvasXY(e); ED.ctx.putImageData(ED.snapshot, 0, 0); drawShape(ED.start, p); ED.snapshot = null; }
    }

    // ── enter / exit ─────────────────────────────────────────────────────────────
    function enterEdit() {
      if (ED.on) return;
      if (!S.natW) { YR.toast('Image is still loading…', '', 1800); return; }
      if (slideOn) stopSlide();
      const c = el('canvas', 'edit-canvas');
      c.width = S.natW; c.height = S.natH;
      let ctx;
      try {
        ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, S.natW, S.natH);
      } catch (err) {
        YR.toast('Could not open this image for editing', 'error', 2800); return;
      }
      ED.canvas = c; ED.ctx = ctx; ED.on = true;
      ED.undo = []; ED.redo = []; ED.undoBytes = 0;
      ED.dirty = false; ED.savedOnce = false; ED.overwrote = false;
      img.style.display = 'none';
      stage.insertBefore(c, readout);
      c.addEventListener('pointerdown', onCanvasDown);
      c.addEventListener('pointermove', onCanvasMove);
      c.addEventListener('pointerup', onCanvasUp);
      c.addEventListener('pointercancel', onCanvasUp);
      reader.classList.add('editing');
      if (!editBar) editBar = buildEditBar();
      editBar.classList.remove('hidden');
      setTool(ED.tool);
      reflectEdit();
      YR.toast('Edit mode — pick a tool and draw. Ctrl+Z undo · Esc to exit', '', 3200);
    }
    function exitEdit(force) {
      if (!ED.on) return;
      commitText();
      if (!force && ED.dirty) {
        if (!window.confirm('Discard unsaved changes to this image?')) return;
      }
      ED.on = false; ED.drawing = false;
      if (ED.canvas && ED.canvas.parentNode) ED.canvas.parentNode.removeChild(ED.canvas);
      ED.canvas = null; ED.ctx = null; ED.undo = []; ED.redo = []; ED.undoBytes = 0;
      img.style.display = '';
      if (editBar) editBar.classList.add('hidden');
      reader.classList.remove('editing');
      reflectEdit();
      if (ED.overwrote) {                         // file changed on disk → refresh view
        img.src = `/api/image?path=${encodeURIComponent(path)}&_=${Date.now()}`;
      }
    }

    // ── save (overwrite original, with a one-time .bak) / save a copy ────────────
    function canvasDataUrl() { return ED.canvas.toDataURL('image/png'); }
    async function saveOverwrite() {
      if (!ED.on) return;
      commitText();
      try {
        const r = await YR.postJSON('/api/image/save',
          { data: canvasDataUrl(), mode: 'overwrite', path });
        ED.dirty = false; ED.savedOnce = true; ED.overwrote = true; reflectEdit();
        YR.toast('Saved' + (r.backup ? ' · backup kept (.bak)' : ''), 'success', 2400);
      } catch (e) {
        YR.toast(e.message || 'Could not save', 'error', 3600);
      }
    }
    async function saveAs() {
      if (!ED.on) return;
      commitText();
      const api = window.pywebview && window.pywebview.api;
      if (!api || !api.save_file) { YR.toast('Save As needs the desktop app — use Save instead', '', 3200); return; }
      const { dir, base } = pathParts();
      let target = null;
      try { target = await api.save_file(base + ' (edited).png', dir, IMG_TYPES); } catch (_) { target = null; }
      if (!target) return;
      try {
        const r = await YR.postJSON('/api/image/save',
          { data: canvasDataUrl(), mode: 'saveas', target });
        ED.dirty = false; reflectEdit();
        YR.toast('Saved ' + (r.name || 'copy'), 'success', 2600);
      } catch (e) {
        YR.toast(e.message || 'Could not save', 'error', 3600);
      }
    }

    // ── keyboard (edit mode owns these while active) ─────────────────────────────
    function handleEditKey(e) {
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
        else if (k === 'y') { e.preventDefault(); redo(); }
        else if (k === 's') { e.preventDefault(); saveOverwrite(); }
        return;
      }
      let h = true;
      switch (e.key) {
        case 'b': setTool('brush'); break;
        case 'p': setTool('pencil'); break;
        case 'e': setTool('eraser'); break;
        case 'l': setTool('line'); break;
        case 'r': setTool('rect'); break;
        case 'o': setTool('ellipse'); break;
        case 'g': setTool('fill'); break;
        case 'i': setTool('eyedropper'); break;
        case 't': setTool('text'); break;
        case '[': setSize(Math.max(1, ED.size - 2)); break;
        case ']': setSize(Math.min(100, ED.size + 2)); break;
        case 'Escape': exitEdit(); break;
        default: h = false;
      }
      if (h) e.preventDefault();
    }

    // ── the floating edit bar (the mode's own sub-toolbar) ───────────────────────
    const EDIT_TOOLS = [
      ['brush', '🖌', 'Brush — soft stroke (b)'],
      ['pencil', '✏', 'Pencil — hard line (p)'],
      ['eraser', '🧽', 'Eraser — rub to transparent (e)'],
      ['line', '╱', 'Line (l)'],
      ['rect', '▭', 'Rectangle (r)'],
      ['ellipse', '◯', 'Ellipse (o)'],
      ['fill', '🪣', 'Fill bucket (g)'],
      ['eyedropper', '💧', 'Pick a colour (i)'],
      ['text', 'T', 'Text (t)'],
    ];
    function mk(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
    function setTool(t) {
      ED.tool = t;
      if (editBar) editBar.querySelectorAll('.eb-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
      if (ED.canvas) ED.canvas.style.cursor = (t === 'text') ? 'text' : 'crosshair';
    }
    function setColor(c) {
      ED.color = c;
      if (!editBar) return;
      editBar.querySelectorAll('.eb-swatch').forEach(s => s.classList.toggle('active', s.dataset.color === c));
      const ci = editBar.querySelector('.eb-color');
      if (ci && /^#[0-9a-fA-F]{6}$/.test(c) && ci.value !== c) ci.value = c;
      const cur = editBar.querySelector('.eb-current'); if (cur) cur.style.background = c;
    }
    function setSize(v) {
      ED.size = Math.max(1, Math.min(100, v | 0));
      if (!editBar) return;
      const r = editBar.querySelector('.eb-size'); if (r && +r.value !== ED.size) r.value = ED.size;
      const lbl = editBar.querySelector('.eb-size-val'); if (lbl) lbl.textContent = ED.size;
    }
    function setOpacity(v) {
      ED.opacity = Math.max(0.05, Math.min(1, v / 100));
      const lbl = editBar && editBar.querySelector('.eb-op-val');
      if (lbl) lbl.textContent = Math.round(ED.opacity * 100) + '%';
    }
    function reflectEdit() {
      if (editBtn) editBtn.classList.toggle('active', ED.on);
      // Guard navigation away (Home / open another file / window close) while
      // there are unsaved edits — mirrors the docx / text / PDF editors.
      if (YR.setLeaveGuard) {
        YR.setLeaveGuard((ED.on && ED.dirty)
          ? () => 'You have unsaved image edits — leave without saving?' : null);
      }
      if (!editBar) return;
      const u = editBar.querySelector('.eb-undo'), r = editBar.querySelector('.eb-redo');
      if (u) u.disabled = !ED.undo.length;
      if (r) r.disabled = !ED.redo.length;
      const sv = editBar.querySelector('.eb-save');
      if (sv) sv.classList.toggle('dirty', ED.dirty);
    }
    function buildEditBar() {
      const bar = mk('div', 'image-edit-bar hidden');
      const tools = mk('div', 'eb-group');
      EDIT_TOOLS.forEach(([tool, icon, title]) => {
        const b = mk('button', 'eb-tool', icon);
        b.dataset.tool = tool; b.title = title;
        b.addEventListener('click', () => setTool(tool));
        tools.appendChild(b);
      });
      bar.appendChild(tools);
      bar.appendChild(mk('span', 'eb-sep'));

      const colors = mk('div', 'eb-group');
      colors.appendChild(mk('span', 'eb-current'));
      EDIT_PALETTE.forEach(col => {
        const s = mk('button', 'eb-swatch');
        s.dataset.color = col; s.style.background = col; s.title = col;
        s.addEventListener('click', () => setColor(col));
        colors.appendChild(s);
      });
      const ci = mk('input', 'eb-color'); ci.type = 'color'; ci.value = ED.color; ci.title = 'Custom colour';
      ci.addEventListener('input', () => setColor(ci.value));
      colors.appendChild(ci);
      bar.appendChild(colors);
      bar.appendChild(mk('span', 'eb-sep'));

      const sizeG = mk('div', 'eb-group');
      sizeG.appendChild(mk('label', 'eb-label', 'Size'));
      const size = mk('input', 'eb-size'); size.type = 'range'; size.min = '1'; size.max = '100'; size.value = ED.size;
      size.title = 'Brush / line width ([ and ])';
      size.addEventListener('input', () => setSize(+size.value));
      sizeG.appendChild(size);
      sizeG.appendChild(mk('span', 'eb-size-val', String(ED.size)));
      bar.appendChild(sizeG);

      const opG = mk('div', 'eb-group');
      opG.appendChild(mk('label', 'eb-label', 'Opacity'));
      const op = mk('input', 'eb-op'); op.type = 'range'; op.min = '5'; op.max = '100'; op.value = String(Math.round(ED.opacity * 100));
      op.title = 'Opacity';
      op.addEventListener('input', () => setOpacity(+op.value));
      opG.appendChild(op);
      opG.appendChild(mk('span', 'eb-op-val', Math.round(ED.opacity * 100) + '%'));
      bar.appendChild(opG);

      const fillBtn = mk('button', 'eb-fill', '▦ Fill shapes');
      fillBtn.title = 'Fill rectangles & ellipses (otherwise outline only)';
      fillBtn.addEventListener('click', () => {
        ED.fillShapes = !ED.fillShapes;
        fillBtn.classList.toggle('active', ED.fillShapes);
      });
      bar.appendChild(fillBtn);
      bar.appendChild(mk('span', 'eb-sep'));

      const undoB = mk('button', 'eb-undo', '↶'); undoB.title = 'Undo (Ctrl+Z)';
      undoB.addEventListener('click', undo);
      const redoB = mk('button', 'eb-redo', '↷'); redoB.title = 'Redo (Ctrl+Y)';
      redoB.addEventListener('click', redo);
      bar.appendChild(undoB); bar.appendChild(redoB);
      bar.appendChild(mk('span', 'eb-sep'));

      const saveB = mk('button', 'eb-save eb-primary', '💾 Save'); saveB.title = 'Save over the original (keeps a .bak) — Ctrl+S';
      saveB.addEventListener('click', saveOverwrite);
      const saveAsB = mk('button', 'eb-saveas', 'Save As…'); saveAsB.title = 'Save a copy as a new file';
      saveAsB.addEventListener('click', saveAs);
      const doneB = mk('button', 'eb-done', '✓ Done'); doneB.title = 'Leave edit mode (Esc)';
      doneB.addEventListener('click', () => exitEdit());
      bar.appendChild(saveB); bar.appendChild(saveAsB); bar.appendChild(doneB);

      YR.root.appendChild(bar);
      setColor(ED.color);
      return bar;
    }

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

    editBtn = YR.ui.btn({ icon: '✎', label: 'Edit', title: 'Paint & draw on this image (b/p/e tools, Esc to exit)', onClick: () => ED.on ? exitEdit() : enterEdit() });
    YR.setTools([
      galGroup,                                                              // LEFT (gallery — when applicable)
      viewMenu, zoomLabel,                                                   // LEFT (view + zoom %)
      YR.ui.sep(),
      transformMenu,                                                         // CENTER
      YR.ui.btn({ icon: '⤢', label: 'Reset', title: 'Reset view (0)', onClick: () => resetView(true) }),
      copyBtn,
      editBtn,
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
    YR.registerCommand({ g: 'Image', ic: '✎', name: 'Edit image (paint & draw)', run: () => enterEdit() });
    YR.registerCommand({ g: 'Image', ic: '▷', name: 'Toggle slideshow', hint: 's', run: () => toggleSlide() });
    YR.registerCommand({ g: 'Image', ic: '⤢', name: 'Reset view', hint: '0', run: () => resetView(true) });
    YR.registerCommand({ g: 'Image', ic: '⛶', name: 'Fit to window', hint: '9', run: () => setFit('contain') });
    YR.registerCommand({ g: 'Image', ic: '1:1', name: 'Actual size', hint: '1', run: () => setFit('actual') });

    // ── Right-click context menus ────────────────────────────────────────
    YR.bindContextMenu(YR.root, (ctx, e) => {
      const items = [
        { icon: '✎', label: ED.on ? 'Exit edit mode' : 'Edit image (paint & draw)', run: () => ED.on ? exitEdit() : enterEdit() },
        { icon: '⧉', label: 'Copy image',  hint: 'c', run: () => copyImage() },
        { icon: '💡', label: 'Describe with AI', run: () => openSide('ai', true) },
        { icon: 'ⓘ', label: 'Image info & EXIF', hint: 'i', run: () => openSide('info', true) },
        { separator: true },
        { icon: '＋', label: 'Zoom in',    hint: '+', run: () => zoomCenter(1.25) },
        { icon: '−', label: 'Zoom out',   hint: '−', run: () => zoomCenter(1 / 1.25) },
        { icon: '⛶', label: 'Fit to window', hint: '9', active: S.fit === 'contain', run: () => setFit('contain') },
        { icon: '1:1', label: 'Actual size',  hint: '1', active: S.fit === 'actual',  run: () => setFit('actual') },
        { separator: true },
        { icon: '↻', label: 'Rotate right', hint: 'r',       run: () => rotate(90) },
        { icon: '↺', label: 'Rotate left',  hint: 'Shift+R', run: () => rotate(-90) },
        { icon: '⇋', label: 'Flip horizontal', hint: 'f',       active: S.flipH, run: () => flip('h') },
        { icon: '⥯', label: 'Flip vertical',   hint: 'Shift+F', active: S.flipV, run: () => flip('v') },
        { icon: '⤢', label: 'Reset view',      hint: '0', run: () => resetView(true) },
      ];
      if (sibs && sibs.count > 1) {
        items.push({ separator: true });
        items.push({ icon: '‹', label: 'Previous image', hint: '[', disabled: !sibs.prev, run: () => goSibling(-1) });
        items.push({ icon: '›', label: 'Next image',     hint: ']', disabled: !sibs.next, run: () => goSibling(1) });
        items.push({ icon: '▷', label: slideOn ? 'Stop slideshow' : 'Start slideshow', hint: 's', active: slideOn, run: () => toggleSlide() });
      }
      return items;
    });

    mount._S = S;
  }

  function unmount() {
    const S = mount._S;
    if (S && S._onKey) window.removeEventListener('keydown', S._onKey);
    // Tear down any edit-mode UI that lives outside the reader subtree (the
    // floating bar is appended to YR.root; the text input to document.body).
    document.querySelectorAll('.image-edit-bar, .edit-text-input').forEach(n => n.remove());
    if (YR.setLeaveGuard) YR.setLeaveGuard(null);   // drop any unsaved-edit guard
    clearTimeout(slideTimer); slideTimer = 0;
    if (!slideAdvancing) slideOn = false;   // navigated away (Home / other file) → end slideshow
    slideAdvancing = false;                 // consume the in-folder-hop flag
    mount._S = null;
  }

  YR.registerReader('image', { mount, unmount });
})();
