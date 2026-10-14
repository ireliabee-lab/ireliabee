"""
Licence and entitlements.

iReliabee has no account system and no iReliabee cloud, so a licence is a
**signed entitlement token** the app verifies offline with an embedded Ed25519
public key. The token is the authority; nothing else is trusted.

    IRL1.<payload>.<signature>

`payload` is base64url(JSON) and `signature` is base64url(Ed25519 over the ASCII
bytes of ``IRL1.<payload>``). Signing over the encoded form, not the decoded
JSON, means no canonicalisation ambiguity: a token either verifies byte for byte
or it does not.

Two ways in:

* **Licence key** - the short code a buyer receives (``IREL-...``). The app sends
  it to the activation service, which returns an entitlement token. Keys can be
  revoked and re-issued; tokens are short-lived and refreshed.
* **Entitlement token** - pasted or imported directly. Works with no network at
  all, which is what team, education and air-gapped installs need.

Design rules, in order of importance:

1. **A licence check never interrupts a call in progress.** Verification is
   local and takes microseconds; refresh happens on a background thread and a
   failed refresh costs nothing until the grace period runs out.
2. **Offline works.** The signature is checked against a key compiled into the
   app. The activation service is for issuing and revoking, not for permission.
3. **Clocks lie.** The highest timestamp ever seen is persisted; winding the
   system clock back does not extend an expired licence.
4. **The app runs on the user's machine, so a determined user can bypass any of
   this.** That is accepted and deliberate. These gates are for honest users;
   no effort is spent on obfuscation or anti-tamper theatre.

State is a single JSON file, ``~/.config/ireliabee/licence.json``. Tampering
with it cannot grant entitlements - only a valid signature can.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from .appdirs import CONFIG_DIR

# -- Constants ---------------------------------------------------------------

PRODUCT = "ireliabee"
TOKEN_PREFIX = "IRL1"
LICENCE_PATH = CONFIG_DIR / "licence.json"

#: Signing keys, newest first. Rotation: add the new key, issue with it, keep the
#: old one until every token signed by it has expired, then delete the entry.
PUBLIC_KEYS: dict[str, str] = {
    "k1": "691c060b32bf5f883fc5eece0514d6705f0d26c2912f5afbfc671ae0330cb6e6",
}

#: How long a token stays good after `exp` while refresh keeps failing. Someone
#: offline for a fortnight, or on a flight, keeps working.
GRACE_DAYS = 14
#: Start trying to refresh this long before `exp`, so a normal user never sees grace.
REFRESH_LEAD_DAYS = 7
#: Never hammer the activation service.
REFRESH_INTERVAL_SECONDS = 6 * 3600
#: A licence check must never be the reason the app feels slow.
NETWORK_TIMEOUT_SECONDS = 8
#: A clock that moves back less than this is drift, not tampering.
CLOCK_SLACK_SECONDS = 24 * 3600

# The licence service runs as Cloudflare Pages Functions beside the website
# (website/functions/v1/licences/), so it shares the site's host and TLS.
DEFAULT_API = "https://ireliabee.co.uk/v1"

#: Free tier: live sessions are counted per session id, for ever, not per month.
FREE_LIVE_SESSIONS = 2

#: Everything a Pro licence unlocks. Used by the gates and shown in the UI.
PRO_FEATURES = (
    "live",        # the live companion in a real call
    "calendar",    # calendar sync, invite -> plan, reminders, Join & listen
    "recap",       # meeting recap, action items, follow-up email
    "people",      # people research
    "study",       # lecture companion and study packs
    "notebook",    # notebooks written by the AI from lectures, meetings and documents
    "retry",       # hard moments
    "exams",       # IELTS and TOEFL band scoring
    "export",      # debrief PDF export
)


class LicenceError(Exception):
    """A licence operation failed in a way worth showing the user."""


# -- Token verification ------------------------------------------------------

def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def verify_token(token: str, *, keys: Optional[dict[str, str]] = None) -> dict:
    """
    Check `token`'s signature and shape and return its payload.

    Raises LicenceError with a message meant for a person. This does **not**
    check expiry - that is `evaluate()`, which needs the tamper-resistant clock.
    """
    keys = PUBLIC_KEYS if keys is None else keys
    parts = (token or "").strip().split(".")
    if len(parts) != 3 or parts[0] != TOKEN_PREFIX:
        raise LicenceError("That does not look like an iReliabee licence token.")
    _, payload_b64, sig_b64 = parts

    try:
        signed = f"{TOKEN_PREFIX}.{payload_b64}".encode("ascii")
        signature = _b64url_decode(sig_b64)
        payload = json.loads(_b64url_decode(payload_b64))
    except Exception:
        raise LicenceError("This licence token is damaged - copy it again in full.")
    if not isinstance(payload, dict):
        raise LicenceError("This licence token is damaged - copy it again in full.")

    kid = str(payload.get("kid") or "k1")
    pub_hex = keys.get(kid)
    if not pub_hex or pub_hex.startswith("REPLACE_"):
        raise LicenceError("This licence was signed with a key this version does not know. Update iReliabee.")
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(pub_hex)).verify(signature, signed)
    except InvalidSignature:
        raise LicenceError("This licence token is not genuine.")
    except Exception:
        raise LicenceError("This licence token could not be checked.")

    if payload.get("prod") != PRODUCT:
        raise LicenceError("This licence is for a different product.")
    if int(payload.get("v") or 0) != 1:
        raise LicenceError("This licence needs a newer version of iReliabee.")
    for required in ("lic", "tier", "iat", "exp"):
        if payload.get(required) in (None, ""):
            raise LicenceError("This licence token is incomplete.")
    return payload


# -- Device identity ---------------------------------------------------------

_DEVICE_SALT = b"ireliabee/device/v1"


def _machine_id_raw() -> Optional[str]:
    """The OS's own stable machine identifier, or None if it cannot be read."""
    try:
        if sys.platform == "win32":
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                r"SOFTWARE\Microsoft\Cryptography", 0,
                                winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
                return str(winreg.QueryValueEx(k, "MachineGuid")[0])
        if sys.platform == "darwin":
            out = subprocess.run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                                 capture_output=True, text=True, timeout=5).stdout
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    return line.split('"')[-2]
            return None
        for p in (Path("/etc/machine-id"), Path("/var/lib/dbus/machine-id")):
            if p.exists():
                value = p.read_text().strip()
                if value:
                    return value
    except Exception:
        pass
    return None


def device_id(store: Optional["LicenceStore"] = None) -> str:
    """
    A stable, non-reversible id for this machine.

    Hashed with a salt so the raw machine GUID never leaves the computer, and
    so the id cannot be used to identify the same machine across other products.
    """
    raw = _machine_id_raw()
    if raw is None:
        store = store or LicenceStore.load()
        raw = store.data.get("device_fallback") or ""
        if not raw:
            raw = uuid.uuid4().hex
            store.data["device_fallback"] = raw
            store.save()
    return hashlib.sha256(_DEVICE_SALT + raw.encode("utf-8")).hexdigest()[:32]


def device_label() -> str:
    """A human name for this machine, shown in the account's device list."""
    try:
        return f"{platform.node() or 'Unknown'} ({platform.system()})"
    except Exception:
        return "Unknown"


# -- State file --------------------------------------------------------------

@dataclass
class LicenceStore:
    """
    ``licence.json``: the token, the key that produced it, and bookkeeping.

    Everything here is untrusted input. The signature is what grants anything.
    """
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls) -> "LicenceStore":
        try:
            raw = json.loads(LICENCE_PATH.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                return cls(raw)
        except Exception:
            pass
        return cls({})

    def save(self) -> None:
        """Write atomically so a crash or a full disk cannot truncate the licence."""
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = LICENCE_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, indent=2), encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass                      # Windows and some filesystems do not do modes
        os.replace(tmp, LICENCE_PATH)

    # -- Tamper-resistant clock ----------------------------------------------

    def now(self) -> int:
        """
        The current time, never earlier than the latest time we have ever seen.

        Winding the system clock back is the oldest trick for extending an
        expired licence, and it is the one thing an offline check can defend
        against cheaply.
        """
        system = int(time.time())
        seen = int(self.data.get("seen_at") or 0)
        if system > seen:
            self.data["seen_at"] = system
            return system
        if seen - system > CLOCK_SLACK_SECONDS:
            return seen               # clock moved back a long way: do not reward it
        return system


# -- Evaluation --------------------------------------------------------------

@dataclass
class Entitlement:
    """What the app is allowed to do right now, and why."""
    state: str                      # none | active | grace | expired | invalid | revoked
    tier: str = "free"              # free | pro
    plan: str = ""                  # monthly | annual | pass7 | team | lifetime
    licence_id: str = ""
    holder: str = ""
    seats: int = 1
    expires_at: Optional[int] = None    # when the entitlement itself runs out
    grace_until: Optional[int] = None
    message: str = ""

    @property
    def is_pro(self) -> bool:
        return self.tier == "pro" and self.state in ("active", "grace")

    def as_dict(self) -> dict:
        return {
            "state": self.state,
            "tier": self.tier,
            "plan": self.plan,
            "licence_id": self.licence_id,
            "holder": self.holder,
            "seats": self.seats,
            "expires_at": self.expires_at,
            "grace_until": self.grace_until,
            "message": self.message,
            "is_pro": self.is_pro,
        }


def evaluate(store: Optional[LicenceStore] = None) -> Entitlement:
    """The current entitlement, from local state only. Never touches the network."""
    store = store or LicenceStore.load()
    token = store.data.get("token")
    if not token:
        return Entitlement(state="none")

    if store.data.get("revoked"):
        return Entitlement(state="revoked",
                           message="This licence was cancelled or moved to another device.")

    try:
        payload = verify_token(token)
    except LicenceError as e:
        return Entitlement(state="invalid", message=str(e))

    now = store.now()
    store.save()                      # persist the high-water clock mark

    bound = payload.get("dev")
    if bound and bound != device_id(store):
        return Entitlement(state="invalid",
                           message="This licence is registered to a different computer.")

    tier = str(payload.get("tier") or "free")
    exp = int(payload.get("exp"))
    sub_exp = payload.get("sub_exp")
    sub_exp = int(sub_exp) if sub_exp not in (None, "") else None
    grace_until = exp + GRACE_DAYS * 86400

    common = dict(
        plan=str(payload.get("plan") or ""),
        licence_id=str(payload.get("lic") or ""),
        holder=str(payload.get("holder") or ""),
        seats=int(payload.get("seats") or 1),
        expires_at=sub_exp or exp,
        grace_until=grace_until,
    )

    # The subscription end date is absolute: grace covers a failed *refresh*,
    # not a licence that has genuinely run out.
    if sub_exp is not None and now > sub_exp:
        return Entitlement(state="expired", tier="free", **common,
                           message="This licence has ended. Renew to use Pro features again.")
    if now <= exp:
        return Entitlement(state="active", tier=tier, **common)
    if now <= grace_until:
        days = max(1, (grace_until - now) // 86400)
        plural = "s" if days != 1 else ""
        return Entitlement(state="grace", tier=tier, **common,
                           message=f"iReliabee could not reach the licence service. "
                                   f"Pro keeps working for {days} more day{plural}.")
    return Entitlement(state="expired", tier="free", **common,
                       message="iReliabee could not confirm this licence. "
                               "Connect to the internet once to restore Pro.")


def is_pro() -> bool:
    return evaluate().is_pro


def allows(feature: str) -> bool:
    """Whether `feature` is available right now. Unknown features are free."""
    if feature not in PRO_FEATURES:
        return True
    return is_pro()


# -- Activation service ------------------------------------------------------

def _api_base() -> str:
    return (os.environ.get("IRELIABEE_LICENCE_API") or DEFAULT_API).rstrip("/")


def normalise_key(key: str) -> str:
    """Upper-case, strip anything that is not part of the code, re-group in fives."""
    cleaned = "".join(c for c in (key or "").upper() if c.isalnum())
    if cleaned.startswith("IREL"):
        cleaned = cleaned[4:]
    groups = [cleaned[i:i + 5] for i in range(0, len(cleaned), 5)]
    return "-".join(["IREL"] + groups) if groups else ""


def looks_like_key(key: str) -> bool:
    """Cheap shape check so an obvious typo is caught before a network round trip."""
    body = "".join(c for c in normalise_key(key).split("-", 1)[-1] if c.isalnum())
    return 16 <= len(body) <= 40


def _post(path: str, body: dict) -> dict:
    import requests
    try:
        r = requests.post(f"{_api_base()}{path}", json=body, timeout=NETWORK_TIMEOUT_SECONDS)
    except Exception:
        raise LicenceError("Could not reach the licence service. Check your internet connection.")
    if r.status_code in (400, 403, 404, 409, 410, 422):
        try:
            detail = r.json().get("message")
        except Exception:
            detail = None
        raise LicenceError(detail or "That licence key was not accepted.")
    if r.status_code >= 500:
        raise LicenceError("The licence service is having trouble. Try again in a few minutes.")
    try:
        return r.json()
    except Exception:
        raise LicenceError("The licence service sent something unexpected.")


def activate(key: str) -> Entitlement:
    """Exchange a licence key for an entitlement token and store it."""
    key = normalise_key(key)
    if not looks_like_key(key):
        raise LicenceError("That licence key looks incomplete - check it against your receipt.")
    store = LicenceStore.load()
    result = _post("/licences/activate", {
        "key": key,
        "product": PRODUCT,
        "device": device_id(store),
        "device_label": device_label(),
    })
    token = result.get("token") or ""
    verify_token(token)               # never store something we cannot verify
    store.data.update({
        "key": key,
        "token": token,
        "activated_at": store.now(),
        "last_refresh_at": store.now(),
        "last_error": "",
        "revoked": False,
    })
    store.save()
    return evaluate(store)


def import_token(token: str) -> Entitlement:
    """Install an entitlement token directly - no network, for team and offline installs."""
    token = (token or "").strip()
    verify_token(token)
    store = LicenceStore.load()
    store.data.update({
        "token": token,
        "key": store.data.get("key") or "",
        "activated_at": store.now(),
        "last_refresh_at": 0,
        "last_error": "",
        "revoked": False,
    })
    store.save()
    return evaluate(store)


def deactivate() -> Entitlement:
    """Release this device so the seat can be used elsewhere. Always clears locally."""
    store = LicenceStore.load()
    key = store.data.get("key")
    if key:
        try:
            _post("/licences/deactivate", {"key": key, "product": PRODUCT,
                                           "device": device_id(store)})
        except LicenceError:
            pass                      # the user asked to sign out; do not trap them offline
    for k in ("key", "token", "activated_at", "last_refresh_at", "last_error", "revoked"):
        store.data.pop(k, None)
    store.save()
    return evaluate(store)


def refresh(force: bool = False) -> Entitlement:
    """
    Ask the service for a fresh token. Safe to call often; does nothing unless due.

    A failure is recorded and swallowed: grace exists precisely so that a flaky
    network is not the user's problem.
    """
    store = LicenceStore.load()
    key = store.data.get("key")
    token = store.data.get("token")
    if not key or not token:
        return evaluate(store)        # offline-imported tokens have nothing to refresh against

    now = store.now()
    last = int(store.data.get("last_refresh_at") or 0)
    if not force:
        if now - last < REFRESH_INTERVAL_SECONDS:
            return evaluate(store)
        try:
            exp = int(verify_token(token).get("exp"))
        except LicenceError:
            exp = 0
        if now < exp - REFRESH_LEAD_DAYS * 86400:
            return evaluate(store)    # still comfortably valid; leave the service alone

    try:
        result = _post("/licences/refresh", {"key": key, "product": PRODUCT,
                                             "device": device_id(store)})
    except LicenceError as e:
        store.data["last_error"] = str(e)
        store.data["last_refresh_at"] = now
        store.save()
        return evaluate(store)

    if result.get("revoked"):
        store.data.update({"revoked": True, "last_refresh_at": now,
                           "last_error": "This licence is no longer active."})
        store.save()
        return evaluate(store)

    new_token = result.get("token") or ""
    try:
        verify_token(new_token)
    except LicenceError as e:
        store.data["last_error"] = str(e)
        store.data["last_refresh_at"] = now
        store.save()
        return evaluate(store)

    store.data.update({"token": new_token, "last_refresh_at": now,
                       "last_error": "", "revoked": False})
    store.save()
    return evaluate(store)


_refresh_lock = threading.Lock()
_refreshing = False


def refresh_in_background() -> None:
    """Kick off a refresh if one is due. Returns immediately; never raises."""
    global _refreshing
    with _refresh_lock:
        if _refreshing:
            return
        _refreshing = True

    def run():
        global _refreshing
        try:
            refresh()
        except Exception:
            pass
        finally:
            with _refresh_lock:
                _refreshing = False

    threading.Thread(target=run, name="licence-refresh", daemon=True).start()
