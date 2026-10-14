"""
Screenshots go where the rest of the user's data goes (audit rough edge 9).

Both capture modules built the folder by hand, and the rebrand missed both:
shots were still written to `~/.local/share/interview-coach/screens` while
everything else had moved to `ireliabee`. Worse, the app recreated that folder
every time it took a shot, right after the migration had moved it — which is
how the two ended up side by side on the owner's machine, 7.6 MB of screenshots
in the folder nothing else in the app looks at.

Capture is platform-split: this module takes the Windows and macOS shots and
hands Linux to core/screen_capture.py. So the test that matters is that the two
agree, and it is the one that runs on either OS.
"""
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import screen_capture_xp as xp  # noqa: E402
from backend.core import appdirs  # noqa: E402
from backend.core import screen_capture as linux_capture  # noqa: E402


class WhereShotsGoTest(unittest.TestCase):
    def test_both_platforms_write_to_the_same_folder(self):
        # Fixing one module and not the other would split a user's screenshots
        # by platform, which is harder to notice than either bug alone.
        self.assertEqual(xp.CAPTURE_DIR, linux_capture.CAPTURE_DIR)

    def test_it_is_the_app_data_folder_every_other_path_uses(self):
        self.assertEqual(xp.CAPTURE_DIR, appdirs.DATA_DIR / "screens")

    def test_the_retired_name_is_gone_from_both(self):
        for where in (xp.CAPTURE_DIR, linux_capture.CAPTURE_DIR):
            self.assertNotIn("interview-coach", str(where))

    def test_a_session_gets_its_own_folder_under_it(self):
        with TemporaryDirectory() as tmp:
            with mock.patch.object(xp, "CAPTURE_DIR", Path(tmp) / "screens"):
                where = xp._capture_dir_for(7)
            self.assertEqual(where, Path(tmp) / "screens" / "7")
            self.assertTrue(where.is_dir())


if __name__ == "__main__":
    unittest.main()
