"""
YancoRead — OCR text-region extraction.

Uses Tesseract's layout analysis (image_to_data) to pull text + bounding boxes,
grouped into blocks (≈ speech balloons / captions). Robust regardless of balloon
shape — and gives the actual text needed for translation / read-aloud.

Returns [{box:{x,y,w,h} normalized, text}] in reading order (top→bottom).
"""

import logging
import threading
from collections import OrderedDict

import cv2
import numpy as np

logger = logging.getLogger('yancoread.textregions')


def _reading_order(blocks: list, rtl: bool) -> list:
    """Order blocks top→bottom by row; within a row left→right (or right→left for RTL)."""
    if not blocks:
        return blocks
    row_tol = 0.04  # normalized y tolerance for "same row"
    rows = []
    for b in sorted(blocks, key=lambda b: b['box']['y']):
        for row in rows:
            top = sum(x['box']['y'] for x in row) / len(row)
            if abs(b['box']['y'] - top) < row_tol:
                row.append(b)
                break
        else:
            rows.append([b])
    rows.sort(key=lambda r: min(x['box']['y'] for x in r))
    out = []
    for row in rows:
        row.sort(key=lambda b: b['box']['x'], reverse=rtl)
        out.extend(row)
    return out


def ocr_blocks(data: bytes, lang: str = 'eng', rtl: bool = False, min_conf: int = 35) -> list:
    import pytesseract
    from pytesseract import Output
    from renderers.comicdir import ocr_config
    from renderers.cvsafe import safe_imdecode

    img = safe_imdecode(data, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return []
    H, W = img.shape
    # upscale small scans — Tesseract likes ~300dpi-ish text height
    scale = 1.0
    if max(H, W) < 1600:
        scale = 1600.0 / max(H, W)
        img = cv2.resize(img, (int(W * scale), int(H * scale)))
    sh, sw = img.shape

    d = pytesseract.image_to_data(img, lang=lang, output_type=Output.DICT, config=ocr_config())
    blocks = {}
    n = len(d['text'])
    for i in range(n):
        txt = (d['text'][i] or '').strip()
        if not txt:
            continue
        try:
            conf = float(d['conf'][i])
        except (ValueError, TypeError):
            conf = -1
        if conf < min_conf:
            continue
        key = (d['block_num'][i], d['par_num'][i])
        b = blocks.setdefault(key, {'x0': 1e9, 'y0': 1e9, 'x1': 0, 'y1': 0, 'words': []})
        x, y, w, h = d['left'][i], d['top'][i], d['width'][i], d['height'][i]
        b['x0'] = min(b['x0'], x); b['y0'] = min(b['y0'], y)
        b['x1'] = max(b['x1'], x + w); b['y1'] = max(b['y1'], y + h)
        b['words'].append(txt)

    out = []
    for b in blocks.values():
        text = ' '.join(b['words']).strip()
        if len(text) < 2:
            continue
        out.append({
            'box': {'x': b['x0'] / sw, 'y': b['y0'] / sh,
                    'w': (b['x1'] - b['x0']) / sw, 'h': (b['y1'] - b['y0']) / sh},
            'text': text,
        })
    return _reading_order(out, rtl)


_CACHE_MAX = 256
_cache: "OrderedDict[tuple, list]" = OrderedDict()
_lock = threading.Lock()


def get_blocks(path: str, index: int, page_bytes: bytes, lang: str, rtl: bool = False) -> list:
    key = (str(path), int(index), lang, bool(rtl))
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    try:
        b = ocr_blocks(page_bytes, lang, rtl)
    except Exception as e:
        logger.warning("OCR blocks failed for %s p%s: %s", path, index, e)
        b = []
    with _lock:
        _cache[key] = b
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return b
