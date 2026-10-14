"""
The rebrand migration actually brings a user's settings across.

It ran for two months and did nothing. `_resolve` moved the legacy folder only
when the new one did not exist — and the packaged backend creates
`~/.config/ireliabee` to open its log file *before* this module is imported, so
the folder always existed. Shipped in v0.4.1; run from source it always worked,
because uvicorn imports `backend.main` and `main_bundled` never runs.

Testing for an *empty* new folder would not have rescued anyone either: by the
time they noticed, it held a log file, and an account file if they had signed in
since upgrading. So it fills in name by name instead.

These are the tests that let the behaviour be trusted rather than reasoned
about: this is the one code path in the app that moves a user's own files.
"""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import main_bundled  # noqa: E402
from backend.core import appdirs  # noqa: E402


class ResolveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.new = Path(self.tmp.name) / "ireliabee"
        self.legacy = Path(self.tmp.name) / "interview-coach"

    def seed(self, folder: Path, **files: str) -> Path:
        folder.mkdir(parents=True, exist_ok=True)
        for name, text in files.items():
            (folder / name.replace("_", ".")).write_text(text, encoding="utf-8")
        return folder

    def resolve(self) -> Path:
        return appdirs._resolve(self.new, self.legacy)

    def test_nothing_to_migrate_creates_nothing(self):
        # The common case, and it must not leave an empty folder lying around.
        self.assertEqual(self.resolve(), self.new)
        self.assertFalse(self.new.exists())

    def test_a_legacy_folder_on_its_own_is_moved_whole(self):
        self.seed(self.legacy, config_json='{"persona": "warm"}', _env="OPENAI_API_KEY=sk-1")
        self.resolve()
        self.assertEqual((self.new / "config.json").read_text(encoding="utf-8"), '{"persona": "warm"}')
        self.assertIn("sk-1", (self.new / ".env").read_text(encoding="utf-8"))
        self.assertFalse(self.legacy.exists(), "the whole folder moved")

    def test_the_case_that_shipped_broken(self):
        # A new folder holding nothing but the log the backend just opened, and
        # the user's real settings still next door. This is what v0.4.1 left.
        self.seed(self.new, backend_log="--- backend starting ---")
        self.seed(self.legacy, config_json='{"persona": "warm"}', _env="OPENAI_API_KEY=sk-1")
        self.resolve()
        self.assertEqual((self.new / "config.json").read_text(encoding="utf-8"), '{"persona": "warm"}')
        self.assertIn("sk-1", (self.new / ".env").read_text(encoding="utf-8"))
        self.assertTrue((self.new / "backend.log").exists(), "and the log is untouched")

    def test_an_empty_new_folder_is_filled_in(self):
        # On Windows a rename onto an existing directory raises, so this case
        # has to go through the per-name path rather than the rename.
        self.new.mkdir(parents=True)
        self.seed(self.legacy, config_json="{}")
        self.resolve()
        self.assertTrue((self.new / "config.json").exists())

    def test_the_newer_file_wins_and_the_older_one_is_not_destroyed(self):
        self.seed(self.new, config_json='{"persona": "current"}')
        self.seed(self.legacy, config_json='{"persona": "ancient"}')
        self.resolve()
        self.assertEqual((self.new / "config.json").read_text(encoding="utf-8"), '{"persona": "current"}')
        self.assertTrue((self.legacy / "config.json").exists(),
                        "nothing is ever deleted: a person can still compare them")

    def test_a_whole_subfolder_comes_across(self):
        # ~/.local/share/interview-coach/screens is exactly this.
        shots = self.legacy / "screens" / "3"
        shots.mkdir(parents=True)
        (shots / "shot.png").write_bytes(b"PNG")
        self.seed(self.new, sessions_db="not really a database")
        self.resolve()
        self.assertTrue((self.new / "screens" / "3" / "shot.png").exists())
        self.assertEqual((self.new / "sessions.db").read_text(encoding="utf-8"),
                         "not really a database", "the database is never touched")

    def test_running_it_twice_changes_nothing_the_second_time(self):
        self.seed(self.new, config_json='{"persona": "current"}')
        self.seed(self.legacy, config_json='{"persona": "ancient"}', _env="OPENAI_API_KEY=sk-1")
        self.resolve()
        before = sorted((p.name, p.read_bytes()) for p in self.new.iterdir())
        self.resolve()
        self.assertEqual(sorted((p.name, p.read_bytes()) for p in self.new.iterdir()), before)

    def test_a_file_where_the_folder_should_be_is_left_alone(self):
        self.legacy.parent.mkdir(parents=True, exist_ok=True)
        self.legacy.write_text("not a folder", encoding="utf-8")
        self.assertEqual(self.resolve(), self.new)
        self.assertFalse(self.new.exists())


class TheLogFolderAsksRatherThanAssumesTest(unittest.TestCase):
    def test_the_log_folder_is_the_one_appdirs_decided(self):
        # Not a strong test, but it cannot be satisfied by a second hardcoded
        # literal — and a hardcoded literal is what killed the migration, by
        # creating the folder before this module was ever imported.
        self.assertEqual(main_bundled._log_dir(), appdirs.CONFIG_DIR)


if __name__ == "__main__":
    unittest.main()
