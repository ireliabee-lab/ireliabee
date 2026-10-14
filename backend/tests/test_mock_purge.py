"""
The unanswered-mock clean-up deletes without asking, so it must be narrow
(audit 181-H11): it ran on every list, matched any tag containing "mock",
and counted answers labelled "interviewer" or "unknown" as no answer at all.
"""
import unittest
from datetime import datetime, timedelta

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend.routers.sessions import purge_unanswered_mocks  # noqa: E402

OLD = (datetime.utcnow() - timedelta(hours=1)).isoformat(timespec="seconds")


def session(tags: str, status: str = "active", lines=()) -> int:
    sid = sess.create_session(title="t", mode="m")
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET tags = ?, status = ?, created_at = ? WHERE id = ?", (tags, status, OLD, sid))
    for role, speaker in lines:
        sess.append_message(sid, role, "words", speaker=speaker)
    return sid


def exists(sid: int) -> bool:
    return sess.get_session(sid) is not None


class PurgeTest(unittest.TestCase):
    def test_an_abandoned_mock_with_no_answer_goes(self):
        sid = session("mock,job", lines=[("assistant", "interviewer")])
        purge_unanswered_mocks()
        self.assertFalse(exists(sid))

    def test_a_users_own_tag_that_mentions_mock_is_left_alone(self):
        sid = session("mock-prep,work", lines=[("assistant", "interviewer")])
        purge_unanswered_mocks()
        self.assertTrue(exists(sid))

    def test_answers_count_however_they_were_labelled(self):
        for speaker in ("interviewer", "unknown", None):
            sid = session("mock,job", lines=[("assistant", "interviewer"), ("user", speaker)])
            purge_unanswered_mocks()
            self.assertTrue(exists(sid), speaker)

    def test_a_finished_session_is_kept(self):
        sid = session("mock,job", status="ended", lines=[("assistant", "interviewer")])
        purge_unanswered_mocks()
        self.assertTrue(exists(sid))

    def test_a_recent_one_may_still_be_running(self):
        sid = sess.create_session(title="t", mode="m")
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET tags = 'mock,job', status = 'active' WHERE id = ?", (sid,))
        purge_unanswered_mocks()
        self.assertTrue(exists(sid))


if __name__ == "__main__":
    unittest.main()
