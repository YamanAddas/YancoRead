# YancoRead

**One reader for everything you read.**

YancoRead is a universal document reader for the desktop. Open almost any readable file — a PDF, a comic, an eBook, a Word/PowerPoint/Excel document, an image, or plain text and code — and the app instantly becomes the *right* reader for it, with a toolbar tailored to exactly what's on screen.

> Part of the **YancoVerse** family of tools.

---

## The idea

Most apps force a trade-off. Single-purpose readers (one for PDFs, one for comics, one for EPUBs) mean a cluttered desktop and several habits to learn. "Open-everything" apps usually solve that with one generic toolbar that does the bare minimum for each format and the best for none.

YancoRead takes the opposite path: it **detects what you opened and morphs to match.** Open a comic and you get panel-by-panel Guided View and manga right-to-left page flow. Open a PDF and the toolbar fills with page navigation, annotation, signing, and redaction. Open an image and you get zoom, pan, rotate, and EXIF. You never wade through tools that don't apply — the interface is always exactly as deep as the file in front of you, and never deeper.

---

## What it opens

| Kind | Formats | Highlights |
|------|---------|------------|
| **PDF** | `.pdf` | Search, annotate (highlight / note / ink / shapes), fill forms, sign, redact, reorder · rotate · merge · split pages, OCR scanned docs, compress, export pages as images, read-aloud, selectable text layer, password unlock, annotation manager with **JSON + XFDF** export/import |
| **Comic** | `.cbz` `.cbr` `.cb7` `.cbt` | Automatic panel detection → cinematic **Guided View**, webtoon scroll, scan cleanup, auto reading-direction, translation overlay, read-aloud |
| **eBook** | `.epub` `.fb2` `.mobi` `.xps` | Reflowable text, adjustable font size, in-book search, table-of-contents navigation |
| **Office** | `.docx` `.pptx` `.xlsx` | Faithful rendering; editing and round-trip save for Word documents |
| **Text / code** | `.txt` `.md` + source files | Find & replace, syntax highlighting, live editing, word counts, smart JSON / CSV / Markdown-table views |
| **Image** | `.png` `.jpg` `.gif` `.webp` … | Zoom / pan / rotate / flip, EXIF details, folder gallery, slideshow |

---

## Beyond reading: AI tools

YancoRead has built-in AI reading tools — summarize, explain, describe an image, translate a comic, OCR a scan — that plug into whatever backend you prefer: a local model via **Ollama** or **LM Studio**, your own gateway (**OpenClaw**), or a hosted **OpenAI**-compatible API. Configure it in **Settings** (the ⚙ gear); AI is off by default.

Much of the heavy lifting also runs **fully offline**: comic panel detection, OCR, and text-to-speech don't need the cloud, and the app never reports what you read.

---

## Running from source

YancoRead is a native desktop app (Flask + [pywebview](https://pywebview.flowrl.com/) + [PyMuPDF](https://pymupdf.readthedocs.io/)). Developed on **Python 3.10**.

```bash
# 1. clone
git clone https://github.com/YamanAddas/YancoRead.git
cd YancoRead

# 2. create a virtual environment
python -m venv venv

# Windows
venv\Scripts\activate
# macOS / Linux
source venv/bin/activate

# 3. install dependencies
pip install -r requirements.txt

# 4. run
python launch.py
```

On Windows you can also just double-click **`YancoRead.bat`** (it finds the venv automatically). `launch.py` starts the Flask backend on `127.0.0.1:8746`, waits for it to be healthy, then opens the desktop window.

### Optional external tools

A few features lean on external binaries and degrade gracefully when absent:

- **CBR comics** (`.cbr`, RAR archives) need an `unrar` or `7z` tool on your `PATH`.
- **OCR** (reading-direction detection, comic translation/read-aloud on scans) needs [Tesseract](https://github.com/UB-Mannheim/tesseract/wiki) installed. Extra language data (e.g. Arabic) drops into `%APPDATA%\YancoRead\tessdata`.
- **Read-aloud** uses the browser's built-in Web Speech API — no server-side TTS engine required.

### Development

```bash
pip install -r requirements-dev.txt   # adds pytest + pyinstaller
python -m pytest -q                   # run the test suite
python build.py                       # build a standalone app (PyInstaller)
```

---

## Tech stack

- **Backend:** Python · Flask
- **Window:** pywebview (native WebView, not a bundled browser)
- **Rendering:** PyMuPDF (PDF / EPUB / XPS / FB2 / MOBI / CBZ), mammoth + python-pptx + openpyxl (Office), Pygments + Markdown (text), OpenCV (comic panel / balloon detection, scan enhancement)
- **Frontend:** vanilla JavaScript — each reader registers a `mount`/`unmount` and a format-specific toolbar profile
- **Platforms:** Windows · macOS · Linux (developed and packaged on Windows first)

---

## License

YancoRead is licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0). See [`LICENSE`](LICENSE).

This is required because YancoRead builds on **PyMuPDF**, which is itself AGPL-3.0. In short: you're free to use, study, modify, and share it, but if you distribute it — or run a modified version as a network service — you must make the corresponding source available under the same license.
