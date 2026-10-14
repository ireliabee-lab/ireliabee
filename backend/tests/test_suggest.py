"""Suggest: AI text for one box of a form — paid, metered, priced first, never identity."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from fastapi.testclient import TestClient  # noqa: E402

from backend.core import hosted, profile_store, providers  # noqa: E402
from backend.core import sessions as sess  # noqa: E402
from backend.errors import FriendlyError  # noqa: E402
from backend.routers import suggest  # noqa: E402

RATES = {"creditsPerUsd": 2.0, "perMillionTokensUsd": {"fast": {"in": 1.0, "out": 5.0}, "careful": {"in": 3.0, "out": 15.0}}}


def fake_message(text, usage=(400, 80)):
    return SimpleNamespace(content=[SimpleNamespace(text=text)],
                           usage=SimpleNamespace(input_tokens=usage[0], output_tokens=usage[1]))


class SuggestTest(unittest.TestCase):
    def setUp(self):
        with sess._connect() as conn:
            conn.execute("DELETE FROM profiles")
        profile_store.create_profile("Oliver Bennett", target_role="Backend engineer",
                                     background="Five years building payment APIs in London",
                                     pronouns="he/him", extra_context="oliver@example.com")
        self.sent = []
        patches = [
            mock.patch.object(hosted, "is_admin", return_value=False),
            mock.patch.object(hosted, "rates", return_value=RATES),
            mock.patch.object(suggest, "resolve_llm", return_value=("claude-haiku-4-5", "anthropic")),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_suggest(self, field, form, reply='{"suggestion": "Show I can own reliable APIs"}', **box):
        def final(**kwargs):
            self.sent.append(kwargs)
            return fake_message(reply)
        with mock.patch.object(providers, "_final_message", side_effect=final):
            return asyncio.run(suggest.suggest(suggest.SuggestBody(field=field, form=form, **box)))

    # ── paid, and named to the service ──────────────────────────────────────

    def test_a_suggestion_goes_through_the_metered_path_named_suggest(self):
        out = self.run_suggest("plan.purpose", {"title": "Acme — Backend Engineer interview", "counterparty": "Acme"})
        self.assertEqual(out["suggestion"], "Show I can own reliable APIs")
        self.assertEqual(len(self.sent), 1)
        # The header the service reads to record the job in the ledger as "call · suggest".
        self.assertEqual(self.sent[0]["extra_headers"], {"x-ireliabee-kind": "suggest"})
        self.assertLessEqual(self.sent[0]["max_tokens"], 200)

    def test_what_it_actually_used_comes_back_in_credits(self):
        out = self.run_suggest("plan.purpose", {"title": "Acme interview"})
        # 400 in at $1/M + 80 out at $5/M = $0.0008, at 2 credits a dollar.
        self.assertEqual(out["cost"]["tokens"], {"input": 400, "output": 80})
        self.assertAlmostEqual(out["cost"]["credits"], 0.002, places=3)

    def test_it_is_recorded_in_the_local_usage_as_a_suggest_job(self):
        from backend.core import costs  # noqa: F401  (creates ai_costs)
        self.run_suggest("plan.purpose", {"title": "Acme interview"})
        with sess._connect() as conn:
            row = conn.execute("SELECT kind, in_tokens, out_tokens FROM ai_costs ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual((row["kind"], row["in_tokens"], row["out_tokens"]), ("suggest", 400, 80))

    def test_other_jobs_are_not_named_to_the_service(self):
        with providers.metering_context("debrief"):
            self.assertEqual(providers._kind_headers(), {})
        with providers.metering_context("suggest"):
            self.assertEqual(providers._kind_headers(), {"x-ireliabee-kind": "suggest"})

    def test_the_admin_on_their_own_keys_sends_no_header(self):
        with mock.patch.object(hosted, "is_admin", return_value=True), providers.metering_context("suggest"):
            self.assertEqual(providers._kind_headers(), {})

    # ── priced first, without spending ───────────────────────────────────────

    def test_the_estimate_makes_no_ai_call(self):
        with mock.patch.object(providers, "_final_message", side_effect=AssertionError("no AI call for a price")):
            est = suggest.estimate(suggest.SuggestBody(field="plan.answers_prep", form={"title": "Acme interview"}))
        self.assertEqual(est["model"], "claude-haiku-4-5")
        self.assertGreater(est["credits"], 0)
        self.assertEqual(est["tokens"]["output"], suggest.TUNED["plan.answers_prep"]["typical_out"])

    def test_the_admin_is_shown_dollars_not_credits(self):
        with mock.patch.object(hosted, "is_admin", return_value=True):
            est = suggest.estimate(suggest.SuggestBody(field="plan.purpose", form={"title": "x"}, model="claude-haiku-4-5"))
        self.assertIsNone(est["credits"])
        self.assertIsNotNone(est["usd"])

    # ── only where there is something to go on ───────────────────────────────

    def test_an_empty_form_and_no_profile_is_refused_before_anything_is_spent(self):
        with sess._connect() as conn:
            conn.execute("DELETE FROM profiles")
        with self.assertRaises(FriendlyError) as e:
            self.run_suggest("plan.purpose", {"purpose": "", "notes": ""})
        self.assertEqual(e.exception.code, "invalid")
        self.assertEqual(self.sent, [])

    def test_what_is_already_in_the_box_itself_is_not_enough_to_go_on(self):
        with sess._connect() as conn:
            conn.execute("DELETE FROM profiles")
        with self.assertRaises(FriendlyError):
            self.run_suggest("story.result", {"result": "we shipped"}, label="Result", length="long")

    def test_any_box_can_ask_described_by_its_label(self):
        out = self.run_suggest("plan.traps_avoid", {"title": "Acme interview"}, label="Traps to avoid", shape="list",
                               reply='{"suggestion": ["Don\'t oversell Kubernetes", "Don\'t skip the question"]}')
        self.assertEqual(len(out["suggestion"]), 2)
        self.assertIn("Traps to avoid", self.sent[0]["system"][0]["text"] if isinstance(self.sent[0]["system"], list)
                      else self.sent[0]["system"])
        self.assertEqual(self.sent[0]["max_tokens"], suggest.SIZES[("list", "short")]["max_tokens"])

    def test_a_long_text_box_gets_more_room_than_a_short_one(self):
        self.run_suggest("story.situation", {"title": "Rescued a project"}, label="Situation", length="long")
        self.run_suggest("story.title", {"situation": "A project two weeks late"}, label="Title")
        self.assertGreater(self.sent[0]["max_tokens"], self.sent[1]["max_tokens"])

    def test_identity_secret_and_payment_boxes_are_never_suggested(self):
        refused = [
            ("profile.name", ""), ("profile.email", ""), ("profile.phone", ""), ("profile.pronouns", ""),
            ("settings.api_key", ""), ("account.password", ""), ("billing.card_number", ""),
            ("licence.licence_key", ""), ("about.contact", "Your email address"), ("x.y", "Full name"),
            ("anything", ""), ("Bad.Field", ""),
        ]
        for field, label in refused:
            with self.assertRaises(FriendlyError, msg=field):
                self.run_suggest(field, {"title": "Acme"}, label=label)
            with self.assertRaises(FriendlyError, msg=field):
                suggest.estimate(suggest.SuggestBody(field=field, label=label, form={"title": "Acme"}))
        self.assertEqual(self.sent, [])

    # ── never identity ───────────────────────────────────────────────────────

    def test_names_emails_phones_and_secrets_on_the_form_are_not_sent(self):
        self.run_suggest("plan.purpose", {"title": "Acme interview", "name": "Oliver Bennett",
                                          "email": "oliver@example.com", "phone": "+44 20 7946 0958",
                                          "api_key": "sk-secret-123", "password": "hunter2",
                                          "notes": "reach me on oliver@example.com or +44 20 7946 0958"})
        message = self.sent[0]["messages"][-1]["content"]
        for secret in ("sk-secret", "hunter2"):
            self.assertNotIn(secret, message)
        message = self.sent[0]["messages"][-1]["content"]
        for secret in ("Oliver", "oliver@example.com", "7946"):
            self.assertNotIn(secret, message)
        self.assertIn("Target role: Backend engineer", message)

    def test_contact_details_in_a_reply_are_taken_out(self):
        out = self.run_suggest("plan.answers_prep", {"title": "Acme interview"},
                               reply='{"suggestion": ["Why Acme? → call me on +44 20 7946 0958", "Tell me about 2019-2023 → the payments rebuild", "Email oliver@example.com"]}')
        joined = " ".join(out["suggestion"])
        self.assertNotIn("7946", joined)
        self.assertNotIn("@", joined)
        self.assertIn("2019-2023", joined, "a year range is not a phone number")

    def test_a_list_box_gets_a_list(self):
        out = self.run_suggest("plan.answers_prep", {"title": "Acme interview"},
                               reply='{"suggestion": ["Tell me about a hard bug → the payments outage", "Why Acme? → their API-first product"]}')
        self.assertEqual(len(out["suggestion"]), 2)


class GuardedTest(unittest.TestCase):
    def test_suggest_is_locked_to_the_app_like_every_route(self):
        from backend.main import app
        c = TestClient(app, base_url="http://127.0.0.1:8000")
        r = c.post("/suggest/", json={"field": "plan.purpose", "form": {"title": "x"}})
        self.assertEqual(r.status_code, 401)
        r = c.post("/suggest/estimate", json={"field": "plan.purpose", "form": {"title": "x"}})
        self.assertEqual(r.status_code, 401)


if __name__ == "__main__":
    unittest.main()
