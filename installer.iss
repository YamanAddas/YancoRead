; YancoRead — Inno Setup installer
; Build: ISCC installer.iss  (or `python build.py` which finds ISCC automatically)
; Per-user install, no admin required. File associations are an opt-in task.

[Setup]
AppName=YancoRead
AppVersion=0.0.1
AppPublisher=YancoVerse
DefaultDirName={autopf}\YancoRead
DefaultGroupName=YancoRead
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=dist
OutputBaseFilename=YancoRead-0.0.1-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=assets\icon.ico
UninstallDisplayIcon={app}\YancoRead.exe

[Files]
Source: "dist\YancoRead\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\YancoRead"; Filename: "{app}\YancoRead.exe"
Name: "{userdesktop}\YancoRead"; Filename: "{app}\YancoRead.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "assoc"; Description: "Set YancoRead as the default reader for comics & eBooks, and add it to 'Open with' for PDF/Office/text"; GroupDescription: "File associations:"

[Registry]
; ── ProgID ────────────────────────────────────────────────────────────────
Root: HKCU; Subkey: "Software\Classes\YancoRead.Document"; ValueType: string; ValueName: ""; ValueData: "YancoRead Document"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\YancoRead.Document\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\YancoRead.exe,0"
Root: HKCU; Subkey: "Software\Classes\YancoRead.Document\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\YancoRead.exe"" ""%1"""

; ── default association for formats that usually have no handler ─────────────
Root: HKCU; Subkey: "Software\Classes\.cbz"; ValueType: string; ValueName: ""; ValueData: "YancoRead.Document"; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.cbr"; ValueType: string; ValueName: ""; ValueData: "YancoRead.Document"; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.cb7"; ValueType: string; ValueName: ""; ValueData: "YancoRead.Document"; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.cbt"; ValueType: string; ValueName: ""; ValueData: "YancoRead.Document"; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.epub"; ValueType: string; ValueName: ""; ValueData: "YancoRead.Document"; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.mobi"; ValueType: string; ValueName: ""; ValueData: "YancoRead.Document"; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.fb2"; ValueType: string; ValueName: ""; ValueData: "YancoRead.Document"; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.xps"; ValueType: string; ValueName: ""; ValueData: "YancoRead.Document"; Tasks: assoc; Flags: uninsdeletevalue

; ── add to "Open with" list (without stealing the default) ──────────────────
Root: HKCU; Subkey: "Software\Classes\.pdf\OpenWithProgids"; ValueType: string; ValueName: "YancoRead.Document"; ValueData: ""; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.docx\OpenWithProgids"; ValueType: string; ValueName: "YancoRead.Document"; ValueData: ""; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.pptx\OpenWithProgids"; ValueType: string; ValueName: "YancoRead.Document"; ValueData: ""; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.xlsx\OpenWithProgids"; ValueType: string; ValueName: "YancoRead.Document"; ValueData: ""; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.txt\OpenWithProgids"; ValueType: string; ValueName: "YancoRead.Document"; ValueData: ""; Tasks: assoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: string; ValueName: "YancoRead.Document"; ValueData: ""; Tasks: assoc; Flags: uninsdeletevalue

[Run]
Filename: "{app}\YancoRead.exe"; Description: "Launch YancoRead"; Flags: nowait postinstall skipifsilent
