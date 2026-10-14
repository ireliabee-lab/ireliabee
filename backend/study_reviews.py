"""
Study mode, phase S1: questions from "Check my understanding" come back for review.

Every question a reader answers in a notebook becomes a study card, with the
paragraph it was about and the points a good answer has. It comes back on the
spaced-repetition schedule Wordcraft and the Research Track already use
(`research_track.schedule`, SM-2): a missed answer in ten minutes, a good one
in a day, then longer each time. Scheduling is plain code: no AI, no credits.
Marking a review answer is the same AI call as marking it the first time.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException

from . import notebook  # also sets up the notebooks table this joins
from .core import sessions as sess
from .research_track import schedule

#: Reviews shown per day at most, so a backlog never feels like a wall (docs/study-mode.md).
DAILY_LIMIT = 20


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def grade_for(score: int) -> int:
    """A marking score (0-100) as a review grade: 0 again, 1 hard, 2 good, 3 easy."""
    if score < 50:
        return 0
    if score < 70:
        return 1
    if score < 90:
        return 2
    return 3


def _ensure_schema() -> None:
    with sess._connect() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS study_cards (
                   id            INTEGER PRIMARY KEY AUTOINCREMENT,
                   notebook_id   INTEGER NOT NULL,
                   document_id   INTEGER,
                   paragraph     TEXT NOT NULL,          -- what the question is about, for marking
                   src           TEXT NOT NULL DEFAULT '[]',  -- source pages, JSON
                   question      TEXT NOT NULL,
                   points        TEXT NOT NULL,          -- JSON list: what a good answer contains
                   reps          INTEGER NOT NULL DEFAULT 0,
                   lapses        INTEGER NOT NULL DEFAULT 0,
                   ease          REAL NOT NULL DEFAULT 2.5,
                   interval_days REAL NOT NULL DEFAULT 0,
                   last_grade    INTEGER,
                   last_score    INTEGER,
                   due           TEXT NOT NULL,
                   last_reviewed TEXT,
                   created_at    TEXT NOT NULL,
                   UNIQUE (notebook_id, question)
               )"""
        )
        conn.execute("CREATE INDEX IF NOT EXISTS study_cards_due ON study_cards (due)")
        # One row per answer (first answers and reviews), for Progress: no text, just when and how well.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS study_review_log (
                   id          INTEGER PRIMARY KEY AUTOINCREMENT,
                   card_id     INTEGER NOT NULL,
                   notebook_id INTEGER NOT NULL,
                   score       INTEGER NOT NULL,
                   at          TEXT NOT NULL
               )"""
        )


_ensure_schema()


def _out(row) -> dict:
    d = dict(row)
    d["src"] = json.loads(d.get("src") or "[]")
    d["points"] = json.loads(d.get("points") or "[]")
    return d


def add(notebook_id: int, paragraph: str, question: str, points: list[str], score: int,
        src: Optional[list[int]] = None, document_id: Optional[int] = None, now: Optional[datetime] = None) -> dict:
    """Keep a just-marked question for review, scheduled from that first answer.
    Answering the same question again in the same notebook reschedules the one card."""
    now = now or _now()
    paragraph, question = (paragraph or "").strip()[:2000], (question or "").strip()[:400]
    points = [str(p).strip()[:300] for p in (points or []) if str(p).strip()][:4]
    if not paragraph or not question or not points:
        raise HTTPException(400, detail={"code": "invalid", "title": "Nothing to keep",
                                         "message": "Answer a question first, then it can come back for review."})
    score = max(0, min(100, int(score)))
    with sess._connect() as conn:
        if not conn.execute("SELECT 1 FROM notebooks WHERE id = ?", (notebook_id,)).fetchone():
            raise HTTPException(404, "Notebook not found")
        row = conn.execute("SELECT * FROM study_cards WHERE notebook_id = ? AND question = ?",
                           (notebook_id, question)).fetchone()
        if row:
            card_id = row["id"]
        else:
            card_id = conn.execute(
                "INSERT INTO study_cards (notebook_id, document_id, paragraph, src, question, points, due, created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (notebook_id, document_id, paragraph, json.dumps([p for p in (src or []) if isinstance(p, int)][:5]),
                 question, json.dumps(points), _iso(now), _iso(now))).lastrowid
    return review(card_id, score, now)


def review(card_id: int, score: int, now: Optional[datetime] = None) -> dict:
    """Record an answer's marking score and schedule the next review."""
    now = now or _now()
    score = max(0, min(100, int(score)))
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM study_cards WHERE id = ?", (card_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Study card not found")
        nxt = schedule(dict(row), grade_for(score), now)
        conn.execute(
            "UPDATE study_cards SET reps=?, lapses=?, ease=?, interval_days=?, last_grade=?, last_score=?, due=?, "
            "last_reviewed=? WHERE id=?",
            (nxt["reps"], nxt["lapses"], nxt["ease"], nxt["interval_days"], nxt["last_grade"], score, nxt["due"],
             _iso(now), card_id))
        conn.execute("INSERT INTO study_review_log (card_id, notebook_id, score, at) VALUES (?,?,?,?)",
                     (card_id, row["notebook_id"], score, _iso(now)))
        return _out(conn.execute("SELECT * FROM study_cards WHERE id = ?", (card_id,)).fetchone())


def progress(now: Optional[datetime] = None) -> dict:
    """For Progress: every answer's date and score, and how many questions are due now."""
    now = now or _now()
    with sess._connect() as conn:
        log = [dict(r) for r in conn.execute("SELECT score, at FROM study_review_log ORDER BY id")]
        due_now = conn.execute("SELECT COUNT(*) FROM study_cards WHERE due <= ?", (_iso(now),)).fetchone()[0]
        cards = conn.execute("SELECT COUNT(*) FROM study_cards").fetchone()[0]
    return {"answers": [{"date": r["at"], "score": r["score"]} for r in log], "due": due_now, "cards": cards}


def due(now: Optional[datetime] = None, limit: int = DAILY_LIMIT, notebook_id: Optional[int] = None) -> dict:
    """Cards due now (oldest first, at most `limit`), how many are due in all, and their notebooks' titles."""
    now = now or _now()
    where, args = "c.due <= ?", [_iso(now)]
    if notebook_id is not None:
        where += " AND c.notebook_id = ?"
        args.append(notebook_id)
    with sess._connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM study_cards c WHERE {where}", args).fetchone()[0]
        rows = conn.execute(
            f"SELECT c.*, n.title AS notebook_title FROM study_cards c JOIN notebooks n ON n.id = c.notebook_id "
            f"WHERE {where} ORDER BY c.due LIMIT ?", [*args, max(1, min(limit, 200))]).fetchall()
        cards = conn.execute("SELECT COUNT(*) FROM study_cards").fetchone()[0]
    return {"cards": [_out(r) for r in rows], "due": total, "total": cards}


def remove(card_id: int) -> dict:
    with sess._connect() as conn:
        if not conn.execute("DELETE FROM study_cards WHERE id = ?", (card_id,)).rowcount:
            raise HTTPException(404, "Study card not found")
    return {"ok": True}


def forget_notebook(notebook_id: int) -> None:
    """A deleted notebook takes its study cards with it."""
    with sess._connect() as conn:
        conn.execute("DELETE FROM study_cards WHERE notebook_id = ?", (notebook_id,))
        conn.execute("DELETE FROM study_chapters WHERE notebook_id = ?", (notebook_id,))
        conn.execute("DELETE FROM study_review_log WHERE notebook_id = ?", (notebook_id,))


# ── S2: Study a chapter — questions to read for, made once per chapter ───────

CHAPTER_QUESTIONS_PROMPT = """You write the questions a reader should read a chapter of their notes to answer, as JSON only.
The reader is {level}. You get the chapter's TITLE and its numbered NOTES, each with the source pages it came from.

- 3 to 5 questions, in the order the chapter answers them. Each asks about a main idea or its reasoning:
  "why", "how", "what is the difference between", "what would happen if". One sentence each. No yes/no questions.
- Every question must be answerable from the NOTES alone. Never ask about anything they do not say.
- "points": the 2 to 4 things a good answer contains, each one short sentence, taken from the NOTES.
- "notes": the numbers of the notes the question draws on.

Return ONLY: {{"questions": [{{"question": "...", "points": ["...", "..."], "notes": [1, 2]}}]}}"""

#: Notes from a chapter sent to make its questions, and how long each may be.
CHAPTER_NOTES = 40
CHAPTER_NOTE_CHARS = 500


def _ensure_chapter_schema() -> None:
    with sess._connect() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS study_chapters (
                   notebook_id INTEGER NOT NULL,
                   section_id  TEXT NOT NULL,
                   level       TEXT NOT NULL,
                   questions   TEXT NOT NULL,      -- JSON [{question, points, src, paragraph}]
                   created_at  TEXT NOT NULL,
                   PRIMARY KEY (notebook_id, section_id, level)
               )"""
        )


_ensure_chapter_schema()


def chapter_notes(notebook_id: int, section_id: str) -> tuple[dict, list[dict]]:
    """The chapter (section) and its notes that carry text: [{text, src}]."""
    doc = notebook.get_notebook(notebook_id).get("doc") or {}
    section = next((s for s in doc.get("sections") or [] if s.get("id") == section_id), None)
    if not section:
        raise HTTPException(404, detail={"code": "invalid", "title": "Chapter not found",
                                         "message": "Turn to the chapter you want to study and try again."})
    notes = [{"text": str(b.get("text") or "").strip()[:CHAPTER_NOTE_CHARS],
              "src": [p for p in b.get("src") or [] if isinstance(p, int)]}
             for b in section.get("blocks") or [] if b.get("type") != "image" and str(b.get("text") or "").strip()]
    return section, notes[:CHAPTER_NOTES]


def clean_chapter_questions(raw: Any, notes: list[dict]) -> list[dict]:
    """The model's questions kept to shape: up to 5, each with points, the pages of the
    notes it used, and those notes' text as the paragraph it is marked against."""
    raw = raw if isinstance(raw, dict) else {}
    out = []
    for q in (raw.get("questions") or [])[:5]:
        if not isinstance(q, dict):
            continue
        question = str(q.get("question") or "").strip()[:400]
        points = [str(p).strip()[:300] for p in q.get("points") or [] if str(p).strip()][:4]
        if not question or not points:
            continue
        used = [n for n in q.get("notes") or [] if isinstance(n, int) and 1 <= n <= len(notes)]
        used = used or list(range(1, len(notes) + 1))
        src = sorted({p for n in used for p in notes[n - 1]["src"]})[:5]
        paragraph = "\n".join(notes[n - 1]["text"] for n in used)[:2000]
        out.append({"question": question, "points": points, "src": src, "paragraph": paragraph})
    return out


async def chapter_questions(notebook_id: int, section_id: str, level: str = "some", model: Optional[str] = None,
                            fallback_credits: bool = False) -> dict:
    """3-5 questions to read the chapter for. Made once per chapter and level, then kept."""
    from . import reading
    from .errors import FriendlyError
    from .core.providers import metering_context, fallback_credits_context, is_fallback_credits
    level = level if level in reading.LEVELS else reading.DEFAULT_LEVEL
    section, notes = chapter_notes(notebook_id, section_id)
    title = section.get("title") or ""
    with sess._connect() as conn:
        row = conn.execute("SELECT questions FROM study_chapters WHERE notebook_id=? AND section_id=? AND level=?",
                           (notebook_id, section_id, level)).fetchone()
    if row:
        return {"title": title, "questions": json.loads(row["questions"]), "cached": True}
    if len(notes) < 2:
        raise HTTPException(400, detail={"code": "invalid", "title": "Too little to study",
                                         "message": "This chapter has too few notes to make questions from."})
    numbered = "\n".join(f"{i + 1}. {n['text']}" + (f" [p. {', '.join(map(str, n['src']))}]" if n["src"] else "")
                         for i, n in enumerate(notes))
    message = f"TITLE\n{title}\n\nNOTES\n{numbered}"
    document_id = int(notebook.get_notebook(notebook_id).get("document_id") or 0)
    try:
        with metering_context("reading"), fallback_credits_context(fallback_credits or is_fallback_credits()):
            raw = await reading._ask(model, CHAPTER_QUESTIONS_PROMPT.format(level=reading.LEVELS[level])
                                     + reading.languages.json_block(None), message, document_id,
                                     kind="study_questions")
    except FriendlyError as fe:
        raise fe.http()
    questions = clean_chapter_questions(raw, notes)
    if len(questions) < 2:
        raise HTTPException(502, detail={"code": "unknown", "title": "No questions came back",
                                         "message": "Try again in a moment."})
    with sess._connect() as conn:
        conn.execute("INSERT OR REPLACE INTO study_chapters (notebook_id, section_id, level, questions, created_at) "
                     "VALUES (?,?,?,?,?)", (notebook_id, section_id, level, json.dumps(questions), _iso(_now())))
    return {"title": title, "questions": questions, "cached": False}


# ── S3: Explain it twice — to an expert, then to a beginner ──────────────────

EXPLAIN_TWICE_PROMPT = """You coach a reader who explained the same chapter twice: once to an EXPERT colleague, once to a BEGINNER.
Judge both against the chapter's NOTES, as JSON only. Be kind, direct and specific.

For each explanation:
- "accurate": 0-100, how well it matches the NOTES. List up to 3 important points it "missed" (short phrases from the NOTES).
  Anything it says that the NOTES contradict goes in "wrong" as {{"said": "...", "fix": "..."}}.
- "bluf": true if the first sentence already gives the main point (bottom line up front).
- "note": one sentence on the single most useful thing to change.
For the BEGINNER explanation also:
- "plain": 0-100, how easy it is for someone new to the subject.
- "analogy": true if it uses an everyday comparison or example.
- "unexplained": technical terms it uses without saying what they mean (at most 5).

Never comment on fluency, pauses, repetition or stuttering. Judge only the content and how it is organised.
Never invent facts the NOTES do not contain.

Return ONLY: {{"expert": {{"accurate": 0, "missed": [], "wrong": [], "bluf": false, "note": ""}},
"beginner": {{"accurate": 0, "plain": 0, "analogy": false, "unexplained": [], "missed": [], "wrong": [], "bluf": false, "note": ""}}}}"""


def delivery(text: str) -> dict:
    """Counted, not judged (no AI): words, filler words and hedges. Repetitions are never counted."""
    from .confidence import FILLERS, HEDGES
    words = len(re.findall(r"[\w'’-]+", text or ""))
    fillers = [m.group(0).lower() for m in FILLERS.finditer(text or "")]
    hedges = [m.group(0).lower() for m in HEDGES.finditer(text or "")]
    sentences = [s for s in re.split(r"[.!?]+\s", (text or "").strip()) if s.strip()]
    return {"words": words, "fillers": len(fillers), "hedges": len(hedges),
            "examples": sorted(set(fillers + hedges))[:5],
            "avg_sentence_words": round(words / len(sentences), 1) if sentences else 0}


def _clean_side(raw: Any, beginner: bool) -> dict:
    raw = raw if isinstance(raw, dict) else {}

    def pct(v: Any) -> int:
        try:
            return max(0, min(100, int(v)))
        except (TypeError, ValueError):
            return 0

    out = {"accurate": pct(raw.get("accurate")), "bluf": bool(raw.get("bluf")),
           "missed": [str(m).strip()[:200] for m in raw.get("missed") or [] if str(m).strip()][:3],
           "wrong": [{"said": str(w.get("said") or "").strip()[:300], "fix": str(w.get("fix") or "").strip()[:300]}
                     for w in raw.get("wrong") or [] if isinstance(w, dict) and str(w.get("fix") or "").strip()][:3],
           "note": str(raw.get("note") or "").strip()[:300]}
    if beginner:
        out.update(plain=pct(raw.get("plain")), analogy=bool(raw.get("analogy")),
                   unexplained=[str(t).strip()[:60] for t in raw.get("unexplained") or [] if str(t).strip()][:5])
    return out


async def explain_twice(notebook_id: int, section_id: str, expert: str, beginner: str, model: Optional[str] = None,
                        fallback_credits: bool = False) -> dict:
    """Feedback on one chapter explained to an expert and to a beginner, with counted delivery for each."""
    from . import reading
    from .errors import FriendlyError
    from .core.providers import metering_context, fallback_credits_context, is_fallback_credits
    expert, beginner = (expert or "").strip()[:4000], (beginner or "").strip()[:4000]
    if len(expert.split()) < 5 or len(beginner.split()) < 5:
        raise HTTPException(400, detail={"code": "invalid", "title": "Two explanations needed",
                                         "message": "Explain it once to an expert and once to a beginner, a few sentences each."})
    section, notes = chapter_notes(notebook_id, section_id)
    numbered = "\n".join(f"{i + 1}. {n['text']}" for i, n in enumerate(notes))
    message = (f"CHAPTER\n{section.get('title') or ''}\n\nNOTES\n{numbered}\n\n"
               f"EXPLANATION TO AN EXPERT\n{expert}\n\nEXPLANATION TO A BEGINNER\n{beginner}")
    document_id = int(notebook.get_notebook(notebook_id).get("document_id") or 0)
    try:
        with metering_context("reading"), fallback_credits_context(fallback_credits or is_fallback_credits()):
            raw = await reading._ask(model, EXPLAIN_TWICE_PROMPT + reading.languages.json_block(None), message,
                                     document_id, kind="study_explain")
    except FriendlyError as fe:
        raise fe.http()
    raw = raw if isinstance(raw, dict) else {}
    return {"title": section.get("title") or "",
            "expert": {**_clean_side(raw.get("expert"), False), "delivery": delivery(expert)},
            "beginner": {**_clean_side(raw.get("beginner"), True), "delivery": delivery(beginner)}}


# ── What studying a chapter costs, before anything is spent ──────────────────

#: Rough sizes (tokens), from the prompts above: the questions call, and marking one answer.
QUESTIONS_PROMPT_TOKENS, QUESTIONS_OUT_TOKENS = 700, 650
MARK_PROMPT_TOKENS, MARK_ANSWER_TOKENS, MARK_OUT_TOKENS = 450, 150, 220


def chapter_estimate(notebook_id: int, section_id: str, level: str = "some", model: Optional[str] = None) -> dict:
    """Credits to study a chapter: making its questions (free once they exist) and marking one answer to each.
    `credits` is None when the service's prices aren't known: never a guess, because it is shown as a price."""
    from . import reading
    from .core import hosted
    from .errors import resolve_llm
    level = level if level in reading.LEVELS else reading.DEFAULT_LEVEL
    _, notes = chapter_notes(notebook_id, section_id)
    with sess._connect() as conn:
        row = conn.execute("SELECT questions FROM study_chapters WHERE notebook_id=? AND section_id=? AND level=?",
                           (notebook_id, section_id, level)).fetchone()
    questions = json.loads(row["questions"]) if row else None
    n = len(questions) if questions else 4
    notes_tokens = sum(len(x["text"]) for x in notes) // 4
    in_tokens, out_tokens = 0, 0
    if not questions:
        in_tokens += QUESTIONS_PROMPT_TOKENS + notes_tokens
        out_tokens += QUESTIONS_OUT_TOKENS
    paragraph_tokens = (sum(len(q["paragraph"]) for q in questions) // 4 // max(n, 1)) if questions else min(notes_tokens, 500)
    in_tokens += n * (MARK_PROMPT_TOKENS + paragraph_tokens + MARK_ANSWER_TOKENS)
    out_tokens += n * MARK_OUT_TOKENS
    try:
        model_name, _ = resolve_llm(model)
    except Exception:
        model_name = model or "default"
    credits = None if hosted.is_admin() else hosted.credits_for(model_name, in_tokens, out_tokens)
    return {"questions_ready": bool(questions), "answers": n,
            "credits": round(credits, 2) if credits is not None else None}
