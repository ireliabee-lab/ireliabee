"""Roadmap 3.3: a session's language drives transcription, the coach and everything written afterwards."""
import asyncio
import unittest
from unittest import mock

import numpy as np

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend.core import transcribers  # noqa: E402
from backend import languages, debrief  # noqa: E402
from backend.routers import coach, mock as mock_router, sessions as sessions_router  # noqa: E402


class LanguagesTest(unittest.TestCase):
    def setUp(self):
        with sess._connect() as conn:
            conn.execute("DELETE FROM messages")
            conn.execute("DELETE FROM sessions")

    def test_each_provider_gets_its_own_code(self):
        self.assertEqual(languages.stt_code("en-GB", "deepgram"), "en-GB")
        self.assertEqual(languages.stt_code("en-GB", "groq"), "en")
        self.assertEqual(languages.stt_code("multi", "deepgram"), "multi")
        self.assertIsNone(languages.stt_code("multi", "local"))  # Whisper detects it
        self.assertEqual(languages.stt_code("xx", "deepgram"), "en")  # unknown → default
        # Nova-2 has no Arabic: move up to Nova-3.
        self.assertEqual(languages.deepgram_model("nova-2", "ar"), "nova-3")
        self.assertEqual(languages.deepgram_model("nova-2", "fr"), "nova-2")

    def test_batch_transcription_passes_the_language(self):
        seen = {}

        def fake(provider, audio, model, language):
            seen.update(provider=provider, language=language)
            return "bonjour"
        with mock.patch.object(transcribers, "_transcribe_openai_compat", fake):
            transcribers.transcribe(np.ones(160, dtype=np.float32), "groq", "whisper-large-v3", "fr")
        self.assertEqual(seen, {"provider": "groq", "language": "fr"})

    def test_coach_writes_in_the_language_but_keeps_its_labels(self):
        block = coach._response_format_block("Ama", "advanced", "fr")
        self.assertIn("This conversation is in French", block)
        self.assertIn("Keep the section labels", block)
        self.assertIn("SHORT:", block)
        self.assertNotIn("LANGUAGE —", coach._response_format_block("Ama", "advanced", "en"))
        self.assertIn("British English", coach._response_format_block("Ama", "advanced", "en-GB"))

    def test_support_follows_the_language(self):
        with mock.patch.object(coach, "english_support_enabled", lambda: True):
            self.assertIn("not a native Spanish speaker", coach.tone_block("advanced", "es"))
            self.assertIn("not a native English speaker", coach.tone_block("advanced", None))

    def test_sessions_remember_their_language(self):
        created = sessions_router.create_session(sessions_router.SessionCreateBody(title="Réunion", language="fr"))
        self.assertEqual(created["language"], "fr")
        self.assertEqual(languages.for_session(created["id"]), "fr")
        old = sess.create_session(title="Old call", mode="general")
        self.assertEqual(languages.for_session(old), "en")

    def test_the_debrief_is_written_in_the_sessions_language(self):
        sid = sess.create_session(title="Entretien", mode="general")
        languages.set_for_session(sid, "fr")
        sess.append_message(sid, "user", "Parlez-moi de vous.", speaker="interviewer")
        sess.append_message(sid, "user", "Je suis ingénieure logicielle.", speaker="you")
        seen = {}

        async def fake(model, system_prompt, message):
            seen["prompt"] = system_prompt
            return {"overall_score": 7, "summary": "Bien.", "questions": []}
        with mock.patch.object(mock_router, "_ask_model", fake):
            asyncio.run(debrief.generate_debrief(sid, None, None))
        self.assertIn("Write every text value in French", seen["prompt"])
        self.assertIn("Keep the JSON keys", seen["prompt"])


if __name__ == "__main__":
    unittest.main()
