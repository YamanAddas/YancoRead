from constants import (KIND_PDF, KIND_COMIC, KIND_EBOOK, KIND_OFFICE,
                       KIND_TEXT, KIND_IMAGE)
from detect import detect, kind_for_ext


def test_kind_for_ext():
    assert kind_for_ext('.pdf') == KIND_PDF
    assert kind_for_ext('.cbz') == KIND_COMIC
    assert kind_for_ext('.epub') == KIND_EBOOK
    assert kind_for_ext('.docx') == KIND_OFFICE
    assert kind_for_ext('.py') == KIND_TEXT
    assert kind_for_ext('.PNG') == KIND_IMAGE  # case-insensitive


def test_detect_each_kind(samples):
    assert detect(str(samples['pdf']))['kind'] == KIND_PDF
    assert detect(str(samples['cbz']))['kind'] == KIND_COMIC
    assert detect(str(samples['pptx']))['kind'] == KIND_OFFICE
    assert detect(str(samples['md']))['kind'] == KIND_TEXT
    assert detect(str(samples['png']))['kind'] == KIND_IMAGE


def test_office_formats_route_to_office():
    for ext in ('.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
                '.rtf', '.odt', '.odp', '.ods'):
        assert kind_for_ext(ext) == KIND_OFFICE, ext


def test_detect_rtf_by_magic(tmp_path):
    p = tmp_path / 'noext'
    p.write_bytes(rb'{\rtf1\ansi hello}')
    assert detect(str(p))['kind'] == KIND_OFFICE


def test_detect_ole_office_by_magic(tmp_path):
    p = tmp_path / 'legacy'
    p.write_bytes(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + b'\x00' * 64)
    assert detect(str(p))['kind'] == KIND_OFFICE


def test_detect_missing_file():
    assert detect('Z:\\does\\not\\exist.pdf')['exists'] is False


def test_detect_extensionless_text(tmp_path):
    p = tmp_path / 'README'
    p.write_text('plain text content here\n', encoding='utf-8')
    assert detect(str(p))['kind'] == KIND_TEXT


def test_detect_binary_unknown(tmp_path):
    p = tmp_path / 'blob.bin'
    p.write_bytes(bytes(range(256)) * 4)
    assert detect(str(p))['kind'] == 'unknown'
