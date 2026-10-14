"""Translation T3: a saved transcript translated afterwards, kept beside the original, exported either way."""
from backend.tests import _env  # noqa: F401
import asyncio  # noqa: E402
from unittest import mock  # noqa: E402

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from backend import languages  # noqa: E402
from backend import transcript_translate as tt  # noqa: E402
from backend.core import sessions as sess  # noqa: E402
from backend.routers import sessions as sessions_router  # noqa: E402


@pytest.fixture
def session():
    sid = sess.create_session(title="Entretien", mode="general")
    languages.set_for_session(sid, "fr")
    sess.append_message(sid, "user", "[INTERVIEWER] Bonjour, parlez-moi de vous.", "interviewer")
    sess.append_message(sid, "assistant", "CUES:\n- ...")
    sess.append_message(sid, "user", "[SCREEN] what is on screen", "unknown")
    sess.append_message(sid, "user", "[USER] Je dirige une équipe de cinq personnes.", "user")
    return sid


def fake_model(calls, answer=None):
    async def ask(model, system, message, *, kind=None, session_id=None, fallback_credits=False):
        calls.append({"system": system, "message": message, "kind": kind, "fallback": fallback_credits})
        lines = [x.split(". ", 1)[1] for x in message.split("\n")[1:]]
        return answer if answer is not None else {"lines": [f"EN: {x}" for x in lines]}
    return ask


def test_lines_are_speech_only_and_know_who_spoke(session):
    got = tt.lines(session)
    assert [x["speaker"] for x in got] == ["them", "you"]
    assert got[0]["text"] == "Bonjour, parlez-moi de vous."


def test_translated_once_kept_beside_the_original_and_never_paid_twice(session):
    calls = []
    with mock.patch("backend.routers.mock._ask_model", side_effect=fake_model(calls)):
        out = asyncio.run(tt.translate(session, "en"))
        assert out["done"] == out["total"] == 2
        again = asyncio.run(tt.translate(session, "en"))
    assert len(calls) == 1                                    # the second run had nothing left to do
    assert calls[0]["kind"] == "translate" and "English" in calls[0]["system"]
    assert again["lines"] == out["lines"]
    assert sorted(out["lines"].values()) == ["EN: Bonjour, parlez-moi de vous.", "EN: Je dirige une équipe de cinq personnes."]
    # The words said are untouched.
    assert tt.lines(session)[1]["text"] == "Je dirige une équipe de cinq personnes."


def test_a_batch_that_does_not_line_up_is_not_kept(session):
    calls = []
    with mock.patch("backend.routers.mock._ask_model", side_effect=fake_model(calls, {"lines": ["only one"]})):
        out = asyncio.run(tt.translate(session, "en"))
    assert out["done"] == 0


def test_the_estimate_counts_only_what_is_left(session, monkeypatch):
    from backend.core import hosted
    monkeypatch.setattr(hosted, "is_admin", lambda: False)
    monkeypatch.setattr(hosted, "credits_for", lambda model, i, o: (i + o) / 10000)
    monkeypatch.setattr("backend.errors.resolve_llm", lambda m: ("deepseek-chat", "hosted"))
    before = tt.estimate(session, "en")
    assert before["lines"] == 2 and before["credits"] > 0
    with mock.patch("backend.routers.mock._ask_model", side_effect=fake_model([])):
        asyncio.run(tt.translate(session, "en"))
    assert tt.estimate(session, "en") == {"lines": 0, "credits": 0}


def test_markdown_in_either_language(session):
    with mock.patch("backend.routers.mock._ask_model", side_effect=fake_model([])):
        asyncio.run(tt.translate(session, "en"))
    said = tt.markdown(session, None, them="Interviewer")
    read = tt.markdown(session, "en", them="Interviewer")
    assert "**Interviewer:** Bonjour, parlez-moi de vous." in said and "EN:" not in said
    assert "**You:** EN: Je dirige une équipe de cinq personnes." in read
    assert "translated from what was said" in read


def test_mixed_is_not_a_target_and_deleting_the_session_drops_them(session):
    with pytest.raises(HTTPException):
        sessions_router.get_translation(session, "multi")
    with mock.patch("backend.routers.mock._ask_model", side_effect=fake_model([])):
        asyncio.run(tt.translate(session, "en"))
    sess.delete_session(session)
    with sess._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM message_translations WHERE session_id = ?", (session,)).fetchone()[0] == 0


def test_the_follow_up_email_can_be_written_in_the_calls_language(session):
    languages.set_display_for_session(session, "en")
    seen = {}

    async def ask(model, system, message, **kw):
        seen["system"] = system
        return {"subject": "Merci", "body": "Bonjour"}

    with mock.patch("backend.routers.mock._ask_model", side_effect=ask), \
         mock.patch("backend.routers.mock._candidate_context", return_value=({}, None)):
        asyncio.run(sessions_router.write_email(session, sessions_router.EmailBody(language="fr")))
        assert "French" in seen["system"]
        asyncio.run(sessions_router.write_email(session, sessions_router.EmailBody()))
        assert "French" not in seen["system"]                 # default: what the user reads
