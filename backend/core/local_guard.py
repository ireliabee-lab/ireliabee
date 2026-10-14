"""
Only this app may use the local backend (audit 180-C3, 177-C7/C8/M9).

The backend listens on 127.0.0.1, and every web page the user visits can
reach 127.0.0.1. CORS only stops a page *reading* a response: it does nothing
for a WebSocket, an ``<img src>`` or a form post, all of which a hostile page
could use to open the microphone, start a paid voice call or burn credits on
text-to-speech, charged to the user.

Three checks, on every HTTP request and WebSocket:

1. **Host** must be a loopback name. A page that rebinds its own domain to
   127.0.0.1 (DNS rebinding) still sends its own domain as Host.
2. **Origin**, when a browser sends one, must be this app's.
3. **A per-launch token** must come with the request: ``X-IRB-Token``, or
   ``?t=`` where a header cannot be set (WebSocket, ``<audio src>``). The
   app's own page fetches it from ``GET /handshake``, which answers only to
   this app's Origin; a hostile page can send that request but cannot read
   the reply.

Exempt: CORS preflights, and ``GET /account/complete``, which the system
browser opens at the end of sign-in and so can carry neither.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import secrets
import sys
from urllib.parse import parse_qs

def _token_from_the_app() -> str:
    """
    The token Tauri made for this launch and handed over when it started us
    (audit 182-H2), taken out of the environment at once so no child process
    inherits it. `.env` can never supply it: load_env skips every IRELIABEE_*
    name (audit 182-H1). Anything short or odd is ignored.
    """
    given = os.environ.pop("IRELIABEE_LOCAL_TOKEN", "")
    return given if len(given) >= 32 and given.isalnum() else ""


_HANDED_OVER = _token_from_the_app()
#: True when the desktop app made the token: then nobody may ask us for it.
FROM_APP = bool(_HANDED_OVER)
#: Fresh every launch: the app's, or (running from source, no Tauri) our own.
TOKEN = _HANDED_OVER or secrets.token_urlsafe(32)

APP_ORIGINS = (
    "tauri://localhost",
    "https://tauri.localhost",
    "http://tauri.localhost",
)
#: The Vite dev server. Not trusted in the packaged app, where any other
#: program on this machine could be listening on those ports.
DEV_ORIGINS = (
    "http://localhost:1420",
    "http://127.0.0.1:1420",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
)
PACKAGED = bool(getattr(sys, "frozen", False))
ALLOWED_ORIGINS = APP_ORIGINS if PACKAGED else APP_ORIGINS + DEV_ORIGINS

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
HANDSHAKE = "/handshake"
#: Proves this is the app's own backend without revealing the token: the page
#: sends a random challenge (without the token) and checks the HMAC it gets
#: back. Whatever else might be listening on the port cannot answer it, so the
#: page sends it nothing (audit 182-H2).
IDENTIFY = "/identify"
EXEMPT_GETS = {"/account/complete"}

#: Where a calendar provider sends the browser back when someone connects a
#: calendar. Google and Microsoft redirect the *system browser* here, so the
#: request arrives with no token and no Origin of ours — it was refused with a
#: 401 and connecting a calendar could never finish in the packaged app.
#:
#: Safe to let through for the same reason ``/account/complete`` is: it carries
#: a ``state`` this backend issued (``secrets.token_urlsafe(24)``, held in
#: memory, used once, forgotten after fifteen minutes). Anything arriving
#: without one is turned away by ``calendar_sync.oauth_finish`` with "this
#: sign-in link has expired", so a page that forges a callback cannot attach a
#: calendar of its choosing.
CALLBACK_GET = re.compile(r"^/calendar/oauth/[a-z0-9_-]{1,20}/callback$")


def _exempt_get(path: str) -> bool:
    """A GET the browser makes on our behalf, which cannot carry a token."""
    return path in EXEMPT_GETS or bool(CALLBACK_GET.match(path))

#: Tests drive routers directly and never through HTTP; a test that wants the
#: guard off says so here, in-process, where no web page can reach.
enforce = True


def _headers(scope) -> dict[str, str]:
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}


def _host_ok(host: str) -> bool:
    if not host:
        return False
    name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
    return name.lower() in LOOPBACK_HOSTS


def _token_ok(given: str | None) -> bool:
    # As bytes: compare_digest raises on non-ASCII str, which was a 500 for
    # `?t=%C3%A9` rather than a refusal.
    return bool(given) and hmac.compare_digest(given.encode("utf-8", "surrogateescape"), TOKEN.encode())


def _pairing_key_ok(given: str | None) -> bool:
    if not given:
        return False
    try:
        from backend import relay
        key = relay.get_pairing_key()
        return bool(key) and hmac.compare_digest(given.encode("utf-8", "surrogateescape"), key.encode())
    except Exception:
        return False


def verdict(scope) -> tuple[bool, int, str]:
    """(allowed, status, reason) for one request or WebSocket."""
    headers = _headers(scope)
    path = scope.get("path", "")
    method = scope.get("method", "GET") if scope["type"] == "http" else "WS"

    if not _host_ok(headers.get("host", "")):
        return False, 403, "host"
    origin = headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        return False, 403, "origin"
    if method == "OPTIONS":
        return True, 200, ""
    if path == HANDSHAKE:
        # When the desktop app made the token, its page has it already and
        # nobody may ask for it. Running from source, only this app's own
        # page, which a browser proves with its Origin.
        if FROM_APP:
            return False, 403, "handshake"
        return (True, 200, "") if origin in ALLOWED_ORIGINS else (False, 403, "origin")
    if path == IDENTIFY and method == "GET":
        return True, 200, ""
    if method == "GET" and _exempt_get(path):
        return True, 200, ""

    query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
    given = headers.get("x-irb-token") or (query.get("t") or [None])[0]
    if path == "/relay/status" or path.startswith("/mcp"):
        relay_given = (
            headers.get("x-irb-relay-key") or
            headers.get("x-irb-token") or
            (query.get("k") or [None])[0] or
            (query.get("key") or [None])[0] or
            (query.get("pairing_key") or [None])[0] or
            (query.get("t") or [None])[0]
        )
        if _token_ok(given) or _pairing_key_ok(relay_given):
            return True, 200, ""
        return False, 401, "token"

    if not _token_ok(given):
        return False, 401, "token"
    return True, 200, ""


def identify(scope) -> str:
    """HMAC-SHA256(token, challenge), hex: only the holder of the token can make it."""
    query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
    challenge = (query.get("n") or [""])[0][:128]
    return hmac.new(TOKEN.encode(), challenge.encode("utf-8", "surrogateescape"), hashlib.sha256).hexdigest()


class _RedactToken(logging.Filter):
    """
    Keep the token out of the access log. Sockets, audio and download links
    carry it as ``?t=``, and uvicorn logs every path in full to backend.log.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(_TOKEN_IN_URL.sub(r"\1\2=REDACTED", a) if isinstance(a, str) else a
                                for a in record.args)
        return True


_TOKEN_IN_URL = re.compile(r"([?&])(t|k|key|pairing_key)=[^&\s\"]*")
logging.getLogger("uvicorn.access").addFilter(_RedactToken())


class LocalGuard:
    """ASGI middleware: refuse anything that is not this app."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket") or not enforce:
            return await self.app(scope, receive, send)
        ok, status, reason = verdict(scope)
        if ok:
            if scope["type"] == "http" and scope.get("path") == HANDSHAKE and scope.get("method") == "GET":
                return await _json(send, 200, b'{"token":"' + TOKEN.encode() + b'"}', scope)
            if scope["type"] == "http" and scope.get("path") == IDENTIFY:
                return await _json(send, 200, b'{"proof":"' + identify(scope).encode() + b'"}', scope)
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            # Refused before the handshake completes: the page gets nothing.
            await send({"type": "websocket.close", "code": 4403, "reason": "Not this app."})
            return
        body = b'{"detail":"This request did not come from iReliabee.","code":"local_auth"}'
        return await _json(send, status, body, scope, auth_required=(reason == "token"))


async def _json(send, status: int, body: bytes, scope, auth_required: bool = False):
    # CORS (outside this, in main.py) adds the headers the app's page needs to
    # read the reply, including x-irb-auth, which tells it to fetch a fresh
    # token after the backend restarts.
    headers = [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]
    if auth_required:
        headers.append((b"x-irb-auth", b"required"))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})
