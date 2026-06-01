/* YancoRead — Settings panel (AI/translation backend + OCR).
   Model field is a smart dropdown auto-populated from the connected backend. */
(function () {
  'use strict';

  const BACKENDS = [
    ['ollama', 'Ollama (local)'],
    ['lmstudio', 'LM Studio (local)'],
    ['openclaw', 'OpenClaw'],
    ['openai', 'OpenAI (cloud)'],
    ['custom', 'Custom'],
  ];
  const DEF = {
    ollama:   { e: 'http://localhost:11434/v1/chat/completions', m: 'llama3.1' },
    lmstudio: { e: 'http://localhost:1234/v1/chat/completions',  m: 'local-model' },
    openclaw: { e: 'http://localhost:18789/v1/chat/completions', m: 'openclaw/default' },
    openai:   { e: 'https://api.openai.com/v1/chat/completions', m: 'gpt-4o-mini' },
    custom:   { e: 'https://your-endpoint/v1/chat/completions',  m: 'model-name' },
  };
  const LANGS = ['English', 'Arabic', 'French', 'Spanish', 'German', 'Italian',
    'Japanese', 'Korean', 'Chinese', 'Portuguese', 'Russian', 'Turkish'];

  const esc = (s) => YR.escapeHtml(s == null ? '' : s);

  async function open() {
    let s = {};
    try { s = (await YR.getJSON('/api/settings')).settings || {}; } catch (e) {}
    const ai = s.ai || {};

    const ov = document.createElement('div');
    ov.className = 'settings-overlay';
    ov.innerHTML = `
      <div class="settings-card">
        <div class="set-head"><h2>Settings</h2><button class="set-close" title="Close">✕</button></div>

        <div class="set-section">
          <h3>AI &amp; Translation</h3>
          <div class="set-row"><label>Backend</label>
            <select id="set-backend" class="set-input">
              ${BACKENDS.map(([v, l]) => `<option value="${v}" ${ai.backend === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div class="set-row"><label>Endpoint</label>
            <input id="set-endpoint" class="set-input" value="${esc(ai.endpoint)}"></div>
          <div class="set-row"><label>Model</label>
            <span style="display:flex;gap:6px;flex:1;align-items:center">
              <select id="set-model" class="set-input" style="flex:1"></select>
              <button class="set-btn" id="set-detect" title="Detect installed models">↻</button></span></div>
          <div class="set-row"><label></label><span id="set-model-status" class="set-status"></span></div>
          <div class="set-row" id="set-key-row"><label>API key</label>
            <input id="set-key" class="set-input" type="password" value="${esc(ai.api_key)}" placeholder="only for cloud backends"></div>
          <div class="set-row"><label>Translate into</label>
            <input id="set-lang" class="set-input" list="set-lang-list" value="${esc(ai.target_lang || 'English')}" placeholder="e.g. English, Arabic">
            <datalist id="set-lang-list">${LANGS.map(l => `<option value="${l}">`).join('')}</datalist></div>
          <div class="set-row"><label></label>
            <span><button class="set-btn" id="set-test">Test connection</button>
            <span id="set-test-status" class="set-status"></span></span></div>
        </div>

        <div class="set-section">
          <h3>OCR (text recognition)</h3>
          <div class="set-row"><label>Read text with</label>
            <select id="set-ocrsrc" class="set-input">
              <option value="vision" ${(s.ocr_source || 'vision') === 'vision' ? 'selected' : ''}>AI vision model (any language, stylized / hand-lettered — uses your LLM)</option>
              <option value="tesseract" ${s.ocr_source === 'tesseract' ? 'selected' : ''}>Tesseract (offline, printed text — English/Arabic)</option>
            </select></div>
          <div class="set-hint">Vision mode (default) reads <b>any language</b> — Arabic, Japanese, Korean, Chinese… — and handles artistic lettering far better; it sends the page image to your AI model, so it needs a <b>multimodal</b> model (e.g. qwen2.5-vl, llava, minicpm-v) and is slower. Tesseract is a fast offline fallback, best on clean printed Latin/Arabic text.</div>
          <div class="set-hint" id="set-ocr-status">Checking…</div>
          <div class="set-row"><label>Tesseract path</label>
            <span style="display:flex;gap:6px;flex:1">
              <input id="set-tess" class="set-input" style="flex:1" value="${esc(s.tesseract_path)}" placeholder="auto-detected — override only if needed">
              <button class="set-btn" id="set-browse">Browse…</button></span></div>
        </div>

        <div class="set-foot">
          <button class="set-btn ghost" id="set-cancel">Cancel</button>
          <button class="set-btn primary" id="set-save">Save</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const $ = (id) => ov.querySelector(id);
    const backendSel = $('#set-backend'), endpoint = $('#set-endpoint'),
      modelSel = $('#set-model'), keyRow = $('#set-key-row'), modelStatus = $('#set-model-status');

    function syncBackend() {
      const d = DEF[backendSel.value] || DEF.custom;
      endpoint.placeholder = d.e;
      keyRow.style.display = (backendSel.value === 'openai' || backendSel.value === 'custom') ? '' : 'none';
    }

    function aiPayload() {
      return {
        backend: backendSel.value,
        endpoint: endpoint.value.trim(),
        model: modelSel.value,
        api_key: $('#set-key').value,
        target_lang: $('#set-lang').value.trim() || 'English',
      };
    }

    function setModelOptions(models, keep) {
      const seen = new Set();
      const opts = [];
      if (keep && !models.includes(keep)) opts.push(keep);   // preserve saved model
      models.forEach(m => { if (!seen.has(m)) { seen.add(m); opts.push(m); } });
      modelSel.innerHTML = opts.length
        ? opts.map(m => `<option value="${esc(m)}" ${m === keep ? 'selected' : ''}>${esc(m)}</option>`).join('')
        : '<option value="">(none detected)</option>';
    }

    let modelSeq = 0;
    async function loadModels() {
      const my = ++modelSeq;                 // only the latest request may update the UI
      const keep = modelSel.value || ai.model || '';
      modelStatus.textContent = 'Detecting models…'; modelStatus.className = 'set-status';
      let r;
      try {
        r = await YR.postJSON('/api/llm/models', { ai: aiPayload() });
      } catch (e) {
        if (my !== modelSeq) return;
        setModelOptions(keep ? [keep] : [], keep);
        modelStatus.textContent = 'Could not reach backend — ↻ to retry';
        modelStatus.className = 'set-status err';
        return;
      }
      if (my !== modelSeq) return;           // a newer detect superseded this one
      if (r.ok && r.models.length) {
        setModelOptions(r.models, keep);
        modelStatus.textContent = r.models.length + ' model' + (r.models.length > 1 ? 's' : '') + ' found';
        modelStatus.className = 'set-status ok';
      } else {
        setModelOptions(keep ? [keep] : [], keep);
        modelStatus.textContent = r.error || 'No models found — start the backend, then ↻';
        modelStatus.className = 'set-status err';
      }
    }

    syncBackend();
    setModelOptions(ai.model ? [ai.model] : [], ai.model);   // show saved model immediately
    loadModels();                                            // then auto-detect

    backendSel.addEventListener('change', () => { syncBackend(); loadModels(); });
    endpoint.addEventListener('change', loadModels);
    $('#set-key').addEventListener('change', loadModels);
    $('#set-detect').addEventListener('click', loadModels);

    $('#set-test').addEventListener('click', async () => {
      const st = $('#set-test-status');
      st.textContent = 'Testing…'; st.className = 'set-status';
      try {
        const r = await YR.postJSON('/api/llm/test', { ai: aiPayload() });
        if (r.ok) { st.textContent = '✓ Connected (' + (r.model || '') + ')'; st.className = 'set-status ok'; }
        else { st.textContent = '✗ ' + (r.error || 'Failed'); st.className = 'set-status err'; }
      } catch (e) { st.textContent = '✗ ' + e.message; st.className = 'set-status err'; }
    });

    $('#set-browse').addEventListener('click', async () => {
      const api = window.pywebview && window.pywebview.api;
      if (api && api.browse_file) {
        const p = await api.browse_file();
        if (p) $('#set-tess').value = p;
      } else { YR.toast('Browse needs the desktop app', '', 3000); }
    });

    (async () => {
      try {
        const o = await YR.getJSON('/api/ocr-status');
        const el = $('#set-ocr-status');
        if (o.available) {
          const ar = o.langs.includes('ara');
          el.innerHTML = `✓ Tesseract found — languages: <b>${o.langs.join(', ')}</b>.` +
            (ar ? '' : ' <span class="err">Arabic (ara) not installed — needed for Arabic comics.</span>');
        } else {
          el.innerHTML = '<span class="err">Tesseract not found.</span> Install it and set the path above.';
        }
      } catch (e) {}
    })();

    const close = () => ov.remove();
    $('.set-close').addEventListener('click', close);
    $('#set-cancel').addEventListener('click', close);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });

    $('#set-save').addEventListener('click', async () => {
      try {
        await YR.postJSON('/api/settings', {
          settings: { ai: aiPayload(), tesseract_path: $('#set-tess').value.trim(),
                      ocr_source: $('#set-ocrsrc').value },
        });
        YR.toast('Settings saved', 'success');
        close();
      } catch (e) { YR.toast('Save failed: ' + e.message, 'error'); }
    });
  }

  YR.openSettings = open;
})();
