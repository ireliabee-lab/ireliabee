"""
The signed-in account, on this computer.

Sign-in is a link emailed to the address (see `website/functions/v1/auth/`).
The link opens a page holding a short-lived, single-use code, and there are two
ways for that code to reach this process: the page hands it over loopback, the
same shape the calendar sign-in already uses, or somebody types it in when the
loopback route cannot land — from a phone, or after a restart moved this backend
to another port. Either way the app trades the code for two tokens:

* a **refresh token**, long-lived and specific to this machine, kept on disk
* an **access token**, good for 15 minutes, kept in memory and re-minted as
  needed

The short access token is what makes the AI proxy cheap: it can be verified
without a database round trip on every call. The cost is a 15-minute window in
which a revoked device still works, which is why the refresh token — the thing
that survives a restart — is the one that can be revoked server-side.

State is ``~/.config/ireliabee/account.json``, mode 600 where the filesystem
allows it. Nothing here is a secret we invented: both tokens come from the
service and can be revoked there.
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import threading
import time
from typing import Optional

from .appdirs import CONFIG_DIR

ACCOUNT_PATH = CONFIG_DIR / "account.json"

DEFAULT_API = "https://ireliabee.co.uk/v1"

#: Re-mint an access token this long before it expires, so a call never fails
#: on a token that went stale mid-request.
REFRESH_MARGIN_SECONDS = 120
NETWORK_TIMEOUT_SECONDS = 10

_lock = threading.Lock()


class AccountError(Exception):
    """Something went wrong that is worth showing the user."""


class AccountUnreachable(AccountError):
    """
    The service was never reached, so it never said no.

    A subclass, so every ``except AccountError`` still catches it. The
    difference only matters where "your sign-in was refused" and "your wifi
    dropped" need different words (backend/errors.py).
    """


class AccountSuspended(AccountError):
    """
    The service answered, and said this account is suspended — blocked from
    the backoffice. A subclass for the same reason as AccountUnreachable: most
    callers only need "it didn't work", but the words shown for it must not be
    "sign in again", which for a suspended account is refused too.
    """


def _api() -> str:
    return (os.environ.get("IRELIABEE_API") or DEFAULT_API).rstrip("/")


def device_id() -> str:
    """
    A stable, salted id for this machine.

    Lives in `core.licence` today. Device identity outlives licensing — the
    service uses it to label sessions and to let one laptop be signed out
    without ending the others — so it moves here when that module goes.
    """
    from .licence import device_id as _device_id
    return _device_id()


def device_label() -> str:
    from .licence import device_label as _device_label
    return _device_label()


# -- State -------------------------------------------------------------------

def _load() -> dict:
    try:
        raw = json.loads(ACCOUNT_PATH.read_text(encoding="utf-8"))
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _save(data: dict) -> None:
    """Written atomically, so a crash cannot leave a half-written token."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ACCOUNT_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass                      # Windows and some filesystems do not do modes
    os.replace(tmp, ACCOUNT_PATH)


def _clear() -> None:
    try:
        ACCOUNT_PATH.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        _save({})


# -- Talking to the service --------------------------------------------------

class HostedOff(AccountError):
    """The open edition with the hosted service switched off (backend/edition.py): nothing is sent."""


def _require_hosted() -> None:
    from .. import edition
    if not edition.hosted_enabled():
        raise HostedOff(
            "Signing in to iReliabee is off in this build: it runs on your own keys. "
            "Start it with IRELIABEE_HOSTED=1 to use iReliabee's hosted AI and credits instead.")


def _post(path: str, body: dict, token: Optional[str] = None) -> dict:
    _require_hosted()
    import requests
    headers = {"authorization": f"Bearer {token}"} if token else None
    try:
        r = requests.post(f"{_api()}{path}", json=body, headers=headers,
                          timeout=NETWORK_TIMEOUT_SECONDS)
    except Exception:
        raise AccountUnreachable("Could not reach iReliabee. Check your internet connection.")
    if r.status_code in (400, 401, 403, 404, 409, 422, 502):
        try:
            detail = r.json().get("message")
        except Exception:
            detail = None
        if r.status_code == 403 and detail and "suspended" in detail.lower():
            raise AccountSuspended(detail)
        raise AccountError(detail or "That did not work. Please try again.")
    if r.status_code >= 500:
        raise AccountError("iReliabee is having trouble. Try again in a few minutes.")
    try:
        return r.json()
    except Exception:
        raise AccountError("iReliabee sent something unexpected.")


def _get(path: str, token: str) -> dict:
    _require_hosted()
    import requests
    try:
        r = requests.get(
            f"{_api()}{path}",
            headers={"authorization": f"Bearer {token}"},
            timeout=NETWORK_TIMEOUT_SECONDS,
        )
    except Exception:
        raise AccountUnreachable("Could not reach iReliabee. Check your internet connection.")
    if r.status_code == 401:
        raise AccountError("Please sign in again.")
    if r.status_code == 403:
        try:
            detail = r.json().get("message") or ""
        except Exception:
            detail = ""
        if "suspended" in detail.lower():
            raise AccountSuspended(detail)
    if r.status_code >= 400:
        raise AccountError("That did not work. Please try again.")
    try:
        return r.json()
    except Exception:
        raise AccountError("iReliabee sent something unexpected.")


# -- The flow ----------------------------------------------------------------

#: The nonce of the sign-in this app asked for, and when it stops being good.
#: A link only completes here if it carries it back, so a web page cannot
#: sign the app into an account of its choosing by sending the browser to
#: /account/complete with a code it got for itself (audit 182-M1). Kept in
#: memory: a link requested before a restart is simply requested again.
_pending_state: dict = {"value": None, "until": 0.0}
#: How long this app will still finish a sign-in it started.
#:
#: It has to outlast the whole chain, and the chain got longer: the link lives
#: 15 minutes on the service and the code it mints lives another 10 (its
#: AUTH_CODE_TTL), so a link redeemed at minute 14 hands over a code still good
#: at minute 24. At 20 minutes the loopback button was refused with "ask for a
#: new link" while the code beside it still worked — a margin that used to be
#: 16 against 20 and was quietly eaten when the code's life went from 60
#: seconds to 10 minutes. 30 leaves the same slack the original had.
_STATE_TTL = 30 * 60


def request_sign_in(email: str, port: int = 8000) -> str:
    """
    Ask the service to email a sign-in link.

    `port` is where this app is listening, so the link knows where to hand the
    code back. The answer is the same whether or not the address has an
    account — the service will not say, and neither will we.
    """
    email = (email or "").strip()
    if not email or "@" not in email:
        raise AccountError("Enter the email address you want to sign in with.")
    state = secrets.token_urlsafe(24)
    result = _post("/auth/request", {"email": email, "port": int(port), "state": state})
    with _lock:
        _pending_state.update(value=state, until=time.time() + _STATE_TTL)
    return result.get("message") or "Check your email for the sign-in link."


def complete(code: str, state: str = "") -> dict:
    """Trade the one-time code for tokens, and remember them — only for a sign-in this app started."""
    if not code:
        raise AccountError("That sign-in link was incomplete.")
    with _lock:
        expected, until = _pending_state["value"], _pending_state["until"]
    matches = bool(expected and state) and hmac.compare_digest(state.encode(), expected.encode())
    if not matches or time.time() > until:
        raise AccountError(
            "This sign-in wasn't started from iReliabee on this computer, or it has expired. "
            "Open iReliabee and ask for a new link.")
    return _store_tokens(_exchange(code))


def complete_with_code(code: str, email: str) -> dict:
    """
    Finish a sign-in from the code shown on the page, rather than over loopback.

    The loopback handoff is the quiet path; this is the one that works when it
    cannot happen at all. The link carries the port this backend was on when it
    asked for the link, so a restart since then sends the browser to a port
    nothing is listening on — and a link opened on a phone points the phone at
    itself. Both used to end on the browser's own error page with the code lost
    behind it.

    **`email` is not a convenience; it is what replaces the nonce.**

    The nonce on `complete` did two jobs and it is easy to see only the first.
    One was stopping a *web page* driving `GET /account/complete` — exempt from
    the local guard, because the system browser cannot carry a token — into
    signing this app into an account of the page's choosing (audit 182-M1).
    That job is covered here by the guard itself: this is a POST on the guarded
    API and no page holds the per-launch token.

    The other was proving the code belonged to a sign-in **this app asked for**,
    and nothing about the guard does that. A code is just twelve characters a
    person can be talked into typing, and `/v1/auth/handoff` will render anyone's
    live code on the real domain under the words "Finish signing in". Without
    this check, one typed code binds this computer to someone else's account:
    the machine's free monthly credit is claimed for them, irreversibly for the
    month (`free_devices` is PRIMARY KEY (device, month)), and every session
    after it runs against — and is readable from — that account.

    So the address is required and must be the one the code resolves to. A code
    for another account is refused and the token it bought is handed straight
    back, which costs an attacker the one thing they were trying to buy.

    A nonce could not have done this job: it lives in memory, so the restart
    that breaks the loopback handoff is the same event that loses it. The
    address survives, because the person typing it knows it.
    """
    code = (code or "").strip()
    wanted = (email or "").strip().lower()
    if not code:
        raise AccountError("Enter the code from the sign-in page.")
    if not wanted or "@" not in wanted:
        raise AccountError("Enter the email address you asked for the link with.")

    # Sent as typed. The service folds the hyphens, the case and the characters
    # people misread (see `normaliseAuthCode`); one owner for that rule is
    # better than two that can drift.
    result = _exchange(code)
    got = str((result.get("account") or {}).get("email") or "").strip().lower()

    # Closed, not open: an answer we cannot check is not an answer we accept.
    if got != wanted:
        _revoke(result.get("refresh_token"))
        raise AccountError(
            f"That code signs in as {got or 'another account'}, not {wanted}. "
            "Use the code from the link sent to your own address — and if you "
            "did not ask for this one, ignore it.")
    return _store_tokens(result)


def _revoke(refresh: Optional[str]) -> None:
    """
    Give back a token we have decided not to keep.

    Best effort on purpose: the sign-in is already being refused, and failing
    to reach the service is not a reason to leave the caller with an error
    about something they cannot act on. The token expires on its own either
    way; this just does not wait for that.
    """
    if not refresh:
        return
    try:
        _post("/auth/signout", {"refresh_token": refresh})
    except AccountError:
        pass


def _exchange(code: str) -> dict:
    """Trade a one-time code for tokens, saying which computer is asking."""
    return _post("/auth/exchange", {
        "code": code,
        "device": device_id(),
        "device_label": device_label(),
    })


def _store_tokens(result: dict) -> dict:
    """
    Keep what the exchange gave back — or nothing at all, if it was incomplete.

    Half a sign-in is worse than none: it reads as signed in and fails on the
    first call that matters.
    """
    refresh = result.get("refresh_token")
    access = result.get("access_token")
    if not refresh or not access:
        raise AccountError("Sign-in did not complete. Please try again.")
    with _lock:
        _pending_state.update(value=None, until=0.0)      # one link, one sign-in
        _forget_refusals()                                # they were about the sign-in this replaces
        _save({
            "refresh_token": refresh,
            "access_token": access,
            # The service owns the real expiry; this is only for knowing when
            # to ask for another, and erring early costs one extra request.
            "access_expires": int(time.time()) + 15 * 60,
            "account": result.get("account") or {},
        })
    return result.get("account") or {}


def _current(margin: int = REFRESH_MARGIN_SECONDS) -> tuple[Optional[str], Optional[str], bool]:
    """(access token, refresh token, whether the access token is good for `margin` more seconds)."""
    with _lock:
        data = _load()
        token, expires = data.get("access_token"), int(data.get("access_expires") or 0)
        refresh = data.get("refresh_token")
    return token, refresh, bool(token and expires - margin > time.time())


#: One refresh at a time: a caller that finds one running waits for its result
#: instead of sending its own (and, if that attempt failed, doesn't queue another
#: timeout behind it). Counts finished attempts.
_refresh_lock = threading.Lock()
_attempts = 0


def access_token() -> Optional[str]:
    """
    A usable access token, refreshed if it is close to expiring.

    Returns None when nobody is signed in — callers treat that as "signed out"
    rather than as an error, because it is the ordinary state before sign-in.
    """
    token, refresh, fresh = _current()
    if not refresh:
        return None
    if fresh:
        return token
    seen = _attempts
    with _refresh_lock:
        token, refresh, fresh = _current()          # someone else may have just refreshed it
        if not refresh:
            return None
        if fresh or _attempts != seen:              # ...or tried and failed: keep what we have
            return token
        return _attempt(token, refresh)


def _attempt(token: Optional[str], refresh: str) -> Optional[str]:
    """One refresh, counted. Call holding _refresh_lock."""
    global _attempts
    try:
        return _refresh(token, refresh)
    finally:
        _attempts += 1


#: When a refresh last failed on the way out rather than being refused. A 401
#: shortly after one of these is an access token that aged out while the network
#: was gone — not a sign-in the service rejected — and the two need different
#: words (backend/errors.py). Kept short: the stale-token 401 arrives within
#: seconds of the failed refresh, and the access token itself lasts minutes.
_unreachable_since: dict = {"at": 0.0}
UNREACHABLE_WINDOW_SECONDS = 60.0


def refresh_unreachable(within: float = UNREACHABLE_WINDOW_SECONDS) -> bool:
    """Whether the last refresh failed on the way out rather than being refused."""
    at = _unreachable_since["at"]
    return bool(at) and (time.time() - at) < within


#: When a refresh was last refused because the account is suspended. A block
#: revokes every refresh token, so a suspended account's next renewal is
#: refused — and the expired access token it leaves behind makes the next AI
#: call a 401. Read out as "please sign in again", that sends them round a loop
#: that can only be refused; remembered here, it is read out as "suspended".
#: Kept for as long as the refusal is the latest word: a refresh that is refused
#: for any other reason, or succeeds, clears it, and so does signing in or out.
_suspended_since: dict = {"at": 0.0}


def refresh_suspended() -> bool:
    """Whether the last refresh was refused because the account is suspended."""
    return bool(_suspended_since["at"])


def _forget_refusals() -> None:
    """
    Drop what the last renewal was told, because the sign-in it was about is gone.

    Both flags describe one sign-in: the one whose renewal set them. A fresh
    sign-in has its own brand-new token and no renewal of its own for about ten
    minutes, so a flag left over from the sign-in before it (the account that
    was suspended and has since been unblocked, or a different account
    altogether) would read that sign-in's first 401 as "suspended". Call it
    holding _lock, beside the write that changes who is signed in.
    """
    _suspended_since["at"] = 0.0
    _unreachable_since["at"] = 0.0


def _refresh(token: Optional[str], refresh: str) -> Optional[str]:
    try:
        result = _post("/auth/refresh", {"refresh_token": refresh})
    except AccountUnreachable:
        # Never reached the service, so it never refused anything. Remembered,
        # because the 401 this produces a moment later is about the network and
        # must not be read out as "your sign-in has expired".
        _unreachable_since["at"] = time.time()
        return token
    except AccountSuspended:
        _unreachable_since["at"] = 0.0
        with _lock:
            # The refusal can take seconds to come back. If they signed out, or
            # in again, meanwhile, it is about a sign-in that no longer exists
            # and must not be pinned on the one that replaced it.
            if _load().get("refresh_token") == refresh:
                _suspended_since["at"] = time.time()
        return token
    except AccountError:
        # The service answered and said no. Keep what we have and let the next
        # call try again — signing someone out because their wifi dropped would
        # be worse than a failed request — but this was not the network.
        _unreachable_since["at"] = 0.0
        _suspended_since["at"] = 0.0
        return token
    _unreachable_since["at"] = 0.0
    _suspended_since["at"] = 0.0
    new_access = result.get("access_token")
    if not new_access:
        return token
    with _lock:
        data = _load()
        if data.get("refresh_token") != refresh:
            # Signed out (or into another account) while this was on its way: don't
            # write the old sign-in back.
            return data.get("access_token") if data.get("refresh_token") else None
        data.update({
            "access_token": new_access,
            "access_expires": int(time.time()) + 15 * 60,
            "account": result.get("account") or data.get("account") or {},
        })
        _save(data)
    return new_access


#: How early the background refresher renews, before a request would have to.
EARLY_REFRESH_SECONDS = 4 * 60


def keep_fresh_in_background() -> None:
    """Renew the access token a few minutes before it runs out, on its own thread.

    Otherwise the first AI call or live-audio start after the token ages out makes a
    blocking network request (up to the timeout) on the server's event loop, and a
    live session stalls while it waits.
    """
    def run() -> None:
        while True:
            time.sleep(60)
            try:
                token, refresh, fresh = _current(REFRESH_MARGIN_SECONDS + EARLY_REFRESH_SECONDS)
                if refresh and not fresh and _refresh_lock.acquire(blocking=False):   # never queue behind a request
                    try:
                        token, refresh, fresh = _current(REFRESH_MARGIN_SECONDS + EARLY_REFRESH_SECONDS)
                        if refresh and not fresh:
                            _attempt(token, refresh)
                    finally:
                        _refresh_lock.release()
            except Exception:
                pass                                   # the next request refreshes as before

    threading.Thread(target=run, name="token-refresh", daemon=True).start()


def sign_out() -> None:
    """Revoke this device server-side, then forget it locally whatever happened."""
    data = _load()
    refresh = data.get("refresh_token")
    if refresh:
        try:
            _post("/auth/signout", {"refresh_token": refresh})
        except AccountError:
            pass                  # they asked to sign out; do not trap them offline
    with _lock:                   # a refresh finishing now sees the file gone, and keeps it gone
        _clear()
        _forget_refusals()


def backoffice_link() -> str:
    """
    A one-time link into the web backoffice, for the admin account.

    The service checks the admin list itself; this only vouches for the
    browser the app is about to open, so the admin does not wait on an email.
    The link works once, within a minute.
    """
    token = access_token()
    if not token:
        raise AccountError("You are not signed in.")
    url = _post("/admin/handoff", {}, token=token).get("url")
    if not url:
        raise AccountError("iReliabee sent something unexpected.")
    return url


def balance() -> dict:
    """
    The credit balance, from the service.

    **Cached after every successful read**, and the cache is what `status`
    reports. The balance lives on the server where the user cannot edit it, but
    a laptop on a train still has to be able to say roughly what is left rather
    than showing a blank where a number should be — so the cached figure is
    served with the time it was read, and the screen says so.

    `held` is what running sessions have reserved and not yet spent, so
    `available` is the number that actually decides whether a session can
    start. Showing only `credits` would let someone watch a balance that never
    moves while a session quietly spends against it.
    """
    token = access_token()
    if not token:
        raise AccountError("You are not signed in.")
    result = _get("/account", token)
    bal = result.get("balance") or {}
    known = {
        "credits": float(bal.get("credits") or 0),
        "held": float(bal.get("held") or 0),
        "available": float(bal.get("available") or 0),
        "at": int(time.time()),
    }
    # What the available credits buy, as the service works it out (the same
    # figure the backoffice shows). Left out when an older service sends none,
    # and the app then works live time out from `available` itself.
    left = result.get("time_left")
    if isinstance(left, dict):
        def seconds(key):
            v = left.get(key)
            return int(v) if isinstance(v, (int, float)) and v >= 0 else None
        owes = left.get("owes_credits")
        known["time_left"] = {
            "live_seconds": seconds("live_seconds"),
            "voice_mock_seconds": seconds("voice_mock_seconds"),
            "owes_credits": float(owes) if isinstance(owes, (int, float)) and owes > 0 else 0.0,
        }
    with _lock:
        data = _load()
        if data.get("refresh_token"):
            data["balance"] = known
            if result.get("account"):
                data["account"] = result["account"]
            free = result.get("free")
            if isinstance(free, dict):
                # This month's free credit: one per computer, so it can be "elsewhere".
                data["free"] = {"month": str(free.get("month") or ""), "granted": bool(free.get("granted")),
                                "elsewhere": bool(free.get("elsewhere"))}
            _save(data)
    return known


def status(refresh: bool = False) -> dict:
    """
    Who is signed in, for the UI. Never raises and never blocks on the network
    unless asked: it is on the app's startup path.
    """
    from .. import edition
    hosted = edition.hosted_enabled()
    data = _load()
    account = data.get("account") or {}
    # With the hosted service switched off (the open edition's default), a sign-in
    # kept from before counts for nothing: it is not used, and so it is not shown.
    signed_in = bool(data.get("refresh_token")) and hosted
    if signed_in and refresh:
        try:
            access_token()
            data = _load()
            account = data.get("account") or account
        except Exception:
            pass
        try:
            balance()
            data = _load()
        except Exception:
            pass                  # the cached figure below is the fallback
    open_edition = edition.is_open()
    return {
        "signed_in": signed_in,
        "account": account if signed_in else None,
        # Whether this account may enter provider keys: an owner, or someone
        # an owner granted own keys in the backoffice. The service decides.
        # See docs/hosted-pivot.md, step 8. The open edition, signed out, runs
        # on its own keys: that is the point of it (backend/edition.py).
        "admin": bool(account.get("admin")) if signed_in else open_edition,
        "edition": edition.name(),
        # Whether signing in to the hosted service is offered at all: always in
        # the app, only when switched on in the open edition.
        "hosted": hosted,
        # Whether to offer "Open backoffice": a separate grant, checked again
        # by the service when the link is asked for. A service from before the
        # two were split sends no `backoffice`, and then only owners had it.
        "backoffice": bool(account.get("backoffice", account.get("admin"))) if signed_in else False,
        "balance": (data.get("balance") or None) if signed_in else None,
        "free": (data.get("free") or None) if signed_in else None,
        "device": {"id": device_id(), "label": device_label()},
    }
