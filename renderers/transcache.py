"""
YancoRead — Translation cache.

A persistent, content-addressed cache of translated text segments. Local LLMs can
take seconds per page, so re-opening a page (or re-encountering the same paragraph)
should be instant. Keys hash the SOURCE TEXT + target/source/register + model, so
identical text reuses its translation across pages and documents. Stored as a JSON
sidecar in the user CACHE dir (regenerable — never written into the repo).

Note: content-addressed keys are correct for the TEXT-LAYER path (PDF/eBook/office),
where the same text always yields the same translation. The comic/image VISION path
must instead cache per (path, page) — its OCR boxes are non-deterministic — and is
handled separately, not here.
"""
import hashlib
import json
import logging
import os
import threading
from collections import OrderedDict
from pathlib import Path

logger = logging.getLogger('yancoread.transcache')

_MAX_ENTRIES = 5000


def seg_key(text: str, target: str, src: str = 'auto',
            register: str = 'neutral', model: str = '') -> str:
    """A stable cache key for one segment. Whitespace is normalised so trivially
    different wrapping of the same text still hits."""
    norm = ' '.join((text or '').split())
    raw = '\x1f'.join([norm, target or '', src or 'auto',
                       register or 'neutral', model or ''])
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def page_key(path: str, index: int, target: str, rtl: bool = False,
             register: str = 'neutral', model: str = '') -> str:
    """A cache key for a WHOLE page's vision (OCR+translate) result. Unlike
    seg_key this is NOT content-addressed — the OCR boxes are non-deterministic —
    so it is keyed by file IDENTITY (path + mtime + size). If the file at `path`
    changes, the key changes and the stale page is never served."""
    try:
        st = os.stat(path)
        ident = '{}:{}'.format(int(st.st_mtime_ns), st.st_size)
    except OSError:
        ident = '0'
    raw = '\x1f'.join([str(path), ident, str(int(index)), target or '',
                       '1' if rtl else '0', register or 'neutral', model or ''])
    return 'P' + hashlib.sha256(raw.encode('utf-8')).hexdigest()


class TranslationCache:
    """Thread-safe LRU with an atomic JSON backing file. Pass an explicit `path`
    in tests; in the app it defaults to <cache_dir>/translations.json."""

    def __init__(self, path=None, max_entries: int = _MAX_ENTRIES):
        self._explicit_path = Path(path) if path else None
        self._max = max_entries
        self._lock = threading.RLock()
        self._data: "OrderedDict[str, str]" = OrderedDict()
        self._disk_mtime = None   # mtime_ns at our last read/write — detects co-writers
        self._load()

    def _path(self):
        if self._explicit_path is not None:
            return self._explicit_path
        try:
            from paths import get_cache_dir
            return get_cache_dir() / 'translations.json'
        except Exception:
            return None

    def _load(self):
        p = self._path()
        if not p:
            return
        try:
            if p.exists():
                d = json.loads(p.read_text(encoding='utf-8'))
                if isinstance(d, dict):
                    self._data.update({str(k): str(v) for k, v in d.items()})
                try:
                    self._disk_mtime = p.stat().st_mtime_ns
                except OSError:
                    pass
        except Exception as e:
            logger.warning('translation cache load failed: %s', e)

    def get(self, key: str):
        with self._lock:
            v = self._data.get(key)
            if v is not None:
                self._data.move_to_end(key)
            return v

    def get_many(self, keys) -> dict:
        with self._lock:
            out = {}
            for k in keys:
                if k in self._data:
                    self._data.move_to_end(k)
                    out[k] = self._data[k]
            return out

    def put_many(self, mapping: dict) -> None:
        if not mapping:
            return
        with self._lock:
            for k, v in mapping.items():
                self._data[k] = v
                self._data.move_to_end(k)
            while len(self._data) > self._max:
                self._data.popitem(last=False)     # evict least-recently-used
            self._save()

    def _save(self):
        p = self._path()
        if not p:
            return
        import tempfile
        tmpname = None
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            # If another writer changed the file since we last read/wrote it, merge
            # the on-disk entries first so we don't erase them (last-writer-wins).
            # Rare (needs two processes sharing one cache file) — a cheap stat keeps
            # the normal single-writer path read-free.
            try:
                cur = p.stat().st_mtime_ns if p.exists() else None
            except OSError:
                cur = None
            if cur is not None and cur != self._disk_mtime:
                merged: "OrderedDict[str, str]" = OrderedDict()
                try:
                    disk = json.loads(p.read_text(encoding='utf-8'))
                    if isinstance(disk, dict):
                        merged.update({str(k): str(v) for k, v in disk.items()})
                except Exception:
                    pass
                merged.update(self._data)            # our entries win for shared keys
                while len(merged) > self._max:
                    merged.popitem(last=False)
                self._data = merged
            # Unique tmp in the same dir so two concurrent writers can't interleave
            # on one tmp file (which could leave torn JSON that loads as empty).
            fd, tmpname = tempfile.mkstemp(dir=str(p.parent), prefix=p.name + '.', suffix='.tmp')
            with os.fdopen(fd, 'w', encoding='utf-8') as fh:
                json.dump(self._data, fh, ensure_ascii=False)
            os.replace(tmpname, p)                   # atomic on the same filesystem
            tmpname = None
            try:
                self._disk_mtime = p.stat().st_mtime_ns
            except OSError:
                self._disk_mtime = None
        except Exception as e:
            logger.warning('translation cache save failed: %s', e)
        finally:
            if tmpname and os.path.exists(tmpname):
                try:
                    os.remove(tmpname)
                except OSError:
                    pass

    def clear(self):
        with self._lock:
            self._data.clear()
            self._save()


# Process-wide singletons (lazily created so tests can use isolated instances).
# Two separate files: content-addressed text segments vs. whole-page vision blobs
# (kept apart so big vision JSON doesn't evict small text entries from one LRU).
_default = None
_default_vision = None
_default_lock = threading.Lock()


def default_cache() -> TranslationCache:
    global _default
    with _default_lock:
        if _default is None:
            _default = TranslationCache()
        return _default


def default_vision_cache() -> TranslationCache:
    global _default_vision
    with _default_lock:
        if _default_vision is None:
            p = None
            try:
                from paths import get_cache_dir
                p = get_cache_dir() / 'translations-vision.json'
            except Exception:
                p = None
            _default_vision = TranslationCache(path=p, max_entries=512)
        return _default_vision
