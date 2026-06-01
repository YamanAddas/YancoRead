"""Comic export & share endpoints: save page / panel image + comic→PDF.

Exercises /api/comic/save-page and /api/comic/export-pdf against the generated
sample archives. The native Save dialog (pywebview) is out of scope here — these
tests post an explicit ``target`` path exactly as the JS bridge does after the
user picks a destination.
"""
import cv2
import fitz
import numpy as np


def _dims(path):
    """(width, height) of an image file, or None if undecodable."""
    img = cv2.imdecode(np.frombuffer(path.read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    return None if img is None else (img.shape[1], img.shape[0])


# ── save page image ──────────────────────────────────────────────────────────
def test_save_page_full_keeps_native_bytes(client, samples, tmp_path):
    out = tmp_path / 'page.png'
    r = client.post('/api/comic/save-page',
                    json={'path': str(samples['cbz']), 'target': str(out), 'index': 0})
    assert r.status_code == 200 and r.get_json()['name'] == 'page.png'
    assert out.exists() and _dims(out) == (120, 160)
    # source page is already PNG → bytes written verbatim (no re-encode).
    src = samples['cbz']
    import zipfile
    with zipfile.ZipFile(src) as z:
        original = z.read(sorted(z.namelist())[0])
    assert out.read_bytes() == original


def test_save_page_reencodes_to_jpeg(client, samples, tmp_path):
    out = tmp_path / 'page.jpg'
    r = client.post('/api/comic/save-page',
                    json={'path': str(samples['cbz']), 'target': str(out), 'index': 1})
    assert r.status_code == 200
    assert out.exists() and out.read_bytes()[:3] == b'\xff\xd8\xff'  # JPEG magic
    assert _dims(out) == (120, 160)


def test_save_page_crop_panel(client, samples, tmp_path):
    out = tmp_path / 'panel.png'
    # 900x1300 page → centre quarter == 450x650.
    r = client.post('/api/comic/save-page',
                    json={'path': str(samples['cbz_panels']), 'target': str(out),
                          'index': 0, 'crop': {'x': 0.25, 'y': 0.25, 'w': 0.5, 'h': 0.5}})
    assert r.status_code == 200
    assert _dims(out) == (450, 650)


def test_save_page_enhanced(client, samples, tmp_path):
    out = tmp_path / 'enh.png'
    r = client.post('/api/comic/save-page',
                    json={'path': str(samples['cbz']), 'target': str(out),
                          'index': 0, 'enhance': True})
    assert r.status_code == 200
    assert out.exists() and _dims(out) == (120, 160)


def test_save_page_extension_defaulted(client, samples, tmp_path):
    # A target with no/odd extension is coerced to .png.
    out = tmp_path / 'noext'
    r = client.post('/api/comic/save-page',
                    json={'path': str(samples['cbz']), 'target': str(out), 'index': 0})
    assert r.status_code == 200 and r.get_json()['name'] == 'noext.png'
    assert (tmp_path / 'noext.png').exists()


# ── export PDF ───────────────────────────────────────────────────────────────
def test_export_pdf_all_pages(client, samples, tmp_path):
    out = tmp_path / 'book.pdf'
    r = client.post('/api/comic/export-pdf',
                    json={'path': str(samples['cbz']), 'target': str(out)})
    body = r.get_json()
    assert r.status_code == 200 and body['pages'] == 3
    with fitz.open(out) as d:
        assert d.page_count == 3
        # native resolution preserved: page rect == source image pixels (1px=1pt).
        assert tuple(round(v) for v in d[0].rect) == (0, 0, 120, 160)


def test_export_pdf_extension_coerced(client, samples, tmp_path):
    out = tmp_path / 'book'  # no extension
    r = client.post('/api/comic/export-pdf',
                    json={'path': str(samples['cbz']), 'target': str(out)})
    assert r.status_code == 200 and r.get_json()['name'] == 'book.pdf'
    assert (tmp_path / 'book.pdf').exists()


# ── error paths ──────────────────────────────────────────────────────────────
def test_save_page_requires_target(client, samples):
    r = client.post('/api/comic/save-page', json={'path': str(samples['cbz']), 'index': 0})
    assert r.status_code == 400


def test_save_page_rejects_bad_source(client, tmp_path):
    r = client.post('/api/comic/save-page',
                    json={'path': 'Z:\\nope.cbz', 'target': str(tmp_path / 'x.png'), 'index': 0})
    assert r.status_code == 400


def test_export_pdf_rejects_missing_folder(client, samples):
    r = client.post('/api/comic/export-pdf',
                    json={'path': str(samples['cbz']), 'target': 'Z:\\no\\such\\dir\\x.pdf'})
    assert r.status_code == 400
