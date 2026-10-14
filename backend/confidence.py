"""
Confidence score: a post-session read on how confidently you came across.

Combines pace, filler words, hedging words, talk share and answer structure
into one 0-100 score. Runs on the saved transcript after the fact, so live
sessions are untouched. Word repetitions are deliberately not counted: in a
stutter they are not a confidence signal.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import datetime
from typing import Optional

from fastapi import HTTPException

from .core import sessions as sess

_TAG = re.compile(r"^\s*(\[[^\]]*\]\s*)+")

YOU_SPEAKERS = {"you", "user"}
THEM_SPEAKERS = {"interviewer"}

FILLERS = re.compile(
    r"\b(u+m+|u+h+|e+r+m*|a+h+|m*h+m+|you know|i mean|kind of|sort of|basically|literally|actually)\b",
    re.IGNORECASE,
)
HEDGES = re.compile(
    r"\b(i think|i guess|i suppose|i feel like|maybe|perhaps|probably|possibly|"
    r"i'm not sure|i am not sure|not really sure|hopefully|i believe)\b",
    re.IGNORECASE,
)

WEIGHTS = {"structure": 0.30, "fillers": 0.20, "hedging": 0.20, "pace": 0.15, "talk_share": 0.15}
MIN_WORDS = 40
STRUCTURE_MIN_WORDS = 25
STRUCTURE_MAX_ANSWERS = 12


def _ensure_column():
    with sess._connect() as conn:
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN confidence_json TEXT")
        except Exception:
            pass


_ensure_column()


def _clean(text: str) -> str:
    return _TAG.sub("", text or "").strip()


def _norm(text: str) -> str:
    return re.sub(r"\W+", " ", text.lower()).strip()


def _words(text: str) -> int:
    return len(text.split())


def build_turns(rows: list[tuple[Optional[str], str]]) -> list[dict]:
    """Turn (speaker, content) rows into speaker turns.

    Drops lines of yours that exactly repeat a neighbouring line of theirs:
    that's their audio leaking into your mic, not something you said.
    """
    lines = []
    for speaker, content in rows:
        who = "you" if speaker in YOU_SPEAKERS else "them" if speaker in THEM_SPEAKERS else None
        text = _clean(content)
        if who and text:
            lines.append((who, text))

    kept = []
    for i, (who, text) in enumerate(lines):
        if who == "you":
            neighbours = [lines[j] for j in (i - 1, i + 1) if 0 <= j < len(lines)]
            if any(w == "them" and _norm(t) == _norm(text) for w, t in neighbours):
                continue
        kept.append((who, text))

    turns: list[dict] = []
    for who, text in kept:
        if turns and turns[-1]["who"] == who:
            turns[-1]["text"] += " " + text
        else:
            turns.append({"who": who, "text": text})
    return turns


def band_score(value: float, good_lo: float, good_hi: float, zero_lo: float, zero_hi: float) -> int:
    """100 inside [good_lo, good_hi], falling linearly to 0 at zero_lo / zero_hi."""
    if good_lo <= value <= good_hi:
        return 100
    if value < good_lo:
        if good_lo == zero_lo:
            return 100
        frac = (value - zero_lo) / (good_lo - zero_lo)
    else:
        frac = (zero_hi - value) / (zero_hi - good_hi)
    return round(max(0.0, min(1.0, frac)) * 100)


def _top(pattern: re.Pattern, text: str, limit: int = 5) -> list[dict]:
    counts = Counter(m.group(0).lower() for m in pattern.finditer(text))
    return [{"phrase": p, "count": c} for p, c in counts.most_common(limit)]


def speech_metrics(turns: list[dict], delivery: Optional[dict]) -> dict:
    """Everything except answer structure — no model call needed."""
    yours = " ".join(t["text"] for t in turns if t["who"] == "you")
    theirs = " ".join(t["text"] for t in turns if t["who"] == "them")
    you_words, them_words = _words(yours), _words(theirs)
    if you_words < MIN_WORDS:
        raise HTTPException(400, f"Not enough of your speech to score yet (need at least {MIN_WORDS} words)")

    fillers = len(FILLERS.findall(yours))
    hedges = len(HEDGES.findall(yours))
    filler_rate = round(fillers / you_words * 100, 1)
    hedge_rate = round(hedges / you_words * 100, 1)

    components: dict[str, dict] = {
        "fillers": {
            "value": filler_rate, "unit": "per 100 words", "count": fillers,
            "score": band_score(filler_rate, 0, 2, 0, 10),
            "top": _top(FILLERS, yours),
        },
        "hedging": {
            "value": hedge_rate, "unit": "per 100 words", "count": hedges,
            "score": band_score(hedge_rate, 0, 1, 0, 6),
            "top": _top(HEDGES, yours),
        },
    }

    wpm = (delivery or {}).get("wpm")
    components["pace"] = (
        {"value": wpm, "unit": "wpm", "score": band_score(wpm, 120, 170, 70, 230), "source": "timing"}
        if wpm else {"value": None, "unit": "wpm", "score": None, "source": None}
    )

    share = (delivery or {}).get("talk_share")
    source = "timing"
    if share is None and them_words:
        share = round(you_words / (you_words + them_words) * 100)
        source = "words"
    components["talk_share"] = (
        {"value": share, "unit": "%", "score": band_score(share, 35, 65, 10, 90), "source": source}
        if share is not None else {"value": None, "unit": "%", "score": None, "source": None}
    )

    return {"words": you_words, "components": components}


def answers_for_structure(turns: list[dict]) -> list[dict]:
    answers = []
    for i, t in enumerate(turns):
        if t["who"] == "you" and _words(t["text"]) >= STRUCTURE_MIN_WORDS:
            question = turns[i - 1]["text"] if i and turns[i - 1]["who"] == "them" else ""
            answers.append({"question": question, "answer": t["text"]})
    return answers[:STRUCTURE_MAX_ANSWERS]


def overall(components: dict[str, dict]) -> Optional[int]:
    scored = {k: c["score"] for k, c in components.items() if c.get("score") is not None}
    if not scored:
        return None
    total = sum(WEIGHTS[k] for k in scored)
    return round(sum(WEIGHTS[k] * s for k, s in scored.items()) / total)


def tips(components: dict[str, dict]) -> list[str]:
    out = []
    f, h, p, t, s = (components.get(k, {}) for k in ("fillers", "hedging", "pace", "talk_share", "structure"))
    if f.get("score") is not None and f["score"] < 80 and f.get("top"):
        out.append(f"Swap \"{f['top'][0]['phrase']}\" for a short pause — silence reads as thinking, not doubt.")
    if h.get("score") is not None and h["score"] < 80 and h.get("top"):
        out.append(f"Cut \"{h['top'][0]['phrase']}\" when you know the answer. State it, then give your reason.")
    if p.get("score") is not None and p["score"] < 80:
        out.append("Slow down a little — aim for about 120-170 words a minute." if p["value"] > 170
                   else "Pick up the pace slightly — aim for about 120-170 words a minute.")
    if t.get("score") is not None and t["score"] < 80:
        out.append("Leave more room for them — ask a question back after key answers." if t["value"] > 65
                   else "Say a bit more — back each answer with one example or reason.")
    if s.get("score") is not None and s["score"] < 80:
        out.append("Lead with your answer in one sentence, add one example, then close with why it matters.")
    return out[:4]


def _rows(session_id: int) -> list[tuple[Optional[str], str]]:
    with sess._connect() as conn:
        return [
            (r["speaker"], r["content"])
            for r in conn.execute(
                "SELECT speaker, content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id",
                (session_id,),
            )
        ]


def load_confidence(session_id: int) -> Optional[dict]:
    with sess._connect() as conn:
        row = conn.execute("SELECT confidence_json FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Session not found")
    return json.loads(row["confidence_json"]) if row["confidence_json"] else None


async def score_structure(answers: list[dict], model: Optional[str]) -> dict:
    from .debrief import _clamp
    from .routers.mock import _ask_model

    system_prompt = """You rate the STRUCTURE of spoken answers, nothing else.

A well-structured answer: opens by answering the question directly, backs it with a reason or
concrete example, and ends with a clear point instead of trailing off.

These are speech transcripts from a speaker who may stutter. Ignore repeated words, false starts,
filler words and transcription glitches completely — they must not lower the score, and notes
must never mention repetition, stuttering, fluency or filler words. Judge only the order and
completeness of the ideas.

Return ONLY JSON, no prose:
{"answers": [{"index": <int, as given>, "score": <int 1-10>, "note": "one short, specific sentence"}]}"""
    message = "\n\n".join(
        f"[{i}] QUESTION: {a['question'] or '(no question captured)'}\nANSWER: {a['answer']}"
        for i, a in enumerate(answers)
    )
    data = await _ask_model(model, system_prompt, message)
    rated = []
    for item in data.get("answers", []):
        try:
            idx = int(item.get("index"))
        except (TypeError, ValueError):
            continue
        score = _clamp(item.get("score"))
        if 0 <= idx < len(answers) and score:
            rated.append({
                "question": answers[idx]["question"][:200],
                "score": score,
                "note": str(item.get("note", "")).strip(),
            })
    if not rated:
        return {"value": None, "unit": "/10", "score": None, "answers": []}
    avg = round(sum(a["score"] for a in rated) / len(rated), 1)
    return {"value": avg, "unit": "/10", "score": round(avg * 10), "answers": rated}


async def generate_confidence(session_id: int, model: Optional[str]) -> dict:
    row = sess.get_session(session_id)
    if row is None:
        raise HTTPException(404, "Session not found")
    turns = build_turns(_rows(session_id))
    try:
        delivery = json.loads(row["delivery_json"]) if row["delivery_json"] else None
    except (TypeError, ValueError):
        delivery = None

    metrics = speech_metrics(turns, delivery)
    components = metrics["components"]
    answers = answers_for_structure(turns)
    components["structure"] = (
        await score_structure(answers, model) if answers
        else {"value": None, "unit": "/10", "score": None, "answers": []}
    )

    report = {
        "overall": overall(components),
        "components": components,
        "tips": tips(components),
        "words": metrics["words"],
        "model": model or "",
        "generated_at": datetime.utcnow().isoformat(timespec="seconds"),
        "session_title": row["title"],
    }
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET confidence_json = ? WHERE id = ?", (json.dumps(report), session_id))
    return report
