"""
Choosing a speech-to-text provider by what the moment actually needs.

After prompt caching, speech is about 83% of what a session costs, and the
providers are not close to each other:

    groq       $0.0002 / minute      (batch)
    openai     $0.0060 / minute      (batch)
    deepgram   $0.0077 / minute      (streaming)

Groq is roughly **38 times cheaper** than Deepgram. It cannot stream, so it
cannot drive the word-by-word text that appears while someone is still
speaking — but a great deal of what the app transcribes does not need that.

So the rule is: **buy streaming only where streaming is the product.**

* A live meeting is the paid moment. Latency and interim words are the feature;
  keep the good provider.
* Practice, warmups and mock interviews are rehearsal. A pause-then-transcribe
  round trip is fine, and costs a fortieth as much.

Nothing here overrides a provider the user has actually chosen when it is the
only one they have a key for. Routing picks between what is *available*.
"""
from __future__ import annotations

import os
from typing import Optional

from .transcribers import STT_PROVIDERS, local_available

#: USD per minute, cheapest first. Kept beside `costs.STT_PRICES`, which prices
#: what was actually used; this one decides what to use.
COST_PER_MINUTE = {
    "local": 0.0,          # runs on the user's machine, but is not bundled
    "groq": 0.0002,
    "openai": 0.0060,
    "deepgram": 0.0077,
}

#: Providers that can transcribe while someone is still speaking. Everything
#: else waits for a pause, which is what makes it cheap.
STREAMING = {"deepgram", "openai"}

#: Tasks where interim words are part of the product.
LIVE_TASKS = {"live"}


def available(provider: str) -> bool:
    """Whether this provider could actually run right now."""
    cfg = STT_PROVIDERS.get(provider)
    if cfg is None:
        return False
    if provider == "local":
        return local_available()
    env = cfg.get("env")
    return bool(env and os.environ.get(env))


def _model_for(provider: str, model: Optional[str]) -> str:
    """Keep the caller's model if it belongs to this provider; else its default."""
    cfg = STT_PROVIDERS.get(provider) or {}
    if model and model in (cfg.get("models") or {}):
        return model
    return cfg.get("default_model") or ""


def route(task: str, preferred: Optional[str] = None,
          model: Optional[str] = None) -> tuple[str, str, str]:
    """
    Pick a provider and model for `task`.

    Returns ``(provider, model, reason)``. The reason is for logging and for
    `/usage/costs` — a cost report that cannot explain why a provider was used
    is hard to act on.

    `local` is never chosen automatically: it is free but slow, is not in the
    packaged app, and silently swapping a cloud transcriber for a CPU-bound one
    would be felt as the app getting worse.
    """
    # An ordinary account transcribes through our relay, whatever this
    # machine's config or leftover keys say: which provider does the work is
    # the backoffice's Speech setting, on the server. Only the admin routes
    # here, on their own keys (audit 178-H4).
    from . import hosted
    if not hosted.is_admin():
        return "deepgram", "nova-3", "hosted: our relay transcribes; the backoffice chooses the provider"

    live = task in LIVE_TASKS

    # A live session keeps whatever the user chose, as long as it can stream.
    if live:
        if preferred and preferred in STREAMING and available(preferred):
            return preferred, _model_for(preferred, model), "live: keeping the chosen provider"
        for provider in sorted(STREAMING, key=lambda p: COST_PER_MINUTE.get(p, 99)):
            if available(provider):
                return provider, _model_for(provider, None), "live: cheapest that can stream"
        # Nothing streams. Fall through and take whatever works — a live session
        # with pause-gated transcription beats a live session with none.

    # Rehearsal, or no streaming provider available: cheapest that works.
    candidates = [p for p in COST_PER_MINUTE
                  if p != "local" and available(p)]
    if not candidates:
        # Keep the caller's choice so the error they get names the key they
        # need, rather than one they never picked.
        return (preferred or "deepgram"), _model_for(preferred or "deepgram", model), "nothing available"

    cheapest = min(candidates, key=lambda p: COST_PER_MINUTE[p])
    if preferred and preferred in candidates and COST_PER_MINUTE[preferred] <= COST_PER_MINUTE[cheapest]:
        return preferred, _model_for(preferred, model), "chosen provider is already cheapest"

    saving = COST_PER_MINUTE.get(preferred or "deepgram", 0) / max(COST_PER_MINUTE[cheapest], 1e-9)
    return cheapest, _model_for(cheapest, None), f"rehearsal: {saving:.0f}x cheaper than {preferred or 'default'}"
