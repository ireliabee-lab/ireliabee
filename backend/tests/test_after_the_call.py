"""After the call (H1b): the notebook of a session started from a meeting lands on the meeting, with its action items."""
import json
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import meetings, remote_reminders as rr  # noqa: E402
from backend.core import sessions as sess  # noqa: E402
from backend.routers import sessions as sessions_router  # noqa: E402,F401  (adds setup_json)


def _clear():
    with sess._connect() as conn:
        conn.execute("DELETE FROM calendar_events")
        conn.execute("DELETE FROM calendars")


def _session_for(event_id):
    s = sess.create_session("Call with Dr. Reyes", "meeting")
    sid = s["id"] if isinstance(s, dict) else s
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET setup_json = ? WHERE id = ?", (json.dumps({"event_id": event_id}), sid))
    return sid


NOTEBOOK = {"id": 41, "title": "Call with Dr. Reyes: notes", "doc": {"board": {"actions": [
    {"text": "Send the research plan", "owner": "Not agreed", "due": "Wednesday", "done": False},
    {"text": "Share two FluencyBank papers", "owner": "Dr. Reyes", "due": "", "done": False},
    {"text": "Book the next call", "owner": "You", "due": "2026-10-09", "done": False},
    {"text": "Already sorted", "owner": "", "due": "", "done": True},
]}}}


class AfterTheCallTest(unittest.TestCase):
    def setUp(self):
        _clear()
        patcher = mock.patch.object(rr, "_call", lambda *a, **k: {})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_notes_and_their_action_items_come_back_to_the_meeting(self):
        m = meetings.create_meeting({"title": "Call with Dr. Reyes", "start": "2026-09-25T15:00", "timezone": "Africa/Accra",
                                     "followups": [{"text": "Send the research plan (by Wednesday)", "kind": "promised"}]})
        out = meetings.attach_notebook(_session_for(m["id"]), NOTEBOOK)
        self.assertIn({"kind": "notebook", "id": 41, "label": "Call with Dr. Reyes: notes"}, out["links"])
        added = [f for f in out["followups"] if f.get("source") == "notes"]
        self.assertEqual([(f["text"], f["due"]) for f in added], [
            ("Dr. Reyes: Share two FluencyBank papers", None),
            ("Book the next call", "2026-10-09"),
        ])      # "Send the research plan (by Wednesday)" was already there; the done one is left out

        # Rewriting the notes adds nothing twice, and keeps one link.
        again = meetings.attach_notebook(_session_for(m["id"]), NOTEBOOK)
        self.assertEqual(len(again["followups"]), len(out["followups"]))
        self.assertEqual(sum(1 for l in again["links"] if l["kind"] == "notebook"), 1)

    def test_a_session_not_from_a_meeting_is_left_alone(self):
        s = sess.create_session("Practice", "meeting")
        sid = s["id"] if isinstance(s, dict) else s
        self.assertIsNone(meetings.attach_notebook(sid, NOTEBOOK))
        self.assertIsNone(meetings.attach_notebook(_session_for(99999), NOTEBOOK))


if __name__ == "__main__":
    unittest.main()
