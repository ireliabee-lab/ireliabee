"""
Write's AI review: a coach that reads a section, or the whole draft, and says what is strong, what
to work on and why (docs/academic-writing.md, stage 5).

The coach never writes the draft. The owner decided this (12 Oct 2026) to keep writers safe under
university integrity and AI-use rules. The prompt forbids rewriting, and `clean` also drops any
suggestion long enough to be a rewritten passage, and any note quoting words that aren't in the text.

Each review is one AI call (kind ``write_review``), priced before it runs, and kept with a
fingerprint of the text it read: opening it again costs nothing, and it says when the text has
changed since.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException

from . import writing
from .core import sessions as sess

#: The most text one review reads: a long chapter. Beyond it, review a section at a time.
MAX_CHARS = 60_000
#: Suggestions are strategies and short patterns, never passages: longer than this is dropped.
TRY_MAX_WORDS = 30
QUOTE_MAX_WORDS = 30
NOTES_MAX = 6
#: For the estimate: the instructions, and a full answer.
PROMPT_TOKENS = 900
ANSWER_TOKENS = 900

RULES = """You coach academic writing. You never write it.

- Never rewrite the writer's sentences, and never give replacement text for their draft. Explain what
  to change and why. You may show a short general pattern of academic phrasing (at most 8 words, with
  … for the writer's content), such as "This suggests that …" or "In contrast to X, Y …". Never give a
  whole sentence the writer could paste in, not even as an example: describe what it should do instead.
- Quote the draft exactly when you point at something: copy at most 25 words from it, unchanged.
- Judge it as {genre} writing{style_note}. Be specific, honest and kind. Praise only what is good.
- Use British English. Address the writer as "you".

Return ONLY JSON:
{{"summary": "one sentence on where this stands",
 "strengths": ["up to 3 specific strengths"],
 "notes": [{{"quote": "exact words from the draft", "issue": "what is weak", "why": "why it matters to a marker",
            "try": "how to fix it, as a strategy or a short pattern, not rewritten text"}}],
 "next": "the single most useful thing to do next"}}
At most {notes} notes, most important first."""

SECTION_FOCUS = """Read the SECTION below, part of a {genre}. The writer is working on: {section_title}.
What this section should do: {hint}
Look at: whether each paragraph opens with a topic sentence and keeps to one idea; whether evidence is
interpreted, not only reported; the writer's own voice at the start and end of paragraphs; links between
sentences and paragraphs (linking words that match the logic, known information before new); claims
hedged to match the evidence; precise, formal wording.{extra}"""

DRAFT_FOCUS = """Read the whole DRAFT below, a {genre}. Judge its structure and argument, not its sentences:
whether the introduction moves from context to focus to thesis to structure; whether the sections follow
the order the thesis promises and each serves it; whether paragraphs build on each other; whether
sources are synthesised (compared, connected) rather than listed; whether the conclusion concludes
(what it all shows) rather than only summarising, with no new evidence.{extra}"""

GENRE_EXTRA = {
    "literature_review": " For a literature review: sources grouped by theme, not one by one; each critiqued (method, sample, applicability), not only described; the gap made explicit.",
    "reflective": " For reflection: Describe briefly, then Interpret, Evaluate and Plan; feelings and experience linked to theory; first person is right here.",
    "research_paper": " For a research paper: an introduction that establishes the territory, shows the gap and says how this study fills it; methods that could be repeated; results reported without interpretation; a discussion that interprets and admits limitations.",
    "research_proposal": " For a proposal: a clear question and purpose, a method that can answer it, and why it matters.",
    "report": " For a report: findings under clear headings, each recommendation tied to a finding.",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ensure_schema() -> None:
    with sess._connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS writing_reviews (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id  INTEGER NOT NULL,
                section_id  INTEGER,                    -- NULL: the whole draft
                text_hash   TEXT NOT NULL,              -- what it read, to say when that has changed
                result_json TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_writing_reviews ON writing_reviews(project_id, section_id);
            """
        )


_ensure_schema()


def _fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def _genre_name(project: dict) -> str:
    try:
        return writing.genre(project["genre"])["title"].lower()
    except HTTPException:
        return "academic"


def build(project_id: int, section_id: Optional[int]) -> tuple[str, str, dict]:
    """The system prompt, the message and the project: what the review sends, and what is priced."""
    p = writing.get_project(project_id)
    g = writing.genre(p["genre"])
    style_note = "" if g.get("first_person") else ", which is usually impersonal"
    rules = RULES.format(genre=g["title"].lower(), style_note=style_note, notes=NOTES_MAX)
    extra = GENRE_EXTRA.get(p["genre"], "")
    context = []
    if p["brief"].strip():
        context.append(f"THE TASK, AS SET:\n{p['brief'].strip()[:3000]}")
    if p["focus"].strip():
        context.append(f"THE WRITER'S FOCUS OR QUESTION:\n{p['focus'].strip()[:1000]}")
    if p["thesis"].strip():
        context.append(f"THE WRITER'S THESIS:\n{p['thesis'].strip()[:1000]}")
    if section_id is None:
        text = "\n\n".join(f"## {s['title']}\n{s['body'].strip()}" for s in p["sections"] if s["body"].strip())
        focus = DRAFT_FOCUS.format(genre=g["title"].lower(), extra=extra)
        label = "DRAFT"
    else:
        sec = next((s for s in p["sections"] if s["id"] == section_id), None)
        if sec is None:
            raise HTTPException(404, "Section not found.")
        text = sec["body"].strip()
        hint = next((t["hint"] for t in g["sections"] if t["key"] == sec["key"]), "carry its part of the argument")
        focus = SECTION_FOCUS.format(genre=g["title"].lower(), section_title=sec["title"], hint=hint, extra=extra)
        label = "SECTION"
    if not text:
        raise HTTPException(400, "There is nothing written here to review yet.")
    if len(text) > MAX_CHARS:
        raise HTTPException(400, "This is too long to review in one go. Review it a section at a time.")
    message = "\n\n".join([focus, *context, f"{label}:\n{text}"])
    return rules, message, p


def estimate(project_id: int, section_id: Optional[int], model: Optional[str] = None) -> dict:
    """Credits for one review. ``credits`` is None when the service's prices aren't known: never a
    guess, because it is shown as a price."""
    from .core import hosted
    from .errors import resolve_llm
    system, message, _ = build(project_id, section_id)
    in_tokens = (len(system) + len(message)) // 4
    try:
        model_name, _ = resolve_llm(model)
    except Exception:
        model_name = model or "default"
    credits = None if hosted.is_admin() else hosted.credits_for(model_name, in_tokens, ANSWER_TOKENS)
    return {"words": writing.words(message), "credits": round(credits, 2) if credits is not None else None,
            "saved": saved(project_id, section_id),
            # What was priced: a review of different text is refused, so the price shown is the price paid.
            "text_hash": _fingerprint(_reviewed_text(project_id, section_id))}


def _words(text: str) -> int:
    return len(re.findall(r"[\w'’-]+", text or ""))


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip().lower().replace("’", "'").replace("“", '"').replace("”", '"')


#: A quoted example longer than this is a sentence to paste, not a pattern ("This suggests that …").
PATTERN_MAX_WORDS = 12
#: Text in quotes: "…", “…”, or '…' / ‘…’ opened after a space or colon (so "writer's" isn't one).
#: An apostrophe between letters ("I'll", "writer's") is inside the quote, not its end.
QUOTED = re.compile(r"[\"“]([^\"”]{1,600})[\"”]|(?:^|(?<=[\s:(]))['‘]((?:[^'’]|(?<=\w)['’](?=\w)){1,600}?)['’](?=[\s.,;:)!?]|$)")


def _strip_handover(text: str) -> str:
    """A field with a ready-made sentence in quotes loses that sentence: the coach describes, it doesn't write."""
    return QUOTED.sub(lambda m: m.group(0) if _words(m.group(1) or m.group(2)) <= PATTERN_MAX_WORDS else "…", text)


def _hands_over_text(tip: str) -> bool:
    """Whether a suggestion carries a ready-made sentence: a quoted span longer than a pattern."""
    return any(_words(a or b) > PATTERN_MAX_WORDS for a, b in QUOTED.findall(tip))


def _cut(text: str, n: int) -> str:
    """At most n characters, ending at a sentence (or word) rather than mid-word."""
    if len(text) <= n:
        return text
    head = text[:n]
    end = max(head.rfind(". "), head.rfind("! "), head.rfind("? "))
    return head[:end + 1] if end > n // 2 else head[:head.rfind(" ")].rstrip(",;:") + "…"


def clean(raw: Any, text: str) -> dict:
    """The review in the shape asked for. A note quoting words not in the text loses its quote; a
    suggestion long enough to be rewritten text, or carrying a ready-made sentence in quotes, is
    dropped, whatever the model sent."""
    if not isinstance(raw, dict):
        raise HTTPException(502, "The review came back in a form the app can't read. Nothing was saved; try again.")
    plain = lambda v, n: _cut(re.sub(r"\s+", " ", str(v or "")).strip(), n)  # noqa: E731
    body = _squash(text)
    notes = []
    for n in raw.get("notes") or []:
        if not isinstance(n, dict) or not plain(n.get("issue"), 400):
            continue
        quote = plain(n.get("quote"), 300).strip('"“”')
        if quote and (_words(quote) > QUOTE_MAX_WORDS or _squash(quote) not in body):
            quote = ""
        tip = plain(n.get("try"), 400)
        if _words(tip) > TRY_MAX_WORDS or _hands_over_text(tip):
            tip = ""          # a passage, not a strategy: the coach does not write the draft
        notes.append({"quote": quote, "issue": _strip_handover(plain(n.get("issue"), 400)),
                      "why": _strip_handover(plain(n.get("why"), 400)), "try": tip})
        if len(notes) == NOTES_MAX:
            break
    out = {
        "summary": _strip_handover(plain(raw.get("summary"), 400)),
        "strengths": [_strip_handover(plain(s, 300)) for s in (raw.get("strengths") or []) if plain(s, 300)][:3],
        "notes": notes,
        "next": _strip_handover(plain(raw.get("next"), 600)),
    }
    if not (out["summary"] or out["notes"] or out["strengths"]):
        raise HTTPException(502, "The review came back empty. Nothing was saved; try again.")
    return out


def _reviewed_text(project_id: int, section_id: Optional[int]) -> str:
    p = writing.get_project(project_id)
    if section_id is None:
        return "\n\n".join(s["body"] for s in p["sections"])
    return next((s["body"] for s in p["sections"] if s["id"] == section_id), "")


def saved(project_id: int, section_id: Optional[int]) -> Optional[dict]:
    """The last review of this section (or of the whole draft), and whether the text has changed since."""
    with sess._connect() as conn:
        row = conn.execute(
            "SELECT * FROM writing_reviews WHERE project_id = ? AND section_id IS ? ORDER BY id DESC LIMIT 1",
            (project_id, section_id)).fetchone()
    if row is None:
        return None
    return {**json.loads(row["result_json"]), "created_at": row["created_at"],
            "stale": row["text_hash"] != _fingerprint(_reviewed_text(project_id, section_id))}


async def review(project_id: int, section_id: Optional[int], model: Optional[str] = None, fallback_credits: bool = False,
                 text_hash: Optional[str] = None) -> dict:
    """One review: the coach's notes, kept with the text it read. `text_hash`, from the estimate, is the
    text that was priced: if the text has changed since, the review is refused so it can be priced again."""
    from .routers.mock import _ask_model
    # The text as sent: edits saved while the AI reads don't count as reviewed.
    text = _reviewed_text(project_id, section_id)
    if text_hash is not None and text_hash != _fingerprint(text):
        raise HTTPException(409, "The text has changed since the price was worked out. Check the price again, then review.")
    system, message, _ = build(project_id, section_id)
    raw = await _ask_model(model, system, message, kind="write_review", fallback_credits=fallback_credits)
    result = clean(raw, text)
    with sess._connect() as conn:
        conn.execute("INSERT INTO writing_reviews (project_id, section_id, text_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
                     (project_id, section_id, _fingerprint(text), json.dumps(result, ensure_ascii=False), _now()))
    return {**result, "created_at": _now(), "stale": False}
