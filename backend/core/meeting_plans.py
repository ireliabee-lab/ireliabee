"""
Meeting Plans — per-conversation game plans.

A MeetingPlan captures the shape of a specific upcoming conversation so the
coach can give structured, context-aware guidance during it. Think of it as
what a prep coach would write for you before a big call.

Fields mirror how you'd think about ANY high-stakes conversation:
  * purpose        — what you want out of this specific conversation
  * counterparty   — who you're talking with (name + role)
  * duration_min   — planned length, so section allocations make sense
  * sections       — ordered agenda blocks (title, minutes, goal)
  * answers_prep   — things you're prepared to be asked about
  * questions_ask  — questions you want to ask them
  * traps_avoid    — mistakes to preempt (e.g. "don't oversell the AI angle")
  * commitments    — concrete outcomes you want to leave with

Storage lives in the same SQLite DB as sessions/profiles.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from typing import Optional

from .sessions import _connect


def _ensure_schema():
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meeting_plans (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                profile_id     INTEGER,
                title          TEXT NOT NULL,
                counterparty   TEXT,
                purpose        TEXT,
                duration_min   INTEGER,
                sections_json  TEXT NOT NULL DEFAULT '[]',
                answers_json   TEXT NOT NULL DEFAULT '[]',
                questions_json TEXT NOT NULL DEFAULT '[]',
                traps_json     TEXT NOT NULL DEFAULT '[]',
                commitments_json TEXT NOT NULL DEFAULT '[]',
                notes          TEXT DEFAULT '',
                created_at     TEXT NOT NULL,
                updated_at     TEXT NOT NULL
            );
            """
        )
        # Add plan_id to sessions so a session can be linked to a plan
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN plan_id INTEGER")
        except sqlite3.OperationalError:
            pass
        # Add briefing + raw research to plans (migration for older DBs)
        # people_ids: researched people (backend/people.py) this meeting is with
        # documents_json: Library reference files for this meeting (roadmap 2.5)
        for col in ("briefing TEXT DEFAULT ''", "raw_research_json TEXT DEFAULT ''", "people_json TEXT DEFAULT '[]'",
                    "documents_json TEXT DEFAULT '[]'"):
            try:
                conn.execute(f"ALTER TABLE meeting_plans ADD COLUMN {col}")
            except sqlite3.OperationalError:
                pass


_ensure_schema()


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def create_plan(
    title: str,
    profile_id: Optional[int] = None,
    counterparty: str = "",
    purpose: str = "",
    duration_min: int = 45,
    sections: Optional[list[dict]] = None,
    answers_prep: Optional[list[str]] = None,
    questions_ask: Optional[list[str]] = None,
    traps_avoid: Optional[list[str]] = None,
    commitments: Optional[list[str]] = None,
    notes: str = "",
    people_ids: Optional[list[int]] = None,
    document_ids: Optional[list[int]] = None,
) -> int:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO meeting_plans (
                profile_id, title, counterparty, purpose, duration_min,
                sections_json, answers_json, questions_json, traps_json,
                commitments_json, notes, people_json, documents_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                profile_id, title, counterparty, purpose, duration_min,
                json.dumps(sections or []),
                json.dumps(answers_prep or []),
                json.dumps(questions_ask or []),
                json.dumps(traps_avoid or []),
                json.dumps(commitments or []),
                notes, json.dumps(people_ids or []), json.dumps(document_ids or []), now, now,
            ),
        )
        return cur.lastrowid


def list_plans(profile_id: Optional[int] = None, limit: int = 30) -> list[sqlite3.Row]:
    with _connect() as conn:
        if profile_id is not None:
            cur = conn.execute(
                "SELECT * FROM meeting_plans WHERE profile_id = ? "
                "ORDER BY updated_at DESC LIMIT ?",
                (profile_id, limit),
            )
        else:
            cur = conn.execute(
                "SELECT * FROM meeting_plans ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            )
        return cur.fetchall()


def get_plan(plan_id: int) -> Optional[dict]:
    with _connect() as conn:
        cur = conn.execute("SELECT * FROM meeting_plans WHERE id = ?", (plan_id,))
        row = cur.fetchone()
    if not row:
        return None
    d = dict(row)
    for k in ("sections", "answers", "questions", "traps", "commitments"):
        d[k if k == "sections" else f"{k}_prep" if k == "answers" else
          f"{k}_ask" if k == "questions" else
          f"{k}_avoid" if k == "traps" else
          k] = json.loads(d.pop(f"{k}_json", "[]"))
    # Clean up mapping
    d.setdefault("answers_prep", d.pop("answers", []) if "answers" in d else [])
    d.setdefault("questions_ask", d.pop("questions", []) if "questions" in d else [])
    d.setdefault("traps_avoid", d.pop("traps", []) if "traps" in d else [])
    d["people_ids"] = json.loads(d.pop("people_json", None) or "[]")
    d["document_ids"] = json.loads(d.pop("documents_json", None) or "[]")
    return d


def update_plan(plan_id: int, **fields):
    if not fields:
        return
    now = _now()
    list_fields = {
        "sections": "sections_json",
        "answers_prep": "answers_json",
        "questions_ask": "questions_json",
        "traps_avoid": "traps_json",
        "commitments": "commitments_json",
        "people_ids": "people_json",
        "document_ids": "documents_json",
    }
    sets = []
    vals: list = []
    for k, v in fields.items():
        if k in list_fields:
            sets.append(f"{list_fields[k]} = ?")
            vals.append(json.dumps(v))
        else:
            sets.append(f"{k} = ?")
            vals.append(v)
    sets.append("updated_at = ?")
    vals.append(now)
    vals.append(plan_id)
    with _connect() as conn:
        conn.execute(f"UPDATE meeting_plans SET {', '.join(sets)} WHERE id = ?", vals)


def delete_plan(plan_id: int):
    with _connect() as conn:
        conn.execute("DELETE FROM meeting_plans WHERE id = ?", (plan_id,))


def render_plan_for_prompt(plan: dict) -> str:
    """Format a plan for injection into the LLM system prompt."""
    lines = [
        f"MEETING PLAN — {plan.get('title', '(untitled)')}",
        f"Counterparty: {plan.get('counterparty') or '(not specified)'}",
        f"Purpose: {plan.get('purpose') or '(not specified)'}",
        f"Planned duration: {plan.get('duration_min') or '?'} minutes",
    ]

    sections = plan.get("sections", []) or []
    if sections:
        lines.append("\nAGENDA")
        for i, s in enumerate(sections, 1):
            title = s.get("title", "(untitled)")
            minutes = s.get("minutes", "?")
            goal = s.get("goal", "")
            lines.append(f"  {i}. [{minutes} min] {title}")
            if goal:
                lines.append(f"     Goal: {goal}")

    for label, key in [
        ("ANSWERS TO PREPARE", "answers_prep"),
        ("QUESTIONS TO ASK THEM", "questions_ask"),
        ("TRAPS TO AVOID", "traps_avoid"),
        ("COMMITMENTS TO SECURE", "commitments"),
    ]:
        items = plan.get(key, []) or []
        if items:
            lines.append(f"\n{label}")
            for it in items:
                lines.append(f"  • {it}")

    notes = plan.get("notes", "").strip()
    if notes:
        lines.append(f"\nNOTES\n{notes}")

    people_ids = plan.get("people_ids") or []
    if people_ids:
        from ..people import briefs_for
        people = briefs_for(people_ids)
        if people:
            lines.append("\n" + "─" * 60)
            lines.append("WHO YOU'RE MEETING (researched — use to build rapport and tailor answers):")
            lines.append("─" * 60)
            lines.append(people)

    briefing = (plan.get("briefing") or "").strip()
    if briefing:
        lines.append("\n" + "─" * 60)
        lines.append("COUNTERPARTY BRIEFING (from research):")
        lines.append("─" * 60)
        lines.append(briefing)

    return "\n".join(lines)
