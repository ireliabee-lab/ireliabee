"""
Links that have to come back to us carry the port we are really on.

Sign-in and calendar connect both send the browser away with a URL pointing at
this backend, and the browser has to find its way home. That port used to be
read off the request's Host header, falling back to 8000 — fine while the app
insisted on 8000, wrong now that it takes whatever port the computer gives it.
A caller can write any Host it likes; only the socket knows the truth.
"""
import unittest

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.routers.calendar import _our_port  # noqa: E402


class Request:
    """Just enough of a Starlette request: what it is serving on, and what was asked."""

    def __init__(self, server, host_port=None):
        self.scope = {"server": server}
        self.url = type("U", (), {"port": host_port})()


class WhichPortWeAreOnTest(unittest.TestCase):
    def test_it_is_the_socket_we_are_serving_on(self):
        self.assertEqual(_our_port(Request(("127.0.0.1", 49812))), 49812)

    def test_a_host_header_does_not_get_to_decide(self):
        # The socket says 49812; the caller wrote something else in Host. A
        # link built from the caller's number would never come back to us.
        self.assertEqual(_our_port(Request(("127.0.0.1", 49812), host_port=1234)), 49812)

    def test_a_request_with_no_port_in_its_host_is_still_answered_correctly(self):
        # "Host: 127.0.0.1" with no port used to fall back to 8000 — a number
        # nobody is listening on once the port is chosen at startup.
        self.assertEqual(_our_port(Request(("127.0.0.1", 49812), host_port=None)), 49812)

    def test_without_a_socket_it_falls_back_to_what_was_asked(self):
        # A test client or an ASGI server that does not fill in "server".
        self.assertEqual(_our_port(Request(None, host_port=8123)), 8123)
        self.assertEqual(_our_port(Request((), host_port=8123)), 8123)

    def test_and_to_the_old_default_when_there_is_nothing_at_all(self):
        self.assertEqual(_our_port(Request(None, host_port=None)), 8000)


if __name__ == "__main__":
    unittest.main()
