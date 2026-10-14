"""
Practice from real calls (roadmap 3.4): find the moments that went badly in
real sessions and mock interviews, and practise them again until they're
solid — scored against the earlier attempt, so progress is visible.

Hard moments come from:
  * debriefs (live sessions and voice mocks): questions scored 6/10 or lower
  * typed mock interviews: answers whose feedback scored 6/10 or lower
A moment can also be picked by hand from any transcript.
"""
from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Optional

from . import languages
from .core import sessions as sess

HARD = 6
_SCORE = re.compile(r"^\*\*Score: (\d+)/10\*\* — (.*)")


def _ensure_schema():
    with sess._connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS retries (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id    INTEGER,
                question      TEXT NOT NULL,
                before_score  INTEGER,
                score         INTEGER NOT NULL,
                created_at    TEXT NOT NULL
            )
            """
        )


_ensure_schema()


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _key(question: str) -> str:
    return re.sub(r"\W+", " ", question.lower()).strip()[:160]


def _retried() -> dict[str, dict]:
    """Best retry per question, so solved moments can drop down the list."""
    with sess._connect() as conn:
        rows = conn.execute("SELECT question, score, created_at FROM retries ORDER BY id").fetchall()
    best: dict[str, dict] = {}
    for r in rows:
        k = _key(r["question"])
        if k not in best or r["score"] >= best[k]["score"]:
            best[k] = {"score": r["score"], "at": r["created_at"]}
    return best


def hard_moments(limit: int = 30) -> list[dict]:
    """Weakest real answers first; moments already retried to 8+ go to the end."""
    out: list[dict] = []
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT id, title, created_at, debrief_json FROM sessions ORDER BY created_at DESC LIMIT 200"
        ).fetchall()
        for r in rows:
            if r["debrief_json"]:
                for q in json.loads(r["debrief_json"]).get("questions", []):
                    if q.get("score") is not None and q["score"] <= HARD and q.get("question"):
                        out.append({
                            "session_id": r["id"], "session_title": r["title"], "date": r["created_at"],
                            "question": q["question"], "previous_answer": q.get("answer_summary", ""),
                            "score": q["score"], "feedback": q.get("verdict", ""),
                            "improvements": q.get("improvements", []), "source": "debrief",
                        })
                continue
            # Typed mocks: question, answer, then the feedback message with its score.
            msgs = conn.execute(
                "SELECT role, speaker, content FROM messages WHERE session_id = ? ORDER BY id", (r["id"],)
            ).fetchall()
            for i in range(len(msgs) - 2):
                q, a, fb = msgs[i], msgs[i + 1], msgs[i + 2]
                if q["speaker"] == "interviewer" and a["speaker"] == "you" and fb["role"] == "assistant":
                    m = _SCORE.match(fb["content"] or "")
                    if m and int(m.group(1)) <= HARD:
                        out.append({
                            "session_id": r["id"], "session_title": r["title"], "date": r["created_at"],
                            "question": q["content"], "previous_answer": a["content"],
                            "score": int(m.group(1)), "feedback": m.group(2).strip(),
                            "improvements": [], "source": "mock",
                        })
    retried = _retried()
    for m in out:
        m["best_retry"] = retried.get(_key(m["question"]))
    solved = lambda m: bool(m["best_retry"] and m["best_retry"]["score"] >= 8)
    out.sort(key=lambda m: (solved(m), m["score"], m["date"] and -datetime.fromisoformat(m["date"]).timestamp()))
    return out[:limit]


RETRY_PROMPT = """You are a fair, encouraging coach. The candidate is practising a question that went badly in a
real {event}. Judge their NEW answer on its own merits for their level, and compare it with the earlier attempt.

CANDIDATE
{context}

Score 1-10 (10 = would clearly win the room; 5 = passable but forgettable; 1-3 = hurts them).
Be specific: reference what they actually said.

Return ONLY JSON, no prose:
{{"score": <int 1-10>,
  "verdict": "one honest sentence on the new answer",
  "improved": ["up to 3 specific things that are better than the earlier attempt ([] if none, or no earlier attempt)"],
  "still_missing": ["up to 3 specific things still missing or weak"],
  "better_answer": "a stronger first-person version, 100-180 words, only using facts from the candidate context and their answers; [placeholders] for unknowns"}}"""


async def score_retry(session_id: Optional[int], question: str, answer: str, previous_answer: str,
                      previous_score: Optional[int], looking_for: str, model: Optional[str]) -> dict:
    from .routers.mock import _ask_model, _candidate_context
    from .scenarios import scenario_from_tags

    row = sess.get_session(session_id) if session_id else None
    _, scenario = scenario_from_tags(row["tags"] if row else None)
    _, context = _candidate_context(None)
    prompt = RETRY_PROMPT.format(event=scenario["event"], context=context)
    if row:
        prompt += languages.json_block(languages.output_for_session(session_id))
    message = "\n".join(x for x in [
        f"QUESTION: {question}",
        f"A STRONG ANSWER SHOWS: {looking_for}" if looking_for else "",
        f"EARLIER ATTEMPT (scored {previous_score}/10): {previous_answer}" if previous_answer else "EARLIER ATTEMPT: (not recorded)",
        f"NEW ANSWER: {answer.strip()}",
    ] if x)
    data = await _ask_model(model, prompt, message)
    try:
        score = max(1, min(10, int(round(float(data.get("score", 0))))))
    except (TypeError, ValueError):
        score = 1
    with sess._connect() as conn:
        conn.execute("INSERT INTO retries (session_id, question, before_score, score, created_at) VALUES (?, ?, ?, ?, ?)",
                     (session_id, question.strip(), previous_score, score, _now()))
    return {
        "score": score,
        "previous_score": previous_score,
        "delta": score - previous_score if previous_score is not None else None,
        "verdict": str(data.get("verdict", "")).strip(),
        "improved": [str(s).strip() for s in data.get("improved", []) if str(s).strip()][:3],
        "still_missing": [str(s).strip() for s in data.get("still_missing", []) if str(s).strip()][:3],
        "better_answer": str(data.get("better_answer", "")).strip(),
    }


def retry_days() -> list[str]:
    with sess._connect() as conn:
        return [r["created_at"] for r in conn.execute("SELECT created_at FROM retries")]
