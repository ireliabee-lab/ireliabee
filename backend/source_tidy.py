"""
A saved transcript, tidied by the AI: punctuation, paragraphs and who is speaking.

A YouTube import (link_import.caption_paragraphs) already reads as paragraphs, but captions rarely
say who is talking, and older automatic captions have no punctuation at all. Working that out takes
judgement, so it is an AI text job (kind ``tidy``): its cost is shown before it runs, it goes to the
user's own assistant when that is on, and the result is saved as a new Library document, so the
original and every note that cites its pages stay exactly as they were.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Optional

from fastapi import HTTPException

#: Text sent in one call, in tokens: its answer (the same words, with punctuation and JSON) stays
#: well inside one answer's 4,096 output tokens, in any script. Japanese or Chinese run about a token
#: a character, English about four characters a token, so parts are sized in tokens, not characters.
PART_TOKENS = 1500
#: Calls in flight at once after the first, which names the speakers for the rest. The user's own
#: assistant answers one request at a time, so with it they go one by one.
PARALLEL = 4
#: For the estimate: the instructions and context per call, and the reply's JSON overhead.
PROMPT_TOKENS = 450
REPLY_OVERHEAD = 1.25
#: A tidied part keeps the original's words, in order, less "um"s and stumbles: at least this share
#: of them must come back, and no more than this share may be new. Otherwise it is not kept.
KEPT_SHARE, NEW_SHARE = 0.85, 0.1
#: Errors that will fail every other part too: stop, save nothing, and say why.
FATAL_CODES = {"relay_not_listening", "out_of_credits", "no_model", "missing_key", "invalid_key", "signed_out", "not_signed_in"}
#: Links being tidied right now, so a second run can't start (and be paid for) meanwhile.
_running: set[str] = set()
#: The line link_import puts between the transcript and the video's description.
DESCRIPTION_MARK = "Video description"
TIDIED = "tidied"

TIDY_PROMPT = """You tidy part of a transcript so it is easy to read. It came from captions, so it
may lack punctuation and capitals, and it does not say who is speaking.

1. Add punctuation and capitals, and split it into paragraphs at natural breaks.
2. Keep every word that was said. You may drop filler sounds (um, uh, er) and a word said twice by
   accident. Never summarise, shorten, reword, add or reorder.
3. Work out who is speaking, from what is said: questions and answers, someone introducing
   themselves or being thanked by name, the TITLE, CHANNEL and DESCRIPTION. Give each speaker their
   name when the transcript or the context makes it clear; otherwise "Host", "Guest", "Speaker 3".
   KNOWN SPEAKERS, when given, are the names already used earlier in this transcript: use the same
   ones. If only one person speaks, the speaker is that person (or "Speaker") throughout.
4. Start a new paragraph whenever the speaker changes.

Return ONLY JSON:
{"speakers": ["names used, in order of first appearance"],
 "paragraphs": [{"speaker": "Name", "text": "the paragraph"}, ...]}"""


def _source(doc_id: int) -> tuple[dict, dict]:
    """The document and its link metadata; only an imported link that isn't itself a tidied copy."""
    from . import document_store
    doc = document_store.get_document(doc_id)
    if doc is None:
        raise HTTPException(404, "Document not found")
    meta = doc.get("source") or {}
    if isinstance(meta, str):
        meta = json.loads(meta or "{}")
    if not meta.get("url"):
        raise HTTPException(400, "Only a source saved from a link can be tidied.")
    if meta.get("method") == TIDIED:
        raise HTTPException(400, "This is already a tidied copy.")
    return doc, meta


def split_description(text: str) -> tuple[str, str]:
    """The transcript, and the video description link_import appended after it ("" when none)."""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if line.strip() == DESCRIPTION_MARK:
            return "\n".join(lines[:i]).strip(), "\n".join(lines[i + 1:]).strip()
    return text.strip(), ""


#: Scripts written without spaces between words: about a token, and a word, per character.
DENSE = "\u0e00-\u0e7f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff"
_DENSE_RE = re.compile(f"[{DENSE}]")


def tokens_of(text: str) -> int:
    """About how many tokens a text is: a character each in dense scripts, four characters elsewhere."""
    dense = len(_DENSE_RE.findall(text))
    return dense + (len(text) - dense) // 4


def chunks(transcript: str, budget: int = PART_TOKENS) -> list[str]:
    """Paragraphs packed into parts of about `budget` tokens; a paragraph is split only when it alone is longer."""
    parts, current = [], ""
    for para in (p.strip() for p in transcript.split("\n")):
        if not para:
            continue
        while tokens_of(para) > budget:
            # As many characters as fit the budget at this paragraph's density, cut at a space if one is near.
            size = max(50, int(budget * len(para) / max(1, tokens_of(para))))
            cut = para.rfind(" ", 0, size)
            cut = cut if cut > size // 2 else size
            if current:
                parts.append(current)
                current = ""
            parts.append(para[:cut].strip())
            para = para[cut:].strip()
        if current and tokens_of(current) + tokens_of(para) > budget:
            parts.append(current)
            current = para
        else:
            current = f"{current}\n{para}" if current else para
    if current:
        parts.append(current)
    return parts


def words_of(text: str) -> list[str]:
    """The words, lower case, curly apostrophes made straight; each character of a dense script is one."""
    text = text.lower().replace("\u2019", "'").replace("\u2018", "'")
    return re.findall(f"[{DENSE}]|[^\\W_]+(?:'[^\\W_]+)*", text)


def _words(text: str) -> int:
    return len(words_of(text))


def keeps_words(original: str, tidied: str) -> bool:
    """Whether the tidied text is the original's words, in order: punctuation and capitals added,
    fillers dropped, nothing summarised, reworded or invented."""
    from difflib import SequenceMatcher
    a, b = words_of(original), words_of(tidied)
    if not a:
        return not b
    kept = sum(m.size for m in SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks())
    return kept >= KEPT_SHARE * len(a) and len(b) - kept <= NEW_SHARE * len(a) + 2


def checked(reply, original: str) -> Optional[list[tuple[Optional[str], str]]]:
    """The reply's (speaker, paragraph) pairs, or None when it isn't the shape asked for or its
    words don't add up to the original's: then that part keeps its original text."""
    paras = reply.get("paragraphs") if isinstance(reply, dict) else None
    if not isinstance(paras, list) or not paras:
        return None
    out = []
    for p in paras:
        if not isinstance(p, dict) or not isinstance(p.get("text"), str) or not p["text"].strip():
            return None
        speaker = p.get("speaker")
        speaker = re.sub(r"\s+", " ", speaker).strip()[:60] if isinstance(speaker, str) and speaker.strip() else None
        out.append((speaker, re.sub(r"\s+", " ", p["text"]).strip()))
    return out if keeps_words(original, " ".join(t for _, t in out)) else None


def compose(parts: list[Optional[list[tuple[Optional[str], str]]]], originals: list[str]) -> str:
    """One paragraph per line. With more than one speaker, each change of speaker starts a turn,
    "— Name: …" (the Text view shows it as a turn); a part that wasn't kept is its original text."""
    speakers = {s for part in parts if part for s, _ in part if s}
    many = len(speakers) > 1
    lines, last = [], None
    for part, original in zip(parts, originals):
        if part is None:
            lines.extend(original.split("\n"))
            last = None
            continue
        for speaker, text in part:
            if many and speaker and speaker != last:
                lines.append(f"— {speaker}: {text}")
            else:
                lines.append(text)
            last = speaker or last
    return "\n".join(lines)


def _context(doc: dict, meta: dict, description: str, known: list[str]) -> str:
    """Title and channel always; the description only while no names are known yet. Once the first
    part has named the speakers, sending it again with every part would only cost more."""
    head = [f"TITLE: {doc.get('name') or ''}", f"CHANNEL: {meta.get('author') or ''}"]
    if description and not known:
        head.append(f"DESCRIPTION: {description[:1500]}")
    if known:
        head.append("KNOWN SPEAKERS: " + ", ".join(known))
    return "\n".join(head)


def tidied_copy(url: str) -> Optional[dict]:
    """The tidied copy already saved for this link, if any: tidying it again would be paid twice."""
    from .core.sessions import _connect
    with _connect() as conn:
        rows = conn.execute(
            "SELECT d.id, d.name, s.metadata FROM documents d JOIN document_sources s ON s.document_id = d.id "
            "ORDER BY d.id DESC").fetchall()
    for r in rows:
        try:
            m = json.loads(r["metadata"] or "{}")
        except ValueError:
            continue
        if m.get("method") == TIDIED and m.get("url") == url:
            return {"id": r["id"], "name": r["name"]}
    return None


def estimate(doc_id: int, model: Optional[str] = None) -> dict:
    """Credits to tidy the transcript. ``credits`` is None when the service's prices aren't
    known: never a guess, because it is shown as a price."""
    from .core import hosted
    from .errors import resolve_llm
    doc, meta = _source(doc_id)
    transcript, description = split_description(_full_text(doc_id))
    parts = chunks(transcript)
    text_tokens = tokens_of(transcript)
    # The description goes with the first part (with every part, if the first names no one: allow for two).
    in_tokens = len(parts) * PROMPT_TOKENS + text_tokens + 2 * tokens_of(description[:1500])
    out_tokens = int(text_tokens * REPLY_OVERHEAD)
    try:
        model_name, _ = resolve_llm(model)
    except Exception:
        model_name = model or "default"
    credits = None if hosted.is_admin() else hosted.credits_for(model_name, in_tokens, out_tokens)
    return {"parts": len(parts), "characters": len(transcript), "credits": round(credits, 2) if credits is not None else None,
            "existing": tidied_copy(meta["url"])}


def _full_text(doc_id: int) -> str:
    from . import document_store
    return document_store.get_document_text(doc_id)


async def tidy(doc_id: int, model: Optional[str] = None, fallback_credits: bool = False, again: bool = False) -> dict:
    """Tidy every part and save the result as a new Library document beside the original.

    The first part goes alone, so the names it finds are given to the rest, which then run a few
    at a time. A part that fails or comes back wrong keeps its original text; only when every part
    fails is the error raised (so "your assistant isn't listening" still reaches the user)."""
    doc, meta = _source(doc_id)
    if meta["url"] in _running:
        raise HTTPException(409, "This video is being tidied already. Its copy will appear in your Library when it's done.")
    if not again and (copy := tidied_copy(meta["url"])):
        raise HTTPException(409, f"This video is already tidied, as \"{copy['name']}\". Open that copy, or choose to tidy it again.")
    _running.add(meta["url"])
    try:
        return await _tidy(doc, meta, doc_id, model, fallback_credits)
    finally:
        _running.discard(meta["url"])


def _fatal(e: Exception) -> bool:
    """An error every other part would hit too: no credits, not signed in, the assistant not listening."""
    code = getattr(e, "code", None)
    if isinstance(code, str) and code in FATAL_CODES:
        return True
    if isinstance(e, HTTPException):
        detail = e.detail if isinstance(e.detail, dict) else {}
        return e.status_code in (401, 402, 403) or detail.get("code") in FATAL_CODES
    return False


async def _tidy(doc: dict, meta: dict, doc_id: int, model: Optional[str], fallback_credits: bool) -> dict:
    from . import link_import, relay
    from .routers.mock import _ask_model
    transcript, description = split_description(_full_text(doc_id))
    originals = chunks(transcript)
    if not originals:
        raise HTTPException(400, "There is no transcript to tidy.")

    errors: list[Exception] = []

    async def one(text: str, known: list[str]):
        try:
            reply = await _ask_model(model, TIDY_PROMPT, f"{_context(doc, meta, description, known)}\n\nTRANSCRIPT\n{text}",
                                     kind="tidy", fallback_credits=fallback_credits)
        except Exception as e:  # noqa: BLE001 - parts already paid for are kept; raised if nothing comes back
            errors.append(e)
            return None
        return checked(reply, text)

    first = await one(originals[0], [])
    if first is None and errors:
        raise errors[0]  # not listening, out of credits, offline: say so before trying every other part
    known = list(dict.fromkeys(s for s, _ in first or [] if s))
    one_by_one = relay.is_enabled() and not fallback_credits   # the assistant answers one at a time
    gate = asyncio.Semaphore(1 if one_by_one else PARALLEL)

    async def gated(text: str):
        async with gate:
            return await one(text, known)

    rest = await asyncio.gather(*(gated(t) for t in originals[1:]))
    fatal = next((e for e in errors if _fatal(e)), None)
    if fatal is not None:
        raise fatal   # out of credits, signed out, assistant gone: a copy left mostly untidied helps no one
    parts = [first, *rest]
    if all(p is None for p in parts):
        if errors:
            raise errors[0]
        raise HTTPException(502, "The AI's answer didn't keep the transcript's words, so nothing was saved. Try again.")

    text = compose(parts, originals)
    if description:
        text += f"\n{DESCRIPTION_MARK}\n{description}"
    title = f"{doc.get('name') or 'Transcript'} (tidied)"
    saved = link_import.save_source(meta["url"], title, text, meta.get("author") or "", method=TIDIED)
    speakers = list(dict.fromkeys(s for p in parts if p for s, _ in p if s))
    return {"document": saved, "speakers": speakers if len(speakers) > 1 else [],
            "parts": len(parts), "kept_original": sum(p is None for p in parts)}
