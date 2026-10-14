"""Calendar (roadmap 3.2): today's meetings, a plan from an invite, the session on time.

Calendars come from:
- an iCal link (Google's "secret address in iCal format", Outlook's "publish
  calendar" ICS link, Apple, Proton…), re-read on every sync;
- an .ics file (kept, and re-expanded on every sync so repeating meetings roll on);
- Google or Outlook sign-in (OAuth with PKCE through the system browser; the
  user registers the app and signs in themselves, iReliabee only keeps the tokens).

Events are kept for a rolling window (yesterday to two weeks ahead), in UTC.
Tokens live only in the local database and are never exported by Transfer.
"""
from __future__ import annotations

import base64
import hashlib
import html
import json
import os
import re
import secrets
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import requests

from .core import sessions as sess
from .errors import FriendlyError

DAYS_BACK = 1
DAYS_AHEAD = 14
MAX_ICS_BYTES = 8 * 1024 * 1024


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _ensure_schema():
    with sess._connect() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS calendars (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,              -- ics_url | ics_file | google | microsoft
            label TEXT NOT NULL DEFAULT '',
            url TEXT,                        -- iCal link
            ics_text TEXT,                   -- imported file
            tokens_json TEXT,                -- OAuth tokens (never exported)
            created_at TEXT, synced_at TEXT, error TEXT)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS calendar_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            calendar_id INTEGER NOT NULL,
            uid TEXT NOT NULL,
            start TEXT NOT NULL, end TEXT NOT NULL, all_day INTEGER DEFAULT 0,
            title TEXT, location TEXT, description TEXT,
            organizer_json TEXT, attendees_json TEXT, join_url TEXT,
            plan_id INTEGER,
            UNIQUE (calendar_id, uid, start))""")


_ensure_schema()


# ── Reading an invite ────────────────────────────────────────────────────────

_URL_END = r"[^\s<>\"'\)\]]+"
JOIN_PATTERNS = [
    rf"https://[\w.-]*zoom\.us/(?:j|my|w|s)/{_URL_END}",
    rf"https://meet\.google\.com/[a-z]{{3}}-[a-z]{{4}}-[a-z]{{3}}{_URL_END}?",
    rf"https://teams\.microsoft\.com/l/meetup-join/{_URL_END}",
    rf"https://teams\.live\.com/meet/{_URL_END}",
    rf"https://[\w.-]*webex\.com/{_URL_END}",
    rf"https://whereby\.com/{_URL_END}",
    rf"https://[\w.-]*chime\.aws/{_URL_END}",
]


def join_link(*texts: Optional[str]) -> str:
    """The video-call link in an invite, if there is one."""
    for text in texts:
        if not text:
            continue
        for pattern in JOIN_PATTERNS:
            m = re.search(pattern, text)
            if m:
                return m.group(0).rstrip(".,;>")
    return ""


# Lines that are dial-in and "how to join" boilerplate, not agenda.
_BOILERPLATE = re.compile(
    r"(meeting id|passcode|password:|one tap mobile|dial by your location|join by phone|find your local number|"
    r"more phone numbers|join with google meet|join zoom meeting|microsoft teams meeting|join the meeting now|"
    r"join on your computer|need help\?|system reference|meeting options|reset dial-in pin|learn more|"
    r"invitation from google calendar|you are receiving this|forwarding this invitation|to stop receiving|"
    r"view all guest info|reply for |conference id|phone conference|^\s*[+\d][\d\s,#*()-]{8,}$|^[_\-=~:]{6,})",
    re.I,
)


def clean_description(text: Optional[str]) -> str:
    """The agenda part of an invite: no HTML, no dial-in or join boilerplate."""
    if not text:
        return ""
    t = re.sub(r"(?is)<(script|style).*?</\1>", "", text)
    t = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>", "\n", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = html.unescape(t)
    # Google wraps its footer in -::~:~:: markers.
    t = re.sub(r"-::~[:~]*::-.*?(-::~[:~]*::-|$)", "", t, flags=re.S)
    lines = []
    for line in t.splitlines():
        line = line.strip()
        if not line or _BOILERPLATE.search(line) or re.fullmatch(r"https?://\S+", line):
            continue
        lines.append(line)
    return "\n".join(lines)[:4000]


def _utc(value, all_day: bool = False) -> datetime:
    """An ICS/API date or datetime as an aware UTC datetime (floating and all-day times are local)."""
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.astimezone()  # floating → this computer's zone
        return dt.astimezone(timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day).astimezone().astimezone(timezone.utc)
    raise ValueError(f"not a date: {value!r}")


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _person(address, params=None) -> dict:
    email = str(address or "").strip()
    email = re.sub(r"(?i)^mailto:", "", email)
    name = str((params or {}).get("CN", "") or "").strip().strip('"')
    return {"name": name if name and name != email else "", "email": email}


def parse_ics(text: str, start: datetime, end: datetime) -> list[dict]:
    """Events between start and end, repeating meetings expanded, cancelled ones dropped."""
    import icalendar
    import recurring_ical_events

    try:
        cal = icalendar.Calendar.from_ical(text)
    except Exception as e:
        raise FriendlyError("invalid", "That isn't a calendar file", f"It couldn't be read as iCalendar (.ics): {e}")
    events = []
    for comp in recurring_ical_events.of(cal).between(start, end):
        if str(comp.get("STATUS", "")).upper() == "CANCELLED":
            continue
        dtstart = comp.get("DTSTART")
        if dtstart is None:
            continue
        s_raw = dtstart.dt
        all_day = not isinstance(s_raw, datetime)
        s = _utc(s_raw, all_day)
        if comp.get("DTEND") is not None:
            e = _utc(comp.get("DTEND").dt, all_day)
        elif comp.get("DURATION") is not None:
            e = s + comp.get("DURATION").dt
        else:
            e = s + (timedelta(days=1) if all_day else timedelta(minutes=30))
        description = str(comp.get("DESCRIPTION", "") or "")
        location = str(comp.get("LOCATION", "") or "")
        attendees = comp.get("ATTENDEE") or []
        if not isinstance(attendees, list):
            attendees = [attendees]
        organizer = comp.get("ORGANIZER")
        events.append({
            "uid": str(comp.get("UID", "") or f"{comp.get('SUMMARY', '')}-{_iso(s)}"),
            "start": _iso(s), "end": _iso(e), "all_day": all_day,
            "title": str(comp.get("SUMMARY", "") or "(no title)").strip(),
            "location": location.strip(),
            "description": clean_description(description),
            "organizer": _person(organizer, getattr(organizer, "params", None)) if organizer else None,
            "attendees": [_person(a, getattr(a, "params", None)) for a in attendees][:60],
            "join_url": join_link(
                str(comp.get("X-MICROSOFT-SKYPETEAMSMEETINGURL", "") or ""),
                str(comp.get("X-GOOGLE-CONFERENCE", "") or ""),
                str(comp.get("URL", "") or ""), location, description,
            ),
        })
    return events


def _window() -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    return now - timedelta(days=DAYS_BACK), now + timedelta(days=DAYS_AHEAD)


def normalise_link(url: str) -> str:
    url = url.strip()
    if url.lower().startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    return url


def fetch_ics(url: str) -> str:
    """Download an iCal link (webcal:// works too)."""
    url = normalise_link(url)
    if not re.match(r"(?i)^https?://", url):
        raise FriendlyError("invalid", "That isn't a calendar link", "Paste the full link, starting with https:// or webcal://.")
    try:
        r = requests.get(url, timeout=20, headers={"User-Agent": "iReliabee calendar", "Accept": "text/calendar, */*"}, stream=True)
        r.raise_for_status()
        body = r.raw.read(MAX_ICS_BYTES + 1, decode_content=True)
    except requests.RequestException as e:
        raise FriendlyError("network", "Couldn't read that calendar link", f"{e.__class__.__name__}: check the link and your connection.")
    text = body.decode(r.encoding or "utf-8", errors="replace")
    if "BEGIN:VCALENDAR" not in text[:2000].upper():
        raise FriendlyError("invalid", "That link isn't an iCal feed",
                            "Use the calendar's secret or published iCal address (it usually ends in .ics), not the page you view it on.")
    return text


# ── Google and Outlook sign-in ───────────────────────────────────────────────

PROVIDERS = {
    "google": {
        "label": "Google Calendar",
        "auth": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "scope": "openid email https://www.googleapis.com/auth/calendar.events.readonly",
        "client_id_env": "GOOGLE_CLIENT_ID", "client_secret_env": "GOOGLE_CLIENT_SECRET",
        # Google's desktop clients take any loopback port.
        "host": "127.0.0.1",
    },
    "microsoft": {
        "label": "Outlook Calendar",
        "auth": "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "token": "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        "scope": "openid profile offline_access Calendars.Read",
        "client_id_env": "MICROSOFT_CLIENT_ID", "client_secret_env": None,
        # Entra ignores the port of http://localhost redirect URIs.
        "host": "localhost",
    },
}
CALLBACK_PATH = "/calendar/oauth/{provider}/callback"
_pending: dict[str, dict] = {}


def redirect_uri(provider: str, port: int) -> str:
    return f"http://{PROVIDERS[provider]['host']}:{port}{CALLBACK_PATH.format(provider=provider)}"


def oauth_ready(provider: str) -> bool:
    return bool(os.environ.get(PROVIDERS[provider]["client_id_env"]))


def oauth_start(provider: str, port: int) -> str:
    """The sign-in URL to open in the user's browser."""
    p = PROVIDERS[provider]
    client_id = os.environ.get(p["client_id_env"])
    if not client_id:
        raise FriendlyError("config", f"Add your {p['label']} app first",
                            f"Paste the client ID of the app you registered ({p['client_id_env']}) in Calendar → Connect.")
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    # Forget abandoned sign-ins after 15 minutes.
    for k in [k for k, v in _pending.items() if v["created"] < time.time() - 900]:
        _pending.pop(k, None)
    _pending[state] = {"provider": provider, "verifier": verifier, "redirect_uri": redirect_uri(provider, port), "created": time.time()}
    params = {
        "client_id": client_id, "response_type": "code", "redirect_uri": _pending[state]["redirect_uri"],
        "scope": p["scope"], "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
    }
    if provider == "google":
        params.update(access_type="offline", prompt="consent")
    else:
        params.update(prompt="select_account")
    return p["auth"] + "?" + requests.compat.urlencode(params)


def _token_request(provider: str, data: dict) -> dict:
    p = PROVIDERS[provider]
    data = {**data, "client_id": os.environ.get(p["client_id_env"], "")}
    if p["client_secret_env"] and os.environ.get(p["client_secret_env"]):
        data["client_secret"] = os.environ[p["client_secret_env"]]
    r = requests.post(p["token"], data=data, timeout=20)
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code >= 400:
        raise FriendlyError("auth", f"{p['label']} sign-in failed",
                            body.get("error_description") or body.get("error") or f"HTTP {r.status_code}")
    return {
        "access_token": body["access_token"],
        "refresh_token": body.get("refresh_token"),
        "expires_at": time.time() + int(body.get("expires_in", 3600)) - 60,
        "id_token": body.get("id_token"),
    }


def _jwt_claims(token: Optional[str]) -> dict:
    """Claims of an ID token, only to label the account (never trusted for anything else)."""
    try:
        payload = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except Exception:
        return {}


def oauth_finish(state: str, code: str) -> int:
    """Exchange the code, save the calendar and read its events. Returns the calendar id."""
    pending = _pending.pop(state, None)
    if not pending:
        raise FriendlyError("auth", "This sign-in link has expired", "Start again from Calendar → Connect.")
    provider = pending["provider"]
    tokens = _token_request(provider, {
        "grant_type": "authorization_code", "code": code,
        "redirect_uri": pending["redirect_uri"], "code_verifier": pending["verifier"],
    })
    claims = _jwt_claims(tokens.pop("id_token", None))
    label = claims.get("email") or claims.get("preferred_username") or PROVIDERS[provider]["label"]
    with sess._connect() as conn:
        # Signing in again to the same account replaces it.
        if label != PROVIDERS[provider]["label"]:
            old = [r["id"] for r in conn.execute("SELECT id FROM calendars WHERE kind = ? AND label = ?", (provider, label))]
            for oid in old:
                conn.execute("DELETE FROM calendar_events WHERE calendar_id = ?", (oid,))
                conn.execute("DELETE FROM calendars WHERE id = ?", (oid,))
        cid = conn.execute("INSERT INTO calendars (kind, label, tokens_json, created_at) VALUES (?, ?, ?, ?)",
                           (provider, label, json.dumps(tokens), _now())).lastrowid
    sync_calendar(cid)
    return cid


def _access_token(cal: dict) -> str:
    tokens = json.loads(cal["tokens_json"] or "{}")
    if tokens.get("access_token") and tokens.get("expires_at", 0) > time.time():
        return tokens["access_token"]
    if not tokens.get("refresh_token"):
        raise FriendlyError("auth", "Sign in again", "This calendar's sign-in has expired — reconnect it.")
    data = {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]}
    if cal["kind"] == "microsoft":
        data["scope"] = PROVIDERS["microsoft"]["scope"]
    fresh = _token_request(cal["kind"], data)
    fresh.pop("id_token", None)
    fresh["refresh_token"] = fresh.get("refresh_token") or tokens["refresh_token"]
    with sess._connect() as conn:
        conn.execute("UPDATE calendars SET tokens_json = ? WHERE id = ?", (json.dumps(fresh), cal["id"]))
    return fresh["access_token"]


def _api_get(url: str, token: str, params: dict, headers: Optional[dict] = None) -> dict:
    r = requests.get(url, params=params, headers={"Authorization": f"Bearer {token}", **(headers or {})}, timeout=25)
    if r.status_code == 401:
        raise FriendlyError("auth", "Sign in again", "The calendar refused the sign-in — reconnect it.")
    if r.status_code >= 400:
        try:
            msg = r.json().get("error", {}).get("message") or r.text[:200]
        except Exception:
            msg = r.text[:200]
        raise FriendlyError("network", "Couldn't read the calendar", msg)
    return r.json()


def google_events(token: str, start: datetime, end: datetime) -> list[dict]:
    events, page = [], None
    while True:
        params = {"timeMin": _iso(start), "timeMax": _iso(end), "singleEvents": "true", "orderBy": "startTime", "maxResults": 250}
        if page:
            params["pageToken"] = page
        data = _api_get("https://www.googleapis.com/calendar/v3/calendars/primary/events", token, params)
        for ev in data.get("items", []):
            if ev.get("status") == "cancelled":
                continue
            me = next((a for a in ev.get("attendees", []) if a.get("self")), None)
            if me and me.get("responseStatus") == "declined":
                continue
            s, e = ev.get("start", {}), ev.get("end", {})
            all_day = "date" in s and "dateTime" not in s
            start_dt = _utc(date.fromisoformat(s["date"])) if all_day else datetime.fromisoformat(s["dateTime"].replace("Z", "+00:00"))
            end_dt = _utc(date.fromisoformat(e["date"])) if all_day else datetime.fromisoformat(e["dateTime"].replace("Z", "+00:00"))
            video = next((p.get("uri") for p in ev.get("conferenceData", {}).get("entryPoints", []) if p.get("entryPointType") == "video"), "")
            org = ev.get("organizer") or {}
            events.append({
                "uid": ev["id"], "start": _iso(start_dt), "end": _iso(end_dt), "all_day": all_day,
                "title": (ev.get("summary") or "(no title)").strip(),
                "location": (ev.get("location") or "").strip(),
                "description": clean_description(ev.get("description")),
                "organizer": {"name": org.get("displayName", ""), "email": org.get("email", "")},
                "attendees": [{"name": a.get("displayName", ""), "email": a.get("email", ""), "self": bool(a.get("self"))}
                              for a in ev.get("attendees", []) if not a.get("resource")][:60],
                "join_url": ev.get("hangoutLink") or video or join_link(ev.get("location"), ev.get("description")),
            })
        page = data.get("nextPageToken")
        if not page:
            return events


def microsoft_events(token: str, start: datetime, end: datetime) -> list[dict]:
    events = []
    url = "https://graph.microsoft.com/v1.0/me/calendarView"
    params: Optional[dict] = {
        "startDateTime": _iso(start), "endDateTime": _iso(end), "$top": 100, "$orderby": "start/dateTime",
        "$select": "id,subject,start,end,isAllDay,isCancelled,location,body,organizer,attendees,onlineMeeting,responseStatus",
    }
    headers = {"Prefer": 'outlook.timezone="UTC", outlook.body-content-type="text"'}
    while url:
        data = _api_get(url, token, params or {}, headers)
        for ev in data.get("value", []):
            if ev.get("isCancelled") or (ev.get("responseStatus") or {}).get("response") == "declined":
                continue
            s = datetime.fromisoformat(ev["start"]["dateTime"][:19]).replace(tzinfo=timezone.utc)
            e = datetime.fromisoformat(ev["end"]["dateTime"][:19]).replace(tzinfo=timezone.utc)
            body = (ev.get("body") or {}).get("content", "")
            location = (ev.get("location") or {}).get("displayName", "")
            org = (ev.get("organizer") or {}).get("emailAddress", {})
            events.append({
                "uid": ev["id"], "start": _iso(s), "end": _iso(e), "all_day": bool(ev.get("isAllDay")),
                "title": (ev.get("subject") or "(no title)").strip(),
                "location": location.strip(), "description": clean_description(body),
                "organizer": {"name": org.get("name", ""), "email": org.get("address", "")},
                "attendees": [{"name": a.get("emailAddress", {}).get("name", ""), "email": a.get("emailAddress", {}).get("address", "")}
                              for a in ev.get("attendees", [])][:60],
                "join_url": (ev.get("onlineMeeting") or {}).get("joinUrl") or join_link(location, body),
            })
        url, params = data.get("@odata.nextLink"), None
    return events


# ── Calendars and their events ───────────────────────────────────────────────

def _public(cal: dict) -> dict:
    d = {k: cal[k] for k in ("id", "kind", "label", "created_at", "synced_at", "error")}
    if cal["kind"] == "ics_url":
        # The link is a secret: show just enough to recognise it.
        url = cal["url"] or ""
        d["hint"] = re.sub(r"^([a-z]+://[^/]+/).*", r"\1…", url, flags=re.I)
    return d


def list_calendars() -> list[dict]:
    """The calendars you linked (not the built-in one that holds your own meetings)."""
    with sess._connect() as conn:
        return [_public(dict(r)) for r in conn.execute("SELECT * FROM calendars WHERE kind != 'ireliabee' ORDER BY id")]


def add_ics(label: str, url: Optional[str] = None, text: Optional[str] = None) -> dict:
    if url:
        text_now = fetch_ics(url)
        parse_ics(text_now, *_window())  # fail now, not at the next sync
    elif text:
        if len(text.encode()) > MAX_ICS_BYTES:
            raise FriendlyError("invalid", "That calendar file is too big", "Export a shorter date range and try again.")
        parse_ics(text, *_window())
    else:
        raise FriendlyError("invalid", "Add a calendar link or file", "")
    with sess._connect() as conn:
        cid = conn.execute(
            "INSERT INTO calendars (kind, label, url, ics_text, created_at) VALUES (?, ?, ?, ?, ?)",
            ("ics_url" if url else "ics_file", label.strip() or ("Calendar link" if url else "Imported calendar"),
             normalise_link(url) if url else None, None if url else text, _now()),
        ).lastrowid
    sync_calendar(cid)
    return next(c for c in list_calendars() if c["id"] == cid)


def remove_calendar(cid: int) -> None:
    with sess._connect() as conn:
        row = conn.execute("SELECT kind FROM calendars WHERE id = ?", (cid,)).fetchone()
        if row and row["kind"] == "ireliabee":
            raise FriendlyError("invalid", "Your own meetings can't be removed", "Delete the meetings one by one instead.")
        conn.execute("DELETE FROM calendar_events WHERE calendar_id = ?", (cid,))
        conn.execute("DELETE FROM calendars WHERE id = ?", (cid,))


def _store(cid: int, events: list[dict]) -> None:
    """Replace a calendar's events, keeping the plans already linked to them."""
    with sess._connect() as conn:
        linked = {(r["uid"], r["start"]): r["plan_id"] for r in conn.execute(
            "SELECT uid, start, plan_id FROM calendar_events WHERE calendar_id = ? AND plan_id IS NOT NULL", (cid,))}
        # A moved one-off meeting keeps its plan: fall back to the uid alone, but only
        # for uids that occur once — every occurrence of a repeating meeting shares its uid.
        occurrences = Counter(ev["uid"] for ev in events)
        by_uid = {uid: pid for (uid, _), pid in linked.items() if occurrences[uid] == 1}
        conn.execute("DELETE FROM calendar_events WHERE calendar_id = ?", (cid,))
        for ev in events:
            conn.execute(
                "INSERT OR IGNORE INTO calendar_events (calendar_id, uid, start, end, all_day, title, location, description, "
                "organizer_json, attendees_json, join_url, plan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (cid, ev["uid"], ev["start"], ev["end"], int(ev["all_day"]), ev["title"], ev["location"], ev["description"],
                 json.dumps(ev.get("organizer")), json.dumps(ev.get("attendees") or []), ev.get("join_url") or "",
                 linked.get((ev["uid"], ev["start"])) or by_uid.get(ev["uid"])),
            )


def sync_calendar(cid: int) -> None:
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM calendars WHERE id = ?", (cid,)).fetchone()
    if not row:
        return
    cal = dict(row)
    start, end = _window()
    try:
        if cal["kind"] == "ics_url":
            events = parse_ics(fetch_ics(cal["url"]), start, end)
        elif cal["kind"] == "ics_file":
            events = parse_ics(cal["ics_text"] or "", start, end)
        elif cal["kind"] == "google":
            events = google_events(_access_token(cal), start, end)
        elif cal["kind"] == "microsoft":
            events = microsoft_events(_access_token(cal), start, end)
        else:
            return
    except FriendlyError as e:
        with sess._connect() as conn:
            conn.execute("UPDATE calendars SET error = ? WHERE id = ?", (f"{e.title}. {e.message}".strip(), cid))
        return
    except Exception as e:  # keep the other calendars syncing
        with sess._connect() as conn:
            conn.execute("UPDATE calendars SET error = ? WHERE id = ?", (f"Couldn't sync: {e.__class__.__name__}", cid))
        return
    _store(cid, events)
    with sess._connect() as conn:
        conn.execute("UPDATE calendars SET synced_at = ?, error = NULL WHERE id = ?", (_now(), cid))


def sync_all() -> None:
    with sess._connect() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM calendars")]
    for cid in ids:
        sync_calendar(cid)


def _event(row) -> dict:
    d = dict(row)
    d["all_day"] = bool(d["all_day"])
    d["organizer"] = json.loads(d.pop("organizer_json", None) or "null")
    d["attendees"] = json.loads(d.pop("attendees_json", None) or "[]")
    # Your own meetings (backend/meetings.py) carry more; synced invites leave these empty.
    for key in ("topics", "people", "links", "reminders", "followups"):
        raw = d.pop(f"{key}_json", None)
        d[key] = json.loads(raw) if raw else ([] if key != "reminders" else None)
    return d


def list_events(start: str, end: str) -> list[dict]:
    """Events overlapping [start, end), soonest first, the same meeting from two calendars once."""
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT e.*, c.label AS calendar, c.kind AS calendar_kind, p.title AS plan_title "
            "FROM calendar_events e JOIN calendars c ON c.id = e.calendar_id "
            "LEFT JOIN meeting_plans p ON p.id = e.plan_id "
            "WHERE e.end > ? AND e.start < ? ORDER BY e.start, e.id", (start, end),
        ).fetchall()
    seen, out = set(), []
    for r in rows:
        ev = _event(r)
        key = (ev["title"].lower(), ev["start"])
        if key in seen:
            continue
        seen.add(key)
        out.append(ev)
    return out


def get_event(event_id: int) -> dict:
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM calendar_events WHERE id = ?", (event_id,)).fetchone()
    if not row:
        raise FriendlyError("not_found", "That meeting isn't in your calendar any more", "Sync the calendar and try again.")
    return _event(row)


def link_plan(event_id: int, plan_id: Optional[int]) -> None:
    get_event(event_id)
    with sess._connect() as conn:
        conn.execute("UPDATE calendar_events SET plan_id = ? WHERE id = ?", (plan_id, event_id))


# ── A plan from an invite ────────────────────────────────────────────────────

INTERVIEW_WORDS = re.compile(r"(?i)\b(interview|screen(ing)?|recruit|hiring|onsite|on-site|technical round|final round|assessment)\b")

TEMPLATE_FOR_KIND = {
    "interview": "tech-interview", "meeting": "work-meeting", "one_on_one": "one-on-one",
    "review": "performance-review", "presentation": "presentation", "sales": "sales-discovery",
    "negotiation": "salary-negotiation", "other": "general",
}


def invite_text(ev: dict) -> str:
    local = ev["start"]
    people = [a for a in ev["attendees"] if not a.get("self")]
    lines = [
        f"TITLE: {ev['title']}",
        f"WHEN (UTC): {local} to {ev['end']}",
        f"ORGANISER: {(ev.get('organizer') or {}).get('name') or ''} <{(ev.get('organizer') or {}).get('email') or ''}>",
        "ATTENDEES: " + ("; ".join(f"{a.get('name') or ''} <{a.get('email') or ''}>".strip() for a in people) or "(none listed)"),
        f"LOCATION: {ev.get('location') or '(none)'}",
        f"VIDEO LINK: {'yes' if ev.get('join_url') else 'no'}",
        "DESCRIPTION / AGENDA:",
        ev.get("description") or "(none)",
    ]
    return "\n".join(lines)


def _minutes(ev: dict) -> int:
    s = datetime.fromisoformat(ev["start"].replace("Z", "+00:00"))
    e = datetime.fromisoformat(ev["end"].replace("Z", "+00:00"))
    return max(10, min(240, int((e - s).total_seconds() // 60)))


def _organisations(ev: dict) -> list[str]:
    """Company domains among the other attendees (not webmail), to name who the meeting is with."""
    webmail = {"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com",
               "me.com", "proton.me", "protonmail.com", "aol.com", "group.calendar.google.com", "resource.calendar.google.com"}
    domains = []
    for a in [ev.get("organizer") or {}, *ev["attendees"]]:
        d = (a.get("email") or "").split("@")[-1].lower()
        if d and "@" in (a.get("email") or "") and d not in webmail and not a.get("self") and d not in domains:
            domains.append(d)
    return domains[:5]


async def draft_plan(event_id: int, model: Optional[str]) -> dict:
    """A plan draft from a calendar invite, for the user to review and save."""
    from .routers.mock import _ask_model, _candidate_context, _level_text

    ev = get_event(event_id)
    profile, context = _candidate_context(None)
    minutes = _minutes(ev)
    guess = "interview" if INTERVIEW_WORDS.search(ev["title"] + " " + (ev.get("description") or "")) else "meeting"
    system_prompt = f"""You prepare someone for a meeting in their calendar, from its invite.

THE USER
{context}

{_level_text(profile)}

Work out what kind of meeting this is from the title, the attendees' organisations and the description.
Use ONLY what the invite and the user's background say: never invent agenda items, names, companies or
facts. Where the invite says little, keep the plan short and practical rather than padding it.

Return ONLY JSON, no prose:
{{"kind": "interview|meeting|one_on_one|review|presentation|sales|negotiation|other",
  "title": "short plan title, e.g. 'Acme — second-round interview' or 'Q3 roadmap review'",
  "counterparty": "who the meeting is with: company, team or person",
  "purpose": "one sentence: what the user wants out of this meeting",
  "sections": [{{"title": "agenda block", "minutes": <int>, "goal": "what to achieve in it"}}],
  "answers_prep": ["likely question or topic → the angle and real example from the user's background to use"],
  "questions_ask": ["smart questions to ask in this meeting"],
  "traps_avoid": ["specific pitfalls for this meeting"],
  "commitments": ["concrete outcomes to leave with"]}}
The sections must add up to about {minutes} minutes (the meeting's length). Use 2-5 sections,
3-6 answers_prep, 2-4 questions_ask, 2-4 traps_avoid, 1-3 commitments."""
    orgs = _organisations(ev)
    message = invite_text(ev) + (f"\nORGANISATIONS (from email domains): {', '.join(orgs)}" if orgs else "") + \
        f"\nLIKELY KIND (from keywords): {guess}"
    data = await _ask_model(model, system_prompt, message)

    def strings(key, limit):
        return [str(s).strip() for s in data.get(key, []) if str(s).strip()][:limit]

    sections = []
    for s in data.get("sections", [])[:6]:
        if isinstance(s, dict) and str(s.get("title", "")).strip():
            try:
                m = int(s.get("minutes")) if s.get("minutes") is not None else None
            except (TypeError, ValueError):
                m = None
            sections.append({"title": str(s["title"]).strip(), "minutes": m, "goal": str(s.get("goal", "")).strip()})
    kind = data.get("kind") if data.get("kind") in TEMPLATE_FOR_KIND else guess
    people = [a for a in ev["attendees"] if not a.get("self")]
    notes = [f"From your calendar: {ev['title']}"]
    if people:
        notes.append("Attendees: " + ", ".join(a.get("name") or a.get("email") for a in people[:12]))
    if ev.get("join_url"):
        notes.append(f"Join link: {ev['join_url']}")
    if ev.get("description"):
        notes.append("Invite notes:\n" + ev["description"][:1500])
    return {
        "title": str(data.get("title", "")).strip() or ev["title"],
        "counterparty": str(data.get("counterparty", "")).strip() or (orgs[0] if orgs else ""),
        "purpose": str(data.get("purpose", "")).strip(),
        "duration_min": minutes,
        "sections": sections,
        "answers_prep": strings("answers_prep", 8),
        "questions_ask": strings("questions_ask", 6),
        "traps_avoid": strings("traps_avoid", 6),
        "commitments": strings("commitments", 4),
        "notes": "\n\n".join(notes),
        "template": TEMPLATE_FOR_KIND[kind],
        "kind": kind,
    }
