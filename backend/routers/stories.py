"""
Story bank: the candidate's best experiences written as STAR stories.

Stories are injected into coach, mock and debrief prompts so answers are built
on real examples instead of generic ones.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import sessions as sess

router = APIRouter()

MAX_PROMPT_STORIES = 12


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _ensure_table():
    with sess._connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS stories (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                title      TEXT NOT NULL,
                tags       TEXT NOT NULL DEFAULT '',
                situation  TEXT NOT NULL DEFAULT '',
                task       TEXT NOT NULL DEFAULT '',
                action     TEXT NOT NULL DEFAULT '',
                result     TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        # Stories you never want leaving this machine (roadmap: sensitive facts).
        try:
            conn.execute("ALTER TABLE stories ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass


_ensure_table()


def _row(r) -> dict:
    d = dict(r)
    d["tags"] = [t.strip() for t in (d.get("tags") or "").split(",") if t.strip()]
    d["is_private"] = bool(d.get("is_private"))
    return d


def list_stories() -> list[dict]:
    with sess._connect() as conn:
        return [_row(r) for r in conn.execute("SELECT * FROM stories ORDER BY updated_at DESC")]


def stories_prompt_block() -> str:
    """Stories formatted for an LLM system prompt ('' when the bank is empty)."""
    stories = list_stories()[:MAX_PROMPT_STORIES]
    if not stories:
        return ""
    parts = []
    for s in stories:
        tags = f" [{', '.join(s['tags'])}]" if s["tags"] else ""
        parts.append(
            f"• {s['title']}{tags}\n"
            f"  Situation: {s['situation'][:400]}\n  Task: {s['task'][:300]}\n"
            f"  Action: {s['action'][:600]}\n  Result: {s['result'][:300]}"
        )
    return (
        "\n\nCANDIDATE'S STORY BANK — real experiences they have prepared.\n"
        "When a question fits one of these, build the answer on that story (its real details and\n"
        "results) rather than inventing a new example. Don't force a story that doesn't fit.\n"
        + "\n".join(parts)
    )


class StoryBody(BaseModel):
    title: str
    tags: list[str] = []
    situation: str = ""
    task: str = ""
    action: str = ""
    result: str = ""
    # Private stories still coach you; they are never written to a transfer file.
    is_private: bool = False


def _clean(body: StoryBody) -> tuple:
    title = body.title.strip()
    if not title:
        raise HTTPException(400, detail={"code": "invalid", "title": "Story needs a title", "message": "Give the story a short title."})
    tags = ",".join(dict.fromkeys(t.strip().lower() for t in body.tags if t.strip()))
    return (title, tags, body.situation.strip(), body.task.strip(),
            body.action.strip(), body.result.strip(), int(body.is_private))


@router.get("/")
def get_stories():
    return list_stories()


@router.post("/")
def create_story(body: StoryBody):
    now = _now()
    with sess._connect() as conn:
        cur = conn.execute(
            "INSERT INTO stories (title, tags, situation, task, action, result, is_private, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (*_clean(body), now, now),
        )
        return _row(conn.execute("SELECT * FROM stories WHERE id = ?", (cur.lastrowid,)).fetchone())


@router.put("/{story_id}")
def update_story(story_id: int, body: StoryBody):
    with sess._connect() as conn:
        if not conn.execute("SELECT 1 FROM stories WHERE id = ?", (story_id,)).fetchone():
            raise HTTPException(404, "Story not found")
        conn.execute(
            "UPDATE stories SET title = ?, tags = ?, situation = ?, task = ?, action = ?, result = ?, "
            "is_private = ?, updated_at = ? WHERE id = ?",
            (*_clean(body), _now(), story_id),
        )
        return _row(conn.execute("SELECT * FROM stories WHERE id = ?", (story_id,)).fetchone())


@router.delete("/{story_id}")
def delete_story(story_id: int):
    with sess._connect() as conn:
        conn.execute("DELETE FROM stories WHERE id = ?", (story_id,))
    return {"ok": True}


class DraftBody(BaseModel):
    notes: str
    model: Optional[str] = None


@router.post("/draft")
async def draft_story(body: DraftBody):
    from ..errors import FriendlyError
    from .mock import _ask_model, _candidate_context

    notes = body.notes.strip()
    if len(notes) < 40:
        raise FriendlyError(
            "invalid", "Tell me a bit more",
            "Write a few sentences about what happened, what you did and how it turned out.",
        )
    profile, context = _candidate_context(None)
    system_prompt = f"""You turn a candidate's rough notes into one interview story in STAR form.

CANDIDATE
{context}

Rules:
- Use ONLY facts from the notes (the candidate context is just for wording and seniority).
- Never invent numbers, tools, employers or outcomes. Where a result or detail is missing,
  write a short bracketed prompt like [how many users?] so the candidate can fill it in.
- First person, concise, spoken style. Action should show what the candidate personally did.

Return ONLY JSON, no prose:
{{"title": "short memorable title",
  "tags": ["2-5 lowercase interview themes this story answers, e.g. conflict, leadership, debugging, deadline, failure"],
  "situation": "1-2 sentences",
  "task": "1 sentence: what the candidate had to achieve",
  "action": "2-4 sentences: the specific steps they took",
  "result": "1-2 sentences: the outcome and what they learned"}}"""
    data = await _ask_model(body.model, system_prompt, "NOTES\n" + notes[:6000], kind="stories")
    return {
        "title": str(data.get("title", "")).strip(),
        "tags": [str(t).strip().lower() for t in data.get("tags", []) if str(t).strip()][:5],
        "situation": str(data.get("situation", "")).strip(),
        "task": str(data.get("task", "")).strip(),
        "action": str(data.get("action", "")).strip(),
        "result": str(data.get("result", "")).strip(),
    }
