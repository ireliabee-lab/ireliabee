"""
"Use my Claude subscription": the app starts the user's Claude Code for the relay itself
(backend/assistant_runner.py), and a run that can't answer fails the waiting requests at once.

Failure modes, written down first:
1. The switch is off: nothing starts, and a request with no assistant listening is refused
   as before ("isn't listening").
2. Claude Code isn't installed: nothing starts; the reason is in the status for Settings.
3. Claude Code starts but isn't signed in (exits non-zero, answers nothing): the request
   waiting for it fails within seconds with the sign-in reason, not after its 60 s timeout.
4. A run stops on its own (idle or its answer limit) while work is still queued: another
   run starts, so a request that arrived in between isn't stranded.
5. The run can only use the relay: not the user's other MCP servers, no built-in tools
   (files, shell, web), and it isn't saved in their Claude Code history.
6. Each install launches its own engine as the bridge: a Store install through its alias.
"""
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from backend.tests import _env  # noqa: F401
from backend import assistant_runner as runner
from backend import relay
from backend.core.config import load_config, save_config
from backend.errors import FriendlyError


def _set(**kw):
    cfg = load_config()
    cfg.update(kw)
    save_config(cfg)


class RunnerBase(unittest.TestCase):
    def setUp(self):
        relay.reset()
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)   # a run's watcher may still touch run.pid
        self._run_dir = mock.patch.object(runner, "RUN_DIR", Path(self._tmp.name))
        self._run_dir.start()
        runner._proc = None
        runner._last_error = None
        _set(relay_auto_claude=False, notebook_relay=False)

    def tearDown(self):
        runner.stop()
        if runner._proc is not None:
            try:
                runner._proc.wait(timeout=5)
            except Exception:
                pass
        # A run's watcher can outlive its test; let it finish so it can't act on the next one.
        runner.wait_for_watchers()
        runner._proc = None
        self._run_dir.stop()
        relay.reset()
        _set(relay_auto_claude=False, notebook_relay=False)
        self._tmp.cleanup()


class SwitchTest(RunnerBase):
    def test_off_starts_nothing_and_stays_not_ready(self):
        with mock.patch.object(runner.subprocess, "Popen") as popen:
            self.assertFalse(relay.ready())
            popen.assert_not_called()

    def test_one_click_turns_on_the_relay_too(self):
        runner.set_enabled(True)
        cfg = load_config()
        self.assertTrue(cfg["relay_auto_claude"])
        self.assertTrue(cfg["notebook_relay"])
        self.assertTrue(relay.is_enabled())

    def test_not_installed_says_so(self):
        runner.set_enabled(True)
        with mock.patch.object(runner, "find_claude", return_value=None), \
             mock.patch.object(runner.subprocess, "Popen") as popen:
            self.assertFalse(relay.ready())
            popen.assert_not_called()
            st = runner.status()
        self.assertIn("isn't installed", st["last_error"])
        self.assertFalse(st["available"])


class CommandTest(unittest.TestCase):
    def test_only_the_relay_and_no_history(self):
        cmd = runner.command("claude", Path("mcp.json"))
        self.assertEqual(cmd[:2], ["claude", "-p"])
        self.assertIn("--strict-mcp-config", cmd)
        self.assertEqual(cmd[cmd.index("--tools") + 1], "")
        allowed = cmd[cmd.index("--allowedTools") + 1].split(",")
        self.assertEqual(sorted(allowed), ["mcp__ireliabee__next_request", "mcp__ireliabee__submit_answer"])
        self.assertIn("--no-session-persistence", cmd)
        self.assertEqual(cmd[cmd.index("--mcp-config") + 1], "mcp.json")

    def test_fast_model_and_low_effort_by_default(self):
        # Measured: the plan's default model timed out on a live answer; Sonnet at low effort ~6-10 s.
        cmd = runner.command("claude", Path("mcp.json"))
        self.assertEqual(cmd[cmd.index("--model") + 1], "sonnet")
        self.assertEqual(cmd[cmd.index("--effort") + 1], "low")
        _set(relay_auto_model="default", relay_auto_effort="medium")
        try:
            cmd = runner.command("claude", Path("mcp.json"))
            self.assertNotIn("--model", cmd)
            self.assertEqual(cmd[cmd.index("--effort") + 1], "medium")
        finally:
            _set(relay_auto_model=None, relay_auto_effort=None)

    def test_prompt_names_the_tools_and_when_to_stop(self):
        for t in runner.TOOLS:
            self.assertIn(t, runner.PROMPT)
        self.assertIn("kind none", runner.PROMPT)
        self.assertIn(str(runner.MAX_ANSWERS), runner.PROMPT)

    def test_bridge_is_this_install_engine(self):
        with mock.patch.object(sys, "frozen", True, create=True), \
             mock.patch.object(sys, "executable", r"C:\Program Files\iReliabee\interview-coach-backend.exe"):
            self.assertEqual(runner.bridge_server(),
                             {"command": r"C:\Program Files\iReliabee\interview-coach-backend.exe", "args": ["--relay-bridge"]})
        with mock.patch.object(sys, "frozen", True, create=True), \
             mock.patch.object(sys, "executable", r"C:\Program Files\WindowsApps\iReliabeeLab.iReliabee_0.4.17.0_x64__x\interview-coach-backend.exe"):
            self.assertEqual(runner.bridge_server(), {"command": "ireliabee-relay.exe", "args": []})
        with mock.patch.object(sys, "frozen", False, create=True):
            b = runner.bridge_server()
            self.assertEqual(b["args"], ["-m", "backend.relay_bridge"])
            self.assertTrue((Path(b["env"]["PYTHONPATH"]) / "backend" / "relay_bridge.py").exists())

    def test_finds_claude_outside_path(self):
        with tempfile.TemporaryDirectory() as d:
            fake = Path(d) / ("claude.exe" if sys.platform == "win32" else "claude")
            fake.write_text("")
            with mock.patch.object(runner.shutil, "which", return_value=None), \
                 mock.patch.object(runner, "_candidates", return_value=[Path(d) / "nope", fake]):
                self.assertEqual(runner.find_claude(), str(fake))
            with mock.patch.object(runner.shutil, "which", return_value="/usr/bin/claude"):
                self.assertEqual(runner.find_claude(), "/usr/bin/claude")

    def test_runs_on_the_plan_not_the_apps_keys(self):
        """The app's .env puts ANTHROPIC_API_KEY in its environment; Claude Code would use it
        over the user's claude.ai login. Session state from a parent Claude Code goes too."""
        env = runner.child_env({
            "PATH": "/bin", "USERPROFILE": "C:/Users/a",
            "ANTHROPIC_API_KEY": "sk-ant-xxx", "ANTHROPIC_BASE_URL": "https://proxy", "ANTHROPIC_AUTH_TOKEN": "t",
            "CLAUDECODE": "1", "CLAUDE_CODE_ENTRYPOINT": "sdk", "CLAUDE_CODE_SESSION_ID": "s",
            "CLAUDE_CONFIG_DIR": "C:/cc", "CLAUDE_CODE_GIT_BASH_PATH": "C:/git/bash.exe",
        })
        self.assertEqual(env, {"PATH": "/bin", "USERPROFILE": "C:/Users/a", "CLAUDE_CONFIG_DIR": "C:/cc",
                               "CLAUDE_CODE_GIT_BASH_PATH": "C:/git/bash.exe"})

    def test_failure_reasons(self):
        self.assertIn("isn't signed in", runner.explain_failure(1, "Invalid API key · Please run /login"))
        self.assertIn("usage limit", runner.explain_failure(1, "Claude AI usage limit reached|1791900000"))
        self.assertIn("exit 2", runner.explain_failure(2, "something else\nboom"))


class RealProcessTest(RunnerBase):
    """A real child process stands in for Claude Code: what it prints and how it exits."""

    def _fake(self, body: str) -> list[str]:
        script = Path(self._tmp.name) / "fake_claude.py"
        script.write_text(body, encoding="utf-8")
        return [sys.executable, str(script)]

    def test_not_signed_in_fails_the_waiting_request_at_once(self):
        runner.set_enabled(True)
        cmd = self._fake("import sys; print('Invalid API key · Please run /login'); sys.exit(1)")
        with mock.patch.object(runner, "find_claude", return_value="claude"), \
             mock.patch.object(runner, "command", return_value=cmd):
            self.assertTrue(relay.ready())
            t0 = time.time()
            with self.assertRaises(FriendlyError) as ctx:
                relay.enqueue_sync("explain", "Explain", {"text": "entropy"}, timeout_s=30)
        self.assertLess(time.time() - t0, 15)
        self.assertEqual(ctx.exception.code, "relay_not_listening")
        self.assertIn("isn't signed in", ctx.exception.message)
        st = runner.status()
        self.assertFalse(st["running"])
        self.assertIn("isn't signed in", st["last_error"])
        self.assertEqual(st["last_run"]["answered"], 0)

    def test_a_run_that_stops_with_work_queued_starts_again(self):
        runner.set_enabled(True)
        cmd = self._fake("import time; time.sleep(0.3)")    # stops cleanly, answers nothing
        starts = []
        real_popen = runner.subprocess.Popen

        def counting_popen(*a, **k):
            starts.append(1)
            return real_popen(*a, **k)

        with mock.patch.object(runner, "find_claude", return_value="claude"), \
             mock.patch.object(runner, "command", return_value=cmd), \
             mock.patch.object(runner.subprocess, "Popen", side_effect=counting_popen):
            self.assertTrue(relay.ready())
            # A request arrives while that run is going; nobody takes it.
            done = threading.Event()

            def ask():
                try:
                    relay.enqueue_sync("explain", "Explain", {"text": "x"}, timeout_s=3)
                except Exception:
                    pass
                done.set()

            threading.Thread(target=ask, daemon=True).start()
            deadline = time.time() + 5
            while len(starts) < 2 and time.time() < deadline:
                time.sleep(0.05)
            done.wait(5)
        self.assertGreaterEqual(len(starts), 2)

    def test_turning_off_stops_a_run(self):
        runner.set_enabled(True)
        cmd = self._fake("import time; time.sleep(30)")
        with mock.patch.object(runner, "find_claude", return_value="claude"), \
             mock.patch.object(runner, "command", return_value=cmd):
            self.assertTrue(runner.ensure_running())
            self.assertTrue(runner.is_running())
            runner.set_enabled(False)
            runner._proc.wait(timeout=5)
            self.assertFalse(runner.is_running())


if __name__ == "__main__":
    unittest.main()
