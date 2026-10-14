"""
A sign-in renewal must not freeze the app, or be read out as a sign-out.

Two faults in one path (audit rough edges 5a and 5b).

The renewal is a blocking HTTPS request, and it was made on the event loop from
inside the speech socket's setup. On a network that has gone away — coming back
from sleep is the ordinary way — the whole window froze until it timed out, once
per source, so Auto froze for about twice as long again. Mid-interview.

Then, because the renewal failed, the old access token went to the relay, the
relay answered 401, and the user was told "Your sign-in has expired. Open
Settings and choose Your account." Their sign-in was fine. The connection had
dropped, the problem fixed itself, and they were sent hunting through Settings
for it.
"""
import asyncio
import time
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import deepgram_stream, errors  # noqa: E402
from backend.core import account  # noqa: E402


class StillAnsweringWhileItRenewsTest(unittest.TestCase):
    #: Long enough to stand out against the heartbeat below, short enough that
    #: the test stays quick. Stands in for a renewal on a network that has gone.
    RENEWAL_SECONDS = 0.4

    def ticks_while_opening_a_speech_socket(self) -> int:
        """
        How many times the loop got a turn while the socket was being opened.

        Counted *during* the call and not after: waiting for the heartbeat to
        finish would count the ticks it made once the block was over, which is
        how the first version of this test passed with the bug still in place.
        """
        ticks: list = []

        def slow_endpoint(language=None):
            time.sleep(self.RENEWAL_SECONDS)
            return "wss://example.invalid/stt/listen", {}

        async def go() -> int:
            stop = asyncio.Event()

            async def heartbeat():
                while not stop.is_set():
                    await asyncio.sleep(0.02)
                    ticks.append(1)

            beat = asyncio.create_task(heartbeat())
            await asyncio.sleep(0)               # let it get going
            ticks.clear()
            session = deepgram_stream.DeepgramSession()
            with mock.patch("backend.core.hosted.deepgram_endpoint", slow_endpoint),                     mock.patch.object(deepgram_stream.websockets, "connect",
                                      mock.AsyncMock(return_value=mock.MagicMock())):
                await session.__aenter__()
            during = len(ticks)
            stop.set()
            await beat
            return during

        return asyncio.run(go())

    def test_the_app_keeps_answering_while_the_sign_in_is_renewed(self):
        # On the loop this froze the whole window until the request timed out,
        # once per source — so Auto froze for about twice as long again.
        self.assertGreaterEqual(
            self.ticks_while_opening_a_speech_socket(), 5,
            "the app must keep answering while the sign-in is renewed",
        )


class TellingTheTwoApartTest(unittest.TestCase):
    """`_unreachable_since` is module state, so every test here resets it."""

    def setUp(self):
        account._unreachable_since.update(at=0.0)
        self.addCleanup(account._unreachable_since.update, at=0.0)

    def test_a_renewal_the_network_ate_is_remembered(self):
        with mock.patch.object(account, "_post",
                               side_effect=account.AccountUnreachable("offline")):
            self.assertEqual(account._refresh("old", "r"), "old", "the old token is kept")
        self.assertTrue(account.refresh_unreachable())

    def test_a_renewal_the_service_refused_is_not_called_offline(self):
        # Revoked is not the same as unplugged: this one really must sign in.
        with mock.patch.object(account, "_post",
                               side_effect=account.AccountError("Please sign in again.")):
            account._refresh("old", "r")
        self.assertFalse(account.refresh_unreachable())

    def test_a_renewal_that_works_forgets_the_outage(self):
        account._unreachable_since["at"] = time.time()
        with mock.patch.object(account, "_post",
                               return_value={"access_token": "new", "account": {}}):
            account._refresh("old", "r")
        self.assertFalse(account.refresh_unreachable())

    def test_an_outage_is_forgotten_once_it_is_old_news(self):
        account._unreachable_since["at"] = time.time() - (account.UNREACHABLE_WINDOW_SECONDS + 5)
        self.assertFalse(account.refresh_unreachable())


class WhatTheUserIsToldTest(unittest.TestCase):
    def setUp(self):
        account._unreachable_since.update(at=0.0)
        self.addCleanup(account._unreachable_since.update, at=0.0)
        # An ordinary signed-in account, the way test_hosted.py does it.
        from backend.core import hosted
        for patch in (mock.patch.object(hosted.account, "status",
                                        return_value={"signed_in": True, "admin": False}),
                      mock.patch.object(hosted.account, "access_token", return_value="ira-token")):
            patch.start()
            self.addCleanup(patch.stop)

    def refused(self):
        class Unauthorized(Exception):
            status_code = 401
        return errors.classify(Unauthorized("Error code: 401"), "deepgram")

    def test_a_dropped_connection_does_not_claim_the_sign_in_expired(self):
        account._unreachable_since["at"] = time.time()
        e = self.refused()
        self.assertEqual(e.code, "signed_out", "the screen must still stop listening")
        self.assertIsNone(e.action, "a dropped connection must not send anyone to Settings")
        self.assertNotIn("expired", f"{e.title} {e.message}".lower())
        self.assertIn("connection", e.message.lower())

    def test_a_sign_in_that_really_did_expire_still_says_so(self):
        e = self.refused()
        self.assertEqual(e.code, "signed_out")
        self.assertEqual(e.action, "settings")
        self.assertIn("expired", e.message.lower())


if __name__ == "__main__":
    unittest.main()
