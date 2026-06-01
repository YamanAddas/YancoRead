"""Verify OCR-based reading-direction detection now that Tesseract is installed."""
import io
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402
from renderers import comicdir  # noqa: E402
from renderers.comicdoc import ComicDoc  # noqa: E402

samples = Path(__file__).parent / 'samples'
samples.mkdir(parents=True, exist_ok=True)

print('tesseract_available:', comicdir.tesseract_available())


def text_page(lines, size=54, font='arial.ttf'):
    W, H = 1100, 1500
    im = Image.new('RGB', (W, H), (255, 255, 255))
    d = ImageDraw.Draw(im)
    try:
        f = ImageFont.truetype(font, size)
    except Exception:
        f = ImageFont.load_default()
    y = 90
    for ln in lines:
        d.text((90, y), ln, fill=(10, 10, 10), font=f)
        y += size + 36
    buf = io.BytesIO(); im.save(buf, 'PNG'); return buf.getvalue()


def make_cbz(name, page_bytes):
    p = samples / name
    with zipfile.ZipFile(p, 'w') as z:
        for i in range(2):
            z.writestr(f'{i:02}.png', page_bytes)
    return p


def detect(name, page_bytes):
    p = make_cbz(name, page_bytes)
    comicdir._cache.clear()
    return comicdir.detect_direction(str(p), ComicDoc(str(p)))


en = detect('ocr-en.cbz', text_page([
    'The quick brown fox jumps',
    'over the lazy dog. Reading',
    'from left to right here.',
    'Hello world, testing OCR now.',
]))
print('English  ->', en)

ar = detect('ocr-ar.cbz', text_page([
    'مرحبا بالعالم هذا اختبار',
    'للقراءة من اليمين الى اليسار',
    'كتاب عربي جميل ورائع جدا',
    'نقرأ من اليمين الى اليسار',
]))
print('Arabic   ->', ar)

print('\nResult: English direction =', en.get('direction'),
      '| Arabic direction =', ar.get('direction'))
