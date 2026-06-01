"""
YancoRead — Comic archive renderer.

A comic file (cbz/cbr/cb7/cbt) is just an archive of ordered page images.
This module lists the image entries in natural sort order and serves each
page's raw bytes — no rasterization needed.

Container support:
    .cbz / .cba  → zip   (stdlib zipfile)
    .cbt         → tar   (stdlib tarfile)
    .cbr         → rar   (rarfile; needs unrar/7z/bsdtar on PATH)
    .cb7         → 7z    (py7zr)
"""

import logging
import re
import tarfile
import threading
import zipfile
from collections import OrderedDict
from pathlib import Path

from constants import COMIC_PAGE_EXTS
from renderers import rartools

logger = logging.getLogger('yancoread.comicdoc')

# Per-document page-bytes cache. CBR/CB7 extraction shells out to an external
# tool (and reopens the whole archive) on every page, which is slow and spawns
# a process per page; the lazy-loader fetches several pages at once. Keep the
# most-recently-served raw page images in memory, bounded by total bytes.
_PAGE_CACHE_MAX_BYTES = 96 * 1024 * 1024  # ~96 MB of decoded page images


def _open_rar(path):
    import rarfile
    if not rartools.have_extractor():
        raise RuntimeError(
            'Cannot open .cbr: no RAR extractor found. Install 7-Zip or WinRAR, '
            'or run on Windows 10+ (which ships tar.exe).')
    return rarfile.RarFile(path)


# py7zr dropped the in-memory SevenZipFile.read() API around 1.0 in favour of a
# WriterFactory; older releases still have read(). Support both so .cb7 works
# regardless of which py7zr is installed/bundled.
_SEVENZIP_READ_LIMIT = 512 * 1024 * 1024  # max bytes a single 7z member may use


def _read_7z_members(path, names):
    """Return {name: bytes} for the requested entries of a .cb7 archive."""
    import py7zr
    out = {}
    with py7zr.SevenZipFile(path) as z:
        # Old API (py7zr < ~1.0): read() returns {name: BytesIO}.
        if hasattr(z, 'read'):
            got = z.read(list(names)) or {}
            for n in names:
                bio = got.get(n)
                if bio is not None:
                    try:
                        bio.seek(0)
                    except Exception:
                        pass
                    out[n] = bio.read()
            return out
        # New API: extract into an in-memory BytesIOFactory.
        from py7zr.io import BytesIOFactory
        fac = BytesIOFactory(_SEVENZIP_READ_LIMIT)
        z.extract(targets=list(names), factory=fac)
        for n in names:
            obj = fac.get(n)
            if obj is not None:
                try:
                    obj.seek(0)
                except Exception:
                    pass
                out[n] = obj.read()
    return out

_MIME = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.avif': 'image/avif',
}


def _natural_key(name: str):
    """Sort key that orders page2 before page10."""
    return [int(t) if t.isdigit() else t.lower()
            for t in re.split(r'(\d+)', name)]


def _is_page(name: str) -> bool:
    if name.endswith('/'):
        return False
    return Path(name).suffix.lower() in COMIC_PAGE_EXTS


class ComicDoc:
    """Lists and serves the page images inside a comic archive."""

    def __init__(self, path: str):
        self.path = str(path)
        self.ext = Path(path).suffix.lower()
        self.names = self._list_pages()
        self._page_cache: "OrderedDict[int, tuple]" = OrderedDict()  # index -> (data, mime)
        self._page_cache_bytes = 0
        self._page_lock = threading.Lock()

    # ── listing ───────────────────────────────────────────────────────────────
    def _list_pages(self) -> list:
        if self.ext in ('.cbz', '.cba'):
            with zipfile.ZipFile(self.path) as z:
                names = [n for n in z.namelist() if _is_page(n)]
        elif self.ext == '.cbt':
            with tarfile.open(self.path) as t:
                names = [m.name for m in t.getmembers() if m.isfile() and _is_page(m.name)]
        elif self.ext == '.cbr':
            with _open_rar(self.path) as r:
                names = [n for n in r.namelist() if _is_page(n)]
        elif self.ext == '.cb7':
            import py7zr
            with py7zr.SevenZipFile(self.path) as z:
                names = [n for n in z.getnames() if _is_page(n)]
        else:
            raise ValueError(f'Unsupported comic container: {self.ext}')
        names.sort(key=_natural_key)
        return names

    @property
    def page_count(self) -> int:
        return len(self.names)

    def info(self) -> dict:
        return {'page_count': self.page_count}

    # ── page bytes ────────────────────────────────────────────────────────────
    def get_page(self, index: int):
        """Return (bytes, mimetype) for the page at index."""
        if not self.names:
            raise IndexError('comic has no pages')
        index = max(0, min(index, len(self.names) - 1))

        with self._page_lock:
            hit = self._page_cache.get(index)
            if hit is not None:
                self._page_cache.move_to_end(index)
                return hit

        name = self.names[index]
        mime = _MIME.get(Path(name).suffix.lower(), 'application/octet-stream')

        if self.ext in ('.cbz', '.cba'):
            with zipfile.ZipFile(self.path) as z:
                data = z.read(name)
        elif self.ext == '.cbt':
            with tarfile.open(self.path) as t:
                fh = t.extractfile(name)
                data = fh.read() if fh else b''
        elif self.ext == '.cbr':
            with _open_rar(self.path) as r:
                data = r.read(name)
        elif self.ext == '.cb7':
            data = _read_7z_members(self.path, [name]).get(name, b'')
        else:
            raise ValueError(f'Unsupported comic container: {self.ext}')

        self._cache_page(index, data, mime)
        return data, mime

    def _cache_page(self, index: int, data: bytes, mime: str) -> None:
        with self._page_lock:
            if index in self._page_cache:
                return
            self._page_cache[index] = (data, mime)
            self._page_cache_bytes += len(data)
            while self._page_cache_bytes > _PAGE_CACHE_MAX_BYTES and len(self._page_cache) > 1:
                _, (old, _m) = self._page_cache.popitem(last=False)
                self._page_cache_bytes -= len(old)

    def read_meta(self, basename: str):
        """Read a non-image entry by file name (e.g. 'ComicInfo.xml'). Returns bytes or None."""
        target = basename.lower()

        def _match(name):
            return name.split('/')[-1].lower() == target

        try:
            if self.ext in ('.cbz', '.cba'):
                with zipfile.ZipFile(self.path) as z:
                    for n in z.namelist():
                        if _match(n):
                            return z.read(n)
            elif self.ext == '.cbt':
                with tarfile.open(self.path) as t:
                    for m in t.getmembers():
                        if m.isfile() and _match(m.name):
                            fh = t.extractfile(m)
                            return fh.read() if fh else None
            elif self.ext == '.cbr':
                with _open_rar(self.path) as r:
                    for n in r.namelist():
                        if _match(n):
                            return r.read(n)
            elif self.ext == '.cb7':
                import py7zr
                with py7zr.SevenZipFile(self.path) as z:
                    names = [n for n in z.getnames() if _match(n)]
                if names:
                    got = _read_7z_members(self.path, [names[0]])
                    return got.get(names[0])
        except Exception as e:
            logger.debug("read_meta(%s) failed: %s", basename, e)
        return None


# ── cache (entry lists are reused across page requests) ──────────────────────
_cache = {}          # path -> (mtime, ComicDoc)
_lock = threading.Lock()


def get_doc(path: str) -> ComicDoc:
    path = str(path)
    try:
        mtime = Path(path).stat().st_mtime
    except OSError:
        mtime = 0.0
    with _lock:
        cached = _cache.get(path)
        if cached and cached[0] == mtime:
            return cached[1]
        doc = ComicDoc(path)
        _cache[path] = (mtime, doc)
        return doc
