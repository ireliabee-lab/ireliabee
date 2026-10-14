"""
Entry point for the PyInstaller-bundled backend.

Starts uvicorn programmatically so the packaged backend is a single binary.

It also chooses the port, which is the reason this file is more than a call to
``uvicorn.run``. The app used to insist on 8000, and anything else holding that
port — another copy of iReliabee, a development server, any web framework in
the world — stopped the whole app with a message blaming the user's antivirus.

So the port is asked for from the operating system here, and the number is
reported only *after* the socket is bound, by the process that holds it. There
is no moment when a port has been chosen but not yet owned, which is the moment
every "find a free port" scheme loses its race in.
"""
from __future__ import annotations

import os
import re
import shutil
import socket
import sys
import threading
import time
from pathlib import Path

#: How the port reaches the desktop app: one line on file descriptor 1, which
#: is the pipe Tauri reads (frontend/src-tauri/src/lib.rs). It has to be the
#: raw descriptor rather than ``print`` because ``_ensure_streams`` has by then
#: pointed ``sys.stdout`` at the log file.
PORT_LINE = "IRELIABEE_PORT"
BIND_FAILED_LINE = "IRELIABEE_BIND_FAILED"
#: Said when the app's process could not be watched directly and we are asking
#: after it instead. Harmless, but worth a line when someone reads the log.
WATCH_FALLBACK_LINE = "IRELIABEE_WATCHING_BY_POLL"
#: ``interview-coach-backend --relay-bridge``: instead of serving, speak MCP over
#: stdio for the user's own assistant (Claude Code, Antigravity) and forward to
#: the running app. Installed users have no Python and no ``backend`` package,
#: so the bridge has to live in this binary.
RELAY_BRIDGE_FLAG = "--relay-bridge"
#: When installed from the Microsoft Store (MSIX), an AppExecutionAlias named
#: ``ireliabee-relay.exe`` points at this binary. Windows invokes the alias
#: with no arguments, so we also enter bridge mode when the program name
#: (sys.argv[0]) matches the alias name.
RELAY_BRIDGE_ALIAS = "ireliabee-relay.exe"


def _is_relay_bridge_invocation() -> bool:
    if RELAY_BRIDGE_FLAG in sys.argv[1:]:
        return True
    if sys.argv and sys.argv[0]:
        prog = re.split(r"[\\/]", str(sys.argv[0]))[-1].lower()
        if prog in (RELAY_BRIDGE_ALIAS, "ireliabee-relay"):
            return True
    return False


def _log_dir() -> Path:
    """
    The folder the app keeps its settings in, asked of the module that decides it.

    Asking is the point, not tidiness. ``core.appdirs`` brings a pre-rebrand
    ``~/.config/interview-coach`` across when it is imported, and it has to do
    that *before* anything creates the new folder. While this returned a
    hardcoded path, ``_ensure_streams`` made ``~/.config/ireliabee`` first to
    open the log, so the migration found the folder already there and moved
    nothing — from v0.4.1 onwards, in the packaged app only. Run from source it
    always worked, because uvicorn imports ``backend.main`` and this file never
    runs, which is why nobody saw it.
    """
    try:
        from backend.core.appdirs import CONFIG_DIR
        return CONFIG_DIR
    except Exception:
        # Whatever went wrong, a log file is how a user’s problem leaves a
        # trace. Take the plain path and let the real import report the rest.
        return Path.home() / ".config" / "ireliabee"


def _ensure_streams():
    # Always keep a log file so a user's problem leaves a trace: under the
    # desktop app our output goes to a pipe nobody shows, and windowed
    # (console=False) builds started by hand have no stdout/stderr at all.
    log_dir = _log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / "backend.log"
    try:
        if path.stat().st_size > 5_000_000:  # keep one previous run's worth
            path.replace(log_dir / "backend.old.log")
    except OSError:
        pass
    log = open(path, "a", buffering=1, encoding="utf-8", errors="replace")
    log.write(f"\n--- backend starting {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
    sys.stdout = log
    sys.stderr = log


#: Our own unpack folder, as the build spec names it. Anything swept has to
#: be inside this, so a default temp location is left alone.
#:
#: "ireliabee-engine" and not "ireliabee": the installer puts the app itself in
#: %LOCALAPPDATA%\\iReliabee, and Windows does not distinguish the case \u2014 so the
#: obvious name made this the app's own install directory and every launch
#: unpacked 95 MB into it.
CACHE_DIR_NAME = "cache"
CACHE_PARENT_NAME = "ireliabee-engine"

#: How long a copy is left alone before it is even considered for sweeping.
#:
#: Not "how long until leftovers are cleared" \u2014 `_in_use` answers that, and a
#: dead copy goes on the next launch whatever its age. This protects only the one
#: live copy that cannot be recognised: a launch part-way through extracting
#: itself has written its DLLs but not loaded them, so it reads as idle.
#:
#: Measured on the installed app: `python312.dll` becomes locked 2.2 s after the
#: unpack folder appears, so the blind window is seconds. A minute is twenty-odd
#: times that, with room for a cold disk, and the app prevents the case anyway \u2014
#: single-instance means a second launch hands over before its sidecar ever
#: starts, so no other copy should be extracting beside us.
#:
#: What this costs, measured rather than claimed: five launches inside the window
#: hold 483 MB, because each is too recent to sweep. The next launch after it
#: clears the lot in one go \u2014 verified, 483 MB across five folders down to 97 MB
#: in one. It was six hours, which meant carrying that for the rest of the day.
UNPACK_KEEP_S = 60


def _age_of(folder: Path) -> float:
    """
    When this copy was put there, as well as we can tell.

    Deliberately the earlier of the two timestamps. A sweep that cannot finish
    — a file still held open moments after the last run was killed — deletes
    what it can and leaves the rest, and removing those children updates the
    folder's modified time. Going by that alone, a half-deleted folder looks
    brand new and is skipped again on the next launch, which is how leftovers
    would have survived the thing written to remove them.
    """
    stat = folder.stat()
    return min(stat.st_mtime, stat.st_ctime)


def _in_use(folder: Path) -> bool:
    """
    Whether something is still running out of this copy.

    A live process holds its Python DLL open, and Windows refuses to open a
    loaded DLL for writing. Measured both ways against the installed app: the
    open was refused while it was running, and succeeded the moment it closed.

    This is what lets a dead leftover go at once instead of waiting out a timer.
    Age alone cannot tell the difference, and `rmtree` is no use as a test —
    it deletes whatever is not locked *before* it reaches the file that is, so
    asking it would mean taking files out from under a running session.

    Anything it cannot read clearly counts as in use. A leftover kept costs
    95 MB until the next launch; a leftover taken from under a live app is an
    interview that stops working.
    """
    try:
        dlls = sorted(folder.glob("python*.dll"))
    except OSError:
        return True
    if not dlls:
        return True                              # not a shape we put there
    for dll in dlls:
        try:
            handle = os.open(dll, os.O_RDWR)
        except OSError:
            return True                          # loaded, or not ours to touch
        os.close(handle)
    return False


def _is_folder_build() -> bool:
    """
    Whether this build reads its libraries in place instead of unpacking them.

    A folder build keeps them in an ``_internal`` directory beside the
    executable, so ``sys._MEIPASS`` sits inside the install directory. A one-file
    build extracts them somewhere else entirely and ``_MEIPASS`` is that copy.
    Comparing the two is how they are told apart without trusting a path name.
    """
    here = getattr(sys, "_MEIPASS", None)
    if not here:
        return False
    try:
        return Path(here).parent.samefile(Path(sys.executable).parent)
    except OSError:
        return False


def _sweep_unpacked() -> None:
    """
    Clear what earlier runs unpacked and could not clean up themselves.

    Nothing to do on a folder build, which is what ships: the libraries are read
    in place, so no copy is ever made and none is ever left behind. This stays
    for the one-file builds that came before it — an upgrading user can still
    have their leftovers — and because being explicit is better than a guard that
    happens to decline.

    A one-file build unpacks itself to run and removes that copy when it exits
    — except the desktop app terminates the bootloader, so the removal never
    happened and about 95 MB was left behind on every single launch.

    Only ever our own folder. The unpack directories in a shared temp folder
    belong to every PyInstaller program on the machine, and deleting those
    would break other people's software, so anywhere but our own cache is left
    untouched.

    Three things are spared: the copy we are running from, any copy something is
    still running out of, and anything unpacked in the last minute — a launch
    still extracting itself has not loaded its DLLs yet, so it is the one live
    copy the in-use test cannot recognise.
    """
    if _is_folder_build():
        return
    here = getattr(sys, "_MEIPASS", None)
    if not here:
        return                                   # running from source: nothing unpacked
    home = Path(here).parent
    if home.name != CACHE_DIR_NAME or home.parent.name != CACHE_PARENT_NAME:
        return                                   # not our folder: not ours to tidy
    now = time.time()
    try:
        entries = list(home.iterdir())
    except OSError:
        return
    for entry in entries:
        try:
            if not entry.is_dir() or entry.samefile(here):
                continue
            if now - _age_of(entry) < UNPACK_KEEP_S:
                continue
            if _in_use(entry):
                continue
            shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            pass                                 # in use by another copy, or gone


def _parent_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _watch_parent(pid: int) -> None:
    """
    Block until the desktop app is gone. Returns only when it has.

    Watches the app's process, not our stdin: on Windows a blocking read on the
    stdin pipe stalls every DLL load in the process (numpy, PortAudio, …),
    which froze startup before the port was ever opened.

    The handle can be refused — endpoint protection hooks process access, and a
    restricted token cannot open one — and when it was, this used to fall
    straight through to the exit below and kill the backend milliseconds after
    it started, before it had bound a port. Exit 0, so the log read as a clean
    shutdown and said nothing about why. Falling back to asking after the app
    costs a wakeup every two seconds and always works.
    """
    if sys.platform == "win32":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        SYNCHRONIZE, INFINITE = 0x00100000, 0xFFFFFFFF
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if handle:
            try:
                kernel32.WaitForSingleObject(handle, INFINITE)
            finally:
                kernel32.CloseHandle(handle)
            return
        _report(f"{WATCH_FALLBACK_LINE} {pid}")
    while _parent_alive(pid):
        time.sleep(2)


def _exit_when_parent_exits(pid: int):
    # Shut down when the desktop app exits (or crashes) so we never orphan the
    # port or the microphone.
    def watch():
        _watch_parent(pid)
        os._exit(0)
    threading.Thread(target=watch, daemon=True).start()


def _parent_pid() -> int | None:
    args = sys.argv[1:]
    if "--parent-pid" in args:
        i = args.index("--parent-pid")
        if i + 1 < len(args) and args[i + 1].isdigit():
            return int(args[i + 1])
    return None


def _wanted_port() -> int:
    """
    The port to ask for: whatever was asked of us, else 0 for "any free one".

    Read from the environment the app started us with, before ``backend.main``
    imports anything — so a stray ``INTERVIEW_COACH_PORT`` in a user's ``.env``
    cannot decide where the app listens. ``load_env`` has not run yet.
    """
    raw = (os.environ.get("INTERVIEW_COACH_PORT") or "").strip()
    if not raw.isdigit():
        return 0
    port = int(raw)
    return port if 0 <= port <= 65535 else 0


def _bind(host: str, port: int) -> socket.socket:
    """
    Take the port and hold it. Port 0 means the OS picks a free one.

    On Windows, SO_EXCLUSIVEADDRUSE and not SO_REUSEADDR: the second lets
    another process bind the same address alongside us and steal connections,
    which is a real hijack on this platform rather than the harmless restart
    convenience it is on Unix.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if sys.platform == "win32":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        sock.bind((host, port))
    except BaseException:
        sock.close()
        raise
    return sock


def _report(line: str) -> None:
    """
    Say something to the app that started us, and to the log.

    Straight to descriptor 1: ``_ensure_streams`` has replaced ``sys.stdout``
    with the log file, but it never closed the descriptor underneath, and that
    descriptor is still the pipe the app reads.
    """
    print(line, flush=True)                       # the log
    try:
        os.write(1, (line + "\n").encode("ascii", "replace"))
    except OSError:
        pass                                      # no pipe: the log has it


def _run_relay_bridge() -> None:
    """
    The assistant's stdio bridge (backend/relay_bridge.py), run from the sidecar.

    Before ``_ensure_streams``: that points stdout at the log file, and here
    stdout is the protocol. Nothing else may be printed to it either, and no
    server, port or parent-watch is started: this is a short-lived helper the
    assistant launches, not a second copy of the app.
    """
    from backend import relay_bridge
    relay_bridge.main()


def main():
    if _is_relay_bridge_invocation():
        _run_relay_bridge()
        return
    _ensure_streams()
    _sweep_unpacked()
    parent = _parent_pid()
    if parent:
        _exit_when_parent_exits(parent)

    host = os.environ.get("INTERVIEW_COACH_HOST", "127.0.0.1")
    wanted = _wanted_port()
    try:
        sock = _bind(host, wanted)
    except OSError as e:
        # A port that was asked for and is taken. Whoever asked wanted *a*
        # backend more than they wanted that number — an old setting left in
        # the environment must not be able to stop the app starting, which is
        # the failure this whole file exists to remove. Say what happened, then
        # take a free port instead.
        _report(f"{BIND_FAILED_LINE} {e.errno} {host}:{wanted} {e.strerror or e}")
        try:
            sock = _bind(host, 0)
        except OSError as second:
            _report(f"{BIND_FAILED_LINE} {second.errno} {host}:0 {second.strerror or second}")
            raise SystemExit(1)

    port = sock.getsockname()[1]
    _report(f"{PORT_LINE} {port}")
    try:
        from backend import relay
        relay.record_port(port)
    except Exception:
        pass

    import uvicorn
    from backend.main import app

    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="info"))
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()

