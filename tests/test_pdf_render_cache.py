"""Per-document rendered-page cache (FitzDoc._render_cache).

render_page() memoises PNG bytes by (index, zoom, rotate) — the viewer re-asks
for the same page at the same zoom constantly, and get_pixmap + PNG encode is the
dominant per-request cost. The cache is bounded by total bytes and dropped
wholesale whenever an edit or reflow makes the rendered pixels stale.

The module-global FitzDoc cache is purged after each test so Windows releases the
file handle (mirrors the other PDF test modules)."""
import shutil

import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc


def _copy_pdf(samples, tmp_path, name='work.pdf'):
    dest = tmp_path / name
    shutil.copy2(samples['pdf'], dest)
    return dest


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


def test_repeat_render_is_a_cache_hit(samples, tmp_path):
    """Same (index, zoom, rotate) returns the very same bytes object, cached once."""
    doc = FitzDoc(str(_copy_pdf(samples, tmp_path)))
    try:
        a = doc.render_page(0, zoom=1.0, rotate=0)
        b = doc.render_page(0, zoom=1.0, rotate=0)
        assert a == b
        assert a is b                                   # served from cache, not re-encoded
        assert len(doc._render_cache) == 1
        assert doc._render_cache_bytes == len(a)
    finally:
        doc.close()


def test_distinct_zoom_and_rotate_are_distinct_entries(samples, tmp_path):
    doc = FitzDoc(str(_copy_pdf(samples, tmp_path)))
    try:
        doc.render_page(0, zoom=1.0, rotate=0)
        doc.render_page(0, zoom=2.0, rotate=0)          # different zoom
        doc.render_page(0, zoom=1.0, rotate=90)         # different rotation
        assert len(doc._render_cache) == 3
    finally:
        doc.close()


def test_zoom_is_quantised_for_the_key(samples, tmp_path):
    """Float zooms that round to the same 3 decimals share one cache entry."""
    doc = FitzDoc(str(_copy_pdf(samples, tmp_path)))
    try:
        a = doc.render_page(0, zoom=1.5, rotate=0)
        b = doc.render_page(0, zoom=1.50049, rotate=0)  # rounds to 1.500
        assert a is b
        assert len(doc._render_cache) == 1
    finally:
        doc.close()


def test_edit_invalidates_render_cache(samples, tmp_path):
    """A page mutation (rotate) drops the cache and forces a fresh, different render."""
    doc = FitzDoc(str(_copy_pdf(samples, tmp_path)))
    try:
        before = doc.render_page(0, zoom=1.0, rotate=0)
        assert len(doc._render_cache) == 1

        doc.rotate_page(0)                              # sets /Rotate → _set_dirty()
        assert doc.dirty is True
        assert len(doc._render_cache) == 0              # cache cleared
        assert doc._render_cache_bytes == 0

        after = doc.render_page(0, zoom=1.0, rotate=0)
        assert after != before                          # the rotated page renders differently
    finally:
        doc.close()


def test_mark_dirty_clears_cache(samples, tmp_path):
    doc = FitzDoc(str(_copy_pdf(samples, tmp_path)))
    try:
        doc.render_page(0, zoom=1.0, rotate=0)
        assert len(doc._render_cache) == 1
        doc.mark_dirty()
        assert len(doc._render_cache) == 0 and doc._render_cache_bytes == 0
    finally:
        doc.close()


def test_byte_budget_evicts_oldest_but_keeps_one(samples, tmp_path, monkeypatch):
    """Past the byte budget the oldest entries are evicted; the just-rendered page
    is always retained even if a single page exceeds the budget."""
    monkeypatch.setattr(fitzdoc, '_PIXMAP_CACHE_MAX_BYTES', 1)   # 1 byte: always over
    doc = FitzDoc(str(_copy_pdf(samples, tmp_path)))
    try:
        doc.render_page(0, zoom=1.0, rotate=0)
        doc.render_page(0, zoom=2.0, rotate=0)
        doc.render_page(0, zoom=3.0, rotate=0)
        assert len(doc._render_cache) == 1              # only the newest survives
        assert doc._render_cache_bytes == len(next(reversed(doc._render_cache.values())))
    finally:
        doc.close()
