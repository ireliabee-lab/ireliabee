"""
Progress dashboard: pulls scores, delivery stats and drill results from past
sessions into trends the user can see improving over time.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import date, datetime, timedelta

from fastapi import APIRouter

from ..core import sessions as sess
from .. import confidence as _confidence  # noqa: F401  (adds sessions.confidence_json)
from .drills import _ensure_table as _ensure_drills_table

router = APIRouter()

_SCORE_RE = re.compile(r"^\*\*Score:\s*(\d+)\s*/\s*10\*\*")


def _day(ts: str | None) -> str | None:
    return ts[:10] if ts else None


def _streak(days: set[str]) -> int:
    """Consecutive practice days ending today (or yesterday, so it survives until you practise)."""
    today = date.today()
    start = today if today.isoformat() in days else today - timedelta(days=1)
    n = 0
    while (start - timedelta(days=n)).isoformat() in days:
        n += 1
    return n


def _loads(raw: str | None) -> dict | None:
    try:
        data = json.loads(raw) if raw else None
        return data if isinstance(data, dict) else None
    except (TypeError, ValueError):
        return None


def _warmup_days() -> set[str]:
    """Days a warm-up was finished (recorded locally by backend/usage.py)."""
    from .. import usage  # noqa: F401  (creates the usage_counts table)
    with sess._connect() as conn:
        return {r[0] for r in conn.execute(
            "SELECT DISTINCT day FROM usage_counts WHERE event = 'practice.warmup.done'"
        )}


@router.get("/")
def get_progress():
    _ensure_drills_table()
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT id, title, tags, created_at, duration_sec, debrief_json, delivery_json, confidence_json "
            "FROM sessions ORDER BY created_at"
        ).fetchall()
        typed_scores: dict[int, list[int]] = {}
        for sid, content in conn.execute(
            "SELECT session_id, content FROM messages WHERE role = 'assistant' AND content LIKE '**Score:%'"
        ):
            m = _SCORE_RE.match(content or "")
            if m:
                typed_scores.setdefault(sid, []).append(int(m.group(1)))
        drill_rows = conn.execute(
            "SELECT topic, score, rounds, solid, created_at FROM drills ORDER BY id"
        ).fetchall()

    scores, delivery, confidence, practice_days = [], [], [], set()
    practice_sec = 0
    focus = Counter()
    for r in rows:
        sid, title, tags, created, duration, debrief_raw, delivery_raw = (
            r["id"], r["title"], r["tags"] or "", r["created_at"], r["duration_sec"] or 0,
            r["debrief_json"], r["delivery_json"],
        )
        kind = "mock" if "mock" in tags.split(",") else "live"
        debrief = _loads(debrief_raw)
        stats = _loads(delivery_raw)

        score = None
        if debrief and debrief.get("overall_score"):
            score = int(debrief["overall_score"])
            focus.update(debrief.get("improvements", [])[:4])
        elif typed_scores.get(sid):
            vals = typed_scores[sid]
            score = round(sum(vals) / len(vals), 1)
        if score is not None:
            scores.append({"session_id": sid, "date": created, "score": score, "kind": kind, "title": title})

        # Saved confidence reports (session hub → Confidence), so the trend and
        # the per-session score are the same number.
        conf = _loads(r["confidence_json"])
        if conf and conf.get("overall") is not None:
            confidence.append({"session_id": sid, "date": created, "confidence": conf["overall"], "title": title})

        if stats and stats.get("words"):
            delivery.append({
                "session_id": sid, "date": created,
                "wpm": stats.get("wpm"), "filler_rate": stats.get("filler_rate"),
                "talk_share": stats.get("talk_share"), "long_answers": stats.get("long_answers", 0),
            })

        if score is not None or stats or duration:
            practice_days.add(_day(created))
            practice_sec += duration or (stats or {}).get("speaking_sec", 0)

    drills = [
        {"topic": d["topic"], "score": d["score"], "rounds": d["rounds"], "solid": bool(d["solid"]), "date": d["created_at"]}
        for d in drill_rows
    ]
    practice_days.update(_day(d["date"]) for d in drills)
    # A finished two-minute warm-up is practice too (roadmap 1.4).
    practice_days.update(_warmup_days())
    # So is studying a lecture's flashcards or quiz (roadmap 3.1).
    study = _study_results()
    practice_days.update(_day(s["date"]) for s in study)
    # And practising a hard moment from a real call again (roadmap 3.4).
    from .. import retry
    practice_days.update(_day(d) for d in retry.retry_days())
    # Study mode: answering and reviewing questions in a notebook, and Talk at work.
    from .. import study_reviews, talk_drills
    studied = study_reviews.progress()
    practice_days.update(_day(a["date"]) for a in studied["answers"])
    talk = talk_drills.results()
    practice_days.update(_day(t["date"]) for t in talk)

    def avg(values):
        values = [v for v in values if v is not None]
        return round(sum(values) / len(values), 1) if values else None

    def change(series, key):
        """Average of the latest 3 minus the 3 before — positive means the number went up."""
        vals = [s[key] for s in series if s.get(key) is not None]
        if len(vals) < 4:
            return None
        return round(avg(vals[-3:]) - avg(vals[-6:-3]), 1)

    # Latest result per topic: a topic counts as solid once its most recent drill was.
    latest_topic = {d["topic"].lower(): d for d in drills}
    return {
        "summary": {
            "sessions": len({s["session_id"] for s in scores} | {d["session_id"] for d in delivery}),
            "practice_minutes": round(practice_sec / 60),
            "streak_days": _streak({d for d in practice_days if d}),
            "avg_score": avg([s["score"] for s in scores[-5:]]),
            "score_change": change(scores, "score"),
            "avg_wpm": avg([d["wpm"] for d in delivery[-5:]]),
            "avg_filler_rate": avg([d["filler_rate"] for d in delivery[-5:]]),
            "filler_change": change(delivery, "filler_rate"),
            "avg_confidence": avg([c["confidence"] for c in confidence[-5:]]),
            "confidence_change": change(confidence, "confidence"),
            "drills": len(drills),
            "solid_topics": sum(1 for d in latest_topic.values() if d["solid"]),
            "topics": len(latest_topic),
            "quizzes": sum(1 for s in study if s["kind"] == "quiz"),
            "avg_quiz": avg([s["percent"] for s in study if s["kind"] == "quiz"][-5:]),
            "study_answers": len(studied["answers"]),
            "study_due": studied["due"],
            "avg_study": avg([a["score"] for a in studied["answers"][-10:]]),
            "talk_drills": len(talk),
            "avg_talk": avg([t["score"] for t in talk[-5:]]),
            "talk_change": change(talk, "score"),
        },
        "scores": scores[-30:],
        "delivery": delivery[-30:],
        "confidence": confidence[-30:],
        "drills": drills[-30:],
        "study": study[-30:],
        "study_answers": studied["answers"][-30:],
        "talk": talk[-30:],
        "focus": [text for text, _ in focus.most_common(3)],
    }


def _study_results() -> list[dict]:
    """Lecture flashcard and quiz rounds (roadmap 3.1), oldest first."""
    from .. import study  # noqa: F401  (creates the table)
    with sess._connect() as conn:
        rows = conn.execute("SELECT session_id, kind, score, total, created_at FROM study_results ORDER BY id").fetchall()
    return [{"session_id": r["session_id"], "kind": r["kind"], "score": r["score"], "total": r["total"],
             "percent": round(100 * r["score"] / r["total"]) if r["total"] else 0, "date": r["created_at"]} for r in rows]
