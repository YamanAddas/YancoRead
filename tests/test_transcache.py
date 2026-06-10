"""
Translation Phase 0 — persistent translation cache + language detector.
"""
from renderers import transcache
from renderers import llm


# ── seg_key ─────────────────────────────────────────────────────────────────────
def test_seg_key_stable_and_whitespace_normalized():
    a = transcache.seg_key('hello   world', 'Arabic', 'auto', 'neutral', 'm')
    b = transcache.seg_key('hello world', 'Arabic', 'auto', 'neutral', 'm')
    assert a == b                                  # whitespace collapsed → same key


def test_seg_key_sensitive_to_params():
    base = transcache.seg_key('hi', 'Arabic', 'auto', 'neutral', 'm')
    assert base != transcache.seg_key('hi', 'English', 'auto', 'neutral', 'm')   # target
    assert base != transcache.seg_key('hi', 'Arabic', 'auto', 'formal', 'm')     # register
    assert base != transcache.seg_key('hi', 'Arabic', 'auto', 'neutral', 'm2')   # model
    assert base != transcache.seg_key('ho', 'Arabic', 'auto', 'neutral', 'm')    # text


# ── cache get/put/persist/evict ─────────────────────────────────────────────────
def test_cache_put_get_roundtrip(tmp_path):
    c = transcache.TranslationCache(path=tmp_path / 't.json')
    c.put_many({'k1': 'v1', 'k2': 'v2'})
    assert c.get('k1') == 'v1'
    assert c.get_many(['k1', 'k2', 'missing']) == {'k1': 'v1', 'k2': 'v2'}
    assert c.get('nope') is None


def test_cache_persists_across_instances(tmp_path):
    p = tmp_path / 't.json'
    transcache.TranslationCache(path=p).put_many({'kept': 'value'})
    fresh = transcache.TranslationCache(path=p)            # new instance, same file
    assert fresh.get('kept') == 'value'


def test_cache_evicts_lru(tmp_path):
    c = transcache.TranslationCache(path=tmp_path / 't.json', max_entries=3)
    c.put_many({'a': '1', 'b': '2', 'c': '3'})
    c.get('a')                                            # touch 'a' → most-recent
    c.put_many({'d': '4'})                                # over cap → evict LRU ('b')
    assert c.get('a') == '1' and c.get('d') == '4'
    assert c.get('b') is None


def test_cache_handles_corrupt_file(tmp_path):
    p = tmp_path / 't.json'
    p.write_text('{ not valid json', encoding='utf-8')
    c = transcache.TranslationCache(path=p)               # must not raise
    assert c.get('x') is None
    c.put_many({'x': 'y'})                                # still usable
    assert c.get('x') == 'y'


# ── language detector (no LLM) ───────────────────────────────────────────────────
def test_detect_lang_english():
    assert llm.detect_lang('The quick brown fox jumps over the lazy dog.') == 'English'


def test_detect_lang_arabic():
    assert llm.detect_lang('السلام عليكم ورحمة الله وبركاته') == 'Arabic'


def test_detect_lang_mixed_mostly_english():
    # A mostly-English sentence with one Arabic name stays English.
    assert llm.detect_lang('My name is محمد and I live in London.') == 'English'


def test_detect_lang_empty_defaults_english():
    assert llm.detect_lang('') == 'English'
    assert llm.detect_lang('12345 !@#') == 'English'
