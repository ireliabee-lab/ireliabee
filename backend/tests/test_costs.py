"""
Per-call cost accounting (docs/hosted-pivot.md, step 1).

The thing that matters here is that an unpriced model never reports as free.
Every credit price will be derived from these numbers, and a silent zero would
understate a session's cost in exactly the direction that loses money.
"""
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import costs  # noqa: E402
from backend.core import providers  # noqa: E402


class CostTestCase(unittest.TestCase):
    def setUp(self):
        with costs._connect() as conn:
            conn.execute("DELETE FROM ai_costs")


class PricingTest(CostTestCase):
    def test_tokens_cost_what_the_price_table_says(self):
        # 1M in + 1M out of a $3/$15 model.
        self.assertAlmostEqual(costs.token_cost("claude-sonnet-4-6", 1_000_000, 1_000_000), 18.0)
        self.assertAlmostEqual(costs.token_cost("claude-sonnet-4-6", 1_000, 500), 0.0105)

    def test_an_unpriced_model_costs_None_not_zero(self):
        self.assertIsNone(costs.token_cost("some-model-we-have-not-priced", 1_000_000, 1_000_000))

    def test_audio_is_priced_by_the_minute(self):
        self.assertAlmostEqual(costs.audio_cost("deepgram", 60), 0.0077)
        self.assertAlmostEqual(costs.audio_cost("deepgram", 1800), 0.231)
        self.assertIsNone(costs.audio_cost("some-unknown-provider", 1800))


class RecordingTest(CostTestCase):
    def test_a_call_is_recorded_with_its_cost(self):
        costs.record("coach", "anthropic", "claude-haiku-4-5",
                     in_tokens=10_000, out_tokens=2_000, session_id=7)
        out = costs.for_session(7)
        self.assertEqual(out["items"][0]["calls"], 1)
        self.assertAlmostEqual(out["cost_usd"], 0.02)      # 10k*$1 + 2k*$5 per M
        self.assertEqual(out["unpriced_calls"], 0)

    def test_an_unpriced_call_is_counted_but_not_costed(self):
        costs.record("coach", "anthropic", "brand-new-model", in_tokens=999, out_tokens=999)
        summary = costs.summary()
        self.assertEqual(summary["calls"], 1)
        self.assertEqual(summary["cost_usd"], 0)
        self.assertEqual(summary["unpriced_calls"], 1,
                         "an unpriced call must be visible, or the total silently lies")

    def test_recording_never_raises(self):
        # Measurement must not be able to break the session it measures.
        with mock.patch.object(costs, "_connect", side_effect=RuntimeError("db gone")):
            costs.record("coach", "anthropic", "claude-haiku-4-5", in_tokens=1)

    def test_cost_per_session_is_the_number_a_credit_must_cover(self):
        for session in (1, 2):
            costs.record("stt", "deepgram", "nova", seconds=1800, session_id=session)
            costs.record("coach", "anthropic", "claude-haiku-4-5",
                         in_tokens=50_000, out_tokens=5_000, session_id=session)
        summary = costs.summary()
        self.assertEqual(summary["sessions"], 2)
        # (0.231 stt + 0.075 model) per session
        self.assertAlmostEqual(summary["cost_per_session_usd"], 0.306, places=3)


class UsageShapeTest(unittest.TestCase):
    """Each provider reports tokens under different names; all three must read."""

    def test_anthropic(self):
        usage = mock.Mock(spec=["input_tokens", "output_tokens"])
        usage.input_tokens, usage.output_tokens = 120, 30
        self.assertEqual(providers._usage_counts(usage), (120, 30))

    def test_openai_and_deepseek(self):
        usage = mock.Mock(spec=["prompt_tokens", "completion_tokens"])
        usage.prompt_tokens, usage.completion_tokens = 200, 40
        self.assertEqual(providers._usage_counts(usage), (200, 40))

    def test_gemini(self):
        usage = mock.Mock(spec=["prompt_token_count", "candidates_token_count"])
        usage.prompt_token_count, usage.candidates_token_count = 300, 60
        self.assertEqual(providers._usage_counts(usage), (300, 60))

    def test_a_provider_that_reports_nothing_is_survivable(self):
        self.assertEqual(providers._usage_counts(None), (0, 0))
        self.assertEqual(providers._usage_counts(mock.Mock(spec=[])), (0, 0))


class ContextTest(CostTestCase):
    def test_calls_are_tagged_with_what_they_were_for(self):
        with providers.metering_context("debrief", 42):
            usage = mock.Mock(spec=["input_tokens", "output_tokens"])
            usage.input_tokens, usage.output_tokens = 1_000, 100
            providers._meter("anthropic", "claude-haiku-4-5", usage)
        out = costs.for_session(42)
        self.assertEqual(out["items"][0]["kind"], "debrief")

    def test_an_untagged_call_still_gets_counted(self):
        usage = mock.Mock(spec=["input_tokens", "output_tokens"])
        usage.input_tokens, usage.output_tokens = 1_000, 100
        providers._meter("anthropic", "claude-haiku-4-5", usage)
        self.assertEqual(costs.summary()["calls"], 1)

    def test_the_context_is_restored_afterwards(self):
        with providers.metering_context("outer", 1):
            with providers.metering_context("inner", 2):
                pass
            self.assertEqual(providers._context.value, ("outer", 1))


if __name__ == "__main__":
    unittest.main()
