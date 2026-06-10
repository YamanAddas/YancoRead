"""
YancoRead — Vintage scan enhancement (OpenCV).

Cleans up faded, yellowed, low-contrast comic scans on demand:
  1. White-balance / de-yellow  — stretch each channel so aged paper reads white
  2. CLAHE local contrast       — revive washed-out art
  3. Gentle edge-preserving denoise
  4. Unsharp mask               — crisp up soft scans

Returns PNG bytes. Cached per (path,index) so the work happens once.
"""

import logging
import threading

import cv2
import numpy as np

logger = logging.getLogger('yancoread.enhance')


def _process(img):
    result = img.astype(np.float32)
    # de-yellow: per-channel percentile stretch so bright paper → ~white
    for c in range(3):
        hi = np.percentile(result[:, :, c], 99)
        if hi > 1:
            result[:, :, c] = np.clip(result[:, :, c] * (245.0 / hi), 0, 255)
    img = result.astype(np.uint8)

    # local contrast on luminance
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(l)
    img = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)

    # edge-preserving denoise + unsharp
    img = cv2.bilateralFilter(img, 5, 40, 40)
    blur = cv2.GaussianBlur(img, (0, 0), 2.0)
    return cv2.addWeighted(img, 1.5, blur, -0.5, 0)


def enhance_bytes(data: bytes) -> bytes:
    from renderers.cvsafe import safe_imdecode
    img = safe_imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        return data
    ok, buf = cv2.imencode('.png', _process(img))
    return buf.tobytes() if ok else data


_cache = {}
_lock = threading.Lock()


def enhance_cached(key, data: bytes) -> bytes:
    with _lock:
        if key in _cache:
            return _cache[key]
    try:
        out = enhance_bytes(data)
    except Exception as e:
        logger.warning("enhance failed for %s: %s", key, e)
        out = data
    with _lock:
        if len(_cache) > 48:
            _cache.clear()
        _cache[key] = out
    return out
