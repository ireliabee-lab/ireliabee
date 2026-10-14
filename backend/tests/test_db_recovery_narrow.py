"""
Only a damaged database is treated as damaged (core/sessions.open_or_recover).

Recovery renames the live sessions.db aside and starts again. That is right for
a corrupt file and catastrophic for a healthy one: every session, notebook,
board, story and CV disappears from the app at once, while the data sits intact
on disk with nothing offering it back.

It caught too much. `sqlite3.OperationalError` is a `DatabaseError`, so
"database is locked", "unable to open database file" and "attempt to write a
readonly database" all triggered it — none of which mean the data is damaged.
And the daily backups it writes were never read by anything.
"""
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402


def rows(path) -> int:
    conn = sqlite3.connect(path)
    try:
        return conn.execute("SELECT count(*) FROM keep").fetchone()[0]
    finally:
        conn.close()


class OwnDatabase(unittest.TestCase):
    """
    A database of this test's own.

    These tests corrupt the file on purpose, and the suite shares one database
    between its tests — so doing that to the shared one wrecks whatever runs
    next. It did: four unrelated export tests failed in the full run and passed
    on their own.
    """

    def setUp(self):
        sess.release_connection()
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(sess.release_connection)
        here = Path(self.tmp.name)
        for name, value in (("DB_DIR", here), ("DB_PATH", here / "sessions.db")):
            patch = mock.patch.object(sess, name, value)
            patch.start()
            self.addCleanup(patch.stop)
        sess.RECOVERED.clear()
        self.addCleanup(sess.RECOVERED.clear)


class WhatCountsAsDamagedTest(OwnDatabase):
    def setUp(self):
        super().setUp()
        conn = sqlite3.connect(sess.DB_PATH)
        conn.execute("CREATE TABLE IF NOT EXISTS keep (what TEXT)")
        conn.execute("INSERT INTO keep VALUES ('a session the user cares about')")
        conn.commit()
        conn.close()

    def moved_aside(self):
        return list(sess.DB_PATH.parent.glob(f"{sess.DB_PATH.name}.corrupt-*"))

    def test_a_locked_database_is_not_moved_aside(self):
        # The file is fine; something else has it for a moment.
        with mock.patch.object(sess.sqlite3, "connect",
                               side_effect=sqlite3.OperationalError("database is locked")):
            sess.open_or_recover()
        self.assertEqual(self.moved_aside(), [], "a locked database was treated as corrupt")
        self.assertEqual(rows(sess.DB_PATH), 1, "the user's data is still there")

    def test_neither_is_a_read_only_folder_or_an_unopenable_file(self):
        for message in ("attempt to write a readonly database",
                        "unable to open database file",
                        "disk I/O error"):
            with self.subTest(message):
                with mock.patch.object(sess.sqlite3, "connect",
                                       side_effect=sqlite3.OperationalError(message)):
                    sess.open_or_recover()
                self.assertEqual(self.moved_aside(), [], message)

    def test_a_genuinely_corrupt_file_is_still_moved_aside(self):
        # The case recovery exists for: keep doing it.
        sess.DB_PATH.write_bytes(b"this is not a database at all")
        sess.open_or_recover()
        self.assertTrue(self.moved_aside(), "a corrupt database should be moved aside")
        self.assertTrue(sess.RECOVERED.get("reason"))


class PuttingSomethingBackTest(OwnDatabase):
    def test_a_good_backup_is_restored_instead_of_starting_empty(self):
        # Three of these are written every day and nothing has ever read one.
        backup = sess.DB_PATH.with_name(f"{sess.DB_PATH.name}.backup-20260922")
        conn = sqlite3.connect(backup)
        conn.execute("CREATE TABLE keep (what TEXT)")
        conn.execute("INSERT INTO keep VALUES ('yesterday')")
        conn.commit()
        conn.close()

        sess.DB_PATH.write_bytes(b"corrupt")
        sess.open_or_recover()

        self.assertEqual(rows(sess.DB_PATH), 1, "yesterday's copy should be back in place")
        self.assertIn("restored_from", sess.RECOVERED)

    def test_a_corrupt_backup_is_not_restored(self):
        bad = sess.DB_PATH.with_name(f"{sess.DB_PATH.name}.backup-20260922")
        bad.write_bytes(b"also not a database")
        sess.DB_PATH.write_bytes(b"corrupt")
        sess.open_or_recover()
        self.assertNotIn("restored_from", sess.RECOVERED)
        self.assertTrue(sess.RECOVERED.get("moved_to"), "the corrupt live file still moves aside")

    def test_a_full_disk_does_not_stop_the_app_starting(self):
        # The daily copy raised OSError, which was not caught, so the first
        # launch of the day on a full disk failed the import and left the user
        # on "the engine didn't start".
        conn = sqlite3.connect(sess.DB_PATH)
        conn.execute("CREATE TABLE keep (what TEXT)")
        conn.commit()
        conn.close()

        class OutOfSpace:
            """A connection that behaves normally until asked to copy itself."""

            def __init__(self, real):
                self._real = real

            def __getattr__(self, name):
                return getattr(self._real, name)

            def __enter__(self):
                return self._real.__enter__()

            def __exit__(self, *exc):
                return self._real.__exit__(*exc)

            def backup(self, *a, **k):
                raise OSError(28, "No space left on device")

        real_connect = sqlite3.connect

        def connect(path, *a, **k):
            return OutOfSpace(real_connect(path, *a, **k))

        with mock.patch.object(sess.sqlite3, "connect", connect):
            sess.open_or_recover()      # must not raise
        self.assertEqual(rows(sess.DB_PATH), 0, "and the live database is untouched")
        self.assertEqual(list(sess.DB_PATH.parent.glob(f"{sess.DB_PATH.name}.backup-*")), [],
                         "a half-written copy should not be left behind")


if __name__ == "__main__":
    unittest.main()
