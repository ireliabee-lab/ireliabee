"""
Study mode: questions answered in a notebook come back for review (docs/study-mode.md).

    GET    /study/due              cards due now (at most a day's worth), and how many in all
    POST   /study/cards            keep a just-marked question, scheduled from its first answer
    POST   /study/cards/{id}       record a review answer's marking score; returns when it is due next
    DELETE /study/cards/{id}       stop reviewing a question
    POST   /study/chapter          3-5 questions to read a chapter for (made once, then kept)
    GET    /study/chapter-estimate what studying a chapter costs, before anything is spent
    POST   /study/explain-twice    feedback on a chapter explained to an expert and to a beginner
"""
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .. import study_reviews as study
from ..entitlements import require_pro

router = APIRouter()


@router.get("/due")
def due(notebook_id: Optional[int] = None, limit: int = study.DAILY_LIMIT):
    return study.due(limit=limit, notebook_id=notebook_id)


class CardBody(BaseModel):
    notebook_id: int
    document_id: Optional[int] = None
    paragraph: str
    src: list[int] = []
    question: str
    points: list[str]
    score: int


@router.post("/cards")
def add(body: CardBody):
    return study.add(body.notebook_id, body.paragraph, body.question, body.points, body.score,
                     body.src, body.document_id)


class ReviewBody(BaseModel):
    score: int


@router.post("/cards/{card_id}")
def review(card_id: int, body: ReviewBody):
    return study.review(card_id, body.score)


@router.delete("/cards/{card_id}")
def remove(card_id: int):
    return study.remove(card_id)


class ChapterBody(BaseModel):
    notebook_id: int
    section_id: str
    level: str = "some"
    model: Optional[str] = None
    fallback_credits: bool = False


@router.post("/chapter", dependencies=[Depends(require_pro("notebook"))])
async def chapter(body: ChapterBody):
    return await study.chapter_questions(body.notebook_id, body.section_id, body.level, body.model,
                                         fallback_credits=body.fallback_credits)


class ExplainTwiceBody(BaseModel):
    notebook_id: int
    section_id: str
    expert: str
    beginner: str
    model: Optional[str] = None
    fallback_credits: bool = False


@router.post("/explain-twice", dependencies=[Depends(require_pro("notebook"))])
async def explain_twice(body: ExplainTwiceBody):
    return await study.explain_twice(body.notebook_id, body.section_id, body.expert, body.beginner, body.model,
                                     fallback_credits=body.fallback_credits)


@router.get("/chapter-estimate")
def chapter_estimate(notebook_id: int, section_id: str, level: str = "some", model: Optional[str] = None):
    return study.chapter_estimate(notebook_id, section_id, level, model)
