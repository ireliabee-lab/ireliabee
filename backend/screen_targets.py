"""
Screen-capture targets: list the screens, windows and browser tabs the user
can capture, and grab one of them as a PIL image.

Target ids:
  "screen:<n>"    → monitor n as numbered by mss (1 = primary)
  "window:<hwnd>" → a top-level window (Windows only)

Windows are captured with PrintWindow(PW_RENDERFULLCONTENT), so a window that
sits behind other windows is still captured cleanly. Browser tabs are listed
and switched through UI Automation; only the tab a browser is showing has
pixels, so capturing another tab means switching to it first.
"""
from __future__ import annotations

import base64
import io
import os
import platform
import re
import time
from typing import Optional

from PIL import Image

IS_WINDOWS = platform.system() == "Windows"

THUMB_WIDTH = 360

BROWSERS = {
    "chrome.exe": "Chrome",
    "msedge.exe": "Edge",
    "firefox.exe": "Firefox",
    "brave.exe": "Brave",
    "opera.exe": "Opera",
    "vivaldi.exe": "Vivaldi",
    "arc.exe": "Arc",
}

# Shell surfaces and this app itself are never useful capture targets.
EXCLUDED_EXES = {
    "interview-coach.exe", "textinputhost.exe", "shellexperiencehost.exe",
    "searchhost.exe", "startmenuexperiencehost.exe", "lockapp.exe",
    "applicationframehost.exe",
}


class TargetNotFound(Exception):
    """The requested screen or window no longer exists."""


def image_to_data_url(img: Image.Image, max_width: int, quality: int = 80) -> str:
    im = img.convert("RGB")
    if im.width > max_width:
        im = im.resize((max_width, round(im.height * max_width / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


# ── Screens (all platforms, via mss) ─────────────────────────────────────────

def _mss():
    import mss
    return mss.MSS() if hasattr(mss, "MSS") else mss.mss()


def list_screens(thumbs: bool = True) -> list[dict]:
    screens = []
    with _mss() as sct:
        monitors = sct.monitors[1:]
        for n, mon in enumerate(monitors, start=1):
            primary = bool(mon.get("is_primary")) or (n == 1 and not any(m.get("is_primary") for m in monitors))
            item = {
                "id": f"screen:{n}", "kind": "screen",
                "label": f"Screen {n}" + (" (main)" if primary else ""),
                "width": mon["width"], "height": mon["height"], "primary": primary,
            }
            if thumbs:
                try:
                    item["thumb"] = image_to_data_url(_grab_monitor(sct, n), THUMB_WIDTH, 70)
                except Exception:
                    pass
            screens.append(item)
    return screens


def _grab_monitor(sct, n: int) -> Image.Image:
    shot = sct.grab(sct.monitors[n])
    return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def grab_screen(n: int) -> Image.Image:
    with _mss() as sct:
        if n < 1 or n >= len(sct.monitors):
            raise TargetNotFound(f"Screen {n} is not connected")
        return _grab_monitor(sct, n)


# ── Windows (Windows only) ───────────────────────────────────────────────────

if IS_WINDOWS:
    import ctypes
    import ctypes.wintypes as W

    _user32 = ctypes.windll.user32
    _kernel32 = ctypes.windll.kernel32
    _gdi32 = ctypes.windll.gdi32
    _dwmapi = ctypes.windll.dwmapi
    _version = ctypes.windll.version

    # Real pixel coordinates on mixed-DPI setups (must precede any window query).
    try:
        _user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # per-monitor v2
    except Exception:
        pass

    # 64-bit handles overflow ctypes' default int conversion; declare them.
    _user32.GetWindowDC.argtypes = [W.HWND]
    _user32.GetWindowDC.restype = W.HDC
    _user32.ReleaseDC.argtypes = [W.HWND, W.HDC]
    _user32.PrintWindow.argtypes = [W.HWND, W.HDC, W.UINT]
    _gdi32.CreateCompatibleDC.argtypes = [W.HDC]
    _gdi32.CreateCompatibleDC.restype = W.HDC
    _gdi32.CreateCompatibleBitmap.argtypes = [W.HDC, ctypes.c_int, ctypes.c_int]
    _gdi32.CreateCompatibleBitmap.restype = W.HBITMAP
    _gdi32.SelectObject.argtypes = [W.HDC, W.HGDIOBJ]
    _gdi32.SelectObject.restype = W.HGDIOBJ
    _gdi32.DeleteObject.argtypes = [W.HGDIOBJ]
    _gdi32.DeleteDC.argtypes = [W.HDC]
    _gdi32.GetDIBits.argtypes = [W.HDC, W.HBITMAP, W.UINT, W.UINT, ctypes.c_void_p, ctypes.c_void_p, W.UINT]

    class _BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", W.DWORD), ("biWidth", W.LONG), ("biHeight", W.LONG),
            ("biPlanes", W.WORD), ("biBitCount", W.WORD), ("biCompression", W.DWORD),
            ("biSizeImage", W.DWORD), ("biXPelsPerMeter", W.LONG), ("biYPelsPerMeter", W.LONG),
            ("biClrUsed", W.DWORD), ("biClrImportant", W.DWORD),
        ]

GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_APPWINDOW = 0x00040000
GW_OWNER = 4
DWMWA_EXTENDED_FRAME_BOUNDS = 9
DWMWA_CLOAKED = 14
PW_RENDERFULLCONTENT = 2
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def _window_text(hwnd) -> str:
    n = _user32.GetWindowTextLengthW(hwnd)
    if not n:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    _user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _window_exe_path(hwnd) -> str:
    pid = W.DWORD()
    _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    handle = _kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not handle:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = W.DWORD(1024)
        if _kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value
    finally:
        _kernel32.CloseHandle(handle)
    return ""


_APP_NAMES: dict[str, str] = {}


def _app_name(exe_path: str) -> str:
    """Friendly app name from the exe's FileDescription (e.g. 'Zoom Workplace')."""
    exe = os.path.basename(exe_path)
    if exe.lower() in BROWSERS:
        return BROWSERS[exe.lower()]
    if exe_path in _APP_NAMES:
        return _APP_NAMES[exe_path]
    name = os.path.splitext(exe)[0]
    try:
        size = _version.GetFileVersionInfoSizeW(exe_path, None)
        if size:
            data = ctypes.create_string_buffer(size)
            if _version.GetFileVersionInfoW(exe_path, 0, size, data):
                ptr, length = ctypes.c_void_p(), W.UINT()
                if _version.VerQueryValueW(data, "\\VarFileInfo\\Translation", ctypes.byref(ptr), ctypes.byref(length)) and length.value >= 4:
                    lang, cp = ctypes.cast(ptr, ctypes.POINTER(W.WORD * 2)).contents
                    key = f"\\StringFileInfo\\{lang:04x}{cp:04x}\\FileDescription"
                    if _version.VerQueryValueW(data, key, ctypes.byref(ptr), ctypes.byref(length)) and length.value > 1:
                        desc = ctypes.wstring_at(ptr, length.value - 1).strip()
                        if desc:
                            name = desc
    except Exception:
        pass
    _APP_NAMES[exe_path] = name
    return name


def _is_cloaked(hwnd) -> bool:
    cloaked = W.DWORD()
    ok = _dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
    return ok == 0 and cloaked.value != 0


def _frame_rect(hwnd) -> W.RECT:
    """Visible window bounds (without the invisible resize border)."""
    rect = W.RECT()
    if _dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ctypes.byref(rect), ctypes.sizeof(rect)) != 0:
        _user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect


def _is_capturable(hwnd) -> bool:
    """Alt-Tab style filter: visible, unowned, not a tool window, not cloaked."""
    if not _user32.IsWindowVisible(hwnd) or _is_cloaked(hwnd):
        return False
    ex = _user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
    if ex & WS_EX_TOOLWINDOW:
        return False
    if _user32.GetWindow(hwnd, GW_OWNER) and not ex & WS_EX_APPWINDOW:
        return False
    return True


def _enum_windows() -> list[int]:
    hwnds: list[int] = []

    @ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    def _cb(hwnd, _):
        hwnds.append(hwnd)
        return True

    _user32.EnumWindows(_cb, 0)
    return hwnds


def list_windows(thumbs: bool = True) -> list[dict]:
    if not IS_WINDOWS:
        return []
    windows = []
    for hwnd in _enum_windows():
        if not _is_capturable(hwnd):
            continue
        title = _window_text(hwnd)
        if not title or title.startswith("DevTools - "):
            continue
        pid = W.DWORD()
        _user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == os.getpid():
            continue
        exe_path = _window_exe_path(hwnd)
        exe = os.path.basename(exe_path).lower()
        if exe in EXCLUDED_EXES:
            continue
        minimized = bool(_user32.IsIconic(hwnd))
        rect = _frame_rect(hwnd)
        width, height = rect.right - rect.left, rect.bottom - rect.top
        if not minimized and (width < 120 or height < 80):
            continue
        item = {
            "id": f"window:{hwnd}", "kind": "window",
            "title": title, "app": _app_name(exe_path) if exe_path else "",
            "browser": BROWSERS.get(exe), "minimized": minimized,
            "width": width, "height": height,
        }
        if thumbs and not minimized:
            try:
                item["thumb"] = image_to_data_url(_print_window(hwnd), THUMB_WIDTH, 70)
            except Exception:
                pass
        windows.append(item)
    return windows


def _print_window(hwnd) -> Image.Image:
    """Render a window (even when covered) into an image, cropped to its visible frame."""
    wrect = W.RECT()
    _user32.GetWindowRect(hwnd, ctypes.byref(wrect))
    width, height = wrect.right - wrect.left, wrect.bottom - wrect.top
    if width <= 0 or height <= 0:
        raise RuntimeError("window has no size")
    hdc = _user32.GetWindowDC(hwnd)
    mdc = _gdi32.CreateCompatibleDC(hdc)
    bmp = _gdi32.CreateCompatibleBitmap(hdc, width, height)
    old = _gdi32.SelectObject(mdc, bmp)
    try:
        if not _user32.PrintWindow(hwnd, mdc, PW_RENDERFULLCONTENT):
            raise RuntimeError("PrintWindow failed")
        header = _BITMAPINFOHEADER(ctypes.sizeof(_BITMAPINFOHEADER), width, -height, 1, 32, 0, 0, 0, 0, 0, 0)
        buf = ctypes.create_string_buffer(width * height * 4)
        if not _gdi32.GetDIBits(mdc, bmp, 0, height, buf, ctypes.byref(header), 0):
            raise RuntimeError("GetDIBits failed")
    finally:
        _gdi32.SelectObject(mdc, old)
        _gdi32.DeleteObject(bmp)
        _gdi32.DeleteDC(mdc)
        _user32.ReleaseDC(hwnd, hdc)
    img = Image.frombuffer("RGB", (width, height), buf, "raw", "BGRX", 0, 1)
    frame = _frame_rect(hwnd)
    box = (frame.left - wrect.left, frame.top - wrect.top,
           frame.right - wrect.left, frame.bottom - wrect.top)
    if box != (0, 0, width, height) and box[2] > box[0] and box[3] > box[1]:
        img = img.crop(box)
    return img


def _grab_window_from_screen(hwnd) -> Image.Image:
    """Fallback: copy the window's area of the screen (includes anything on top of it)."""
    rect = _frame_rect(hwnd)
    with _mss() as sct:
        shot = sct.grab({"left": rect.left, "top": rect.top,
                         "width": rect.right - rect.left, "height": rect.bottom - rect.top})
        return Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def _check_window(hwnd: int):
    if not IS_WINDOWS or not _user32.IsWindow(hwnd):
        raise TargetNotFound("That window has been closed")
    if _user32.IsIconic(hwnd):
        raise TargetNotFound("That window is minimized — restore it, then capture again")


def grab_window(hwnd: int) -> Image.Image:
    _check_window(hwnd)
    try:
        img = _print_window(hwnd)
        # GPU-rendered windows can come back all black; fall back to the screen copy.
        if img.convert("L").getextrema()[1] > 8:
            return img
    except Exception:
        pass
    return _grab_window_from_screen(hwnd)


# ── Browser tabs (Windows, UI Automation) ────────────────────────────────────

_UIA = None


def _uia():
    """(IUIAutomation, UIAutomationClient module), created once per process."""
    global _UIA
    if _UIA is None:
        import comtypes
        import comtypes.client
        comtypes.client.GetModule("UIAutomationCore.dll")
        from comtypes.gen import UIAutomationClient as client
        automation = comtypes.client.CreateObject(client.CUIAutomation, interface=client.IUIAutomation)
        _UIA = (automation, client)
    return _UIA


def _com_init():
    import comtypes
    try:
        comtypes.CoInitializeEx(comtypes.COINIT_MULTITHREADED)
    except OSError:
        pass  # already initialised on this thread


def _tab_items(hwnd: int) -> list:
    """The browser's tab-strip items (ARIA tabs inside web pages are excluded)."""
    _com_init()
    automation, client = _uia()
    root = automation.ElementFromHandle(hwnd)
    cond = automation.CreatePropertyCondition(client.UIA_ControlTypePropertyId, client.UIA_TabItemControlTypeId)
    found = root.FindAll(client.TreeScope_Descendants, cond)
    walker = automation.ControlViewWalker
    items = []
    for i in range(found.Length):
        el = found.GetElement(i)
        parent, in_page = el, False
        for _ in range(40):
            parent = walker.GetParentElement(parent)
            if not parent:
                break
            if parent.CurrentControlType == client.UIA_DocumentControlTypeId:
                in_page = True
                break
        if not in_page:
            items.append(el)
    return items


def _is_selected(el) -> bool:
    _, client = _uia()
    try:
        pattern = el.GetCurrentPattern(client.UIA_SelectionItemPatternId)
        return bool(pattern.QueryInterface(client.IUIAutomationSelectionItemPattern).CurrentIsSelected)
    except Exception:
        return False


# Status suffixes Chromium appends to tab names ("… - Memory usage - 41.6 MB").
_TAB_SUFFIX = re.compile(
    r"(\s+-\s+(Memory usage - [\d.,]+\s*[KMG]B|Audio playing|Audio muted|Pinned|"
    r"Network error|Crashed|Camera or microphone recording|Camera recording|"
    r"Microphone recording|Sharing your screen|Bluetooth device connected))+$",
    re.IGNORECASE,
)


def list_tabs(hwnd: int) -> list[dict]:
    _check_window(hwnd)
    tabs = []
    for i, el in enumerate(_tab_items(hwnd)):
        title = el.CurrentName or ""
        tabs.append({"index": i, "title": title, "label": _TAB_SUFFIX.sub("", title) or title,
                     "selected": _is_selected(el)})
    return tabs


def select_tab(hwnd: int, index: int, title: Optional[str] = None) -> bool:
    """
    Switch the browser window to a tab. Matches by title first (tab order may
    have changed since the list was fetched), then by index. Returns True if
    the tab changed (callers should let the page repaint before capturing).
    """
    _check_window(hwnd)
    items = _tab_items(hwnd)
    target = None
    if title:
        target = next((el for el in items if el.CurrentName == title), None)
    if target is None and 0 <= index < len(items):
        target = items[index]
    if target is None:
        raise TargetNotFound("That tab has been closed")
    if _is_selected(target):
        return False
    _, client = _uia()
    try:
        pattern = target.GetCurrentPattern(client.UIA_SelectionItemPatternId)
        pattern.QueryInterface(client.IUIAutomationSelectionItemPattern).Select()
    except Exception:
        pattern = target.GetCurrentPattern(client.UIA_LegacyIAccessiblePatternId)
        pattern.QueryInterface(client.IUIAutomationLegacyIAccessiblePattern).DoDefaultAction()
    return True


# ── Entry points ─────────────────────────────────────────────────────────────

def list_targets(thumbs: bool = True) -> dict:
    return {"screens": list_screens(thumbs), "windows": list_windows(thumbs)}


def parse_target(target: str) -> tuple[str, int]:
    kind, _, value = (target or "").partition(":")
    if kind not in ("screen", "window") or not value.lstrip("-").isdigit():
        raise ValueError(f"Unknown capture target: {target!r}")
    return kind, int(value)


def grab(target: str, tab_index: Optional[int] = None, tab_title: Optional[str] = None) -> Image.Image:
    kind, value = parse_target(target)
    if kind == "screen":
        return grab_screen(value)
    if tab_index is not None or tab_title:
        if select_tab(value, tab_index if tab_index is not None else -1, tab_title):
            time.sleep(0.6)  # let the newly shown tab paint
    return grab_window(value)
