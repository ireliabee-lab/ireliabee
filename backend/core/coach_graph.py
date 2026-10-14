"""
Coach turn as a pipeline of nodes, run in order by routers/coach.py.

Layout:

    START
      │
      ▼
  classify_turn        (cheap LLM: Haiku / Flash / DeepSeek chat)
      │
      ▼
  match_plan           (no LLM: string overlap against plan.answers_prep)
      │
      ▼
  route                (no LLM: decides which model to use in compose)
      │
      ▼
  compose_reply        (chosen LLM; streams if streaming=True)
      │
      ▼
   END

Design rules:
  * Fast path: simple/small-talk turns can skip the expensive model.
  * Any node can fall back to the current `respond()` pipeline on failure.
  * Streaming is opt-in — CLI turns it on, batch runs (research) keep sync.
"""
from __future__ import annotations

import os
import re
from typing import Optional, TypedDict, Literal

from .providers import respond, PROVIDERS


TurnType = Literal["question", "statement", "small_talk", "pivot", "instruction"]


class TurnState(TypedDict, total=False):
    # ─── Input (set by caller) ────────────────────────────────────────
    transcript: str
    speaker: str                 # "you" | "interviewer" | "unknown"
    plan: Optional[dict]
    briefing_present: bool
    system_prompt: str
    history: list[dict]
    provider: str                # default LLM provider
    model: str                   # default LLM model

    # ─── Intermediate ─────────────────────────────────────────────────
    turn_type: Optional[TurnType]
    matched_answer_idx: Optional[int]
    matched_answer_text: Optional[str]
    routing_decision: str        # "cheap" | "default" | "premium"
    routing_reason: str

    # ─── Output ───────────────────────────────────────────────────────
    reply: str
    error: Optional[str]


# ─── Model tier registry ──────────────────────────────────────────────
# Given a provider, pick the cheap/default/premium models.
TIER_MAP = {
    "anthropic": {
        "cheap":   "claude-haiku-4-5",
        "default": "claude-sonnet-4-6",
        "premium": "claude-opus-4-7",
    },
    "openai": {
        "cheap":   "gpt-5-mini",
        "default": "gpt-5-mini",
        "premium": "gpt-5",
    },
    "deepseek": {
        "cheap":   "deepseek-chat",
        "default": "deepseek-chat",
        "premium": "deepseek-reasoner",
    },
    "gemini": {
        "cheap":   "gemini-2.5-flash",
        "default": "gemini-2.5-flash",
        "premium": "gemini-2.5-pro",
    },
}


def _tier_model(provider: str, tier: str, fallback: str) -> str:
    return TIER_MAP.get(provider, {}).get(tier, fallback)


# ─── Nodes ────────────────────────────────────────────────────────────

CLASSIFY_SYSTEM = (
    "You classify a single conversation turn. Output ONE token only, no "
    "prose, no punctuation. Valid outputs: question | statement | small_talk | "
    "pivot | instruction. "
    "\n\n"
    "Definitions:\n"
    "  question    = the speaker is asking something that expects an answer\n"
    "  statement   = the speaker is asserting something (not asking)\n"
    "  small_talk  = greetings, filler, weather, non-substantive\n"
    "  pivot       = a section-change signal ('let's move on', 'next topic')\n"
    "  instruction = the speaker is telling the user what to do\n"
)


SMALL_TALK_MARKERS = {
    "hello", "hi", "hey", "how are you", "nice to meet",
    "good morning", "good afternoon", "good evening", "thanks",
    "thank you", "cheers", "bye", "goodbye", "see you",
}
PIVOT_MARKERS = {
    "let's move on", "next topic", "moving on", "shall we",
    "next question", "let's talk about", "one more thing",
}


def _has_phrase(text: str, phrases: set[str]) -> bool:
    # Whole words only: a plain substring test matched "hi" inside "this"/"which"/"hire".
    return any(re.search(rf"\b{re.escape(p)}\b", text) for p in phrases)


def _fast_classify(transcript: str, speaker: str) -> Optional[TurnType]:
    """Fast heuristic. Returns None when unsure (fall back to LLM)."""
    t = transcript.lower().strip()
    if not t:
        return "small_talk"
    words = t.split()
    n = len(words)

    # Very short utterances are almost always small_talk
    if n < 4:
        return "small_talk"

    # Explicit greeting / closing markers
    if n < 12 and _has_phrase(t, SMALL_TALK_MARKERS):
        return "small_talk"

    # Pivot signals
    if _has_phrase(t, PIVOT_MARKERS):
        return "pivot"

    # Ends with ? → question
    if t.endswith("?"):
        return "question"

    # Speaker heuristics: interviewer utterances are usually questions or
    # instructions; user utterances are usually statements.
    if speaker == "interviewer" and n > 6:
        # Contains a wh-word or "how" → almost certainly a question
        wh = {"what", "why", "how", "when", "where", "which", "who",
              "tell me", "walk me", "explain", "describe", "could you", "can you"}
        for w in wh:
            if w in t:
                return "question"
        return "question"  # default for interviewer

    if speaker == "you" and n > 6:
        return "statement"

    return None  # let the LLM classifier decide


def classify_node(state: TurnState) -> TurnState:
    """Fast heuristic → LLM classifier only if ambiguous."""
    transcript = state.get("transcript", "").strip()
    speaker = state.get("speaker", "unknown")

    fast = _fast_classify(transcript, speaker)
    if fast is not None:
        state["turn_type"] = fast
        return state

    # Ambiguous — call cheap-tier classifier.
    provider = state["provider"]
    cheap_model = _tier_model(provider, "cheap", state["model"])
    try:
        raw = respond(
            provider=provider, model=cheap_model,
            transcript=transcript, history=[],
            system_prompt=CLASSIFY_SYSTEM,
        )
        cleaned = raw.strip().lower().split()[0].strip(".,;:!?")
        if cleaned in ("question", "statement", "small_talk", "pivot", "instruction"):
            state["turn_type"] = cleaned  # type: ignore
        else:
            state["turn_type"] = "question"
    except Exception as e:
        state["error"] = f"classify: {e}"
        state["turn_type"] = "question"
    return state


def match_plan_node(state: TurnState) -> TurnState:
    """Try to match the transcript to a prepared answer in the plan. No LLM."""
    plan = state.get("plan")
    if not plan:
        return state

    prep = plan.get("answers_prep") or []
    if not prep:
        return state

    transcript_words = {w.lower().strip(".,;:!?") for w in state.get("transcript", "").split()}
    best_idx = -1
    best_overlap = 0
    for i, ans in enumerate(prep):
        ans_words = {w.lower().strip(".,;:!?") for w in ans.split() if len(w) > 3}
        overlap = len(transcript_words & ans_words)
        if overlap > best_overlap:
            best_overlap = overlap
            best_idx = i
    if best_overlap >= 2:  # meaningful overlap (2+ substantive words)
        state["matched_answer_idx"] = best_idx
        state["matched_answer_text"] = prep[best_idx]
    return state


def route_node(state: TurnState) -> TurnState:
    """Decide which model tier to use for the compose step. No LLM."""
    turn_type = state.get("turn_type") or "question"
    matched = state.get("matched_answer_text") is not None
    briefing = state.get("briefing_present", False)

    if turn_type == "small_talk":
        state["routing_decision"] = "cheap"
        state["routing_reason"] = "small talk — cheap model is enough"
    elif turn_type == "pivot":
        state["routing_decision"] = "cheap"
        state["routing_reason"] = "pivot — no reasoning needed"
    elif matched:
        state["routing_decision"] = "cheap"
        state["routing_reason"] = "matched a prepared answer — cheap model can compose"
    elif turn_type == "question" and briefing:
        state["routing_decision"] = "default"
        state["routing_reason"] = "question needs briefing-informed answer"
    elif turn_type == "question":
        state["routing_decision"] = "default"
        state["routing_reason"] = "question with no briefing — default is fine"
    else:
        state["routing_decision"] = "default"
        state["routing_reason"] = "default tier"
    return state


def compose_node(state: TurnState) -> TurnState:
    """Actually compose the SAY/ANALYSIS/WHY response."""
    provider = state["provider"]
    default_model = state["model"]
    tier = state.get("routing_decision", "default")
    model = _tier_model(provider, tier, default_model)

    # Prepend a note to the transcript so the model knows the turn type +
    # matched answer if any.
    prefix_lines = [f"[TURN TYPE: {state.get('turn_type', 'question')}]"]
    if state.get("matched_answer_text"):
        prefix_lines.append(
            f"[MATCHES PREPARED ANSWER #{state['matched_answer_idx']}: "
            f"{state['matched_answer_text']}]\n"
            "Use this preparation as the backbone of SAY, but adapt to what "
            "was actually asked."
        )
    prefixed_transcript = "\n".join(prefix_lines) + "\n\n" + state["transcript"]

    try:
        # We call respond() with a COPY of history so the classifier & match
        # nodes don't pollute the persistent conversation memory.
        history_copy = list(state.get("history", []))
        reply = respond(
            provider=provider, model=model,
            transcript=prefixed_transcript, history=history_copy,
            system_prompt=state["system_prompt"],
        )
        state["reply"] = reply
    except Exception as e:
        state["reply"] = ""
        state["error"] = f"compose: {e}"
    return state
