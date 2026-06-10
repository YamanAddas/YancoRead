"""
YancoRead — Build Script (PyInstaller)

    python build.py              # frozen app dir + portable zip (+ installer if Inno Setup present)
    python build.py --portable   # portable zip only
    python build.py --installer  # installer only

Output:
    dist/YancoRead/YancoRead.exe        # standalone app
    dist/YancoRead-<ver>-portable.zip   # portable
    dist/YancoRead-<ver>-setup.exe      # installer (needs Inno Setup ISCC on PATH)
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

PROJECT_DIR = Path(__file__).parent
DIST_DIR = PROJECT_DIR / 'dist'
BUILD_DIR = PROJECT_DIR / 'build'
APP_NAME = 'YancoRead'
SEP = os.pathsep

# Packages PyInstaller should pull in fully (data files + submodules + binaries).
# nh3 is a compiled Rust extension (HTML sanitizer) — collect it so the frozen app
# can sanitize markdown/docx instead of failing closed to escaped text.
COLLECT_ALL = ['webview', 'fitz', 'cv2', 'pptx', 'openpyxl', 'mammoth',
               'py7zr', 'markdown', 'pygments', 'pytesseract', 'PIL', 'rarfile', 'nh3']
HIDDEN = ['webview', 'clr', 'bottle', 'pythoncom', 'numpy']
# Data dirs bundled into the frozen app (read at runtime via sys._MEIPASS).
# assets/tools carries any user-dropped unrar/7z extractor for CBR archives.
ADD_DATA = [('templates', 'templates'), ('static', 'static'),
            ('assets/tools', 'assets/tools')]


def check_pyinstaller():
    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        print('[BUILD] Installing PyInstaller…')
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'pyinstaller'])


def run_pyinstaller():
    cmd = [sys.executable, '-m', 'PyInstaller', '--name', APP_NAME,
           '--noconfirm', '--clean', '--windowed',
           '--distpath', str(DIST_DIR), '--workpath', str(BUILD_DIR)]
    for c in COLLECT_ALL:
        cmd += ['--collect-all', c]
    for h in HIDDEN:
        cmd += ['--hidden-import', h]
    for src, dst in ADD_DATA:
        cmd += ['--add-data', f'{PROJECT_DIR / src}{SEP}{dst}']
    icon = PROJECT_DIR / 'assets' / 'icon.ico'
    if icon.exists():
        cmd += ['--icon', str(icon)]
    cmd.append(str(PROJECT_DIR / 'launch.py'))
    print('[BUILD] Running PyInstaller…')
    subprocess.check_call(cmd)


def build_portable_zip():
    app_dir = DIST_DIR / APP_NAME
    if not app_dir.exists():
        print('[BUILD] ERROR: dist/YancoRead missing — run PyInstaller first')
        return None
    sys.path.insert(0, str(PROJECT_DIR))
    from constants import VERSION
    zip_path = DIST_DIR / f'{APP_NAME}-{VERSION}-portable.zip'
    print(f'[BUILD] Creating portable zip: {zip_path.name}…')
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for file in app_dir.rglob('*'):
            if file.is_file():
                zf.write(file, f'{APP_NAME}/{file.relative_to(app_dir)}')
        zf.writestr(f'{APP_NAME}/portable.txt', 'Portable mode — data stored beside the app\n')
    print(f'[BUILD] Portable zip: {zip_path} ({zip_path.stat().st_size/1e6:.1f} MB)')
    return zip_path


def build_installer():
    iscc = shutil.which('ISCC')
    if not iscc:
        for cand in [Path('C:/Program Files (x86)/Inno Setup 6/ISCC.exe'),
                     Path.home() / 'AppData/Local/Programs/Inno Setup 6/ISCC.exe']:
            if cand.exists():
                iscc = str(cand)
                break
    iss = PROJECT_DIR / 'installer.iss'
    if not iscc:
        print('[BUILD] Inno Setup not found — skipping installer.')
        print('       Install with:  winget install JRSoftware.InnoSetup')
        return None
    if not iss.exists():
        print('[BUILD] installer.iss missing — skipping installer.')
        return None
    sys.path.insert(0, str(PROJECT_DIR))
    from constants import VERSION
    text = iss.read_text(encoding='utf-8')
    patched = re.sub(r'AppVersion=.*', f'AppVersion={VERSION}', text)
    patched = re.sub(r'OutputBaseFilename=.*',
                     f'OutputBaseFilename={APP_NAME}-{VERSION}-setup', patched)
    if patched != text:
        iss.write_text(patched, encoding='utf-8')
    print('[BUILD] Building Inno Setup installer…')
    subprocess.check_call([iscc, '/Q', str(iss)])
    out = DIST_DIR / f'{APP_NAME}-{VERSION}-setup.exe'
    if out.exists():
        print(f'[BUILD] Installer: {out} ({out.stat().st_size/1e6:.1f} MB)')
        return out
    return None


def main():
    ap = argparse.ArgumentParser(description=f'Build {APP_NAME}')
    ap.add_argument('--portable', action='store_true')
    ap.add_argument('--installer', action='store_true')
    args = ap.parse_args()
    build_all = not args.portable and not args.installer

    check_pyinstaller()
    run_pyinstaller()
    if build_all or args.portable:
        build_portable_zip()
    if build_all or args.installer:
        build_installer()
    print('\n[BUILD] Done!')
    print(f'  App: dist/{APP_NAME}/{APP_NAME}.exe')


if __name__ == '__main__':
    main()
