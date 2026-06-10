"""Tests pinning the 2026-06-09 audit follow-up fixes (mediums + lows).

Each test fails if its fix is reverted.
"""

import json
import math
import os
import shutil
import tempfile
import zipfile

import pytest


# ── llm.detect_lang: exclude digits from the Arabic ratio ───────────────────

def test_detect_lang_ignores_arabic_indic_digits():
    from renderers import llm
    assert llm.detect_lang('Page ١٢٣') == 'English'   # "Page ١٢٣"
    assert llm.detect_lang('Hello world, this is English.') == 'English'
    assert llm.detect_lang('مرحبا بالعالم') == 'Arabic'


# ── llm._parse_segments_reply: null translation must not become "None" ──────

def test_parse_segments_null_translation_is_blank():
    from renderers import llm
    reply = json.dumps({'segments': [{'id': 0, 't': None}, {'id': 1, 't': 'Bonjour'}]})
    out = llm._parse_segments_reply(reply)
    assert out['0'] == ''            # NOT the literal string "None"
    assert out['1'] == 'Bonjour'


# ── llm.vision_read: tolerate box as a JSON array + reject non-finite ───────

def test_vision_read_box_as_array_and_nan(monkeypatch):
    from renderers import llm
    monkeypatch.setattr(llm, 'chat', lambda *a, **k: json.dumps([
        {'text': 'a', 'box': [0.1, 0.2, 0.3, 0.4]},      # array form
        {'text': 'b', 'box': float('nan')},               # garbage -> default box
        {'text': 'c', 'box': {'x': 0.5}},                 # partial dict
    ]))
    blocks = llm.vision_read({}, b'img', False, '')
    assert blocks[0]['box'] == {'x': 0.1, 'y': 0.2, 'w': 0.3, 'h': 0.4}
    assert blocks[1]['box'] == {'x': 0, 'y': 0, 'w': 0.25, 'h': 0.07}
    for b in blocks:
        assert all(math.isfinite(v) for v in b['box'].values())


# ── app._cap_segments: bound count + per-segment length ─────────────────────

def test_cap_segments_bounds_count_and_length():
    import app
    segs = [{'id': i, 'text': 'x' * 20000} for i in range(900)]
    capped, truncated = app._cap_segments(segs)
    assert truncated is True
    assert len(capped) == app._MAX_TRANSLATE_SEGMENTS
    assert all(len(s['text']) <= app._MAX_TRANSLATE_SEG_CHARS for s in capped)


# ── app._merge_ai_settings: blank keeps, clear_api_key removes ──────────────

def test_merge_ai_settings_keep_and_clear(client):
    import app as app_module
    app_module.userdata.set_setting('ai', {'api_key': 'sk-SAVED', 'backend': 'openai'})
    # blank api_key -> keep the saved one
    merged = app_module._merge_ai_settings({'api_key': '', 'backend': 'openai'})
    assert merged['api_key'] == 'sk-SAVED'
    # explicit clear -> removed
    merged2 = app_module._merge_ai_settings({'clear_api_key': True})
    assert merged2['api_key'] == ''
    # a real new key replaces
    merged3 = app_module._merge_ai_settings({'api_key': 'sk-NEW'})
    assert merged3['api_key'] == 'sk-NEW'


# ── app._probe_cfg: reuse saved key only for the SAME endpoint ──────────────

def test_probe_cfg_reuses_key_only_for_same_endpoint(client):
    import app as app_module
    app_module.userdata.set_setting('ai', {
        'backend': 'openai', 'endpoint': 'https://api.openai.com/v1',
        'api_key': 'sk-SAVED', 'model': 'gpt'})
    same = app_module._probe_cfg({'backend': 'openai',
                                  'endpoint': 'https://api.openai.com/v1',
                                  'api_key': '', 'model': 'gpt'})
    other = app_module._probe_cfg({'backend': 'openai',
                                   'endpoint': 'https://evil.example/v1',
                                   'api_key': '', 'model': 'gpt'})
    assert same.get('api_key') == 'sk-SAVED'         # Test/Detect work for stored config
    assert not other.get('api_key')                  # key never crosses to a new host
    assert app_module._probe_cfg(None).get('api_key') == 'sk-SAVED'


# ── detect(): non-string path must not crash ────────────────────────────────

@pytest.mark.parametrize('bad', [None, 123, ['x'], {'a': 1}])
def test_detect_non_string_path(bad):
    from detect import detect
    info = detect(bad)
    assert info['exists'] is False
    assert info['kind'] == 'unknown'


# ── /api/image-translate: only images ───────────────────────────────────────

def test_image_translate_rejects_non_image(client, samples):
    r = client.get('/api/image-translate?path=' + str(samples['md']))
    assert r.status_code == 415


# ── comicdoc cb7 guard + bounded LRU ────────────────────────────────────────

def test_cb7_oversized_member_rejected():
    py7zr = pytest.importorskip('py7zr')
    from renderers import comicdoc
    tmp = tempfile.mkdtemp(prefix='yr_cb7_')
    try:
        p = os.path.join(tmp, 't.cb7')
        with py7zr.SevenZipFile(p, 'w') as z:
            z.writestr(b'A' * 200000, 'page1.png')
        orig = comicdoc.MAX_ARCHIVE_ENTRY_BYTES
        comicdoc.MAX_ARCHIVE_ENTRY_BYTES = 1000           # 1 KB cap
        try:
            with pytest.raises(ValueError):
                comicdoc._read_7z_members(p, ['page1.png'])
        finally:
            comicdoc.MAX_ARCHIVE_ENTRY_BYTES = orig
        # under the real cap it reads fully (no silent truncation)
        got = comicdoc._read_7z_members(p, ['page1.png'])
        assert got.get('page1.png') and len(got['page1.png']) == 200000
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_comicdoc_cache_is_bounded():
    from renderers import comicdoc
    from collections import OrderedDict
    assert isinstance(comicdoc._cache, OrderedDict)
    assert comicdoc._CACHE_MAX <= 8


# ── transcache: cross-process re-merge + unique tmp ─────────────────────────

def test_transcache_cross_process_merge():
    from renderers.transcache import TranslationCache
    tmp = tempfile.mkdtemp(prefix='yr_tc_')
    try:
        path = os.path.join(tmp, 'tc.json')
        a = TranslationCache(path=path)
        b = TranslationCache(path=path)        # loads the (empty) file
        a.put_many({'from_a': 'alpha'})
        b.put_many({'from_b': 'beta'})         # must NOT erase a's entry
        fresh = TranslationCache(path=path)
        assert fresh.get('from_a') == 'alpha'
        assert fresh.get('from_b') == 'beta'
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_transcache_concurrent_writes_stay_valid_json():
    import threading
    from renderers.transcache import TranslationCache
    tmp = tempfile.mkdtemp(prefix='yr_tc2_')
    try:
        path = os.path.join(tmp, 'tc.json')
        cache = TranslationCache(path=path)

        def hammer(n):
            for i in range(40):
                cache.put_many({f'k{n}_{i}': f'v{n}_{i}'})
                cache.get(f'k{n}_{i}')

        threads = [threading.Thread(target=hammer, args=(n,)) for n in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        # file is still valid JSON (no torn write)
        with open(path, encoding='utf-8') as fh:
            data = json.load(fh)
        assert isinstance(data, dict) and len(data) == 6 * 40
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
