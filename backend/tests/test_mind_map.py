"""A highlighted passage becomes a mind map: kept to shape, only real pages, named for the assistant."""
from backend.tests import _env  # noqa: F401
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

from fastapi import HTTPException  # noqa: E402

from backend import reading  # noqa: E402
from backend.core import providers  # noqa: E402


class CleanMindMapTest(unittest.TestCase):
    def test_keeps_the_shape_and_drops_pages_that_were_not_sent(self):
        raw = {
            "center": "  Stuttering   triggers ",
            "branches": [
                {"label": "Stress", "note": "Makes it worse.", "pages": [1, 9, "2"],
                 "children": [{"label": "Phone calls", "note": "A common one.", "pages": [1], "children": [{"label": "too deep"}]}]},
                {"label": "", "note": "no label, dropped"},
                "not a node",
                {"label": "Anxiety", "pages": []},
            ] + [{"label": f"Extra {i}"} for i in range(10)],
        }
        out = reading.clean_mind_map(raw, {1})
        self.assertEqual(out["center"], "Stuttering triggers")
        self.assertLessEqual(len(out["branches"]), 6)
        first = out["branches"][0]
        self.assertEqual(first["pages"], [1])
        self.assertEqual(first["children"][0]["label"], "Phone calls")
        self.assertNotIn("children", first["children"][0])  # leaves stop at two levels
        self.assertEqual(out["branches"][1]["label"], "Anxiety")

    def test_rubbish_gives_an_empty_map(self):
        self.assertEqual(reading.clean_mind_map("nope", set()), {"center": "", "branches": []})


class MindMapCallTest(unittest.IsolatedAsyncioTestCase):
    async def test_named_mind_map_for_the_assistant_and_given_time(self):
        seen = []

        async def fake_ask(model, system, message, doc, fallback_credits=False, kind=None):
            seen.append((kind, message))
            return {"center": "Idea", "branches": [{"label": "A"}, {"label": "B"}]}

        with mock.patch.object(reading, "_ask", side_effect=fake_ask):
            out = await reading.mind_map("Stress can make stuttering worse but does not cause it.")
        self.assertEqual(seen[0][0], "mind_map")
        self.assertTrue(seen[0][1].startswith("PASSAGE\nStress"))
        self.assertEqual([b["label"] for b in out["branches"]], ["A", "B"])
        self.assertGreaterEqual(providers.relay_wait_seconds("mind_map"), 120.0)

    async def test_a_thin_answer_is_an_error_not_an_empty_map(self):
        async def fake_ask(*a, **k):
            return {"center": "Idea", "branches": [{"label": "Only one"}]}

        with mock.patch.object(reading, "_ask", side_effect=fake_ask):
            with self.assertRaises(HTTPException):
                await reading.mind_map("A passage worth mapping.")

    async def test_nothing_selected(self):
        with self.assertRaises(HTTPException):
            await reading.mind_map("  ")


if __name__ == "__main__":
    unittest.main()
