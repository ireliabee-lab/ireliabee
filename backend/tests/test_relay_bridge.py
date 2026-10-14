"""
Unit tests for backend/relay_bridge.py (stdio bridge for assistant MCP relay).
"""
import json
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401
from backend import relay
from backend import relay_bridge


class RelayBridgeTest(unittest.TestCase):
    def setUp(self):
        relay.reset()
        self.key = relay.get_pairing_key()
        relay.record_port(8000)

    def tearDown(self):
        relay.reset()

    def test_read_relay_info(self):
        port, key = relay_bridge.read_relay_info()
        self.assertEqual(port, 8000)
        self.assertEqual(key, self.key)

    def test_send_to_backend_missing_file_returns_error(self):
        with mock.patch("backend.relay_bridge.read_relay_info", return_value=(0, "")):
            resp = relay_bridge.send_to_backend({"jsonrpc": "2.0", "id": 1, "method": "ping"}, retries=1)
            self.assertEqual(resp["error"]["code"], -32000)
            self.assertIn("not running", resp["error"]["message"])

    def test_send_to_backend_recovers_across_port_change(self):
        # First call fails on stale port, then discovers new port on retry
        calls = []

        def mock_urlopen(req, timeout=65.0):
            url = req.full_url
            calls.append(url)
            if "8000" in url:
                import urllib.error
                raise urllib.error.URLError("Connection refused")
            # New port succeeds
            mock_resp = mock.MagicMock()
            mock_resp.read.return_value = json.dumps({"jsonrpc": "2.0", "id": 42, "result": {}}).encode("utf-8")
            mock_resp.__enter__.return_value = mock_resp
            return mock_resp

        # Port changes to 9090 on restart
        relay_bridge_info_ports = [(8000, self.key), (9090, self.key)]
        def fake_read():
            if relay_bridge_info_ports:
                return relay_bridge_info_ports.pop(0)
            return (9090, self.key)

        with mock.patch("backend.relay_bridge.read_relay_info", side_effect=fake_read):
            with mock.patch("urllib.request.urlopen", side_effect=mock_urlopen):
                resp = relay_bridge.send_to_backend({"jsonrpc": "2.0", "id": 42, "method": "ping"}, retries=3)
                self.assertIsNotNone(resp)
                self.assertEqual(resp["id"], 42)
                # Verified that it tried 8000, then retried on 9090
                self.assertTrue(any("8000" in u for u in calls))
                self.assertTrue(any("9090" in u for u in calls))


if __name__ == "__main__":
    unittest.main()
