"""Validate reading-direction detection + panel detection after the rewrite."""
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from renderers import comicdir, panels  # noqa: E402
from renderers.comicdoc import ComicDoc  # noqa: E402

tmp = Path(__file__).parent / 'samples'
tmp.mkdir(parents=True, exist_ok=True)
results = []


def check(label, cond, extra=''):
    results.append(cond)
    print(('  [ OK ]' if cond else '  [FAIL]') + f' {label}' + (f' — {extra}' if extra else ''))


def blank_page(c=200):
    img = np.full((300, 200, 3), c, np.uint8)
    return cv2.imencode('.png', img)[1].tobytes()


def make_cbz(name, comicinfo=None):
    p = tmp / name
    with zipfile.ZipFile(p, 'w') as z:
        if comicinfo:
            z.writestr('ComicInfo.xml', comicinfo)
        for i in range(2):
            z.writestr(f'{i:02}.png', blank_page())
    return p


# 1. ComicInfo Manga=YesAndRightToLeft → rtl
p = make_cbz('dir-manga.cbz', '<?xml version="1.0"?><ComicInfo><Manga>YesAndRightToLeft</Manga></ComicInfo>')
r = comicdir.detect_direction(str(p), ComicDoc(str(p)))
check('Manga=YesAndRightToLeft → rtl', r['direction'] == 'rtl' and r['source'] == 'comicinfo', str(r))

# 2. LanguageISO=ar → rtl
p = make_cbz('dir-ar.cbz', '<?xml version="1.0"?><ComicInfo><LanguageISO>ar</LanguageISO></ComicInfo>')
r = comicdir.detect_direction(str(p), ComicDoc(str(p)))
check('LanguageISO=ar → rtl', r['direction'] == 'rtl', str(r))

# 3. Manga=No → ltr
p = make_cbz('dir-en.cbz', '<?xml version="1.0"?><ComicInfo><Manga>No</Manga><LanguageISO>en</LanguageISO></ComicInfo>')
r = comicdir.detect_direction(str(p), ComicDoc(str(p)))
check('Manga=No → ltr', r['direction'] == 'ltr', str(r))

# 4. No metadata, no tesseract → unknown (graceful)
p = make_cbz('dir-none.cbz')
r = comicdir.detect_direction(str(p), ComicDoc(str(p)))
check('no metadata → unknown (OCR skipped gracefully)', r['direction'] == 'unknown', str(r))
print('     tesseract available:', comicdir.tesseract_available())

# 5. Panel detection still works on the multi-panel sample
cbz = tmp / 'sample-panels.cbz'
if cbz.exists():
    expected = [4, 3, 3]
    with zipfile.ZipFile(cbz) as z:
        for i, n in enumerate(sorted(z.namelist())):
            boxes = panels.detect_panels(z.read(n), rtl=False)
            check(f'panels page {i} (want {expected[i]})', len(boxes) == expected[i], f'{len(boxes)} found')

print('\n' + ('ALL PASSED' if all(results) else f'{results.count(False)} FAILED') +
      f'  ({results.count(True)}/{len(results)})')
sys.exit(0 if all(results) else 1)
