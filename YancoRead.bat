@echo off
REM ── YancoRead launcher ────────────────────────────────────────────────────
REM Double-click to start the app. No terminal needed.
REM Uses the project's venv if present, otherwise falls back to system Python.

setlocal
cd /d "%~dp0"

REM Prefer the windowless interpreter (pythonw) so no console lingers.
set "PYW=venv\Scripts\pythonw.exe"
set "PY=venv\Scripts\python.exe"

if exist "%PYW%" (
    start "" "%PYW%" "launch.py"
    goto :eof
)

if exist "%PY%" (
    start "" "%PY%" "launch.py"
    goto :eof
)

REM No venv — try a system Python (pythonw first, then python).
where pythonw >nul 2>&1 && (
    start "" pythonw "launch.py"
    goto :eof
)
where python >nul 2>&1 && (
    start "" python "launch.py"
    goto :eof
)

echo Could not find Python. Create the venv first:
echo     python -m venv venv ^&^& venv\Scripts\pip install -r requirements.txt
pause
