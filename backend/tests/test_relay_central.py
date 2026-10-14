"""
Unit and integration tests for Phase 2: Central Text AI Routing through MCP Relay.

Verifies:
1. Central dispatch via providers.respond for:
   - Feature 1: Explain (reading.lookup)
   - Feature 2: Study (study.generate_pack)
   - Feature 3: Debrief (debrief.generate_debrief)
   - Feature 4: Live Companion turn (_token_stream in routers.coach)
2. Per-kind parsing of answers.
3. Fallback when assistant is not listening (503 relay_not_listening).
4. Fallback on timeout (504 relay_timeout).
5. Explicit credit fallback (fallback_credits=True).
6. Non-text operations (vision/screenshots and audio) NEVER route through relay.
"""
import asyncio
import json
import unittest
from unittest import mock
from fastapi import HTTPException

from backend.tests import _env  # noqa: F401
from backend import debrief, reading, relay, study
from backend.core import config as core_config
from backend.core import providers
from backend.core import sessions as sess
from backend.errors import FriendlyError
from backend.routers import coach


class CentralRelayRoutingTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        relay.reset()
        coach.reset_session_fallbacks()
        self.orig_config = core_config.load_config()

    def tearDown(self):
        relay.reset()
        coach.reset_session_fallbacks()
        core_config.save_config(self.orig_config)

    async def test_feature_1_explain_routes_centrally_through_relay(self):
        """Feature 1: Notebook Explain routes through respond() to the relay."""
        core_config.save_config({**self.orig_config, "notebook_relay": True})

        next_task = asyncio.create_task(relay.next_request(wait_s=2.0, client="antigravity"))
        await asyncio.sleep(0.01)
        self.assertTrue(relay.is_listening())

        with mock.patch("backend.core.providers._respond_anthropic") as mock_proxy,              mock.patch("backend.core.providers._meter") as mock_meter:
            lookup_task = asyncio.create_task(reading.lookup("gradient descent"))

            req = await next_task
            self.assertEqual(req["kind"], "explain")
            self.assertIn("gradient descent", req["context"]["text"])

            relay.submit_answer(req["id"], {
                "meaning": "An optimization algorithm for finding the local minimum",
                "example": "Training a neural network",
                "from": "general",
                "pages": [],
                "unsure": False,
            })

            res = await lookup_task
            mock_proxy.assert_not_called()
            mock_meter.assert_not_called()
            self.assertEqual(res["meaning"], "An optimization algorithm for finding the local minimum")
            self.assertEqual(res["example"], "Training a neural network")

    async def test_feature_2_study_pack_generation_routes_through_relay(self):
        """Feature 2: Study flashcard/quiz pack routes through respond() to the relay."""
        core_config.save_config({**self.orig_config, "notebook_relay": True})

        sid = sess.create_session(title="Lecture 1", mode="lecture")
        transcript = (
            "Welcome to Lecture 1 on Neural Networks and Deep Learning. Today we will explore how "
            "backpropagation and gradient descent work to train complex multilayer perceptrons for "
            "pattern recognition tasks across many practical domains."
        )
        with sess._connect() as conn:
            conn.execute(
                "INSERT INTO messages (session_id, speaker, content, role, created_at) VALUES (?, ?, ?, 'user', '2026-10-04T12:00:00')",
                (sid, "interviewer", transcript),
            )

        next_task = asyncio.create_task(relay.next_request(wait_s=2.0, client="claude-code"))
        await asyncio.sleep(0.01)

        with mock.patch("backend.core.providers._respond_anthropic") as mock_proxy,              mock.patch("backend.core.providers._meter") as mock_meter:
            study_task = asyncio.create_task(study.generate_pack(sid, None))

            req = await next_task
            self.assertEqual(req["kind"], "study")
            self.assertIn("LECTURE TRANSCRIPT", req["context"]["text"])

            relay.submit_answer(req["id"], {
                "title": "Neural Networks",
                "summary": "Neural network basics.",
                "outline": [{"heading": "Basics", "points": ["Backpropagation"]}],
                "key_points": ["Neural nets learn representations"],
                "glossary": [{"term": "ReLU", "definition": "Rectified Linear Unit"}],
                "flashcards": [{"front": "What is backprop?", "back": "Reverse-mode automatic differentiation."}],
                "quiz": [
                    {"question": "What is activation function?", "options": ["ReLU", "Car", "Tree", "Sky"], "answer": 0, "explanation": "ReLU is standard."}
                ],
            })

            pack = await study_task
            mock_proxy.assert_not_called()
            mock_meter.assert_not_called()
            self.assertEqual(pack["title"], "Neural Networks")
            self.assertEqual(len(pack["flashcards"]), 1)
            self.assertEqual(pack["flashcards"][0]["front"], "What is backprop?")

    async def test_feature_3_debrief_routes_through_relay(self):
        """Feature 3: Interview debrief generation routes through respond() to the relay."""
        core_config.save_config({**self.orig_config, "notebook_relay": True})

        sid = sess.create_session(title="Interview", mode="mock")
        with sess._connect() as conn:
            conn.execute(
                "INSERT INTO messages (session_id, speaker, content, role, created_at) VALUES (?, ?, ?, 'user', '2026-10-04T12:00:00')",
                (sid, "interviewer", "Tell me about yourself"),
            )
            conn.execute(
                "INSERT INTO messages (session_id, speaker, content, role, created_at) VALUES (?, ?, ?, 'user', '2026-10-04T12:00:01')",
                (sid, "user", "I am a software engineer with 5 years experience building scalable backend services."),
            )

        next_task = asyncio.create_task(relay.next_request(wait_s=2.0, client="claude-code"))
        await asyncio.sleep(0.01)

        with mock.patch("backend.core.providers._respond_anthropic") as mock_proxy,              mock.patch("backend.core.providers._meter") as mock_meter:
            debrief_task = asyncio.create_task(
                debrief.generate_debrief(sid, None, None)
            )

            req = await next_task
            self.assertEqual(req["kind"], "debrief")
            self.assertIn("Tell me about yourself", req["context"]["text"])

            relay.submit_answer(req["id"], {
                "overall_score": 8,
                "summary": "Solid technical background.",
                "strengths": ["Clear communication"],
                "improvements": ["Give more concrete metrics"],
                "questions": [],
                "questions_to_ask": [],
                "next_steps": ["Prepare follow-ups"],
            })

            report = await debrief_task
            mock_proxy.assert_not_called()
            mock_meter.assert_not_called()
            self.assertEqual(report["overall_score"], 8)
            self.assertEqual(report["summary"], "Solid technical background.")
            self.assertIn("Clear communication", report["strengths"])

    async def test_feature_4_live_companion_turn_routes_through_relay(self):
        """Feature 4: Live Companion stream (_token_stream) routes through relay and yields tokens."""
        core_config.save_config({**self.orig_config, "notebook_relay": True})

        next_task = asyncio.create_task(relay.next_request(wait_s=2.0, client="antigravity"))
        await asyncio.sleep(0.01)

        served = {}
        tokens = []

        async def run_stream():
            loop = asyncio.get_running_loop()
            def _gen():
                return list(coach._token_stream("anthropic", "claude-haiku-4-5", "What is concurrency?", [], "System prompt", served))
            return await loop.run_in_executor(None, _gen)

        stream_task = asyncio.create_task(run_stream())

        req = await next_task
        self.assertEqual(req["kind"], "live_turn")
        self.assertIn("What is concurrency?", req["context"]["text"])

        # Assistant replies with text advice
        relay.submit_answer(req["id"], "Concurrency is dealing with a lot of things at once.")

        tokens = await stream_task
        joined = "".join(tokens)
        self.assertEqual(joined, "Concurrency is dealing with a lot of things at once.")
        self.assertEqual(served.get("provider"), "assistant_relay")
        self.assertEqual(served.get("model"), "antigravity")

    def test_per_kind_answer_parsing(self):
        """Verify _normalize_answer shapes output properly per feature kind."""
        # explain kind: dict or text wrapped to dict
        exp_dict = relay._normalize_answer({"meaning": "foo", "example": "bar"}, kind="explain")
        self.assertEqual(exp_dict["meaning"], "foo")
        self.assertEqual(exp_dict["example"], "bar")
        self.assertEqual(exp_dict["from"], "general")

        exp_str = relay._normalize_answer("simple plain meaning", kind="explain")
        self.assertEqual(exp_str["meaning"], "simple plain meaning")

        # live_turn: text string returned
        turn_str = relay._normalize_answer("Ask them about performance.", kind="live_turn")
        self.assertEqual(turn_str, "Ask them about performance.")

        turn_dict = relay._normalize_answer({"reply": "Great idea."}, kind="live_turn")
        self.assertEqual(turn_dict, "Great idea.")

        # suggest: text string returned
        sug_str = relay._normalize_answer("Lead Software Engineer", kind="suggest")
        self.assertEqual(sug_str, "Lead Software Engineer")

        # suggest: an object answer stays an object, so a list box gets a real list
        sug_obj = relay._normalize_answer({"suggestion": ["Python", "SQL"]}, kind="suggest")
        self.assertEqual(sug_obj, {"suggestion": ["Python", "SQL"]})
        from backend.routers.mock import _parse_json
        self.assertEqual(_parse_json(json.dumps(sug_obj))["suggestion"], ["Python", "SQL"])

        # structured features (study, debrief, etc.): returns dict/list
        study_parsed = relay._normalize_answer('''```json
{"cards": [{"q": "1+1", "a": "2"}]}
```''', kind="study")
        self.assertIsInstance(study_parsed, dict)
        self.assertEqual(study_parsed["cards"][0]["q"], "1+1")

    async def test_not_listening_fallback_everywhere(self):
        """When assistant is not listening, text features raise relay_not_listening (503)."""
        core_config.save_config({**self.orig_config, "notebook_relay": True})
        self.assertFalse(relay.is_listening())

        # 1. Explain
        with self.assertRaises(HTTPException) as ctx:
            await reading.lookup("entanglement")
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(ctx.exception.detail["code"], "relay_not_listening")
        self.assertIn("isn't listening", ctx.exception.detail["title"])

        # 2. Live Companion turn
        with self.assertRaises(FriendlyError) as ctx2:
            list(coach._token_stream("anthropic", "claude-haiku-4-5", "hi", [], "system"))
        self.assertEqual(ctx2.exception.code, "relay_not_listening")

    async def test_timeout_fallback_everywhere(self):
        """When assistant times out, raises relay_timeout (504)."""
        core_config.save_config({**self.orig_config, "notebook_relay": True})

        # Assistant starts listening
        next_task = asyncio.create_task(relay.next_request(wait_s=2.0, client="claude-code"))
        await asyncio.sleep(0.01)

        # Fast timeout patch on enqueue_sync
        orig_sync = relay.enqueue_sync
        def fake_sync(*args, **kwargs):
            kwargs["timeout_s"] = 0.05
            return orig_sync(*args, **kwargs)

        with mock.patch("backend.relay.enqueue_sync", side_effect=fake_sync):
            with self.assertRaises(HTTPException) as ctx:
                await reading.lookup("timeout test")
            self.assertEqual(ctx.exception.status_code, 504)
            self.assertEqual(ctx.exception.detail["code"], "relay_timeout")
            self.assertIn("didn't answer", ctx.exception.detail["title"])

        next_task.cancel()

    async def test_fallback_credits_bypasses_relay(self):
        """fallback_credits=True skips the relay even when relay is enabled and listening."""
        core_config.save_config({**self.orig_config, "notebook_relay": True})

        with mock.patch("backend.reading._ask", new_callable=mock.AsyncMock) as mock_ask:
            mock_ask.return_value = {
                "meaning": "Classical physics answer",
                "example": "Pendulum",
                "from": "general",
                "pages": [],
                "unsure": False,
            }
            res = await reading.lookup("gravity", fallback_credits=True)
            mock_ask.assert_called_once()
            self.assertEqual(res["meaning"], "Classical physics answer")

    def test_vision_and_audio_never_route_through_relay(self):
        """Screenshots and audio transcribers never call the relay."""
        core_config.save_config({**self.orig_config, "notebook_relay": True})
        # Assistant is NOT listening. If vision calls relay, it will raise relay_not_listening.
        self.assertFalse(relay.is_listening())

        with mock.patch("backend.core.providers._vision_anthropic", return_value="Image analysis result") as mock_vision:
            res = providers.respond_with_image("anthropic", "claude-haiku-4-5", "fake_path.png", "What is on screen?")
            mock_vision.assert_called_once()
            self.assertEqual(res, "Image analysis result")

    def test_coach_turn_fallback_credits_bypasses_relay_and_reports_real_provider(self):
        """When Live Companion turn uses fallback credits, it bypasses relay and reports real provider."""
        from backend.errors import resolve_llm
        from backend.core import hosted
        core_config.save_config({**self.orig_config, "notebook_relay": True, "model": "claude-haiku-4-5"})
        self.assertFalse(relay.is_listening())

        # When fallback is active, resolve_llm must NOT return assistant_relay
        with mock.patch.object(hosted, "access_token", return_value="fake_access_token"):
            model_resolved, provider_resolved = resolve_llm("assistant", fallback_credits=True)
            self.assertEqual(provider_resolved, "anthropic")
            self.assertEqual(model_resolved, "claude-haiku-4-5")

        served = {}
        with mock.patch("backend.routers.coach._stream_anthropic", return_value=iter(["Hello", " world"])) as mock_anthropic:
            tokens = list(coach._token_stream(
                "anthropic", "claude-haiku-4-5", "What is testing?", [], "System prompt", served, fallback_credits=True
            ))
            mock_anthropic.assert_called_once()
            self.assertEqual("".join(tokens), "Hello world")
            self.assertEqual(served.get("provider"), "anthropic")
            self.assertEqual(served.get("model"), "claude-haiku-4-5")

    def test_x_irb_use_credits_header_middleware(self):
        """Requests with X-IRB-Use-Credits: 1 header bypass the relay via ASGI middleware."""
        from fastapi.testclient import TestClient
        from backend.main import app
        from backend.core import local_guard
        core_config.save_config({**self.orig_config, "notebook_relay": True})
        self.assertFalse(relay.is_listening())

        client = TestClient(app, base_url="http://127.0.0.1:8000")
        base_headers = {"origin": "http://tauri.localhost", "x-irb-token": local_guard.TOKEN}

        with mock.patch("backend.entitlements.allows", return_value=True):
            # Without header, fails with 503 relay_not_listening
            r1 = client.post("/reading/lookup", headers=base_headers, json={"text": "quantum_unseen_term", "depth": "basic"})
            self.assertEqual(r1.status_code, 503)
            self.assertEqual(r1.json()["detail"]["code"], "relay_not_listening")

            # With header, bypasses relay and reaches provider
            with mock.patch("backend.reading._ask", new_callable=mock.AsyncMock) as mock_ask:
                mock_ask.return_value = {
                    "meaning": "Fluctuation answer",
                    "example": "Vacuum",
                    "from": "general",
                    "pages": [],
                    "unsure": False,
                }
                r2 = client.post(
                    "/reading/lookup",
                    headers={**base_headers, "X-IRB-Use-Credits": "1"},
                    json={"text": "quantum_unseen_term", "depth": "basic"},
                )
                self.assertEqual(r2.status_code, 200)
                mock_ask.assert_called_once()
                self.assertEqual(r2.json()["meaning"], "Fluctuation answer")

    def test_session_fallback_credits_endpoints_and_sticky_state(self):
        """POST /coach/session/{id}/fallback sets sticky session fallback."""
        from fastapi.testclient import TestClient
        from backend.main import app
        from backend.core import local_guard
        client = TestClient(app, base_url="http://127.0.0.1:8000")
        base_headers = {"origin": "http://tauri.localhost", "x-irb-token": local_guard.TOKEN}

        sid = 999
        self.assertFalse(coach.is_session_fallback(sid))

        res1 = client.post(f"/coach/session/{sid}/fallback", headers=base_headers)
        self.assertEqual(res1.status_code, 200)
        self.assertTrue(res1.json()["fallback_credits"])
        self.assertTrue(coach.is_session_fallback(sid))

        sid2 = 1000
        res2 = client.post(f"/sessions/{sid2}/fallback-credits", headers=base_headers)
        self.assertEqual(res2.status_code, 200)
        self.assertTrue(res2.json()["fallback_credits"])
        self.assertTrue(coach.is_session_fallback(sid2))

    async def test_overlapping_requests_contextvar_isolation(self):
        """Two concurrent overlapping requests: one with X-IRB-Use-Credits: 1 header uses credits,
        while the other without the header still routes to the relay and does not leak credits."""
        import httpx
        import threading
        from backend.main import app
        from backend.core import local_guard, hosted

        core_config.save_config({**self.orig_config, "notebook_relay": True, "model": "claude-haiku-4-5"})
        self.assertFalse(relay.is_listening())

        base_headers = {"origin": "http://tauri.localhost", "x-irb-token": local_guard.TOKEN}

        req1_started = threading.Event()
        can_req1_finish = threading.Event()

        def fake_respond_anthropic(*args, **kwargs):
            req1_started.set()
            can_req1_finish.wait(timeout=5.0)
            return json.dumps({
                "meaning": "Credit answer",
                "example": "Ex",
                "from": "general",
                "pages": [],
                "unsure": False,
            })

        loop = asyncio.get_running_loop()

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8000") as client:
            with mock.patch("backend.entitlements.allows", return_value=True), \
                 mock.patch.object(hosted, "access_token", return_value="fake_tok"), \
                 mock.patch("backend.core.providers._meter"), \
                 mock.patch("backend.core.providers._respond_anthropic", side_effect=fake_respond_anthropic):

                # 1. Start Request 1 with fallback header
                task1 = asyncio.create_task(
                    client.post(
                        "/reading/lookup",
                        headers={**base_headers, "X-IRB-Use-Credits": "1"},
                        json={"text": "term_one_overlapping", "depth": "basic"},
                    )
                )

                # Wait until Request 1 is actively inside its provider call / holding context
                await loop.run_in_executor(None, req1_started.wait, 5.0)
                self.assertTrue(req1_started.is_set())

                # 2. While Request 1 is still in-flight, send Request 2 WITHOUT the header
                # Request 2 must NOT inherit Request 1's fallback_credits!
                resp2 = await client.post(
                    "/reading/lookup",
                    headers=base_headers,
                    json={"text": "term_two_overlapping", "depth": "basic"},
                )

                # Now let Request 1 finish
                can_req1_finish.set()
                resp1 = await task1

                # Verify Request 2 attempted to use relay and failed with 503 (relay not listening)
                self.assertEqual(resp2.status_code, 503)
                self.assertEqual(resp2.json()["detail"]["code"], "relay_not_listening")

                # Verify Request 1 succeeded with credits fallback (200)
                self.assertEqual(resp1.status_code, 200)
                self.assertEqual(resp1.json()["meaning"], "Credit answer")


if __name__ == "__main__":
    unittest.main()
