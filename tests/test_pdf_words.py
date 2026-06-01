"""P-v2-1a — PDF word geometry (the selectable text layer's data source).

Covers FitzDoc.word_boxes(), which returns per-word boxes for one page so the
reader can lay invisible, selectable spans over the rendered page image (giving
scanned-looking PDFs native drag-select + copy). Boxes are in the page's
*displayed* point space — the same space search_for() already overlays into — so
multiplying by the viewer's zoom positions each span exactly over its glyphs.
Also covers the Flask route GET /api/pdf/words.
"""
import fitz
import pytest

from renderers.fitzdoc import FitzDoc

LINE = 'The quick brown fox'


def _words(path, page=0):
    return FitzDoc(str(path)).word_boxes(page)


def _texts(res):
    return [w[4] for w in res['words']]


@pytest.fixture
def blank_pdf(tmp_path):
    """A page with no text at all → words must come back empty (but dims valid)."""
    doc = fitz.open()
    doc.new_page(width=300, height=400)
    p = tmp_path / 'blank.pdf'
    doc.save(str(p)); doc.close()
    return p


@pytest.fixture
def rot_pdf(tmp_path):
    """A page carrying an intrinsic /Rotate 90 — dims report rotated, words follow."""
    doc = fitz.open()
    pg = doc.new_page(width=612, height=792)
    pg.insert_text((72, 90), LINE, fontsize=14)
    pg.set_rotation(90)
    p = tmp_path / 'rot.pdf'
    doc.save(str(p)); doc.close()
    return p


# ── FitzDoc.word_boxes ──────────────────────────────────────────────────────────
def test_words_report_shape(samples):
    res = _words(samples['pdf'])
    assert set(res) >= {'page', 'width', 'height', 'rotation', 'words'}
    assert res['page'] == 0
    assert res['width'] > 0 and res['height'] > 0
    assert isinstance(res['words'], list) and res['words']


def test_words_each_box_is_xyxy_text_line(samples):
    res = _words(samples['pdf'])
    for w in res['words']:
        assert len(w) == 6
        x0, y0, x1, y1, t, line = w
        assert x0 < x1 and y0 < y1                 # a real, non-empty rectangle
        assert isinstance(t, str) and t.strip()    # never blank/whitespace-only
        assert isinstance(line, int) and line >= 0


def test_words_line_index_is_monotonic(samples):
    # the line counter only ever holds or advances (never jumps back), so the UI
    # can group consecutive words into line elements by simple equality.
    lines = [w[5] for w in _words(samples['pdf'])['words']]
    assert lines == sorted(lines)
    assert lines[0] == 0
    # the fixture has two visual lines per page → at least two distinct line ids
    assert len(set(lines)) >= 2


def test_words_carry_the_real_text(samples):
    txt = ' '.join(_texts(_words(samples['pdf'])))
    for token in ('YancoRead', 'quick', 'brown', 'fox'):
        assert token in txt


def test_words_are_in_reading_order(samples):
    # default content-stream order matches get_text('text') — the line reads L→R.
    # (the fixture's last word carries a trailing period: "fox.")
    toks = [t.rstrip('.') for t in _texts(_words(samples['pdf']))]
    seq = [t for t in toks if t in ('The', 'quick', 'brown', 'fox')]
    assert seq == ['The', 'quick', 'brown', 'fox']


def test_words_fall_within_page_rect(samples):
    res = _words(samples['pdf'])
    W, H = res['width'], res['height']
    for x0, y0, x1, y1, *_ in res['words']:
        assert 0 <= x0 and x1 <= W + 1            # +1 slack for rounding
        assert 0 <= y0 and y1 <= H + 1


def test_words_dims_match_page_rect(samples):
    d = fitz.open(str(samples['pdf']))
    try:
        r = d.load_page(0).rect
    finally:
        d.close()
    res = _words(samples['pdf'])
    assert abs(res['width'] - r.width) < 0.5
    assert abs(res['height'] - r.height) < 0.5


def test_words_second_page_independent(samples):
    # the fixture numbers each page ("page 1", "page 2", …) — page 1 says "2"
    toks = _texts(_words(samples['pdf'], page=1))
    assert '2' in toks and '1' not in toks


def test_words_blank_page_empty(blank_pdf):
    res = _words(blank_pdf)
    assert res['words'] == []
    assert res['width'] == 300 and res['height'] == 400   # dims still reported


def test_words_rotation_reported_and_dims_rotated(rot_pdf):
    res = _words(rot_pdf)
    assert res['rotation'] == 90
    # /Rotate 90 swaps the displayed rect: a 612×792 page reports 792×612
    assert round(res['width']) == 792 and round(res['height']) == 612
    for x0, y0, x1, y1, *_ in res['words']:            # words still inside it
        assert x1 <= res['width'] + 1 and y1 <= res['height'] + 1


def test_words_page_index_clamped(samples):
    n = fitz.open(str(samples['pdf'])).page_count
    assert _words(samples['pdf'], page=-5)['page'] == 0
    assert _words(samples['pdf'], page=999)['page'] == n - 1


def test_words_align_with_render_scale(samples):
    """The contract the overlay relies on: a word at point x renders at pixel
    x*zoom, so every box must sit inside the pixmap rendered at that zoom."""
    zoom = 2.0
    res = _words(samples['pdf'])
    d = fitz.open(str(samples['pdf']))
    try:
        pix = d.load_page(0).get_pixmap(matrix=fitz.Matrix(zoom, zoom))
    finally:
        d.close()
    for x0, y0, x1, y1, *_ in res['words']:
        assert x1 * zoom <= pix.width + 2
        assert y1 * zoom <= pix.height + 2


# ── Flask: GET /api/pdf/words ─────────────────────────────────────────────────────
def test_api_words_ok(client, samples):
    r = client.get('/api/pdf/words', query_string={'path': str(samples['pdf']), 'page': 0})
    assert r.status_code == 200
    b = r.get_json()
    assert b['page'] == 0 and b['words']
    assert any('quick' in w[4] for w in b['words'])


def test_api_words_default_page(client, samples):
    r = client.get('/api/pdf/words', query_string={'path': str(samples['pdf'])})
    assert r.status_code == 200
    assert r.get_json()['page'] == 0


def test_api_words_bad_page_defaults_zero(client, samples):
    r = client.get('/api/pdf/words', query_string={'path': str(samples['pdf']), 'page': 'abc'})
    assert r.status_code == 200
    assert r.get_json()['page'] == 0


def test_api_words_missing_path(client):
    r = client.get('/api/pdf/words', query_string={'page': 0})
    assert r.status_code == 400


def test_api_words_invalid_path(client, tmp_path):
    r = client.get('/api/pdf/words', query_string={'path': str(tmp_path / 'nope.pdf')})
    assert r.status_code == 400
