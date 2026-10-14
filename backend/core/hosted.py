"""
Where the AI comes from: our service, or a key on this machine.

Step 8 of the hosted pivot (``docs/hosted-pivot.md``). Everyone gets the AI
through iReliabee. One seeded account may still use its own provider keys,
because when a provider changes a model, rate-limits us, or the proxy itself is
the suspect, running straight against a provider key is the only way to tell
whose fault it is. Deleting that costs a day to rebuild at exactly the moment
it is needed.

**The admin flag is not a client-side switch.** It is read from the account the
service returned, so turning it on means changing a row in our database, not a
file on a laptop. What a determined person can do locally is set provider keys
in their own environment — and that spends their money, not ours, which is the
outcome we would have chosen anyway.

There is one rule, and everything here follows from it:

    signed in and not admin   ->  our service, on our keys, metered
    admin with a key set      ->  that key, direct, unmetered by us
    not signed in             ->  nothing that costs money runs

The third case is why this module answers ``reason`` rather than just
``False``: a screen that says "sign in to use this" is an answer, and one that
silently does nothing is a bug report.
"""
from __future__ import annotations

import os
import re
import time
from typing import Optional

from . import account

#: Where the hosted API lives. Mirrors ``account.DEFAULT_API``.
def api_base() -> str:
    return account._api()


class NotAvailable(RuntimeError):
    """The AI cannot run, with a sentence explaining why to a person."""


def _unavailable(sign_in: str, provider: str, what: str) -> NotAvailable:
    """
    Why nothing ran: in the app, sign in; in the open edition (backend/edition.py),
    which runs on the user's own keys, the key that is missing.
    """
    from .. import edition
    if edition.is_open() and not access_token():
        return NotAvailable(f"Add your {provider} key in Settings to use {what}.")
    return NotAvailable(sign_in)


def is_admin() -> bool:
    """Whether this machine is signed in as the one account that may use keys."""
    try:
        return bool(account.status().get("admin"))
    except Exception:
        return False


def own_key(env_var: str) -> Optional[str]:
    """
    A provider key from this machine, but only for the admin account.

    Anyone else's key is ignored rather than removed: the setting is hidden,
    the environment may still carry one from an older version, and quietly
    honouring it would mean some installs metered and some not, with nothing on
    screen to say which.
    """
    if not is_admin():
        return None
    return os.environ.get(env_var) or None


def access_token() -> Optional[str]:
    """The short-lived token the proxy checks, or None when signed out."""
    try:
        return account.access_token()
    except Exception:
        return None


def anthropic_credentials() -> tuple[str, Optional[str]]:
    """
    ``(api_key, base_url)`` for the Anthropic client.

    A ``base_url`` of None means talk to Anthropic directly. Otherwise the key
    is our own access token and the base URL is our service, which speaks the
    same wire format — see ``website/functions/v1/messages.js``.
    """
    key = own_key("ANTHROPIC_API_KEY")
    if key:
        return key, None

    token = access_token()
    if not token:
        raise _unavailable("Sign in to use iReliabee's AI. Open Settings and choose Your account.",
                           "Anthropic", "the AI")
    return token, anthropic_base()


def anthropic_base() -> str:
    """
    Our service's address as the Anthropic SDK wants it: without ``/v1``.

    The SDK appends ``/v1/messages`` itself. Handing it ``api_base()``, which
    already ends in ``/v1``, sent every hosted AI call to ``/v1/v1/messages``
    — a 404 the app reported as "can't use this model". Unit tests did not
    notice because none of them built a real URL.
    """
    base = api_base().rstrip("/")
    return base[: -len("/v1")] if base.endswith("/v1") else base


def deepgram_endpoint(language: str, translate: bool = False) -> tuple[str, dict]:
    """
    ``(url, headers)`` for the live speech socket.

    Either Deepgram directly with an admin's own key, or our relay with an
    access token. The relay chooses the model and the options; see
    ``website/functions/v1/stt/listen.js`` for why the client does not.
    """
    from ..deepgram_stream import DEEPGRAM_URL

    key = own_key("DEEPGRAM_API_KEY")
    if key:
        return DEEPGRAM_URL.replace("{language}", language), {
            "Authorization": f"Token {key}",
        }

    token = access_token()
    if not token:
        raise _unavailable("Sign in to use iReliabee's speech recognition. "
                           "Open Settings and choose Your account.", "Deepgram", "speech recognition")
    base = api_base().replace("https://", "wss://").replace("http://", "ws://")
    # translate=1: this call's captions are translated, and the relay charges for that with the session.
    return f"{base}/stt/listen?language={language}" + ("&translate=1" if translate else ""), {
        "Authorization": f"Bearer {token}",
    }


AGENT_URL = "wss://agent.deepgram.com/v1/agent/converse"


def agent_endpoint() -> tuple[str, dict]:
    """
    ``(url, headers)`` for the voice mock's Voice Agent connection.

    The admin with a key talks to Deepgram directly; everyone else goes
    through our relay, which charges the call in credits and decides what the
    agent thinks with (website/server/agent.js). Audit 178-H6: this used a key
    on the user's computer for everyone.
    """
    key = own_key("DEEPGRAM_API_KEY")
    if key:
        return AGENT_URL, {"Authorization": f"Token {key}"}
    token = access_token()
    if not token:
        raise _unavailable("Sign in to use voice practice. Open Settings and choose Your account.",
                           "Deepgram", "voice practice")
    base = api_base().replace("https://", "wss://").replace("http://", "ws://")
    return f"{base}/agent/converse", {"Authorization": f"Bearer {token}"}


class SpeakError(Exception):
    """A refused speech request, carrying its HTTP status for errors.classify."""

    def __init__(self, status_code: int, text: str):
        super().__init__(f"HTTP {status_code} {text[:200]}")
        self.status_code = status_code


def speak(text: str, voice_model: str) -> bytes:
    """
    A short phrase as MP3: the voice preview and the pronunciation helper.

    Direct to Deepgram for the admin's own key; through our /v1/speak for
    everyone else, which charges it in credits.
    """
    import requests

    key = own_key("DEEPGRAM_API_KEY")
    if key:
        version = "v2" if voice_model.startswith("flux-") else "v1"
        res = requests.post(
            f"https://api.deepgram.com/{version}/speak",
            params={"model": voice_model, "encoding": "mp3"},
            headers={"Authorization": f"Token {key}", "Content-Type": "application/json"},
            json={"text": text}, timeout=30,
        )
    else:
        token = access_token()
        if not token:
            raise _unavailable("Sign in to hear voices. Open Settings and choose Your account.",
                               "Deepgram", "voices")
        res = requests.post(
            f"{api_base()}/speak",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"text": text, "voice": voice_model}, timeout=30,
        )
    if res.status_code != 200:
        raise SpeakError(res.status_code, res.text)
    return res.content


#: The service's credit rates, fetched at most every ten minutes (see `rates`).
_RATES: dict = {"at": 0.0, "value": None}
RATES_TTL_S = 600


def rates() -> Optional[dict]:
    """
    What the service charges, from its public price list (GET /api/checkout):
    `creditsPerUsd` (the backoffice markup) and `perMillionTokensUsd` per tier.
    Cached for ten minutes; the last good copy when the service can't be
    reached; None when there has never been one.
    """
    import requests

    now = time.time()
    if _RATES["value"] is not None and now - _RATES["at"] < RATES_TTL_S:
        return _RATES["value"]
    site = api_base().rstrip("/")
    site = site[: -len("/v1")] if site.endswith("/v1") else site
    try:
        res = requests.get(f"{site}/api/checkout", timeout=5)
        res.raise_for_status()
        value = res.json().get("rates") or {}
    except Exception:
        return _RATES["value"]
    _RATES.update(at=now, value=value)
    return value


def tier_for(model: str) -> str:
    """The tier the service bills a model name on: the same rule as its tierFor()."""
    return "careful" if re.search(r"opus|sonnet|careful|reasoner", model or "", re.I) else "fast"


def credits_for(model: str, in_tokens: int, out_tokens: int) -> Optional[float]:
    """
    Credits the service would charge for this many tokens on `model`, using its
    own formula (cost of the tier's model x credits per dollar). None when its
    prices aren't known: never a guess, because this number is shown as a price.
    """
    r = rates() or {}
    per_usd = r.get("creditsPerUsd")
    price = (r.get("perMillionTokensUsd") or {}).get(tier_for(model))
    if not per_usd or not isinstance(price, dict):
        return None
    try:
        usd = (in_tokens * float(price["in"]) + out_tokens * float(price["out"])) / 1_000_000
    except (KeyError, TypeError, ValueError):
        return None
    return usd * float(per_usd)


#: The one provider we proxy. Everything else needs a key we no longer give out.
HOSTED_PROVIDER = "anthropic"

#: What a saved model choice becomes when it is not one we serve. Latency
#: matters more than depth for live cues, so the fast tier is the safe default.
HOSTED_MODELS = {"claude-haiku-4-5", "claude-sonnet-5", "claude-sonnet-4-6"}
HOSTED_DEFAULT = "claude-haiku-4-5"


def coerce(provider: str, model: str) -> tuple[str, str]:
    """
    The provider and model this machine may actually use.

    A config saved before the pivot can name OpenAI, DeepSeek or Gemini, and an
    ordinary account has no key for any of them — so the call would fail with
    "Missing env var" for a setting the user cannot even see any more. It is
    quietly moved onto what we serve instead.

    The admin account is left alone: choosing a different provider is the
    entire reason that account exists.
    """
    if is_admin():
        return provider, model
    if provider == HOSTED_PROVIDER and model in HOSTED_MODELS:
        return provider, model
    return HOSTED_PROVIDER, (model if model in HOSTED_MODELS else HOSTED_DEFAULT)


def readiness() -> dict:
    """
    Whether the AI can run at all, for the screens that gate on it.

    Replaces the provider-key check that used to answer this question. The
    question has changed: it is no longer "has the user pasted a key" but "is
    this machine signed in to something that can pay".
    """
    if is_admin():
        return {"ready": True, "mode": "keys", "message": ""}
    if access_token():
        return {"ready": True, "mode": "hosted", "message": ""}
    return {
        "ready": False,
        "mode": "signed-out",
        "message": "Sign in to use live sessions, debriefs and research.",
    }


#: Below this many credits the app says so before a call. One credit is thirty
#: minutes of live session (core/pricing.py, CREDITS_PER_SESSION), so this is
#: "less than half an hour left" — worth knowing before an interview, and not
#: often enough to nag. The service decides what may actually start; the real
#: floor there is far lower, which is exactly why it is useless as a warning.
LOW_CREDITS = 1.0


def credit_warning() -> Optional[dict]:
    """
    ``{"available": float, "low": bool, "at": int}``, or None when unknown.

    The **cached** balance, deliberately: ``account.status()`` reads the account
    file, while ``account.balance()`` is the one that goes to the network. This
    sits on the readiness check, which sits in front of every call, and readiness
    must not become slow — or start failing — because the service is slow.

    A warning and never a gate. The figure can be a minute old, and the relay
    decides what may start against the real ledger. Refusing a call on a stale
    local number, mid-interview, is the one failure this must not introduce.
    """
    try:
        status = account.status()
    except Exception:
        return None
    balance = status.get("balance")
    if not status.get("signed_in") or not isinstance(balance, dict):
        return None                     # never invent a number
    available = float(balance.get("available") or 0)
    return {"available": available, "low": available < LOW_CREDITS,
            "at": int(balance.get("at") or 0)}
