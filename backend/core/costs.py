"""
What a session actually costs in AI.

Step 1 of the hosted pivot (``docs/hosted-pivot.md``): before a credit can be
priced, we have to know what one buys. Today the user pays the providers
directly and nobody measures anything, so every price would be a guess.

This records two things per call:

* **tokens** in and out, for model calls
* **seconds** of audio, for speech-to-text

and converts them to US dollars *only where a price is known*. An unpriced model
still records its tokens with `cost_usd` left NULL — a missing price must never
silently become a cost of zero, because a zero would quietly understate what a
session costs and that is the one number this module exists to get right.

Everything is local, in the same SQLite database as sessions, and is never
transmitted. It is instrumentation for us, not telemetry about the user.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from .sessions import _connect

#: USD per million tokens, (input, output).
#:
#: Model pricing changes often and silently, and a stale figure here turns into
#: a mispriced credit. A model that is absent is not free — it is unpriced, and
#: `cost_usd` stays NULL.
#:
#: **Anthropic prices read off the pricing page on 20 September 2026.** The
#: others have not been re-checked since they were written down and are only
#: reachable on the admin bring-your-own-key path, so nothing we sell is priced
#: from them; they are marked rather than trusted.
MODEL_PRICES: dict[str, tuple[float, float]] = {
    # Anthropic — verified 2026-09-20
    "claude-opus-5": (5.00, 25.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-sonnet-4-6": (3.00, 15.00),   # now a legacy model, and dearer than Sonnet 5
    "claude-haiku-4-5": (1.00, 5.00),
    # Groq — the fast tier's live cues since 2026-09-21. UNVERIFIED; mirrors
    # website/functions/_shared/limits.js, which the charge actually uses.
    "openai/gpt-oss-120b": (0.15, 0.75),
    "openai/gpt-oss-20b": (0.10, 0.50),
    # OpenAI — UNVERIFIED
    "gpt-5-mini": (0.25, 2.00),
    # DeepSeek — UNVERIFIED
    "deepseek-chat": (0.27, 1.10),
    # Google — UNVERIFIED
    "gemini-2.5-flash": (0.30, 2.50),
}

#: USD per minute of audio.
#:
#: `deepgram-agent` is the Voice Agent API used by the voice mock interview: it
#: bundles speech-to-text, a model and text-to-speech into one per-minute
#: charge, so it is an order of magnitude dearer than transcription alone. It
#: was a flagged placeholder at 0.0800; the real figure is 0.075, so the guess
#: was honest in the safe direction.
#:
#: Deepgram is quoting a promotional 0.0048/min on Nova-3 streaming. We price
#: from the **regular** 0.0077 on purpose: a promotion that ends would
#: otherwise turn into a margin that quietly disappears.
STT_PRICES: dict[str, float] = {
    "deepgram": 0.0077,          # Nova-3 streaming, regular rate — verified 2026-09-20
    "deepgram-agent": 0.0750,    # Voice Agent API, standard — verified 2026-09-20
    "groq": 0.0002,              # whisper-large-v3-turbo — UNVERIFIED, likely understated
    "openai": 0.0060,            # whisper-1, batch — UNVERIFIED
    "local": 0.0,                # the user's own CPU
}


def _ensure_schema():
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS ai_costs (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                at          TEXT NOT NULL,
                session_id  INTEGER,
                kind        TEXT NOT NULL,      -- coach | mock | debrief | notes | stt | ...
                provider    TEXT NOT NULL,
                model       TEXT NOT NULL,
                in_tokens   INTEGER DEFAULT 0,
                out_tokens  INTEGER DEFAULT 0,
                seconds     REAL DEFAULT 0,
                cost_usd    REAL                -- NULL when the price is unknown
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_ai_costs_session ON ai_costs(session_id)")
        # Cache columns were added after the table shipped; existing installs
        # get them here rather than through a migration framework.
        existing = {r[1] for r in conn.execute("PRAGMA table_info(ai_costs)")}
        for column in ("cache_read_tokens", "cache_write_tokens"):
            if column not in existing:
                conn.execute(f"ALTER TABLE ai_costs ADD COLUMN {column} INTEGER DEFAULT 0")


_ensure_schema()


#: What a cached input token costs, as a fraction of a normal one. Anthropic
#: charges about a tenth to read an entry and a quarter extra to create it;
#: OpenAI and DeepSeek discount reads and never charge for the write.
CACHE_READ_MULTIPLIER = 0.10
CACHE_WRITE_MULTIPLIER = 1.25


def token_cost(model: str, in_tokens: int, out_tokens: int,
               cache_read: int = 0, cache_write: int = 0) -> Optional[float]:
    """
    Dollars for a model call, or None if we have no price for that model.

    `in_tokens` is the uncached remainder: providers report cached tokens
    separately, and counting them twice would erase the saving on paper while
    leaving it real. Cached reads are charged at a fraction, writes at a small
    premium.
    """
    price = MODEL_PRICES.get(model)
    if not price:
        return None
    dollars = (
        in_tokens * price[0]
        + out_tokens * price[1]
        + cache_read * price[0] * CACHE_READ_MULTIPLIER
        + cache_write * price[0] * CACHE_WRITE_MULTIPLIER
    )
    return dollars / 1_000_000


def audio_cost(provider: str, seconds: float) -> Optional[float]:
    price = STT_PRICES.get(provider)
    if price is None:
        return None
    return (seconds / 60.0) * price


def record(kind: str, provider: str, model: str, *,
           in_tokens: int = 0, out_tokens: int = 0, seconds: float = 0,
           cache_read: int = 0, cache_write: int = 0,
           session_id: Optional[int] = None) -> None:
    """
    Record one billable call. Never raises.

    Measurement must not be able to break the thing it measures: if this fails,
    the user's session carries on and we lose one row.
    """
    try:
        cost = (audio_cost(provider, seconds) if seconds
                else token_cost(model, in_tokens, out_tokens, cache_read, cache_write))
        with _connect() as conn:
            conn.execute(
                "INSERT INTO ai_costs (at, session_id, kind, provider, model, "
                "in_tokens, out_tokens, seconds, cost_usd, cache_read_tokens, "
                "cache_write_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (datetime.utcnow().isoformat(timespec="seconds"), session_id, kind,
                 provider, model, int(in_tokens), int(out_tokens), float(seconds), cost,
                 int(cache_read), int(cache_write)),
            )
    except Exception:
        pass


# -- Reading the numbers back ------------------------------------------------

def _row(r) -> dict:
    return {
        "kind": r["kind"], "provider": r["provider"], "model": r["model"],
        "calls": r["calls"], "in_tokens": r["in_tokens"] or 0,
        "out_tokens": r["out_tokens"] or 0, "seconds": round(r["seconds"] or 0, 1),
        "cache_read_tokens": r["cache_read"] or 0,
        "cache_write_tokens": r["cache_write"] or 0,
        "cost_usd": round(r["cost_usd"], 4) if r["cost_usd"] is not None else None,
        "unpriced_calls": r["unpriced"],
    }


def summary(days: int = 90) -> dict:
    """
    Totals by kind and model, plus a per-session average.

    `unpriced_calls` is the number this module could not cost. If it is not
    zero, the totals are a floor rather than the answer, and `MODEL_PRICES`
    needs the missing entry.
    """
    with _connect() as conn:
        rows = conn.execute(
            "SELECT kind, provider, model, COUNT(*) AS calls, "
            "SUM(in_tokens) AS in_tokens, SUM(out_tokens) AS out_tokens, "
            "SUM(seconds) AS seconds, SUM(cache_read_tokens) AS cache_read, "
            "SUM(cache_write_tokens) AS cache_write, SUM(cost_usd) AS cost_usd, "
            "SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced "
            "FROM ai_costs WHERE at >= datetime('now', ?) "
            "GROUP BY kind, provider, model ORDER BY cost_usd DESC NULLS LAST",
            (f"-{max(1, days)} days",),
        ).fetchall()

        totals = conn.execute(
            "SELECT COUNT(*) AS calls, SUM(cost_usd) AS cost_usd, "
            "SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced, "
            "COUNT(DISTINCT session_id) AS sessions "
            "FROM ai_costs WHERE at >= datetime('now', ?)",
            (f"-{max(1, days)} days",),
        ).fetchone()

    sessions = totals["sessions"] or 0
    cost = totals["cost_usd"] or 0.0
    return {
        "days": days,
        "calls": totals["calls"] or 0,
        "sessions": sessions,
        "cost_usd": round(cost, 4),
        "cost_per_session_usd": round(cost / sessions, 4) if sessions else None,
        "unpriced_calls": totals["unpriced"] or 0,
        "by_model": [_row(r) for r in rows],
    }


def for_session(session_id: int) -> dict:
    """Everything one session cost — the number a credit has to cover."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT kind, provider, model, COUNT(*) AS calls, "
            "SUM(in_tokens) AS in_tokens, SUM(out_tokens) AS out_tokens, "
            "SUM(seconds) AS seconds, SUM(cache_read_tokens) AS cache_read, "
            "SUM(cache_write_tokens) AS cache_write, SUM(cost_usd) AS cost_usd, "
            "SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced "
            "FROM ai_costs WHERE session_id = ? GROUP BY kind, provider, model",
            (int(session_id),),
        ).fetchall()
    items = [_row(r) for r in rows]
    priced = [i["cost_usd"] for i in items if i["cost_usd"] is not None]
    return {
        "session_id": session_id,
        "cost_usd": round(sum(priced), 4),
        "unpriced_calls": sum(i["unpriced_calls"] for i in items),
        "items": items,
    }
