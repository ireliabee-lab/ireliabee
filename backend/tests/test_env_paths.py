"""
The tests never read or write the developer's own config and data folders.

They did: `relay.RELAY_INFO_PATH` is computed from the real home folder when
the module is imported, `_env` did not redirect it, and the relay tests wrote a
test port and pairing key into the real ~/.config/ireliabee/relay.json. That
file is how the Claude Code bridge finds the installed app, so on 13 Oct the
owner's app went unreachable after a test run.

So this does not trust a hand-kept list. It reads every backend module for
paths built at import from the app folders or the home folder, and for the
app folders imported by name, and checks each one now points into the test's
temporary folder. A new one that `_env` does not redirect fails here, before
any test gets to write through it.
"""
import ast
import importlib
import unittest
from pathlib import Path

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)

BACKEND = Path(__file__).resolve().parents[1]
TMP = Path(_env._TMP.name).resolve()
APP_DIRS = {"CONFIG_DIR", "DATA_DIR"}


def _builds_a_user_path(node: ast.AST) -> bool:
    """True if `node` uses an app folder by name, or calls Path.home() or expanduser()."""
    for sub in ast.walk(node):
        if isinstance(sub, ast.Name) and sub.id in APP_DIRS | {"DB_DIR"}:
            return True
        if isinstance(sub, ast.Attribute) and sub.attr in ("home", "expanduser"):
            return True
    return False


def _user_paths() -> list[tuple[str, str]]:
    """(module, name) for every module-level name that holds a user folder or a path in one."""
    found = []
    for path in sorted(BACKEND.rglob("*.py")):
        rel = path.relative_to(BACKEND)
        if rel.parts[0] == "tests":
            continue
        module = ".".join(("backend", *rel.with_suffix("").parts))
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for stmt in tree.body:
            if isinstance(stmt, ast.ImportFrom) and (stmt.module or "").endswith("appdirs"):
                for alias in stmt.names:
                    if alias.name in APP_DIRS:
                        found.append((module, alias.asname or alias.name))
            elif isinstance(stmt, (ast.Assign, ast.AnnAssign)) and stmt.value is not None \
                    and _builds_a_user_path(stmt.value):
                targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
                found += [(module, t.id) for t in targets if isinstance(t, ast.Name)]
    return found


class TestsStayInTheirOwnFolderTest(unittest.TestCase):
    def test_the_scan_finds_the_paths_we_know_about(self):
        # If this fails the scan is broken, and the test below would pass on nothing.
        found = set(_user_paths())
        for known in [("backend.relay", "RELAY_INFO_PATH"),
                      ("backend.relay_bridge", "RELAY_CONFIG_PATH"),
                      ("backend.assistant_runner", "RUN_DIR"),
                      ("backend.core.licence", "LICENCE_PATH"),
                      ("backend.core.sessions", "DB_DIR"),
                      ("backend.core.appdirs", "CONFIG_DIR")]:
            self.assertIn(known, found)

    def test_every_user_path_points_into_the_test_folder(self):
        for module, name in _user_paths():
            with self.subTest(path=f"{module}.{name}"):
                value = getattr(importlib.import_module(module), name)
                self.assertTrue(Path(value).resolve().is_relative_to(TMP),
                                f"{module}.{name} is {value}: redirect it in backend/tests/_env.py")

    def test_the_relay_file_is_not_the_real_one(self):
        from backend import relay, relay_bridge
        real = Path.home() / ".config" / "ireliabee" / "relay.json"
        self.assertNotEqual(relay.RELAY_INFO_PATH.resolve(), real.resolve())
        self.assertTrue(relay.RELAY_INFO_PATH.resolve().is_relative_to(TMP))
        # The bridge reads what the app writes, so in tests they still agree.
        self.assertEqual(relay_bridge.RELAY_CONFIG_PATH, relay.RELAY_INFO_PATH)


if __name__ == "__main__":
    unittest.main()
