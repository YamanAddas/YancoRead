#!/usr/bin/env python3
"""PostToolUse check for YancoRead (Edit / Write).

After a file is edited, do a fast syntax check so a typo is caught immediately
instead of at the next run/test:
  * .py  → compile() (py_compile-style, no import side effects)
  * .js  → `node --check` if node is on PATH (skipped silently otherwise)

PostToolUse cannot undo the edit (it already happened); this only surfaces a
warning. We print a JSON object that feeds the message back to Claude as
context so it can fix the file. FAIL-OPEN: any hook error stays silent.

Pure stdlib + an optional `node` call. Cross-platform; no shell features used.
"""
import json
import os
import subprocess
import sys


def _emit(message: str) -> None:
    """Return a non-blocking note to Claude (decision 'block' on PostToolUse just
    means 'show this reason to the model', not that anything is reverted)."""
    print(json.dumps({"decision": "block", "reason": message}))


def main() -> int:
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        return 0

    tool_input = data.get("tool_input") or {}
    file_path = tool_input.get("file_path") or ""
    if not file_path or not os.path.isfile(file_path):
        return 0

    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".py":
        try:
            with open(file_path, "r", encoding="utf-8") as fh:
                src = fh.read()
            compile(src, file_path, "exec")
        except SyntaxError as e:
            _emit(f"⚠️ Python syntax error in {os.path.basename(file_path)} "
                  f"(line {e.lineno}): {e.msg}. Fix it before running.")
        except Exception:
            pass  # encoding/read issues are not our job to report
        return 0

    if ext in (".js", ".mjs", ".cjs"):
        try:
            proc = subprocess.run(
                ["node", "--check", file_path],
                capture_output=True, text=True, timeout=20,
            )
            if proc.returncode != 0:
                detail = (proc.stderr or proc.stdout or "").strip().splitlines()
                first = detail[0] if detail else "syntax error"
                _emit(f"⚠️ JS syntax error in {os.path.basename(file_path)}: "
                      f"{first}. Fix it before reloading.")
        except FileNotFoundError:
            pass  # node not installed → skip quietly
        except Exception:
            pass
        return 0

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)  # fail-open
