import asyncio
import json
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend import presentation as pres  # noqa: E402
from backend import meeting_notes as notes  # noqa: E402
from backend import meeting_prep as prep  # noqa: E402


def _script(words: int) -> str:
    return " ".join(["word"] * words) + "."


class PresentationTimingTest(unittest.TestCase):
    def test_rejects_tiny_input(self):
        with self.assertRaises(HTTPException):
            pres.analyze_timing("too short", None)

    def test_estimates_minutes_at_speaking_pace(self):
        r = pres.analyze_timing(_script(260), None)  # 260 words / 130 wpm = 2 min
        self.assertEqual(r["words"], 260)
        self.assertEqual(r["est_minutes"], 2.0)

    def test_over_under_against_target(self):
        r = pres.analyze_timing(_script(260), 1.0)   # 2 min vs 1 min target
        self.assertEqual(r["over_under"], 1.0)

    def test_flags_long_sentences(self):
        text = " ".join(["clause"] * 40) + ". Short one here now."
        r = pres.analyze_timing(text, None)
        self.assertEqual(len(r["long_sentences"]), 1)
        self.assertEqual(r["long_sentences"][0]["words"], 40)

    def test_flags_jargon(self):
        r = pres.analyze_timing(
            "We will leverage synergy to move the needle going forward on this plan, "
            "and the whole team is expected to fully utilise every available resource here.", None)
        self.assertIn("leverage", r["jargon"])
        self.assertIn("synergy", r["jargon"])
        self.assertIn("move the needle", r["jargon"])


class PresentationClarityTest(unittest.TestCase):
    def test_combines_timing_with_model_clarity(self):
        async def fake(model, system, message):
            self.assertIn("TALK SCRIPT", message)
            return {"clarity_score": "8", "opening": "Here's the one thing to remember.",
                    "strengths": ["clear ask"], "fixes": ["cut the intro", ""]}
        with patch("backend.routers.mock._ask_model", fake):
            r = asyncio.run(pres.analyze_presentation(_script(260), 2.0, None))
        self.assertEqual(r["clarity_score"], 8)
        self.assertEqual(r["timing"]["est_minutes"], 2.0)
        self.assertEqual(r["fixes"], ["cut the intro"])


class MeetingNotesTest(unittest.TestCase):
    def setUp(self):
        self.sid = sess.create_session("Standup", "meeting", "", "")
        with sess._connect() as conn:
            for speaker, text in [
                ("interviewer", "Where are we on the payments migration?"),
                ("you", "Backend is done. I still need to migrate the webhook handler by Friday."),
                ("interviewer", "What about the rollback plan?"),
            ]:
                conn.execute(
                    "INSERT INTO messages (session_id, role, speaker, content, created_at) VALUES (?, 'user', ?, ?, '')",
                    (self.sid, speaker, text),
                )

    def test_generates_and_saves(self):
        reply = {"summary": "Discussed the payments migration status.",
                 "decisions": ["Ship behind a flag"],
                 "action_items": [{"who": "You", "what": "Migrate the webhook handler by Friday"},
                                  {"who": "", "what": ""}],
                 "open_questions": ["What is the rollback plan?"]}
        with patch("backend.routers.mock._ask_model", lambda *a: _coro(reply)):
            report = asyncio.run(notes.generate_notes(self.sid, None))
        self.assertEqual(len(report["action_items"]), 1)
        self.assertEqual(report["action_items"][0]["who"], "You")
        self.assertEqual(report["open_questions"], ["What is the rollback plan?"])
        self.assertEqual(notes.load_notes(self.sid), json.loads(json.dumps(report)))

    def test_empty_session_rejected(self):
        empty = sess.create_session("Empty", "meeting", "", "")
        with self.assertRaises(HTTPException):
            asyncio.run(notes.generate_notes(empty, None))


class MeetingPrepTest(unittest.TestCase):
    def test_rejects_thin_agenda(self):
        with self.assertRaises(HTTPException):
            asyncio.run(prep.generate_prep("hi", "", None))

    def test_generates_clean_lists(self):
        # Mapping the result into a plan is frontend/src/lib/planFromAgenda.ts (tested there).
        reply = {"likely_questions": ["Why now?", ""], "talking_points": ["We have traction"], "risks": ["Budget freeze — cite ROI"]}
        with patch("backend.routers.mock._ask_model", lambda *a: _coro(reply)):
            out = asyncio.run(prep.generate_prep("Discuss Q3 roadmap and budget ask", "leadership meeting", None))
        self.assertEqual(out["likely_questions"], ["Why now?"])
        self.assertEqual(out["talking_points"], ["We have traction"])
        self.assertEqual(out["risks"], ["Budget freeze — cite ROI"])


async def _coro(value):
    return value


if __name__ == "__main__":
    unittest.main()
