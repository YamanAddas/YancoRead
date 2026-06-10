"""Bounded OpenCV image decode for the comic-vision pipeline.

A crafted comic page (e.g. a near-solid 30000x30000 PNG) compresses to a few KB
but decodes to gigabytes of pixels. ``cv2.imdecode`` has no pixel cap and the
archive byte-guards only bound the compressed member size, so the panel/enhance/
OCR/direction passes could OOM the single app process on a hostile page.

``safe_imdecode`` reads the image's declared dimensions from its header first
(via Pillow, which does not decode pixels) and refuses anything past a sane pixel
budget by returning ``None`` — exactly what ``cv2.imdecode`` returns on failure,
so every existing caller (which already handles ``None``) skips the page instead
of crashing.
"""

import io
import logging

import cv2
import numpy as np
from PIL import Image

logger = logging.getLogger('yancoread.cvsafe')

# 80 Mpx is generous for any real comic page (a 7016x9933 A4@600dpi scan is
# ~70 Mpx); a decompression bomb is far larger.
MAX_CV_PIXELS = 80 * 1_000_000


def safe_imdecode(data: bytes, flags=cv2.IMREAD_COLOR):
    """Decode image ``data`` with cv2 after rejecting pixel bombs by header size.

    Returns the decoded ndarray, or ``None`` if the bytes are empty, oversized, or
    not a decodable image (matching cv2.imdecode's None-on-failure contract)."""
    if not data:
        return None
    try:
        with Image.open(io.BytesIO(data)) as probe:
            w, h = probe.size
        if w * h > MAX_CV_PIXELS:
            logger.warning("refusing oversized image for cv2: %dx%d (%d Mpx)",
                           w, h, (w * h) // 1_000_000)
            return None
    except Exception:
        # Header not Pillow-readable (unusual format) — fall through and let cv2
        # try; cv2 returns None on its own failure.
        pass
    return cv2.imdecode(np.frombuffer(data, np.uint8), flags)
