"""
The two things that decide whether a hosted session makes money: prompt
caching, and a context window that does not grow without limit.

Both are invisible when they break. The answers stay correct and only the bill
changes, which is why the arithmetic is pinned down here.
"""
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import context, costs, prompt_cache  # noqa: E402


def exchanges(n: int, words: int = 60) -> list[dict]:
    """A conversation of `n` exchanges, roughly `words` words per message."""
    body = " ".join(["word"] * words)
    out = []
    for i in range(n):
        out.append({"role": "user", "content": f"Q{i}: {body}"})
        out.append({"role": "assistant", "content": f"A{i}: {body}"})
    return out


class TokenEstimateTest(unittest.TestCase):
    def test_the_estimate_is_in_the_right_region(self):
        # ~4 chars per token in English; we use 3.6 to err high.
        text = "word " * 100          # 500 chars
        self.assertGreater(context.estimate_tokens(text), 100)
        self.assertLess(context.estimate_tokens(text), 200)

    def test_it_errs_high_rather_than_low(self):
        # Trimming sooner is the cheap mistake; trimming later is the expensive
        # one. The estimate must never be under the 4-chars-per-token rule.
        text = "a" * 4000
        self.assertGreaterEqual(context.estimate_tokens(text), 1000)

    def test_empty_costs_nothing(self):
        self.assertEqual(context.estimate_tokens(""), 0)
        self.assertEqual(context.messages_tokens([]), 0)


class TrimTest(unittest.TestCase):
    def test_a_short_conversation_is_left_alone(self):
        history = exchanges(2)
        self.assertEqual(context.trim_history(history), history)

    def test_a_long_conversation_is_capped(self):
        history = exchanges(60)                      # 120 messages
        trimmed = context.trim_history(history, max_tokens=1000)
        self.assertLess(context.messages_tokens(trimmed), 1400)
        self.assertLess(len(trimmed), len(history))

    def test_growth_stops_being_quadratic(self):
        """The point of the whole exercise: doubling the call must not
        quadruple the prompt."""
        short = context.messages_tokens(context.trim_history(exchanges(20)))
        long = context.messages_tokens(context.trim_history(exchanges(80)))
        self.assertLess(long, short * 1.5,
                        "a four-times-longer call should cost about the same per turn")

    def test_the_most_recent_exchanges_survive(self):
        history = exchanges(60)
        trimmed = context.trim_history(history, max_tokens=800)
        self.assertEqual(trimmed[-1], history[-1])
        self.assertEqual(trimmed[-2], history[-2])

    def test_what_was_dropped_is_declared(self):
        trimmed = context.trim_history(exchanges(60), max_tokens=800)
        self.assertIn("left out", trimmed[0]["content"],
                      "a model told about the gap behaves better than one left to guess")

    def test_the_callers_history_is_not_modified(self):
        history = exchanges(60)
        before = len(history)
        context.trim_history(history, max_tokens=500)
        self.assertEqual(len(history), before, "the full record still gets saved")

    def test_one_enormous_message_cannot_empty_the_conversation(self):
        history = exchanges(4)
        history[0]["content"] = "x" * 500_000
        trimmed = context.trim_history(history, max_tokens=100)
        self.assertGreaterEqual(len(trimmed), context.MIN_MESSAGES)

    def test_no_history_is_survivable(self):
        self.assertEqual(context.trim_history([]), [])
        self.assertEqual(context.trim_history(None), [])


class CacheTest(unittest.TestCase):
    def test_a_big_prompt_is_marked_for_caching(self):
        big = "word " * 4000
        system = prompt_cache.anthropic_system(big)
        self.assertIsInstance(system, list)
        self.assertEqual(system[0]["cache_control"], {"type": "ephemeral"})
        self.assertEqual(system[0]["text"], big)

    def test_a_small_prompt_is_marked_too(self):
        # Below a model's minimum Anthropic ignores the marker and charges no
        # write premium, so marking costs nothing; not marking cost every
        # Sonnet prompt between 1024 and 2048 tokens its cache.
        small = "You are a helpful coach."
        system = prompt_cache.anthropic_system(small)
        self.assertEqual(system[0]["cache_control"], {"type": "ephemeral"})

    def test_haiku_needs_4096_tokens(self):
        # The old code said 2048 "for Haiku"; Anthropic's docs say 4096.
        self.assertEqual(prompt_cache.MIN_CACHEABLE_TOKENS["claude-haiku-4-5"], 4096)

    def test_the_conversation_cache_is_a_request_level_marker(self):
        self.assertEqual(prompt_cache.conversation_cache(),
                         {"extra_body": {"cache_control": {"type": "ephemeral"}}})

    def test_an_empty_prompt_is_survivable(self):
        self.assertEqual(prompt_cache.anthropic_system(""), "")

    def test_anthropic_cache_counts_are_read(self):
        usage = mock.Mock(spec=["cache_read_input_tokens", "cache_creation_input_tokens"])
        usage.cache_read_input_tokens, usage.cache_creation_input_tokens = 5000, 0
        self.assertEqual(prompt_cache.cache_stats(usage), (5000, 0))

    def test_openai_cache_counts_are_read(self):
        details = mock.Mock(spec=["cached_tokens"])
        details.cached_tokens = 3000
        usage = mock.Mock(spec=["prompt_tokens_details"])
        usage.prompt_tokens_details = details
        self.assertEqual(prompt_cache.cache_stats(usage), (3000, 0))

    def test_a_provider_that_reports_no_cache_returns_zero(self):
        self.assertEqual(prompt_cache.cache_stats(None), (0, 0))
        self.assertEqual(prompt_cache.cache_stats(mock.Mock(spec=[])), (0, 0))


class SavingTest(unittest.TestCase):
    """The arithmetic that justifies the work."""

    def setUp(self):
        with costs._connect() as conn:
            conn.execute("DELETE FROM ai_costs")

    def test_a_cached_turn_costs_a_fraction_of_an_uncached_one(self):
        model = "claude-haiku-4-5"                 # $1 / $5 per M
        uncached = costs.token_cost(model, 20_000, 300)
        cached = costs.token_cost(model, 0, 300, cache_read=20_000)
        self.assertLess(cached, uncached * 0.35)

    def test_a_cache_write_costs_a_little_more_than_normal_input(self):
        model = "claude-haiku-4-5"
        normal = costs.token_cost(model, 20_000, 0)
        write = costs.token_cost(model, 0, 0, cache_write=20_000)
        self.assertAlmostEqual(write, normal * 1.25, places=6)

    def test_a_whole_session_is_much_cheaper_cached(self):
        """15 turns, a 5,000-token system prompt: the shape of a real call."""
        model = "claude-haiku-4-5"
        system, reply = 5_000, 300

        naive = sum(costs.token_cost(model, system + turn * 400, reply)
                    for turn in range(15))

        # Cached: the system prompt is written once and read after that, and
        # history is capped rather than growing with the call.
        optimised = costs.token_cost(model, 400, reply, cache_write=system)
        optimised += sum(costs.token_cost(model, 800, reply, cache_read=system)
                         for _ in range(14))

        saved = 1 - optimised / naive
        self.assertGreater(saved, 0.60, f"only saved {saved:.0%}")

    def test_the_saving_is_visible_in_the_report(self):
        # If cached tokens were counted as ordinary input, the bill would look
        # unchanged and nobody would know the cache was working.
        costs.record("coach", "anthropic", "claude-haiku-4-5",
                     in_tokens=400, out_tokens=300, cache_read=20_000, session_id=5)
        out = costs.for_session(5)
        self.assertEqual(out["items"][0]["cache_read_tokens"], 20_000)
        self.assertLess(out["cost_usd"], 0.01)


if __name__ == "__main__":
    unittest.main()
