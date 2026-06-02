# Vendored third-party assets

## ssf.js

- **What:** SheetJS `ssf` (SpreadSheet Format) — formats numbers/dates with
  Excel number-format codes (`#,##0.00`, `0.0%`, `yyyy-mm-dd`, …).
- **Version:** 0.11.2
- **License:** Apache-2.0 (compatible with this project's AGPL-3.0 — Apache-2.0
  is one-way compatible with AGPL-3.0).
- **Source:** https://www.npmjs.com/package/ssf  ·  https://sheetjs.com
- **Used by:** the XLSX sticky-grid viewer (`static/js/readers/office.js`,
  `mountSheet`) to render cell values via `SSF.format(numberFormat, value)`.

The file is vendored **verbatim** (unmodified) so the upstream copyright header
and behavior are preserved. It defines a global `SSF` when loaded as a plain
`<script>`.
