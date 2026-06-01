from urllib.parse import quote


def _q(path):
    return quote(str(path))


def test_health(client):
    r = client.get('/health')
    assert r.status_code == 200 and r.get_json()['status'] == 'ok'


def test_open_and_page_render(client, samples):
    r = client.post('/api/open', json={'path': str(samples['pdf'])})
    assert r.status_code == 200
    assert r.get_json()['doc']['kind'] == 'pdf'
    pg = client.get(f"/api/page?path={_q(samples['pdf'])}&index=0&zoom=1")
    assert pg.status_code == 200 and pg.mimetype == 'image/png'


def test_open_unsupported(client, tmp_path):
    p = tmp_path / 'x.zzz'
    p.write_bytes(b'\x00\x01\x02\x00')
    r = client.post('/api/open', json={'path': str(p)})
    assert r.status_code == 415


def test_open_missing(client):
    r = client.post('/api/open', json={'path': 'Z:\\nope.pdf'})
    assert r.status_code == 404


def test_comic_endpoints(client, samples):
    r = client.post('/api/open', json={'path': str(samples['cbz_panels'])})
    assert r.get_json()['doc']['kind'] == 'comic'
    assert client.get(f"/api/comic-page?path={_q(samples['cbz_panels'])}&index=0").status_code == 200
    pn = client.get(f"/api/comic-panels?path={_q(samples['cbz_panels'])}&index=0").get_json()
    assert pn['count'] == 4


def test_office_text_image(client, samples):
    assert client.get(f"/api/office?path={_q(samples['pptx'])}").get_json()['html']
    assert client.get(f"/api/text?path={_q(samples['md'])}").get_json()['mode'] == 'markdown'
    assert client.get(f"/api/image?path={_q(samples['png'])}").status_code == 200


def test_recent_and_prefs(client, samples):
    client.post('/api/open', json={'path': str(samples['pdf'])})
    recent = client.get('/api/recent').get_json()['recent']
    assert any(r['path'] == str(samples['pdf']) for r in recent)
    client.post('/api/prefs', json={'kind': 'comic', 'prefs': {'fit': 'width'}})
    assert client.get('/api/prefs?kind=comic').get_json()['prefs']['fit'] == 'width'


def test_file_prefs_roundtrip(client, samples):
    client.post('/api/file-prefs', json={'path': str(samples['cbz']), 'prefs': {'dir': 'rtl'}})
    r = client.post('/api/open', json={'path': str(samples['cbz'])})
    assert r.get_json()['doc']['file_prefs']['dir'] == 'rtl'


def test_doc_text(client, samples):
    r = client.get(f"/api/doc-text?path={_q(samples['pdf'])}&start=0&end=3")
    assert r.status_code == 200
    j = r.get_json()
    assert j['page_count'] == 3 and 'fox' in j['text'].lower()
    assert client.get('/api/doc-text').status_code == 400
