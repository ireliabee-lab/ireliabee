"""
Wordcraft — English from first words to expert communicator.

Seven realms (Pre-A1 to C2), each with six lessons, word/phrase/pattern cards
and exercises checked on this computer. A guided daily session walks the
learner through them: cards, the lesson's words, a passage, exercises, a piece
of writing, speaking, a self-check; a weekly mission; and the realm's exit.

Measurement follows the design: communication is judged by whether the message
lands (content, structure, clarity), never by speed or smoothness, and pauses,
repeated sounds or fillers are never counted as mistakes.

The curriculum is data in ``wordcraft_content/`` (see its README). The only AI
use is the Editor's writing check here, and the characters, which run through
Practice like any practice partner. Everything else stays on this machine.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from fastapi import HTTPException

from . import milestones as ms
from .core import sessions as sess
from .research_track import schedule, panel_sessions

CONTENT_DIR = Path(__file__).resolve().parent / "wordcraft_content"

GOALS = ("everyday", "work", "study", "exam", "curious")
GRADES = (0, 1, 2, 3)
NEW_PER_DAY = 10
#: Characters: practice partners in scenarios.py, keyed by the tag a round carries.
CHARACTERS = {
    "wc_guide": "The Guide", "wc_shopkeeper": "The Shopkeeper", "wc_neighbour": "The Neighbour",
    "wc_colleague": "The Colleague", "wc_debater": "The Debater", "wc_interviewer": "The Interviewer",
    "wc_audience": "The Audience",
}
PASS_SCORE = 7.0          # a character round or a written piece passes at this score out of 10
RECALL_PASS = 0.85        # share of a realm's cards held
DRILL_PASS = 0.80         # first-try accuracy across a realm's lessons
LESSON_STEPS = ("intro", "read", "drills", "write", "speak", "check")
STEP_TITLES = {"intro": "Today's quest", "read": "Read", "drills": "Practise", "write": "Write",
               "speak": "Say it", "check": "Check"}
PILLARS = ("words", "phrases", "sentences", "understanding", "speaking", "communicating")
LIMITS = {"answer": 4000, "writing": 6000, "text": 300}


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
            CREATE TABLE IF NOT EXISTS wc_track (
                id         INTEGER PRIMARY KEY CHECK (id = 1),
                realm      INTEGER NOT NULL DEFAULT 0,
                placed_at  INTEGER NOT NULL DEFAULT 0,           -- the realm placement started them in
                goal       TEXT NOT NULL DEFAULT 'everyday',
                show_pace  INTEGER NOT NULL DEFAULT 0,           -- pace and fillers: off unless turned on
                started_at TEXT NOT NULL,
                realm_at   TEXT NOT NULL,                        -- when the current realm began
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wc_cards (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                card_id       TEXT NOT NULL UNIQUE,              -- id in the content files, or mine-<n>
                kind          TEXT NOT NULL,                     -- word | phrase | pattern
                text          TEXT NOT NULL,
                meaning       TEXT NOT NULL,
                example       TEXT NOT NULL DEFAULT '',
                goes_with     TEXT NOT NULL DEFAULT '',          -- joined with " · "
                note          TEXT NOT NULL DEFAULT '',
                job           TEXT NOT NULL DEFAULT '',
                realm         INTEGER NOT NULL DEFAULT 0,
                ord           INTEGER NOT NULL DEFAULT 0,
                known         INTEGER NOT NULL DEFAULT 0,        -- came in as known (below the start realm)
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
            CREATE INDEX IF NOT EXISTS idx_wc_cards_due ON wc_cards(due);
            CREATE TABLE IF NOT EXISTS wc_lessons (
                lesson_id   TEXT PRIMARY KEY,
                drill_score REAL,                                -- share right first try, 0-1
                answer      TEXT NOT NULL DEFAULT '',            -- what they wrote
                done_at     TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wc_attempts (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                lesson_id  TEXT NOT NULL,
                drill      INTEGER NOT NULL,
                correct    INTEGER NOT NULL,                     -- right on the first try
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wc_writing (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                lesson_id  TEXT NOT NULL DEFAULT '',
                realm      INTEGER NOT NULL DEFAULT 0,
                prompt     TEXT NOT NULL DEFAULT '',
                text       TEXT NOT NULL,
                score      REAL,                                 -- the Editor's score out of 10
                feedback   TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wc_days (
                day          TEXT PRIMARY KEY,
                steps_json   TEXT NOT NULL DEFAULT '[]',
                done_json    TEXT NOT NULL DEFAULT '[]',
                answers_json TEXT NOT NULL DEFAULT '{}',
                completed_at TEXT,
                created_at   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wc_missions (
                week       TEXT PRIMARY KEY,                     -- ISO week, e.g. 2026-W39
                kind       TEXT NOT NULL,                        -- phrases | character | write
                target     INTEGER NOT NULL DEFAULT 1,
                done_at    TEXT,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wc_cando (
                realm      INTEGER NOT NULL,
                item       INTEGER NOT NULL,
                rating     INTEGER NOT NULL,                     -- 1 not yet … 4 easily
                rated_at   TEXT NOT NULL,
                PRIMARY KEY (realm, item, rated_at)
            );
            CREATE TABLE IF NOT EXISTS wc_placements (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                answers    TEXT NOT NULL,
                realm      INTEGER NOT NULL,
                created_at TEXT NOT NULL
            );
            """
        )


_ensure_schema()


# ── Content ──────────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def content() -> dict:
    """The realms, their cards, lessons and placement items, shipped with the app."""
    def load(name: str) -> dict:
        try:
            return json.loads((CONTENT_DIR / name).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
    realms = load("realms.json").get("realms", [])
    out = []
    for r in realms:
        data = load(f"realm_{r['id']}.json")
        out.append({**r, "cards": data.get("cards", []), "lessons": data.get("lessons", []),
                    "placement": data.get("placement", [])})
    return {"realms": out}


def _realm(n: int) -> Optional[dict]:
    return next((r for r in content()["realms"] if r["id"] == n), None)


def _lesson(lesson_id: str) -> Optional[dict]:
    for r in content()["realms"]:
        for lesson in r["lessons"]:
            if lesson.get("id") == lesson_id:
                return {**lesson, "realm": r["id"]}
    return None


def _card_defs() -> dict[str, dict]:
    return {c["id"]: {**c, "realm": r["id"]} for r in content()["realms"] for c in r["cards"]}


# ── The track ────────────────────────────────────────────────────────────────

def get_track() -> Optional[dict]:
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM wc_track WHERE id = 1").fetchone()
    if not row:
        return None
    t = dict(row)
    t["show_pace"] = bool(t["show_pace"])
    return t


def _need_track() -> dict:
    t = get_track()
    if not t:
        raise HTTPException(409, detail={"code": "not_started", "title": "Wordcraft hasn't started",
                                         "message": "Take the placement check or choose a realm to begin."})
    return t


def placement_items() -> list[dict]:
    """The placement check: every realm's items, easiest first, without the answers."""
    items = [it for r in content()["realms"] for it in r["placement"]]
    return [{k: v for k, v in it.items() if k != "answer"} for it in items]


def place(answers: dict[str, int]) -> dict:
    """
    Score the placement check. The start realm is the first realm where fewer
    than two of its three items were right; realms below it count as known.
    """
    by_realm: dict[int, list[bool]] = {}
    for r in content()["realms"]:
        for it in r["placement"]:
            given = answers.get(it["id"])
            by_realm.setdefault(r["id"], []).append(given is not None and int(given) == it["answer"])
    start = next((n for n in sorted(by_realm) if sum(by_realm[n]) < 2), max(by_realm) if by_realm else 0)
    with sess._connect() as conn:
        conn.execute("INSERT INTO wc_placements (answers, realm, created_at) VALUES (?,?,?)",
                     (json.dumps(answers), start, _iso(_now())))
    return {"realm": start, "by_realm": {str(k): sum(v) for k, v in by_realm.items()},
            "name": (_realm(start) or {}).get("name", "")}


def start(realm: int, goal: str = "everyday", now: Optional[datetime] = None) -> dict:
    """Begin (or restart) at a realm. Cards of the realms below come in as already known."""
    now = now or _now()
    if not _realm(realm):
        raise HTTPException(400, "No such realm")
    goal = goal if goal in GOALS else "everyday"
    stamp = _iso(now)
    with sess._connect() as conn:
        conn.execute(
            "INSERT INTO wc_track (id, realm, placed_at, goal, started_at, realm_at, updated_at) VALUES (1,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET realm=excluded.realm, placed_at=excluded.placed_at, goal=excluded.goal, "
            "realm_at=excluded.realm_at, updated_at=excluded.updated_at",
            (realm, realm, goal, stamp, stamp, stamp))
    seed_cards(now)
    return get_track()


def update_track(fields: dict) -> dict:
    _need_track()
    sets, vals = [], []
    if "goal" in fields and fields["goal"] in GOALS:
        sets.append("goal = ?"); vals.append(fields["goal"])
    if "show_pace" in fields:
        sets.append("show_pace = ?"); vals.append(1 if fields["show_pace"] else 0)
    if sets:
        with sess._connect() as conn:
            conn.execute(f"UPDATE wc_track SET {', '.join(sets)}, updated_at = ? WHERE id = 1", (*vals, _iso(_now())))
    return get_track()


# ── Cards ────────────────────────────────────────────────────────────────────

def _lesson_order() -> dict[str, int]:
    order = {}
    for r in content()["realms"]:
        for i, lesson in enumerate(r["lessons"]):
            for j, cid in enumerate(lesson.get("cards", [])):
                order.setdefault(cid, r["id"] * 1000 + i * 20 + j)
    return order


def seed_cards(now: Optional[datetime] = None) -> int:
    """Add every shipped card once. Cards of realms below the start realm come in as known, due for a light review."""
    now = now or _now()
    track = get_track()
    below = track["realm"] if track else 0
    order = _lesson_order()
    added = 0
    with sess._connect() as conn:
        have = {r[0] for r in conn.execute("SELECT card_id FROM wc_cards")}
        for i, (cid, c) in enumerate(sorted(_card_defs().items(), key=lambda kv: order.get(kv[0], kv[1]["realm"] * 1000 + 900))):
            if cid in have:
                continue
            known = c["realm"] < below
            conn.execute(
                "INSERT INTO wc_cards (card_id, kind, text, meaning, example, goes_with, note, job, realm, ord, known, "
                "reps, ease, interval_days, last_grade, first_seen, due, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (cid, c["kind"], c["text"], c["meaning"], c.get("example", ""), " · ".join(c.get("goes_with") or []),
                 c.get("note", ""), c.get("job", ""), c["realm"], order.get(cid, c["realm"] * 1000 + 900),
                 1 if known else 0, 2 if known else 0, 2.5, 21.0 if known else 0, 2 if known else None,
                 _iso(now) if known else None, _iso(now + timedelta(days=7 + i % 24)) if known else None, _iso(now)))
            added += 1
    return added


def add_card(text: str, meaning: str, example: str = "", kind: str = "word") -> dict:
    text, meaning = _s(text, LIMITS["text"]), _s(meaning, LIMITS["answer"])
    if not text or not meaning:
        raise HTTPException(400, "A card needs the word or phrase and what it means")
    track = _need_track()
    kind = kind if kind in ("word", "phrase", "pattern") else "word"
    with sess._connect() as conn:
        n = conn.execute("SELECT COUNT(*) FROM wc_cards WHERE card_id LIKE 'mine-%'").fetchone()[0] + 1
        if conn.execute("SELECT 1 FROM wc_cards WHERE lower(text) = lower(?)", (text,)).fetchone():
            raise HTTPException(409, detail={"code": "exists", "title": "Already a card",
                                             "message": f"\"{text}\" is already in your cards."})
        conn.execute("INSERT INTO wc_cards (card_id, kind, text, meaning, example, realm, ord, created_at) "
                     "VALUES (?,?,?,?,?,?,?,?)", (f"mine-{n}", kind, text, meaning, _s(example, LIMITS["answer"]),
                                                   track["realm"], -1, _iso(_now())))
        return dict(conn.execute("SELECT * FROM wc_cards WHERE card_id = ?", (f"mine-{n}",)).fetchone())


def list_cards(q: str = "", kind: str = "", realm: Optional[int] = None) -> list[dict]:
    sql, args = "SELECT * FROM wc_cards WHERE 1=1", []
    if q:
        sql += " AND (text LIKE ? OR meaning LIKE ?)"; args += [f"%{q}%", f"%{q}%"]
    if kind in ("word", "phrase", "pattern"):
        sql += " AND kind = ?"; args.append(kind)
    if realm is not None:
        sql += " AND realm = ?"; args.append(realm)
    with sess._connect() as conn:
        return [dict(r) for r in conn.execute(sql + " ORDER BY realm, ord, id", args)]


def _new_today(conn, now: datetime) -> int:
    start_of_day = _iso(now.replace(hour=0, minute=0, second=0))
    return conn.execute("SELECT COUNT(*) FROM wc_cards WHERE first_seen >= ? AND known = 0",
                        (start_of_day,)).fetchone()[0]


def review_queue(now: Optional[datetime] = None, limit: int = 60) -> dict:
    """Cards due now, then today's new ones: this realm's, in lesson order."""
    now = now or _now()
    track = get_track()
    realm = track["realm"] if track else 0
    with sess._connect() as conn:
        due = [dict(r) for r in conn.execute(
            "SELECT * FROM wc_cards WHERE first_seen IS NOT NULL AND due <= ? ORDER BY due LIMIT ?", (_iso(now), limit))]
        room = max(0, NEW_PER_DAY - _new_today(conn, now))
        new = [dict(r) for r in conn.execute(
            "SELECT * FROM wc_cards WHERE first_seen IS NULL AND realm <= ? ORDER BY ord, id LIMIT ?", (realm, room))] if room else []
    return {"due": due, "new": new}


def review(card_id: int, grade: int, now: Optional[datetime] = None) -> dict:
    now = now or _now()
    if grade not in GRADES:
        raise HTTPException(400, "Grade must be 0 (again) to 3 (easy)")
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM wc_cards WHERE id = ?", (card_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Card not found")
        nxt = schedule(dict(row), grade, now)
        conn.execute(
            "UPDATE wc_cards SET reps=?, lapses=?, ease=?, interval_days=?, last_grade=?, due=?, last_reviewed=?, "
            "first_seen=COALESCE(first_seen, ?) WHERE id=?",
            (nxt["reps"], nxt["lapses"], nxt["ease"], nxt["interval_days"], nxt["last_grade"], nxt["due"],
             _iso(now), _iso(now), card_id))
        return dict(conn.execute("SELECT * FROM wc_cards WHERE id = ?", (card_id,)).fetchone())


def card_stats(realm: Optional[int] = None) -> dict:
    with sess._connect() as conn:
        sql = "SELECT kind, reps, last_grade, first_seen FROM wc_cards"
        rows = [dict(r) for r in (conn.execute(sql + " WHERE realm = ?", (realm,)) if realm is not None else conn.execute(sql))]
    seen = [r for r in rows if r["first_seen"]]
    held = [r for r in seen if (r["last_grade"] or 0) >= 2 and r["reps"] >= 1]
    by_kind = {k: sum(1 for r in held if r["kind"] == k) for k in ("word", "phrase", "pattern")}
    return {"total": len(rows), "seen": len(seen), "held": len(held), "by_kind": by_kind,
            "recall": round(len(held) / len(rows), 3) if rows else 0.0}


# ── Lessons and exercises ────────────────────────────────────────────────────

def lessons_done() -> dict[str, dict]:
    with sess._connect() as conn:
        return {r["lesson_id"]: dict(r) for r in conn.execute("SELECT * FROM wc_lessons")}


def record_drills(lesson_id: str, results: list[bool], now: Optional[datetime] = None) -> float:
    """Save first-try results for a lesson's exercises; returns the share right."""
    lesson = _lesson(lesson_id)
    if not lesson:
        raise HTTPException(404, "No such lesson")
    results = [bool(r) for r in results][: len(lesson.get("drills", []))]
    stamp = _iso(now or _now())
    with sess._connect() as conn:
        for i, ok in enumerate(results):
            conn.execute("INSERT INTO wc_attempts (lesson_id, drill, correct, created_at) VALUES (?,?,?,?)",
                         (lesson_id, i, 1 if ok else 0, stamp))
    return round(sum(results) / len(results), 3) if results else 0.0


def _lesson_score(lesson_id: str) -> Optional[float]:
    """First-try share right on the lesson's most recent full run of its exercises."""
    lesson = _lesson(lesson_id)
    n = len((lesson or {}).get("drills", []))
    if not n:
        return None
    with sess._connect() as conn:
        rows = conn.execute("SELECT correct FROM wc_attempts WHERE lesson_id = ? ORDER BY id DESC LIMIT ?",
                            (lesson_id, n)).fetchall()
    return round(sum(r[0] for r in rows) / len(rows), 3) if rows else None


def mark_lesson(lesson_id: str, answer: str = "", done: bool = True) -> dict:
    if not _lesson(lesson_id):
        raise HTTPException(404, "No such lesson")
    with sess._connect() as conn:
        if done:
            conn.execute("INSERT INTO wc_lessons (lesson_id, drill_score, answer, done_at) VALUES (?,?,?,?) "
                         "ON CONFLICT(lesson_id) DO UPDATE SET drill_score=excluded.drill_score, answer=excluded.answer",
                         (lesson_id, _lesson_score(lesson_id), _s(answer, LIMITS["writing"]), _iso(_now())))
        else:
            conn.execute("DELETE FROM wc_lessons WHERE lesson_id = ?", (lesson_id,))
    return {"lesson_id": lesson_id, "done": done}


def curriculum() -> dict:
    track = get_track()
    level = track["realm"] if track else 0
    placed = track["placed_at"] if track else 0
    done = lessons_done()
    realms = []
    for r in content()["realms"]:
        lessons = [{**{k: v for k, v in l.items() if k != "drills"}, "drill_count": len(l.get("drills", [])),
                    "done": l["id"] in done, "score": (done.get(l["id"]) or {}).get("drill_score")}
                   for l in r["lessons"]]
        state = "done" if r["id"] < level else "current" if r["id"] == level else "locked"
        realms.append({**{k: v for k, v in r.items() if k not in ("cards", "lessons", "placement")},
                       "lessons": lessons, "state": state, "placed": r["id"] < placed,
                       "cards": len(r["cards"])})
    return {"realm": level, "realms": realms}


def lesson_detail(lesson_id: str) -> dict:
    """A lesson with its cards spelt out, for practising outside the daily session."""
    lesson = _lesson(lesson_id)
    if not lesson:
        raise HTTPException(404, "No such lesson")
    defs = _card_defs()
    return {**lesson, "card_list": [defs[c] for c in lesson.get("cards", []) if c in defs],
            "done": lesson_id in lessons_done(), "score": _lesson_score(lesson_id)}


# ── Writing and the Editor ───────────────────────────────────────────────────

EDITOR_PROMPT = """You are the Editor in Wordcraft, an English course. You read a learner's writing and give short, kind, useful notes.

The learner is working at CEFR level {cefr} (Wordcraft realm {realm}, "{realm_name}").
The task was: {prompt}

Judge the writing for a reader, not against a native speaker:
1. Task: did it do what was asked?
2. Organisation: is it easy to follow?
3. Range: words and sentence patterns suited to the level.
4. Accuracy that affects meaning: only mistakes that blur or change the meaning.

Rules:
- Prompt before you tell: for the one thing to change, first say what to look at, then give a better version.
- Mark at most ONE thing to change, the one that matters most for meaning. Ignore small slips that do not affect meaning.
- Never mark repeated words, hesitation markers or informal fillers as errors in a spoken-style answer.
- Praise something specific the learner did well.
- Use plain English the learner can understand at their level.

Reply with ONLY this JSON:
{{"score": <0-10, where 7 means the task is done clearly at this level>,
 "strengths": ["<specific thing done well>", "<another, optional>"],
 "focus": {{"look_at": "<what to look at, as a hint>", "quote": "<the learner's words, copied exactly>", "better": "<a better version>", "why": "<the rule or reason, one sentence>"}},
 "next": "<one short suggestion for next time>"}}
If there is nothing worth changing, set "focus" to null."""


async def check_writing(text: str, lesson_id: str = "", prompt: str = "", model: Optional[str] = None) -> dict:
    """The Editor's notes on a piece of writing: one AI call, metered like any text job."""
    from .routers.mock import _ask_model
    text = _s(text, LIMITS["writing"])
    if len(re.findall(r"[A-Za-z]+", text)) < 3:
        raise HTTPException(400, "Write a little more first: at least a sentence.")
    track = _need_track()
    lesson = _lesson(lesson_id) if lesson_id else None
    realm_n = lesson["realm"] if lesson else track["realm"]
    realm = _realm(realm_n) or {}
    task = prompt or ((lesson or {}).get("write") or {}).get("prompt") or "Write freely."
    system = EDITOR_PROMPT.format(cefr=realm.get("cefr", ""), realm=realm_n, realm_name=realm.get("name", ""),
                                  prompt=task)
    raw = await _ask_model(model, system, text, kind="wordcraft")
    feedback = clean_feedback(raw)
    with sess._connect() as conn:
        cur = conn.execute("INSERT INTO wc_writing (lesson_id, realm, prompt, text, score, feedback, created_at) "
                           "VALUES (?,?,?,?,?,?,?)", (lesson_id, realm_n, _s(task, LIMITS["answer"]), text,
                                                     feedback["score"], json.dumps(feedback), _iso(_now())))
        wid = cur.lastrowid
    return {"id": wid, **feedback}


def clean_feedback(raw: Any) -> dict:
    """Keep only the fields the app shows, with sane types, whatever the model returned."""
    raw = raw if isinstance(raw, dict) else {}
    try:
        score = max(0.0, min(10.0, float(raw.get("score"))))
    except (TypeError, ValueError):
        score = None
    strengths = [_s(s, 300) for s in (raw.get("strengths") or []) if _s(s, 300)][:3]
    focus = raw.get("focus") if isinstance(raw.get("focus"), dict) else None
    if focus:
        focus = {k: _s(focus.get(k, ""), 600) for k in ("look_at", "quote", "better", "why")}
        if not focus["better"]:
            focus = None
    return {"score": score, "strengths": strengths, "focus": focus, "next": _s(raw.get("next", ""), 300)}


def list_writing(limit: int = 30) -> list[dict]:
    with sess._connect() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM wc_writing ORDER BY id DESC LIMIT ?", (limit,))]
    for r in rows:
        r["feedback"] = json.loads(r["feedback"] or "{}")
    return rows


# ── Characters ───────────────────────────────────────────────────────────────

def character_rounds(since: Optional[str] = None) -> list[dict]:
    """Practice rounds with Wordcraft's characters, with their scores."""
    return panel_sessions(since, personas=CHARACTERS)


def _best_round(character: str, since: Optional[str] = None) -> Optional[float]:
    scores = [s["score"] for s in character_rounds(since) if s["persona"] == character and s["score"] is not None]
    return max(scores) if scores else None


def character_brief(character: str, lesson_id: str = "") -> dict:
    """What a character is told about the learner: their level and the words to use."""
    if character not in CHARACTERS:
        raise HTTPException(404, "No such character")
    track = _need_track()
    lesson = _lesson(lesson_id) if lesson_id else None
    realm = _realm(lesson["realm"] if lesson else track["realm"]) or {}
    defs = _card_defs()
    words = [defs[c]["text"] for c in (lesson or {}).get("cards", []) if c in defs]
    details = (f"The learner is at CEFR {realm.get('cefr', '')} (Wordcraft realm {realm.get('id')}: {realm.get('name', '')}). "
               f"Speak at that level: short, clear sentences and common words; explain any harder word you use. "
               f"Give them room: pauses, repeated sounds and fillers are fine and never count against them; "
               f"judge only whether their message was clear, complete and well organised.")
    if words:
        details += " Where natural, invite them to use these words and phrases: " + ", ".join(words) + "."
    if lesson and (lesson.get("speak") or {}).get("prompt"):
        details += f" Today's speaking task: {lesson['speak']['prompt']}"
    return {"scenario": character, "name": CHARACTERS[character], "subject": (lesson or {}).get("title") or realm.get("goal", ""),
            "details": details, "tone": "basic" if (realm.get("id") or 0) <= 3 else "advanced"}


# ── Missions ─────────────────────────────────────────────────────────────────

MISSIONS = {
    "phrases": "Use {target} of your recent phrases in a real conversation the app coaches.",
    "character": "Have a full conversation with a character this week.",
    "write": "Write a real message or email to someone, using one of your patterns.",
}


def _week(d: datetime) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def mission(now: Optional[datetime] = None) -> dict:
    """This week's mission, created the first time it is asked for, with progress."""
    now = now or datetime.now()
    week = _week(now)
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM wc_missions WHERE week = ?", (week,)).fetchone()
        if not row:
            n = conn.execute("SELECT COUNT(*) FROM wc_missions").fetchone()[0]
            kind = ("phrases", "character", "write")[n % 3]
            conn.execute("INSERT INTO wc_missions (week, kind, target, created_at) VALUES (?,?,?,?)",
                         (week, kind, 3 if kind == "phrases" else 1, _iso(_now())))
            row = conn.execute("SELECT * FROM wc_missions WHERE week = ?", (week,)).fetchone()
    m = dict(row)
    monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    progress, found = 0, []
    if m["kind"] == "phrases":
        found = phrases_used(_iso(monday))
        progress = len(found)
    elif m["kind"] == "character":
        progress = sum(1 for r in character_rounds(_iso(monday)) if r["answers"] >= 3)
    done = bool(m["done_at"]) or progress >= m["target"]
    if done and not m["done_at"] and m["kind"] != "write":
        with sess._connect() as conn:
            conn.execute("UPDATE wc_missions SET done_at = ? WHERE week = ?", (_iso(_now()), week))
    return {"week": week, "kind": m["kind"], "target": m["target"], "progress": min(progress, m["target"]),
            "text": MISSIONS[m["kind"]].format(target=m["target"]), "done": done, "found": found}


def finish_mission(now: Optional[datetime] = None) -> dict:
    """The learner says they did it (for the kinds the app cannot see)."""
    week = _week(now or datetime.now())
    mission(now)
    with sess._connect() as conn:
        conn.execute("UPDATE wc_missions SET done_at = COALESCE(done_at, ?) WHERE week = ?", (_iso(_now()), week))
    return mission(now)


def phrases_used(since: str) -> list[str]:
    """Phrases the learner has studied that appear in their own lines in real (not practice) sessions."""
    phrases = [c["text"] for c in list_cards(kind="phrase") if c["first_seen"] and len(c["text"]) >= 6]
    if not phrases:
        return []
    norm = {re.sub(r"[^a-z' ]", "", p.lower()).strip(): p for p in phrases}
    norm = {k: v for k, v in norm.items() if len(k.split()) >= 2}
    used: list[str] = []
    with sess._connect() as conn:
        rows = conn.execute("SELECT id, tags FROM sessions WHERE created_at >= ?", (since,)).fetchall()
        for r in rows:
            if "mock" in (r["tags"] or "").split(","):
                continue
            text = " ".join(m[0] or "" for m in conn.execute(
                "SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND speaker IN ('user','you')", (r["id"],)))
            flat = re.sub(r"[^a-z' ]", " ", text.lower())
            flat = re.sub(r"\s+", " ", flat)
            for key, phrase in norm.items():
                if phrase not in used and f" {key} " in f" {flat} ":
                    used.append(phrase)
    return used


# ── Exit, levelling up, skills ───────────────────────────────────────────────

def exit_status(realm_n: int) -> dict:
    realm = _realm(realm_n) or {}
    track = get_track()
    since = track["realm_at"] if track else None
    ex = realm.get("exit") or {}
    stats = card_stats(realm_n)
    done = lessons_done()
    lessons = realm.get("lessons", [])
    scores = [s for s in (_lesson_score(l["id"]) for l in lessons) if s is not None]
    drill = round(sum(scores) / len(scores), 3) if scores else None
    checks = [
        {"id": "lessons", "label": f"Finish all {len(lessons)} lessons",
         "value": f"{sum(1 for l in lessons if l['id'] in done)} of {len(lessons)}",
         "met": bool(lessons) and all(l["id"] in done for l in lessons)},
        {"id": "recall", "label": f"Hold {round(RECALL_PASS * 100)}% of the realm's {stats['total']} cards",
         "value": f"{round(stats['recall'] * 100)}%", "met": stats["total"] > 0 and stats["recall"] >= RECALL_PASS},
        {"id": "drills", "label": f"Get {round(DRILL_PASS * 100)}% of the exercises right first time",
         "value": f"{round(drill * 100)}%" if drill is not None else "Not yet", "met": drill is not None and drill >= DRILL_PASS},
    ]
    character = ex.get("character")
    if character:
        best = _best_round(character, since)
        checks.append({"id": "talk", "label": f"Score {PASS_SCORE:g}/10 or more talking with {CHARACTERS.get(character, character)}",
                       "value": f"{best}/10" if best is not None else "Not yet", "met": best is not None and best >= PASS_SCORE,
                       "character": character})
    if ex.get("writing"):
        with sess._connect() as conn:
            best_w = conn.execute("SELECT MAX(score) FROM wc_writing WHERE realm = ? AND created_at >= ?",
                                  (realm_n, since or "")).fetchone()[0]
        checks.append({"id": "writing", "label": f"A written piece the Editor scores {PASS_SCORE:g}/10 or more",
                       "value": f"{best_w:g}/10" if best_w is not None else "Not yet",
                       "met": best_w is not None and best_w >= PASS_SCORE})
    return {"realm": realm_n, "exit": ex, "checks": checks, "passed": all(c["met"] for c in checks),
            "lessons_done": sum(1 for l in lessons if l["id"] in done), "lessons_total": len(lessons)}


def advance() -> dict:
    track = _need_track()
    status = exit_status(track["realm"])
    if not status["passed"]:
        raise HTTPException(409, detail={"code": "exit_not_met", "title": "Not yet",
                                         "message": "Pass every part of this realm's exit first."})
    if track["realm"] >= len(content()["realms"]) - 1:
        raise HTTPException(409, detail={"code": "top", "title": "You've reached the top",
                                         "message": "The Grand Hall is the last realm. Keep practising to stay sharp."})
    now = _iso(_now())
    with sess._connect() as conn:
        conn.execute("UPDATE wc_track SET realm = realm + 1, realm_at = ?, updated_at = ? WHERE id = 1", (now, now))
    return get_track()


def skills() -> list[dict]:
    """Each pillar scored 0-4 from evidence: lessons done in it, exercises, writing and conversations."""
    done = lessons_done()
    out = []
    for p in PILLARS:
        ls = [l for r in content()["realms"] for l in r["lessons"] if l.get("pillar") == p]
        mine = [l for l in ls if l["id"] in done]
        scores = [s for s in (_lesson_score(l["id"]) for l in mine) if s is not None]
        acc = sum(scores) / len(scores) if scores else 0
        score = 0
        if mine:
            score = 1
        if len(mine) >= 2 and acc >= 0.6:
            score = 2
        if len(mine) >= 4 and acc >= 0.8:
            score = 3
        if len(mine) >= 8 and acc >= 0.9:
            score = 4
        out.append({"id": p, "lessons_done": len(mine), "lessons_total": len(ls),
                    "accuracy": round(acc, 2) if scores else None, "score": score})
    rounds = [r for r in character_rounds() if r["score"] is not None]
    writing = [w for w in list_writing(200) if w["score"] is not None]
    for s in out:
        if s["id"] == "speaking" and rounds:
            s["score"] = max(s["score"], 3 if max(r["score"] for r in rounds) >= PASS_SCORE else 2)
        if s["id"] == "communicating" and writing:
            s["score"] = max(s["score"], 3 if max(w["score"] for w in writing) >= PASS_SCORE else 2)
    return out


# ── Progress: trends measured locally ────────────────────────────────────────

def mtld(text: str, threshold: float = 0.72) -> Optional[float]:
    """Measure of Textual Lexical Diversity (McCarthy & Jarvis, 2010), averaged both ways."""
    tokens = re.findall(r"[a-z']+", text.lower())
    if len(tokens) < 50:
        return None

    def one_way(words: list[str]) -> float:
        factors, types, count = 0.0, set(), 0
        for w in words:
            count += 1
            types.add(w)
            if len(types) / count <= threshold:
                factors += 1
                types, count = set(), 0
        if count:
            ttr = len(types) / count
            factors += (1 - ttr) / (1 - threshold) if ttr < 1 else 0
        return len(words) / factors if factors else float(len(words))

    return round((one_way(tokens) + one_way(tokens[::-1])) / 2, 1)


SUBORDINATORS = re.compile(r"\b(because|although|though|while|whereas|when|whenever|if|unless|since|so that|"
                           r"which|who|whom|whose|that|where|after|before|until|as soon as|even though)\b", re.I)


def text_measures(text: str) -> dict:
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if re.search(r"[A-Za-z]", s)]
    words = re.findall(r"[A-Za-z']+", text)
    joins = len(SUBORDINATORS.findall(text))
    return {"words": len(words), "sentences": len(sentences),
            "words_per_sentence": round(len(words) / len(sentences), 1) if sentences else None,
            "joins_per_sentence": round(joins / len(sentences), 2) if sentences else None,
            "mtld": mtld(text)}


def rate_cando(realm_n: int, ratings: list[int]) -> dict:
    realm = _realm(realm_n)
    if not realm:
        raise HTTPException(404, "No such realm")
    stamp = _iso(_now())
    with sess._connect() as conn:
        for i, r in enumerate(ratings[: len(realm["can_do"])]):
            conn.execute("INSERT OR REPLACE INTO wc_cando (realm, item, rating, rated_at) VALUES (?,?,?,?)",
                         (realm_n, i, max(1, min(4, int(r))), stamp))
    return progress()


def progress() -> dict:
    track = get_track()
    stats = card_stats()
    writing = list(reversed(list_writing(200)))
    trend = [{"date": w["created_at"][:10], "score": w["score"], **text_measures(w["text"])} for w in writing]
    with sess._connect() as conn:
        cando_rows = conn.execute("SELECT realm, item, rating, rated_at FROM wc_cando ORDER BY rated_at").fetchall()
        days = conn.execute("SELECT COUNT(*) FROM wc_days WHERE completed_at IS NOT NULL").fetchone()[0]
        attempts = conn.execute("SELECT COUNT(*), SUM(correct) FROM wc_attempts").fetchone()
    latest: dict[tuple[int, int], int] = {}
    for r in cando_rows:
        latest[(r["realm"], r["item"])] = r["rating"]
    cando = []
    for realm in content()["realms"]:
        items = [{"text": t, "rating": latest.get((realm["id"], i))} for i, t in enumerate(realm["can_do"])]
        cando.append({"realm": realm["id"], "name": realm["name"], "items": items})
    return {"track": track, "cards": stats, "days": days, "streak": streak(),
            "exercises": {"done": attempts[0] or 0, "right": attempts[1] or 0},
            "writing": trend[-20:], "skills": skills(), "cando": cando,
            "rounds": [r for r in character_rounds() if r["score"] is not None][:20]}


# ── The daily session ────────────────────────────────────────────────────────

def _day(local: Optional[datetime] = None) -> str:
    return (local or datetime.now()).date().isoformat()


def _next_lesson(skip: tuple = ()) -> Optional[dict]:
    track = _need_track()
    done = lessons_done()
    realm = _realm(track["realm"]) or {}
    return next((l for l in realm.get("lessons", []) if l["id"] not in done and l["id"] not in skip), None)


def _lesson_step_ids(lesson: dict) -> list[str]:
    return [f"lesson:{lesson['id']}:{part}" for part in LESSON_STEPS]


def _planned_lessons(steps: list[str]) -> tuple:
    return tuple(dict.fromkeys(s.split(":")[1] for s in steps if s.startswith("lesson:")))


def _plan(now: datetime, local: Optional[datetime]) -> list[str]:
    steps: list[str] = []
    queue = review_queue(now)
    if queue["due"] or queue["new"]:
        steps.append("cards")
    lesson = _next_lesson()
    if lesson:
        steps += _lesson_step_ids(lesson)
    m = mission(local)
    if not m["done"]:
        with sess._connect() as conn:
            week_days = [r[0] for r in conn.execute("SELECT steps_json FROM wc_days WHERE day >= ?",
                                                    (_monday(local).isoformat(),))]
        if not any("mission" in json.loads(s) for s in week_days):
            steps.append("mission")
    if not lesson:
        steps.append("exit")
    return steps


def _monday(local: Optional[datetime]):
    d = (local or datetime.now()).date()
    return d - timedelta(days=d.weekday())


def _day_row(key: str) -> Optional[dict]:
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM wc_days WHERE day = ?", (key,)).fetchone()
    if not row:
        return None
    return {"day": row["day"], "steps": json.loads(row["steps_json"]), "done": json.loads(row["done_json"]),
            "answers": json.loads(row["answers_json"]), "completed_at": row["completed_at"]}


def _save_day(day: dict) -> None:
    complete = bool(day["steps"]) and all(s in day["done"] for s in day["steps"])
    completed_at = (day.get("completed_at") or _iso(_now())) if complete else None
    with sess._connect() as conn:
        conn.execute(
            "INSERT INTO wc_days (day, steps_json, done_json, answers_json, completed_at, created_at) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(day) DO UPDATE SET steps_json=excluded.steps_json, done_json=excluded.done_json, "
            "answers_json=excluded.answers_json, completed_at=excluded.completed_at",
            (day["day"], json.dumps(day["steps"]), json.dumps(day["done"]), json.dumps(day["answers"]),
             completed_at, _iso(_now())))


def streak(local: Optional[datetime] = None) -> int:
    """Days in a row with a finished session. One missed day a week is forgiven, so a rest day keeps the streak."""
    with sess._connect() as conn:
        days = {r[0] for r in conn.execute("SELECT day FROM wc_days WHERE completed_at IS NOT NULL")}
    d = (local or datetime.now()).date()
    if d.isoformat() not in days:
        d -= timedelta(days=1)
    count, rested_week = 0, None
    while True:
        if d.isoformat() in days:
            count += 1
        else:
            week = d.isocalendar()[:2]
            prev = d - timedelta(days=1)
            if count and rested_week != week and prev.isoformat() in days:
                rested_week = week          # a rest day: skip it without breaking the run
            else:
                break
        d -= timedelta(days=1)
    return count


def _step(step_id: str, day: dict, now: datetime, local: Optional[datetime]) -> dict:
    out: dict[str, Any] = {"id": step_id, "done": step_id in day["done"]}
    if step_id == "cards":
        q = review_queue(now)
        out.update(kind="cards", title="Words", minutes=10, due=len(q["due"]), new=len(q["new"]))
    elif step_id.startswith("lesson:"):
        _, lesson_id, part = step_id.split(":")
        lesson = _lesson(lesson_id) or {}
        realm = _realm(lesson.get("realm", 0)) or {}
        out.update(kind=f"wc_{part}", title=STEP_TITLES[part], answer=day["answers"].get(lesson_id, ""),
                   lesson={k: lesson.get(k) for k in ("id", "title", "minutes", "pillar", "why", "rule", "passage",
                                                      "write", "speak", "check", "realm")},
                   realm={"id": realm.get("id"), "name": realm.get("name"), "cefr": realm.get("cefr")})
        if part == "intro":
            defs = _card_defs()
            out["cards"] = [defs[c] for c in lesson.get("cards", []) if c in defs]
        if part == "drills":
            out["drills"] = lesson.get("drills", [])
        if part == "write":
            out["editor"] = lesson.get("realm", 0) >= 2
    elif step_id == "mission":
        out.update(kind="mission", title="This week's mission", mission=mission(local))
    elif step_id == "exit":
        out.update(kind="exit", title="Realm exit", exit=exit_status(_need_track()["realm"]))
    else:
        out.update(kind="unknown", title=step_id)
    return out


def session(now: Optional[datetime] = None, local: Optional[datetime] = None) -> dict:
    now = now or _now()
    track = _need_track()
    with sess._connect() as conn:
        have = conn.execute("SELECT COUNT(*) FROM wc_cards WHERE card_id NOT LIKE 'mine-%'").fetchone()[0]
    if have < len(_card_defs()):          # content added since this install started
        seed_cards(now)
    key = _day(local)
    day = _day_row(key)
    if not day:
        day = {"day": key, "steps": _plan(now, local), "done": [], "answers": {}, "completed_at": None}
        _save_day(day)
    steps = [_step(s, day, now, local) for s in day["steps"]]
    status = exit_status(track["realm"])
    realm = _realm(track["realm"]) or {}
    upcoming = _next_lesson(_planned_lessons(day["steps"]))
    minutes = sum(int((s.get("lesson") or {}).get("minutes") or 0) for s in steps if s["kind"] == "wc_intro")
    minutes += 10 if any(s["kind"] == "cards" for s in steps) else 0
    return {
        "day": key, "steps": steps,
        "current": next((i for i, s in enumerate(steps) if not s["done"]), None),
        "complete": bool(steps) and all(s["done"] for s in steps),
        "started": bool(day["done"]), "minutes": minutes, "streak": streak(local),
        "level": {"id": track["realm"], "name": realm.get("name", ""), "cefr": realm.get("cefr", ""),
                  "lessons_done": status["lessons_done"], "lessons_total": status["lessons_total"],
                  "exit_passed": status["passed"], "levels": len(content()["realms"])},
        "next_lesson": {"id": upcoming["id"], "title": upcoming["title"], "minutes": upcoming.get("minutes")} if upcoming else None,
    }


def session_step(step_id: str, answer: Optional[str] = None, done: bool = True, results: Optional[list] = None,
                 now: Optional[datetime] = None, local: Optional[datetime] = None) -> dict:
    """Finish a step. Exercises send their first-try results; writing sends its text; a check can say "not yet"."""
    day = _day_row(_day(local))
    if not day or step_id not in day["steps"]:
        raise HTTPException(404, "That step is not in today's session")
    if step_id.startswith("lesson:"):
        _, lesson_id, part = step_id.split(":")
        if answer is not None:
            day["answers"][lesson_id] = _s(answer, LIMITS["writing"])
        if part == "drills" and results is not None and done:
            record_drills(lesson_id, results, now)
        if part == "check" and done:
            mark_lesson(lesson_id, day["answers"].get(lesson_id, ""))
        if part == "check" and not done:
            again = {f"lesson:{lesson_id}:{p}" for p in ("read", "drills", "speak")}
            day["done"] = [s for s in day["done"] if s not in again]
    if step_id == "mission" and done:
        m = mission(local)
        if m["kind"] == "write":
            finish_mission(local)
    if done and step_id not in day["done"]:
        day["done"].append(step_id)
    _save_day(day)
    return session(now, local)


def session_more(now: Optional[datetime] = None, local: Optional[datetime] = None) -> dict:
    session(now, local)
    day = _day_row(_day(local))
    lesson = _next_lesson(_planned_lessons(day["steps"]))
    if lesson:
        day["steps"] += _lesson_step_ids(lesson)
    elif "exit" not in day["steps"]:
        day["steps"].append("exit")
    else:
        raise HTTPException(409, detail={"code": "nothing_left", "title": "Nothing left today",
                                         "message": "Every lesson in this realm is done. Pass the exit to open the next realm."})
    _save_day(day)
    return session(now, local)


# ── Milestones and activity ──────────────────────────────────────────────────

def _earned_milestones() -> list[dict]:
    track = get_track()
    if not track:
        return []
    done = lessons_done()
    realms = content()["realms"]
    total = sum(len(r["lessons"]) for r in realms)
    out = ms.counted("lessons", "lesson", len(done), ms.LESSON_COUNTS,
                     lambda n: "First lesson done" if n == 1 else f"{n} lessons done",
                     lambda n: "Your first Wordcraft lesson, start to finish." if n == 1 else f"{n} Wordcraft lessons finished.")
    if total and len(done) >= total:
        out.append(ms.milestone("lessons:all", "lesson", "Every lesson done",
                                f"All {total} lessons, from first words to the Grand Hall.", big=True))
    for r in realms:
        if track["placed_at"] < r["id"] <= track["realm"]:
            out.append(ms.milestone(f"realm:{r['id']}", "level", f"Welcome to {r.get('name', '')}",
                                    f"Realm {r['id']} is open: CEFR {r.get('cefr', '')}. New words, new characters.", big=True))
    if exit_status(track["realm"])["passed"] and track["realm"] < len(realms) - 1:
        out.append(ms.milestone(f"exit:{track['realm']}", "exit", "Realm exit passed",
                                "Every part of this realm's exit is met. Sail on to the next realm when you're ready."))
    held = card_stats()["held"]
    out += ms.counted("cards", "cards", held, (25, 50, 100, 200, 300), lambda n: f"{n} cards held",
                      lambda n: f"{n} words, phrases and patterns you remember.")
    if any((l.get("drill_score") or 0) >= 1 for l in done.values()):
        out.append(ms.milestone("perfect:1", "skill", "Perfect lesson", "Every exercise right on the first try."))
    if any((w["score"] or 0) >= PASS_SCORE for w in list_writing(200)):
        out.append(ms.milestone("writing:pass", "skill", "The Editor approves",
                                f"A piece of writing scored {PASS_SCORE:g}/10 or more."))
    if any((r["score"] or 0) >= PASS_SCORE for r in character_rounds()):
        out.append(ms.milestone("talk:pass", "skill", "Conversation passed",
                                f"A character round scored {PASS_SCORE:g}/10 or more."))
    with sess._connect() as conn:
        missions = conn.execute("SELECT COUNT(*) FROM wc_missions WHERE done_at IS NOT NULL").fetchone()[0]
    out += ms.counted("missions", "mission", missions, (1, 5, 10),
                      lambda n: "First mission" if n == 1 else f"{n} missions",
                      lambda n: "You took your English out into the real world." if n == 1 else f"{n} weekly missions done.")
    act = activity()
    out += ms.streak_milestones(act["best_streak"])
    out += ms.day_milestones(act["days_finished"])
    return out


def milestones() -> dict:
    """Milestones waiting to be celebrated, and every one reached so far."""
    return {"pending": ms.pending("wordcraft", _earned_milestones()), "earned": ms.earned("wordcraft")}


def milestones_seen(keys: list[str]) -> dict:
    return ms.mark_seen("wordcraft", keys)


def activity(local: Optional[datetime] = None) -> dict:
    """The calendar, weekly lessons and the climb, first-try accuracy by week, and each realm's lessons."""
    done = lessons_done()
    out = ms.activity("wc_days", [l["done_at"] for l in done.values()], streak(local), local)
    track = get_track()
    realm_now = track["realm"] if track else 0
    placed = track["placed_at"] if track else 0
    out["levels"] = [{"id": r["id"], "name": r.get("name", ""), "cefr": r.get("cefr", ""),
                      "done": sum(1 for l in r["lessons"] if l["id"] in done), "total": len(r["lessons"]),
                      "state": "done" if r["id"] < realm_now else "current" if r["id"] == realm_now else "locked",
                      "skipped": r["id"] < placed}
                     for r in content()["realms"]]
    with sess._connect() as conn:
        rows = conn.execute("SELECT correct, created_at FROM wc_attempts WHERE created_at >= ?",
                            (_iso(_now() - timedelta(weeks=13)),)).fetchall()
    by_week: dict[str, list[int]] = {w["week"]: [0, 0] for w in out["weeks"]}
    for r in rows:
        d = datetime.fromisoformat(ms.local_day(r["created_at"]))
        wk = (d - timedelta(days=d.weekday())).date().isoformat()
        if wk in by_week:
            by_week[wk][0] += 1
            by_week[wk][1] += r["correct"]
    for w in out["weeks"]:
        n, right = by_week[w["week"]]
        w["exercises"], w["accuracy"] = n, round(right / n, 3) if n else None
    return out


def activity_day(day: str) -> dict:
    """One day of the calendar in full: its steps, lessons finished, character rounds and writing."""
    labels = {"cards": "Word cards", "mission": "This week's mission", "exit": "Realm exit"}
    out = ms.day_detail("wc_days", day, _lesson, labels, lessons_done(), character_rounds(), CHARACTERS)
    out["writing"] = [{"id": w["id"], "score": w["score"], "words": len(re.findall(r"[A-Za-z']+", w["text"])),
                       "lesson_id": w["lesson_id"]}
                      for w in list_writing(200) if ms.local_day(w["created_at"]) == day]
    return out
