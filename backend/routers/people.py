from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import people as store
from ..core.web_search import search_engine
from ..errors import FriendlyError, resolve_llm
from ..entitlements import require_pro

router = APIRouter()


class PersonBody(BaseModel):
    name: Optional[str] = None
    organisation: Optional[str] = None
    role: Optional[str] = None
    links: Optional[list[str]] = None
    known: Optional[str] = None
    purpose: Optional[str] = None


def _found(pid: int) -> dict:
    person = store.get_person(pid)
    if person is None:
        raise HTTPException(404, "Person not found")
    return person


@router.get("/")
def list_people():
    return store.list_people()


@router.get("/sources")
def sources():
    """What research can use right now, so the UI can say what's missing."""
    return {"web_search": search_engine()}


@router.post("/")
def create(body: PersonBody):
    if not (body.name or "").strip():
        raise FriendlyError("invalid", "Who are you meeting?", "Add their name.").http()
    return store.create_person(body.model_dump(exclude_none=True))


@router.get("/{pid}")
def get_one(pid: int):
    return _found(pid)


@router.put("/{pid}")
def update(pid: int, body: PersonBody):
    _found(pid)
    if body.name is not None and not body.name.strip():
        raise FriendlyError("invalid", "Who are you meeting?", "Add their name.").http()
    return store.update_person(pid, body.model_dump(exclude_none=True))


@router.delete("/{pid}")
def delete(pid: int):
    store.delete_person(pid)
    return {"status": "deleted"}


@router.post("/{pid}/research", dependencies=[Depends(require_pro("people"))])
def research(pid: int):
    """Start research in the background; poll GET /people/{pid} for the stage."""
    _found(pid)
    try:
        resolve_llm(None)  # fail now, not after a minute of searching
    except FriendlyError as fe:
        raise fe.http()
    return store.start_research(pid)
