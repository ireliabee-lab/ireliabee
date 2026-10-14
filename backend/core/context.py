"""
Keeping a conversation's context from growing without limit.

A live coaching session sends the whole history on every turn, so an untrimmed
conversation costs **quadratically** in its own length: turn 20 pays for turns
1–19 all over again. A 60-minute call was costing far more than twice a
30-minute one, which is the wrong shape for a product that charges by the
session.

This module caps that. It keeps the most recent exchanges in full, drops the
oldest, and leaves a short marker where the dropped ones were so the model knows
context is missing rather than inventing continuity across the gap.

Trimming is deliberately not clever. A summarisation pass would preserve more,
but it costs a model call of its own on the hot path, and the thing being
optimised is exactly that cost.
"""
from __future__ import annotations

from typing import Iterable

#: Characters per token. English averages about 4; 3.6 deliberately
#: **over**-estimates, because erring that way trims sooner and spends less.
#: This is an estimate, not a tokenizer — it decides when to trim, never what
#: anyone is billed. `core/costs.py` records the real counts the providers report.
CHARS_PER_TOKEN = 3.6

#: How much history a turn may carry, before the system prompt and the new
#: message. Roughly 20–30 exchanges of ordinary speech.
DEFAULT_MAX_TOKENS = 3000

#: Never trim below this many messages, whatever the budget says. A coach that
#: has forgotten the last three things said is worse than an expensive one.
MIN_MESSAGES = 6

#: Left in place of what was dropped, so the model treats the gap as a gap.
ELISION = ("[Earlier in this conversation, {count} exchanges have been left out "
           "to keep this prompt short. Ask if you need something from them.]")


def estimate_tokens(text: str) -> int:
    """Approximate token count. Over-estimates on purpose; see CHARS_PER_TOKEN."""
    if not text:
        return 0
    return int(len(text) / CHARS_PER_TOKEN) + 1


def messages_tokens(messages: Iterable[dict]) -> int:
    """Approximate tokens for a list of chat messages, including role overhead."""
    total = 0
    for m in messages or []:
        content = m.get("content")
        if isinstance(content, str):
            total += estimate_tokens(content)
        elif isinstance(content, list):
            # Multi-part content (text + images); only text is countable here.
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    total += estimate_tokens(part["text"])
        total += 4        # role and framing overhead, per message
    return total


def trim_history(history: list[dict], *,
                 max_tokens: int = DEFAULT_MAX_TOKENS,
                 min_messages: int = MIN_MESSAGES) -> list[dict]:
    """
    Return the tail of `history` that fits in `max_tokens`.

    Drops from the oldest end, never from the middle or the recent end, because
    the last few exchanges are what the next answer depends on. Below
    `min_messages` nothing is dropped however long the messages are — a single
    enormous message should not be able to empty the conversation.

    The returned list is new; the caller's history is never modified, so the
    full record still gets saved to the session.
    """
    if not history:
        return []

    messages = list(history)
    if len(messages) <= min_messages or messages_tokens(messages) <= max_tokens:
        return messages

    # Walk backwards, keeping whole messages until the budget runs out.
    kept: list[dict] = []
    used = 0
    for message in reversed(messages):
        cost = messages_tokens([message])
        if kept and len(kept) >= min_messages and used + cost > max_tokens:
            break
        kept.append(message)
        used += cost
    kept.reverse()

    dropped = len(messages) - len(kept)
    if dropped <= 0:
        return kept

    # Say what is missing. A model told that a gap exists behaves better than
    # one left to guess why the conversation appears to start mid-sentence.
    marker = {"role": "user", "content": ELISION.format(count=dropped)}

    # A history that starts with an assistant turn reads as though the model
    # spoke unprompted; the marker also fixes that.
    return [marker] + kept


def trim_transcript(lines: list, *, max_lines: int = 40) -> list:
    """
    The tail of a live transcript.

    Same reasoning as `trim_history`, for the raw speech lines some prompts
    include alongside the conversation.
    """
    return list(lines or [])[-max_lines:]
