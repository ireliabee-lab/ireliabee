"""
Unit tests for backend relay core (backend/relay.py).
"""
import asyncio
import unittest

from backend.tests import _env  # noqa: F401
from backend import relay


class RelayCoreTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        relay.reset()

    def tearDown(self):
        relay.reset()

    async def test_initial_status(self):
        st = relay.status()
        self.assertFalse(st["listening"])
        self.assertFalse(st["active"])
        self.assertEqual(st["queued"], 0)
        self.assertEqual(st["working"], [])
        self.assertIsNone(st["client"])

    async def test_next_request_timeout_returns_none(self):
        # wait 0.1s for test speed
        result = await relay.next_request(wait_s=0.1, client="claude-test")
        self.assertEqual(result, {"kind": "none"})
        st = relay.status()
        self.assertEqual(st["client"], "claude-test")
        self.assertIsNotNone(st["last_poll_at"])

    async def test_enqueue_before_next_request(self):
        # Enqueue first, then assistant calls next_request
        enqueue_task = asyncio.create_task(
            relay.enqueue("explain", "Explain this term", {"selection": "entropy"})
        )
        await asyncio.sleep(0.01)

        st = relay.status()
        self.assertEqual(st["queued"], 1)

        req = await relay.next_request(wait_s=1.0)
        self.assertEqual(req["kind"], "explain")
        self.assertEqual(req["instructions"], "Explain this term")
        self.assertEqual(req["context"]["selection"], "entropy")

        st2 = relay.status()
        self.assertEqual(st2["queued"], 0)
        self.assertIn(req["id"], st2["working"])

        # Assistant submits answer
        ok = relay.submit_answer(req["id"], {"meaning": "Measure of disorder", "from": "source", "pages": [1], "unsure": False})
        self.assertTrue(ok)

        answer = await enqueue_task
        self.assertEqual(answer["meaning"], "Measure of disorder")
        self.assertEqual(answer["from"], "source")
        self.assertEqual(answer["pages"], [1])

    async def test_next_request_waiting_before_enqueue(self):
        # Assistant calls next_request first (waiting), then app enqueues
        next_task = asyncio.create_task(relay.next_request(wait_s=2.0, client="antigravity"))
        await asyncio.sleep(0.01)

        self.assertTrue(relay.status()["listening"])
        self.assertTrue(relay.is_listening())

        enqueue_task = asyncio.create_task(
            relay.enqueue("explain", "Instructions", {"selection": "gradient"})
        )

        req = await next_task
        self.assertEqual(req["kind"], "explain")
        self.assertEqual(req["context"]["selection"], "gradient")

        # Submit answer as a JSON string
        ok = relay.submit_answer(req["id"], '{"meaning": "Direction of steepest ascent", "from": "general", "pages": [], "unsure": false}')
        self.assertTrue(ok)

        answer = await enqueue_task
        self.assertEqual(answer["meaning"], "Direction of steepest ascent")
        self.assertEqual(answer["from"], "general")

    async def test_submit_answer_with_markdown_fenced_json(self):
        next_task = asyncio.create_task(relay.next_request(wait_s=2.0))
        await asyncio.sleep(0.01)

        enqueue_task = asyncio.create_task(
            relay.enqueue("explain", "Instructions", {"selection": "backprop"})
        )

        req = await next_task
        markdown_reply = """Here is the explanation you asked for:
```json
{
  "meaning": "Backward propagation of errors",
  "example": "Tracing blame backwards",
  "from": "both",
  "pages": [3],
  "unsure": false
}
```
"""
        ok = relay.submit_answer(req["id"], markdown_reply)
        self.assertTrue(ok)

        answer = await enqueue_task
        self.assertEqual(answer["meaning"], "Backward propagation of errors")
        self.assertEqual(answer["example"], "Tracing blame backwards")
        self.assertEqual(answer["from"], "both")
        self.assertEqual(answer["pages"], [3])

    async def test_submit_answer_unknown_id(self):
        ok = relay.submit_answer("nonexistent_id", {"meaning": "test"})
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
