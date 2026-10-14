"""Roadmap 2.4: new student and work scenarios, for practice and the live coach."""
import unittest

from backend.scenarios import SCENARIOS, get_scenario, scenario_from_tags
from backend.core.templates import TEMPLATES, render_prompt

NEW = {"admission": "admission-interview", "internship": "graduate-interview", "group": "group-discussion",
       "review": "performance-review", "promotion": "promotion-ask", "feedback": "giving-feedback",
       "one_on_one": "one-on-one", "support": "customer-call"}


class ScenarioTest(unittest.TestCase):
    def test_each_new_scenario_is_complete(self):
        for sid in NEW:
            s = SCENARIOS[sid]
            for key in ("label", "counterpart", "event", "subject_default", "setting", "questions", "judge"):
                self.assertTrue(s[key], f"{sid}.{key}")
            self.assertIn("{subject}", s["setting"])

    def test_the_research_panel_scenarios_are_complete(self):
        for sid in ("supervisor", "journal_club", "proposal", "reviewer", "audience", "committee", "professor"):
            s = SCENARIOS[sid]
            for key in ("label", "counterpart", "event", "subject_default", "setting", "questions", "judge"):
                self.assertTrue(s[key], f"{sid}.{key}")
            self.assertIn("{subject}", s["setting"])
        self.assertEqual(scenario_from_tags("mock,interview,reviewer")[0], "reviewer")

    def test_saved_practice_sessions_find_their_scenario_again(self):
        self.assertEqual(scenario_from_tags("mock,voice,one_on_one")[0], "one_on_one")
        self.assertEqual(get_scenario("admission")[1]["counterpart"], "admissions tutor")

    def test_each_new_live_template_renders_for_the_user(self):
        for tid in NEW.values():
            prompt = render_prompt(tid, {"name": "Ama"})
            self.assertIn("Ama", prompt)
            self.assertIn("SAY:", prompt)
            self.assertNotIn("{", prompt.replace("{}", ""))  # no unfilled placeholders
            self.assertTrue(TEMPLATES[tid]["label"])


if __name__ == "__main__":
    unittest.main()
