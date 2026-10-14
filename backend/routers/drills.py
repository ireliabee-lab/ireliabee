"""
"Explain it back" drills: the coach picks a topic from the candidate's CV — or from
any Library file, like lecture slides, a spec or notes (roadmap 2.2) — and keeps
probing with follow-up questions until their explanation is solid. When a drill
comes from a file, that file is the answer key: explanations are checked against it.

The conversation lives in the client; each turn sends the exchange so far.
Finished drills are recorded so progress can be charted later.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..core import sessions as sess
from .coach import RESPONSE_TONES, tone_block, _persona_block, _resolve_tone
from .mock import _ask_model, _candidate_context, _level_text
from ..document_store import documents_context, get_document

router = APIRouter()

SOLID_SCORE = 80
MAX_ROUNDS = 6


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _ensure_table():
    with sess._connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS drills (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                topic       TEXT NOT NULL,
                score       INTEGER NOT NULL,
                rounds      INTEGER NOT NULL,
                solid       INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL
            )
        """)
        # Where the topic came from (roadmap 2.2): a Library file, or NULL for the CV.
        for col in ("document_id INTEGER", "source TEXT DEFAULT ''"):
            try:
                conn.execute(f"ALTER TABLE drills ADD COLUMN {col}")
            except Exception:
                pass


def _file(document_id: Optional[int]) -> tuple[str, str]:
    """(file name, file text as a prompt block) — ('', '') when there's no usable file."""
    if not document_id:
        return "", ""
    doc = get_document(document_id)
    text = documents_context([document_id], budget=14000, heading="SOURCE MATERIAL")
    return ((doc or {}).get("name") or "the file", text) if doc and text else ("", "")


class TopicsBody(BaseModel):
    model: Optional[str] = None
    cv_id: Optional[int] = None
    document_id: Optional[int] = None


def _clean_topics(data: dict) -> list[dict]:
    topics = []
    for t in data.get("topics", []):
        if isinstance(t, dict) and str(t.get("title", "")).strip():
            topics.append({"title": str(t["title"]).strip(), "why": str(t.get("why", "")).strip()})
    return topics[:8]


@router.post("/topics")
async def suggest_topics(body: TopicsBody):
    profile, context = _candidate_context(body.cv_id)
    if body.document_id:
        name, material = _file(body.document_id)
        if not material:
            raise HTTPException(404, detail={"code": "invalid", "title": "Couldn't read that file",
                                              "message": "It may be empty or a scanned image. Try another file from your Library."})
        system_prompt = f"""You help someone prepare to explain material out loud — in an exam, a viva, a
presentation, a meeting or an interview. Find the ideas in this file they're most likely to be asked
to explain in their own words.

{material}

THE PERSON
{context}

{_level_text(profile)}

Pick 6 concrete topics from the file: key concepts, mechanisms, definitions, decisions, trade-offs,
results or arguments. Prefer ideas the file treats as central, and ones that are easy to repeat but
hard to explain ("why", "how", "what if"). Use the file's own terms. Every topic must come from the file.

Write plain text inside the JSON strings — no markdown or asterisks.
Return ONLY JSON, no prose:
{{"topics": [{{"title": "short topic, max 6 words", "why": "one short sentence: what they'll need to explain"}}]}}"""
        data = await _ask_model(body.model, system_prompt, "Suggest the topics.")
        return {"topics": _clean_topics(data), "source": name}

    system_prompt = f"""You help a candidate prepare for interviews by finding the things on their
CV they are most likely to be asked to explain in depth.

CANDIDATE
{context}

{_level_text(profile)}

Pick 6 concrete topics: technologies, projects, decisions, or concepts the candidate claims.
Prefer things an interviewer would dig into, and things that are easy to claim but hard to explain.

Write plain text inside the JSON strings — no markdown or asterisks.
Return ONLY JSON, no prose:
{{"topics": [{{"title": "short topic, max 6 words", "why": "one short sentence on why they'll be asked"}}]}}"""
    data = await _ask_model(body.model, system_prompt, "Suggest the topics.")
    return {"topics": _clean_topics(data), "source": ""}


class Exchange(BaseModel):
    role: Literal["coach", "you"]
    text: str


class TurnBody(BaseModel):
    topic: str = Field(..., min_length=1)
    history: list[Exchange] = []
    answer: str = ""
    model: Optional[str] = None
    response_tone: Optional[str] = None
    cv_id: Optional[int] = None
    document_id: Optional[int] = None


@router.post("/turn")
async def drill_turn(body: TurnBody):
    topic = body.topic.strip()
    answer = body.answer.strip()
    rounds = sum(1 for h in body.history if h.role == "you") + (1 if answer else 0)
    if body.history and not answer:
        raise HTTPException(400, "Answer is empty")

    profile, context = _candidate_context(body.cv_id)
    tone = _resolve_tone(body.response_tone)
    file_name, material = _file(body.document_id)
    # With a file, it is the answer key; without one, the CV is the context.
    grounding = (
        f"""{material}

The SOURCE MATERIAL above ("{file_name}") is the answer key. Judge what they say against it: credit
explanations that match it in their own words, and treat anything that contradicts it as a wrong fact.
"""
        if material else ""
    )

    if not answer:
        about = f'an idea from "{file_name}"' if material else "something they claim on their CV"
        ask_style = (", the way a lecturer, examiner or colleague would ask about this material" if material
                     else ", tied to how they used it if the CV says so")
        system_prompt = f"""You are a sharp but kind examiner checking whether someone truly understands
{about}.
{grounding}
CANDIDATE
{context}
{_persona_block(profile)}

Ask ONE opening question that makes them explain "{topic}" in their own words{ask_style}.
Keep it under 30 words. Match their level.

Write plain text inside the JSON strings — no markdown or asterisks.
Return ONLY JSON: {{"question": "..."}}

{tone_block(tone)}"""
        data = await _ask_model(body.model, system_prompt, f"TOPIC: {topic}")
        question = str(data.get("question", "")).strip()
        if not question:
            question = f"In your own words, how would you explain {topic} to an interviewer?"
        return {"question": question, "done": False, "understanding": None}

    force_end = rounds >= MAX_ROUNDS
    source_facts = "the source material, " if material else ""
    transcript = "\n".join(f"{'INTERVIEWER' if h.role == 'coach' else 'CANDIDATE'}: {h.text}" for h in body.history)
    system_prompt = f"""You are a sharp but kind interviewer running an "explain it back" drill on
"{topic}". You keep probing until the candidate's explanation is solid for their level.
{grounding}
CANDIDATE
{context}
{_persona_block(profile)}

After each answer:
- Rate their overall understanding so far, 0–100 ({SOLID_SCORE}+ = would satisfy a real interviewer
  at their level). Judge what they said, not what the CV claims.
- Give one short line of feedback that references what they actually said.
- List the gaps still open (vague terms, missing "why", wrong facts, no example), max 3.
- If understanding is below {SOLID_SCORE}, ask ONE follow-up question (under 30 words) aimed at the
  biggest gap — the way an interviewer would dig in. Don't repeat earlier questions.
- If understanding is {SOLID_SCORE}+{" or this is the final round" if force_end else ""}, stop: set done
  true, set next_question null, and write model_explanation — how they could explain it in an
  interview, first person, 80–140 words, using only facts from {source_facts}their CV
  and answers, with [placeholders] for specifics you don't know.

Write plain text inside the JSON strings — no markdown or asterisks.
Return ONLY JSON, no prose:
{{"understanding": <int 0-100>, "feedback": "...", "gaps": ["..."], "next_question": "..." | null,
  "done": <bool>, "model_explanation": "..." | null}}

{tone_block(tone)}"""
    message = f"DRILL SO FAR\n{transcript}\n\nCANDIDATE'S LATEST ANSWER: {answer}"
    if force_end:
        message += "\n\nThis is the final round: finish the drill now."
    data = await _ask_model(body.model, system_prompt, message)

    try:
        understanding = max(0, min(100, int(round(float(data.get("understanding", 0))))))
    except (TypeError, ValueError):
        understanding = 0
    next_question = str(data.get("next_question") or "").strip() or None
    done = bool(data.get("done")) or force_end or understanding >= SOLID_SCORE or not next_question
    result = {
        "understanding": understanding,
        "feedback": str(data.get("feedback", "")).strip(),
        "gaps": [str(g).strip() for g in data.get("gaps", []) if str(g).strip()][:3],
        "question": None if done else next_question,
        "done": done,
        "model_explanation": str(data.get("model_explanation") or "").strip() or None,
        "solid": understanding >= SOLID_SCORE,
        "rounds": rounds,
    }

    if done:
        _ensure_table()
        with sess._connect() as conn:
            conn.execute(
                "INSERT INTO drills (topic, score, rounds, solid, created_at, document_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (topic, understanding, rounds, int(result["solid"]), _now(), body.document_id if material else None, file_name),
            )
    return result


@router.get("/history")
def drill_history(limit: int = 50):
    _ensure_table()
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT id, topic, score, rounds, solid, created_at, document_id, source FROM drills ORDER BY id DESC LIMIT ?",
            (max(1, min(limit, 500)),),
        ).fetchall()
    return [
        {"id": r[0], "topic": r[1], "score": r[2], "rounds": r[3], "solid": bool(r[4]), "created_at": r[5],
         "document_id": r[6], "source": r[7] or ""}
        for r in rows
    ]
