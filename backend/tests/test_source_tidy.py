"""Tidying a saved transcript with the AI (backend/source_tidy.py). The ways it can go wrong were
written down first (CLAUDE.md, Testing, rule 3), one test each:

1. The AI drops or invents words: that part keeps its original text.
2. The reply isn't the JSON asked for: that part keeps its original text.
3. Speakers named one way in the first part and another later: the rest are told the first part's names.
4. Only one person speaks: no speaker labels.
5. The original document, and the pages its notes cite, change: never; the result is a new document.
6. Paying twice: a tidied copy can't be tidied again, and a file that isn't an imported link is refused.
7. The AI fails part-way: what came back is kept; nothing back at all raises (not listening, no credits).
8. The video description is tidied or lost: it is sent as context only and kept at the end unchanged.
9. Paying twice for the same video: a second tidy is refused unless asked for again on purpose.
10. Paying for the description over and over: once the first part has named the speakers, the rest
    are sent the names, not the description again.
"""
from backend.tests import _env  # noqa: F401

import asyncio
from unittest import mock

import pytest
from fastapi import HTTPException

from backend import document_store, link_import, source_tidy
from backend.routers import mock as mock_router

TRANSCRIPT = "\n".join([
    "so tell me how the lab started it started with a memo",
    "right the memo said we would build personal super intelligence and we got to work",
    "Video description",
    "An interview with Nat Friedman about the lab.",
])


_videos = iter(range(10_000))


def saved(text=TRANSCRIPT, method="public", url=None):
    """A saved YouTube link; each its own video unless `url` is given."""
    url = url or f"https://www.youtube.com/watch?v=vid{next(_videos):08d}"
    return link_import.save_source(url, "The lab", text, "Some Channel", method)


def run(doc_id, replies):
    """tidy() with the AI answering `replies` in turn (a dict, or an Exception to raise); returns (result, prompts)."""
    prompts, queue = [], list(replies)

    async def ask(model, system, message, **kw):
        prompts.append(message)
        r = queue.pop(0)
        if callable(r):
            r = r(message.split("TRANSCRIPT\n", 1)[1])
        if isinstance(r, Exception):
            raise r
        return r
    with mock.patch.object(mock_router, "_ask_model", side_effect=ask):
        return asyncio.run(source_tidy.tidy(doc_id)), prompts


TWO = {"speakers": ["Host", "Nat"], "paragraphs": [
    {"speaker": "Host", "text": "So, tell me how the lab started."},
    {"speaker": "Nat", "text": "It started with a memo. Right, the memo said we would build personal super intelligence, and we got to work."},
]}


def test_a_two_person_transcript_becomes_labelled_turns_in_a_new_document():
    doc = saved()
    before = document_store.get_document_text(doc["id"])
    out, _ = run(doc["id"], [TWO])
    text = document_store.get_document_text(out["document"]["id"])
    assert text.split("\n")[:2] == ["— Host: So, tell me how the lab started.",
                                    "— Nat: It started with a memo. Right, the memo said we would build personal super intelligence, and we got to work."]
    assert out["speakers"] == ["Host", "Nat"]
    assert out["document"]["id"] != doc["id"] and out["document"]["source"]["method"] == "tidied"
    assert out["document"]["name"] == "The lab (tidied)"
    assert document_store.get_document_text(doc["id"]) == before, "the original is never changed"


LONG = "\n".join(["so tell me how the lab started it started with a memo " * 40] * 3)


def echo(name):
    """A reply that keeps the part's words, all said by `name`."""
    return lambda part: {"speakers": [name], "paragraphs": [{"speaker": name, "text": part.replace("\n", " ")}]}


def test_dropped_or_invented_words_keep_the_original_part():
    short = {"speakers": ["Host"], "paragraphs": [{"speaker": "Host", "text": "The lab began with a memo."}]}
    assert source_tidy.checked(short, "so tell me how the lab started it started with a memo") is None
    doc = saved(LONG)
    parts = len(source_tidy.chunks(document_store.get_document_text(doc["id"])))
    assert parts > 1
    out, _ = run(doc["id"], [echo("Nat")] + [short] * (parts - 1))
    assert out["kept_original"] == parts - 1
    with pytest.raises(HTTPException) as e:   # nothing usable at all: nothing saved
        run(saved()["id"], [short])
    assert e.value.status_code == 502


@pytest.mark.parametrize("reply", ["not json", {"paragraphs": "x"}, {"paragraphs": [{"speaker": "A"}]}, {"paragraphs": []}])
def test_a_reply_in_the_wrong_shape_keeps_the_original_part(reply):
    assert source_tidy.checked(reply, "some words here") is None


def test_later_parts_are_told_the_names_the_first_part_found():
    doc = saved(LONG)
    parts = len(source_tidy.chunks(document_store.get_document_text(doc["id"])))
    assert parts > 1
    out, prompts = run(doc["id"], [echo("Nat")] * parts)
    assert "KNOWN SPEAKERS" not in prompts[0]
    assert all("KNOWN SPEAKERS: Nat" in p for p in prompts[1:])


def test_one_speaker_gets_no_labels():
    doc = saved("it started with a memo and we got to work on it")
    out, _ = run(doc["id"], [{"speakers": ["Nat"], "paragraphs": [{"speaker": "Nat", "text": "It started with a memo, and we got to work on it."}]}])
    assert document_store.get_document_text(out["document"]["id"]) == "It started with a memo, and we got to work on it."
    assert out["speakers"] == []


def test_a_tidied_copy_or_a_plain_file_cannot_be_tidied():
    tidied = saved(method="tidied")
    with pytest.raises(HTTPException) as e:
        source_tidy.estimate(tidied["id"])
    assert e.value.status_code == 400
    plain = document_store.create_document("notes", "notes.txt", "text/plain", b"just some notes")
    with pytest.raises(HTTPException):
        asyncio.run(source_tidy.tidy(plain))


def test_nothing_back_raises_and_a_late_failure_keeps_what_came_back():
    doc = saved()
    with pytest.raises(RuntimeError):
        run(doc["id"], [RuntimeError("relay_not_listening")])
    big = saved(LONG)
    parts = len(source_tidy.chunks(document_store.get_document_text(big["id"])))
    out, _ = run(big["id"], [echo("Nat")] + [RuntimeError("timeout")] * (parts - 1))
    assert out["kept_original"] == parts - 1


def test_the_description_is_context_only_and_kept_unchanged_at_the_end():
    doc = saved()
    out, prompts = run(doc["id"], [TWO])
    assert "DESCRIPTION: An interview with Nat Friedman" in prompts[0]
    assert "An interview with Nat Friedman" not in prompts[0].split("TRANSCRIPT")[1]
    assert document_store.get_document_text(out["document"]["id"]).endswith("Video description\nAn interview with Nat Friedman about the lab.")


def test_a_second_tidy_of_the_same_video_is_refused_unless_asked_again():
    doc = saved()
    run(doc["id"], [TWO])
    assert source_tidy.estimate(doc["id"])["existing"]["name"] == "The lab (tidied)"
    with pytest.raises(HTTPException) as e:
        run(doc["id"], [TWO])
    assert e.value.status_code == 409
    prompts = []

    async def ask(model, system, message, **kw):
        prompts.append(message)
        return TWO
    with mock.patch.object(mock_router, "_ask_model", side_effect=ask):
        out = asyncio.run(source_tidy.tidy(doc["id"], again=True))
    assert out["document"]["source"]["method"] == "tidied" and len(prompts) == 1


def test_the_description_goes_once_and_the_names_after_it():
    doc = saved(LONG + "\nVideo description\nAn interview with Nat Friedman.")
    parts = len(source_tidy.chunks(source_tidy.split_description(document_store.get_document_text(doc["id"]))[0]))
    assert parts > 1
    _, prompts = run(doc["id"], [echo("Nat")] * parts)
    assert "DESCRIPTION:" in prompts[0]
    assert all("DESCRIPTION:" not in p and "KNOWN SPEAKERS: Nat" in p for p in prompts[1:])


# ── From the audit of 12 Oct 2026 ─────────────────────────────────────────────────

def test_dense_scripts_are_sized_and_counted_by_character():
    japanese = "東京で話しました" * 600            # 4,800 characters, about as many tokens
    assert len(source_tidy.chunks(japanese)) >= 3   # never one part whose answer can't fit
    assert source_tidy.words_of("東京です") == ["東", "京", "で", "す"]
    assert source_tidy.keeps_words("東京で話しました", "東京で、話しました。")


def test_a_reworded_or_summarised_part_is_refused_even_at_the_same_length():
    original = "so tell me how the lab started it started with a memo and then we got to work"
    assert source_tidy.keeps_words(original, "So, tell me how the lab started. It started with a memo, and then we got to work.")
    assert not source_tidy.keeps_words(original, "Tell me about the lab's origins: a memo began it, after which the team started working hard.")
    assert not source_tidy.keeps_words(original, "The lab began with a memo.")
    assert source_tidy.keeps_words("we don't know", "We don’t know.")   # a curly apostrophe is the same word


def test_running_out_of_credits_part_way_saves_nothing_and_says_why():
    big = saved(LONG)
    parts = len(source_tidy.chunks(document_store.get_document_text(big["id"])))
    out_of_credits = HTTPException(402, {"code": "out_of_credits", "message": "You're out of credits"})
    with pytest.raises(HTTPException) as e:
        run(big["id"], [echo("Nat")] + [out_of_credits] * (parts - 1))
    assert e.value.status_code == 402
    assert source_tidy.tidied_copy(document_store.get_document(big["id"])["source"]["url"]) is None


def test_a_second_run_while_one_is_going_is_refused():
    doc = saved()
    url = document_store.get_document(doc["id"])["source"]["url"]
    source_tidy._running.add(url)
    try:
        with pytest.raises(HTTPException) as e:
            run(doc["id"], [TWO])
        assert e.value.status_code == 409 and "being tidied" in e.value.detail
    finally:
        source_tidy._running.discard(url)


def test_with_the_users_own_assistant_parts_go_one_at_a_time():
    big = saved(LONG + "\n" + LONG)
    parts = len(source_tidy.chunks(document_store.get_document_text(big["id"])))
    assert parts > 2
    busy = {"now": 0, "most": 0}

    async def ask(model, system, message, **kw):
        busy["now"] += 1; busy["most"] = max(busy["most"], busy["now"])
        await asyncio.sleep(0.01)
        busy["now"] -= 1
        return echo("Nat")(message.split("TRANSCRIPT\n", 1)[1])
    from backend import relay
    with mock.patch.object(mock_router, "_ask_model", side_effect=ask), mock.patch.object(relay, "is_enabled", return_value=True):
        asyncio.run(source_tidy.tidy(big["id"]))
    assert busy["most"] == 1
