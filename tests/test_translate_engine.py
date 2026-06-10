"""
Translation Phase 0 — the context-aware translate_segments engine (llm.py).

All tests stub llm.chat so they run offline and deterministically. They assert the
engine's robustness contract: keyed 1:1 mapping, id-reorder tolerance, missing-id
repair, refusal/malformed fallback to ORIGINAL text, blank passthrough, and the
hardened chat() response-shape guard.
"""
import json

import pytest

from renderers import llm


def test_translate_segments_basic(monkeypatch):
    def chat(cfg, messages, timeout=60, temperature=0.2):
        items = json.loads(messages[-1]['content'])['segments']
        return json.dumps({'segments': [{'id': it['id'], 't': 'AR:' + it['text']} for it in items]})
    monkeypatch.setattr(llm, 'chat', chat)
    segs = [{'id': 'a', 'text': 'hello'}, {'id': 'b', 'text': 'world'}]
    assert llm.translate_segments({}, segs, 'Arabic') == {'a': 'AR:hello', 'b': 'AR:world'}


def test_translate_segments_handles_reordered_ids(monkeypatch):
    """EN<->AR reorders; the model may return ids out of order — must still map 1:1."""
    def chat(cfg, messages, timeout=60, temperature=0.2):
        items = json.loads(messages[-1]['content'])['segments']
        rows = [{'id': it['id'], 't': it['text'].upper()} for it in reversed(items)]
        return json.dumps({'segments': rows})
    monkeypatch.setattr(llm, 'chat', chat)
    segs = [{'id': 0, 'text': 'one'}, {'id': 1, 'text': 'two'}, {'id': 2, 'text': 'three'}]
    assert llm.translate_segments({}, segs, 'X') == {0: 'ONE', 1: 'TWO', 2: 'THREE'}


def test_translate_segments_repairs_missing_id(monkeypatch):
    """A dropped id triggers exactly one repair retry that recovers it."""
    calls = {'n': 0}
    def chat(cfg, messages, timeout=60, temperature=0.2):
        items = json.loads(messages[-1]['content'])['segments']
        calls['n'] += 1
        if calls['n'] == 1:
            items = items[1:]                      # drop the first id initially
        return json.dumps({'segments': [{'id': it['id'], 't': 'T:' + it['text']} for it in items]})
    monkeypatch.setattr(llm, 'chat', chat)
    segs = [{'id': 0, 'text': 'one'}, {'id': 1, 'text': 'two'}]
    assert llm.translate_segments({}, segs, 'X') == {0: 'T:one', 1: 'T:two'}
    assert calls['n'] == 2                          # initial + one repair


def test_translate_segments_refusal_falls_back_to_original(monkeypatch):
    """A refusal/garbled reply must never surface — fall back to the original text."""
    monkeypatch.setattr(llm, 'chat', lambda *a, **k: 'I cannot translate that.')
    segs = [{'id': 0, 'text': 'hello'}, {'id': 1, 'text': 'world'}]
    assert llm.translate_segments({}, segs, 'Arabic') == {0: 'hello', 1: 'world'}


def test_translate_segments_salvages_via_per_item(monkeypatch):
    """If a weak model can't produce batch JSON but CAN translate a single string,
    the per-item fallback salvages it (batch JSON carries "segments"; the per-item
    translate() sends the raw text)."""
    def chat(cfg, messages, timeout=60, temperature=0.2):
        content = messages[-1]['content']
        if '"segments"' in content:
            return 'not json at all'                 # batch + repair both unparseable
        return 'PER-ITEM:' + content                  # single-string translate() works
    monkeypatch.setattr(llm, 'chat', chat)
    assert llm.translate_segments({}, [{'id': 0, 'text': 'hello'}], 'X') == {0: 'PER-ITEM:hello'}


def test_translate_segments_blank_preserved_and_not_sent(monkeypatch):
    seen = {}
    def chat(cfg, messages, timeout=60, temperature=0.2):
        items = json.loads(messages[-1]['content'])['segments']
        seen['ids'] = [it['id'] for it in items]
        return json.dumps({'segments': [{'id': it['id'], 't': 'X'} for it in items]})
    monkeypatch.setattr(llm, 'chat', chat)
    segs = [{'id': 0, 'text': '   '}, {'id': 1, 'text': 'real'}]
    res = llm.translate_segments({}, segs, 'X')
    assert res[0] == '   ' and res[1] == 'X'        # blank untouched, real translated
    assert seen['ids'] == [1]                        # blank never sent to the model


def test_translate_batch_delegates_same_length(monkeypatch):
    def chat(cfg, messages, timeout=60, temperature=0.2):
        items = json.loads(messages[-1]['content'])['segments']
        return json.dumps({'segments': [{'id': it['id'], 't': it['text'][::-1]} for it in items]})
    monkeypatch.setattr(llm, 'chat', chat)
    assert llm.translate_batch({}, ['abc', 'de'], 'X') == ['cba', 'ed']


def test_translate_batch_empty():
    assert llm.translate_batch({}, [], 'X') == []


def test_chat_raises_on_bad_response_shape(monkeypatch):
    class _Resp:
        def raise_for_status(self): pass
        def json(self): return {'choices': []}      # empty → IndexError without the guard
    monkeypatch.setattr(llm.requests, 'post', lambda *a, **k: _Resp())
    with pytest.raises(ValueError):
        llm.chat({'backend': 'custom', 'endpoint': 'http://h/v1/chat/completions', 'model': 'm'},
                 [{'role': 'user', 'content': 'x'}])
