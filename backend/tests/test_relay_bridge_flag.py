"""
`interview-coach-backend --relay-bridge` and `ireliabee-relay.exe` (backend/main_bundled.py).

Installed users have no Python and no `backend` package, so the assistant's stdio
bridge has to start from the bundled sidecar. It must run before the server
machinery: stdout is the MCP protocol there, not the log file.

On Microsoft Store (MSIX) installs, Windows creates an AppExecutionAlias named
`ireliabee-relay.exe` pointing at the sidecar. The alias invokes the exe with no
arguments, so the sidecar also enters bridge mode when argv[0] is the alias.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.tests import _env  # noqa: F401
from backend import main_bundled

ROOT = Path(__file__).resolve().parents[2]


class RelayBridgeFlagTest(unittest.TestCase):
    def test_flag_runs_the_bridge_and_nothing_else(self):
        with mock.patch("backend.relay_bridge.main") as bridge, \
             mock.patch.object(main_bundled, "_ensure_streams") as streams, \
             mock.patch.object(main_bundled, "_bind") as bind, \
             mock.patch.object(main_bundled, "_sweep_unpacked") as sweep, \
             mock.patch.object(sys, "argv", ["interview-coach-backend", "--relay-bridge"]):
            main_bundled.main()
        bridge.assert_called_once()
        streams.assert_not_called()   # stdout stays the protocol, not the log file
        bind.assert_not_called()      # no second server
        sweep.assert_not_called()

    def test_started_as_alias_exe_name_runs_the_bridge_without_flags(self):
        for name in (
            "ireliabee-relay.exe",
            "ireliabee-relay",
            r"C:\Users\User\AppData\Local\Microsoft\WindowsApps\ireliabee-relay.exe",
            r"C:\Program Files\WindowsApps\iReliabeeLab.iReliabee_0.4.0.0_x64__...\ireliabee-relay.exe",
            "/usr/local/bin/ireliabee-relay.exe",
            "/opt/ireliabee/ireliabee-relay",
        ):
            with self.subTest(argv0=name):
                with mock.patch("backend.relay_bridge.main") as bridge, \
                     mock.patch.object(main_bundled, "_ensure_streams") as streams, \
                     mock.patch.object(main_bundled, "_bind") as bind, \
                     mock.patch.object(main_bundled, "_sweep_unpacked") as sweep, \
                     mock.patch.object(sys, "argv", [name]):
                    main_bundled.main()
                bridge.assert_called_once()
                streams.assert_not_called()
                bind.assert_not_called()
                sweep.assert_not_called()

    def test_without_the_flag_the_server_path_is_taken(self):
        with mock.patch("backend.relay_bridge.main") as bridge, \
             mock.patch.object(main_bundled, "_ensure_streams", side_effect=SystemExit(0)), \
             mock.patch.object(sys, "argv", ["interview-coach-backend"]):
            with self.assertRaises(SystemExit):
                main_bundled.main()
        bridge.assert_not_called()

    def test_as_a_real_process_it_speaks_json_rpc_on_stdout_only(self):
        # Home has a relay.json naming a port nothing listens on, as after the app quit.
        with tempfile.TemporaryDirectory() as home:
            cfg = Path(home) / ".config" / "ireliabee"
            cfg.mkdir(parents=True)
            (cfg / "relay.json").write_text(json.dumps({"port": 1, "pairing_key": "irb_relay_x"}))
            env = {**os.environ, "HOME": home, "USERPROFILE": home}
            msg = json.dumps({"jsonrpc": "2.0", "id": 7, "method": "ping"}) + "\n"
            r = subprocess.run([sys.executable, "-m", "backend.main_bundled", "--relay-bridge"],
                               input=msg, capture_output=True, text=True, cwd=ROOT, env=env, timeout=60)
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        self.assertEqual(len(lines), 1, r.stdout)
        reply = json.loads(lines[0])
        self.assertEqual(reply["id"], 7)
        self.assertIn("error", reply)  # app not running: a clean error, not a crash

    def test_as_a_real_process_started_as_alias_it_speaks_json_rpc_on_stdout(self):
        with tempfile.TemporaryDirectory() as home:
            cfg = Path(home) / ".config" / "ireliabee"
            cfg.mkdir(parents=True)
            (cfg / "relay.json").write_text(json.dumps({"port": 1, "pairing_key": "irb_relay_x"}))
            env = {**os.environ, "HOME": home, "USERPROFILE": home}
            msg = json.dumps({"jsonrpc": "2.0", "id": 11, "method": "ping"}) + "\n"
            code = (
                "import sys, runpy; "
                "sys.argv = ['ireliabee-relay.exe']; "
                "runpy.run_module('backend.main_bundled', run_name='__main__')"
            )
            r = subprocess.run([sys.executable, "-c", code],
                               input=msg, capture_output=True, text=True, cwd=ROOT, env=env, timeout=60)
        lines = [l for l in r.stdout.splitlines() if l.strip()]
        self.assertEqual(len(lines), 1, r.stdout)
        reply = json.loads(lines[0])
        self.assertEqual(reply["id"], 11)
        self.assertIn("error", reply)


if __name__ == "__main__":
    unittest.main()
