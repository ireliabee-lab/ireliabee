"""delete_superseded_exchange: a speaker kept talking, so the answer to the
first part of their question is replaced by the answer to the whole thing."""
import pathlib
import tempfile
import unittest

from backend.core import sessions as s


class SupersededExchangeTest(unittest.TestCase):
    def setUp(self):
        self._orig = (s.DB_DIR, s.DB_PATH)
        s.DB_DIR = pathlib.Path(tempfile.mkdtemp())
        s.DB_PATH = s.DB_DIR / "t.db"
        self.sid = s.create_session("t", "live")

    def tearDown(self):
        s.DB_DIR, s.DB_PATH = self._orig

    def add(self, *pairs):
        for question, answer in pairs:
            s.append_message(self.sid, "user", question, "interviewer")
            if answer is not None:
                s.append_message(self.sid, "assistant", answer)

    def contents(self):
        return [m["content"] for m in s.load_messages(self.sid)]

    def test_removes_answer_to_first_part(self):
        self.add(("[INTERVIEWER] Tell me about yourself.", "A0"),
                 ("[INTERVIEWER] Why do you want", "A1"))
        self.assertTrue(s.delete_superseded_exchange(self.sid, "Why do you want to work here?"))
        self.assertEqual(self.contents(), ["[INTERVIEWER] Tell me about yourself.", "A0"])

    def test_section_tags_are_ignored(self):
        self.add(("[INTERVIEWER] [§2: Leadership] Tell me about a time", "A1"))
        self.assertTrue(s.delete_superseded_exchange(self.sid, "Tell me about a time you led a team"))
        self.assertEqual(self.contents(), [])

    def test_double_continuation_after_middle_answer_saved(self):
        # "A" answered and replaced by "A B" (saved); now "A B C" replaces "A B".
        self.add(("[INTERVIEWER] Tell me about a project?", "A0"))
        s.delete_superseded_exchange(self.sid, "Tell me about a project? With real users?")
        self.add(("[INTERVIEWER] Tell me about a project? With real users?", "A1"))
        self.assertTrue(s.delete_superseded_exchange(
            self.sid, "Tell me about a project? With real users? And what you'd change?"))
        self.assertEqual(self.contents(), [])

    def test_double_continuation_when_middle_answer_was_cancelled(self):
        # "A B" was cancelled before it finished, so "A" is still the saved one.
        self.add(("[INTERVIEWER] Tell me about a project?", "A0"))
        self.assertTrue(s.delete_superseded_exchange(
            self.sid, "Tell me about a project? With real users? And what you'd change?"))
        self.assertEqual(self.contents(), [])

    def test_unrelated_latest_question_is_kept(self):
        self.add(("[INTERVIEWER] What's your notice period?", "A0"))
        self.assertFalse(s.delete_superseded_exchange(self.sid, "Why do you want to work here?"))
        self.assertEqual(len(self.contents()), 2)

    def test_older_matching_question_is_never_touched(self):
        # Only the most recent question may be superseded.
        self.add(("[INTERVIEWER] Tell me more", "A0"),
                 ("[INTERVIEWER] What's your notice period?", "A1"))
        self.assertFalse(s.delete_superseded_exchange(self.sid, "Tell me more about the migration"))
        self.assertEqual(len(self.contents()), 4)

    def test_whitespace_differences(self):
        self.add(("[YOU]  I led the   migration", "A0"))
        self.assertTrue(s.delete_superseded_exchange(self.sid, "I led the migration to Kubernetes"))


if __name__ == "__main__":
    unittest.main()
