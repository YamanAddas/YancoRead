"""Tests for the image editor's save endpoint (/api/image/save).

The editor sends its canvas as a PNG data URL; the backend decodes it and writes
the file — either to a chosen target (Save As) or back over the original (with a
one-time .bak of the pristine original)."""
import base64
import io

from PIL import Image


def _png_data_url(w=24, h=18, color=(200, 40, 40, 255)):
    """A solid RGBA PNG as a 'data:image/png;base64,…' URL (what the canvas sends)."""
    im = Image.new('RGBA', (w, h), color)
    buf = io.BytesIO()
    im.save(buf, 'PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def test_save_as_png(client, tmp_path):
    dest = tmp_path / 'drawing.png'
    r = client.post('/api/image/save',
                    json={'data': _png_data_url(30, 20), 'mode': 'saveas', 'target': str(dest)})
    assert r.status_code == 200 and r.get_json()['ok']
    assert dest.is_file()
    with Image.open(dest) as im:
        assert im.size == (30, 20) and im.format == 'PNG'


def test_save_as_jpeg_flattens_alpha(client, tmp_path):
    """A target .jpg re-encodes to JPEG; transparent pixels flatten onto white."""
    dest = tmp_path / 'photo.jpg'
    # Fully-transparent canvas → JPEG (no alpha) should come out white.
    r = client.post('/api/image/save',
                    json={'data': _png_data_url(16, 16, (10, 20, 30, 0)),
                          'mode': 'saveas', 'target': str(dest)})
    assert r.status_code == 200
    assert dest.is_file()
    with Image.open(dest) as im:
        assert im.format == 'JPEG' and im.mode == 'RGB'
        assert im.getpixel((0, 0)) == (255, 255, 255) or im.getpixel((8, 8))[0] > 240


def test_save_as_defaults_extension_to_png(client, tmp_path):
    dest = tmp_path / 'noext'
    r = client.post('/api/image/save',
                    json={'data': _png_data_url(), 'mode': 'saveas', 'target': str(dest)})
    assert r.status_code == 200
    out = r.get_json()['path']
    assert out.endswith('.png') and Image.open(out).format == 'PNG'


def test_overwrite_backs_up_pristine_original_once(client, tmp_path):
    """First overwrite copies the untouched original to .bak; a second overwrite
    must NOT clobber that backup (so the pristine original is always recoverable)."""
    orig = tmp_path / 'pic.png'
    Image.new('RGB', (40, 40), (5, 5, 5)).save(orig, 'PNG')   # pristine = near-black
    bak = tmp_path / 'pic.png.bak'

    # First edit → red canvas.
    r1 = client.post('/api/image/save',
                     json={'data': _png_data_url(40, 40, (255, 0, 0, 255)),
                           'mode': 'overwrite', 'path': str(orig)})
    assert r1.status_code == 200 and r1.get_json()['backup']
    assert bak.is_file()
    with Image.open(orig) as im:
        assert im.convert('RGB').getpixel((0, 0)) == (255, 0, 0)   # rewritten
    with Image.open(bak) as im:
        assert im.convert('RGB').getpixel((0, 0)) == (5, 5, 5)     # pristine kept

    # Second edit → green canvas. .bak must still hold the pristine near-black.
    r2 = client.post('/api/image/save',
                     json={'data': _png_data_url(40, 40, (0, 255, 0, 255)),
                           'mode': 'overwrite', 'path': str(orig)})
    assert r2.status_code == 200 and r2.get_json()['backup'] is None
    with Image.open(orig) as im:
        assert im.convert('RGB').getpixel((0, 0)) == (0, 255, 0)   # rewritten again
    with Image.open(bak) as im:
        assert im.convert('RGB').getpixel((0, 0)) == (5, 5, 5)     # STILL pristine


def test_overwrite_keeps_original_format(client, tmp_path):
    """Overwriting a .jpg writes JPEG bytes (not the PNG the canvas sent)."""
    orig = tmp_path / 'pic.jpg'
    Image.new('RGB', (32, 32), (9, 9, 9)).save(orig, 'JPEG')
    r = client.post('/api/image/save',
                    json={'data': _png_data_url(32, 32, (0, 0, 255, 255)),
                          'mode': 'overwrite', 'path': str(orig)})
    assert r.status_code == 200
    with Image.open(orig) as im:
        assert im.format == 'JPEG'


def test_missing_data_is_400(client, tmp_path):
    r = client.post('/api/image/save', json={'mode': 'saveas', 'target': str(tmp_path / 'x.png')})
    assert r.status_code == 400


def test_bad_base64_is_400(client, tmp_path):
    r = client.post('/api/image/save',
                    json={'data': 'data:image/png;base64,@@@not-base64@@@',
                          'mode': 'saveas', 'target': str(tmp_path / 'x.png')})
    assert r.status_code == 400


def test_saveas_without_target_is_400(client):
    r = client.post('/api/image/save', json={'data': _png_data_url(), 'mode': 'saveas'})
    assert r.status_code == 400


def test_overwrite_missing_file_is_400(client, tmp_path):
    r = client.post('/api/image/save',
                    json={'data': _png_data_url(), 'mode': 'overwrite',
                          'path': str(tmp_path / 'nope.png')})
    assert r.status_code == 400


def test_save_requires_token(client, tmp_path):
    """SECURITY: image save is a mutating write → must be token-gated."""
    r = client.post('/api/image/save',
                    json={'data': _png_data_url(), 'mode': 'saveas', 'target': str(tmp_path / 'x.png')},
                    headers={'X-YR-Token': ''})
    assert r.status_code == 403
