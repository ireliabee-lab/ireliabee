"""Roadmap 2.3: IELTS and TOEFL-style speaking practice, in the exam's structure, scored band-style and honestly."""
import asyncio
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import exams, debrief  # noqa: E402
from backend.core import sessions as sess  # noqa: E402
from backend.routers import mock as mock_router  # noqa: E402

IELTS = exams.EXAMS["ielts"]
TOEFL = exams.EXAMS["toefl"]


class ScoringTest(unittest.TestCase):
    def test_ielts_overall_rounds_like_ielts(self):
        self.assertEqual(exams.ielts_round(6.25), 6.5)   # .25 rounds up to the half band
        self.assertEqual(exams.ielts_round(6.75), 7.0)   # .75 rounds up to the whole band
        self.assertEqual(exams.ielts_round(6.1), 6.0)
        self.assertEqual(exams.ielts_round(6.6), 6.5)

    def test_pronunciation_is_never_scored_from_text_or_transcript(self):
        for spoken in (False, True):
            out = exams.clean_bands(IELTS, {"fluency": 7, "vocabulary": 6, "grammar": 6, "pronunciation": 9}, spoken)
            self.assertIsNone(out["bands"]["pronunciation"])
            self.assertEqual(out["overall"], 6.5)            # (7+6+6)/3 = 6.33 → 6.5, pronunciation left out
            self.assertEqual(out["not_assessed"], ["pronunciation"])

    def test_toefl_delivery_only_counts_when_spoken(self):
        typed = exams.clean_bands(TOEFL, {"delivery": 4, "language_use": 3, "topic_development": 3}, spoken=False)
        self.assertIsNone(typed["bands"]["delivery"])
        self.assertEqual((typed["overall"], typed["scaled"]), (3.0, 22))
        spoken = exams.clean_bands(TOEFL, {"delivery": 4, "language_use": 3, "topic_development": 3}, spoken=True)
        self.assertEqual(spoken["bands"]["delivery"], 4.0)
        self.assertEqual(spoken["scaled"], 25)              # mean 3.33 of 4 → 25/30

    def test_scores_are_clamped_and_junk_is_ignored(self):
        out = exams.clean_bands(IELTS, {"fluency": 12, "vocabulary": "abc", "grammar": -3}, spoken=False)
        self.assertEqual(out["bands"]["fluency"], 9.0)
        self.assertIsNone(out["bands"]["vocabulary"])
        self.assertEqual(out["bands"]["grammar"], 0.0)

    def test_rubric_tells_the_examiner_what_not_to_score(self):
        text = exams.rubric_block(IELTS, spoken=False)
        self.assertIn("Do NOT score Pronunciation", text)
        self.assertIn("calibrated", text)
        self.assertIn("6 — competent", text)   # anchors across the scale, not just the top


class PracticeTest(unittest.TestCase):
    def setUp(self):
        # Band scoring is a Pro feature (docs/pricing-boundary.md); these tests
        # are about the exam itself, so they run as a licensed user.
        self._pro = _env.pro()
        self._pro.__enter__()
        self.addCleanup(lambda: self._pro.__exit__(None, None, None))

    def ask(self, reply):
        seen = {}

        # **kwargs so the double keeps matching _ask_model as it gains
        # cost-metering arguments it does not care about.
        async def fake(model, system_prompt, message, **kwargs):
            seen["prompt"] = system_prompt
            seen.update(kwargs)
            return reply
        return seen, mock.patch.object(mock_router, "_ask_model", fake)

    def test_an_ielts_test_follows_the_three_parts_with_timings(self):
        reply = {"questions": [
            {"part": "Part 1", "question": "Do you work or study?", "prep_seconds": 0, "speak_seconds": 30},
            {"part": "Part 2", "question": "Describe a place you visited.\n- where it was", "prep_seconds": 60, "speak_seconds": 120},
            {"part": "Part 3", "question": "Why do people travel?", "prep_seconds": 0, "speak_seconds": 60},
        ]}
        seen, patch = self.ask(reply)
        with patch, mock.patch.object(mock_router, "resolve_llm", return_value=("m", "p")):
            out = asyncio.run(mock_router.start_mock(mock_router.StartBody(scenario="ielts")))
        self.assertEqual([q["part"] for q in out["questions"]], ["Part 1", "Part 2", "Part 3"])
        self.assertEqual(out["questions"][1]["prep_seconds"], 60)
        self.assertEqual(out["exam"]["id"], "ielts")
        self.assertIn("Part 2: 1 question(s)", seen["prompt"])
        self.assertIn("mock,exam,ielts", sess.get_session(out["session_id"])["tags"])

    def test_an_answer_gets_bands_and_a_top_scoring_version(self):
        sid = sess.create_session(title="IELTS practice", mode="general")
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET tags = 'mock,exam,ielts' WHERE id = ?", (sid,))
        reply = {"bands": {"fluency": 6, "vocabulary": 7, "grammar": 6, "pronunciation": 8},
                 "verdict": "Solid band 6.", "strengths": ["Clear topic"], "improvements": ["Link ideas"],
                 "better_answer": "Honestly, I'd say…", "phrasing": [{"said": "more better", "better": "much better", "why": "comparative"}]}
        seen, patch = self.ask(reply)
        with patch:
            out = asyncio.run(mock_router.answer_mock(mock_router.AnswerBody(
                session_id=sid, question="Do you like cooking?", answer="Yes I like it more better than before.", part="Part 1")))
        self.assertEqual(out["exam"]["overall"], 6.5)
        self.assertIsNone(out["exam"]["bands"]["pronunciation"])
        self.assertEqual(out["score"], 7)                   # 6.5/9 on the 10-point Progress scale
        self.assertEqual(out["phrasing"][0]["better"], "much better")
        self.assertIn("Do NOT score Pronunciation", seen["prompt"])

    def test_the_voice_examiner_runs_the_real_structure(self):
        from backend.scenarios import get_scenario
        _, scenario = get_scenario("ielts")
        prompt = mock_router._interviewer_prompt("Hannah", "", "mixed", 5, {}, "ctx", "", scenario)
        self.assertIn("IELTS Speaking examiner", prompt)
        self.assertIn("Part 2", prompt)
        self.assertIn("no feedback", prompt)

    def test_the_voice_debrief_adds_whole_test_bands(self):
        sid = sess.create_session(title="IELTS call", mode="voice-mock")
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET tags = 'mock,voice,ielts' WHERE id = ?", (sid,))
        sess.append_message(sid, "user", "Tell me about your hometown.", speaker="interviewer")
        sess.append_message(sid, "user", "My hometown is Kumasi, it is very lively.", speaker="user")
        seen = {}

        async def fake(model, system_prompt, message):
            seen["prompt"] = system_prompt
            return {"overall_score": 6, "summary": "Good.", "questions": [],
                    "bands": {"fluency": 7, "vocabulary": 6, "grammar": 6, "pronunciation": 7}}
        with mock.patch.object(mock_router, "_ask_model", fake):
            report = asyncio.run(debrief.generate_debrief(sid, None, None))
        self.assertEqual(report["exam"]["overall"], 6.5)
        self.assertIsNone(report["exam"]["bands"]["pronunciation"])
        self.assertIn('"bands"', seen["prompt"])


if __name__ == "__main__":
    unittest.main()
