"""
Clearing what earlier runs left behind (backend/main_bundled._sweep_unpacked).

The packaged backend is a one-file build: it unpacks about 95 MB of itself to
run, and the bootloader deletes that copy when the real process exits. The
desktop app terminates the bootloader, so the delete never happened. Measured
on the owner's machine on 2026-09-23: eleven folders, 999 MB, with nothing
running — growing by 95 MB every time he opened the app, with nothing on screen
ever connecting it to iReliabee.

The unpack now goes somewhere the app owns and is swept on the way up. The care
these tests take is about the other half of that: the shared temp folder is
where every PyInstaller program on the machine unpacks, so sweeping the wrong
directory would delete other people's software.
"""
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import main_bundled  # noqa: E402

OLD = main_bundled.UNPACK_KEEP_S + 3600


def aged(path: Path, seconds_old: float) -> Path:
    """
    An unpacked copy that was last touched that long ago.

    It carries a `python*.dll`, because a real one does and the sweeper reads it:
    that file is how it tells a copy something is still running from (its DLL is
    loaded, so it cannot be opened for writing) from a dead leftover. A fixture
    without one is not the shape the bootloader produces, and the sweeper would
    rightly leave it alone.
    """
    path.mkdir(parents=True, exist_ok=True)
    (path / "python312.dll").write_bytes(b"MZ not really a dll")
    when = time.time() - seconds_old
    import os
    os.utime(path, (when, when))
    return path


class SweepingOurOwnLeftoversTest(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # …/<parent>/cache/_MEIxxxx — the shape the build spec produces, taken
        # from the constants rather than spelled out, so the two cannot drift.
        self.cache = (Path(self.tmp.name) / main_bundled.CACHE_PARENT_NAME
                      / main_bundled.CACHE_DIR_NAME)
        self.running = aged(self.cache / "_MEIrunning", 0)

    def sweep(self, here=None):
        with mock.patch.object(main_bundled.sys, "_MEIPASS", str(here or self.running), create=True):
            main_bundled._sweep_unpacked()

    def test_an_old_copy_from_a_previous_run_is_removed(self):
        stale = aged(self.cache / "_MEIold", OLD)
        self.sweep()
        self.assertFalse(stale.exists())

    def test_the_copy_we_are_running_from_is_never_touched(self):
        # It is the oldest thing there on a long session, and deleting it
        # would pull the floor out from under the running backend.
        aged(self.running, OLD)
        self.sweep()
        self.assertTrue(self.running.exists())

    def test_a_copy_still_warm_is_left_alone(self):
        # A copy part-way through unpacking itself: its DLLs are written but not
        # loaded yet, so `_in_use` cannot see it and only its age saves it.
        # Half the window rather than a fixed number of seconds — spelling the
        # number out here is what broke this test when the window moved.
        fresh = aged(self.cache / "_MEIfresh", main_bundled.UNPACK_KEEP_S / 2)
        self.sweep()
        self.assertTrue(fresh.exists())

    def test_it_clears_a_backlog_in_one_go(self):
        stale = [aged(self.cache / f"_MEI{i}", OLD) for i in range(11)]
        self.sweep()
        self.assertEqual([d for d in stale if d.exists()], [])

    def test_a_half_removed_folder_is_still_tried_again(self):
        # Observed on a real run: a sweep that cannot finish deletes what it
        # can, and removing those children updates the folder's modified time
        # — so judged by that alone a half-removed folder looks brand new and
        # is skipped on the next launch too, outliving the code written to
        # remove it. Age comes from the earlier of the two stamps, which on
        # Windows means the folder's creation.
        #
        # A test cannot set a creation time, so this drives the decision the
        # real case produces: created long ago, touched a moment ago.
        stale = aged(self.cache / "_MEIhalfgone", 0)
        (stale / "leftover.dll").write_bytes(b"x")
        with mock.patch.object(main_bundled, "_age_of",
                               lambda f: time.time() - OLD if f.name == "_MEIhalfgone" else time.time()):
            self.sweep()
        self.assertFalse(stale.exists(), "a half-removed folder was skipped as if it were new")

    def test_age_is_taken_from_whichever_stamp_is_older(self):
        import os
        folder = self.cache / "_MEIstamps"
        folder.mkdir(parents=True, exist_ok=True)
        long_ago = time.time() - OLD
        os.utime(folder, (long_ago, long_ago))
        stat = folder.stat()
        # Whatever this platform puts in the two stamps, the older wins.
        self.assertEqual(main_bundled._age_of(folder), min(stat.st_mtime, stat.st_ctime))
        self.assertLessEqual(main_bundled._age_of(folder), time.time() - OLD + 5)

    def test_a_folder_it_cannot_remove_does_not_stop_the_app(self):
        aged(self.cache / "_MEIlocked", OLD)
        with mock.patch.object(main_bundled.shutil, "rmtree", side_effect=OSError(13, "in use")):
            self.sweep()      # must not raise: the app has to start regardless


class StillBeingRunFromTest(unittest.TestCase):
    """
    A copy something is still running out of is spared, whatever its age.

    Age alone cannot tell a dead leftover from an app that has been open all
    afternoon, and waiting out a timer instead meant five launches in half an
    hour sitting on 483 MB. The test used here is the one Windows gives for
    free: a live process holds its Python DLL open, and a loaded DLL cannot be
    opened for writing.

    `rmtree` is no use as that test, which is the point of asking first — it
    deletes whatever is not locked *before* it reaches the file that is, so
    asking it would mean taking files out from under a live session.
    """

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache = (Path(self.tmp.name) / main_bundled.CACHE_PARENT_NAME
                      / main_bundled.CACHE_DIR_NAME)
        self.running = aged(self.cache / "_MEIrunning", 0)

    def sweep(self):
        with mock.patch.object(main_bundled.sys, "_MEIPASS", str(self.running), create=True):
            main_bundled._sweep_unpacked()

    def test_a_dead_leftover_is_taken_at_once_rather_than_waiting_out_a_timer(self):
        stale = aged(self.cache / "_MEIdead", main_bundled.UNPACK_KEEP_S + 1)
        self.sweep()
        self.assertFalse(stale.exists())

    def test_a_copy_being_run_from_is_spared_however_old_it_is(self):
        # The app open all afternoon. Its folder is the oldest thing there.
        live = aged(self.cache / "_MEIlive", OLD)
        with mock.patch.object(main_bundled, "_in_use", lambda f: f.name == "_MEIlive"):
            self.sweep()
        self.assertTrue(live.exists(), "a live copy must not be swept")
        self.assertEqual(len(list(live.iterdir())), 1,
                         "and not partly swept either: nothing may be taken from under it")

    def test_a_folder_that_is_not_our_shape_is_left_alone(self):
        # No python*.dll: not something the bootloader made, so not ours to judge.
        odd = self.cache / "_MEIsomethingelse"
        odd.mkdir(parents=True)
        (odd / "whatever.txt").write_text("hello", encoding="utf-8")
        when = time.time() - OLD
        import os
        os.utime(odd, (when, when))
        self.assertTrue(main_bundled._in_use(odd), "an unfamiliar shape counts as in use")
        self.sweep()
        self.assertTrue(odd.exists())

    def test_a_dll_that_cannot_be_opened_counts_as_in_use(self):
        folder = aged(self.cache / "_MEIlocked", OLD)
        with mock.patch.object(main_bundled.os, "open", side_effect=OSError(13, "in use")):
            self.assertTrue(main_bundled._in_use(folder))

    def test_a_readable_dll_means_nothing_is_running_from_it(self):
        self.assertFalse(main_bundled._in_use(aged(self.cache / "_MEIidle", OLD)))

    def test_a_launch_still_unpacking_is_protected_by_its_age(self):
        # The one live copy the in-use test cannot see: its DLLs are still being
        # written, so nothing holds them open yet.
        starting = aged(self.cache / "_MEIstarting", 1)
        self.assertFalse(main_bundled._in_use(starting), "not yet loaded, so it reads as idle")
        self.sweep()
        self.assertTrue(starting.exists(), "too recent to touch, which is what saves it")


class NotTheInstallFolderTest(unittest.TestCase):
    """
    The unpack folder is not the folder the app is installed into.

    It was. The installer puts the app in ``%LOCALAPPDATA%\iReliabee`` and the
    spec unpacked to ``%LOCALAPPDATA%\ireliabee\cache`` — the same directory,
    because Windows does not distinguish the case — so every launch wrote 95 MB
    of itself into its own install directory, next to the executable the
    installer and the updater both have to replace.

    Nothing in the unit tests could see it and nothing in the code looked wrong.
    It took installing the app and listing the folder.
    """

    def product_name(self) -> str:
        """What the installer calls the install folder (Tauri's productName)."""
        import json
        conf = (Path(__file__).resolve().parents[2]
                / "frontend" / "src-tauri" / "tauri.conf.json")
        return json.loads(conf.read_text(encoding="utf-8"))["productName"]

    def test_the_unpack_parent_is_not_the_install_folder(self):
        self.assertNotEqual(main_bundled.CACHE_PARENT_NAME.lower(),
                            self.product_name().lower(),
                            "the unpack folder would be the app's own install directory")

    def spec(self) -> str:
        return (Path(__file__).resolve().parents[1]
                / "build" / "interview-coach-backend.spec").read_text(encoding="utf-8")

    def test_the_build_ships_a_folder_rather_than_unpacking_itself(self):
        # The whole point: read the libraries in place and there is no copy to
        # leave behind, no extraction to wait for, and nothing to sweep. A spec
        # that quietly goes back to one-file brings all of it back.
        spec = self.spec()
        self.assertIn("exclude_binaries=True", spec)
        self.assertIn("COLLECT(", spec)

    def test_nothing_is_unpacked_at_runtime_any_more(self):
        self.assertNotIn("runtime_tmpdir=", self.spec(),
                         "a runtime_tmpdir means it is extracting itself again")


class NotOurFolderTest(unittest.TestCase):
    """The half that matters most: never touch anybody else's unpacked app."""

    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_it_will_not_sweep_a_shared_temp_folder(self):
        # What a default build does: unpack straight into %TEMP%, alongside
        # every other PyInstaller program on the machine.
        shared = Path(self.tmp.name) / "Temp"
        ours = aged(shared / "_MEIours", 0)
        someone_else = aged(shared / "_MEItheirs", OLD)
        with mock.patch.object(main_bundled.sys, "_MEIPASS", str(ours), create=True):
            main_bundled._sweep_unpacked()
        self.assertTrue(someone_else.exists(), "another program's files were deleted")

    def test_a_lookalike_path_is_not_enough(self):
        # "cache" alone does not make it ours.
        other = Path(self.tmp.name) / "someapp" / "cache"
        ours = aged(other / "_MEIours", 0)
        theirs = aged(other / "_MEItheirs", OLD)
        with mock.patch.object(main_bundled.sys, "_MEIPASS", str(ours), create=True):
            main_bundled._sweep_unpacked()
        self.assertTrue(theirs.exists())

    def test_a_folder_build_has_nothing_to_sweep(self):
        # What ships: the libraries sit in an `_internal` folder beside the exe
        # and are read in place, so no copy is ever made. The sweeper says so
        # outright rather than reaching its folder-name guard and declining.
        exe = Path(self.tmp.name) / "iReliabee" / "interview-coach-backend.exe"
        internal = exe.parent / "_internal"
        internal.mkdir(parents=True)
        leftover = aged(exe.parent / "_internal-old", OLD)
        with mock.patch.object(main_bundled.sys, "_MEIPASS", str(internal), create=True), \
                mock.patch.object(main_bundled.sys, "executable", str(exe)):
            self.assertTrue(main_bundled._is_folder_build())
            main_bundled._sweep_unpacked()
        self.assertTrue(leftover.exists(), "a folder build must not go looking for things to delete")

    def test_a_one_file_build_is_not_mistaken_for_a_folder_one(self):
        # An upgrading user can still have one-file leftovers, so the old path
        # has to keep working.
        exe = Path(self.tmp.name) / "iReliabee" / "interview-coach-backend.exe"
        exe.parent.mkdir(parents=True, exist_ok=True)
        unpacked = Path(self.tmp.name) / "somewhere-else" / "cache" / "_MEIrunning"
        unpacked.mkdir(parents=True)
        with mock.patch.object(main_bundled.sys, "_MEIPASS", str(unpacked), create=True), \
                mock.patch.object(main_bundled.sys, "executable", str(exe)):
            self.assertFalse(main_bundled._is_folder_build())

    def test_running_from_source_sweeps_nothing(self):
        # No _MEIPASS: a developer running `python -m backend.main_bundled`.
        with mock.patch.object(main_bundled.sys, "_MEIPASS", None, create=True):
            main_bundled._sweep_unpacked()      # must simply do nothing

    def test_a_vanished_folder_is_not_an_error(self):
        missing = (Path(self.tmp.name) / main_bundled.CACHE_PARENT_NAME
                   / main_bundled.CACHE_DIR_NAME / "_MEIgone")
        with mock.patch.object(main_bundled.sys, "_MEIPASS", str(missing), create=True):
            main_bundled._sweep_unpacked()      # must not raise


if __name__ == "__main__":
    unittest.main()
