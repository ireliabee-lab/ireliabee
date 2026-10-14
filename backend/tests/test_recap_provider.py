"""
A recap is written by a provider that answers, and gives up in minutes.

Found after a Riverside visit-day call (session 27): the coach answered with
Claude, the session's choice, but the recap went to the Settings model,
DeepSeek, which the network could not reach. The SDK's ten-minute timeout and
two retries held the recap for about 18 minutes before a 502.
"""
import asyncio
import os
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import costs, providers  # noqa: E402
from backend.core import sessions as sess  # noqa: E402
from backend import meeting_notes  # noqa: E402
from backend.routers import mock as mock_router  # noqa: E402


class ApiConnectionError(Exception):
    """Named like the SDK's, which is what _unreachable looks at."""


ApiConnectionError.__name__ = "APIConnectionError"


class RecapModelTest(unittest.TestCase):
    def test_the_recap_uses_the_model_that_answered_during_the_session(self):
        sid = sess.create_session(title="Call", mode="work-meeting", llm_model="deepseek-chat")
        costs.record("coach", "anthropic", "claude-sonnet-4-6", session_id=sid, in_tokens=10, out_tokens=10)
        self.assertEqual(meeting_notes.answered_with(sid), "claude-sonnet-4-6")

    def test_a_session_with_no_coach_answers_leaves_the_choice_to_settings(self):
        sid = sess.create_session(title="Quiet", mode="work-meeting")
        self.assertIsNone(meeting_notes.answered_with(sid))


class FallbackTest(unittest.TestCase):
    def run_ask(self, first_error):
        calls = []

        def respond(provider, model, *_args, **_kw):
            calls.append(provider)
            if len(calls) == 1:
                raise first_error
            return '{"ok": true}'

        def resolve(model):
            return (model or "deepseek-chat", "anthropic" if (model or "").startswith("claude") else "deepseek")

        with mock.patch.object(mock_router, "respond", respond), \
             mock.patch.object(mock_router, "resolve_llm", resolve):
            return calls, asyncio.run(mock_router._ask_model("deepseek-chat", "sys", "msg"))

    def test_an_unreachable_provider_hands_the_report_to_another(self):
        calls, data = self.run_ask(ApiConnectionError("Connection error."))
        self.assertEqual(calls, ["deepseek", "anthropic"])
        self.assertEqual(data, {"ok": True})

    def test_a_real_refusal_is_not_retried_elsewhere(self):
        with self.assertRaises(Exception):
            self.run_ask(PermissionError("invalid api key"))


class LimitsTest(unittest.TestCase):
    def test_clients_give_up_in_minutes_not_half_an_hour(self):
        import anthropic
        limits = providers._sdk_limits(anthropic)   # as the Claude client is given them
        self.assertEqual(limits["max_retries"], 1)
        self.assertLessEqual(limits["timeout"].read, 120)
        self.assertLessEqual(limits["timeout"].connect, 10)


if __name__ == "__main__":
    unittest.main()
