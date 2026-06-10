"""
Translation Phase 4 — /api/translate/blocks (office + text in-place DOM swap).
"""
import json

from renderers import transcache


def _echo_chat(cfg, messages, timeout=60, temperature=0.2):
    items = json.loads(messages[-1]['content'])['segments']
    return json.dumps({'segments': [{'id': it['id'], 't': 'AR(' + it['text'] + ')'} for it in items]})


def _iso(monkeypatch, tmp_path):
    from renderers import llm
    monkeypatch.setattr(llm, 'chat', _echo_chat)
    iso = transcache.TranslationCache(path=tmp_path / 'tc.json')
    monkeypatch.setattr(transcache, 'default_cache', lambda: iso)


def _cfg(client):
    import app as app_module
    app_module.userdata.set_setting('ai', {
        'backend': 'custom', 'endpoint': 'http://h/v1/chat/completions',
        'model': 'm', 'api_key': ''})


def test_translate_blocks_keyed(client, monkeypatch, tmp_path):
    _cfg(client); _iso(monkeypatch, tmp_path)
    r = client.post('/api/translate/blocks', json={
        'blocks': [{'id': 'p1', 'text': 'Hello'}, {'id': 'p2', 'text': 'World'}],
        'target': 'Arabic', 'source': 'English'})
    assert r.status_code == 200
    d = r.get_json()
    assert d['lang'] == {'source': 'English', 'target': 'Arabic'}
    assert {t['id']: t['t'] for t in d['translations']} == {'p1': 'AR(Hello)', 'p2': 'AR(World)'}


def test_translate_blocks_drops_blank(client, monkeypatch, tmp_path):
    _cfg(client); _iso(monkeypatch, tmp_path)
    out = client.post('/api/translate/blocks', json={
        'blocks': [{'id': 'a', 'text': '   '}, {'id': 'b', 'text': 'real'}],
        'target': 'Arabic', 'source': 'English'}).get_json()['translations']
    assert [t['id'] for t in out] == ['b']        # blank block dropped
    assert out[0]['t'] == 'AR(real)'


def test_translate_blocks_same_language_is_noop(client, monkeypatch, tmp_path):
    _cfg(client)
    from renderers import llm
    called = {'n': 0}
    monkeypatch.setattr(llm, 'chat', lambda *a, **k: called.__setitem__('n', called['n'] + 1) or '{}')
    out = client.post('/api/translate/blocks', json={
        'blocks': [{'id': 'x', 'text': 'hello'}],
        'target': 'English', 'source': 'English'}).get_json()['translations']
    assert out[0]['t'] == 'hello'                 # same language → original, untouched
    assert called['n'] == 0                       # and no LLM call


def test_translate_blocks_empty_is_400(client):
    assert client.post('/api/translate/blocks', json={'blocks': []}).status_code == 400


def test_translate_blocks_multichunk(client, monkeypatch, tmp_path):
    """>40 segments must split into multiple LLM calls and merge back 1:1 (the
    chunk-merge path was previously never exercised)."""
    _cfg(client)
    from renderers import llm
    calls = {'n': 0}

    def counting_chat(cfg, messages, timeout=60, temperature=0.2):
        calls['n'] += 1
        return _echo_chat(cfg, messages, timeout, temperature)
    monkeypatch.setattr(llm, 'chat', counting_chat)
    iso = transcache.TranslationCache(path=tmp_path / 'tc.json')
    monkeypatch.setattr(transcache, 'default_cache', lambda: iso)

    blocks = [{'id': f'p{i}', 'text': f'line {i}'} for i in range(85)]
    d = client.post('/api/translate/blocks', json={
        'blocks': blocks, 'target': 'Arabic', 'source': 'English'}).get_json()
    out = {t['id']: t['t'] for t in d['translations']}
    assert len(out) == 85
    assert out['p0'] == 'AR(line 0)' and out['p84'] == 'AR(line 84)'
    assert calls['n'] == 3                          # ceil(85 / 40)


def test_translate_blocks_auto_source_detect(client, monkeypatch, tmp_path):
    """No explicit source ('auto') must auto-detect and translate (the auto path
    the single Translate button relies on, previously untested end-to-end)."""
    _cfg(client); _iso(monkeypatch, tmp_path)
    d = client.post('/api/translate/blocks', json={
        'blocks': [{'id': 'a', 'text': 'Hello there friend'}],
        'target': 'Arabic'}).get_json()             # no 'source'
    assert d['lang']['source'] == 'English'         # auto-detected
    assert d['translations'][0]['t'] == 'AR(Hello there friend)'
