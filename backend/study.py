"""
Lecture companion (roadmap 3.1): turn a recorded lecture into a study pack,
and keep quiz results so they count as practice.

A study pack is built from the session transcript (and any Library files
attached, e.g. the lecture slides): a summary, the lecture's outline, key
points, a glossary, flashcards and a multiple-choice quiz. Long lectures are
condensed chunk by chunk first, so nothing late in the lecture is lost.
Everything must come from what was said or shown — never invented.
"""
from __future__ import annotations

import hashlib
import json
import random
from datetime import datetime
from typing import Optional

from fastapi import HTTPException

from . import languages
from .core import sessions as sess
from .debrief import transcript_lines

CHUNK_CHARS = 18000      # ~25 minutes of speech per chunk
DIRECT_LIMIT = 36000     # up to ~50 minutes goes to the model in one pass


def _ensure_schema():
    with sess._connect() as conn:
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN study_json TEXT")
        except Exception:
            pass
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS study_results (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id  INTEGER NOT NULL,
                kind        TEXT NOT NULL,          -- 'quiz' | 'flashcards'
                score       INTEGER NOT NULL,
                total       INTEGER NOT NULL,
                created_at  TEXT NOT NULL
            )
            """
        )


_ensure_schema()


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def lecture_text(session_id: int) -> str:
    """What the lecturer said, in order (the student's own questions are kept, marked)."""
    lines = []
    for line in transcript_lines(session_id):
        who, _, text = line.partition(": ")
        lines.append(text if who == "Interviewer" else f"(Student) {text}")
    return "\n".join(lines)


def chunks(text: str, size: int = CHUNK_CHARS) -> list[str]:
    """Split on line boundaries into pieces of about `size` characters."""
    out, cur = [], []
    n = 0
    for line in text.split("\n"):
        if n + len(line) > size and cur:
            out.append("\n".join(cur)); cur, n = [], 0
        cur.append(line); n += len(line) + 1
    if cur:
        out.append("\n".join(cur))
    return out


CONDENSE_PROMPT = """You condense one part of a lecture transcript into detailed study notes, as plain text.
Keep every definition, formula, example, number, name, date and claim the lecturer made, in order, in the
lecturer's own terms. Drop filler, repetition and admin chatter. Never add anything that wasn't said."""

PACK_PROMPT = """You turn a lecture into a study pack for a student. Use ONLY what the lecturer said (and the
attached course material, if any) — never add facts, examples or definitions from elsewhere. If something was
unclear or cut off in the transcript, leave it out rather than guess. Transcripts may contain speech-recognition
errors: fix obvious ones silently using context and the course material.

Return ONLY JSON:
{
  "title": "a short title for this lecture",
  "summary": "4-6 sentences: what the lecture covered and its main argument",
  "outline": [{"heading": "a section of the lecture in order", "points": ["what was said in it"]}],
  "key_points": ["the 5-10 things most worth remembering"],
  "glossary": [{"term": "a term the lecturer used or defined", "definition": "as the lecturer defined or used it"}],
  "flashcards": [{"front": "a question or cue", "back": "the answer, short"}],
  "quiz": [{"question": "a multiple-choice question on the material",
            "options": ["four options", "…", "…", "…"],
            "answer": <index 0-3 of the correct option>,
            "explanation": "one sentence on why, from the lecture"}]
}
Aim for 8-15 flashcards and 6-10 quiz questions, from easy recall to understanding and application.
Wrong quiz options must be plausible but clearly wrong according to the lecture."""


def clean_pack(data: dict) -> dict:
    def strs(v, limit):
        return [str(x).strip() for x in (v or []) if str(x).strip()][:limit]

    quiz = []
    for q in data.get("quiz") or []:
        if not isinstance(q, dict):
            continue
        options = strs(q.get("options"), 6)
        try:
            answer = int(q.get("answer"))
        except (TypeError, ValueError):
            continue
        if len(options) >= 2 and 0 <= answer < len(options) and str(q.get("question", "")).strip():
            # Models favour certain answer positions; shuffle so the position gives nothing away.
            # Seeded by the question, so the same pack always shows the same order.
            correct = options[answer]
            seed = int(hashlib.sha256(str(q["question"]).encode()).hexdigest()[:8], 16)
            random.Random(seed).shuffle(options)
            quiz.append({"question": str(q["question"]).strip(), "options": options, "answer": options.index(correct),
                         "explanation": str(q.get("explanation", "")).strip()})
    return {
        "title": str(data.get("title", "")).strip(),
        "summary": str(data.get("summary", "")).strip(),
        "outline": [
            {"heading": str(s.get("heading", "")).strip(), "points": strs(s.get("points"), 8)}
            for s in data.get("outline") or [] if isinstance(s, dict) and str(s.get("heading", "")).strip()
        ][:12],
        "key_points": strs(data.get("key_points"), 12),
        "glossary": [
            {"term": str(g.get("term", "")).strip(), "definition": str(g.get("definition", "")).strip()}
            for g in data.get("glossary") or [] if isinstance(g, dict) and str(g.get("term", "")).strip()
        ][:30],
        "flashcards": [
            {"front": str(f.get("front", "")).strip(), "back": str(f.get("back", "")).strip()}
            for f in data.get("flashcards") or []
            if isinstance(f, dict) and str(f.get("front", "")).strip() and str(f.get("back", "")).strip()
        ][:30],
        "quiz": quiz[:15],
    }


def load_pack(session_id: int) -> Optional[dict]:
    with sess._connect() as conn:
        row = conn.execute("SELECT study_json FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Session not found")
    return json.loads(row["study_json"]) if row["study_json"] else None


async def generate_pack(session_id: int, model: Optional[str], document_ids: Optional[list[int]] = None) -> dict:
    from .routers.mock import _ask_model, respond, resolve_llm, classify
    from .document_store import documents_context
    import asyncio

    if sess.get_session(session_id) is None:
        raise HTTPException(404, "Session not found")
    text = lecture_text(session_id)
    if len(text) < 200:
        raise HTTPException(400, detail={"code": "invalid", "title": "Not enough lecture to study yet",
                                         "message": "Record more of the lecture, then make the study pack."})

    # Notes and cards in the lecture's language (roadmap 3.3).
    lang_rule = languages.json_block(languages.for_session(session_id))

    # Long lectures: condense each part first, so the whole lecture fits and nothing late is dropped.
    if len(text) > DIRECT_LIMIT:
        model_id, provider = resolve_llm(model)
        loop = asyncio.get_running_loop()
        parts = chunks(text)
        try:
            notes = await asyncio.gather(*[
                loop.run_in_executor(None, lambda p=p, i=i: respond(
                    provider, model_id, f"PART {i + 1} OF {len(parts)}\n{p}", [], CONDENSE_PROMPT + lang_rule, 4096))
                for i, p in enumerate(parts)
            ])
        except Exception as e:
            raise classify(e, provider)
        text = "\n\n".join(f"[Part {i + 1}]\n{n}" for i, n in enumerate(notes))

    material = documents_context(document_ids or [], budget=10000, heading="COURSE MATERIAL")
    message = (f"{material}\n\n" if material else "") + "LECTURE TRANSCRIPT\n" + text
    from .core.providers import metering_context
    with metering_context("study", session_id):
        pack = clean_pack(await _ask_model(model, PACK_PROMPT + lang_rule, message))
    pack["generated_at"] = _now()
    pack["condensed"] = len(lecture_text(session_id)) > DIRECT_LIMIT
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET study_json = ? WHERE id = ?", (json.dumps(pack), session_id))
    return pack


def record_result(session_id: int, kind: str, score: int, total: int) -> dict:
    if kind not in ("quiz", "flashcards") or total <= 0 or not (0 <= score <= total):
        raise HTTPException(400, "Invalid result")
    with sess._connect() as conn:
        conn.execute("INSERT INTO study_results (session_id, kind, score, total, created_at) VALUES (?, ?, ?, ?, ?)",
                     (session_id, kind, score, total, _now()))
    return {"ok": True}


def list_packs() -> list[dict]:
    """
    Every recorded lecture, and any other session with a study pack, newest first, with the
    latest quiz score. A lecture whose pack was never made (the app closed as it ended, the
    pack failed, credits ran out) is listed too, with `ready` false, so it can still be made.
    """
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT s.id, s.title, s.created_at, s.study_json FROM sessions s "
            "WHERE s.study_json IS NOT NULL "
            "   OR (s.mode = 'lecture' AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)) "
            "ORDER BY s.created_at DESC"
        ).fetchall()
        best = {r["session_id"]: r for r in conn.execute(
            "SELECT session_id, score, total, MAX(created_at) AS at FROM study_results WHERE kind = 'quiz' GROUP BY session_id"
        ).fetchall()}
    out = []
    for r in rows:
        pack = json.loads(r["study_json"]) if r["study_json"] else None
        last = best.get(r["id"])
        out.append({
            "session_id": r["id"], "title": (pack or {}).get("title") or r["title"], "created_at": r["created_at"],
            "ready": pack is not None,
            "flashcards": len((pack or {}).get("flashcards", [])), "quiz": len((pack or {}).get("quiz", [])),
            "last_quiz": {"score": last["score"], "total": last["total"], "at": last["at"]} if last else None,
        })
    return out
