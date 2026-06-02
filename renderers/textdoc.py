"""
YancoRead — Text / Markdown / code renderer.

    .md/.markdown → rendered HTML (+ raw toggle on the frontend) + heading outline
    source code   → Pygments syntax highlight (classed HTML + a style sheet)
    everything else that sniffs as text → escaped <pre>
"""

import html
import io
import logging
import re
from pathlib import Path

logger = logging.getLogger('yancoread.textdoc')

_MD_EXTS = {'.md', '.markdown', '.mdown', '.mkd'}
_PLAIN_EXTS = {'.txt', '.text', '.log', '.rst', '.org', ''}
_MAX_BYTES = 4 * 1024 * 1024  # 4 MB cap on what we load into the DOM

# Generated once: Pygments style sheet for the 'monokai' dark theme.
_PYGMENTS_CSS = None


def _read_full(path: str):
    """Read text with encoding fallback.

    Returns (text, truncated, meta) where meta carries what the editor needs to
    round-trip the file faithfully: {encoding, bom, eol}.
    """
    raw = Path(path).read_bytes()
    truncated = len(raw) > _MAX_BYTES
    if truncated:
        raw = raw[:_MAX_BYTES]
    bom = raw.startswith(b'\xef\xbb\xbf')
    text, encoding = None, 'utf-8'
    for enc in ('utf-8-sig', 'utf-8', 'latin-1'):
        try:
            text = raw.decode(enc)
            encoding = 'utf-8' if enc == 'utf-8-sig' else enc
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = raw.decode('utf-8', errors='replace')
    eol = 'crlf' if '\r\n' in text else 'lf'
    return text, truncated, {'encoding': encoding, 'bom': bom, 'eol': eol}


def _pygments_css() -> str:
    global _PYGMENTS_CSS
    if _PYGMENTS_CSS is None:
        from pygments.formatters import HtmlFormatter
        _PYGMENTS_CSS = HtmlFormatter(style='monokai').get_style_defs('.highlight')
    return _PYGMENTS_CSS


def _highlight_code(text: str, filename: str) -> dict:
    from pygments import highlight
    from pygments.formatters import HtmlFormatter
    from pygments.lexers import get_lexer_for_filename, guess_lexer
    from pygments.util import ClassNotFound

    try:
        lexer = get_lexer_for_filename(filename, text)
    except ClassNotFound:
        try:
            lexer = guess_lexer(text)
        except ClassNotFound:
            from pygments.lexers.special import TextLexer
            lexer = TextLexer()

    formatter = HtmlFormatter(linenos='table', cssclass='highlight')
    body = highlight(text, lexer, formatter)
    return {
        'mode': 'code',
        'html': body,
        'css': _pygments_css(),
        'lang': getattr(lexer, 'name', 'Text'),
    }


def _render_markdown(text: str) -> dict:
    import markdown
    md = markdown.Markdown(
        extensions=['fenced_code', 'tables', 'toc', 'sane_lists', 'nl2br'])
    body = md.convert(text)

    outline = []
    # python-markdown's 'toc' extension exposes a structured token tree.
    for item in getattr(md, 'toc_tokens', []):
        _flatten_toc(item, outline, level=1)

    return {
        'mode': 'markdown',
        'html': f'<article class="doc-page markdown-body" dir="auto">{body}</article>',
        'outline': outline,
        'raw': text,
    }


def _flatten_toc(item, out, level):
    out.append({'title': item.get('name', ''), 'anchor': item.get('id', ''),
                'level': level})
    for child in item.get('children', []):
        _flatten_toc(child, out, level + 1)


def render_text(text: str, name: str = '', ext=None) -> dict:
    """Render already-in-memory text the same way a file would render.

    Used by the live editor preview and by the view-refresh after an edit, so
    they stay byte-for-byte consistent with how the file first opened.
    """
    if ext is None:
        ext = Path(name).suffix
    ext = (ext or '').lower()
    if ext in _MD_EXTS:
        return _render_markdown(text)
    if ext in _PLAIN_EXTS:
        return {'mode': 'plain',
                'html': f'<pre class="plain-text" dir="auto">{html.escape(text)}</pre>'}
    return _highlight_code(text, name or ('file' + ext))


def to_html(path: str) -> dict:
    """Render a text-like file. Returns a dict with at least {mode, html}.

    Also reports edit metadata: ``raw`` (the source text), ``editable`` (False
    for files truncated by the size cap — saving those would lose data), and the
    ``encoding``/``bom``/``eol`` needed to write the file back faithfully.
    """
    p = Path(path)
    text, truncated, meta = _read_full(path)
    result = render_text(text, p.name, p.suffix)
    result['raw'] = text
    result['truncated'] = truncated
    result['editable'] = not truncated
    result.update(meta)
    return result


# ── export (HTML / PDF) ──────────────────────────────────────────────────────
# A print-friendly stylesheet: light page, readable body, boxed code. Kept
# self-contained so an exported .html opens identically anywhere, and so the PDF
# (built from the same HTML via MuPDF's Story engine) matches the .html output.
_EXPORT_CSS = """
body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6; color: #1a2230; max-width: 820px; margin: 0 auto;
  padding: 24px; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.1em 0 0.5em; }
h1 { font-size: 1.9em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
p { margin: 0 0 1em; }
a { color: #0a7d72; }
pre { background: #f4f6fa; border: 1px solid #e1e8f0; padding: 12px 14px;
  border-radius: 6px; overflow-x: auto; }
pre, code { font-family: "Cascadia Code", Consolas, "Courier New", monospace;
  font-size: 13px; }
:not(pre) > code { background: #eef2f7; padding: 1px 5px; border-radius: 4px; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #cfd8e3; padding: 6px 10px; text-align: left; }
th { background: #eef3f8; }
blockquote { border-left: 3px solid #9aa7b8; margin: 1em 0; padding: 0.2em 1em;
  color: #475266; }
ul, ol { margin: 0 0 1em 1.4em; }
img { max-width: 100%; height: auto; }
"""


def build_export_html(text: str, name: str = '') -> str:
    """Render ``text`` to a standalone, print-friendly HTML document.

    Markdown is rendered to HTML; source code is escaped in a <pre> (we drop the
    Pygments dark theme here so it prints legibly on a white page); plain text is
    escaped in a <pre>.
    """
    ext = Path(name).suffix.lower()
    if ext in _MD_EXTS:
        import markdown
        md = markdown.Markdown(
            extensions=['fenced_code', 'tables', 'toc', 'sane_lists'])
        inner = md.convert(text)
    else:
        inner = f'<pre>{html.escape(text)}</pre>'
    title = html.escape(name or 'Document')
    return ('<!DOCTYPE html><html><head><meta charset="utf-8">'
            f'<title>{title}</title><style>{_EXPORT_CSS}</style></head>'
            f'<body>{inner}</body></html>')


def to_pdf_bytes(full_html: str) -> bytes:
    """Paginate an HTML document into PDF bytes via MuPDF's Story engine."""
    import fitz
    story = fitz.Story(html=full_html)
    buf = io.BytesIO()
    writer = fitz.DocumentWriter(buf)
    mediabox = fitz.paper_rect('letter')
    where = mediabox + (54, 54, -54, -54)   # ~0.75in margins
    more = 1
    while more:
        dev = writer.begin_page(mediabox)
        more, _ = story.place(where)
        story.draw(dev)
        writer.end_page()
    writer.close()
    return buf.getvalue()
