"""Persona (roadmap 1.1): saved in config, validated, and the first onboarding step."""
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from fastapi import HTTPException  # noqa: E402
from backend.routers import config as cfg_router  # noqa: E402


class PersonaTest(unittest.TestCase):
    def setUp(self):
        # An in-memory config so the user's real config file is never touched.
        self.store: dict = {"provider": "anthropic"}
        patches = [
            mock.patch.object(cfg_router, "load_config", lambda: dict(self.store)),
            mock.patch.object(cfg_router, "save_config", lambda c: self.store.clear() or self.store.update(c)),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def test_unset_by_default(self):
        self.assertEqual(cfg_router.get_persona(), {"persona": None})

    def test_saved_and_read_back_keeping_other_settings(self):
        cfg_router.put_persona(cfg_router.PersonaRequest(persona="student"))
        self.assertEqual(cfg_router.get_persona(), {"persona": "student"})
        self.assertEqual(self.store["provider"], "anthropic")

    def test_unknown_values_are_rejected(self):
        with self.assertRaises(HTTPException):
            cfg_router.put_persona(cfg_router.PersonaRequest(persona="astronaut"))
        self.assertNotIn("persona", self.store)

    def test_a_bad_stored_value_reads_as_unset(self):
        self.store["persona"] = "astronaut"
        self.assertEqual(cfg_router.get_persona(), {"persona": None})

    def test_persona_is_the_first_onboarding_step(self):
        with mock.patch.object(cfg_router, "readiness", lambda: {"llm": None, "stt": None, "voice": None}):
            before = cfg_router.onboarding()
            cfg_router.put_persona(cfg_router.PersonaRequest(persona="professional"))
            after = cfg_router.onboarding()
        self.assertEqual(before["steps"][0], {"id": "persona", "done": False})
        self.assertEqual(after["steps"][0], {"id": "persona", "done": True})
        # Five steps, not six: the model key and the speech key became one
        # account (docs/hosted-pivot.md, step 8).
        self.assertEqual(after["total"], 5)
        self.assertEqual(after["done"], before["done"] + 1)


if __name__ == "__main__":
    unittest.main()
