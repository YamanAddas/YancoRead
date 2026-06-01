"""P8a — PDF merge & split backend.

Covers two structural operations that each write a NEW file and never mutate the
source: (1) FitzDoc.merge(), which concatenates the open document ('self', with
its unsaved edits) and/or other PDFs in a given order; (2) FitzDoc.split(), which
carves one PDF per page range into a folder with collision-safe names. Plus the
Flask routes /api/pdf/merge and /api/pdf/split that drive both.

Like the form / sign / page-ops tests, every test builds its own PDFs in tmp_path
so nothing shared is touched, and the module-global FitzDoc cache is purged after
each test so Windows releases the file handles.
"""
import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc


def _make_pdf(path, tags):
    """A PDF with one page per tag; each tag is stamped as the page's only text,
    so page identity/order is verifiable by reading text straight back."""
    doc = fitz.open()
    for t in tags:
        page = doc.new_page()
        page.insert_text((72, 72), t)
    doc.save(str(path)); doc.close()
    return path


def _page_count(path) -> int:
    d = fitz.open(str(path))
    try:
        return d.page_count
    finally:
        d.close()


def _page_texts(path) -> list:
    """The trimmed text of every page, in order — bypassing the FitzDoc cache."""
    d = fitz.open(str(path))
    try:
        return [d.load_page(i).get_text().strip() for i in range(d.page_count)]
    finally:
        d.close()


@pytest.fixture
def doc_a(tmp_path):
    return _make_pdf(tmp_path / 'a.pdf', ['A0', 'A1'])


@pytest.fixture
def doc_b(tmp_path):
    return _make_pdf(tmp_path / 'b.pdf', ['B0', 'B1', 'B2'])


@pytest.fixture
def doc_c(tmp_path):
    return _make_pdf(tmp_path / 'c.pdf', ['C0'])


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


# ── FitzDoc.merge ────────────────────────────────────────────────────────────────
def test_merge_self_and_other(tmp_path, doc_a, doc_b):
    out = tmp_path / 'merged.pdf'
    res = FitzDoc(str(doc_a)).merge(str(out), ['self', str(doc_b)])
    assert res['pages'] == 5
    assert res['name'] == 'merged.pdf'
    assert _page_count(out) == 5
    assert _page_texts(out) == ['A0', 'A1', 'B0', 'B1', 'B2']


def test_merge_respects_order(tmp_path, doc_a, doc_b, doc_c):
    out = tmp_path / 'ordered.pdf'
    FitzDoc(str(doc_a)).merge(str(out), [str(doc_c), str(doc_b)])
    assert _page_texts(out) == ['C0', 'B0', 'B1', 'B2']


def test_merge_self_only(tmp_path, doc_a):
    out = tmp_path / 'selfonly.pdf'
    res = FitzDoc(str(doc_a)).merge(str(out), ['self'])
    assert res['pages'] == 2
    assert _page_texts(out) == ['A0', 'A1']


def test_merge_includes_unsaved_edits(tmp_path, doc_a):
    """'self' is the live in-memory doc, so an unsaved edit rides into the merge."""
    out = tmp_path / 'edited.pdf'
    d = FitzDoc(str(doc_a))
    d.rotate_page(0, absolute=90)        # in memory only — never saved to doc_a
    d.merge(str(out), ['self'])
    merged = fitz.open(str(out))
    try:
        assert merged.load_page(0).rotation == 90
    finally:
        merged.close()
    # the source on disk is untouched
    src = fitz.open(str(doc_a))
    try:
        assert src.load_page(0).rotation == 0
    finally:
        src.close()


def test_merge_leaves_sources_untouched(tmp_path, doc_a, doc_b):
    out = tmp_path / 'merged.pdf'
    FitzDoc(str(doc_a)).merge(str(out), ['self', str(doc_b)])
    assert _page_count(doc_a) == 2
    assert _page_count(doc_b) == 3


def test_merge_empty_sequence_raises(tmp_path, doc_a):
    with pytest.raises(ValueError):
        FitzDoc(str(doc_a)).merge(str(tmp_path / 'x.pdf'), [])


def test_merge_non_pdf_in_sequence_raises(tmp_path, doc_a, samples):
    with pytest.raises(ValueError):
        FitzDoc(str(doc_a)).merge(str(tmp_path / 'x.pdf'), ['self', str(samples['txt'])])


def test_merge_missing_file_raises(tmp_path, doc_a):
    with pytest.raises(ValueError):
        FitzDoc(str(doc_a)).merge(str(tmp_path / 'x.pdf'),
                                  ['self', str(tmp_path / 'ghost.pdf')])


# ── FitzDoc.split ────────────────────────────────────────────────────────────────
def test_split_multiple_ranges(tmp_path):
    src = _make_pdf(tmp_path / 's.pdf', ['0', '1', '2', '3', '4'])
    out = tmp_path / 'out'; out.mkdir()
    res = FitzDoc(str(src)).split(str(out), [[0, 0], [1, 2]])
    assert res['count'] == 2
    names = sorted(f['name'] for f in res['files'])
    assert names == ['s (p1).pdf', 's (p2-3).pdf']
    by_name = {f['name']: f for f in res['files']}
    assert by_name['s (p1).pdf']['pages'] == 1
    assert by_name['s (p2-3).pdf']['pages'] == 2
    for f in res['files']:
        assert (out / f['name']).is_file()


def test_split_each_page(tmp_path):
    src = _make_pdf(tmp_path / 's.pdf', ['0', '1', '2'])
    out = tmp_path / 'out'; out.mkdir()
    res = FitzDoc(str(src)).split(str(out), [[0, 0], [1, 1], [2, 2]])
    assert res['count'] == 3
    assert all(f['pages'] == 1 for f in res['files'])


def test_split_reversed_range_tolerated(tmp_path):
    src = _make_pdf(tmp_path / 's.pdf', ['0', '1', '2', '3'])
    out = tmp_path / 'out'; out.mkdir()
    res = FitzDoc(str(src)).split(str(out), [[2, 0]])
    assert res['files'][0]['name'] == 's (p1-3).pdf'
    assert res['files'][0]['pages'] == 3


def test_split_custom_stem(tmp_path):
    src = _make_pdf(tmp_path / 's.pdf', ['0', '1'])
    out = tmp_path / 'out'; out.mkdir()
    res = FitzDoc(str(src)).split(str(out), [[0, 0]], stem='Chapter')
    assert res['files'][0]['name'] == 'Chapter (p1).pdf'


def test_split_unique_naming(tmp_path):
    src = _make_pdf(tmp_path / 's.pdf', ['0', '1'])
    out = tmp_path / 'out'; out.mkdir()
    d = FitzDoc(str(src))
    first = d.split(str(out), [[0, 0]])['files'][0]['name']
    second = d.split(str(out), [[0, 0]])['files'][0]['name']
    assert first == 's (p1).pdf'
    assert second == 's (p1) (2).pdf'
    assert (out / first).is_file() and (out / second).is_file()


def test_split_out_of_range_raises(tmp_path):
    src = _make_pdf(tmp_path / 's.pdf', ['0', '1'])
    out = tmp_path / 'out'; out.mkdir()
    with pytest.raises(ValueError):
        FitzDoc(str(src)).split(str(out), [[0, 99]])


def test_split_empty_ranges_raises(tmp_path):
    src = _make_pdf(tmp_path / 's.pdf', ['0'])
    out = tmp_path / 'out'; out.mkdir()
    with pytest.raises(ValueError):
        FitzDoc(str(src)).split(str(out), [])


def test_split_missing_dir_raises(tmp_path):
    src = _make_pdf(tmp_path / 's.pdf', ['0'])
    with pytest.raises(ValueError):
        FitzDoc(str(src)).split(str(tmp_path / 'no_such_dir'), [[0, 0]])


def test_split_leaves_source_untouched(tmp_path):
    src = _make_pdf(tmp_path / 's.pdf', ['0', '1', '2'])
    out = tmp_path / 'out'; out.mkdir()
    FitzDoc(str(src)).split(str(out), [[0, 1]])
    assert _page_count(src) == 3


# ── Flask: POST /api/pdf/merge ─────────────────────────────────────────────────────
def test_api_merge_self_and_other(client, tmp_path, doc_a, doc_b):
    out = tmp_path / 'merged.pdf'
    r = client.post('/api/pdf/merge',
                    json={'path': str(doc_a), 'target': str(out),
                          'sequence': ['self', str(doc_b)]})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ok'] is True and b['pages'] == 5
    assert _page_count(out) == 5


def test_api_merge_missing_path(client, tmp_path):
    r = client.post('/api/pdf/merge',
                    json={'target': str(tmp_path / 'm.pdf'), 'sequence': ['self']})
    assert r.status_code == 400


def test_api_merge_non_pdf_source(client, tmp_path, samples):
    r = client.post('/api/pdf/merge',
                    json={'path': str(samples['txt']), 'target': str(tmp_path / 'm.pdf'),
                          'sequence': ['self']})
    assert r.status_code == 400


def test_api_merge_missing_target(client, doc_a):
    r = client.post('/api/pdf/merge',
                    json={'path': str(doc_a), 'sequence': ['self']})
    assert r.status_code == 400


def test_api_merge_empty_sequence(client, tmp_path, doc_a):
    r = client.post('/api/pdf/merge',
                    json={'path': str(doc_a), 'target': str(tmp_path / 'm.pdf'),
                          'sequence': []})
    assert r.status_code == 400


def test_api_merge_bad_target_folder(client, doc_a):
    r = client.post('/api/pdf/merge',
                    json={'path': str(doc_a),
                          'target': str(doc_a.parent / 'no_dir' / 'm.pdf'),
                          'sequence': ['self']})
    assert r.status_code == 400


def test_api_merge_non_pdf_in_sequence_400(client, tmp_path, doc_a, samples):
    r = client.post('/api/pdf/merge',
                    json={'path': str(doc_a), 'target': str(tmp_path / 'm.pdf'),
                          'sequence': ['self', str(samples['txt'])]})
    assert r.status_code == 400


# ── Flask: POST /api/pdf/split ─────────────────────────────────────────────────────
def test_api_split_happy(client, tmp_path):
    src = _make_pdf(tmp_path / 's.pdf', ['0', '1', '2'])
    out = tmp_path / 'out'; out.mkdir()
    r = client.post('/api/pdf/split',
                    json={'path': str(src), 'dir': str(out),
                          'ranges': [[0, 0], [1, 2]]})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ok'] is True and b['count'] == 2
    assert all((out / f['name']).is_file() for f in b['files'])


def test_api_split_missing_path(client, tmp_path):
    r = client.post('/api/pdf/split',
                    json={'dir': str(tmp_path), 'ranges': [[0, 0]]})
    assert r.status_code == 400


def test_api_split_non_pdf(client, tmp_path, samples):
    r = client.post('/api/pdf/split',
                    json={'path': str(samples['txt']), 'dir': str(tmp_path),
                          'ranges': [[0, 0]]})
    assert r.status_code == 400


def test_api_split_bad_dir(client, tmp_path, doc_a):
    r = client.post('/api/pdf/split',
                    json={'path': str(doc_a), 'dir': str(tmp_path / 'no_dir'),
                          'ranges': [[0, 0]]})
    assert r.status_code == 400


def test_api_split_empty_ranges(client, tmp_path, doc_a):
    r = client.post('/api/pdf/split',
                    json={'path': str(doc_a), 'dir': str(tmp_path), 'ranges': []})
    assert r.status_code == 400


def test_api_split_out_of_range(client, tmp_path, doc_a):
    r = client.post('/api/pdf/split',
                    json={'path': str(doc_a), 'dir': str(tmp_path),
                          'ranges': [[0, 99]]})
    assert r.status_code == 400
