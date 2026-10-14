"""
"Use my Claude subscription": the failures found by live testing on 13-14 Oct 2026.

1. The dead window: for ~3 minutes after an app-started run answered and exited, relay.ready()
   counted it as still listening, started nothing, and the request timed out (the owner's live
   call: two "THEM · hey" cards stuck on dots).
2. A run that never connects (its MCP bridge failed) or stops polling hung forever, and every
   later request queued behind it.
3. A model that never ends its turn (Haiku polled for 15 minutes) kept a run alive.
4. Turning the switch off killed only the cmd.exe wrapper; claude.exe kept running.
5. A run left over from a crashed app session kept polling.
6. Claude Code 2.1's usage-limit wording wasn't recognised.
7. The bridge read the port and key from relay.json, which a test run or a second copy of the
   app can overwrite.
8. An answer with a ``` code block inside one of its strings was rejected as unreadable.
9. The timeout message always said "60 seconds".
"""
import asyncio
import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

from backend.tests import _env  # noqa: F401
from backend.tests.test_assistant_runner import RunnerBase, _set
from backend import assistant_runner as runner
from backend import relay
from backend.errors import FriendlyError


def _fake(tmp: str, body: str) -> list[str]:
    script = Path(tmp) / "fake_claude.py"
    script.write_text(body, encoding="utf-8")
    return [sys.executable, str(script)]


def _wait(cond, limit=20.0):
    t0 = time.time()
    while time.time() - t0 < limit:
        if cond():
            return True
        time.sleep(0.1)
    return False


class DeadWindowTest(RunnerBase):
    def test_a_request_right_after_a_run_ended_starts_a_new_run(self):
        """The bug: an answer 10 s ago made is_listening() True, so nothing was started."""
        runner.set_enabled(True)
        relay._last_answer_at = time.time() - 10
        relay._last_poll_at = time.time() - 5
        self.assertTrue(relay.is_listening())          # the old rule still says "listening"
        with mock.patch.object(runner, "ensure_running", return_value=True) as start:
            self.assertTrue(relay.ready())
            start.assert_called_once()

    def test_an_assistant_waiting_right_now_is_used_without_starting_another(self):
        runner.set_enabled(True)
        loop = asyncio.new_event_loop()
        try:
            relay._waiters.append((loop.create_future(), loop))
            with mock.patch.object(runner, "ensure_running") as start:
                self.assertTrue(relay.ready())
                start.assert_not_called()
        finally:
            relay._waiters.clear()
            loop.close()

    def test_hand_started_assistant_between_polls_still_counts_when_claude_code_cannot_start(self):
        runner.set_enabled(True)
        relay._last_poll_at = time.time() - 5
        with mock.patch.object(runner, "ensure_running", return_value=False):
            self.assertTrue(relay.ready())

    def test_switch_off_keeps_the_old_rule(self):
        relay._last_poll_at = time.time() - 5
        with mock.patch.object(runner, "ensure_running") as start:
            self.assertTrue(relay.ready())
            start.assert_not_called()


class WatchdogTest(RunnerBase):
    def _run(self, body):
        cmd = _fake(self._tmp.name, body)
        return mock.patch.multiple(runner, find_claude=mock.DEFAULT, command=mock.DEFAULT), cmd

    def test_a_run_that_never_connects_fails_the_request_fast(self):
        runner.set_enabled(True)
        cmd = _fake(self._tmp.name, "import time; time.sleep(120)")      # never polls
        with mock.patch.object(runner, "find_claude", return_value="claude"), \
             mock.patch.object(runner, "command", return_value=cmd), \
             mock.patch.object(runner, "CONNECT_S", 1), mock.patch.object(runner, "STALL_S", 1):
            self.assertTrue(relay.ready())
            t0 = time.time()
            with self.assertRaises(FriendlyError) as ctx:
                relay.enqueue_sync("live_turn", "Answer", {"text": "hey"}, timeout_s=60)
        self.assertLess(time.time() - t0, 15)
        self.assertIn("couldn't reach iReliabee", ctx.exception.message)
        self.assertTrue(_wait(lambda: not runner.is_running()))
        self.assertEqual(runner.status()["last_run"].get("stopped"), "no_connect")

    def test_an_idle_run_is_stopped_even_if_the_model_never_ends(self):
        runner.set_enabled(True)
        cmd = _fake(self._tmp.name, "import time; time.sleep(120)")
        with mock.patch.object(runner, "find_claude", return_value="claude"), \
             mock.patch.object(runner, "command", return_value=cmd), \
             mock.patch.object(runner, "IDLE_STOP_S", 1),              mock.patch.object(relay, "pending", return_value=0):   # nothing queued, whatever other tests left (CI, Linux)
            self.assertTrue(runner.ensure_running())
            self.assertTrue(_wait(lambda: not runner.is_running()))
        st = runner.status()
        self.assertEqual(st["last_run"].get("stopped"), "idle")
        self.assertIsNone(st["last_error"])            # an idle stop is not a failure

    def test_a_new_run_gets_its_own_time_for_a_request_that_waited_before_it(self):
        """Live 14 Oct: a request that had waited 40 s for a failed run got its new run stopped
        as 'stalled' after 4 s."""
        relay._queue.append(({"id": "r9"}, None))
        relay._timing["r9"] = {"queued": time.time() - 100}
        try:
            now = time.time()
            self.assertIsNone(runner._watchdog_reason(now - 5, now))
            self.assertEqual(runner._watchdog_reason(now - (runner.STALL_S + 1), now), "stalled")
        finally:
            relay._queue.clear()
            relay._timing.clear()

    def test_watchdog_leaves_a_working_run_alone(self):
        relay._working["r1"] = ({"id": "r1"}, None)
        try:
            self.assertIsNone(runner._watchdog_reason(time.time() - 10_000, time.time()))
        finally:
            relay._working.clear()


class StopTest(RunnerBase):
    def test_turning_off_kills_the_whole_process_tree(self):
        """On Windows we hold cmd.exe; claude.exe is its child. Both must go."""
        runner.set_enabled(True)
        child_pid_file = Path(self._tmp.name) / "child.pid"
        body = ("import subprocess, sys, time\n"
                f"p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])\n"
                f"open(r'{child_pid_file}', 'w').write(str(p.pid))\n"
                "time.sleep(120)\n")
        cmd = _fake(self._tmp.name, body)
        with mock.patch.object(runner, "find_claude", return_value="claude"), \
             mock.patch.object(runner, "command", return_value=cmd):
            self.assertTrue(runner.ensure_running())
            self.assertTrue(_wait(lambda: child_pid_file.exists() and child_pid_file.read_text()))
            child = int(child_pid_file.read_text())
            runner.set_enabled(False)
            self.assertTrue(_wait(lambda: not runner.is_running()))
        self.assertTrue(_wait(lambda: not _alive(child), 10), "the child (claude.exe) was left running")
        self.assertIsNone(runner.status()["last_error"])   # turning off is not "Claude Code failed"

    def test_turning_off_fails_waiting_requests_with_the_reason(self):
        runner.set_enabled(True)
        cmd = _fake(self._tmp.name, "import time; time.sleep(120)")
        out = {}
        with mock.patch.object(runner, "find_claude", return_value="claude"), \
             mock.patch.object(runner, "command", return_value=cmd):
            self.assertTrue(relay.ready())
            import threading

            def ask():
                try:
                    relay.enqueue_sync("live_turn", "Answer", {"text": "hey"}, timeout_s=60)
                except FriendlyError as e:
                    out["e"] = e
            th = threading.Thread(target=ask); th.start()
            time.sleep(0.5)
            runner.set_enabled(False)
            th.join(15)
        self.assertIn("turned off", out["e"].message)

    def test_a_run_left_over_from_a_crash_is_stopped_once(self):
        (Path(self._tmp.name) / runner.PID_FILE).write_text("424242")
        runner._leftovers_checked = False
        with mock.patch.object(runner, "_is_leftover_run", return_value=True), \
             mock.patch.object(runner, "_kill_tree") as kill:
            runner._kill_leftover()
            runner._kill_leftover()
        kill.assert_called_once_with(424242)
        self.assertFalse((Path(self._tmp.name) / runner.PID_FILE).exists())


def _alive(pid: int) -> bool:
    import subprocess
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class MessagesAndConfigTest(RunnerBase):
    def test_claude_code_2_1_usage_limit_wording(self):
        msg = runner.explain_failure(1, "You've hit your session limit · resets 1:50am (Africa/Sao_Tome)")
        self.assertIn("usage limit", msg)
        self.assertIn("resets 1:50am", msg)

    def test_bridge_gets_port_and_key_directly_and_is_marked_one_click(self):
        with mock.patch.object(relay, "_current_port", 6223):
            cfg = json.loads(runner.write_mcp_config().read_text(encoding="utf-8"))
        env = cfg["mcpServers"]["ireliabee"]["env"]
        self.assertEqual(env["IRB_RELAY_PORT"], "6223")
        self.assertEqual(env["IRB_RELAY_KEY"], relay.get_pairing_key())
        self.assertEqual(env["IRB_RELAY_CLIENT"], "one-click")

    def test_backend_learns_its_port_from_its_first_request(self):
        """Run from source, nothing recorded the port, so the bridge used a stale relay.json."""
        from fastapi.testclient import TestClient
        from backend.main import app
        with mock.patch.object(relay, "_current_port", None),              mock.patch.object(relay, "write_relay_info"):
            TestClient(app, base_url="http://127.0.0.1:6223").get("/handshake", headers={"Origin": "http://localhost:5173"})
            self.assertEqual(relay.known_port(), 6223)

    def test_unknown_port_leaves_the_bridge_to_relay_json(self):
        with mock.patch.object(relay, "_current_port", None):
            env = json.loads(runner.write_mcp_config().read_text(encoding="utf-8"))["mcpServers"]["ireliabee"]["env"]
        self.assertNotIn("IRB_RELAY_PORT", env)

    def test_bridge_reads_the_env_before_relay_json(self):
        from backend import relay_bridge
        with mock.patch.dict(os.environ, {"IRB_RELAY_PORT": "6223", "IRB_RELAY_KEY": "k"}):
            self.assertEqual(relay_bridge.read_relay_info(), (6223, "k"))

    def test_one_click_run_is_told_to_end_its_turn_on_none(self):
        from backend.routers import mcp
        call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "next_request", "arguments": {"wait_s": 0.1}}}
        one = asyncio.run(mcp._handle_jsonrpc(call, one_click=True))["result"]["content"][0]["text"]
        hand = asyncio.run(mcp._handle_jsonrpc(call))["result"]["content"][0]["text"]
        self.assertIn("End your turn now", one)
        self.assertIn("Call next_request() again", hand)

    def test_answer_with_a_code_block_in_a_string_parses(self):
        from backend.routers.mock import _parse_json
        answer = {"meaning": "Run it like this:\n```python\nprint(1)\n```\nthen check.", "pages": [2]}
        self.assertEqual(_parse_json(json.dumps(answer)), answer)
        self.assertEqual(_parse_json("```json\n" + json.dumps(answer) + "\n```"), answer)

    def test_timeout_message_says_the_real_limit(self):
        from backend.errors import relay_timeout
        self.assertIn("60 seconds", relay_timeout(60).message)
        self.assertIn("3 minutes", relay_timeout(180).message)


if __name__ == "__main__":
    unittest.main()
