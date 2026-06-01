"""P-v2-2 — PDF redaction (true black-out).

Covers FitzDoc.redact(), which writes a NEW pdf with the underlying text, vector
art and (optionally) image pixels under each box *removed* from the content
streams — not merely hidden behind a drawn rectangle — then paints a solid fill
(default black) over each. The open document and the original file are never
mutated; the work runs on a faithful in-memory clone, so metadata/outline ride
along unless scrub=True strips them. Boxes arrive in unrotated PDF points (the
same space the annotate route and selectable text layer use). Also covers the
Flask route POST /api/pdf/redact.

The module-global FitzDoc cache is purged after each test so Windows releases
file handles before tmp_path is torn down.
"""
import os

import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc


def _make_text_pdf(path, pages=1, w=300, h=200):
    """Pages each carrying 'SECRET' (y≈50) and 'PUBLIC' (y≈100) on separate lines,
    plus a 'page N' tag — so a box over SECRET leaves PUBLIC intact and we can
    prove per-page independence."""
    doc = fitz.open()
    for i in range(pages):
        pg = doc.new_page(width=w, height=h)
        pg.insert_text((50, 50), 'SECRET', fontsize=20)
        pg.insert_text((50, 100), 'PUBLIC', fontsize=20)
        pg.insert_text((50, 150), f'page {i + 1}', fontsize=12)
    doc.save(str(path))
    doc.close()
    return path


def _make_image_pdf(path, w=200, h=200, shade=200):
    """A single page fully covered by a solid mid-grey image, so 'inside the box'
    (black fill) and 'outside the box' (grey image survives) are unmistakable."""
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, w, h), False)
    pix.clear_with(shade)                                   # every channel = shade
    doc = fitz.open()
    pg = doc.new_page(width=w, height=h)
    pg.insert_image(fitz.Rect(0, 0, w, h), pixmap=pix)
    doc.save(str(path))
    doc.close()
    return path


def _make_meta_pdf(path):
    doc = fitz.open()
    pg = doc.new_page(width=300, height=200)
    pg.insert_text((50, 50), 'SECRET', fontsize=20)
    doc.set_metadata({'title': 'Confidential Report', 'author': 'Alice'})
    doc.save(str(path))
    doc.close()
    return path


def _word_rect(path, word='SECRET', page=0):
    """First hit rect for `word` on `page`, as [x0, y0, x1, y1] in page points."""
    d = fitz.open(str(path))
    try:
        hits = d.load_page(page).search_for(word)
    finally:
        d.close()
    assert hits, f'fixture should contain {word!r}'
    r = hits[0]
    return [round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2)]


def _page_text(path, page=0):
    d = fitz.open(str(path))
    try:
        return d.load_page(page).get_text()
    finally:
        d.close()


def _pixel(path, x, y, page=0, dpi=72):
    """RGB tuple at point (x, y); dpi=72 ⇒ 1 pt == 1 px, so points map straight
    to pixel coordinates."""
    d = fitz.open(str(path))
    try:
        pix = d.load_page(page).get_pixmap(dpi=dpi)
        return pix.pixel(int(x), int(y))
    finally:
        d.close()


def _center(rect):
    return (rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2


@pytest.fixture
def text_pdf(tmp_path):
    return _make_text_pdf(tmp_path / 'doc.pdf')


@pytest.fixture
def two_page_pdf(tmp_path):
    return _make_text_pdf(tmp_path / 'two.pdf', pages=2)


@pytest.fixture
def image_pdf(tmp_path):
    return _make_image_pdf(tmp_path / 'scan.pdf')


@pytest.fixture
def meta_pdf(tmp_path):
    return _make_meta_pdf(tmp_path / 'meta.pdf')


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


def _regions(rect, page=0):
    return [{'page': page, 'rects': [rect]}]


# ── FitzDoc.redact: the core guarantee — text is REMOVED, not covered ─────────────
def test_redact_removes_text_under_box(tmp_path, text_pdf):
    rect = _word_rect(text_pdf, 'SECRET')
    out = tmp_path / 'redacted.pdf'
    res = FitzDoc(str(text_pdf)).redact(str(out), _regions(rect))
    txt = _page_text(res['path'])
    assert 'SECRET' not in txt                  # the glyphs are gone from the stream
    assert 'PUBLIC' in txt                      # untouched text survives


def test_redact_fills_box_black_by_default(tmp_path, text_pdf):
    rect = _word_rect(text_pdf, 'SECRET')
    out = tmp_path / 'r.pdf'
    res = FitzDoc(str(text_pdf)).redact(str(out), _regions(rect))
    cx, cy = _center(rect)
    r, g, b = _pixel(res['path'], cx, cy)[:3]
    assert r < 40 and g < 40 and b < 40         # solid black over the redacted area


def test_redact_custom_fill_colour(tmp_path, text_pdf):
    rect = _word_rect(text_pdf, 'SECRET')
    out = tmp_path / 'r.pdf'
    res = FitzDoc(str(text_pdf)).redact(str(out), _regions(rect), fill='#ff0000')
    cx, cy = _center(rect)
    r, g, b = _pixel(res['path'], cx, cy)[:3]
    assert r > 200 and g < 70 and b < 70        # honoured the red fill


def test_redact_report_shape(tmp_path, text_pdf):
    rect = _word_rect(text_pdf, 'SECRET')
    res = FitzDoc(str(text_pdf)).redact(str(tmp_path / 'r.pdf'), _regions(rect))
    assert set(res) >= {'path', 'name', 'pages', 'boxes'}
    assert res['pages'] == 1 and res['boxes'] == 1
    assert os.path.isfile(res['path'])
    assert res['name'] == 'r.pdf'


def test_redact_leaves_source_file_untouched(tmp_path, text_pdf):
    before = os.path.getsize(str(text_pdf))
    rect = _word_rect(text_pdf, 'SECRET')
    FitzDoc(str(text_pdf)).redact(str(tmp_path / 'r.pdf'), _regions(rect))
    assert os.path.getsize(str(text_pdf)) == before
    assert 'SECRET' in _page_text(text_pdf)     # original still has the word


def test_redact_does_not_mutate_open_doc(tmp_path, text_pdf):
    rect = _word_rect(text_pdf, 'SECRET')
    d = FitzDoc(str(text_pdf))
    d.redact(str(tmp_path / 'r.pdf'), _regions(rect))
    assert 'SECRET' in d.doc.load_page(0).get_text()   # clone was mutated, not us


def test_redact_only_named_page(tmp_path, two_page_pdf):
    rect = _word_rect(two_page_pdf, 'SECRET', page=0)
    res = FitzDoc(str(two_page_pdf)).redact(str(tmp_path / 'r.pdf'), _regions(rect, page=0))
    assert res['pages'] == 1 and res['boxes'] == 1
    assert 'SECRET' not in _page_text(res['path'], page=0)
    assert 'SECRET' in _page_text(res['path'], page=1)   # page 1 left alone


def test_redact_multiple_pages(tmp_path, two_page_pdf):
    r0 = _word_rect(two_page_pdf, 'SECRET', page=0)
    r1 = _word_rect(two_page_pdf, 'SECRET', page=1)
    regions = [{'page': 0, 'rects': [r0]}, {'page': 1, 'rects': [r1]}]
    res = FitzDoc(str(two_page_pdf)).redact(str(tmp_path / 'r.pdf'), regions)
    assert res['pages'] == 2 and res['boxes'] == 2
    assert 'SECRET' not in _page_text(res['path'], page=0)
    assert 'SECRET' not in _page_text(res['path'], page=1)


def test_redact_removes_image_pixels_under_box_only(tmp_path, image_pdf):
    box = [60.0, 60.0, 140.0, 140.0]
    res = FitzDoc(str(image_pdf)).redact(str(tmp_path / 'r.pdf'), _regions(box),
                                         remove_images=True)
    inside = _pixel(res['path'], 100, 100)[:3]            # centre of the box
    outside = _pixel(res['path'], 20, 20)[:3]             # far corner, image intact
    assert max(inside) < 40                               # box → black
    assert min(outside) > 150                             # grey image survives


def test_redact_metadata_preserved_without_scrub(tmp_path, meta_pdf):
    rect = _word_rect(meta_pdf, 'SECRET')
    res = FitzDoc(str(meta_pdf)).redact(str(tmp_path / 'r.pdf'), _regions(rect))
    d = fitz.open(res['path'])
    try:
        assert d.metadata.get('title') == 'Confidential Report'   # faithful clone
    finally:
        d.close()


def test_redact_scrub_strips_metadata(tmp_path, meta_pdf):
    rect = _word_rect(meta_pdf, 'SECRET')
    res = FitzDoc(str(meta_pdf)).redact(str(tmp_path / 'r.pdf'), _regions(rect), scrub=True)
    d = fitz.open(res['path'])
    try:
        assert not d.metadata.get('title')
        assert not d.metadata.get('author')
    finally:
        d.close()


def test_redact_unique_naming(tmp_path, text_pdf):
    rect = _word_rect(text_pdf, 'SECRET')
    out = tmp_path / 'dup.pdf'
    d = FitzDoc(str(text_pdf))
    first = d.redact(str(out), _regions(rect))['name']
    second = d.redact(str(out), _regions(rect))['name']
    assert first == 'dup.pdf' and second == 'dup (2).pdf'
    assert (tmp_path / first).is_file() and (tmp_path / second).is_file()


def test_redact_zero_area_rect_skipped(tmp_path, text_pdf):
    rect = _word_rect(text_pdf, 'SECRET')
    # one valid box + one degenerate (zero-area) box → only the valid one counts
    regions = [{'page': 0, 'rects': [rect, [10, 10, 10, 10]]}]
    res = FitzDoc(str(text_pdf)).redact(str(tmp_path / 'r.pdf'), regions)
    assert res['boxes'] == 1


def test_redact_all_boxes_empty_raises(tmp_path, text_pdf):
    regions = [{'page': 0, 'rects': [[10, 10, 10, 10]]}]   # nothing with real area
    with pytest.raises(ValueError):
        FitzDoc(str(text_pdf)).redact(str(tmp_path / 'r.pdf'), regions)


def test_redact_empty_regions_raises(tmp_path, text_pdf):
    with pytest.raises(ValueError):
        FitzDoc(str(text_pdf)).redact(str(tmp_path / 'r.pdf'), [])


def test_redact_page_out_of_range_raises(tmp_path, text_pdf):
    with pytest.raises(ValueError):
        FitzDoc(str(text_pdf)).redact(str(tmp_path / 'r.pdf'),
                                      [{'page': 999, 'rects': [[1, 1, 9, 9]]}])


def test_redact_bad_rect_raises(tmp_path, text_pdf):
    with pytest.raises(ValueError):
        FitzDoc(str(text_pdf)).redact(str(tmp_path / 'r.pdf'),
                                      [{'page': 0, 'rects': [['a', 'b', 'c', 'd']]}])


def test_redact_bad_destination_ext_raises(tmp_path, text_pdf):
    rect = _word_rect(text_pdf, 'SECRET')
    with pytest.raises(ValueError):
        FitzDoc(str(text_pdf)).redact(str(tmp_path / 'r.txt'), _regions(rect))


def test_redact_missing_dest_folder_raises(tmp_path, text_pdf):
    rect = _word_rect(text_pdf, 'SECRET')
    with pytest.raises(ValueError):
        FitzDoc(str(text_pdf)).redact(str(tmp_path / 'nope' / 'r.pdf'), _regions(rect))


# ── Flask: POST /api/pdf/redact ────────────────────────────────────────────────────
def test_api_redact_ok(client, tmp_path, text_pdf):
    rect = _word_rect(text_pdf, 'SECRET')
    out = tmp_path / 'api.pdf'
    r = client.post('/api/pdf/redact',
                    json={'path': str(text_pdf), 'target': str(out),
                          'regions': _regions(rect)})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ok'] is True and b['boxes'] == 1 and b['pages'] == 1
    assert os.path.isfile(b['path'])
    assert 'SECRET' not in _page_text(b['path'])


def test_api_redact_scrub_flag(client, tmp_path, meta_pdf):
    rect = _word_rect(meta_pdf, 'SECRET')
    out = tmp_path / 'api.pdf'
    r = client.post('/api/pdf/redact',
                    json={'path': str(meta_pdf), 'target': str(out),
                          'regions': _regions(rect), 'scrub': True})
    assert r.status_code == 200
    d = fitz.open(r.get_json()['path'])
    try:
        assert not d.metadata.get('title')
    finally:
        d.close()


def test_api_redact_missing_path(client, tmp_path):
    r = client.post('/api/pdf/redact', json={'target': str(tmp_path / 'x.pdf'),
                                             'regions': _regions([1, 1, 9, 9])})
    assert r.status_code == 400


def test_api_redact_no_regions(client, tmp_path, text_pdf):
    r = client.post('/api/pdf/redact',
                    json={'path': str(text_pdf), 'target': str(tmp_path / 'x.pdf')})
    assert r.status_code == 400


def test_api_redact_empty_regions(client, tmp_path, text_pdf):
    r = client.post('/api/pdf/redact',
                    json={'path': str(text_pdf), 'target': str(tmp_path / 'x.pdf'),
                          'regions': []})
    assert r.status_code == 400


def test_api_redact_non_pdf_source(client, tmp_path, samples):
    r = client.post('/api/pdf/redact',
                    json={'path': str(samples['txt']), 'target': str(tmp_path / 'x.pdf'),
                          'regions': _regions([1, 1, 9, 9])})
    assert r.status_code == 400


def test_api_redact_bad_target_ext(client, tmp_path, text_pdf):
    r = client.post('/api/pdf/redact',
                    json={'path': str(text_pdf), 'target': str(tmp_path / 'x.txt'),
                          'regions': _regions([1, 1, 9, 9])})
    assert r.status_code == 400


def test_api_redact_target_folder_missing(client, tmp_path, text_pdf):
    r = client.post('/api/pdf/redact',
                    json={'path': str(text_pdf), 'target': str(tmp_path / 'nope' / 'x.pdf'),
                          'regions': _regions([1, 1, 9, 9])})
    assert r.status_code == 400


def test_api_redact_target_equals_source(client, text_pdf):
    r = client.post('/api/pdf/redact',
                    json={'path': str(text_pdf), 'target': str(text_pdf),
                          'regions': _regions([1, 1, 9, 9])})
    assert r.status_code == 409


def test_api_redact_page_out_of_range(client, tmp_path, text_pdf):
    r = client.post('/api/pdf/redact',
                    json={'path': str(text_pdf), 'target': str(tmp_path / 'x.pdf'),
                          'regions': [{'page': 999, 'rects': [[1, 1, 9, 9]]}]})
    assert r.status_code == 400
