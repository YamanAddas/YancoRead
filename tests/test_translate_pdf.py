"""
Translation Phase 1 — PDF text-layer extraction (fitzdoc.translate_segments).
"""
import fitz

from renderers import fitzdoc


def test_pdf_translate_segments_textlayer(samples):
    res = fitzdoc.FitzDoc(str(samples['pdf'])).translate_segments(0)
    assert res['source'] == 'textlayer'
    assert res['segments']
    blob = ' '.join(s['text'] for s in res['segments'])
    assert 'YancoRead' in blob and 'fox' in blob
    seg = res['segments'][0]
    assert len(seg['box']) == 4 and seg['text']
    assert seg['dir'] == 'ltr'
    assert isinstance(seg['color'], list) and len(seg['color']) == 3
    assert res['width'] > 0 and res['height'] > 0


def test_pdf_translate_segments_detects_scanned(tmp_path):
    """A full-page image with no text layer is flagged for the OCR/vision path."""
    import cv2
    import numpy as np
    png = cv2.imencode('.png', np.full((120, 120, 3), 128, np.uint8))[1].tobytes()
    d = fitz.open(); pg = d.new_page(width=300, height=300)
    pg.insert_image(fitz.Rect(0, 0, 300, 300), stream=png)
    p = tmp_path / 'scan.pdf'; d.save(str(p)); d.close()
    res = fitzdoc.FitzDoc(str(p)).translate_segments(0)
    assert res['source'] == 'image'
    assert res['segments'] == []


def test_pdf_translate_segments_blank_is_textlayer(tmp_path):
    """A blank page is NOT a scan — don't route it to OCR for nothing."""
    d = fitz.open(); d.new_page(width=300, height=300)
    p = tmp_path / 'blank.pdf'; d.save(str(p)); d.close()
    res = fitzdoc.FitzDoc(str(p)).translate_segments(0)
    assert res['source'] == 'textlayer'
    assert res['segments'] == []


def test_seg_dir_helper():
    """Block base-direction detection (font-independent unit test)."""
    assert fitzdoc._seg_dir('Hello world, this is English.') == 'ltr'
    assert fitzdoc._seg_dir('السلام عليكم ورحمة الله وبركاته') == 'rtl'
    assert fitzdoc._seg_dir('Mostly English with محمد as one name') == 'ltr'
    assert fitzdoc._seg_dir('12345 .,!?') == 'ltr'      # no letters → ltr default


def test_int_to_rgb_helper():
    assert fitzdoc._int_to_rgb(0x000000) == [0, 0, 0]
    assert fitzdoc._int_to_rgb(0xFF8040) == [255, 128, 64]
    assert fitzdoc._int_to_rgb(None) == [0, 0, 0]       # defensive


# ── /api/translate/page endpoint ────────────────────────────────────────────────
def _echo_chat(cfg, messages, timeout=60, temperature=0.2):
    import json
    items = json.loads(messages[-1]['content'])['segments']
    return json.dumps({'segments': [{'id': it['id'], 't': 'AR(' + it['text'] + ')'}
                                     for it in items]})


def _isolate(monkeypatch, tmp_path):
    """Stub the LLM + isolate the translation cache to a temp file."""
    from renderers import llm, transcache
    monkeypatch.setattr(llm, 'chat', _echo_chat)
    iso = transcache.TranslationCache(path=tmp_path / 'tc.json')
    monkeypatch.setattr(transcache, 'default_cache', lambda: iso)
    return llm


def test_translate_page_endpoint_and_cache(client, samples, monkeypatch, tmp_path):
    import app as app_module
    app_module.userdata.set_setting('ai', {
        'backend': 'custom', 'endpoint': 'http://h/v1/chat/completions',
        'model': 'm', 'api_key': ''})
    llm = _isolate(monkeypatch, tmp_path)

    r = client.post('/api/translate/page', json={
        'path': str(samples['pdf']), 'page': 0, 'target': 'Arabic', 'source': 'English'})
    assert r.status_code == 200
    data = r.get_json()
    assert data['source'] == 'textlayer'
    assert data['segments'] and all('translated' in s for s in data['segments'])
    assert any(s['translated'].startswith('AR(') for s in data['segments'])
    assert data['cached'] is False
    assert data['lang'] == {'source': 'English', 'target': 'Arabic'}

    # Second call: served from the persistent cache, no LLM round-trip.
    calls = {'n': 0}
    def counting_chat(*a, **k):
        calls['n'] += 1
        return ''
    monkeypatch.setattr(llm, 'chat', counting_chat)
    d2 = client.post('/api/translate/page', json={
        'path': str(samples['pdf']), 'page': 0, 'target': 'Arabic', 'source': 'English'}).get_json()
    assert d2['cached'] is True
    assert calls['n'] == 0
    assert any(s['translated'].startswith('AR(') for s in d2['segments'])


def test_translate_page_scanned_routes_to_image(client, tmp_path, monkeypatch):
    _isolate(monkeypatch, tmp_path)
    import cv2
    import numpy as np
    png = cv2.imencode('.png', np.full((120, 120, 3), 128, np.uint8))[1].tobytes()
    d = fitz.open(); pg = d.new_page(width=300, height=300)
    pg.insert_image(fitz.Rect(0, 0, 300, 300), stream=png)
    p = tmp_path / 'scan.pdf'; d.save(str(p)); d.close()
    data = client.post('/api/translate/page', json={
        'path': str(p), 'page': 0, 'target': 'Arabic'}).get_json()
    assert data['source'] == 'image'
    assert data['segments'] == []


def test_translate_page_does_not_cache_failures(client, samples, monkeypatch, tmp_path):
    """If the LLM is unreachable, segments fall back to original text and the
    FAILURE is NOT cached — a later call retries rather than serving stale text."""
    import app as app_module
    app_module.userdata.set_setting('ai', {
        'backend': 'custom', 'endpoint': 'http://h/v1/chat/completions',
        'model': 'm', 'api_key': ''})
    from renderers import llm, transcache
    iso = transcache.TranslationCache(path=tmp_path / 'tc.json')
    monkeypatch.setattr(transcache, 'default_cache', lambda: iso)
    calls = {'n': 0}
    def failing(*a, **k):
        calls['n'] += 1
        raise llm.requests.RequestException('backend down')
    monkeypatch.setattr(llm, 'chat', failing)

    d1 = client.post('/api/translate/page', json={
        'path': str(samples['pdf']), 'page': 0, 'target': 'Arabic', 'source': 'English'}).get_json()
    assert all(s['translated'] == s['text'] for s in d1['segments'])   # fell back to original
    first = calls['n']
    assert first > 0
    client.post('/api/translate/page', json={
        'path': str(samples['pdf']), 'page': 0, 'target': 'Arabic', 'source': 'English'})
    assert calls['n'] > first                                          # retried, not cached


def test_translate_page_bad_path(client):
    r = client.post('/api/translate/page', json={'path': 'Z:/nope.pdf', 'page': 0})
    assert r.status_code == 404


def test_translate_page_rejects_non_pdf(client, samples):
    r = client.post('/api/translate/page', json={'path': str(samples['png']), 'page': 0})
    assert r.status_code == 415
