"""Translation T1: hear one language, read another. The call is transcribed in the spoken language;
cues, answers, the debrief and notes are written in the reading language; "Say it in" turns an answer back."""
from backend.tests import _env  # noqa: F401
import asyncio  # noqa: E402
from unittest import mock  # noqa: E402

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from backend import languages  # noqa: E402
from backend.core import sessions as sess  # noqa: E402
from backend.routers import coach  # noqa: E402


@pytest.fixture
def session():
    sid = sess.create_session(title="Entretien", mode="general")
    languages.set_for_session(sid, "fr")
    return sid


def test_the_reading_language_falls_back_to_the_spoken_one(session):
    assert languages.output_for_session(session) == "fr"          # nothing chosen: read what is spoken
    languages.set_display_for_session(session, "en")
    assert languages.output_for_session(session) == "en"
    assert languages.for_session(session) == "fr"                  # transcription still listens for French
    languages.set_display_for_session(session, None)
    assert languages.output_for_session(session) == "fr"


def test_mixed_and_unknown_codes_are_not_reading_languages(session):
    languages.set_display_for_session(session, "multi")
    assert languages.output_for_session(session) == "fr"
    languages.set_display_for_session(session, "xx")
    assert languages.output_for_session(session) == "fr"


def test_the_debrief_is_written_in_the_reading_language(session):
    # The debrief writes in output_for_session (debrief.py). Spoken French alone: told to write French.
    assert "French" in languages.json_block(languages.output_for_session(session))
    # Reading in English: no "write in French" instruction any more (English is the default, so none at all).
    languages.set_display_for_session(session, "en")
    assert "French" not in languages.json_block(languages.output_for_session(session))


def test_say_it_in_the_calls_language(session):
    seen = {}

    async def fake_ask(model, system, message, *, kind=None, session_id=None, fallback_credits=False):
        seen.update(system=system, message=message, kind=kind, session_id=session_id)
        return {"text": "CUES:\n- Je dirige une équipe de cinq personnes"}

    with mock.patch("backend.routers.mock._ask_model", side_effect=fake_ask):
        out = asyncio.run(coach.say_in(coach.SayInRequest(text="CUES:\n- I lead a team of five", session_id=session)))
    assert out == {"text": "CUES:\n- Je dirige une équipe de cinq personnes", "language": "fr"}
    assert seen["kind"] == "translate" and seen["session_id"] == session
    assert "French" in seen["system"] and "CUES:/SHORT:/FULL:" in seen["system"]
    assert seen["message"].startswith("ANSWER\nCUES:")


def test_say_it_in_needs_a_single_language(session):
    languages.set_for_session(session, "multi")
    with pytest.raises(HTTPException):
        asyncio.run(coach.say_in(coach.SayInRequest(text="Hello", session_id=session)))
    with pytest.raises(HTTPException):
        asyncio.run(coach.say_in(coach.SayInRequest(text="  ", session_id=session)))
