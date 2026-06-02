import zipfile

from renderers import officedoc, textdoc
from renderers.comicdoc import ComicDoc
from renderers.fitzdoc import FitzDoc

PNG_MAGIC = b'\x89PNG\r\n\x1a\n'


def test_fitz_pdf_render_outline_search(samples):
    doc = FitzDoc(str(samples['pdf']))
    assert doc.page_count == 3
    assert doc.render_page(0, 1.0)[:8] == PNG_MAGIC
    assert len(doc.outline()) >= 2
    assert len(doc.search('fox')) == 3


def test_fitz_page_text(samples):
    doc = FitzDoc(str(samples['pdf']))
    full = doc.page_text(0, None)
    assert full['page_count'] == 3
    assert full['start'] == 0 and full['end'] == 3
    assert 'fox' in full['text'].lower()
    assert full['truncated'] is False
    # single-page range
    one = doc.page_text(1, 2)
    assert one['start'] == 1 and one['end'] == 2
    # out-of-range start clamps to the last page
    assert doc.page_text(99, 100)['start'] == 2
    # max_chars truncation
    trunc = doc.page_text(0, None, max_chars=10)
    assert trunc['truncated'] is True and len(trunc['text']) <= 10


def test_comicdoc_pages(samples):
    doc = ComicDoc(str(samples['cbz']))
    assert doc.page_count == 3
    data, mime = doc.get_page(0)
    assert mime == 'image/png' and data[:8] == PNG_MAGIC


def test_comicdoc_read_meta(samples):
    doc = ComicDoc(str(samples['cbz_manga']))
    assert doc.read_meta('ComicInfo.xml') is not None
    assert doc.read_meta('Nope.xml') is None


def test_office_pptx_xlsx(samples):
    p = officedoc.to_html(str(samples['pptx']))
    assert '<article' in p['html'] and len(p['outline']) >= 1
    # XLSX now renders to structured per-sheet JSON (sticky-grid viewer).
    x = officedoc.to_html(str(samples['xlsx']))
    assert x['sheets'] and len(x['outline']) >= 1
    assert any(c.get('v') is not None for c in x['sheets'][0]['cells'])


def test_text_modes(samples):
    assert textdoc.to_html(str(samples['md']))['mode'] == 'markdown'
    assert textdoc.to_html(str(samples['py']))['mode'] == 'code'
    assert textdoc.to_html(str(samples['txt']))['mode'] == 'plain'
