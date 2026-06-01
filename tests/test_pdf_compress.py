"""P10a — PDF compress/optimize backend.

Covers FitzDoc.compress(), which writes a size-optimised COPY of a PDF (lossless
'light', image-downsampling 'balanced'/'strong') and never mutates the source or
the open document, plus the Flask route /api/pdf/compress.

Image-heavy fixtures are filled with os.urandom noise (incompressible) so that the
down-sampling levels produce an unmistakable, assertable size drop. The module
-global FitzDoc cache is purged after each test so Windows releases handles.
"""
import os

import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc


def _make_image_pdf(path, pages=2, page_pt=144, px=600):
    """A PDF whose pages carry a noise image. ``px`` pixels across a ``page_pt``-pt
    square ⇒ (px / (page_pt/72)) dpi — at the defaults that's 300 dpi, so both
    'balanced' (>200) and 'strong' (>130) will down-sample it."""
    samples = os.urandom(px * px * 3)
    pix = fitz.Pixmap(fitz.csRGB, px, px, samples, False)
    doc = fitz.open()
    for i in range(pages):
        pg = doc.new_page(width=page_pt, height=page_pt)
        pg.insert_image(fitz.Rect(0, 0, page_pt, page_pt), pixmap=pix)
        pg.insert_text((8, 12), f'page {i + 1}')
    doc.save(str(path), garbage=0, deflate=False)         # uncompressed baseline
    doc.close()
    return path


def _make_text_pdf(path, pages=12):
    """A text-heavy PDF saved uncompressed, so even lossless 'light' shrinks it."""
    doc = fitz.open()
    body = ('The quick brown fox jumps over the lazy dog. ' * 50)
    for _ in range(pages):
        doc.new_page().insert_text((40, 40), body, fontsize=8)
    doc.save(str(path), garbage=0, deflate=False, clean=False)
    doc.close()
    return path


def _size(p):
    return os.path.getsize(str(p))


def _pages_text(p):
    d = fitz.open(str(p))
    try:
        return d.page_count, d.load_page(0).get_text()
    finally:
        d.close()


@pytest.fixture
def img_pdf(tmp_path):
    return _make_image_pdf(tmp_path / 'scan.pdf')


@pytest.fixture
def text_pdf(tmp_path):
    return _make_text_pdf(tmp_path / 'notes.pdf')


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


# ── FitzDoc.compress ─────────────────────────────────────────────────────────────
def test_compress_light_lossless_shrinks_text(tmp_path, text_pdf):
    out = tmp_path / 'notes-min.pdf'
    res = FitzDoc(str(text_pdf)).compress(str(out), level='light')
    assert res['level'] == 'light'
    assert res['after'] < res['before']                   # lossless still wins here
    pages, text = _pages_text(res['path'])
    assert pages == 12 and 'quick brown fox' in text


def test_compress_balanced_shrinks_images(tmp_path, img_pdf):
    out = tmp_path / 'scan-balanced.pdf'
    res = FitzDoc(str(img_pdf)).compress(str(out), level='balanced')
    assert res['after'] < res['before']
    assert res['saved'] > 0 and res['saved_pct'] > 0
    assert os.path.isfile(res['path'])


def test_compress_strong_smaller_than_balanced(tmp_path, img_pdf):
    d = FitzDoc(str(img_pdf))
    bal = d.compress(str(tmp_path / 'b.pdf'), level='balanced')['after']
    strong = d.compress(str(tmp_path / 's.pdf'), level='strong')['after']
    assert strong < bal                                   # 96 dpi/q55 beats 150 dpi/q80


def test_compress_size_report_fields(tmp_path, img_pdf):
    out = tmp_path / 'scan2.pdf'
    res = FitzDoc(str(img_pdf)).compress(str(out), level='balanced')
    assert set(res) >= {'path', 'name', 'level', 'before', 'after', 'saved', 'saved_pct'}
    assert res['before'] == _size(img_pdf)
    assert res['after'] == _size(res['path'])
    assert res['saved'] == res['before'] - res['after']


def test_compress_default_level_is_balanced(tmp_path, img_pdf):
    res = FitzDoc(str(img_pdf)).compress(str(tmp_path / 'def.pdf'))
    assert res['level'] == 'balanced'


def test_compress_preserves_pages_and_text(tmp_path, img_pdf):
    res = FitzDoc(str(img_pdf)).compress(str(tmp_path / 'p.pdf'), level='strong')
    pages, text = _pages_text(res['path'])
    assert pages == 2 and 'page 1' in text


def test_compress_leaves_source_untouched(tmp_path, img_pdf):
    before_bytes = _size(img_pdf)
    FitzDoc(str(img_pdf)).compress(str(tmp_path / 'q.pdf'), level='strong')
    assert _size(img_pdf) == before_bytes                 # original file unchanged
    pages, _ = _pages_text(img_pdf)
    assert pages == 2


def test_compress_does_not_mutate_open_doc(tmp_path, img_pdf):
    d = FitzDoc(str(img_pdf))
    n_before = d.doc.page_count
    d.compress(str(tmp_path / 'r.pdf'), level='strong')   # rewrite_images runs on a copy
    assert d.doc.page_count == n_before
    assert d.doc.load_page(0).get_pixmap(dpi=36).width > 0  # open doc still usable


def test_compress_unique_naming(tmp_path, img_pdf):
    out = tmp_path / 'dup.pdf'
    d = FitzDoc(str(img_pdf))
    first = d.compress(str(out), level='light')['name']
    second = d.compress(str(out), level='light')['name']
    assert first == 'dup.pdf'
    assert second == 'dup (2).pdf'
    assert (tmp_path / first).is_file() and (tmp_path / second).is_file()


def test_compress_bad_level_raises(tmp_path, img_pdf):
    with pytest.raises(ValueError):
        FitzDoc(str(img_pdf)).compress(str(tmp_path / 'x.pdf'), level='ultra')


def test_compress_bad_destination_ext_raises(tmp_path, img_pdf):
    with pytest.raises(ValueError):
        FitzDoc(str(img_pdf)).compress(str(tmp_path / 'x.txt'))


def test_compress_missing_dest_folder_raises(tmp_path, img_pdf):
    with pytest.raises(ValueError):
        FitzDoc(str(img_pdf)).compress(str(tmp_path / 'nope' / 'x.pdf'))


# ── Flask: POST /api/pdf/compress ──────────────────────────────────────────────────
def test_api_compress_light_text(client, tmp_path, text_pdf):
    out = tmp_path / 'api-light.pdf'
    r = client.post('/api/pdf/compress',
                    json={'path': str(text_pdf), 'target': str(out), 'level': 'light'})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ok'] is True and b['level'] == 'light'
    assert b['after'] < b['before']
    assert os.path.isfile(b['path'])


def test_api_compress_balanced_image(client, tmp_path, img_pdf):
    out = tmp_path / 'api-bal.pdf'
    r = client.post('/api/pdf/compress',
                    json={'path': str(img_pdf), 'target': str(out), 'level': 'balanced'})
    assert r.status_code == 200
    b = r.get_json()
    assert b['saved'] > 0 and b['saved_pct'] > 0


def test_api_compress_missing_path(client, tmp_path):
    r = client.post('/api/pdf/compress', json={'target': str(tmp_path / 'x.pdf')})
    assert r.status_code == 400


def test_api_compress_non_pdf_source(client, tmp_path, samples):
    r = client.post('/api/pdf/compress',
                    json={'path': str(samples['txt']), 'target': str(tmp_path / 'x.pdf')})
    assert r.status_code == 400


def test_api_compress_bad_target_ext(client, tmp_path, img_pdf):
    r = client.post('/api/pdf/compress',
                    json={'path': str(img_pdf), 'target': str(tmp_path / 'x.txt')})
    assert r.status_code == 400


def test_api_compress_target_folder_missing(client, tmp_path, img_pdf):
    r = client.post('/api/pdf/compress',
                    json={'path': str(img_pdf), 'target': str(tmp_path / 'nope' / 'x.pdf')})
    assert r.status_code == 400


def test_api_compress_bad_level(client, tmp_path, img_pdf):
    r = client.post('/api/pdf/compress',
                    json={'path': str(img_pdf), 'target': str(tmp_path / 'x.pdf'), 'level': 'ultra'})
    assert r.status_code == 400
