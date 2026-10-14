"""Roadmap 3.4: practise hard moments from real calls again, scored against the earlier attempt."""
import asyncio
import json
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend import retry, debrief  # noqa: E402,F401  (debrief adds sessions.debrief_json)
from backend.routers import mock as mock_router, progress  # noqa: E402


class RetryTest(unittest.TestCase):
    def setUp(self):
        with sess._connect() as conn:
            conn.execute("DELETE FROM retries")
            conn.execute("DELETE FROM messages")
            conn.execute("DELETE FROM sessions")
        # A live call with a debrief: one weak answer, one strong one.
        self.live = sess.create_session(title="Acme final round", mode="general")
        report = {"questions": [
            {"question": "Tell me about a conflict.", "answer_summary": "Rambled about a deadline.", "score": 4,
             "verdict": "No clear resolution.", "improvements": ["Say what you did"]},
            {"question": "Why this company?", "answer_summary": "Specific and warm.", "score": 9, "verdict": "Great."},
        ]}
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET debrief_json = ? WHERE id = ?", (json.dumps(report), self.live))
        # A typed mock: question, answer, feedback with its score.
        self.mock = sess.create_session(title="Mock interview", mode="tech-interview")
        sess.append_message(self.mock, "user", "Explain a hash map.", speaker="interviewer")
        sess.append_message(self.mock, "user", "It stores things.", speaker="you")
        sess.append_message(self.mock, "assistant", "**Score: 2/10** — Too vague to show understanding.\n\n**What worked**")

    def test_weak_answers_from_debriefs_and_mocks_become_moments(self):
        moments = retry.hard_moments()
        self.assertEqual([m["question"] for m in moments], ["Explain a hash map.", "Tell me about a conflict."])  # lowest first
        mock_moment = moments[0]
        self.assertEqual((mock_moment["score"], mock_moment["previous_answer"], mock_moment["source"]), (2, "It stores things.", "mock"))
        self.assertEqual(mock_moment["feedback"], "Too vague to show understanding.")
        self.assertEqual(moments[1]["improvements"], ["Say what you did"])

    def run_retry(self, reply, **kw):
        seen = {}

        async def fake(model, system_prompt, message):
            seen["message"] = message
            return reply
        with mock.patch.object(mock_router, "_ask_model", fake):
            out = asyncio.run(retry.score_retry(kw.get("session_id", self.mock), kw.get("question", "Explain a hash map."),
                                                "It maps keys to values using a hash function…", "It stores things.", 2, "", None))
        return out, seen

    def test_a_retry_is_scored_against_the_earlier_attempt(self):
        out, seen = self.run_retry({"score": 7, "verdict": "Much clearer.", "improved": ["Defines hashing"],
                                    "still_missing": ["Collisions"], "better_answer": "…"})
        self.assertEqual((out["score"], out["previous_score"], out["delta"]), (7, 2, 5))
        self.assertIn("EARLIER ATTEMPT (scored 2/10): It stores things.", seen["message"])
        self.assertEqual(out["still_missing"], ["Collisions"])

    def test_solved_moments_drop_to_the_end_and_show_their_best(self):
        self.run_retry({"score": 9, "verdict": "Solid."})
        moments = retry.hard_moments()
        self.assertEqual(moments[-1]["question"], "Explain a hash map.")
        self.assertEqual(moments[-1]["best_retry"]["score"], 9)
        self.assertIsNone(moments[0]["best_retry"])

    def test_retries_count_as_practice(self):
        self.run_retry({"score": 6})
        self.assertGreaterEqual(progress.get_progress()["summary"]["streak_days"], 1)


if __name__ == "__main__":
    unittest.main()
