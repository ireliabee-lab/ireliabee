from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..presentation import analyze_presentation
from ..entitlements import require_pro

router = APIRouter()


class PresentationBody(BaseModel):
    text: str
    target_minutes: Optional[float] = None
    model: Optional[str] = None


@router.post("/analyze", dependencies=[Depends(require_pro("study"))])
async def analyze(body: PresentationBody):
    return await analyze_presentation(body.text or "", body.target_minutes, body.model)
