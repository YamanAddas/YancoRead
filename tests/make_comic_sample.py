"""Build a multi-panel sample comic (CBZ) and validate panel detection.

    venv\\Scripts\\python.exe tests\\make_comic_sample.py
"""
import sys
import zipfile
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from renderers import panels  # noqa: E402

out = Path(__file__).parent / 'samples'
out.mkdir(parents=True, exist_ok=True)

W, H = 900, 1300
GUT = 26  # gutter width


def page(layout):
    """layout: list of (x0,y0,x1,y1) panel rects in fractions of the page."""
    img = np.full((H, W, 3), 250, np.uint8)  # near-white page
    colors = [(60, 120, 200), (200, 120, 60), (90, 180, 110), (170, 90, 180),
              (200, 180, 70), (120, 120, 120)]
    for i, (x0, y0, x1, y1) in enumerate(layout):
        a = (int(x0 * W) + GUT, int(y0 * H) + GUT)
        b = (int(x1 * W) - GUT, int(y1 * H) - GUT)
        cv2.rectangle(img, a, b, colors[i % len(colors)], -1)
        cv2.rectangle(img, a, b, (20, 20, 20), 5)  # black panel border
        cv2.putText(img, str(i + 1), (a[0] + 18, a[1] + 60),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 4)
    return cv2.imencode('.png', img)[1].tobytes()


layouts = [
    # 2x2 grid
    [(0, 0, .5, .5), (.5, 0, 1, .5), (0, .5, .5, 1), (.5, .5, 1, 1)],
    # top wide, two below
    [(0, 0, 1, .45), (0, .45, .5, 1), (.5, .45, 1, 1)],
    # three stacked rows
    [(0, 0, 1, .34), (0, .34, 1, .67), (0, .67, 1, 1)],
]

cbz = out / 'sample-panels.cbz'
with zipfile.ZipFile(cbz, 'w') as z:
    for i, lay in enumerate(layouts):
        z.writestr(f'page{i:02}.png', page(lay))
print('Wrote', cbz)

# validate detection (LTR)
print('\nPanel detection (LTR):')
ok = True
expected = [4, 3, 3]
with zipfile.ZipFile(cbz) as z:
    for i, name in enumerate(sorted(z.namelist())):
        boxes = panels.detect_panels(z.read(name), rtl=False)
        order = [(round(b['x'], 2), round(b['y'], 2)) for b in boxes]
        good = len(boxes) == expected[i]
        ok = ok and good
        print(f"  page {i}: {len(boxes)} panels (want {expected[i]}) "
              f"{'OK' if good else 'FAIL'}  order(x,y)={order}")

# RTL ordering check on the 2x2 page (panel 1 should be top-right)
with zipfile.ZipFile(cbz) as z:
    boxes = panels.detect_panels(z.read(sorted(z.namelist())[0]), rtl=True)
    first = boxes[0] if boxes else {}
    rtl_ok = bool(boxes) and first.get('x', 0) > 0.4
    print(f"\nRTL 2x2: first panel x={round(first.get('x', -1), 2)} "
          f"(want >0.4, i.e. right side) {'OK' if rtl_ok else 'FAIL'}")

print('\n' + ('DETECTION OK' if ok and rtl_ok else 'DETECTION ISSUES'))
sys.exit(0 if ok and rtl_ok else 1)
