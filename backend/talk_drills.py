"""
Talk at work (Study mode, S4; the communication-practice framework in docs/study-mode.md).

Short spoken or typed drills for everyday work talk, scored for what the
listener needs: the main point first (BLUF), clear, short enough, and honest
without hedging. Three kinds:

- scenarios: a stand-up, pushing back, giving bad news, asking for help,
  saying you don't know, a status update when you're behind;
- impromptu: a random topic, 60 seconds, organise your thoughts fast;
- write it shorter: a Slack message or email, about half as long and BLUF.

Counting filler words and hedges is plain code (confidence.py's word lists;
repetitions are never counted). Feedback is one AI call per answer.
"""
from __future__ import annotations

import hashlib
import re
from datetime import date
from typing import Any, Optional

from fastapi import HTTPException

from .core import sessions as sess

#: Real situations, each with who is listening and how long a good answer takes.
SCENARIOS: list[dict] = [
    {"id": "standup", "kind": "Stand-up", "seconds": 30, "listener": "your tech lead and five engineers who want to get back to work",
     "brief": "Yesterday you worked on the password reset feature. You hit 403 errors from the email service, spent three hours "
              "debugging, found the API key had expired, renewed it, and emails work again. The full reset flow isn't done. "
              "Today you plan to finish it."},
    {"id": "behind", "kind": "Status when behind", "seconds": 45, "listener": "your manager, who promised the client a date",
     "brief": "The export feature was due Friday. A data-format problem means it will be next Wednesday. You have a fix "
              "planned and could ship a partial export on Friday if that helps."},
    {"id": "pushback", "kind": "Pushing back", "seconds": 45, "listener": "a product manager asking for one more feature this sprint",
     "brief": "The sprint is already full. Adding the feature would push the security fix to next sprint. You can do the "
              "feature if the security fix moves, or next sprint if it doesn't."},
    {"id": "bad_news", "kind": "Bad news", "seconds": 45, "listener": "a customer whose report failed overnight",
     "brief": "Last night's report didn't run because of a server update. Their data is safe. It will rerun by 11:00 today "
              "and you've added a check so it can't fail silently again."},
    {"id": "help", "kind": "Asking for help", "seconds": 30, "listener": "a senior colleague who is busy",
     "brief": "Your tests pass locally but fail in CI with a timeout. You've tried raising the timeout and running them alone. "
              "You think it's the database setup in CI but don't know how it's configured."},
    {"id": "dont_know", "kind": "Saying you don't know", "seconds": 30, "listener": "an interviewer who asked about a tool you haven't used",
     "brief": "They asked how you'd tune Kafka consumer lag. You haven't used Kafka, but you have tuned queue consumers in "
              "RabbitMQ and know how you'd find out."},
    {"id": "explain_up", "kind": "Explaining to a non-engineer", "seconds": 60, "listener": "the CEO, who isn't technical",
     "brief": "Pages load slowly because every visit asks the database for the same product list. A cache would keep a copy "
              "in memory and refresh it every few minutes. It takes two days and cuts load time by about half."},
    {"id": "feedback", "kind": "Giving feedback", "seconds": 45, "listener": "a teammate whose pull requests are too large to review",
     "brief": "Their last three pull requests were over 1,500 lines. Reviews take days and bugs slip through. You'd like "
              "changes split into smaller pieces, and you're happy to pair on how."},
]

#: Topics for 60-second impromptu talks: everyday enough that nobody needs to look anything up.
TOPICS: list[str] = [
    "The best piece of advice you've been given", "A tool you couldn't work without", "What makes a good meeting",
    "Something you changed your mind about", "How you learn something new quickly", "The most useful skill nobody teaches",
    "A mistake that taught you something", "What a great manager does differently", "Working from home or the office",
    "How you decide what to do first", "The last problem you solved", "What you'd automate if you could",
    "A book, talk or video that stuck with you", "How to say no politely", "What makes code easy to read",
    "The best team you've been part of", "Something you're proud of this year", "How you handle a hard deadline",
    "Why documentation matters", "A habit that makes your work better", "What you'd tell yourself on your first day",
    "How to explain your job to a ten-year-old", "The most overrated thing in your field", "How you stay focused",
]

TALK_PROMPT = """You coach someone practising everyday work talk, as JSON only. Be kind, direct and specific.
You get the SITUATION (who is listening and what they need), the time a good answer takes, and the ANSWER they gave.

Judge it for the LISTENER, not the speaker:
- "bluf": true if the first sentence gives the main point (bottom line up front).
- "clear": 0-100, how easy it is for this listener to follow and act on.
- "length": "too short", "right" or "too long" for the time given.
- "strengths": up to 2 short things that worked.
- "fixes": up to 3 short, concrete changes, most important first.
- "better": the same answer rewritten the way a strong communicator would say it, in their voice, about the right length.
  Keep every fact from the SITUATION and the ANSWER; never invent new facts.
- "score": 0-100 overall.

Never comment on fluency, pauses, repetition or stuttering. Judge only the content and how it is organised.

Return ONLY: {{"bluf": false, "clear": 0, "length": "right", "strengths": [], "fixes": [], "better": "", "score": 0}}"""

SHORTEN_PROMPT = """You make a work message shorter and clearer, as JSON only.
You get the KIND (a chat message or an email) and the MESSAGE.

- Rewrite it at about half the length or less, bottom line up front: what you need or what happened, first.
- Keep every fact, number, date, name and request. Never add facts. Keep the writer's tone, minus filler and
  apologies ("just", "actually", "sorry but", "I think maybe").
- End with the one thing the reader should do, when there is one.
- "cut": up to 4 short descriptions of what you removed and why.

Return ONLY: {{"shorter": "...", "cut": ["..."]}}"""


def _ensure_schema() -> None:
    with sess._connect() as conn:
        # Scores and counts only: what was said is never kept.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS talk_results (
                   id         INTEGER PRIMARY KEY AUTOINCREMENT,
                   drill      TEXT NOT NULL,          -- a scenario id, or "impromptu"
                   score      INTEGER NOT NULL,
                   words      INTEGER NOT NULL,
                   fillers    INTEGER NOT NULL,
                   hedges     INTEGER NOT NULL,
                   created_at TEXT NOT NULL
               )"""
        )


_ensure_schema()


def results() -> list[dict]:
    """Every scored answer, oldest first, for Progress."""
    with sess._connect() as conn:
        return [{"drill": r["drill"], "score": r["score"], "words": r["words"], "fillers": r["fillers"],
                 "hedges": r["hedges"], "date": r["created_at"]}
                for r in conn.execute("SELECT * FROM talk_results ORDER BY id")]


def delivery(text: str) -> dict:
    """Counted, not judged: words, filler words and hedges. Repetitions are never counted."""
    from .confidence import FILLERS, HEDGES
    words = len(re.findall(r"[\w'’-]+", text or ""))
    found = [m.group(0).lower() for m in FILLERS.finditer(text or "")] + \
            [m.group(0).lower() for m in HEDGES.finditer(text or "")]
    return {"words": words, "fillers": sum(1 for _ in FILLERS.finditer(text or "")),
            "hedges": sum(1 for _ in HEDGES.finditer(text or "")), "examples": sorted(set(found))[:5]}


def topic_for(day: Optional[date] = None, skip: int = 0) -> str:
    """Today's impromptu topic (the same all day), or the next one along when asked for another."""
    day = day or date.today()
    n = int(hashlib.sha256(day.isoformat().encode()).hexdigest(), 16)
    return TOPICS[(n + skip) % len(TOPICS)]


def drills(skip: int = 0) -> dict:
    return {"scenarios": SCENARIOS, "topic": topic_for(skip=skip), "impromptu_seconds": 60}


def _clean_talk(raw: Any) -> dict:
    raw = raw if isinstance(raw, dict) else {}

    def pct(v: Any) -> int:
        try:
            return max(0, min(100, int(v)))
        except (TypeError, ValueError):
            return 0

    length = raw.get("length") if raw.get("length") in ("too short", "right", "too long") else "right"
    return {"bluf": bool(raw.get("bluf")), "clear": pct(raw.get("clear")), "length": length, "score": pct(raw.get("score")),
            "strengths": [str(s).strip()[:200] for s in raw.get("strengths") or [] if str(s).strip()][:2],
            "fixes": [str(s).strip()[:200] for s in raw.get("fixes") or [] if str(s).strip()][:3],
            "better": str(raw.get("better") or "").strip()[:1500]}


async def _ask(system: str, message: str, kind: str, model: Optional[str], fallback_credits: bool) -> Any:
    from . import languages
    from .errors import FriendlyError
    from .routers.mock import _ask_model
    try:
        # `kind` bills the call and names it for the user's own assistant (the worker thread's kind).
        return await _ask_model(model, system + languages.json_block(None), message, kind=kind,
                                fallback_credits=fallback_credits)
    except FriendlyError as fe:
        raise fe.http()


async def score(drill: str, answer: str, topic: str = "", seconds: Optional[int] = None, model: Optional[str] = None,
                fallback_credits: bool = False) -> dict:
    """Feedback on one answer to a scenario or an impromptu topic, with its counted delivery."""
    answer = (answer or "").strip()[:4000]
    if len(answer.split()) < 4:
        raise HTTPException(400, detail={"code": "invalid", "title": "Say a little more",
                                         "message": "Give your answer in a sentence or two first."})
    if drill == "impromptu":
        topic = (topic or "").strip()[:200]
        if not topic:
            raise HTTPException(400, detail={"code": "invalid", "title": "No topic", "message": "Pick a topic first."})
        situation = (f"An impromptu 60-second talk to a friendly audience of colleagues on: {topic}. "
                     "A good one has one clear point, two or three reasons or examples, and a closing line.")
        target = 60
    else:
        sc = next((s for s in SCENARIOS if s["id"] == drill), None)
        if not sc:
            raise HTTPException(404, detail={"code": "invalid", "title": "Unknown drill", "message": "Pick a drill from the list."})
        situation = f"{sc['kind']}. Listening: {sc['listener']}. What happened: {sc['brief']}"
        target = sc["seconds"]
    took = f"\nThey took about {int(seconds)} seconds." if seconds else ""
    message = f"SITUATION\n{situation}\n\nTIME A GOOD ANSWER TAKES\nabout {target} seconds{took}\n\nANSWER\n{answer}"
    raw = await _ask(TALK_PROMPT, message, "talk_drill", model, fallback_credits)
    out = {**_clean_talk(raw), "delivery": delivery(answer), "target_seconds": target}
    from datetime import datetime, timezone
    with sess._connect() as conn:
        conn.execute("INSERT INTO talk_results (drill, score, words, fillers, hedges, created_at) VALUES (?,?,?,?,?,?)",
                     (drill, out["score"], out["delivery"]["words"], out["delivery"]["fillers"], out["delivery"]["hedges"],
                      datetime.now(timezone.utc).isoformat(timespec="seconds")))
    return out


async def shorten(text: str, kind: str = "chat", model: Optional[str] = None, fallback_credits: bool = False) -> dict:
    """A work message about half as long, BLUF, with what was cut and why."""
    text = (text or "").strip()[:6000]
    if len(text.split()) < 12:
        raise HTTPException(400, detail={"code": "invalid", "title": "Too short to shorten",
                                         "message": "Paste a message of a few sentences."})
    kind = "email" if kind == "email" else "chat"
    raw = await _ask(SHORTEN_PROMPT, f"KIND\n{'an email' if kind == 'email' else 'a chat message'}\n\nMESSAGE\n{text}",
                     "talk_shorten", model, fallback_credits)
    raw = raw if isinstance(raw, dict) else {}
    shorter = str(raw.get("shorter") or "").strip()[:6000]
    if not shorter:
        raise HTTPException(502, detail={"code": "unknown", "title": "Nothing came back", "message": "Try again in a moment."})
    before, after = len(text.split()), len(shorter.split())
    return {"shorter": shorter, "cut": [str(c).strip()[:200] for c in raw.get("cut") or [] if str(c).strip()][:4],
            "words_before": before, "words_after": after, "saved_percent": max(0, round(100 * (before - after) / before))}
