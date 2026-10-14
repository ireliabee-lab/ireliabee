"""
Coach router — HTTP + SSE streaming.

Flow for each turn:
  1. classify + match_plan + route  (fast heuristics, no LLM most of the time)
  2. compose  (streams tokens back via SSE so the UI renders immediately)

Speaker mapping: the frontend sends "user"/"interviewer". The graph's fast-path
heuristic checks for "you"/"interviewer". We normalise "user" → "you" before
calling into the graph so the cheap LLM classify call is skipped for ~95% of turns.
"""
import asyncio
import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Optional, AsyncGenerator

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import languages
from ..core.coach_graph import _fast_classify, match_plan_node, route_node, _tier_model, TurnState
from ..core.templates import render_prompt, TEMPLATES
from ..core.meeting_plans import get_plan
from ..core.config import load_config
from ..errors import FriendlyError, classify, resolve_llm
from ..core import context, prompt_cache
from ..core.providers import respond_with_image
from ..core import profile_store
from ..core import sessions as sess
from ..screen_capture_xp import capture as _screen_capture  # cross-platform wrapper
from ..screen_capture_xp import grab_target as _grab_target, capture_path as _capture_path, crop_capture as _crop_capture
from .. import screen_targets

from ..document_store import get_cv_text, get_active_cv_text, documents_context
from ..people import coach_block

router = APIRouter()

_fallback_sessions: set[int] = set()


def reset_session_fallbacks():
    _fallback_sessions.clear()


def is_session_fallback(session_id: Optional[int]) -> bool:
    return bool(session_id and session_id in _fallback_sessions)


@router.post("/session/{session_id}/fallback")
async def set_session_fallback(session_id: int):
    _fallback_sessions.add(session_id)
    return {"ok": True, "session_id": session_id, "fallback_credits": True}


_MODEL_PROVIDER: dict[str, str] = {
    "claude":   "anthropic",
    "gpt":      "openai",
    "deepseek": "deepseek",
    "gemini":   "gemini",
    "o1":       "openai",
    "o3":       "openai",
}
_DEFAULT_MODEL = "claude-sonnet-4-6"

COMPOSE_SYSTEM_ADDENDUM = ""  # kept for possible future use


def _provider_for(model: str) -> str:
    for prefix, provider in _MODEL_PROVIDER.items():
        if model.startswith(prefix):
            return provider
    return "anthropic"


def _normalise_speaker(speaker: str) -> str:
    """Map frontend speaker names to the graph's heuristic names."""
    return "you" if speaker == "user" else speaker


# ── Response shape + tone ────────────────────────────────────────────────────

# The FULL answer runs ~250 words; 1024 tokens cut it off mid-sentence.
REPLY_MAX_TOKENS = 2048

RESPONSE_TONES = {
    "basic": (
        "LANGUAGE LEVEL — BASIC: use plain, everyday words and short sentences. "
        "Avoid jargon; if a technical term is unavoidable, explain it in a few simple words. "
        "Sound confident and clear, like someone early in their career who knows their stuff."
    ),
    "advanced": (
        "LANGUAGE LEVEL — ADVANCED: use precise domain terminology, name specific methods, tools, "
        "trade-offs and metrics, and show depth of reasoning. Technical vocabulary is not a claim "
        "of seniority — keep every claim at the depth this person genuinely has. "
        "Stay conversational, not textbook recitation."
    ),
}
DEFAULT_RESPONSE_TONE = "advanced"



def english_support_enabled() -> bool:
    return bool(load_config().get("english_support"))


def tone_block(tone: str, language: Optional[str] = None) -> str:
    """Language-level instruction, plus plain-language guidance when language support is on."""
    block = RESPONSE_TONES.get(tone, RESPONSE_TONES[DEFAULT_RESPONSE_TONE])
    return f"{block}\n\n{languages.support_block(language)}" if english_support_enabled() else block


def _resolve_tone(requested: Optional[str]) -> str:
    if requested in RESPONSE_TONES:
        return requested
    saved = load_config().get("response_tone")
    return saved if saved in RESPONSE_TONES else DEFAULT_RESPONSE_TONE


EXPERIENCE_LEVELS = {
    "student": (
        "a student or new graduate",
        "Draw on coursework, personal and academic projects, hackathons and internships. Show "
        "curiosity, fundamentals and how fast they learn. Do not claim production ownership, "
        "on-call responsibility, leading teams or making company-level decisions.",
    ),
    "junior": (
        "a junior professional (about 0–2 years)",
        "Talk about tasks and features they contributed to within a team, what they learned, how "
        "they asked for help, took feedback and grew. Show solid fundamentals and eagerness. Do not "
        "claim they designed large systems, set technical direction, led teams or mentored others.",
    ),
    "mid": (
        "a mid-level professional (about 2–5 years)",
        "They own features end to end, work independently, collaborate across teams and sometimes "
        "help newer teammates. Do not claim org-wide architecture decisions, managing people or "
        "setting strategy.",
    ),
    "senior": (
        "a senior professional (about 5–10 years)",
        "They own systems and technical decisions, reason about trade-offs and risk, mentor others "
        "and influence their team's direction. Stay within what the profile shows about scope.",
    ),
    "lead": (
        "a lead, staff or principal-level professional (10+ years)",
        "They set technical or product direction across teams, shape hiring and standards, and "
        "measure impact at organisation level — still only as the profile supports.",
    ),
}


def _persona_block(profile: dict) -> str:
    name = profile.get("name") or "the candidate"
    level = EXPERIENCE_LEVELS.get((profile.get("experience_level") or "").strip())
    if level:
        who, how = level
        level_text = f"{name} is {who}. {how}"
    else:
        level_text = (
            f"Infer {name}'s real seniority from the background, target role and CV, and keep every "
            "answer at that level."
        )
    return f"""

════════════════════════════════════════════════════════
  SPEAK AS {name.upper()} — the profile above is the source of truth.
════════════════════════════════════════════════════════
Every suggested answer is spoken by {name} in the first person and must sound like
the real person described in the profile, so the interviewer's impression matches who
{name} actually is.

EXPERIENCE LEVEL
{level_text}

• Never claim a title, scope, team size, years of experience, tool, or result that the
  profile, CV or documents don't support. Overselling gets exposed by follow-up questions.
• When a question goes beyond {name}'s experience, stay honest but confident: acknowledge it
  in one short clause (never apologise or dwell on it), pivot straight to the closest thing
  they have genuinely done, and show how they would approach or learn the rest.
• Lean on the listed strengths. Frame weaknesses truthfully, with what {name} is doing to grow."""


def _render_coach_prompt(template_id: str, profile: dict, plan: Optional[dict]) -> str:
    from .stories import stories_prompt_block
    return render_prompt(template_id, profile=profile, plan=plan) + _persona_block(profile) + stories_prompt_block()


def _response_format_block(name: str, tone: str, language: Optional[str] = None) -> str:
    return f"""

════════════════════════════════════════════════════════
  RESPONSE FORMAT — this replaces any output format described above.
════════════════════════════════════════════════════════
Reply with ONLY these three sections, in this order. No analysis, no explanation of why
the answer works, no preamble, no closing notes.

CUES:
- <exactly 3 bullets, at most 6 words each: the key points to hit, in speaking order,
   so {name} can glance at them mid-sentence>

SHORT:
<What {name} can say in 20–30 seconds: 2–4 sentences that answer directly.>

FULL:
<The complete answer {name} gives to an intellectually engaged listener, 150–250 words
(about 60–90 seconds spoken). Lead with the answer, then make it vivid and credible:
a concrete example or story, specific details, mechanisms or numbers drawn from the
background and CV, and a closing line that ties back to the role or the question.
First person, natural spoken language, no bullet points or headings, no meta commentary.>

Only state facts that appear in the background, CV, documents, plan or conversation.
Never invent employers, projects, numbers or results. Where a vivid specific would help
but isn't known, write a short bracketed placeholder such as [your metric] or [project name].
{_pronounce_block() if english_support_enabled() else ""}
{tone_block(tone, language)}{languages.reply_block(language)}"""


def _pronounce_block() -> str:
    return """
After FULL, add one more section:

PRONOUNCE:
- <word or short phrase from your answer> — <syllables with the stressed one in capitals, e.g. an-A-ly-sis> — <a short tip, max 8 words>

List 2–3 words from the answer that non-native speakers often mispronounce or stress wrongly
(technical terms, names of tools, long words). Skip very common words."""


def _meter_stream(provider: str, model: str, usage) -> None:
    """
    Record a streamed call's tokens, splitting out what the cache served.

    Cached input is reported separately by the providers and must not be
    counted as ordinary input as well: doing so would price a cached call like
    an uncached one and make the whole saving invisible in /usage/costs.
    """
    try:
        from ..core import costs
        from ..core.providers import _context, _usage_counts
        cache_read, cache_write = prompt_cache.cache_stats(usage)
        in_tokens, out_tokens = _usage_counts(usage)
        kind, session_id = getattr(_context, "value", None) or ("coach", None)
        costs.record(kind, provider, model, in_tokens=max(0, in_tokens),
                     out_tokens=out_tokens, cache_read=cache_read,
                     cache_write=cache_write, session_id=session_id)
    except Exception:
        pass


# ── Per-provider streaming generators ────────────────────────────────────────

def _stream_anthropic(model: str, transcript: str, history: list, system_prompt: str,
                      served: Optional[dict] = None):
    # The same client every other AI call uses: our service for an ordinary
    # account, the admin's own key for the admin (core/hosted.py). This used
    # to read ANTHROPIC_API_KEY itself, so the live coach — the call a session
    # makes most — failed with "key missing" for everyone but the admin.
    from ..core.providers import _anthropic_client
    client = _anthropic_client()
    msgs = context.trim_history(history) + [{"role": "user", "content": transcript}]
    # The system prompt and the conversation so far are both cached: each turn
    # of a call re-sends everything before it, which is read back from cache
    # at a tenth of the price instead of paid in full every time.
    with client.messages.stream(
        model=model, max_tokens=REPLY_MAX_TOKENS,
        system=prompt_cache.anthropic_system(system_prompt), messages=msgs,
        **prompt_cache.conversation_cache(),
    ) as stream:
        for text in stream.text_stream:
            yield text
        # Usage only exists once the stream is finished. Costed here because
        # the streaming path is the live coach — the call that happens most
        # often in a session, and until now the only one nothing measured.
        final = stream.get_final_message()
        _meter_stream("anthropic", model, final.usage)
        # And the answer names the model that wrote it. The service picks that
        # on the server — the name asked for here is only a request — so this
        # is the one place the app can learn what really ran.
        if served is not None and getattr(final, "model", ""):
            served.update({"model": final.model, "confirmed": True})


def _stream_openai_like(provider: str, model: str, transcript: str, history: list, system_prompt: str,
                        served: Optional[dict] = None):
    from openai import OpenAI
    from ..core.providers import PROVIDERS
    cfg = PROVIDERS[provider]
    key = os.environ.get(cfg["env"])
    if not key:
        raise RuntimeError(f"Missing {cfg['env']}")
    kwargs: dict = {"api_key": key}
    if "base_url" in cfg:
        kwargs["base_url"] = cfg["base_url"]
    client = OpenAI(**kwargs)
    # The system prompt stays first and unchanged so the provider's automatic
    # prefix caching can hit; see core/prompt_cache.py.
    msgs = ([{"role": "system", "content": system_prompt}]
            + context.trim_history(history)
            + [{"role": "user", "content": transcript}])
    stream = client.chat.completions.create(
        model=model, messages=msgs, max_tokens=REPLY_MAX_TOKENS, stream=True,
        stream_options={"include_usage": True},
    )
    for chunk in stream:
        # Every chunk names the model that produced it, which is not always the
        # one that was asked for — a service may serve a newer build, or its
        # own choice entirely.
        if served is not None and not served.get("confirmed") and getattr(chunk, "model", ""):
            served.update({"model": chunk.model, "confirmed": True})
        # The usage-only chunk at the end carries no choices.
        if getattr(chunk, "usage", None):
            _meter_stream(provider, model, chunk.usage)
        if not chunk.choices:
            continue
        text = chunk.choices[0].delta.content or ""
        if text:
            yield text


def _stream_gemini(model: str, transcript: str, history: list, system_prompt: str,
                   served: Optional[dict] = None):
    from google import genai
    from google.genai import types
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        raise RuntimeError("Missing GEMINI_API_KEY")
    client = genai.Client(api_key=key)
    contents = []
    for m in context.trim_history(history) + [{"role": "user", "content": transcript}]:
        role = "user" if m["role"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})
    for chunk in client.models.generate_content_stream(
        model=model, contents=contents,
        config=types.GenerateContentConfig(system_instruction=system_prompt, max_output_tokens=REPLY_MAX_TOKENS),
    ):
        if served is not None and not served.get("confirmed") and getattr(chunk, "model_version", ""):
            served.update({"model": chunk.model_version, "confirmed": True})
        if chunk.text:
            yield chunk.text


def _token_stream(provider: str, model: str, transcript: str, history: list, system_prompt: str,
                  served: Optional[dict] = None, *, fallback_credits: bool = False):
    """
    Unified streaming generator across all providers.

    `served` is filled in with the provider and model that actually answered.
    For an ordinary account that is the service's choice, made on the server
    and not knowable here — except that the answer says so on its way back,
    which is the only honest place to read it from.
    """
    from .. import relay
    from ..errors import relay_not_listening, relay_timeout
    from ..core.providers import is_fallback_credits

    effective_fallback = fallback_credits or is_fallback_credits()
    if relay.is_enabled() and not effective_fallback:
        if not relay.ready():
            raise relay_not_listening()
        try:
            ans = relay.enqueue_sync(
                kind="live_turn",
                instructions=system_prompt,
                context={"text": transcript, **({"history": history} if history else {})},
                timeout_s=60.0,
            )
        except (TimeoutError, asyncio.TimeoutError):
            raise relay_timeout(60.0)

        if served is not None:
            served.update({"provider": "assistant_relay", "model": relay.get_client() or "assistant", "confirmed": True})

        if isinstance(ans, dict):
            text = str(ans.get("reply") or ans.get("text") or ans.get("answer") or json.dumps(ans)).strip()
        else:
            text = str(ans).strip()

        words = text.split(" ")
        for i, w in enumerate(words):
            yield w if i == 0 else " " + w
        return

    # Routing can pick a different model per turn; whatever it picked, an
    # ordinary account only ever reaches what our service serves.
    from ..core import hosted
    provider, model = hosted.coerce(provider, model)
    if served is not None:
        served.update({"provider": provider, "model": model, "confirmed": False})
    if provider == "anthropic":
        yield from _stream_anthropic(model, transcript, history, system_prompt, served)
    elif provider in ("openai", "deepseek"):
        yield from _stream_openai_like(provider, model, transcript, history, system_prompt, served)
    elif provider == "gemini":
        yield from _stream_gemini(model, transcript, history, system_prompt, served)
    else:
        raise ValueError(f"Unknown provider: {provider}")


# ── Shared turn preparation (classify + match + route) ───────────────────────

def _prepare(tagged: str, graph_speaker: str, provider: str, model: str,
             plan: Optional[dict], briefing_present: bool) -> dict:
    """
    Run classify → match_plan → route without calling the LLM compose step.
    Returns a dict with turn_type, routing_decision, compose_model, matched_answer_text.
    """
    state: TurnState = {
        "transcript": tagged,
        "speaker": graph_speaker,
        "provider": provider,
        "model": model,
        "system_prompt": "",
        "history": [],
        "plan": plan,
        "briefing_present": briefing_present,
        "turn_type": "question",
        "routing_decision": "default",
        "routing_reason": "",
        "reply": "",
        "error": "",
        "matched_answer_text": None,
        "matched_answer_idx": None,
    }

    # Fast-path classify (no LLM for interviewer/you + most lengths)
    fast = _fast_classify(tagged, graph_speaker)
    if fast is not None:
        state["turn_type"] = fast
    else:
        # LLM classify only as last resort — keep the default "question"
        state["turn_type"] = "question"

    state = match_plan_node(state)
    state = route_node(state)

    tier = state.get("routing_decision", "default")
    compose_model = _tier_model(provider, tier, model)

    return {
        "turn_type": state["turn_type"],
        "routing_decision": tier,
        "compose_model": compose_model,
        "matched_answer_text": state.get("matched_answer_text"),
    }


# ── Request model ────────────────────────────────────────────────────────────

class TurnRequest(BaseModel):
    transcript: str
    speaker: str = "user"
    session_id: Optional[int] = None
    plan_id: Optional[int] = None
    template: str = "tech-interview"
    model: str = _DEFAULT_MODEL
    history: list = []
    section_idx: int = 0
    ai_instructions: Optional[str] = None
    cv_id: Optional[int] = None
    document_ids: Optional[list[int]] = None
    # Researched people in this call (roadmap 2.6), on top of any the plan lists.
    people_ids: Optional[list[int]] = None
    response_tone: Optional[str] = None
    # What the call is spoken in (roadmap 3.3); the coach writes in it too, unless
    # display_language says what the user reads in (docs/translation.md, T1).
    language: Optional[str] = None
    display_language: Optional[str] = None
    # The speaker kept talking after an earlier part (this text) was sent: this
    # turn is the whole question, and the saved answer to the part is dropped.
    replaces: Optional[str] = None
    fallback_credits: bool = False


# ── SSE streaming endpoint (primary) ─────────────────────────────────────────

@router.post("/turn")
async def coach_turn(req: TurnRequest):
    plan = get_plan(req.plan_id) if req.plan_id else None
    profile_row = profile_store.get_active_profile()
    profile = dict(profile_row) if profile_row else {}

    # People come from the plan and the session; the coach gets them once, with guidance.
    people_ids = list(dict.fromkeys([*(plan or {}).get("people_ids", []), *(req.people_ids or [])]))
    system_prompt = _render_coach_prompt(
        req.template if req.template in TEMPLATES else "tech-interview",
        profile=profile, plan={**plan, "people_ids": []} if plan else None,
    )
    people_block = coach_block(people_ids) if people_ids else ""
    system_prompt += people_block

    # Attach CV (explicit id wins; else active CV)
    cv_text = ""
    if req.cv_id:
        cv_text = get_cv_text(req.cv_id)
    else:
        cv_text = get_active_cv_text()
    if cv_text.strip():
        system_prompt += "\n\nCANDIDATE CV:\n" + cv_text.strip()[:8000]

    # Reference files: the plan's (roadmap 2.5) plus any ticked for this session.
    doc_ids = list(dict.fromkeys([*(plan or {}).get("document_ids", []), *(req.document_ids or [])]))
    docs = documents_context(doc_ids)
    if docs:
        system_prompt += (
            "\n\nREFERENCE FILES for this conversation (job spec, agenda, slides, notes…). Use them to make "
            "suggestions specific — match the requirements, terms and priorities they state — but don't quote "
            "long passages or claim the user wrote them.\n\n" + docs
        )

    tone = _resolve_tone(req.response_tone)
    spoken = languages.resolve(req.language) if req.language else languages.for_session(req.session_id)
    if req.language and req.session_id:
        languages.set_for_session(req.session_id, spoken)
    if req.display_language is not None and req.session_id:
        languages.set_display_for_session(req.session_id, req.display_language or None)
    # Cues and answers are written in what the user reads; the call itself is still heard in `spoken`.
    if req.session_id:
        language = languages.output_for_session(req.session_id)
    else:
        language = req.display_language if req.display_language in languages.LANGUAGES else spoken
    system_prompt += _response_format_block(profile.get("name") or "the candidate", tone, language)

    # Append per-session custom instructions (from the Preferences modal)
    if req.ai_instructions and req.ai_instructions.strip():
        system_prompt = (
            system_prompt
            + "\n\nCUSTOM INSTRUCTIONS (highest priority, from this user for this session):\n"
            + req.ai_instructions.strip()
        )

    sections = plan.get("sections", []) if plan else []
    section = sections[req.section_idx] if sections and req.section_idx < len(sections) else None
    section_prefix = f"[§{req.section_idx+1}: {section.get('title','')}] " if section else ""

    graph_speaker = _normalise_speaker(req.speaker)
    tagged = f"[{graph_speaker.upper()}] {section_prefix}{req.transcript}"
    provider = _provider_for(req.model)
    history = list(req.history)
    briefing_present = bool((plan and (plan.get("briefing") or "").strip()) or people_block)

    from ..core.providers import is_fallback_credits, fallback_credits_context
    is_fallback = req.fallback_credits or is_fallback_credits() or is_session_fallback(req.session_id)

    async def event_stream() -> AsyncGenerator[str, None]:
        loop = asyncio.get_running_loop()
        try:
            # The model this machine may actually use — for an ordinary
            # account, one our service serves, whatever an older config says.
            # Off the loop: this can need a token refresh (see deepgram_stream).
            model, provider = await loop.run_in_executor(
                None, lambda: resolve_llm(req.model, fallback_credits=is_fallback)
            )
        except FriendlyError as fe:
            yield f"data: {json.dumps({'type': 'error', **fe.as_dict()})}\n\n"
            return

        # 1. Fast prepare (classify + match + route) — no LLM in >95% of cases
        prep = await loop.run_in_executor(
            None, _prepare, tagged, graph_speaker, provider, model, plan, briefing_present
        )
        compose_model = prep["compose_model"]

        # Prefix compose transcript with turn-type + matched-answer context
        prefix_lines = [f"[TURN TYPE: {prep['turn_type']}]"]
        if prep.get("matched_answer_text"):
            prefix_lines.append(
                f"[MATCHES PREPARED ANSWER: {prep['matched_answer_text']}]\n"
                "Use this as the backbone of the answer, adapted to what was actually asked."
            )
        compose_transcript = "\n".join(prefix_lines) + "\n\n" + tagged

        # Emit meta upfront so the UI can badge the turn while tokens stream
        yield f"data: {json.dumps({'type': 'meta', 'turn_type': prep['turn_type'], 'response_tone': tone})}\n\n"

        # 2. Stream compose tokens — true streaming via thread + asyncio.Queue
        # What actually answers, filled in by the stream itself.
        served: dict = {"provider": provider, "model": compose_model, "confirmed": False}
        full_reply = ""
        q: asyncio.Queue = asyncio.Queue()
        cancelled = threading.Event()

        def _run_stream():
            try:
                with fallback_credits_context(is_fallback):
                    for token in _token_stream(provider, compose_model, compose_transcript, list(history),
                                               system_prompt, served, fallback_credits=is_fallback):
                        if cancelled.is_set():
                            break
                        loop.call_soon_threadsafe(q.put_nowait, token)
            except Exception as exc:
                if not cancelled.is_set():
                    loop.call_soon_threadsafe(q.put_nowait, exc)
            finally:
                loop.call_soon_threadsafe(q.put_nowait, None)  # sentinel

        t = threading.Thread(target=_run_stream, daemon=True)
        t.start()

        try:
            while True:
                item = await q.get()
                if item is None:
                    break
                if isinstance(item, Exception):
                    yield f"data: {json.dumps({'type': 'error', **classify(item, provider).as_dict()})}\n\n"
                    return
                full_reply += item
                yield f"data: {json.dumps({'type': 'token', 'text': item})}\n\n"
        finally:
            cancelled.set()

        # 3. Update history + save session
        new_history = history + [
            {"role": "user",      "content": tagged},
            {"role": "assistant", "content": full_reply},
        ]

        # Only persist if the caller passed an explicit session_id.
        # Turns without a session_id are ephemeral — nothing gets written to
        # the DB, keeping the Call Sessions list clean.
        session_id = req.session_id
        if session_id is not None:
            try:
                with sess._connect() as _c:
                    _c.execute(
                        "UPDATE sessions SET status = 'active', "
                        "started_at = COALESCE(started_at, ?) "
                        "WHERE id = ? AND (status IS NULL OR status = 'draft' OR status = 'paused')",
                        (sess.datetime.utcnow().isoformat(timespec="seconds"), session_id),
                    )
            except Exception:
                pass
            if req.replaces:
                sess.delete_superseded_exchange(session_id, req.transcript)
            sess.append_message(session_id, "user", tagged, req.speaker)
            sess.append_message(session_id, "assistant", full_reply)

        yield f"data: {json.dumps({'type': 'done', 'session_id': session_id, 'history': new_history, 'engine': {**served, 'asked': req.model}})}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# Full coding solutions (several approaches with code, walkthrough) need far
# more room than a spoken answer; 1500 tokens cut them off mid-explanation.
# Thinking tokens (see respond_with_image think=True) count toward this too.
SCREEN_MAX_TOKENS = 16000

SCREEN_DEFAULT_QUESTION = (
    "Help me with what's on my screen right now. If it's a coding problem, solve it completely."
)


# What the conversation adds to a screenshot: the lines before it, capped so a
# long call can't swell the request (each screenshot is a paid vision call).
SCREEN_CONTEXT_LINES = 12
SCREEN_CONTEXT_LINE_CHARS = 400
SCREEN_CONTEXT_CHARS = 3000


class ScreenContextLine(BaseModel):
    speaker: str  # "them" | "you"
    text: str


def _screen_question(prompt: Optional[str], their_question: Optional[str],
                     conversation: Optional[list]) -> tuple[str, Optional[str]]:
    """
    The message sent with a screenshot, and the question it answers (or None).

    What the user typed always wins. Otherwise, in a live session, the last
    thing the other side asked is the question: someone presenting asks "why
    does revenue dip in Q3?" and the answer has to be about that, read off the
    slide, not a tour of the slide. With neither, the general question stands.
    The recent conversation goes along as context either way.
    """
    typed = (prompt or "").strip()
    asked = " ".join((their_question or "").split())[:SCREEN_CONTEXT_LINE_CHARS]
    if typed:
        message, answering = typed, None
    elif asked:
        message = (
            f'They just asked: "{asked}"\n'
            "Answer that question for me, using what is on the screen as the evidence: read the "
            "numbers, labels and wording off it. If the screen doesn't show what they asked about, "
            "say so briefly and answer from the conversation."
        )
        answering = asked
    else:
        message, answering = SCREEN_DEFAULT_QUESTION, None

    lines = []
    for line in (conversation or [])[-SCREEN_CONTEXT_LINES:]:
        speaker = getattr(line, "speaker", None) if not isinstance(line, dict) else line.get("speaker")
        text = getattr(line, "text", None) if not isinstance(line, dict) else line.get("text")
        text = " ".join(str(text or "").split())[:SCREEN_CONTEXT_LINE_CHARS]
        if text:
            lines.append(f"{'Them' if speaker == 'them' else 'Me'}: {text}")
    # Keep the most recent lines when the whole lot is too long.
    while lines and sum(len(l) + 1 for l in lines) > SCREEN_CONTEXT_CHARS:
        lines.pop(0)
    if lines:
        message += "\n\nRECENT CONVERSATION (context only, most recent last):\n" + "\n".join(lines)
    return message, answering


def _conversation_from_form(raw: Optional[str]) -> list:
    """The conversation as the upload form sends it: a JSON list, or nothing."""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return [x for x in data if isinstance(x, dict)] if isinstance(data, list) else []


def _screen_format_block(name: str) -> str:
    return f"""

════════════════════════════════════════════════════════
  SCREENSHOT RESPONSE — this replaces any output format described above.
════════════════════════════════════════════════════════
{name} just captured their screen and needs help with what is on it. First decide
what the screen shows, then reply in the matching format. Use only the section
headings CUES:, SHORT: and FULL: — never SAY:, ANALYSIS: or WHY: — and never start
a line inside FULL with CUES:, SHORT: or FULL:.

A) A CODING / ALGORITHM / SQL PROBLEM (LeetCode, HackerRank, CoderPad, an IDE task,
   a take-home prompt). Solve it completely:

CUES:
- <3 bullets, max 6 words each: the pattern, the key insight, the target complexity>

SHORT:
<2–3 sentences {name} can say to open: restate the problem in plain words, name the
brute-force idea, then the optimal approach and its time/space complexity.>

FULL:
### Problem
<1–2 sentences: the task, inputs/outputs and constraints, as read from the screen.>

### Approach 1 — Brute force
**Idea:** <one or two sentences>
**Steps:**
1. <numbered steps>
**Complexity:** Time O(…), Space O(…) — <one-line justification>
```<language>
<complete code implementing exactly these steps>
```

### Approach 2 — Optimal
<same structure: Idea, Steps, Complexity, code>

(Add an intermediate approach when it is the natural next step an interviewer expects —
always when the brute force is plain recursion and the optimal is DP: Approach 2 is then
top-down recursion with a memo cache, Approach 3 is bottom-up tabulation, and each one's
code is written that way. If the brute force is already optimal, say so and give one
approach.)

### Walkthrough
<Trace the optimal code on one example shown on screen: the key state after each
important step, ending with the output. It must equal the expected output on screen;
if it doesn't, re-read the example and fix the code before answering.>

### Edge cases
- <bullets: empty input, single element, duplicates, limits from the constraints…>

### Say while coding
- <3–5 short lines {name} can narrate while typing the optimal solution>

Code rules — these matter most:
- Write in the language selected in the on-screen editor; if none is visible, Python 3.
- Use the exact class and function signature from the starter code on screen.
- Each approach's name, idea, steps, complexity and code must describe the same
  algorithm: same technique (recursion vs memoised recursion vs bottom-up table vs
  two pointers…), same data structures, same loop order, same variable names as the
  steps mention. The stated complexity must be the real complexity of that code.
- Copy examples and constraints exactly as they appear on screen (e.g. ".*" is not ".").
- Only claim behaviour you have traced; don't assert how the code handles inputs the
  constraints rule out.
- Before answering, run every approach's code by hand on every example on screen,
  including the base cases and helper branches it reaches. Fix any code whose result
  differs from the expected output.
- Complete and runnable: no placeholders, no "...", no omitted helpers or imports.
  Short comments on the key lines only.
- If part of the problem is cut off, solve what is visible and say what was not.

B) ANYTHING ELSE (slides, a document, a form, a diagram, a chat, an error message).
   When the message says what THEY just asked, answer exactly that question, grounded in what
   the screen shows, as the reply {name} gives out loud. Use the recent conversation only to
   understand the question; don't summarise it.

CUES:
- <3 bullets, max 6 words each>

SHORT:
<2–4 sentences: what is on screen and the direct answer or next step.>

FULL:
<The complete answer or explanation {name} needs, using markdown where it helps.
If it's a question, answer it; if it's an error, explain the cause and the fix.>
"""


def _screen_system_prompt(template: str, cv_id: Optional[int], ai_instructions: Optional[str]) -> str:
    profile_row = profile_store.get_active_profile()
    profile = dict(profile_row) if profile_row else {}
    system_prompt = _render_coach_prompt(
        template if template in TEMPLATES else "tech-interview",
        profile=profile, plan=None,
    )
    cv_text = get_cv_text(cv_id) if cv_id else get_active_cv_text()
    if cv_text.strip():
        system_prompt += "\n\nCANDIDATE CV:\n" + cv_text.strip()[:8000]
    if ai_instructions and ai_instructions.strip():
        system_prompt += (
            "\n\nCUSTOM INSTRUCTIONS (highest priority, from this user for this session):\n"
            + ai_instructions.strip()
        )
    return system_prompt + _screen_format_block(profile.get("name") or "the candidate")


@router.post("/screen")
async def coach_screen(
    file: UploadFile = File(...),
    prompt: Optional[str] = Form(None),
    session_id: Optional[int] = Form(None),
    template: str = Form("tech-interview"),
    model: str = Form(_DEFAULT_MODEL),
    ai_instructions: Optional[str] = Form(None),
    cv_id: Optional[int] = Form(None),
    their_question: Optional[str] = Form(None),
    conversation: Optional[str] = Form(None),
):
    """
    Vision LLM on an uploaded screenshot.

    Builds the same context-rich system prompt as /turn (template + profile +
    CV + AI instructions), then hands the image + user prompt to the vision
    provider. Appends the interaction to the session so the transcript is
    complete.
    """
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty image")

    provider = _provider_for(model)
    system_prompt = _screen_system_prompt(template, cv_id, ai_instructions)
    user_q, answering = _screen_question(prompt, their_question, _conversation_from_form(conversation))
    shown = (prompt or "").strip() or (f"Answering: {answering}" if answering else SCREEN_DEFAULT_QUESTION)

    # Save to a temp file for the vision provider (they take file paths)
    suffix = Path(file.filename or "screenshot.png").suffix or ".png"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        tmp_path = tmp.name
    try:
        loop = asyncio.get_running_loop()
        reply = await loop.run_in_executor(
            None,
            lambda: respond_with_image(provider, model, tmp_path, user_q, system_prompt,
                                       max_tokens=SCREEN_MAX_TOKENS, think=True),
        )
    except Exception as e:
        raise HTTPException(500, f"Vision LLM error: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass

    sid = session_id
    # Ephemeral if no session_id was provided — no DB write.
    if sid is not None:
        try:
            with sess._connect() as _c:
                _c.execute(
                    "UPDATE sessions SET status = 'active', "
                    "started_at = COALESCE(started_at, ?) "
                    "WHERE id = ? AND (status IS NULL OR status = 'draft' OR status = 'paused')",
                    (sess.datetime.utcnow().isoformat(timespec="seconds"), sid),
                )
        except Exception:
            pass
        sess.append_message(sid, "user", f"[SCREEN] {shown}", speaker="unknown")
        sess.append_message(sid, "assistant", reply)

    return {"reply": reply, "session_id": sid, "prompt_used": shown, "answering": answering}


@router.get("/screen/targets")
async def coach_screen_targets():
    """Screens and windows the user can capture, each with a small thumbnail."""
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(None, screen_targets.list_targets)
    except Exception as e:
        raise HTTPException(500, f"Couldn't list screens and windows: {e}")


@router.get("/screen/tabs")
async def coach_screen_tabs(window: str):
    """Tabs of a browser window (target id "window:<hwnd>")."""
    loop = asyncio.get_running_loop()
    try:
        kind, hwnd = screen_targets.parse_target(window)
        if kind != "window":
            raise ValueError("Tabs are only available for browser windows")
        return {"tabs": await loop.run_in_executor(None, lambda: screen_targets.list_tabs(hwnd))}
    except screen_targets.TargetNotFound as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Couldn't read the browser's tabs: {e}")


class GrabScreenRequest(BaseModel):
    target: str                      # "screen:<n>" | "window:<hwnd>"
    tab_index: Optional[int] = None  # switch the browser to this tab first
    tab_title: Optional[str] = None
    session_id: Optional[int] = None


@router.post("/screen/grab")
async def coach_screen_grab(req: GrabScreenRequest):
    """
    Capture a picker target without analysing it yet. Returns a capture id
    for /screen/native plus a preview so the chat can show the shot at once.
    """
    loop = asyncio.get_running_loop()
    try:
        capture_id, _path, img = await loop.run_in_executor(
            None,
            lambda: _grab_target(req.session_id or 0, req.target, req.tab_index, req.tab_title),
        )
    except screen_targets.TargetNotFound as e:
        raise HTTPException(404, str(e))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(500, f"Screenshot failed: {e}")
    preview = await loop.run_in_executor(None, lambda: screen_targets.image_to_data_url(img, 1600, 82))
    return {"capture_id": capture_id, "preview": preview, "width": img.width, "height": img.height}


class NativeScreenRequest(BaseModel):
    mode: str = "region"       # 'full' | 'region' | 'window'
    capture_id: Optional[str] = None  # from /screen/grab; overrides mode
    region: Optional[dict] = None     # {x, y, w, h} in capture pixels
    prompt: Optional[str] = None
    session_id: Optional[int] = None
    template: str = "tech-interview"
    model: str = _DEFAULT_MODEL
    ai_instructions: Optional[str] = None
    cv_id: Optional[int] = None
    # In a live session: the other side's latest question and the lines before
    # the capture, so the answer is about what was asked (_screen_question).
    their_question: Optional[str] = None
    conversation: Optional[list[ScreenContextLine]] = None


@router.post("/screen/native")
async def coach_screen_native(req: NativeScreenRequest):
    """
    Server-side native screen capture (grim / gnome-screenshot / import / scrot),
    or analysis of a capture taken earlier with /screen/grab.
    Same context assembly as /screen; no browser upload needed.
    """
    mode = req.mode if req.mode in ("full", "region", "window") else "region"
    loop = asyncio.get_running_loop()

    if req.capture_id:
        path = _capture_path(req.capture_id)
        if path is None:
            raise HTTPException(404, "Screenshot expired — capture again")
        mode = "picked"
        if req.region:
            try:
                path = await loop.run_in_executor(None, lambda: _crop_capture(path, req.region))
                mode = "region"
            except (KeyError, TypeError, ValueError) as e:
                raise HTTPException(400, f"Bad region: {e}")
    else:
        try:
            path = await loop.run_in_executor(
                None,
                lambda: _screen_capture(session_id=req.session_id or 0, mode=mode),
            )
        except Exception as e:
            raise HTTPException(500, f"Screenshot failed: {e}")

    provider = _provider_for(req.model)
    system_prompt = _screen_system_prompt(req.template, req.cv_id, req.ai_instructions)
    user_q, answering = _screen_question(req.prompt, req.their_question, req.conversation)
    shown = (req.prompt or "").strip() or (f"Answering: {answering}" if answering else SCREEN_DEFAULT_QUESTION)

    try:
        reply = await loop.run_in_executor(
            None,
            lambda: respond_with_image(provider, req.model, str(path), user_q, system_prompt,
                                       max_tokens=SCREEN_MAX_TOKENS, think=True),
        )
    except Exception as e:
        raise HTTPException(500, f"Vision LLM error: {e}")

    sid = req.session_id
    # Ephemeral if no session_id was provided — no DB write.
    if sid is not None:
        try:
            with sess._connect() as _c:
                _c.execute(
                    "UPDATE sessions SET status = 'active', "
                    "started_at = COALESCE(started_at, ?) "
                    "WHERE id = ? AND (status IS NULL OR status = 'draft' OR status = 'paused')",
                    (sess.datetime.utcnow().isoformat(timespec="seconds"), sid),
                )
        except Exception:
            pass
        sess.append_message(sid, "user", f"[SCREEN native/{mode}] {shown}", speaker="unknown")
        sess.append_message(sid, "assistant", reply)

    return {"reply": reply, "session_id": sid, "prompt_used": shown, "answering": answering,
            "screenshot_path": str(path)}


# ── Follow-up predictor ──────────────────────────────────────────────────────

class FollowupLine(BaseModel):
    speaker: str
    text: str


class FollowupBody(BaseModel):
    transcript: list[FollowupLine]
    model: Optional[str] = None


@router.post("/followups")
async def predict_followups(body: FollowupBody):
    from ..core.providers import respond
    from .mock import _level_text, _parse_json

    lines = [
        f"{'Interviewer' if l.speaker == 'interviewer' else 'Candidate'}: {l.text.strip()}"
        for l in body.transcript[-12:] if l.text.strip()
    ]
    if not any(l.startswith("Candidate:") for l in lines):
        return {"followups": []}

    model, provider = resolve_llm(body.model)
    fast_model = _tier_model(provider, "cheap", model)
    row = profile_store.get_active_profile()
    profile = dict(row) if row else {}
    system_prompt = f"""You predict what an interviewer will ask next, so the candidate can prepare.

Candidate: {profile.get('name') or 'the candidate'}, interviewing for {profile.get('target_role') or 'the role'}.
{_level_text(profile)}

Read the conversation and predict the 2 most likely NEXT questions, usually follow-ups that probe the
candidate's last answer (a vague claim, a missing number, a trade-off they skipped, or a natural next topic).

Return ONLY JSON, no prose:
{{"followups": [{{"question": "the question as the interviewer would phrase it",
                  "prep": "at most 14 words: what to have ready to say"}}]}}"""
    loop = asyncio.get_running_loop()
    try:
        raw = await loop.run_in_executor(
            None, lambda: respond(provider, fast_model, "CONVERSATION\n" + "\n".join(lines), [], system_prompt, 400)
        )
    except Exception as e:
        raise classify(e, provider)
    try:
        data = _parse_json(raw)
    except Exception:
        return {"followups": []}
    return {"followups": [
        {"question": str(f.get("question", "")).strip(), "prep": str(f.get("prep", "")).strip()}
        for f in data.get("followups", []) if str(f.get("question", "")).strip()
    ][:2]}



# ── Say it in the call's language (docs/translation.md, T1) ──────────────────

SAY_IN_PROMPT = """You turn a coach's suggested answer into what the user should actually say on the call, as JSON only.
The user reads the coach in one language, but the call is in {target}. Write the answer in natural, spoken {target}:
how a fluent speaker would say it in a {kind}, not a word-for-word translation. Keep every fact, name and number,
keep it about as long, and keep any CUES:/SHORT:/FULL: labels exactly as they are (in English).

Return ONLY: {{"text": "..."}}"""


class SayInRequest(BaseModel):
    text: str
    session_id: Optional[int] = None
    language: Optional[str] = None     # the call's language; else the session's
    model: Optional[str] = None
    fallback_credits: bool = False


@router.post("/say-in")
async def say_in(req: SayInRequest):
    """The answer the coach wrote in the reading language, in the language the call is spoken in."""
    text = (req.text or "").strip()[:6000]
    if not text:
        raise HTTPException(400, detail={"code": "invalid", "title": "Nothing to say", "message": "There's no answer to put into the call's language."})
    target = languages.resolve(req.language) if req.language else languages.for_session(req.session_id)
    if target == "multi":
        raise HTTPException(400, detail={"code": "invalid", "title": "Pick the call's language",
                                         "message": "The call is set to Mixed: choose the language you'll answer in."})
    from .mock import _ask_model
    raw = await _ask_model(req.model, SAY_IN_PROMPT.format(target=languages.name(target), kind="conversation"),
                           f"ANSWER\n{text}", kind="translate", session_id=req.session_id,
                           fallback_credits=req.fallback_credits)
    out = str((raw or {}).get("text") or "").strip() if isinstance(raw, dict) else ""
    if not out:
        raise HTTPException(502, detail={"code": "unknown", "title": "Nothing came back", "message": "Try again in a moment."})
    return {"text": out, "language": target}
