"""
YancoRead — User Data Persistence
Single JSON file holding recent files, reading positions, bookmarks, and
per-kind reader preferences. Thread-safe, atomic writes.
"""

import json
import logging
import threading
import time
from pathlib import Path

from constants import RECENT_FILES_MAX
from paths import get_userdata_file

logger = logging.getLogger('yancoread.userdata')

DEFAULT_DATA = {
    'recent': [],        # [{path, name, kind, last_opened, position, progress}]
    'file_prefs': {},    # path -> {dir: 'auto'|'ltr'|'rtl', ...} per-file overrides
    'bookmarks': {},     # path -> [ {page/anchor, label, ts} ]
    'prefs': {
        'pdf':   {'fit': 'width', 'zoom': 1.0, 'scroll': 'continuous'},
        'comic': {'mode': 'single', 'fit': 'height', 'rtl': False},
        'ebook': {'fontsize': 11, 'theme': 'dark'},
        'text':  {'theme': 'dark', 'wrap': True, 'fontsize': 15},
        'office': {'zoom': 1.0},
        'image': {'fit': 'contain'},
    },
    'settings': {
        'theme': 'dark',
        'restore_last': True,
        'tesseract_path': '',          # override; blank = auto-detect
        'ocr_source': 'vision',        # 'vision' (multimodal LLM — universal, any language) | 'tesseract' (offline, best on clean Latin/Arabic)
        'ai': {
            'backend': 'ollama',       # ollama | lmstudio | openclaw | openai | custom
            'endpoint': '',            # blank = backend default
            'model': '',               # blank = backend default
            'api_key': '',
            'target_lang': 'English',  # translate comics into this language
        },
    },
}


class UserData:
    """Thread-safe accessor for the userdata.json file."""

    def __init__(self, path: Path | None = None):
        self._path = Path(path) if path else get_userdata_file()
        self._lock = threading.RLock()
        self._data = self._load()

    def _load(self) -> dict:
        if self._path.exists():
            try:
                data = json.loads(self._path.read_text(encoding='utf-8'))
                return self._merge_defaults(data)
            except (json.JSONDecodeError, OSError) as e:
                logger.warning("userdata load failed (%s); using defaults", e)
        return json.loads(json.dumps(DEFAULT_DATA))  # deep copy

    @classmethod
    def _merge_defaults(cls, data: dict) -> dict:
        # Recursive deep-merge so newly-added nested defaults (e.g. settings.ai.*)
        # backfill into an existing userdata.json instead of being shadowed by a
        # shallow update of the top-level 'settings' dict.
        merged = json.loads(json.dumps(DEFAULT_DATA))
        return cls._deep_merge(merged, data)

    @classmethod
    def _deep_merge(cls, base: dict, overlay: dict) -> dict:
        for key, val in overlay.items():
            if isinstance(val, dict) and isinstance(base.get(key), dict):
                cls._deep_merge(base[key], val)
            else:
                base[key] = val
        return base

    def _save(self) -> None:
        tmp = self._path.with_suffix('.json.tmp')
        try:
            tmp.write_text(json.dumps(self._data, indent=2), encoding='utf-8')
            tmp.replace(self._path)
        except OSError as e:
            logger.error("userdata save failed: %s", e)

    # ── recent files ──────────────────────────────────────────────────────────
    def add_recent(self, path: str, name: str, kind: str) -> None:
        with self._lock:
            recent = [r for r in self._data['recent'] if r.get('path') != path]
            entry = next((r for r in self._data['recent'] if r.get('path') == path), {})
            entry.update({'path': path, 'name': name, 'kind': kind,
                          'last_opened': time.time()})
            recent.insert(0, entry)
            self._data['recent'] = recent[:RECENT_FILES_MAX]
            self._save()

    def get_recent(self) -> list:
        with self._lock:
            return list(self._data['recent'])

    def remove_recent(self, path: str) -> None:
        with self._lock:
            self._data['recent'] = [r for r in self._data['recent']
                                    if r.get('path') != path]
            self._save()

    def clear_recent(self) -> None:
        with self._lock:
            self._data['recent'] = []
            self._save()

    # ── reading position / progress ────────────────────────────────────────────
    def set_position(self, path: str, position, progress: float = 0.0) -> None:
        with self._lock:
            for r in self._data['recent']:
                if r.get('path') == path:
                    r['position'] = position
                    r['progress'] = round(float(progress), 4)
                    r['last_opened'] = time.time()
                    break
            self._save()

    def get_position(self, path: str):
        with self._lock:
            for r in self._data['recent']:
                if r.get('path') == path:
                    return r.get('position'), r.get('progress', 0.0)
        return None, 0.0

    # ── bookmarks ──────────────────────────────────────────────────────────────
    def add_bookmark(self, path: str, mark: dict) -> None:
        with self._lock:
            mark = dict(mark)
            mark.setdefault('ts', time.time())
            self._data['bookmarks'].setdefault(path, []).append(mark)
            self._save()

    def get_bookmarks(self, path: str) -> list:
        with self._lock:
            return list(self._data['bookmarks'].get(path, []))

    def remove_bookmark(self, path: str, index: int) -> None:
        with self._lock:
            marks = self._data['bookmarks'].get(path, [])
            if 0 <= index < len(marks):
                marks.pop(index)
                self._save()

    # ── per-file preferences (e.g. reading direction override) ─────────────────
    def get_file_prefs(self, path: str) -> dict:
        with self._lock:
            return dict(self._data['file_prefs'].get(path, {}))

    def set_file_pref(self, path: str, prefs: dict) -> None:
        with self._lock:
            self._data['file_prefs'].setdefault(path, {}).update(prefs)
            self._save()

    # ── preferences ────────────────────────────────────────────────────────────
    def get_prefs(self, kind: str) -> dict:
        with self._lock:
            return dict(self._data['prefs'].get(kind, {}))

    def set_prefs(self, kind: str, prefs: dict) -> None:
        with self._lock:
            self._data['prefs'].setdefault(kind, {}).update(prefs)
            self._save()

    def all_prefs(self) -> dict:
        with self._lock:
            return json.loads(json.dumps(self._data['prefs']))

    # ── settings ───────────────────────────────────────────────────────────────
    def get_settings(self) -> dict:
        with self._lock:
            return dict(self._data['settings'])

    def set_setting(self, key: str, value) -> None:
        with self._lock:
            self._data['settings'][key] = value
            self._save()
