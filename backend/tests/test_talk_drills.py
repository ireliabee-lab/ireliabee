"""Talk at work: scenarios, impromptu topics and Write it shorter, scored for the listener."""
from backend.tests import _env  # noqa: F401
import asyncio  # noqa: E402
from datetime import date  # noqa: E402

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from backend import talk_drills as talk  # noqa: E402


def _fake(reply):
    seen = {}

    async def fake_ask(system, message, kind, model, fallback_credits):
        seen.update(system=system, message=message, kind=kind)
        return reply
    return fake_ask, seen


def test_every_scenario_says_who_listens_and_how_long():
    ids = [s["id"] for s in talk.SCENARIOS]
    assert len(ids) == len(set(ids)) >= 6 and "standup" in ids
    assert all(s["listener"] and s["brief"] and 15 <= s["seconds"] <= 90 for s in talk.SCENARIOS)


def test_the_topic_holds_for_the_day_and_another_is_different():
    day = date(2026, 10, 8)
    assert talk.topic_for(day) == talk.topic_for(day)
    assert talk.topic_for(day, skip=1) != talk.topic_for(day)


def test_a_scenario_answer_is_scored_for_the_listener(monkeypatch):
    fake, seen = _fake({"bluf": True, "clear": 130, "length": "much too long", "score": "80",
                        "strengths": ["a", "b", "c"], "fixes": ["one"], "better": "Password reset is nearly done."})
    monkeypatch.setattr(talk, "_ask", fake)
    out = asyncio.run(talk.score("standup", "Um, so yesterday I basically fixed the email key and today I finish reset.", seconds=40))
    assert seen["kind"] == "talk_drill" and "tech lead" in seen["message"] and "about 30 seconds" in seen["message"]
    assert "Never comment on fluency, pauses, repetition or stuttering" in seen["system"]
    assert out["clear"] == 100 and out["length"] == "right" and out["score"] == 80 and len(out["strengths"]) == 2
    assert out["delivery"]["fillers"] == 2 and out["target_seconds"] == 30


def test_impromptu_needs_a_topic_and_unknown_drills_are_refused(monkeypatch):
    fake, _ = _fake({})
    monkeypatch.setattr(talk, "_ask", fake)
    with pytest.raises(HTTPException):
        asyncio.run(talk.score("impromptu", "A long enough answer here.", topic=""))
    with pytest.raises(HTTPException):
        asyncio.run(talk.score("nope", "A long enough answer here."))
    with pytest.raises(HTTPException):
        asyncio.run(talk.score("standup", "Too short"))


def test_shorten_reports_the_words_saved(monkeypatch):
    fake, seen = _fake({"shorter": "The export moves to Wednesday; partial export Friday if useful?", "cut": ["the apology"]})
    monkeypatch.setattr(talk, "_ask", fake)
    text = ("Hi, sorry to bother you, I just wanted to actually let you know that I think maybe the export "
            "will not be ready on Friday as planned, it will probably be Wednesday, but we could do a partial one.")
    out = asyncio.run(talk.shorten(text, "email"))
    assert seen["kind"] == "talk_shorten" and "an email" in seen["message"]
    assert out["words_after"] < out["words_before"] and out["saved_percent"] > 40 and out["cut"] == ["the apology"]
    with pytest.raises(HTTPException):
        asyncio.run(talk.shorten("too short to shorten"))


def test_a_scored_answer_is_kept_as_numbers_only_and_counts_in_progress(monkeypatch):
    fake, _ = _fake({"score": 72, "clear": 70})
    monkeypatch.setattr(talk, "_ask", fake)
    before = len(talk.results())
    asyncio.run(talk.score("pushback", "I can add it if the security fix moves to next sprint, otherwise next sprint."))
    rows = talk.results()
    assert len(rows) == before + 1 and rows[-1]["drill"] == "pushback" and rows[-1]["score"] == 72
    assert "answer" not in rows[-1] and "text" not in rows[-1]          # what was said is never kept
    from backend import confidence, debrief  # noqa: F401  (Progress reads the columns they add)
    from backend.routers import progress, sessions as _sessions  # noqa: F401
    out = progress.get_progress()
    assert out["summary"]["talk_drills"] >= 1 and out["talk"][-1]["score"] == 72
    assert out["summary"]["streak_days"] >= 1
