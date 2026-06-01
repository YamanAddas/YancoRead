"""Text reader edit & save: /api/text(/render|/save) round-trip fidelity."""
from urllib.parse import quote


def _q(p):
    return quote(str(p))


def test_text_meta_fields(client, tmp_path):
    """Opening a file reports the metadata the editor round-trips on."""
    p = tmp_path / 'note.txt'
    p.write_bytes(b'\xef\xbb\xbfhello\r\nworld\r\n')   # utf-8 BOM + CRLF
    data = client.get(f"/api/text?path={_q(p)}").get_json()
    assert data['mode'] == 'plain'
    assert data['raw'] == 'hello\r\nworld\r\n'   # BOM stripped, EOL untouched
    assert data['editable'] is True
    assert data['eol'] == 'crlf'
    assert data['bom'] is True
    assert data['encoding'] == 'utf-8'


def test_render_markdown_live(client):
    r = client.post('/api/text/render', json={'content': '# Hi\n\ntext', 'name': 'x.md'})
    j = r.get_json()
    assert j['mode'] == 'markdown'
    assert '<h1' in j['html']


def test_render_code_live(client):
    r = client.post('/api/text/render',
                    json={'content': 'def f():\n    return 1\n', 'name': 'x.py'})
    j = r.get_json()
    assert j['mode'] == 'code'
    assert 'highlight' in j['html']


def test_save_in_place_lf(client, tmp_path):
    p = tmp_path / 'a.txt'
    p.write_text('old\n', encoding='utf-8')
    r = client.post('/api/text/save', json={
        'path': str(p), 'content': 'new line\nsecond\n', 'eol': 'lf', 'encoding': 'utf-8'})
    assert r.get_json()['ok'] is True
    assert p.read_bytes() == b'new line\nsecond\n'


def test_save_preserves_crlf(client, tmp_path):
    p = tmp_path / 'b.txt'
    r = client.post('/api/text/save', json={
        'path': str(p), 'content': 'one\ntwo\n', 'eol': 'crlf', 'encoding': 'utf-8'})
    assert r.status_code == 200
    assert p.read_bytes() == b'one\r\ntwo\r\n'


def test_save_normalizes_then_reapplies_eol(client, tmp_path):
    """Content arriving with mixed/CRLF endings is normalized before re-applying."""
    p = tmp_path / 'mix.txt'
    r = client.post('/api/text/save', json={
        'path': str(p), 'content': 'a\r\nb\rc\n', 'eol': 'crlf', 'encoding': 'utf-8'})
    assert r.status_code == 200
    assert p.read_bytes() == b'a\r\nb\r\nc\r\n'


def test_save_preserves_bom(client, tmp_path):
    p = tmp_path / 'c.txt'
    client.post('/api/text/save', json={
        'path': str(p), 'content': 'x\n', 'eol': 'lf', 'encoding': 'utf-8', 'bom': True})
    assert p.read_bytes() == b'\xef\xbb\xbfx\n'


def test_save_latin1(client, tmp_path):
    p = tmp_path / 'd.txt'
    client.post('/api/text/save', json={
        'path': str(p), 'content': 'café\n', 'eol': 'lf', 'encoding': 'latin-1'})
    assert p.read_bytes() == 'café\n'.encode('latin-1')


def test_save_as_target_leaves_source(client, tmp_path):
    src = tmp_path / 'src.md'
    src.write_text('# orig\n', encoding='utf-8')
    dst = tmp_path / 'copy.md'
    r = client.post('/api/text/save', json={
        'path': str(src), 'target': str(dst), 'content': '# copy\n',
        'eol': 'lf', 'encoding': 'utf-8'})
    j = r.get_json()
    assert j['ok'] is True and j['name'] == 'copy.md'
    assert dst.read_text(encoding='utf-8') == '# copy\n'
    assert src.read_text(encoding='utf-8') == '# orig\n'   # original untouched


def test_save_missing_folder(client, tmp_path):
    bad = tmp_path / 'nope' / 'x.txt'
    r = client.post('/api/text/save', json={'path': str(bad), 'content': 'x'})
    assert r.status_code == 400


def test_save_missing_content(client, tmp_path):
    p = tmp_path / 'e.txt'
    r = client.post('/api/text/save', json={'path': str(p)})
    assert r.status_code == 400


def test_large_file_not_editable(client, tmp_path):
    p = tmp_path / 'big.txt'
    p.write_bytes(b'a' * (4 * 1024 * 1024 + 10))
    data = client.get(f"/api/text?path={_q(p)}").get_json()
    assert data['truncated'] is True
    assert data['editable'] is False


# ── export (PDF / HTML) ──────────────────────────────────────────────────────
def test_export_html_markdown(client, tmp_path):
    dst = tmp_path / 'out.html'
    r = client.post('/api/text/export', json={
        'content': '# Heading\n\n**bold** text', 'name': 'doc.md',
        'format': 'html', 'target': str(dst)})
    j = r.get_json()
    assert j['ok'] is True and j['format'] == 'html'
    body = dst.read_text(encoding='utf-8')
    assert '<!DOCTYPE html>' in body and '<h1' in body and '<strong>bold' in body


def test_export_pdf_markdown(client, tmp_path):
    dst = tmp_path / 'out.pdf'
    r = client.post('/api/text/export', json={
        'content': '# Title\n\nA paragraph for the PDF.', 'name': 'doc.md',
        'format': 'pdf', 'target': str(dst)})
    assert r.get_json()['ok'] is True
    raw = dst.read_bytes()
    assert raw[:5] == b'%PDF-'
    import fitz
    d = fitz.open(str(dst))
    try:
        assert 'Title' in d[0].get_text()      # real text, not rasterised
    finally:
        d.close()


def test_export_code_html_boxed(client, tmp_path):
    dst = tmp_path / 'code.html'
    client.post('/api/text/export', json={
        'content': 'def f():\n    return 1\n', 'name': 'a.py',
        'format': 'html', 'target': str(dst)})
    body = dst.read_text(encoding='utf-8')
    assert '<pre>' in body and 'def f' in body


def test_export_corrects_extension(client, tmp_path):
    dst = tmp_path / 'noext'
    r = client.post('/api/text/export', json={
        'content': 'hi', 'name': 'x.txt', 'format': 'pdf', 'target': str(dst)})
    assert r.get_json()['name'] == 'noext.pdf'
    assert (tmp_path / 'noext.pdf').exists()


def test_export_bad_format(client, tmp_path):
    r = client.post('/api/text/export', json={
        'content': 'hi', 'name': 'x.txt', 'format': 'docx', 'target': str(tmp_path / 'x')})
    assert r.status_code == 400


def test_export_missing_target(client):
    r = client.post('/api/text/export', json={'content': 'hi', 'name': 'x.txt', 'format': 'pdf'})
    assert r.status_code == 400
