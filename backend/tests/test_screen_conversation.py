"""A screenshot in a live session answers what the other side just asked, with the conversation as
context. The ways it can go wrong are listed first (CLAUDE.md, Testing, rule 3), one test each."""
from backend.tests import _env  # noqa: F401
import asyncio  # noqa: E402
import io  # noqa: E402
from unittest import mock  # noqa: E402

from fastapi import UploadFile  # noqa: E402

from backend.routers import coach  # noqa: E402
from backend.routers.coach import ScreenContextLine as Line, _screen_question  # noqa: E402


def test_their_question_becomes_the_question_and_says_so():
    msg, answering = _screen_question(None, "Why does revenue dip in Q3?", [])
    assert answering == "Why does revenue dip in Q3?"
    assert msg.startswith('They just asked: "Why does revenue dip in Q3?"')
    assert "evidence" in msg and "read the" in msg   # answer it from the screen, not a tour of the slide


def test_what_was_typed_always_wins():
    msg, answering = _screen_question("solve it in Java", "Why Q3?", [Line(speaker="them", text="Why Q3?")])
    assert answering is None
    assert msg.startswith("solve it in Java")


def test_no_question_and_no_conversation_keeps_the_old_behaviour():
    msg, answering = _screen_question(None, None, None)
    assert (msg, answering) == (coach.SCREEN_DEFAULT_QUESTION, None)


def test_the_conversation_goes_along_labelled_and_in_order():
    msg, _ = _screen_question(None, "And the margin?", [
        Line(speaker="them", text="Here's the quarterly view."), Line(speaker="you", text="Thanks, go on."),
    ])
    block = msg.split("RECENT CONVERSATION")[1]
    assert block.index("Them: Here's the quarterly view.") < block.index("Me: Thanks, go on.")


def test_a_long_call_is_capped_keeping_the_most_recent_lines():
    many = [Line(speaker="them", text=f"line {i} " + "x" * 600) for i in range(40)]
    msg, _ = _screen_question(None, None, many)
    block = msg.split("RECENT CONVERSATION (context only, most recent last):\n")[1]
    kept = block.split("\n")
    assert len(kept) <= coach.SCREEN_CONTEXT_LINES
    assert sum(len(l) + 1 for l in kept) <= coach.SCREEN_CONTEXT_CHARS
    assert kept[-1].startswith("Them: line 39"), "the newest line is never the one dropped"
    assert all(len(l) <= coach.SCREEN_CONTEXT_LINE_CHARS + len("Them: ") for l in kept)


def test_blank_lines_and_a_blank_question_add_nothing():
    msg, answering = _screen_question("  ", "   ", [Line(speaker="them", text="   ")])
    assert (msg, answering) == (coach.SCREEN_DEFAULT_QUESTION, None)


def test_the_upload_route_sends_question_and_conversation_and_reports_what_it_answered():
    seen = {}

    def fake(provider, model, path, user_q, system, **kw):
        seen.update(q=user_q, system=system)
        return "CUES:\n- Q3 is seasonal"

    upload = UploadFile(filename="s.png", file=io.BytesIO(b"\x89PNG fake"))
    with mock.patch.object(coach, "respond_with_image", side_effect=fake), \
         mock.patch.object(coach, "_provider_for", return_value="anthropic"):
        out = asyncio.run(coach.coach_screen(
            file=upload, prompt=None, session_id=None, template="general", model="m",
            ai_instructions=None, cv_id=None, their_question="Why does revenue dip in Q3?",
            conversation='[{"speaker":"them","text":"This slide shows the year."}]',
        ))
    assert out["answering"] == "Why does revenue dip in Q3?"
    assert out["prompt_used"] == "Answering: Why does revenue dip in Q3?"
    assert "Them: This slide shows the year." in seen["q"]
    assert "answer exactly that question" in seen["system"]


def test_a_malformed_conversation_from_the_form_is_ignored_not_an_error():
    assert coach._conversation_from_form("not json") == []
    assert coach._conversation_from_form('{"a":1}') == []
    assert coach._conversation_from_form('[{"speaker":"them","text":"hi"}, 3]') == [{"speaker": "them", "text": "hi"}]
