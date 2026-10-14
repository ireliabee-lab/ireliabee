"""
Meeting reminders by email and text message: the part that leaves the laptop.

Desktop reminders never leave it (MeetingReminders.tsx). An email or text one
has to, because ireliabee.co.uk sends it, so it arrives with the laptop asleep
(docs/meetings-and-reminders.md, R2; website/functions/_shared/reminders.js).

Only what the reminder says goes: the title, the time in your zone (and
theirs), the link or place, the topics and what to prepare, exactly the text
`reminder_texts` builds and the app shows. Never the notes, the plan, the
people or anything else. Nothing is sent for a meeting with no email or text
reminder, unless it had one before and it has to be taken back.

A meeting that could not be sent (offline, signed out) is marked and sent
again on the next calendar sync; so is a deletion.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .core import account
from .core import sessions as sess

REMOTE = ("email", "sms")
TIMEOUT_SECONDS = 10

#: `calendar_events.remote_state`: "sent" when the service holds this meeting's
#: reminders, "pending" when they still have to be sent (or taken back).
_COLUMNS = {"remote_state": "TEXT"}


def _ensure() -> None:
    with sess._connect() as conn:
        have = {r[1] for r in conn.execute("PRAGMA table_info(calendar_events)")}
        for name, kind in _COLUMNS.items():
            if name not in have:
                conn.execute(f"ALTER TABLE calendar_events ADD COLUMN {name} {kind}")
        # Deleted meetings whose reminders the service may still hold.
        conn.execute("CREATE TABLE IF NOT EXISTS remote_reminders_forget (uid TEXT PRIMARY KEY)")


_ensure()


# -- The text ------------------------------------------------------------------

def _zone(name: Optional[str]):
    try:
        return ZoneInfo(name) if name else None
    except (ZoneInfoNotFoundError, ValueError):
        return None


def _clock(dt: datetime) -> str:
    return dt.strftime("%I:%M %p").lstrip("0").lower()


def _day(dt: datetime) -> str:
    return f"{dt.strftime('%a')} {dt.day} {dt.strftime('%b')}"


def _city(name: str) -> str:
    return name.rsplit("/", 1)[-1].replace("_", " ")


def lead_label(minutes: int) -> str:
    if minutes % 1440 == 0:
        n = minutes // 1440
        return "1 day" if n == 1 else f"{n} days"
    if minutes % 60 == 0:
        n = minutes // 60
        return "1 hour" if n == 1 else f"{n} hours"
    return f"{minutes} minutes"


def reminder_text(m: dict, minutes: int) -> dict:
    """What one reminder says, as the app shows it: a subject and the lines of the message."""
    start = datetime.fromisoformat(str(m["start"]).replace("Z", "+00:00"))
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    mine = _zone(m.get("timezone")) or timezone.utc
    local = start.astimezone(mine)
    lead = lead_label(minutes)
    lines = [m.get("title") or "Meeting", f"In {lead}, at {_clock(local)} ({local.tzname()}), {_day(local)}"]
    theirs = _zone(m.get("their_timezone"))
    if theirs and m.get("their_timezone") != m.get("timezone"):
        there = start.astimezone(theirs)
        lines.append(f"That's {_clock(there)} in {_city(m['their_timezone'])}")
    if m.get("join_url"):
        lines.append(f"Join: {m['join_url']}")
    elif m.get("location"):
        lines.append(f"Where: {m['location']}")
    if m.get("topics"):
        lines.append("Topics: " + "; ".join(m["topics"][:6]))
    if m.get("prep"):
        lines.append(f"Prepare: {m['prep']}")
    return {"subject": f"{m.get('title') or 'Meeting'} in {lead}", "text": "\n".join(lines)}


def followup_text(m: dict, f: dict) -> dict:
    """A follow-up's reminder, on the morning it is due."""
    start = datetime.fromisoformat(str(m["start"]).replace("Z", "+00:00"))
    local = start.astimezone(_zone(m.get("timezone")) or timezone.utc)
    lead = {"asked": "They asked", "promised": "You promised", "todo": "To do"}.get(f.get("kind"), "To do")
    lines = [f"Due today: {f['text']}", f"{lead}, from: {m.get('title') or 'Meeting'} ({_day(local)})"]
    return {"subject": f"Due today: {f['text']}"[:200], "text": "\n".join(lines)}


def followup_at(m: dict, f: dict) -> Optional[int]:
    """9:00 on the due day, in the meeting's zone (unix seconds), or None without a due date."""
    from .meetings import FOLLOWUP_HOUR
    if not f.get("due") or f.get("done"):
        return None
    zone = _zone(m.get("timezone")) or timezone.utc
    day = datetime.strptime(f["due"], "%Y-%m-%d").replace(hour=FOLLOWUP_HOUR, tzinfo=zone)
    return int(day.timestamp())


def reminder_texts(m: dict) -> list[dict]:
    """Every email and text reminder of this meeting and its follow-ups, ready for the service."""
    start = datetime.fromisoformat(str(m["start"]).replace("Z", "+00:00"))
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    out = []
    for r in m.get("reminders") or []:
        at = int((start - timedelta(minutes=int(r["minutes"]))).timestamp())
        said = reminder_text(m, int(r["minutes"]))
        for channel in REMOTE:
            if channel in (r.get("channels") or []):
                out.append({"at": at, "channel": channel, **said})
    for f in m.get("followups") or []:
        at = followup_at(m, f)
        if at is None:
            continue
        said = followup_text(m, f)
        for channel in REMOTE:
            if channel in (f.get("remind") or []):
                out.append({"at": at, "channel": channel, **said})
    return out


# -- Talking to the service ------------------------------------------------------

class RemoteError(Exception):
    """The service could not be told; the meeting is kept and sent again later."""


def _call(method: str, path: str, body: Optional[dict] = None) -> dict:
    import requests
    token = account.access_token()
    if not token:
        raise RemoteError("Sign in to iReliabee to get reminders by email or text message.")
    try:
        r = requests.request(method, f"{account._api()}{path}", json=body,
                             headers={"authorization": f"Bearer {token}"}, timeout=TIMEOUT_SECONDS)
    except Exception:
        raise RemoteError("Could not reach iReliabee. Your email and text reminders will be set up when you're back online.")
    try:
        data = r.json()
    except Exception:
        data = {}
    if r.status_code >= 400:
        raise RemoteError(data.get("message") or "iReliabee could not set up those reminders. Try again in a few minutes.")
    return data


def phone() -> dict:
    """The confirmed number (masked) and what a text costs; an empty answer when signed out."""
    if not account.access_token():
        return {"phone": None, "confirmed": False, "price": None, "signed_in": False}
    return {**_call("GET", "/phone"), "signed_in": True}


def phone_start(number: str) -> dict:
    return _call("POST", "/phone", {"number": number})


def phone_confirm(code: str) -> dict:
    return _call("POST", "/phone/confirm", {"code": code})


def _set_state(uid: str, state: Optional[str]) -> None:
    with sess._connect() as conn:
        conn.execute("UPDATE calendar_events SET remote_state = ? WHERE uid = ?", (state, uid))


def _state(uid: str) -> Optional[str]:
    with sess._connect() as conn:
        row = conn.execute("SELECT remote_state FROM calendar_events WHERE uid = ?", (uid,)).fetchone()
    return row["remote_state"] if row else None


def push(m: dict) -> Optional[dict]:
    """
    Send this meeting's email and text reminders, replacing any the service
    holds. None when there is nothing to send; otherwise what they will cost,
    or why they could not be sent yet (they are sent again on the next sync).
    """
    texts = reminder_texts(m)
    if not texts and _state(m["uid"]) is None:
        return None                               # never had any: nothing leaves the laptop
    try:
        got = _call("PUT", f"/reminders/{m['uid']}", {"reminders": texts})
    except RemoteError as e:
        _set_state(m["uid"], "pending")
        return {"ok": False, "message": str(e)}
    _set_state(m["uid"], "sent" if texts else None)
    return {"ok": True, **got}


def forget(uid: str, state: Optional[str]) -> None:
    """A deleted meeting: take back its reminders, now or on the next sync."""
    if state is None:
        return
    try:
        _call("DELETE", f"/reminders/{uid}")
    except RemoteError:
        with sess._connect() as conn:
            conn.execute("INSERT OR IGNORE INTO remote_reminders_forget (uid) VALUES (?)", (uid,))


def resend_pending() -> int:
    """Send what could not be sent before (the calendar sync calls this). Returns how many went."""
    from . import meetings
    with sess._connect() as conn:
        uids = [r["uid"] for r in conn.execute("SELECT uid FROM remote_reminders_forget").fetchall()]
        rows = conn.execute("SELECT id FROM calendar_events WHERE remote_state = 'pending'").fetchall()
    if not (uids or rows) or not account.access_token():
        return 0
    done = 0
    for uid in uids:
        try:
            _call("DELETE", f"/reminders/{uid}")
        except RemoteError:
            continue
        with sess._connect() as conn:
            conn.execute("DELETE FROM remote_reminders_forget WHERE uid = ?", (uid,))
        done += 1
    for row in rows:
        result = push(meetings.get_meeting(row["id"]))
        done += 1 if result and result.get("ok") else 0
    return done
