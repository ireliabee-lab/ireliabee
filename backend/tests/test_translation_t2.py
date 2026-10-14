"""Translation T2: finished caption lines are translated beside the original, billed with the session."""
from backend.tests import _env  # noqa: F401
import asyncio  # noqa: E402
from unittest import mock  # noqa: E402

from backend.caption_translate import CaptionTranslator  # noqa: E402
from backend.core import hosted  # noqa: E402


def test_only_a_different_single_language_turns_it_on():
    send = lambda m: None  # noqa: E731
    assert CaptionTranslator.for_call(send, "fr", None) is None
    assert CaptionTranslator.for_call(send, "fr", "fr") is None
    assert CaptionTranslator.for_call(send, "fr", "multi") is None
    assert CaptionTranslator.for_call(send, "fr", "xx") is None
    assert CaptionTranslator.for_call(send, "fr", "en").target == "en"


def test_lines_are_translated_with_context_and_sent_beside_the_original():
    sent, calls = [], []

    async def send(msg):
        sent.append(msg)

    def fake_respond(provider, model, text, history, system, max_tokens):
        from backend.core import providers
        calls.append({"text": text, "system": system, "max_tokens": max_tokens,
                      "kind": providers.current_kind(), "fallback": providers.is_fallback_credits()})
        return "Translated: " + text.rsplit("LINE\n", 1)[1]

    async def run():
        t = CaptionTranslator(send, "en", session_id=7)
        t.add("Bonjour à tous.", "interviewer")
        t.add("Parlez-moi de vous.", "interviewer")
        t.add("   ", "user")                              # nothing to translate
        await t.close()

    with mock.patch("backend.core.providers.respond", side_effect=fake_respond), \
         mock.patch("backend.errors.resolve_llm", return_value=("deepseek-chat", "hosted")):
        asyncio.run(run())

    assert len(calls) == 2
    assert {m["text"] for m in sent} == {"Bonjour à tous.", "Parlez-moi de vous."}
    second = next(c for c in calls if c["text"].endswith("Parlez-moi de vous."))
    assert "BEFORE\nBonjour à tous." in second["text"]        # the line before, for context
    assert all(c["kind"] == "translate" and c["fallback"] for c in calls)   # iReliabee's AI, never the relay
    assert all("English" in c["system"] and c["max_tokens"] <= 300 for c in calls)
    assert all(m["type"] == "translation" and m["speaker"] == "interviewer" for m in sent)


def test_a_failed_translation_never_breaks_the_call():
    sent = []

    async def send(msg):
        sent.append(msg)

    async def run():
        t = CaptionTranslator(send, "en")
        t.add("Une ligne.", "user")
        await t.close()

    with mock.patch("backend.core.providers.respond", side_effect=RuntimeError("provider down")), \
         mock.patch("backend.errors.resolve_llm", return_value=("m", "hosted")):
        asyncio.run(run())
    assert sent == []


def test_the_relay_is_told_so_it_can_bill_it(monkeypatch):
    monkeypatch.setattr(hosted, "own_key", lambda name: None)
    monkeypatch.setattr(hosted, "access_token", lambda: "tok")
    plain, _ = hosted.deepgram_endpoint("fr")
    translated, _ = hosted.deepgram_endpoint("fr", translate=True)
    assert plain.endswith("/stt/listen?language=fr")
    assert translated.endswith("/stt/listen?language=fr&translate=1")
