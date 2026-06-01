"""P-v2-3 — Open password-protected PDFs.

Covers FitzDoc's encrypted-document handling:
  * detection — fitz.open() succeeds on a locked file, but pages can't be read
    until authenticate() runs; FitzDoc surfaces this as `.locked` / info()['locked'].
  * FitzDoc.unlock(password) — authenticates with a user OR owner password,
    flips `.locked` False and `.authenticated` True, and (only then) lays out a
    reflowable doc. A wrong/empty password leaves the doc locked so the user can
    retry. The password is never stored on the wrapper.
  * the document cache — an unlocked ("authenticated") doc is protected from LRU
    eviction and from being reopened, so the user is never re-prompted mid-read.
  * the Flask routes — POST /api/open returns {status:'locked'} for a locked file
    (instead of 500), and POST /api/unlock authenticates it; afterwards /api/open
    serves the full payload.

NOTE on this PyMuPDF build: needs_pass stays truthy even AFTER a successful
authenticate, so FitzDoc tracks the live lock state itself rather than re-reading
needs_pass — these tests pin that behaviour down.

The module-global FitzDoc cache is purged after each test so Windows releases
file handles before tmp_path is torn down.
"""
import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc

USER_PW = 'userpw'
OWNER_PW = 'ownerpw'


def _make_encrypted_pdf(path, user_pw=USER_PW, owner_pw=OWNER_PW,
                        method=fitz.PDF_ENCRYPT_AES_256, title='Locked Report',
                        author='Alice', body='SECRET alpha', pages=1):
    doc = fitz.open()
    for i in range(pages):
        pg = doc.new_page(width=300, height=200)
        pg.insert_text((50, 50), body if i == 0 else f'page {i + 1}', fontsize=20)
    if title or author:
        doc.set_metadata({'title': title, 'author': author})
    doc.save(str(path), encryption=method, owner_pw=owner_pw, user_pw=user_pw)
    doc.close()
    return path


def _make_plain_pdf(path, body='open content'):
    doc = fitz.open()
    pg = doc.new_page(width=300, height=200)
    pg.insert_text((50, 50), body, fontsize=20)
    doc.save(str(path))
    doc.close()
    return path


def _page_text(path, page=0):
    d = fitz.open(str(path))
    try:
        return d.load_page(page).get_text()
    finally:
        d.close()


@pytest.fixture
def locked_pdf(tmp_path):
    return _make_encrypted_pdf(tmp_path / 'locked.pdf')


@pytest.fixture
def plain_pdf(tmp_path):
    return _make_plain_pdf(tmp_path / 'plain.pdf')


@pytest.fixture(autouse=True)
def _purge_doc_cache():
    yield
    with fitzdoc._lock:
        docs = [d for _, d in fitzdoc._cache.values()]
        fitzdoc._cache.clear()
    for d in docs:
        try:
            d.close()
        except Exception:
            pass


# ── detection ─────────────────────────────────────────────────────────────────
def test_locked_doc_detected(locked_pdf):
    doc = FitzDoc(str(locked_pdf))
    try:
        assert doc.locked is True
        assert doc.authenticated is False
        # page_count is readable while locked; reflow is deferred (not a reflowable)
        assert doc.page_count == 1
        assert doc.reflowable is False
        info = doc.info()
        assert info['locked'] is True
        # metadata is not readable until authenticated → empty title/author
        assert info['title'] == ''
        assert info['author'] == ''
    finally:
        doc.close()


def test_page_size_raises_while_locked(locked_pdf):
    """The reason api_open must short-circuit: page geometry needs a loaded page."""
    doc = FitzDoc(str(locked_pdf))
    try:
        with pytest.raises(Exception):
            doc.page_size(0)
    finally:
        doc.close()


def test_plain_pdf_not_locked(plain_pdf):
    doc = FitzDoc(str(plain_pdf))
    try:
        assert doc.locked is False
        assert doc.info()['locked'] is False
    finally:
        doc.close()


def test_owner_only_restriction_not_locked(tmp_path):
    """A PDF with an empty *user* password (only owner restrictions) opens without
    a password — it must NOT be treated as locked, or we'd prompt needlessly."""
    p = _make_encrypted_pdf(tmp_path / 'owner_only.pdf', user_pw='', owner_pw=OWNER_PW)
    doc = FitzDoc(str(p))
    try:
        assert doc.locked is False
        assert doc.info()['locked'] is False
    finally:
        doc.close()


# ── FitzDoc.unlock ──────────────────────────────────────────────────────────────
def test_unlock_with_user_password(locked_pdf):
    doc = FitzDoc(str(locked_pdf))
    try:
        assert doc.unlock(USER_PW) is True
        assert doc.locked is False
        assert doc.authenticated is True
        assert doc.info()['locked'] is False
        # metadata + page geometry now readable
        assert doc.info()['title'] == 'Locked Report'
        assert doc.page_size(0)['width'] == 300
    finally:
        doc.close()


def test_unlock_with_owner_password(locked_pdf):
    doc = FitzDoc(str(locked_pdf))
    try:
        assert doc.unlock(OWNER_PW) is True
        assert doc.locked is False
        assert doc.authenticated is True
    finally:
        doc.close()


def test_unlock_wrong_password_keeps_locked(locked_pdf):
    doc = FitzDoc(str(locked_pdf))
    try:
        assert doc.unlock('definitely-wrong') is False
        assert doc.locked is True
        assert doc.authenticated is False
        # a wrong attempt must not poison a later correct one
        assert doc.unlock(USER_PW) is True
        assert doc.locked is False
    finally:
        doc.close()


def test_unlock_empty_password_fails(locked_pdf):
    doc = FitzDoc(str(locked_pdf))
    try:
        assert doc.unlock('') is False
        assert doc.locked is True
    finally:
        doc.close()


def test_unlock_unencrypted_is_noop(plain_pdf):
    doc = FitzDoc(str(plain_pdf))
    try:
        # already open: unlock returns True without needing a real password
        assert doc.unlock('anything') is True
        assert doc.locked is False
        assert doc.authenticated is False  # nothing was authenticated
    finally:
        doc.close()


def test_unlock_idempotent(locked_pdf):
    doc = FitzDoc(str(locked_pdf))
    try:
        assert doc.unlock(USER_PW) is True
        assert doc.unlock(USER_PW) is True   # second call is a no-op success
        assert doc.locked is False
    finally:
        doc.close()


def test_unlock_then_text_is_readable(locked_pdf):
    doc = FitzDoc(str(locked_pdf))
    try:
        assert doc.unlock(USER_PW) is True
        # render path works now: render a page without raising
        png = doc.render_page(0, zoom=1.0)
        assert isinstance(png, (bytes, bytearray)) and png[:4] == b'\x89PNG'
    finally:
        doc.close()


def test_password_not_stored_on_doc(locked_pdf):
    """Security: the password string must not be retained on the wrapper."""
    doc = FitzDoc(str(locked_pdf))
    try:
        assert doc.unlock(USER_PW) is True
        for k, v in vars(doc).items():
            assert v != USER_PW, f'password leaked into attribute {k!r}'
        assert not hasattr(doc, 'password')
    finally:
        doc.close()


# ── document cache: an unlocked doc stays unlocked ──────────────────────────────
def test_get_doc_returns_same_instance_after_unlock(locked_pdf):
    d1 = fitzdoc.get_doc(str(locked_pdf))
    assert d1.locked is True
    assert d1.unlock(USER_PW) is True
    d2 = fitzdoc.get_doc(str(locked_pdf))      # same path, unchanged mtime
    assert d2 is d1
    assert d2.locked is False


def test_authenticated_doc_survives_eviction(tmp_path, locked_pdf):
    """Opening many other files must not re-lock an authenticated session doc."""
    orig = fitzdoc.get_doc(str(locked_pdf))
    assert orig.unlock(USER_PW) is True
    # Flood the LRU with more clean docs than it can hold.
    for i in range(fitzdoc._CACHE_MAX + 2):
        fitzdoc.get_doc(str(_make_plain_pdf(tmp_path / f'extra_{i}.pdf')))
    again = fitzdoc.get_doc(str(locked_pdf))
    assert again is orig            # not evicted → not reopened → not re-locked
    assert again.locked is False
    assert again.authenticated is True


# ── Flask route: POST /api/open on a locked file ────────────────────────────────
def test_route_open_locked_returns_locked_status(client, locked_pdf):
    r = client.post('/api/open', json={'path': str(locked_pdf)})
    assert r.status_code == 200          # NOT a 500
    data = r.get_json()
    assert data['status'] == 'locked'
    assert data['kind'] == 'pdf'
    assert data['path'] == str(locked_pdf)
    assert data['name'] == 'locked.pdf'
    assert 'doc' not in data             # nothing to render yet


def test_route_open_ok_for_plain_pdf(client, plain_pdf):
    r = client.post('/api/open', json={'path': str(plain_pdf)})
    data = r.get_json()
    assert data['status'] == 'ok'
    assert data['doc']['meta']['locked'] is False


# ── Flask route: POST /api/unlock ───────────────────────────────────────────────
def test_route_unlock_success_then_open(client, locked_pdf):
    r = client.post('/api/unlock', json={'path': str(locked_pdf), 'password': USER_PW})
    assert r.status_code == 200
    assert r.get_json()['ok'] is True
    # re-open now serves the full payload (cached doc is authenticated)
    r2 = client.post('/api/open', json={'path': str(locked_pdf)})
    data = r2.get_json()
    assert data['status'] == 'ok'
    assert data['doc']['meta']['locked'] is False
    assert 'page_size' in data['doc']['meta']


def test_route_unlock_wrong_password(client, locked_pdf):
    r = client.post('/api/unlock', json={'path': str(locked_pdf), 'password': 'nope'})
    assert r.status_code == 403
    assert 'password' in r.get_json()['error'].lower()


def test_route_unlock_missing_path(client):
    r = client.post('/api/unlock', json={'password': USER_PW})
    assert r.status_code == 400
    assert 'path' in r.get_json()['error'].lower()


def test_route_unlock_file_not_found(client, tmp_path):
    r = client.post('/api/unlock', json={'path': str(tmp_path / 'nope.pdf'), 'password': USER_PW})
    assert r.status_code == 404


def test_route_unlock_owner_password(client, locked_pdf):
    r = client.post('/api/unlock', json={'path': str(locked_pdf), 'password': OWNER_PW})
    assert r.status_code == 200
    assert r.get_json()['ok'] is True
