import zipfile

from renderers import comicdir, panels
from renderers.comicdoc import ComicDoc


def _first_page(path):
    with zipfile.ZipFile(path) as z:
        return z.read(sorted(z.namelist())[0])


def test_panels_grid_ltr(samples):
    boxes = panels.detect_panels(_first_page(samples['cbz_panels']), rtl=False)
    assert len(boxes) == 4
    assert boxes[0]['x'] < 0.3 and boxes[0]['y'] < 0.3  # reading order: top-left first


def test_panels_grid_rtl(samples):
    boxes = panels.detect_panels(_first_page(samples['cbz_panels']), rtl=True)
    assert len(boxes) == 4
    assert boxes[0]['x'] > 0.4  # manga: first panel is top-right


def test_panels_solid_page_fallback(samples):
    # ComicInfo.xml is skipped; the solid color page has no panels
    boxes = panels.detect_panels(_first_page(samples['cbz']), rtl=False)
    assert boxes == []


def test_direction_from_comicinfo(samples):
    comicdir._cache.clear()
    doc = ComicDoc(str(samples['cbz_manga']))
    r = comicdir.detect_direction(str(samples['cbz_manga']), doc)
    assert r['direction'] == 'rtl' and r['source'] == 'comicinfo'
