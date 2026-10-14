"""Roadmap 2.2: "Explain a topic" from any Library file, with the file as the answer key."""
import asyncio
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend import document_store as docs  # noqa: E402
from backend import transfer  # noqa: E402
from backend.routers import drills  # noqa: E402

SLIDES = "Lecture 4: Photosynthesis. Light reactions make ATP and NADPH in the thylakoid; the Calvin cycle fixes CO2 in the stroma."


class DrillFilesTest(unittest.TestCase):
    def setUp(self):
        drills._ensure_table()
        with sess._connect() as conn:
            conn.execute("DELETE FROM documents")
            conn.execute("DELETE FROM drills")
        self.doc = docs.create_document(name="Bio lecture 4", original_filename="l4.txt", mime="text/plain", content=SLIDES.encode())
        with sess._connect() as conn:
            conn.execute("UPDATE documents SET extracted_text = ? WHERE id = ?", (SLIDES, self.doc))
        self.prompts: list[str] = []

    def model(self, reply: dict):
        async def fake(model, system_prompt, message):
            self.prompts.append(system_prompt)
            return reply
        return mock.patch.object(drills, "_ask_model", fake)

    def test_topics_come_from_the_file(self):
        with self.model({"topics": [{"title": "Calvin cycle", "why": "Central to the lecture"}]}):
            out = asyncio.run(drills.suggest_topics(drills.TopicsBody(document_id=self.doc)))
        self.assertEqual(out["source"], "Bio lecture 4")
        self.assertEqual(out["topics"][0]["title"], "Calvin cycle")
        self.assertIn("Calvin cycle fixes CO2", self.prompts[0])
        self.assertIn("Every topic must come from the file", self.prompts[0])

    def test_an_unreadable_file_is_a_clear_error(self):
        with self.model({"topics": []}):
            with self.assertRaises(drills.HTTPException) as err:
                asyncio.run(drills.suggest_topics(drills.TopicsBody(document_id=12345)))
        self.assertEqual(err.exception.detail["title"], "Couldn't read that file")

    def test_the_file_is_the_answer_key_and_the_drill_remembers_it(self):
        with self.model({"question": "What does the Calvin cycle do?"}):
            first = asyncio.run(drills.drill_turn(drills.TurnBody(topic="Calvin cycle", document_id=self.doc)))
        self.assertEqual(first["question"], "What does the Calvin cycle do?")
        self.assertIn("answer key", self.prompts[-1])
        self.assertIn("Light reactions make ATP", self.prompts[-1])

        done = {"understanding": 85, "feedback": "Clear.", "gaps": [], "next_question": None, "done": True,
                "model_explanation": "It fixes carbon dioxide into sugars in the stroma."}
        with self.model(done):
            asyncio.run(drills.drill_turn(drills.TurnBody(
                topic="Calvin cycle", document_id=self.doc, answer="It fixes CO2 into sugar.",
                history=[drills.Exchange(role="coach", text="What does the Calvin cycle do?")])))
        self.assertIn("the source material,", self.prompts[-1])
        past = drills.drill_history()[0]
        self.assertEqual((past["topic"], past["document_id"], past["source"]), ("Calvin cycle", self.doc, "Bio lecture 4"))

    def test_cv_drills_are_unchanged(self):
        with self.model({"question": "Explain REST."}):
            asyncio.run(drills.drill_turn(drills.TurnBody(topic="REST")))
        self.assertNotIn("answer key", self.prompts[-1])
        self.assertIn("something they claim on their CV", self.prompts[-1])

    def test_exports_leave_local_file_and_people_links_behind(self):
        cleaned = transfer._clean({"id": 1, "topic": "x", "document_id": 3, "source": "Bio", "people_json": "[1]", "documents_json": "[2]"})
        self.assertEqual(cleaned, {"topic": "x", "source": "Bio"})


if __name__ == "__main__":
    unittest.main()
