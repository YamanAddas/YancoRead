"""
YancoRead — RAR/CBR extractor discovery.

`rarfile` is a pure-Python *wrapper*: it shells out to an external tool to do
the actual decompression. On a clean machine none of those tools may be on
PATH, so a bundled .cbr silently fails. This module points rarfile at the best
extractor we can find, probing in priority order:

    1. A binary we ship next to the app   (assets/tools/)
    2. 7-Zip / unrar / unar on PATH
    3. Well-known install locations (7-Zip, WinRAR)
    4. Windows 10+ system tar.exe          (libarchive / bsdtar — reads RAR)

bsdtar (shipped in C:\\Windows\\System32\\tar.exe since Win10 1803) is the
universal zero-install fallback: it is libarchive and decodes RAR happily, so
CBR works out of the box on any modern Windows box even with nothing bundled.

Call configure() once at startup; it is idempotent and never raises.
"""

import logging
import os
import shutil
import sys
from pathlib import Path

logger = logging.getLogger('yancoread.rartools')

_configured = False
_available = False


def _app_dir() -> Path:
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent.parent


def _bundled_tools_dir() -> Path:
    return _app_dir() / 'assets' / 'tools'


def _exe(name: str) -> str:
    return name + '.exe' if sys.platform == 'win32' else name


def _first_existing(candidates) -> str | None:
    for c in candidates:
        if not c:
            continue
        p = Path(c)
        if p.is_file():
            return str(p)
    return None


def _find_on_path(*names) -> str | None:
    for n in names:
        found = shutil.which(n)
        if found:
            return found
    return None


def configure() -> bool:
    """Point rarfile at the best available extractor. Returns True if one was found."""
    global _configured, _available
    if _configured:
        return _available
    _configured = True

    try:
        import rarfile
    except Exception as e:
        logger.warning("rarfile import failed: %s", e)
        return False

    tools = _bundled_tools_dir()

    # 1+2+3: prefer unrar / 7z, falling back to bsdtar.
    unrar = (
        _first_existing([tools / _exe('unrar'), tools / _exe('UnRAR')])
        or _find_on_path('unrar', 'UnRAR')
        or _first_existing([
            r'C:\Program Files\WinRAR\UnRAR.exe',
            r'C:\Program Files (x86)\WinRAR\UnRAR.exe',
        ])
    )
    sevenzip = (
        _first_existing([tools / _exe('7z'), tools / _exe('7za')])
        or _find_on_path('7z', '7za', '7zz')
        or _first_existing([
            r'C:\Program Files\7-Zip\7z.exe',
            r'C:\Program Files (x86)\7-Zip\7z.exe',
        ])
    )
    unar = (
        _first_existing([tools / _exe('unar')])
        or _find_on_path('unar')
    )
    # 4: universal Win10+ fallback — libarchive bsdtar reads RAR.
    bsdtar = (
        _first_existing([tools / _exe('bsdtar')])
        or _find_on_path('bsdtar')
        or _first_existing([os.path.join(os.environ.get('SystemRoot', r'C:\Windows'),
                                         'System32', 'tar.exe')])
        or _find_on_path('tar')
    )

    if unrar:
        rarfile.UNRAR_TOOL = unrar
    if sevenzip:
        rarfile.SEVENZIP_TOOL = sevenzip
    if unar:
        rarfile.UNAR_TOOL = unar
    if bsdtar:
        rarfile.BSDTAR_TOOL = bsdtar

    _available = bool(unrar or sevenzip or unar or bsdtar)
    if _available:
        logger.info("rar extractors: unrar=%s 7z=%s unar=%s bsdtar=%s",
                    unrar, sevenzip, unar, bsdtar)
    else:
        logger.warning("No RAR extractor found — .cbr files will not open. "
                       "Install 7-Zip or WinRAR, or run on Windows 10+ (tar.exe).")
    return _available


def have_extractor() -> bool:
    """True if a usable RAR extractor was located (configures lazily)."""
    return configure()
