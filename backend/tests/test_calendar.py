"""Roadmap 3.2: calendars — iCal links and files, Google and Outlook sign-in, plans from invites."""
import asyncio
import json
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from urllib.parse import parse_qs, urlparse

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend.core.meeting_plans import create_plan  # noqa: E402
from backend import calendar_sync as cal  # noqa: E402
from backend.errors import FriendlyError  # noqa: E402
from backend.routers import mock as mock_router  # noqa: E402

# Monday 2026-09-21 09:30 London (BST, UTC+1) → 08:30 UTC, weekly.
ICS = """BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:DAYLIGHT
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
TZNAME:BST
DTSTART:19700329T010000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
TZNAME:GMT
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:standup-1
SUMMARY:Team standup
DTSTART;TZID=Europe/London:20260921T093000
DTEND;TZID=Europe/London:20260921T094500
RRULE:FREQ=WEEKLY;COUNT=4
DESCRIPTION:Quick round of updates.\\n\\nJoin Zoom Meeting\\nhttps://acme.zoom.us/j/123456789?pwd=abc\\nMeeting ID: 123 456 789\\nPasscode: 42
ORGANIZER;CN=Kofi Mensah:mailto:kofi@acme.com
ATTENDEE;CN=Ama Mensah;PARTSTAT=ACCEPTED:mailto:ama@acme.com
END:VEVENT
BEGIN:VEVENT
UID:interview-9
SUMMARY:Globex — technical interview
DTSTART;TZID=GMT Standard Time:20260922T140000
DTEND;TZID=GMT Standard Time:20260922T150000
X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0
DESCRIPTION:Agenda: system design, then your questions.\\n________________\\nMicrosoft Teams meeting\\nJoin on your computer
ORGANIZER;CN=Recruiting:mailto:talent@globex.io
END:VEVENT
BEGIN:VEVENT
UID:cancelled-1
SUMMARY:Cancelled sync
STATUS:CANCELLED
DTSTART:20260923T100000Z
DTEND:20260923T103000Z
END:VEVENT
BEGIN:VEVENT
UID:holiday-1
SUMMARY:Bank holiday
DTSTART;VALUE=DATE:20260924
DTEND;VALUE=DATE:20260925
END:VEVENT
END:VCALENDAR
"""

WINDOW = (datetime(2026, 9, 20, tzinfo=timezone.utc), datetime(2026, 10, 20, tzinfo=timezone.utc))


class CalendarTest(unittest.TestCase):
    def setUp(self):
        with sess._connect() as conn:
            conn.execute("DELETE FROM calendar_events")
            conn.execute("DELETE FROM calendars")
            conn.execute("DELETE FROM meeting_plans")

    def test_invites_are_read_with_time_zones_repeats_and_links(self):
        events = cal.parse_ics(ICS, *WINDOW)
        titles = [e["title"] for e in events]
        self.assertEqual(titles.count("Team standup"), 4)  # weekly, 4 times
        self.assertNotIn("Cancelled sync", titles)
        standup = min((e for e in events if e["title"] == "Team standup"), key=lambda e: e["start"])
        self.assertEqual((standup["start"], standup["end"]), ("2026-09-21T08:30:00Z", "2026-09-21T08:45:00Z"))
        self.assertEqual(standup["join_url"], "https://acme.zoom.us/j/123456789?pwd=abc")
        self.assertEqual(standup["description"], "Quick round of updates.")  # dial-in boilerplate gone
        self.assertEqual(standup["organizer"], {"name": "Kofi Mensah", "email": "kofi@acme.com"})
        self.assertEqual(standup["attendees"], [{"name": "Ama Mensah", "email": "ama@acme.com"}])
        # Outlook's Windows zone name.
        interview = next(e for e in events if e["uid"] == "interview-9")
        self.assertEqual(interview["start"], "2026-09-22T13:00:00Z")
        self.assertTrue(interview["join_url"].startswith("https://teams.microsoft.com/l/meetup-join/"))
        self.assertEqual(interview["description"], "Agenda: system design, then your questions.")
        self.assertTrue(next(e for e in events if e["title"] == "Bank holiday")["all_day"])

    def test_not_a_calendar_is_a_friendly_error(self):
        with self.assertRaises(FriendlyError):
            cal.parse_ics("<html>Sign in</html>", *WINDOW)

    def test_a_linked_plan_survives_a_resync(self):
        with mock.patch.object(cal, "_window", lambda: WINDOW):
            added = cal.add_ics("Work", text=ICS)
            ev = next(e for e in cal.list_events("2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z") if e["uid"] == "interview-9")
            plan_id = create_plan(title="Globex interview")
            cal.link_plan(ev["id"], plan_id)
            cal.sync_calendar(added["id"])
            again = next(e for e in cal.list_events("2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z") if e["uid"] == "interview-9")
        self.assertEqual((again["plan_id"], again["plan_title"], again["calendar"]), (plan_id, "Globex interview", "Work"))

    def test_a_plan_for_one_repeat_stays_on_that_repeat(self):
        with mock.patch.object(cal, "_window", lambda: WINDOW):
            added = cal.add_ics("Work", text=ICS)
            standups = [e for e in cal.list_events(*[cal._iso(d) for d in WINDOW]) if e["uid"] == "standup-1"]
            plan_id = create_plan(title="Monday standup")
            cal.link_plan(standups[0]["id"], plan_id)
            cal.sync_calendar(added["id"])
            after = [e for e in cal.list_events(*[cal._iso(d) for d in WINDOW]) if e["uid"] == "standup-1"]
        self.assertEqual([e["plan_id"] for e in after], [plan_id, None, None, None])

    def test_a_moved_one_off_meeting_keeps_its_plan(self):
        with mock.patch.object(cal, "_window", lambda: WINDOW):
            added = cal.add_ics("Work", text=ICS)
            ev = next(e for e in cal.list_events(*[cal._iso(d) for d in WINDOW]) if e["uid"] == "interview-9")
            plan_id = create_plan(title="Globex interview")
            cal.link_plan(ev["id"], plan_id)
            with sess._connect() as conn:
                conn.execute("UPDATE calendars SET ics_text = ? WHERE id = ?",
                             (ICS.replace("20260922T140000", "20260923T110000").replace("20260922T150000", "20260923T120000"), added["id"]))
            cal.sync_calendar(added["id"])
            moved = next(e for e in cal.list_events(*[cal._iso(d) for d in WINDOW]) if e["uid"] == "interview-9")
        self.assertEqual((moved["start"], moved["plan_id"]), ("2026-09-23T10:00:00Z", plan_id))

    def test_google_sign_in_asks_who_the_account_is(self):
        # Without openid + email Google returns no ID token, so accounts can't be named or replaced.
        self.assertTrue({"openid", "email"} <= set(cal.PROVIDERS["google"]["scope"].split()))

    def test_the_same_meeting_in_two_calendars_shows_once(self):
        with mock.patch.object(cal, "_window", lambda: WINDOW):
            cal.add_ics("Work", text=ICS)
            cal.add_ics("Copy", text=ICS)
        day = cal.list_events("2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z")
        self.assertEqual([e["title"] for e in day], ["Team standup"])

    def test_ical_links_are_fetched_and_kept_secret(self):
        class Resp:
            encoding = "utf-8"
            raw = mock.Mock(read=lambda n, decode_content=True: ICS.encode())
            def raise_for_status(self): pass
        with mock.patch.object(cal.requests, "get", return_value=Resp()) as get, mock.patch.object(cal, "_window", lambda: WINDOW):
            added = cal.add_ics("", url="webcal://calendar.google.com/calendar/ical/secret-token/basic.ics")
        self.assertTrue(get.call_args[0][0].startswith("https://calendar.google.com/"))
        self.assertEqual(added["hint"], "https://calendar.google.com/…")
        self.assertNotIn("secret-token", json.dumps(cal.list_calendars()))

    def test_google_events_are_mapped_and_declined_ones_skipped(self):
        items = {"items": [
            {"id": "g1", "summary": "Design review", "start": {"dateTime": "2026-09-21T10:00:00+02:00"},
             "end": {"dateTime": "2026-09-21T11:00:00+02:00"}, "hangoutLink": "https://meet.google.com/abc-defg-hij",
             "organizer": {"email": "lead@initech.com"}, "attendees": [{"email": "me@x.com", "self": True, "responseStatus": "accepted"}]},
            {"id": "g2", "summary": "Declined", "start": {"dateTime": "2026-09-21T12:00:00Z"}, "end": {"dateTime": "2026-09-21T13:00:00Z"},
             "attendees": [{"email": "me@x.com", "self": True, "responseStatus": "declined"}]},
        ]}
        with mock.patch.object(cal, "_api_get", return_value=items):
            events = cal.google_events("tok", *WINDOW)
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]["start"], events[0]["join_url"]), ("2026-09-21T08:00:00Z", "https://meet.google.com/abc-defg-hij"))

    def test_outlook_events_are_mapped(self):
        data = {"value": [{"id": "m1", "subject": "1:1", "start": {"dateTime": "2026-09-21T15:00:00.0000000"},
                           "end": {"dateTime": "2026-09-21T15:30:00.0000000"}, "isAllDay": False,
                           "onlineMeeting": {"joinUrl": "https://teams.microsoft.com/l/meetup-join/xyz"},
                           "organizer": {"emailAddress": {"name": "Sam", "address": "sam@initech.com"}}, "attendees": []}]}
        with mock.patch.object(cal, "_api_get", return_value=data):
            events = cal.microsoft_events("tok", *WINDOW)
        self.assertEqual((events[0]["start"], events[0]["organizer"]["name"]), ("2026-09-21T15:00:00Z", "Sam"))

    def test_sign_in_uses_pkce_and_saves_the_account(self):
        with mock.patch.dict("os.environ", {"GOOGLE_CLIENT_ID": "cid.apps.googleusercontent.com", "GOOGLE_CLIENT_SECRET": "s"}):
            url = cal.oauth_start("google", 8123)
            q = {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}
            self.assertEqual(q["redirect_uri"], "http://127.0.0.1:8123/calendar/oauth/google/callback")
            self.assertEqual((q["code_challenge_method"], q["access_type"]), ("S256", "offline"))
            claims = {"email": "me@example.com"}
            id_token = "x." + __import__("base64").urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".y"
            resp = mock.Mock(status_code=200, headers={"content-type": "application/json"},
                             json=lambda: {"access_token": "at", "refresh_token": "rt", "expires_in": 3600, "id_token": id_token})
            with mock.patch.object(cal.requests, "post", return_value=resp) as post, \
                 mock.patch.object(cal, "google_events", return_value=[]):
                cid = cal.oauth_finish(q["state"], "the-code")
            sent = post.call_args.kwargs["data"]
            self.assertEqual((sent["code"], sent["client_secret"]), ("the-code", "s"))
            self.assertIn("code_verifier", sent)
        saved = next(c for c in cal.list_calendars() if c["id"] == cid)
        self.assertEqual((saved["kind"], saved["label"], saved["error"]), ("google", "me@example.com", None))
        self.assertNotIn("tokens_json", saved)
        with self.assertRaises(FriendlyError):
            cal.oauth_finish(q["state"], "again")  # a state works once

    def test_expired_tokens_are_refreshed(self):
        with sess._connect() as conn:
            cid = conn.execute("INSERT INTO calendars (kind, label, tokens_json) VALUES ('microsoft', 'me', ?)",
                               (json.dumps({"access_token": "old", "refresh_token": "rt", "expires_at": time.time() - 5}),)).lastrowid
        resp = mock.Mock(status_code=200, headers={"content-type": "application/json"}, json=lambda: {"access_token": "new", "expires_in": 3600})
        with mock.patch.dict("os.environ", {"MICROSOFT_CLIENT_ID": "mid"}), mock.patch.object(cal.requests, "post", return_value=resp):
            with sess._connect() as conn:
                row = dict(conn.execute("SELECT * FROM calendars WHERE id = ?", (cid,)).fetchone())
            self.assertEqual(cal._access_token(row), "new")
        with sess._connect() as conn:
            kept = json.loads(conn.execute("SELECT tokens_json FROM calendars WHERE id = ?", (cid,)).fetchone()[0])
        self.assertEqual(kept["refresh_token"], "rt")

    def test_a_plan_is_drafted_from_the_invite(self):
        with mock.patch.object(cal, "_window", lambda: WINDOW):
            cal.add_ics("Work", text=ICS)
        ev = next(e for e in cal.list_events("2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z") if e["uid"] == "interview-9")
        seen = {}

        async def fake(model, system_prompt, message):
            seen["message"] = message
            return {"kind": "interview", "title": "Globex — technical interview", "counterparty": "Globex",
                    "sections": [{"title": "System design", "minutes": 45, "goal": "Show trade-offs"}], "questions_ask": ["What's next?"]}
        with mock.patch.object(mock_router, "_ask_model", fake):
            draft = asyncio.run(cal.draft_plan(ev["id"], None))
        self.assertIn("ORGANISATIONS (from email domains): globex.io", seen["message"])
        self.assertIn("Agenda: system design", seen["message"])
        self.assertEqual((draft["template"], draft["duration_min"], draft["counterparty"]), ("tech-interview", 60, "Globex"))
        self.assertIn("Join link: https://teams.microsoft.com/", draft["notes"])


if __name__ == "__main__":
    unittest.main()
