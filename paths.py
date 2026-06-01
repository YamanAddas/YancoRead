"""
YancoRead — Centralized Data Paths
Single source of truth for user data, cache, and log directories.

Cross-platform (Windows / macOS / Linux). Supports portable mode via a
'portable.txt' marker file next to the executable.
"""

import logging
import os
import sys
from pathlib import Path

logger = logging.getLogger('yancoread.paths')

# When frozen by PyInstaller, __file__ points inside the bundle but app
# resources live next to the executable.
if getattr(sys, 'frozen', False):
    APP_DIR = Path(sys.executable).parent
else:
    APP_DIR = Path(__file__).parent

_APP_NAME = 'YancoRead'


def is_portable() -> bool:
    """Return True if running in portable mode (portable.txt next to exe)."""
    return (APP_DIR / 'portable.txt').exists()


def _home() -> Path:
    return Path.home()


def get_data_dir() -> Path:
    """Per-user data directory (settings, library, reading positions)."""
    if is_portable():
        d = APP_DIR / 'data'
    elif sys.platform == 'win32':
        base = Path(os.environ.get('APPDATA', _home() / 'AppData' / 'Roaming'))
        d = base / _APP_NAME
    elif sys.platform == 'darwin':
        d = _home() / 'Library' / 'Application Support' / _APP_NAME
    else:  # linux / *nix
        base = Path(os.environ.get('XDG_DATA_HOME', _home() / '.local' / 'share'))
        d = base / _APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_cache_dir() -> Path:
    """Cache directory (rendered page bitmaps, thumbnails, extracted pages)."""
    if is_portable():
        d = APP_DIR / 'cache'
    elif sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA', _home() / 'AppData' / 'Local'))
        d = base / _APP_NAME / 'cache'
    elif sys.platform == 'darwin':
        d = _home() / 'Library' / 'Caches' / _APP_NAME
    else:
        base = Path(os.environ.get('XDG_CACHE_HOME', _home() / '.cache'))
        d = base / _APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_log_dir() -> Path:
    """Log directory."""
    if is_portable():
        d = APP_DIR / 'logs'
    elif sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA', _home() / 'AppData' / 'Local'))
        d = base / _APP_NAME / 'logs'
    elif sys.platform == 'darwin':
        d = _home() / 'Library' / 'Logs' / _APP_NAME
    else:
        base = Path(os.environ.get('XDG_STATE_HOME', _home() / '.local' / 'state'))
        d = base / _APP_NAME / 'logs'
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_userdata_file() -> Path:
    """Path to the userdata.json persistence file."""
    return get_data_dir() / 'userdata.json'
