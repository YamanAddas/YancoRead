"""Optional high-fidelity slide rendering via a *detected* LibreOffice install.

LibreOffice is NEVER bundled (it's ~hundreds of MB and MPL-licensed). We detect
a `soffice` binary and, only if present, convert PPTX → PDF with it, then
rasterize the PDF pages with PyMuPDF (already a dependency). Results are cached
on disk keyed by the file's path+mtime+size.

Every function degrades to ``None`` on any failure — a missing binary, a
conversion timeout, a corrupt deck — so the caller silently falls back to the
native (CSS-positioned) slide render.
"""

import hashlib
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from paths import get_cache_dir

logger = logging.getLogger('yancoread.libreoffice')

# LibreOffice serializes badly when several instances share state; one at a time.
_LOCK = threading.Lock()
_soffice_cache = None

_WIN_DIRS = [
    r'C:\Program Files\LibreOffice\program\soffice.exe',
    r'C:\Program Files (x86)\LibreOffice\program\soffice.exe',
]
_NIX_DIRS = [
    '/usr/bin/soffice', '/usr/local/bin/soffice',
    '/opt/libreoffice/program/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
]


def find_soffice():
    """Path to a usable `soffice` binary, or None. Caches a positive result; a
    negative result is re-checked (the user may install LibreOffice mid-session)."""
    global _soffice_cache
    if _soffice_cache:
        return _soffice_cache
    cand = shutil.which('soffice') or shutil.which('soffice.exe')
    if not cand:
        for p in _WIN_DIRS + _NIX_DIRS:
            if Path(p).is_file():
                cand = p
                break
    if cand:
        _soffice_cache = cand
    return cand


def available() -> bool:
    return bool(find_soffice())


def _cache_key(path: str) -> str:
    st = os.stat(path)
    raw = '%s|%d|%d' % (os.path.abspath(path), st.st_mtime_ns, st.st_size)
    return hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]


def _kill_tree(proc) -> None:
    """Kill a process AND its descendants. subprocess's own timeout only kills the
    launched `soffice`, but on Windows that execs a detached `soffice.bin` that
    survives and keeps the -env profile dir locked, so rmtree silently fails."""
    try:
        if sys.platform == 'win32':
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                           capture_output=True, check=False)
        else:
            proc.kill()
    except Exception:
        pass


def _sweep_stale_profiles() -> None:
    """Best-effort cleanup of yr_lo_* profile dirs orphaned by a past timeout. Only
    touches dirs older than an hour so an in-flight conversion's profile is safe."""
    import time
    try:
        tmp = Path(tempfile.gettempdir())
        cutoff = time.time() - 3600
        for d in tmp.glob('yr_lo_*'):
            try:
                if d.is_dir() and d.stat().st_mtime < cutoff:
                    shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass
    except Exception:
        pass


def _convert_to_pdf(src: str, out_dir: str, timeout: int = 120):
    """pptx → pdf via headless LibreOffice into out_dir. Returns the pdf Path or
    None. Uses a throwaway user profile and a hard timeout; serialized."""
    soffice = find_soffice()
    if not soffice:
        return None
    _sweep_stale_profiles()       # clear leftovers from past timed-out conversions
    profile = Path(tempfile.mkdtemp(prefix='yr_lo_'))
    cmd = [
        soffice, '--headless', '--norestore', '--nologo', '--nofirststartwizard',
        '-env:UserInstallation=%s' % profile.as_uri(),
        '--convert-to', 'pdf', '--outdir', str(out_dir), str(src),
    ]
    try:
        with _LOCK:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                _kill_tree(proc)            # reap the detached soffice.bin too
                try:
                    proc.communicate(timeout=5)
                except Exception:
                    pass
                logger.warning('LibreOffice conversion timed out: %s', src)
                return None
    except Exception as e:
        logger.warning('LibreOffice conversion failed: %s', e)
        return None
    finally:
        shutil.rmtree(profile, ignore_errors=True)   # a still-locked dir is swept next run
    pdf = Path(out_dir) / (Path(src).stem + '.pdf')
    return pdf if pdf.is_file() else None


def _rasterize_pdf(pdf_path: str, out_dir: Path, dpi: int = 150, thumb_dpi: int = 48) -> int:
    """Rasterize every PDF page to slide-<n>.png + thumb-<n>.png in out_dir.
    Returns the page count. Testable without LibreOffice (uses PyMuPDF only)."""
    import fitz
    doc = fitz.open(str(pdf_path))
    n = 0
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        for i, page in enumerate(doc, 1):
            page.get_pixmap(dpi=dpi).save(str(out_dir / ('slide-%d.png' % i)))
            page.get_pixmap(dpi=thumb_dpi).save(str(out_dir / ('thumb-%d.png' % i)))
            n = i
    finally:
        doc.close()
    return n


_CACHE_BUDGET_BYTES = 400 * 1024 * 1024   # ~400 MB ceiling for rendered slides


def _prune_cache(budget=_CACHE_BUDGET_BYTES):
    """Keep the on-disk slide cache under a size budget by evicting the
    least-recently-used deck folders (the key includes mtime, so re-saving a
    deck orphans its old render — this is what reclaims that space)."""
    root = get_cache_dir() / 'slides'
    if not root.is_dir():
        return
    entries = []
    total = 0
    for d in root.iterdir():
        if not d.is_dir():
            continue
        try:
            size = sum(f.stat().st_size for f in d.iterdir() if f.is_file())
            mtime = d.stat().st_mtime
        except OSError:
            continue
        entries.append((mtime, size, d))
        total += size
    entries.sort()                                  # oldest first
    for _mtime, size, d in entries:
        if total <= budget:
            break
        shutil.rmtree(d, ignore_errors=True)
        total -= size


def render_slides(path: str):
    """Render a deck's slides to cached PNGs. Returns {'count': n, 'dir': str}
    or None (no LibreOffice / any failure → caller falls back to native)."""
    if not find_soffice():
        return None
    try:
        key = _cache_key(path)
    except OSError:
        return None
    cdir = get_cache_dir() / 'slides' / key
    done = cdir / 'done'
    if done.is_file():
        try:
            count = int(done.read_text())
            os.utime(cdir, None)                    # mark recently used (LRU)
            return {'count': count, 'dir': str(cdir)}
        except Exception:
            shutil.rmtree(cdir, ignore_errors=True)

    tmp = Path(tempfile.mkdtemp(prefix='yr_lo_pdf_'))
    try:
        pdf = _convert_to_pdf(path, str(tmp))
        if not pdf:
            return None
        n = _rasterize_pdf(str(pdf), cdir)
        if not n:
            shutil.rmtree(cdir, ignore_errors=True)
            return None
        done.write_text(str(n))
        try:
            _prune_cache()                          # keep total cache under budget
        except Exception:
            pass
        return {'count': n, 'dir': str(cdir)}
    except Exception as e:
        logger.warning('slide render failed for %s: %s', path, e)
        shutil.rmtree(cdir, ignore_errors=True)
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def slide_image_path(path: str, index: int, thumb: bool = False):
    """Filesystem path to a cached rendered slide image (1-based index), running
    the render on first request. None if unavailable."""
    info = render_slides(path)
    if not info or index < 1 or index > info['count']:
        return None
    name = ('thumb-%d.png' if thumb else 'slide-%d.png') % index
    p = Path(info['dir']) / name
    return str(p) if p.is_file() else None
