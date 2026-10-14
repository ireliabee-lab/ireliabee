"""
A saved session opens as it was set up.

Found preparing for a PhD interview: a session made with the Academic / PhD
coach, a plan, files, people and instructions came back from the Sessions
page with the default coach and none of the rest, so the coach would have
answered the interview as a work meeting.
"""
import unittest

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.routers.sessions import (  # noqa: E402
    SessionCreateBody, SessionSetup, SessionUpdateBody, create_session, get_one, update_session,
)


def made() -> dict:
    return create_session(SessionCreateBody(
        title="PhD fit call", template="academic-phd", language="en",
        setup=SessionSetup(plan_id=5, cv_id=1, document_ids=[6], people_ids=[3],
                           ai_instructions="Keywords, not sentences.", response_tone="basic", auto_answer=True),
    ))


class SessionSetupTest(unittest.TestCase):
    def test_a_session_keeps_its_coach_plan_files_people_and_instructions(self):
        s = get_one(made()["id"])
        self.assertEqual(s["mode"], "academic-phd")
        self.assertEqual(s["setup"], {
            "plan_id": 5, "cv_id": 1, "document_ids": [6], "people_ids": [3],
            "ai_instructions": "Keywords, not sentences.", "response_tone": "basic", "auto_answer": True,
        })

    def test_a_change_replaces_only_what_it_names(self):
        sid = made()["id"]
        s = update_session(sid, SessionUpdateBody(template="work-meeting", setup=SessionSetup(plan_id=None)))
        self.assertEqual(s["mode"], "work-meeting")
        self.assertIsNone(s["setup"]["plan_id"], "choosing no plan is kept, not ignored")
        self.assertEqual(s["setup"]["document_ids"], [6])
        self.assertEqual(s["setup"]["ai_instructions"], "Keywords, not sentences.")

    def test_a_session_from_before_this_opens_with_an_empty_setup(self):
        s = create_session(SessionCreateBody(title="old", template="general"))
        self.assertEqual(s["setup"], {})

    def test_instructions_have_a_limit(self):
        with self.assertRaises(Exception):
            SessionSetup(ai_instructions="x" * 4001)


if __name__ == "__main__":
    unittest.main()
