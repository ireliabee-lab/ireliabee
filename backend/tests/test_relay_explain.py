"""
Unit tests for notebook Explain integration with MCP relay via central providers.respond route.
"""
import asyncio
import unittest
from unittest import mock
from fastapi import HTTPException

from backend.tests import _env  # noqa: F401
from backend import reading, relay
from backend.core import config as core_config


class RelayExplainTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        relay.reset()
        self.orig_config = core_config.load_config()

    def tearDown(self):
        relay.reset()
        core_config.save_config(self.orig_config)

    async def test_explain_when_relay_disabled_uses_ask(self):
        # Relay setting off
        cfg = {**self.orig_config, "notebook_relay": False}
        core_config.save_config(cfg)

        with mock.patch("backend.reading._ask", new_callable=mock.AsyncMock) as mock_ask:
            mock_ask.return_value = {
                "meaning": "The energy of a system",
                "example": "Heat engine",
                "from": "general",
                "pages": [],
                "unsure": False,
            }
            res = await reading.lookup("thermodynamics")
            mock_ask.assert_called_once()
            self.assertEqual(res["meaning"], "The energy of a system")
            self.assertEqual(res["from"], "general")

    async def test_explain_when_relay_enabled_and_listening_routes_to_relay(self):
        # Relay setting on
        cfg = {**self.orig_config, "notebook_relay": True}
        core_config.save_config(cfg)

        # Assistant starts listening
        next_task = asyncio.create_task(relay.next_request(wait_s=2.0, client="claude-code"))
        await asyncio.sleep(0.01)

        self.assertTrue(relay.is_listening())

        with mock.patch("backend.core.providers._respond_anthropic") as mock_anthropic, \
             mock.patch("backend.core.providers._meter") as mock_meter:
            lookup_task = asyncio.create_task(reading.lookup("quantum superposition"))

            # Assistant receives request through next_request
            req = await next_task
            self.assertEqual(req["kind"], "explain")
            self.assertIn("quantum superposition", req["context"]["text"])

            # Assistant submits answer
            relay.submit_answer(req["id"], {
                "meaning": "Ability to exist in multiple states at once",
                "example": "Schrodinger's cat",
                "from": "general",
                "pages": [],
                "unsure": False,
            })

            res = await lookup_task
            # Hosted provider was NEVER called: zero credits spent!
            mock_anthropic.assert_not_called()
            mock_meter.assert_not_called()
            self.assertEqual(res["meaning"], "Ability to exist in multiple states at once")
            self.assertEqual(res["example"], "Schrodinger's cat")

    async def test_explain_when_relay_enabled_but_not_listening_raises_503(self):
        cfg = {**self.orig_config, "notebook_relay": True}
        core_config.save_config(cfg)

        self.assertFalse(relay.is_listening())

        with self.assertRaises(HTTPException) as ctx:
            await reading.lookup("entanglement")

        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(ctx.exception.detail["code"], "relay_not_listening")
        self.assertIn("isn't listening", ctx.exception.detail["title"])

    async def test_explain_when_relay_enabled_not_listening_with_fallback_credits(self):
        cfg = {**self.orig_config, "notebook_relay": True}
        core_config.save_config(cfg)

        self.assertFalse(relay.is_listening())

        with mock.patch("backend.reading._ask", new_callable=mock.AsyncMock) as mock_ask:
            mock_ask.return_value = {
                "meaning": "Correlated quantum particles",
                "example": "Bell pairs",
                "from": "general",
                "pages": [],
                "unsure": False,
            }
            # User chose to fall back to credits
            res = await reading.lookup("entanglement", fallback_credits=True)
            mock_ask.assert_called_once()
            self.assertEqual(res["meaning"], "Correlated quantum particles")

    async def test_explain_when_relay_times_out_raises_504_and_cleans_up(self):
        cfg = {**self.orig_config, "notebook_relay": True}
        core_config.save_config(cfg)

        # Assistant starts listening
        next_task = asyncio.create_task(relay.next_request(wait_s=2.0, client="claude-code"))
        await asyncio.sleep(0.01)

        self.assertTrue(relay.is_listening())

        # Use a short timeout on relay.enqueue_sync
        orig_enqueue_sync = relay.enqueue_sync
        def fast_timeout_enqueue_sync(kind, instructions, context, timeout_s=60.0):
            return orig_enqueue_sync(kind, instructions, context, timeout_s=0.05)

        with mock.patch("backend.relay.enqueue_sync", side_effect=fast_timeout_enqueue_sync):
            with self.assertRaises(HTTPException) as ctx:
                await reading.lookup("timeout test term")

            self.assertEqual(ctx.exception.status_code, 504)
            self.assertEqual(ctx.exception.detail["code"], "relay_timeout")
            self.assertIn("didn't answer", ctx.exception.detail["title"])

        # After timeout, verify that _working is empty (no stale entries leaked)
        self.assertEqual(len(relay.status()["working"]), 0)


if __name__ == "__main__":
    unittest.main()
