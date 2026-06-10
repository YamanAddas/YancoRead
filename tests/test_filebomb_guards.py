"""
Audit batch #1 — hostile-file hardening + API-key exposure.

Covers:
  • Decompression-bomb guards for comic archives (comicdoc) and Office files (officedoc).
  • Friendly errors for degenerate documents (0-page PDF) instead of raw crashes.
  • /api/settings never leaks the stored AI api_key, and a blank re-save keeps it.
"""
import zipfile

import pytest

# A real-world 0-page PDF (malformed but openable): /Count 0, empty /Kids.
_ZERO_PAGE_PDF = (
    b'%PDF-1.4\n'
    b'1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
    b'2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n'
    b'trailer\n<< /Size 3 /Root 1 0 R >>\n%%EOF\n'
)


# ── comic archive zip-bomb guard ────────────────────────────────────────────────
def test_comic_rejects_oversized_entry(tmp_path, monkeypatch):
    """A comic page whose declared uncompressed size exceeds the cap is refused
    BEFORE the bytes are read (decompression-bomb guard)."""
    from renderers import comicdoc
    cbz = tmp_path / 'bomb.cbz'
    with zipfile.ZipFile(cbz, 'w') as z:
        z.writestr('p00.png', b'\x89PNG' + b'x' * 4000)   # ~4 KB uncompressed
    monkeypatch.setattr(comicdoc, 'MAX_ARCHIVE_ENTRY_BYTES', 100)
    doc = comicdoc.ComicDoc(str(cbz))
    with pytest.raises(ValueError):
        doc.get_page(0)


def test_comic_cbt_rejects_oversized_entry(tmp_path, monkeypatch):
    """The .cbt (tar) branch is guarded too, not just .cbz — hostile archives are
    the app's primary threat model, so each format branch needs coverage."""
    import io
    import tarfile
    from renderers import comicdoc
    cbt = tmp_path / 'bomb.cbt'
    payload = b'\x89PNG' + b'x' * 4000
    with tarfile.open(cbt, 'w') as t:
        info = tarfile.TarInfo('p00.png')
        info.size = len(payload)
        t.addfile(info, io.BytesIO(payload))
    monkeypatch.setattr(comicdoc, 'MAX_ARCHIVE_ENTRY_BYTES', 100)
    doc = comicdoc.ComicDoc(str(cbt))
    with pytest.raises(ValueError):
        doc.get_page(0)


def test_comic_normal_page_still_reads(tmp_path):
    """Regression: a normal comic page reads fine under the (real) cap."""
    from renderers import comicdoc
    cbz = tmp_path / 'ok.cbz'
    with zipfile.ZipFile(cbz, 'w') as z:
        z.writestr('p00.png', b'\x89PNG' + b'y' * 200)
    doc = comicdoc.ComicDoc(str(cbz))
    data, mime = doc.get_page(0)
    assert data and mime == 'image/png'


# ── office decompression-bomb guard ─────────────────────────────────────────────
def test_office_rejects_total_bomb(samples, monkeypatch):
    """An Office archive whose members sum past the total cap is refused."""
    from renderers import officedoc
    monkeypatch.setattr(officedoc, 'MAX_ARCHIVE_TOTAL_BYTES', 10)
    with pytest.raises(ValueError):
        officedoc.to_html(str(samples['xlsx']))


def test_office_rejects_oversized_member(samples, monkeypatch):
    """An Office archive with a single member over the per-entry cap is refused."""
    from renderers import officedoc
    monkeypatch.setattr(officedoc, 'MAX_ARCHIVE_ENTRY_BYTES', 10)
    with pytest.raises(ValueError):
        officedoc.to_html(str(samples['pptx']))


def test_accept_reject_changes_is_bomb_guarded(tmp_path, monkeypatch):
    """accept_reject_changes re-parses an untrusted docx, so its _guard_zip_bomb
    wiring must hold too (not just the to_html path)."""
    docx = pytest.importorskip('docx')
    from renderers import officedoc
    src = tmp_path / 'tracked.docx'
    d = docx.Document()
    d.add_paragraph('Body text.')
    d.save(src)
    monkeypatch.setattr(officedoc, 'MAX_ARCHIVE_TOTAL_BYTES', 10)
    with pytest.raises(ValueError):
        officedoc.accept_reject_changes(str(src), str(tmp_path / 'out.docx'), 'accept')


def test_office_normal_render_still_works(samples):
    """Regression: the bomb guard does NOT block a valid office file from
    rendering under the real caps. (xlsx returns a 'sheets' structure; docx/pptx
    return 'html' — assert a non-empty result either way.)"""
    from renderers import officedoc
    out = officedoc.to_html(str(samples['xlsx']))
    assert isinstance(out, dict) and out
    assert out.get('html') or out.get('sheets')


# ── degenerate document: 0-page PDF ─────────────────────────────────────────────
def test_zero_page_pdf_raises_friendly_error(tmp_path):
    """A 0-page PDF yields a clean ValueError, not an uncaught PyMuPDF crash."""
    from renderers import fitzdoc
    p = tmp_path / 'zero.pdf'
    p.write_bytes(_ZERO_PAGE_PDF)
    doc = fitzdoc.FitzDoc(str(p))
    assert doc.page_count == 0
    # Pin OUR friendly message so a regression to PyMuPDF's raw error is caught
    # (raw load_page also raises ValueError, so a bare raises() wouldn't notice).
    with pytest.raises(ValueError, match='no pages'):
        doc.render_page(0)
    with pytest.raises(ValueError, match='no pages'):
        doc.page_size(0)


def test_zero_page_pdf_via_api(client, tmp_path):
    """The /api/page route returns a clean JSON error (not a 200 image) for a
    0-page PDF."""
    p = tmp_path / 'zero_api.pdf'
    p.write_bytes(_ZERO_PAGE_PDF)
    from urllib.parse import quote
    r = client.get(f'/api/page?path={quote(str(p))}&index=0&zoom=1')
    assert r.status_code == 500
    assert 'error' in r.get_json()


# ── /api/settings api_key exposure ──────────────────────────────────────────────
def test_settings_get_does_not_leak_api_key(client):
    """SECURITY: GET /api/settings must NOT return the stored api_key, but must
    report whether one is set."""
    import app as app_module
    app_module.userdata.set_setting('ai', {
        'backend': 'openai', 'endpoint': 'https://api.openai.com/v1/chat/completions',
        'model': 'gpt-4o', 'api_key': 'sk-SECRET-DO-NOT-LEAK', 'target_lang': 'English',
    })
    ai = client.get('/api/settings').get_json()['settings']['ai']
    assert 'api_key' not in ai
    assert ai.get('api_key_set') is True


def test_settings_post_does_not_echo_api_key(client):
    """The POST response also must not echo the key back to the page."""
    r = client.post('/api/settings', json={'settings': {'ai': {
        'backend': 'openai', 'api_key': 'sk-SECRET-2', 'model': 'gpt-4o'}}})
    assert r.status_code == 200
    ai = r.get_json()['settings']['ai']
    assert 'api_key' not in ai and ai.get('api_key_set') is True


def test_settings_blank_key_keeps_existing(client):
    """A re-save with a blank api_key (the form no longer holds the secret) must
    KEEP the stored key, while still updating other fields."""
    import app as app_module
    client.post('/api/settings', json={'settings': {'ai': {
        'backend': 'openai', 'api_key': 'sk-KEEP-ME'}}})
    client.post('/api/settings', json={'settings': {'ai': {
        'backend': 'openai', 'api_key': '', 'model': 'gpt-4o-mini'}}})
    stored = app_module.userdata.get_settings()['ai']
    assert stored['api_key'] == 'sk-KEEP-ME'        # key preserved
    assert stored['model'] == 'gpt-4o-mini'          # other field updated


def test_settings_new_key_replaces(client):
    """A non-blank api_key on save replaces the stored one."""
    import app as app_module
    client.post('/api/settings', json={'settings': {'ai': {'api_key': 'sk-OLD'}}})
    client.post('/api/settings', json={'settings': {'ai': {'api_key': 'sk-NEW'}}})
    assert app_module.userdata.get_settings()['ai']['api_key'] == 'sk-NEW'
