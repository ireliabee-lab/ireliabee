import json
from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ..core import sessions as sess
from ..meeting_notes import generate_notes, load_notes
from .. import study
from ..entitlements import require_pro

router = APIRouter()


class NotesBody(BaseModel):
    model: Optional[str] = None


# ── Lecture companion (roadmap 3.1) ─────────────────────────────────────────
class StudyBody(BaseModel):
    model: Optional[str] = None
    document_ids: Optional[list[int]] = None


class StudyResult(BaseModel):
    kind: str
    score: int
    total: int


@router.get("/study")
def study_packs():
    return study.list_packs()


@router.get("/{session_id}/study")
def get_study(session_id: int):
    return study.load_pack(session_id)


@router.post("/{session_id}/study", dependencies=[Depends(require_pro("study"))])
async def make_study(session_id: int, body: StudyBody):
    return await study.generate_pack(session_id, body.model, body.document_ids)


@router.post("/{session_id}/study/result")
def save_study_result(session_id: int, body: StudyResult):
    return study.record_result(session_id, body.kind, body.score, body.total)


@router.get("/")
def list_sessions_with_notes():
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT s.id, s.title, s.subtitle, s.created_at, s.notes_json, "
            "       (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id AND m.role = 'user') AS turns "
            "FROM sessions s ORDER BY s.created_at DESC LIMIT 200"
        ).fetchall()
    out = []
    for r in rows:
        if not r["turns"]:
            continue
        saved = json.loads(r["notes_json"]) if r["notes_json"] else None
        out.append({
            "id": r["id"], "title": r["title"], "subtitle": r["subtitle"], "created_at": r["created_at"],
            "has_notes": saved is not None, "generated_at": saved.get("generated_at") if saved else None,
        })
    return out


@router.get("/{session_id}")
def get_notes(session_id: int):
    return load_notes(session_id)


@router.post("/{session_id}", dependencies=[Depends(require_pro("recap"))])
async def create_notes(session_id: int, body: NotesBody):
    return await generate_notes(session_id, body.model)
