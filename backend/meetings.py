"""
Your own meetings: scheduled in iReliabee, without Google or Outlook.

They live in one built-in calendar (kind "ireliabee", "My meetings") in the
same `calendar_events` table as synced invites, so the Calendar tab, a plan
from the invite, "Join & listen" and the in-app reminder work on them as they
are. Sync never touches that calendar and it cannot be removed.

What only your own meetings have is kept in extra columns: the time zone the
time was entered in (and the other side's), topics, what to prepare, notes,
who it is with, links to the rest of the app, reminders, and the Idea board
note it came from. See docs/meetings-and-reminders.md.
"""
from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from . import calendar_sync as cal
from .core import sessions as sess
from .errors import FriendlyError

KIND = "ireliabee"
LABEL = "My meetings"

CHANNELS = ("desktop", "email", "sms")
#: 30 and 15 minutes before, on the desktop; email and text are turned on per meeting (remote_reminders.py).
DEFAULT_REMINDERS = [{"minutes": 30, "channels": ["desktop"]}, {"minutes": 15, "channels": ["desktop"]}]
LINK_KINDS = ("plan", "notebook", "research", "outreach", "person")
#: What a follow-up is: something they asked of you, something you promised, or your own to-do.
FOLLOWUP_KINDS = ("asked", "promised", "todo")
#: When a follow-up's reminder comes on its due day, in the meeting's time zone.
FOLLOWUP_HOUR = 9

LIMITS = {"title": 200, "place": 500, "topic": 200, "topics": 20, "prep": 2000, "notes": 5000,
          "people": 20, "name": 120, "email": 200, "reminders": 6, "links": 10, "link": 300,
          "about": 2000, "followups": 30, "followup": 300}

EXTRA_COLUMNS = {
    "timezone": "TEXT", "their_timezone": "TEXT", "topics_json": "TEXT", "prep": "TEXT", "notes": "TEXT",
    "people_json": "TEXT", "links_json": "TEXT", "reminders_json": "TEXT", "note_id": "INTEGER", "updated_at": "TEXT",
    "about": "TEXT", "followups_json": "TEXT",
}


def _ensure_columns() -> None:
    with sess._connect() as conn:
        have = {r[1] for r in conn.execute("PRAGMA table_info(calendar_events)")}
        for name, kind in EXTRA_COLUMNS.items():
            if name not in have:
                conn.execute(f"ALTER TABLE calendar_events ADD COLUMN {name} {kind}")


_ensure_columns()


def own_calendar_id() -> int:
    """The built-in calendar, made the first time it is needed."""
    with sess._connect() as conn:
        row = conn.execute("SELECT id FROM calendars WHERE kind = ? ORDER BY id LIMIT 1", (KIND,)).fetchone()
        if row:
            return row["id"]
        cur = conn.execute("INSERT INTO calendars (kind, label, created_at) VALUES (?, ?, ?)", (KIND, LABEL, cal._now()))
        return cur.lastrowid


# ── Cleaning what the app sends ──────────────────────────────────────────────

def _s(value: Any, limit: int) -> str:
    return str(value).strip()[:limit] if isinstance(value, (str, int, float)) else ""


def _zone(name: Any, field: str = "timezone") -> Optional[str]:
    name = _s(name, 64)
    if not name:
        return None
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise FriendlyError("invalid", "Unknown time zone", f"{field}: {name}")
    return name


def _when(value: Any, zone: Optional[str]) -> datetime:
    """An ISO time; one without an offset is read in `zone` (else UTC)."""
    text = _s(value, 40)
    if not text:
        raise FriendlyError("invalid", "Pick a date and time", "")
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise FriendlyError("invalid", "That date and time isn't valid", text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ZoneInfo(zone) if zone else timezone.utc)
    return dt


def clean_reminders(raw: Any) -> list[dict]:
    if raw is None:
        return [dict(r, channels=list(r["channels"])) for r in DEFAULT_REMINDERS]
    out, seen = [], set()
    for r in raw if isinstance(raw, list) else []:
        if not isinstance(r, dict):
            continue
        try:
            minutes = int(r.get("minutes"))
        except (TypeError, ValueError):
            continue
        if not 0 <= minutes <= 7 * 24 * 60 or minutes in seen:
            continue
        channels = [c for c in CHANNELS if c in (r.get("channels") or [])]
        if not channels:
            continue
        seen.add(minutes)
        out.append({"minutes": minutes, "channels": channels})
    return sorted(out, key=lambda r: -r["minutes"])[: LIMITS["reminders"]]


def _people(raw: Any) -> list[dict]:
    out = []
    for p in raw if isinstance(raw, list) else []:
        if not isinstance(p, dict):
            continue
        name = _s(p.get("name"), LIMITS["name"])
        email = _s(p.get("email"), LIMITS["email"])
        pid = p.get("id") if isinstance(p.get("id"), int) else None
        if name or email or pid:
            out.append({k: v for k, v in (("id", pid), ("name", name), ("email", email)) if v})
    return out[: LIMITS["people"]]


def _links(raw: Any) -> list[dict]:
    out = []
    for link in raw if isinstance(raw, list) else []:
        if not isinstance(link, dict) or link.get("kind") not in LINK_KINDS:
            continue
        ref = link.get("id")
        ref = ref if isinstance(ref, int) else _s(ref, LIMITS["link"])
        if ref in ("", None):
            continue
        out.append({"kind": link["kind"], "id": ref, "label": _s(link.get("label"), LIMITS["title"])})
    return out[: LIMITS["links"]]


def clean_followups(raw: Any) -> list[dict]:
    """
    Follow-ups: what they asked of you, what you promised, and your own to-dos,
    each with an optional due date (a reminder comes that morning) and done or not.
    """
    out = []
    for f in raw if isinstance(raw, list) else []:
        if not isinstance(f, dict):
            continue
        text = _s(f.get("text"), LIMITS["followup"])
        if not text:
            continue
        due = _s(f.get("due"), 10) or None
        if due:
            try:
                due = datetime.strptime(due, "%Y-%m-%d").strftime("%Y-%m-%d")
            except ValueError:
                raise FriendlyError("invalid", "That due date isn't valid", due)
        fid = _s(f.get("id"), 16) or secrets.token_hex(4)
        remind = [c for c in CHANNELS if c in (f.get("remind") or ["desktop"])]
        out.append({
            "id": fid, "text": text, "kind": f.get("kind") if f.get("kind") in FOLLOWUP_KINDS else "todo",
            "due": due, "done": bool(f.get("done")), "remind": remind,
            **({"source": "notes"} if f.get("source") == "notes" else {}),
        })
    return out[: LIMITS["followups"]]


def clean_meeting(raw: dict, current: Optional[dict] = None) -> dict:
    """A meeting as it is stored: times in UTC, the rest trimmed and checked."""
    base = current or {}
    get = lambda k, d=None: raw[k] if k in raw else base.get(k, d)   # noqa: E731
    title = _s(get("title"), LIMITS["title"])
    if not title:
        raise FriendlyError("invalid", "Give the meeting a title", "")
    zone = _zone(get("timezone")) if "timezone" in raw else base.get("timezone")
    their = _zone(get("their_timezone"), "their_timezone") if "their_timezone" in raw else base.get("their_timezone")
    if "start" not in raw and not base:
        raise FriendlyError("invalid", "Pick a date and time", "")
    start = _when(raw["start"], zone) if "start" in raw else datetime.fromisoformat(base["start"].replace("Z", "+00:00"))
    if "minutes" in raw:
        try:
            minutes = int(raw["minutes"])
        except (TypeError, ValueError):
            raise FriendlyError("invalid", "How long is the meeting?", "")
    elif "end" in raw:
        minutes = int((_when(raw["end"], zone) - start).total_seconds() // 60)
    elif base:
        old_start = datetime.fromisoformat(base["start"].replace("Z", "+00:00"))
        minutes = int((datetime.fromisoformat(base["end"].replace("Z", "+00:00")) - old_start).total_seconds() // 60)
    else:
        minutes = 30
    if not 5 <= minutes <= 24 * 60:
        raise FriendlyError("invalid", "A meeting runs from 5 minutes to a day", "")
    place = _s(get("location", ""), LIMITS["place"])
    join = cal.join_link(_s(get("join_url", ""), LIMITS["place"]), place)
    topics = [t for t in (_s(x, LIMITS["topic"]) for x in (get("topics") or [])) if t][: LIMITS["topics"]]
    return {
        "title": title,
        "start": cal._iso(start),
        "end": cal._iso(start + timedelta(minutes=minutes)),
        "timezone": zone,
        "their_timezone": their,
        "location": place,
        "join_url": join,
        "topics": topics,
        "prep": _s(get("prep", ""), LIMITS["prep"]),
        "notes": _s(get("notes", ""), LIMITS["notes"]),
        "people": _people(get("people")),
        "links": _links(get("links")),
        "reminders": clean_reminders(raw["reminders"] if "reminders" in raw else base.get("reminders")),
        "about": _s(get("about", ""), LIMITS["about"]),
        "followups": clean_followups(get("followups") or []),
        "plan_id": get("plan_id") if isinstance(get("plan_id"), int) else None,
        "note_id": get("note_id") if isinstance(get("note_id"), int) else None,
    }


# ── Storing ──────────────────────────────────────────────────────────────────

def _description(m: dict) -> str:
    """The plain text a plan-from-invite reads: topics and what to prepare."""
    parts = []
    if m["topics"]:
        parts.append("Topics:\n" + "\n".join(f"- {t}" for t in m["topics"]))
    if m["prep"]:
        parts.append("Prepare:\n" + m["prep"])
    return "\n\n".join(parts)


def _row_values(m: dict) -> tuple:
    return (m["start"], m["end"], m["title"], m["location"], _description(m),
            json.dumps([{"name": p.get("name", ""), "email": p.get("email", "")} for p in m["people"]]), m["join_url"],
            m["plan_id"], m["timezone"], m["their_timezone"], json.dumps(m["topics"]), m["prep"], m["notes"],
            json.dumps(m["people"]), json.dumps(m["links"]), json.dumps(m["reminders"]), m["note_id"], cal._now(),
            m["about"], json.dumps(m["followups"]))


def create_meeting(raw: dict) -> dict:
    m = clean_meeting(raw)
    cid = own_calendar_id()
    with sess._connect() as conn:
        cur = conn.execute(
            "INSERT INTO calendar_events (calendar_id, uid, start, end, all_day, title, location, description, attendees_json, "
            "join_url, plan_id, timezone, their_timezone, topics_json, prep, notes, people_json, links_json, reminders_json, "
            "note_id, updated_at, about, followups_json) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cid, f"ireliabee-{secrets.token_hex(8)}", *_row_values(m)))
        new_id = cur.lastrowid
    return _with_remote(get_meeting(new_id))


def _with_remote(m: dict) -> dict:
    """The meeting, after its email and text reminders are sent to ireliabee.co.uk (if it has any)."""
    from . import remote_reminders
    m["remote"] = remote_reminders.push(m)
    return m


def _own_row(event_id: int) -> dict:
    with sess._connect() as conn:
        row = conn.execute(
            "SELECT e.* FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ? AND c.kind = ?",
            (event_id, KIND)).fetchone()
    if not row:
        raise FriendlyError("not_found", "That meeting isn't in your calendar any more", "")
    return dict(row)


def get_meeting(event_id: int) -> dict:
    return to_meeting(_own_row(event_id))


def to_meeting(row: dict) -> dict:
    """A stored row as the app sees it (synced invites get the same shape, with the extras empty)."""
    ev = cal._event(row)
    for key in ("timezone", "their_timezone", "prep", "notes", "note_id", "updated_at", "about"):
        ev.setdefault(key, None)
    ev.setdefault("followups", [])
    return ev


def open_followups() -> list[dict]:
    """
    Every follow-up not yet done, from any of your meetings, past or to come,
    soonest due first (undated last): the Calendar tab's "To follow up".
    """
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT e.* FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id "
            "WHERE c.kind = ? AND e.followups_json IS NOT NULL AND e.followups_json != '[]'", (KIND,)).fetchall()
    out = []
    for row in rows:
        m = to_meeting(dict(row))
        for f in m["followups"]:
            if not f.get("done"):
                out.append({**f, "meeting_id": m["id"], "meeting_title": m["title"], "meeting_start": m["start"],
                            "timezone": m.get("timezone")})
    return sorted(out, key=lambda f: (f["due"] is None, f["due"] or "", f["meeting_start"]))


def set_followup_done(event_id: int, followup_id: str, done: bool) -> dict:
    """Tick a follow-up off (or back on) without sending the whole meeting."""
    m = get_meeting(event_id)
    if not any(f["id"] == followup_id for f in m["followups"]):
        raise FriendlyError("not_found", "That follow-up isn't on this meeting any more", "")
    followups = [dict(f, done=done) if f["id"] == followup_id else f for f in m["followups"]]
    return update_meeting(event_id, {"followups": followups})


def update_meeting(event_id: int, raw: dict) -> dict:
    current = get_meeting(event_id)
    m = clean_meeting(raw, current)
    with sess._connect() as conn:
        conn.execute(
            "UPDATE calendar_events SET start = ?, end = ?, title = ?, location = ?, description = ?, attendees_json = ?, "
            "join_url = ?, plan_id = ?, timezone = ?, their_timezone = ?, topics_json = ?, prep = ?, notes = ?, "
            "people_json = ?, links_json = ?, reminders_json = ?, note_id = ?, updated_at = ?, about = ?, followups_json = ? "
            "WHERE id = ?",
            (*_row_values(m), event_id))
    return _with_remote(get_meeting(event_id))


def delete_meeting(event_id: int) -> None:
    from . import remote_reminders
    row = _own_row(event_id)
    remote_reminders.forget(row["uid"], row.get("remote_state"))
    with sess._connect() as conn:
        conn.execute("DELETE FROM calendar_events WHERE id = ?", (event_id,))
        have = {r[1] for r in conn.execute("PRAGMA table_info(board_notes)")}
        if "event_id" in have:      # the Idea board note it came from forgets it
            conn.execute("UPDATE board_notes SET event_id = NULL WHERE event_id = ?", (event_id,))


def upcoming(now: Optional[datetime] = None, days: int = 60) -> list[dict]:
    """Your own meetings from now on, soonest first (the Calendar tab's list and the reminders)."""
    now = now or datetime.now(timezone.utc)
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT e.* FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id "
            "WHERE c.kind = ? AND e.end > ? AND e.start < ? ORDER BY e.start",
            (KIND, cal._iso(now), cal._iso(now + timedelta(days=days)))).fetchall()
    return [to_meeting(dict(r)) for r in rows]


# ── After the call (H1b) ─────────────────────────────────────────────────────
#
# A session started from a meeting (Join & listen, Set up session) carries the
# meeting's id in its setup. When its notebook is written, the meeting gets a
# link to it, and the notebook's action items become the meeting's follow-ups,
# so what was agreed on the call is on the Calendar tab's "To follow up".

#: Words that mean the action is the user's own, when the notes name its owner.
_MINE = {"", "me", "i", "you", "myself", "not agreed", "us", "we"}
#: The most action items one notebook adds, so a long meeting cannot flood the list.
MAX_FROM_NOTES = 12


def _meeting_of_session(session_id: int) -> Optional[int]:
    with sess._connect() as conn:
        have = {r[1] for r in conn.execute("PRAGMA table_info(sessions)")}
        if "setup_json" not in have:
            return None
        row = conn.execute("SELECT setup_json FROM sessions WHERE id = ?", (session_id,)).fetchone()
    try:
        setup = json.loads(row["setup_json"]) if row and row["setup_json"] else {}
    except ValueError:
        return None
    event_id = setup.get("event_id") if isinstance(setup, dict) else None
    return event_id if isinstance(event_id, int) else None


def followups_from_notes(actions: list, existing: list[dict]) -> list[dict]:
    """
    The notebook's action items as follow-ups: one to someone else is kept as
    theirs ("Dr. Reyes: send the reading list"), a spoken due date stays in
    the text, and none is added twice.
    """
    seen = {f["text"].strip().lower() for f in existing}
    out = []
    for a in actions or []:
        if not isinstance(a, dict) or a.get("done"):
            continue
        text = _s(a.get("text"), LIMITS["followup"] - 60)
        if not text:
            continue
        owner = _s(a.get("owner"), 60)
        if owner.lower() not in _MINE:
            text = f"{owner}: {text}"
        due_said = _s(a.get("due"), 40)
        due = None
        try:
            due = datetime.strptime(due_said, "%Y-%m-%d").strftime("%Y-%m-%d") if due_said else None
        except ValueError:
            text = f"{text} (by {due_said})"
        if text.strip().lower() in seen:
            continue
        seen.add(text.strip().lower())
        out.append({"text": text, "kind": "todo", "due": due, "done": False, "remind": ["desktop"], "source": "notes"})
        if len(out) >= MAX_FROM_NOTES:
            break
    return out


def attach_notebook(session_id: int, notebook: dict) -> Optional[dict]:
    """Link a session's notebook to the meeting it was started from, and add its action items. None if there is none."""
    event_id = _meeting_of_session(session_id)
    if event_id is None:
        return None
    try:
        m = get_meeting(event_id)
    except FriendlyError:
        return None                                # a synced invite, or a meeting since deleted
    links = [l for l in m["links"] if not (l["kind"] == "notebook" and l["id"] == notebook["id"])]
    links.append({"kind": "notebook", "id": notebook["id"], "label": notebook.get("title") or "Notes from the call"})
    actions = ((notebook.get("doc") or {}).get("board") or {}).get("actions") or []
    added = followups_from_notes(actions, m["followups"])
    return update_meeting(event_id, {"links": links, "followups": m["followups"] + added})
