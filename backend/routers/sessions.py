"""
Sessions router — extended with subtitle, tags, status, duration_sec on top of
the CLI's base sessions table. Columns are added lazily on module import.
"""
import json
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import languages
from ..core import sessions as sess
from ..entitlements import require_pro
router = APIRouter()


# ── Lazy schema migration for desktop-only columns ───────────────────────────

def _ensure_extended_schema():
    with sess._connect() as conn:
        for stmt in (
            "ALTER TABLE sessions ADD COLUMN subtitle TEXT",
            "ALTER TABLE sessions ADD COLUMN tags TEXT",       # comma-separated
            "ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'draft'",
            "ALTER TABLE sessions ADD COLUMN duration_sec INTEGER DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN started_at TEXT",
            "ALTER TABLE sessions ADD COLUMN ended_at TEXT",
            "ALTER TABLE sessions ADD COLUMN saved_at TEXT",
            "ALTER TABLE sessions ADD COLUMN paused_at TEXT",
            "ALTER TABLE sessions ADD COLUMN delivery_json TEXT",
            "ALTER TABLE sessions ADD COLUMN paused_sec INTEGER DEFAULT 0",
            # How the session was set up (SessionSetup), so Start opens it as
            # it was made: its plan, files, people and instructions.
            "ALTER TABLE sessions ADD COLUMN setup_json TEXT",
        ):
            try:
                conn.execute(stmt)
            except Exception:
                pass


_ensure_extended_schema()


# ── Request bodies ───────────────────────────────────────────────────────────

class SessionSetup(BaseModel):
    """
    What a session was set up with, beyond its title and coach.

    Kept so a saved session opens as it was made. It used to open with the
    default coach and no plan, files or people, and the coach answered a PhD
    interview as a work meeting. Every field is optional, and an update
    changes only the fields it names.
    """
    plan_id: Optional[int] = None
    cv_id: Optional[int] = None
    document_ids: Optional[list[int]] = None
    people_ids: Optional[list[int]] = None
    ai_instructions: Optional[str] = Field(default=None, max_length=4000)
    response_tone: Optional[str] = Field(default=None, max_length=40)
    auto_answer: Optional[bool] = None       # Auto Answer for what they say
    auto_answer_you: Optional[bool] = None   # and for what you say (absent: follows auto_answer)
    #: The calendar meeting this session was started from (Join & listen), so its
    #: notes and action items find their way back to it (meetings.attach_notebook).
    event_id: Optional[int] = None


class SessionCreateBody(BaseModel):
    title: str
    subtitle: Optional[str] = None
    tags: Optional[list[str]] = None
    template: str = "tech-interview"
    llm_provider: str = ""
    llm_model: str = ""
    language: Optional[str] = None
    display_language: Optional[str] = None   # what the user reads in ("" = same as spoken)
    setup: Optional[SessionSetup] = None


class SessionUpdateBody(BaseModel):
    title: Optional[str] = None
    subtitle: Optional[str] = None
    tags: Optional[list[str]] = None
    language: Optional[str] = None
    display_language: Optional[str] = None   # what the user reads in ("" = same as spoken)
    # The coach, changed in the session's Preferences.
    template: Optional[str] = Field(default=None, max_length=60)
    setup: Optional[SessionSetup] = None


# ── Helpers ──────────────────────────────────────────────────────────────────

def _row_to_dict(row) -> dict:
    d = dict(row)
    # Parse tags into a list for the client
    tags_raw = d.get("tags") or ""
    d["tags"] = [t.strip() for t in tags_raw.split(",") if t.strip()]
    d["setup"] = _setup_of(d.pop("setup_json", None))
    return d


def _setup_of(raw) -> dict:
    """The stored setup, or an empty one for a session made before it was kept."""
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _merged_setup(current, change: SessionSetup) -> str:
    """The stored setup with the fields this change names replaced."""
    return json.dumps({**_setup_of(current), **change.model_dump(exclude_unset=True)})


def _paused_for(conn, session_id: int, now: str) -> int:
    """Seconds of the current pause, if the session is paused right now."""
    row = conn.execute("SELECT status, paused_at FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if not row or row["status"] != "paused" or not row["paused_at"]:
        return 0
    try:
        return max(0, int(datetime.fromisoformat(now).timestamp() - datetime.fromisoformat(row["paused_at"]).timestamp()))
    except ValueError:
        return 0


def purge_unanswered_mocks(min_age_minutes: int = 10) -> int:
    """Delete mock interviews where the candidate never answered anything.

    They're calls that never really started (only the greeting was recorded) and
    clutter the history. Recent ones are left alone in case they're still running.

    Narrow on purpose, since it deletes without asking (audit 181-H11):
    - only sessions /mock created, whose tags *start* with "mock" (a user's
      own "mock-prep" tag used to match);
    - only if nobody said anything at all, whatever the line was labelled
      (answers recorded as "interviewer" or "unknown" used to count as none);
    - never one that was finished and so kept on purpose.
    """
    cutoff = (datetime.utcnow() - timedelta(minutes=min_age_minutes)).isoformat(timespec="seconds")
    with sess._connect() as conn:
        ids = [r[0] for r in conn.execute(
            "SELECT s.id FROM sessions s "
            "WHERE (COALESCE(s.tags, '') = 'mock' OR COALESCE(s.tags, '') LIKE 'mock,%') "
            "AND s.created_at < ? "
            "AND COALESCE(s.status, '') IN ('', 'draft', 'active') "
            "AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role = 'user')",
            (cutoff,),
        )]
    for sid in ids:
        sess.delete_session(sid)
    return len(ids)


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/")
def list_sessions(status: Optional[str] = None):
    """Return sessions with turn counts + extended columns.

    Optional query ?status=draft|active|ended to filter.
    """
    purge_unanswered_mocks()
    with sess._connect() as conn:
        sql = (
            "SELECT s.*, "
            "       (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS turns "
            "FROM sessions s "
        )
        params: tuple = ()
        if status:
            sql += "WHERE COALESCE(s.status, 'draft') = ? "
            params = (status,)
        sql += "ORDER BY s.updated_at DESC LIMIT 200"
        rows = conn.execute(sql, params).fetchall()
        return [_row_to_dict(r) for r in rows]


@router.post("/")
def create_session(body: SessionCreateBody):
    """Create a stub session (status='draft'). Turns will flip it to 'active'."""
    session_id = sess.create_session(
        title=body.title,
        mode=body.template,
        llm_provider=body.llm_provider,
        llm_model=body.llm_model,
    )
    with sess._connect() as conn:
        conn.execute(
            "UPDATE sessions SET subtitle = ?, tags = ?, status = 'draft', setup_json = ?, updated_at = ? WHERE id = ?",
            (body.subtitle, ",".join(body.tags or []),
             _merged_setup(None, body.setup) if body.setup else None, _now(), session_id),
        )
    languages.set_for_session(session_id, body.language)
    if body.display_language:
        languages.set_display_for_session(session_id, body.display_language)
    return get_one(session_id)


@router.get("/{session_id}")
def get_one(session_id: int):
    row = sess.get_session(session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    with sess._connect() as conn:
        row = conn.execute(
            "SELECT s.*, "
            "       (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS turns "
            "FROM sessions s WHERE id = ?",
            (session_id,),
        ).fetchone()
        return _row_to_dict(row)


@router.get("/{session_id}/messages")
def get_messages(session_id: int):
    """Return all persisted messages for this session with timestamps + speaker."""
    if sess.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT id, role, content, speaker, created_at "
            "FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
    return [dict(r) for r in rows]


@router.put("/{session_id}")
def update_session(session_id: int, body: SessionUpdateBody):
    if sess.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    fields = []
    values: list = []
    if body.title is not None:
        fields.append("title = ?");    values.append(body.title)
    if body.subtitle is not None:
        fields.append("subtitle = ?"); values.append(body.subtitle)
    if body.tags is not None:
        fields.append("tags = ?");     values.append(",".join(body.tags))
    if body.template:
        fields.append("mode = ?");     values.append(body.template)
    if body.setup is not None:
        with sess._connect() as conn:
            current = conn.execute("SELECT setup_json FROM sessions WHERE id = ?", (session_id,)).fetchone()
        fields.append("setup_json = ?"); values.append(_merged_setup(current["setup_json"] if current else None, body.setup))
    if body.language is not None:
        languages.set_for_session(session_id, body.language)
    if body.display_language is not None:
        languages.set_display_for_session(session_id, body.display_language or None)
    if not fields:
        return get_one(session_id)
    fields.append("updated_at = ?");   values.append(_now())
    values.append(session_id)
    with sess._connect() as conn:
        conn.execute(f"UPDATE sessions SET {', '.join(fields)} WHERE id = ?", values)
    return get_one(session_id)


@router.post("/{session_id}/start")
def start_session(session_id: int):
    """Mark a draft as active, or resume a paused one. Sets started_at if not set."""
    if sess.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    now = _now()
    with sess._connect() as conn:
        conn.execute(
            "UPDATE sessions SET paused_sec = COALESCE(paused_sec, 0) + ?, paused_at = NULL WHERE id = ?",
            (_paused_for(conn, session_id, now), session_id),
        )
        conn.execute(
            "UPDATE sessions SET status = 'active', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
            (now, now, session_id),
        )
    return get_one(session_id)


@router.post("/{session_id}/save")
def save_session(session_id: int):
    """Explicitly promote a session to 'saved' — hides it from the auto-clutter filter."""
    if sess.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    now = _now()
    with sess._connect() as conn:
        conn.execute(
            "UPDATE sessions SET saved_at = COALESCE(saved_at, ?), updated_at = ? WHERE id = ?",
            (now, now, session_id),
        )
    return get_one(session_id)


@router.post("/{session_id}/pause")
def pause_session(session_id: int):
    """Mark a session as paused (still resumable). Paused time isn't counted in its duration."""
    row = sess.get_session(session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if row["status"] == "paused":
        return get_one(session_id)
    now = _now()
    with sess._connect() as conn:
        conn.execute(
            "UPDATE sessions SET status = 'paused', paused_at = ?, updated_at = ? WHERE id = ?",
            (now, now, session_id),
        )
    return get_one(session_id)


class TranscriptBody(BaseModel):
    text: str
    speaker: str = "interviewer"


@router.post("/{session_id}/transcript")
def record_transcript(session_id: int, body: TranscriptBody):
    """Save what was said without asking the coach (roadmap 3.1: lectures are recorded, not answered)."""
    if sess.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Nothing to record")
    speaker = "interviewer" if body.speaker == "interviewer" else "user"
    sess.append_message(session_id, "user", f"[{speaker.upper()}] {text}", speaker)
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET status = CASE WHEN status = 'draft' THEN 'active' ELSE status END, "
                     "started_at = COALESCE(started_at, ?) WHERE id = ?", (_now(), session_id))
    return {"ok": True}


@router.post("/{session_id}/end")
def end_session(session_id: int):
    """Mark ended and compute duration."""
    if sess.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    now = _now()
    with sess._connect() as conn:
        row = conn.execute("SELECT started_at, created_at, paused_sec FROM sessions WHERE id = ?", (session_id,)).fetchone()
        start_iso = row["started_at"] or row["created_at"]
        paused = (row["paused_sec"] or 0) + _paused_for(conn, session_id, now)
        try:
            start_ts = datetime.fromisoformat(start_iso).timestamp()
            end_ts = datetime.fromisoformat(now).timestamp()
            duration = max(0, int(end_ts - start_ts) - paused)
        except Exception:
            duration = 0
        conn.execute(
            "UPDATE sessions SET status = 'ended', ended_at = ?, duration_sec = ?, paused_sec = ?, paused_at = NULL, updated_at = ? WHERE id = ?",
            (now, duration, paused, now, session_id),
        )
    return get_one(session_id)


@router.delete("/{session_id}")
def delete_session(session_id: int):
    row = sess.get_session(session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    sess.delete_session(session_id)
    return {"ok": True}


# ── Debrief ──────────────────────────────────────────────────────────────────

class DebriefBody(BaseModel):
    model: Optional[str] = None
    response_tone: Optional[str] = None


@router.get("/{session_id}/debrief")
def get_debrief(session_id: int):
    from ..debrief import load_debrief
    return {"debrief": load_debrief(session_id)}


@router.post("/{session_id}/debrief")
async def create_debrief(session_id: int, body: DebriefBody):
    from ..debrief import generate_debrief
    return await generate_debrief(session_id, body.model, body.response_tone)


@router.post("/{session_id}/debrief/export",
             dependencies=[Depends(require_pro("export"))])
def export_debrief(session_id: int):
    from ..debrief import export_pdf
    return {"path": str(export_pdf(session_id))}


# ── Delivery stats (pace, fillers, talk share) ───────────────────────────────

class DeliveryBody(BaseModel):
    words: int = 0
    speaking_sec: int = 0
    wpm: int = 0
    fillers: int = 0
    filler_rate: float = 0
    talk_share: Optional[int] = None
    long_answers: int = 0


@router.post("/{session_id}/delivery")
def save_delivery(session_id: int, body: DeliveryBody):
    if sess.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET delivery_json = ? WHERE id = ?", (json.dumps(body.model_dump()), session_id))
    return {"ok": True}


# ── Thank-you / follow-up email ──────────────────────────────────────────────

EMAIL_KINDS = {
    "thank_you": "a thank-you email sent within 24 hours of the interview",
    "follow_up": "a polite follow-up email checking on the status after not hearing back for a week or more",
    "recap": "a short recap email after a work meeting, listing what was agreed and the next steps",
}


def _translation_target(session_id: int, language: str) -> str:
    from .. import transcript_translate as tt
    if sess.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if not tt.target_ok(language):
        raise HTTPException(status_code=400, detail="Pick one language to translate into")
    return language


@router.get("/{session_id}/translation")
def get_translation(session_id: int, language: str):
    """The transcript's translations into `language` kept so far (T3), by message id."""
    from .. import transcript_translate as tt
    return tt.status(session_id, _translation_target(session_id, language))


@router.get("/{session_id}/translation/estimate")
def translation_estimate(session_id: int, language: str, model: Optional[str] = None):
    """What translating the rest of the transcript costs, before anything is spent."""
    from .. import transcript_translate as tt
    return tt.estimate(session_id, _translation_target(session_id, language), model)


class TranslateBody(BaseModel):
    language: str
    model: Optional[str] = None
    fallback_credits: bool = False


@router.post("/{session_id}/translation")
async def translate_transcript(session_id: int, body: TranslateBody):
    """Translate the lines that have no translation yet; kept, so each line is only paid for once."""
    from .. import transcript_translate as tt
    return await tt.translate(session_id, _translation_target(session_id, body.language), body.model,
                              body.fallback_credits)


@router.get("/{session_id}/transcript.md")
def transcript_markdown(session_id: int, language: Optional[str] = None, them: str = "Them"):
    """The transcript as Markdown, as said or in a language it has been translated into."""
    from .. import transcript_translate as tt
    if sess.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"markdown": tt.markdown(session_id, language, them[:40] or "Them")}


class EmailBody(BaseModel):
    kind: str = "thank_you"
    recipient: Optional[str] = None
    notes: Optional[str] = None
    model: Optional[str] = None
    response_tone: Optional[str] = None
    # The email goes to people on the call, who may not read what the user reads: None writes it in
    # the session's reading language, a code writes it in that one ("In {spoken}", T3).
    language: Optional[str] = None


@router.post("/{session_id}/email", dependencies=[Depends(require_pro("recap"))])
async def write_email(session_id: int, body: EmailBody):
    from ..debrief import transcript_lines
    from .coach import RESPONSE_TONES, tone_block, _resolve_tone
    from .mock import _ask_model, _candidate_context

    row = sess.get_session(session_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    lines = transcript_lines(session_id)
    if not lines:
        raise HTTPException(status_code=400, detail="This session has no conversation to write about yet")

    kind = body.kind if body.kind in EMAIL_KINDS else "thank_you"
    profile, _ = _candidate_context(None)
    tone = _resolve_tone(body.response_tone)
    name = profile.get("name") or ""
    transcript = "\n".join(lines)[-12000:]
    write_in = body.language if body.language in languages.LANGUAGES and body.language != "multi" \
        else languages.output_for_session(session_id)

    system_prompt = f"""You write short, warm, professional emails for {name or "the sender"}.
Write {EMAIL_KINDS[kind]}.

Rules:
- 90–160 words. Plain text, no markdown.
- Refer to one or two specific things that were actually discussed in the conversation, so it
  doesn't read like a template. Never invent facts, names, dates or promises.
- {"Address it to " + body.recipient.strip() + "." if (body.recipient or "").strip() else "If the interviewer's name appears in the conversation use it, otherwise use [Name]."}
- Use [placeholders] for anything you don't know (role title, company) unless it's in the conversation.
- Sign off with {name or "[Your name]"}.
- Don't grovel or oversell; sound like a confident, genuine person.

Return ONLY JSON: {{"subject": "...", "body": "..."}}

{tone_block(tone, write_in)}{languages.json_block(write_in)}"""
    message = f"SESSION: {row['title']}\n\nCONVERSATION\n{transcript}"
    if (body.notes or "").strip():
        message += f"\n\nEXTRA NOTES FROM THE SENDER (include these): {body.notes.strip()[:1000]}"
    data = await _ask_model(body.model, system_prompt, message)
    return {
        "subject": str(data.get("subject", "")).strip(),
        "body": str(data.get("body", "")).strip(),
    }


@router.post("/{session_id}/fallback-credits")
async def session_fallback_credits(session_id: int):
    from .coach import _fallback_sessions
    _fallback_sessions.add(session_id)
    return {"ok": True, "session_id": session_id, "fallback_credits": True}
