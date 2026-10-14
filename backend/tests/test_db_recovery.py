"""
A corrupt sessions.db must not stop the backend starting (audit 181-H10):
it is moved aside, never deleted, and a fresh one is started.
"""
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.tests import _env  # noqa: F401
from backend.core import sessions as sess  # noqa: E402


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.addCleanup(self.dir.cleanup)
        d = Path(self.dir.name)
        self.db = d / "sessions.db"
        for p in (mock.patch.object(sess, "DB_DIR", d), mock.patch.object(sess, "DB_PATH", self.db)):
            p.start()
            self.addCleanup(p.stop)
        sess.RECOVERED.clear()
        self.addCleanup(sess.RECOVERED.clear)

    def test_a_corrupt_file_is_moved_aside_and_the_app_still_opens(self):
        self.db.write_bytes(b"this is not a database at all" * 100)
        sess.open_or_recover()
        self.assertTrue(sess.RECOVERED.get("moved_to"))
        moved = Path(sess.RECOVERED["moved_to"])
        self.assertTrue(moved.exists(), "kept to recover from, never deleted")
        self.assertIn(b"not a database", moved.read_bytes())
        sid = sess.create_session(title="after", mode="m")   # the fresh one works
        self.assertIsNotNone(sess.get_session(sid))

    def test_a_healthy_file_is_left_alone_and_copied_once_a_day(self):
        sid = sess.create_session(title="keep me", mode="m")
        sess.open_or_recover()
        self.assertEqual(sess.RECOVERED, {})
        self.assertEqual(sess.get_session(sid)["title"], "keep me")
        backups = list(self.db.parent.glob("sessions.db.backup-*"))
        self.assertEqual(len(backups), 1)
        copy = sqlite3.connect(backups[0])
        try:
            self.assertEqual(copy.execute("SELECT title FROM sessions").fetchone()[0], "keep me")
        finally:
            copy.close()

    def test_only_the_last_few_daily_copies_are_kept(self):
        sess.create_session(title="x", mode="m")
        for day in ("20260101", "20260102", "20260103", "20260104"):
            (self.db.parent / f"sessions.db.backup-{day}").write_bytes(b"old")
        sess.open_or_recover()
        self.assertEqual(len(list(self.db.parent.glob("sessions.db.backup-*"))), sess.BACKUPS_KEPT)


if __name__ == "__main__":
    unittest.main()
