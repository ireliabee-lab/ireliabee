# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for the Interview Coach backend.

Build:
    cd ireliabee
    pyinstaller backend/build/interview-coach-backend.spec --clean --noconfirm

Output (a folder, not a single file):
    dist/interview-coach-backend/interview-coach-backend.exe
    dist/interview-coach-backend/_internal/...        ≈ 95 MB, read in place

**Why a folder.** A one-file build is an archive that unpacks itself to a temp
directory on every launch and deletes that copy when it exits — except the
desktop app terminates the bootloader, so the delete never ran and about 95 MB
was left behind every single time anyone opened the app. A gigabyte was measured
on the owner’s machine with nothing running, and nothing on screen connected it
to this app.

That was patched twice and neither patch was the fix: moving the unpack somewhere
we own and sweeping it at startup still writes 95 MB per launch, still costs the
extraction time, still hands Windows Defender a fresh copy to scan, and still
leaves a peak of several hundred megabytes for anyone who opens and closes the app
a few times. A folder is read in place. Nothing is extracted, nothing accumulates,
there is nothing to sweep, and the "first launch takes a little longer" splash
stops being a lie on the fiftieth launch.

The exe needs its ``_internal`` folder beside it. Tauri ships the exe as the
sidecar and ``_internal`` as a bundled resource, which on Windows lands in the
same directory — see bundle.resources in frontend/src-tauri/tauri.conf.json.
"""
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(os.getcwd())
BACKEND_DIR = PROJECT_ROOT / "backend"

# Modules that get imported dynamically and PyInstaller can't autodetect.
hiddenimports = [
    # LLM providers
    "anthropic",
    "openai",
    "google.genai",
    # STT + audio
    "sounddevice",
    *(["pyaudiowpatch", "comtypes", "comtypes.client", "comtypes.stream"] if sys.platform == "win32" else []),
    "soundfile",
    "numpy",
    "websockets",
    # Docs
    "pypdf",
    # Debrief PDF: Unicode fonts + Arabic/Devanagari shaping
    "fpdf",
    "uharfbuzz",
    # Calendar (roadmap 3.2)
    "icalendar",
    "recurring_ical_events",
    "tzdata",
    # Licence tokens (Ed25519 signature check)
    "cryptography",
    "cryptography.hazmat.primitives.asymmetric.ed25519",
    # Screenshot
    "mss",
    "PIL",
    "PIL.Image",
    # `--relay-bridge` (main_bundled.py) imports this lazily, so nothing else names it
    "backend.relay_bridge",
    "backend.assistant_runner",
    "backend.link_import",
    "backend.source_tidy",
    "backend.routers.links",
    "backend.study_reviews",
    "backend.routers.study_reviews",
    "backend.talk_drills",
    "backend.routers.talk_drills",
    "backend.dictionary",
    "backend.routers.dictionary",
    "backend.writing",
    "backend.routers.writing",
    "backend.writing_refs",
    "backend.writing_review",
    "backend.writing_export",
    # FastAPI stack
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan.on",
]

datas = []
# Time-zone data for calendar invites (Windows has no IANA database).
from PyInstaller.utils.hooks import collect_data_files
datas += collect_data_files("tzdata")

# Include the backend package itself
datas.append((str(BACKEND_DIR / "main.py"), "backend"))
for f in (BACKEND_DIR / "routers").glob("*.py"):
    datas.append((str(f), "backend/routers"))
datas.append((str(BACKEND_DIR / "deepgram_stream.py"), "backend"))
datas.append((str(BACKEND_DIR / "document_store.py"), "backend"))
datas.append((str(BACKEND_DIR / "transfer.py"), "backend"))
datas.append((str(BACKEND_DIR / "usage.py"), "backend"))
datas.append((str(BACKEND_DIR / "entitlements.py"), "backend"))
datas.append((str(BACKEND_DIR / "screen_capture_xp.py"), "backend"))
# Research Track curriculum: lessons, terms and skills are data, read at runtime.
for f in (BACKEND_DIR / "research_content").glob("*.json"):
    datas.append((str(f), "backend/research_content"))
for f in (BACKEND_DIR / "research_content" / "packs").glob("*.json"):
    datas.append((str(f), "backend/research_content/packs"))
# Write's framework: stages, kinds of writing and their structures (backend/writing.py).
for f in (BACKEND_DIR / "writing_content").glob("*.json"):
    datas.append((str(f), "backend/writing_content"))
# Wordcraft realms: cards, lessons, exercises and placement are data too.
for f in (BACKEND_DIR / "wordcraft_content").glob("*.json"):
    datas.append((str(f), "backend/wordcraft_content"))
# Noto fonts for debrief PDFs in every session language (SIL OFL, see OFL.txt).
for f in (BACKEND_DIR / "fonts").iterdir():
    datas.append((str(f), "backend/fonts"))


binaries = []
# sounddevice loads PortAudio via ctypes at runtime; on Linux it is not bundled
# automatically, so ship the system copy for AppImage users.
if sys.platform.startswith("linux"):
    import ctypes.util
    import glob
    for pattern in ("/usr/lib/x86_64-linux-gnu/libportaudio.so.2*", "/usr/lib64/libportaudio.so.2*", "/usr/lib/libportaudio.so.2*"):
        hits = sorted(glob.glob(pattern))
        if hits:
            binaries.append((hits[0], "."))
            break

a = Analysis(
    [str(BACKEND_DIR / "main_bundled.py")],
    pathex=[str(PROJECT_ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",       # not needed unless region-select overlay is built later
        "matplotlib",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=None,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=None)

# A folder build: the exe carries only the bootloader and the bytecode, and
# COLLECT puts the libraries beside it instead of inside it. `exclude_binaries`
# is what makes the difference — with it, there is no archive to unpack and no
# `runtime_tmpdir` to unpack into.
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="interview-coach-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,          # hide the console window on Windows
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="interview-coach-backend",
)
