"""
Meeting prep: turn an agenda into the questions you're likely to be asked and
the talking points to have ready. Used by Plans → "from a meeting agenda",
which maps the result into the plan being edited (frontend/src/lib/
planFromAgenda.ts). Generation itself is stateless.
"""
from __future__ import annotations

from typing import Optional

from fastapi import HTTPException



async def generate_prep(agenda: str, context: str, model: Optional[str]) -> dict:
    from .routers.mock import _ask_model

    if len(agenda.strip()) < 10:
        raise HTTPException(400, "Add a short agenda or a few bullet points first.")

    system_prompt = """You help someone prepare for a meeting. Given their agenda and context,
anticipate how it will go.

Return ONLY JSON:
{"likely_questions": ["questions the other side is likely to ask, hardest first"],
 "talking_points": ["crisp points the person should be ready to make"],
 "risks": ["things that could derail the meeting, and a one-line way to handle each"]}"""
    message = f"AGENDA\n{agenda.strip()}\n\nCONTEXT\n{context.strip() or '(none given)'}"
    from .core.providers import metering_context
    with metering_context("meeting_prep"):
        data = await _ask_model(model, system_prompt, message)

    def strings(key, limit):
        return [str(s).strip() for s in data.get(key, []) if str(s).strip()][:limit]

    return {
        "likely_questions": strings("likely_questions", 10),
        "talking_points": strings("talking_points", 10),
        "risks": strings("risks", 6),
        "model": model or "",
    }

