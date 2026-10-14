"""
Choosing the port the app listens on (backend/main_bundled.py).

The app used to insist on 127.0.0.1:8000. Anything else holding that port — a
second copy of iReliabee, a development server, any web framework in the world
— killed the backend at startup, and the splash blamed the user's antivirus.
It happened to the owner on 2026-09-23, and cost an hour of looking in the
wrong place.

The port is now asked of the operating system, and the number is reported only
after the socket is bound, by the process holding it: there is no moment when a
port has been chosen but not yet owned. These pin down that property, and the
seam it depends on — a report that has to reach a pipe after stdout has been
pointed at the log file.
"""
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import main_bundled  # noqa: E402

IS_WINDOWS = sys.platform == "win32"


def held(port: int = 0) -> socket.socket:
    """A socket sitting on a port, the way another program would."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", port))
    sock.listen(1)
    return sock


class WhichPortIsAskedForTest(unittest.TestCase):
    def test_nothing_asked_for_means_any_free_one(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(main_bundled._wanted_port(), 0)

    def test_a_port_the_app_asked_for_is_honoured(self):
        with mock.patch.dict(os.environ, {"INTERVIEW_COACH_PORT": "8123"}, clear=True):
            self.assertEqual(main_bundled._wanted_port(), 8123)

    def test_nonsense_is_not_a_port(self):
        # A setting left over from an older version, or a typo: fall back to
        # letting the OS choose rather than crashing at startup.
        for bad in ("", "  ", "eight thousand", "-1", "99999", "80.5"):
            with mock.patch.dict(os.environ, {"INTERVIEW_COACH_PORT": bad}, clear=True):
                self.assertEqual(main_bundled._wanted_port(), 0, bad)


class TakingThePortTest(unittest.TestCase):
    def test_zero_gets_a_real_port_from_the_os(self):
        sock = main_bundled._bind("127.0.0.1", 0)
        self.addCleanup(sock.close)
        port = sock.getsockname()[1]
        self.assertGreater(port, 0)
        self.assertLessEqual(port, 65535)

    def test_the_port_is_ours_the_moment_we_know_it(self):
        # The property the whole design rests on: the number is learnt from a
        # socket that is already bound, so nothing can take it in between.
        sock = main_bundled._bind("127.0.0.1", 0)
        self.addCleanup(sock.close)
        port = sock.getsockname()[1]
        with self.assertRaises(OSError):
            main_bundled._bind("127.0.0.1", port)

    def test_binding_a_taken_port_is_refused(self):
        # `_bind` itself never wanders: it takes the port it was given or says
        # it could not. Deciding what to do about that is main()'s job, and it
        # takes a free one instead (WhenTheAskedForPortIsTakenTest).
        other = held()
        self.addCleanup(other.close)
        with self.assertRaises(OSError):
            main_bundled._bind("127.0.0.1", other.getsockname()[1])

    def test_a_failed_bind_leaves_no_socket_behind(self):
        other = held()
        self.addCleanup(other.close)
        before = _open_sockets()
        with self.assertRaises(OSError):
            main_bundled._bind("127.0.0.1", other.getsockname()[1])
        self.assertLessEqual(_open_sockets(), before, "the failed attempt leaked its socket")

    @unittest.skipUnless(IS_WINDOWS, "SO_EXCLUSIVEADDRUSE is a Windows option")
    def test_on_windows_nobody_may_bind_alongside_us(self):
        # Without this, another process can bind the same address with
        # SO_REUSEADDR and take connections meant for us.
        sock = main_bundled._bind("127.0.0.1", 0)
        self.addCleanup(sock.close)
        self.assertTrue(sock.getsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE))
        self.assertFalse(sock.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR))


def _open_sockets() -> int:
    """A rough count of this process's sockets, for the leak check."""
    import gc
    return sum(1 for o in gc.get_objects() if isinstance(o, socket.socket))


class WhenTheAskedForPortIsTakenTest(unittest.TestCase):
    """
    A port named in the environment is a preference, not a demand.

    A stray INTERVIEW_COACH_PORT left by an old install, or inherited from a
    parent shell, must not be able to stop the app starting — that is the
    failure this whole file exists to remove, and demanding the port put it
    back in through the side door.
    """

    def test_it_takes_a_free_port_instead_of_refusing_to_start(self):
        other = held()
        self.addCleanup(other.close)
        taken = other.getsockname()[1]
        said = []
        with (
            mock.patch.object(main_bundled, "_report", said.append),
            mock.patch.dict(os.environ, {"INTERVIEW_COACH_PORT": str(taken)}, clear=True),
            mock.patch.object(main_bundled, "_ensure_streams", lambda: None),
            mock.patch.object(main_bundled, "_parent_pid", lambda: None),
            mock.patch("uvicorn.Server") as server,
            mock.patch.dict("sys.modules", {"backend.main": mock.MagicMock()}),
        ):
            main_bundled.main()

        told = " ".join(said)
        self.assertIn(main_bundled.BIND_FAILED_LINE, told, "it should say the asked-for port was busy")
        port_lines = [l for l in said if l.startswith(main_bundled.PORT_LINE)]
        self.assertTrue(port_lines, "it should still announce a port it did get")
        got = int(port_lines[-1].split()[1])
        self.assertNotEqual(got, taken)
        self.assertGreater(got, 0)
        self.assertTrue(server.called, "and it should go on to serve")


class WatchingTheAppTest(unittest.TestCase):
    """
    The backend stops when the app does — and only then.

    `os._exit(0)` used to sit outside the guard that checks the app's process
    could be watched at all. Where OpenProcess is refused — endpoint protection
    hooking process access, a restricted token — the watchdog waited on nothing
    and killed the backend milliseconds after startup, before the port was
    bound, with exit code 0 so the log read as a clean shutdown.
    """

    @unittest.skipUnless(IS_WINDOWS, "the handle path is Windows-only")
    def test_a_refused_handle_falls_back_to_asking_rather_than_exiting(self):
        import ctypes
        said, alive = [], [True, True, False]
        with (
            mock.patch.object(main_bundled, "_report", said.append),
            mock.patch.object(main_bundled, "_parent_alive", lambda pid: alive.pop(0) if alive else False),
            mock.patch.object(ctypes.windll.kernel32, "OpenProcess", lambda *a: 0),
            mock.patch.object(main_bundled.time, "sleep", lambda s: None),
        ):
            main_bundled._watch_parent(4321)      # returns only when the app is gone
        self.assertIn(main_bundled.WATCH_FALLBACK_LINE, " ".join(said),
                      "it should say it is watching the slow way")
        self.assertEqual(alive, [], "it should have kept asking until the app went")

    def test_it_returns_when_the_app_is_gone(self):
        with (
            mock.patch.object(main_bundled, "_parent_alive", lambda pid: False),
            mock.patch.object(main_bundled, "_report", lambda line: None),
        ):
            main_bundled._watch_parent(4321)      # must not hang


class SayingWhichPortTest(unittest.TestCase):
    """
    The report has to reach the pipe the desktop app reads, which is the
    fragile part: by the time it is sent, `sys.stdout` points at the log file
    and only the raw descriptor still reaches the app.
    """

    def test_the_line_reaches_the_descriptor_the_app_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            pipe = Path(tmp) / "fd1"
            with open(pipe, "w", encoding="utf-8") as f:
                saved = os.dup(1)
                try:
                    os.dup2(f.fileno(), 1)
                    main_bundled._report(f"{main_bundled.PORT_LINE} 49812")
                finally:
                    os.dup2(saved, 1)
                    os.close(saved)
            self.assertIn("IRELIABEE_PORT 49812", pipe.read_text(encoding="utf-8"))

    def test_it_still_reaches_the_app_once_stdout_is_the_log_file(self):
        # _ensure_streams() replaces sys.stdout with the log; the descriptor
        # underneath is untouched, and that is what carries the port.
        with tempfile.TemporaryDirectory() as tmp:
            pipe = Path(tmp) / "fd1"
            log = Path(tmp) / "log"
            with open(pipe, "w", encoding="utf-8") as f, open(log, "w", encoding="utf-8") as l:
                saved_fd, saved_stdout = os.dup(1), sys.stdout
                try:
                    os.dup2(f.fileno(), 1)
                    sys.stdout = l                       # what _ensure_streams does
                    main_bundled._report(f"{main_bundled.PORT_LINE} 49813")
                finally:
                    sys.stdout = saved_stdout
                    os.dup2(saved_fd, 1)
                    os.close(saved_fd)
            self.assertIn("IRELIABEE_PORT 49813", pipe.read_text(encoding="utf-8"))
            self.assertIn("IRELIABEE_PORT 49813", log.read_text(encoding="utf-8"),
                          "the log should carry it too, for a user reporting a problem")

    def test_no_pipe_at_all_is_not_a_crash(self):
        # Started by hand, or a windowed build with nothing on the other end.
        with mock.patch.object(main_bundled.os, "write", side_effect=OSError(9, "Bad file descriptor")):
            main_bundled._report(f"{main_bundled.PORT_LINE} 1234")   # must not raise


if __name__ == "__main__":
    unittest.main()
