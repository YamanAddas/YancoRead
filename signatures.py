"""
YancoRead — Signature / stamp library.

A small on-disk store of reusable signature images (transparent PNGs) used by
the PDF "Sign & stamp" tool. Signatures are *personal data*, so they live in
the per-user data dir (``%APPDATA%\\YancoRead\\signatures`` on Windows) — never
in the repo. Each signature is one ``<id>.png`` file; an ``index.json`` holds
display metadata (name, kind, pixel size, created time). Thread-safe with
atomic writes, mirroring userdata.py.
"""

import base64
import binascii
import json
import logging
import re
import threading
import time
import uuid
from pathlib import Path

from paths import get_data_dir

logger = logging.getLogger('yancoread.signatures')

PNG_MAGIC = b'\x89PNG\r\n\x1a\n'
_MAX_BYTES = 4 * 1024 * 1024          # 4 MB ceiling per signature PNG
_NAME_MAX = 60
_ID_RE = re.compile(r'^[a-f0-9]{1,32}$')   # ids we mint are lowercase hex
_VALID_KINDS = ('draw', 'type', 'import')


def _png_dims(data: bytes) -> tuple:
    """Validate PNG magic + IHDR and return (width, height) in pixels.

    Parsing the header ourselves keeps the store dependency-free (no Pillow /
    fitz needed just to size an image) and rejects non-PNG payloads early.
    """
    if not data or len(data) < 24 or data[:8] != PNG_MAGIC:
        raise ValueError('signature must be a PNG image')
    if data[12:16] != b'IHDR':
        raise ValueError('malformed PNG (missing IHDR)')
    w = int.from_bytes(data[16:20], 'big')
    h = int.from_bytes(data[20:24], 'big')
    if w <= 0 or h <= 0:
        raise ValueError('PNG has no pixels')
    return w, h


def decode_png_data(raw) -> bytes:
    """Turn a frontend payload into raw PNG bytes.

    Accepts a ``data:image/png;base64,…`` data URL, a bare base64 string, or
    already-decoded bytes. Validation that it is actually a PNG happens in
    :meth:`SignatureStore.add`.
    """
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw)
    s = str(raw or '').strip()
    if not s:
        raise ValueError('no image data')
    if s.startswith('data:'):
        comma = s.find(',')
        if comma == -1:
            raise ValueError('malformed data URL')
        s = s[comma + 1:]
    s = re.sub(r'\s+', '', s)
    try:
        return base64.b64decode(s, validate=False)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f'invalid base64 image data: {e}')


def _safe_id(sig_id) -> str:
    sid = str(sig_id or '')
    if not _ID_RE.match(sid):
        raise ValueError('bad signature id')
    return sid


class SignatureStore:
    """Thread-safe accessor for the reusable-signature library on disk."""

    def __init__(self, root: Path | None = None):
        self._dir = Path(root) if root else (get_data_dir() / 'signatures')
        self._dir.mkdir(parents=True, exist_ok=True)
        self._index = self._dir / 'index.json'
        self._lock = threading.RLock()

    # ── persistence ─────────────────────────────────────────────────────────
    def _load(self) -> list:
        if self._index.exists():
            try:
                data = json.loads(self._index.read_text(encoding='utf-8'))
                items = data.get('items') if isinstance(data, dict) else data
                if isinstance(items, list):
                    return [it for it in items if isinstance(it, dict)]
            except (json.JSONDecodeError, OSError) as e:
                logger.warning('signature index load failed (%s); rebuilding', e)
        return []

    def _write(self, items: list) -> None:
        tmp = self._index.with_suffix('.json.tmp')
        try:
            tmp.write_text(json.dumps({'items': items}, indent=2), encoding='utf-8')
            tmp.replace(self._index)
        except OSError as e:
            logger.error('signature index save failed: %s', e)

    def _png_path(self, sig_id: str) -> Path:
        return self._dir / f'{sig_id}.png'

    # ── operations ──────────────────────────────────────────────────────────
    def list(self) -> list:
        """Return library entries, newest first. Self-heals: entries whose PNG
        was removed out-of-band are dropped from the index."""
        with self._lock:
            items = self._load()
            live = [it for it in items if self._png_path(str(it.get('id', ''))).exists()]
            if len(live) != len(items):
                self._write(live)
            return live

    def add(self, png_bytes: bytes, name: str = '', kind: str = 'draw') -> dict:
        """Validate + store a PNG signature. Returns the new entry descriptor."""
        if not png_bytes:
            raise ValueError('no image data')
        if len(png_bytes) > _MAX_BYTES:
            raise ValueError('signature image is too large (max 4 MB)')
        w, h = _png_dims(png_bytes)
        sig_id = uuid.uuid4().hex[:16]
        entry = {
            'id': sig_id,
            'name': (name or '').strip()[:_NAME_MAX] or 'Signature',
            'kind': kind if kind in _VALID_KINDS else 'draw',
            'w': w, 'h': h,
            'created': time.time(),
        }
        with self._lock:
            self._png_path(sig_id).write_bytes(png_bytes)
            items = self._load()
            items.insert(0, entry)
            self._write(items)
        return entry

    def png(self, sig_id) -> bytes:
        """Raw PNG bytes for a signature. Raises KeyError if it doesn't exist."""
        sid = _safe_id(sig_id)
        with self._lock:
            p = self._png_path(sid)
            if not p.exists():
                raise KeyError(sig_id)
            return p.read_bytes()

    def rename(self, sig_id, name: str):
        """Rename a signature. Returns the updated entry, or None if not found."""
        with self._lock:
            items = self._load()
            for it in items:
                if it.get('id') == sig_id:
                    it['name'] = (name or '').strip()[:_NAME_MAX] or it.get('name') or 'Signature'
                    self._write(items)
                    return it
            return None

    def delete(self, sig_id) -> bool:
        """Remove a signature's PNG and index entry. Returns True if anything
        was removed."""
        with self._lock:
            try:
                sid = _safe_id(sig_id)
            except ValueError:
                return False
            png = self._png_path(sid)
            existed = png.exists()
            try:
                png.unlink(missing_ok=True)
            except OSError as e:
                logger.warning('could not delete signature png %s: %s', sid, e)
            items = self._load()
            kept = [it for it in items if it.get('id') != sig_id]
            removed_entry = len(kept) != len(items)
            if removed_entry:
                self._write(kept)
            return existed or removed_entry
