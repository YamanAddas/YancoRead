"""
Translation Phase 3 — persistent vision cache + /api/image-translate.
"""
import time
from urllib.parse import quote

from renderers import transcache


def _png(tmp_path, name='pic.png'):
    import cv2
    import numpy as np
    p = tmp_path / name
    p.write_bytes(cv2.imencode('.png', np.full((60, 80, 3), 200, np.uint8))[1].tobytes())
    return p


# ── page_key: file-identity keyed (NOT content-addressed) ───────────────────────
def test_page_key_is_stable_and_param_sensitive(tmp_path):
    f = tmp_path / 'a.png'; f.write_bytes(b'x' * 100)
    k = transcache.page_key(str(f), 0, 'Arabic', True, 'neutral', 'm')
    assert k == transcache.page_key(str(f), 0, 'Arabic', True, 'neutral', 'm')
    assert k != transcache.page_key(str(f), 1, 'Arabic', True, 'neutral', 'm')   # index
    assert k != transcache.page_key(str(f), 0, 'English', True, 'neutral', 'm')  # target
    assert k != transcache.page_key(str(f), 0, 'Arabic', False, 'neutral', 'm')  # rtl
    assert k != transcache.page_key(str(f), 0, 'Arabic', True, 'neutral', 'm2')  # model


def test_page_key_invalidates_when_file_changes(tmp_path):
    f = tmp_path / 'a.png'; f.write_bytes(b'x' * 100)
    k1 = transcache.page_key(str(f), 0, 'Arabic')
    time.sleep(0.01)
    f.write_bytes(b'y' * 250)                       # different size + mtime
    assert k1 != transcache.page_key(str(f), 0, 'Arabic')


def test_page_key_missing_file_does_not_raise():
    assert transcache.page_key('Z:/nope.png', 0, 'Arabic')   # returns a key, no crash


# ── /api/image-translate + two-tier cache ───────────────────────────────────────
def test_image_translate_endpoint_and_persistent_cache(client, tmp_path, monkeypatch):
    import app as app_module
    app_module.userdata.set_setting('ai', {
        'backend': 'custom', 'endpoint': 'http://h/v1/chat/completions',
        'model': 'm', 'api_key': ''})
    from renderers import llm
    calls = {'n': 0}
    def fake_vision(cfg, image_bytes, rtl=False, target=''):
        calls['n'] += 1
        return [{'text': 'Hello', 'box': {'x': 0.1, 'y': 0.1, 'w': 0.3, 'h': 0.12},
                 'translated': 'مرحبا'}]
    monkeypatch.setattr(llm, 'vision_read', fake_vision)
    iso = transcache.TranslationCache(path=tmp_path / 'v.json')
    monkeypatch.setattr(transcache, 'default_vision_cache', lambda: iso)
    app_module._vision_cache.clear()
    pic = _png(tmp_path)

    url = f'/api/image-translate?path={quote(str(pic))}&target=Arabic&rtl=1'
    d = client.get(url).get_json()
    assert d['source'] == 'vision' and d['blocks']
    assert d['blocks'][0]['translated'] == 'مرحبا'
    assert calls['n'] == 1

    # Clear the in-process LRU → the PERSISTENT cache must serve the repeat.
    app_module._vision_cache.clear()
    d2 = client.get(url).get_json()
    assert d2['blocks'][0]['translated'] == 'مرحبا'
    assert calls['n'] == 1                          # vision NOT re-run — disk cache hit


def test_image_translate_bad_path(client):
    r = client.get('/api/image-translate?path=Z:/nope.png&target=Arabic')
    assert r.status_code == 400
