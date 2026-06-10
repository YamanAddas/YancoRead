"""
YancoRead — Comic reading-direction detection.

Decides whether a comic reads right-to-left (manga / Arabic / Hebrew) or
left-to-right.

  1. ComicInfo.xml  — the <Manga> / <LanguageISO> tags many releases embed.
  2. OCR (optional) — Tesseract OSD script detection on the first text-bearing
     pages. Arabic/Hebrew/Syriac/Thaana/N'Ko → RTL. Skipped gracefully if the
     Tesseract binary isn't installed.

Returns 'rtl' | 'ltr' | 'unknown' plus the source, cached per file.
"""

import logging
import os
import shutil
import threading
import xml.etree.ElementTree as ET
from collections import OrderedDict

logger = logging.getLogger('yancoread.comicdir')

_RTL_LANGS = {'ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv', 'ku', 'arc', 'syr'}
_RTL_SCRIPTS = {'Arabic', 'Hebrew', 'Syriac', 'Thaana', 'N\'Ko', 'Nko'}

_tesseract_ready = None  # tri-state: None=unchecked, True/False once probed


def tessdata_dir() -> str:
    """A user-writable tessdata folder (%APPDATA%/YancoRead/tessdata) holding
    extra languages (e.g. Arabic) — lets users add languages without admin."""
    try:
        from paths import get_data_dir
        d = get_data_dir() / 'tessdata'
        if d.is_dir() and any(d.glob('*.traineddata')):
            return str(d)
    except Exception:
        pass
    return ''


def ocr_config() -> str:
    """Point Tesseract at our user tessdata dir via the TESSDATA_PREFIX env var.
    (A --tessdata-dir config string is unreliable: pytesseract passes it literally,
    so quotes/spaces in the path break it.) Returns '' — callers still pass it as
    the config arg, but the real work is the env var set here."""
    dd = tessdata_dir()
    if dd:
        os.environ['TESSDATA_PREFIX'] = dd
    return ''


def tesseract_available() -> bool:
    """Locate the Tesseract binary (PATH or common Windows install dirs)."""
    global _tesseract_ready
    if _tesseract_ready is not None:
        return _tesseract_ready
    try:
        import pytesseract
    except ImportError:
        _tesseract_ready = False
        return False
    if shutil.which('tesseract'):
        _tesseract_ready = True
        return True
    candidates = [
        r'C:\Program Files\Tesseract-OCR\tesseract.exe',
        r'C:\Program Files (x86)\Tesseract-OCR\tesseract.exe',
        os.path.expandvars(r'%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe'),
        os.path.expandvars(r'%LOCALAPPDATA%\Tesseract-OCR\tesseract.exe'),
        '/usr/bin/tesseract', '/usr/local/bin/tesseract', '/opt/homebrew/bin/tesseract',
    ]
    for c in candidates:
        if os.path.isfile(c):
            pytesseract.pytesseract.tesseract_cmd = c
            _tesseract_ready = True
            return True
    _tesseract_ready = False
    return False


def _from_comicinfo(doc) -> str:
    raw = doc.read_meta('ComicInfo.xml')
    if not raw:
        return ''
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return ''

    def _text(tag):
        for el in root.iter():
            if el.tag.split('}')[-1].lower() == tag.lower() and el.text:
                return el.text.strip()
        return ''

    manga = _text('Manga').lower()
    if manga in ('yesandrighttoleft', 'yes'):
        return 'rtl'
    if manga == 'no':
        return 'ltr'
    lang = _text('LanguageISO').lower().split('-')[0]
    if lang:
        return 'rtl' if lang in _RTL_LANGS else 'ltr'
    return ''


def _from_ocr(doc, sample_pages=3) -> str:
    if not tesseract_available():
        return ''
    import pytesseract
    import cv2
    import numpy as np

    n = min(sample_pages, doc.page_count)
    for i in range(n):
        try:
            data, _ = doc.get_page(i)
            from renderers.cvsafe import safe_imdecode
            img = safe_imdecode(data, cv2.IMREAD_GRAYSCALE)
            if img is None:
                continue
            # downscale large pages for speed (clamp each axis to >=1px so an
            # extreme-aspect page, e.g. 3000x1, can't make a 0-width target that
            # cv2.resize asserts on)
            h, w = img.shape
            scale = min(1.0, 1400 / max(h, w))
            if scale < 1.0:
                img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))))
            osd = pytesseract.image_to_osd(img, output_type=pytesseract.Output.DICT,
                                           config=ocr_config())
            script = osd.get('script', '')
            if script:
                return 'rtl' if script in _RTL_SCRIPTS else 'ltr'
        except Exception as e:
            logger.debug("OCR osd failed on page %s: %s", i, e)
            continue
    return ''


# ── public + cache ────────────────────────────────────────────────────────────
_CACHE_MAX = 256
_cache: "OrderedDict[str, dict]" = OrderedDict()
_lock = threading.Lock()


def detect_direction(path: str, doc) -> dict:
    """Return {'direction': 'rtl'|'ltr'|'unknown', 'source': ...}, cached per file."""
    key = str(path)
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]

    direction, source = 'unknown', 'none'
    ci = _from_comicinfo(doc)
    if ci:
        direction, source = ci, 'comicinfo'
    else:
        ocr = _from_ocr(doc)
        if ocr:
            direction, source = ocr, 'ocr'

    result = {'direction': direction, 'source': source,
              'ocr_available': tesseract_available()}
    with _lock:
        _cache[key] = result
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return result
