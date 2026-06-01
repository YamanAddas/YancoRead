from userdata import UserData


def test_recent_add_remove(tmp_path):
    u = UserData(tmp_path / 'u.json')
    u.add_recent('/x/a.pdf', 'a.pdf', 'pdf')
    assert u.get_recent()[0]['path'] == '/x/a.pdf'
    u.remove_recent('/x/a.pdf')
    assert u.get_recent() == []


def test_position(tmp_path):
    u = UserData(tmp_path / 'u.json')
    u.add_recent('/x/a.pdf', 'a.pdf', 'pdf')
    u.set_position('/x/a.pdf', 5, 0.5)
    pos, prog = u.get_position('/x/a.pdf')
    assert pos == 5 and prog == 0.5


def test_prefs_and_file_prefs(tmp_path):
    u = UserData(tmp_path / 'u.json')
    u.set_prefs('comic', {'rtl': True})
    assert u.get_prefs('comic')['rtl'] is True
    u.set_file_pref('/x/a.cbz', {'dir': 'rtl'})
    assert u.get_file_prefs('/x/a.cbz')['dir'] == 'rtl'


def test_bookmarks(tmp_path):
    u = UserData(tmp_path / 'u.json')
    u.add_bookmark('/x/a.pdf', {'page': 3, 'label': 'cool'})
    assert u.get_bookmarks('/x/a.pdf')[0]['page'] == 3
    u.remove_bookmark('/x/a.pdf', 0)
    assert u.get_bookmarks('/x/a.pdf') == []


def test_persistence_across_instances(tmp_path):
    f = tmp_path / 'u.json'
    UserData(f).add_recent('/x/a.pdf', 'a.pdf', 'pdf')
    assert UserData(f).get_recent()[0]['path'] == '/x/a.pdf'


def test_defaults_present(tmp_path):
    u = UserData(tmp_path / 'u.json')
    assert 'pdf' in u.all_prefs() and 'comic' in u.all_prefs()
    assert u.get_settings()['theme'] == 'dark'
