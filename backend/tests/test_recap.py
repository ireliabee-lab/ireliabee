"""Roadmap 2.1: a meeting ends with one recap — notes, owners and due dates, and the recap email."""
import asyncio
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend.core import templates  # noqa: E402
from backend import meeting_notes  # noqa: E402
from backend.routers import mock as mock_router  # noqa: E402

REPLY = {
    "summary": "Agreed to ship the billing fix first.",
    "decisions": ["Ship the billing fix before the dashboard"],
    "action_items": [{"who": "You", "what": "Send the rollout plan", "due": "Friday"},
                     {"who": "Priya", "what": "Review the migration"}],
    "open_questions": ["Who owns on-call?"],
    "email": {"subject": "Recap: billing fix", "body": "Thanks all.\n- You: rollout plan (Friday)"},
}


class RecapTest(unittest.TestCase):
    def setUp(self):
        self.sid = sess.create_session(title="Billing sync", mode="work-meeting")
        sess.append_message(self.sid, "user", "Can you send the rollout plan by Friday?", speaker="interviewer")
        sess.append_message(self.sid, "user", "Yes, I'll send it Friday.", speaker="user")
        self.prompt = ""

    def run_recap(self):
        async def fake(model, system_prompt, message):
            self.prompt = system_prompt
            return REPLY
        with mock.patch.object(mock_router, "_ask_model", fake):
            return asyncio.run(meeting_notes.generate_notes(self.sid, None))

    def test_action_items_keep_owner_and_due_date(self):
        out = self.run_recap()
        self.assertEqual(out["action_items"], [
            {"who": "You", "what": "Send the rollout plan", "due": "Friday"},
            {"who": "Priya", "what": "Review the migration", "due": ""},
        ])

    def test_recap_email_comes_with_the_notes_and_is_saved(self):
        out = self.run_recap()
        self.assertEqual(out["email"]["subject"], "Recap: billing fix")
        self.assertEqual(meeting_notes.load_notes(self.sid)["email"]["body"], REPLY["email"]["body"])
        self.assertIn('"Interviewer" are the other people', self.prompt)
        self.assertIn("never invent", self.prompt)

    def test_the_meeting_coach_pins_down_decisions_and_actions(self):
        prompt = templates.TEMPLATES["work-meeting"]["system_prompt"]
        self.assertIn("So to confirm", prompt)
        self.assertIn("recap", templates.TEMPLATES["work-meeting"]["label"])


if __name__ == "__main__":
    unittest.main()
