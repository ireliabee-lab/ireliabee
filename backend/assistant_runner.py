"""
backend/assistant_runner.py - Start the user's own Claude Code for the relay, with no terminal.

The relay (relay.py) answers text features with the user's own assistant, which until now
had to be started by hand: register the MCP server, open Claude Code, say "start iReliabee".
With "Use my Claude subscription" on, the app does that itself:

* when a feature sends a request and nothing is listening, it starts Claude Code headless
  (`claude -p`) with only the iReliabee relay as its MCP server and only the relay's tools;
* that Claude Code answers what is queued, waits a short while for more, then exits, so an
  idle app spends nothing from the user's subscription;
* a run that fails before answering anything (not installed, not signed in) fails the
  requests that were waiting for it at once, with the reason, rather than at their timeout.

Same code on Windows, Linux and macOS: only where `claude` lives and how a window is
hidden differ.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .core.appdirs import CONFIG_DIR

logger = logging.getLogger(__name__)

#: Config key for the switch.
CONFIG_KEY = "relay_auto_claude"
#: Where the runs keep their MCP config and log: an empty folder, so no CLAUDE.md is read.
RUN_DIR = CONFIG_DIR / "assistant"
#: How long a run waits for another request before it stops (seconds).
IDLE_WAIT_S = 20
#: Requests one run answers before it stops; the next run starts fresh, so context stays small.
#: Every restart costs a cold start (~10-15 s), so not too few.
MAX_ANSWERS = 25
#: The watchdog. Measured 14 Oct 2026: a run that lost its MCP bridge, or a model that never
#: ended its turn, kept a run alive forever, and every later request queued behind it.
CONNECT_S = 45        # a run that hasn't taken a waiting request this long after starting never connected
STALL_S = 40          # a request waiting this long while the run isn't polling: the run is stuck
IDLE_STOP_S = 90      # no request picked up or answered for this long: stop, whatever the model does
MAX_RUN_S = 20 * 60   # no run lives longer than this
PID_FILE = "run.pid"
#: The relay's tools, as Claude Code names them. Nothing else is allowed: no files, no shell.
TOOLS = ("mcp__ireliabee__next_request", "mcp__ireliabee__submit_answer")

PROMPT = (
    "You answer requests from the iReliabee desktop app. "
    f"Call mcp__ireliabee__next_request with wait_s {IDLE_WAIT_S}. "
    "For each request it returns, follow its instructions exactly, grounded only in its context, "
    "and reply with mcp__ireliabee__submit_answer using its id. Then call next_request again. "
    f"Stop when next_request returns kind none, or after {MAX_ANSWERS} answers. "
    "Do not write anything else."
)

_lock = threading.RLock()
_proc: Optional[subprocess.Popen] = None
_started_at: Optional[float] = None
_last_error: Optional[str] = None
_last_run: dict[str, Any] = {}
#: Why a run is being stopped by the app ("off", or a watchdog reason), by its pid. Per run:
#: a watcher left from an earlier run must never relabel or kill a later one.
_stop_reasons: dict[int, str] = {}
#: Watcher threads, so tests (and shutdown) can wait for them.
_watchers: list[threading.Thread] = []
#: Set by relay.py: (answers since a time) and (fail the waiting requests with an error).
answers_since: Optional[Callable[[float], int]] = None
pending: Optional[Callable[[], int]] = None
fail_pending: Optional[Callable[[Exception], None]] = None


def is_enabled() -> bool:
    from .core.config import load_config
    try:
        return bool(load_config().get(CONFIG_KEY, False))
    except Exception:
        return False


def set_enabled(on: bool) -> None:
    """Turn the switch on or off. On also turns on the relay itself: that is the one click."""
    from .core.config import load_config, save_config
    cfg = load_config()
    cfg[CONFIG_KEY] = bool(on)
    if on:
        cfg["notebook_relay"] = True
    save_config(cfg)
    if not on:
        stop()


def _candidates() -> list[Path]:
    """Where Claude Code's installers put `claude`, for when the app's PATH doesn't have it
    (a GUI app on macOS starts with a short PATH)."""
    home = Path.home()
    names = ["claude.exe", "claude.cmd"] if os.name == "nt" else ["claude"]
    dirs = [home / ".local" / "bin", home / ".claude" / "local"]
    if os.name == "nt":
        local = Path(os.environ.get("LOCALAPPDATA", home / "AppData" / "Local"))
        roaming = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
        dirs += [local / "Microsoft" / "WinGet" / "Links", roaming / "npm"]
    else:
        dirs += [Path("/opt/homebrew/bin"), Path("/usr/local/bin"), home / ".npm-global" / "bin"]
    return [d / n for d in dirs for n in names]


def find_claude() -> Optional[str]:
    """The path of Claude Code's `claude`, or None when it isn't installed."""
    found = shutil.which("claude")
    if found:
        return found
    for p in _candidates():
        if p.is_file():
            return str(p)
    return None


def bridge_server() -> dict[str, Any]:
    """The MCP server entry Claude Code launches to reach the relay: this install's own engine
    with --relay-bridge, or the Python module when running from source."""
    if getattr(sys, "frozen", False):
        exe = sys.executable
        if "\\windowsapps\\" in exe.lower():
            # A Store install: other programs can't start an exe inside WindowsApps; the
            # package's alias for it can be.
            return {"command": "ireliabee-relay.exe", "args": []}
        return {"command": exe, "args": ["--relay-bridge"]}
    repo = str(Path(__file__).resolve().parent.parent)
    return {"command": sys.executable, "args": ["-m", "backend.relay_bridge"], "env": {"PYTHONPATH": repo}}


def write_mcp_config() -> Path:
    """The run's MCP config. The bridge is told this backend's port and key directly (when the
    port is known) rather than reading ~/.config/ireliabee/relay.json, which a second copy of
    the app, a dev server or a test run can overwrite; and it is marked as app-started, so the
    relay tells it to end its turn when there is nothing to do."""
    from . import relay
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    server = bridge_server()
    env = dict(server.get("env") or {})
    env["IRB_RELAY_CLIENT"] = "one-click"
    port = relay.known_port()
    if port:
        env["IRB_RELAY_PORT"] = str(port)
        env["IRB_RELAY_KEY"] = relay.get_pairing_key()
    server["env"] = env
    path = RUN_DIR / "mcp.json"
    path.write_text(json.dumps({"mcpServers": {"ireliabee": server}}, indent=2), encoding="utf-8")
    return path


#: Model and effort for these runs. Measured live on 13 Oct 2026 (a live-call answer, cold / warm):
#: the plan's default model (Opus) timed out past 60 s; Sonnet at low effort took 9.5 / 5.8 s;
#: Haiku 5.1 / 6.4 s. The answers are short and follow written instructions, so a fast model at
#: low effort is the default. "default" in config means Claude Code's own default for the plan.
MODEL_KEY, EFFORT_KEY = "relay_auto_model", "relay_auto_effort"
DEFAULT_MODEL, DEFAULT_EFFORT = "sonnet", "low"


def _model_and_effort() -> tuple[Optional[str], str]:
    from .core.config import load_config
    try:
        cfg = load_config()
    except Exception:
        cfg = {}
    model = str(cfg.get(MODEL_KEY) or DEFAULT_MODEL).strip()
    model = None if model in ("", "default") else model
    effort = str(cfg.get(EFFORT_KEY) or DEFAULT_EFFORT).strip()
    return model, effort


def command(claude: str, mcp_config: Path) -> list[str]:
    model, effort = _model_and_effort()
    extra = (["--model", model] if model else []) + ["--effort", effort]
    return [
        claude, "-p", PROMPT, *extra,
        "--mcp-config", str(mcp_config),
        "--strict-mcp-config",           # only the relay: not the user's other servers
        "--tools", "",                   # no built-in tools: no files, no shell, no web
        "--allowedTools", ",".join(TOOLS),
        "--no-session-persistence",      # these runs don't belong in the user's history
    ]


#: Claude Code settings a user sets on purpose; everything else CLAUDE_CODE_* is session state
#: inherited from whatever started the app (e.g. the app launched from inside Claude Code).
KEEP_CLAUDE_VARS = {"CLAUDE_CONFIG_DIR", "CLAUDE_CODE_GIT_BASH_PATH"}


def child_env(env: Optional[dict] = None) -> dict:
    """The environment Claude Code starts with: this process's, less anything that would stop it
    signing in with the user's Claude subscription. The app loads the provider keys in its .env
    into its own environment, and Claude Code prefers ANTHROPIC_API_KEY (or a base URL or token)
    over the claude.ai login: it would bill that key, or fail with it, instead of using the plan."""
    env = dict(os.environ if env is None else env)
    for k in list(env):
        if k.startswith("ANTHROPIC_") or k == "CLAUDECODE" or (k.startswith("CLAUDE_CODE_") and k not in KEEP_CLAUDE_VARS):
            del env[k]
    return env


def is_running() -> bool:
    with _lock:
        return _proc is not None and _proc.poll() is None


_leftovers_checked = False


def _kill_tree(pid: int) -> None:
    """Stop a run and everything it started. On Windows the process we hold is the cmd.exe that
    runs claude.CMD; terminating only it left claude.exe (and its MCP bridge) running."""
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=15)
        else:
            import signal
            os.killpg(pid, signal.SIGTERM)
    except Exception as e:  # already gone, or not ours to kill
        logger.info("assistant runner: stopping pid %s: %s", pid, e)


def _is_leftover_run(pid: int) -> bool:
    """Whether pid is still a Claude Code run (and not a reused pid of something else)."""
    try:
        if os.name == "nt":
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), timeout=10).stdout.lower()
            return any(n in out for n in ('"cmd.exe"', '"claude.exe"', '"node.exe"'))
        out = subprocess.run(["ps", "-p", str(pid), "-o", "comm="], capture_output=True, text=True, timeout=10).stdout.lower()
        return any(n in out for n in ("claude", "node"))
    except Exception:
        return False


def _kill_leftover() -> None:
    """A run from an app session that crashed (atexit never ran) may still be polling: stop it."""
    global _leftovers_checked
    if _leftovers_checked:
        return
    _leftovers_checked = True
    f = RUN_DIR / PID_FILE
    try:
        pid = int(f.read_text().strip())
    except (OSError, ValueError):
        return
    if pid != os.getpid() and _is_leftover_run(pid):
        logger.info("assistant runner: stopping a run left over from before (pid %s)", pid)
        _kill_tree(pid)
    try:
        f.unlink()
    except OSError:
        pass


def ensure_running() -> bool:
    """Start a run if the switch is on and none is going. True when one is going after this."""
    global _proc, _started_at, _last_error
    if not is_enabled():
        return False
    _kill_leftover()
    with _lock:
        if _proc is not None and _proc.poll() is None:
            return True
        claude = find_claude()
        if not claude:
            _last_error = "Claude Code isn't installed on this computer."
            return False
        try:
            cfg = write_mcp_config()
            log = open(RUN_DIR / "last-run.log", "w", encoding="utf-8", errors="replace")
            kwargs: dict[str, Any] = {}
            if os.name == "nt":
                kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            else:
                kwargs["start_new_session"] = True
            _proc = subprocess.Popen(
                command(claude, cfg), cwd=str(RUN_DIR), env=child_env(), stdin=subprocess.DEVNULL,
                stdout=log, stderr=subprocess.STDOUT, **kwargs,
            )
            log.close()   # the child has its own handle
        except OSError as e:
            _last_error = f"Couldn't start Claude Code: {e}"
            logger.warning("assistant runner: %s", _last_error)
            return False
        _started_at = time.time()
        proc, started = _proc, _started_at
        try:
            (RUN_DIR / PID_FILE).write_text(str(proc.pid))
        except OSError:
            pass
        logger.info("assistant runner: started Claude Code (pid %s)", proc.pid)
    t = threading.Thread(target=_watch, args=(proc, started), daemon=True)
    with _lock:
        _watchers[:] = [w for w in _watchers if w.is_alive()] + [t]
    t.start()
    return True


def _log_tail(n: int = 600) -> str:
    try:
        return (RUN_DIR / "last-run.log").read_text(encoding="utf-8", errors="replace").strip()[-n:]
    except OSError:
        return ""


def explain_failure(code: int, output: str) -> str:
    """What to tell the user about a run that stopped without answering."""
    low = output.lower()
    if "api key" in low and ("external" in low or "anthropic_api_key" in low):
        return "Claude Code is set to use an API key instead of your Claude plan. Remove ANTHROPIC_API_KEY from its settings, then sign in with your plan."
    if any(s in low for s in ("/login", "not logged in", "log in", "invalid api key", "authentication", "oauth")):
        return "Claude Code isn't signed in. Open it once in a terminal (type claude) and sign in."
    if re.search(r"hit your .*limit|usage limit|rate limit|limit reached|(session|weekly|opus|sonnet|5-hour) limit", low):
        resets = re.search(r"resets ([^\n|]+)", output, re.I)
        when = f" (resets {resets.group(1).strip()})" if resets else ""
        return f"Your Claude plan's usage limit is reached for now{when}. Try later, or use credits."
    last = output.strip().splitlines()[-1][:200] if output.strip() else ""
    return f"Claude Code stopped (exit {code}){': ' + last if last else ''}."


def _watchdog_reason(started: float, now: float) -> Optional[str]:
    """Why a live run should be stopped now, or None."""
    from . import relay
    activity = relay.last_activity()
    took_any = activity is not None and activity >= started
    if relay.working_count() == 0:
        if relay.pending() and not relay.has_waiters():
            if not took_any and now - started > CONNECT_S:
                return "no_connect"
            # Counted from when this run started: a request already waiting before it began
            # (a previous run failed) gets the full STALL_S with this one.
            if min(relay.oldest_pending_age(), now - started) > STALL_S:
                return "stalled"
        last = activity if took_any else started
        if not relay.pending() and now - last > IDLE_STOP_S:
            return "idle"
        if now - started > MAX_RUN_S:
            return "too_long"
    return None


WATCHDOG_MESSAGES = {
    "no_connect": "Claude Code started but couldn't reach iReliabee. Try again; if it keeps happening, restart iReliabee.",
    "stalled": "Claude Code stopped taking requests. Try again.",
}


def _watch(proc: subprocess.Popen, started: float) -> None:
    global _last_error, _last_run
    while True:
        try:
            code = proc.wait(timeout=2)
            break
        except subprocess.TimeoutExpired:
            with _lock:
                current = _proc is proc
            # Only the current run is judged: the relay's queue belongs to it, not to an older one.
            reason = _watchdog_reason(started, time.time()) if current else None
            if reason:
                logger.info("assistant runner: stopping the run (%s)", reason)
                with _lock:
                    _stop_reasons[proc.pid] = reason
                _kill_tree(proc.pid)
    answered = answers_since(started) if answers_since else 0
    output = _log_tail()
    with _lock:
        reason = _stop_reasons.pop(proc.pid, None)
        if _proc is not proc:
            # A newer run has started since: this one's ending is old news, and its requests
            # (if any) are the newer run's to answer.
            return
        _last_run = {"exit": code, "answered": answered, "seconds": round(time.time() - started, 1),
                     **({"stopped": reason} if reason else {})}
        crashed = reason is None and code != 0 and answered == 0
        if reason in WATCHDOG_MESSAGES:
            _last_error = WATCHDOG_MESSAGES[reason]
        elif crashed:
            _last_error = explain_failure(code, output)
        elif answered or reason == "off":
            _last_error = None
        failed = crashed or reason in WATCHDOG_MESSAGES or reason == "off"
    logger.info("assistant runner: run ended %s", _last_run)
    try:
        if (RUN_DIR / PID_FILE).read_text().strip() == str(proc.pid):
            (RUN_DIR / PID_FILE).unlink()
    except OSError:
        pass
    if failed:
        if fail_pending:
            from .errors import FriendlyError
            message = ("Use my Claude subscription was turned off." if reason == "off"
                       else _last_error or "It stopped before answering.")
            # The code every feature already handles as "the assistant can't answer: offer credits".
            fail_pending(FriendlyError("relay_not_listening", "Claude Code couldn't answer", message, "credits_fallback"))
        return
    # It stopped on its own (idle, its answer limit, or the watchdog's idle stop): start again
    # if work arrived meanwhile.
    if pending and pending() > 0:
        ensure_running()


def stop(reason: str = "off") -> None:
    """Stop the run and everything it started (the switch turned off, or the app closing)."""
    with _lock:
        proc = _proc
        if proc is not None and proc.poll() is None:
            _stop_reasons[proc.pid] = reason
    if proc is not None and proc.poll() is None:
        _kill_tree(proc.pid)


# Don't leave a run behind when the app closes.
import atexit  # noqa: E402
atexit.register(stop)


def wait_for_watchers(timeout: float = 15.0) -> None:
    """Wait until every run's watcher has finished (tests; nothing in the app needs it)."""
    deadline = time.time() + timeout
    with _lock:
        threads = list(_watchers)
    for t in threads:
        t.join(max(0.0, deadline - time.time()))


def status() -> dict[str, Any]:
    claude = find_claude()
    with _lock:
        return {
            "enabled": is_enabled(),
            "available": bool(claude),
            "path": claude,
            "running": _proc is not None and _proc.poll() is None,
            "started_at": _started_at,
            "last_error": _last_error,
            "last_run": dict(_last_run),
        }
