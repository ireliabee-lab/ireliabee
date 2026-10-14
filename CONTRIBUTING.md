# Contributing

Thank you for helping. A few things make a pull request easy to take:

1. **Open an issue first** for anything larger than a fix, so we can agree on the shape before
   you spend the time.
2. **Keep it focused.** One change per pull request, with a title in the Conventional Commits
   style: `fix(app): …`, `feat(app): …`, `docs: …`.
3. **Run the tests** before you push:

   ```bash
   python -m pytest -q backend/tests
   cd frontend && npx tsc --noEmit && npx vitest run
   ```

4. **Audio capture is platform-split.** A change to `backend/routers/audio.py` has to be reasoned
   about for both Windows (WASAPI loopback through PyAudioWPatch) and Linux (`pw-record` on the
   sink monitor); a test on one proves nothing about the other.
5. **New backend dependencies** need a `hiddenimports` entry in
   `backend/build/interview-coach-backend.spec`, or the packaged app will not find them.
6. **Never commit keys.** Provider keys belong in `~/.config/ireliabee/.env`, not in the tree.

By contributing you agree that your contribution is licensed under the AGPL-3.0, the licence of
this repository.

## Where things live

Some comments refer to `website/`, or to documents under `docs/`, that are not in this
repository: they belong to the hosted service and its planning, which are not open source.

| Path | What |
|---|---|
| `backend/routers/` | HTTP and WebSocket endpoints, one module per feature area |
| `backend/core/` | Storage and coach internals: sessions, profiles, plans, providers, the local guard |
| `frontend/src/components/` | One `*View.tsx` per screen; `Page.tsx` is the shared shell |
| `frontend/src/lib/` | API client, navigation, scenarios, themes |
| `frontend/src-tauri/` | The Rust shell: window, sidecar launch and its per-launch token, updater |
