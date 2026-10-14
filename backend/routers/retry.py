from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import retry
from ..entitlements import require_pro

router = APIRouter()


@router.get("/moments")
def moments(limit: int = 30):
    return retry.hard_moments(max(1, min(limit, 100)))


class RetryBody(BaseModel):
    session_id: Optional[int] = None
    question: str
    answer: str
    previous_answer: str = ""
    previous_score: Optional[int] = None
    looking_for: str = ""
    model: Optional[str] = None


@router.post("/answer", dependencies=[Depends(require_pro("retry"))])
async def answer(body: RetryBody):
    if not body.question.strip() or not body.answer.strip():
        raise HTTPException(400, "Question and answer are required")
    return await retry.score_retry(body.session_id, body.question, body.answer, body.previous_answer,
                                   body.previous_score, body.looking_for, body.model)
