"""Follow-ups on a meeting: what they asked, what you promised, your to-dos, with due dates (H1)."""
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import meetings, remote_reminders as rr  # noqa: E402
from backend.core import sessions as sess  # noqa: E402
from backend.errors import FriendlyError  # noqa: E402


def _clear():
    with sess._connect() as conn:
        conn.execute("DELETE FROM calendar_events")
        conn.execute("DELETE FROM calendars")


REYES = {
    "title": "Call with Dr. Reyes", "start": "2026-09-25T15:00", "timezone": "Africa/Accra", "minutes": 25,
    "about": "A university speech lab. Frank about what a strong application needs.",
    "followups": [
        {"text": "Send the research plan", "kind": "promised", "due": "2026-09-30", "remind": ["desktop", "email"]},
        {"text": "Start the FluencyBank variability project", "kind": "promised"},
        {"text": "Explain how my AI background fits", "kind": "asked", "done": True},
    ],
}


class FollowupTest(unittest.TestCase):
    def setUp(self):
        _clear()
        self.sent = []
        patcher = mock.patch.object(rr, "_call", lambda method, path, body=None: self.sent.append((method, path, body)) or {})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_follow_ups_are_kept_with_ids_and_the_about_text(self):
        m = meetings.create_meeting(REYES)
        self.assertEqual(m["about"], REYES["about"])
        self.assertEqual([f["kind"] for f in m["followups"]], ["promised", "promised", "asked"])
        self.assertTrue(all(len(f["id"]) == 8 for f in m["followups"]))
        self.assertEqual(m["followups"][1]["remind"], ["desktop"])          # desktop unless chosen otherwise
        with self.assertRaises(FriendlyError):
            meetings.create_meeting({**REYES, "followups": [{"text": "x", "due": "30/09/2026"}]})

    def test_open_follow_ups_come_from_past_meetings_too_soonest_first(self):
        meetings.create_meeting(REYES)
        meetings.create_meeting({"title": "Riverside info session", "start": "2026-10-01T19:30", "timezone": "UTC",
                                 "followups": [{"text": "Register with the QR code", "due": "2026-09-29"}]})
        open_ = meetings.open_followups()
        self.assertEqual([f["text"] for f in open_],
                         ["Register with the QR code", "Send the research plan", "Start the FluencyBank variability project"])
        self.assertEqual(open_[1]["meeting_title"], "Call with Dr. Reyes")

    def test_ticking_one_off(self):
        m = meetings.create_meeting(REYES)
        fid = m["followups"][0]["id"]
        done = meetings.set_followup_done(m["id"], fid, True)
        self.assertTrue(done["followups"][0]["done"])
        self.assertNotIn(fid, [f["id"] for f in meetings.open_followups()])
        with self.assertRaises(FriendlyError):
            meetings.set_followup_done(m["id"], "nope", True)

    def test_a_due_follow_up_is_emailed_that_morning_and_withdrawn_once_done(self):
        m = meetings.create_meeting(REYES)
        method, path, body = self.sent[-1]
        self.assertEqual(method, "PUT")
        (r,) = body["reminders"]
        self.assertEqual((r["channel"], r["at"]), ("email", 1790758800))       # 30 Sep, 09:00 in Accra
        self.assertEqual(r["subject"], "Due today: Send the research plan")
        self.assertIn("You promised, from: Call with Dr. Reyes (Fri 25 Sep)", r["text"])
        meetings.set_followup_done(m["id"], m["followups"][0]["id"], True)
        self.assertEqual(self.sent[-1][2], {"reminders": []})


if __name__ == "__main__":
    unittest.main()
