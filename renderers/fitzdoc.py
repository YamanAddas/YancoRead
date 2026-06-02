"""
YancoRead — PyMuPDF (fitz) renderer.

Powers PDF *and* eBook kinds (epub / fb2 / xps / oxps / mobi). fitz opens all
of them; reflowable formats (epub/fb2/mobi) additionally support re-layout at a
chosen font size, which drives the eBook font-size tool.

A small LRU cache keeps documents open between page requests (Flask calls
render_page() once per page). Documents are reopened automatically if the file
changes on disk.
"""

import json
import logging
import re
import threading
import xml.etree.ElementTree as ET
from collections import OrderedDict
from pathlib import Path
from xml.sax.saxutils import escape as _xml_escape

import fitz  # PyMuPDF

from constants import MAX_RENDER_ZOOM

logger = logging.getLogger('yancoread.fitzdoc')

# Default page geometry used when laying out reflowable eBooks.
_REFLOW_W = 720
_REFLOW_H = 1000


def _human_size(n: int) -> str:
    f = float(n)
    for unit in ('B', 'KB', 'MB', 'GB'):
        if f < 1024 or unit == 'GB':
            return f'{int(f)} {unit}' if unit == 'B' else f'{f:.1f} {unit}'
        f /= 1024
    return f'{f:.1f} GB'


def _fmt_pdf_date(raw) -> str:
    """PDF date 'D:YYYYMMDDHHmmSS+HH'mm'' → 'YYYY-MM-DD HH:MM' (best-effort)."""
    if not raw:
        return ''
    s = str(raw).strip()
    if s.startswith('D:'):
        s = s[2:]
    digits = ''
    for ch in s:
        if ch.isdigit():
            digits += ch
        else:
            break
    if len(digits) < 8:
        return ''
    out = f'{digits[0:4]}-{digits[4:6]}-{digits[6:8]}'
    if len(digits) >= 12:
        out += f' {digits[8:10]}:{digits[10:12]}'
    return out


def _rgb(v):
    """Normalize a color spec → (r, g, b) floats in 0..1, or None.
    Accepts [r, g, b] in 0..1 or 0..255, or a '#rrggbb' string."""
    if v is None:
        return None
    if isinstance(v, str):
        s = v.strip().lstrip('#')
        if len(s) == 6:
            try:
                return tuple(int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))
            except ValueError:
                return None
        return None
    try:
        r, g, b = float(v[0]), float(v[1]), float(v[2])
    except (TypeError, ValueError, IndexError):
        return None
    if max(r, g, b) > 1.0:
        r, g, b = r / 255, g / 255, b / 255
    return (max(0.0, min(1.0, r)), max(0.0, min(1.0, g)), max(0.0, min(1.0, b)))


# ── annotation export / import (v2-5c) ───────────────────────────────────────
# The inverse of add_annotation's kind table: the subtype PyMuPDF reports via
# annot.type[1] → our input kind. Drives faithful export/import. Kinds absent
# here (Popup/Widget/Link/Redact/Stamp/Polygon…) are simply skipped.
SUBTYPE_TO_KIND = {
    'Highlight': 'highlight', 'Underline': 'underline', 'StrikeOut': 'strikeout',
    'Squiggly': 'squiggly', 'Square': 'rect', 'Circle': 'oval', 'Line': 'line',
    'Ink': 'ink', 'Text': 'note', 'FreeText': 'freetext',
}
# our kind → Adobe XFDF element name (all lowercase in the XFDF schema).
_KIND_TO_XFDF = {
    'highlight': 'highlight', 'underline': 'underline', 'strikeout': 'strikeout',
    'squiggly': 'squiggly', 'rect': 'square', 'oval': 'circle', 'line': 'line',
    'ink': 'ink', 'note': 'text', 'freetext': 'freetext',
}
_XFDF_TO_KIND = {v: k for k, v in _KIND_TO_XFDF.items()}


def _hexcolor(c):
    """(r,g,b) floats 0..1 → '#rrggbb', or None."""
    if not c:
        return None
    try:
        return '#' + ''.join('%02x' % max(0, min(255, round(float(x) * 255))) for x in c[:3])
    except (TypeError, ValueError):
        return None


def _parse_nums(s):
    """Parse a comma/space/semicolon-separated number list (XFDF rect/coords/
    gesture) → list of floats, rounded. Bad tokens are dropped."""
    if not s:
        return []
    out = []
    for tok in re.split(r'[,;\s]+', str(s).strip()):
        if tok:
            try:
                out.append(round(float(tok), 2))
            except ValueError:
                pass
    return out


def _quads_to_rects(verts):
    """Text-markup quadpoints (a flat point list, 4 per marked span) → bounding
    rects [x0,y0,x1,y1] — the geometry add_annotation re-consumes for markup."""
    if not verts:
        return []
    rects = []
    for i in range(0, len(verts) - 3, 4):
        quad = verts[i:i + 4]
        xs = [float(p[0]) for p in quad]
        ys = [float(p[1]) for p in quad]
        rects.append([round(min(xs), 2), round(min(ys), 2),
                      round(max(xs), 2), round(max(ys), 2)])
    return rects


class FitzDoc:
    """Wraps a single fitz.Document with the operations the UI needs."""

    def __init__(self, path: str):
        self.path = str(path)
        # PyMuPDF is NOT thread-safe across operations on the same Document.
        # Flask serves pages concurrently (lazy-load fires several /api/page
        # requests in parallel), so every access to self.doc is serialized
        # through this per-document lock. Re-entrant so render helpers can call
        # one another.
        self._lock = threading.RLock()
        self.doc = fitz.open(self.path)
        # Password-protected / encrypted files open fine here but yield no pages
        # until authenticate() succeeds. NOTE: in this PyMuPDF build needs_pass
        # stays truthy even AFTER a successful authenticate, so we track the live
        # lock state in our own attribute (cleared by unlock()) and never re-read
        # needs_pass for that purpose.
        self.locked = bool(self.doc.needs_pass)
        # True once a password has been accepted this session. Protects the
        # in-memory authenticated doc from LRU eviction (which would re-lock it)
        # and from being silently reopened from disk.
        self.authenticated = False
        # is_reflowable is safe to read while locked, but layout() must NOT run on
        # a locked doc — defer reflow setup until after a successful unlock().
        self.reflowable = (not self.locked) and bool(self.doc.is_reflowable)
        self._fontsize = 11
        # True once an editing op mutates self.doc; gates save() and protects the
        # in-memory doc from being reopened or LRU-evicted before the user saves.
        self.dirty = False
        if self.reflowable:
            self.doc.layout(width=_REFLOW_W, height=_REFLOW_H, fontsize=self._fontsize)

    # ── info ────────────────────────────────────────────────────────────────
    @property
    def page_count(self) -> int:
        return self.doc.page_count

    def info(self) -> dict:
        with self._lock:
            meta = self.doc.metadata or {}
            return {
                'page_count': self.doc.page_count,
                'reflowable': self.reflowable,
                'title': meta.get('title') or '',
                'author': meta.get('author') or '',
                'fontsize': self._fontsize,
                'locked': self.locked,
            }

    def properties(self) -> dict:
        """Rich document metadata for the Info panel: title/author/subject/
        keywords/creator/producer, formatted dates, PDF version, encryption,
        page count and first-page size in points. Defensive throughout."""
        import os
        with self._lock:
            meta = dict(self.doc.metadata or {})
            try:
                rect = self.doc.load_page(0).rect
                page_w, page_h = round(rect.width, 1), round(rect.height, 1)
            except Exception:
                page_w = page_h = 0
            try:
                encrypted = bool(self.doc.is_encrypted)
            except Exception:
                encrypted = False
            page_count = self.doc.page_count
        try:
            size_bytes = os.path.getsize(self.path)
        except OSError:
            size_bytes = 0
        return {
            'title': meta.get('title') or '',
            'author': meta.get('author') or '',
            'subject': meta.get('subject') or '',
            'keywords': meta.get('keywords') or '',
            'creator': meta.get('creator') or '',
            'producer': meta.get('producer') or '',
            'format': meta.get('format') or '',           # e.g. 'PDF 1.7'
            'created': _fmt_pdf_date(meta.get('creationDate')),
            'modified': _fmt_pdf_date(meta.get('modDate')),
            'encrypted': encrypted,
            'reflowable': self.reflowable,
            'page_count': page_count,
            'page_width': page_w,
            'page_height': page_h,
            'size_bytes': size_bytes,
            'size_human': _human_size(size_bytes),
        }

    def unlock(self, password: str) -> bool:
        """Authenticate a password-protected document so its pages can be read.

        Returns True on success (a user OR owner password is accepted), False on
        a wrong password. The password is used only for this call — it is never
        stored, cached, or logged.
        """
        with self._lock:
            if not self.locked:
                return True  # already open — nothing to do
            try:
                rc = self.doc.authenticate(password or '')
            except Exception as e:
                # Never include the password in diagnostics.
                logger.debug("authenticate failed to run for %s: %s", self.path, e)
                rc = 0
            if not rc:
                return False
            # rc > 0 → success (1 = no password needed, 2 = user, 4 = owner,
            # 6 = both). Pages and metadata are now readable for the life of this
            # cached instance.
            self.locked = False
            self.authenticated = True
            # Content is decrypted now: a reflowable eBook needs its initial
            # layout, which we deferred while locked.
            try:
                self.reflowable = bool(self.doc.is_reflowable)
                if self.reflowable:
                    self.doc.layout(width=_REFLOW_W, height=_REFLOW_H,
                                    fontsize=self._fontsize)
            except Exception:
                self.reflowable = False
            return True

    def outline(self) -> list:
        """Table of contents: list of {level, title, page} (page is 0-based)."""
        out = []
        try:
            with self._lock:
                toc = self.doc.get_toc()
            for level, title, page in toc:
                out.append({'level': level, 'title': title, 'page': max(page - 1, 0)})
        except Exception as e:
            logger.debug("get_toc failed for %s: %s", self.path, e)
        return out

    # ── rendering ─────────────────────────────────────────────────────────────
    def render_page(self, index: int, zoom: float = 1.0, rotate: int = 0) -> bytes:
        """Render a page to PNG bytes at the given zoom factor and rotation.

        ``rotate`` is a clockwise angle in degrees (normally 0/90/180/270); the
        rotation is baked into the render matrix so the cached document is never
        mutated and concurrent renders at different angles stay independent.
        """
        zoom = max(0.2, min(float(zoom), MAX_RENDER_ZOOM))
        try:
            rotate = int(rotate) % 360
        except (TypeError, ValueError):
            rotate = 0
        with self._lock:
            index = max(0, min(index, self.doc.page_count - 1))
            page = self.doc.load_page(index)
            mat = fitz.Matrix(zoom, zoom)
            if rotate:
                mat = mat * fitz.Matrix(rotate)
            pix = page.get_pixmap(matrix=mat, alpha=False)
            return pix.tobytes('png')

    def page_size(self, index: int = 0) -> dict:
        """Unscaled page dimensions in points (used for fit-to-width math)."""
        with self._lock:
            index = max(0, min(index, self.doc.page_count - 1))
            rect = self.doc.load_page(index).rect
            return {'width': rect.width, 'height': rect.height}

    # ── reflow (eBooks) ────────────────────────────────────────────────────────
    def relayout(self, fontsize: int) -> int:
        """Re-layout a reflowable document at a new font size. Returns new page count."""
        with self._lock:
            if not self.reflowable:
                return self.doc.page_count
            self._fontsize = max(6, min(int(fontsize), 36))
            self.doc.layout(width=_REFLOW_W, height=_REFLOW_H, fontsize=self._fontsize)
            return self.doc.page_count

    # ── editing / save ────────────────────────────────────────────────────────
    def mark_dirty(self):
        """Flag the document as having unsaved in-memory edits."""
        with self._lock:
            self.dirty = True

    def save(self) -> dict:
        """Persist in-memory edits back to the original file, in place.

        Uses an *incremental* save: PyMuPDF appends the changes to the existing
        file, leaving the original bytes (and any encryption) intact — the
        safest possible write. No-op when nothing is dirty. A few PDFs can't be
        updated incrementally (e.g. repaired/decrypted on open); those raise so
        the caller can fall back to "Save a Copy".
        """
        with self._lock:
            if not self.dirty:
                return {'saved': False, 'mode': 'clean'}
            if not self.doc.is_pdf:
                raise ValueError('Only PDF documents can be saved')
            if not self.doc.can_save_incrementally():
                raise RuntimeError('This PDF can\'t be updated in place — use "Save a Copy".')
            self.doc.save(self.path, incremental=True, encryption=fitz.PDF_ENCRYPT_KEEP)
            self.dirty = False
        _note_saved(self.path, self)
        return {'saved': True, 'mode': 'incremental'}

    def save_copy(self, dest: str) -> dict:
        """Write the current state (including unsaved edits) to a new PDF file,
        leaving the working document and its unsaved-edit state untouched."""
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Only PDF documents can be saved')
            self.doc.save(dest, garbage=3, deflate=True)
        return {'path': dest, 'name': Path(dest).name}

    # ── page operations ─────────────────────────────────────────────────────────
    def rotate_page(self, index: int, delta: int = 90, absolute=None) -> dict:
        """Rotate a single page and persist it as the page's /Rotate.

        Pass `delta` (default +90) to turn relative to the page's current
        rotation, or `absolute` to set it outright. The result is snapped to a
        right angle in [0, 360). Pure rotation keeps the doc incrementally
        savable, so this shares the in-place Save path with annotations.
        """
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Only PDF pages can be rotated')
            index = max(0, min(int(index), self.doc.page_count - 1))
            page = self.doc.load_page(index)
            base = int(absolute) if absolute is not None else page.rotation + int(delta)
            deg = base % 360
            if deg % 90:                       # snap stray angles to a right angle
                deg = (deg // 90) * 90
            page.set_rotation(deg)
            self.dirty = True
            return {'page': index, 'rotation': deg}

    def export_arranged(self, dest: str, plan: list) -> dict:
        """Assemble a NEW pdf from a page plan, leaving this document untouched.

        `plan` is an ordered list of items; output pages appear in that order, so
        any source page omitted from the plan is dropped (delete) and a repeated
        ``src`` duplicates a page. Each item is::

            {'src': <0-based source page index>, 'rotate': <delta degrees>}

        ``rotate`` is a *delta* added to the source page's own rotation (the same
        turn the user dialled in the organizer, where thumbnails start at the
        source orientation), snapped to a right angle. The original file is never
        mutated — this is a garbage-collected full rewrite, so dropped pages'
        bytes don't linger in the output.
        """
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Only PDF documents can be organized')
            items = list(plan or [])
            if not items:
                raise ValueError('Nothing to export — the page plan is empty')
            n = self.doc.page_count
            out = fitz.open()
            try:
                for it in items:
                    try:
                        src = int(it['src'])
                    except (KeyError, TypeError, ValueError):
                        raise ValueError('each plan item needs a numeric "src"')
                    if not (0 <= src < n):
                        raise ValueError(f'page {src + 1} is out of range (1..{n})')
                    out.insert_pdf(self.doc, from_page=src, to_page=src)
                    turn = int(it.get('rotate') or 0) % 360
                    if turn:
                        pg = out.load_page(out.page_count - 1)
                        deg = (pg.rotation + turn) % 360
                        if deg % 90:
                            deg = (deg // 90) * 90
                        pg.set_rotation(deg)
                out.save(str(dest), garbage=3, deflate=True)
                pages = out.page_count
            finally:
                out.close()
        return {'path': str(dest), 'name': Path(dest).name, 'pages': pages}

    @staticmethod
    def _safe_stem(stem, fallback: str) -> str:
        """Reduce a user-supplied output filename stem to a BARE name — strip any
        directory components and separators so it can't escape the chosen output
        folder (path-traversal guard for split / export-images)."""
        base = (stem or '').strip()
        base = Path(base).name                       # drop dir parts (./ ../ etc.)
        base = base.replace('/', '').replace('\\', '').strip().strip('.')
        return base or fallback

    @staticmethod
    def _unique_path(dest: Path) -> Path:
        """Return `dest` or, if it already exists, `dest` with a ` (2)`, ` (3)`…
        counter inserted before the suffix — so a split never clobbers files."""
        dest = Path(dest)
        if not dest.exists():
            return dest
        stem, suffix, parent = dest.stem, dest.suffix, dest.parent
        for i in range(2, 1000):
            cand = parent / f'{stem} ({i}){suffix}'
            if not cand.exists():
                return cand
        return dest

    def merge(self, dest: str, sequence: list) -> dict:
        """Assemble a NEW pdf by concatenating documents in order, leaving this
        document untouched.

        `sequence` is an ordered list whose items are either the literal string
        ``'self'`` (this open document, *including* its unsaved edits — same as
        :meth:`export_arranged`) or a filesystem path to another PDF. Every part
        is appended whole, in the given order. The original file is never mutated;
        this is a garbage-collected full rewrite.
        """
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Only PDF documents can be merged')
            seq = list(sequence or [])
            if not seq:
                raise ValueError('Nothing to merge — the list is empty')
            out = fitz.open()
            opened = []
            try:
                for item in seq:
                    if isinstance(item, str) and item.strip().lower() == 'self':
                        out.insert_pdf(self.doc)
                        continue
                    path = Path(str(item))
                    if path.suffix.lower() != '.pdf':
                        raise ValueError(f'Not a PDF: {path.name}')
                    if not path.is_file():
                        raise ValueError(f'File not found: {path.name}')
                    src = fitz.open(str(path))
                    opened.append(src)
                    if not src.is_pdf:
                        raise ValueError(f'Not a PDF: {path.name}')
                    out.insert_pdf(src)
                pages = out.page_count
                if pages == 0:
                    raise ValueError('The merged document would be empty')
                out.save(str(dest), garbage=3, deflate=True)
            finally:
                out.close()
                for s in opened:
                    try:
                        s.close()
                    except Exception:
                        pass
        return {'path': str(dest), 'name': Path(dest).name, 'pages': pages}

    def split(self, out_dir: str, ranges: list, stem: str = None) -> dict:
        """Write one NEW pdf per page range into `out_dir`, leaving this document
        untouched.

        `ranges` is a list of ``[first, last]`` *0-based, inclusive* page indices
        (reversed pairs are tolerated). Each range becomes a file named
        ``"<stem> (pA-B).pdf"`` (or ``"(pN)"`` for a single page); collisions get a
        numeric counter so nothing is overwritten. Returns
        ``{'files': [{path, name, pages}, …], 'count': N}``.
        """
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Only PDF documents can be split')
            folder = Path(out_dir)
            if not folder.is_dir():
                raise ValueError('Output folder does not exist')
            rngs = list(ranges or [])
            if not rngs:
                raise ValueError('No page ranges to split')
            n = self.doc.page_count
            base = self._safe_stem(stem or Path(self.path).stem, 'split')
            norm = []
            for r in rngs:
                try:
                    a, b = int(r[0]), int(r[1])
                except (TypeError, ValueError, IndexError, KeyError):
                    raise ValueError('each range needs [first, last] page numbers')
                if a > b:
                    a, b = b, a
                if not (0 <= a < n) or not (0 <= b < n):
                    raise ValueError(f'range {a + 1}-{b + 1} is outside 1..{n}')
                norm.append((a, b))
            results = []
            for a, b in norm:
                out = fitz.open()
                try:
                    out.insert_pdf(self.doc, from_page=a, to_page=b)
                    label = f'{a + 1}' if a == b else f'{a + 1}-{b + 1}'
                    dest = self._unique_path(folder / f'{base} (p{label}).pdf')
                    out.save(str(dest), garbage=3, deflate=True)
                    results.append({'path': str(dest), 'name': dest.name,
                                    'pages': out.page_count})
                finally:
                    out.close()
        return {'files': results, 'count': len(results)}

    _IMG_FORMATS = {'png': '.png', 'jpg': '.jpg', 'jpeg': '.jpg'}

    def export_images(self, out_dir: str, pages=None, fmt: str = 'png',
                      dpi: int = 150, stem: str = None) -> dict:
        """Render pages to image files in `out_dir`, leaving this document untouched.

        `pages` is a list of 0-based page indices (None or empty → every page).
        `fmt` is 'png', 'jpg' or 'jpeg'; `dpi` is clamped to a sane 36–600 band.
        Each page becomes ``"<stem> (pN).<ext>"`` and collisions get a numeric
        counter, so nothing is overwritten. Returns
        ``{'files': [{path, name, page}, …], 'count': N, 'dir': out_dir}``.
        Unlike merge/split this isn't PDF-only — any page-based document renders.
        """
        with self._lock:
            folder = Path(out_dir)
            if not folder.is_dir():
                raise ValueError('Output folder does not exist')
            ext = self._IMG_FORMATS.get(str(fmt or 'png').strip().lower())
            if ext is None:
                raise ValueError('Image format must be PNG or JPG')
            is_jpg = ext == '.jpg'
            try:
                dpi = int(dpi)
            except (TypeError, ValueError):
                dpi = 150
            dpi = max(36, min(600, dpi))
            n = self.doc.page_count
            if pages:
                idxs = []
                for p in pages:
                    try:
                        i = int(p)
                    except (TypeError, ValueError):
                        raise ValueError('page numbers must be integers')
                    if not (0 <= i < n):
                        raise ValueError(f'page {i + 1} is out of range (1..{n})')
                    idxs.append(i)
            else:
                idxs = list(range(n))
            if not idxs:
                raise ValueError('No pages to export')
            base = self._safe_stem(stem or Path(self.path).stem, 'page')
            results = []
            for i in idxs:
                pix = self.doc.load_page(i).get_pixmap(dpi=dpi)
                if is_jpg and pix.alpha:
                    pix = fitz.Pixmap(pix, 0)         # JPEG has no alpha channel
                dest = self._unique_path(folder / f'{base} (p{i + 1}){ext}')
                if is_jpg:
                    pix.save(str(dest), jpg_quality=90)
                else:
                    pix.save(str(dest))
                results.append({'path': str(dest), 'name': dest.name, 'page': i})
        return {'files': results, 'count': len(results), 'dir': str(folder)}

    _COMPRESS_LEVELS = {
        # level → image-rewrite kwargs (None = lossless structural pass only).
        # NOTE: rewrite_images requires dpi_target strictly < dpi_threshold.
        'light':    None,
        'balanced': {'dpi_threshold': 200, 'dpi_target': 150, 'quality': 80},
        'strong':   {'dpi_threshold': 130, 'dpi_target': 96,  'quality': 55},
    }

    def compress(self, dest: str, level: str = 'balanced') -> dict:
        """Write a size-optimised COPY of this PDF to `dest`; never mutate the open
        document or the original file.

        Levels:
          * ``light``    — lossless only: drop unused objects, deflate streams and
            subset fonts. No image quality change.
          * ``balanced`` — light, plus down-sampling images denser than 200 dpi to
            150 dpi (JPEG q80). Good for sharing.
          * ``strong``   — light, plus down-sampling images denser than 130 dpi to
            96 dpi (JPEG q55). Smallest; screen-only.

        ``rewrite_images``/``subset_fonts`` mutate a document in place, so the work
        runs on a throw-away in-memory copy (which carries any unsaved edits too,
        exactly like :meth:`merge`). Returns the new path plus before/after byte
        sizes and the percentage saved.
        """
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Only PDF documents can be compressed')
            lvl = str(level or 'balanced').strip().lower()
            if lvl not in self._COMPRESS_LEVELS:
                raise ValueError('Compression level must be light, balanced or strong')
            out = Path(dest)
            if out.suffix.lower() != '.pdf':
                raise ValueError('Destination must be a .pdf file')
            if not out.parent.is_dir():
                raise ValueError('Destination folder does not exist')
            try:
                before = Path(self.path).stat().st_size
            except OSError:
                before = 0
            img = self._COMPRESS_LEVELS[lvl]
            tmp = fitz.open()
            try:
                tmp.insert_pdf(self.doc)             # copy current in-memory state
                if img is not None:
                    try:
                        tmp.rewrite_images(lossy=True, lossless=True, **img)
                    except Exception:
                        pass                          # best-effort; never block the save
                try:
                    tmp.subset_fonts()
                except Exception:
                    pass
                dest_unique = self._unique_path(out)
                tmp.save(str(dest_unique), garbage=4, deflate=True, deflate_images=True,
                         deflate_fonts=True, clean=True, use_objstms=1)
            finally:
                tmp.close()
        after = dest_unique.stat().st_size
        saved = before - after if before else 0
        pct = round(saved / before * 100, 1) if before else 0.0
        return {'path': str(dest_unique), 'name': dest_unique.name, 'level': lvl,
                'before': before, 'after': after, 'saved': saved, 'saved_pct': pct}

    # Redaction modes, resolved once from the pinned PyMuPDF (getattr keeps us
    # safe if a constant is renamed upstream). Text removal is the default since
    # 1.24.2; we additionally erase image *pixels* under the box and any line-art
    # the box touches, so nothing recoverable survives beneath the black fill.
    _REDACT_IMG_PIXELS = getattr(fitz, 'PDF_REDACT_IMAGE_PIXELS', 2)
    _REDACT_IMG_NONE = getattr(fitz, 'PDF_REDACT_IMAGE_NONE', 0)
    _REDACT_ART_TOUCHED = getattr(fitz, 'PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED', 2)
    _REDACT_TEXT_REMOVE = getattr(fitz, 'PDF_REDACT_TEXT_REMOVE', 0)

    def redact(self, dest: str, regions, fill=None, scrub: bool = False,
               remove_images: bool = True) -> dict:
        """Write a NEW pdf with the given regions permanently redacted — the
        text, vector drawings and (optionally) image pixels under each box are
        REMOVED from the page content streams, not merely hidden behind a drawn
        rectangle. The open document and the original file on disk are never
        mutated (the work runs on an in-memory copy, exactly like
        :meth:`compress`/:meth:`merge`, so any unsaved edits ride along too).

        ``regions`` is a list of per-page boxes::

            [{'page': <0-based index>, 'rects': [[x0, y0, x1, y1], …]}, …]

        in unrotated PDF points — the same coordinate space the annotate route
        and the selectable text layer use, so the UI can feed hand-drawn boxes
        or selected-word boxes straight through. Each rect becomes a redaction
        annotation filled solid ``fill`` (an ``[r,g,b]`` 0–1/0–255 triple or a
        ``'#rrggbb'`` string; default black). Applying the redactions on a page
        erases every glyph, line-art path and (when ``remove_images``) image
        pixel the box touches, then paints the fill. With ``scrub=True`` the
        document's metadata, XML metadata and any embedded JavaScript are
        stripped too — defence-in-depth before sharing.

        Returns ``{path, name, pages, boxes}``: the (collision-safe) output path
        and name, the number of pages that carried at least one redaction, and
        the total box count actually applied.
        """
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Only PDF documents can be redacted')
            n = self.doc.page_count
            by_page = {}
            for item in (regions or []):
                try:
                    pno = int(item['page'])
                except (KeyError, TypeError, ValueError):
                    raise ValueError('each region needs a numeric "page"')
                if not (0 <= pno < n):
                    raise ValueError(f'page {pno + 1} is out of range (1..{n})')
                for r in (item.get('rects') or []):
                    try:
                        rect = fitz.Rect(float(r[0]), float(r[1]),
                                         float(r[2]), float(r[3]))
                    except (TypeError, ValueError, IndexError):
                        raise ValueError('each rect must be [x0, y0, x1, y1] numbers')
                    rect.normalize()
                    if rect.is_empty or rect.width < 1 or rect.height < 1:
                        continue                      # ignore zero-area / stray taps
                    by_page.setdefault(pno, []).append(rect)
            if not by_page:
                raise ValueError('No redaction areas given')
            out = Path(dest)
            if out.suffix.lower() != '.pdf':
                raise ValueError('Destination must be a .pdf file')
            if not out.parent.is_dir():
                raise ValueError('Destination folder does not exist')
            rgb = _rgb(fill) or (0.0, 0.0, 0.0)       # redaction convention: black
            img_mode = self._REDACT_IMG_PIXELS if remove_images else self._REDACT_IMG_NONE
            boxes = 0
            # Faithful in-memory clone of the current state (carries unsaved edits,
            # metadata and outline) so the redacted copy is identical save for the
            # removed regions — and the original file is never mutated. We then
            # apply_redactions destructively on the *clone*.
            tmp = fitz.open(stream=self.doc.tobytes(), filetype='pdf')
            try:
                for pno, rects in by_page.items():
                    page = tmp.load_page(pno)
                    for rect in rects:
                        page.add_redact_annot(rect, fill=rgb)
                        boxes += 1
                    page.apply_redactions(images=img_mode,
                                          graphics=self._REDACT_ART_TOUCHED,
                                          text=self._REDACT_TEXT_REMOVE)
                if scrub:
                    try:
                        tmp.scrub()
                    except Exception as e:
                        logger.debug("scrub skipped during redact: %s", e)
                dest_unique = self._unique_path(out)
                tmp.save(str(dest_unique), garbage=4, deflate=True, clean=True)
            finally:
                tmp.close()
        return {'path': str(dest_unique), 'name': dest_unique.name,
                'pages': len(by_page), 'boxes': boxes}

    def ocr(self, dest: str, language: str = 'eng', pages=None,
            dpi: int = 300, skip_text: bool = True) -> dict:
        """Write a *searchable* COPY of this PDF to ``dest`` — never mutate the open
        document or the original file.

        Selected pages are rasterised at ``dpi`` and run through Tesseract, which
        lays an **invisible** text layer behind the image: the page looks identical
        but its words become selectable and searchable. Pages that already carry a
        real text layer are copied through untouched when ``skip_text`` is set (the
        default) so born-digital pages keep their crisp vector text and only the
        scanned pages are OCR'd.

        Args:
          dest:      destination ``.pdf`` path (auto-uniquified; never overwrites).
          language:  Tesseract language code(s), e.g. ``eng`` or ``eng+ara``.
          pages:     optional list of 0-based indices to OCR; ``None`` = every page.
                     Pages outside the list are always copied as-is.
          dpi:       rasterisation resolution for OCR (clamped to 72–600; 300 best).
          skip_text: copy pages that already contain selectable text rather than
                     rasterising + OCR'ing them.

        Returns a report dict: ``path``, ``name``, ``language``, ``pages`` (total),
        ``ocr_pages``, ``skipped_pages`` and ``before``/``after`` byte sizes
        (``ocr_pages + skipped_pages == pages`` always).

        Raises ``ValueError`` for a non-PDF source, a bad destination, an
        unavailable Tesseract engine, or an uninstalled language.
        """
        from renderers import comicdir
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Only PDF documents can be made searchable')
            out = Path(dest)
            if out.suffix.lower() != '.pdf':
                raise ValueError('Destination must be a .pdf file')
            if not out.parent.is_dir():
                raise ValueError('Destination folder does not exist')
            if not comicdir.tesseract_available():
                raise ValueError('OCR needs the free Tesseract engine, which isn’t installed')

            lang = (str(language or 'eng').strip()) or 'eng'
            comicdir.ocr_config()                       # sets TESSDATA_PREFIX env var
            tessdata = comicdir.tessdata_dir() or None  # user language dir, else system default
            try:
                import pytesseract
                have = set(pytesseract.get_languages(config=''))
                missing = [w for w in lang.replace('+', ' ').split() if w and w not in have]
                if missing:
                    raise ValueError('Language not installed: ' + ', '.join(missing))
            except ValueError:
                raise
            except Exception:
                pass                                    # can't list langs → let Tesseract try anyway

            try:
                dpi = int(dpi)
            except (TypeError, ValueError):
                dpi = 300
            dpi = max(72, min(600, dpi))

            n = self.doc.page_count
            sel = set(range(n)) if pages is None else {int(p) for p in pages if 0 <= int(p) < n}
            try:
                before = Path(self.path).stat().st_size
            except OSError:
                before = 0

            out_doc = fitz.open()
            ocr_pages = skipped = 0
            try:
                for i in range(n):
                    page = self.doc.load_page(i)
                    has_text = len((page.get_text('text') or '').strip()) >= 8
                    if i not in sel or (skip_text and has_text):
                        out_doc.insert_pdf(self.doc, from_page=i, to_page=i)  # copy through
                        skipped += 1
                        continue
                    try:
                        pix = page.get_pixmap(dpi=dpi)
                        ob = pix.pdfocr_tobytes(compress=True, language=lang, tessdata=tessdata)
                        od = fitz.open(stream=ob, filetype='pdf')
                        try:
                            out_doc.insert_pdf(od)
                        finally:
                            od.close()
                        ocr_pages += 1
                    except Exception:
                        logger.exception('OCR failed on page %d; copying it through', i)
                        out_doc.insert_pdf(self.doc, from_page=i, to_page=i)
                        skipped += 1
                dest_unique = self._unique_path(out)
                out_doc.save(str(dest_unique), garbage=4, deflate=True,
                             deflate_images=True, deflate_fonts=True, use_objstms=1)
            finally:
                out_doc.close()
        after = dest_unique.stat().st_size
        return {'path': str(dest_unique), 'name': dest_unique.name, 'language': lang,
                'pages': n, 'ocr_pages': ocr_pages, 'skipped_pages': skipped,
                'before': before, 'after': after}

    def place_image(self, index: int, rect, png_bytes: bytes,
                    keep_proportion: bool = True, rotate: int = 0) -> dict:
        """Stamp an image (e.g. a signature) onto a page, baked into content.

        ``rect`` is ``[x0, y0, x1, y1]`` in unrotated PDF points — the same
        coordinate space the annotation methods use. Unlike an annotation, an
        inserted image is written into the page's content stream: it is
        permanent, won't appear in :meth:`annotations`, and can't be removed via
        :meth:`delete_annotation`. It does keep the document incrementally
        savable, though, so a placed signature rides the in-place Save path
        alongside annotations and rotation.

        A transparent PNG keeps its alpha (the page shows through), so a
        signature lands as ink-on-page rather than a white box. ``keep_proportion``
        letterboxes the image inside ``rect`` so it never distorts; ``rotate`` is
        an optional right-angle turn applied to the stamp itself.
        """
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Images can only be stamped onto PDF files')
            if not png_bytes:
                raise ValueError('no image data')
            index = max(0, min(int(index), self.doc.page_count - 1))
            try:
                coords = [float(v) for v in rect]
            except (TypeError, ValueError):
                raise ValueError('rect must be [x0, y0, x1, y1]')
            if len(coords) != 4:
                raise ValueError('rect must be [x0, y0, x1, y1]')
            r = fitz.Rect(*coords)
            r.normalize()
            if r.is_empty or r.is_infinite or r.width <= 0 or r.height <= 0:
                raise ValueError('rect has no area')
            try:
                turn = int(rotate) % 360
            except (TypeError, ValueError):
                turn = 0
            if turn % 90:                       # insert_image only accepts right angles
                turn = (turn // 90) * 90
            page = self.doc.load_page(index)
            page.insert_image(r, stream=png_bytes,
                              keep_proportion=bool(keep_proportion),
                              overlay=True, rotate=turn)
            self.dirty = True
            return {'page': index, 'rect': [round(v, 2) for v in r]}

    # ── form fields (P7a) ────────────────────────────────────────────────────────
    # Map PyMuPDF widget type-strings to the simple kinds the frontend renders.
    _FIELD_KIND = {
        'text': 'text', 'checkbox': 'checkbox', 'radiobutton': 'radio',
        'combobox': 'combo', 'listbox': 'list', 'signature': 'signature',
    }
    _FF_READONLY = 1            # PDF field-flag bits (stable across PDF versions)
    _FF_MULTILINE = 1 << 12

    @staticmethod
    def _truthy(value, on_state) -> bool:
        if isinstance(value, bool):
            return value
        s = str(value).strip().lower()
        return s in ('1', 'true', 'on', 'yes', 'checked') or s == str(on_state).lower()

    def _field_desc(self, w, pno: int) -> dict:
        kind = self._FIELD_KIND.get((w.field_type_string or '').lower(), 'text')
        flags = int(getattr(w, 'field_flags', 0) or 0)
        val = w.field_value
        entry = {
            'page': pno,
            'name': w.field_name or '',
            'label': getattr(w, 'field_label', None) or '',
            'kind': kind,
            'value': '' if val is None else val,
            'rect': [round(float(v), 2) for v in w.rect],
            'readonly': bool(flags & self._FF_READONLY),
        }
        if kind in ('combo', 'list'):
            entry['options'] = list(w.choice_values or [])
        elif kind in ('checkbox', 'radio'):
            try:
                on = w.on_state()
            except Exception:
                on = 'Yes'
            entry['on'] = on or 'Yes'
            entry['checked'] = str(val) not in ('', 'Off', 'None', 'False')
        elif kind == 'text':
            entry['maxlen'] = int(getattr(w, 'text_maxlen', 0) or 0)
            entry['multiline'] = bool(flags & self._FF_MULTILINE)
        return entry

    def form_fields(self) -> dict:
        """Enumerate fillable form widgets across all pages.

        Returns ``{'is_form': bool, 'fields': [descriptor, …]}``. Push buttons are
        skipped (they hold no fillable value). A radio group surfaces one entry
        per button (each with its own rect + ``on`` state) so the UI can render a
        control at every spot; they share a ``name`` and current ``value``.
        """
        with self._lock:
            if not self.doc.is_pdf:
                return {'is_form': False, 'fields': []}
            fields = []
            for pno in range(self.doc.page_count):
                for w in self.doc.load_page(pno).widgets():
                    if (w.field_type_string or '').lower() == 'button':
                        continue                    # push button — not data
                    fields.append(self._field_desc(w, pno))
            return {'is_form': bool(fields), 'fields': fields}

    def set_field(self, page: int, name: str, value) -> dict:
        """Set one form field's value in memory — call :meth:`save` to persist.

        ``value`` is a string for text/choice fields, and truthy/falsy or the
        on-state for checkboxes. For a radio group, pass the chosen button's
        on-state (anything unmatched clears the group). Raises ``KeyError`` if no
        widget on the page carries ``name``; ``ValueError`` if it's read-only.
        """
        name = str(name or '')
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Not a PDF')
            if not name:
                raise ValueError('field name required')
            pno = max(0, min(int(page), self.doc.page_count - 1))
            pg = self.doc.load_page(pno)
            group = [w for w in pg.widgets() if (w.field_name or '') == name]
            if not group:
                raise KeyError(name)
            kind = self._FIELD_KIND.get((group[0].field_type_string or '').lower(), 'text')
            if int(getattr(group[0], 'field_flags', 0) or 0) & self._FF_READONLY:
                raise ValueError('field is read-only')
            if kind == 'signature':
                raise ValueError('signature fields are not fillable here')

            applied = None
            if kind == 'checkbox':
                w = group[0]
                try:
                    on = w.on_state() or 'Yes'
                except Exception:
                    on = 'Yes'
                w.field_value = bool(self._truthy(value, on))
                w.update()
                applied = w.field_value
            elif kind == 'radio':
                chosen = None
                for w in group:
                    try:
                        on = w.on_state()
                    except Exception:
                        on = None
                    if on is not None and str(value) == str(on):
                        chosen = w
                        break
                if chosen is not None:
                    chosen.field_value = str(value)
                    chosen.update()
                    applied = str(value)
                else:                               # nothing matched → clear group
                    group[0].field_value = 'Off'
                    group[0].update()
                    applied = 'Off'
            else:                                   # text, combo, list
                w = group[0]
                w.field_value = '' if value is None else str(value)
                w.update()
                applied = w.field_value

            self.dirty = True
            return {'page': pno, 'name': name, 'value': applied}

    # ── annotations ────────────────────────────────────────────────────────────
    def annotations(self, index: int) -> list:
        """List the annotations on a page as UI descriptors."""
        with self._lock:
            index = max(0, min(int(index), self.doc.page_count - 1))
            page = self.doc.load_page(index)
            return [self._annot_desc(a, index) for a in page.annots()]

    def add_annotation(self, index: int, spec: dict) -> dict:
        """Add one annotation from a frontend spec (coords in unrotated PDF
        points). Marks the doc dirty; returns the new annotation's descriptor."""
        kind = (spec.get('kind') or '').strip().lower()
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Annotations are only supported on PDF files')
            index = max(0, min(int(index), self.doc.page_count - 1))
            page = self.doc.load_page(index)
            annot = self._build_annot(page, kind, spec)
            if annot is None:
                raise ValueError(f'Unsupported annotation: {kind or "(none)"}')
            self._style_annot(annot, kind, spec)
            self.dirty = True
            return self._annot_desc(annot, index)

    def delete_annotation(self, index: int, xref: int) -> bool:
        """Delete a page annotation by xref. Returns True if one was removed."""
        with self._lock:
            index = max(0, min(int(index), self.doc.page_count - 1))
            page = self.doc.load_page(index)
            target = next((a for a in page.annots() if a.xref == int(xref)), None)
            if target is None:
                return False
            page.delete_annot(target)
            self.dirty = True
            return True

    def all_annotations(self, cap: int = 5000) -> list:
        """Every annotation in the document as UI descriptors, in page order
        (for the annotation manager). Bounded by `cap` so a pathological doc
        can't blow up the payload."""
        out = []
        with self._lock:
            for index in range(self.doc.page_count):
                page = self.doc.load_page(index)
                for a in page.annots():
                    out.append(self._annot_desc(a, index))
                    if len(out) >= cap:
                        return out
        return out

    def update_annotation(self, index: int, xref: int, spec: dict):
        """Edit an existing annotation in place: its note text ('text'/'content')
        and/or stroke color. Notes apply to ANY annotation kind. Marks the doc
        dirty; returns the updated descriptor, or None if no such xref exists."""
        with self._lock:
            index = max(0, min(int(index), self.doc.page_count - 1))
            page = self.doc.load_page(index)
            target = next((a for a in page.annots() if a.xref == int(xref)), None)
            if target is None:
                return None
            changed = False
            if 'text' in spec or 'content' in spec:
                content = spec.get('text', spec.get('content'))
                try:
                    target.set_info(content=str(content or ''))
                    changed = True
                except Exception as e:
                    logger.debug("annot set_info content failed: %s", e)
            color = _rgb(spec.get('color'))
            if color is not None:
                try:
                    target.set_colors(stroke=color)
                    changed = True
                except Exception as e:
                    logger.debug("annot set_colors failed: %s", e)
            if changed:
                try:
                    target.update()
                except Exception as e:
                    logger.debug("annot.update skipped: %s", e)
                self.dirty = True
            return self._annot_desc(target, index)

    # ── annotation export / import (v2-5c) ───────────────────────────────────
    def export_annotations(self, fmt: str = 'json') -> str:
        """Serialize every annotation to a portable string.

        fmt='json' → YancoRead's native format: full fidelity, coords in
        unrotated top-left PDF points (a perfect backup/restore of our own
        annotations). fmt='xfdf' → Adobe's XML interchange format (coords in
        bottom-left PDF user space, so Acrobat & other PDF tools can read it).
        """
        fmt = (fmt or 'json').strip().lower()
        records, heights = [], {}
        with self._lock:
            for index in range(self.doc.page_count):
                page = self.doc.load_page(index)
                heights[index] = float(page.rect.height)
                for a in page.annots():
                    rec = self._annot_record(a, index)
                    if rec:
                        records.append(rec)
        if fmt == 'xfdf':
            return self._records_to_xfdf(records, heights)
        return json.dumps({'yancoread_annotations': 1,
                           'source': Path(self.path).name,
                           'count': len(records),
                           'annotations': records},
                          ensure_ascii=False, indent=2)

    def import_annotations(self, data, fmt: str = 'json') -> dict:
        """Recreate annotations from a JSON or XFDF string (produced by
        export_annotations or another PDF tool). Adds them to the in-memory doc
        and marks it dirty — call save() to persist. Returns a small report
        {added, skipped, total, errors}."""
        fmt = (fmt or 'json').strip().lower()
        with self._lock:
            if not self.doc.is_pdf:
                raise ValueError('Annotations are only supported on PDF files')
            page_count = self.doc.page_count
            if fmt == 'xfdf':
                records, heights = self._xfdf_to_records(data), {}
                for rec in records:
                    page = max(0, min(int(rec.get('page', 0)), page_count - 1))
                    rec['page'] = page
                    if page not in heights:
                        heights[page] = float(self.doc.load_page(page).rect.height)
                    self._flip_record_y(rec, heights[page])   # bottom-left → top-left
            else:
                obj = json.loads(data) if isinstance(data, (str, bytes)) else data
                if isinstance(obj, dict):
                    records = obj.get('annotations') or []
                elif isinstance(obj, list):
                    records = obj
                else:
                    records = []

            added, errors = 0, []
            for rec in records:
                if not isinstance(rec, dict) or not rec.get('kind'):
                    continue
                try:
                    page = max(0, min(int(rec.get('page', 0)), page_count - 1))
                    desc = self.add_annotation(page, rec)
                    content = rec.get('content')
                    if content and rec.get('kind') not in ('note', 'text', 'freetext'):
                        self.update_annotation(page, desc['id'], {'content': content})
                    added += 1
                except Exception as e:                       # one bad record never aborts the rest
                    errors.append(str(e))
            return {'added': added, 'skipped': len(errors),
                    'total': len(records), 'errors': errors[:8]}

    @staticmethod
    def _annot_record(annot, index):
        """One live annotation → a portable record (native top-left points)
        carrying everything add_annotation needs to recreate it. None for kinds
        we don't round-trip."""
        try:
            kind = SUBTYPE_TO_KIND.get(annot.type[1])
        except Exception:
            kind = None
        if not kind:
            return None
        try:
            r = [round(float(v), 2) for v in annot.rect]
        except Exception:
            r = [0.0, 0.0, 0.0, 0.0]
        rec = {'kind': kind, 'page': index, 'rect': r}
        try:
            stroke = annot.colors.get('stroke')
            if stroke:
                rec['color'] = [round(float(c), 4) for c in stroke]
        except Exception:
            pass
        try:
            fill = annot.colors.get('fill')
            if fill:
                rec['fill'] = [round(float(c), 4) for c in fill]
        except Exception:
            pass
        try:
            width = (annot.border or {}).get('width')
            if width:
                rec['width'] = round(float(width), 2)
        except Exception:
            pass
        try:
            content = annot.info.get('content', '') or ''
        except Exception:
            content = ''
        if content:
            rec['content'] = content
        try:
            verts = annot.vertices
        except Exception:
            verts = None
        if kind in ('highlight', 'underline', 'strikeout', 'squiggly'):
            rec['rects'] = _quads_to_rects(verts) or [r]
        elif kind in ('rect', 'oval', 'freetext'):
            rec['rects'] = [r]
        elif kind == 'line':
            if verts and len(verts) >= 2:
                rec['points'] = [[round(float(verts[0][0]), 2), round(float(verts[0][1]), 2)],
                                 [round(float(verts[-1][0]), 2), round(float(verts[-1][1]), 2)]]
            else:
                rec['points'] = [[r[0], r[1]], [r[2], r[3]]]
        elif kind == 'ink':
            rec['strokes'] = [[[round(float(p[0]), 2), round(float(p[1]), 2)] for p in s]
                              for s in (verts or [])]
        elif kind == 'note':
            rec['point'] = [r[0], r[1]]
        if kind in ('note', 'freetext') and content:
            rec['text'] = content
        return rec

    @staticmethod
    def _records_to_xfdf(records, heights):
        """Native top-left records → an XFDF document string. Y is flipped to
        bottom-left PDF user space (the XFDF convention) per the page height."""
        def fy(page, y):
            return round(heights.get(page, 0.0) - float(y), 2)

        def nums(seq):
            return ','.join(str(round(float(v), 2)) for v in seq)

        out = ['<?xml version="1.0" encoding="UTF-8"?>',
               '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">',
               '  <annots>']
        for rec in records:
            el = _KIND_TO_XFDF.get(rec.get('kind'))
            if not el:
                continue
            page = int(rec.get('page', 0))
            r = rec.get('rect') or [0, 0, 0, 0]
            attrs = [f'page="{page}"',
                     f'rect="{nums([r[0], fy(page, r[3]), r[2], fy(page, r[1])])}"']
            col = _hexcolor(rec.get('color'))
            if col:
                attrs.append(f'color="{col}"')
            fill = _hexcolor(rec.get('fill'))
            if fill:
                attrs.append(f'interior-color="{fill}"')
            if rec.get('width') is not None:
                attrs.append(f'width="{rec["width"]}"')
            inner = ''
            kind = rec['kind']
            if kind in ('highlight', 'underline', 'strikeout', 'squiggly'):
                coords = []
                for x0, y0, x1, y1 in (rec.get('rects') or []):
                    coords += [x0, fy(page, y0), x1, fy(page, y0),
                               x0, fy(page, y1), x1, fy(page, y1)]
                attrs.append(f'coords="{nums(coords)}"')
            elif kind == 'line':
                p = rec.get('points') or [[r[0], r[1]], [r[2], r[3]]]
                attrs.append(f'start="{nums([p[0][0], fy(page, p[0][1])])}"')
                attrs.append(f'end="{nums([p[1][0], fy(page, p[1][1])])}"')
            elif kind == 'ink':
                gestures = ''
                for s in (rec.get('strokes') or []):
                    flat = []
                    for pt in s:
                        flat += [pt[0], fy(page, pt[1])]
                    gestures += f'<gesture>{nums(flat)}</gesture>'
                inner += f'<inklist>{gestures}</inklist>'
            content = rec.get('content') or rec.get('text') or ''
            if content:
                inner += f'<contents>{_xml_escape(content)}</contents>'
            open_tag = f'    <{el} ' + ' '.join(attrs)
            out.append(open_tag + (f'>{inner}</{el}>' if inner else '/>'))
        out += ['  </annots>', '</xfdf>', '']
        return '\n'.join(out)

    @staticmethod
    def _xfdf_to_records(data):
        """Parse an XFDF string → records in XFDF (bottom-left) coords. The flip
        back to top-left happens in import_annotations (it has the page heights).
        Tolerates namespaced or bare tags and missing optional attributes."""
        if isinstance(data, bytes):
            data = data.decode('utf-8', 'replace')
        try:
            root = ET.fromstring(data)
        except ET.ParseError as e:
            raise ValueError(f'Invalid XFDF: {e}')

        def local(tag):
            return str(tag).split('}', 1)[-1].lower()

        annots = next((el for el in root.iter() if local(el.tag) == 'annots'), None)
        if annots is None:
            return []
        out = []
        for el in list(annots):
            kind = _XFDF_TO_KIND.get(local(el.tag))
            if not kind:
                continue

            def attr(name, _a=el.attrib):
                if name in _a:
                    return _a[name]
                return next((v for k, v in _a.items() if local(k) == name), None)

            rec = {'kind': kind}
            try:
                rec['page'] = int(attr('page') or 0)
            except (ValueError, TypeError):
                rec['page'] = 0
            rect = _parse_nums(attr('rect'))
            if len(rect) == 4:
                rec['rect'] = rect
            col = _rgb(attr('color'))
            if col:
                rec['color'] = [round(c, 4) for c in col]
            ic = _rgb(attr('interior-color'))
            if ic:
                rec['fill'] = [round(c, 4) for c in ic]
            try:
                if attr('width') is not None:
                    rec['width'] = float(attr('width'))
            except (ValueError, TypeError):
                pass
            for child in el:
                if local(child.tag) == 'contents':
                    rec['content'] = child.text or ''
            if kind in ('highlight', 'underline', 'strikeout', 'squiggly'):
                coords = _parse_nums(attr('coords'))
                rects = []
                for i in range(0, len(coords) - 7, 8):
                    xs = coords[i:i + 8:2]
                    ys = coords[i + 1:i + 8:2]
                    rects.append([min(xs), min(ys), max(xs), max(ys)])
                rec['rects'] = rects or ([rec['rect']] if 'rect' in rec else [])
            elif kind in ('rect', 'oval', 'freetext'):
                rec['rects'] = [rec['rect']] if 'rect' in rec else []
            elif kind == 'line':
                s, e = _parse_nums(attr('start')), _parse_nums(attr('end'))
                if len(s) == 2 and len(e) == 2:
                    rec['points'] = [s, e]
                elif 'rect' in rec:
                    rr = rec['rect']
                    rec['points'] = [[rr[0], rr[1]], [rr[2], rr[3]]]
            elif kind == 'ink':
                strokes = []
                for il in el:
                    if local(il.tag) != 'inklist':
                        continue
                    for g in il:
                        if local(g.tag) != 'gesture':
                            continue
                        n = _parse_nums(g.text)
                        strokes.append([[n[i], n[i + 1]] for i in range(0, len(n) - 1, 2)])
                rec['strokes'] = strokes
            elif kind == 'note' and 'rect' in rec:
                rec['point'] = [rec['rect'][0], rec['rect'][3]]   # top-left corner (bottom-left space)
            if kind in ('note', 'freetext') and rec.get('content'):
                rec['text'] = rec['content']
            out.append(rec)
        return out

    @staticmethod
    def _flip_record_y(rec, height):
        """Flip every Y coordinate in a record between top-left and bottom-left
        space (the transform is its own inverse for a given page height)."""
        def fy(y):
            return round(height - float(y), 2)
        if 'rect' in rec and len(rec['rect']) == 4:
            x0, y0, x1, y1 = rec['rect']
            rec['rect'] = [x0, fy(y1), x1, fy(y0)]
        if 'rects' in rec:
            rec['rects'] = [[x0, fy(y1), x1, fy(y0)] for x0, y0, x1, y1 in rec['rects']]
        if 'points' in rec:
            rec['points'] = [[p[0], fy(p[1])] for p in rec['points']]
        if 'strokes' in rec:
            rec['strokes'] = [[[p[0], fy(p[1])] for p in s] for s in rec['strokes']]
        if 'point' in rec:
            rec['point'] = [rec['point'][0], fy(rec['point'][1])]

    # -- annotation helpers --
    def _build_annot(self, page, kind, spec):
        rects = [fitz.Rect(*r) for r in (spec.get('rects') or []) if r]
        if kind in ('highlight', 'underline', 'strikeout', 'squiggly'):
            if not rects:
                raise ValueError(f'{kind} needs at least one rect')
            fn = {'highlight': page.add_highlight_annot,
                  'underline': page.add_underline_annot,
                  'strikeout': page.add_strikeout_annot,
                  'squiggly': page.add_squiggly_annot}[kind]
            return fn(rects)
        if kind in ('rect', 'square'):
            return page.add_rect_annot(rects[0]) if rects else None
        if kind in ('oval', 'circle', 'ellipse'):
            return page.add_circle_annot(rects[0]) if rects else None
        if kind == 'line':
            pts = spec.get('points') or []
            if len(pts) < 2:
                raise ValueError('line needs two points')
            return page.add_line_annot(fitz.Point(*pts[0]), fitz.Point(*pts[1]))
        if kind == 'ink':
            # PyMuPDF wants a seq of seq of float pairs (NOT fitz.Point objects).
            strokes = [[(float(p[0]), float(p[1])) for p in s]
                       for s in (spec.get('strokes') or []) if s]
            if not strokes:
                raise ValueError('ink needs at least one stroke')
            return page.add_ink_annot(strokes)
        if kind in ('note', 'text'):
            pt = spec.get('point') or ([rects[0].x0, rects[0].y0] if rects else [72, 72])
            return page.add_text_annot(fitz.Point(*pt), str(spec.get('text') or ''))
        if kind in ('freetext', 'free_text'):
            if not rects:
                raise ValueError('freetext needs a rect')
            return page.add_freetext_annot(
                rects[0], str(spec.get('text') or ''),
                fontsize=int(spec.get('fontsize') or 12),
                text_color=_rgb(spec.get('color')) or (0, 0, 0),
                fill_color=_rgb(spec.get('fill')))
        if kind == 'stamp':
            if not rects:
                raise ValueError('stamp needs a rect')
            return page.add_stamp_annot(rects[0], stamp=int(spec.get('stamp') or 0))
        return None

    def _style_annot(self, annot, kind, spec):
        color = _rgb(spec.get('color'))
        fill = _rgb(spec.get('fill'))
        if kind == 'highlight' and color is None:
            color = (1.0, 0.92, 0.23)        # default marker yellow
        steps = (
            lambda: annot.set_colors(stroke=color)
            if color is not None and kind not in ('freetext', 'free_text') else None,
            lambda: annot.set_colors(fill=fill)
            if fill is not None and kind in ('rect', 'square', 'oval', 'circle', 'ellipse') else None,
            lambda: annot.set_border(width=float(spec['width']))
            if spec.get('width') is not None else None,
            lambda: annot.set_opacity(float(spec['opacity']))
            if spec.get('opacity') is not None else None,
            lambda: annot.set_info(content=str(spec['text']))
            if spec.get('text') and kind in ('note', 'text') else None,
        )
        for step in steps:
            try:
                step()
            except Exception as e:
                logger.debug("annot style step skipped (%s): %s", kind, e)
        try:
            annot.update()
        except Exception as e:
            logger.debug("annot.update skipped (%s): %s", kind, e)

    @staticmethod
    def _annot_desc(annot, page_index):
        try:
            rect = [round(v, 2) for v in annot.rect]
        except Exception:
            rect = [0, 0, 0, 0]
        try:
            kind = annot.type[1]
        except Exception:
            kind = '?'
        try:
            stroke = annot.colors.get('stroke')
        except Exception:
            stroke = None
        try:
            content = annot.info.get('content', '')
        except Exception:
            content = ''
        return {'id': annot.xref, 'page': page_index, 'kind': kind,
                'rect': rect, 'color': list(stroke) if stroke else None,
                'content': content}

    # ── search ──────────────────────────────────────────────────────────────
    def search(self, query: str, max_hits: int = 200) -> list:
        """Full-text search. Returns [{page, snippet, count}] (page 0-based)."""
        query = (query or '').strip()
        if not query:
            return []
        results = []
        needle = query.lower()
        with self._lock:
            page_count = self.doc.page_count
            for i in range(page_count):
                if len(results) >= max_hits:
                    break
                try:
                    page = self.doc.load_page(i)
                    text = page.get_text('text')
                except Exception:
                    continue
                low = text.lower()
                pos = low.find(needle)
                if pos == -1:
                    continue
                count = low.count(needle)
                start = max(0, pos - 40)
                end = min(len(text), pos + len(query) + 40)
                snippet = text[start:end].replace('\n', ' ').strip()
                # match rectangles in unrotated page points, for the UI to overlay
                try:
                    rects = [
                        [round(r.x0, 2), round(r.y0, 2), round(r.x1, 2), round(r.y1, 2)]
                        for r in page.search_for(query)
                    ]
                except Exception:
                    rects = []
                results.append({'page': i, 'snippet': snippet, 'count': count, 'rects': rects})
        return results

    # ── word geometry (feeds the selectable text overlay) ────────────────────
    def word_boxes(self, index: int) -> dict:
        """Per-word boxes for one page, for the invisible selectable text layer.

        Returns ``{page, width, height, rotation, words}`` where ``words`` is a
        list of ``[x0, y0, x1, y1, text, line]`` in the page's *displayed*
        coordinate space (points, 1pt = 1/72"; the page's intrinsic /Rotate is
        already applied, matching what ``render_page`` produces). The UI
        multiplies these by its zoom to lay transparent, selectable spans over
        the rendered image, so PDFs gain native drag-select + copy. Words arrive
        in reading order (block, line, word), so a browser selection across them
        flows naturally. ``line`` is a sequential per-page line counter (bumped
        whenever the block or line changes) so the UI can group words into line
        elements — that makes a native copy emit spaces between words and
        newlines between lines.

        ``width``/``height`` are this page's own rect, so a viewer can scale per
        page rather than assuming a uniform size.
        """
        with self._lock:
            n = self.doc.page_count
            if n <= 0:
                return {'page': 0, 'width': 0, 'height': 0, 'rotation': 0, 'words': []}
            index = max(0, min(int(index), n - 1))
            page = self.doc.load_page(index)
            rect = page.rect
            words = []
            try:
                prev_key, line = None, -1
                for w in page.get_text('words'):
                    # (x0, y0, x1, y1, "word", block_no, line_no, word_no)
                    text = w[4]
                    if not text or not text.strip():
                        continue
                    key = (w[5], w[6])
                    if key != prev_key:
                        line += 1
                        prev_key = key
                    words.append([round(w[0], 2), round(w[1], 2),
                                  round(w[2], 2), round(w[3], 2), text, line])
            except Exception:
                words = []
            return {
                'page': index,
                'width': round(rect.width, 2),
                'height': round(rect.height, 2),
                'rotation': int(page.rotation or 0),
                'words': words,
            }

    # ── text extraction (feeds the AI reading tools) ─────────────────────────
    def page_text(self, start: int = 0, end=None, max_chars: int = 24000) -> dict:
        """Plain text for pages [start, end).

        Returns {text, start, end, page_count, truncated}. The total length is
        capped at ``max_chars`` so the AI backend never receives an unbounded
        payload; ``truncated`` signals the UI that the range was cut short.
        """
        with self._lock:
            n = self.doc.page_count
            if n <= 0:
                return {'text': '', 'start': 0, 'end': 0, 'page_count': 0, 'truncated': False}
            start = max(0, min(int(start), n - 1))
            end = n if end is None else max(start + 1, min(int(end), n))
            chunks, total, truncated, reached = [], 0, False, start
            for i in range(start, end):
                try:
                    t = self.doc.load_page(i).get_text('text')
                except Exception:
                    t = ''
                if total + len(t) > max_chars:
                    chunks.append(t[: max(0, max_chars - total)])
                    reached = i + 1
                    truncated = True
                    break
                chunks.append(t)
                total += len(t)
                reached = i + 1
            return {
                'text': '\n'.join(chunks).strip(),
                'start': start,
                'end': reached,
                'page_count': n,
                'truncated': truncated,
            }

    def close(self):
        # Wait for any in-flight render/search to finish before closing the
        # underlying document, so eviction can never free a doc mid-operation.
        with self._lock:
            try:
                self.doc.close()
            except Exception:
                pass


# ── document cache ──────────────────────────────────────────────────────────
_CACHE_MAX = 6
_cache: "OrderedDict[str, tuple]" = OrderedDict()  # path -> (mtime, FitzDoc)
_lock = threading.Lock()


def get_doc(path: str) -> FitzDoc:
    """Return a cached FitzDoc for path, reopening if the file changed."""
    path = str(path)
    try:
        mtime = Path(path).stat().st_mtime
    except OSError:
        mtime = 0.0

    evicted = []  # FitzDocs to close after releasing the global lock
    with _lock:
        cached = _cache.get(path)
        # Keep serving the in-memory doc when it's unchanged on disk OR has unsaved
        # edits OR has been unlocked this session — a dirty doc must never be
        # silently reopened (that would discard edits) and an authenticated doc
        # must never be reopened either (that would re-lock it and force the user
        # to re-enter the password mid-read).
        if cached and (cached[0] == mtime or cached[1].dirty or cached[1].authenticated):
            _cache.move_to_end(path)
            return cached[1]
        # stale or missing — (re)open
        if cached:
            evicted.append(cached[1])
            del _cache[path]
        doc = FitzDoc(path)
        _cache[path] = (mtime, doc)
        _cache.move_to_end(path)
        # Evict the oldest doc that is neither dirty (unsaved edits) nor unlocked
        # this session (re-opening would re-lock it).
        while len(_cache) > _CACHE_MAX:
            victim = next((k for k, (_, d) in _cache.items()
                           if not d.dirty and not d.authenticated), None)
            if victim is None:
                break  # everything cached is protected — keep them all
            _, old = _cache.pop(victim)
            evicted.append(old)

    # Close evicted docs outside the cache lock; FitzDoc.close() blocks on the
    # doc's own lock until any in-flight render finishes, so this must not be
    # held under _lock (would stall every other get_doc caller).
    for old in evicted:
        old.close()
    return doc


def _note_saved(path: str, doc: "FitzDoc") -> None:
    """Refresh a freshly-saved doc's cache mtime so the live (now-clean) object
    is kept on the next access instead of being reopened from disk."""
    path = str(path)
    try:
        mtime = Path(path).stat().st_mtime
    except OSError:
        return
    with _lock:
        cur = _cache.get(path)
        if cur is not None and cur[1] is doc:
            _cache[path] = (mtime, doc)
