"""Questions answered in a notebook come back for review on the shared SM-2 schedule, with no AI."""
from backend.tests import _env  # noqa: F401
import asyncio  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from backend import notebook as nb, study_reviews as study  # noqa: E402

T0 = datetime(2026, 10, 8, 9, 0, tzinfo=timezone.utc)
POINTS = ["Stress does not cause stuttering", "It can make it worse"]


def _card(notebook_id: int, score: int, question: str = "Does stress cause stuttering?", now=T0) -> dict:
    return study.add(notebook_id, "Acute stress does not cause stuttering but may increase it.", question,
                     POINTS, score, src=[1], now=now)


@pytest.fixture
def notebook_id():
    made = nb.create_notebook("reading", title="Stuttering")
    yield made["id"]
    try:
        nb.delete_notebook(made["id"])
    except HTTPException:
        pass


def test_scores_become_review_grades():
    assert [study.grade_for(s) for s in (0, 49, 50, 69, 70, 89, 90, 100)] == [0, 0, 1, 1, 2, 2, 3, 3]


def test_a_good_first_answer_comes_back_tomorrow_and_a_miss_in_minutes(notebook_id):
    good = _card(notebook_id, 80)
    assert good["due"].startswith("2026-10-09T09:00")
    assert good["points"] == POINTS and good["src"] == [1] and good["last_score"] == 80

    missed = _card(notebook_id, 20, question="What makes stuttering worse?")
    assert missed["due"].startswith("2026-10-08T09:10")


def test_answering_the_same_question_again_reschedules_one_card(notebook_id):
    first = _card(notebook_id, 80)
    again = _card(notebook_id, 80, now=T0 + timedelta(days=1))
    assert again["id"] == first["id"] and again["reps"] == 2
    assert study.due(now=T0 + timedelta(days=30), notebook_id=notebook_id)["total"] >= 1


def test_due_lists_only_what_is_due_oldest_first_and_caps_the_day(notebook_id):
    for i in range(5):
        _card(notebook_id, 20, question=f"Question {i}?", now=T0 + timedelta(minutes=i))
    _card(notebook_id, 95, question="Easy one?")              # due in days, not now
    later = T0 + timedelta(hours=1)
    out = study.due(now=later, limit=3, notebook_id=notebook_id)
    assert out["due"] == 5 and len(out["cards"]) == 3
    assert [c["question"] for c in out["cards"]] == ["Question 0?", "Question 1?", "Question 2?"]
    assert out["cards"][0]["notebook_title"] == "Stuttering"


def test_review_moves_the_card_on(notebook_id):
    card = _card(notebook_id, 20)
    nxt = study.review(card["id"], 90, now=T0 + timedelta(minutes=15))
    assert nxt["last_score"] == 90 and nxt["due"] > card["due"]


def test_nothing_to_keep_without_a_question(notebook_id):
    with pytest.raises(HTTPException):
        study.add(notebook_id, "text", "", POINTS, 50)


NOTES = [{"text": "Stress does not cause stuttering.", "src": [1]},
         {"text": "Anxiety can make it worse.", "src": [2]},
         {"text": "It is a neurological difference.", "src": [3]}]


def test_chapter_questions_keep_shape_and_only_real_pages():
    raw = {"questions": [
        {"question": "Why is stress not the cause?", "points": ["It is neurological"], "notes": [1, 3, 9]},
        {"question": "", "points": ["dropped"]},
        {"question": "No points, dropped"},
        {"question": "What does anxiety do?", "points": ["Makes it worse"]},   # no notes: all of them
    ] + [{"question": f"Extra {i}?", "points": ["x"], "notes": [1]} for i in range(5)]}
    out = study.clean_chapter_questions(raw, NOTES)
    assert len(out) == 3                                # first five kept, two of them invalid
    assert out[0]["src"] == [1, 3] and "neurological" in out[0]["paragraph"]
    assert out[1]["src"] == [1, 2, 3]


def test_chapter_questions_are_made_once_then_kept(notebook_id, monkeypatch):
    doc = {"sections": [{"id": "s1", "title": "Stress", "blocks": [
        {"type": "point", "text": n["text"], "src": n["src"]} for n in NOTES]}]}
    monkeypatch.setattr(study, "chapter_notes", lambda nid, sid: (doc["sections"][0], NOTES))
    calls = []

    async def fake_ask(model, system, message, doc_id, fallback_credits=False, kind=None):
        calls.append(kind)
        return {"questions": [{"question": "Why?", "points": ["a"], "notes": [1]},
                              {"question": "How?", "points": ["b"], "notes": [2]}]}

    from backend import reading
    monkeypatch.setattr(reading, "_ask", fake_ask)
    first = asyncio.run(study.chapter_questions(notebook_id, "s1"))
    again = asyncio.run(study.chapter_questions(notebook_id, "s1"))
    assert calls == ["study_questions"]
    assert first["cached"] is False and again["cached"] is True
    assert [q["question"] for q in again["questions"]] == ["Why?", "How?"]


def test_delivery_counts_fillers_and_hedges_but_never_repetitions():
    out = study.delivery("Um, I think it is, it is basically the the brain. Maybe stress makes it worse.")
    assert out["fillers"] == 2 and out["hedges"] == 2       # um, basically / i think, maybe
    assert "the the" not in " ".join(out["examples"])        # repeated words are not counted
    assert out["words"] > 10 and out["avg_sentence_words"] > 0


def test_explain_twice_needs_two_real_explanations(notebook_id):
    with pytest.raises(HTTPException):
        asyncio.run(study.explain_twice(notebook_id, "s1", "Too short", "Also short here"))


def test_explain_twice_feedback_is_kept_to_shape(notebook_id, monkeypatch):
    doc = {"sections": [{"id": "s1", "title": "Stress", "blocks": []}]}
    monkeypatch.setattr(study, "chapter_notes", lambda nid, sid: (doc["sections"][0], NOTES))
    seen = {}

    async def fake_ask(model, system, message, doc_id, fallback_credits=False, kind=None):
        seen.update(kind=kind, system=system, message=message)
        return {"expert": {"accurate": 140, "missed": ["a", "b", "c", "d"], "bluf": True, "note": "Good."},
                "beginner": {"accurate": "x", "plain": 70, "analogy": True, "unexplained": ["neurological"],
                             "wrong": [{"said": "stress causes it", "fix": "It does not cause it"}, {"said": "no fix"}]}}

    from backend import reading
    monkeypatch.setattr(reading, "_ask", fake_ask)
    out = asyncio.run(study.explain_twice(notebook_id, "s1", "Stuttering is a neurological difference, not stress.",
                                          "Think of it like a hiccup in how speech is timed, um, basically."))
    assert seen["kind"] == "study_explain"
    assert "Never comment on fluency, pauses, repetition or stuttering" in seen["system"]
    assert out["expert"]["accurate"] == 100 and len(out["expert"]["missed"]) == 3
    assert out["beginner"]["accurate"] == 0 and out["beginner"]["analogy"] is True
    assert out["beginner"]["wrong"] == [{"said": "stress causes it", "fix": "It does not cause it"}]
    assert out["beginner"]["delivery"]["fillers"] == 2 and "plain" not in out["expert"]


def test_every_answer_is_logged_for_progress(notebook_id):
    before = len(study.progress()["answers"])
    card = _card(notebook_id, 60, question="Logged question?")
    study.review(card["id"], 90, now=T0 + timedelta(days=1))
    out = study.progress(now=T0 + timedelta(days=400))
    assert len(out["answers"]) == before + 2 and [a["score"] for a in out["answers"][-2:]] == [60, 90]
    assert out["due"] >= 1
    from backend import confidence, debrief  # noqa: F401  (Progress reads the columns they add)
    from backend.routers import progress, sessions as _sessions  # noqa: F401
    summary = progress.get_progress()["summary"]
    assert summary["study_answers"] >= 2 and summary["avg_study"] is not None


def test_the_estimate_is_the_services_price_and_free_questions_once_made(notebook_id, monkeypatch):
    from backend.core import hosted
    doc = {"sections": [{"id": "s1", "title": "Stress", "blocks": []}]}
    monkeypatch.setattr(study, "chapter_notes", lambda nid, sid: (doc["sections"][0], NOTES))
    monkeypatch.setattr(hosted, "is_admin", lambda: False)
    seen = []
    monkeypatch.setattr(hosted, "credits_for", lambda m, i, o: seen.append((i, o)) or 0.5)
    first = study.chapter_estimate(notebook_id, "s1")
    assert first == {"questions_ready": False, "answers": 4, "credits": 0.5}

    import json as _json
    from backend.core import sessions
    with sessions._connect() as conn:
        conn.execute("INSERT OR REPLACE INTO study_chapters VALUES (?,?,?,?,?)",
                     (notebook_id, "s1", "some", _json.dumps([{"question": "q", "points": ["a"], "src": [], "paragraph": "p" * 400}] * 3), "now"))
    again = study.chapter_estimate(notebook_id, "s1")
    assert again["questions_ready"] is True and again["answers"] == 3
    assert seen[1][0] < seen[0][0]                               # no questions call any more: fewer tokens
    monkeypatch.setattr(hosted, "credits_for", lambda m, i, o: None)
    assert study.chapter_estimate(notebook_id, "s1")["credits"] is None   # unknown prices: no number, never a guess


def test_deleting_a_notebook_deletes_its_cards():
    made = nb.create_notebook("reading", title="Gone soon")
    card = _card(made["id"], 50)
    nb.delete_notebook(made["id"])
    with pytest.raises(HTTPException):
        study.review(card["id"], 50)
