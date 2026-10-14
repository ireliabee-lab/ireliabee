"""Roadmap 2.6: people research — search angles, reading, the brief, and the plan link."""
import json
import os
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend.core import web_search as ws  # noqa: E402
from backend.core import meeting_plans as plans  # noqa: E402
from backend import people  # noqa: E402

BRIEF = {
    "identity": {"summary": "Head of Data at Acme [1]", "confidence": "high", "note": "Matched by organisation."},
    "snapshot": ["Joined Acme in 2023 [1]"],
    "cares_about": ["Data quality [2]"],
    "style": "Direct and numbers-first [2]",
    "common_ground": ["Your pipeline-monitoring project"],
    "win_them_over": ["Lead with measurable results"],
    "openers": ["I enjoyed your talk on data contracts."],
    "they_may_ask": [{"question": "How do you test pipelines?", "answer": "Contract tests, as at X."}],
    "objections": [{"concern": "Little finance experience", "response": "Point to the billing project."}],
    "watch_outs": ["Don't oversell ML"],
    "gaps": [],
}


class PeopleResearchTest(unittest.TestCase):
    def setUp(self):
        with sess._connect() as conn:
            conn.execute("DELETE FROM people")
            conn.execute("DELETE FROM meeting_plans")
        self.person = people.create_person({
            "name": "Ada Mensah", "organisation": "Acme", "role": "Head of Data",
            "links": ["adamensah.dev", "https://www.linkedin.com/in/ada", "  "], "purpose": "Final interview",
        })

    def test_links_are_normalised_and_deduplicated(self):
        self.assertEqual(self.person["links"], ["https://adamensah.dev", "https://www.linkedin.com/in/ada"])
        self.assertEqual(people.clean_links(["a.com", "https://a.com", "a.com"]), ["https://a.com"])

    def test_search_angles_quote_the_name_and_cover_the_organisation(self):
        qs = people.search_queries(self.person)
        self.assertTrue(all('"Ada Mensah"' in q for q in qs[:3]))
        self.assertTrue(any("interview OR podcast" in q for q in qs))
        self.assertTrue(any(q.startswith("Acme news") for q in qs))

    def test_web_search_only_runs_with_a_key(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TAVILY_API_KEY", None)
            os.environ.pop("BRAVE_SEARCH_API_KEY", None)
            self.assertIsNone(ws.search_engine())
            self.assertEqual(ws.web_search("anything"), ([], None))
        with mock.patch.dict(os.environ, {"BRAVE_SEARCH_API_KEY": "k"}):
            self.assertEqual(ws.search_engine(), "brave")

    def test_reading_skips_private_and_sign_in_networks(self):
        findings = [
            {"source": "web", "url": "https://twitter.com/ada", "title": "", "snippet": ""},
            {"source": "web", "url": "https://acme.com/blog/data", "title": "", "snippet": ""},
            {"source": "papers", "url": "https://papers.org/1", "title": "", "snippet": ""},
        ]
        urls = people.pages_to_read(self.person, findings)
        self.assertEqual(urls, ["https://adamensah.dev", "https://acme.com/blog/data"])

    def test_html_to_text_drops_scripts_and_keeps_paragraphs(self):
        text = ws.html_to_text("<script>x()</script><nav>menu</nav><p>Hello</p><p>World &amp; more</p>")
        self.assertEqual(text.split(), ["Hello", "World", "&", "more"])

    def test_sources_are_numbered_with_read_pages_first(self):
        findings = [{"source": "wikipedia", "title": "Acme", "url": "https://w.org/Acme", "snippet": "A company"}]
        pages = [{"url": "https://adamensah.dev", "text": "Ada writes about data contracts."}]
        msg, sources = people.brief_message(self.person, findings, pages, "Name: Kofi")
        self.assertEqual([s["n"] for s in sources], [1, 2])
        self.assertEqual(sources[0]["url"], "https://adamensah.dev")
        self.assertIn("[1] (link; reliability: official", msg)
        self.assertEqual(sources[0]["text"], "Ada writes about data contracts.")  # kept for the fact-check
        self.assertIn("Ada writes about data contracts.", msg)
        self.assertIn("Name: Kofi", msg)  # the user's profile, for common ground
        self.assertIn("Final interview", msg)

    def test_prompt_limits_research_to_public_professional_information(self):
        for word in ("home address", "family", "health", "politics", "religion", "private social media"):
            self.assertIn(word, people.BRIEF_PROMPT)

    def test_full_run_stores_the_brief_and_feeds_linked_plans(self):
        found = [{"source": "web", "title": "Ada at Acme", "url": "https://acme.com/team/ada", "snippet": "Head of Data"}]
        with mock.patch.object(people, "gather", return_value=(found, ["Wikipedia lookup failed: offline"])), \
             mock.patch.object(people, "read_pages", return_value=([{"url": "https://adamensah.dev", "text": "Ada's site"}], [])), \
             mock.patch.object(people, "_user_context", return_value="Name: Kofi"), \
             mock.patch.object(people, "_write", return_value=json.loads(json.dumps(BRIEF))), \
             mock.patch.object(people, "_ask", return_value={"verdicts": [
                 {"id": 1, "verdict": "supported"}, {"id": 2, "verdict": "partly"},
                 {"id": 3, "verdict": "supported"}, {"id": 4, "verdict": "unsupported"}]}) as check:
            people.run_research(self.person["id"])

        done = people.get_person(self.person["id"])
        self.assertEqual(done["status"], "done")
        brief = done["brief"]
        self.assertEqual(brief["sources"][0]["url"], "https://adamensah.dev")  # user link is source 1
        self.assertEqual(brief["sources"][0]["tier"], "official")
        self.assertEqual(brief["sources"][1]["tier"], "official")  # acme.com for someone at Acme
        self.assertNotIn("text", brief["sources"][0])  # page text isn't stored with the brief
        self.assertEqual(brief["problems"], ["Wikipedia lookup failed: offline"])
        self.assertIsNotNone(done["researched_at"])
        # The fact-check saw the cited source text, dropped the unsupported claim and flagged the partial one.
        self.assertIn("Ada's site", check.call_args.args[1])
        self.assertEqual(brief["cares_about"], [])
        self.assertEqual(brief["unconfirmed"], ["Direct and numbers-first [2]"])
        self.assertEqual(brief["verification"], {"ran": True, "checked": 4, "removed": 1, "unconfirmed": 1, "bad_citations": 0})

        plan_id = plans.create_plan("Acme final", people_ids=[done["id"]])
        prompt = plans.render_plan_for_prompt(plans.get_plan(plan_id))
        self.assertIn("WHO YOU'RE MEETING", prompt)
        self.assertIn("Head of Data at Acme", prompt)
        self.assertNotIn("[1]", prompt)  # citation markers are for the screen, not the coach
        self.assertIn("Style: Direct and numbers-first (unconfirmed)", prompt)
        self.assertIn("facts checked against sources", prompt)

        # The live coach gets the brief plus how to use it.
        block = people.coach_block([done["id"]])
        self.assertIn("WHO YOU'RE MEETING", block)
        self.assertIn("Use ONLY facts written here", block)
        self.assertIn("Head of Data at Acme", block)
        self.assertEqual(people.coach_block([12345]), "")
        self.assertIn("How do you test pipelines? → Contract tests", prompt)

    def test_source_tiers(self):
        tier = people.source_tier
        self.assertEqual(tier("https://anything.io", "link"), "official")
        self.assertEqual(tier("https://careers.acme.co.uk/team", "web", "Acme Payments"), "official")
        self.assertEqual(tier("https://blog.google/news", "web", "Google DeepMind"), "official")
        self.assertEqual(tier("https://www.cs.ox.ac.uk/people/ada", "web", "Oxford"), "official")
        self.assertEqual(tier("https://en.wikipedia.org/wiki/Ada", "wikipedia"), "reference")
        self.assertEqual(tier("https://www.reuters.com/tech/x", "web", "Acme"), "news")
        self.assertEqual(tier("https://github.com/ada", "github"), "record")
        self.assertEqual(tier("https://some-blog.medium.com/p", "web", "Acme"), "secondary")
        self.assertEqual(tier("https://news.ycombinator.com/item?id=1", "hacker-news", "Acme"), "secondary")

    def test_citations_to_missing_sources_are_removed(self):
        cleaned, removed = people.clean_citations({"snapshot": ["Joined in 2023 [1][9]"], "identity": {"summary": "CTO [0]"},
                                                   "sources": [{"n": 1}]}, 1)
        self.assertEqual(cleaned["snapshot"], ["Joined in 2023 [1]"])
        self.assertEqual(cleaned["identity"]["summary"], "CTO ")
        self.assertEqual(removed, 2)
        self.assertEqual(cleaned["sources"], [{"n": 1}])

    def test_uncited_facts_are_dropped_even_without_a_model(self):
        brief = {"identity": {"summary": "Leads data at Acme", "confidence": "high"},
                 "snapshot": ["Speaks at conferences", "Joined in 2023 [1]"], "cares_about": [], "style": ""}
        with mock.patch.object(people, "_ask", side_effect=RuntimeError("no model")):
            out, problem = people._check(brief, [{"n": 1, "title": "t", "url": "u", "tier": "official", "text": "Joined 2023"}])
        self.assertEqual(out["snapshot"], ["Joined in 2023 [1]"])
        self.assertEqual(out["identity"]["confidence"], "low")  # an uncited summary can't be trusted
        self.assertFalse(out["verification"]["ran"])
        self.assertIn("fact-check", problem)

    def test_a_failed_run_keeps_a_readable_reason(self):
        with mock.patch.object(people, "gather", side_effect=RuntimeError("boom")):
            people.run_research(self.person["id"])
        failed = people.get_person(self.person["id"])
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"]["title"], "Research failed")

    def test_plans_keep_their_people_through_updates(self):
        plan_id = plans.create_plan("Panel")
        plans.update_plan(plan_id, people_ids=[self.person["id"], 99])
        self.assertEqual(plans.get_plan(plan_id)["people_ids"], [self.person["id"], 99])
        # Unknown or unresearched people are simply left out of the coach's prompt.
        self.assertNotIn("WHO YOU'RE MEETING", plans.render_plan_for_prompt(plans.get_plan(plan_id)))


if __name__ == "__main__":
    unittest.main()
