#!/usr/bin/env python3
"""PreToolUse guard for YancoRead (Edit / Write / NotebookEdit).

Blocks writes to paths that must never be hand-edited:
  * generated build output (dist/, build/)  — rebuild with build.py instead
  * the virtualenv (venv/)
  * anything that would leak secrets/personal data (userdata.json, .env, *.key)

Reads the hook payload as JSON on stdin. Exit 0 = allow; exit 2 = block (stderr
is shown to Claude). FAIL-OPEN: any unexpected error allows the edit through, so
a hook bug can never wedge the session.

Pure stdlib, no shell, no third-party deps — runs the same on Windows/macOS/Linux.
"""
import json
import os
import sys


# Repo-relative path prefixes / names that are off-limits for direct editing.
BLOCKED_DIR_PREFIXES = ("dist/", "build/", "venv/", ".venv/")
BLOCKED_NAMES = ("userdata.json",)
BLOCKED_SUFFIXES = (".userdata.json", ".key")


def _norm(path: str) -> str:
    return path.replace("\\", "/")


def main() -> int:
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0  # can't parse → don't get in the way

    tool_input = data.get("tool_input") or {}
    file_path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if not file_path:
        return 0

    # Resolve against the project root so we compare like-for-like.
    project_dir = data.get("cwd") or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    try:
        abs_path = os.path.abspath(file_path)
        rel = _norm(os.path.relpath(abs_path, project_dir))
    except Exception:
        return 0

    name = os.path.basename(rel)

    # Only guard paths *inside* the project; edits elsewhere aren't our concern.
    inside = not rel.startswith("..") and not os.path.isabs(rel)

    if inside and (rel.startswith(BLOCKED_DIR_PREFIXES)
                   or name in BLOCKED_NAMES
                   or name.endswith(BLOCKED_SUFFIXES)
                   or name == ".env" or name.startswith(".env.")):
        sys.stderr.write(
            f"Blocked edit to '{rel}': this path is generated build output, the "
            "virtualenv, or a secrets/userdata file that must not be hand-edited "
            "or committed. Rebuild generated files with `python build.py`; keep "
            "secrets in %APPDATA%\\YancoRead\\ (outside the repo)."
        )
        return 2

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)  # fail-open
