"""Tests for the app-close fix (the native window-close deadlock + orphan guard).

Root cause: window.py's `closing` handler called window.evaluate_js, which pywebview
runs synchronously on the GUI thread and blocks on a semaphore that same thread must
release — a deadlock that hung the window on close and orphaned the Flask backend.
The fix moves the unsaved-changes signal to an HTTP flag the frontend pushes, plus a
parent-watchdog so a force-killed launcher can't leave an orphan.
"""

import os
import subprocess
import sys
import time


# ── /api/ui-state: the frontend pushes the unsaved flag; the close handler reads it ──

def test_ui_state_roundtrip(client):
    # default is clean
    assert client.get('/api/ui-state').get_json() == {'dirty': False}
    # frontend reports unsaved work
    assert client.post('/api/ui-state', json={'dirty': True}).status_code == 200
    assert client.get('/api/ui-state').get_json()['dirty'] is True
    # …and back to clean after a save
    client.post('/api/ui-state', json={'dirty': False})
    assert client.get('/api/ui-state').get_json()['dirty'] is False


def test_ui_state_get_needs_no_token(client):
    # The native close handler (window.py) reads this via a plain GET with NO API
    # token, so the GET must not be token-gated.
    c = client.application.test_client()           # fresh client, no token header
    r = c.get('/api/ui-state')
    assert r.status_code == 200
    assert 'dirty' in r.get_json()


def test_ui_state_post_is_token_gated(client):
    # Writing the flag is a POST, so it must require the token like other writes.
    c = client.application.test_client()           # no token header
    assert c.post('/api/ui-state', json={'dirty': True}).status_code == 403


# ── parent watchdog: detects a dead launcher so the backend can't orphan ─────

def test_parent_alive_self_and_dead():
    import app
    assert app._parent_alive(os.getpid()) is True
    p = subprocess.Popen([sys.executable, '-c', 'pass'])
    p.wait()
    time.sleep(0.3)
    assert app._parent_alive(p.pid) is False
    assert app._parent_alive(999999) is False


def test_watchdog_noop_without_env(monkeypatch):
    # Without YR_PARENT_PID (backend-only / tests) the watchdog must not start.
    import app
    monkeypatch.delenv('YR_PARENT_PID', raising=False)
    app._start_parent_watchdog()                   # must not raise / must be a no-op
    assert not any(t.name == 'parent-watchdog' for t in __import__('threading').enumerate())
