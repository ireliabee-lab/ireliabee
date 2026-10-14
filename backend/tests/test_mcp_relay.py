"""
Tests for MCP router (/mcp/sse, /mcp/messages, /relay/status) and local_guard protection.
"""
import asyncio
import os
import json
import unittest
import httpx

from backend.tests import _env  # noqa: F401
from backend.main import app
from backend import relay
from backend.core.local_guard import TOKEN


class McpRelayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        relay.reset()
        self.transport = httpx.ASGITransport(app=app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://127.0.0.1")
        self.auth_headers = {"x-irb-token": TOKEN}

    async def asyncTearDown(self):
        await self.client.aclose()
        relay.reset()

    async def test_local_guard_rejects_without_token(self):
        # On loopback host without token -> 401 token
        r = await self.client.get("/relay/status")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["code"], "local_auth")

        r = await self.client.post("/mcp/messages", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.assertEqual(r.status_code, 401)

    async def test_local_guard_rejects_non_loopback_host(self):
        # Foreign host -> 403 host
        async with httpx.AsyncClient(transport=self.transport, base_url="http://evil.com") as foreign_client:
            r = await foreign_client.get(f"/relay/status?t={TOKEN}")
            self.assertEqual(r.status_code, 403)

    async def test_relay_status_endpoint_with_token(self):
        # Via header
        r = await self.client.get("/relay/status", headers=self.auth_headers)
        self.assertEqual(r.status_code, 200)
        data = r.json()
        self.assertIn("listening", data)
        self.assertIn("queued", data)
        self.assertIn("working", data)
        self.assertIn("repo_dir", data)
        self.assertTrue(os.path.isabs(data["repo_dir"]))
        self.assertTrue(os.path.isdir(os.path.join(data["repo_dir"], "backend")))

        # Via query param ?t=
        r2 = await self.client.get(f"/relay/status?t={TOKEN}")
        self.assertEqual(r2.status_code, 200)

    async def test_mcp_initialize(self):
        msg = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "claude-code-test", "version": "1.0"},
            },
        }
        r = await self.client.post(f"/mcp/messages?t={TOKEN}", json=msg)
        self.assertEqual(r.status_code, 200)
        res = r.json()
        self.assertEqual(res["jsonrpc"], "2.0")
        self.assertEqual(res["id"], 1)
        self.assertEqual(res["result"]["serverInfo"]["name"], "ireliabee-relay")
        self.assertIn("instructions", res["result"])
        self.assertIn("start iReliabee", res["result"]["instructions"])
        self.assertIn("next_request", res["result"]["instructions"])
        self.assertIn("submit_answer", res["result"]["instructions"])
        self.assertIn("prompts", res["result"]["capabilities"])
        self.assertEqual(relay.status()["client"], "claude-code-test")

    async def test_mcp_tools_list(self):
        msg = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {},
        }
        r = await self.client.post(f"/mcp/messages?t={TOKEN}", json=msg)
        self.assertEqual(r.status_code, 200)
        tools = r.json()["result"]["tools"]
        tool_names = [t["name"] for t in tools]
        self.assertIn("next_request", tool_names)
        self.assertIn("submit_answer", tool_names)
        self.assertIn("answer", tool_names)
        self.assertIn("relay_status", tool_names)

    async def test_mcp_tool_call_relay_status(self):
        msg = {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "relay_status",
                "arguments": {},
            },
        }
        r = await self.client.post(f"/mcp/messages?t={TOKEN}", json=msg)
        self.assertEqual(r.status_code, 200)
        content = r.json()["result"]["content"]
        self.assertEqual(content[0]["type"], "text")
        st = json.loads(content[0]["text"])
        self.assertIn("listening", st)
        self.assertNotIn("pairing_key", st)

    async def test_mcp_tool_call_next_request_timeout(self):
        msg = {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "next_request",
                "arguments": {"wait_s": 0.1},
            },
        }
        r = await self.client.post(f"/mcp/messages?t={TOKEN}", json=msg)
        self.assertEqual(r.status_code, 200)
        content = r.json()["result"]["content"]
        self.assertIn('"kind": "none"', content[0]["text"])

    async def test_mcp_relay_full_flow(self):
        # 1. App enqueues a request
        enqueue_task = asyncio.create_task(
            relay.enqueue("explain", "Explain this term", {"selection": "transformer"})
        )
        await asyncio.sleep(0.01)

        # 2. Assistant calls next_request
        call_next = {
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {
                "name": "next_request",
                "arguments": {"wait_s": 1.0},
            },
        }
        r = await self.client.post(f"/mcp/messages?t={TOKEN}", json=call_next)
        self.assertEqual(r.status_code, 200)
        text = r.json()["result"]["content"][0]["text"]
        self.assertIn("transformer", text)
        self.assertIn("r1", text)

        # 3. Assistant calls submit_answer
        call_submit = {
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {
                "name": "submit_answer",
                "arguments": {
                    "id": "r1",
                    "answer": {
                        "meaning": "An attention-based neural network architecture",
                        "example": "BERT or GPT",
                        "from": "general",
                        "pages": [],
                        "unsure": False,
                    },
                },
            },
        }
        r2 = await self.client.post(f"/mcp/messages?t={TOKEN}", json=call_submit)
        self.assertEqual(r2.status_code, 200)
        self.assertIn("Answer accepted", r2.json()["result"]["content"][0]["text"])

        # 4. App receives answer
        answer = await enqueue_task
        self.assertEqual(answer["meaning"], "An attention-based neural network architecture")
        self.assertEqual(answer["example"], "BERT or GPT")


    async def test_pairing_key_authenticates_relay_routes(self):
        key = relay.get_pairing_key()
        self.assertTrue(key.startswith("irb_relay_"))

        # /relay/status accepts pairing key via ?k=
        r = await self.client.get(f"/relay/status?k={key}")
        self.assertEqual(r.status_code, 200)

        # /mcp/messages accepts pairing key via ?k=
        ping = {"jsonrpc": "2.0", "id": 99, "method": "ping"}
        r2 = await self.client.post(f"/mcp/messages?k={key}", json=ping)
        self.assertEqual(r2.status_code, 200)

    async def test_pairing_key_rejected_on_non_relay_routes(self):
        key = relay.get_pairing_key()
        # Non-relay endpoints must reject the pairing key (only master token accepted)
        r = await self.client.get(f"/sessions?k={key}")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json()["code"], "local_auth")

        r2 = await self.client.get(f"/reading/languages?k={key}")
        self.assertEqual(r2.status_code, 401)

    async def test_regenerate_pairing_key(self):
        old_key = relay.get_pairing_key()
        new_key = relay.regenerate_pairing_key()
        self.assertNotEqual(old_key, new_key)

        # Old key refused
        r = await self.client.get(f"/relay/status?k={old_key}")
        self.assertEqual(r.status_code, 401)

        # New key accepted
        r2 = await self.client.get(f"/relay/status?k={new_key}")
        self.assertEqual(r2.status_code, 200)

    async def test_relay_info_json_written(self):
        relay.record_port(9876)
        info_file = relay.RELAY_INFO_PATH
        self.assertTrue(info_file.exists())
        data = json.loads(info_file.read_text(encoding="utf-8"))
        self.assertEqual(data["port"], 9876)
        self.assertEqual(data["pairing_key"], relay.get_pairing_key())


    async def test_mcp_prompts_list_and_get(self):
        # prompts/list
        msg_list = {"jsonrpc": "2.0", "id": 50, "method": "prompts/list", "params": {}}
        r = await self.client.post(f"/mcp/messages?t={TOKEN}", json=msg_list)
        self.assertEqual(r.status_code, 200)
        prompts = r.json()["result"]["prompts"]
        self.assertEqual(len(prompts), 1)
        self.assertEqual(prompts[0]["name"], "ireliabee-listen")

        # prompts/get valid
        msg_get = {"jsonrpc": "2.0", "id": 51, "method": "prompts/get", "params": {"name": "ireliabee-listen"}}
        r2 = await self.client.post(f"/mcp/messages?t={TOKEN}", json=msg_get)
        self.assertEqual(r2.status_code, 200)
        messages = r2.json()["result"]["messages"]
        self.assertEqual(len(messages), 1)
        text = messages[0]["content"]["text"]
        self.assertIn("next_request", text)
        self.assertIn("submit_answer", text)

        # prompts/get unknown
        msg_err = {"jsonrpc": "2.0", "id": 52, "method": "prompts/get", "params": {"name": "other"}}
        r3 = await self.client.post(f"/mcp/messages?t={TOKEN}", json=msg_err)
        self.assertEqual(r3.status_code, 200)
        self.assertIn("error", r3.json())
        self.assertEqual(r3.json()["error"]["code"], -32602)

    async def test_relay_status_never_exposes_pairing_key_without_master_token(self):
        key = relay.get_pairing_key()
        # Request with pairing key (?k=) does not receive pairing_key
        r_pair = await self.client.get(f"/relay/status?k={key}")
        self.assertEqual(r_pair.status_code, 200)
        self.assertNotIn("pairing_key", r_pair.json())

        # Request with header x-irb-relay-key does not receive pairing_key
        r_pair_hdr = await self.client.get("/relay/status", headers={"x-irb-relay-key": key})
        self.assertEqual(r_pair_hdr.status_code, 200)
        self.assertNotIn("pairing_key", r_pair_hdr.json())

        # Request with master token receives pairing_key
        r_tok = await self.client.get(f"/relay/status?t={TOKEN}")
        self.assertEqual(r_tok.status_code, 200)
        self.assertIn("pairing_key", r_tok.json())
        self.assertEqual(r_tok.json()["pairing_key"], key)

        r_tok_hdr = await self.client.get("/relay/status", headers=self.auth_headers)
        self.assertEqual(r_tok_hdr.status_code, 200)
        self.assertIn("pairing_key", r_tok_hdr.json())
        self.assertEqual(r_tok_hdr.json()["pairing_key"], key)


if __name__ == "__main__":
    unittest.main()
