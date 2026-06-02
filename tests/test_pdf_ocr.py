"""P11a — PDF OCR (make scanned PDFs searchable).

Covers FitzDoc.ocr(), which writes a searchable COPY of a PDF: selected image
pages are rasterised and run through Tesseract, which lays an *invisible* text
layer behind them. Pages that already carry a real text layer are copied through
untouched (when skip_text is on). The source file and the open document are
never mutated. Also covers the Flask route POST /api/pdf/ocr.

These tests need the Tesseract binary; the whole module is skipped when it isn't
installed, so the suite stays green on machines without OCR. Scanned fixtures
render dictionary words (which OCR most reliably) into an image-only page, so the
recognised text is assertable.
"""
import os

import fitz
import pytest

from renderers import comicdir, fitzdoc
from renderers.fitzdoc import FitzDoc


def _ocr_actually_works() -> bool:
    """True only if OCR can really run end to end. The Tesseract *binary* alone
    isn't enough — PyMuPDF's pdfocr needs the language data (tessdata); a common
    Windows install has the binary but no tessdata, which made these tests FAIL
    instead of skip. Probe a 1-page render so the gate matches real capability."""
    if not comicdir.tesseract_available():
        return False
    try:
        comicdir.ocr_config()
        d = fitz.open()
        d.new_page(width=200, height=80)
        pix = d.load_page(0).get_pixmap(dpi=72)
        pix.pdfocr_tobytes(language='eng', tessdata=comicdir.tessdata_dir() or None)
        d.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _ocr_actually_works(),
    reason='Tesseract OCR (binary + tessdata language data) not available',
)

# A clean, dictionary-friendly phrase OCR reads reliably even after re-rasterising.
SCAN_TEXT = 'The quick brown fox'
TEXT_LAYER = 'Born digital paragraph here'


def _make_scanned_pdf(path, pages=1, text=SCAN_TEXT, dpi=200):
    """An image-only PDF: render ``text`` to a bitmap, then place ONLY that image
    on each page (no text layer) — so get_text() is empty until OCR runs."""
    gen = fitz.open()
    gp = gen.new_page(width=360, height=110)
    gp.insert_text((20, 64), text, fontsize=24)
    pix = gp.get_pixmap(dpi=dpi)
    gen.close()
    doc = fitz.open()
    for _ in range(pages):
        pg = doc.new_page(width=pix.width * 72 / dpi, height=pix.height * 72 / dpi)
        pg.insert_image(pg.rect, pixmap=pix)
    doc.save(str(path), garbage=0, deflate=False)
    doc.close()
    return path


def _make_text_pdf(path, pages=1, text=TEXT_LAYER):
    """A born-digital PDF carrying a real (selectable) text layer."""
    doc = fitz.open()
    for _ in range(pages):
        doc.new_page(width=360, height=200).insert_text((20, 40), text, fontsize=16)
    doc.save(str(path), garbage=0, deflate=False)
    doc.close()
    return path


def _size(p):
    return os.path.getsize(str(p))


def _page_texts(p):
    d = fitz.open(str(p))
    try:
        return [d.load_page(i).get_text().strip() for i in range(d.page_count)]
    finally:
        d.close()


@pytest.fixture
def scan_pdf(tmp_path):
    return _make_scanned_pdf(tmp_path / 'scan.pdf')


@pytest.fixture
def scan2_pdf(tmp_path):
    return _make_scanned_pdf(tmp_path / 'scan2.pdf', pages=2)


@pytest.fixture
def text_pdf(tmp_path):
    return _make_text_pdf(tmp_path / 'digital.pdf')


@pytest.fixture(autouse=True)
def _purge_doc_cache():
    yield
    with fitzdoc._lock:
        docs = [d for _, d in fitzdoc._cache.values()]
        fitzdoc._cache.clear()
    for d in docs:
        try:
            d.close()
        except Exception:
            pass


# ── FitzDoc.ocr ───────────────────────────────────────────────────────────────────
def test_ocr_makes_scanned_searchable(tmp_path, scan_pdf):
    assert _page_texts(scan_pdf) == ['']            # truly image-only to begin with
    out = tmp_path / 'scan-ocr.pdf'
    res = FitzDoc(str(scan_pdf)).ocr(str(out), language='eng')
    assert res['ocr_pages'] == 1
    txt = _page_texts(res['path'])[0].lower()
    assert 'quick' in txt and 'brown' in txt        # the words are now selectable


def test_ocr_report_fields(tmp_path, scan_pdf):
    res = FitzDoc(str(scan_pdf)).ocr(str(tmp_path / 'r.pdf'))
    assert set(res) >= {'path', 'name', 'language', 'pages',
                        'ocr_pages', 'skipped_pages', 'before', 'after'}
    assert res['pages'] == res['ocr_pages'] + res['skipped_pages']
    assert res['after'] == _size(res['path'])
    assert res['before'] == _size(scan_pdf)


def test_ocr_default_language_is_eng(tmp_path, scan_pdf):
    res = FitzDoc(str(scan_pdf)).ocr(str(tmp_path / 'd.pdf'))
    assert res['language'] == 'eng'


def test_ocr_skips_pages_that_already_have_text(tmp_path, text_pdf):
    res = FitzDoc(str(text_pdf)).ocr(str(tmp_path / 't.pdf'), skip_text=True)
    assert res['ocr_pages'] == 0 and res['skipped_pages'] == res['pages']
    assert TEXT_LAYER in _page_texts(res['path'])[0]   # original text preserved verbatim


def test_ocr_skip_text_false_forces_ocr(tmp_path, text_pdf):
    res = FitzDoc(str(text_pdf)).ocr(str(tmp_path / 'f.pdf'), skip_text=False)
    assert res['ocr_pages'] == res['pages']            # every page rasterised + OCR'd
    assert 'born' in _page_texts(res['path'])[0].lower()


def test_ocr_pages_subset_only(tmp_path, scan2_pdf):
    res = FitzDoc(str(scan2_pdf)).ocr(str(tmp_path / 's.pdf'), pages=[0])
    assert res['ocr_pages'] == 1 and res['skipped_pages'] == 1
    texts = _page_texts(res['path'])
    assert 'quick' in texts[0].lower()                 # OCR'd page is searchable
    assert texts[1] == ''                              # untouched page stays image-only


def test_ocr_preserves_page_count(tmp_path, scan2_pdf):
    res = FitzDoc(str(scan2_pdf)).ocr(str(tmp_path / 'p.pdf'))
    assert res['pages'] == 2
    d = fitz.open(res['path'])
    try:
        assert d.page_count == 2
    finally:
        d.close()


def test_ocr_leaves_source_untouched(tmp_path, scan_pdf):
    before = _size(scan_pdf)
    FitzDoc(str(scan_pdf)).ocr(str(tmp_path / 'q.pdf'))
    assert _size(scan_pdf) == before                   # original file unchanged
    assert _page_texts(scan_pdf) == ['']               # still image-only


def test_ocr_does_not_mutate_open_doc(tmp_path, scan_pdf):
    d = FitzDoc(str(scan_pdf))
    n_before = d.doc.page_count
    d.ocr(str(tmp_path / 'r.pdf'))
    assert d.doc.page_count == n_before
    assert d.doc.load_page(0).get_pixmap(dpi=36).width > 0   # open doc still usable


def test_ocr_unique_naming(tmp_path, scan_pdf):
    out = tmp_path / 'dup.pdf'
    d = FitzDoc(str(scan_pdf))
    first = d.ocr(str(out))['name']
    second = d.ocr(str(out))['name']
    assert first == 'dup.pdf' and second == 'dup (2).pdf'
    assert (tmp_path / first).is_file() and (tmp_path / second).is_file()


def test_ocr_bad_destination_ext_raises(tmp_path, scan_pdf):
    with pytest.raises(ValueError):
        FitzDoc(str(scan_pdf)).ocr(str(tmp_path / 'x.txt'))


def test_ocr_missing_dest_folder_raises(tmp_path, scan_pdf):
    with pytest.raises(ValueError):
        FitzDoc(str(scan_pdf)).ocr(str(tmp_path / 'nope' / 'x.pdf'))


def test_ocr_unknown_language_raises(tmp_path, scan_pdf):
    with pytest.raises(ValueError):
        FitzDoc(str(scan_pdf)).ocr(str(tmp_path / 'x.pdf'), language='zzz')


# ── Flask: POST /api/pdf/ocr ───────────────────────────────────────────────────────
def test_api_ocr_scanned(client, tmp_path, scan_pdf):
    out = tmp_path / 'api-ocr.pdf'
    r = client.post('/api/pdf/ocr', json={'path': str(scan_pdf), 'target': str(out)})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ok'] is True and b['ocr_pages'] >= 1
    assert 'quick' in _page_texts(b['path'])[0].lower()


def test_api_ocr_pages_subset(client, tmp_path, scan2_pdf):
    out = tmp_path / 'api-sub.pdf'
    r = client.post('/api/pdf/ocr',
                    json={'path': str(scan2_pdf), 'target': str(out), 'pages': [1]})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ocr_pages'] == 1 and b['skipped_pages'] == 1


def test_api_ocr_missing_path(client, tmp_path):
    r = client.post('/api/pdf/ocr', json={'target': str(tmp_path / 'x.pdf')})
    assert r.status_code == 400


def test_api_ocr_non_pdf_source(client, tmp_path, samples):
    r = client.post('/api/pdf/ocr',
                    json={'path': str(samples['txt']), 'target': str(tmp_path / 'x.pdf')})
    assert r.status_code == 400


def test_api_ocr_bad_target_ext(client, tmp_path, scan_pdf):
    r = client.post('/api/pdf/ocr',
                    json={'path': str(scan_pdf), 'target': str(tmp_path / 'x.txt')})
    assert r.status_code == 400


def test_api_ocr_target_folder_missing(client, tmp_path, scan_pdf):
    r = client.post('/api/pdf/ocr',
                    json={'path': str(scan_pdf), 'target': str(tmp_path / 'nope' / 'x.pdf')})
    assert r.status_code == 400


def test_api_ocr_bad_language(client, tmp_path, scan_pdf):
    r = client.post('/api/pdf/ocr',
                    json={'path': str(scan_pdf), 'target': str(tmp_path / 'x.pdf'), 'language': 'zzz'})
    assert r.status_code == 400


def test_api_ocr_pages_not_list(client, tmp_path, scan_pdf):
    r = client.post('/api/pdf/ocr',
                    json={'path': str(scan_pdf), 'target': str(tmp_path / 'x.pdf'), 'pages': '1'})
    assert r.status_code == 400
