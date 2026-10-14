"""
Prompt caching: stop paying full price for the same system prompt every turn.

A coaching session's system prompt carries the template, the persona, the
user's stories, their CV and any reference files — several thousand tokens —
and it is byte-identical on every turn of that session. Sent uncached, a
fifteen-turn call pays for it fifteen times.

Providers cache it differently:

* **Anthropic** needs an explicit `cache_control` marker. Cache reads cost about
  a tenth of normal input; the write that creates the entry costs about a
  quarter more than normal. Entries live ~5 minutes, refreshed on each hit,
  which covers the gaps between turns in a live call.
* **OpenAI, DeepSeek and Gemini** cache automatically, but only on an identical
  *leading* prefix. Nothing to send — the requirement is that the static part
  comes first and never varies. See `stable_prefix_note` below.

The one rule that makes all of it work: **put what does not change at the
front, and do not let anything volatile in.** A timestamp, a random id or a
re-ordered block at the start of a prompt silently costs a cache and nobody
notices, because the only symptom is a larger bill.
"""
from __future__ import annotations

#: Anthropic's own minimums, below which a marked prompt is simply not cached
#: (verified against the prompt-caching docs, 2026-09-21). For reference and
#: tests only: nothing here decides by them. A marker below the minimum costs
#: nothing — no entry is written, so no write premium is charged — and the
#: model that actually answers is chosen by our server per tier, not here. An
#: earlier threshold of 2048 "for Haiku" was wrong twice over: Haiku 4.5 needs
#: 4096, and skipping the marker saved nothing while blocking every Sonnet
#: prompt between 1024 and 2048 tokens.
MIN_CACHEABLE_TOKENS = {
    "claude-haiku-4-5": 4096,
    "claude-sonnet-5": 1024,
    "claude-sonnet-4-6": 1024,
    "claude-sonnet-4-5": 1024,
    "claude-opus-5": 512,
    "claude-fable-5-1": 512,
}

_EPHEMERAL = {"type": "ephemeral"}


def anthropic_system(system_prompt: str):
    """
    The `system=` argument for an Anthropic call, marked for caching.

    Always marked: Anthropic caches it once it reaches the model's minimum and
    ignores the marker, at no charge, when it does not. The system prompt is
    the part of a session that never changes, so every later call inside five
    minutes reads it at a tenth of the input price.
    """
    if not system_prompt:
        return system_prompt
    return [{"type": "text", "text": system_prompt, "cache_control": _EPHEMERAL}]


def conversation_cache() -> dict:
    """
    Extra request fields that cache the whole conversation, history and all.

    Anthropic's request-level ``cache_control`` puts a breakpoint after the
    last block, so the next turn — the same conversation plus one exchange —
    reads everything before it from cache. Only for multi-turn calls (the live
    coach): on a one-off call the entry would be written, at a quarter over
    the input price, and never read.
    """
    return {"extra_body": {"cache_control": _EPHEMERAL}}


def cache_stats(usage) -> tuple[int, int]:
    """
    ``(cache_read_tokens, cache_write_tokens)`` from a provider's usage object.

    Anthropic reports both explicitly. OpenAI reports reads under
    `prompt_tokens_details.cached_tokens` and never charges a write. Anything
    else reports neither, and zero is the truthful answer.

    These matter for more than curiosity: priced at full rate, a cached call
    would look as expensive as an uncached one and the saving would be
    invisible in `/usage/costs`.
    """
    if usage is None:
        return 0, 0

    read = getattr(usage, "cache_read_input_tokens", None)
    write = getattr(usage, "cache_creation_input_tokens", None)
    if read is not None or write is not None:
        return int(read or 0), int(write or 0)

    details = getattr(usage, "prompt_tokens_details", None)
    if details is not None:
        cached = getattr(details, "cached_tokens", None)
        if cached is None and isinstance(details, dict):
            cached = details.get("cached_tokens")
        if cached:
            return int(cached), 0

    return 0, 0


stable_prefix_note = """
Keep the static part of a prompt first and byte-identical.

Every provider's automatic caching matches on a leading prefix, so anything
that varies between turns — a clock, a counter, a shuffled list — invalidates
the whole entry from that point on. The failure is silent: the answers stay
correct and only the bill changes, which is why this is written down rather
than left to be remembered.
""".strip()
