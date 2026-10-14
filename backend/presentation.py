"""
Presentation rehearsal: paste a script or slide notes and get timing plus
clarity feedback before you present. Stateless — nothing is saved, no session
involved.
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import HTTPException

SPEAKING_WPM = 130          # a calm spoken pace for a presentation
LONG_SENTENCE_WORDS = 30
JARGON = re.compile(
    r"\b(synergy|synergies|leverage|leveraging|paradigm|holistic|bandwidth|"
    r"circle back|touch base|move the needle|low-hanging fruit|boil the ocean|"
    r"utilize|utilise|going forward|at the end of the day|deep dive)\b",
    re.IGNORECASE,
)


def _sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p.strip() for p in parts if p.strip()]


def analyze_timing(text: str, target_minutes: Optional[float]) -> dict:
    words = len(text.split())
    if words < 20:
        raise HTTPException(400, "Paste a bit more of your script — at least 20 words.")
    est_seconds = round(words / SPEAKING_WPM * 60)
    sentences = _sentences(text)
    long_sentences = [s for s in sentences if len(s.split()) > LONG_SENTENCE_WORDS]
    jargon_hits = sorted({m.group(0).lower() for m in JARGON.finditer(text)})
    avg_sentence = round(words / len(sentences), 1) if sentences else 0

    result = {
        "words": words,
        "est_seconds": est_seconds,
        "est_minutes": round(est_seconds / 60, 1),
        "target_minutes": target_minutes,
        "sentences": len(sentences),
        "avg_sentence_words": avg_sentence,
        "long_sentences": [{"words": len(s.split()), "text": s[:240]} for s in long_sentences[:6]],
        "jargon": jargon_hits,
    }
    if target_minutes:
        delta = round(result["est_minutes"] - target_minutes, 1)
        result["over_under"] = delta   # + = too long, - = room to spare
    return result


async def analyze_presentation(text: str, target_minutes: Optional[float], model: Optional[str]) -> dict:
    from .routers.mock import _ask_model

    timing = analyze_timing(text, target_minutes)

    system_prompt = """You are a speaking coach reviewing the text of a talk or presentation.
Judge clarity and flow only — not timing (that's measured separately).

Return ONLY JSON:
{"clarity_score": <int 1-10>,
 "opening": "a tightened, punchier first 1-2 sentences the speaker could open with",
 "strengths": ["up to 3 things that already work"],
 "fixes": ["up to 4 specific, actionable clarity or structure fixes"]}"""
    data = await _ask_model(model, system_prompt, "TALK SCRIPT\n" + text[:8000])

    def strings(key, limit):
        return [str(s).strip() for s in data.get(key, []) if str(s).strip()][:limit]

    try:
        clarity = max(1, min(10, int(round(float(data.get("clarity_score"))))))
    except (TypeError, ValueError):
        clarity = 0

    return {
        "timing": timing,
        "clarity_score": clarity,
        "opening": str(data.get("opening", "")).strip(),
        "strengths": strings("strengths", 3),
        "fixes": strings("fixes", 4),
        "model": model or "",
    }
