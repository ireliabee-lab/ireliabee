# iReliabee (open edition)

**Practise any conversation. Speak with confidence.**

iReliabee is a desktop coach for the conversations that matter: job interviews, meetings,
pitches, presentations, negotiations, vivas, difficult conversations, public speaking, or a
scenario you describe. It listens to your microphone (and, if you want, the other side of a
call), transcribes it as you speak, and gives you glanceable cues, a short answer and the full
version, with your CV and documents as context. Around that sit practice and mock interviews,
preparation plans, saved stories, debriefs, progress tracking, notebooks, a writing room with
citations, a research track and an English course (Wordcraft).

This is the **open edition**, published under the AGPL-3.0. It runs entirely on **your own
provider keys**: every feature is available, no account is needed, and the app talks to no
server of ours.

iReliabee is built for practice and preparation. Rehearse the conversation ahead of time so you
can handle it yourself when it counts.

## How it is put together

| Part | Where | What it is |
|---|---|---|
| Desktop shell | `frontend/src-tauri/` | Tauri 2 (Rust): the window, the tray, and the backend's launch |
| Interface | `frontend/src/` | React 18 + TypeScript + Vite |
| Local backend | `backend/` | Python / FastAPI + SQLite, bundled with PyInstaller as a *sidecar* |

The backend listens on `127.0.0.1` on a port the OS gives it at start-up, and only the app may
use it: every request needs a token made fresh for each launch (`backend/core/local_guard.py`).
A `401` from that port in a browser is the lock working, not a bug.

Your data stays on your computer: `~/.config/ireliabee` (settings, `.env` with your keys,
`backend.log`) and `~/.local/share/ireliabee/sessions.db` (sessions, profiles, plans, stories,
library, notebooks).

## Your own keys

Open **Settings**, choose a provider for the **Language Model** and for **Speech-to-Text**, and
paste the key beside it. Keys are kept in `~/.config/ireliabee/.env` on this computer only, and
calls go straight from your computer to the provider, billed to you by them.

| Key | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Claude: coaching, practice, debriefs, notebooks, writing review |
| `OPENAI_API_KEY` | GPT models, and Whisper as a batch speech-to-text fallback |
| `GEMINI_API_KEY` | Gemini models |
| `DEEPSEEK_API_KEY` | DeepSeek models |
| `GROQ_API_KEY` | Fast models and batch speech-to-text on Groq |
| `DEEPGRAM_API_KEY` | Live speech-to-text, voice practice and voices |
| `TAVILY_API_KEY` / `SEARCH_API_KEY` | Optional web search for research features |

You only need the providers you pick. A typical set-up is one language model key plus a
Deepgram key for live transcription.

Each provider has its own terms about what it does with what you send it, including whether it
trains on it. Read them before you choose one.

## What the hosted service adds (optional, off by default)

iReliabee also runs a hosted service, which this repository does not contain. Signed in to it,
the app uses iReliabee's AI and speech recognition instead of your keys, paid per use in
credits, and can send meeting reminders by email or text. In the open edition it is **off**:
nothing is sent to it and the sign-in form is not shown. To turn it on, start the app with the
environment variable `IRELIABEE_HOSTED=1`.

## Build from source

### Prerequisites

| Tool | Version |
|---|---|
| Python | 3.12 (what the tests and builds use) |
| Node.js | 20 or later (with npm) |
| Rust | stable, via [rustup](https://rustup.rs) |
| Tauri prerequisites | see [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/) |

Platform notes:

- **Windows:** the Visual Studio C++ Build Tools and the WebView2 runtime (already on Windows
  10/11). System audio is captured through WASAPI loopback (PyAudioWPatch, installed by
  `requirements.txt`).
- **Linux:** `libwebkit2gtk-4.1-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
  `libportaudio2`, and PipeWire (`pw-record`) for system audio. Screen capture uses ImageMagick
  or `grim`.
- **macOS:** builds with the Xcode command-line tools. We do not test on macOS. The microphone
  works; capturing the other side of a call needs a virtual audio device such as BlackHole.

### Run it from source

```bash
git clone https://github.com/ireliabee-lab/ireliabee.git
cd ireliabee

python -m venv .venv
# Windows: .venv\Scripts\activate      Linux/macOS: source .venv/bin/activate
pip install -r backend/requirements.txt -c backend/constraints.txt

cd frontend && npm ci && cd ..
```

Then, in two terminals:

```bash
# 1. the backend, on port 8000
python -m uvicorn backend.main:app --reload --port 8000

# 2. the interface in a browser (Vite on http://localhost:1420) ...
cd frontend && npm run dev
# ... or the desktop window, with the backend from terminal 1
make dev            # Linux/macOS; on Windows see "Desktop window on Windows" below
```

**Desktop window on Windows.** Tauri expects a sidecar binary to exist, even when you run the
backend yourself:

```powershell
mkdir frontend\src-tauri\binaries
copy C:\Windows\System32\cmd.exe frontend\src-tauri\binaries\interview-coach-backend-x86_64-pc-windows-msvc.exe
cd frontend
$env:INTERVIEW_COACH_SKIP_SIDECAR = "1"; npm run tauri dev
```

### Build an installer

```bash
# 1. the backend as a folder build (dist/interview-coach-backend/)
pyinstaller backend/build/interview-coach-backend.spec --clean --noconfirm

# 2. copy it beside the app as the sidecar, named for your target triple
#    (rustc -vV | grep host), e.g. x86_64-pc-windows-msvc or x86_64-unknown-linux-gnu
mkdir -p frontend/src-tauri/binaries
cp dist/interview-coach-backend/interview-coach-backend* \
   frontend/src-tauri/binaries/interview-coach-backend-<target-triple>[.exe]

# 3. the app
cd frontend && npm run tauri build
```

On Linux and macOS, `make build` does all three. Installers land in
`frontend/src-tauri/target/release/bundle/`.

**Updates.** The open edition does not update itself: it follows no release feed. If you
publish builds of your own, set `plugins.updater.endpoints` and `plugins.updater.pubkey` in
`frontend/src-tauri/tauri.conf.json`, `bundle.createUpdaterArtifacts` to `true`, and
`AUTO_UPDATE` in `frontend/src/lib/edition.ts`, and sign your releases with your own key.

**Dictionary.** Wordcraft's dictionary (Open English WordNet and Tatoeba) is not in the
repository. Build it with `python scripts/build_dictionary.py` and point
`IRELIABEE_DICTIONARY_URL` at the folder holding `manifest.json` and `dictionary.db.gz`
(a `file:///` address works).

## Tests

```bash
python -m pytest -q backend/tests
cd frontend && npx tsc --noEmit && npx vitest run
```

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Please report
security problems privately, as described in [SECURITY.md](SECURITY.md).

## Licence

iReliabee's open edition is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License, version 3, as published by the Free Software
Foundation. See [LICENSE](LICENSE). If you run a modified version for others over a network,
the AGPL asks you to offer them its source.

Bundled third-party material (fonts, citation styles, data) keeps its own licence: see
[NOTICE.md](NOTICE.md).

"iReliabee" and the iReliabee logo are the project's name and mark. You may build and share the
software under the AGPL; please give a fork that you distribute a name of its own.

Copyright (C) 2026 iReliabee Lab.
