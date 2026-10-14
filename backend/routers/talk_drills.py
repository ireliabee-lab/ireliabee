"""
Talk at work: everyday work-talk drills (docs/study-mode.md, S4).

    GET  /talk/drills            the scenarios and today's impromptu topic (?skip=n for another topic)
    POST /talk/score             feedback on one answer to a scenario or an impromptu topic
    POST /talk/shorten           a work message about half as long, bottom line up front
"""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import talk_drills as talk
from ..entitlements import require_pro

router = APIRouter()


@router.get("/drills")
def drills(skip: int = 0):
    return talk.drills(skip)


class ScoreBody(BaseModel):
    drill: str                      # a scenario id, or "impromptu"
    answer: str
    topic: str = ""
    seconds: Optional[int] = None
    model: Optional[str] = None
    fallback_credits: bool = False


@router.post("/score", dependencies=[Depends(require_pro("study"))])
async def score(body: ScoreBody):
    return await talk.score(body.drill, body.answer, body.topic, body.seconds, body.model,
                            fallback_credits=body.fallback_credits)


class ShortenBody(BaseModel):
    text: str
    kind: str = "chat"              # chat | email
    model: Optional[str] = None
    fallback_credits: bool = False


@router.post("/shorten", dependencies=[Depends(require_pro("study"))])
async def shorten(body: ShortenBody):
    return await talk.shorten(body.text, body.kind, body.model, fallback_credits=body.fallback_credits)
