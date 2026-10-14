"""Local usage counts (see backend/usage.py). Nothing here leaves the machine."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import usage

router = APIRouter()


class UsageEvent(BaseModel):
    event: str


@router.post("/event", status_code=204)
def record_event(body: UsageEvent):
    if not usage.valid_event(body.event):
        raise HTTPException(400, "Invalid event name")
    usage.record(body.event)


@router.get("/summary")
def get_summary(days: int = 90):
    return usage.summary(days)


@router.get("/costs")
def get_costs(days: int = 90):
    """
    What the AI has actually cost, by model and by kind.

    Step 1 of docs/hosted-pivot.md: a credit cannot be priced until this has
    real numbers in it. `unpriced_calls` above zero means MODEL_PRICES is
    missing an entry and the totals are a floor, not the answer.
    """
    from ..core import costs
    return costs.summary(days)


@router.get("/costs/{session_id}")
def get_session_cost(session_id: int):
    """What one session cost — the number a credit has to cover."""
    from ..core import costs
    return costs.for_session(session_id)
