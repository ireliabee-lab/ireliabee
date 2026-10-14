"""Your own meetings (no Google or Outlook), and Idea board notes turned into meetings."""
import unittest
from datetime import datetime, timedelta, timezone

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import boards, calendar_sync as cal, meetings  # noqa: E402
from backend.core import meeting_plans  # noqa: E402,F401  (the plans table events join to)
from backend.core import sessions as sess  # noqa: E402
from backend.errors import FriendlyError  # noqa: E402


def _clear():
    with sess._connect() as conn:
        conn.execute("DELETE FROM calendar_events")
        conn.execute("DELETE FROM calendars")


class MeetingTest(unittest.TestCase):
    def setUp(self):
        _clear()

    def reyes(self, **extra):
        return meetings.create_meeting({
            "title": "Call with Dr. Reyes", "start": "2026-10-02T11:00", "timezone": "America/New_York",
            "their_timezone": "America/New_York", "minutes": 25, "location": "https://example.zoom.us/j/123456789",
            "topics": ["Research plan feedback", "Next steps"], "prep": "Send the plan by Wednesday.",
            "people": [{"name": "Sam Reyes", "email": "sam.reyes@example.edu"}], **extra})

    def test_a_meeting_is_stored_in_utc_with_the_zone_it_was_entered_in(self):
        m = self.reyes()
        self.assertEqual(m["start"], "2026-10-02T15:00:00Z")          # 11:00 in New York is 15:00 UTC
        self.assertEqual(m["end"], "2026-10-02T15:25:00Z")
        self.assertEqual(m["timezone"], "America/New_York")
        self.assertEqual(m["join_url"], "https://example.zoom.us/j/123456789")
        self.assertEqual(m["topics"], ["Research plan feedback", "Next steps"])
        self.assertEqual(m["calendar_kind"] if "calendar_kind" in m else "ireliabee", "ireliabee")

    def test_it_shows_on_the_calendar_with_the_synced_invites(self):
        m = self.reyes()
        events = cal.list_events("2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z")
        self.assertEqual([e["id"] for e in events], [m["id"]])
        self.assertEqual(events[0]["calendar_kind"], "ireliabee")
        self.assertEqual(events[0]["topics"], ["Research plan feedback", "Next steps"])
        self.assertIn("Research plan feedback", events[0]["description"])     # what a plan-from-invite reads

    def test_reminders_default_to_30_and_15_minutes(self):
        self.assertEqual(self.reyes()["reminders"],
                         [{"minutes": 30, "channels": ["desktop"]}, {"minutes": 15, "channels": ["desktop"]}])

    def test_reminders_are_cleaned(self):
        m = self.reyes(reminders=[{"minutes": 15, "channels": ["sms", "email", "fax"]}, {"minutes": 15, "channels": ["desktop"]},
                                    {"minutes": -5, "channels": ["desktop"]}, {"minutes": 1440, "channels": ["email"]},
                                    {"minutes": 60, "channels": []}])
        self.assertEqual(m["reminders"], [{"minutes": 1440, "channels": ["email"]}, {"minutes": 15, "channels": ["email", "sms"]}])

    def test_changing_a_meeting_keeps_what_was_not_changed(self):
        m = self.reyes()
        moved = meetings.update_meeting(m["id"], {"start": "2026-10-02T13:00"})
        self.assertEqual(moved["start"], "2026-10-02T17:00:00Z")      # still read in New York time
        self.assertEqual(moved["end"], "2026-10-02T17:25:00Z")        # still 25 minutes
        self.assertEqual(moved["topics"], m["topics"])
        self.assertEqual(meetings.update_meeting(m["id"], {"topics": []})["topics"], [])

    def test_bad_input_is_refused_plainly(self):
        for bad in ({"title": "", "start": "2026-10-02T11:00"}, {"title": "x"}, {"title": "x", "start": "soon"},
                    {"title": "x", "start": "2026-10-02T11:00", "timezone": "Mars/Olympus"},
                    {"title": "x", "start": "2026-10-02T11:00", "minutes": 2}):
            with self.assertRaises(FriendlyError):
                meetings.create_meeting(bad)

    def test_sync_leaves_your_own_meetings_alone_and_they_cannot_be_removed_as_a_calendar(self):
        m = self.reyes()
        cal.sync_all()
        self.assertEqual(meetings.get_meeting(m["id"])["title"], "Call with Dr. Reyes")
        self.assertEqual(cal.list_calendars(), [])                    # not shown among linked calendars
        with self.assertRaises(FriendlyError):
            cal.remove_calendar(meetings.own_calendar_id())

    def test_upcoming_lists_only_your_own_future_meetings(self):
        soon = datetime.now(timezone.utc) + timedelta(hours=2)
        past = datetime.now(timezone.utc) - timedelta(days=2)
        a = meetings.create_meeting({"title": "Soon", "start": soon.isoformat()})
        meetings.create_meeting({"title": "Past", "start": past.isoformat()})
        self.assertEqual([m["id"] for m in meetings.upcoming()], [a["id"]])

    def test_deleting_a_meeting(self):
        m = self.reyes()
        meetings.delete_meeting(m["id"])
        with self.assertRaises(FriendlyError):
            meetings.get_meeting(m["id"])


class NoteMeetingTest(unittest.TestCase):
    def setUp(self):
        _clear()
        self.board = boards.create_board("PhD")
        self.addCleanup(lambda: boards.delete_board(self.board["id"]))
        self.note = boards.add_note(self.board["id"], {"text": "Call with Dr. Patel\n- funding news\n- lab rotation"})

    def test_a_note_becomes_a_meeting_titled_by_its_first_line(self):
        n = boards.schedule_note(self.board["id"], self.note["id"],
                                 {"start": "2026-10-01T15:30", "timezone": "America/Indiana/Indianapolis"})
        self.assertTrue(n["event_id"])
        self.assertEqual(n["meeting"]["title"], "Call with Dr. Patel")
        m = meetings.get_meeting(n["event_id"])
        self.assertEqual(m["topics"], ["funding news", "lab rotation"])
        self.assertEqual(m["note_id"], self.note["id"])
        self.assertEqual(boards.get_board(self.board["id"])["notes"][0]["meeting"]["start"], m["start"])

    def test_scheduling_again_moves_the_same_meeting(self):
        first = boards.schedule_note(self.board["id"], self.note["id"], {"start": "2026-10-01T15:30"})
        again = boards.schedule_note(self.board["id"], self.note["id"], {"start": "2026-10-02T09:00"})
        self.assertEqual(first["event_id"], again["event_id"])
        self.assertEqual(again["meeting"]["start"], "2026-10-02T09:00:00Z")

    def test_a_meeting_deleted_in_the_calendar_frees_the_note(self):
        n = boards.schedule_note(self.board["id"], self.note["id"], {"start": "2026-10-01T15:30"})
        meetings.delete_meeting(n["event_id"])
        self.assertIsNone(boards.get_board(self.board["id"])["notes"][0]["event_id"])

    def test_unscheduling_can_keep_or_delete_the_meeting(self):
        n = boards.schedule_note(self.board["id"], self.note["id"], {"start": "2026-10-01T15:30"})
        kept = boards.unschedule_note(self.board["id"], self.note["id"])
        self.assertIsNone(kept["event_id"])
        meetings.get_meeting(n["event_id"])                            # still there
        n2 = boards.schedule_note(self.board["id"], self.note["id"], {"start": "2026-10-01T15:30"})
        boards.unschedule_note(self.board["id"], self.note["id"], delete_meeting=True)
        with self.assertRaises(FriendlyError):
            meetings.get_meeting(n2["event_id"])


if __name__ == "__main__":
    unittest.main()
