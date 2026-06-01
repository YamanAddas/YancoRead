"""P5b — PDF annotation backend: add / list / delete + persist via save().

Every test that touches the save path works on a *copy* of the shared session
sample, never the fixture original. A copy is also used for in-memory tests so
the module-global FitzDoc cache can't leak a mutated doc across the suite.
"""
import shutil

import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc

PNG_MAGIC = b'\x89PNG\r\n\x1a\n'

# input kind  ->  PDF subtype string PyMuPDF reports via annot.type[1]
KIND_SUBTYPE = {
    'highlight': 'Highlight',
    'underline': 'Underline',
    'strikeout': 'StrikeOut',
    'squiggly': 'Squiggly',
    'rect': 'Square',
    'oval': 'Circle',
    'line': 'Line',
    'ink': 'Ink',
    'note': 'Text',
    'freetext': 'FreeText',
}


def _copy_pdf(samples, tmp_path, name='work.pdf'):
    dest = tmp_path / name
    shutil.copy2(samples['pdf'], dest)
    return dest


def _annot_count(path) -> int:
    d = fitz.open(str(path))
    try:
        return sum(1 for _ in d.load_page(0).annots())
    finally:
        d.close()


def _spec(kind):
    """A minimal valid frontend spec for the given annotation kind."""
    s = {'kind': kind}
    if kind in ('highlight', 'underline', 'strikeout', 'squiggly',
                'rect', 'oval', 'freetext'):
        s['rects'] = [[70, 80, 240, 96]]
    if kind == 'line':
        s['points'] = [[70, 80], [240, 80]]
    if kind == 'ink':
        s['strokes'] = [[[70, 80], [90, 100], [120, 80]]]
    if kind == 'note':
        s['point'] = [72, 100]
    if kind in ('note', 'freetext'):
        s['text'] = 'hello'
    return s


@pytest.fixture(autouse=True)
def _purge_doc_cache():
    """Drop+close any cached docs after each test so Windows releases the file
    handles before tmp_path teardown (a dirty doc is never auto-evicted)."""
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
@pytest.mark.parametrize('kind,subtype', sorted(KIND_SUBTYPE.items()))
def test_add_kind_roundtrips(samples, tmp_path, kind, subtype):
    p = _copy_pdf(samples, tmp_path, f'{kind}.pdf')
    doc = FitzDoc(str(p))
    try:
        desc = doc.add_annotation(0, _spec(kind))
        assert isinstance(desc['id'], int) and desc['id'] > 0
        assert desc['kind'] == subtype
        assert desc['page'] == 0
        assert doc.dirty is True, 'adding an annotation must mark the doc dirty'
        listed = doc.annotations(0)
        assert any(a['id'] == desc['id'] for a in listed), 'new annot must be listed'
    finally:
        doc.close()


def test_highlight_renders(samples, tmp_path):
    """The version-sensitive add_highlight_annot([rect]) path renders cleanly."""
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        doc.add_annotation(0, _spec('highlight'))
        png = doc.render_page(0, 1.0)
        assert png[:8] == PNG_MAGIC, 'page with an annotation must still render'
    finally:
        doc.close()


def test_note_preserves_text(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        desc = doc.add_annotation(0, {'kind': 'note', 'point': [72, 100],
                                      'text': 'remember this'})
        assert desc['content'] == 'remember this'
    finally:
        doc.close()


def test_unsupported_kind_raises(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        with pytest.raises(ValueError):
            doc.add_annotation(0, {'kind': 'wormhole', 'rects': [[1, 2, 3, 4]]})
    finally:
        doc.close()


def test_delete_annotation(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        desc = doc.add_annotation(0, _spec('highlight'))
        assert len(doc.annotations(0)) == 1
        assert doc.delete_annotation(0, desc['id']) is True
        assert doc.annotations(0) == []
        assert doc.delete_annotation(0, 999999) is False, 'missing xref → False'
    finally:
        doc.close()


# ── Flask endpoints ──────────────────────────────────────────────────────────
def test_api_annotate_and_list(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/annotate',
                    json={'path': str(p), 'page': 0, **_spec('highlight')})
    assert r.status_code == 200
    annot = r.get_json()['annotation']
    assert annot['kind'] == 'Highlight' and annot['id'] > 0

    lst = client.get('/api/pdf/annotations', query_string={'path': str(p), 'page': 0})
    assert lst.status_code == 200
    assert annot['id'] in [a['id'] for a in lst.get_json()['annotations']]


def test_api_annotate_then_save_persists(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    assert _annot_count(p) == 0
    r = client.post('/api/pdf/annotate',
                    json={'path': str(p), 'page': 0, **_spec('highlight')})
    assert r.status_code == 200

    s = client.post('/api/pdf/save', json={'path': str(p)})
    assert s.status_code == 200
    sb = s.get_json()
    assert sb['ok'] is True and sb['saved'] is True and sb['mode'] == 'incremental'
    assert _annot_count(p) == 1, 'annotation must persist to disk after save'


def test_api_annotate_rejects_non_pdf(client, samples):
    r = client.post('/api/pdf/annotate',
                    json={'path': str(samples['txt']), 'page': 0, **_spec('highlight')})
    assert r.status_code == 400
    assert 'PDF' in r.get_json()['error']


def test_api_annotate_unknown_kind(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/annotate',
                    json={'path': str(p), 'page': 0, 'kind': 'wormhole',
                          'rects': [[1, 2, 3, 4]]})
    assert r.status_code == 400


def test_api_annotate_missing_path(client):
    assert client.post('/api/pdf/annotate',
                       json={'page': 0, 'kind': 'highlight'}).status_code == 400


def test_api_annotation_delete(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    aid = client.post('/api/pdf/annotate',
                      json={'path': str(p), 'page': 0, **_spec('note')}
                      ).get_json()['annotation']['id']

    d = client.post('/api/pdf/annotation/delete',
                    json={'path': str(p), 'page': 0, 'id': aid})
    assert d.status_code == 200 and d.get_json()['ok'] is True

    lst = client.get('/api/pdf/annotations', query_string={'path': str(p), 'page': 0})
    assert all(a['id'] != aid for a in lst.get_json()['annotations'])


def test_api_annotation_delete_missing_is_404(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/annotation/delete',
                    json={'path': str(p), 'page': 0, 'id': 987654})
    assert r.status_code == 404
