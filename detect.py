"""
YancoRead — Format Router
Given a file path, decide its document *kind*. The kind selects both the
backend renderer and the frontend tool profile (the adaptive toolbar).

Detection is extension-first (fast, reliable for the formats we target) with a
magic-byte fallback for extension-less or mislabeled files.
"""

import logging
from pathlib import Path

from constants import (
    EXT_KIND, TEXT_EXTS,
    KIND_PDF, KIND_COMIC, KIND_EBOOK, KIND_OFFICE,
    KIND_TEXT, KIND_IMAGE, KIND_UNKNOWN,
)  # noqa: F401  (KIND_OFFICE used in _MAGIC below)

logger = logging.getLogger('yancoread.detect')

# Magic-byte signatures → kind (used only when the extension is unknown).
_MAGIC = [
    (b'%PDF',                        KIND_PDF),
    (b'{\\rtf',                      KIND_OFFICE),  # rich text
    (b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1', KIND_OFFICE),  # OLE2: legacy doc/xls/ppt
    (b'Rar!\x1a\x07',                KIND_COMIC),   # rar — assume comic archive
    (b'7z\xbc\xaf\x27\x1c',          KIND_COMIC),   # 7z  — assume comic archive
    (b'\x89PNG\r\n\x1a\n',           KIND_IMAGE),
    (b'\xff\xd8\xff',                KIND_IMAGE),    # jpeg
    (b'GIF87a',                      KIND_IMAGE),
    (b'GIF89a',                      KIND_IMAGE),
    (b'BM',                          KIND_IMAGE),    # bmp
]


def kind_for_ext(ext: str) -> str:
    """Return the document kind for a file extension (with leading dot)."""
    ext = ext.lower()
    if ext in EXT_KIND:
        return EXT_KIND[ext]
    if ext in TEXT_EXTS:
        return KIND_TEXT
    return KIND_UNKNOWN


def _looks_like_text(sample: bytes) -> bool:
    """Heuristic: is this byte sample plausibly a text file?"""
    if not sample:
        return True  # empty file — treat as (empty) text
    if b'\x00' in sample:
        return False  # NUL byte → binary
    # Decode as UTF-8; if it works and most chars are printable, call it text.
    try:
        text = sample.decode('utf-8')
    except UnicodeDecodeError:
        try:
            text = sample.decode('latin-1')
        except UnicodeDecodeError:
            return False
    printable = sum(1 for c in text if c.isprintable() or c in '\r\n\t\f\v')
    return printable / max(len(text), 1) > 0.85


def _sniff_magic(path: Path) -> str:
    """Read leading bytes and classify by signature, with a text fallback."""
    try:
        with path.open('rb') as fh:
            head = fh.read(2048)
    except OSError as e:
        logger.warning("Cannot read %s for sniffing: %s", path, e)
        return KIND_UNKNOWN

    # ZIP container: could be comic (cbz), epub, or office (docx/pptx/xlsx).
    # Without the extension we can't tell which, so default to comic only if it
    # clearly holds images — otherwise leave as unknown. Keep it simple here.
    for sig, kind in _MAGIC:
        if head.startswith(sig):
            return kind

    if _looks_like_text(head):
        return KIND_TEXT
    return KIND_UNKNOWN


def detect(path) -> dict:
    """
    Classify a file for opening.

    Returns a dict:
        {
          'path': str,         # absolute path
          'name': str,         # file name
          'ext': str,          # lowercase extension incl. dot ('' if none)
          'kind': str,         # one of constants.KIND_*
          'size': int,         # bytes (0 if unknown)
          'exists': bool,
        }
    """
    # A malformed local request can send a non-string path (JSON null/number/list);
    # Path() would raise TypeError. Treat anything non-str as a missing file.
    if not isinstance(path, str):
        return {'path': '', 'name': '', 'ext': '', 'kind': KIND_UNKNOWN,
                'size': 0, 'exists': False}
    p = Path(path)
    ext = p.suffix.lower()
    name = p.name

    # Files named purely by convention (Makefile, Dockerfile) → text.
    if not ext and name.lower() in {
        'makefile', 'dockerfile', 'cmakelists.txt', 'readme', 'license',
        '.gitignore', '.gitattributes', '.env',
    }:
        kind = KIND_TEXT
    else:
        kind = kind_for_ext(ext)

    exists = p.exists() and p.is_file()
    size = p.stat().st_size if exists else 0

    # Unknown extension → sniff the bytes.
    if kind == KIND_UNKNOWN and exists:
        kind = _sniff_magic(p)

    return {
        'path': str(p),
        'name': name,
        'ext': ext,
        'kind': kind,
        'size': size,
        'exists': exists,
    }
