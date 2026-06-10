"""
Audit batch #2 — secret/security exposure hardening.

Covers:
  • Tesseract path validation (a configured OCR path must be the tesseract
    binary, so a tampered userdata.json can't run an arbitrary executable).
  • XXE / entity-expansion hardening of the DOCX accept/reject-changes parser.
  • LLM endpoint scheme validation (reject non-HTTP(S) / hostless endpoints).
"""
import zipfile

import pytest


# ── Tesseract path validation ───────────────────────────────────────────────────
def test_valid_tesseract_cmd(tmp_path):
    import app as app_module
    good_exe = tmp_path / 'tesseract.exe'; good_exe.write_bytes(b'x')
    good_nix = tmp_path / 'tesseract'; good_nix.write_bytes(b'x')
    evil = tmp_path / 'evil.exe'; evil.write_bytes(b'x')
    assert app_module._valid_tesseract_cmd(str(good_exe)) is True
    assert app_module._valid_tesseract_cmd(str(good_nix)) is True
    assert app_module._valid_tesseract_cmd(str(evil)) is False           # wrong name
    assert app_module._valid_tesseract_cmd(str(tmp_path / 'tesseract.exe.missing')) is False  # not a file
    assert app_module._valid_tesseract_cmd('') is False


def test_ocr_status_ignores_bad_tesseract_path(client, tmp_path):
    """A configured path that isn't the tesseract binary is ignored (never set as
    the command) and surfaced as a warning."""
    import app as app_module
    import pytesseract
    evil = tmp_path / 'evil.exe'; evil.write_bytes(b'x')
    app_module.userdata.set_setting('tesseract_path', str(evil))
    out = client.get('/api/ocr-status').get_json()
    assert pytesseract.pytesseract.tesseract_cmd != str(evil)   # never pointed at evil.exe
    assert 'warning' in out                                     # told the user it was ignored


# ── DOCX XXE / entity-expansion ─────────────────────────────────────────────────
def test_accept_changes_blocks_xxe(tmp_path):
    """A crafted document.xml with an external-entity reference must NOT disclose
    the local file's contents through the accept/reject-changes rewrite."""
    from renderers import officedoc
    secret = tmp_path / 'secret.txt'
    secret.write_text('TOP-SECRET-XXE-CANARY')
    doc_xml = (
        '<?xml version="1.0"?>'
        '<!DOCTYPE w:document [ <!ENTITY xxe SYSTEM "%s"> ]>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>'
        % secret.as_uri()
    ).encode('utf-8')
    src = tmp_path / 'evil.docx'
    with zipfile.ZipFile(src, 'w') as z:
        z.writestr('word/document.xml', doc_xml)
    dest = tmp_path / 'out.docx'
    result = officedoc.accept_reject_changes(str(src), str(dest), 'accept')
    assert result['ok'] is True                          # operation still succeeds (no crash)
    with zipfile.ZipFile(dest) as z:
        out_xml = z.read('word/document.xml').decode('utf-8', 'replace')
    assert 'TOP-SECRET-XXE-CANARY' not in out_xml         # secret never resolved/leaked


# ── LLM endpoint validation ─────────────────────────────────────────────────────
def test_validate_endpoint_accepts_http_rejects_others():
    from renderers import llm
    llm._validate_endpoint('http://localhost:11434/v1/chat/completions')   # ok
    llm._validate_endpoint('https://api.openai.com/v1/chat/completions')   # ok
    for bad in ('file:///etc/passwd', 'ftp://x/y', 'gopher://x', 'not-a-url', ''):
        with pytest.raises(ValueError):
            llm._validate_endpoint(bad)


def test_chat_rejects_non_http_endpoint(monkeypatch):
    from renderers import llm

    def _boom(*a, **k):
        raise AssertionError('requests.post must not be reached past the guard')
    monkeypatch.setattr(llm.requests, 'post', _boom)
    # Pin OUR guard's distinctive message — requests' own InvalidSchema is also a
    # ValueError, so a bare pytest.raises(ValueError) would pass even without it.
    with pytest.raises(ValueError, match='Invalid LLM endpoint'):
        llm.chat({'backend': 'custom', 'endpoint': 'file:///etc/passwd', 'model': 'm'},
                 [{'role': 'user', 'content': 'hi'}])


def test_list_models_rejects_bad_endpoint(monkeypatch):
    from renderers import llm

    def _boom(*a, **k):
        raise AssertionError('requests.get must not be reached past the guard')
    monkeypatch.setattr(llm.requests, 'get', _boom)
    r = llm.list_models({'backend': 'custom', 'endpoint': 'ftp://nope', 'model': 'm'})
    assert r['ok'] is False
    assert 'Invalid LLM endpoint' in (r.get('error') or '')
