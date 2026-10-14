"""Write's AI review (backend/writing_review.py). Written down first (CLAUDE.md, Testing, rule 3),
one test each:

1. The coach writes the draft: a suggestion long enough to be rewritten text is dropped, and the
   prompt forbids rewriting.
2. A note quotes words that aren't in the draft: its quote is dropped, the note kept.
3. A malformed or empty reply is saved as a review: it is refused, nothing kept.
4. The same text is paid for twice: the review is kept with its text and offered again; after an
   edit it says it is out of date.
5. What is priced differs from what is sent: both come from the same prompt.
6. Too much text, or none: refused before any call.
7. A deleted section or project leaves its reviews behind.
"""
from backend.tests import _env  # noqa: F401

import asyncio
from unittest import mock

import pytest
from fastapi import HTTPException

from backend import writing, writing_review as wr
from backend.core import sessions as sess
from backend.routers import mock as mock_router

TEXT = "Remote work has spread quickly. Studies show it helps wellbeing. However, isolation remains a risk for some workers."


def project_with_text(text=TEXT):
    p = writing.create_project("Review me", "essay", 2000)
    sec = p["sections"][1]
    writing.update_section(sec["id"], {"body": text})
    return p["id"], sec["id"]


def ask_returning(reply, seen=None):
    async def ask(model, system, message, **kw):
        if seen is not None:
            seen.update(system=system, message=message, kind=kw.get("kind"))
        return reply
    return mock.patch.object(mock_router, "_ask_model", side_effect=ask)


GOOD = {"summary": "A clear start that needs more evidence.", "strengths": ["Clear topic sentence"],
        "notes": [{"quote": "Studies show it helps wellbeing", "issue": "Which studies?", "why": "Claims need sources.",
                   "try": "Name the study and cite it, then say what it shows: \"This suggests that …\""}],
        "next": "Add a citation to each claim."}


def test_the_coach_never_hands_back_rewritten_text():
    rewrite = "Remote working has expanded rapidly across many sectors, and a growing body of peer-reviewed research indicates that it can improve employee wellbeing, although social isolation continues to pose a substantial risk for a minority of workers in practice."
    out = wr.clean({**GOOD, "notes": [{**GOOD["notes"][0], "try": rewrite}]}, TEXT)
    assert out["notes"][0]["try"] == "" and out["notes"][0]["issue"] == "Which studies?"
    system, _, _ = wr.build(*project_with_text())
    assert "Never rewrite" in system and "You never write it" in system


def test_a_ready_made_sentence_in_quotes_is_dropped_even_when_short_overall():
    # Both came back from a real review (12 Oct 2026) and would have been pasted in.
    for tip in ("End the section by clarifying what the evidence suggests: 'For most workers, wellbeing gains outweigh "
                "isolation risks, but particular groups—perhaps…—experience net harm.'",
                "After stating your thesis, add: 'I'll first examine broad wellbeing gains, then show which workers "
                "suffer isolation, before arguing that overall gains mask uneven impact.'"):
        out = wr.clean({**GOOD, "notes": [{**GOOD["notes"][0], "try": tip}]}, TEXT)
        assert out["notes"][0]["try"] == "", tip
    pattern = "Interpret the figure: 'This suggests that …' or \"In contrast to X, Y …\", then link it to your thesis."
    assert wr.clean({**GOOD, "notes": [{**GOOD["notes"][0], "try": pattern}]}, TEXT)["notes"][0]["try"] == pattern
    long_next = "Rewrite your introduction to move from context to focus. " * 20
    assert wr.clean({**GOOD, "next": long_next}, TEXT)["next"].endswith("focus.")


def test_a_quote_not_in_the_draft_is_dropped_but_the_note_kept():
    out = wr.clean({**GOOD, "notes": [{**GOOD["notes"][0], "quote": "Studies prove it always helps"}]}, TEXT)
    assert out["notes"][0]["quote"] == "" and out["notes"][0]["issue"]
    kept = wr.clean(GOOD, TEXT.replace("Studies", "Studies"))
    assert kept["notes"][0]["quote"] == "Studies show it helps wellbeing"


@pytest.mark.parametrize("reply", ["not json", {"notes": "x"}, {"summary": "", "strengths": [], "notes": []}])
def test_a_malformed_or_empty_reply_is_refused_and_nothing_kept(reply):
    pid, sid = project_with_text()
    with ask_returning(reply), pytest.raises(HTTPException) as e:
        asyncio.run(wr.review(pid, sid))
    assert e.value.status_code == 502
    assert wr.saved(pid, sid) is None


def test_a_review_is_kept_for_its_text_and_marked_out_of_date_after_an_edit():
    pid, sid = project_with_text()
    with ask_returning(GOOD):
        asyncio.run(wr.review(pid, sid))
    again = wr.saved(pid, sid)
    assert again["summary"] == GOOD["summary"] and again["stale"] is False
    assert wr.estimate(pid, sid)["saved"]["stale"] is False
    writing.update_section(sid, {"body": TEXT + " A new sentence."})
    assert wr.saved(pid, sid)["stale"] is True
    assert wr.saved(pid, None) is None   # the whole draft is reviewed separately


def test_what_is_priced_is_what_is_sent():
    pid, sid = project_with_text()
    writing.update_project(pid, {"thesis": "Remote work helps most workers.", "brief": "Evaluate remote work."})
    seen = {}
    with ask_returning(GOOD, seen):
        asyncio.run(wr.review(pid, None))
    system, message, _ = wr.build(pid, None)
    assert (seen["system"], seen["message"], seen["kind"]) == (system, message, "write_review")
    assert "THE WRITER'S THESIS:\nRemote work helps most workers." in message and TEXT in message


def test_nothing_or_too_much_is_refused_before_any_call():
    p = writing.create_project("Empty", "essay")
    with pytest.raises(HTTPException) as e:
        wr.build(p["id"], p["sections"][0]["id"])
    assert e.value.status_code == 400
    pid, sid = project_with_text("word " * (wr.MAX_CHARS // 4))
    with pytest.raises(HTTPException):
        wr.build(pid, sid)


def test_deleting_a_section_or_project_deletes_its_reviews():
    pid, sid = project_with_text()
    with ask_returning(GOOD):
        asyncio.run(wr.review(pid, sid))
        asyncio.run(wr.review(pid, None))
    writing.delete_section(sid)
    assert wr.saved(pid, sid) is None
    writing.delete_project(pid)
    with sess._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM writing_reviews WHERE project_id = ?", (pid,)).fetchone()[0] == 0


# ── From the audit of 12 Oct 2026 ─────────────────────────────────────────────────

def test_the_review_is_of_the_text_sent_and_refused_if_it_changed_after_the_price():
    pid, sid = project_with_text()
    priced = wr.estimate(pid, sid)["text_hash"]
    writing.update_section(sid, {"body": TEXT + " Typed after the price was shown."})
    with ask_returning(GOOD), pytest.raises(HTTPException) as e:
        asyncio.run(wr.review(pid, sid, text_hash=priced))
    assert e.value.status_code == 409
    fresh = wr.estimate(pid, sid)["text_hash"]

    async def ask_then_edit(model, system, message, **kw):
        writing.update_section(sid, {"body": TEXT + " Typed while the AI was reading."})
        return GOOD
    with mock.patch.object(mock_router, "_ask_model", side_effect=ask_then_edit):
        asyncio.run(wr.review(pid, sid, text_hash=fresh))
    assert wr.saved(pid, sid)["stale"] is True   # the coach never read the new sentence


def test_no_field_hands_over_a_ready_made_sentence():
    rewrite = "'Remote work raised output by twelve per cent among London firms over the two years studied.'"
    out = wr.clean({**GOOD, "summary": f"Start with {rewrite}", "next": f"Next: write {rewrite}",
                    "strengths": [f"You could say {rewrite}"]}, TEXT)
    for text in (out["summary"], out["next"], out["strengths"][0]):
        assert "twelve per cent" not in text and "…" in text
