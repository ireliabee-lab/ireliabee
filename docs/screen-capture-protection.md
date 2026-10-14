# Screen-Capture Protection

## What it is

A window flag that excludes the iReliabee window from **software screen
capture** — screenshots, screen recorders, and the screen-share feature of
Zoom / Teams / Meet / OBS.

When protection is **ON** and someone shares their screen, the iReliabee
window appears **black / blank** to the other participants, while the local
user still sees it normally.

Toggle it from the **shield icon** in the titlebar. It starts **ON** at app
launch.

## How it works

| Layer | Location | What it does |
|-------|----------|--------------|
| Backend | `src-tauri/src/lib.rs` (`setup()`) | Calls `set_content_protected(true)` at startup |
| UI | `src/components/Titlebar.tsx` | Shield toggle → `setContentProtected(true/false)` |
| Permission | `src-tauri/capabilities/default.json` | `core:window:allow-set-content-protected` |

Under the hood the OS APIs are:
- **Windows** → `SetWindowDisplayAffinity(WDA_EXCLUDECAPTURE)`
- **macOS** → `NSWindow.sharingType = .none`
- **Linux** → best-effort only (see limits)

## What it does NOT do — read this before relying on it

This feature is a **hygiene layer**, not a security boundary. Be explicit with
anyone who evaluates it:

- **The app is still fully detectable.** The process runs normally and is
  visible in Task Manager / Activity Monitor / `ps`, along with its name and
  network connections. Nothing about this hides the app's *existence*.
- **It protects only iReliabee's own window** — not the whole screen, not
  other apps.
- **Audio calls:** no effect whatsoever (it is purely visual).
- **A video/audio call cannot scan the machine.** The other party never
  "detects" the app through the call. The flag only matters if the local user
  *chooses to screen-share* — then this one window won't leak its pixels.
- **A phone camera** pointed at the screen still captures everything on it.
- **Not guaranteed on Linux/Wayland.** The Wayland compositor may ignore the
  flag. Reliable on **Windows and macOS**. (Note: `main.rs` forces
  `GDK_BACKEND=x11` on Linux, which improves the odds under XWayland.)

## Correct one-line description

> "When protection is on and the user screen-shares, this window will not
> appear in the shared video (Windows/macOS)."

Not: "no tool can detect this app."

## Threat-model note

A screen-capture flag does **not** defend against the attack pattern behind
credential/session theft or social engineering (e.g. a stolen session leading
to fraudulent transfers). Those require different controls:

- Hardware-key / phishing-resistant MFA
- Out-of-band transaction signing & approval
- Session timeouts and device binding
- Simply not screen-sharing sensitive windows

Treat this feature as *defense in depth*, layered on top of those — never as a
substitute for them.
