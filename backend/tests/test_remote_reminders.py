"""Email and text reminders: what leaves the laptop, and only when one is turned on (remote_reminders.py)."""
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import meetings, remote_reminders as rr  # noqa: E402
from backend.core import sessions as sess  # noqa: E402


def _clear():
    with sess._connect() as conn:
        conn.execute("DELETE FROM calendar_events")
        conn.execute("DELETE FROM calendars")
        conn.execute("DELETE FROM remote_reminders_forget")


class Service:
    """ireliabee.co.uk, as far as these tests need it."""

    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        if self.fail:
            raise rr.RemoteError("Could not reach iReliabee.")
        return {"reminders": len((body or {}).get("reminders", [])), "texts": 0, "credits": 0}


REYES = {
    "title": "Call with Dr. Reyes", "start": "2026-10-02T15:00", "timezone": "Africa/Accra",
    "their_timezone": "America/New_York", "minutes": 25, "location": "https://example.zoom.us/j/1",
    "topics": ["Research plan feedback", "Next steps"], "prep": "Send the plan.",
    "notes": "Private: ask about funding", "people": [{"name": "Sam Reyes", "email": "sam@example.edu"}],
}


class RemoteRemindersTest(unittest.TestCase):
    def setUp(self):
        _clear()
        self.service = Service()
        patcher = mock.patch.object(rr, "_call", self.service)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_text_says_when_theirs_where_topics_and_prep(self):
        m = meetings.create_meeting(REYES)
        said = rr.reminder_text(m, 15)
        self.assertEqual(said["subject"], "Call with Dr. Reyes in 15 minutes")
        self.assertEqual(said["text"].splitlines(), [
            "Call with Dr. Reyes",
            "In 15 minutes, at 3:00 pm (GMT), Fri 2 Oct",
            "That's 11:00 am in New York",
            "Join: https://example.zoom.us/j/1",
            "Topics: Research plan feedback; Next steps",
            "Prepare: Send the plan.",
        ])
        self.assertNotIn("funding", said["text"])          # never the notes
        self.assertNotIn("sam@example.edu", said["text"])     # never the people

    def test_nothing_leaves_the_laptop_for_desktop_only_reminders(self):
        m = meetings.create_meeting(REYES)
        self.assertIsNone(m["remote"])
        self.assertEqual(self.service.calls, [])

    def test_email_and_text_reminders_are_sent_and_taken_back(self):
        m = meetings.create_meeting({**REYES, "reminders": [
            {"minutes": 30, "channels": ["desktop", "email"]}, {"minutes": 15, "channels": ["desktop", "sms"]}]})
        method, path, body = self.service.calls[-1]
        self.assertEqual((method, path), ("PUT", f"/reminders/{m['uid']}"))
        self.assertEqual([(r["channel"], r["at"]) for r in body["reminders"]],
                         [("email", 1790951400), ("sms", 1790952300)])   # 14:30 and 14:45 UTC
        self.assertTrue(m["remote"]["ok"])

        # Turned back to desktop only: the service is told to drop them, once.
        meetings.update_meeting(m["id"], {"reminders": [{"minutes": 30, "channels": ["desktop"]}]})
        self.assertEqual(self.service.calls[-1][2], {"reminders": []})
        n = len(self.service.calls)
        meetings.update_meeting(m["id"], {"title": "Call with Eric"})
        self.assertEqual(len(self.service.calls), n)

    def test_offline_the_meeting_is_saved_and_sent_on_the_next_sync(self):
        self.service.fail = True
        m = meetings.create_meeting({**REYES, "reminders": [{"minutes": 15, "channels": ["email"]}]})
        self.assertFalse(m["remote"]["ok"])
        self.assertEqual(meetings.get_meeting(m["id"])["title"], "Call with Dr. Reyes")   # kept all the same

        self.service.fail = False
        with mock.patch.object(rr.account, "access_token", return_value="t"):
            self.assertEqual(rr.resend_pending(), 1)
        self.assertEqual(self.service.calls[-1][0], "PUT")
        with mock.patch.object(rr.account, "access_token", return_value="t"):
            self.assertEqual(rr.resend_pending(), 0)

    def test_deleting_a_meeting_takes_its_reminders_back_even_if_offline(self):
        m = meetings.create_meeting({**REYES, "reminders": [{"minutes": 15, "channels": ["sms"]}]})
        self.service.fail = True
        meetings.delete_meeting(m["id"])
        self.assertEqual(self.service.calls[-1][:2], ("DELETE", f"/reminders/{m['uid']}"))
        self.service.fail = False
        with mock.patch.object(rr.account, "access_token", return_value="t"):
            self.assertEqual(rr.resend_pending(), 1)
        self.assertEqual(self.service.calls[-1][:2], ("DELETE", f"/reminders/{m['uid']}"))

    def test_lead_labels(self):
        self.assertEqual([rr.lead_label(n) for n in (15, 60, 120, 1440)], ["15 minutes", "1 hour", "2 hours", "1 day"])


if __name__ == "__main__":
    unittest.main()
