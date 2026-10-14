"""
Local usage counts: how often each screen is opened and key actions happen,
per day. Used to decide which screens to merge or drop (docs/ROADMAP.md,
Phase 0). Stored only in the local database — never exported by Transfer and
never sent anywhere.
"""
from __future__ import annotations

import re
from datetime import date, timedelta

from .core.sessions import _connect

# "view:plans", "session.listen", "practice.start"… — short, lowercase, no free text.
EVENT_RE = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,63}$")


def _ensure_schema():
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS usage_counts (
                event  TEXT NOT NULL,
                day    TEXT NOT NULL,
                count  INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (event, day)
            )
        """)


_ensure_schema()


def valid_event(name: str) -> bool:
    return bool(EVENT_RE.match(name or ""))


def record(event: str, day: date | None = None) -> None:
    """Count one occurrence of `event` today. Invalid names are ignored."""
    if not valid_event(event):
        return
    d = (day or date.today()).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO usage_counts (event, day, count) VALUES (?, ?, 1) "
            "ON CONFLICT(event, day) DO UPDATE SET count = count + 1",
            (event, d),
        )


def summary(days: int = 90) -> dict:
    """Totals per event over the last `days` days, most used first."""
    since = (date.today() - timedelta(days=max(1, days) - 1)).isoformat()
    with _connect() as conn:
        rows = conn.execute(
            "SELECT event, SUM(count) AS total, COUNT(*) AS active_days, MAX(day) AS last_day "
            "FROM usage_counts WHERE day >= ? GROUP BY event ORDER BY total DESC, event",
            (since,),
        ).fetchall()
    return {
        "since": since,
        "events": [
            {"event": r["event"], "total": r["total"], "active_days": r["active_days"], "last_day": r["last_day"]}
            for r in rows
        ],
    }
