"""
Choosing a speech-to-text provider (docs/hosted-pivot.md).

After prompt caching, speech is most of what a session costs, and Groq is about
38x cheaper than Deepgram. The rule these tests pin down is: buy streaming only
where streaming is the product, and never silently make a live meeting worse to
save a fifth of a cent.
"""
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import hosted, stt_routing  # noqa: E402

# Choosing among providers is the admin's path: an ordinary account always
# transcribes through our relay (test_hosted.SpeechRoutingTest). Said here
# rather than inherited from whoever is signed in on the machine running the
# tests, which is how these once passed only on the admin's own laptop.
_admin = mock.patch.object(hosted, "is_admin", return_value=True)


def setUpModule():
    _admin.start()


def tearDownModule():
    _admin.stop()


def with_keys(*providers):
    """Pretend exactly these providers have their API keys configured."""
    env = {}
    for p in providers:
        cfg = stt_routing.STT_PROVIDERS.get(p) or {}
        if cfg.get("env"):
            env[cfg["env"]] = "test-key"
    return mock.patch.dict("os.environ", env, clear=True)


class AvailabilityTest(unittest.TestCase):
    def test_a_provider_without_its_key_is_not_available(self):
        with with_keys("groq"):
            self.assertTrue(stt_routing.available("groq"))
            self.assertFalse(stt_routing.available("deepgram"))

    def test_an_unknown_provider_is_not_available(self):
        self.assertFalse(stt_routing.available("nonesuch"))


class LiveTest(unittest.TestCase):
    """The paid moment. Interim words are the feature; do not trade them away."""

    def test_a_live_session_keeps_the_chosen_streaming_provider(self):
        with with_keys("deepgram", "groq"):
            provider, model, _ = stt_routing.route("live", "deepgram")
            self.assertEqual(provider, "deepgram",
                             "groq is cheaper but cannot stream — a live call must not be degraded")
            self.assertEqual(model, "nova-3")

    def test_a_live_session_falls_back_to_another_streaming_provider(self):
        with with_keys("openai", "groq"):
            provider, _, reason = stt_routing.route("live", "deepgram")
            self.assertEqual(provider, "openai")
            self.assertIn("stream", reason)

    def test_a_live_session_with_nothing_streaming_still_works(self):
        with with_keys("groq"):
            provider, _, _ = stt_routing.route("live", "deepgram")
            self.assertEqual(provider, "groq",
                             "pause-gated transcription beats no transcription")


class RehearsalTest(unittest.TestCase):
    """Practice and warmups. Nobody is being interviewed; buy the cheap one."""

    def test_rehearsal_takes_the_cheapest_available(self):
        with with_keys("deepgram", "openai", "groq"):
            provider, model, reason = stt_routing.route("rehearsal", "deepgram")
            self.assertEqual(provider, "groq")
            self.assertEqual(model, "whisper-large-v3-turbo")
            self.assertIn("cheaper", reason)

    def test_the_chosen_provider_stands_when_it_is_already_cheapest(self):
        with with_keys("groq", "deepgram"):
            provider, _, reason = stt_routing.route("rehearsal", "groq")
            self.assertEqual(provider, "groq")
            self.assertIn("already cheapest", reason)

    def test_the_only_available_provider_is_used_however_dear(self):
        with with_keys("deepgram"):
            provider, _, _ = stt_routing.route("rehearsal", "deepgram")
            self.assertEqual(provider, "deepgram")

    def test_local_is_never_chosen_automatically(self):
        # Free, but CPU-bound and not in the packaged app. Swapping a cloud
        # transcriber for it would be felt as the app getting worse.
        with with_keys("deepgram"):
            with mock.patch.object(stt_routing, "local_available", return_value=True):
                provider, _, _ = stt_routing.route("rehearsal", "deepgram")
                self.assertNotEqual(provider, "local")


class NoKeysTest(unittest.TestCase):
    def test_with_nothing_configured_the_chosen_provider_is_kept(self):
        # So the error names the key the user needs, not one they never picked.
        with mock.patch.dict("os.environ", {}, clear=True):
            provider, _, reason = stt_routing.route("rehearsal", "deepgram")
            self.assertEqual(provider, "deepgram")
            self.assertEqual(reason, "nothing available")


class ModelTest(unittest.TestCase):
    def test_a_model_from_another_provider_is_not_carried_over(self):
        with with_keys("groq"):
            _, model, _ = stt_routing.route("rehearsal", "deepgram", "nova-3")
            self.assertEqual(model, "whisper-large-v3-turbo",
                             "nova-3 means nothing to groq")

    def test_a_model_belonging_to_the_provider_is_kept(self):
        with with_keys("groq"):
            _, model, _ = stt_routing.route("rehearsal", "groq", "whisper-large-v3")
            self.assertEqual(model, "whisper-large-v3")


class WhatMakesASessionLiveTest(unittest.TestCase):
    """
    The regression this class exists for: the audio socket decided "live" from
    whether the session had been saved yet. A session is written when the coach
    first answers, which is always *after* the listening starts — so every call
    began as "rehearsal" and bought the cheap batch provider. The user spoke and
    no words appeared until they paused, and Whisper filled the silences with
    "Thank you.". Both symptoms, one line.
    """

    def test_a_live_call_is_live_before_it_has_been_saved(self):
        from backend.routers.audio import stt_task
        self.assertEqual(stt_task("live"), "live")

    def test_holding_a_key_to_talk_is_still_rehearsal(self):
        from backend.routers.audio import stt_task
        self.assertEqual(stt_task("push-to-talk"), "rehearsal")

    def test_a_live_call_keeps_the_streaming_provider_even_where_groq_is_cheaper(self):
        from backend.routers.audio import stt_task
        with with_keys("deepgram", "groq"):
            provider, _, _ = stt_routing.route(stt_task("live"), "deepgram", None)
            self.assertEqual(provider, "deepgram",
                             "interim words are the product in a live call")
            self.assertIn(provider, stt_routing.STREAMING)

    def test_rehearsal_still_takes_the_cheap_one(self):
        from backend.routers.audio import stt_task
        with with_keys("deepgram", "groq"):
            provider, _, _ = stt_routing.route(stt_task("push-to-talk"), "deepgram", None)
            self.assertEqual(provider, "groq")


class SavingTest(unittest.TestCase):
    def test_the_saving_is_the_reason_this_exists(self):
        from backend.core import costs
        deepgram = costs.audio_cost("deepgram", 1800)
        groq = costs.audio_cost("groq", 1800)
        self.assertGreater(deepgram / groq, 30,
                           "if this ratio ever narrows, the routing is not worth its complexity")

    def test_the_voice_agent_is_priced_far_above_plain_transcription(self):
        from backend.core import costs
        # It bundles speech-to-text, a model and speech synthesis. Reporting it
        # at transcription rates would understate a voice mock by an order of
        # magnitude.
        self.assertGreater(costs.audio_cost("deepgram-agent", 60),
                           costs.audio_cost("deepgram", 60) * 5)


if __name__ == "__main__":
    unittest.main()
