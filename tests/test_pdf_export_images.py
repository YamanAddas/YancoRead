"""P9a — PDF export-pages-as-images backend.

Covers FitzDoc.export_images(), which renders pages to PNG/JPG files in a folder
and never mutates the source, plus the Flask route /api/pdf/export-images.

Like the merge/split tests, every test builds its own PDF in tmp_path and the
module-global FitzDoc cache is purged after each test so Windows releases handles.
Saved images are inspected by their magic bytes (PNG/JPEG) and re-rendered pixel
width (to prove the dpi knob flows through).
"""
import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc


def _make_pdf(path, n):
    doc = fitz.open()
    for i in range(n):
        doc.new_page().insert_text((72, 72), f'page {i + 1}')
    doc.save(str(path)); doc.close()
    return path


def _img_kind(path) -> str:
    with open(path, 'rb') as f:
        head = f.read(8)
    if head.startswith(b'\x89PNG'):
        return 'png'
    if head[:2] == b'\xff\xd8':
        return 'jpg'
    return '?'


def _img_width(path) -> int:
    return fitz.Pixmap(str(path)).width


@pytest.fixture
def pdf5(tmp_path):
    return _make_pdf(tmp_path / 'doc.pdf', 5)


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


# ── FitzDoc.export_images ──────────────────────────────────────────────────────────
def test_export_all_pages_png(tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    res = FitzDoc(str(pdf5)).export_images(str(out))
    assert res['count'] == 5
    assert res['dir'] == str(out)
    assert len(list(out.glob('*.png'))) == 5
    for f in res['files']:
        assert (out / f['name']).is_file()
        assert _img_kind(out / f['name']) == 'png'


def test_export_selected_pages(tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    res = FitzDoc(str(pdf5)).export_images(str(out), pages=[0, 2, 4])
    assert res['count'] == 3
    names = sorted(f['name'] for f in res['files'])
    assert names == ['doc (p1).png', 'doc (p3).png', 'doc (p5).png']


def test_export_jpg_format(tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    res = FitzDoc(str(pdf5)).export_images(str(out), pages=[0], fmt='jpg')
    f = out / res['files'][0]['name']
    assert f.suffix == '.jpg'
    assert _img_kind(f) == 'jpg'


def test_export_jpeg_alias(tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    res = FitzDoc(str(pdf5)).export_images(str(out), pages=[0], fmt='JPEG')
    assert res['files'][0]['name'].endswith('.jpg')


def test_export_dpi_affects_size(tmp_path, pdf5):
    lo = tmp_path / 'lo'; lo.mkdir()
    hi = tmp_path / 'hi'; hi.mkdir()
    d = FitzDoc(str(pdf5))
    w_lo = _img_width(lo / d.export_images(str(lo), pages=[0], dpi=72)['files'][0]['name'])
    w_hi = _img_width(hi / d.export_images(str(hi), pages=[0], dpi=300)['files'][0]['name'])
    assert w_hi > w_lo * 2          # 300 dpi is ~4x the linear resolution of 72


def test_export_dpi_clamped(tmp_path, pdf5):
    """An absurd dpi is clamped rather than rejected — the export still succeeds."""
    out = tmp_path / 'out'; out.mkdir()
    res = FitzDoc(str(pdf5)).export_images(str(out), pages=[0], dpi=999999)
    assert res['count'] == 1
    assert _img_width(out / res['files'][0]['name']) <= 600 / 72 * 800  # bounded


def test_export_custom_stem(tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    res = FitzDoc(str(pdf5)).export_images(str(out), pages=[1], stem='Scan')
    assert res['files'][0]['name'] == 'Scan (p2).png'


def test_export_unique_naming(tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    d = FitzDoc(str(pdf5))
    first = d.export_images(str(out), pages=[0])['files'][0]['name']
    second = d.export_images(str(out), pages=[0])['files'][0]['name']
    assert first == 'doc (p1).png'
    assert second == 'doc (p1) (2).png'
    assert (out / first).is_file() and (out / second).is_file()


def test_export_out_of_range_raises(tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    with pytest.raises(ValueError):
        FitzDoc(str(pdf5)).export_images(str(out), pages=[99])


def test_export_bad_format_raises(tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    with pytest.raises(ValueError):
        FitzDoc(str(pdf5)).export_images(str(out), pages=[0], fmt='gif')


def test_export_missing_dir_raises(tmp_path, pdf5):
    with pytest.raises(ValueError):
        FitzDoc(str(pdf5)).export_images(str(tmp_path / 'nope'), pages=[0])


def test_export_leaves_source_untouched(tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    FitzDoc(str(pdf5)).export_images(str(out))
    d = fitz.open(str(pdf5))
    try:
        assert d.page_count == 5
    finally:
        d.close()


# ── Flask: POST /api/pdf/export-images ──────────────────────────────────────────────
def test_api_export_all(client, tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    r = client.post('/api/pdf/export-images',
                    json={'path': str(pdf5), 'dir': str(out)})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ok'] is True and b['count'] == 5
    assert len(list(out.glob('*.png'))) == 5


def test_api_export_selected_jpg(client, tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    r = client.post('/api/pdf/export-images',
                    json={'path': str(pdf5), 'dir': str(out),
                          'pages': [0, 1], 'format': 'jpg', 'dpi': 200})
    assert r.status_code == 200
    b = r.get_json()
    assert b['count'] == 2
    assert all(f['name'].endswith('.jpg') for f in b['files'])


def test_api_export_missing_path(client, tmp_path):
    r = client.post('/api/pdf/export-images', json={'dir': str(tmp_path)})
    assert r.status_code == 400


def test_api_export_non_pdf(client, tmp_path, samples):
    r = client.post('/api/pdf/export-images',
                    json={'path': str(samples['txt']), 'dir': str(tmp_path)})
    assert r.status_code == 400


def test_api_export_bad_dir(client, tmp_path, pdf5):
    r = client.post('/api/pdf/export-images',
                    json={'path': str(pdf5), 'dir': str(tmp_path / 'nope')})
    assert r.status_code == 400


def test_api_export_bad_format(client, tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    r = client.post('/api/pdf/export-images',
                    json={'path': str(pdf5), 'dir': str(out), 'format': 'gif'})
    assert r.status_code == 400


def test_api_export_out_of_range(client, tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    r = client.post('/api/pdf/export-images',
                    json={'path': str(pdf5), 'dir': str(out), 'pages': [99]})
    assert r.status_code == 400


def test_api_export_pages_not_list(client, tmp_path, pdf5):
    out = tmp_path / 'out'; out.mkdir()
    r = client.post('/api/pdf/export-images',
                    json={'path': str(pdf5), 'dir': str(out), 'pages': '0,1'})
    assert r.status_code == 400
