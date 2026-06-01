"""
YancoRead — Main Entry Point
Starts the Flask backend, waits for it to be healthy, then opens the window.
A file path passed on the command line (double-click / "Open with") is handed
to the frontend via the YANCOREAD_OPEN environment variable.
"""

import logging
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import requests

from constants import FLASK_PORT, HTTP_TIMEOUT_PROBE, FLASK_STARTUP_TIMEOUT, PROCESS_CLEANUP_TIMEOUT

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('yancoread.launch')

PROJECT_DIR = Path(__file__).parent
_processes = []
_flask_thread = None


def _parse_open_file(argv) -> str:
    """Return the first command-line argument that is an existing file."""
    for arg in argv[1:]:
        if arg.startswith('-'):
            continue
        if Path(arg).is_file():
            return str(Path(arg).resolve())
    return ''


def start_flask():
    """Start Flask: subprocess in dev, in-process daemon thread when frozen."""
    global _flask_thread
    if getattr(sys, 'frozen', False):
        def _run():
            sys.path.insert(0, str(PROJECT_DIR))
            from app import app
            app.run(host='127.0.0.1', port=FLASK_PORT, debug=False, use_reloader=False)
        _flask_thread = threading.Thread(target=_run, name='flask-server', daemon=True)
        _flask_thread.start()
        return _flask_thread

    proc = subprocess.Popen([sys.executable, str(PROJECT_DIR / 'app.py')],
                            cwd=str(PROJECT_DIR))
    _processes.append(proc)
    return proc


def wait_for_flask(timeout=FLASK_STARTUP_TIMEOUT) -> bool:
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = requests.get(f'http://127.0.0.1:{FLASK_PORT}/health',
                             timeout=HTTP_TIMEOUT_PROBE)
            if r.status_code == 200:
                return True
        except requests.RequestException as e:
            logger.debug("waiting for flask: %s", e)
        time.sleep(0.4)
    return False


def cleanup():
    for proc in _processes:
        try:
            proc.terminate()
            proc.wait(timeout=PROCESS_CLEANUP_TIMEOUT)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
    _processes.clear()


def main():
    # Record any file passed on the command line so app.py can surface it.
    open_file = _parse_open_file(sys.argv)
    if open_file:
        os.environ['YANCOREAD_OPEN'] = open_file

    # Single instance: a second launch forwards its file to the running window.
    from singleinstance import (acquire_instance_lock, release_instance_lock,
                                show_already_running_message)
    if not acquire_instance_lock():
        if open_file:
            try:
                requests.post(f'http://127.0.0.1:{FLASK_PORT}/api/open-external',
                              json={'path': open_file}, timeout=HTTP_TIMEOUT_PROBE)
            except requests.RequestException:
                pass
        else:
            show_already_running_message()
        sys.exit(0)

    import atexit
    atexit.register(release_instance_lock)

    print('[YancoRead] Starting…')
    start_flask()
    if not wait_for_flask():
        print('[YancoRead] ERROR: Flask failed to start')
        cleanup()
        sys.exit(1)
    print('[YancoRead] Flask ready')

    try:
        from window import main as window_main
        window_main()
    except Exception as e:
        logger.exception("window error")
        import webbrowser
        webbrowser.open(f'http://127.0.0.1:{FLASK_PORT}')
        print(f'[YancoRead] Window failed ({e}); opened in browser.')
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass

    print('[YancoRead] Shutting down…')
    cleanup()
    os._exit(0)


if __name__ == '__main__':
    main()
