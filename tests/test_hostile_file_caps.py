"""Hostile-file decompression/decode caps added after the 2026-06-09 audit.

Each test crafts a payload in the OS temp dir (never the repo) that is tiny on
disk but would expand to gigabytes in memory, and asserts the guard refuses it
while a legitimate file of the same kind still works. If a guard were removed, the
matching reject test fails.
"""

import os
import shutil
import tempfile
import zipfile

import pytest


@pytest.fixture
def tmp_dir():
    d = tempfile.mkdtemp(prefix="yr_hostile_test_")
    try:
        yield d
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ── eBook (epub/xps/oxps) decompression bomb ────────────────────────────────

def test_ebook_markup_bomb_rejected(tmp_dir):
    from renderers.fitzdoc import _guard_ebook_bomb
    bomb = os.path.join(tmp_dir, "bomb.epub")
    big = "<p>" + ("A" * 200) + "</p>\n"
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("content.xhtml", "<html><body>" + big * 600_000 + "</body></html>")
    assert os.path.getsize(bomb) < 2 * 1024 * 1024     # tiny on disk
    with pytest.raises(ValueError, match="unsafe size|decompression"):
        _guard_ebook_bomb(bomb)


def test_ebook_single_huge_entry_rejected(tmp_dir):
    from renderers.fitzdoc import _guard_ebook_bomb
    from constants import MAX_ARCHIVE_ENTRY_BYTES
    bomb = os.path.join(tmp_dir, "huge.epub")
    # One entry declaring > the per-entry cap (zeros compress to ~nothing).
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("big.bin", b"\0" * (MAX_ARCHIVE_ENTRY_BYTES + 1))
    with pytest.raises(ValueError):
        _guard_ebook_bomb(bomb)


def test_ebook_guard_noop_on_non_zip(tmp_dir):
    # A PDF (or any non-ZIP) must pass the guard untouched — no false positive.
    import fitz
    from renderers.fitzdoc import _guard_ebook_bomb
    pdf = os.path.join(tmp_dir, "ok.pdf")
    d = fitz.open(); d.new_page(); d.save(pdf); d.close()
    _guard_ebook_bomb(pdf)   # must not raise


def test_legit_epub_still_opens(tmp_dir):
    from renderers.fitzdoc import FitzDoc
    epub = os.path.join(tmp_dir, "ok.epub")
    with zipfile.ZipFile(epub, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml",
                   '<?xml version="1.0"?><container version="1.0" '
                   'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                   '<rootfiles><rootfile full-path="content.opf" '
                   'media-type="application/oebps-package+xml"/></rootfiles></container>')
        z.writestr("content.opf",
                   '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" '
                   'version="2.0" unique-identifier="id"><metadata '
                   'xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title>'
                   '<dc:identifier id="id">x</dc:identifier></metadata><manifest>'
                   '<item id="c" href="c.xhtml" media-type="application/xhtml+xml"/>'
                   '</manifest><spine><itemref idref="c"/></spine></package>')
        z.writestr("c.xhtml",
                   '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">'
                   '<body><h1>Hello</h1><p>A real little book.</p></body></html>')
    doc = FitzDoc(epub)
    try:
        assert doc.page_count >= 1
    finally:
        doc.close()


# ── xlsx cell-graph bomb ────────────────────────────────────────────────────

def test_xlsx_cell_xml_bomb_rejected(tmp_dir):
    from renderers.officedoc import _guard_xlsx_bomb, _MAX_XLSX_CELL_XML_BYTES
    bomb = os.path.join(tmp_dir, "bomb.xlsx")
    cell = "<row><c><v>1</v></c></row>"
    n = (_MAX_XLSX_CELL_XML_BYTES // len(cell)) + 50_000
    sheet = "<worksheet><sheetData>" + cell * n + "</sheetData></worksheet>"
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/worksheets/sheet1.xml", sheet)
    assert os.path.getsize(bomb) < 5 * 1024 * 1024
    with pytest.raises(ValueError, match="extremely large|decompression"):
        _guard_xlsx_bomb(bomb)


def test_xlsx_sharedstrings_bomb_rejected(tmp_dir):
    from renderers.officedoc import _guard_xlsx_bomb, _MAX_XLSX_CELL_XML_BYTES
    bomb = os.path.join(tmp_dir, "ss.xlsx")
    blob = "<si><t>" + ("Z" * 5000) + "</t></si>"
    n = (_MAX_XLSX_CELL_XML_BYTES // len(blob)) + 5_000
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("xl/sharedStrings.xml", "<sst>" + blob * n + "</sst>")
    with pytest.raises(ValueError):
        _guard_xlsx_bomb(bomb)


def test_legit_xlsx_passes_guard(tmp_dir):
    from openpyxl import Workbook
    from renderers.officedoc import _guard_xlsx_bomb, _xlsx_to_html
    ok = os.path.join(tmp_dir, "ok.xlsx")
    wb = Workbook()
    ws = wb.active
    ws.append(["Name", "Qty", "Price"])
    for i in range(200):
        ws.append([f"Item {i}", i, i * 1.5])
    wb.save(ok)
    _guard_xlsx_bomb(ok)                  # must not raise
    res = _xlsx_to_html(ok)               # full render works
    assert res["sheets"] and res["sheets"][0]["rows"] >= 1


# ── PIL image decompression bomb ────────────────────────────────────────────

@pytest.mark.filterwarnings('ignore::PIL.Image.DecompressionBombWarning')
def test_image_pixel_bomb_rejected(tmp_dir):
    from PIL import Image
    from renderers.imagedoc import thumbnail_png, _MAX_IMAGE_PIXELS
    bomb = os.path.join(tmp_dir, "bomb.png")
    side = int((_MAX_IMAGE_PIXELS ** 0.5)) + 2000
    Image.new("L", (side, side), 0).save(bomb)
    assert os.path.getsize(bomb) < 5 * 1024 * 1024   # near-solid -> tiny on disk
    with pytest.raises(ValueError, match="extremely large|decompression"):
        thumbnail_png(bomb)


def test_normal_image_thumbnails(tmp_dir):
    from PIL import Image
    from renderers.imagedoc import thumbnail_png
    ok = os.path.join(tmp_dir, "ok.png")
    Image.new("RGB", (800, 600), (10, 20, 30)).save(ok)
    out = thumbnail_png(ok)
    assert out[:8] == b"\x89PNG\r\n\x1a\n"            # valid PNG bytes back


# ── OpenCV decode bomb ──────────────────────────────────────────────────────

@pytest.mark.filterwarnings('ignore::PIL.Image.DecompressionBombWarning')
def test_cv_imdecode_bomb_returns_none():
    import cv2
    import numpy as np
    from renderers.cvsafe import safe_imdecode, MAX_CV_PIXELS
    side = int((MAX_CV_PIXELS ** 0.5)) + 1000
    ok, buf = cv2.imencode(".png", np.zeros((side, side), np.uint8))
    assert ok
    assert safe_imdecode(buf.tobytes(), cv2.IMREAD_GRAYSCALE) is None


def test_cv_imdecode_small_ok_and_garbage_none():
    import cv2
    import numpy as np
    from renderers.cvsafe import safe_imdecode
    ok, buf = cv2.imencode(".png", np.zeros((120, 90), np.uint8))
    img = safe_imdecode(buf.tobytes(), cv2.IMREAD_GRAYSCALE)
    assert img is not None and img.shape == (120, 90)
    assert safe_imdecode(b"not an image") is None
    assert safe_imdecode(b"") is None
