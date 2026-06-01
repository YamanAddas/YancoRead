"""
YancoRead — pywebview Window
Opens the Flask UI in a native window with a JS API bridge for native file
dialogs and a standard menu bar. Cross-platform (Windows / macOS / Linux).
"""

import json
import logging
import sys
import webbrowser
from pathlib import Path

import webview
from webview.menu import Menu, MenuAction, MenuSeparator

from constants import FLASK_PORT, VERSION, GITHUB_REPO
from paths import APP_DIR, get_log_dir

logger = logging.getLogger('yancoread.window')

# File dialog filters. On Windows these render as the type dropdown.
FILE_TYPES = (
    'All readable (*.pdf;*.epub;*.mobi;*.fb2;*.xps;*.oxps;*.azw3;'
    '*.cbz;*.cbr;*.cb7;*.cbt;*.docx;*.pptx;*.xlsx;*.txt;*.md;'
    '*.json;*.csv;*.log;*.html;*.py;*.js;*.png;*.jpg;*.jpeg;*.gif;*.webp)',
    'PDF (*.pdf)',
    'Comics (*.cbz;*.cbr;*.cb7;*.cbt)',
    'eBooks (*.epub;*.mobi;*.fb2;*.xps;*.oxps;*.azw3)',
    'Office (*.docx;*.pptx;*.xlsx)',
    'Text and code (*.txt;*.md;*.json;*.csv;*.log;*.html;*.css;*.js;*.py)',
    'Images (*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.tiff)',
    'All files (*.*)',
)

# Per-kind filters — used by the rail tiles via Api.browse_file_kind(kind) so
# clicking the PDF tile opens a dialog filtered to PDFs, the Comic tile to
# comic archives, etc.
KIND_FILE_TYPES = {
    'pdf':    ('PDF (*.pdf)', 'All files (*.*)'),
    'comic':  ('Comics (*.cbz;*.cbr;*.cb7;*.cbt)', 'All files (*.*)'),
    'ebook':  ('eBooks (*.epub;*.mobi;*.fb2;*.xps;*.oxps;*.azw3)', 'All files (*.*)'),
    'office': ('Office (*.docx;*.pptx;*.xlsx)', 'All files (*.*)'),
    'text':   ('Text and code (*.txt;*.md;*.json;*.csv;*.log;*.html;*.css;*.js;*.py;*.ts;*.tsx;*.rs;*.go;*.java;*.cpp;*.c;*.h;*.sh;*.yaml;*.toml;*.xml)', 'All files (*.*)'),
    'image':  ('Images (*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp;*.tiff;*.avif;*.svg)', 'All files (*.*)'),
}


class Api:
    """Exposed to JS as window.pywebview.api.* — runs in the main thread,
    which can reach native OS dialogs that Flask cannot."""

    def __init__(self):
        self._window = None

    def set_window(self, window):
        self._window = window

    def browse_file(self) -> str | None:
        """Native open-file dialog. Returns the chosen path or None."""
        if not self._window:
            return None
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            directory=str(Path.home()),
            file_types=FILE_TYPES,
        )
        if result and len(result) > 0:
            return str(result[0])
        return None

    def browse_file_kind(self, kind: str) -> str | None:
        """Native open-file dialog filtered to one document kind (PDF / comic /
        eBook / office / text / image). Used by the rail tiles so each kind's
        tile opens a kind-appropriate picker. Unknown kinds fall back to the
        full FILE_TYPES list. Returns the chosen path or None."""
        if not self._window:
            return None
        ft = KIND_FILE_TYPES.get((kind or '').lower(), FILE_TYPES)
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            directory=str(Path.home()),
            file_types=ft,
        )
        if result and len(result) > 0:
            return str(result[0])
        return None

    def browse_folder(self) -> str | None:
        """Native folder picker (for path settings). Returns the chosen path or None."""
        if not self._window:
            return None
        result = self._window.create_file_dialog(
            webview.FOLDER_DIALOG, directory=str(Path.home()))
        if result and len(result) > 0:
            return str(result[0])
        return None

    def browse_pdfs(self) -> list:
        """Native multi-select open-file dialog filtered to PDFs (for Merge).
        Returns a list of chosen paths (empty if cancelled)."""
        if not self._window:
            return []
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG,
            directory=str(Path.home()),
            allow_multiple=True,
            file_types=('PDF document (*.pdf)', 'All files (*.*)'),
        )
        if not result:
            return []
        if isinstance(result, (list, tuple)):
            return [str(p) for p in result]
        return [str(result)]

    def save_file(self, suggested_name: str = 'document.docx',
                  directory: str = '', file_types=None) -> str | None:
        """Native save-file dialog (used by the editor's 'Save As' and the
        comic reader's export/share).

        ``file_types`` is an optional list/tuple of pywebview filter strings
        (e.g. ['PNG image (*.png)', 'All files (*.*)']). When omitted it
        defaults to the Word-document filter so existing callers are unaffected.

        Returns the chosen path or None if cancelled. pywebview returns either a
        bare string or a 1-tuple depending on platform/version — handle both.
        """
        if not self._window:
            return None
        start_dir = directory if directory and Path(directory).is_dir() \
            else str(Path.home())
        if file_types:
            ft = tuple(file_types) if isinstance(file_types, (list, tuple)) \
                else (file_types,)
        else:
            ft = ('Word document (*.docx)', 'All files (*.*)')
        result = self._window.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=start_dir,
            save_filename=suggested_name or 'document.docx',
            file_types=ft,
        )
        if not result:
            return None
        if isinstance(result, (list, tuple)):
            return str(result[0]) if result else None
        return str(result)

    def open_url(self, url: str) -> bool:
        """Open a URL in the user's default browser (not the embedded webview)."""
        if url and (url.startswith('https://') or url.startswith('http://')):
            webbrowser.open(url)
            return True
        return False

    def toggle_fullscreen(self) -> bool:
        if self._window:
            self._window.toggle_fullscreen()
        return True

    def minimize(self) -> bool:
        if self._window:
            self._window.minimize()
        return True


api = Api()


def _js(code: str):
    w = webview.active_window()
    if w:
        w.evaluate_js(code)


# ── menu callbacks ──────────────────────────────────────────────────────────
def _menu_open():
    path = api.browse_file()
    if path:
        _js(f'window.YR && YR.openFile({json.dumps(path)})')


def _menu_close_doc():
    _js('window.YR && YR.goHome()')


def _menu_fullscreen():
    w = webview.active_window()
    if w:
        w.toggle_fullscreen()


def _menu_zoom_in():
    _js("document.body.style.zoom=(parseFloat(document.body.style.zoom||1)+0.1).toFixed(2)")


def _menu_zoom_out():
    _js("document.body.style.zoom=Math.max(0.5,(parseFloat(document.body.style.zoom||1)-0.1)).toFixed(2)")


def _menu_zoom_reset():
    _js("document.body.style.zoom='1'")


def _menu_reload():
    w = webview.active_window()
    if w:
        w.load_url(f'http://127.0.0.1:{FLASK_PORT}')


def _menu_github():
    webbrowser.open(f'https://github.com/{GITHUB_REPO}')


def _menu_logs():
    folder = str(get_log_dir())
    if sys.platform == 'win32':
        import os
        os.startfile(folder)  # noqa: S606 — opening a known local folder
    elif sys.platform == 'darwin':
        import subprocess
        subprocess.Popen(['open', folder])
    else:
        import subprocess
        subprocess.Popen(['xdg-open', folder])


def _menu_about():
    _js('window.YR && YR.showAbout()')


def _build_menu():
    return [
        Menu('File', [
            MenuAction('Open…', _menu_open),
            MenuSeparator(),
            MenuAction('Close Document', _menu_close_doc),
            MenuSeparator(),
            MenuAction('Exit', lambda: webview.active_window().destroy()),
        ]),
        Menu('View', [
            MenuAction('Fullscreen', _menu_fullscreen),
            MenuSeparator(),
            MenuAction('Zoom In', _menu_zoom_in),
            MenuAction('Zoom Out', _menu_zoom_out),
            MenuAction('Reset Zoom', _menu_zoom_reset),
            MenuSeparator(),
            MenuAction('Reload', _menu_reload),
        ]),
        Menu('Help', [
            MenuAction('GitHub Repository', _menu_github),
            MenuAction('Open Logs Folder', _menu_logs),
            MenuSeparator(),
            MenuAction(f'About YancoRead v{VERSION}', _menu_about),
        ]),
    ]


def main():
    window = webview.create_window(
        'YancoRead',
        f'http://127.0.0.1:{FLASK_PORT}',
        width=1380,
        height=900,
        min_size=(900, 560),
        background_color='#060b14',
        js_api=api,
    )
    api.set_window(window)

    icon_path = APP_DIR / 'assets' / 'icon.ico'
    webview.start(
        menu=_build_menu(),
        debug='--debug' in sys.argv,
        icon=str(icon_path) if icon_path.exists() else None,
    )


if __name__ == '__main__':
    main()
