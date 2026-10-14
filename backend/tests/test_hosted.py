"""
Where the AI comes from (docs/hosted-pivot.md, step 8).

One rule decides whose money a call spends, so it is worth pinning from both
sides: an ordinary account must never reach a provider directly, and the admin
account must never be forced through the proxy when it is the proxy being
investigated.

The failure that matters most is the quiet one — a provider key left in the
environment from an older version silently taking over, so some installs are
metered and some are not with nothing on screen to say which.
"""
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)

from backend.core import hosted


def signed_in(admin=False, token="ira-token"):
    """Patch the account module the way a signed-in machine looks."""
    return (
        mock.patch.object(hosted.account, "status",
                          return_value={"signed_in": True, "admin": admin}),
        mock.patch.object(hosted.account, "access_token", return_value=token),
    )


def signed_out():
    return (
        mock.patch.object(hosted.account, "status",
                          return_value={"signed_in": False, "admin": False}),
        mock.patch.object(hosted.account, "access_token", return_value=None),
    )


class HostedTestCase(unittest.TestCase):
    def use(self, patches):
        for p in patches:
            p.start()
            self.addCleanup(p.stop)


class OrdinaryAccountTest(HostedTestCase):
    def test_the_model_call_goes_through_our_service(self):
        self.use(signed_in())
        key, base_url = hosted.anthropic_credentials()
        self.assertEqual(key, "ira-token")
        self.assertTrue(base_url, "an ordinary account must not talk to Anthropic directly")

    def test_speech_goes_through_our_relay_over_a_websocket(self):
        self.use(signed_in())
        url, headers = hosted.deepgram_endpoint("en")
        self.assertTrue(url.startswith("ws"), url)
        self.assertIn("/stt/listen", url)
        self.assertNotIn("deepgram.com", url)
        self.assertEqual(headers["Authorization"], "Bearer ira-token")

    def test_a_stray_provider_key_does_not_take_over(self):
        # The setting is hidden, but an older version may have written one, and
        # honouring it would mean some installs metered and some not.
        self.use(signed_in())
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-ant-leftover"}):
            key, base_url = hosted.anthropic_credentials()
        self.assertEqual(key, "ira-token")
        self.assertTrue(base_url)

    def test_a_stray_speech_key_does_not_take_over_either(self):
        self.use(signed_in())
        with mock.patch.dict("os.environ", {"DEEPGRAM_API_KEY": "dg-leftover"}):
            url, _ = hosted.deepgram_endpoint("en")
        self.assertNotIn("deepgram.com", url)

    def test_the_session_language_reaches_the_relay(self):
        self.use(signed_in())
        url, _ = hosted.deepgram_endpoint("fr")
        self.assertIn("language=fr", url)


class AdminAccountTest(HostedTestCase):
    def test_an_admin_with_a_key_talks_to_the_provider_directly(self):
        # The whole point: when the proxy is the suspect, this is the only way
        # to tell whose fault it is.
        self.use(signed_in(admin=True))
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-ant-mine"}):
            key, base_url = hosted.anthropic_credentials()
        self.assertEqual(key, "sk-ant-mine")
        self.assertIsNone(base_url)

    def test_an_admin_speech_key_reaches_deepgram(self):
        self.use(signed_in(admin=True))
        with mock.patch.dict("os.environ", {"DEEPGRAM_API_KEY": "dg-mine"}):
            url, headers = hosted.deepgram_endpoint("en")
        self.assertIn("deepgram.com", url)
        self.assertEqual(headers["Authorization"], "Token dg-mine")

    def test_an_admin_without_a_key_still_uses_the_service(self):
        # Being admin is permission to use a key, not a requirement to have one.
        self.use(signed_in(admin=True))
        with mock.patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop("ANTHROPIC_API_KEY", None)
            key, base_url = hosted.anthropic_credentials()
        self.assertEqual(key, "ira-token")
        self.assertTrue(base_url)


class SignedOutTest(HostedTestCase):
    def test_nothing_that_costs_money_runs(self):
        self.use(signed_out())
        with self.assertRaises(hosted.NotAvailable):
            hosted.anthropic_credentials()
        with self.assertRaises(hosted.NotAvailable):
            hosted.deepgram_endpoint("en")

    def test_the_refusal_tells_the_person_what_to_do(self):
        # A screen that says "sign in" is an answer; one that silently does
        # nothing is a bug report.
        self.use(signed_out())
        with self.assertRaises(hosted.NotAvailable) as caught:
            hosted.anthropic_credentials()
        self.assertIn("Sign in", str(caught.exception))

    def test_being_signed_out_is_not_an_admin_loophole(self):
        self.use(signed_out())
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-ant-anyone"}):
            self.assertIsNone(hosted.own_key("ANTHROPIC_API_KEY"))
            with self.assertRaises(hosted.NotAvailable):
                hosted.anthropic_credentials()


class CoerceTest(HostedTestCase):
    """
    A config saved before the pivot can still name OpenAI or DeepSeek, and an
    ordinary account has no key for either — so the call would fail with
    "Missing env var" for a setting that is no longer on screen.
    """

    def test_a_pre_pivot_provider_choice_is_moved_onto_what_we_serve(self):
        self.use(signed_in())
        self.assertEqual(hosted.coerce("openai", "gpt-5-mini"),
                         ("anthropic", "claude-haiku-4-5"))
        self.assertEqual(hosted.coerce("deepseek", "deepseek-chat"),
                         ("anthropic", "claude-haiku-4-5"))

    def test_a_model_we_do_serve_is_left_alone(self):
        self.use(signed_in())
        self.assertEqual(hosted.coerce("anthropic", "claude-sonnet-5"),
                         ("anthropic", "claude-sonnet-5"))

    def test_an_anthropic_model_we_do_not_serve_falls_back_to_the_fast_tier(self):
        self.use(signed_in())
        self.assertEqual(hosted.coerce("anthropic", "claude-opus-4-7"),
                         ("anthropic", "claude-haiku-4-5"))

    def test_the_admin_account_may_still_choose_anything(self):
        # Being able to run against another provider is the entire reason that
        # account exists.
        self.use(signed_in(admin=True))
        self.assertEqual(hosted.coerce("openai", "gpt-5-mini"), ("openai", "gpt-5-mini"))


class CreditWarningTest(HostedTestCase):
    """
    Enough credit to finish, said before the call rather than during it.

    Nothing looked at the balance until a call was already running, so the first
    a user heard of it was mid-interview. A warning, never a gate — and read
    from the cached figure, because it sits in front of every call and readiness
    must not become slow, or start failing, because the service is slow.
    """

    def signed_in_with(self, balance):
        self.use((
            mock.patch.object(hosted.account, "status",
                              return_value={"signed_in": True, "admin": False, "balance": balance}),
            mock.patch.object(hosted.account, "access_token", return_value="ira-token"),
        ))

    def test_a_low_balance_is_flagged_before_the_call(self):
        self.signed_in_with({"available": 0.4, "at": 1700000000})
        warning = hosted.credit_warning()
        self.assertTrue(warning["low"])
        self.assertEqual(warning["available"], 0.4)

    def test_a_comfortable_balance_says_nothing(self):
        self.signed_in_with({"available": 5.0, "at": 1700000000})
        self.assertFalse(hosted.credit_warning()["low"])

    def test_half_an_hour_left_is_the_line(self):
        # One credit is thirty minutes of live session (core/pricing.py).
        self.signed_in_with({"available": hosted.LOW_CREDITS, "at": 0})
        self.assertFalse(hosted.credit_warning()["low"])

    def test_it_never_goes_to_the_network_for_this(self):
        # The whole reason it reads the cached figure: this is on the path in
        # front of every call.
        self.signed_in_with({"available": 0.2, "at": 0})
        with mock.patch.object(hosted.account, "balance",
                               side_effect=AssertionError("readiness must not touch the network")):
            self.assertTrue(hosted.credit_warning()["low"])

    def test_signed_out_has_no_credit_line(self):
        self.use(signed_out())
        self.assertIsNone(hosted.credit_warning())

    def test_a_balance_we_have_never_read_is_not_invented(self):
        self.signed_in_with(None)
        self.assertIsNone(hosted.credit_warning())

    def test_a_broken_account_file_is_not_a_crash(self):
        self.use((mock.patch.object(hosted.account, "status", side_effect=ValueError("bad json")),))
        self.assertIsNone(hosted.credit_warning())


class ReadinessTest(HostedTestCase):
    def test_signed_in_is_ready_and_says_it_is_hosted(self):
        self.use(signed_in())
        self.assertEqual(hosted.readiness(), {"ready": True, "mode": "hosted", "message": ""})

    def test_admin_is_ready_on_its_own_keys(self):
        self.use(signed_in(admin=True))
        self.assertEqual(hosted.readiness()["mode"], "keys")

    def test_signed_out_is_not_ready_and_explains_itself(self):
        self.use(signed_out())
        state = hosted.readiness()
        self.assertFalse(state["ready"])
        self.assertIn("Sign in", state["message"])

    def test_a_broken_account_file_reads_as_not_admin_rather_than_admin(self):
        # Failing open here would hand everyone the key screens.
        with mock.patch.object(hosted.account, "status", side_effect=OSError("boom")):
            self.assertFalse(hosted.is_admin())


if __name__ == "__main__":
    unittest.main()


class LiveCoachTest(HostedTestCase):
    """
    The live coach is the call a session makes most. An end-to-end test as an
    ordinary account found it reading ANTHROPIC_API_KEY itself, so it failed
    with "key missing" for everyone but the admin — while speech, wired the
    other way, worked.
    """

    def setUp(self):
        from backend.core import providers
        providers._clients.clear()
        self.addCleanup(providers._clients.clear)

    def test_an_ordinary_account_is_ready_without_any_key(self):
        from backend import errors
        self.use(signed_in())
        with mock.patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop("ANTHROPIC_API_KEY", None)
            model, provider = errors.resolve_llm("claude-haiku-4-5")
        self.assertEqual((model, provider), ("claude-haiku-4-5", "anthropic"))

    def test_an_old_saved_provider_is_moved_onto_what_we_serve(self):
        from backend import errors
        self.use(signed_in())
        model, provider = errors.resolve_llm("gpt-5-mini")
        self.assertEqual(provider, "anthropic")
        self.assertIn(model, hosted.HOSTED_MODELS)

    def test_an_ordinary_account_with_no_model_saved_is_served_anyway(self):
        # It has no model picker, so nothing saved is its normal state. A live
        # test found the voice-mock feedback and follow-ups refusing it with
        # "No AI model selected — choose one in Settings", a setting it
        # cannot see.
        from backend import errors
        self.use(signed_in())
        with mock.patch.object(errors, "load_config", return_value={}):
            model, provider = errors.resolve_llm(None)
        self.assertEqual((provider, model), (hosted.HOSTED_PROVIDER, hosted.HOSTED_DEFAULT))

    def test_the_admin_with_no_model_saved_is_asked_to_choose(self):
        from backend import errors
        self.use(signed_in(admin=True))
        with mock.patch.object(errors, "load_config", return_value={}):
            with self.assertRaises(errors.FriendlyError) as caught:
                errors.resolve_llm("")
        self.assertEqual(caught.exception.code, "no_model")

    def test_signed_out_is_told_to_sign_in_not_to_find_a_key(self):
        from backend import errors
        self.use(signed_out())
        with self.assertRaises(errors.FriendlyError) as caught:
            errors.resolve_llm("claude-haiku-4-5")
        self.assertEqual(caught.exception.code, "signed_out")
        self.assertNotIn("key", caught.exception.message.lower())

    def test_the_admin_still_needs_their_own_key(self):
        from backend import errors
        self.use(signed_in(admin=True))
        with mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": ""}):
            with self.assertRaises(errors.FriendlyError) as caught:
                errors.resolve_llm("claude-haiku-4-5")
        self.assertEqual(caught.exception.code, "missing_key")

    def test_the_streaming_coach_talks_to_our_service(self):
        from backend.routers import coach
        self.use(signed_in())
        made = {}

        class FakeAnthropic:
            def __init__(self, **kwargs):
                made.update(kwargs)

        with mock.patch("anthropic.Anthropic", FakeAnthropic), \
             mock.patch.dict("os.environ", {"ANTHROPIC_API_KEY": "sk-stray-key"}):
            gen = coach._stream_anthropic("claude-haiku-4-5", "hi", [], "system")
            with self.assertRaises(Exception):
                next(gen)       # the fake has no .messages; the client is what matters
        self.assertEqual(made.get("api_key"), "ira-token", "our access token, not the stray key")
        self.assertTrue(made.get("base_url"), "pointed at our service, not at Anthropic")

    def test_whatever_routing_picks_an_ordinary_account_stays_on_what_we_serve(self):
        from backend.routers import coach
        self.use(signed_in())
        seen = {}

        def fake_anthropic(model, *a):
            seen["model"] = model
            yield "ok"

        with mock.patch.object(coach, "_stream_anthropic", fake_anthropic):
            out = list(coach._token_stream("openai", "gpt-5", "hi", [], "system"))
        self.assertEqual(out, ["ok"])
        self.assertIn(seen["model"], hosted.HOSTED_MODELS)


class HostedErrorsTest(HostedTestCase):
    """What an ordinary account is told when our service says no."""

    def test_out_of_credits_is_about_their_iReliabee_balance(self):
        from backend import errors
        self.use(signed_in())
        e = errors.classify(Exception("server rejected WebSocket connection: HTTP 402"), "deepgram")
        self.assertEqual(e.code, "out_of_credits")
        self.assertIn("credit pack", e.message)
        self.assertNotIn("Deepgram", e.title)

    def test_an_expired_sign_in_is_not_a_bad_api_key(self):
        from backend import errors
        self.use(signed_in())
        class Unauthorized(Exception):
            status_code = 401          # how the Anthropic SDK reports it
        e = errors.classify(Unauthorized("Error code: 401"), "anthropic")
        self.assertEqual(e.code, "signed_out")
        self.assertNotIn("key", e.message.lower())

    def _status_error(self, status, text):
        class ApiError(Exception):
            status_code = status
        return ApiError(text)

    def test_a_suspended_account_is_told_so_not_to_paste_a_key(self):
        # Audit 180-H4: a 403 said "rejected the API key … paste a fresh key".
        from backend import errors
        self.use(signed_in())
        e = errors.classify(self._status_error(403, "This account has been suspended."), "anthropic")
        self.assertEqual(e.code, "account_suspended")
        self.assertNotIn("key", f"{e.title} {e.message}".lower())

    def test_the_daily_limit_is_named_not_called_busy(self):
        from backend import errors
        self.use(signed_in())
        e = errors.classify(self._status_error(
            429, "You have reached today's usage limit. It resets in 24 hours"), "anthropic")
        self.assertEqual(e.code, "daily_limit")
        self.assertIn("24 hours", e.message)

    def test_a_burst_is_just_busy(self):
        from backend import errors
        self.use(signed_in())
        e = errors.classify(self._status_error(429, "That is a lot of requests at once."), "anthropic")
        self.assertEqual(e.code, "rate_limited")

    def test_missing_key_text_never_reaches_an_ordinary_account(self):
        from backend import errors
        self.use(signed_in())
        for text in ("Missing env var ANTHROPIC_API_KEY", "Could not resolve authentication method"):
            e = errors.classify(Exception(text), "anthropic")
            self.assertNotIn(e.code, ("missing_key", "invalid_key"), text)
            self.assertNotIn("key", f"{e.title} {e.message}".lower(), text)

    def test_the_admin_still_hears_about_their_provider(self):
        from backend import errors
        self.use(signed_in(admin=True))
        e = errors.classify(Exception("HTTP 402 payment required"), "deepgram")
        self.assertEqual(e.code, "out_of_credits")
        self.assertIn("Deepgram", e.title)

    def test_running_out_mid_session_is_said_out_loud(self):
        import asyncio
        import websockets
        import websockets.frames
        from backend import deepgram_stream, errors

        class ClosedSocket:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise websockets.exceptions.ConnectionClosed(
                    websockets.frames.Close(4402, "You are out of credits."), None)

        session = deepgram_stream.DeepgramSession(api_key="x")
        session.ws = ClosedSocket()

        async def drain():
            return [m async for m in session.transcripts()]

        self.use(signed_in())
        with self.assertRaises(errors.FriendlyError) as caught:
            asyncio.run(drain())
        self.assertEqual(caught.exception.code, "out_of_credits")

    def test_an_ordinary_close_still_ends_quietly(self):
        import asyncio
        import websockets
        import websockets.frames
        from backend import deepgram_stream

        class ClosedSocket:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise websockets.exceptions.ConnectionClosed(websockets.frames.Close(1000, "Done."), None)

        session = deepgram_stream.DeepgramSession(api_key="x")
        session.ws = ClosedSocket()

        async def drain():
            return [m async for m in session.transcripts()]

        self.assertEqual(asyncio.run(drain()), [])


class ProxyAddressTest(HostedTestCase):
    def test_the_sdk_reaches_v1_messages_not_v1_v1_messages(self):
        # The Anthropic SDK appends /v1/messages to base_url. Found live: the
        # base already ended in /v1, so every hosted AI call was a 404.
        self.use(signed_in())
        _key, base_url = hosted.anthropic_credentials()
        self.assertEqual(base_url, "https://ireliabee.co.uk")
        self.assertEqual(f"{base_url}/v1/messages", "https://ireliabee.co.uk/v1/messages")

    def test_a_development_address_keeps_its_own_host(self):
        self.use(signed_in())
        with mock.patch.dict("os.environ", {"IRELIABEE_API": "http://127.0.0.1:8002/v1/"}):
            self.assertEqual(hosted.anthropic_base(), "http://127.0.0.1:8002")

    def test_speech_keeps_the_v1_path_it_needs(self):
        self.use(signed_in())
        url, _ = hosted.deepgram_endpoint("en")
        self.assertTrue(url.startswith("wss://ireliabee.co.uk/v1/stt/listen"), url)


class NoProviderNamesTest(HostedTestCase):
    """The admin can switch providers at any moment; users never see which."""

    def test_an_ordinary_account_never_sees_a_provider_name(self):
        from backend import errors
        self.use(signed_in())
        for service in ("anthropic", "deepseek", "openai", "deepgram"):
            for exc in (Exception("HTTP 429 rate limit"), Exception("HTTP 404 model not found"),
                        Exception("connection refused")):
                e = errors.classify(exc, service)
                for provider in ("Anthropic", "Claude", "DeepSeek", "OpenAI", "Deepgram"):
                    self.assertNotIn(provider, e.title + e.message, f"{service}: {e.title}")

    def test_the_admin_still_sees_which_provider_failed(self):
        from backend import errors
        self.use(signed_in(admin=True))
        e = errors.classify(Exception("HTTP 429 rate limit"), "anthropic")
        self.assertIn("Anthropic", e.title)


class VoiceTest(HostedTestCase):
    """Voice mock, preview and pronounce go through our service (audit 178-H6)."""

    def test_an_ordinary_account_calls_the_interviewer_through_our_relay(self):
        self.use(signed_in())
        with mock.patch.dict("os.environ", {"DEEPGRAM_API_KEY": "dg-stray"}):
            url, headers = hosted.agent_endpoint()
        self.assertEqual(url, "wss://ireliabee.co.uk/v1/agent/converse")
        self.assertEqual(headers["Authorization"], "Bearer ira-token", "not the stray key")

    def test_the_admin_still_calls_deepgram_with_their_own_key(self):
        self.use(signed_in(admin=True))
        with mock.patch.dict("os.environ", {"DEEPGRAM_API_KEY": "dg-admin"}):
            url, headers = hosted.agent_endpoint()
        self.assertIn("agent.deepgram.com", url)
        self.assertEqual(headers["Authorization"], "Token dg-admin")

    def test_signed_out_is_told_to_sign_in(self):
        self.use(signed_out())
        with self.assertRaises(hosted.NotAvailable):
            hosted.agent_endpoint()

    def test_speech_for_an_ordinary_account_goes_to_our_speak_endpoint(self):
        self.use(signed_in())
        calls = []

        class Res:
            status_code = 200
            content = b"mp3"
            text = ""

        def fake_post(url, **kw):
            calls.append((url, kw))
            return Res()

        with mock.patch("requests.post", fake_post), \
             mock.patch.dict("os.environ", {"DEEPGRAM_API_KEY": "dg-stray"}):
            audio = hosted.speak("entrepreneur", "flux-hannah-en")
        self.assertEqual(audio, b"mp3")
        self.assertEqual(calls[0][0], "https://ireliabee.co.uk/v1/speak")
        self.assertEqual(calls[0][1]["headers"]["Authorization"], "Bearer ira-token")
        self.assertEqual(calls[0][1]["json"], {"text": "entrepreneur", "voice": "flux-hannah-en"})

    def test_out_of_credits_on_speech_reads_as_credits(self):
        from backend import errors
        self.use(signed_in())
        e = errors.classify(hosted.SpeakError(402, '{"error":"insufficient_credits"}'), "deepgram")
        self.assertEqual(e.code, "out_of_credits")
        self.assertNotIn("Deepgram", e.title)


class SpeechRoutingTest(HostedTestCase):
    """Audit 178-H4: an ordinary account never transcribes on a local key."""

    def test_a_saved_groq_choice_and_a_leftover_key_still_use_our_relay(self):
        from backend.core import stt_routing
        self.use(signed_in())
        with mock.patch.dict("os.environ", {"GROQ_API_KEY": "gsk-stray", "OPENAI_API_KEY": "sk-stray"}):
            for task in ("live", "rehearsal"):
                provider, _model, reason = stt_routing.route(task, "groq", "whisper-large-v3-turbo")
                self.assertEqual(provider, "deepgram", task)
                self.assertIn("relay", reason)

    def test_the_admin_still_routes_on_their_own_keys(self):
        from backend.core import stt_routing
        self.use(signed_in(admin=True))
        with mock.patch.dict("os.environ", {"GROQ_API_KEY": "gsk-admin"}):
            provider, _m, _r = stt_routing.route("rehearsal", "groq", None)
        self.assertEqual(provider, "groq")


class ConfigCatalogueTest(HostedTestCase):
    """Audit 180-H5: provider names and key status are the admin's to see."""

    def test_an_ordinary_account_gets_no_provider_catalogue(self):
        from backend.routers import config as config_router
        self.use(signed_in())
        cfg = config_router.get_config()
        self.assertEqual(cfg["llm_providers"], [])
        self.assertEqual(cfg["stt_providers"], [])
        self.assertEqual(cfg["research_keys"], [])

    def test_the_admin_still_gets_every_provider(self):
        from backend.routers import config as config_router
        self.use(signed_in(admin=True))
        self.assertTrue(config_router.get_config()["llm_providers"])


class NeutralWordingTest(HostedTestCase):
    """Audit 182-M4: nothing unclassified reaches an ordinary account as key or provider text."""

    def test_status_less_errors_never_mention_keys_or_providers(self):
        from backend import errors
        self.use(signed_in())
        for text in ("permission denied", "invalid_auth", "incorrect api key", "Your credit balance is too low",
                     "anthropic.InternalServerError: something odd"):
            e = errors.classify(Exception(text), "anthropic")
            words = f"{e.title} {e.message}".lower()
            self.assertNotIn(e.code, ("invalid_key", "missing_key"), text)
            self.assertNotIn("key", words, text)
            self.assertNotIn("anthropic", words, text)

    def test_the_network_is_still_named_as_the_network(self):
        from backend import errors
        self.use(signed_in())
        self.assertEqual(errors.classify(Exception("ConnectError: timed out"), "anthropic").code, "network")
