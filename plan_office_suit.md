# YancoRead — Office Suite Innovation Plan

> Roadmap to deepen the **Office reader** (DOCX · PPTX · XLSX) the same way the PDF
> reader was deepened: native, lean, free, and built in **sequenced, independently
> verifiable chunks** (backend + tests first, then UI). Researched 2026-06 against
> current free/open-source tooling; every dependency below is free and license-clean
> for an AGPL-3.0 app.

---

## 0. Principles (carried over from the rest of the app)

- **Free & open only.** No paid libraries, no API keys, AGPL-compatible licenses. AI
  features plug into the existing pluggable LLM client (Ollama / LM Studio / OpenClaw /
  any OpenAI-compatible endpoint) and stay optional/local-friendly.
- **Native & not bloated.** Prefer what's already bundled (PyMuPDF, openpyxl, python-pptx,
  python-docx, mammoth, lxml). A new multi-hundred-MB dependency is a hard no. New deps
  must earn their weight; favor "one tiny vendored file" over a framework.
- **Toolbar discipline.** Produce-a-new-file ops live in hubs; interactive modes get
  exactly ONE button; document-wide managers live in the sidebar (like the PDF Notes tab).
- **Graceful degradation.** A high-fidelity path may use an *optional* external tool
  (LibreOffice) **only if already installed** — never bundled, always falls back.
- **Offline-first.** Vendored assets (fonts, JS) live in the repo/`%APPDATA%`, not a CDN.
- **Reader-first.** YancoRead is a reader that can edit, not an Office clone. Depth should
  serve reading/reviewing comfort before authoring.

---

## 1. Current state (honest audit)

| Format | Today | Verdict |
|--------|-------|---------|
| **DOCX** | Deep: mammoth→HTML, contenteditable editor + ribbon, HTML→docx write-back (fonts/colors/highlight/B-I-U/align/spacing/headings/lists/links/tables/images), page setup, headers/footers, footnotes round-trip, AI panel, Web-Speech read-aloud, highlights+notes, find/replace, outline nav, print/Save-as-PDF. **`detect_docx_fidelity()` already DETECTS tracked-changes & comments but can only warn "lossy"** — it can't show or keep them. | Strong base; clear gaps in **review** (track changes, comments) and **reading aids**. |
| **PPTX** | `_pptx_to_html()` ≈ 40 lines: title + body text + pictures, **stacked vertically as plain HTML**. No slide model, no layout/position, no tables/shapes/charts, no notes, no backgrounds. | **Mis-presented.** Biggest broken→fixed delta. |
| **XLSX** | `_xlsx_to_html()` ≈ 35 lines: `read_only + data_only`, `values_only=True`, capped 2000×60, bare `<table>`, row 0 forced as header. No styles, no number formats, no merged cells, no sheet tabs, no formulas. | Usable but flat; missing fidelity + navigation. |

The Office frontend (`office.js`) dispatches on `doc.meta.render` (`flow` / `unsupported`).
Everything in `flow` currently assumes a continuous-HTML document — PPTX and XLSX need
their own render branches.

---

## 2. Tooling decisions (the master list — all FREE)

| Tool | Version | License | Status | Used for |
|------|---------|---------|--------|----------|
| **python-pptx** | 1.0.2 | MIT | ✅ already in app | PPTX structural extraction (text, tables, pictures, shape geometry, notes, slide size) |
| **openpyxl** | 3.1.5 | MIT | ✅ already in app | XLSX — read styles + number formats + merged cells (**must drop `read_only=True`**: merged ranges/`freeze_panes` are NOT exposed in read-only mode — verified; non-read-only reads a capped 2000×60 sheet in ~1s) |
| **python-docx** | 1.2.0 | MIT | ✅ already in app | DOCX — **native Comments API is new in 1.2.0**; write-back |
| **mammoth** | 1.12.0 | BSD-2 | ✅ already in app | DOCX→clean semantic HTML (keep it; don't swap) |
| **lxml** | 6.1.1 | BSD | ✅ already in app | Raw OOXML reads: tracked changes (`w:ins`/`w:del`), comment anchors |
| **PyMuPDF (fitz)** | 1.27.2.3 | AGPL-3.0 | ✅ already in app | Rasterize the PPTX→PDF intermediate to slide images (high-fidelity path) |
| **SheetJS `ssf`** | `ssf.js` latest | Apache-2.0 | ➕ vendor 1 JS file | Excel number-format code → display string (the reference ECMA-376 formatter) |
| **markdownify** | latest | MIT | ➕ new (tiny, pure-Py) | DOCX/HTML → Markdown export |
| **OpenDyslexic** | — | SIL OFL 1.1 | ➕ bundle woff2 | Dyslexia-friendly reading-font toggle |
| **difflib** | stdlib | PSF | ✅ stdlib | "Compare with backup" redline diff |
| **LibreOffice** | 25.2.x | MPL-2.0 | ⚙ OPTIONAL external — **never bundle** | High-fidelity PPTX (and optional DOCX) → PDF, only if the user already has `soffice` |
| **docx-revisions** | 0.1.5 | MIT | ⚠ optional/experimental | Accept/reject tracked changes *to disk* (vet before trusting) |

**Net new shipped dependencies for the core plan: one vendored JS file (`ssf.js`) + one
font + `markdownify`.** Everything else reuses what's bundled or is an optional, auto-
detected external tool. Zero new heavyweight Python packages.

### Explicitly REJECTED (with reasons — so we don't revisit)

- **Bundling LibreOffice** — ~300–600 MB installed. Detect & use if present; never ship it.
- **`unoconv`** — archived/bugfix-only since 2025. If we ever need a warm LO instance, use `unoserver` (MIT); otherwise a locked `subprocess` to `soffice` is simpler.
- **`soffice --convert-to png`** for decks — known first-slide-only bug; go via PDF then PyMuPDF.
- **Aspose.Slides / Spire** (PPTX) — paid / freemium-limited. Out.
- **`formulas`** (XLSX) — pulls numpy+scipy+schedula, EUPL-1.1 friction. Use cached values instead.
- **`pycel`** (XLSX) — GPLv3, stale since 2021, **unpatched RCE CVE-2024-53924**. Disqualified for an app that opens arbitrary files.
- **Babel** for number formats — ~10 MB CLDR and its date syntax ≠ Excel's. `ssf.js` is correct + tiny.
- **Tabulator / Jspreadsheet CE** — editing grids; heavyweight; Jspreadsheet's XLSX/style features are paid. Hand-roll a sticky-CSS grid instead.
- **`docx2pdf`** — requires MS Word installed; not free/offline. Keep WebView print → Save-as-PDF as the default DOCX→PDF.
- **"PyMuPDF converts docx→PDF"** — it does NOT (fitz can't open .docx). Don't attempt this path.
- **`python-redlines`** — embeds a native .NET binary (tens of MB + packaging pain). Use `difflib` redline instead; revisit only on real demand.
- **Swapping mammoth for `docx-preview`** — it's a layout renderer that would fight our editor + write-back (we own both sides). Keep mammoth; grow its style map.
- **Naming any feature "Bionic Reading"** — patent+trademark protected. Ship a generic "Reading focus" toggle instead.

---

## 3. Track D — DOCX innovation (deepen the strongest reader)

> Base is already deep; these target **review** and **reading comfort**, mostly with
> ZERO new dependencies (lxml + stdlib + CSS).

- **D1 — Tracked-changes & comments DISPLAY** *(backend + tests, then UI)* — **highest value.**
  lxml pass over `document.xml`: render `w:ins` as `<ins class="trk-ins" data-author>`,
  `w:del`/`w:delText` as `<del class="trk-del">`, color by author; surface Word comments
  (python-docx 1.2.0 `doc.comments` + `w:commentRangeStart/End` anchors) in a sidebar
  **"Review" tab** (mirrors the PDF Notes tab). A view toggle: Original / Final / Markup.
  Turns the two existing "lossy — Save As" warnings into real features. *Zero new deps.*
  - *Caveats to surface honestly:* comment reply-threads & resolved-state aren't modeled
    by python-docx 1.2.0; show top-level comments faithfully and note the limitation.

- **D2 — Reading aids** *(UI, zero deps)* — reading-time + word/char count in *read* mode
  (≈238 wpm), **OpenDyslexic** font toggle (OFL, bundled), **sepia + true-dark** doc
  themes, a scroll-driven **reading-progress bar** (reuse existing scroll fraction), and a
  generic **"Reading focus"** toggle (bold the leading fraction of each word — NOT branded).

- **D3 — Compare with backup** *(backend + tests)* — we already write `<file>.docx.bak`
  on overwrite. Add "Compare with backup": extract paragraph text both sides, `difflib`
  → inline redline using D1's `<ins>/<del>` styling. *Zero new deps.*

- **D4 — Export to Markdown** *(backend + tests)* — `markdownify` (MIT, tiny) turns the
  rendered/edited HTML into `.md`; pairs with the existing print→PDF and adds an HTML
  export. Lands in the export hub, no new toolbar button.

- **D5 — *(optional, experimental)* Accept/reject to disk + AI-edits-as-tracked-changes** —
  `docx-revisions` (MIT, pure-Py — vet on real files, keep behind the `.bak` safety) to
  write accepted/rejected docs; and a standout reader-first combo: AI "fix grammar / rewrite"
  results land as **tracked insertions** the user reviews rather than auto-applied.

---

## 4. Track P — PPTX: make presentations real slides

> Layered design: a fast structural default that always works, plus an optional
> pixel-fidelity path when LibreOffice is present.

- **P1 — Slide-deck viewer** *(UI-led; backend already emits per-slide sections + outline)* —
  one slide at a time on an aspect-correct stage (`prs.slide_width/height` → `aspect-ratio`,
  `object-fit: contain` letterboxing), prev/next + **←/→/PageUp-Down/Home/End** keys, a
  "3 / 12" counter, **slide thumbnails** in the sidebar (reuse comic/PDF nav patterns),
  per-file "last slide" memory. Serve assets over Flask (pywebview dislikes `file://`).

- **P2 — Richer slide content (Tier 0 fidelity)** *(backend + tests)* — extend
  `_pptx_to_html()` to an **absolutely-positioned** layout from shape geometry
  (`left/top/width/height/rotation`, EMU→px), plus **tables**, **grouped shapes**
  (recursive child-offset remap), **pictures** in place, and slide **backgrounds**. Label
  it clearly as a faithful-but-approximate native render. *Zero new deps.*

- **P3 — Speaker notes + present mode** *(UI)* — a notes panel (`slide.notes_slide`,
  trivially extractable) and a fullscreen **Present** mode (Fullscreen API, black bg,
  one slide, keyboard-driven). One toolbar button for Present (mode discipline).

- **P4 — *(optional)* High-fidelity render** *(backend + tests, graceful)* — if `soffice`
  is detected: `soffice --headless --convert-to pdf` (per-call profile dir, timeout +
  process-kill, serialized) → rasterize with **PyMuPDF** (`get_pixmap` at 96–150 DPI;
  thumbnails downscaled; cache by file mtime+hash). The same viewer swaps the slide
  source from CSS-approximation to rendered image. Falls back to P2 silently; optional
  "Install LibreOffice for pixel-perfect slides" hint. **LibreOffice never bundled.**

---

## 5. Track X — XLSX: make spreadsheets a real grid

> Net new shipped dep: **one vendored JS file (`ssf.js`)**. Zero new Python packages.

- **X1 — Structured backend + sheet tabs + sticky grid** *(backend + tests, then UI)* —
  rewrite `_xlsx_to_html()` to return **structured JSON per sheet** (not pre-baked HTML):
  `name`, `dims`, `merged` (from `ws.merged_cells.ranges`), `freeze` (`ws.freeze_panes`),
  `colWidths`, `rowHeights`, and a `cells` array `{r,c,v,z(number_format),s(compact style)}`
  by iterating **cells** (not `values_only`). **IMPORTANT (verified):** open WITHOUT
  `read_only=True` — `merged_cells` and `freeze_panes` raise/aren't exposed on a
  `ReadOnlyWorksheet`. Non-read-only reads a capped 2000×60 sheet in ~1s, so the cap stays
  the safeguard. Frontend renders a `<table>` with **`position: sticky`** header row + first
  column, **sheet tabs**, and **merged cells** via `colspan`/`rowspan` (reuse the
  occupancy-grid logic already in `_emit_table`). Keep the 2000×60 cap + truncation note.

- **X2 — Number formats + cell styling (fidelity)** *(UI + small backend)* — vendor
  **`ssf.js`** (Apache-2.0) into `static/js/vendor/`; render each cell via
  `SSF.format(cell.z, cell.v)` (dates, currency, %, thousands). Apply compact style flags
  (bold/italic, alignment, explicit ARGB font/fill; defensively skip theme/indexed colors).
  Borders → CSS per side. Frozen-pane offsets drive the sticky positions.

- **X3 — Formula/value toggle + per-sheet search** *(small backend + UI)* — read cached
  values (`data_only=True`) by default; on demand also expose formula strings
  (`data_only=False`) so **one toggle button** swaps value ⇄ formula. Detect "formula with
  no cached value" (library-generated files) and show the formula rather than a blank.
  Scope the existing find/match-count engine to the active sheet; add jump-to-cell.

---

## 6. Cross-cutting / shared infrastructure

- **Sidebar tabs** — reuse the PDF/Office sidebar tab pattern for DOCX **Review**, PPTX
  **Slides/Thumbnails + Notes**, XLSX **Sheets** (the outline machinery already exists).
- **`doc.meta.render` gains `slides` and `sheet`** branches alongside `flow`/`unsupported`,
  so DOCX's flow renderer is untouched while PPTX/XLSX get purpose-built views.
- **Optional-tool detection** — a single reusable "is `soffice` available?" probe (PATH +
  standard install dirs, cached), shared by any high-fidelity path.
- **Restart rules** (per `CLAUDE.md`): editing `app.py`/`renderers/*.py` → restart Flask;
  static JS/CSS → browser reload only.
- **Security/privacy** — opening arbitrary files is the core job: validate paths, never
  trust formula content (no evaluator), fail-open on parser errors, scratch to OS temp,
  no secrets in the repo.

---

## 7. Suggested sequencing (one focused chunk at a time)

Recommended order — biggest broken→fixed delta first, cheapest-high-value within each track:

1. **P1** Slide-deck viewer (PPTX feels like slides) — mostly frontend, high visible win.
2. **P2** Richer slide content (Tier 0 layout fidelity).
3. **X1** XLSX structured backend + sheet tabs + sticky grid.
4. **X2** Number formats + cell styling.
5. **D1** Tracked-changes & comments display (turns "lossy" warnings into features).
6. **P3** Speaker notes + present mode.
7. **X3** Formula/value toggle + per-sheet search.
8. **D2** Reading aids (OpenDyslexic, reading time, themes, focus, progress).
9. **D3** Compare with backup (difflib redline).
10. **D4** Export to Markdown.
11. **P4** *(optional)* LibreOffice high-fidelity slide render.
12. **D5** *(optional)* accept/reject to disk + AI-edits-as-tracked-changes.

Each chunk: backend + pytest first where there's logic, then UI, `node --check` on JS,
verify in the browser, **red-team before calling it done**. One chunk per session.

---

## 8. Verification approach (per chunk)

- **Backend:** extend `tests/` (alongside `test_office.py`) with fixtures via
  `make_samples.py`. PPTX: a deck with a table, grouped shapes, a picture, notes, 4:3 + 16:9.
  XLSX: merged header, date/currency/percent formats, a frozen pane, a formula with AND
  without a cached value, >2000 rows (truncation), `.xlsm`. DOCX: a file with tracked
  changes + comments, multi-author revisions.
- **Frontend:** `node --check`, then drive the real app (browser/puppeteer) — slide nav +
  thumbnails + present; sheet tabs + sticky + merged + formats + formula toggle; review
  tab + markup toggle.
- **Hostile inputs:** corrupt/locked files, theme-only colors, empty value cache, missing
  notes, password-protected, legacy `.doc/.ppt/.xls` (must still route to the graceful
  "unsupported" screen).

---

## 9. Footprint summary

- **Shipped additions:** `ssf.js` (Apache-2.0, ~tiny), OpenDyslexic woff2 (OFL),
  `markdownify` (MIT, pure-Py). **No new heavyweight packages.**
- **Optional/auto-detected:** LibreOffice (MPL-2.0, external, never bundled),
  `docx-revisions` (MIT, experimental).
- **Reused:** python-pptx, openpyxl, python-docx, mammoth, lxml, PyMuPDF, difflib (stdlib),
  the existing LLM client, sidebar/find/read-aloud/annotation machinery.

This keeps the Office suite **native, lean, free, and AGPL-safe** while closing the real
gaps: PPTX becomes a proper slide viewer, XLSX becomes a real styled grid, and DOCX gains
the review + reading-comfort depth its strong editing base has been missing.
