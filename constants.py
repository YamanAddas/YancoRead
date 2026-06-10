"""
YancoRead — Shared Constants
Single source of truth for values used across multiple modules.
"""

# App version — used in About screen, packaging, User-Agent
VERSION = '0.0.1'

# App identity
APP_NAME = 'YancoRead'

# GitHub repository (for update checking)
GITHUB_REPO = 'YamanAddas/YancoRead'

# Flask backend port (YancoHub uses 8745; keep ours distinct)
FLASK_PORT = 8746

# ── Document kinds & their extensions ──────────────────────────────────────────
# A "kind" maps to a renderer (backend) + a tool profile (frontend toolbar).
# This is the canonical map; detect.py and the UI both read from it.

KIND_PDF = 'pdf'
KIND_COMIC = 'comic'
KIND_EBOOK = 'ebook'
KIND_OFFICE = 'office'
KIND_TEXT = 'text'
KIND_IMAGE = 'image'
KIND_UNKNOWN = 'unknown'

# Extension → kind. Lowercase, dot-prefixed.
EXT_KIND = {
    # PDF
    '.pdf': KIND_PDF,

    # Comics (archives of ordered images)
    '.cbz': KIND_COMIC, '.cbr': KIND_COMIC, '.cb7': KIND_COMIC,
    '.cbt': KIND_COMIC, '.cba': KIND_COMIC,

    # eBooks (PyMuPDF opens epub/fb2/xps/oxps/mobi)
    '.epub': KIND_EBOOK, '.fb2': KIND_EBOOK, '.xps': KIND_EBOOK,
    '.oxps': KIND_EBOOK, '.mobi': KIND_EBOOK, '.azw': KIND_EBOOK,
    '.azw3': KIND_EBOOK,

    # Office — Word / PowerPoint / Excel + OpenDocument + legacy binary formats.
    # (.docx/.pptx/.xlsx render natively; the rest are routed here only so the
    #  reader can show a graceful "unsupported format" message — see below.)
    '.docx': KIND_OFFICE, '.pptx': KIND_OFFICE, '.xlsx': KIND_OFFICE,
    '.doc': KIND_OFFICE,  '.ppt': KIND_OFFICE,  '.xls': KIND_OFFICE,
    '.rtf': KIND_OFFICE,
    '.odt': KIND_OFFICE,  '.odp': KIND_OFFICE,  '.ods': KIND_OFFICE,

    # Images
    '.png': KIND_IMAGE, '.jpg': KIND_IMAGE, '.jpeg': KIND_IMAGE,
    '.gif': KIND_IMAGE, '.webp': KIND_IMAGE, '.bmp': KIND_IMAGE,
    '.tiff': KIND_IMAGE, '.tif': KIND_IMAGE, '.svg': KIND_IMAGE,
    '.avif': KIND_IMAGE, '.ico': KIND_IMAGE,
}

# Plain-text / code extensions all map to KIND_TEXT. Kept as a set because the
# list is long and we also fall back to KIND_TEXT for anything that sniffs as text.
TEXT_EXTS = {
    '.txt', '.text', '.log', '.md', '.markdown', '.mdown', '.mkd',
    '.rst', '.org', '.tex',
    # data / config
    '.json', '.jsonc', '.json5', '.csv', '.tsv', '.ini', '.cfg', '.conf',
    '.toml', '.yaml', '.yml', '.xml', '.env', '.properties',
    # markup / web
    '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less',
    # source code
    '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.pyw',
    '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp',
    '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.m', '.mm',
    '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd', '.ps1', '.psm1',
    '.sql', '.r', '.lua', '.pl', '.pm', '.dart', '.scala', '.clj',
    '.ex', '.exs', '.erl', '.hs', '.ml', '.vim', '.dockerfile',
    '.gradle', '.makefile', '.cmake', '.gitignore', '.gitattributes',
}

# Map text extensions into EXT_KIND too (so a single dict answers every ext).
for _ext in TEXT_EXTS:
    EXT_KIND.setdefault(_ext, KIND_TEXT)

# Subset of comic extensions by container type (used by the comic renderer)
COMIC_ZIP = {'.cbz', '.cba'}   # zip-based
COMIC_RAR = {'.cbr'}           # rar-based (needs unrar/7z)
COMIC_7Z = {'.cb7'}            # 7z-based
COMIC_TAR = {'.cbt'}           # tar-based

# Image extensions accepted as comic pages inside an archive
COMIC_PAGE_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif'}

# ── Office sub-classification ──────────────────────────────────────────────────
# Formats the native engine renders to HTML
# (mammoth → docx, python-pptx → pptx, openpyxl → xlsx).
OFFICE_NATIVE_EXTS = {'.docx', '.pptx', '.xlsx'}

# Legacy binary + OpenDocument formats. We have no native renderer for these,
# so the reader shows a graceful "unsupported format" message rather than
# failing to open. (Detection still classifies them as office.)
OFFICE_UNSUPPORTED_EXTS = {'.doc', '.ppt', '.xls', '.rtf', '.odt', '.odp', '.ods'}

# ── HTTP / process timeouts (seconds) ──────────────────────────────────────────
HTTP_TIMEOUT_PROBE = 2        # quick reachability checks (backend probes)
FLASK_STARTUP_TIMEOUT = 15    # max wait for Flask to become ready
PROCESS_CLEANUP_TIMEOUT = 3   # max wait for child process to terminate

# Rendering limits
MAX_RENDER_ZOOM = 6.0         # cap page render scale to avoid huge bitmaps
DEFAULT_RENDER_DPI = 110      # base DPI for page rasterization
RECENT_FILES_MAX = 60         # how many recent files to remember

# ── Archive safety (decompression-bomb guards) ─────────────────────────────────
# Comic archives (cbz/cbr/cb7/cbt) and Office files (docx/pptx/xlsx) are all
# containers we decompress on open. A "zip bomb" is a few KB on disk that expands
# to many gigabytes, exhausting memory. We refuse to decompress any single member
# larger than the per-entry cap, or a whole archive whose members sum past the
# total cap. Both limits sit far above any legitimate page image or document part.
MAX_ARCHIVE_ENTRY_BYTES = 512 * 1024 * 1024        # 512 MB — one page image / one XML part
MAX_ARCHIVE_TOTAL_BYTES = 2 * 1024 * 1024 * 1024   # 2 GB  — whole archive, uncompressed

# eBooks (epub/xps/oxps) are ZIP containers PyMuPDF lays out in full on open, and
# layout amplifies the markup ~15-20x in RAM — so a moderate epub (well under the
# byte caps above) can still OOM. We additionally cap the summed uncompressed size
# of the *markup* members (xhtml/html/css/xml/opf/ncx/svg) that drive layout; image
# bytes stay bounded by the per-entry/total caps. 96 MB of markup is ~10x the
# largest real books, so legitimate (even image-heavy) eBooks are unaffected.
MAX_EBOOK_MARKUP_BYTES = 96 * 1024 * 1024          # 96 MB — summed text/markup parts
