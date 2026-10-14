"""
Milestones and activity, shared by the Research track and Wordcraft.

A track hands over the milestones its learner has reached so far (first lesson,
a new level, a seven-day streak …). The first time one shows up it is saved as
earned and waits, unseen, until the app has celebrated it. An install that
already had progress when this arrived gets its past milestones filed as seen,
so nobody opens the app to a pile of old confetti.

Activity is the day-by-day record behind the calendar and the charts: what was
planned and done each day, lessons finished, and the streaks.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from typing import Callable, Iterable, Optional

from .core import sessions as sess

INIT = "_init"          # marker row: this track's milestones have been looked at before

STREAKS = (3, 7, 14, 30, 60, 100, 200, 365)
DAY_COUNTS = (1, 10, 25, 50, 100, 200)
LESSON_COUNTS = (1, 5, 10, 25, 50)


def _ensure_schema() -> None:
    with sess._connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS track_milestones (
                track     TEXT NOT NULL,                  -- research | wordcraft
                key       TEXT NOT NULL,                  -- e.g. streak:7, level:2
                kind      TEXT NOT NULL DEFAULT '',       -- lesson | level | streak | days | cards | skill
                title     TEXT NOT NULL DEFAULT '',
                body      TEXT NOT NULL DEFAULT '',
                big       INTEGER NOT NULL DEFAULT 0,     -- a full-screen moment, not a small badge
                earned_at TEXT NOT NULL,
                seen_at   TEXT,
                PRIMARY KEY (track, key)
            );
            """
        )


_ensure_schema()


def _iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def _now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def local_day(stamp: Optional[str]) -> Optional[str]:
    """A stored UTC timestamp as the learner's local date."""
    if not stamp:
        return None
    try:
        d = datetime.fromisoformat(stamp)
    except ValueError:
        return stamp[:10]
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone().date().isoformat()


# ── Milestones ───────────────────────────────────────────────────────────────

def milestone(key: str, kind: str, title: str, body: str = "", big: bool = False) -> dict:
    return {"key": key, "kind": kind, "title": title, "body": body, "big": big}


def counted(prefix: str, kind: str, n: int, steps: Iterable[int], title: Callable[[int], str],
            body: Callable[[int], str] = lambda _n: "", big_from: Optional[int] = None) -> list[dict]:
    """One milestone for each threshold in `steps` that `n` has reached."""
    return [milestone(f"{prefix}:{s}", kind, title(s), body(s), big=big_from is not None and s >= big_from)
            for s in steps if n >= s]


def streak_milestones(best: int) -> list[dict]:
    return counted("streak", "streak", best, STREAKS, lambda s: f"{s}-day streak",
                   lambda s: f"{s} days in a row. Habits like this are how people get good.", big_from=7)


def day_milestones(days: int) -> list[dict]:
    return counted("days", "days", days, DAY_COUNTS,
                   lambda s: "First full day" if s == 1 else f"{s} days finished",
                   lambda s: "You did every step of a day's session." if s == 1 else
                   f"You have finished {s} daily sessions.", big_from=50)


def pending(track: str, earned: list[dict]) -> list[dict]:
    """Save newly earned milestones; return the ones not yet celebrated, oldest first."""
    now = _iso(_now())
    with sess._connect() as conn:
        first_look = not conn.execute("SELECT 1 FROM track_milestones WHERE track = ? AND key = ?",
                                      (track, INIT)).fetchone()
        if first_look:
            conn.execute("INSERT OR IGNORE INTO track_milestones (track, key, earned_at, seen_at) VALUES (?,?,?,?)",
                         (track, INIT, now, now))
        for m in earned:
            conn.execute(
                "INSERT OR IGNORE INTO track_milestones (track, key, kind, title, body, big, earned_at, seen_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (track, m["key"], m["kind"], m["title"], m["body"], 1 if m["big"] else 0, now,
                 now if first_look else None))
        rows = conn.execute("SELECT * FROM track_milestones WHERE track = ? AND seen_at IS NULL AND key != ? "
                            "ORDER BY earned_at, rowid", (track, INIT)).fetchall()
    return [_row(r) for r in rows]


def mark_seen(track: str, keys: list[str]) -> dict:
    now = _iso(_now())
    with sess._connect() as conn:
        for k in keys[:50]:
            conn.execute("UPDATE track_milestones SET seen_at = ? WHERE track = ? AND key = ? AND seen_at IS NULL",
                         (now, track, str(k)))
    return {"ok": True}


def earned(track: str) -> list[dict]:
    """Every milestone reached, newest first: the trophy shelf."""
    with sess._connect() as conn:
        rows = conn.execute("SELECT * FROM track_milestones WHERE track = ? AND key != ? "
                            "ORDER BY earned_at DESC, rowid DESC", (track, INIT)).fetchall()
    return [_row(r) for r in rows]


def _row(r) -> dict:
    return {"key": r["key"], "kind": r["kind"], "title": r["title"], "body": r["body"], "big": bool(r["big"]),
            "earned_at": r["earned_at"], "seen": r["seen_at"] is not None}


# ── Activity ─────────────────────────────────────────────────────────────────

def _runs(days: set[str]) -> tuple[int, int]:
    """(best run, run ending today or yesterday) of consecutive dates."""
    if not days:
        return 0, 0
    ordered = sorted(date.fromisoformat(d) for d in days)
    best = run = 1
    for a, b in zip(ordered, ordered[1:]):
        run = run + 1 if (b - a).days == 1 else 1
        best = max(best, run)
    return best, run


def activity(days_table: str, lesson_stamps: list[str], current_streak: int,
             local: Optional[datetime] = None, span: int = 182) -> dict:
    """The day-by-day record for the calendar and charts, over the last `span` days.

    days_table is research_days or wc_days: one row per day a session was opened.
    lesson_stamps are the UTC times lessons were finished.
    """
    today = (local or datetime.now()).date()
    start = today - timedelta(days=span - 1)
    with sess._connect() as conn:
        rows = conn.execute(f"SELECT day, steps_json, done_json, completed_at FROM {days_table}").fetchall()
    per_day: dict[str, dict] = {}
    completed: set[str] = set()
    for r in rows:
        steps, done = json.loads(r["steps_json"]), json.loads(r["done_json"])
        if r["completed_at"]:
            completed.add(r["day"])
        if r["day"] >= start.isoformat():
            per_day[r["day"]] = {"day": r["day"], "planned": len(steps), "done": len(done),
                                 "complete": bool(r["completed_at"]), "lessons": 0}
    lessons_by_day: dict[str, int] = {}
    for s in lesson_stamps:
        d = local_day(s)
        if d:
            lessons_by_day[d] = lessons_by_day.get(d, 0) + 1
    for d, n in lessons_by_day.items():
        if d >= start.isoformat():
            per_day.setdefault(d, {"day": d, "planned": 0, "done": 0, "complete": False, "lessons": 0})["lessons"] = n
    best, _ = _runs(completed)
    # Lessons finished per week (weeks start Monday), oldest first, the last 12 weeks.
    monday = today - timedelta(days=today.weekday())
    weeks = []
    for i in range(11, -1, -1):
        w0 = monday - timedelta(weeks=i)
        w1 = w0 + timedelta(days=7)
        weeks.append({"week": w0.isoformat(),
                      "lessons": sum(n for d, n in lessons_by_day.items() if w0.isoformat() <= d < w1.isoformat()),
                      "days": sum(1 for d in completed if w0.isoformat() <= d < w1.isoformat())})
    # Lessons done so far, by date: the climb.
    running, climb = 0, []
    for d in sorted(lessons_by_day):
        running += lessons_by_day[d]
        climb.append({"day": d, "total": running})
    return {"today": today.isoformat(), "start": start.isoformat(),
            "days": sorted(per_day.values(), key=lambda x: x["day"]),
            "weeks": weeks, "climb": climb,
            "streak": current_streak, "best_streak": max(best, current_streak),
            "days_finished": len(completed), "lessons_finished": len(lesson_stamps)}


def day_detail(days_table: str, day: str, lesson_title: Callable[[str], Optional[dict]],
               labels: dict[str, str], lessons: dict[str, dict], rounds: list[dict], round_names: dict[str, str]) -> dict:
    """What happened on one day: the session's steps (a lesson's parts folded into one line),
    lessons finished that day and practice rounds, each with what the app needs to open it."""
    try:
        date.fromisoformat(day)
    except ValueError:
        return {"day": day, "planned": False, "complete": False, "steps": [], "lessons": [], "rounds": []}
    with sess._connect() as conn:
        row = conn.execute(f"SELECT steps_json, done_json, completed_at FROM {days_table} WHERE day = ?", (day,)).fetchone()
    steps: list[dict] = []
    if row:
        planned, done = json.loads(row["steps_json"]), set(json.loads(row["done_json"]))
        seen: dict[str, dict] = {}
        for sid in planned:
            if sid.startswith("lesson:"):
                _, lid, _part = sid.split(":")
                if lid not in seen:
                    info = lesson_title(lid) or {}
                    seen[lid] = {"kind": "lesson", "id": lid, "label": info.get("title") or lid, "done": 0, "total": 0}
                    steps.append(seen[lid])
                seen[lid]["total"] += 1
                seen[lid]["done"] += 1 if sid in done else 0
            else:
                head = sid.split(":", 1)[0]
                label = labels.get(sid) or labels.get(head) or sid
                steps.append({"kind": head, "id": sid, "label": label, "done": 1 if sid in done else 0, "total": 1})
    finished = [{"id": lid, "title": (lesson_title(lid) or {}).get("title") or lid}
                for lid, l in lessons.items() if local_day(l.get("done_at")) == day]
    on_day = [{"id": r["id"], "title": round_names.get(r["persona"], r["title"]), "score": r["score"], "answers": r["answers"]}
              for r in rounds if local_day(r["created_at"]) == day]
    return {"day": day, "planned": bool(row), "complete": bool(row and row["completed_at"]),
            "steps": steps, "lessons": finished, "rounds": on_day}
