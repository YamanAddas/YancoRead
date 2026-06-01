"""P5d — PDF page operations.

P5d-1: rotate a single page and persist it as the page's /Rotate. Rotation is
reversible metadata, so it rides the existing in-place incremental Save path
(shared with annotations). Every save-path test works on a *copy* of the shared
sample so the fixture original is never mutated, and the module-global FitzDoc
cache is purged after each test so Windows releases the file handle.
"""
import shutil

import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc


def _copy_pdf(samples, tmp_path, name='work.pdf'):
    dest = tmp_path / name
    shutil.copy2(samples['pdf'], dest)
    return dest


def _rotation(path, index=0) -> int:
    d = fitz.open(str(path))
    try:
        return d.load_page(index).rotation
    finally:
        d.close()


def _page_count(path) -> int:
    d = fitz.open(str(path))
    try:
        return d.page_count
    finally:
        d.close()


def _page_text(path, index=0) -> str:
    d = fitz.open(str(path))
    try:
        return d.load_page(index).get_text()
    finally:
        d.close()


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


# ── FitzDoc level ────────────────────────────────────────────────────────────
def test_rotate_relative_default_is_quarter_turn(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        assert doc.rotate_page(0)['rotation'] == 90
        assert doc.rotate_page(0)['rotation'] == 180   # accumulates
        assert doc.rotate_page(0, delta=-90)['rotation'] == 90
    finally:
        doc.close()


def test_rotate_wraps_modulo_360(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        doc.rotate_page(0, absolute=270)
        assert doc.rotate_page(0, delta=90)['rotation'] == 0   # 270+90 → 0
        assert doc.rotate_page(0, delta=-90)['rotation'] == 270  # 0-90 → 270
    finally:
        doc.close()


def test_rotate_absolute_and_snap(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        assert doc.rotate_page(0, absolute=180)['rotation'] == 180
        assert doc.rotate_page(0, absolute=47)['rotation'] == 0    # stray angle snaps
    finally:
        doc.close()


def test_rotate_marks_dirty(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        assert doc.dirty is False
        doc.rotate_page(1)
        assert doc.dirty is True
    finally:
        doc.close()


def test_rotate_clamps_out_of_range_index(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        res = doc.rotate_page(999)               # clamps to last page, no raise
        assert res['page'] == doc.doc.page_count - 1
    finally:
        doc.close()


# ── Flask endpoints ──────────────────────────────────────────────────────────
def test_api_rotate_page(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/rotate-page', json={'path': str(p), 'page': 0})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ok'] is True and b['page'] == 0 and b['rotation'] == 90


def test_api_rotate_then_save_persists(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    assert _rotation(p, 0) == 0
    before = _page_count(p)

    client.post('/api/pdf/rotate-page', json={'path': str(p), 'page': 0, 'delta': 90})
    s = client.post('/api/pdf/save', json={'path': str(p)})
    assert s.status_code == 200
    sb = s.get_json()
    assert sb['saved'] is True and sb['mode'] == 'incremental'

    assert _rotation(p, 0) == 90, 'rotation must persist to disk after save'
    assert _page_count(p) == before, 'rotation must not change the page count'


def test_api_rotate_rejects_non_pdf(client, samples):
    r = client.post('/api/pdf/rotate-page', json={'path': str(samples['txt']), 'page': 0})
    assert r.status_code == 400


def test_api_rotate_missing_path(client):
    assert client.post('/api/pdf/rotate-page', json={'page': 0}).status_code == 400


def test_api_rotate_bad_numbers(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/rotate-page', json={'path': str(p), 'page': 'x'})
    assert r.status_code == 400


# ── P5d-2: organize (export arranged copy) ───────────────────────────────────
def test_export_reorders_pages(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    out = tmp_path / 'reordered.pdf'
    doc = FitzDoc(str(p))
    try:
        res = doc.export_arranged(str(out), [{'src': 2}, {'src': 0}, {'src': 1}])
        assert res['pages'] == 3
    finally:
        doc.close()
    assert 'page 3' in _page_text(out, 0)
    assert 'page 1' in _page_text(out, 1)
    assert 'page 2' in _page_text(out, 2)


def test_export_drops_omitted_pages(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    out = tmp_path / 'subset.pdf'
    doc = FitzDoc(str(p))
    try:
        doc.export_arranged(str(out), [{'src': 0}, {'src': 2}])   # drop page 2
    finally:
        doc.close()
    assert _page_count(out) == 2
    assert 'page 3' in _page_text(out, 1)


def test_export_duplicates_repeated_src(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    out = tmp_path / 'dup.pdf'
    doc = FitzDoc(str(p))
    try:
        doc.export_arranged(str(out), [{'src': 0}, {'src': 0}])
    finally:
        doc.close()
    assert _page_count(out) == 2
    assert 'page 1' in _page_text(out, 0) and 'page 1' in _page_text(out, 1)


def test_export_applies_rotation_delta(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    out = tmp_path / 'rot.pdf'
    doc = FitzDoc(str(p))
    try:
        doc.export_arranged(str(out), [{'src': 0, 'rotate': 90}, {'src': 1}])
    finally:
        doc.close()
    assert _rotation(out, 0) == 90
    assert _rotation(out, 1) == 0


def test_export_leaves_source_untouched(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    out = tmp_path / 'out.pdf'
    doc = FitzDoc(str(p))
    try:
        doc.export_arranged(str(out), [{'src': 2, 'rotate': 90}])
        assert doc.dirty is False, 'organize must not mark the working doc dirty'
        assert doc.doc.page_count == 3
        assert doc.doc.load_page(0).rotation == 0
    finally:
        doc.close()
    assert _page_count(p) == 3, 'source file on disk must be unchanged'
    assert _rotation(p, 0) == 0


def test_export_empty_plan_raises(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        with pytest.raises(ValueError):
            doc.export_arranged(str(tmp_path / 'x.pdf'), [])
    finally:
        doc.close()


def test_export_out_of_range_raises(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        with pytest.raises(ValueError):
            doc.export_arranged(str(tmp_path / 'x.pdf'), [{'src': 99}])
    finally:
        doc.close()


def test_api_organize_writes_new_file(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    out = tmp_path / 'organized.pdf'
    r = client.post('/api/pdf/organize',
                    json={'path': str(p), 'target': str(out),
                          'plan': [{'src': 1}, {'src': 0}]})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ok'] is True and b['pages'] == 2 and b['name'] == 'organized.pdf'
    assert out.is_file()
    assert 'page 2' in _page_text(out, 0)
    assert _page_count(p) == 3, 'original must be untouched'


def test_api_organize_rejects_same_path(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/organize',
                    json={'path': str(p), 'target': str(p), 'plan': [{'src': 0}]})
    assert r.status_code == 409


def test_api_organize_rejects_non_pdf(client, samples, tmp_path):
    r = client.post('/api/pdf/organize',
                    json={'path': str(samples['txt']), 'target': str(tmp_path / 'o.pdf'),
                          'plan': [{'src': 0}]})
    assert r.status_code == 400


def test_api_organize_empty_plan(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/organize',
                    json={'path': str(p), 'target': str(tmp_path / 'o.pdf'), 'plan': []})
    assert r.status_code == 400


def test_api_organize_bad_src(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/organize',
                    json={'path': str(p), 'target': str(tmp_path / 'o.pdf'),
                          'plan': [{'src': 99}]})
    assert r.status_code == 400
