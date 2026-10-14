"""
Research Track: a path from newcomer to research scientist.

Seven levels (docs: "Research Track: newcomer to research scientist"), each
ending in an exit test. This module keeps the learner's place on the ladder,
their term bank (spaced repetition), their paper cards, the lessons they have
done and the evidence behind every skill score.

Nothing here calls the AI. Cards are self-graded, paper cards are the
learner's own words, and the practice panel (Supervisor, Journal Club) runs
through the ordinary mock conversation, which this module only reads back.
The curriculum itself is data in `research_content/`, so lessons and terms can
be improved without touching code.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from . import milestones as ms
from .core import sessions as sess

CONTENT_DIR = Path(__file__).resolve().parent / "research_content"

GOALS = ("phd", "first-paper", "industry", "curious")
GRADES = (0, 1, 2, 3)            # again, hard, good, easy
NEW_PER_DAY = 10                 # new cards introduced a day
PERSONAS = {"supervisor": "Supervisor meeting", "journal_club": "Journal club",
            "proposal": "Proposal defence", "reviewer": "Reviewer 2",
            "audience": "Conference audience", "committee": "Viva committee", "professor": "Professor"}
#: A panel session counts as passed at this score out of 10.
PASS_SCORE = 7.0
#: A mock viva has to be long enough to count: this many questions answered.
VIVA_QUESTIONS = 8
LIMITS = {"term": 200, "text": 1200, "field": 120, "brief": 4000, "card": 3000, "title": 300, "draft": 40000}
PAPER_FIELDS = ("question", "method", "result", "limitation", "critique")

#: DARPA's Heilmeier Catechism: the eight questions a proposal must answer.
HEILMEIER = (
    ("aim", "What are you trying to do? Say it with no jargon."),
    ("today", "How is it done today, and what are the limits of current practice?"),
    ("new", "What is new in your approach, and why do you think it will be successful?"),
    ("who", "Who cares? If you are successful, what difference will it make?"),
    ("risks", "What are the risks?"),
    ("cost", "How much will it cost?"),
    ("time", "How long will it take?"),
    ("exams", "What are the mid-term and final exams to check for success?"),
)
#: A proposal answer counts as written once it is at least this long.
ANSWER_MIN = 40
#: The milestones of a replication, in order.
REPLICATION_STEPS = (
    ("choose", "Choose the paper and the one result you will reproduce"),
    ("data", "Get the data, or the closest data you can use, and note how it differs"),
    ("plan", "Write a preregistration-style plan before you look at results"),
    ("pipeline", "Rebuild the analysis in version-controlled code"),
    ("reproduce", "Reproduce the main number or figure"),
    ("compare", "Compare with the paper and explain every difference"),
    ("share", "Share the code and a short write-up"),
)
#: The writing projects of levels 4 and 5: fields in order, each (id, label, hint, rows, minimum length).
#: A "choice" field lists its options instead of a length.
FLAT_KINDS: dict[str, tuple] = {
    "paper": (
        ("abstract", "Abstract", "The question, what you did, the main result with its size, and why it matters. About 150–250 words.", 5, 400),
        ("introduction", "Introduction", "Establish the territory, show the gap, say how this paper fills it (Swales' CARS moves).", 8, 800),
        ("methods", "Methods", "Enough detail that someone else could repeat it: data, design, measures, analysis.", 8, 800),
        ("results", "Results", "What you found, with sizes and uncertainty, in the order of your questions.", 8, 800),
        ("discussion", "Discussion", "What the results mean, how they fit other work, and claims no stronger than the evidence.", 6, 600),
        ("limitations", "Limitations", "What the design cannot rule out, and what would.", 3, 200),
    ),
    "review": (
        ("paper", "Paper you reviewed", "Authors, year and title.", 1, 5),
        ("link", "Link to its public reviews (optional)", "An OpenReview page, so you can compare.", 1, 0),
        ("summary", "Summary", "What the paper claims and how it supports it, in your own words.", 4, 200),
        ("strengths", "Strengths", "What is new, sound or useful.", 3, 150),
        ("weaknesses", "Weaknesses", "Threats to validity, missing baselines, claims beyond the evidence.", 4, 200),
        ("questions", "Questions for the authors", "What would change your mind.", 3, 100),
        ("recommendation", "Recommendation", ("Reject", "Weak reject", "Weak accept", "Accept")),
        ("confidence", "Your confidence", ("1 Guess", "2 Unsure", "3 Fairly sure", "4 Confident", "5 Expert")),
        ("compare", "What the real reviewers raised that you missed (optional)", "After reading the public reviews.", 3, 0),
    ),
    "talk": (
        ("message", "The one message", "The single sentence you want the audience to leave with.", 2, 40),
        ("outline", "Outline", "The story in 5 to 8 steps, one idea per slide.", 5, 300),
        ("script", "Script", "What you will say in about 10 minutes.", 10, 1200),
        ("questions", "Questions you expect", "The three hardest questions and your short answers.", 4, 150),
    ),
}
PROJECT_KINDS = ("proposal", "replication") + tuple(FLAT_KINDS)


def _now() -> datetime:
    return datetime.utcnow().replace(microsecond=0)


def _iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def _s(value: Any, limit: int) -> str:
    return str(value).strip()[:limit] if isinstance(value, (str, int, float)) else ""


# ── Schema ───────────────────────────────────────────────────────────────────

def _ensure_schema() -> None:
    with sess._connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS research_track (
                id           INTEGER PRIMARY KEY CHECK (id = 1),   -- one learner per install
                field        TEXT NOT NULL,
                goal         TEXT NOT NULL,
                level        INTEGER NOT NULL DEFAULT 0,
                weekly_hours INTEGER NOT NULL DEFAULT 10,
                brief        TEXT NOT NULL DEFAULT '',            -- the project, for the Supervisor
                started_at   TEXT NOT NULL,
                level_at     TEXT NOT NULL,                       -- when the current level began
                updated_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS term_cards (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                term_key      TEXT NOT NULL UNIQUE,                -- lower-cased term: one card per term
                core_id       TEXT,                                -- id in core_terms.json, if it came from there
                term          TEXT NOT NULL,
                definition    TEXT NOT NULL,
                example       TEXT NOT NULL DEFAULT '',
                misuse        TEXT NOT NULL DEFAULT '',
                when_used     TEXT NOT NULL DEFAULT '',
                tier          TEXT NOT NULL,                       -- core | field | mine
                grp           TEXT NOT NULL DEFAULT '',
                source        TEXT NOT NULL DEFAULT '',            -- where a field term was found
                ord           INTEGER NOT NULL DEFAULT 0,          -- order new cards are introduced in
                reps          INTEGER NOT NULL DEFAULT 0,
                lapses        INTEGER NOT NULL DEFAULT 0,
                ease          REAL NOT NULL DEFAULT 2.5,
                interval_days REAL NOT NULL DEFAULT 0,
                last_grade    INTEGER,
                first_seen    TEXT,
                last_reviewed TEXT,
                due           TEXT,
                created_at    TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_term_cards_due ON term_cards(due);
            CREATE TABLE IF NOT EXISTS paper_cards (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL,
                authors     TEXT NOT NULL DEFAULT '',
                document_id INTEGER,
                notebook_id INTEGER,
                pass        INTEGER NOT NULL DEFAULT 0,               -- reading passes done, 0-3
                question    TEXT NOT NULL DEFAULT '',
                method      TEXT NOT NULL DEFAULT '',
                result      TEXT NOT NULL DEFAULT '',
                limitation  TEXT NOT NULL DEFAULT '',
                critique    TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS research_lessons (
                lesson_id TEXT PRIMARY KEY,
                answer    TEXT NOT NULL DEFAULT '',                   -- the learner's self-check answer
                done_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS research_projects (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                kind       TEXT NOT NULL,                             -- proposal | replication
                title      TEXT NOT NULL,
                data_json  TEXT NOT NULL DEFAULT '{}',                -- the kind's fields, see clean_project
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS research_sprints (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER,                                   -- what was written, if a project
                minutes    INTEGER NOT NULL,
                words      INTEGER NOT NULL DEFAULT 0,                -- words added
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS research_days (
                day          TEXT PRIMARY KEY,                        -- local date, YYYY-MM-DD
                steps_json   TEXT NOT NULL DEFAULT '[]',              -- the day's step ids, in order
                done_json    TEXT NOT NULL DEFAULT '[]',              -- the step ids finished
                answers_json TEXT NOT NULL DEFAULT '{}',              -- exercise answers, by lesson
                completed_at TEXT,                                    -- when the last step was done
                created_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS research_evidence (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                skill_id   TEXT NOT NULL,
                score      INTEGER NOT NULL,                          -- 0-4
                kind       TEXT NOT NULL,                             -- exit | mentor | self
                note       TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            """
        )


_ensure_schema()


def _ensure_columns() -> None:
    """Tracks started before field packs and mentors."""
    with sess._connect() as conn:
        have = {r[1] for r in conn.execute("PRAGMA table_info(research_track)")}
        for col in ("packs", "mentor_name", "mentor_email"):
            if col not in have:
                conn.execute(f"ALTER TABLE research_track ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")


_ensure_columns()


# ── Content ──────────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def content() -> dict:
    """The curriculum, core terms and skills shipped with the app."""
    def load(name: str) -> dict:
        try:
            return json.loads((CONTENT_DIR / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    terms = load("core_terms.json").get("terms", [])
    levels = load("curriculum.json").get("levels", [])
    pillars = load("skills.json").get("pillars", [])
    packs = {}
    for f in sorted((CONTENT_DIR / "packs").glob("*.json")) if (CONTENT_DIR / "packs").is_dir() else []:
        pack = load(f"packs/{f.name}")
        if pack.get("id"):
            packs[pack["id"]] = pack
    return {"terms": terms, "levels": levels, "pillars": pillars, "packs": packs}


def active_packs() -> list[str]:
    track = get_track()
    wanted = [p for p in (track or {}).get("packs", "").split(",") if p]
    return [p for p in wanted if p in content()["packs"]]


def _levels_with_packs() -> list[dict]:
    """The ladder with the active packs' lessons added to their levels, after the core ones."""
    levels = [dict(lv, lessons=list(lv.get("lessons", []))) for lv in content()["levels"]]
    by_id = {lv["id"]: lv for lv in levels}
    for pid in active_packs():
        pack = content()["packs"][pid]
        for lesson in pack.get("lessons", []):
            lv = by_id.get(lesson.get("level"))
            if lv is not None:
                lv["lessons"].append({**lesson, "pack": pid, "pack_name": pack.get("name", pid)})
    return levels


def _level(n: int) -> Optional[dict]:
    return next((lv for lv in _levels_with_packs() if lv.get("id") == n), None)


def _skills() -> dict[str, dict]:
    out = {}
    for p in content()["pillars"]:
        for sk in p.get("skills", []):
            out[sk["id"]] = {**sk, "pillar": p["id"]}
    return out


# ── Spaced repetition ────────────────────────────────────────────────────────

def schedule(card: dict, grade: int, now: datetime) -> dict:
    """
    The next review for a card, SM-2 style. `grade` is 0 again, 1 hard, 2 good,
    3 easy. A forgotten card comes back in ten minutes and starts again; a
    remembered one waits longer each time, longer still when it was easy.
    """
    if grade not in GRADES:
        raise ValueError("grade must be 0-3")
    reps, ease = int(card.get("reps") or 0), float(card.get("ease") or 2.5)
    interval = float(card.get("interval_days") or 0)
    lapses = int(card.get("lapses") or 0)
    if grade == 0:
        return {"reps": 0, "lapses": lapses + 1, "ease": max(1.3, round(ease - 0.2, 2)),
                "interval_days": 0.0, "last_grade": 0, "due": _iso(now + timedelta(minutes=10))}
    if reps == 0:
        interval = {1: 1.0, 2: 1.0, 3: 3.0}[grade]
    elif reps == 1:
        interval = {1: 2.0, 2: 4.0, 3: 6.0}[grade]
    else:
        interval = interval * {1: 1.2, 2: ease, 3: ease * 1.3}[grade]
    ease = max(1.3, round(ease + {1: -0.15, 2: 0.0, 3: 0.15}[grade], 2))
    interval = round(min(interval, 365.0), 2)
    return {"reps": reps + 1, "lapses": lapses, "ease": ease, "interval_days": interval,
            "last_grade": grade, "due": _iso(now + timedelta(days=interval))}


# ── The track ────────────────────────────────────────────────────────────────

def get_track() -> Optional[dict]:
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM research_track WHERE id = 1").fetchone()
    return dict(row) if row else None


def _need_track() -> dict:
    t = get_track()
    if not t:
        raise HTTPException(409, detail={"code": "no_track", "title": "Start your track first",
                                         "message": "Choose your field and goal on the Research screen."})
    return t


def start_track(field: str, goal: str, weekly_hours: int = 10, brief: str = "") -> dict:
    field = _s(field, LIMITS["field"])
    if not field:
        raise HTTPException(400, "Say which field you're researching")
    goal = goal if goal in GOALS else "curious"
    hours = max(1, min(int(weekly_hours or 10), 60))
    now = _iso(_now())
    with sess._connect() as conn:
        conn.execute(
            "INSERT INTO research_track (id, field, goal, level, weekly_hours, brief, started_at, level_at, updated_at) "
            "VALUES (1, ?, ?, 0, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET field=excluded.field, goal=excluded.goal, "
            "weekly_hours=excluded.weekly_hours, brief=excluded.brief, updated_at=excluded.updated_at",
            (field, goal, hours, _s(brief, LIMITS["brief"]), now, now, now))
    seed_core_terms()
    harvest_terms()
    return get_track()


def update_track(fields: dict) -> dict:
    t = _need_track()
    field = _s(fields.get("field", t["field"]), LIMITS["field"]) or t["field"]
    goal = fields.get("goal", t["goal"])
    goal = goal if goal in GOALS else t["goal"]
    hours = max(1, min(int(fields.get("weekly_hours", t["weekly_hours"]) or 10), 60))
    brief = _s(fields.get("brief", t["brief"]), LIMITS["brief"])
    with sess._connect() as conn:
        conn.execute("UPDATE research_track SET field=?, goal=?, weekly_hours=?, brief=?, updated_at=? WHERE id=1",
                     (field, goal, hours, brief, _iso(_now())))
    return get_track()


# ── Term bank ────────────────────────────────────────────────────────────────

def _key(term: str) -> str:
    return " ".join(term.lower().split())


def _level_term_order() -> dict[str, int]:
    """Core terms the lessons use come first, in lesson order."""
    order: dict[str, int] = {}
    for lv in content()["levels"]:
        for lesson in lv.get("lessons", []):
            for tid in lesson.get("terms", []):
                order.setdefault(tid, len(order))
    return order


def seed_core_terms() -> int:
    order = _level_term_order()
    now = _iso(_now())
    added = 0
    with sess._connect() as conn:
        for i, t in enumerate(content()["terms"]):
            cur = conn.execute(
                "INSERT OR IGNORE INTO term_cards (term_key, core_id, term, definition, example, misuse, when_used, "
                "tier, grp, ord, created_at) VALUES (?,?,?,?,?,?,?,'core',?,?,?)",
                (_key(t["term"]), t["id"], t["term"], t.get("definition", ""), t.get("example", ""),
                 t.get("misuse", ""), t.get("when", ""), t.get("group", ""), order.get(t["id"], 1000 + i), now))
            added += cur.rowcount
    return added


def _definitions_in(doc: dict):
    for section in doc.get("sections") or []:
        for block in section.get("blocks") or []:
            if block.get("type") == "definition" and block.get("term") and block.get("text"):
                yield block["term"], block["text"]


def harvest_terms() -> int:
    """Terms the learner's own notes define become field cards."""
    now = _iso(_now())
    found: list[tuple[str, str, str]] = []
    with sess._connect() as conn:
        try:
            rows = conn.execute("SELECT title, doc_json FROM notebooks WHERE kind IN ('reading','lecture')").fetchall()
        except Exception:
            rows = []
        for r in rows:
            try:
                doc = json.loads(r["doc_json"] or "{}")
            except ValueError:
                continue
            found += [(term, text, r["title"]) for term, text in _definitions_in(doc)]
        try:
            packs = conn.execute("SELECT title, study_json FROM sessions WHERE study_json IS NOT NULL").fetchall()
        except Exception:
            packs = []
        for r in packs:
            try:
                pack = json.loads(r["study_json"] or "{}")
            except ValueError:
                continue
            for g in pack.get("glossary") or []:
                if g.get("term") and g.get("definition"):
                    found.append((g["term"], g["definition"], r["title"]))
        added = 0
        for term, text, source in found:
            cur = conn.execute(
                "INSERT OR IGNORE INTO term_cards (term_key, term, definition, tier, source, ord, created_at) "
                "VALUES (?,?,?,'field',?,2000,?)",
                (_key(term), _s(term, LIMITS["term"]), _s(text, LIMITS["text"]), _s(source, LIMITS["title"]), now))
            added += cur.rowcount
    return added


def add_term(term: str, definition: str, example: str = "") -> dict:
    term, definition = _s(term, LIMITS["term"]), _s(definition, LIMITS["text"])
    if not term or not definition:
        raise HTTPException(400, "A card needs a term and what it means")
    with sess._connect() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO term_cards (term_key, term, definition, example, tier, ord, created_at) "
            "VALUES (?,?,?,?,'mine',500,?)", (_key(term), term, definition, _s(example, LIMITS["text"]), _iso(_now())))
        if not cur.rowcount:
            raise HTTPException(409, "That term is already in your bank")
        row = conn.execute("SELECT * FROM term_cards WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def list_terms(q: str = "", tier: str = "") -> list[dict]:
    sql, args = "SELECT * FROM term_cards WHERE 1=1", []
    if q:
        sql += " AND (term LIKE ? OR definition LIKE ?)"
        args += [f"%{q}%", f"%{q}%"]
    if tier in ("core", "field", "mine", "pack"):
        sql += " AND tier = ?"
        args.append(tier)
    with sess._connect() as conn:
        return [dict(r) for r in conn.execute(sql + " ORDER BY grp, term", args)]


def _new_today(conn, now: datetime) -> int:
    start = _iso(now.replace(hour=0, minute=0, second=0))
    return conn.execute("SELECT COUNT(*) FROM term_cards WHERE first_seen >= ?", (start,)).fetchone()[0]


def review_queue(now: Optional[datetime] = None, limit: int = 60) -> dict:
    """Cards due now, then today's allowance of new ones."""
    now = now or _now()
    with sess._connect() as conn:
        due = [dict(r) for r in conn.execute(
            "SELECT * FROM term_cards WHERE first_seen IS NOT NULL AND due <= ? ORDER BY due LIMIT ?", (_iso(now), limit))]
        room = max(0, NEW_PER_DAY - _new_today(conn, now))
        new = [dict(r) for r in conn.execute(
            "SELECT * FROM term_cards WHERE first_seen IS NULL ORDER BY ord, id LIMIT ?", (room,))] if room else []
        total_new = conn.execute("SELECT COUNT(*) FROM term_cards WHERE first_seen IS NULL").fetchone()[0]
    return {"due": due, "new": new, "new_left": total_new}


def review(card_id: int, grade: int, now: Optional[datetime] = None) -> dict:
    now = now or _now()
    if grade not in GRADES:
        raise HTTPException(400, "Grade must be 0 (again) to 3 (easy)")
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM term_cards WHERE id = ?", (card_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Card not found")
        nxt = schedule(dict(row), grade, now)
        conn.execute(
            "UPDATE term_cards SET reps=?, lapses=?, ease=?, interval_days=?, last_grade=?, due=?, last_reviewed=?, "
            "first_seen=COALESCE(first_seen, ?) WHERE id=?",
            (nxt["reps"], nxt["lapses"], nxt["ease"], nxt["interval_days"], nxt["last_grade"], nxt["due"],
             _iso(now), _iso(now), card_id))
        return dict(conn.execute("SELECT * FROM term_cards WHERE id = ?", (card_id,)).fetchone())


def term_stats(core_ids: Optional[list[str]] = None) -> dict:
    """How many cards have been seen, and how many are held (last answered good or easy)."""
    with sess._connect() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT core_id, reps, last_grade, first_seen FROM term_cards")]
    if core_ids is not None:
        wanted = set(core_ids)
        rows = [r for r in rows if r["core_id"] in wanted]
    seen = [r for r in rows if r["first_seen"]]
    held = [r for r in seen if (r["last_grade"] or 0) >= 2 and r["reps"] >= 1]
    return {"total": len(rows), "seen": len(seen), "held": len(held),
            "recall": round(len(held) / len(rows), 3) if rows else 0.0}


# ── Lessons ──────────────────────────────────────────────────────────────────

def _lesson(lesson_id: str) -> Optional[dict]:
    for lv in _levels_with_packs():
        for lesson in lv.get("lessons", []):
            if lesson.get("id") == lesson_id:
                return {**lesson, "level": lv["id"]}
    return None


def lessons_done() -> dict[str, dict]:
    with sess._connect() as conn:
        return {r["lesson_id"]: dict(r) for r in conn.execute("SELECT * FROM research_lessons")}


def mark_lesson(lesson_id: str, answer: str = "", done: bool = True) -> dict:
    if not _lesson(lesson_id):
        raise HTTPException(404, "No such lesson")
    with sess._connect() as conn:
        if done:
            conn.execute("INSERT INTO research_lessons (lesson_id, answer, done_at) VALUES (?,?,?) "
                         "ON CONFLICT(lesson_id) DO UPDATE SET answer=excluded.answer",
                         (lesson_id, _s(answer, LIMITS["card"]), _iso(_now())))
        else:
            conn.execute("DELETE FROM research_lessons WHERE lesson_id = ?", (lesson_id,))
    return {"lesson_id": lesson_id, "done": done}


# ── Paper cards ──────────────────────────────────────────────────────────────

def list_papers() -> list[dict]:
    with sess._connect() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM paper_cards ORDER BY updated_at DESC")]
    for r in rows:
        r["complete"] = all(r[f].strip() for f in PAPER_FIELDS)
    return rows


def add_paper(title: str, document_id: Optional[int] = None, notebook_id: Optional[int] = None, authors: str = "") -> dict:
    title = _s(title, LIMITS["title"])
    if not title:
        raise HTTPException(400, "A paper needs a title")
    now = _iso(_now())
    with sess._connect() as conn:
        if document_id or notebook_id:
            dup = conn.execute("SELECT id FROM paper_cards WHERE (document_id = ? AND ? IS NOT NULL) "
                               "OR (notebook_id = ? AND ? IS NOT NULL)",
                               (document_id, document_id, notebook_id, notebook_id)).fetchone()
            if dup:
                raise HTTPException(409, "That paper already has a card")
        cur = conn.execute("INSERT INTO paper_cards (title, authors, document_id, notebook_id, created_at, updated_at) "
                           "VALUES (?,?,?,?,?,?)", (title, _s(authors, LIMITS["title"]), document_id, notebook_id, now, now))
    return next(p for p in list_papers() if p["id"] == cur.lastrowid)


def update_paper(paper_id: int, fields: dict) -> dict:
    sets, args = [], []
    for f in PAPER_FIELDS + ("title", "authors"):
        if f in fields and fields[f] is not None:
            sets.append(f"{f} = ?")
            args.append(_s(fields[f], LIMITS["title"] if f in ("title", "authors") else LIMITS["card"]))
    if fields.get("pass") is not None:
        sets.append("pass = ?")
        args.append(max(0, min(int(fields["pass"]), 3)))
    if not sets:
        raise HTTPException(400, "Nothing to change")
    with sess._connect() as conn:
        cur = conn.execute(f"UPDATE paper_cards SET {', '.join(sets)}, updated_at = ? WHERE id = ?",
                           (*args, _iso(_now()), paper_id))
        if not cur.rowcount:
            raise HTTPException(404, "Paper card not found")
    return next(p for p in list_papers() if p["id"] == paper_id)


def delete_paper(paper_id: int) -> None:
    with sess._connect() as conn:
        conn.execute("DELETE FROM paper_cards WHERE id = ?", (paper_id,))


def paper_sources() -> list[dict]:
    """Library files and reading notes that could become paper cards."""
    with sess._connect() as conn:
        have_docs = {r[0] for r in conn.execute("SELECT document_id FROM paper_cards WHERE document_id IS NOT NULL")}
        have_nbs = {r[0] for r in conn.execute("SELECT notebook_id FROM paper_cards WHERE notebook_id IS NOT NULL")}
        out = []
        try:
            for r in conn.execute("SELECT id, name, original_filename, created_at FROM documents ORDER BY created_at DESC"):
                if r["id"] not in have_docs:
                    out.append({"kind": "document", "id": r["id"], "title": r["name"], "file": r["original_filename"]})
        except Exception:
            pass
        try:
            for r in conn.execute("SELECT id, title FROM notebooks WHERE kind = 'reading' ORDER BY updated_at DESC"):
                if r["id"] not in have_nbs:
                    out.append({"kind": "notebook", "id": r["id"], "title": r["title"]})
        except Exception:
            pass
    return out


# ── Projects: the proposal and the replication ───────────────────────────────

def clean_project(kind: str, data: Any) -> dict:
    """Only the fields a kind has, trimmed; unknown keys are dropped."""
    data = data if isinstance(data, dict) else {}
    if kind == "proposal":
        answers = data.get("answers") if isinstance(data.get("answers"), dict) else {}
        return {"question": _s(data.get("question", ""), LIMITS["card"]),
                "hypothesis": _s(data.get("hypothesis", ""), LIMITS["card"]),
                "answers": {qid: _s(answers.get(qid, ""), LIMITS["card"]) for qid, _ in HEILMEIER}}
    if kind in FLAT_KINDS:
        out = {}
        for fid, _label, spec, *_ in FLAT_KINDS[kind]:
            value = data.get(fid, "")
            if isinstance(spec, tuple):
                out[fid] = value if value in spec else ""
            else:
                out[fid] = _s(value, LIMITS["draft"])
        return out
    steps = data.get("steps") if isinstance(data.get("steps"), dict) else {}
    return {"paper": _s(data.get("paper", ""), LIMITS["title"]),
            "claim": _s(data.get("claim", ""), LIMITS["card"]),
            "data": _s(data.get("data", ""), LIMITS["card"]),
            "code_url": _s(data.get("code_url", ""), LIMITS["title"]),
            "prereg_url": _s(data.get("prereg_url", ""), LIMITS["title"]),
            "notes": _s(data.get("notes", ""), LIMITS["card"]),
            "steps": {sid: bool(steps.get(sid)) for sid, _ in REPLICATION_STEPS}}


def project_progress(kind: str, data: dict) -> dict:
    """How far a project is, and the next thing to do."""
    todo: list[str] = []
    if kind == "proposal":
        if not data["question"].strip():
            todo.append("Write your research question.")
        if not data["hypothesis"].strip():
            todo.append("State a hypothesis that could turn out false.")
        todo += [q for qid, q in HEILMEIER if len(data["answers"].get(qid, "").strip()) < ANSWER_MIN]
        total = len(HEILMEIER) + 2
    elif kind in FLAT_KINDS:
        for fid, label, spec, *rest in FLAT_KINDS[kind]:
            if isinstance(spec, tuple):
                if not data.get(fid):
                    todo.append(f"Choose your {label.lower()}.")
            elif rest and rest[-1] and len(data.get(fid, "").strip()) < rest[-1]:
                todo.append(f"Write the {label.split(' (')[0].lower()}.")
        total = sum(1 for f in FLAT_KINDS[kind] if isinstance(f[2], tuple) or f[-1])
    else:
        todo += [label for sid, label in REPLICATION_STEPS if not data["steps"].get(sid)]
        if not data["prereg_url"].strip():
            todo.append("Add the link to your preregistration or plan.")
        if not data["code_url"].strip():
            todo.append("Add the link to your code.")
        total = len(REPLICATION_STEPS) + 2
    return {"done": total - len(todo), "total": total, "complete": not todo, "next": todo[0] if todo else None}


def _project_row(r) -> dict:
    try:
        data = json.loads(r["data_json"] or "{}")
    except ValueError:
        data = {}
    data = clean_project(r["kind"], data)
    return {"id": r["id"], "kind": r["kind"], "title": r["title"], "data": data,
            "progress": project_progress(r["kind"], data), "created_at": r["created_at"], "updated_at": r["updated_at"]}


def list_projects(kind: str = "") -> list[dict]:
    with sess._connect() as conn:
        rows = conn.execute("SELECT * FROM research_projects " + ("WHERE kind = ? " if kind else "") +
                            "ORDER BY updated_at DESC, id DESC", (kind,) if kind else ()).fetchall()
    return [_project_row(r) for r in rows]


def create_project(kind: str, title: str, data: Any = None) -> dict:
    if kind not in PROJECT_KINDS:
        raise HTTPException(400, "A project is a proposal or a replication")
    title = _s(title, LIMITS["title"])
    if not title:
        raise HTTPException(400, "Give the project a title")
    now = _iso(_now())
    with sess._connect() as conn:
        cur = conn.execute("INSERT INTO research_projects (kind, title, data_json, created_at, updated_at) VALUES (?,?,?,?,?)",
                           (kind, title, json.dumps(clean_project(kind, data or {})), now, now))
        return _project_row(conn.execute("SELECT * FROM research_projects WHERE id = ?", (cur.lastrowid,)).fetchone())


def update_project(project_id: int, title: Optional[str] = None, data: Any = None) -> dict:
    """Change only what is sent; answers and steps merge key by key."""
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM research_projects WHERE id = ?", (project_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Project not found")
        merged = _project_row(row)["data"]
        if isinstance(data, dict):
            for key, value in data.items():
                if isinstance(value, dict) and isinstance(merged.get(key), dict):
                    merged[key] = {**merged[key], **value}
                else:
                    merged[key] = value
        new_title = (_s(title, LIMITS["title"]) if title is not None else "") or row["title"]
        conn.execute("UPDATE research_projects SET title = ?, data_json = ?, updated_at = ? WHERE id = ?",
                     (new_title, json.dumps(clean_project(row["kind"], merged)), _iso(_now()), project_id))
        return _project_row(conn.execute("SELECT * FROM research_projects WHERE id = ?", (project_id,)).fetchone())


def delete_project(project_id: int) -> None:
    with sess._connect() as conn:
        conn.execute("DELETE FROM research_projects WHERE id = ?", (project_id,))


def project_text(project: dict) -> str:
    """Everything written in a project, for counting words."""
    d = project["data"]
    parts = [v for k, v in d.items() if isinstance(v, str) and not k.endswith("url")]
    parts += list((d.get("answers") or {}).values())
    return " ".join(parts)


# ── Writing sprints ──────────────────────────────────────────────────────────

def add_sprint(minutes: int, words: int = 0, project_id: Optional[int] = None) -> dict:
    minutes = max(1, min(int(minutes or 0), 240))
    words = max(0, min(int(words or 0), 20000))
    now = _iso(_now())
    with sess._connect() as conn:
        cur = conn.execute("INSERT INTO research_sprints (project_id, minutes, words, created_at) VALUES (?,?,?,?)",
                           (project_id, minutes, words, now))
    return {"id": cur.lastrowid, "project_id": project_id, "minutes": minutes, "words": words, "created_at": now}


def sprint_stats(since: Optional[str] = None) -> dict:
    with sess._connect() as conn:
        row = conn.execute("SELECT COUNT(*), COALESCE(SUM(minutes), 0), COALESCE(SUM(words), 0) FROM research_sprints "
                           + ("WHERE created_at >= ?" if since else ""), (since,) if since else ()).fetchone()
    return {"sprints": row[0], "minutes": row[1], "words": row[2]}


# ── The practice panel, read back from Practice ──────────────────────────────

def panel_sessions(since: Optional[str] = None, personas: Optional[dict] = None) -> list[dict]:
    """Practice rounds with the panel (or with `personas`): each typed answer's score out of 10."""
    personas = PERSONAS if personas is None else personas
    out = []
    with sess._connect() as conn:
        try:
            rows = conn.execute("SELECT id, title, tags, created_at, debrief_json FROM sessions "
                                "WHERE tags LIKE '%mock%' ORDER BY created_at DESC").fetchall()
        except Exception:   # before debriefs existed on this install
            rows = conn.execute("SELECT id, title, tags, created_at, NULL AS debrief_json FROM sessions "
                                "WHERE tags LIKE '%mock%' ORDER BY created_at DESC").fetchall()
        for r in rows:
            tags = (r["tags"] or "").split(",")
            persona = next((p for p in personas if p in tags), None)
            if not persona or (since and r["created_at"] < since):
                continue
            scores = []
            for m in conn.execute("SELECT content FROM messages WHERE session_id = ? AND role = 'assistant'", (r["id"],)):
                text = m["content"] or ""
                if text.startswith("**Score:"):
                    try:
                        scores.append(float(text.split("**Score:")[1].split("/")[0]))
                    except (ValueError, IndexError):
                        pass
            answers = len(scores)
            if not scores and r["debrief_json"]:   # a voice round: its debrief carries one overall score
                try:
                    debrief = json.loads(r["debrief_json"])
                    overall = debrief.get("overall_score")
                    if isinstance(overall, (int, float)):
                        scores.append(float(overall))
                        answers = len(debrief.get("questions") or []) or 1
                except ValueError:
                    pass
            out.append({"id": r["id"], "persona": persona, "title": r["title"], "created_at": r["created_at"],
                        "answers": answers, "score": round(sum(scores) / len(scores), 1) if scores else None})
    return out


def _best(persona: str, since: Optional[str] = None) -> Optional[float]:
    scores = [s["score"] for s in panel_sessions(since) if s["persona"] == persona and s["score"] is not None]
    return max(scores) if scores else None


# ── Mastery ──────────────────────────────────────────────────────────────────

def _bands(value: float, steps: list[tuple[float, int]]) -> int:
    return max([score for need, score in steps if value >= need] or [0])


def skill_scores() -> dict[str, dict]:
    """Every skill's 0-4 score and what earned it. Scores only come from evidence."""
    skills = _skills()
    done = lessons_done()
    scores = {sid: {"score": 0, "why": ""} for sid in skills}

    def lift(sid: str, score: int, why: str) -> None:
        if sid in scores and score > scores[sid]["score"]:
            scores[sid] = {"score": score, "why": why}

    for lesson_id in done:
        lesson = _lesson(lesson_id)
        for sid in (lesson or {}).get("skills", []):
            lift(sid, 1, f"Lesson done: {lesson['title']}")
    stats = term_stats()
    vocab = 0
    if stats["seen"] >= 20 and stats["held"] / max(stats["seen"], 1) >= 0.8:
        vocab = _bands(stats["held"], [(20, 1), (60, 2), (120, 3)])
    lift("research-vocabulary", vocab, f"{stats['held']} terms held in spaced review")
    papers = list_papers()
    complete = sum(1 for p in papers if p["complete"])
    lift("paper-cards", _bands(complete, [(1, 1), (5, 2), (15, 3)]), f"{complete} complete paper cards")
    three = sum(1 for p in papers if p["pass"] >= 3)
    lift("three-pass-reading", _bands(three, [(1, 1), (3, 2), (10, 3)]), f"{three} papers read in three passes")
    lift("field-map", _bands(len(papers), [(10, 1), (30, 2), (60, 3)]), f"{len(papers)} papers on your map")
    if any(p["progress"]["complete"] for p in list_projects("proposal")):
        for sid in ("question-framing", "hypothesis-formulation"):
            lift(sid, 2, "A complete one-page proposal")
    for rep in list_projects("replication"):
        d = rep["data"]
        if d["steps"].get("plan") and d["prereg_url"]:
            lift("preregistering", 2, f"Preregistered plan: {rep['title']}")
        if d["steps"].get("pipeline") and d["code_url"]:
            lift("reproducible-pipeline", 2, f"Code for {rep['title']}")
            lift("version-control", 2, f"Code for {rep['title']}")
        if d["steps"].get("reproduce"):
            lift("data-analysis", 2, f"Reproduced the result in {rep['title']}")
        if rep["progress"]["complete"]:
            lift("study-design", 2, f"Finished replication: {rep['title']}")
    if any(p["progress"]["complete"] for p in list_projects("paper")):
        for sid in ("structuring-a-paper", "writing-an-abstract", "hedging-claims"):
            lift(sid, 2, "A complete paper draft")
    reviews = [p for p in list_projects("review") if p["progress"]["complete"]]
    lift("peer-reviewing", _bands(len(reviews), [(1, 1), (2, 2), (5, 3)]), f"{len(reviews)} complete peer reviews")
    if any(p["progress"]["complete"] for p in list_projects("talk")):
        lift("conference-talk", 2, "A complete talk: message, outline, script and expected questions")
        lift("elevator-pitch", 1, "A one-sentence message for your talk")
    meetings = meeting_report(limit=50)
    if meetings["distinct_terms"] >= 25:
        lift("research-vocabulary", 4, f"Used {meetings['distinct_terms']} of your terms in real meetings")
    elif meetings["distinct_terms"] >= 10:
        lift("research-vocabulary", 3, f"Used {meetings['distinct_terms']} of your terms in real meetings")
    calibrated = [s for s in meetings["sessions"] if s["hedges"] and not s["overclaims"]]
    if len(calibrated) >= 3:
        lift("hedging-claims", 3, f"{len(calibrated)} real meetings with hedged claims and no overclaiming")
    sprints = sprint_stats()
    if sprints["sprints"] >= 3:
        lift("structuring-a-paper", 1, f"{sprints['sprints']} writing sprints, {sprints['words']} words")
    for persona, sid in (("supervisor", "discuss-research"), ("journal_club", "present-a-paper"),
                         ("proposal", "question-framing"), ("reviewer", "study-design"),
                         ("audience", "answering-questions"), ("committee", "handling-critique"),
                         ("professor", "elevator-pitch")):
        best = _best(persona)
        if best is not None:
            lift(sid, _bands(best, [(5, 1), (6, 2), (PASS_SCORE, 3), (8.5, 4)]), f"Best {PERSONAS[persona]}: {best}/10")
    with sess._connect() as conn:
        for r in conn.execute("SELECT skill_id, score, kind, note FROM research_evidence"):
            lift(r["skill_id"], int(r["score"]), r["note"] or r["kind"])
    return scores


def exit_status(level: int) -> dict:
    """What the level's exit test asks, and how far the learner is."""
    lv = _level(level) or {}
    track = get_track()
    since = track["level_at"] if track else None
    checks: list[dict] = []
    if level == 0:
        ids = [tid for lesson in lv.get("lessons", []) for tid in lesson.get("terms", [])]
        st = term_stats(ids)
        need = float(((lv.get("exit") or {}).get("recall_threshold")) or 0.9)
        checks.append({"id": "recall", "label": f"Hold {round(need * 100)}% of this level's {st['total']} terms",
                       "value": f"{round(st['recall'] * 100)}%", "met": st["total"] > 0 and st["recall"] >= need})
        best = _best("supervisor", since)
        checks.append({"id": "oral", "label": f"Score {PASS_SCORE:g}/10 or more with the Supervisor",
                       "value": f"{best}/10" if best is not None else "Not yet", "met": best is not None and best >= PASS_SCORE})
    elif level == 1:
        passed = [s for s in panel_sessions(since) if s["persona"] == "journal_club" and (s["score"] or 0) >= PASS_SCORE]
        complete = sum(1 for p in list_papers() if p["complete"])
        checks.append({"id": "journal", "label": f"Pass 3 journal clubs ({PASS_SCORE:g}/10 or more)",
                       "value": f"{len(passed)} of 3", "met": len(passed) >= 3})
        checks.append({"id": "cards", "label": "10 complete paper cards", "value": f"{complete} of 10", "met": complete >= 10})
    elif level == 2:
        written = any(p["progress"]["complete"] for p in list_projects("proposal"))
        best = _best("proposal", since)
        checks.append({"id": "proposal", "label": "A one-page proposal answering all eight Heilmeier questions",
                       "value": "written" if written else "Not yet", "met": written})
        checks.append({"id": "defence", "label": f"Score {PASS_SCORE:g}/10 or more defending it to the proposal panel",
                       "value": f"{best}/10" if best is not None else "Not yet", "met": best is not None and best >= PASS_SCORE})
    elif level == 3:
        reps = list_projects("replication")
        furthest = max(reps, key=lambda p: p["progress"]["done"], default=None)
        best = _best("reviewer", since)
        checks.append({"id": "replication", "label": "A finished replication: every milestone, with the plan and code linked",
                       "value": f"{furthest['progress']['done']} of {furthest['progress']['total']}" if furthest else "Not started",
                       "met": any(p["progress"]["complete"] for p in reps)})
        checks.append({"id": "review", "label": f"Score {PASS_SCORE:g}/10 or more defending it to Reviewer 2",
                       "value": f"{best}/10" if best is not None else "Not yet", "met": best is not None and best >= PASS_SCORE})
    elif level == 4:
        paper = any(p["progress"]["complete"] for p in list_projects("paper"))
        reviews = sum(1 for p in list_projects("review") if p["progress"]["complete"])
        best = _best("reviewer", since)
        checks.append({"id": "paper", "label": "A complete paper draft: abstract, introduction, methods, results, discussion, limitations",
                       "value": "written" if paper else "Not yet", "met": paper})
        checks.append({"id": "reviews", "label": "Two complete peer reviews", "value": f"{reviews} of 2", "met": reviews >= 2})
        checks.append({"id": "defence", "label": f"Score {PASS_SCORE:g}/10 or more defending the draft to Reviewer 2",
                       "value": f"{best}/10" if best is not None else "Not yet", "met": best is not None and best >= PASS_SCORE})
    elif level == 5:
        talk = any(p["progress"]["complete"] for p in list_projects("talk"))
        best = _best("audience", since)
        checks.append({"id": "talk", "label": "A complete talk: one message, outline, script and expected questions",
                       "value": "written" if talk else "Not yet", "met": talk})
        checks.append({"id": "conference", "label": f"Score {PASS_SCORE:g}/10 or more with the conference audience",
                       "value": f"{best}/10" if best is not None else "Not yet", "met": best is not None and best >= PASS_SCORE})
    elif level == 6:
        vivas = [s for s in panel_sessions(since) if s["persona"] == "committee" and s["answers"] >= VIVA_QUESTIONS]
        best = max((s["score"] for s in vivas if s["score"] is not None), default=None)
        checks.append({"id": "viva", "label": f"A mock viva of {VIVA_QUESTIONS} or more questions scoring {PASS_SCORE:g}/10 or more",
                       "value": f"{best}/10" if best is not None else "Not yet", "met": best is not None and best >= PASS_SCORE})
    else:
        checks.append({"id": "done", "label": "You have finished the ladder", "value": "", "met": False})
    lessons = lv.get("lessons", [])
    done = lessons_done()
    return {"level": level, "exit": lv.get("exit"), "checks": checks,
            "lessons_done": sum(1 for l in lessons if l["id"] in done), "lessons_total": len(lessons),
            "passed": bool(checks) and all(c["met"] for c in checks)}


def advance() -> dict:
    track = _need_track()
    status = exit_status(track["level"])
    if not status["passed"]:
        raise HTTPException(409, detail={"code": "exit_not_met", "title": "Not yet",
                                         "message": "Pass every part of this level's exit test first."})
    now = _iso(_now())
    with sess._connect() as conn:
        for sid in (status["exit"] or {}).get("skills", []):
            conn.execute("INSERT INTO research_evidence (skill_id, score, kind, note, created_at) VALUES (?,3,'exit',?,?)",
                         (sid, f"Passed the level {track['level']} exit test", now))
        conn.execute("UPDATE research_track SET level = level + 1, level_at = ?, updated_at = ? WHERE id = 1", (now, now))
    return get_track()


def readiness() -> dict:
    track = get_track()
    level = track["level"] if track else 0
    skills = _skills()
    scores = skill_scores()
    pillars = []
    for p in content()["pillars"]:
        live = [s for s in p.get("skills", []) if s.get("level", 0) <= level + 1]
        vals = [scores[s["id"]]["score"] for s in live]
        pillars.append({"id": p["id"], "name": p["name"], "score": round(sum(vals) / len(vals), 2) if vals else 0.0,
                        "skills": [{**s, **scores[s["id"]]} for s in p.get("skills", [])]})
    open_skills = [{**skills[sid], **v} for sid, v in scores.items() if skills[sid].get("level", 0) <= level + 1]
    weakest = sorted(open_skills, key=lambda s: (s["score"], s.get("level", 0)))[:3]
    return {"level": level, "pillars": pillars, "weakest": weakest, "exit": exit_status(level)}


# ── Today ────────────────────────────────────────────────────────────────────

def today(now: Optional[datetime] = None) -> dict:
    now = now or _now()
    track = _need_track()
    queue = review_queue(now)
    lv = _level(track["level"]) or {}
    done = lessons_done()
    lesson = next((l for l in lv.get("lessons", []) if l["id"] not in done), None)
    papers = list_papers()
    paper = min((p for p in papers if p["pass"] < 3 or not p["complete"]), key=lambda p: p["pass"], default=None)
    project = None
    kind = {2: "proposal", 3: "replication", 4: "paper", 5: "talk"}.get(track["level"])
    if kind == "paper" and any(p["progress"]["complete"] for p in list_projects("paper")) \
            and sum(1 for p in list_projects("review") if p["progress"]["complete"]) < 2:
        kind = "review"
    if kind:
        mine = list_projects(kind)
        open_ones = [p for p in mine if not p["progress"]["complete"]]
        if open_ones:
            project = open_ones[0]
        elif not mine:
            project = {"kind": kind, "id": None, "title": None, "progress": None}
    week_ago = _iso(now - timedelta(days=7))
    recent = panel_sessions(week_ago)
    speak = (lesson or {}).get("speak")
    if not speak:
        held = [c for c in list_terms() if c["first_seen"]]
        pick = held[now.toordinal() % len(held)] if held else None
        speak = f"Use \"{pick['term']}\" correctly in a 60-second answer about your project." if pick else \
            "In 60 seconds, explain your research question to someone outside your field."
    return {
        "track": track,
        "reviews": {"due": len(queue["due"]), "new": len(queue["new"])},
        "lesson": lesson,
        "paper": paper,
        "speak": speak,
        "project": project,
        "weekly": {
            "supervisor": not any(s["persona"] == "supervisor" for s in recent),
            "journal_club": track["level"] >= 1 and not any(s["persona"] == "journal_club" for s in recent),
            "reviewer": track["level"] >= 3 and not any(s["persona"] == "reviewer" for s in recent),
            "sprint": track["level"] >= 2 and sprint_stats(week_ago)["sprints"] == 0,
            "peer_review": track["level"] >= 3 and not any(p["updated_at"] >= week_ago for p in list_projects("review")),
            "conference": track["level"] >= 5 and not any(s["persona"] == "audience" for s in panel_sessions(_iso(now - timedelta(days=30)))),
        },
        "exit": exit_status(track["level"]),
    }


# ── The daily session ────────────────────────────────────────────────────────
#
# One guided path through the day: the term cards, then the next lesson step by
# step (why, read, exercise, say it, check), then whatever else is due (a weekly
# meeting, the project, the exit test). The day's steps are fixed when it starts,
# so finishing a lesson mid-session never reshuffles what is left.

LESSON_STEPS = ("intro", "read", "do", "speak", "check")
STEP_TITLES = {"intro": "This lesson", "read": "Read", "do": "Exercise", "speak": "Say it", "check": "Check"}
WEEKLY_STEP = ("supervisor", "journal_club", "reviewer", "peer_review", "sprint", "conference")


def _day(local: Optional[datetime] = None) -> str:
    return (local or datetime.now()).date().isoformat()


def _next_lesson(skip: tuple = ()) -> Optional[dict]:
    track = _need_track()
    done = lessons_done()
    lv = _level(track["level"]) or {}
    return next((l for l in lv.get("lessons", []) if l["id"] not in done and l["id"] not in skip), None)


def _lesson_step_ids(lesson: dict) -> list:
    return [f"lesson:{lesson['id']}:{part}" for part in LESSON_STEPS]


def _planned_lessons(steps: list) -> tuple:
    return tuple(dict.fromkeys(s.split(":")[1] for s in steps if s.startswith("lesson:")))


def _plan(now: datetime) -> list:
    """The step ids for a new day, in the order they are done."""
    steps = []
    queue = review_queue(now)
    if queue["due"] or queue["new"]:
        steps.append("cards")
    lesson = _next_lesson()
    if lesson:
        steps += _lesson_step_ids(lesson)
    info = today(now)
    weekly = next((k for k in WEEKLY_STEP if info["weekly"].get(k)), None)
    if weekly:
        steps.append(f"weekly:{weekly}")
    if info["project"]:
        steps.append(f"project:{info['project']['kind']}")
    if not lesson:
        steps.append("exit")
    return steps


def _day_row(key: str) -> Optional[dict]:
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM research_days WHERE day = ?", (key,)).fetchone()
    if not row:
        return None
    return {"day": row["day"], "steps": json.loads(row["steps_json"]), "done": json.loads(row["done_json"]),
            "answers": json.loads(row["answers_json"]), "completed_at": row["completed_at"]}


def _save_day(day: dict) -> None:
    complete = bool(day["steps"]) and all(s in day["done"] for s in day["steps"])
    completed_at = (day.get("completed_at") or _iso(_now())) if complete else None
    with sess._connect() as conn:
        conn.execute(
            "INSERT INTO research_days (day, steps_json, done_json, answers_json, completed_at, created_at) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT(day) DO UPDATE SET steps_json=excluded.steps_json, "
            "done_json=excluded.done_json, answers_json=excluded.answers_json, completed_at=excluded.completed_at",
            (day["day"], json.dumps(day["steps"]), json.dumps(day["done"]), json.dumps(day["answers"]),
             completed_at, _iso(_now())))


def streak(local: Optional[datetime] = None) -> int:
    """Days in a row with a finished session; today counts once it is finished."""
    with sess._connect() as conn:
        days = {r[0] for r in conn.execute("SELECT day FROM research_days WHERE completed_at IS NOT NULL")}
    d = (local or datetime.now()).date()
    if d.isoformat() not in days:
        d -= timedelta(days=1)
    count = 0
    while d.isoformat() in days:
        count += 1
        d -= timedelta(days=1)
    return count


def _cards_for(core_ids: list) -> list:
    if not core_ids:
        return []
    marks = ",".join("?" * len(core_ids))
    with sess._connect() as conn:
        rows = conn.execute(f"SELECT term, definition, example, core_id FROM term_cards WHERE core_id IN ({marks})",
                            tuple(core_ids)).fetchall()
    by_id = {r["core_id"]: dict(r) for r in rows}
    return [{k: by_id[i][k] for k in ("term", "definition", "example")} for i in core_ids if i in by_id]


def _step(step_id: str, day: dict, now: datetime) -> dict:
    """What a step shows, worked out fresh so it reflects the latest state."""
    out = {"id": step_id, "done": step_id in day["done"]}
    if step_id == "cards":
        queue = review_queue(now)
        out.update(kind="cards", title="Words", minutes=10, due=len(queue["due"]), new=len(queue["new"]))
    elif step_id.startswith("lesson:"):
        _, lesson_id, part = step_id.split(":")
        lesson = _lesson(lesson_id) or {}
        out.update(kind=part, title=STEP_TITLES[part], answer=day["answers"].get(lesson_id, ""),
                   lesson={k: lesson.get(k) for k in ("id", "title", "minutes", "pillar", "why", "read", "do",
                                                      "speak", "check", "level", "pack_name")})
        if part == "intro":
            out["terms"] = _cards_for(lesson.get("terms", []))
    elif step_id.startswith("weekly:"):
        out.update(kind="weekly", title="This week", what=step_id.split(":", 1)[1])
    elif step_id.startswith("project:"):
        out.update(kind="project", title="Your project", project=today(now)["project"],
                   project_kind=step_id.split(":", 1)[1])
    elif step_id == "exit":
        out.update(kind="exit", title="Level exit", exit=exit_status(_need_track()["level"]))
    else:
        out.update(kind="unknown", title=step_id)
    return out


def session(now: Optional[datetime] = None, local: Optional[datetime] = None) -> dict:
    """Today's guided session, planned the first time it is opened each day."""
    now = now or _now()
    track = _need_track()
    key = _day(local)
    day = _day_row(key)
    if not day:
        day = {"day": key, "steps": _plan(now), "done": [], "answers": {}, "completed_at": None}
        _save_day(day)
    steps = [_step(s, day, now) for s in day["steps"]]
    status = exit_status(track["level"])
    lv = _level(track["level"]) or {}
    upcoming = _next_lesson(_planned_lessons(day["steps"]))
    minutes = sum(int((s.get("lesson") or {}).get("minutes") or 0) for s in steps if s["kind"] == "intro")
    minutes += 10 if any(s["kind"] == "cards" for s in steps) else 0
    return {
        "day": key,
        "steps": steps,
        "current": next((i for i, s in enumerate(steps) if not s["done"]), None),
        "complete": bool(steps) and all(s["done"] for s in steps),
        "started": bool(day["done"]),
        "minutes": minutes,
        "streak": streak(local),
        "level": {"id": track["level"], "name": lv.get("name", ""), "lessons_done": status["lessons_done"],
                  "lessons_total": status["lessons_total"], "exit_passed": status["passed"],
                  "levels": len(content()["levels"])},
        "next_lesson": {"id": upcoming["id"], "title": upcoming["title"], "minutes": upcoming.get("minutes")} if upcoming else None,
    }


def session_step(step_id: str, answer: Optional[str] = None, done: bool = True,
                 now: Optional[datetime] = None, local: Optional[datetime] = None) -> dict:
    """Finish a step, or save an exercise answer without finishing it. A check answered
    "not yet" sends the learner back over the reading, the exercise and the speaking."""
    day = _day_row(_day(local))
    if not day or step_id not in day["steps"]:
        raise HTTPException(404, "That step is not in today's session")
    if step_id.startswith("lesson:"):
        _, lesson_id, part = step_id.split(":")
        if answer is not None:
            day["answers"][lesson_id] = _s(answer, LIMITS["card"])
        if part == "check" and done:
            mark_lesson(lesson_id, day["answers"].get(lesson_id, ""))
        if part == "check" and not done:
            again = {f"lesson:{lesson_id}:{p}" for p in ("read", "do", "speak")}
            day["done"] = [s for s in day["done"] if s not in again]
    if done and step_id not in day["done"]:
        day["done"].append(step_id)
    _save_day(day)
    return session(now, local)


def session_more(now: Optional[datetime] = None, local: Optional[datetime] = None) -> dict:
    """Keep going: add the next lesson (or the exit test) to today's session."""
    session(now, local)                                   # make sure today exists
    day = _day_row(_day(local))
    lesson = _next_lesson(_planned_lessons(day["steps"]))
    if lesson:
        day["steps"] += _lesson_step_ids(lesson)
    elif "exit" not in day["steps"]:
        day["steps"].append("exit")
    else:
        raise HTTPException(409, detail={"code": "nothing_left", "title": "Nothing left today",
                                         "message": "Every lesson in this level is done. Pass the exit test to open the next level."})
    _save_day(day)
    return session(now, local)


def curriculum() -> dict:
    track = get_track()
    level = track["level"] if track else 0
    done = lessons_done()
    levels = []
    for lv in _levels_with_packs():
        lessons = [{**l, "done": l["id"] in done, "answer": (done.get(l["id"]) or {}).get("answer", "")}
                   for l in lv.get("lessons", [])]
        levels.append({**lv, "lessons": lessons,
                       "state": "done" if lv["id"] < level else "current" if lv["id"] == level else "locked"})
    return {"level": level, "levels": levels}



# ── Milestones and activity ──────────────────────────────────────────────────

def _earned_milestones() -> list[dict]:
    track = get_track()
    if not track:
        return []
    done = lessons_done()
    held = term_stats()["held"]
    papers = sum(1 for p in list_papers() if p["complete"])
    out = ms.counted("lessons", "lesson", len(done), ms.LESSON_COUNTS,
                     lambda n: "First lesson done" if n == 1 else f"{n} lessons done",
                     lambda n: "The first step on the ladder." if n == 1 else f"{n} research lessons finished.")
    for lv in content()["levels"]:
        if 0 < lv["id"] <= track["level"]:
            out.append(ms.milestone(f"level:{lv['id']}", "level", f"Level {lv['id']}: {lv.get('name', '')}",
                                    "You passed the exit test and opened the next level.", big=True))
    if exit_status(track["level"])["passed"] and track["level"] < len(content()["levels"]) - 1:
        out.append(ms.milestone(f"exit:{track['level']}", "exit", "Exit test passed",
                                "Every part of this level's exit is met. Open the next level when you're ready."))
    out += ms.counted("terms", "cards", held, (25, 50, 100, 200), lambda n: f"{n} terms held",
                      lambda n: f"{n} research terms held in spaced review.")
    out += ms.counted("papers", "paper", papers, (1, 5, 10, 25),
                      lambda n: "First paper card" if n == 1 else f"{n} paper cards",
                      lambda n: "You pulled a paper apart: question, method, result, limitation." if n == 1
                      else f"{n} papers read closely enough to fill every field.")
    act = activity()
    out += ms.streak_milestones(act["best_streak"])
    out += ms.day_milestones(act["days_finished"])
    return out


def milestones() -> dict:
    """Milestones waiting to be celebrated, and every one reached so far."""
    return {"pending": ms.pending("research", _earned_milestones()), "earned": ms.earned("research")}


def milestones_seen(keys: list[str]) -> dict:
    return ms.mark_seen("research", keys)


def activity(local: Optional[datetime] = None) -> dict:
    """The calendar, weekly lessons and the climb, plus each level's lessons done."""
    stamps = [l["done_at"] for l in lessons_done().values()]
    out = ms.activity("research_days", stamps, streak(local), local)
    done = lessons_done()
    track = get_track()
    level = track["level"] if track else 0
    out["levels"] = [{"id": lv["id"], "name": lv.get("name", ""), "done": sum(1 for l in lv.get("lessons", []) if l["id"] in done),
                      "total": len(lv.get("lessons", [])),
                      "state": "done" if lv["id"] < level else "current" if lv["id"] == level else "locked"}
                     for lv in _levels_with_packs()]
    return out


def activity_day(day: str) -> dict:
    """One day of the calendar in full: its steps, lessons finished and panel rounds."""
    labels = {"cards": "Term cards", "exit": "Level exit test", "weekly": "This week's meeting", "project": "Your project",
              **{f"weekly:{k}": v for k, v in PERSONAS.items()}, "weekly:sprint": "Writing sprint",
              "weekly:peer_review": "Peer review"}
    return ms.day_detail("research_days", day, _lesson, labels, lessons_done(),
                         panel_sessions(), PERSONAS)

# ── Portfolio ────────────────────────────────────────────────────────────────

def portfolio(now: Optional[datetime] = None) -> str:
    """Everything the learner has made, as Markdown to share with a mentor."""
    now = now or _now()
    track = _need_track()
    level = _level(track["level"]) or {}
    lines = [f"# Research portfolio: {track['field']}", "",
             f"Level {track['level']}: {level.get('name', '')} · started {track['started_at'][:10]} · exported {now.date().isoformat()}", ""]
    if track["brief"]:
        lines += ["## Project", "", track["brief"], ""]
    if active_packs():
        lines += ["Field packs: " + ", ".join(content()["packs"][p].get("name", p) for p in active_packs()), ""]
    if track.get("mentor_name"):
        lines += [f"Mentor: {track['mentor_name']}", ""]
    signed = sign_offs()
    if signed:
        lines += ["## Mentor sign-offs", ""]
        lines += [f"- {s['created_at'][:10]}: {s['note']} ({', '.join(s['skills'])})" for s in signed]
        lines.append("")
    lines += ["## Skills", "", "| Pillar | Skill | Score | Evidence |", "| --- | --- | --- | --- |"]
    scores = skill_scores()
    names = ["Not started", "Aware", "Guided", "Independent", "Fluent"]
    for p in content()["pillars"]:
        for sk in p.get("skills", []):
            sc = scores[sk["id"]]
            if sc["score"]:
                lines.append(f"| {p['name']} | {sk['name']} | {sc['score']} {names[sc['score']]} | {sc['why']} |")
    stats = term_stats()
    sp = sprint_stats()
    lines += ["", f"Terms held in spaced review: {stats['held']} of {stats['total']}. "
                  f"Writing sprints: {sp['sprints']} ({sp['minutes']} minutes, {sp['words']} words).", ""]
    papers = [p for p in list_papers() if any(p[f].strip() for f in PAPER_FIELDS)]
    if papers:
        lines += ["## Paper cards", ""]
        for p in papers:
            lines += [f"### {p['title']}" + (f" ({p['authors']})" if p["authors"] else ""), ""]
            lines += [f"- **{f.capitalize()}:** {p[f].strip()}" for f in PAPER_FIELDS if p[f].strip()]
            lines.append("")
    for kind, heading in (("proposal", "Proposals"), ("replication", "Replications"), ("paper", "Paper drafts"),
                          ("review", "Peer reviews"), ("talk", "Talks")):
        projects = list_projects(kind)
        if not projects:
            continue
        lines += [f"## {heading}", ""]
        for pr in projects:
            d = pr["data"]
            lines += [f"### {pr['title']}", "", f"Progress: {pr['progress']['done']} of {pr['progress']['total']}"
                      + (" (complete)" if pr["progress"]["complete"] else ""), ""]
            if kind == "proposal":
                if d["question"]:
                    lines.append(f"**Question:** {d['question']}")
                if d["hypothesis"]:
                    lines.append(f"**Hypothesis:** {d['hypothesis']}")
                lines.append("")
                for qid, q in HEILMEIER:
                    if d["answers"].get(qid):
                        lines += [f"**{q}**", "", d["answers"][qid], ""]
            elif kind == "replication":
                for key, label in (("paper", "Paper"), ("claim", "Result reproduced"), ("data", "Data"),
                                   ("prereg_url", "Plan"), ("code_url", "Code"), ("notes", "Findings")):
                    if d.get(key):
                        lines.append(f"- **{label}:** {d[key]}")
                done = [label for sid, label in REPLICATION_STEPS if d["steps"].get(sid)]
                if done:
                    lines.append("- **Milestones done:** " + "; ".join(done))
                lines.append("")
            else:
                for fid, label, *_ in FLAT_KINDS[kind]:
                    if d.get(fid):
                        lines += [f"**{label}**", "", d[fid], ""]
    rounds = [r for r in panel_sessions() if r["score"] is not None]
    if rounds:
        lines += ["## Practice panel", "", "| Date | With | Score |", "| --- | --- | --- |"]
        lines += [f"| {r['created_at'][:10]} | {PERSONAS[r['persona']]} | {r['score']}/10 |" for r in rounds]
        lines.append("")
    return "\n".join(lines)


# ── Field packs ──────────────────────────────────────────────────────────────

def pack_list() -> list[dict]:
    active = set(active_packs())
    return [{"id": pid, "name": p.get("name", pid), "description": p.get("description", ""),
             "terms": len(p.get("terms", [])), "lessons": len(p.get("lessons", [])),
             "resources": p.get("resources", []), "active": pid in active}
            for pid, p in content()["packs"].items()]


def set_packs(pack_ids: list[str]) -> dict:
    """Choose the field packs; a pack's terms join the bank once and stay if it is turned off."""
    _need_track()
    ids = [p for p in dict.fromkeys(pack_ids or []) if p in content()["packs"]]
    now = _iso(_now())
    with sess._connect() as conn:
        conn.execute("UPDATE research_track SET packs = ?, updated_at = ? WHERE id = 1", (",".join(ids), now))
        for pid in ids:
            pack = content()["packs"][pid]
            for i, term in enumerate(pack.get("terms", [])):
                conn.execute(
                    "INSERT OR IGNORE INTO term_cards (term_key, core_id, term, definition, example, misuse, when_used, "
                    "tier, grp, source, ord, created_at) VALUES (?,?,?,?,?,?,?,'pack',?,?,?,?)",
                    (_key(term["term"]), f"{pid}:{term['id']}", term["term"], term.get("definition", ""),
                     term.get("example", ""), term.get("misuse", ""), term.get("when", ""),
                     term.get("group", pack.get("name", pid)), pack.get("name", pid), 1500 + i, now))
    return {"packs": pack_list()}


# ── Real meetings: the learner's own words, read locally ─────────────────────

#: Words that claim more than a single study can show.
OVERCLAIMS = ("prove", "proves", "proved", "proof", "definitely", "certainly", "undeniably", "without doubt",
              "no doubt", "always", "never", "guarantees", "everyone knows", "it is clear that", "clearly shows")
#: Words that match a claim to its evidence.
HEDGES = ("suggest", "suggests", "suggested", "may", "might", "could", "appears to", "seems to", "likely",
          "associated with", "consistent with", "we found no evidence", "the evidence", "tentative", "in this sample")
_WORDS = re.compile(r"[A-Za-z][A-Za-z'\-]*")


def _phrase_re(phrases) -> re.Pattern:
    alts = sorted({p.lower() for p in phrases if p}, key=len, reverse=True)
    return re.compile(r"\b(" + "|".join(re.escape(a) for a in alts) + r")\b", re.I) if alts else re.compile(r"(?!x)x")


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def meeting_report(limit: int = 10) -> dict:
    """
    What the learner said in real sessions (not practice): which of their terms
    they used, and where a claim was stronger than the evidence. Only their own
    lines are read, and nothing leaves the machine.
    """
    terms = [c["term"] for c in list_terms() if len(c["term"]) >= 3]
    term_re = _phrase_re(terms)
    canon = {t.lower(): t for t in terms}
    over_re, hedge_re = _phrase_re(OVERCLAIMS), _phrase_re(HEDGES)
    out, used_all = [], {}
    with sess._connect() as conn:
        rows = conn.execute("SELECT id, title, tags, created_at FROM sessions ORDER BY created_at DESC").fetchall()
        for r in rows:
            if "mock" in (r["tags"] or "").split(","):
                continue
            lines = [m["content"] or "" for m in conn.execute(
                "SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND speaker IN ('user','you') ORDER BY id",
                (r["id"],))]
            if not lines:
                continue
            text = " ".join(lines)
            used: dict[str, int] = {}
            for m in term_re.finditer(text):
                name = canon.get(m.group(1).lower(), m.group(1))
                used[name] = used.get(name, 0) + 1
            overclaims = [{"word": m.group(1), "sentence": s[:300]} for s in _sentences(text) for m in [over_re.search(s)] if m]
            hedges = len(hedge_re.findall(text))
            for name, n in used.items():
                used_all[name] = used_all.get(name, 0) + n
            out.append({"id": r["id"], "title": r["title"], "created_at": r["created_at"],
                        "words": len(_WORDS.findall(text)),
                        "terms": sorted(({"term": k, "count": v} for k, v in used.items()), key=lambda x: -x["count"]),
                        "overclaims": overclaims[:10], "hedges": hedges})
            if len(out) >= limit:
                break
    return {"sessions": out, "distinct_terms": len(used_all),
            "top_terms": sorted(({"term": k, "count": v} for k, v in used_all.items()), key=lambda x: -x["count"])[:15]}


# ── A real mentor's sign-off ─────────────────────────────────────────────────

def set_mentor(name: str, email: str = "") -> dict:
    _need_track()
    with sess._connect() as conn:
        conn.execute("UPDATE research_track SET mentor_name = ?, mentor_email = ?, updated_at = ? WHERE id = 1",
                     (_s(name, LIMITS["field"]), _s(email, LIMITS["field"]), _iso(_now())))
    return get_track()


def sign_off(mentor: str, level: int, skill_ids: list[str], note: str = "") -> dict:
    """A mentor confirms skills they have seen: each becomes Independent (3) on their word."""
    mentor = _s(mentor, LIMITS["field"])
    if not mentor:
        raise HTTPException(400, "Say who is signing off")
    skills = _skills()
    ids = [s for s in dict.fromkeys(skill_ids or []) if s in skills]
    if not ids:
        raise HTTPException(400, "Choose at least one skill your mentor has seen you do")
    now = _iso(_now())
    text = f"Signed off by {mentor} at level {int(level)}" + (f": {_s(note, LIMITS['text'])}" if note.strip() else "")
    with sess._connect() as conn:
        for sid in ids:
            conn.execute("INSERT INTO research_evidence (skill_id, score, kind, note, created_at) VALUES (?,3,'mentor',?,?)",
                         (sid, text, now))
    return {"signed": ids, "note": text}


def sign_offs() -> list[dict]:
    with sess._connect() as conn:
        rows = conn.execute("SELECT note, created_at, GROUP_CONCAT(skill_id) AS skills FROM research_evidence "
                            "WHERE kind = 'mentor' GROUP BY note, created_at ORDER BY created_at DESC").fetchall()
    names = {sid: s["name"] for sid, s in _skills().items()}
    return [{"note": r["note"], "created_at": r["created_at"],
             "skills": [names.get(s, s) for s in (r["skills"] or "").split(",") if s]} for r in rows]
