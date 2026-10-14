"""
backend/relay.py - MCP Relay for Text AI features.

Routes text AI requests to the user's own AI assistant (Claude Code or Antigravity)
connected via MCP, rather than spending iReliabee credits through the hosted proxy.
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import re
import threading
import time
from pathlib import Path
from typing import Any, Optional
from .core.appdirs import CONFIG_DIR

RELAY_INFO_PATH = CONFIG_DIR / "relay.json"


logger = logging.getLogger(__name__)

DEFAULT_WAIT_S = 50.0
MAX_QUEUE = 50

_seq = 0
_lock = threading.RLock()
_queue: list[tuple[dict[str, Any], concurrent.futures.Future]] = []
_waiters: list[tuple[asyncio.Future[dict[str, Any]], asyncio.AbstractEventLoop]] = []
_working: dict[str, tuple[dict[str, Any], concurrent.futures.Future]] = {}
_last_poll_at: Optional[float] = None
_last_answer_at: Optional[float] = None
#: When each recent answer came in, so a run of the app-started assistant can tell whether it answered.
_answer_times: list[float] = []
#: When an assistant last took a request off the queue (not when it last polled: an idle
#: assistant polls every few seconds), so a run that sits idle can be told apart from a busy one.
_last_pick_at: Optional[float] = None
#: When each request was queued and picked up, to log how long each stage took.
_timing: dict[str, dict[str, float]] = {}
#: An assistant that asked for work or answered this recently still counts as connected:
#: between answering one request and asking for the next it writes its own reply, which
#: can take well over a minute. Its next request waits in the queue meanwhile.
ACTIVE_WINDOW_S = 180.0
_client: Optional[str] = None
_current_port: Optional[int] = None


def record_port(port: int) -> None:
    global _current_port
    if port and port > 0:
        _current_port = int(port)
        write_relay_info()


def known_port() -> Optional[int]:
    """This backend's port when it has been recorded (the packaged app records it at start)."""
    return _current_port


def get_port() -> int:
    return _current_port or 8000


def get_pairing_key() -> str:
    from .core.config import load_config, save_config
    import secrets
    cfg = load_config()
    key = cfg.get("relay_pairing_key")
    if not key:
        key = f"irb_relay_{secrets.token_urlsafe(24)}"
        cfg["relay_pairing_key"] = key
        save_config(cfg)
        write_relay_info()
    return key


def regenerate_pairing_key() -> str:
    from .core.config import load_config, save_config
    import secrets
    cfg = load_config()
    key = f"irb_relay_{secrets.token_urlsafe(24)}"
    cfg["relay_pairing_key"] = key
    save_config(cfg)
    write_relay_info()
    return key


def write_relay_info() -> None:
    try:
        RELAY_INFO_PATH.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "port": get_port(),
            "pairing_key": get_pairing_key(),
            "updated_at": int(time.time()),
        }
        RELAY_INFO_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        logger.warning("Could not write relay.json: %s", e)


def reset() -> None:
    """Clear all queues and waiters. Used by tests."""
    global _seq, _last_poll_at, _last_answer_at, _last_pick_at, _client
    with _lock:
        _seq = 0
        _last_poll_at = None
        _last_answer_at = None
        _answer_times.clear()
        _timing.clear()
        _last_pick_at = None
        _client = None
        for _, fut in _queue:
            if not fut.done():
                fut.cancel()
        _queue.clear()
        for w, _ in _waiters:
            if not w.done():
                w.cancel()
        _waiters.clear()
        for _, fut in _working.values():
            if not fut.done():
                fut.cancel()
        _working.clear()


def is_enabled() -> bool:
    """Whether the user turned on 'Use my own AI assistant for text features'."""
    from .core.config import load_config
    try:
        return bool(load_config().get("notebook_relay", False))
    except Exception:
        return False


def is_listening() -> bool:
    """
    True when an assistant is actively waiting in next_request, or polled very recently
    (e.g. between turns).
    """
    with _lock:
        if _waiters or _working:
            return True
        now = time.time()
        return any(t is not None and now - t < ACTIVE_WINDOW_S for t in (_last_poll_at, _last_answer_at))


def _picked(req_id: str) -> None:
    global _last_pick_at
    _last_pick_at = time.time()
    t = _timing.get(req_id)
    if t is not None and "picked" not in t:
        t["picked"] = time.time()


def _log_answered(req_id: str) -> None:
    """One line per answer: how long it waited for an assistant, and how long that took."""
    t = _timing.pop(req_id, None)
    if not t:
        return
    now = time.time()
    picked = t.get("picked", now)
    logger.info("relay %s: picked up after %.1fs, answered %.1fs later (%.1fs in all)",
                req_id, picked - t["queued"], now - picked, now - t["queued"])


def ready() -> bool:
    """Whether a request sent now will be answered.

    With "Use my Claude subscription" on, only an assistant that is waiting in next_request
    right now counts: a run the app started exits ~20 s after its last answer, and treating
    it as connected for ACTIVE_WINDOW_S afterwards left requests in that window with nobody
    to answer them (13 Oct 2026: live answers timed out, cards stuck on dots). Otherwise the
    app starts Claude Code. A hand-started assistant between two polls is still counted when
    Claude Code can't be started."""
    from . import assistant_runner
    if assistant_runner.is_enabled():
        with _lock:
            if _waiters:
                return True
        if assistant_runner.ensure_running():
            return True
    return is_listening()


def has_waiters() -> bool:
    with _lock:
        return bool(_waiters)


def oldest_pending_age() -> float:
    """Seconds the oldest request still in the queue (not yet picked up) has waited; 0 if none."""
    with _lock:
        if not _queue:
            return 0.0
        now = time.time()
        return max(now - _timing.get(req["id"], {}).get("queued", now) for req, _ in _queue)


def last_activity() -> Optional[float]:
    """When a request was last picked up or answered."""
    with _lock:
        ts = [t for t in (_last_pick_at, _last_answer_at) if t is not None]
        return max(ts) if ts else None


def working_count() -> int:
    with _lock:
        return len(_working)


def answers_since(t: float) -> int:
    with _lock:
        return sum(1 for a in _answer_times if a >= t)


def pending() -> int:
    with _lock:
        return len(_queue)


def fail_pending(exc: Exception) -> None:
    """Fail every request waiting for an answer: the assistant that was to answer them is gone."""
    with _lock:
        items = list(_queue) + list(_working.values())
        _queue.clear()
        _working.clear()
    for _, fut in items:
        if not fut.done():
            fut.set_exception(exc)


def set_client(name: Optional[str]) -> None:
    """Record the client name reported by the assistant (e.g. 'claude-code', 'antigravity')."""
    global _client
    with _lock:
        if name:
            _client = str(name)[:100]


def get_client() -> Optional[str]:
    """Return the client name reported by the assistant."""
    with _lock:
        return _client


def status(include_key: bool = False) -> dict[str, Any]:
    """Status dictionary reported to the app UI and over MCP."""
    with _lock:
        st: dict[str, Any] = {
            "enabled": is_enabled(),
            "listening": len(_waiters) > 0,
            "active": is_listening(),
            "last_poll_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(_last_poll_at)) if _last_poll_at else None,
            "queued": len(_queue),
            "working": list(_working.keys()),
            "client": _client,
            "port": get_port(),
            "repo_dir": str(Path(__file__).resolve().parent.parent),
        }
    if include_key:
        st["pairing_key"] = get_pairing_key()
    from . import assistant_runner
    st["auto"] = assistant_runner.status()
    return st


def _wire_runner() -> None:
    from . import assistant_runner
    assistant_runner.answers_since = answers_since
    assistant_runner.pending = pending
    assistant_runner.fail_pending = fail_pending


_wire_runner()


async def next_request(wait_s: float = DEFAULT_WAIT_S, client: Optional[str] = None) -> dict[str, Any]:
    """
    Called by the MCP tool `next_request`.
    Blocks until a request is queued or until wait_s expires.
    Returns the request dict, or `{"kind": "none"}` on timeout.
    """
    global _last_poll_at
    _last_poll_at = time.time()
    if client:
        set_client(client)

    loop = asyncio.get_running_loop()

    with _lock:
        # If something is already queued, take the oldest
        while _queue:
            req, fut = _queue.pop(0)
            if not fut.done():
                _working[req["id"]] = (req, fut)
                _picked(req["id"])
                return req

        # Otherwise register a waiter
        waiter: asyncio.Future[dict[str, Any]] = loop.create_future()
        _waiters.append((waiter, loop))

    try:
        req = await asyncio.wait_for(waiter, timeout=max(0.1, wait_s))
        _picked(req["id"])
        return req
    except asyncio.TimeoutError:
        return {"kind": "none"}
    finally:
        _last_poll_at = time.time()
        with _lock:
            _waiters[:] = [w for w in _waiters if w[0] is not waiter]


def _create_request(kind: str, instructions: str, context: dict[str, Any]) -> tuple[dict[str, Any], concurrent.futures.Future]:
    global _seq
    with _lock:
        _seq += 1
        req_id = f"r{_seq}"
        req = {
            "id": req_id,
            "kind": kind,
            "instructions": instructions,
            "context": context,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        ans_fut = concurrent.futures.Future()
        _timing[req_id] = {"queued": time.time()}
        while len(_timing) > 200:
            _timing.pop(next(iter(_timing)))

        # If an assistant is actively waiting, dispatch immediately
        delivered = False
        while _waiters:
            w, w_loop = _waiters.pop(0)
            if not w.done():
                _working[req_id] = (req, ans_fut)
                w_loop.call_soon_threadsafe(w.set_result, req)
                delivered = True
                break

        if not delivered:
            _queue.append((req, ans_fut))
            while len(_queue) > MAX_QUEUE:
                old_req, old_fut = _queue.pop(0)
                if not old_fut.done():
                    old_fut.set_exception(RuntimeError(f"Request {old_req['id']} dropped: queue exceeded {MAX_QUEUE}"))

        return req, ans_fut


def enqueue_sync(kind: str, instructions: str, context: dict[str, Any], timeout_s: float = 60.0) -> Any:
    """
    Synchronously enqueue a request from a worker thread.
    Blocks until the assistant submits an answer, or raises TimeoutError.
    """
    req, ans_fut = _create_request(kind, instructions, context)
    try:
        return ans_fut.result(timeout=timeout_s)
    except (TimeoutError, concurrent.futures.TimeoutError):
        with _lock:
            _working.pop(req["id"], None)
            _queue[:] = [item for item in _queue if item[0]["id"] != req["id"]]
        raise TimeoutError(f"Relay request {req['id']} ({kind}) timed out after {timeout_s}s")


async def enqueue(kind: str, instructions: str, context: dict[str, Any], timeout_s: float = 60.0) -> Any:
    """
    Enqueue a request for the assistant to answer asynchronously.
    Returns the assistant's answer once submitted.
    Raises TimeoutError if not answered in time.
    """
    req, ans_fut = _create_request(kind, instructions, context)
    try:
        return await asyncio.wait_for(asyncio.wrap_future(ans_fut), timeout=timeout_s)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        with _lock:
            _working.pop(req["id"], None)
            _queue[:] = [item for item in _queue if item[0]["id"] != req["id"]]
        raise TimeoutError(f"Relay request {req['id']} ({kind}) timed out after {timeout_s}s")


def submit_answer(req_id: str, answer: Any) -> bool:
    """
    Called when the assistant calls `submit_answer` or `answer`.
    Resolves the waiting future for request `req_id`.
    """
    global _last_answer_at
    with _lock:
        _last_answer_at = time.time()
        _answer_times.append(_last_answer_at)
        del _answer_times[:-200]
        _log_answered(req_id)
        if req_id in _working:
            req, fut = _working.pop(req_id)
            kind = req.get("kind", "text")
            parsed = _normalize_answer(answer, kind)
            if not fut.done():
                fut.set_result(parsed)
            return True

        for i, (req, fut) in enumerate(_queue):
            if req["id"] == req_id:
                _queue.pop(i)
                kind = req.get("kind", "text")
                parsed = _normalize_answer(answer, kind)
                if not fut.done():
                    fut.set_result(parsed)
                return True

    logger.warning("submit_answer: unknown request id %s", req_id)
    return False


def _try_parse_json(text: str) -> Any:
    try:
        return json.loads(text)
    except Exception:
        pass
    m = re.search(r"```(?:json)?\s*([\{\[].*?[\}\]])\s*```", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1))
        except Exception:
            pass
    m2 = re.search(r"([\{\[].*[\}\]])", text, re.DOTALL)
    if m2:
        try:
            return json.loads(m2.group(1))
        except Exception:
            pass
    return None


def _normalize_answer(answer: Any, kind: str = "text") -> Any:
    """Parse and normalize assistant answer according to request kind."""
    if kind == "explain":
        if isinstance(answer, dict):
            return {
                "meaning": str(answer.get("meaning") or answer.get("text") or answer.get("reply") or "").strip(),
                "example": str(answer.get("example") or "").strip()[:600],
                "from": str(answer.get("from") or "general").strip(),
                "pages": list(answer.get("pages") or []),
                "unsure": bool(answer.get("unsure")),
            }
        if isinstance(answer, str):
            text = answer.strip()
            parsed = _try_parse_json(text)
            if isinstance(parsed, dict) and ("meaning" in parsed or "text" in parsed or "example" in parsed):
                return {
                    "meaning": str(parsed.get("meaning") or parsed.get("text") or parsed.get("reply") or "").strip(),
                    "example": str(parsed.get("example") or "").strip()[:600],
                    "from": str(parsed.get("from") or "general").strip(),
                    "pages": list(parsed.get("pages") or []),
                    "unsure": bool(parsed.get("unsure")),
                }
            return {"meaning": text, "example": "", "from": "general", "pages": [], "unsure": False}
        return answer

    if kind in ("live_turn", "coach_turn", "turn"):
        if isinstance(answer, dict):
            return str(answer.get("reply") or answer.get("text") or answer.get("answer") or json.dumps(answer)).strip()
        if isinstance(answer, str):
            return answer.strip()
        return str(answer)

    if kind == "suggest":
        # An object answer goes back as it is: providers.respond sends it as JSON, which
        # suggest's parser reads, so a list box gets a list (not a Python repr in one item).
        if isinstance(answer, (dict, list)):
            return answer
        if isinstance(answer, str):
            parsed = _try_parse_json(answer.strip())
            if isinstance(parsed, dict) and "text" in parsed:
                return str(parsed["text"]).strip()
            return answer.strip()
        return str(answer)

    # All structured/JSON features (wordcraft, study, plan, debrief, meeting_notes, mock, etc.)
    if isinstance(answer, (dict, list)):
        return answer
    if isinstance(answer, str):
        text = answer.strip()
        parsed = _try_parse_json(text)
        if parsed is not None:
            return parsed
        return text
    return answer
