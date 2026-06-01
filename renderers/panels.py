"""
YancoRead — Comic panel detection (heuristic, OpenCV).

Splits a comic page into panels for "Guided View". No ML model. Several
complementary strategies are tried and the better-scoring result wins:

  1. Gutter     — locate uniform low-variance gutter rows/columns.
  2. Threshold  — Otsu split of uniform (white/black) gutters from content,
                  tried at both polarities (light and dark backgrounds).
  3. Edges      — Canny edges → dilate/close → blobs; works on full-bleed art
                  and textured backgrounds where the gutters aren't uniform.
  4. Adaptive   — adaptive threshold for uneven scans/lighting.
  5. XY-cut     — recursive edge-density gap cutting (produces boxes directly).

Returns normalized boxes ({x,y,w,h} in 0..1) in reading order, or [] when no
strategy yields a confident layout (the reader then treats the page as one
panel).
"""

import logging
import threading
from collections import OrderedDict

import cv2
import numpy as np

logger = logging.getLogger('yancoread.panels')

_MIN_AREA_FRAC = 0.015
_MIN_W_FRAC = 0.07
_MIN_H_FRAC = 0.045
_MAX_PANELS = 24
_ROW_TOL_FRAC = 0.06
_MIN_SCORE = 0.18


# ── geometry helpers ──────────────────────────────────────────────────────────
def _inter_area(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    x = max(ax, bx); y = max(ay, by)
    x2 = min(ax + aw, bx + bw); y2 = min(ay + ah, by + bh)
    return max(0, x2 - x) * max(0, y2 - y)


def _contained(inner, outer, pad=2):
    ix, iy, iw, ih = inner
    ox, oy, ow, oh = outer
    return (ix >= ox - pad and iy >= oy - pad and
            ix + iw <= ox + ow + pad and iy + ih <= oy + oh + pad)


def _remove_nested(boxes):
    boxes = sorted(boxes, key=lambda b: b[2] * b[3], reverse=True)
    kept = []
    for b in boxes:
        if not any(_contained(b, k) for k in kept):
            kept.append(b)
    return kept


def _reading_order(boxes, rtl, H):
    row_tol = H * _ROW_TOL_FRAC
    rows = []
    for b in sorted(boxes, key=lambda b: b[1]):
        for row in rows:
            row_top = sum(bb[1] for bb in row) / len(row)
            if abs(b[1] - row_top) < row_tol:
                row.append(b)
                break
        else:
            rows.append([b])
    rows.sort(key=lambda r: min(bb[1] for bb in r))
    ordered = []
    for row in rows:
        row.sort(key=lambda b: b[0], reverse=rtl)
        ordered.extend(row)
    return ordered


def _boxes_from_mask(mask, W, H):
    """Connected blobs in a binary mask → filtered bounding boxes."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    page_area = float(W * H)
    boxes = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if w * h < _MIN_AREA_FRAC * page_area:
            continue
        if w < _MIN_W_FRAC * W or h < _MIN_H_FRAC * H:
            continue
        if w > 0.99 * W and h > 0.99 * H:
            continue
        boxes.append((x, y, w, h))
    return _remove_nested(boxes)


def _score(boxes, W, H):
    n = len(boxes)
    if n < 2 or n > _MAX_PANELS:
        return -1.0
    page = float(W * H)
    cover = sum(w * h for _, _, w, h in boxes) / page
    if cover < 0.30 or cover > 1.10:
        return -1.0
    overlap = 0.0
    for i in range(n):
        for j in range(i + 1, n):
            overlap += _inter_area(boxes[i], boxes[j])
    overlap_frac = overlap / page
    # reward coverage near ~0.82, punish overlaps and excessive panel counts
    return (1.0 - abs(cover - 0.82)) - overlap_frac * 2.0 - max(0, n - 10) * 0.04


# ── recursive XY-cut on edge density ──────────────────────────────────────────
# Gutters have (almost) no edges regardless of their COLOR, so cutting at low-edge
# bands separates panels that brightness-thresholding merges, and trims margins.
def _find_gap(empty, n, min_gap):
    """Widest interior run of True (empty lines), not touching the ends."""
    best = None
    i = 0
    while i < n:
        if empty[i]:
            j = i
            while j < n and empty[j]:
                j += 1
            if i > 0 and j < n and (j - i) >= min_gap:
                if best is None or (j - i) > (best[1] - best[0]):
                    best = (i, j)
            i = j
        else:
            i += 1
    return best


def _xycut(edges, x0, y0, x1, y1, out, min_dim, min_gap, depth):
    region = edges[y0:y1, x0:x1]
    rh, rw = region.shape
    if rh < min_dim or rw < min_dim:
        return
    rowc = (region > 0).sum(1)
    colc = (region > 0).sum(0)
    rfull = rowc > rw * 0.015
    cfull = colc > rh * 0.015
    if not rfull.any() or not cfull.any():
        return
    # trim margins to the content extent
    a = int(np.argmax(rfull)); b = rh - int(np.argmax(rfull[::-1]))
    c = int(np.argmax(cfull)); d = rw - int(np.argmax(cfull[::-1]))
    nx0, ny0, nx1, ny1 = x0 + c, y0 + a, x0 + d, y0 + b
    if (nx1 - nx0) < min_dim or (ny1 - ny0) < min_dim:
        return
    sub = edges[ny0:ny1, nx0:nx1]
    sh, sw = sub.shape
    row_empty = (sub > 0).sum(1) <= sw * 0.006
    col_empty = (sub > 0).sum(0) <= sh * 0.006
    if depth < 9:
        hgap = _find_gap(row_empty, sh, min_gap)   # horizontal gutter → split top/bottom
        vgap = _find_gap(col_empty, sw, min_gap)   # vertical gutter → split left/right
        hlen = (hgap[1] - hgap[0]) if hgap else 0
        vlen = (vgap[1] - vgap[0]) if vgap else 0
        if hlen or vlen:
            if hlen >= vlen:
                mid = ny0 + (hgap[0] + hgap[1]) // 2
                _xycut(edges, nx0, ny0, nx1, mid, out, min_dim, min_gap, depth + 1)
                _xycut(edges, nx0, mid, nx1, ny1, out, min_dim, min_gap, depth + 1)
            else:
                mid = nx0 + (vgap[0] + vgap[1]) // 2
                _xycut(edges, nx0, ny0, mid, ny1, out, min_dim, min_gap, depth + 1)
                _xycut(edges, mid, ny0, nx1, ny1, out, min_dim, min_gap, depth + 1)
            return
    out.append((nx0, ny0, nx1 - nx0, ny1 - ny0))


def _strategy_xycut(gray, W, H):
    edges = cv2.Canny(gray, 50, 150)
    k = max(2, int(min(W, H) * 0.004))
    edges = cv2.dilate(edges, np.ones((k, k), np.uint8))
    boxes = []
    _xycut(edges, 0, 0, W, H, boxes,
           min_dim=int(min(W, H) * 0.06),
           min_gap=max(8, int(min(W, H) * 0.014)), depth=0)
    page = float(W * H)
    out = [(x, y, w, h) for (x, y, w, h) in boxes
           if w * h >= _MIN_AREA_FRAC * page and w >= _MIN_W_FRAC * W and h >= _MIN_H_FRAC * H]
    return _remove_nested(out)


# ── strategies ────────────────────────────────────────────────────────────────
def _strategy_threshold(gray, bg_light):
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if bg_light:
        th = cv2.bitwise_not(th)
    H, W = gray.shape
    k = max(3, (int(min(H, W) * 0.012) | 1))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    return cv2.morphologyEx(th, cv2.MORPH_CLOSE, kernel, iterations=2)


def _fill_holes(mask):
    H, W = mask.shape
    flood = mask.copy()
    ff = np.zeros((H + 2, W + 2), np.uint8)
    cv2.floodFill(flood, ff, (0, 0), 255)
    return mask | cv2.bitwise_not(flood)


def _strategy_edges(gray):
    H, W = gray.shape
    edges = cv2.Canny(gray, 50, 150)
    k = max(3, (int(min(H, W) * 0.01) | 1))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    dil = cv2.dilate(edges, kernel, iterations=2)
    closed = cv2.morphologyEx(dil, cv2.MORPH_CLOSE, kernel, iterations=3)
    return _fill_holes(closed)


def _strategy_adaptive(gray):
    H, W = gray.shape
    th = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                               cv2.THRESH_BINARY_INV, 31, 8)
    k = max(3, (int(min(H, W) * 0.02) | 1))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    closed = cv2.morphologyEx(th, cv2.MORPH_CLOSE, kernel, iterations=3)
    return _fill_holes(closed)


def _strategy_gutter(gray):
    """Panels = islands left behind after removing the light gutter network that
    is connected to the page margin. Robust for bordered comics with thin gutters
    (where content-based thresholding merges the whole page into one blob)."""
    H, W = gray.shape
    _, light = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Force a light frame so the margin/gutter is seeded from the corner.
    light[0, :] = 255; light[H - 1, :] = 255
    light[:, 0] = 255; light[:, W - 1] = 255
    ff = light.copy()
    mask = np.zeros((H + 2, W + 2), np.uint8)
    cv2.floodFill(ff, mask, (0, 0), 128)          # flood the gutter network
    gutter = (ff == 128).astype(np.uint8) * 255
    panel = cv2.bitwise_not(gutter)               # non-gutter = panels
    # OPEN only: erodes thin bridges where content crosses a gutter (un-merges
    # adjacent panels). No CLOSE — closing bridges thin gutters and merges panels.
    k = max(3, (int(min(H, W) * 0.005) | 1))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    panel = cv2.morphologyEx(panel, cv2.MORPH_OPEN, kernel)
    return panel


def detect_panels(data: bytes, rtl: bool = False) -> list:
    arr = np.frombuffer(data, np.uint8)
    gray = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        return []
    H, W = gray.shape

    # Try both gutter polarities (don't rely on border sampling alone), plus
    # edge- and adaptive-threshold strategies; the best-scoring layout wins.
    masks = [
        _strategy_gutter(gray),
        _strategy_threshold(gray, True),
        _strategy_threshold(gray, False),
        _strategy_edges(gray),
        _strategy_adaptive(gray),
    ]
    candidates = [(_score(b, W, H), b)
                  for b in (_boxes_from_mask(m, W, H) for m in masks)]
    # XY-cut produces boxes directly (edge-density gutters); score it too.
    xy = _strategy_xycut(gray, W, H)
    candidates.append((_score(xy, W, H), xy))

    best_score, best = max(candidates, key=lambda c: c[0])
    if best_score < _MIN_SCORE or len(best) < 2:
        return []

    best = _reading_order(best, rtl, H)
    return [{'x': x / W, 'y': y / H, 'w': w / W, 'h': h / H} for (x, y, w, h) in best]


# ── cache ──────────────────────────────────────────────────────────────────────
_CACHE_MAX = 512
_cache: "OrderedDict[tuple, list]" = OrderedDict()
_lock = threading.Lock()


def get_panels(path: str, index: int, page_bytes: bytes, rtl: bool) -> list:
    key = (str(path), int(index), bool(rtl))
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    try:
        panels = detect_panels(page_bytes, rtl)
    except Exception as e:
        logger.warning("panel detection failed for %s p%s: %s", path, index, e)
        panels = []
    with _lock:
        _cache[key] = panels
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)
    return panels
