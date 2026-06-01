"""P-v2-5c — Annotation export / import (JSON + XFDF).

Round-trips every annotation kind through both serializers:
  * JSON  — YancoRead-native, full fidelity, top-left points.
  * XFDF  — Adobe XML interchange (bottom-left PDF user space), so other tools
            can read our markup and we can read theirs.

The strategy for the round-trip tests: seed a *copy* of the shared 3-page
sample, export, then import into a SECOND fresh copy of the same sample and
assert the recreated annotations match (kind, page, note text, colour and —
within a small tolerance — geometry). Because both copies share the page size,
the XFDF Y-flip is exercised for real and must land back where it started.

The module-global FitzDoc cache is purged after each test so Windows releases
file handles before tmp_path teardown.
"""
import shutil
import xml.etree.ElementTree as ET

import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc


def _copy_pdf(samples, tmp_path, name='work.pdf'):
    dest = tmp_path / name
    shutil.copy2(samples['pdf'], dest)
    return dest


def _seed(doc):
    """Add a representative spread of kinds across all 3 pages. Returns the
    expected (kind, page, content) multiset."""
    h = doc.add_annotation(0, {'kind': 'highlight', 'rects': [[70, 80, 240, 96]]})
    doc.update_annotation(0, h['id'], {'text': 'see note'})          # popup note on a highlight
    doc.add_annotation(0, {'kind': 'ink', 'strokes': [[[70, 450], [90, 470], [120, 450]]],
                           'color': [0, 0, 0]})
    doc.add_annotation(1, {'kind': 'note', 'point': [72, 100], 'text': 'remember'})
    doc.add_annotation(1, {'kind': 'rect', 'rects': [[50, 200, 150, 260]], 'color': [1, 0, 0]})
    doc.add_annotation(2, {'kind': 'line', 'points': [[70, 400], [240, 420]], 'color': [0, 0, 1]})
    return {('Highlight', 0, 'see note'), ('Ink', 0, ''), ('Text', 1, 'remember'),
            ('Square', 1, ''), ('Line', 2, '')}


def _triples(doc):
    return {(a['kind'], a['page'], a.get('content', '')) for a in doc.all_annotations()}


def _by_kind(doc):
    return {a['kind']: a for a in doc.all_annotations()}


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


# ── export shape ─────────────────────────────────────────────────────────────
def test_export_json_shape(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        expected = _seed(doc)
        import json
        obj = json.loads(doc.export_annotations('json'))
        assert obj['yancoread_annotations'] == 1
        assert obj['count'] == len(expected) == 5
        # records store our *input* kind (not the PDF subtype)
        assert {a['kind'] for a in obj['annotations']} == {'highlight', 'ink', 'note', 'rect', 'line'}
        assert {a['page'] for a in obj['annotations']} == {0, 1, 2}
        assert any(a.get('content') == 'see note' for a in obj['annotations'])
    finally:
        doc.close()


def test_export_xfdf_is_valid_xml(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        _seed(doc)
        xml = doc.export_annotations('xfdf')
        assert xml.startswith('<?xml')
        root = ET.fromstring(xml)                       # must parse
        assert root.tag.endswith('xfdf')
        tags = {el.tag.split('}')[-1] for el in root.iter()}
        assert {'highlight', 'ink', 'text', 'square', 'line'} <= tags
    finally:
        doc.close()


def test_export_empty_doc(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        import json
        assert json.loads(doc.export_annotations('json'))['annotations'] == []
        ET.fromstring(doc.export_annotations('xfdf'))   # still valid, just no annots
    finally:
        doc.close()


# ── full round-trips (export A → import fresh B) ──────────────────────────────
@pytest.mark.parametrize('fmt', ['json', 'xfdf'])
def test_roundtrip_kinds_and_notes(samples, tmp_path, fmt):
    src = _copy_pdf(samples, tmp_path, 'src.pdf')
    a = FitzDoc(str(src))
    try:
        expected = _seed(a)
        blob = a.export_annotations(fmt)
    finally:
        a.close()

    dst = _copy_pdf(samples, tmp_path, 'dst.pdf')
    b = FitzDoc(str(dst))
    try:
        report = b.import_annotations(blob, fmt)
        assert report['added'] == 5 and report['skipped'] == 0
        assert _triples(b) == expected
    finally:
        b.close()


@pytest.mark.parametrize('fmt', ['json', 'xfdf'])
def test_roundtrip_colors(samples, tmp_path, fmt):
    src = _copy_pdf(samples, tmp_path, 'src.pdf')
    a = FitzDoc(str(src))
    try:
        _seed(a)
        a_cols = {k: v.get('color') for k, v in _by_kind(a).items()}
        blob = a.export_annotations(fmt)
    finally:
        a.close()

    dst = _copy_pdf(samples, tmp_path, 'dst.pdf')
    b = FitzDoc(str(dst))
    try:
        b.import_annotations(blob, fmt)
        b_cols = {k: v.get('color') for k, v in _by_kind(b).items()}
        # explicitly-set colours land on their exact values …
        assert b_cols['Square'] == pytest.approx([1, 0, 0], abs=0.02)
        assert b_cols['Line'] == pytest.approx([0, 0, 1], abs=0.02)
        # … and every colour round-trips within hex quantization (XFDF writes
        # #rrggbb), including the highlight's default marker yellow.
        for kind in ('Highlight', 'Square', 'Line'):
            assert b_cols[kind] == pytest.approx(a_cols[kind], abs=0.02), \
                f'{kind} colour drifted: {a_cols[kind]} -> {b_cols[kind]}'
    finally:
        b.close()


@pytest.mark.parametrize('fmt', ['json', 'xfdf'])
def test_roundtrip_geometry_within_tolerance(samples, tmp_path, fmt):
    """The recreated bounding rects land where the originals were (XFDF exercises
    the Y-flip, so a sign error here would move everything to the wrong end of the
    page and blow the tolerance)."""
    src = _copy_pdf(samples, tmp_path, 'src.pdf')
    a = FitzDoc(str(src))
    try:
        _seed(a)
        a_rects = {k: v['rect'] for k, v in _by_kind(a).items()}
        blob = a.export_annotations(fmt)
    finally:
        a.close()

    dst = _copy_pdf(samples, tmp_path, 'dst.pdf')
    b = FitzDoc(str(dst))
    try:
        b.import_annotations(blob, fmt)
        b_rects = {k: v['rect'] for k, v in _by_kind(b).items()}
        for kind in ('Highlight', 'Text', 'Square', 'Line', 'Ink'):
            for av, bv in zip(a_rects[kind], b_rects[kind]):
                assert abs(av - bv) <= 2.5, f'{kind}: {a_rects[kind]} vs {b_rects[kind]}'
    finally:
        b.close()


def test_xfdf_flip_is_not_identity(samples, tmp_path):
    """Guard: a top page annotation must NOT export to the same Y in XFDF (proves
    the bottom-left flip actually happens, not a silent no-op)."""
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        doc.add_annotation(0, {'kind': 'rect', 'rects': [[50, 40, 150, 90]]})  # near the top
        xml = doc.export_annotations('xfdf')
        root = ET.fromstring(xml)
        sq = next(el for el in root.iter() if el.tag.endswith('square'))
        ys = [float(t) for t in sq.get('rect').split(',')]
        page_h = doc.doc.load_page(0).rect.height
        assert ys[1] > page_h / 2, 'a top annotation should sit high in bottom-left space'
    finally:
        doc.close()


def test_json_accepts_bare_list(samples, tmp_path):
    """import tolerates a bare JSON array (not just the wrapped object)."""
    dst = _copy_pdf(samples, tmp_path)
    b = FitzDoc(str(dst))
    try:
        import json
        data = json.dumps([{'kind': 'note', 'page': 0, 'point': [72, 90], 'text': 'hi'}])
        assert b.import_annotations(data, 'json')['added'] == 1
        assert _triples(b) == {('Text', 0, 'hi')}
    finally:
        b.close()


def test_import_external_xfdf(samples, tmp_path):
    """Parse a hand-written, Acrobat-style XFDF (namespaced) — the whole point of
    supporting XFDF is reading markup made elsewhere."""
    dst = _copy_pdf(samples, tmp_path)
    b = FitzDoc(str(dst))
    try:
        xfdf = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve"><annots>'
            '<highlight page="0" rect="70,700,240,716" color="#ffff00" '
            'coords="70,716,240,716,70,700,240,700"><contents>from acrobat</contents></highlight>'
            '<text page="2" rect="72,500,88,516" color="#ff0000"><contents>review this</contents></text>'
            '</annots></xfdf>'
        )
        report = b.import_annotations(xfdf, 'xfdf')
        assert report['added'] == 2
        assert _triples(b) == {('Highlight', 0, 'from acrobat'), ('Text', 2, 'review this')}
    finally:
        b.close()


def test_import_bad_xfdf_raises_valueerror(samples, tmp_path):
    dst = _copy_pdf(samples, tmp_path)
    b = FitzDoc(str(dst))
    try:
        with pytest.raises(ValueError):
            b.import_annotations('<xfdf><annots><highlight></annots>', 'xfdf')   # malformed
    finally:
        b.close()


# ── Flask routes ─────────────────────────────────────────────────────────────
def test_api_export_default_dest_json(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    client.post('/api/pdf/annotate', json={'path': str(p), 'page': 0,
                                            'kind': 'highlight', 'rects': [[70, 80, 240, 96]]})
    r = client.post('/api/pdf/annotations/export', json={'path': str(p), 'fmt': 'json'})
    assert r.status_code == 200
    outp = tmp_path / r.get_json()['name']
    assert outp.name == 'work-annotations.json' and outp.is_file()
    import json
    obj = json.loads(outp.read_text(encoding='utf-8'))
    assert obj['count'] == 1 and obj['annotations'][0]['kind'] == 'highlight'


def test_api_export_explicit_dest_xfdf(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    client.post('/api/pdf/annotate', json={'path': str(p), 'page': 1,
                                            'kind': 'note', 'point': [72, 100], 'text': 'x'})
    dest = tmp_path / 'out.xfdf'
    r = client.post('/api/pdf/annotations/export',
                    json={'path': str(p), 'fmt': 'xfdf', 'dest': str(dest)})
    assert r.status_code == 200 and r.get_json()['dest'] == str(dest)
    assert dest.read_text(encoding='utf-8').startswith('<?xml')


def test_api_export_bad_fmt(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/annotations/export', json={'path': str(p), 'fmt': 'docx'})
    assert r.status_code == 400


def test_api_import_json_then_list(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    import json
    data = json.dumps({'annotations': [
        {'kind': 'rect', 'page': 0, 'rects': [[40, 50, 120, 110]], 'color': [1, 0, 0]},
        {'kind': 'note', 'page': 1, 'point': [72, 90], 'text': 'imported'},
    ]})
    r = client.post('/api/pdf/annotations/import', json={'path': str(p), 'data': data})
    assert r.status_code == 200
    body = r.get_json()
    assert body['added'] == 2 and body['fmt'] == 'json'

    lst = client.get('/api/pdf/annotations', query_string={'path': str(p)}).get_json()['annotations']
    assert {(a['kind'], a['page']) for a in lst} == {('Square', 0), ('Text', 1)}


def test_api_import_infers_xfdf(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    xfdf = ('<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
            '<square page="0" rect="40,40,120,120" color="#00ff00"/></annots></xfdf>')
    r = client.post('/api/pdf/annotations/import', json={'path': str(p), 'data': xfdf})  # no fmt
    assert r.status_code == 200
    assert r.get_json()['fmt'] == 'xfdf' and r.get_json()['added'] == 1


def test_api_import_then_save_persists(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    import json
    data = json.dumps([{'kind': 'note', 'page': 0, 'point': [72, 90], 'text': 'persist me'}])
    client.post('/api/pdf/annotations/import', json={'path': str(p), 'data': data})
    s = client.post('/api/pdf/save', json={'path': str(p)})
    assert s.status_code == 200 and s.get_json()['ok'] is True

    d = fitz.open(str(p))
    try:
        contents = [a.info.get('content', '') for a in d.load_page(0).annots()]
    finally:
        d.close()
    assert 'persist me' in contents


def test_api_import_missing_path(client):
    assert client.post('/api/pdf/annotations/import',
                       json={'data': '[]'}).status_code == 400


def test_api_import_no_data(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    assert client.post('/api/pdf/annotations/import',
                       json={'path': str(p), 'data': ''}).status_code == 400
