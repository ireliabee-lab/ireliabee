"""
Screen capture — grab a shot of what's on the user's screen (Zoom window,
coding challenge, whiteboard, diagram, etc.) and hand it to a vision LLM for
analysis.

X11 path uses ImageMagick's `import`. Wayland (grim) is supported if present.

Screenshots are saved under the app's own data folder (core/appdirs.py), in
`screens/<sessionId>/`, so users can review them later.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Literal

from .appdirs import DATA_DIR

#: Under the app's own data folder, like everything else the user owns. This
#: was a hand-built "interview-coach" path the rebrand missed, so screenshots
#: went to a folder nothing else in the app looks at — and the app recreated
#: that folder after the migration had moved it, which is why both sat side by
#: side on the owner's machine.
CAPTURE_DIR = DATA_DIR / "screens"


def _now_stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def _detect_backend() -> str:
    if shutil.which("grim"):
        return "grim"
    if shutil.which("gnome-screenshot"):
        return "gnome-screenshot"
    if shutil.which("import"):
        return "import"
    if shutil.which("scrot"):
        return "scrot"
    raise RuntimeError(
        "No screenshot tool found. Install one: `sudo apt install imagemagick` "
        "(for `import`) or `sudo apt install grim` on Wayland."
    )


CaptureMode = Literal["full", "region", "window"]


def capture(
    session_id: int | str,
    mode: CaptureMode = "region",
) -> Path:
    """Grab a screenshot and return its path.

    Modes:
      full   — entire screen, no prompt
      region — interactive drag-select (default; matches how you'd naturally
                point at a coding-question region)
      window — click a window to capture it whole
    """
    session_dir = CAPTURE_DIR / str(session_id)
    session_dir.mkdir(parents=True, exist_ok=True)
    out = session_dir / f"{_now_stamp()}.png"

    backend = _detect_backend()

    if backend == "import":
        cmd = _import_cmd(mode, out)
    elif backend == "grim":
        cmd = _grim_cmd(mode, out)
    elif backend == "gnome-screenshot":
        cmd = _gnome_cmd(mode, out)
    elif backend == "scrot":
        cmd = _scrot_cmd(mode, out)
    else:
        raise RuntimeError(f"Unhandled backend: {backend}")

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"Screenshot failed ({backend}): {result.stderr.strip() or result.stdout.strip()}"
        )
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError("Screenshot appeared to succeed but the file is empty.")

    return out


# ─── Backend command builders ─────────────────────────────────────────────

def _import_cmd(mode: CaptureMode, out: Path) -> list[str]:
    if mode == "full":
        return ["import", "-window", "root", str(out)]
    if mode == "window":
        # User clicks the target window; import captures it whole.
        return ["import", str(out)]  # default behaviour is window select
    # region: interactive drag-select
    return ["import", str(out)]


def _grim_cmd(mode: CaptureMode, out: Path) -> list[str]:
    if mode == "full":
        return ["grim", str(out)]
    if mode == "region":
        # grim + slurp for interactive select; require slurp installed.
        if not shutil.which("slurp"):
            return ["grim", str(out)]  # fall back to full
        return ["sh", "-c", f'grim -g "$(slurp)" "{out}"']
    if mode == "window":
        return ["grim", str(out)]  # grim has no built-in window picker
    return ["grim", str(out)]


def _gnome_cmd(mode: CaptureMode, out: Path) -> list[str]:
    if mode == "full":
        return ["gnome-screenshot", "-f", str(out)]
    if mode == "region":
        return ["gnome-screenshot", "-a", "-f", str(out)]
    if mode == "window":
        return ["gnome-screenshot", "-w", "-f", str(out)]
    return ["gnome-screenshot", "-f", str(out)]


def _scrot_cmd(mode: CaptureMode, out: Path) -> list[str]:
    if mode == "full":
        return ["scrot", str(out)]
    if mode == "region":
        return ["scrot", "-s", str(out)]
    if mode == "window":
        return ["scrot", "-u", str(out)]
    return ["scrot", str(out)]
