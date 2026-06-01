"""
YancoRead — Office renderer (docx / pptx / xlsx → HTML).

Everything is converted to self-contained HTML (images inlined as data URIs)
so the frontend just drops it into the reading pane. Each format also yields a
navigable outline:
    docx  → headings
    pptx  → one entry per slide
    xlsx  → one entry per sheet
"""

import base64
import html
import logging
import re
import zipfile
from pathlib import Path

logger = logging.getLogger('yancoread.officedoc')

# Safety caps so a pathological spreadsheet can't produce a 200MB page.
_XLSX_MAX_ROWS = 2000
_XLSX_MAX_COLS = 60


# ── DOCX ──────────────────────────────────────────────────────────────────────
# Map Word's Title/Subtitle paragraph styles to classes the editor styles and
# the save path maps back to those Word styles, so they round-trip both ways.
# Appended to mammoth's built-in heading/list defaults.
_MAMMOTH_STYLE_MAP = "\n".join([
    "p[style-name='Title'] => p.doc-title:fresh",
    "p[style-name='Subtitle'] => p.doc-subtitle:fresh",
])

# Known page sizes (portrait W×H in inches) for normalising a section's size to
# a friendly label the editor's Page Setup can show. Anything else → 'custom'.
_PAGE_SIZES = {
    'letter': (8.5, 11.0),
    'legal': (8.5, 14.0),
    'a4': (8.27, 11.69),
    'a3': (11.69, 16.54),
    'tabloid': (11.0, 17.0),
}


def _match_page_size(w_in, h_in) -> str:
    """Map (width, height) inches to a known size label, orientation-agnostic."""
    if not w_in or not h_in:
        return 'custom'
    lo, hi = sorted((w_in, h_in))
    for key, (pw, ph) in _PAGE_SIZES.items():
        if abs(lo - pw) < 0.06 and abs(hi - ph) < 0.06:
            return key
    return 'custom'


def _docx_page_setup(path: str):
    """Read section 0's page size / orientation / margins for the editor.

    Returns a dict (size, orientation, width_in, height_in, margins{}) or None
    if it can't be read — the editor falls back to its default page geometry.
    """
    try:
        from docx import Document
        from docx.enum.section import WD_ORIENT
        d = Document(path)
        if not d.sections:
            return None
        s = d.sections[0]

        def inch(v):
            try:
                return round(v.inches, 3)
            except Exception:
                return None

        w, h = inch(s.page_width), inch(s.page_height)
        landscape = (s.orientation == WD_ORIENT.LANDSCAPE) or bool(w and h and w > h)
        return {
            'size': _match_page_size(w, h),
            'orientation': 'landscape' if landscape else 'portrait',
            'width_in': w, 'height_in': h,
            'margins': {
                'top': inch(s.top_margin), 'bottom': inch(s.bottom_margin),
                'left': inch(s.left_margin), 'right': inch(s.right_margin),
            },
        }
    except Exception as e:                                       # pragma: no cover
        logger.debug("page-setup read failed for %s: %s", path, e)
        return None


def _read_hf(hf) -> dict:
    """Plain text + a page-number flag for one header/footer container.

    We only surface what the editor can faithfully round-trip: the literal text
    and whether a PAGE field is present (the live number is left to Word). Rich
    content — tables, images, tab-stops — is reported by the fidelity scan.
    """
    try:
        paras = list(hf.paragraphs)
    except Exception:
        return {'text': '', 'page_num': False}
    lines, page_num = [], False
    for p in paras:
        try:
            xml = p._p.xml
        except Exception:
            xml = ''
        if 'PAGE' in xml and ('instrText' in xml or 'fldSimple' in xml):
            page_num = True
        lines.append(p.text)
    return {'text': '\n'.join(lines).strip('\n'), 'page_num': page_num}


def _docx_headers_footers(path: str):
    """Section-0 primary header/footer for the editor, or None if unreadable."""
    try:
        from docx import Document
        d = Document(path)
        if not d.sections:
            return None
        s = d.sections[0]
        return {'header': _read_hf(s.header), 'footer': _read_hf(s.footer)}
    except Exception as e:                                       # pragma: no cover
        logger.debug("header/footer read failed for %s: %s", path, e)
        return None


# Mammoth renders a footnote reference inline as
#   <sup><a href="#footnote-N" id="footnote-ref-N">[N]</a></sup>
# and appends a trailing <ol> whose items carry id="footnote-N". We rewrite both
# into a compact, editable shape the save path can turn back into a real
# footnotes part — markers become <sup class="fn-ref">, the list a section.
_FN_REF_RE = re.compile(
    r'(?:<sup>\s*)*<a\s+href="#footnote-(\d+)"\s+id="footnote-ref-\d+"\s*>'
    r'.*?</a>(?:\s*</sup>)*', re.DOTALL)
_FN_LIST_RE = re.compile(
    r'<ol>\s*((?:<li id="footnote-\d+">.*?</li>\s*)+)</ol>', re.DOTALL)
_FN_ITEM_RE = re.compile(r'<li id="footnote-(\d+)">(.*?)</li>', re.DOTALL)
_FN_BACKLINK_RE = re.compile(r'\s*<a\s+href="#footnote-ref-\d+"\s*>.*?</a>', re.DOTALL)


def _transform_footnotes(body: str) -> str:
    """Rewrite mammoth's footnote markup into the editor's round-trip shape.

    The trailing footnote list becomes ``<section class="doc-footnotes">`` (the
    back-link arrows are dropped) and every in-text reference becomes
    ``<sup class="fn-ref" data-fn-id="N">N</sup>``. A document with no footnotes
    is returned unchanged.
    """
    if 'id="footnote-' not in body:
        return body

    def _section(m):
        items = []
        for it in _FN_ITEM_RE.finditer(m.group(1)):
            inner = _FN_BACKLINK_RE.sub('', it.group(2)).strip()
            items.append(f'<li class="fn-item" data-fn-id="{it.group(1)}">{inner}</li>')
        if not items:
            return m.group(0)
        return ('<section class="doc-footnotes" data-doc-footnotes="1">'
                '<ol class="fn-list">' + ''.join(items) + '</ol></section>')

    body = _FN_LIST_RE.sub(_section, body)
    body = _FN_REF_RE.sub(
        r'<sup class="fn-ref" data-fn-id="\1" contenteditable="false">\1</sup>', body)
    return body


def _docx_to_html(path: str) -> dict:
    import mammoth
    with open(path, 'rb') as fh:
        result = mammoth.convert_to_html(fh, style_map=_MAMMOTH_STYLE_MAP)
    body = _transform_footnotes(result.value)

    # Inject ids into headings and collect an outline.
    outline = []
    counter = {'n': 0}

    def _add_id(m):
        tag, attrs, inner = m.group(1), m.group(2), m.group(3)
        counter['n'] += 1
        anchor = f'h-{counter["n"]}'
        title = re.sub(r'<[^>]+>', '', inner).strip()
        level = int(tag[1])
        if title:
            outline.append({'title': title, 'anchor': anchor, 'level': level})
        return f'<{tag}{attrs} id="{anchor}">{inner}</{tag}>'

    body = re.sub(r'<(h[1-6])([^>]*)>(.*?)</\1>', _add_id, body, flags=re.DOTALL)
    # Page geometry and the primary header/footer travel together as one
    # "document structure" payload the editor threads back on save.
    page = _docx_page_setup(path)
    hf = _docx_headers_footers(path)
    if hf:
        page = (page or {})
        page.update(hf)
    return {
        'html': f'<article class="doc-page docx">{body}</article>',
        'outline': outline,
        'fidelity': detect_docx_fidelity(path),
        'page': page,
    }


def _hf_is_simple(xml: str) -> bool:
    """True when a header/footer holds only plain text and at most a page-number
    field — exactly what the Tier-4b rebuild reproduces. Tables, images, legacy
    shapes, embedded objects, tab-stops (multi-column layouts) or any field
    other than PAGE/NUMPAGES make it rich, so the rebuild would drop something.
    """
    if re.search(r'<w:(tbl|drawing|pict)[ />]', xml):
        return False
    if '<v:' in xml or '<w:object' in xml:        # legacy VML / OLE object
        return False
    if '<w:tab' in xml:                           # tab stops → multi-column header
        return False
    codes = re.findall(r'<w:instrText[^>]*>(.*?)</w:instrText>', xml, re.DOTALL)
    codes += re.findall(r'w:instr="([^"]*)"', xml)
    for c in codes:
        token = (c.strip().upper().split() or [''])[0]
        if token not in ('PAGE', 'NUMPAGES'):
            return False
    return True


def _footnotes_are_simple(xml: str) -> bool:
    """True when footnotes.xml holds only plain-text notes — exactly what the
    Tier-4c rebuild reproduces (text + reference marks, across one or more
    paragraphs). Tables, images, legacy shapes, embedded objects, hyperlinks or
    fields make a note rich, so the rebuild would drop something.
    """
    if re.search(r'<w:(tbl|drawing|pict)[ />]', xml):
        return False
    if '<v:' in xml or '<w:object' in xml or '<w:hyperlink' in xml:
        return False
    if re.search(r'<w:(instrText|fldSimple|fldChar)[ >]', xml):
        return False
    return True


# Features the HTML-rebuild save path cannot reproduce. Detecting them lets the
# editor warn precisely and steer the user to "Save As" instead of a lossy
# overwrite. Plain inline images are NOT flagged — mammoth surfaces them and the
# converter re-embeds them, so they round-trip fine.
def detect_docx_fidelity(path: str) -> dict:
    """Scan a .docx for structure the editor can't rewrite.

    Returns ``{'lossy': bool, 'features': [str, ...]}``. Never raises — a scan
    failure simply reports nothing lost (the generic .bak warning still applies).
    """
    features: list[str] = []
    try:
        with zipfile.ZipFile(path) as z:
            names = set(z.namelist())

            def _read(name: str) -> str:
                try:
                    return z.read(name).decode('utf-8', 'replace')
                except Exception:
                    return ''

            # Headers / footers — a single plain-text primary header/footer now
            # round-trips (Tier 4b), so flag only what the rebuild still drops:
            # rich content, or first-page/even-page variants (>1 texty part).
            hdr = [_read(n) for n in names if re.match(r'word/header\d*\.xml$', n)]
            ftr = [_read(n) for n in names if re.match(r'word/footer\d*\.xml$', n)]
            hdr_texty = [x for x in hdr if '<w:t' in x]
            ftr_texty = [x for x in ftr if '<w:t' in x]
            if (len(hdr_texty) > 1 or len(ftr_texty) > 1
                    or any(not _hf_is_simple(x) for x in hdr_texty + ftr_texty)):
                features.append('Headers & footers')

            # Footnotes — plain-text notes now round-trip (Tier 4c); flag only
            # rich content. Endnotes aren't rebuilt, so any note text is lossy.
            # (Default parts hold only separators, so <w:t> means real notes.)
            fn_xml = _read('word/footnotes.xml')
            if '<w:t' in fn_xml and not _footnotes_are_simple(fn_xml):
                features.append('Footnotes')
            if '<w:t' in _read('word/endnotes.xml'):
                features.append('Endnotes')

            doc_xml = _read('word/document.xml')
            if 'word/comments.xml' in names:
                features.append('Comments')
            if re.search(r'<w:(ins|del)[ >]', doc_xml):
                features.append('Tracked changes')
            if doc_xml.count('<w:sectPr') > 1:
                features.append('Multiple sections')
            if re.search(r'<w:cols[^>]*w:num="(?:[2-9]|\d\d+)"', doc_xml):
                features.append('Columns')
            if '<w:fldChar' in doc_xml or '<w:instrText' in doc_xml:
                features.append('Fields / table of contents')
            if '<w:pict' in doc_xml or 'v:textbox' in doc_xml or 'wps:txbx' in doc_xml:
                features.append('Text boxes / shapes')
            if any(n.startswith('word/embeddings/') for n in names):
                features.append('Embedded objects')
    except Exception as e:                                   # pragma: no cover
        logger.debug("fidelity scan failed for %s: %s", path, e)
        return {'lossy': False, 'features': []}

    seen: list[str] = []
    for f in features:
        if f not in seen:
            seen.append(f)
    return {'lossy': bool(seen), 'features': seen}


# ── PPTX ──────────────────────────────────────────────────────────────────────
def _pptx_to_html(path: str) -> dict:
    from pptx import Presentation
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    prs = Presentation(path)
    slides_html = []
    outline = []

    for i, slide in enumerate(prs.slides, start=1):
        anchor = f'slide-{i}'
        title_text = ''
        if slide.shapes.title and slide.shapes.title.has_text_frame:
            title_text = slide.shapes.title.text.strip()
        outline.append({'title': title_text or f'Slide {i}', 'anchor': anchor, 'level': 1})

        parts = [f'<header class="slide-num">Slide {i}</header>']
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                is_title = (shape == slide.shapes.title)
                tag = 'h2' if is_title else 'p'
                for para in shape.text_frame.paragraphs:
                    txt = ''.join(run.text for run in para.runs) or para.text
                    if txt.strip():
                        parts.append(f'<{tag}>{html.escape(txt)}</{tag}>')
            elif shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                try:
                    img = shape.image
                    b64 = base64.b64encode(img.blob).decode('ascii')
                    parts.append(
                        f'<img alt="" src="data:{img.content_type};base64,{b64}">')
                except Exception as e:
                    logger.debug("pptx image extract failed: %s", e)

        slides_html.append(
            f'<section class="slide" id="{anchor}">' + '\n'.join(parts) + '</section>')

    body = '\n'.join(slides_html)
    return {'html': f'<article class="doc-page pptx">{body}</article>',
            'outline': outline}


# ── XLSX ──────────────────────────────────────────────────────────────────────
def _xlsx_to_html(path: str) -> dict:
    from openpyxl import load_workbook
    wb = load_workbook(path, read_only=True, data_only=True)
    sheets_html = []
    outline = []

    for ws in wb.worksheets:
        anchor = 'sheet-' + re.sub(r'\W+', '-', ws.title)
        outline.append({'title': ws.title, 'anchor': anchor, 'level': 1})

        rows_html = []
        truncated = False
        for r, row in enumerate(ws.iter_rows(values_only=True)):
            if r >= _XLSX_MAX_ROWS:
                truncated = True
                break
            cells = row[:_XLSX_MAX_COLS]
            tag = 'th' if r == 0 else 'td'
            tds = ''.join(
                f'<{tag}>{html.escape("" if v is None else str(v))}</{tag}>'
                for v in cells)
            rows_html.append(f'<tr>{tds}</tr>')

        note = ('<p class="trunc">Showing first '
                f'{_XLSX_MAX_ROWS} rows…</p>') if truncated else ''
        sheets_html.append(
            f'<section class="sheet" id="{anchor}">'
            f'<h2>{html.escape(ws.title)}</h2>'
            f'<div class="sheet-scroll"><table>{"".join(rows_html)}</table></div>'
            f'{note}</section>')

    wb.close()
    body = '\n'.join(sheets_html)
    return {'html': f'<article class="doc-page xlsx">{body}</article>',
            'outline': outline}


# ── dispatch ────────────────────────────────────────────────────────────────
def to_html(path: str) -> dict:
    """Render an office document to {html, outline}."""
    ext = Path(path).suffix.lower()
    if ext == '.docx':
        return _docx_to_html(path)
    if ext == '.pptx':
        return _pptx_to_html(path)
    if ext == '.xlsx':
        return _xlsx_to_html(path)
    raise ValueError(f'Unsupported office format: {ext}')


# ── HTML → DOCX (editor write-back) ───────────────────────────────────────────
# A focused, native converter that maps the rich-text editor's HTML straight to
# a .docx. We own both sides (the contenteditable output and this parser), so we
# can guarantee fidelity for exactly the formatting the editor exposes — fonts,
# sizes, colours, highlight, bold/italic/underline/strike, alignment, line
# spacing, headings, lists, links, tables and inline images — with no extra
# dependency (python-docx + lxml are already present via the readers above).

_BLOCK_TAGS = {
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre',
    'section', 'article', 'header', 'figure', 'ul', 'ol',
}
_HEADING_STYLE = {
    'h1': 'Heading 1', 'h2': 'Heading 2', 'h3': 'Heading 3',
    'h4': 'Heading 4', 'h5': 'Heading 5', 'h6': 'Heading 6',
}


def _style_map(el) -> dict:
    raw = el.get('style') or ''
    out = {}
    for part in raw.split(';'):
        if ':' in part:
            k, v = part.split(':', 1)
            out[k.strip().lower()] = v.strip()
    return out


def _parse_color(v):
    from docx.shared import RGBColor
    if not v:
        return None
    v = v.strip().lower()
    try:
        if v.startswith('#'):
            h = v[1:]
            if len(h) == 3:
                h = ''.join(c * 2 for c in h)
            if len(h) >= 6:
                return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
        m = re.match(r'rgba?\(([^)]+)\)', v)
        if m:
            nums = [p.strip() for p in m.group(1).split(',')]
            r, g, b = (int(round(float(nums[i]))) for i in range(3))
            return RGBColor(max(0, min(255, r)), max(0, min(255, g)), max(0, min(255, b)))
        named = {
            'black': '000000', 'white': 'ffffff', 'red': 'ff0000', 'green': '008000',
            'blue': '0000ff', 'yellow': 'ffff00', 'gray': '808080', 'grey': '808080',
            'orange': 'ffa500', 'purple': '800080',
        }
        if v in named:
            h = named[v]
            return RGBColor(int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except Exception:
        return None
    return None


def _parse_pt(v):
    if not v:
        return None
    v = v.strip().lower()
    try:
        if v.endswith('pt'):
            return float(v[:-2])
        if v.endswith('px'):
            return round(float(v[:-2]) * 0.75, 1)
        if v.endswith('em'):
            return round(float(v[:-2]) * 12.0, 1)
        if v.endswith('%'):
            return round(float(v[:-1]) / 100.0 * 12.0, 1)
        return float(v)
    except ValueError:
        return None


def _ctx_from(el, ctx: dict) -> dict:
    """Derive an inline-formatting context from an element's tag + inline CSS."""
    c = dict(ctx)
    tag = el.tag.lower() if isinstance(el.tag, str) else ''
    if tag in ('b', 'strong'):
        c['bold'] = True
    if tag in ('i', 'em'):
        c['italic'] = True
    if tag == 'u':
        c['underline'] = True
    if tag in ('s', 'strike', 'del'):
        c['strike'] = True
    if tag == 'sup':
        c['sup'] = True
    if tag == 'sub':
        c['sub'] = True
    if tag == 'font':
        if el.get('face'):
            c['font'] = el.get('face')
        if el.get('color'):
            col = _parse_color(el.get('color'))
            if col is not None:
                c['color'] = col

    sd = _style_map(el)
    fw = sd.get('font-weight', '')
    if fw == 'bold' or (fw.isdigit() and int(fw) >= 600):
        c['bold'] = True
    elif fw in ('normal', '400'):
        c['bold'] = False
    fs = sd.get('font-style')
    if fs == 'italic':
        c['italic'] = True
    elif fs == 'normal':
        c['italic'] = False
    deco = (sd.get('text-decoration', '') + ' ' + sd.get('text-decoration-line', ''))
    if 'underline' in deco:
        c['underline'] = True
    if 'line-through' in deco:
        c['strike'] = True
    if sd.get('color'):
        col = _parse_color(sd['color'])
        if col is not None:
            c['color'] = col
    bg = sd.get('background-color') or sd.get('background')
    if bg:
        col = _parse_color(bg)
        if col is not None:
            c['highlight'] = col
    if sd.get('font-family'):
        c['font'] = sd['font-family'].split(',')[0].strip().strip('\'"')
    if sd.get('font-size'):
        pt = _parse_pt(sd['font-size'])
        if pt:
            c['size'] = pt
    va = sd.get('vertical-align')
    if va == 'super':
        c['sup'] = True
    elif va == 'sub':
        c['sub'] = True
    return c


def _shade_run(run, rgb):
    """Apply a background fill (text highlight) to a run via w:shd."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    rpr = run._element.get_or_add_rPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), str(rgb))
    rpr.append(shd)


def _add_run(p, text, ctx):
    from docx.shared import Pt
    if not text:
        return
    # Drop pure-whitespace segments that are just HTML pretty-printing.
    if not text.strip() and ('\n' in text or '\t' in text):
        return
    text = text.replace('\n', ' ').replace('\t', ' ').replace('\xa0', ' ')
    r = p.add_run(text)
    f = r.font
    if ctx.get('bold'):
        r.bold = True
    if ctx.get('italic'):
        r.italic = True
    if ctx.get('underline'):
        r.underline = True
    if ctx.get('strike'):
        f.strike = True
    if ctx.get('font'):
        f.name = ctx['font']
    if ctx.get('size'):
        f.size = Pt(ctx['size'])
    if ctx.get('color') is not None:
        f.color.rgb = ctx['color']
    if ctx.get('sup'):
        f.superscript = True
    if ctx.get('sub'):
        f.subscript = True
    if ctx.get('highlight') is not None:
        _shade_run(r, ctx['highlight'])


_CONTENT_WIDTH_IN = 6.5      # usual letter page minus 1" margins


def _css_length(value):
    """Parse a CSS length (``%``, ``px``, ``cm``, ``in`` or bare px) into a docx
    Length, or None. Percent is taken as a fraction of the text column width."""
    from docx.shared import Cm, Inches
    w = (value or '').strip().lower()
    if not w:
        return None
    try:
        if w.endswith('%'):
            return Inches(_CONTENT_WIDTH_IN * float(w[:-1]) / 100.0)
        if w.endswith('px'):
            return Inches(float(w[:-2]) / 96.0)
        if w.endswith('cm'):
            return Cm(float(w[:-2]))
        if w.endswith('in'):
            return Inches(float(w[:-2]))
        return Inches(float(w) / 96.0)
    except ValueError:
        return None


def _img_width(el):
    """Explicit display width for an <img>, from CSS width or the width attr."""
    return _css_length(_style_map(el).get('width') or el.get('width') or '')


def _set_image_alt(shape, alt):
    """Set an inline image's alt text (the drawing's docPr descr/title)."""
    from docx.oxml.ns import qn
    docPr = shape._inline.find(qn('wp:docPr'))
    if docPr is not None:
        docPr.set('descr', alt)
        docPr.set('title', alt)


def _add_image(p, el):
    import base64
    import io
    from docx.shared import Inches
    src = el.get('src', '')
    if not src.startswith('data:'):
        return
    try:
        _, b64 = src.split(',', 1)
        data = base64.b64decode(b64)
        run = p.add_run()
        shape = run.add_picture(io.BytesIO(data))
        want = _img_width(el)
        max_w = Inches(6.0)
        if want is not None and shape.width:
            ratio = int(want) / shape.width
            shape.height = int(shape.height * ratio)
            shape.width = int(want)
        elif shape.width and shape.width > max_w:
            ratio = max_w / shape.width
            shape.height = int(shape.height * ratio)
            shape.width = max_w
        alt = (el.get('alt') or '').strip()
        if alt:
            _set_image_alt(shape, alt)
    except Exception as e:
        logger.debug("docx image embed failed: %s", e)


_HYPERLINK_RELTYPE = (
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'
)


def _add_hyperlink(p, url, el, ctx):
    """Insert a real Word hyperlink (``w:hyperlink`` + external relationship)
    wrapping the link's inline content. Falls back to leaving the styled runs
    in place if the relationship can't be created."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    from docx.shared import RGBColor

    lctx = dict(ctx)
    lctx.setdefault('color', RGBColor(0x0B, 0x66, 0xC2))
    lctx['underline'] = True

    before = {id(c) for c in p._p}
    _render_inline(el, lctx, p)
    new_runs = [c for c in p._p
                if id(c) not in before and c.tag == qn('w:r')]
    if not new_runs:
        return
    try:
        r_id = p.part.relate_to(url, _HYPERLINK_RELTYPE, is_external=True)
    except Exception as e:                       # pragma: no cover - defensive
        logger.debug("hyperlink relationship failed: %s", e)
        return  # the runs are already styled like a link — good enough
    hyperlink = OxmlElement('w:hyperlink')
    hyperlink.set(qn('r:id'), r_id)
    new_runs[0].addprevious(hyperlink)
    for r in new_runs:
        hyperlink.append(r)          # lxml append reparents the run element


def _place_child(p, child, ctx) -> bool:
    """Render one inline child into paragraph p. Returns False for block nodes."""
    from docx.shared import RGBColor
    if not isinstance(child.tag, str):
        return True  # comments / processing instructions
    tag = child.tag.lower()
    if tag == 'sup' and child.get('data-fn-final-id'):
        _add_footnote_ref(p, child.get('data-fn-final-id'))
    elif tag == 'br':
        p.add_run().add_break()
    elif tag == 'img':
        _add_image(p, child)
    elif tag in _BLOCK_TAGS or tag == 'table':
        return False
    elif tag == 'a':
        href = (child.get('href') or '').strip()
        if href and not href.lower().startswith('javascript:'):
            _add_hyperlink(p, href, child, ctx)
        else:
            cctx = _ctx_from(child, ctx)
            cctx.setdefault('color', RGBColor(0x0B, 0x66, 0xC2))
            cctx['underline'] = True
            _render_inline(child, cctx, p)
    else:
        _render_inline(child, _ctx_from(child, ctx), p)
    return True


def _render_inline(el, ctx, p):
    if el.text:
        _add_run(p, el.text, ctx)
    for child in el:
        _place_child(p, child, ctx)
        if child.tail:
            _add_run(p, child.tail, ctx)


def _apply_para_format(p, sd):
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt
    ta = sd.get('text-align')
    align = {
        'left': WD_ALIGN_PARAGRAPH.LEFT, 'center': WD_ALIGN_PARAGRAPH.CENTER,
        'right': WD_ALIGN_PARAGRAPH.RIGHT, 'justify': WD_ALIGN_PARAGRAPH.JUSTIFY,
    }.get(ta)
    if align is not None:
        p.alignment = align
    lh = sd.get('line-height')
    if lh:
        try:
            p.paragraph_format.line_spacing = float(lh)
        except ValueError:
            pt = _parse_pt(lh)
            if pt:
                p.paragraph_format.line_spacing = Pt(pt)


def _cell_spans(cell):
    """(colspan, rowspan) for an HTML cell, each clamped to >= 1."""
    def _i(name):
        try:
            return max(1, int(cell.get(name, '1')))
        except (TypeError, ValueError):
            return 1
    return _i('colspan'), _i('rowspan')


def _cell_width(cell):
    """Explicit cell width as a docx Length, or None. Accepts %, px, cm, in."""
    return _css_length(_style_map(cell).get('width') or cell.get('width') or '')


def _set_repeat_header(row):
    """Mark a table row as a heading that repeats atop each page (w:tblHeader)."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    trPr = row._tr.get_or_add_trPr()
    th = OxmlElement('w:tblHeader')
    th.set(qn('w:val'), 'true')
    trPr.append(th)


def _render_cell(html_cell, cell, base):
    """Render a td/th's content into a docx table cell.

    Editor and mammoth markup wrap cell text in block tags (``<p>``, headings,
    lists), so inline-only rendering would silently drop it. The cell's
    pre-existing empty paragraph is reused for the first block to avoid a blank
    leading line; ``base`` carries inherited formatting (e.g. bold for <th>)."""
    blocks = [c for c in html_cell
              if isinstance(c.tag, str) and c.tag.lower() in _BLOCK_TAGS]
    if not blocks:
        _render_inline(html_cell, _ctx_from(html_cell, base), cell.paragraphs[0])
        return

    used_first = False
    if (html_cell.text or '').strip():
        _add_run(cell.paragraphs[0], html_cell.text, _ctx_from(html_cell, base))
        used_first = True

    def _next_para():
        nonlocal used_first
        if not used_first:
            used_first = True
            return cell.paragraphs[0]
        return cell.add_paragraph()

    for child in html_cell:
        if not isinstance(child.tag, str):
            continue
        tag = child.tag.lower()
        if tag in ('ul', 'ol'):
            for li in child:
                if isinstance(li.tag, str) and li.tag.lower() == 'li':
                    _render_inline(li, _ctx_from(li, base), _next_para())
        elif tag in _BLOCK_TAGS:
            p = _next_para()
            _apply_para_format(p, _style_map(child))
            _render_inline(child, _ctx_from(child, base), p)
        if child.tail and child.tail.strip():
            _add_run(cell.paragraphs[-1], child.tail, base)

    if not used_first:                       # nothing rendered → fall back inline
        _render_inline(html_cell, _ctx_from(html_cell, base), cell.paragraphs[0])


def _emit_table(doc, el):
    parsed = []
    for tr in el.iter('tr'):
        cells = [c for c in tr
                 if isinstance(c.tag, str) and c.tag.lower() in ('td', 'th')]
        if cells:
            parsed.append(cells)
    if not parsed:
        return
    nrows = len(parsed)

    # Walk an occupancy grid so colspan/rowspan map to real cell coordinates.
    occupied = set()
    placements = []          # (row, col, colspan, rowspan, cell_el)
    ncols = 0
    for r, cells in enumerate(parsed):
        c = 0
        for cell in cells:
            while (r, c) in occupied:
                c += 1
            cs, rs = _cell_spans(cell)
            for dr in range(rs):
                for dc in range(cs):
                    occupied.add((r + dr, c + dc))
            placements.append((r, c, cs, rs, cell))
            c += cs
            ncols = max(ncols, c)
    if ncols < 1:
        return

    table = doc.add_table(rows=nrows, cols=ncols)
    try:
        table.style = 'Table Grid'
    except Exception:
        pass

    col_widths = {}          # grid-column → Length (from simple, unspanned cells)
    for (r, c, cs, rs, cell) in placements:
        target = table.cell(r, c)
        if cs > 1 or rs > 1:
            try:
                target = target.merge(table.cell(r + rs - 1, c + cs - 1))
            except Exception as e:                       # pragma: no cover
                logger.debug("cell merge failed: %s", e)
        base = {'bold': True} if cell.tag.lower() == 'th' else {}
        _render_cell(cell, target, base)
        w = _cell_width(cell)
        if w is not None and cs == 1 and c not in col_widths:
            col_widths[c] = w

    if col_widths:
        table.autofit = False
        for ci, width in col_widths.items():
            for ri in range(nrows):
                try:
                    table.cell(ri, ci).width = width
                except Exception:                        # pragma: no cover
                    pass

    # First row entirely <th> → a repeating header row.
    if parsed[0] and all(c.tag.lower() == 'th' for c in parsed[0]):
        _set_repeat_header(table.rows[0])


def _add_hr(doc):
    """Insert a horizontal rule as an empty paragraph with a bottom border."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    p = doc.add_paragraph()
    pPr = p._p.get_or_add_pPr()
    pBdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '6')
    bottom.set(qn('w:space'), '1')
    bottom.set(qn('w:color'), 'auto')
    pBdr.append(bottom)
    pPr.append(pBdr)
    return p


def _emit_block(doc, el, list_style=None):
    tag = el.tag.lower() if isinstance(el.tag, str) else ''
    if tag in ('ul', 'ol'):
        style = 'List Number' if tag == 'ol' else 'List Bullet'
        for li in el:
            if isinstance(li.tag, str) and li.tag.lower() == 'li':
                _emit_block(doc, li, list_style=style)
        return
    if tag == 'table':
        _emit_table(doc, el)
        return
    if tag == 'hr':
        _add_hr(doc)
        return

    classes = set((el.get('class') or '').split())
    if list_style:
        para_style = list_style
    elif 'doc-title' in classes:
        para_style = 'Title'
    elif 'doc-subtitle' in classes:
        para_style = 'Subtitle'
    elif tag in _HEADING_STYLE:
        para_style = _HEADING_STYLE[tag]
    elif tag == 'blockquote':
        para_style = 'Quote'
    else:
        para_style = None

    try:
        p = doc.add_paragraph(style=para_style) if para_style else doc.add_paragraph()
    except KeyError:
        p = doc.add_paragraph()  # style missing in template
    _apply_para_format(p, _style_map(el))
    _render_inline(el, _ctx_from(el, {}), p)

    # Nested lists living inside this block (e.g. a <ul> inside an <li>).
    for child in el:
        if isinstance(child.tag, str) and child.tag.lower() in ('ul', 'ol'):
            _emit_block(doc, child)


def _apply_page_setup(doc, page) -> None:
    """Apply editor page-setup (size / orientation / margins) to section 0.

    python-docx does NOT swap width/height when you flip orientation, so we set
    the dimensions explicitly and keep ``w:orient`` consistent with them.
    """
    if not page:
        return
    from docx.shared import Inches
    from docx.enum.section import WD_ORIENT
    try:
        s = doc.sections[0]
    except (IndexError, AttributeError):
        return

    w = page.get('width_in')
    h = page.get('height_in')
    orient = (page.get('orientation') or '').lower()
    # Fall back to the named size when explicit dimensions weren't supplied.
    if (not w or not h) and page.get('size') in _PAGE_SIZES:
        w, h = _PAGE_SIZES[page['size']]
    if w and h:
        if orient == 'landscape' and w < h:
            w, h = h, w
        elif orient == 'portrait' and w > h:
            w, h = h, w
        s.orientation = WD_ORIENT.LANDSCAPE if (w > h) else WD_ORIENT.PORTRAIT
        s.page_width = Inches(w)
        s.page_height = Inches(h)

    m = page.get('margins') or {}
    for attr, key in (('top_margin', 'top'), ('bottom_margin', 'bottom'),
                      ('left_margin', 'left'), ('right_margin', 'right')):
        v = m.get(key)
        if isinstance(v, (int, float)) and 0 <= v <= 12:
            setattr(s, attr, Inches(v))


def _add_page_number_field(paragraph) -> None:
    """Append a live PAGE field (fldSimple form — widely supported) to a paragraph."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    fld = OxmlElement('w:fldSimple')
    fld.set(qn('w:instr'), ' PAGE ')
    r = OxmlElement('w:r')
    t = OxmlElement('w:t')
    t.text = '1'                                   # cached value; Word recomputes
    r.append(t)
    fld.append(r)
    paragraph._p.append(fld)


def _write_hf(hf, spec: dict) -> None:
    """Write plain text (+ an optional page-number field) into a header/footer.

    A fresh ``Document()`` starts with linked (inherited) headers/footers, so we
    only materialise a part when the editor actually has content — blank
    specs leave the section's default untouched.
    """
    if not isinstance(spec, dict):
        return
    text = (spec.get('text') or '').replace('\r', '')
    page_num = bool(spec.get('page_num'))
    if not text.strip() and not page_num:
        return

    hf.is_linked_to_previous = False               # give it its own part
    paras = hf.paragraphs
    first = paras[0]
    for extra in paras[1:]:                        # collapse to a clean slate
        extra._p.getparent().remove(extra._p)
    for r in list(first.runs):
        r._r.getparent().remove(r._r)

    lines = text.split('\n') if text else ['']
    cur = first
    for i, line in enumerate(lines):
        if i:
            cur = hf.add_paragraph()
        if line:
            cur.add_run(line.replace('\t', ' '))
    if page_num:
        if (lines[-1] if lines else '').strip():
            cur.add_run(' ')
        _add_page_number_field(cur)


def _apply_headers_footers(doc, page) -> None:
    """Apply the editor's primary header/footer to section 0 (plain text + page #)."""
    if not page:
        return
    try:
        s = doc.sections[0]
    except (IndexError, AttributeError):
        return
    for key, getter in (('header', lambda: s.header), ('footer', lambda: s.footer)):
        spec = page.get(key)
        if isinstance(spec, dict):
            try:
                _write_hf(getter(), spec)
            except Exception as e:                 # pragma: no cover - defensive
                logger.debug("%s write failed: %s", key, e)


_W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
_FN_REL_TYPE = ('http://schemas.openxmlformats.org/officeDocument/2006/'
                'relationships/footnotes')
_FN_CT_OVERRIDE = ('<Override PartName="/word/footnotes.xml" ContentType='
                   '"application/vnd.openxmlformats-officedocument.'
                   'wordprocessingml.footnotes+xml"/>')


def _cls(el) -> set:
    return set((el.get('class') or '').split())


def _extract_footnote_defs(frag) -> dict:
    """Pull footnote text out of the body fragment and strip the sections.

    Returns ``{orig_id: [line, ...]}`` (one entry per ``.fn-item``, paragraphs
    kept as separate lines); each ``.doc-footnotes`` section is removed so it
    never lands in the document body.
    """
    defs = {}
    for sec in list(frag.iter('section')):
        if 'doc-footnotes' not in _cls(sec):
            continue
        for li in sec.iter('li'):
            fid = li.get('data-fn-id')
            if 'fn-item' not in _cls(li) or not fid:
                continue
            blocks = [c for c in li if isinstance(c.tag, str)
                      and c.tag.lower() in _BLOCK_TAGS]
            lines = [' '.join(b.text_content().split()) for b in (blocks or [li])]
            defs[fid] = [ln for ln in lines if ln] or ['']
        parent = sec.getparent()
        if parent is not None:
            parent.remove(sec)
    return defs


def _order_footnote_refs(frag, defs) -> list:
    """Number footnote markers in document order; stamp each with a final id and
    return the ordered ``[(id, [line, ...]), ...]`` payload for footnotes.xml."""
    order = []
    for sup in frag.iter('sup'):
        if 'fn-ref' not in _cls(sup):
            continue
        fid = str(len(order) + 1)
        sup.set('data-fn-final-id', fid)
        order.append((fid, defs.get(sup.get('data-fn-id'), [''])))
    return order


def _add_footnote_ref(p, fid: str) -> None:
    """Append a superscript footnote-reference mark (Word auto-numbers it)."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    r = OxmlElement('w:r')
    rpr = OxmlElement('w:rPr')
    va = OxmlElement('w:vertAlign')
    va.set(qn('w:val'), 'superscript')
    rpr.append(va)
    r.append(rpr)
    ref = OxmlElement('w:footnoteReference')
    ref.set(qn('w:id'), str(fid))
    r.append(ref)
    p._p.append(r)


def _build_footnotes_xml(order) -> str:
    """Serialise the ordered footnote payload into a footnotes.xml part. The two
    leading separator notes (ids -1 and 0) are what Word writes by default."""
    head = (
        '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/>'
        '</w:r></w:p></w:footnote>'
        '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r>'
        '<w:continuationSeparator/></w:r></w:p></w:footnote>')
    notes = []
    for fid, lines in order:
        paras = []
        for i, line in enumerate(lines or ['']):
            txt = html.escape(line, quote=False)
            if i == 0:
                run = ('<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'
                       '<w:footnoteRef/></w:r>'
                       f'<w:r><w:t xml:space="preserve"> {txt}</w:t></w:r>')
            else:
                run = f'<w:r><w:t xml:space="preserve">{txt}</w:t></w:r>'
            paras.append(f'<w:p>{run}</w:p>')
        notes.append(f'<w:footnote w:id="{fid}">{"".join(paras)}</w:footnote>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<w:footnotes xmlns:w="{_W_NS}">{head}{"".join(notes)}</w:footnotes>')


def _inject_footnotes(path: str, order) -> None:
    """Splice a footnotes part into a saved .docx: add the part, a content-type
    override and a document relationship. python-docx can't model footnotes, so
    we rewrite the package zip directly."""
    import shutil
    with zipfile.ZipFile(path) as z:
        data = {n: z.read(n) for n in z.namelist()}

    ct = data.get('[Content_Types].xml', b'').decode('utf-8')
    if 'word/footnotes.xml' not in ct:
        ct = ct.replace('</Types>', _FN_CT_OVERRIDE + '</Types>')
        data['[Content_Types].xml'] = ct.encode('utf-8')

    rels_name = 'word/_rels/document.xml.rels'
    raw = data.get(rels_name)
    rels = raw.decode('utf-8') if raw else (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/'
        'package/2006/relationships"></Relationships>')
    if _FN_REL_TYPE not in rels:
        used = [int(x) for x in re.findall(r'Id="rId(\d+)"', rels)]
        nid = (max(used) + 1) if used else 1
        rel = (f'<Relationship Id="rId{nid}" Type="{_FN_REL_TYPE}" '
               'Target="footnotes.xml"/>')
        rels = rels.replace('</Relationships>', rel + '</Relationships>')
    data[rels_name] = rels.encode('utf-8')

    data['word/footnotes.xml'] = _build_footnotes_xml(order).encode('utf-8')

    tmp = path + '.tmpfn'
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, blob in data.items():
            z.writestr(name, blob)
    shutil.move(tmp, path)


def html_to_docx(body_html: str, dest: str, page=None) -> None:
    """Convert the editor's HTML (inner content of the doc article) to a .docx.

    ``page`` is the optional document-structure dict from the editor (size /
    orientation / margins, plus the primary header & footer); when present it is
    applied to the document's section. Footnotes travel inside ``body_html`` (a
    ``.doc-footnotes`` section plus ``.fn-ref`` markers) and are spliced back in
    as a real footnotes part after the save.
    """
    from docx import Document
    from lxml import html as LH

    doc = Document()
    frag = LH.fragment_fromstring(body_html or '<p></p>', create_parent='yr-root')

    fn_defs = _extract_footnote_defs(frag)            # strips .doc-footnotes
    fn_order = _order_footnote_refs(frag, fn_defs)    # stamps marker ids

    if frag.text and frag.text.strip():
        _add_run(doc.add_paragraph(), frag.text, {})

    for ch in frag:
        if not isinstance(ch.tag, str):
            continue
        tag = ch.tag.lower()
        if tag in _BLOCK_TAGS or tag in ('table', 'hr'):
            _emit_block(doc, ch)
        else:
            # Stray inline content at the top level → wrap in a paragraph.
            p = doc.add_paragraph()
            _place_child(p, ch, {})
        if ch.tail and ch.tail.strip():
            _add_run(doc.add_paragraph(), ch.tail, {})

    _apply_page_setup(doc, page)
    _apply_headers_footers(doc, page)
    doc.save(dest)
    if fn_order:
        try:
            _inject_footnotes(dest, fn_order)
        except Exception as e:                       # pragma: no cover - defensive
            logger.debug("footnote injection failed: %s", e)
