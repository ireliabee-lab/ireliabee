"""Roadmap 3.1: lecture companion — record without answering, study pack, quiz results in Progress."""
import asyncio
import unittest
from unittest import mock

from fastapi import HTTPException

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend import study  # noqa: E402
from backend.routers import sessions as sessions_router, mock as mock_router, progress  # noqa: E402
from backend.core.templates import render_prompt  # noqa: E402

PACK = {
    "title": "Raft consensus",
    "summary": "How Raft elects a leader.",
    "outline": [{"heading": "Elections", "points": ["Timeouts trigger elections"]}],
    "key_points": ["A majority elects the leader"],
    "glossary": [{"term": "Term", "definition": "A numbered election period"}],
    "flashcards": [{"front": "What elects a leader?", "back": "A majority vote"}, {"front": "", "back": "dropped"}],
    "quiz": [
        {"question": "Who can commit an entry?", "options": ["Any node", "The leader, once a majority stores it", "A follower", "Nobody"], "answer": 1, "explanation": "Majority rule."},
        {"question": "Broken answer index", "options": ["a", "b"], "answer": 7},
        {"question": "Too few options", "options": ["only"], "answer": 0},
    ],
}


class StudyTest(unittest.TestCase):
    def setUp(self):
        self.sid = sess.create_session(title="Lecture 6", mode="lecture")

    def say(self, text, speaker="interviewer"):
        sessions_router.record_transcript(self.sid, sessions_router.TranscriptBody(text=text, speaker=speaker))

    def test_lectures_are_recorded_without_asking_the_coach(self):
        self.say("Raft elects one leader per term.")
        self.say("Why randomised timeouts?", speaker="user")
        self.assertEqual(study.lecture_text(self.sid), "Raft elects one leader per term.\n(Student) Why randomised timeouts?")
        self.assertEqual(sess.get_session(self.sid)["status"], "active")
        with self.assertRaises(HTTPException):
            sessions_router.record_transcript(self.sid, sessions_router.TranscriptBody(text="  "))

    def test_long_text_splits_on_line_boundaries(self):
        text = "\n".join(f"line {i} " + "x" * 90 for i in range(100))
        parts = study.chunks(text, 1000)
        self.assertGreater(len(parts), 5)
        self.assertEqual("\n".join(parts), text)                  # nothing lost or reordered
        self.assertTrue(all(len(p) <= 1100 for p in parts))

    def test_pack_keeps_only_valid_cards_and_questions(self):
        pack = study.clean_pack(PACK)
        self.assertEqual(len(pack["flashcards"]), 1)
        self.assertEqual(len(pack["quiz"]), 1)                       # bad index and too few options dropped
        q = pack["quiz"][0]
        self.assertEqual(q["options"][q["answer"]], "The leader, once a majority stores it")  # answer follows the shuffle

    def test_answer_positions_are_shuffled_but_stable(self):
        quiz = [{"question": f"Q{i}?", "options": ["right", "w1", "w2", "w3"], "answer": 0} for i in range(40)]
        packed = study.clean_pack({"quiz": quiz})["quiz"]
        positions = {q["answer"] for q in packed}
        self.assertEqual(positions, {0, 1, 2, 3})                   # not always first
        self.assertTrue(all(q["options"][q["answer"]] == "right" for q in packed))
        again = study.clean_pack({"quiz": quiz})["quiz"]
        self.assertEqual([q["answer"] for q in packed], [q["answer"] for q in again])  # same pack, same order

    def test_a_study_pack_is_built_from_the_lecture_and_saved(self):
        self.say("Raft elects one leader per term. " * 10)
        seen = {}

        async def fake(model, system_prompt, message):
            seen["prompt"], seen["message"] = system_prompt, message
            return PACK
        with mock.patch.object(mock_router, "_ask_model", fake):
            pack = asyncio.run(study.generate_pack(self.sid, None))
        self.assertEqual(pack["title"], "Raft consensus")
        self.assertFalse(pack["condensed"])
        self.assertIn("Use ONLY what the lecturer said", seen["prompt"])
        self.assertIn("Raft elects one leader", seen["message"])
        saved = study.load_pack(self.sid)["quiz"][0]
        self.assertEqual(saved["options"][saved["answer"]], "The leader, once a majority stores it")
        listed = {p["session_id"]: p for p in study.list_packs()}
        self.assertTrue(listed[self.sid]["ready"])

    def test_a_lecture_without_its_pack_is_still_listed_so_it_can_be_made(self):
        # The app closed as the lecture ended, or making the pack failed: it must not vanish from Study.
        self.say("Raft elects one leader per term.")
        empty = sess.create_session(title="Lecture 7", mode="lecture")        # nothing recorded
        other = sess.create_session(title="Interview", mode="general")
        sessions_router.record_transcript(other, sessions_router.TranscriptBody(text="Tell me about yourself", speaker="interviewer"))
        listed = {p["session_id"]: p for p in study.list_packs()}
        self.assertIn(self.sid, listed)
        self.assertFalse(listed[self.sid]["ready"])
        self.assertEqual((listed[self.sid]["flashcards"], listed[self.sid]["quiz"]), (0, 0))
        self.assertNotIn(empty, listed)
        self.assertNotIn(other, listed)

    def test_long_lectures_are_condensed_part_by_part_first(self):
        self.say(("The leader replicates entries with AppendEntries. " * 40 + "\n") * 25)   # > DIRECT_LIMIT
        condensed_calls = []

        def fake_respond(provider, model, text, history, system_prompt, max_tokens=1024):
            condensed_calls.append(text[:12])
            return "condensed notes"

        async def fake_ask(model, system_prompt, message):
            self.assertIn("[Part 1]\ncondensed notes", message)
            return PACK
        with mock.patch.object(mock_router, "respond", fake_respond), \
             mock.patch.object(mock_router, "resolve_llm", return_value=("m", "p")), \
             mock.patch.object(mock_router, "_ask_model", fake_ask):
            pack = asyncio.run(study.generate_pack(self.sid, None))
        self.assertTrue(pack["condensed"])
        self.assertGreaterEqual(len(condensed_calls), 2)
        self.assertTrue(all(c.startswith("PART ") for c in condensed_calls))

    def test_too_little_lecture_is_a_clear_error(self):
        self.say("Hello.")
        with self.assertRaises(HTTPException) as err:
            asyncio.run(study.generate_pack(self.sid, None))
        self.assertEqual(err.exception.detail["title"], "Not enough lecture to study yet")

    def test_quiz_results_count_as_practice(self):
        study.record_result(self.sid, "quiz", 7, 10)
        with self.assertRaises(HTTPException):
            study.record_result(self.sid, "quiz", 11, 10)
        results = progress._study_results()
        self.assertEqual(results[-1]["percent"], 70)
        out = progress.get_progress()
        self.assertGreaterEqual(out["summary"]["quizzes"], 1)
        self.assertGreaterEqual(out["summary"]["streak_days"], 1)

    def test_the_lecture_coach_only_explains(self):
        prompt = render_prompt("lecture", {"name": "Ama"})
        self.assertIn("only asked when Ama wants a passage explained", prompt)
        self.assertIn("Stay faithful to what the lecturer said", prompt)


if __name__ == "__main__":
    unittest.main()
