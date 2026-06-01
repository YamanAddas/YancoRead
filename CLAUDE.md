# YancoRead — project guide for Claude Code

Universal "open anything readable" desktop app: detect a file's kind and morph the
toolbar to match (PDF / comic / eBook / office / text / image). Stack: **Flask +
pywebview + PyMuPDF**, vanilla-JS frontend. Developed on **Python 3.10**.

## Run & test

- **Run the app:** `python launch.py` (starts Flask, then opens the native window).
- **Backend only (for API testing):** `python app.py` → serves on **`http://127.0.0.1:8746`**.
  IMPORTANT: always use `127.0.0.1`, never `localhost` (the Host-header guard rejects `localhost`).
- **Tests:** `python -m pytest -q` from the repo root (suite is ~407 tests; keep it green).
- **JS syntax check:** `node --check static/js/readers/<file>.js` after editing frontend code.
- On Windows the venv interpreter is `venv\Scripts\python.exe`; activate the venv first
  (`venv\Scripts\activate`) or call it directly.

## Editing & reload rules (IMPORTANT)

- Editing **`app.py`** or **`renderers/*.py`** → **restart Flask** to take effect
  (it runs with `debug=False`, `use_reloader=False`, so there is no auto-reload).
- Editing **static assets** (`static/js/**`, `static/css/**`, `templates/**`) → just
  **reload the browser/window**; no Flask restart needed.
- **Do NOT edit `dist/` or `build/`** — those are generated build output. Rebuild with
  `python build.py` (PyInstaller) instead.

## Architecture

- `detect.py` — routes a file to a kind by extension.
- `renderers/` — backend per kind: `fitzdoc.py` (PDF **and** eBook, via PyMuPDF),
  `comicdoc.py` (cbz/cbr/cb7/cbt), `officedoc.py` (docx/pptx/xlsx → HTML),
  `textdoc.py` (markdown + Pygments), `imagedoc.py`. Plus `panels.py`/`balloons.py`/
  `enhance.py` (OpenCV comic vision), `llm.py` (AI backends), `signatures.py`.
- `app.py` — Flask routes (`/api/...`). `paths.py` — cross-platform user-data dirs.
  `userdata.py` — settings/state. `window.py` — pywebview window + native dialogs.
- Frontend: `static/js/app.js` is the shell; each reader in `static/js/readers/<kind>.js`
  registers via `YR.registerReader(kind, { mount, unmount })` and builds its own toolbar.
  Shared helpers hang off the global `YR` (getJSON/postJSON/toast/sidebar/savePrefs/…).

## Toolbar discipline (a core product principle)

Keep the UI native and lean — "don't let it get so big that it's not the right way":
- **"Produce-a-new-file" operations** (merge, split, export images, compress, OCR…) are
  grouped into **hubs**, never added as standalone top-toolbar buttons.
- **Interactive MODES** (Markup, Sign, Fill, Redact, Read-aloud) each get **exactly ONE**
  toolbar button. Sub-tools live inside the mode's own bar.
- Document-wide managers (e.g. the annotation "Notes" tab) live in the **sidebar**, not
  the toolbar.

## PDF overlay coordinates

PDF point `(x, y)` → CSS px = `(x * z, y * z)` where `z = effZoom()`. Overlays
(search highlights, text layer, annotation hotspots, TTS/flash boxes) are absolutely-
positioned children of `.page-wrap`. These are only coherent at **user-rotation 0** —
gate any overlay drawing on `S.rotate % 360 === 0` and skip otherwise (the existing
overlays all do this).

## Security & privacy (IMPORTANT — this repo is public, AGPL-3.0)

- **Never commit secrets or personal data.** No API keys, tokens, or `userdata.json`
  in the tree (`.gitignore` guards these — keep it that way).
- The **signature library** and **OCR tessdata** live ONLY in `%APPDATA%\YancoRead\`
  (outside the repo). Never copy them into the project tree.
- Write scratch/probe files to the **OS temp dir**, never into the repo.
- Entering passwords/credentials is the **user's own action** — never store or log them.

## License & dependencies

- **AGPL-3.0** (required by PyMuPDF, which is AGPL). Keep it that way unless the user
  decides to relicense. **Do not add new paid dependencies** or anything needing a
  commercial license.

## Workflow

- On bug reports: **audit the code path and inspect real state before patching** —
  rigor over fast guesses.
- Build features in **sequenced, independently-verifiable chunks** (backend + tests
  first, then UI), verifying each before moving on.
- Git init/commit/push is the user's call — don't push unless asked.
