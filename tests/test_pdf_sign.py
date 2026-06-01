"""P6a — PDF Sign & stamp backend.

Covers three layers: (1) FitzDoc.place_image, which bakes a PNG into a page's
content stream (NOT an annotation) yet keeps the doc incrementally savable, so a
signature rides the in-place Save path; (2) the SignatureStore reusable-signature
library; (3) the Flask routes that drive both.

Like the page-ops tests, every save-path test works on a *copy* of the shared
sample so the fixture original is never mutated, and the module-global FitzDoc
cache is purged after each test so Windows releases the file handle. Signature
tests use a SignatureStore rooted in tmp_path — never the real %APPDATA% library.
"""
import base64
import shutil

import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc
from signatures import SignatureStore, decode_png_data, _png_dims


def _copy_pdf(samples, tmp_path, name='work.pdf'):
    dest = tmp_path / name
    shutil.copy2(samples['pdf'], dest)
    return dest


def _png_bytes(w=48, h=24) -> bytes:
    """A small valid PNG (cv2, like conftest) — content is irrelevant here; the
    backend only needs a real PNG to size and stamp."""
    import cv2
    import numpy as np
    img = np.full((h, w, 3), 200, np.uint8)
    return cv2.imencode('.png', img)[1].tobytes()


def _image_count(path, index=0) -> int:
    d = fitz.open(str(path))
    try:
        return len(d.load_page(index).get_images())
    finally:
        d.close()


def _page_count(path) -> int:
    d = fitz.open(str(path))
    try:
        return d.page_count
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


@pytest.fixture
def iso_signatures(tmp_path):
    """Point the app's signature store at a temp dir, never the real library."""
    import app as app_module
    original = app_module.signatures
    app_module.signatures = SignatureStore(tmp_path / 'sigs')
    try:
        yield app_module.signatures
    finally:
        app_module.signatures = original


# ── SignatureStore ──────────────────────────────────────────────────────────────
def test_store_add_and_list(tmp_path):
    store = SignatureStore(tmp_path / 's')
    assert store.list() == []
    e = store.add(_png_bytes(60, 30), name='My Mark', kind='draw')
    assert e['name'] == 'My Mark' and e['kind'] == 'draw'
    assert e['w'] == 60 and e['h'] == 30 and len(e['id']) == 16
    lst = store.list()
    assert len(lst) == 1 and lst[0]['id'] == e['id']


def test_store_add_rejects_non_png(tmp_path):
    store = SignatureStore(tmp_path / 's')
    with pytest.raises(ValueError):
        store.add(b'this is plainly not a png')


def test_store_add_rejects_oversize(tmp_path):
    store = SignatureStore(tmp_path / 's')
    with pytest.raises(ValueError):
        store.add(b'\x00' * (5 * 1024 * 1024))


def test_store_add_defaults_name_and_kind(tmp_path):
    store = SignatureStore(tmp_path / 's')
    e = store.add(_png_bytes(), name='', kind='bogus')
    assert e['name'] == 'Signature' and e['kind'] == 'draw'


def test_store_png_roundtrip(tmp_path):
    store = SignatureStore(tmp_path / 's')
    raw = _png_bytes(40, 40)
    e = store.add(raw)
    assert store.png(e['id']) == raw


def test_store_png_missing_raises(tmp_path):
    store = SignatureStore(tmp_path / 's')
    with pytest.raises(KeyError):
        store.png('abcdef0123456789')


def test_store_png_bad_id_raises(tmp_path):
    store = SignatureStore(tmp_path / 's')
    with pytest.raises(ValueError):
        store.png('../../secrets')


def test_store_rename(tmp_path):
    store = SignatureStore(tmp_path / 's')
    e = store.add(_png_bytes(), name='Old')
    out = store.rename(e['id'], 'New Name')
    assert out['name'] == 'New Name'
    assert store.list()[0]['name'] == 'New Name'
    assert store.rename('abcdef0123456789', 'x') is None


def test_store_delete(tmp_path):
    store = SignatureStore(tmp_path / 's')
    e = store.add(_png_bytes())
    assert store.delete(e['id']) is True
    assert store.list() == []
    with pytest.raises(KeyError):
        store.png(e['id'])
    assert store.delete(e['id']) is False


def test_store_list_self_heals(tmp_path):
    store = SignatureStore(tmp_path / 's')
    e = store.add(_png_bytes())
    (tmp_path / 's' / f"{e['id']}.png").unlink()   # png vanishes out-of-band
    assert store.list() == []                      # stale index entry dropped


def test_store_persists_across_instances(tmp_path):
    root = tmp_path / 's'
    SignatureStore(root).add(_png_bytes(), name='Persist')
    assert SignatureStore(root).list()[0]['name'] == 'Persist'


# ── decode_png_data / _png_dims ──────────────────────────────────────────────────
def test_decode_data_url_and_bare_and_bytes():
    raw = _png_bytes()
    b64 = base64.b64encode(raw).decode()
    assert decode_png_data('data:image/png;base64,' + b64) == raw
    assert decode_png_data(b64) == raw          # bare base64
    assert decode_png_data(raw) == raw          # bytes pass through


def test_decode_empty_raises():
    with pytest.raises(ValueError):
        decode_png_data('')


def test_png_dims():
    assert _png_dims(_png_bytes(33, 17)) == (33, 17)
    with pytest.raises(ValueError):
        _png_dims(b'nope')


# ── FitzDoc.place_image ───────────────────────────────────────────────────────────
def test_place_image_marks_dirty_and_adds(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        assert doc.dirty is False
        assert len(doc.doc.load_page(0).get_images()) == 0
        res = doc.place_image(0, [72, 72, 240, 140], _png_bytes())
        assert res['page'] == 0 and len(res['rect']) == 4
        assert doc.dirty is True
        assert len(doc.doc.load_page(0).get_images()) == 1
    finally:
        doc.close()


def test_place_image_keeps_incrementally_savable(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        doc.place_image(0, [72, 72, 240, 140], _png_bytes())
        assert doc.doc.can_save_incrementally()   # truthy (PyMuPDF returns 1)
    finally:
        doc.close()


def test_place_image_persists_after_save(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    before = _page_count(p)
    doc = FitzDoc(str(p))
    try:
        doc.place_image(1, [72, 72, 240, 140], _png_bytes())
        out = doc.save()
        assert out['saved'] is True and out['mode'] == 'incremental'
    finally:
        doc.close()
    assert _image_count(p, 1) == 1, 'stamp must persist to disk after save'
    assert _page_count(p) == before, 'stamp must not change the page count'


def test_place_image_clamps_index(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        res = doc.place_image(999, [10, 10, 80, 40], _png_bytes())
        assert res['page'] == doc.doc.page_count - 1
    finally:
        doc.close()


def test_place_image_empty_rect_raises(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        with pytest.raises(ValueError):
            doc.place_image(0, [72, 72, 72, 72], _png_bytes())
    finally:
        doc.close()


def test_place_image_bad_rect_raises(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        with pytest.raises(ValueError):
            doc.place_image(0, [1, 2, 3], _png_bytes())
    finally:
        doc.close()


def test_place_image_requires_data(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    doc = FitzDoc(str(p))
    try:
        with pytest.raises(ValueError):
            doc.place_image(0, [72, 72, 240, 140], b'')
    finally:
        doc.close()


# ── Flask: signature library ──────────────────────────────────────────────────────
def test_api_signatures_empty(client, iso_signatures):
    r = client.get('/api/signatures')
    assert r.status_code == 200
    assert r.get_json()['signatures'] == []


def test_api_signature_save_list_png_delete(client, iso_signatures):
    raw = _png_bytes(50, 25)
    b64 = base64.b64encode(raw).decode()
    r = client.post('/api/signatures',
                    json={'png': 'data:image/png;base64,' + b64, 'name': 'Sig A'})
    assert r.status_code == 200
    sig = r.get_json()['signature']
    assert sig['name'] == 'Sig A' and sig['w'] == 50 and sig['h'] == 25

    lst = client.get('/api/signatures').get_json()['signatures']
    assert len(lst) == 1 and lst[0]['id'] == sig['id']

    png = client.get(f"/api/signatures/{sig['id']}.png")
    assert png.status_code == 200 and png.mimetype == 'image/png'
    assert png.data == raw

    d = client.post('/api/signatures/delete', json={'id': sig['id']})
    assert d.status_code == 200
    assert client.get('/api/signatures').get_json()['signatures'] == []


def test_api_signature_save_rejects_non_png(client, iso_signatures):
    r = client.post('/api/signatures',
                    json={'png': base64.b64encode(b'nope').decode()})
    assert r.status_code == 400


def test_api_signature_png_404(client, iso_signatures):
    assert client.get('/api/signatures/abcdef0123456789.png').status_code == 404


def test_api_signature_png_bad_id_400(client, iso_signatures):
    assert client.get('/api/signatures/notavalidhexid.png').status_code == 400


def test_api_signature_delete_missing(client, iso_signatures):
    r = client.post('/api/signatures/delete', json={'id': 'abcdef0123456789'})
    assert r.status_code == 404


# ── Flask: stamp onto a page ──────────────────────────────────────────────────────
def test_api_stamp_by_signature_id(client, iso_signatures, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    b64 = base64.b64encode(_png_bytes()).decode()
    sig = client.post('/api/signatures',
                      json={'png': b64, 'name': 'Mark'}).get_json()['signature']

    r = client.post('/api/pdf/stamp',
                    json={'path': str(p), 'page': 0, 'rect': [72, 72, 240, 140],
                          'signature': sig['id']})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ok'] is True and b['page'] == 0

    s = client.post('/api/pdf/save', json={'path': str(p)})
    assert s.status_code == 200 and s.get_json()['saved'] is True
    assert _image_count(p, 0) == 1


def test_api_stamp_inline_png(client, iso_signatures, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    b64 = base64.b64encode(_png_bytes()).decode()
    r = client.post('/api/pdf/stamp',
                    json={'path': str(p), 'page': 2, 'rect': [72, 72, 240, 140],
                          'png': 'data:image/png;base64,' + b64})
    assert r.status_code == 200
    assert client.post('/api/pdf/save', json={'path': str(p)}).status_code == 200
    assert _image_count(p, 2) == 1


def test_api_stamp_rejects_non_pdf(client, iso_signatures, samples):
    b64 = base64.b64encode(_png_bytes()).decode()
    r = client.post('/api/pdf/stamp',
                    json={'path': str(samples['txt']), 'page': 0,
                          'rect': [10, 10, 80, 40], 'png': b64})
    assert r.status_code == 400


def test_api_stamp_missing_path(client, iso_signatures):
    r = client.post('/api/pdf/stamp', json={'page': 0, 'rect': [1, 2, 3, 4], 'png': 'x'})
    assert r.status_code == 400


def test_api_stamp_bad_rect(client, iso_signatures, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    b64 = base64.b64encode(_png_bytes()).decode()
    r = client.post('/api/pdf/stamp',
                    json={'path': str(p), 'page': 0, 'rect': [1, 2, 3], 'png': b64})
    assert r.status_code == 400


def test_api_stamp_unknown_signature(client, iso_signatures, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/stamp',
                    json={'path': str(p), 'page': 0, 'rect': [72, 72, 240, 140],
                          'signature': 'abcdef0123456789'})
    assert r.status_code == 404
