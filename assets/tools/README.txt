YancoRead — bundled extractor tools (optional)
==============================================

YancoRead opens .cbr (RAR) comics by shelling out to an external extractor.
It auto-detects one in this priority order:

    1. A binary placed in THIS folder (assets/tools/)
    2. 7-Zip / unrar / unar found on the system PATH
    3. 7-Zip / WinRAR in their default install locations
    4. Windows 10+ system tar.exe  (libarchive / bsdtar — reads RAR natively)

On Windows 10 (1803+) and Windows 11, step 4 means .cbr works with NOTHING
bundled, because tar.exe in System32 is libarchive and decodes RAR.

To guarantee .cbr support on older systems, drop ONE of these here:

    unrar.exe      (from https://www.rarlab.com/rar_add.htm)
    7z.exe + 7z.dll (from https://www.7-zip.org/)
    bsdtar.exe     (libarchive)

This file is a harmless placeholder so the folder is bundled by PyInstaller.
