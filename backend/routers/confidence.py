import json
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from ..confidence import generate_confidence, load_confidence
from ..core import sessions as sess

router = APIRouter()


class ConfidenceBody(BaseModel):
    model: Optional[str] = None


@router.get("/")
def list_scorable():
    """Sessions with at least one line of yours, newest first, with any saved score."""
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT s.id, s.title, s.subtitle, s.tags, s.created_at, s.confidence_json "
            "FROM sessions s WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id "
            "AND m.role = 'user' AND m.speaker IN ('you', 'user')) "
            "ORDER BY s.created_at DESC LIMIT 200"
        ).fetchall()
    out = []
    for r in rows:
        saved = json.loads(r["confidence_json"]) if r["confidence_json"] else None
        out.append({
            "id": r["id"], "title": r["title"], "subtitle": r["subtitle"],
            "tags": [t for t in (r["tags"] or "").split(",") if t],
            "created_at": r["created_at"],
            "overall": saved.get("overall") if saved else None,
            "generated_at": saved.get("generated_at") if saved else None,
        })
    return out


@router.get("/{session_id}")
def get_confidence(session_id: int):
    return load_confidence(session_id)


@router.post("/{session_id}")
async def create_confidence(session_id: int, body: ConfidenceBody):
    return await generate_confidence(session_id, body.model)
