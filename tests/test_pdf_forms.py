"""P7a — PDF form filling backend.

Covers two layers: (1) FitzDoc.form_fields(), which enumerates fillable AcroForm
widgets (text / checkbox / combobox / listbox) as flat UI descriptors, and
FitzDoc.set_field(), which writes one widget's value in memory while keeping the
doc incrementally savable so a filled form rides the in-place Save path; (2) the
Flask routes /api/pdf/fields and /api/pdf/field that drive both.

Like the sign + page-ops tests, every test builds its own form PDF in tmp_path
(the shared `samples` fixture has none) so nothing is mutated, and the module-
global FitzDoc cache is purged after each test so Windows releases file handles.

Radio groups are deliberately absent from the synthetic fixture: PyMuPDF cannot
add a radio kid from scratch without a pre-existing parent field (its widget
validator raises "bad xref"). The radio branch in set_field is exercised only
against real-world radio PDFs, not unit-tested here.
"""
import fitz
import pytest

from renderers import fitzdoc
from renderers.fitzdoc import FitzDoc


def _make_form_pdf(path):
    """A one-page PDF with a text field, a read-only text field, a checkbox,
    a combobox and a listbox — one of every fillable kind we support."""
    doc = fitz.open()
    page = doc.new_page()

    w = fitz.Widget(); w.field_name = 'full_name'
    w.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    w.rect = fitz.Rect(72, 72, 320, 92); w.field_value = ''
    page.add_widget(w)

    w = fitz.Widget(); w.field_name = 'locked'
    w.field_type = fitz.PDF_WIDGET_TYPE_TEXT
    w.rect = fitz.Rect(72, 100, 320, 120); w.field_value = 'cannot change'
    w.field_flags = 1                                   # ReadOnly
    page.add_widget(w)

    w = fitz.Widget(); w.field_name = 'agree'
    w.field_type = fitz.PDF_WIDGET_TYPE_CHECKBOX
    w.rect = fitz.Rect(72, 130, 92, 150); w.field_value = False
    page.add_widget(w)

    w = fitz.Widget(); w.field_name = 'country'
    w.field_type = fitz.PDF_WIDGET_TYPE_COMBOBOX
    w.rect = fitz.Rect(72, 160, 320, 180)
    w.choice_values = ['USA', 'Canada', 'Mexico']; w.field_value = 'USA'
    page.add_widget(w)

    w = fitz.Widget(); w.field_name = 'fruit'
    w.field_type = fitz.PDF_WIDGET_TYPE_LISTBOX
    w.rect = fitz.Rect(72, 190, 320, 240)
    w.choice_values = ['Apple', 'Pear', 'Plum']; w.field_value = 'Apple'
    page.add_widget(w)

    doc.save(str(path)); doc.close()
    return path


def _field_values(path) -> dict:
    """Read {name: value} straight off disk, bypassing the FitzDoc cache."""
    d = fitz.open(str(path))
    try:
        out = {}
        for pno in range(d.page_count):
            for w in (d.load_page(pno).widgets() or []):
                out[w.field_name] = w.field_value
        return out
    finally:
        d.close()


@pytest.fixture
def form_pdf(tmp_path):
    return _make_form_pdf(tmp_path / 'form.pdf')


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


# ── FitzDoc.form_fields ───────────────────────────────────────────────────────────
def test_form_fields_enumerates_all_kinds(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        info = doc.form_fields()
        assert info['is_form'] is True
        by_name = {f['name']: f for f in info['fields']}
        assert set(by_name) == {'full_name', 'locked', 'agree', 'country', 'fruit'}
        assert by_name['full_name']['kind'] == 'text'
        assert by_name['agree']['kind'] == 'checkbox'
        assert by_name['country']['kind'] == 'combo'
        assert by_name['fruit']['kind'] == 'list'
    finally:
        doc.close()


def test_form_fields_text_metadata(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        by_name = {f['name']: f for f in doc.form_fields()['fields']}
        t = by_name['full_name']
        assert t['readonly'] is False
        assert 'maxlen' in t and 'multiline' in t
        assert by_name['locked']['readonly'] is True
    finally:
        doc.close()


def test_form_fields_each_has_rect(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        for f in doc.form_fields()['fields']:
            assert len(f['rect']) == 4
            x0, y0, x1, y1 = f['rect']
            assert x1 > x0 and y1 > y0
    finally:
        doc.close()


def test_form_fields_choice_options(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        by_name = {f['name']: f for f in doc.form_fields()['fields']}
        assert by_name['country']['options'] == ['USA', 'Canada', 'Mexico']
        assert by_name['fruit']['options'] == ['Apple', 'Pear', 'Plum']
    finally:
        doc.close()


def test_form_fields_checkbox_state(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        cb = next(f for f in doc.form_fields()['fields'] if f['name'] == 'agree')
        assert cb['on'] == 'Yes'
        assert cb['checked'] is False
    finally:
        doc.close()


def test_form_fields_non_form_pdf(samples):
    doc = FitzDoc(str(samples['pdf']))
    try:
        info = doc.form_fields()
        assert info['is_form'] is False
        assert info['fields'] == []
    finally:
        doc.close()


# ── FitzDoc.set_field ──────────────────────────────────────────────────────────────
def test_set_field_text_marks_dirty(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        assert doc.dirty is False
        res = doc.set_field(0, 'full_name', 'Jane Doe')
        assert res == {'page': 0, 'name': 'full_name', 'value': 'Jane Doe'}
        assert doc.dirty is True
    finally:
        doc.close()


def test_set_field_checkbox_truthy_and_falsy(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        assert doc.set_field(0, 'agree', True)['value'] is True
        assert doc.set_field(0, 'agree', False)['value'] is False
        assert doc.set_field(0, 'agree', 'Yes')['value'] is True
    finally:
        doc.close()


def test_set_field_combo_and_list(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        assert doc.set_field(0, 'country', 'Canada')['value'] == 'Canada'
        assert doc.set_field(0, 'fruit', 'Plum')['value'] == 'Plum'
    finally:
        doc.close()


def test_set_field_readonly_raises(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        with pytest.raises(ValueError):
            doc.set_field(0, 'locked', 'hacked')
    finally:
        doc.close()


def test_set_field_missing_raises_keyerror(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        with pytest.raises(KeyError):
            doc.set_field(0, 'does_not_exist', 'x')
    finally:
        doc.close()


def test_set_field_blank_name_raises(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        with pytest.raises(ValueError):
            doc.set_field(0, '', 'x')
    finally:
        doc.close()


def test_set_field_clamps_page(form_pdf):
    """An out-of-range page clamps to the last page; the field is still found."""
    doc = FitzDoc(str(form_pdf))
    try:
        res = doc.set_field(999, 'full_name', 'Clamped')
        assert res['page'] == doc.doc.page_count - 1
        assert res['value'] == 'Clamped'
    finally:
        doc.close()


def test_set_field_keeps_incrementally_savable(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        doc.set_field(0, 'full_name', 'Jane Doe')
        assert doc.doc.can_save_incrementally()
    finally:
        doc.close()


def test_set_field_persists_after_save(form_pdf):
    doc = FitzDoc(str(form_pdf))
    try:
        doc.set_field(0, 'full_name', 'Jane Doe')
        doc.set_field(0, 'agree', True)
        doc.set_field(0, 'country', 'Mexico')
        out = doc.save()
        assert out['saved'] is True and out['mode'] == 'incremental'
    finally:
        doc.close()
    vals = _field_values(form_pdf)
    assert vals['full_name'] == 'Jane Doe'
    assert vals['agree'] == 'Yes'
    assert vals['country'] == 'Mexico'


# ── Flask: GET /api/pdf/fields ──────────────────────────────────────────────────────
def test_api_fields_lists(client, form_pdf):
    r = client.get('/api/pdf/fields', query_string={'path': str(form_pdf)})
    assert r.status_code == 200
    b = r.get_json()
    assert b['is_form'] is True
    assert {f['name'] for f in b['fields']} == {
        'full_name', 'locked', 'agree', 'country', 'fruit'}


def test_api_fields_non_pdf_is_empty(client, samples):
    r = client.get('/api/pdf/fields', query_string={'path': str(samples['txt'])})
    assert r.status_code == 200
    assert r.get_json() == {'is_form': False, 'fields': []}


def test_api_fields_plain_pdf_not_a_form(client, samples):
    r = client.get('/api/pdf/fields', query_string={'path': str(samples['pdf'])})
    assert r.status_code == 200
    assert r.get_json()['is_form'] is False


def test_api_fields_missing_path(client):
    assert client.get('/api/pdf/fields').status_code == 400


# ── Flask: POST /api/pdf/field ──────────────────────────────────────────────────────
def test_api_field_set_and_save(client, form_pdf):
    r = client.post('/api/pdf/field',
                    json={'path': str(form_pdf), 'page': 0,
                          'name': 'full_name', 'value': 'Jane Doe'})
    assert r.status_code == 200
    b = r.get_json()
    assert b['ok'] is True and b['value'] == 'Jane Doe'

    s = client.post('/api/pdf/save', json={'path': str(form_pdf)})
    assert s.status_code == 200 and s.get_json()['saved'] is True
    assert _field_values(form_pdf)['full_name'] == 'Jane Doe'


def test_api_field_checkbox(client, form_pdf):
    r = client.post('/api/pdf/field',
                    json={'path': str(form_pdf), 'page': 0,
                          'name': 'agree', 'value': True})
    assert r.status_code == 200
    assert client.post('/api/pdf/save', json={'path': str(form_pdf)}).status_code == 200
    assert _field_values(form_pdf)['agree'] == 'Yes'


def test_api_field_choice(client, form_pdf):
    r = client.post('/api/pdf/field',
                    json={'path': str(form_pdf), 'page': 0,
                          'name': 'country', 'value': 'Canada'})
    assert r.status_code == 200 and r.get_json()['value'] == 'Canada'


def test_api_field_missing_path(client):
    r = client.post('/api/pdf/field', json={'name': 'full_name', 'value': 'x'})
    assert r.status_code == 400


def test_api_field_missing_name(client, form_pdf):
    r = client.post('/api/pdf/field', json={'path': str(form_pdf), 'value': 'x'})
    assert r.status_code == 400


def test_api_field_non_pdf(client, samples):
    r = client.post('/api/pdf/field',
                    json={'path': str(samples['txt']), 'name': 'x', 'value': 'y'})
    assert r.status_code == 400


def test_api_field_unknown_field_404(client, form_pdf):
    r = client.post('/api/pdf/field',
                    json={'path': str(form_pdf), 'page': 0,
                          'name': 'ghost', 'value': 'x'})
    assert r.status_code == 404


def test_api_field_readonly_400(client, form_pdf):
    r = client.post('/api/pdf/field',
                    json={'path': str(form_pdf), 'page': 0,
                          'name': 'locked', 'value': 'hacked'})
    assert r.status_code == 400
