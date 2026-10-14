"""
User-facing errors for AI provider and Deepgram failures.

Provider SDKs raise very different exceptions for the same problem (missing
key, bad key, no credits, rate limit…). classify() maps them onto a small set
of codes with plain-language messages the UI can show as-is.
"""
from __future__ import annotations

import os
import re
from typing import Optional

from fastapi import HTTPException

from .core.config import load_config
from .core.providers import PROVIDERS

LABELS = {
    "anthropic": "Anthropic (Claude)", "openai": "OpenAI", "deepseek": "DeepSeek",
    "gemini": "Google Gemini", "groq": "Groq", "deepgram": "Deepgram", "local": "Local Whisper",
}

HTTP_STATUS = {
    "no_model": 400, "missing_key": 400, "invalid_key": 401, "out_of_credits": 402,
    "signed_out": 401, "account_suspended": 403, "daily_limit": 429, "service_unavailable": 503,
    "rate_limited": 429, "model_unavailable": 400, "network": 503, "unknown": 502,
    "invalid": 400, "unreadable": 400,
    "mic_lost": 503, "system_lost": 503, "audio_unsupported": 503, "mic_silent": 503,
    # Relay (MCP assistant)
    "relay_not_listening": 503, "relay_timeout": 504,
    # Calendar (roadmap 3.2)
    "auth": 400, "config": 400, "not_found": 404,
}


class FriendlyError(Exception):
    def __init__(self, code: str, title: str, message: str, action: Optional[str] = None):
        super().__init__(f"{title}. {message}")
        self.code, self.title, self.message, self.action = code, title, message, action

    def as_dict(self) -> dict:
        return {"code": self.code, "title": self.title, "message": self.message, "action": self.action}

    def http(self) -> HTTPException:
        return HTTPException(HTTP_STATUS.get(self.code, 502), detail=self.as_dict())


def label(service: str) -> str:
    return LABELS.get(service, service.capitalize() if service else "The AI provider")


def missing_key(service: str) -> FriendlyError:
    where = "Speech-to-Text" if service in ("deepgram", "groq") else "Language Model"
    return FriendlyError(
        "missing_key", f"{label(service)} API key missing",
        f"Add your {label(service)} key in Settings → {where} to use this feature.", "settings",
    )


def mic_lost(exc: Optional[BaseException] = None) -> FriendlyError:
    """
    A microphone that would not open, or that went away mid-call.

    PortAudio’s own words — "Error opening InputStream: Invalid device
    [PaErrorCode -9996]" — are true and useless to the person reading them. What
    happened is almost always that a headset connected or disconnected, which on
    Bluetooth happens without anyone touching anything. The raw text belongs in
    the log, where it is worth having; the toast gets the sentence that says
    what to do about it.
    """
    return FriendlyError(
        "mic_lost", "Can’t open the microphone",
        "The microphone changed, or another app is holding it — connecting a headset "
        "does this on its own. Choose one under Sound, then start listening again.",
    )


def system_lost(exc: Optional[BaseException] = None) -> FriendlyError:
    """The output the call plays through would not open, or went away. See `mic_lost`."""
    return FriendlyError(
        "system_lost", "Can’t hear the call",
        "The output the call plays through changed — connecting a headset does this on "
        "its own. Choose an output under Sound, or move the call back to your speakers, "
        "then start listening again.",
    )


def audio_unsupported(message: str) -> FriendlyError:
    """
    This computer cannot record what it is playing at all — a missing tool, or
    an operating system with no route to it. Not a device that went away, so it
    is worth telling apart: nothing the user picks under Sound will help.
    """
    return FriendlyError("audio_unsupported", "Can’t record this computer’s sound", message)


def mic_silent() -> FriendlyError:
    """Not a quiet room: an input delivering exact zeros, which means the wrong device."""
    return FriendlyError(
        "mic_silent", "The microphone is completely silent",
        "Not quiet — silent, which usually means the wrong device is open. Choose a "
        "microphone under Sound and start listening again.",
    )


def resolve_llm(model: Optional[str], *, fallback_credits: bool = False) -> tuple[str, str]:
    """Return (model, provider) for a coach/feedback call, or raise a FriendlyError."""
    from . import relay
    from .core.providers import is_fallback_credits
    fallback = fallback_credits or is_fallback_credits()
    if relay.is_enabled() and not fallback:
        return (model or "").strip() or "assistant", "assistant_relay"

    from .routers.coach import _provider_for

    from .core import hosted

    raw_model = (model or "").strip()
    if raw_model == "assistant" or not raw_model:
        model = (load_config().get("model") or "").strip()
    else:
        model = raw_model
    # An ordinary account has no model picker (Settings shows it only to the
    # admin), so "nothing chosen" is its normal state, not a mistake: the
    # server decides which model answers. Only the admin must choose.
    if not model and not hosted.is_admin():
        model = hosted.HOSTED_DEFAULT
    if not model:
        raise FriendlyError(
            "no_model", "No AI model selected",
            "Choose a language model and add its API key in Settings before starting.", "settings",
        )
    provider = _provider_for(model)

    # Whose AI this is decides what "ready" means (core/hosted.py). An
    # ordinary account never holds a provider key — asking it for one sends
    # the user to a Settings field they cannot see — so it needs to be signed
    # in, and its saved choice is moved onto a model our service serves. Only
    # the admin account runs on keys from this machine.
    provider, model = hosted.coerce(provider, model)
    if not hosted.is_admin():
        if not hosted.access_token():
            raise FriendlyError(
                "signed_out", "Sign in to use the coach",
                "iReliabee supplies the AI once you're signed in. Open Settings and choose Your account.",
                "settings",
            )
        return model, provider

    env = PROVIDERS.get(provider, {}).get("env")
    if env and not os.environ.get(env):
        raise missing_key(provider)
    return model, provider


def out_of_credits() -> FriendlyError:
    """An ordinary account has nothing left to spend."""
    return FriendlyError(
        "out_of_credits", "You're out of credits",
        "Buy a credit pack in Settings → Your account to keep going. Nothing you said was lost.",
        "settings",
    )


def account_suspended() -> FriendlyError:
    """
    An ordinary account an admin has blocked in the backoffice.

    No Settings button: signing in again is refused too, so sending them there
    starts a loop that never explains itself. Writing to us is the way out.
    One wording, whether the news came as an HTTP 403, a refused speech socket
    or a call our relay ended part-way through.
    """
    return FriendlyError(
        "account_suspended", "This account can't use the AI right now",
        "It has been suspended. Email support@ireliabee.co.uk and we'll sort it out.",
    )


#: The close codes our relay ends a live call or a voice mock with
#: (website/server/billing.js). 4000–4999 are the application's own to define.
OUT_OF_CREDITS_CLOSE = 4402
SUSPENDED_CLOSE = 4403


def relay_closed(closed: BaseException) -> Optional[FriendlyError]:
    """
    What our relay meant by closing a speech socket, or None for an ordinary close.

    The live call and the voice mock both read closes through here, so the two
    cannot drift apart the way they had — one checked a named constant, the
    other a bare 4402. The code is the one the relay sent (`rcvd`), not the one
    this end echoed back.
    """
    code = getattr(getattr(closed, "rcvd", None), "code", None)
    if code == OUT_OF_CREDITS_CLOSE:
        return out_of_credits()
    if code == SUSPENDED_CLOSE:
        return account_suspended()
    return None


def require_deepgram() -> str:
    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        raise missing_key("deepgram")
    return key


def _status(exc: BaseException) -> Optional[int]:
    for candidate in (
        getattr(exc, "status_code", None),
        getattr(getattr(exc, "response", None), "status_code", None),
        getattr(exc, "code", None),
    ):
        if isinstance(candidate, int):
            return candidate
    # websockets reports rejected handshakes only in the text: "... HTTP 402"
    m = re.search(r"\bhttp (\d{3})\b", str(exc).lower())
    return int(m.group(1)) if m else None


_NETWORK = (
    "connecterror", "connectionerror", "failed to establish a new connection", "connection refused",
    "connection reset", "connection aborted", "timed out", "timeout", "name or service not known",
    "temporary failure in name resolution", "network is unreachable", "getaddrinfo",
)


def classify(exc: BaseException, service: str) -> FriendlyError:
    if isinstance(exc, FriendlyError):
        return exc
    text = f"{type(exc).__name__} {exc}".lower()
    status = _status(exc)

    # An ordinary account never deals with a provider: the admin chooses which
    # one serves it, and can change that at any moment. So its errors name
    # iReliabee's service, never "Anthropic" or "Deepgram", and never send it
    # to provider settings it cannot see.
    from .core import hosted
    hosted_user = not hosted.is_admin()
    speech = service in ("deepgram", "groq", "openai-stt", "local")
    name = ("Speech recognition" if speech else "iReliabee's AI") if hosted_user else label(service)

    def has(*words):
        return any(w in text for w in words)

    # An ordinary account reaches every provider through our service, so a
    # refusal is about *their iReliabee account*, not a provider key they
    # never had. Decided here, before any key wording can be reached: telling
    # them to "paste a fresh key" sends them to a field they cannot see
    # (audit 180-H4).
    if hosted_user:
        if status == 402 or has("insufficient_credits", "out of credits"):
            return out_of_credits()
        if status == 401 or has("invalid api key", "unauthorized", "authentication"):
            # A 401 just after a refresh that never reached us is a token that
            # aged out while the network was gone. Their sign-in is fine, and
            # sending them to Settings mid-interview fixes nothing — it is the
            # kind of thing that has them hunting for a problem that is already
            # over. Same code, so the screen still stops listening (audit
            # 178-H1); different words, and no Settings button.
            from .core import account as account_core
            # A 401 after a renewal the service refused as "suspended" is that
            # suspension arriving late, through the expired token it left.
            if account_core.refresh_suspended():
                return account_suspended()
            if account_core.refresh_unreachable():
                return FriendlyError(
                    "signed_out", "Can't reach iReliabee",
                    "Your sign-in couldn't be renewed because the connection dropped. "
                    "Check your internet connection and start listening again.",
                )
            return FriendlyError(
                "signed_out", "Please sign in again",
                "Your sign-in has expired. Open Settings and choose Your account.", "settings",
            )
        if status == 403 or has("suspended"):
            return account_suspended()
        if status == 429 and has("today's usage limit", "usage limit", "resets in 24 hours"):
            return FriendlyError(
                "daily_limit", "You've reached today's limit",
                "It resets within 24 hours. Email support@ireliabee.co.uk if you need more today.",
            )
        if status == 429 or has("rate limit", "too many requests", "a lot of requests"):
            return FriendlyError(
                "rate_limited", f"{name} is busy right now",
                "Wait a moment and try again.",
            )
        if status == 503 or has("missing env var", "could not resolve authentication", "api key not set",
                                "api_key not set", "no api key", "not available right now"):
            return FriendlyError(
                "service_unavailable", f"{name} isn't available right now",
                "Please try again in a moment.",
            )
        if has(*_NETWORK):
            return FriendlyError(
                "network", f"Can't reach {name}",
                "Check your internet connection and try again.",
            )
        # Everything else, in words that name no provider and no key: the
        # branches below are written for the admin, and a status-less
        # "permission denied" or "credit balance" used to reach them (audit
        # 182-M4). Nor the raw exception text, which can name either.
        return FriendlyError(
            "unknown", f"{name} couldn't answer that",
            "Please try again in a moment.",
        )

    if has("missing env var", "could not resolve authentication", "api key not set", "api_key not set", "no api key"):
        return missing_key(service)

    # Credits before rate limits: OpenAI reports an empty balance as HTTP 429.
    if status == 402 or has("credit balance", "insufficient_quota", "insufficient balance", "exceeded your current quota",
                            "billing", "payment required", "insufficient credits", "out of credits"):
        return FriendlyError(
            "out_of_credits", f"{name} account is out of credits",
            f"Top up your {name} balance, or switch to another provider in Settings.", "settings",
        )
    if status in (401, 403) or has("invalid api key", "incorrect api key", "api key not valid", "invalid_auth",
                                   "invalid credentials", "authentication", "unauthorized", "permission denied"):
        return FriendlyError(
            "invalid_key", f"{name} rejected the API key",
            "The key may be mistyped, revoked or expired. Paste a fresh key in Settings.", "settings",
        )
    if status == 429 or has("rate limit", "resource_exhausted", "too many requests", "overloaded"):
        return FriendlyError(
            "rate_limited", f"{name} is busy right now",
            "Too many requests or a temporary quota limit. Wait a moment and try again.",
        )
    if status == 404 or (has("model") and has("not found", "does not exist", "not supported", "unknown model")):
        if hosted_user:
            return FriendlyError(
                "model_unavailable", f"{name} couldn't answer that",
                "Please try again in a moment.",
            )
        return FriendlyError(
            "model_unavailable", f"{name} can't use this model",
            "Pick a different model in Settings.", "settings",
        )
    if has(*_NETWORK):
        return FriendlyError(
            "network", f"Can't reach {name}",
            "Check your internet connection and try again.",
        )
    detail = str(exc).strip().splitlines()[0][:160] if str(exc).strip() else type(exc).__name__
    return FriendlyError("unknown", f"{name} request failed", detail)



def relay_not_listening() -> FriendlyError:
    return FriendlyError(
        "relay_not_listening", "Your assistant isn't listening",
        "Say start iReliabee in your assistant, or use credits instead.", "credits_fallback",
    )


def relay_timeout(seconds: float = 60.0) -> FriendlyError:
    s = int(round(seconds))
    took = f"{s // 60} minutes" if s >= 120 else f"{s} seconds"
    return FriendlyError(
        "relay_timeout", "Your assistant didn't answer",
        f"It took longer than {took}. Try again, or use credits instead.", "credits_fallback",
    )
