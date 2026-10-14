from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from ..meeting_prep import generate_prep

router = APIRouter()


class PrepBody(BaseModel):
    agenda: str
    context: str = ""
    model: Optional[str] = None


@router.post("/")
async def prep(body: PrepBody):
    return await generate_prep(body.agenda or "", body.context or "", body.model)

