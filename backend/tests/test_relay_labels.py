"""The user's own assistant gets each task's real name and enough time for it."""
from backend.tests import _env  # noqa: F401
import asyncio  # noqa: E402
import unittest  # noqa: E402
from unittest import mock  # noqa: E402

from backend import reading  # noqa: E402
from backend.core import providers  # noqa: E402


class RelayTimeTest(unittest.TestCase):
    def test_live_answers_cannot_wait_but_notebook_steps_can(self):
        self.assertEqual(providers.relay_wait_seconds("live_turn"), 60.0)
        self.assertGreaterEqual(providers.relay_wait_seconds("explain"), 120.0)
        # A notebook step reads ~20,000 characters and writes a long answer.
        self.assertGreaterEqual(providers.relay_wait_seconds("notebook_points"), 300.0)
        self.assertGreaterEqual(providers.relay_wait_seconds(None), 300.0)


class RelayLabelTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_notebook_step_is_named_for_the_assistant_while_billing_stays_reading(self):
        seen = []

        def fake_respond(provider, model, text, history, system, max_tokens):
            seen.append((getattr(providers._context, "relay_task", None), getattr(providers._context, "value", None)))
            return '{"points": []}'

        with mock.patch("backend.routers.mock.respond", side_effect=fake_respond), \
             mock.patch("backend.routers.mock.resolve_llm", return_value=("m", "anthropic")):
            await reading._ask(None, "system", "PAGES 1", 1, kind="notebook_points")
        self.assertEqual(seen[0][0], "notebook_points")
        self.assertEqual(seen[0][1][0], "reading")

    async def test_an_explain_running_beside_a_notebook_build_does_not_rename_it(self):
        """Explain sets its billing kind on the event loop; a concurrent job must not inherit it."""
        seen = []
        explain_started = asyncio.Event()
        release = asyncio.Event()

        def fake_respond(provider, model, text, history, system, max_tokens):
            seen.append((text, getattr(providers._context, "relay_task", None)))
            return '{"points": []}'

        async def explain_like():
            with providers.metering_context("explain"):
                explain_started.set()
                await release.wait()

        with mock.patch("backend.routers.mock.respond", side_effect=fake_respond), \
             mock.patch("backend.routers.mock.resolve_llm", return_value=("m", "anthropic")):
            holder = asyncio.create_task(explain_like())
            await explain_started.wait()
            await asyncio.create_task(reading._ask(None, "system", "JOB", 1, kind="notebook_points"))
            release.set()
            await holder
        self.assertEqual(seen, [("JOB", "notebook_points")])


if __name__ == "__main__":
    unittest.main()


class StillConnectedBetweenRequestsTest(unittest.TestCase):
    """A notebook's next step must not fail while the assistant writes its own reply between requests."""

    def setUp(self):
        from backend import relay
        relay.reset()
        self.relay = relay

    def tearDown(self):
        self.relay.reset()

    def test_an_assistant_that_just_answered_still_counts_as_listening(self):
        relay = self.relay
        with mock.patch.object(relay.time, "time", return_value=1000.0):
            relay._last_poll_at = 900.0            # asked 100 s ago, then worked on the answer
            relay.submit_answer("r-unknown", {})   # answered just now
        with mock.patch.object(relay.time, "time", return_value=1060.0):
            self.assertTrue(relay.is_listening())  # a minute later it is writing its reply: still here

    def test_an_assistant_quiet_for_minutes_is_not_listening(self):
        relay = self.relay
        relay._last_poll_at = 1000.0
        with mock.patch.object(relay.time, "time", return_value=1000.0 + relay.ACTIVE_WINDOW_S + 5):
            self.assertFalse(relay.is_listening())
