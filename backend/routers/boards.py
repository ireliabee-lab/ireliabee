"""
Idea boards — sticky notes on a cork wall.

    GET    /boards/                 every board (q= searches titles and notes)
    POST   /boards/                 a new board
    GET    /boards/{id}             one board with its notes
    PATCH  /boards/{id}             rename it, or turn snapping on and off
    DELETE /boards/{id}             it and its notes
    POST   /boards/{id}/notes       pin a new note
    PATCH  /boards/{id}/notes/{n}   change one (only the fields sent)
    POST   /boards/{id}/notes/moves where notes ended up, several at once
    DELETE /boards/{id}/notes/{n}   take one down

Everything saves as the user types or drags, so these are small and frequent.
"""
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from .. import boards

router = APIRouter()


class BoardBody(BaseModel):
    title: Optional[str] = None
    snap: Optional[bool] = None


class NoteBody(BaseModel):
    text: Optional[str] = None
    colour: Optional[str] = None
    pin: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    w: Optional[float] = None
    h: Optional[float] = None
    #: How it hangs on its pin, in degrees.
    rot: Optional[float] = None
    #: Bring it to the front (it was just dragged or picked up).
    front: Optional[bool] = None


class MovesBody(BaseModel):
    moves: list[dict[str, Any]]


def _given(body: BaseModel) -> dict:
    """Only what the caller actually sent: a note keeps the rest as it was."""
    return body.model_dump(exclude_unset=True, exclude_none=True)


@router.get("/")
def list_boards(q: Optional[str] = None):
    return boards.list_boards(q)


@router.post("/")
def create(body: BoardBody):
    return boards.create_board(body.title or "")


@router.get("/{board_id}")
def get_one(board_id: int):
    return boards.get_board(board_id)


@router.patch("/{board_id}")
def update(board_id: int, body: BoardBody):
    return boards.update_board(board_id, title=body.title, snap=body.snap)


@router.delete("/{board_id}")
def delete(board_id: int):
    return boards.delete_board(board_id)


@router.post("/{board_id}/notes")
def add_note(board_id: int, body: NoteBody):
    return boards.add_note(board_id, _given(body))


@router.patch("/{board_id}/notes/{note_id}")
def update_note(board_id: int, note_id: int, body: NoteBody):
    return boards.update_note(board_id, note_id, _given(body))


@router.post("/{board_id}/notes/moves")
def move_notes(board_id: int, body: MovesBody):
    return boards.move_notes(board_id, body.moves)


@router.delete("/{board_id}/notes/{note_id}")
def delete_note(board_id: int, note_id: int):
    return boards.delete_note(board_id, note_id)


class ScheduleBody(BaseModel):
    """The meeting for a note: anything backend/meetings.py takes; the note's text fills title and topics."""
    model_config = {"extra": "allow"}


@router.post("/{board_id}/notes/{note_id}/meeting")
def schedule_note(board_id: int, note_id: int, body: ScheduleBody):
    return boards.schedule_note(board_id, note_id, body.model_dump())


@router.delete("/{board_id}/notes/{note_id}/meeting")
def unschedule_note(board_id: int, note_id: int, delete: bool = False):
    return boards.unschedule_note(board_id, note_id, delete)
