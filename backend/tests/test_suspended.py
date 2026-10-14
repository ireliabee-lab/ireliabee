"""
A suspended account is told it is suspended — not signed out, not "try again".

An admin can block an account from the backoffice, and our relay says so in
two places: it refuses the speech socket's handshake with HTTP 403, and it ends
a live call or voice mock already running with close code 4403 — beside the
4402 it has always used for "out of credits" (website/server/billing.js).

The wrong words here are worse than none. "Speech recognition stopped… start
listening again" invites a retry that can only be refused, and "please sign in
again" starts a sign-in the service will turn down too — a loop that never says
why. Both paths are pinned against the real `websockets` exceptions, since the
library's shape (which attribute carries the status, which frame the code is
on) is exactly what changed under us between its legacy and asyncio clients.
"""
import asyncio
import contextlib
import time
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)

import websockets
import websockets.frames
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.http11 import Response

from backend import deepgram_stream, errors
from backend.core import hosted

#: Word for word what the relay writes when it refuses a handshake
#: (`refuse()` in website/server/stt.js): no body, no Content-Length, and the
#: connection closed straight after.
RELAY_REFUSAL = "HTTP/1.1 {status} {message}\r\nConnection: close\r\n\r\n"
SUSPENDED_403 = (403, "Forbidden: this account has been suspended")
UNAUTHORIZED_401 = (401, "Unauthorized")


def ordinary_account():
    """Signed in, not the admin: every call goes through our service."""
    return [
        mock.patch.object(hosted.account, "status", return_value={"signed_in": True, "admin": False}),
        mock.patch.object(hosted.account, "access_token", return_value="ira-token"),
        # A 401 just after a refresh the network ate has its own wording
        # (test_refresh_not_on_the_loop); these tests are not about that.
        mock.patch.object(hosted.account, "refresh_unreachable", return_value=False),
        # Nor about the suspension that arrives late through a refused renewal
        # (LateSuspensionTest below).
        mock.patch.object(hosted.account, "refresh_suspended", return_value=False),
    ]


def closed_with(code, reason=""):
    return ConnectionClosed(websockets.frames.Close(code, reason), None)


@contextlib.asynccontextmanager
async def refusing_relay(status, message):
    """A socket on this machine that turns every handshake down the way the relay does."""
    async def answer(reader, writer):
        await reader.readuntil(b"\r\n\r\n")
        writer.write(RELAY_REFUSAL.format(status=status, message=message).encode())
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(answer, "127.0.0.1", 0)
    try:
        yield server.sockets[0].getsockname()[1]
    finally:
        server.close()
        await server.wait_closed()


class SuspendedTestCase(unittest.TestCase):
    def setUp(self):
        for p in ordinary_account():
            p.start()
            self.addCleanup(p.stop)


class RelayCloseTest(SuspendedTestCase):
    """The close codes the relay ends a session with, read in one place."""

    def test_4402_is_still_out_of_credits(self):
        self.assertEqual(errors.relay_closed(closed_with(4402, "You are out of credits.")).code,
                         "out_of_credits")

    def test_4403_is_a_suspended_account(self):
        e = errors.relay_closed(closed_with(4403, "This account has been suspended."))
        self.assertEqual(e.code, "account_suspended")
        self.assertIn("suspended", e.message)
        self.assertIsNone(e.action, "Settings cannot fix a block: signing in again is refused too")

    def test_every_other_close_is_not_ours_to_explain(self):
        for code in (1000, 1001, 1011, 4000, 4401, 4404):
            self.assertIsNone(errors.relay_closed(closed_with(code)), code)

    def test_a_connection_that_just_dropped_carries_no_code_at_all(self):
        self.assertIsNone(errors.relay_closed(ConnectionClosed(None, None)))

    def test_one_wording_however_the_news_arrived(self):
        by_close = errors.relay_closed(closed_with(4403)).as_dict()
        by_status = errors.classify(InvalidStatus(Response(*SUSPENDED_403, Headers())), "deepgram").as_dict()

        class ApiError(Exception):
            status_code = 403
        by_http = errors.classify(ApiError("This account has been suspended."), "anthropic").as_dict()
        self.assertEqual(by_close, errors.account_suspended().as_dict())
        self.assertEqual(by_status, by_close)
        self.assertEqual(by_http, by_close)


class LiveCallClosedTest(SuspendedTestCase):
    """A live call the relay ends part-way through (backend/deepgram_stream.py)."""

    def drain(self, code, reason=""):
        heard = []

        class RelaySaysThenCloses:
            """One transcript, then the relay's close frame."""
            def __init__(self):
                self.said = False

            def __aiter__(self):
                return self

            async def __anext__(self):
                if not self.said:
                    self.said = True
                    return ('{"type": "Results", "is_final": true,'
                            ' "channel": {"alternatives": [{"transcript": "so in my last role"}]}}')
                raise closed_with(code, reason)

        session = deepgram_stream.DeepgramSession(api_key="x")
        session.ws = RelaySaysThenCloses()

        async def run():
            async for msg in session.transcripts():
                heard.append(msg["text"])

        try:
            asyncio.run(run())
        except errors.FriendlyError as e:
            return heard, e
        return heard, None

    def test_a_block_mid_call_says_suspended(self):
        heard, why = self.drain(4403, "This account has been suspended.")
        self.assertEqual(why.code, "account_suspended")
        self.assertEqual(heard, ["so in my last role"], "what was said before the block still arrives")

    def test_running_out_mid_call_is_still_out_of_credits(self):
        _, why = self.drain(4402, "You are out of credits.")
        self.assertEqual(why.code, "out_of_credits")

    def test_other_closes_still_end_quietly(self):
        # audio.py turns a quiet end into "Speech recognition stopped", which
        # is the truth for these: the relay stopped, and trying again may work.
        for code in (1000, 1011):
            heard, why = self.drain(code)
            self.assertIsNone(why, code)
            self.assertEqual(heard, ["so in my last role"], code)

    def test_the_app_is_told_suspended_not_speech_stopped(self):
        from backend.routers.audio import _report_speech_ended

        sent = []

        class AppSocket:
            async def send_json(self, data):
                sent.append(data)

        async def relay_said_4403():
            raise errors.relay_closed(closed_with(4403))

        async def scenario():
            task = asyncio.get_running_loop().create_task(relay_said_4403())
            with contextlib.suppress(errors.FriendlyError):
                await task
            await _report_speech_ended(AppSocket(), task)

        asyncio.run(scenario())
        self.assertEqual([m["code"] for m in sent], ["account_suspended"])


class RefusedHandshakeTest(SuspendedTestCase):
    """
    A suspended account starting a call: the relay answers the upgrade with 403.

    Through the real client, against the relay's exact bytes, because what
    reaches classify() is whatever the pinned `websockets` makes of a response
    with no body and a closed connection — an `InvalidStatus` whose status sits
    on `.response.status_code`, and whose text holds only "HTTP 403", not the
    reason the relay gave.
    """

    def connect_live(self, status, message):
        async def scenario():
            async with refusing_relay(status, message) as port:
                url = f"ws://127.0.0.1:{port}/v1/stt/listen?language=en"
                with mock.patch.object(hosted, "deepgram_endpoint",
                                       return_value=(url, {"Authorization": "Bearer ira-token"})):
                    async with deepgram_stream.DeepgramSession():
                        self.fail("the relay refused this handshake")

        with self.assertRaises(Exception) as caught:
            asyncio.run(scenario())
        return caught.exception

    def test_what_the_library_raises(self):
        exc = self.connect_live(*SUSPENDED_403)
        self.assertIsInstance(exc, InvalidStatus)
        self.assertEqual(exc.response.status_code, 403)

    def test_a_403_handshake_is_a_suspended_account(self):
        e = errors.classify(self.connect_live(*SUSPENDED_403), "deepgram")
        self.assertEqual(e.code, "account_suspended")

    def test_a_401_handshake_is_still_signed_out(self):
        e = errors.classify(self.connect_live(*UNAUTHORIZED_401), "deepgram")
        self.assertEqual(e.code, "signed_out")
        self.assertEqual(e.action, "settings")

    def test_a_402_handshake_is_still_out_of_credits(self):
        e = errors.classify(self.connect_live(402, "Payment Required"), "deepgram")
        self.assertEqual(e.code, "out_of_credits")


class VoiceMockTest(SuspendedTestCase):
    """The voice mock hears the same news from the same relay (backend/routers/mock.py)."""

    def call(self, relay):
        """Run one voice mock against `relay`; return what the app was sent."""
        from backend.routers import mock as mock_router

        sent = []

        class AppSocket:
            def __init__(self):
                self.opened = False

            async def accept(self):
                pass

            async def receive_json(self):
                if not self.opened:
                    self.opened = True
                    return {"voice": "hannah"}
                await asyncio.Event().wait()        # the user never presses End

            async def send_json(self, data):
                sent.append(data)

            async def send_bytes(self, data):
                pass

            async def close(self):
                pass

        class Microphone:
            def stop(self):
                pass

            def close(self):
                pass

        async def scenario():
            async with contextlib.AsyncExitStack() as stack:
                url, connect = await relay(stack)
                for p in (
                    mock.patch.object(hosted, "agent_endpoint", return_value=(url, {"Authorization": "Bearer t"})),
                    mock.patch.object(mock_router, "_candidate_context", return_value=({}, "")),
                    mock.patch.object(mock_router, "_open_stream_for", return_value=(Microphone(), None)),
                    *([mock.patch.object(mock_router.websockets, "connect", connect)] if connect else []),
                ):
                    stack.enter_context(p)
                await asyncio.wait_for(mock_router.voice_mock(AppSocket()), timeout=10)

        asyncio.run(scenario())
        return sent

    @staticmethod
    def closing_with(code, reason=""):
        class Agent:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *exc):
                return False

            async def send(self, data):
                pass

            def __aiter__(self):
                return self

            async def __anext__(self):
                raise closed_with(code, reason)

        async def relay(stack):
            return "ws://relay.invalid/v1/agent/converse", lambda url, **kwargs: Agent()
        return relay

    @staticmethod
    def refusing(status, message):
        async def relay(stack):
            port = await stack.enter_async_context(refusing_relay(status, message))
            return f"ws://127.0.0.1:{port}/v1/agent/converse", None
        return relay

    def errors_in(self, sent):
        return [m["code"] for m in sent if m.get("type") == "error"]

    def test_a_block_mid_call_says_suspended(self):
        sent = self.call(self.closing_with(4403, "This account has been suspended."))
        self.assertEqual(self.errors_in(sent), ["account_suspended"])
        self.assertEqual(sent[-1]["type"], "ended", "the call still ends")

    def test_running_out_mid_call_is_still_out_of_credits(self):
        sent = self.call(self.closing_with(4402, "You are out of credits."))
        self.assertEqual(self.errors_in(sent), ["out_of_credits"])

    def test_an_ordinary_hang_up_is_not_an_error(self):
        sent = self.call(self.closing_with(1000))
        self.assertEqual(self.errors_in(sent), [])
        self.assertEqual(sent[-1]["type"], "ended")

    def test_a_refused_start_says_suspended(self):
        sent = self.call(self.refusing(*SUSPENDED_403))
        self.assertEqual(self.errors_in(sent), ["account_suspended"])

    def test_a_refused_start_with_401_is_still_signed_out(self):
        sent = self.call(self.refusing(*UNAUTHORIZED_401))
        self.assertEqual(self.errors_in(sent), ["signed_out"])



class LateSuspensionTest(unittest.TestCase):
    """
    The suspension that arrives fifteen minutes after the block.

    A block revokes every refresh token, so the app's next renewal is refused
    with 403 "suspended" — and the expired access token that leaves behind makes
    the next AI call a 401. Read out as "please sign in again", that starts a
    loop that can only be refused. The refusal is remembered, the way a renewal
    the network ate already is, so the 401 after it says "suspended".
    """

    def setUp(self):
        from backend.core import account
        self.account = account
        for flag in (account._suspended_since, account._unreachable_since):
            flag["at"] = 0.0
        self.addCleanup(account._suspended_since.update, {"at": 0.0})
        self.addCleanup(account._unreachable_since.update, {"at": 0.0})
        # Signed in, with the refresh token the renewals below send: a refusal
        # only counts for the sign-in that is still here when it comes back.
        account._save({"refresh_token": "r", "access_token": "a", "access_expires": 0,
                       "account": {"email": "ama@example.com", "admin": False}})
        self.addCleanup(account._clear)

    @staticmethod
    def answered(status, message):
        r = mock.Mock()
        r.status_code = status
        r.json.return_value = {"message": message}
        return r

    @staticmethod
    def expired_token():
        class Expired(Exception):
            status_code = 401
        return Expired("Please sign in again.")

    def test_a_suspended_answer_is_its_own_error(self):
        with mock.patch("requests.post", return_value=self.answered(403, "This account has been suspended. Email us.")):
            with self.assertRaises(self.account.AccountSuspended):
                self.account._post("/auth/refresh", {"refresh_token": "r"})

    def test_a_403_that_is_not_a_suspension_is_not_called_one(self):
        with mock.patch("requests.post", return_value=self.answered(403, "Not allowed from here.")):
            with self.assertRaises(self.account.AccountError) as caught:
                self.account._post("/v1/x", {})
        self.assertNotIsInstance(caught.exception, self.account.AccountSuspended)

    def test_the_401_after_a_suspended_renewal_says_suspended(self):
        refused = self.account.AccountSuspended("This account has been suspended.")
        with mock.patch.object(self.account, "_post", side_effect=refused):
            self.assertEqual(self.account._refresh("old-access", "r"), "old-access", "keeps what it had")
        self.assertTrue(self.account.refresh_suspended())
        said = errors.classify(self.expired_token(), "anthropic")
        self.assertEqual(said.as_dict(), errors.account_suspended().as_dict())
        self.assertIsNone(said.action, "no Settings button: signing in again is refused too")

    def test_unblocked_then_refused_for_a_revoked_token_is_sign_in_again(self):
        # After an unblock the old refresh token is still revoked, so the next
        # renewal is a plain refusal — and "sign in again" is now exactly right.
        with mock.patch.object(self.account, "_post", side_effect=self.account.AccountSuspended("suspended")):
            self.account._refresh("a", "r")
        with mock.patch.object(self.account, "_post", side_effect=self.account.AccountError("Please sign in again.")):
            self.account._refresh("a", "r")
        self.assertFalse(self.account.refresh_suspended())
        self.assertEqual(errors.classify(self.expired_token(), "anthropic").code, "signed_out")

    def test_a_renewal_that_works_clears_it(self):
        with mock.patch.object(self.account, "_post", side_effect=self.account.AccountSuspended("suspended")):
            self.account._refresh("a", "r")
        with (
            mock.patch.object(self.account, "_post", return_value={"access_token": "new"}),
            mock.patch.object(self.account, "_load", return_value={"refresh_token": "r"}),
            mock.patch.object(self.account, "_save"),
        ):
            self.account._refresh("a", "r")
        self.assertFalse(self.account.refresh_suspended())

    def test_a_suspended_balance_read_is_named_too(self):
        with mock.patch("requests.get", return_value=self.answered(403, "This account has been suspended.")):
            with self.assertRaises(self.account.AccountSuspended):
                self.account._get("/account", "tok")


class SuspensionBelongsToOneSignInTest(unittest.TestCase):
    """
    "Suspended" is about the sign-in whose renewal was refused, and no other.

    Signing in again hands the app a brand-new token, and its first renewal is
    about ten minutes away. A flag left from the sign-in before it (an account
    since unblocked, or someone else's) would read that new sign-in's first
    401 as "suspended" for all that time, and a signed-out app would carry it
    into whoever signs in next.
    """

    def setUp(self):
        from backend.core import account
        self.account = account
        for flag in (account._suspended_since, account._unreachable_since):
            flag["at"] = 0.0
        self.addCleanup(account._suspended_since.update, {"at": 0.0})
        self.addCleanup(account._unreachable_since.update, {"at": 0.0})
        self.addCleanup(account._clear)
        self.signed_in_as("ama@example.com", "r-ama")

    def signed_in_as(self, email, refresh):
        self.account._save({"refresh_token": refresh, "access_token": "a", "access_expires": 0,
                            "account": {"email": email, "admin": False}})

    def suspended_renewal(self, refresh="r-ama"):
        refused = self.account.AccountSuspended("This account has been suspended.")
        with mock.patch.object(self.account, "_post", side_effect=refused):
            self.account._refresh("a", refresh)

    @staticmethod
    def exchanged(email, refresh):
        return {"refresh_token": refresh, "access_token": "fresh",
                "account": {"email": email, "admin": False}}

    @staticmethod
    def expired_token():
        class Expired(Exception):
            status_code = 401
        return Expired("Please sign in again.")

    def test_the_renewal_did_mark_it(self):
        # The control: without it every test below passes on a flag never set.
        self.suspended_renewal()
        self.assertTrue(self.account.refresh_suspended())

    def test_signing_in_again_with_a_typed_code_clears_it(self):
        self.suspended_renewal()
        with mock.patch.object(self.account, "_exchange",
                               return_value=self.exchanged("ama@example.com", "r-new")):
            self.account.complete_with_code("ABCD-EFGH-JKLM", "ama@example.com")
        self.assertFalse(self.account.refresh_suspended())
        self.assertEqual(errors.classify(self.expired_token(), "anthropic").code, "signed_out",
                         "a 401 on the new sign-in is about that sign-in")

    def test_signing_in_over_loopback_clears_it(self):
        self.suspended_renewal()
        self.account._pending_state.update(value="nonce", until=time.time() + 60)
        self.addCleanup(self.account._pending_state.update, value=None, until=0.0)
        with mock.patch.object(self.account, "_exchange",
                               return_value=self.exchanged("kofi@example.com", "r-kofi")):
            self.account.complete("code", "nonce")
        self.assertFalse(self.account.refresh_suspended(), "someone else's suspension is not Kofi's")

    def test_signing_out_clears_it(self):
        self.suspended_renewal()
        with mock.patch.object(self.account, "_post", return_value={}):
            self.account.sign_out()
        self.assertFalse(self.account.refresh_suspended())
        self.assertFalse(self.account.status()["signed_in"])

    def test_a_dropped_renewal_is_forgotten_with_the_sign_in_too(self):
        # The same leak for the other flag: "the connection dropped" is not
        # news to a sign-in that has just reached the service to get its token.
        self.account._unreachable_since["at"] = time.time()
        with mock.patch.object(self.account, "_exchange",
                               return_value=self.exchanged("ama@example.com", "r-new")):
            self.account.complete_with_code("ABCD-EFGH-JKLM", "ama@example.com")
        self.assertFalse(self.account.refresh_unreachable())

    def test_a_refusal_that_comes_back_after_a_new_sign_in_is_not_pinned_on_it(self):
        # The background renewal for Ama's old sign-in is on its way when she
        # signs in again; its "suspended" arrives after the new tokens are
        # saved, and is about a refresh token this app no longer holds.
        self.signed_in_as("ama@example.com", "r-new")
        self.suspended_renewal(refresh="r-ama")
        self.assertFalse(self.account.refresh_suspended())
        self.assertEqual(self.account._load()["refresh_token"], "r-new", "and the new sign-in is kept")


if __name__ == "__main__":
    unittest.main()
