"""Roadmap 2.5: Library files attached to a plan feed the live coach and practice."""
import asyncio
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend.core import meeting_plans as plans  # noqa: E402
from backend import document_store as docs  # noqa: E402
from backend.routers import mock as mock_router  # noqa: E402


def _doc(name: str, text: str) -> int:
    did = docs.create_document(name=name, original_filename=f"{name}.txt", mime="text/plain", content=text.encode())
    with sess._connect() as conn:  # extraction runs on upload; set the text directly for the test
        conn.execute("UPDATE documents SET extracted_text = ? WHERE id = ?", (text, did))
    return did


class PlanFilesTest(unittest.TestCase):
    def setUp(self):
        with sess._connect() as conn:
            conn.execute("DELETE FROM documents")
            conn.execute("DELETE FROM meeting_plans")
        self.spec = _doc("Job spec", "Must know Kafka and data contracts.")
        self.notes = _doc("My notes", "Mention the billing migration.")

    def test_plans_keep_their_files(self):
        pid = plans.create_plan("Acme final", document_ids=[self.spec])
        self.assertEqual(plans.get_plan(pid)["document_ids"], [self.spec])
        plans.update_plan(pid, document_ids=[self.spec, self.notes])
        self.assertEqual(plans.get_plan(pid)["document_ids"], [self.spec, self.notes])

    def test_context_names_each_file_and_skips_unknown_ones(self):
        text = docs.documents_context([self.spec, 999, self.spec, self.notes])
        self.assertEqual(text.count("REFERENCE FILE:"), 2)  # duplicate and unknown ids skipped
        self.assertIn("REFERENCE FILE: Job spec\nMust know Kafka", text)
        self.assertLess(text.index("Job spec"), text.index("My notes"))  # kept in the order given
        self.assertEqual(docs.documents_context([]), "")

    def test_budget_is_shared_so_one_long_file_cannot_crowd_out_the_rest(self):
        long_doc = _doc("Long deck", "x" * 50_000)
        text = docs.documents_context([long_doc, self.spec], budget=1000)
        self.assertIn("Must know Kafka and data contracts.", text)  # the short file survives whole
        self.assertIn("trimmed to fit", text)
        self.assertLess(len(text), 1200)

    def test_practice_questions_draw_on_the_plans_files(self):
        pid = plans.create_plan("Acme final", document_ids=[self.spec])
        seen = {}

        async def fake_model(model, system_prompt, message):
            seen["prompt"] = system_prompt
            return {"questions": [{"question": "How would you use Kafka here?", "type": "technical", "looking_for": "x"}]}

        body = mock_router.StartBody(plan_id=pid, document_ids=[self.notes], count=1)
        with mock.patch.object(mock_router, "_ask_model", fake_model), \
             mock.patch.object(mock_router, "resolve_llm", return_value=("m", "p")):
            out = asyncio.run(mock_router.start_mock(body))
        self.assertTrue(out["used_files"])
        self.assertIn("Must know Kafka", seen["prompt"])            # from the plan
        self.assertIn("Mention the billing migration", seen["prompt"])  # picked directly

    def test_voice_interviewer_prompt_includes_files(self):
        files = mock_router._files_block([self.spec], "base your questions on these")
        from backend.scenarios import get_scenario
        _, scenario = get_scenario("job")
        prompt = mock_router._interviewer_prompt("Hannah", "Data engineer", "mixed", 3, {}, "ctx", "", scenario, files)
        self.assertIn("Must know Kafka", prompt)


if __name__ == "__main__":
    unittest.main()
