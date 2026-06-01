"""P5a — PDF save foundation: incremental save / save-copy + dirty-state cache.

The save path mutates files, so every test works on a *copy* of the shared
session sample (never the fixture original).
"""
import shutil

import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc

PNG_MAGIC = b'\x89PNG\r\n\x1a\n'
_RECT = fitz.Rect(70, 80, 220, 95)


def _copy_pdf(samples, tmp_path, name='work.pdf'):
    dest = tmp_path / name
    shutil.copy2(samples['pdf'], dest)
    return dest


def _annot_count(path) -> int:
    d = fitz.open(str(path))
    try:
        return sum(1 for _ in d.load_page(0).annots())
    finally:
        d.close()


# ── FitzDoc-level: round-trip + no-op ────────────────────────────────────────
def test_save_roundtrip_incremental(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    assert _annot_count(p) == 0

    doc = FitzDoc(str(p))
    doc.doc.load_page(0).add_highlight_annot(_RECT)   # simulates a P5b markup op
    doc.mark_dirty()
    res = doc.save()
    doc.close()

    assert res == {'saved': True, 'mode': 'incremental'}
    assert _annot_count(p) == 1, "annotation must persist to disk after save()"


def test_clean_save_is_noop(samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    before = p.stat().st_size
    doc = FitzDoc(str(p))
    res = doc.save()           # nothing was edited
    doc.close()
    assert res == {'saved': False, 'mode': 'clean'}
    assert p.stat().st_size == before, "a clean save must not rewrite the file"


def test_save_copy_leaves_original_untouched(samples, tmp_path):
    src = _copy_pdf(samples, tmp_path, 'src.pdf')
    dest = tmp_path / 'copy.pdf'

    doc = FitzDoc(str(src))
    doc.doc.load_page(0).add_highlight_annot(_RECT)
    doc.mark_dirty()
    out = doc.save_copy(str(dest))

    assert out['path'] == str(dest) and dest.is_file()
    assert _annot_count(dest) == 1, "copy must include the unsaved edits"
    assert _annot_count(src) == 0, "save_copy must never touch the original"
    assert doc.dirty is True, "working doc stays dirty after a copy (edits unsaved)"
    doc.close()


# ── cache invariants: a dirty doc must survive reopen + eviction ─────────────
def test_dirty_doc_not_reopened_on_mtime_change(samples, tmp_path):
    p = str(_copy_pdf(samples, tmp_path, 'live.pdf'))
    try:
        d1 = fitzdoc.get_doc(p)
        d1.doc.load_page(0).add_highlight_annot(_RECT)
        d1.mark_dirty()
        # Simulate the file changing on disk: poke a stale stored mtime so the
        # next get_doc() sees a mismatch and would normally reopen.
        with fitzdoc._lock:
            mt, obj = fitzdoc._cache[p]
            fitzdoc._cache[p] = (mt - 9999.0, obj)
        d2 = fitzdoc.get_doc(p)
        assert d2 is d1, "a dirty doc must never be silently reopened"
        assert d2.dirty is True
    finally:
        with fitzdoc._lock:
            ent = fitzdoc._cache.pop(p, None)
        if ent:
            ent[1].close()


def test_dirty_doc_survives_lru_eviction(tmp_path):
    n = fitzdoc._CACHE_MAX + 2
    paths = []
    for i in range(n + 1):
        fp = tmp_path / f'e{i}.pdf'
        d = fitz.open()
        d.new_page().insert_text((72, 72), f'page {i}')
        d.save(str(fp))
        d.close()
        paths.append(str(fp))
    try:
        dirty = fitzdoc.get_doc(paths[0])           # oldest entry
        dirty.doc.load_page(0).add_highlight_annot(fitz.Rect(70, 70, 200, 90))
        dirty.mark_dirty()
        for p in paths[1:]:                         # flood the cache past the cap
            fitzdoc.get_doc(p)
        with fitzdoc._lock:
            assert paths[0] in fitzdoc._cache, "dirty doc must survive eviction"
            assert fitzdoc._cache[paths[0]][1] is dirty
        assert dirty.render_page(0, 1.0)[:8] == PNG_MAGIC, "dirty doc still usable"
    finally:
        with fitzdoc._lock:
            for p in paths:
                ent = fitzdoc._cache.pop(p, None)
                if ent:
                    ent[1].close()


# ── Flask endpoints ──────────────────────────────────────────────────────────
def test_api_save_clean_is_ok_noop(client, samples, tmp_path):
    p = _copy_pdf(samples, tmp_path)
    r = client.post('/api/pdf/save', json={'path': str(p)})
    assert r.status_code == 200
    body = r.get_json()
    assert body['ok'] is True and body['saved'] is False and body['mode'] == 'clean'


def test_api_save_rejects_non_pdf(client, samples):
    r = client.post('/api/pdf/save', json={'path': str(samples['txt'])})
    assert r.status_code == 400
    assert 'PDF' in r.get_json()['error']


def test_api_save_missing_path(client):
    assert client.post('/api/pdf/save', json={}).status_code == 400


def test_api_save_copy_writes_new_file(client, samples, tmp_path):
    src = _copy_pdf(samples, tmp_path, 'src.pdf')
    dest = tmp_path / 'out.pdf'
    r = client.post('/api/pdf/save-copy', json={'path': str(src), 'target': str(dest)})
    assert r.status_code == 200
    assert r.get_json()['ok'] is True
    assert dest.is_file() and fitz.open(str(dest)).is_pdf


def test_api_save_copy_rejects_same_file(client, samples, tmp_path):
    src = _copy_pdf(samples, tmp_path, 'src.pdf')
    r = client.post('/api/pdf/save-copy', json={'path': str(src), 'target': str(src)})
    assert r.status_code == 409
