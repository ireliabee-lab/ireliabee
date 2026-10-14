"""
Settings and API keys survive an interrupted write (audit rough edge 8).

`config.json` and `.env` were the last two files of the user's own that were
written straight over themselves with `write_text`, while `licence.json` and
`account.json` had long gone through a temp file and one rename. A write that
died half-way left a truncated file: persona, language and tone silently back to
their defaults, or pasted API keys gone.

The .env half has a second point to it. It used to be written and chmodded a
moment later, so a file holding the user's keys existed at the default mode for
an instant. The temp file is chmodded before it is moved into place instead.
"""
import json
import os
import stat
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import config  # noqa: E402

POSIX_ONLY = unittest.skipIf(os.name == "nt", "Windows has no file modes to check")


class OwnConfigFolder(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        here = Path(self.tmp.name)
        for name, value in (("CONFIG_PATH", here / "config.json"), ("ENV_PATH", here / ".env")):
            patch = mock.patch.object(config, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def leftovers(self):
        return sorted(p.name for p in Path(self.tmp.name).glob("*.tmp"))


class SavingSettingsTest(OwnConfigFolder):
    def test_what_was_saved_comes_back(self):
        config.save_config({"persona": "warm", "language": "en"})
        self.assertEqual(config.load_config(), {"persona": "warm", "language": "en"})

    def test_it_leaves_no_temp_file_behind(self):
        config.save_config({"persona": "warm"})
        self.assertEqual(self.leftovers(), [])

    def test_a_write_that_fails_leaves_the_previous_settings_alone(self):
        # The whole point. `write_text` had already truncated the real file by
        # the time anything could go wrong, so a failure here used to mean the
        # user's persona, language and tone were simply gone.
        config.save_config({"persona": "warm", "tone": "plain"})
        with mock.patch.object(config.os, "replace", side_effect=OSError(13, "in use")):
            with self.assertRaises(OSError):
                config.save_config({"persona": "clobbered"})
        self.assertEqual(config.load_config(), {"persona": "warm", "tone": "plain"})

    def test_settings_are_read_back_as_utf8(self):
        config.save_config({"name": "Zoë", "role": "Ingénieur"})
        self.assertEqual(config.load_config()["name"], "Zoë")


class SavingKeysTest(OwnConfigFolder):
    def test_a_key_is_written_and_read_back(self):
        config._write_env_var("OPENAI_API_KEY", "sk-test-123")
        self.assertIn("OPENAI_API_KEY=sk-test-123", config.ENV_PATH.read_text(encoding="utf-8"))

    def test_it_leaves_no_temp_file_behind(self):
        config._write_env_var("OPENAI_API_KEY", "sk-test-123")
        self.assertEqual(self.leftovers(), [])

    def test_replacing_one_key_keeps_the_others(self):
        config._write_env_var("OPENAI_API_KEY", "first")
        config._write_env_var("DEEPGRAM_API_KEY", "second")
        config._write_env_var("OPENAI_API_KEY", "third")
        text = config.ENV_PATH.read_text(encoding="utf-8")
        self.assertIn("OPENAI_API_KEY=third", text)
        self.assertIn("DEEPGRAM_API_KEY=second", text)
        self.assertNotIn("first", text)

    def test_a_failed_write_does_not_lose_the_keys_already_there(self):
        config._write_env_var("OPENAI_API_KEY", "keep-me")
        with mock.patch.object(config.os, "replace", side_effect=OSError(13, "in use")):
            with self.assertRaises(OSError):
                config._write_env_var("DEEPGRAM_API_KEY", "never-lands")
        self.assertIn("OPENAI_API_KEY=keep-me", config.ENV_PATH.read_text(encoding="utf-8"))

    def test_the_file_is_made_private_before_it_is_put_in_place(self):
        # The cross-platform half of the case below, which only runs on POSIX and
        # so never runs on the machine this is usually written on. Windows has no
        # mode to read back, but the *order* is the thing that matters and it can
        # be checked anywhere: chmod the temp file, then rename it into place. The
        # old code created .env at the default mode and chmodded it afterwards,
        # with the key already in it.
        order = []
        real_chmod, real_replace = config.os.chmod, config.os.replace

        def chmod(path, mode):
            order.append(("chmod", mode))
            return real_chmod(path, mode)

        def replace(src, dst):
            order.append(("replace", None))
            return real_replace(src, dst)

        with mock.patch.object(config.os, "chmod", chmod), \
                mock.patch.object(config.os, "replace", replace):
            config._write_env_var("OPENAI_API_KEY", "sk-test-123")

        self.assertEqual([step for step, _ in order], ["chmod", "replace"])
        self.assertEqual(order[0][1], 0o600)

    def test_settings_are_not_made_private_the_same_way(self):
        # config.json holds persona, language and tone — no secrets — so it is
        # deliberately left at the usual mode.
        with mock.patch.object(config.os, "chmod") as chmod:
            config.save_config({"persona": "warm"})
        chmod.assert_not_called()

    @POSIX_ONLY
    def test_a_file_holding_keys_is_never_briefly_readable(self):
        # On the very first write, too: the old code created .env at the default
        # mode and chmodded it afterwards, with the key already in it.
        config._write_env_var("OPENAI_API_KEY", "sk-test-123")
        self.assertEqual(stat.S_IMODE(config.ENV_PATH.stat().st_mode), 0o600)

    def test_an_env_file_from_an_older_build_still_loads(self):
        # Written in the machine's own codepage before we settled on UTF-8.
        # load_env runs at startup with nowhere to report a decode error, so
        # raising here would be an app that will not open before an interview.
        config.ENV_PATH.write_bytes(b"SOME_API_KEY=caf\xe9\n")
        config.load_env()                     # must not raise
        self.addCleanup(os.environ.pop, "SOME_API_KEY", None)
        self.assertTrue(os.environ.get("SOME_API_KEY"))


class OnlyOneWriterTest(OwnConfigFolder):
    def test_two_saves_at_once_cannot_rename_each_other_s_wreckage(self):
        # The temp file's name is fixed and FastAPI runs these on a threadpool.
        import threading
        errors: list = []

        def save(n):
            try:
                for _ in range(40):
                    config.save_config({"who": n, "padding": "x" * 500})
            except Exception as e:      # noqa: BLE001 — the test is what it says
                errors.append(e)

        threads = [threading.Thread(target=save, args=(n,)) for n in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(self.leftovers(), [])
        # Whoever wrote last, it is a whole document rather than two spliced.
        self.assertIn(json.loads(config.CONFIG_PATH.read_text(encoding="utf-8"))["who"], range(4))


if __name__ == "__main__":
    unittest.main()
