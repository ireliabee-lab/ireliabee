import asyncio
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from .. import calendar_sync as cal
from .. import meetings
from ..entitlements import require_pro
from ..errors import FriendlyError


def _our_port(request: Request) -> int:
    """
    The port this backend is actually listening on.

    From the socket uvicorn is serving, not from the request's Host header:
    the app no longer insists on 8000, so a header without a port must not be
    answered with a number nobody is listening on. The links built from this
    go to a browser and have to come back here.
    """
    server = request.scope.get("server") or ()
    if len(server) > 1 and server[1]:
        return int(server[1])
    return request.url.port or 8000

router = APIRouter()

# Client IDs of the apps the user registers for sign-in (not secrets for PKCE
# clients, but kept with the other keys in .env).
CALENDAR_KEYS = [
    {"env": "GOOGLE_CLIENT_ID", "provider": "google"},
    {"env": "GOOGLE_CLIENT_SECRET", "provider": "google"},
    {"env": "MICROSOFT_CLIENT_ID", "provider": "microsoft"},
]


def _run(fn, *args):
    return asyncio.get_running_loop().run_in_executor(None, fn, *args)


@router.get("/calendars")
def calendars(request: Request):
    port = _our_port(request)
    return {
        "calendars": cal.list_calendars(),
        "providers": {
            p: {"label": v["label"], "ready": cal.oauth_ready(p), "redirect_uri": cal.redirect_uri(p, port),
                "keys": {k["env"]: bool(os.environ.get(k["env"])) for k in CALENDAR_KEYS if k["provider"] == p}}
            for p, v in cal.PROVIDERS.items()
        },
    }


class LinkBody(BaseModel):
    url: str
    label: str = ""


@router.post("/calendars/link", dependencies=[Depends(require_pro("calendar"))])
async def add_link(body: LinkBody):
    return await _run(lambda: cal.add_ics(body.label, url=body.url))


@router.post("/calendars/file", dependencies=[Depends(require_pro("calendar"))])
async def add_file(file: UploadFile = File(...), label: str = Form("")):
    raw = await file.read(cal.MAX_ICS_BYTES + 1)
    text = raw.decode("utf-8", errors="replace")
    name = label or (file.filename or "").rsplit(".", 1)[0]
    return await _run(lambda: cal.add_ics(name, text=text))


@router.delete("/calendars/{calendar_id}")
def remove(calendar_id: int):
    cal.remove_calendar(calendar_id)
    return {"ok": True}


@router.post("/sync", dependencies=[Depends(require_pro("calendar"))])
async def sync():
    await _run(cal.sync_all)
    return {"calendars": cal.list_calendars()}


@router.get("/events")
def events(start: Optional[str] = None, end: Optional[str] = None, days: int = 7):
    """Meetings between start and end (ISO, UTC); by default from the start of today for `days` days."""
    now = datetime.now().astimezone()
    s = start or cal._iso(now.replace(hour=0, minute=0, second=0, microsecond=0))
    e = end or cal._iso(now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=max(1, min(days, 14))))
    return cal.list_events(s, e)


class PlanLink(BaseModel):
    plan_id: Optional[int] = None


@router.put("/events/{event_id}/plan", dependencies=[Depends(require_pro("calendar"))])
def link_plan(event_id: int, body: PlanLink):
    cal.link_plan(event_id, body.plan_id)
    return cal.get_event(event_id)


class DraftBody(BaseModel):
    model: Optional[str] = None


@router.post("/events/{event_id}/draft", dependencies=[Depends(require_pro("calendar"))])
async def draft(event_id: int, body: DraftBody):
    return await cal.draft_plan(event_id, body.model)


# ── Google / Outlook sign-in ─────────────────────────────────────────────────

@router.get("/oauth/{provider}/start", dependencies=[Depends(require_pro("calendar"))])
def oauth_start(provider: str, request: Request):
    if provider not in cal.PROVIDERS:
        raise FriendlyError("invalid", "Unknown calendar", provider)
    return {"url": cal.oauth_start(provider, _our_port(request))}


_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>iReliabee</title>
<style>body{{font:15px system-ui,sans-serif;background:#f6f5f0;color:#1d2b2a;display:grid;place-items:center;height:100vh;margin:0}}
div{{max-width:420px;padding:28px;border-radius:14px;background:#fff;box-shadow:0 6px 30px rgba(0,0,0,.08)}}h1{{font-size:19px;margin:0 0 8px}}p{{margin:0;color:#5b6664;line-height:1.5}}</style>
</head><body><div><h1>{title}</h1><p>{message}</p></div></body></html>"""


@router.get("/oauth/{provider}/callback", response_class=HTMLResponse)
async def oauth_callback(provider: str, state: str = "", code: str = "", error: str = "", error_description: str = ""):
    import html
    if error:
        return HTMLResponse(_PAGE.format(title="Calendar not connected",
                                         message=html.escape(error_description or error) + "<br><br>You can close this tab."), 400)
    try:
        await _run(cal.oauth_finish, state, code)
    except FriendlyError as e:
        return HTMLResponse(_PAGE.format(title=html.escape(e.title), message=html.escape(e.message) + "<br><br>You can close this tab."), 400)
    return HTMLResponse(_PAGE.format(title="Calendar connected",
                                     message="You can close this tab and go back to iReliabee — your meetings are on the Calendar tab."))


# ── Your own meetings (backend/meetings.py) ──────────────────────────────────

class MeetingBody(BaseModel):
    """Title, start (ISO; without an offset it is read in `timezone`), minutes or end, timezone,
    their_timezone, location, join_url, topics, prep, notes, people, links, reminders, plan_id."""
    model_config = {"extra": "allow"}


@router.post("/meetings/reminder-preview")
def reminder_preview(body: MeetingBody):
    """What an email or text reminder of this meeting will say, before it is saved or turned on."""
    from .. import remote_reminders
    m = meetings.clean_meeting(body.model_dump())
    remote = [r for r in m["reminders"] if set(r["channels"]) & set(remote_reminders.REMOTE)]
    minutes = min(r["minutes"] for r in (remote or m["reminders"] or [{"minutes": 15}]))
    return remote_reminders.reminder_text(m, minutes)


@router.post("/meetings/resend")
async def resend_meeting_reminders():
    """Email and text reminders that could not reach ireliabee.co.uk before (offline, signed out)."""
    from .. import remote_reminders
    return {"sent": await _run(remote_reminders.resend_pending)}


@router.get("/followups")
def followups():
    """Follow-ups not yet done, from all your meetings (the Calendar tab's "To follow up")."""
    return meetings.open_followups()


class FollowupDone(BaseModel):
    done: bool = True


@router.post("/meetings/{event_id}/followups/{followup_id}")
def tick_followup(event_id: int, followup_id: str, body: FollowupDone):
    return meetings.set_followup_done(event_id, followup_id, body.done)


@router.get("/meetings")
def my_meetings(days: int = 60):
    """Your own meetings from now on, soonest first."""
    return meetings.upcoming(days=max(1, min(days, 366)))


@router.post("/meetings")
def new_meeting(body: MeetingBody):
    return meetings.create_meeting(body.model_dump())


@router.get("/meetings/{event_id}")
def one_meeting(event_id: int):
    return meetings.get_meeting(event_id)


@router.patch("/meetings/{event_id}")
def change_meeting(event_id: int, body: MeetingBody):
    return meetings.update_meeting(event_id, body.model_dump(exclude_unset=True))


@router.delete("/meetings/{event_id}")
def remove_meeting(event_id: int):
    meetings.delete_meeting(event_id)
    return {"ok": True}
