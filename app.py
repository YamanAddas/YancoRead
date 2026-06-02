"""
YancoRead — Flask Backend
REST API that routes an opened file to the right renderer and serves pages,
HTML, search, outlines, and user data to the single-page frontend.
"""

import logging
import mimetypes
import os
import secrets
import sys
import threading
from collections import OrderedDict
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, send_file

from constants import (
    VERSION, FLASK_PORT,
    KIND_PDF, KIND_COMIC, KIND_EBOOK, KIND_OFFICE, KIND_TEXT, KIND_IMAGE,
    OFFICE_NATIVE_EXTS,
)
from detect import detect
from signatures import SignatureStore, decode_png_data
from userdata import UserData

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s %(name)s %(levelname)s %(message)s')
logger = logging.getLogger('yancoread.app')

# When frozen by PyInstaller, templates/static are bundled under sys._MEIPASS.
_RES = Path(getattr(sys, '_MEIPASS', Path(__file__).parent))
app = Flask(__name__,
            template_folder=str(_RES / 'templates'),
            static_folder=str(_RES / 'static'))
userdata = UserData()
signatures = SignatureStore()

# Kinds rendered by the PyMuPDF (fitz) engine.
_FITZ_KINDS = {KIND_PDF, KIND_EBOOK}


# ── security: DNS-rebinding guard ──────────────────────────────────────────────
# YancoRead serves arbitrary local file paths (/api/page, /api/image, /api/office,
# …). Although it only binds to 127.0.0.1, a malicious web page the user visits in
# a normal browser could DNS-rebind its own hostname to 127.0.0.1 and POST/GET to
# our port, exfiltrating local files. Browsers cannot forge the Host header, so we
# reject any request whose Host isn't one of our own loopback authorities.
_ALLOWED_HOSTS = {
    f'127.0.0.1:{FLASK_PORT}', f'localhost:{FLASK_PORT}',
    f'[::1]:{FLASK_PORT}', '127.0.0.1', 'localhost', '[::1]',
}

# Per-session API token, minted at startup and injected into our own page. The
# Host guard stops cross-origin BROWSERS (they can't forge Host); this token
# additionally stops *other local processes* and any residual cross-origin call
# from triggering state-changing endpoints (arbitrary file write, etc.) — they
# don't have the token. Read-only GETs (page/image renders, loaded via <img>,
# which can't carry custom headers) stay gated by the Host guard + path checks.
_API_TOKEN = secrets.token_urlsafe(32)
_TOKEN_METHODS = {'POST', 'PUT', 'PATCH', 'DELETE'}
# /api/open-external is POSTed by a *second* launch process (single-instance file
# forwarding), which has no token; it only navigates the window to open a file
# (no write, no data returned), so it's exempt from the token gate.
_TOKEN_EXEMPT = {'/api/open-external'}


@app.before_request
def _guard_request():
    host = (request.host or '').lower()
    if host not in _ALLOWED_HOSTS:
        logger.warning("rejected request with Host header %r", request.host)
        return _err('Forbidden host', 403)
    if (request.method in _TOKEN_METHODS and request.path.startswith('/api/')
            and request.path not in _TOKEN_EXEMPT
            and not secrets.compare_digest(request.headers.get('X-YR-Token', ''), _API_TOKEN)):
        logger.warning("rejected %s %s — missing/invalid API token", request.method, request.path)
        return _err('Forbidden', 403)
    return None


# ── helpers ───────────────────────────────────────────────────────────────────
def _err(message: str, code: int = 400):
    return jsonify({'error': message}), code


def _require_path(args) -> Path | None:
    """Validate a path arg points at an existing file. Returns Path or None."""
    raw = args.get('path', '')
    if not raw:
        return None
    p = Path(raw)
    if not p.is_file():
        return None
    return p


# ── shell ──────────────────────────────────────────────────────────────────────
@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'version': VERSION})


@app.route('/')
def index():
    return render_template('index.html', version=VERSION, api_token=_API_TOKEN)


@app.route('/api/launch-file')
def launch_file():
    """Path of a file passed on the command line at startup (or empty)."""
    return jsonify({'path': os.environ.get('YANCOREAD_OPEN', '')})


@app.route('/api/open-external', methods=['POST'])
def open_external():
    """Open a file in the already-running instance (single-instance forwarding).
    Works in a frozen build where Flask shares the process with the window."""
    body = request.get_json(silent=True) or {}
    path = (body.get('path') or '').strip()
    if not path:
        return _err('No path')
    try:
        import json as _json
        import webview
        if webview.windows:
            win = webview.windows[0]
            win.evaluate_js(f'window.YR && YR.openFile({_json.dumps(path)})')
            try:
                win.restore()
                win.on_top = True
                win.on_top = False
            except Exception:
                pass
            return jsonify({'status': 'ok'})
    except Exception as e:
        logger.debug("open-external could not reach window: %s", e)
    return _err('No window to receive the file', 503)


# ── open / detect ───────────────────────────────────────────────────────────────
@app.route('/api/open', methods=['POST'])
def api_open():
    body = request.get_json(silent=True) or {}
    path = body.get('path', '')
    info = detect(path)
    if not info['exists']:
        return _err(f'File not found: {path}', 404)
    if info['kind'] == 'unknown':
        return _err(f'Unsupported file type: {info["ext"] or info["name"]}', 415)

    kind = info['kind']
    meta = {}
    try:
        if kind in _FITZ_KINDS:
            from renderers.fitzdoc import get_doc
            doc = get_doc(info['path'])
            meta = doc.info()
            if meta.get('locked'):
                # Password-protected: pages can't be read until the user
                # authenticates. Skip page_size (it would raise) and tell the
                # client to prompt. Not added to recents yet — the re-open after
                # a successful unlock records it.
                return jsonify({
                    'status': 'locked',
                    'path': info['path'],
                    'name': info['name'],
                    'kind': kind,
                })
            meta['page_size'] = doc.page_size(0)
        elif kind == KIND_COMIC:
            from renderers.comicdoc import get_doc
            meta = get_doc(info['path']).info()
        elif kind == KIND_OFFICE:
            meta = _office_meta(info['path'], info['ext'])
    except Exception as e:
        logger.exception("open failed for %s", path)
        return _err(f'Could not open file: {e}', 500)

    userdata.add_recent(info['path'], info['name'], kind)
    position, progress = userdata.get_position(info['path'])

    return jsonify({
        'status': 'ok',
        'doc': {
            **info,
            'meta': meta,
            'prefs': userdata.get_prefs(kind),
            'file_prefs': userdata.get_file_prefs(info['path']),
            'position': position,
            'progress': progress,
            'bookmarks': userdata.get_bookmarks(info['path']),
        },
    })


@app.route('/api/unlock', methods=['POST'])
def api_unlock():
    """Authenticate a password-protected document so it can be opened.
    Body: {path, password}. The password is used only to authenticate the
    in-memory document — it is never stored or logged. On success the client
    re-opens the file (now unlocked) to render it. Returns {ok:true} or a 403
    'incorrect password' for retry."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    password = body.get('password') or ''
    if not raw:
        return _err('Missing path')
    info = detect(raw)
    if not info['exists']:
        return _err(f'File not found: {raw}', 404)
    if info['kind'] not in _FITZ_KINDS:
        return _err('This file type is not password-protected', 415)
    try:
        from renderers.fitzdoc import get_doc
        ok = get_doc(info['path']).unlock(password)
    except Exception as e:
        logger.exception("unlock failed for %s", raw)
        return _err(f'Could not open file: {e}', 500)
    if not ok:
        return _err('Incorrect password — please try again.', 403)
    return jsonify({'ok': True})


# ── fitz: pages, outline, search, reflow (PDF + eBook) ───────────────────────────
@app.route('/api/page')
def api_page():
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        index = int(request.args.get('index', 0))
        zoom = float(request.args.get('zoom', 1.0))
        rotate = int(request.args.get('rot', 0))
    except ValueError:
        return _err('index, zoom and rot must be numbers')
    try:
        from renderers.fitzdoc import get_doc
        png = get_doc(str(p)).render_page(index, zoom, rotate)
    except Exception as e:
        logger.exception("render page failed")
        return _err(f'Render failed: {e}', 500)
    resp = Response(png, mimetype='image/png')
    resp.headers['Cache-Control'] = 'private, max-age=120'
    return resp


@app.route('/api/outline')
def api_outline():
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    from renderers.fitzdoc import get_doc
    return jsonify({'outline': get_doc(str(p)).outline()})


@app.route('/api/search')
def api_search():
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    q = request.args.get('q', '')
    from renderers.fitzdoc import get_doc
    return jsonify({'results': get_doc(str(p)).search(q)})


@app.route('/api/pdf/words')
def api_pdf_words():
    """Per-word boxes for one page — feeds the PDF reader's selectable text layer.

    Query: path, page (0-based). Returns {page, width, height, rotation, words}
    with words as [x0, y0, x1, y1, text] in displayed page points. Fetched
    lazily by the viewer (one page at a time, as pages scroll into view).
    """
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        page = int(request.args.get('page', 0))
    except (TypeError, ValueError):
        page = 0
    try:
        from renderers.fitzdoc import get_doc
        return jsonify(get_doc(str(p)).word_boxes(page))
    except Exception as e:
        logger.exception("pdf-words failed")
        return _err(f'Could not read word boxes: {e}', 500)


@app.route('/api/relayout', methods=['POST'])
def api_relayout():
    body = request.get_json(silent=True) or {}
    path = body.get('path', '')
    if not Path(path).is_file():
        return _err('Missing or invalid path')
    try:
        fontsize = int(body.get('fontsize', 11))
    except (TypeError, ValueError):
        return _err('fontsize must be an integer')
    from renderers.fitzdoc import get_doc
    return jsonify({'page_count': get_doc(path).relayout(fontsize)})


@app.route('/api/doc-text')
def api_doc_text():
    """Plain text for a page range of a fitz document (PDF/eBook).

    Feeds the eBook/PDF AI reading tools and the PDF "copy text" actions.
    Query: path, start, end (end optional), max (optional char cap — the AI
    callers leave it at the 24k default; the copy-text actions raise it).
    """
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        start = int(request.args.get('start', 0))
    except (TypeError, ValueError):
        start = 0
    end_arg = request.args.get('end')
    try:
        end = int(end_arg) if end_arg not in (None, '') else None
    except (TypeError, ValueError):
        end = None
    try:
        max_chars = int(request.args.get('max', 24000))
    except (TypeError, ValueError):
        max_chars = 24000
    max_chars = max(1000, min(max_chars, 2_000_000))
    try:
        from renderers.fitzdoc import get_doc
        return jsonify(get_doc(str(p)).page_text(start, end, max_chars))
    except Exception as e:
        logger.exception("doc-text failed")
        return _err(f'Could not read text: {e}', 500)


@app.route('/api/pdf-info')
def api_pdf_info():
    """Full document properties for the PDF reader's Info panel."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        from renderers.fitzdoc import get_doc
        return jsonify(get_doc(str(p)).properties())
    except Exception as e:
        logger.exception("pdf-info failed")
        return _err(f'Could not read document info: {e}', 500)


@app.route('/api/pdf/save', methods=['POST'])
def api_pdf_save():
    """Save in-memory edits (annotations, etc.) back to the PDF, in place.
    Incremental + append-only, so the original bytes are preserved. No-op when
    there are no unsaved edits."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    if not raw:
        return _err('Missing path')
    dest = Path(raw)
    if not dest.is_file():
        return _err('File not found')
    if dest.suffix.lower() != '.pdf':
        return _err('Only PDF files can be saved here')
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(dest)).save()
    except PermissionError:
        return _err('Could not save — the file may be open in another program.', 423)
    except (ValueError, RuntimeError) as e:
        return _err(str(e), 409)
    except Exception as e:
        logger.exception("pdf save failed")
        return _err(f'Could not save PDF: {e}', 500)
    return jsonify({'ok': True, 'path': str(dest), 'name': dest.name, **res})


@app.route('/api/pdf/save-copy', methods=['POST'])
def api_pdf_save_copy():
    """Write the current PDF state (including unsaved edits) to a new file.
    Never touches the original — used for 'Save a Copy' and as the fallback for
    PDFs that can't be updated in place."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    target = (body.get('target') or '').strip()
    if not raw:
        return _err('Missing path')
    src = Path(raw)
    if not src.is_file():
        return _err('Source file not found')
    if not target:
        return _err('No save target provided')
    dest = Path(target)
    if dest.suffix.lower() != '.pdf':
        dest = dest.with_suffix('.pdf')
    if not dest.parent.is_dir():
        return _err('Target folder does not exist')
    if dest.resolve() == src.resolve():
        return _err('Choose a different file for the copy', 409)
    try:
        from renderers.fitzdoc import get_doc
        get_doc(str(src)).save_copy(str(dest))
    except PermissionError:
        return _err('Could not write the copy — the target may be locked.', 423)
    except Exception as e:
        logger.exception("pdf save-copy failed")
        return _err(f'Could not save copy: {e}', 500)
    return jsonify({'ok': True, 'path': str(dest), 'name': dest.name})


@app.route('/api/pdf/annotations')
def api_pdf_annotations():
    """List annotations. With ?page=N → just that page; omit page (or page=all)
    → every annotation in the document (for the annotation manager)."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    raw_page = request.args.get('page')
    want_all = raw_page is None or str(raw_page).strip().lower() == 'all'
    index = 0
    if not want_all:
        try:
            index = int(raw_page)
        except (ValueError, TypeError):
            return _err('page must be a number')
    try:
        from renderers.fitzdoc import get_doc
        doc = get_doc(str(p))
        annots = doc.all_annotations() if want_all else doc.annotations(index)
        return jsonify({'annotations': annots})
    except Exception as e:
        logger.exception("pdf annotations failed")
        return _err(f'Could not read annotations: {e}', 500)


@app.route('/api/pdf/annotate', methods=['POST'])
def api_pdf_annotate():
    """Add one annotation to a PDF page (in memory — call /api/pdf/save to
    persist). Body: {path, page, kind, rects/points/strokes/point, color, …}."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    if not raw:
        return _err('Missing path')
    p = Path(raw)
    if not p.is_file():
        return _err('File not found')
    if p.suffix.lower() != '.pdf':
        return _err('Annotations are only supported on PDF files')
    try:
        index = int(body.get('page', 0))
    except (ValueError, TypeError):
        return _err('page must be a number')
    try:
        from renderers.fitzdoc import get_doc
        annot = get_doc(str(p)).add_annotation(index, body)
    except ValueError as e:
        return _err(str(e), 400)
    except Exception as e:
        logger.exception("pdf annotate failed")
        return _err(f'Could not add annotation: {e}', 500)
    return jsonify({'ok': True, 'annotation': annot})


@app.route('/api/pdf/annotation/delete', methods=['POST'])
def api_pdf_annotation_delete():
    """Delete a PDF annotation by xref id (in memory — save to persist)."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    if not raw:
        return _err('Missing path')
    p = Path(raw)
    if not p.is_file():
        return _err('File not found')
    try:
        index = int(body.get('page', 0))
        xref = int(body.get('id'))
    except (ValueError, TypeError):
        return _err('page and id must be numbers')
    try:
        from renderers.fitzdoc import get_doc
        ok = get_doc(str(p)).delete_annotation(index, xref)
    except Exception as e:
        logger.exception("pdf annotation delete failed")
        return _err(f'Could not delete annotation: {e}', 500)
    if not ok:
        return _err('Annotation not found', 404)
    return jsonify({'ok': True})


@app.route('/api/pdf/annotation/update', methods=['POST'])
def api_pdf_annotation_update():
    """Edit an existing annotation's note text and/or color by xref id (in
    memory — call /api/pdf/save to persist). Body: {path, page, id, text?, color?}."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    if not raw:
        return _err('Missing path')
    p = Path(raw)
    if not p.is_file():
        return _err('File not found')
    try:
        index = int(body.get('page', 0))
        xref = int(body.get('id'))
    except (ValueError, TypeError):
        return _err('page and id must be numbers')
    try:
        from renderers.fitzdoc import get_doc
        desc = get_doc(str(p)).update_annotation(index, xref, body)
    except Exception as e:
        logger.exception("pdf annotation update failed")
        return _err(f'Could not update annotation: {e}', 500)
    if desc is None:
        return _err('Annotation not found', 404)
    return jsonify({'ok': True, 'annotation': desc})


@app.route('/api/pdf/annotations/export', methods=['POST'])
def api_pdf_annotations_export():
    """Write every annotation in the document to a sidecar file. Body:
    {path, fmt=json|xfdf, dest?}. With no dest, writes alongside the source as
    <stem>-annotations.<fmt> (same convention as compress/split). JSON is
    YancoRead-native (full fidelity); XFDF is the Adobe interchange format other
    PDF tools read. Never mutates the source PDF."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    if not raw:
        return _err('Missing path')
    p = Path(raw)
    if not p.is_file():
        return _err('File not found')
    fmt = (body.get('fmt') or 'json').strip().lower()
    if fmt not in ('json', 'xfdf'):
        return _err('fmt must be json or xfdf')
    dest = (body.get('dest') or '').strip()
    outp = Path(dest) if dest else p.with_name(p.stem + '-annotations.' + fmt)
    try:
        from renderers.fitzdoc import get_doc
        content = get_doc(str(p)).export_annotations(fmt)
        outp.write_text(content, encoding='utf-8')
    except Exception as e:
        logger.exception("pdf annotation export failed")
        return _err(f'Could not export annotations: {e}', 500)
    return jsonify({'ok': True, 'name': outp.name, 'dest': str(outp), 'fmt': fmt})


@app.route('/api/pdf/annotations/import', methods=['POST'])
def api_pdf_annotations_import():
    """Import annotations from a JSON or XFDF payload into the in-memory doc
    (call /api/pdf/save to persist). Body: {path, fmt?, data}. `fmt` is inferred
    from the data when omitted. Returns {added, skipped, total}."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    if not raw:
        return _err('Missing path')
    p = Path(raw)
    if not p.is_file():
        return _err('File not found')
    data = body.get('data')
    if not data or not str(data).strip():
        return _err('No annotation data provided')
    fmt = (body.get('fmt') or '').strip().lower()
    if fmt not in ('json', 'xfdf'):
        fmt = 'xfdf' if str(data).lstrip()[:200].lower().lstrip('﻿').startswith(('<?xml', '<xfdf')) else 'json'
    try:
        from renderers.fitzdoc import get_doc
        report = get_doc(str(p)).import_annotations(data, fmt)
    except ValueError as e:
        return _err(str(e))
    except Exception as e:
        logger.exception("pdf annotation import failed")
        return _err(f'Could not import annotations: {e}', 500)
    return jsonify({'ok': True, 'fmt': fmt, **report})


@app.route('/api/pdf/rotate-page', methods=['POST'])
def api_pdf_rotate_page():
    """Rotate a single PDF page and persist it as the page's /Rotate (in memory
    — call /api/pdf/save to write it). Body: {path, page, delta?, rotate?}."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    if not raw:
        return _err('Missing path')
    p = Path(raw)
    if not p.is_file():
        return _err('File not found')
    if p.suffix.lower() != '.pdf':
        return _err('Only PDF pages can be rotated')
    try:
        index = int(body.get('page', 0))
        delta = int(body.get('delta', 90))
        absolute = body.get('rotate', None)
        absolute = None if absolute is None else int(absolute)
    except (ValueError, TypeError):
        return _err('page/delta/rotate must be numbers')
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(p)).rotate_page(index, delta=delta, absolute=absolute)
    except ValueError as e:
        return _err(str(e), 400)
    except Exception as e:
        logger.exception("pdf rotate-page failed")
        return _err(f'Could not rotate page: {e}', 500)
    return jsonify({'ok': True, **res})


@app.route('/api/pdf/organize', methods=['POST'])
def api_pdf_organize():
    """Assemble a reorganized copy of a PDF from a page plan and write it to a
    NEW file — never mutates the original. Body: {path, target, plan:[{src,
    rotate}]}. `plan` order is the output order; omitted source pages are
    dropped, repeated ones duplicated; `rotate` is a delta on the source page."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    target = (body.get('target') or '').strip()
    if not raw:
        return _err('Missing path')
    src = Path(raw)
    if not src.is_file():
        return _err('Source file not found')
    if src.suffix.lower() != '.pdf':
        return _err('Only PDF files can be organized')
    if not target:
        return _err('No save target provided')
    dest = Path(target)
    if dest.suffix.lower() != '.pdf':
        dest = dest.with_suffix('.pdf')
    if not dest.parent.is_dir():
        return _err('Target folder does not exist')
    if dest.resolve() == src.resolve():
        return _err('Choose a different file for the organized copy', 409)
    plan = body.get('plan')
    if not isinstance(plan, list) or not plan:
        return _err('The page plan is empty')
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(src)).export_arranged(str(dest), plan)
    except ValueError as e:
        return _err(str(e), 400)
    except PermissionError:
        return _err('Could not write the file — the target may be locked.', 423)
    except Exception as e:
        logger.exception("pdf organize failed")
        return _err(f'Could not organize PDF: {e}', 500)
    return jsonify({'ok': True, **res})


@app.route('/api/pdf/merge', methods=['POST'])
def api_pdf_merge():
    """Concatenate several PDFs into a NEW file — never mutates any source.
    Body: {path, target, sequence}. `sequence` is an ordered list whose items are
    either the literal 'self' (this open document, with its unsaved edits) or a
    path to another PDF; every part is appended whole, in order."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    target = (body.get('target') or '').strip()
    if not raw:
        return _err('Missing path')
    src = Path(raw)
    if not src.is_file():
        return _err('Source file not found')
    if src.suffix.lower() != '.pdf':
        return _err('Only PDF files can be merged')
    if not target:
        return _err('No save target provided')
    dest = Path(target)
    if dest.suffix.lower() != '.pdf':
        dest = dest.with_suffix('.pdf')
    if not dest.parent.is_dir():
        return _err('Target folder does not exist')
    sequence = body.get('sequence')
    if not isinstance(sequence, list) or not sequence:
        return _err('Nothing to merge')
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(src)).merge(str(dest), sequence)
    except ValueError as e:
        return _err(str(e), 400)
    except PermissionError:
        return _err('Could not write the file — the target may be locked.', 423)
    except Exception as e:
        logger.exception("pdf merge failed")
        return _err(f'Could not merge PDFs: {e}', 500)
    return jsonify({'ok': True, **res})


@app.route('/api/pdf/split', methods=['POST'])
def api_pdf_split():
    """Write one NEW PDF per page range into a folder — never mutates the source.
    Body: {path, dir, ranges, stem?}. `ranges` is a list of [first, last] 0-based
    inclusive page indices (same convention as /organize); `stem` (optional)
    names the output files."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    out_dir = (body.get('dir') or '').strip()
    if not raw:
        return _err('Missing path')
    src = Path(raw)
    if not src.is_file():
        return _err('Source file not found')
    if src.suffix.lower() != '.pdf':
        return _err('Only PDF files can be split')
    if not out_dir:
        return _err('No output folder provided')
    if not Path(out_dir).is_dir():
        return _err('Output folder does not exist')
    ranges = body.get('ranges')
    if not isinstance(ranges, list) or not ranges:
        return _err('No page ranges to split')
    stem = (body.get('stem') or '').strip() or None
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(src)).split(out_dir, ranges, stem)
    except ValueError as e:
        return _err(str(e), 400)
    except PermissionError:
        return _err('Could not write the files — the folder may be locked.', 423)
    except Exception as e:
        logger.exception("pdf split failed")
        return _err(f'Could not split PDF: {e}', 500)
    return jsonify({'ok': True, **res})


@app.route('/api/pdf/export-images', methods=['POST'])
def api_pdf_export_images():
    """Render PDF pages to image files (PNG/JPG) in a folder — never mutates the
    source. Body: {path, dir, pages?, format?, dpi?, stem?}. `pages` is a list of
    0-based page indices (omitted or empty = every page)."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    out_dir = (body.get('dir') or '').strip()
    if not raw:
        return _err('Missing path')
    src = Path(raw)
    if not src.is_file():
        return _err('Source file not found')
    if src.suffix.lower() != '.pdf':
        return _err('Only PDF files can be exported as images')
    if not out_dir:
        return _err('No output folder provided')
    if not Path(out_dir).is_dir():
        return _err('Output folder does not exist')
    pages = body.get('pages')
    if pages is not None and not isinstance(pages, list):
        return _err('pages must be a list of page numbers')
    fmt = body.get('format') or 'png'
    dpi = body.get('dpi', 150)
    stem = (body.get('stem') or '').strip() or None
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(src)).export_images(out_dir, pages, fmt, dpi, stem)
    except ValueError as e:
        return _err(str(e), 400)
    except PermissionError:
        return _err('Could not write the images — the folder may be locked.', 423)
    except Exception as e:
        logger.exception("pdf export-images failed")
        return _err(f'Could not export images: {e}', 500)
    return jsonify({'ok': True, **res})


@app.route('/api/pdf/compress', methods=['POST'])
def api_pdf_compress():
    """Write a size-optimised COPY of a PDF — never mutates the source.
    Body: {path, target, level?}. `target` is the destination .pdf path; `level`
    is one of light|balanced|strong. Returns before/after byte sizes + percent
    saved."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    target = (body.get('target') or '').strip()
    level = (body.get('level') or 'balanced').strip()
    if not raw:
        return _err('Missing path')
    src = Path(raw)
    if not src.is_file():
        return _err('Source file not found')
    if src.suffix.lower() != '.pdf':
        return _err('Only PDF files can be compressed')
    if not target:
        return _err('No destination provided')
    tgt = Path(target)
    if tgt.suffix.lower() != '.pdf':
        return _err('Destination must be a .pdf file')
    if not tgt.parent.is_dir():
        return _err('Destination folder does not exist')
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(src)).compress(target, level)
    except ValueError as e:
        return _err(str(e), 400)
    except PermissionError:
        return _err('Could not write the file — it may be open or the folder is locked.', 423)
    except Exception as e:
        logger.exception("pdf compress failed")
        return _err(f'Could not compress PDF: {e}', 500)
    return jsonify({'ok': True, **res})


@app.route('/api/pdf/redact', methods=['POST'])
def api_pdf_redact():
    """Write a permanently-redacted COPY of a PDF — never mutates the source.
    Body: {path, target, regions:[{page, rects:[[x0,y0,x1,y1]]}], scrub?,
    remove_images?, fill?}. Each rect (in unrotated PDF points — the same space
    the annotate route and selectable text layer use) has its underlying text,
    vector art and (when remove_images, default true) image pixels REMOVED, then
    a solid fill (default black) painted over it. `scrub` also strips metadata
    and embedded JS. Returns the new path/name plus page & box counts."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    target = (body.get('target') or '').strip()
    if not raw:
        return _err('Missing path')
    src = Path(raw)
    if not src.is_file():
        return _err('Source file not found')
    if src.suffix.lower() != '.pdf':
        return _err('Only PDF files can be redacted')
    if not target:
        return _err('No destination provided')
    tgt = Path(target)
    if tgt.suffix.lower() != '.pdf':
        return _err('Destination must be a .pdf file')
    if not tgt.parent.is_dir():
        return _err('Destination folder does not exist')
    if tgt.resolve() == src.resolve():
        return _err('Choose a different file for the redacted copy', 409)
    regions = body.get('regions')
    if not isinstance(regions, list) or not regions:
        return _err('No redaction areas given')
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(src)).redact(
            target, regions,
            fill=body.get('fill'),
            scrub=bool(body.get('scrub', False)),
            remove_images=bool(body.get('remove_images', True)))
    except ValueError as e:
        return _err(str(e), 400)
    except PermissionError:
        return _err('Could not write the file — it may be open or the folder is locked.', 423)
    except Exception as e:
        logger.exception("pdf redact failed")
        return _err(f'Could not redact PDF: {e}', 500)
    return jsonify({'ok': True, **res})


@app.route('/api/pdf/ocr', methods=['POST'])
def api_pdf_ocr():
    """Write a searchable COPY of a (scanned) PDF — never mutates the source.
    Body: {path, target, language?, pages?, dpi?, skip_text?}. Rasterises the
    selected image pages, runs Tesseract, and lays an invisible text layer behind
    them so the words become selectable/searchable. `language` is a Tesseract code
    like 'eng' or 'eng+ara'; `pages` is an optional list of 0-based indices (omit =
    all); `skip_text` (default true) leaves pages that already have real text
    untouched. Returns page counts (total/ocr'd/skipped) + before/after sizes."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    target = (body.get('target') or '').strip()
    language = (body.get('language') or 'eng').strip() or 'eng'
    if not raw:
        return _err('Missing path')
    src = Path(raw)
    if not src.is_file():
        return _err('Source file not found')
    if src.suffix.lower() != '.pdf':
        return _err('Only PDF files can be made searchable')
    if not target:
        return _err('No destination provided')
    tgt = Path(target)
    if tgt.suffix.lower() != '.pdf':
        return _err('Destination must be a .pdf file')
    if not tgt.parent.is_dir():
        return _err('Destination folder does not exist')
    pages = body.get('pages')
    if pages is not None:
        if not isinstance(pages, list):
            return _err('pages must be a list of page numbers')
        try:
            pages = [int(p) for p in pages]
        except (TypeError, ValueError):
            return _err('pages must be whole numbers')
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(src)).ocr(target, language=language, pages=pages,
                                    dpi=body.get('dpi', 300),
                                    skip_text=bool(body.get('skip_text', True)))
    except ValueError as e:
        return _err(str(e), 400)
    except PermissionError:
        return _err('Could not write the file — it may be open or the folder is locked.', 423)
    except Exception as e:
        logger.exception("pdf ocr failed")
        return _err(f'Could not OCR PDF: {e}', 500)
    return jsonify({'ok': True, **res})


# ── signatures (PDF sign & stamp) ─────────────────────────────────────────────────
@app.route('/api/signatures')
def api_signatures_list():
    """List the user's reusable signatures. The library lives in the per-user
    data dir (outside the repo) — signatures are personal data."""
    try:
        return jsonify({'signatures': signatures.list()})
    except Exception as e:
        logger.exception("signature list failed")
        return _err(f'Could not list signatures: {e}', 500)


@app.route('/api/signatures', methods=['POST'])
def api_signatures_save():
    """Save a new signature PNG to the library. Body: {png, name?, kind?}.
    `png` is a data URL or base64 PNG (drawn on a canvas, typed, or imported)."""
    body = request.get_json(silent=True) or {}
    try:
        png = decode_png_data(body.get('png'))
        entry = signatures.add(png, name=body.get('name', ''),
                               kind=body.get('kind', 'draw'))
    except ValueError as e:
        return _err(str(e), 400)
    except Exception as e:
        logger.exception("signature save failed")
        return _err(f'Could not save signature: {e}', 500)
    return jsonify({'ok': True, 'signature': entry})


@app.route('/api/signatures/<sig_id>.png')
def api_signature_png(sig_id):
    """Serve a stored signature's PNG bytes (library thumbnail / placement preview)."""
    try:
        data = signatures.png(sig_id)
    except KeyError:
        return _err('Signature not found', 404)
    except ValueError as e:
        return _err(str(e), 400)
    except Exception as e:
        logger.exception("signature png failed")
        return _err(f'Could not read signature: {e}', 500)
    return Response(data, mimetype='image/png', headers={'Cache-Control': 'no-store'})


@app.route('/api/signatures/delete', methods=['POST'])
def api_signature_delete():
    """Remove a signature from the library. Body: {id}."""
    body = request.get_json(silent=True) or {}
    sig_id = (body.get('id') or '').strip()
    if not sig_id:
        return _err('Missing signature id')
    try:
        ok = signatures.delete(sig_id)
    except Exception as e:
        logger.exception("signature delete failed")
        return _err(f'Could not delete signature: {e}', 500)
    if not ok:
        return _err('Signature not found', 404)
    return jsonify({'ok': True})


@app.route('/api/pdf/stamp', methods=['POST'])
def api_pdf_stamp():
    """Stamp an image (a signature) onto a PDF page in memory — call
    /api/pdf/save to persist. Body: {path, page, rect:[x0,y0,x1,y1],
    signature?|png?, keep_proportion?, rotate?}. Provide either a saved
    `signature` id from the library or an inline `png` (data URL / base64)."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    if not raw:
        return _err('Missing path')
    p = Path(raw)
    if not p.is_file():
        return _err('File not found')
    if p.suffix.lower() != '.pdf':
        return _err('Signatures can only be stamped onto PDF files')
    try:
        index = int(body.get('page', 0))
    except (ValueError, TypeError):
        return _err('page must be a number')
    rect = body.get('rect')
    if not isinstance(rect, (list, tuple)) or len(rect) != 4:
        return _err('rect must be [x0, y0, x1, y1]')
    try:
        rect = [float(v) for v in rect]
    except (ValueError, TypeError):
        return _err('rect values must be numbers')
    # image source: a saved signature id, or an inline png payload
    sig_id = (body.get('signature') or '').strip()
    try:
        png = signatures.png(sig_id) if sig_id else decode_png_data(body.get('png'))
    except KeyError:
        return _err('Signature not found', 404)
    except ValueError as e:
        return _err(str(e), 400)
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(p)).place_image(
            index, rect, png,
            keep_proportion=bool(body.get('keep_proportion', True)),
            rotate=body.get('rotate', 0))
    except ValueError as e:
        return _err(str(e), 400)
    except Exception as e:
        logger.exception("pdf stamp failed")
        return _err(f'Could not stamp the PDF: {e}', 500)
    return jsonify({'ok': True, **res})


@app.route('/api/pdf/fields')
def api_pdf_fields():
    """List interactive form fields (AcroForm widgets) in a PDF.
    Returns {is_form, fields:[{page,name,kind,value,rect,...}]}."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    if Path(str(p)).suffix.lower() != '.pdf':
        return jsonify({'is_form': False, 'fields': []})
    try:
        from renderers.fitzdoc import get_doc
        return jsonify(get_doc(str(p)).form_fields())
    except Exception as e:
        logger.exception("pdf fields failed")
        return _err(f'Could not read form fields: {e}', 500)


@app.route('/api/pdf/field', methods=['POST'])
def api_pdf_field():
    """Set one form field's value in memory — call /api/pdf/save to persist.
    Body: {path, page, name, value}."""
    body = request.get_json(silent=True) or {}
    raw = (body.get('path') or '').strip()
    if not raw:
        return _err('Missing path')
    p = Path(raw)
    if not p.is_file():
        return _err('File not found')
    if p.suffix.lower() != '.pdf':
        return _err('Form fields are only on PDF files')
    name = (body.get('name') or '').strip()
    if not name:
        return _err('Missing field name')
    try:
        index = int(body.get('page', 0))
    except (ValueError, TypeError):
        return _err('page must be a number')
    try:
        from renderers.fitzdoc import get_doc
        res = get_doc(str(p)).set_field(index, name, body.get('value'))
    except KeyError:
        return _err('Field not found', 404)
    except ValueError as e:
        return _err(str(e), 400)
    except Exception as e:
        logger.exception("pdf set field failed")
        return _err(f'Could not set field: {e}', 500)
    return jsonify({'ok': True, **res})


# ── comics ──────────────────────────────────────────────────────────────────────
@app.route('/api/comic-page')
def api_comic_page():
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        index = int(request.args.get('index', 0))
    except ValueError:
        return _err('index must be a number')
    try:
        from renderers.comicdoc import get_doc
        data, mime = get_doc(str(p)).get_page(index)
    except Exception as e:
        logger.exception("comic page failed")
        return _err(f'Could not read page: {e}', 500)
    if request.args.get('enhance', '').lower() in ('1', 'true', 'yes'):
        from renderers import enhance
        data = enhance.enhance_cached((str(p), index), data)
        mime = 'image/png'
    resp = Response(data, mimetype=mime)
    resp.headers['Cache-Control'] = 'private, max-age=300'
    return resp


@app.route('/api/comic-panels')
def api_comic_panels():
    """Detected panel boxes for a comic page (for Guided View)."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        index = int(request.args.get('index', 0))
    except ValueError:
        return _err('index must be a number')
    rtl = request.args.get('rtl', '').lower() in ('1', 'true', 'yes')
    try:
        from renderers.comicdoc import get_doc
        from renderers import panels
        data, _ = get_doc(str(p)).get_page(index)
        boxes = panels.get_panels(str(p), index, data, rtl)
    except Exception as e:
        logger.exception("panel detection failed")
        return _err(f'Panel detection failed: {e}', 500)
    return jsonify({'panels': boxes, 'count': len(boxes)})


# Vision-LLM results are slow/costly — cache per (path,index,rtl,target,source).
_VISION_CACHE_MAX = 256
_vision_cache = OrderedDict()
_vision_lock = threading.Lock()


def _vision_blocks(path, index, rtl, target):
    key = (str(path), int(index), bool(rtl), target or '')
    with _vision_lock:
        if key in _vision_cache:
            _vision_cache.move_to_end(key)
            return _vision_cache[key]
    from renderers.comicdoc import get_doc
    from renderers import llm
    data, _ = get_doc(str(path)).get_page(index)
    blocks = llm.vision_read(_ai_cfg(), data, rtl, target or '')
    with _vision_lock:
        _vision_cache[key] = blocks
        _vision_cache.move_to_end(key)
        while len(_vision_cache) > _VISION_CACHE_MAX:
            _vision_cache.popitem(last=False)
    return blocks


def _tesseract_blocks(path, index, rtl, lang=None):
    """OCR a comic page with Tesseract. Returns (blocks, lang_used).

    For RTL comics (Arabic/Hebrew/manga) we run the script's own model ALONE —
    mixing in 'eng' measurably degrades the Arabic LSTM — and only add English
    for LTR pages. Vision OCR is the universal default; this is the offline
    fallback, so it is honest about being best on clean Latin/Arabic print.
    """
    from renderers.comicdoc import get_doc
    from renderers import textregions, comicdir
    comicdir.tesseract_available()  # ensure pytesseract.tesseract_cmd is set
    import pytesseract
    try:
        installed = set(pytesseract.get_languages(config=comicdir.ocr_config()))
    except Exception:
        installed = {'eng'}
    if not lang:
        if rtl and 'ara' in installed:
            lang = 'ara'            # Arabic alone — don't dilute with eng
        elif 'eng' in installed:
            lang = 'eng'
        else:
            lang = next(iter(installed - {'osd'}), 'eng')
    data, _ = get_doc(str(path)).get_page(index)
    return textregions.get_blocks(str(path), index, data, lang, rtl), lang


def _vision_preferred() -> bool:
    return userdata.get_settings().get('ocr_source') == 'vision'


@app.route('/api/comic-ocr')
def api_comic_ocr():
    """OCR a comic page into text blocks (no translation) — for read-aloud."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        index = int(request.args.get('index', 0))
    except ValueError:
        return _err('index must be a number')
    rtl = request.args.get('rtl', '').lower() in ('1', 'true', 'yes')
    req_lang = request.args.get('lang')
    try:
        if _vision_preferred():
            try:
                return jsonify({'blocks': _vision_blocks(p, index, rtl, ''), 'source': 'vision'})
            except Exception as e:
                # Vision is the universal default, but the LLM may be unreachable —
                # fall back to Tesseract when it's installed instead of hard-failing.
                from renderers import comicdir
                if not comicdir.tesseract_available():
                    raise
                logger.warning("vision OCR failed (%s); falling back to Tesseract", e)
        blocks, lang = _tesseract_blocks(p, index, rtl, req_lang)
        return jsonify({'blocks': blocks, 'lang': lang, 'source': 'tesseract'})
    except Exception as e:
        logger.exception("comic-ocr failed")
        return _err(f'OCR failed: {e}', 500)


@app.route('/api/comic-translate')
def api_comic_translate():
    """OCR a comic page into text blocks and translate them via the configured LLM."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        index = int(request.args.get('index', 0))
    except ValueError:
        return _err('index must be a number')
    cfg = _ai_cfg()
    target = request.args.get('target') or cfg.get('target_lang') or 'English'
    rtl = request.args.get('rtl', '').lower() in ('1', 'true', 'yes')
    req_lang = request.args.get('lang')
    try:
        if _vision_preferred():
            try:
                # Vision transcribes AND translates in one multimodal pass.
                return jsonify({'blocks': _vision_blocks(p, index, rtl, target),
                                'target': target, 'source': 'vision'})
            except Exception as e:
                from renderers import comicdir
                if not comicdir.tesseract_available():
                    raise
                logger.warning("vision translate failed (%s); falling back to Tesseract+LLM", e)

        from renderers import llm
        blocks, lang = _tesseract_blocks(p, index, rtl, req_lang)
        if not blocks:
            return jsonify({'blocks': [], 'note': 'No text detected (OCR found nothing).'})

        translations = llm.translate_batch(cfg, [b['text'] for b in blocks], target)
        for b, t in zip(blocks, translations):
            b['translated'] = t
        return jsonify({'blocks': blocks, 'lang': lang, 'target': target, 'source': 'tesseract'})
    except Exception as e:
        logger.exception("comic-translate failed")
        return _err(f'Translation failed: {e}', 502)


@app.route('/api/comic-info')
def api_comic_info():
    """Detected reading direction for a comic (ComicInfo.xml + optional OCR)."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        from renderers.comicdoc import get_doc
        from renderers import comicdir
        info = comicdir.detect_direction(str(p), get_doc(str(p)))
    except Exception as e:
        logger.exception("direction detection failed")
        return jsonify({'direction': 'unknown', 'source': 'error', 'error': str(e)})
    return jsonify(info)


@app.route('/api/comic-siblings')
def api_comic_siblings():
    """Naturally-sorted sibling comics in the same folder — powers series
    auto-continue (open the next/previous issue without leaving the reader)."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    from constants import EXT_KIND, KIND_COMIC
    from renderers.comicdoc import _natural_key
    folder = p.parent
    try:
        names = [e.name for e in os.scandir(folder)
                 if e.is_file()
                 and EXT_KIND.get(os.path.splitext(e.name)[1].lower()) == KIND_COMIC]
    except OSError as e:
        return _err(f'Could not list folder: {e}', 500)
    names.sort(key=_natural_key)
    files = [{'path': str(folder / n), 'name': n} for n in names]
    idx = next((i for i, n in enumerate(names) if n == p.name), -1)
    return jsonify({
        'files': files,
        'index': idx,
        'count': len(files),
        'prev': files[idx - 1]['path'] if idx > 0 else None,
        'next': files[idx + 1]['path'] if 0 <= idx < len(files) - 1 else None,
    })


def _norm_img_ext(e: str) -> str:
    e = (e or '').lower()
    return '.jpg' if e in ('.jpg', '.jpeg') else e


@app.route('/api/comic/save-page', methods=['POST'])
def api_comic_save_page():
    """Save one comic page to a user-chosen path from the native Save dialog.

    Body: {path, target, index, enhance?, crop?}
      crop — optional {x,y,w,h} as 0..1 fractions of the page (a panel region).
    The page is written with its native bytes when the chosen extension matches
    the source format; otherwise (or for a crop) it is re-encoded with OpenCV.
    Display-only adjustments (brightness/night/etc.) are intentionally NOT baked
    in — the saved file is the true page (optionally the cleaned 'Enhance' scan).
    """
    body = request.get_json(silent=True) or {}
    src = (body.get('path') or '').strip()
    if not src or not Path(src).is_file():
        return _err('Missing or invalid path')
    target = (body.get('target') or '').strip()
    if not target:
        return _err('No save target provided')
    try:
        index = int(body.get('index', 0))
    except (TypeError, ValueError):
        return _err('index must be a number')

    dest = Path(target)
    ext = dest.suffix.lower()
    if ext not in ('.png', '.jpg', '.jpeg'):
        ext = '.png'
        dest = dest.with_suffix('.png')
    if not dest.parent.is_dir():
        return _err('Target folder does not exist')

    try:
        from renderers.comicdoc import get_doc
        data, mime = get_doc(src).get_page(index)
    except Exception as e:
        logger.exception("save-page: read failed")
        return _err(f'Could not read page: {e}', 500)

    if body.get('enhance'):
        from renderers import enhance
        data = enhance.enhance_cached((src, index), data)
        mime = 'image/png'

    crop = body.get('crop') if isinstance(body.get('crop'), dict) else None
    src_ext = '.' + mime.split('/')[-1]
    need_reencode = bool(crop) or _norm_img_ext(src_ext) != _norm_img_ext(ext)

    try:
        if need_reencode:
            import cv2
            import numpy as np
            img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                dest.write_bytes(data)  # undecodable — save faithful original
            else:
                if crop:
                    h, w = img.shape[:2]
                    x = max(0, min(w - 1, int(round(float(crop.get('x', 0)) * w))))
                    y = max(0, min(h - 1, int(round(float(crop.get('y', 0)) * h))))
                    cw = max(1, min(w - x, int(round(float(crop.get('w', 1)) * w))))
                    ch = max(1, min(h - y, int(round(float(crop.get('h', 1)) * h))))
                    img = img[y:y + ch, x:x + cw]
                enc = '.jpg' if ext in ('.jpg', '.jpeg') else '.png'
                params = [cv2.IMWRITE_JPEG_QUALITY, 92] if enc == '.jpg' else []
                ok, buf = cv2.imencode(enc, img, params)
                if not ok:
                    return _err('Could not encode image', 500)
                dest.write_bytes(buf.tobytes())
        else:
            dest.write_bytes(data)
    except PermissionError:
        return _err('Could not save — the file may be open in another program.', 423)
    except Exception as e:
        logger.exception("save-page failed")
        return _err(f'Could not save image: {e}', 500)

    return jsonify({'ok': True, 'name': dest.name, 'path': str(dest)})


@app.route('/api/comic/export-pdf', methods=['POST'])
def api_comic_export_pdf():
    """Combine every page of a comic into a single PDF at a user-chosen path.

    Each page image is embedded at native resolution on a same-size PDF page,
    so the export is lossless (no rasterisation re-compression of the artwork).
    """
    body = request.get_json(silent=True) or {}
    src = (body.get('path') or '').strip()
    if not src or not Path(src).is_file():
        return _err('Missing or invalid path')
    target = (body.get('target') or '').strip()
    if not target:
        return _err('No save target provided')
    dest = Path(target)
    if dest.suffix.lower() != '.pdf':
        dest = dest.with_suffix('.pdf')
    if not dest.parent.is_dir():
        return _err('Target folder does not exist')

    try:
        import fitz
        import cv2
        import numpy as np
        from renderers.comicdoc import get_doc
        cdoc = get_doc(src)
        n = cdoc.page_count
        if n == 0:
            return _err('Comic has no pages')
        out = fitz.open()
        try:
            for i in range(n):
                data, mime = cdoc.get_page(i)
                img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
                if img is not None:
                    h, w = img.shape[:2]
                    page = out.new_page(width=w, height=h)
                    page.insert_image(fitz.Rect(0, 0, w, h), stream=data)
                else:
                    # Format OpenCV can't decode (e.g. avif) — let MuPDF try.
                    try:
                        idoc = fitz.open(stream=data, filetype=mime.split('/')[-1])
                        pdfb = idoc.convert_to_pdf()
                        idoc.close()
                        with fitz.open('pdf', pdfb) as spdf:
                            out.insert_pdf(spdf)
                    except Exception:
                        logger.warning("export-pdf: skipped undecodable page %d", i)
            if out.page_count == 0:
                return _err('No pages could be exported', 500)
            out.save(str(dest), deflate=True, garbage=3)
        finally:
            out.close()
    except PermissionError:
        return _err('Could not save — the file may be open in another program.', 423)
    except Exception as e:
        logger.exception("export-pdf failed")
        return _err(f'Could not export PDF: {e}', 500)

    return jsonify({'ok': True, 'name': dest.name, 'path': str(dest), 'pages': n})


@app.route('/api/file-prefs', methods=['POST'])
def api_file_prefs():
    """Persist a per-file override (e.g. reading direction)."""
    body = request.get_json(silent=True) or {}
    path, prefs = body.get('path', ''), body.get('prefs', {})
    if path and isinstance(prefs, dict):
        userdata.set_file_pref(path, prefs)
    return jsonify({'status': 'ok'})


# ── office ──────────────────────────────────────────────────────────────────────
# Rendering is fully native (no external engine). Reader metadata reports:
#   'flow'         — lightweight mammoth/python-pptx/openpyxl → HTML (/api/office).
#   'unsupported'  — a legacy/OpenDocument format we can't open natively
#                    (.doc/.ppt/.xls/.rtf/.odt/.odp/.ods).
def _office_meta(path: str, ext: str) -> dict:
    """Decide how to render an office file; returns reader metadata.

    Routes by extension only (no file I/O — callers may pass paths that don't
    exist yet). Slide/sheet geometry rides along in the /api/office payload.
    """
    ext = (ext or '').lower()
    if ext == '.pptx':
        return {'render': 'slides'}      # one-slide-at-a-time deck viewer
    if ext == '.xlsx':
        return {'render': 'sheet'}       # sticky-grid spreadsheet viewer
    if ext in OFFICE_NATIVE_EXTS:
        return {'render': 'flow'}
    return {'render': 'unsupported', 'reason': 'unsupported_format', 'ext': ext}


@app.route('/api/office')
def api_office():
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        from renderers import officedoc
        return jsonify(officedoc.to_html(str(p)))
    except Exception as e:
        logger.exception("office render failed")
        return _err(f'Could not render document: {e}', 500)


@app.route('/api/office/compare')
def api_office_compare():
    """Redline the current .docx against its last-saved .bak backup."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    if Path(str(p)).suffix.lower() != '.docx':
        return _err('Only .docx supports compare')
    try:
        from renderers import officedoc
        return jsonify(officedoc._docx_compare(str(p)))
    except Exception as e:
        logger.exception("office compare failed")
        return _err(f'Could not compare: {e}', 500)


@app.route('/api/slides/image')
def api_slides_image():
    """Serve a high-fidelity rendered slide (or thumbnail) PNG, rendering the
    deck via a detected LibreOffice on first request. 404 when unavailable so
    the viewer falls back to the native render."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        index = int(request.args.get('index', '1'))
    except (TypeError, ValueError):
        return _err('Bad slide index')
    thumb = request.args.get('thumb') in ('1', 'true')
    try:
        from renderers import libreoffice
        img = libreoffice.slide_image_path(str(p), index, thumb=thumb)
    except Exception:
        logger.exception("slide image render failed")
        img = None
    if not img:
        return _err('High-fidelity render unavailable', 404)
    return send_file(img, mimetype='image/png')


@app.route('/api/office/export', methods=['POST'])
def api_office_export():
    """Export a .docx to Markdown or standalone HTML. Re-renders from the file
    on disk (always current; no client-side HTML staleness), writes to target."""
    body = request.get_json(silent=True) or {}
    src = (body.get('path') or '').strip()
    fmt = (body.get('format') or 'md').strip().lower()
    target = (body.get('target') or '').strip()
    if not src or not Path(src).is_file():
        return _err('Source document not found')
    if Path(src).suffix.lower() != '.docx':
        return _err('Only .docx can be exported')
    if not target:
        return _err('No export target provided')
    dest = Path(target)
    if not dest.parent.is_dir():
        return _err('Target folder does not exist')
    try:
        from renderers import officedoc
        body_html = officedoc.to_html(src).get('html', '')
        if fmt == 'html':
            if dest.suffix.lower() not in ('.html', '.htm'):
                dest = dest.with_suffix('.html')
            text = officedoc.html_to_standalone(body_html, dest.stem)
        else:
            if dest.suffix.lower() != '.md':
                dest = dest.with_suffix('.md')
            text = officedoc.html_to_markdown(body_html)
        dest.write_text(text, encoding='utf-8')
    except Exception as e:
        logger.exception("office export failed")
        return _err(f'Could not export: {e}', 500)
    return jsonify({'ok': True, 'path': str(dest), 'name': dest.name})


@app.route('/api/office/accept-changes', methods=['POST'])
def api_office_accept_changes():
    """Accept or reject ALL tracked changes, writing a NEW .docx (the original
    is never modified). Body: {path, mode: 'accept'|'reject', target}."""
    body = request.get_json(silent=True) or {}
    src = (body.get('path') or '').strip()
    mode = (body.get('mode') or 'accept').strip().lower()
    target = (body.get('target') or '').strip()
    if mode not in ('accept', 'reject'):
        return _err('mode must be accept or reject')
    if not src or not Path(src).is_file() or Path(src).suffix.lower() != '.docx':
        return _err('Source .docx not found')
    if not target:
        return _err('No target provided')
    dest = Path(target)
    if dest.suffix.lower() != '.docx':
        dest = dest.with_suffix('.docx')
    if not dest.parent.is_dir():
        return _err('Target folder does not exist')
    try:
        from renderers import officedoc
        result = officedoc.accept_reject_changes(src, str(dest), mode)
    except Exception as e:
        logger.exception("accept/reject changes failed")
        return _err(f'Could not apply changes: {e}', 500)
    return jsonify({**result, 'path': str(dest), 'name': dest.name})


@app.route('/api/office/save', methods=['POST'])
def api_office_save():
    """Write edited HTML back to a .docx.

    mode='overwrite' : back up the original to <path>.bak, then rewrite it.
    mode='saveas'    : write a fresh .docx to the provided target path.

    The HTML→docx step is a faithful re-generation of the editor's content,
    not a byte-perfect round-trip — hence the automatic .bak on overwrite.
    """
    import shutil
    from renderers import officedoc

    body = request.get_json(silent=True) or {}
    html = body.get('html')
    mode = (body.get('mode') or 'overwrite').strip().lower()
    page = body.get('page') if isinstance(body.get('page'), dict) else None
    if html is None:
        return _err('No document content provided')

    backup = None
    if mode == 'saveas':
        target = (body.get('target') or '').strip()
        if not target:
            return _err('No save target provided')
        dest = Path(target)
        if dest.suffix.lower() != '.docx':
            dest = dest.with_suffix('.docx')
        if not dest.parent.is_dir():
            return _err('Target folder does not exist')
    else:
        raw = (body.get('path') or '').strip()
        if not raw:
            return _err('Missing path')
        dest = Path(raw)
        if not dest.is_file():
            return _err('Original file not found')
        if dest.suffix.lower() != '.docx':
            return _err('Only .docx files can be saved')
        # Defense-in-depth: the editor disables overwrite for lossy files, but
        # re-check on the server (the HTML rebuild can't reproduce tracked
        # changes / comments / footnotes / fields, etc.). Refuse — Save As only.
        fid = officedoc.detect_docx_fidelity(str(dest))
        if fid.get('lossy'):
            return _err('This file has ' + ', '.join(fid.get('features') or ['features'])
                        + " the editor can't rewrite — use Save As to keep a clean copy.", 409)
        backup = dest.with_suffix(dest.suffix + '.bak')

    try:
        if backup is not None:
            shutil.copy2(dest, backup)
        officedoc.html_to_docx(html, str(dest), page=page)
    except PermissionError:
        return _err('Could not save — the file may be open in another program.', 423)
    except Exception as e:
        logger.exception("office save failed")
        return _err(f'Could not save document: {e}', 500)

    return jsonify({
        'ok': True,
        'path': str(dest),
        'name': dest.name,
        'backup': str(backup) if backup else None,
    })


# ── text / markdown / code ───────────────────────────────────────────────────────
@app.route('/api/text')
def api_text():
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        from renderers import textdoc
        return jsonify(textdoc.to_html(str(p)))
    except Exception as e:
        logger.exception("text render failed")
        return _err(f'Could not read file: {e}', 500)


@app.route('/api/text/render', methods=['POST'])
def api_text_render():
    """Render in-memory text (live Markdown preview + view refresh after edits)."""
    body = request.get_json(silent=True) or {}
    content = body.get('content') or ''
    name = body.get('name') or ''
    ext = body.get('ext')
    try:
        from renderers import textdoc
        return jsonify(textdoc.render_text(content, name, ext))
    except Exception as e:
        logger.exception("text live-render failed")
        return _err(f'Render failed: {e}', 500)


@app.route('/api/text/save', methods=['POST'])
def api_text_save():
    """Write edited text back to disk. ``target`` (Save As) defaults to ``path``
    (Save in place). EOL / encoding / BOM are preserved from the opened file so
    a round-trip doesn't churn the whole file."""
    body = request.get_json(silent=True) or {}
    src = (body.get('path') or '').strip()
    target = (body.get('target') or src).strip()
    content = body.get('content')
    if content is None:
        return _err('No content to save')
    if not target:
        return _err('No save target')
    dest = Path(target)
    if not dest.parent.is_dir():
        return _err('Destination folder does not exist')

    eol = (body.get('eol') or 'lf').lower()
    enc = (body.get('encoding') or 'utf-8').lower()
    bom = bool(body.get('bom'))
    text = content.replace('\r\n', '\n').replace('\r', '\n')
    if eol == 'crlf':
        text = text.replace('\n', '\r\n')
    try:
        data = text.encode('latin-1', errors='replace') if enc == 'latin-1' \
            else text.encode('utf-8')
        if bom and enc != 'latin-1':
            data = b'\xef\xbb\xbf' + data
        dest.write_bytes(data)
    except PermissionError:
        return _err('File is read-only or locked', 423)
    except Exception as e:
        logger.exception("text save failed")
        return _err(f'Could not save: {e}', 500)
    return jsonify({'ok': True, 'name': dest.name, 'path': str(dest)})


@app.route('/api/text/export', methods=['POST'])
def api_text_export():
    """Export the (possibly edited) text to a print-friendly PDF or HTML file at
    a user-chosen ``target``. Markdown is rendered; code/plain is boxed as-is."""
    body = request.get_json(silent=True) or {}
    content = body.get('content')
    if content is None:
        return _err('No content to export')
    name = body.get('name') or 'document'
    fmt = (body.get('format') or 'pdf').lower()
    if fmt not in ('pdf', 'html'):
        return _err('Unsupported export format')
    target = (body.get('target') or '').strip()
    if not target:
        return _err('No save target')
    dest = Path(target)
    want = '.pdf' if fmt == 'pdf' else '.html'
    if dest.suffix.lower() != want:
        dest = dest.with_suffix(want)
    if not dest.parent.is_dir():
        return _err('Target folder does not exist')
    try:
        from renderers import textdoc
        full_html = textdoc.build_export_html(content, name)
        data = textdoc.to_pdf_bytes(full_html) if fmt == 'pdf' \
            else full_html.encode('utf-8')
        dest.write_bytes(data)
    except PermissionError:
        return _err('Could not save — the file may be open in another program.', 423)
    except Exception as e:
        logger.exception("text export failed")
        return _err(f'Could not export: {e}', 500)
    return jsonify({'ok': True, 'name': dest.name, 'path': str(dest), 'format': fmt})


# ── images ────────────────────────────────────────────────────────────────────
@app.route('/api/image')
def api_image():
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    mime = mimetypes.guess_type(p.name)[0] or 'application/octet-stream'
    return send_file(str(p), mimetype=mime)


@app.route('/api/image-info')
def api_image_info():
    """Dimensions, colour mode, DPI, EXIF and decoded GPS for the Info panel."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    try:
        from renderers import imagedoc
        return jsonify(imagedoc.info(str(p)))
    except Exception as e:
        logger.exception("image-info failed")
        return _err(f'Could not read image info: {e}', 500)


@app.route('/api/image-siblings')
def api_image_siblings():
    """Naturally-sorted sibling images in the same folder — lets the viewer act
    like a folder gallery (open the next/previous picture without leaving)."""
    p = _require_path(request.args)
    if not p:
        return _err('Missing or invalid path')
    from constants import EXT_KIND, KIND_IMAGE
    from renderers.comicdoc import _natural_key
    folder = p.parent
    try:
        names = [e.name for e in os.scandir(folder)
                 if e.is_file()
                 and EXT_KIND.get(os.path.splitext(e.name)[1].lower()) == KIND_IMAGE]
    except OSError as e:
        return _err(f'Could not list folder: {e}', 500)
    names.sort(key=_natural_key)
    files = [{'path': str(folder / n), 'name': n} for n in names]
    idx = next((i for i, n in enumerate(names) if n == p.name), -1)
    return jsonify({
        'files': files,
        'index': idx,
        'count': len(files),
        'prev': files[idx - 1]['path'] if idx > 0 else None,
        'next': files[idx + 1]['path'] if 0 <= idx < len(files) - 1 else None,
    })


# ── recent / position / bookmarks / prefs ────────────────────────────────────────
@app.route('/api/recent')
def api_recent():
    return jsonify({'recent': userdata.get_recent()})


@app.route('/api/recent/remove', methods=['POST'])
def api_recent_remove():
    body = request.get_json(silent=True) or {}
    userdata.remove_recent(body.get('path', ''))
    return jsonify({'status': 'ok'})


@app.route('/api/recent/clear', methods=['POST'])
def api_recent_clear():
    userdata.clear_recent()
    return jsonify({'status': 'ok'})


@app.route('/api/position', methods=['POST'])
def api_position():
    body = request.get_json(silent=True) or {}
    path = body.get('path', '')
    if path:
        userdata.set_position(path, body.get('position'),
                              body.get('progress', 0.0))
    return jsonify({'status': 'ok'})


@app.route('/api/bookmarks', methods=['GET', 'POST'])
def api_bookmarks():
    if request.method == 'GET':
        return jsonify({'bookmarks': userdata.get_bookmarks(request.args.get('path', ''))})
    body = request.get_json(silent=True) or {}
    path = body.get('path', '')
    if path and 'mark' in body:
        userdata.add_bookmark(path, body['mark'])
    return jsonify({'status': 'ok', 'bookmarks': userdata.get_bookmarks(path)})


@app.route('/api/bookmarks/remove', methods=['POST'])
def api_bookmarks_remove():
    body = request.get_json(silent=True) or {}
    userdata.remove_bookmark(body.get('path', ''), int(body.get('index', -1)))
    return jsonify({'status': 'ok'})


@app.route('/api/prefs', methods=['GET', 'POST'])
def api_prefs():
    if request.method == 'GET':
        kind = request.args.get('kind')
        if kind:
            return jsonify({'prefs': userdata.get_prefs(kind)})
        return jsonify({'prefs': userdata.all_prefs()})
    body = request.get_json(silent=True) or {}
    kind, prefs = body.get('kind'), body.get('prefs', {})
    if kind:
        userdata.set_prefs(kind, prefs)
    return jsonify({'status': 'ok'})


@app.route('/api/settings', methods=['GET', 'POST'])
def api_settings():
    if request.method == 'GET':
        return jsonify({'settings': userdata.get_settings()})
    body = request.get_json(silent=True) or {}
    for key, value in (body.get('settings') or {}).items():
        userdata.set_setting(key, value)
    return jsonify({'status': 'ok', 'settings': userdata.get_settings()})


# ── AI: LLM connection test + translation ────────────────────────────────────
def _ai_cfg(override=None):
    cfg = dict(userdata.get_settings().get('ai') or {})
    if override:
        cfg.update({k: v for k, v in override.items() if v is not None})
    return cfg


def _probe_cfg(body_ai):
    """Config for a connection probe (test / models). SECURITY: a probe targets
    a client-chosen endpoint, so it must use ONLY client-supplied credentials —
    never the *saved* api_key. Otherwise a caller could point `endpoint` at their
    own server and harvest the stored key from the Authorization header. The
    Settings form always sends the full payload (incl. the key field), so taking
    the body verbatim is sufficient; with no body we fall back to the saved
    config to re-test the stored connection."""
    if body_ai:
        return {k: v for k, v in body_ai.items() if v is not None}
    return dict(userdata.get_settings().get('ai') or {})


@app.route('/api/llm/test', methods=['POST'])
def api_llm_test():
    from renderers import llm
    body = request.get_json(silent=True) or {}
    return jsonify(llm.test_connection(_probe_cfg(body.get('ai'))))


@app.route('/api/llm/models', methods=['POST'])
def api_llm_models():
    from renderers import llm
    body = request.get_json(silent=True) or {}
    return jsonify(llm.list_models(_probe_cfg(body.get('ai'))))


@app.route('/api/ocr-status')
def api_ocr_status():
    out = {'available': False, 'langs': [], 'path': ''}
    try:
        import pytesseract
        from renderers import comicdir
        cfgpath = (userdata.get_settings().get('tesseract_path') or '').strip()
        if cfgpath and os.path.isfile(cfgpath):
            pytesseract.pytesseract.tesseract_cmd = cfgpath
        else:
            comicdir.tesseract_available()  # auto-detects + sets cmd
        out['path'] = pytesseract.pytesseract.tesseract_cmd
        out['langs'] = pytesseract.get_languages(config=comicdir.ocr_config())
        out['tessdata_dir'] = comicdir.tessdata_dir()
        out['available'] = True
    except Exception as e:
        out['error'] = str(e)
    return jsonify(out)


@app.route('/api/translate', methods=['POST'])
def api_translate():
    from renderers import llm
    body = request.get_json(silent=True) or {}
    text = body.get('text', '')
    if not text.strip():
        return _err('No text to translate')
    cfg = _ai_cfg()
    target = body.get('target') or cfg.get('target_lang') or 'English'
    try:
        return jsonify({'translation': llm.translate(cfg, text, target)})
    except Exception as e:
        logger.exception("translate failed")
        return _err(f'Translation failed: {e}', 502)


# General document AI assistant (summarize / key points / ask / rewrite / …).
# Used by the office + text readers. Each task maps to a system prompt; the
# document text (or the user's selection) is the user message.
_AI_TASKS = {
    'summarize': 'Summarize the following document clearly and concisely. '
                 'Lead with a one-sentence gist, then a short paragraph. '
                 'Use the document\'s own language.',
    'keypoints': 'Extract the key points from the following document as a '
                 'tight bulleted list (start each line with "- "). No preamble.',
    'simplify': 'Rewrite the following text in plain, simple language that a '
                'general audience can understand. Preserve all meaning. '
                'Output only the rewritten text.',
    'rewrite': 'Improve the following text: fix grammar, tighten wording, and '
               'make it clear and professional. Preserve meaning and tone. '
               'Output only the rewritten text.',
    'explain': 'Explain the following text in clear terms. Define jargon and '
               'clarify what it means and why it matters.',
}
_AI_MAX_CHARS = 24000  # keep prompts within a sane window


@app.route('/api/ai', methods=['POST'])
def api_ai():
    from renderers import llm
    body = request.get_json(silent=True) or {}
    task = (body.get('task') or '').strip().lower()
    text = (body.get('text') or '').strip()
    if not text:
        return _err('No text provided')
    text = text[:_AI_MAX_CHARS]
    cfg = _ai_cfg()

    try:
        if task == 'translate':
            target = body.get('target') or cfg.get('target_lang') or 'English'
            return jsonify({'result': llm.translate(cfg, text, target)})
        if task == 'ask':
            question = (body.get('question') or '').strip()
            if not question:
                return _err('No question provided')
            messages = [
                {'role': 'system', 'content':
                    'You are a helpful reading assistant. Answer the user\'s '
                    'question using ONLY the document provided. If the answer '
                    'isn\'t in the document, say so plainly.'},
                {'role': 'user', 'content':
                    f'DOCUMENT:\n{text}\n\nQUESTION: {question}'},
            ]
            return jsonify({'result': llm.chat(cfg, messages, timeout=120)})
        system = _AI_TASKS.get(task)
        if not system:
            return _err(f'Unknown AI task: {task}')
        messages = [{'role': 'system', 'content': system},
                    {'role': 'user', 'content': text}]
        return jsonify({'result': llm.chat(cfg, messages, timeout=120)})
    except Exception as e:
        logger.exception("ai task failed")
        return _err(f'AI request failed: {e}', 502)


# Vision-LLM helper for the Image viewer. Each task is one multimodal
# instruction; the image itself (a bounded PNG) is the payload.
_IMAGE_AI_TASKS = {
    'describe': 'Describe this image in clear, vivid detail. Cover the main '
                'subject, the setting, notable objects, colours and mood, and '
                'mention any visible text. Write 2–4 sentences of plain prose. '
                'No preamble, no markdown.',
    'ocr': 'Transcribe ALL text visible in this image exactly as written, '
           'preserving line breaks and natural reading order. Output ONLY the '
           'text — no commentary. If there is no text, reply: (no text found).',
    'caption': 'Write a single concise caption for this image: one short '
               'sentence, no quotation marks, no trailing period unless natural.',
    'tags': 'List 5–12 short keyword tags that describe this image, separated by '
            'commas on one line. Lowercase, no numbering, no commentary.',
    'alt': 'Write concise alt text for this image for a screen reader: one '
           'factual sentence, no "image of" or "picture of" prefix.',
}


@app.route('/api/image-ai', methods=['POST'])
def api_image_ai():
    """Describe / read text / caption / tag / ask about an image with the
    configured multimodal model. We downscale to a bounded PNG first so large
    originals don't blow the request size."""
    from renderers import llm, imagedoc
    body = request.get_json(silent=True) or {}
    p = _require_path(body)
    if not p:
        return _err('Missing or invalid path')
    task = (body.get('task') or 'describe').strip().lower()
    if task == 'ask':
        question = (body.get('question') or '').strip()
        if not question:
            return _err('No question provided')
        instr = ('Answer this question about the image using only what you can '
                 'see in it. If it cannot be answered from the image, say so '
                 'plainly.\n\nQUESTION: ' + question)
    else:
        instr = _IMAGE_AI_TASKS.get(task)
        if not instr:
            return _err(f'Unknown image AI task: {task}')
    try:
        png = imagedoc.thumbnail_png(str(p))
        result = llm.vision_chat(_ai_cfg(), png, instr, timeout=180)
        return jsonify({'result': result})
    except Exception as e:
        logger.exception("image-ai failed")
        return _err(f'Image AI request failed: {e}', 502)


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=FLASK_PORT, debug=False, use_reloader=False)
