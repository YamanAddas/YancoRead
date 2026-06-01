"""P-v2-5a — Annotation manager backend.

Builds on the P5b annotation backend (add/list/delete) with the two pieces a
document-wide manager needs:
  * FitzDoc.all_annotations() — every annotation in the doc, page-ordered.
  * FitzDoc.update_annotation(page, xref, spec) — edit an existing annotation's
    note text and/or color in place (a note can attach to ANY kind). Marks the
    doc dirty; returns the updated descriptor, or None for an unknown xref.
  * routes — GET /api/pdf/annotations with no `page` (or page=all) lists the
    whole document; the existing ?page=N stays a single page. POST
    /api/pdf/annotation/update edits one; 404 for a missing xref.

The shared sample PDF is 3 pages, so the cross-page list is exercised for real.
The module-global FitzDoc cache is purged after each test so Windows releases
file handles before tmp_path teardown.
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


def _spec(kind):
    """A minimal valid frontend spec for the given annotation kind."""
    s = {'kind': kind}
    if kind in ('highlight', 'underline', 'strikeout', 'squiggly', 'rect', 'oval'):
        s['rects'] = [[70, 80, 240, 96]]
    if kind == 'note':
        s['point'] = [72, 100]
        s['text'] = 'hello'
    return s


def _content_on_disk(path, page=0):
    d = fitz.open(str(path))
    try:
        return [a.info.get('content', '') for a in d.load_page(page).annots()]
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


# ── FitzDoc.all_annotations ──────────────────────────────────────────────────
def test_all_annotations_empty(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        assert doc.all_annotations() == []
    finally:
        doc.close()


def test_all_annotations_spans_pages(samples, tmp_path):
    """One annotation on each of the 3 sample pages → a single flat, page-ordered
    list (the whole point of the manager)."""
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        doc.add_annotation(0, _spec('highlight'))
        doc.add_annotation(1, _spec('note'))
        doc.add_annotation(2, _spec('rect'))
        alla = doc.all_annotations()
        assert [a['page'] for a in alla] == [0, 1, 2]
        assert {a['kind'] for a in alla} == {'Highlight', 'Text', 'Square'}
        assert all(isinstance(a['id'], int) and a['id'] > 0 for a in alla)
    finally:
        doc.close()


def test_all_annotations_cap(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        for _ in range(4):
            doc.add_annotation(0, _spec('highlight'))
        assert len(doc.all_annotations(cap=2)) == 2
    finally:
        doc.close()


# ── FitzDoc.update_annotation ────────────────────────────────────────────────
def test_update_note_text(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        desc = doc.add_annotation(1, {'kind': 'note', 'point': [72, 100], 'text': 'old'})
        out = doc.update_annotation(1, desc['id'], {'text': 'brand new note'})
        assert out is not None
        assert out['content'] == 'brand new note'
        # the listed copy reflects it too
        listed = next(a for a in doc.annotations(1) if a['id'] == desc['id'])
        assert listed['content'] == 'brand new note'
    finally:
        doc.close()


def test_update_note_on_any_kind(samples, tmp_path):
    """A note can be attached to a highlight (content is universal)."""
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        desc = doc.add_annotation(0, _spec('highlight'))
        out = doc.update_annotation(0, desc['id'], {'text': 'see clause 4'})
        assert out['content'] == 'see clause 4'
    finally:
        doc.close()


def test_update_color(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        desc = doc.add_annotation(0, _spec('highlight'))   # default yellow
        out = doc.update_annotation(0, desc['id'], {'color': [1, 0, 0]})
        assert out['color'] == pytest.approx([1.0, 0.0, 0.0], abs=0.02)
    finally:
        doc.close()


def test_update_missing_xref_returns_none(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        assert doc.update_annotation(0, 987654, {'text': 'x'}) is None
    finally:
        doc.close()


def test_update_marks_dirty(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        desc = doc.add_annotation(0, _spec('note'))
        doc.dirty = False                       # simulate a freshly-loaded doc
        doc.update_annotation(0, desc['id'], {'text': 'changed'})
        assert doc.dirty is True
    finally:
        doc.close()


# ── routes: whole-document list ──────────────────────────────────────────────
def test_api_list_all_when_page_omitted(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    client.post('/api/pdf/annotate', json={'path': str(p), 'page': 0, **_spec('highlight')})
    client.post('/api/pdf/annotate', json={'path': str(p), 'page': 2, **_spec('note')})

    r = client.get('/api/pdf/annotations', query_string={'path': str(p)})
    assert r.status_code == 200
    annots = r.get_json()['annotations']
    assert sorted(a['page'] for a in annots) == [0, 2]


def test_api_list_all_explicit(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    client.post('/api/pdf/annotate', json={'path': str(p), 'page': 1, **_spec('rect')})
    r = client.get('/api/pdf/annotations', query_string={'path': str(p), 'page': 'all'})
    assert r.status_code == 200
    assert [a['page'] for a in r.get_json()['annotations']] == [1]


def test_api_list_single_page_unchanged(client, samples, tmp_path):
    """Backward compatibility: ?page=N still returns only that page."""
    p = _copy_pdf(samples, tmp_path)
    client.post('/api/pdf/annotate', json={'path': str(p), 'page': 0, **_spec('highlight')})
    client.post('/api/pdf/annotate', json={'path': str(p), 'page': 2, **_spec('note')})

    r = client.get('/api/pdf/annotations', query_string={'path': str(p), 'page': 0})
    annots = r.get_json()['annotations']
    assert [a['page'] for a in annots] == [0]


# ── routes: update ───────────────────────────────────────────────────────────
def test_api_update_note_then_list(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    aid = client.post('/api/pdf/annotate',
                      json={'path': str(p), 'page': 1, **_spec('note')}
                      ).get_json()['annotation']['id']

    u = client.post('/api/pdf/annotation/update',
                    json={'path': str(p), 'page': 1, 'id': aid, 'text': 'reviewed'})
    assert u.status_code == 200
    assert u.get_json()['annotation']['content'] == 'reviewed'

    lst = client.get('/api/pdf/annotations', query_string={'path': str(p), 'page': 1})
    got = next(a for a in lst.get_json()['annotations'] if a['id'] == aid)
    assert got['content'] == 'reviewed'


def test_api_update_missing_path(client):
    r = client.post('/api/pdf/annotation/update', json={'page': 0, 'id': 1, 'text': 'x'})
    assert r.status_code == 400
    assert 'path' in r.get_json()['error'].lower()


def test_api_update_missing_annot_404(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/annotation/update',
                    json={'path': str(p), 'page': 0, 'id': 987654, 'text': 'x'})
    assert r.status_code == 404


def test_api_update_then_save_persists(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    aid = client.post('/api/pdf/annotate',
                      json={'path': str(p), 'page': 0, **_spec('note')}
                      ).get_json()['annotation']['id']
    client.post('/api/pdf/annotation/update',
                json={'path': str(p), 'page': 0, 'id': aid, 'text': 'persisted note'})

    s = client.post('/api/pdf/save', json={'path': str(p)})
    assert s.status_code == 200 and s.get_json()['ok'] is True
    assert 'persisted note' in _content_on_disk(p, 0)
