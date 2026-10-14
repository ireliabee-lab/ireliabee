"""
Cross-platform screen capture wrapper.

- Linux : delegate to the CLI's screen_capture module (ImageMagick / grim / etc.)
- Windows: use `mss` for full-screen; region/window fall back to full-screen with a note
- macOS : `mss` for full-screen; region/window fall back to full

The result is always a written PNG path on disk, matching the CLI shape.

grab_target() is the picker-driven path: capture a chosen screen, window or
browser tab (see screen_targets), keep it under a capture id, and let the
analysis step crop it to a region the user dragged out.
"""
from __future__ import annotations

import platform
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from typing import Literal, Optional

from .core.appdirs import DATA_DIR

#: The same folder the Linux path writes to (core/screen_capture.py). The two
#: have to agree: this module takes the Windows and macOS shots itself and hands
#: Linux over to that one, so a folder fixed in only one place would split a
#: user's screenshots by platform.
CAPTURE_DIR = DATA_DIR / "screens"
CaptureMode = Literal["full", "region", "window"]

IS_WINDOWS = platform.system() == "Windows"
IS_LINUX   = platform.system() == "Linux"
IS_MACOS   = platform.system() == "Darwin"


def _now_stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def _capture_dir_for(session_id) -> Path:
    d = CAPTURE_DIR / str(session_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _capture_mss(mode: CaptureMode, out: Path, monitor_idx: int = 1) -> Path:
    """mss-based full-screen capture (Windows/macOS/Linux X11)."""
    import mss
    from PIL import Image
    with mss.mss() as sct:
        # monitor 0 = all monitors; monitor 1 = primary
        idx = monitor_idx if monitor_idx < len(sct.monitors) else 1
        img = sct.grab(sct.monitors[idx])
        Image.frombytes("RGB", img.size, img.bgra, "raw", "BGRX").save(out)
    return out


def capture(session_id, mode: CaptureMode = "region") -> Path:
    """Capture a screenshot. Returns the path of the written PNG."""
    out_dir = _capture_dir_for(session_id)
    out = out_dir / f"{_now_stamp()}.png"

    if IS_LINUX:
        # Linux: delegate to the mature CLI implementation
        from .core import screen_capture as cli_sc
        return cli_sc.capture(session_id=session_id, mode=mode)

    # Windows / macOS: mss-based fallback. Region/window are approximated as
    # full-screen (a proper picker would need a native overlay UI).
    return _capture_mss("full" if mode == "full" else "full", out)


# ── Picker-driven captures ───────────────────────────────────────────────────

_MAX_CAPTURES = 50
_captures: "OrderedDict[str, Path]" = OrderedDict()
_captures_lock = threading.Lock()


def grab_target(session_id, target: str, tab_index: Optional[int] = None,
                tab_title: Optional[str] = None):
    """Capture a picker target. Returns (capture_id, path, PIL image)."""
    from . import screen_targets
    img = screen_targets.grab(target, tab_index, tab_title)
    capture_id = uuid.uuid4().hex
    path = _capture_dir_for(session_id) / f"{_now_stamp()}-{capture_id[:8]}.png"
    img.save(path)
    with _captures_lock:
        _captures[capture_id] = path
        while len(_captures) > _MAX_CAPTURES:
            _captures.popitem(last=False)
    return capture_id, path, img


def capture_path(capture_id: str) -> Optional[Path]:
    with _captures_lock:
        path = _captures.get(capture_id)
    return path if path and path.exists() else None


def crop_capture(path: Path, region: dict) -> Path:
    """Crop a saved capture to {x, y, w, h} (capture pixels); returns the new PNG."""
    from PIL import Image
    with Image.open(path) as img:
        x = max(0, int(region["x"]))
        y = max(0, int(region["y"]))
        right = min(img.width, x + int(region["w"]))
        bottom = min(img.height, y + int(region["h"]))
        if right - x < 8 or bottom - y < 8:
            raise ValueError("Selected region is too small")
        out = path.with_name(f"{path.stem}-crop-{x}-{y}-{right - x}x{bottom - y}.png")
        img.crop((x, y, right, bottom)).save(out)
    return out
