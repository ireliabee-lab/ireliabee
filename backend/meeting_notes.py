"""
Meeting notes and recap (roadmap 2.1): a summary of a session — key points,
decisions, action items with owner and due date, and the questions still
open — plus a recap email to the people in the meeting, all from one model
call on the saved transcript. Meeting-mode sessions open this as soon as they
end; any session can generate it from its Recap tab.
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Optional

from fastapi import HTTPException

from . import languages
from .core import sessions as sess
from .debrief import transcript_lines


def _ensure_column():
    with sess._connect() as conn:
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN notes_json TEXT")
        except Exception:
            pass


_ensure_column()


def load_notes(session_id: int) -> Optional[dict]:
    with sess._connect() as conn:
        row = conn.execute("SELECT notes_json FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Session not found")
    return json.loads(row["notes_json"]) if row["notes_json"] else None


def _strings(data: dict, key: str, limit: int) -> list[str]:
    return [str(s).strip() for s in data.get(key, []) if str(s).strip()][:limit]


def answered_with(session_id: int) -> Optional[str]:
    """The model behind this session's most recent coach answer, if any."""
    from .core.sessions import _connect
    try:
        with _connect() as conn:
            row = conn.execute(
                "SELECT model FROM ai_costs WHERE session_id = ? AND kind = 'coach' AND model IS NOT NULL "
                "ORDER BY at DESC, rowid DESC LIMIT 1", (int(session_id),),
            ).fetchone()
    except Exception:
        return None
    return row[0] if row else None


async def generate_notes(session_id: int, model: Optional[str]) -> dict:
    from .routers.mock import _ask_model, _candidate_context

    row = sess.get_session(session_id)
    if row is None:
        raise HTTPException(404, "Session not found")
    lines = transcript_lines(session_id)
    if not lines:
        raise HTTPException(400, "Nothing was said in this session yet")
    # The model that answered during this session, unless one was asked for:
    # it is the one known to work. Settings' model can be a different one, as
    # it was when a recap waited on a provider this session never used.
    model = model or answered_with(session_id)

    profile, _ = _candidate_context(None)
    me = (profile.get("name") or "").strip()
    system_prompt = f"""You take notes on a conversation and write the recap email, and return them as JSON, nothing else.

These may be speech transcripts, so ignore filler words, repeated words and transcription glitches.
Capture only what was actually discussed — never invent details, names, dates or commitments.
Lines marked "Candidate" are {me or "the user"}; lines marked "Interviewer" are the other people in the
conversation (in a meeting they're colleagues, managers or clients, not interviewers).

Return ONLY JSON:
{{"summary": "3-5 sentences on what the conversation covered and where it landed",
 "decisions": ["clear decisions or conclusions reached, if any"],
 "action_items": [{{"who": "name, or 'You' for {me or 'the user'}, or 'Them'", "what": "the concrete task", "due": "the deadline exactly as said ('Friday', 'end of month'), or '' if none was agreed"}}],
 "open_questions": ["questions raised that were never clearly answered, and topics left unresolved"],
 "email": {{"subject": "short recap subject naming the meeting's topic",
            "body": "a recap email from {me or '[Your name]'} to the others: a one-line thank-you, the key decisions, the action items as a short list with owner and due date, any open question to settle, and the next step. 90-180 words, plain text, no markdown headings; list lines start with '- '. Use [Name] if you don't know who it's to."}}}}
Use [] for any part with nothing to report.""" + languages.json_block(languages.output_for_session(session_id))
    from .core.providers import metering_context
    with metering_context("meeting_notes", session_id):
        data = await _ask_model(model, system_prompt, "TRANSCRIPT\n" + "\n".join(lines))

    actions = []
    for a in data.get("action_items", []):
        what = str(a.get("what", "")).strip() if isinstance(a, dict) else str(a).strip()
        if what:
            who = str(a.get("who", "")).strip() if isinstance(a, dict) else ""
            due = str(a.get("due", "")).strip() if isinstance(a, dict) else ""
            actions.append({"who": who or "—", "what": what, "due": due})

    report = {
        "summary": str(data.get("summary", "")).strip(),
        "decisions": _strings(data, "decisions", 8),
        "action_items": actions[:12],
        "open_questions": _strings(data, "open_questions", 10),
        "email": {
            "subject": str((data.get("email") or {}).get("subject", "")).strip(),
            "body": str((data.get("email") or {}).get("body", "")).strip(),
        },
        "model": model or "",
        "generated_at": datetime.utcnow().isoformat(timespec="seconds"),
        "session_title": row["title"],
    }
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET notes_json = ? WHERE id = ?", (json.dumps(report), session_id))
    return report
