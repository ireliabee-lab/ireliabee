"""
Mock interview: the AI plays the interviewer.

POST /mock/start   → create a "mock"-tagged session and generate questions
POST /mock/answer  → store the Q/A and return a score, feedback and a stronger answer
Ending uses the existing POST /sessions/{id}/end.
"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import languages
from ..core import costs, profile_store
from ..core import sessions as sess
from ..core.providers import metering_context, respond
from ..document_store import get_active_cv_text, get_cv_text
from .coach import EXPERIENCE_LEVELS, RESPONSE_TONES, english_support_enabled, tone_block, _persona_block, _provider_for, _resolve_tone
from ..errors import FriendlyError, classify, relay_closed, resolve_llm
from ..scenarios import get_scenario, scenario_from_tags
from .. import exams
from ..entitlements import check_pro, pro_required

router = APIRouter()

FOCUS_TEXT = {
    "behavioral": "behavioral questions (past situations, teamwork, conflict, ownership, learning)",
    "technical": "technical questions about the skills and tools in the target role and the candidate's background",
    "mixed": "a realistic mix of behavioral and technical questions, the way a real interview flows",
}


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _candidate_context(cv_id: Optional[int]) -> tuple[dict, str]:
    row = profile_store.get_active_profile()
    profile = dict(row) if row else {}
    cv = get_cv_text(cv_id) if cv_id else get_active_cv_text()
    lines = [
        f"Name: {profile.get('name') or 'the candidate'}",
        f"Target role: {profile.get('target_role') or '(not specified)'}",
        f"Background: {profile.get('background') or '(not specified)'}",
        f"Strengths: {profile.get('strengths') or '(not specified)'}",
        f"Weaknesses: {profile.get('weaknesses') or '(not specified)'}",
        f"Extra context: {profile.get('extra_context') or '(none)'}",
    ]
    hard = (profile.get("hard_question") or "").strip()
    if hard:
        lines.append(
            "A fact they know they may be asked about and want to practise saying out loud: "
            f"{hard}"
        )
    if cv.strip():
        lines.append("CV:\n" + cv.strip()[:6000])
    from .stories import stories_prompt_block
    return profile, "\n".join(lines) + stories_prompt_block()


def _hard_question_block(profile: dict) -> str:
    """Ask about the candidate's dreaded fact — the point of naming it is to rehearse it."""
    hard = (profile.get("hard_question") or "").strip()
    if not hard:
        return ""
    return (
        "\nOne of your questions must put the candidate's difficult fact to them, plainly and "
        "without cruelty, the way a fair interviewer would raise it. Ask it in the middle of the "
        "set, not first and not last.\n"
    )


def _level_text(profile: dict) -> str:
    level = EXPERIENCE_LEVELS.get((profile.get("experience_level") or "").strip())
    if level:
        return f"The candidate is {level[0]}."
    return "Infer the candidate's seniority from their background and CV."


def _parse_json(raw: str) -> dict:
    text = raw.strip()
    # Already JSON (a relay answer arrives as json.dumps of the assistant's object): take it as
    # it is, so a ``` code block inside one of its strings isn't mistaken for the JSON.
    try:
        whole = json.loads(text)
        if isinstance(whole, dict):
            return whole
    except ValueError:
        pass
    # Only a fence around the WHOLE answer is unwrapped; fences inside strings are content.
    fence = re.fullmatch(r"```(?:json)?\s*(.*)```", text, re.S)
    if fence:
        text = fence.group(1)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("model did not return JSON")
    return json.loads(text[start:end + 1])


def _unreachable(e: Exception) -> bool:
    """A timeout or a connection that never got through: the provider, not the request, failed."""
    names = {type(x).__name__ for x in (e, e.__cause__, e.__context__) if x is not None}
    return bool(names & {"APITimeoutError", "APIConnectionError", "ConnectTimeout", "ReadTimeout",
                         "ConnectError", "TimeoutException"})


def _backup_for(provider: str) -> Optional[tuple[str, str]]:
    """Another provider that can answer, by default model, or None."""
    from ..core.providers import PROVIDERS
    for other in ("anthropic", "deepseek", "openai", "gemini"):
        if other == provider or other not in PROVIDERS:
            continue
        try:
            return resolve_llm(PROVIDERS[other]["default_model"])
        except Exception:
            continue
    return None


async def _ask_model(model: Optional[str], system_prompt: str, message: str,
                    *, kind: Optional[str] = None, session_id: Optional[int] = None,
                    fallback_credits: bool = False) -> dict:
    from ..core.providers import _context, fallback_credits_context, is_fallback_credits
    ctx_val = getattr(_context, "value", None)
    effective_kind = kind or (ctx_val[0] if ctx_val else None) or "model"
    effective_sid = session_id if session_id is not None else (ctx_val[1] if ctx_val else None)
    effective_fallback = fallback_credits or is_fallback_credits()

    model, provider = resolve_llm(model)
    loop = asyncio.get_running_loop()

    def _run(text: str) -> str:
        with metering_context(effective_kind, effective_sid), fallback_credits_context(effective_fallback):
            return respond(provider, model, text, [], system_prompt, 4096)

    async def call(text: str) -> str:
        nonlocal model, provider
        try:
            return await loop.run_in_executor(None, lambda: _run(text))
        except Exception as e:
            # A provider that cannot be reached or does not answer in time
            # (providers.py _limits) is no reason to lose a whole report: hand
            # it to another one this account can use, once.
            backup = _unreachable(e) and _backup_for(provider)
            if not backup:
                raise classify(e, provider)
            first = provider
            model, provider = backup
            try:
                return await loop.run_in_executor(None, lambda: _run(text))
            except Exception as e2:
                raise classify(e2, provider) from None
            finally:
                print(f"[ask] {first} did not answer; used {provider} ({model}) instead")

    raw = await call(message)
    try:
        return _parse_json(raw)
    except (ValueError, json.JSONDecodeError):
        pass
    raw = await call(message + "\n\nReply with ONLY the JSON object described in your instructions — no other text.")
    try:
        return _parse_json(raw)
    except (ValueError, json.JSONDecodeError):
        raise FriendlyError(
            "unknown", "The AI model gave an unreadable answer",
            "Try again, or pick a different model in Settings.", "settings",
        )


class StartBody(BaseModel):
    model: Optional[str] = None
    document_ids: Optional[list[int]] = None
    plan_id: Optional[int] = None
    template: str = "tech-interview"
    focus: str = "mixed"
    count: int = Field(5, ge=1, le=15)
    role: Optional[str] = None
    job_description: Optional[str] = None
    cv_id: Optional[int] = None
    scenario: Optional[str] = None
    language: Optional[str] = None


def _files_for(document_ids, plan_id) -> list[int]:
    """Files to practise from: the chosen plan's plus any picked directly (roadmap 2.5)."""
    ids = list(document_ids or [])
    if plan_id:
        from ..core.meeting_plans import get_plan
        plan = get_plan(plan_id) or {}
        ids = [*plan.get("document_ids", []), *ids]
    return list(dict.fromkeys(ids))


def _files_block(ids: list[int], use: str) -> str:
    from ..document_store import documents_context
    text = documents_context(ids, budget=12000)
    return f"\nREFERENCE FILES ({use})\n{text}\n" if text else ""


def _question_brief(scenario: dict, focus: str) -> str:
    return scenario["questions"] or FOCUS_TEXT.get(focus, FOCUS_TEXT["mixed"])


@router.post("/start")
async def start_mock(body: StartBody):
    profile, context = _candidate_context(body.cv_id)
    scenario_id, scenario = get_scenario(body.scenario)
    default_subject = profile.get("target_role") if scenario_id == "job" else None
    role = (body.role or default_subject or scenario["subject_default"]).strip()
    focus = _question_brief(scenario, body.focus)
    jd = (body.job_description or "").strip()
    jd_block = f"BACKGROUND DETAILS (job description, abstract, scholarship criteria or agenda)\n{jd[:6000]}" if jd else ""
    files = _files_block(_files_for(body.document_ids, body.plan_id),
                         "base most questions on these: their requirements, topics, claims and terms")
    jd_block += files
    # Speaking tests are English by design; everything else can be in the session's language (roadmap 3.3).
    exam = exams.exam_for(scenario.get("exam"))
    if exam:
        check_pro("exams")            # band scoring is Pro; every other scenario is free
    language = "en" if exam else languages.resolve(body.language)
    if exam:
        data = await _ask_model(body.model, exams.questions_prompt(exam, (body.role or "").strip(), context), "Write the test now.")
        questions = [
            {
                "question": str(q.get("question", "")).strip(),
                "type": "exam",
                "part": str(q.get("part", "")).strip(),
                "prep_seconds": max(0, min(120, int(q.get("prep_seconds") or 0))),
                "speak_seconds": max(15, min(180, int(q.get("speak_seconds") or 45))),
                "looking_for": str(q.get("looking_for", "")).strip(),
            }
            for q in data.get("questions", []) if str(q.get("question", "")).strip()
        ][:12]
        if not questions:
            raise HTTPException(502, "The AI model did not write the test")
        session_id = sess.create_session(title=f"{exam['name']} practice", mode=body.template, llm_model=resolve_llm(body.model)[0])
        with sess._connect() as conn:
            conn.execute(
                "UPDATE sessions SET subtitle = ?, tags = ?, status = 'active', started_at = ?, updated_at = ? WHERE id = ?",
                (f"{len(questions)} speaking tasks", f"mock,exam,{scenario_id}", _now(), _now(), session_id),
            )
        return {"session_id": session_id, "role": exam["name"], "questions": questions, "used_files": False,
                "exam": {"id": scenario_id, "name": exam["name"], "scale": exam["scale"], "max": exam["max"],
                         "criteria": [{"key": k, "label": l} for k, l, _ in exam["criteria"]]}}

    system_prompt = f"""You are an experienced {scenario["counterpart"]} preparing a realistic practice session: {scenario["setting"].format(subject=role)}.

CANDIDATE
{context}

{_level_text(profile)} Pitch every question at that level: hard enough to be a real test,
never expecting experience the candidate could not plausibly have.
{jd_block}

{_hard_question_block(profile)}
Write {body.count} {focus}. Order them the way a real {scenario["event"]} would flow (warm-up first).
Each question must be a single thing to answer, phrased exactly as the {scenario["counterpart"]} would say it.

Return ONLY JSON, no prose:
{{"questions": [{{"question": "...", "type": "behavioral|technical", "looking_for": "one sentence on what a strong answer shows"}}]}}""" + languages.json_block(language)

    data = await _ask_model(body.model, system_prompt, "Generate the interview questions now.")
    questions = [
        {
            "question": str(q.get("question", "")).strip(),
            "type": q.get("type", "mixed"),
            "looking_for": str(q.get("looking_for", "")).strip(),
        }
        for q in data.get("questions", [])
        if str(q.get("question", "")).strip()
    ][: body.count]
    if not questions:
        raise HTTPException(502, "The AI model did not generate any questions")

    session_id = sess.create_session(
        title=f"Mock {scenario['event']} — {role}", mode=body.template, llm_model=resolve_llm(body.model)[0],
    )
    with sess._connect() as conn:
        conn.execute(
            "UPDATE sessions SET subtitle = ?, tags = ?, status = 'active', started_at = ?, updated_at = ? WHERE id = ?",
            (f"{len(questions)} {body.focus if scenario_id == 'job' else scenario['label']} questions",
             f"mock,interview,{scenario_id}", _now(), _now(), session_id),
        )
    languages.set_for_session(session_id, language)
    return {"session_id": session_id, "role": role, "questions": questions, "used_files": bool(files), "language": language}


PHRASING_FIELD = """,
  "phrasing": [{"said": "a short phrase exactly as they wrote it", "better": "the same meaning and facts, said the way a fluent speaker would — never change numbers, names or claims", "why": "max 8 words, simple"}]
  (up to 3 LANG phrasing or grammar fixes from their answer, most useful first; [] if the LANG is already natural)"""


class AnswerBody(BaseModel):
    session_id: int
    model: Optional[str] = None
    question: str
    looking_for: Optional[str] = None
    answer: str
    response_tone: Optional[str] = None
    cv_id: Optional[int] = None
    document_ids: Optional[list[int]] = None
    plan_id: Optional[int] = None
    part: Optional[str] = None


def _exam_feedback_prompt(exam: dict, name: str, part: str, tone: str) -> str:
    return f"""You are a trained {exam['name']} examiner scoring one practice answer{f' ({part})' if part else ''} and coaching the candidate.
The answer was typed, so judge the words: ideas, organisation, vocabulary and grammar.

{exams.rubric_block(exam, spoken=False)}

Return ONLY JSON, no prose:
{{"bands": {{{", ".join(f'"{k}": <number or null>' for k, _, _ in exam["criteria"])}}},
  "verdict": "one honest sentence on the level this answer shows and the single biggest thing holding it back",
  "strengths": ["up to 3 specific things that worked, quoting their words"],
  "improvements": ["up to 3 specific fixes that would raise the score — e.g. a linking phrase to use, a tense to fix, a vaguer word to upgrade"],
  "better_answer": "the same ideas as a top-scoring spoken answer {name} could give — natural, fluent spoken English, the right length for this part; no memorised-sounding phrases",
  "phrasing": [{{"said": "a short phrase exactly as they wrote it", "better": "the natural, correct version", "why": "max 8 words, simple"}}]}}
Up to 4 phrasing fixes, most useful first; [] if there are none.

{tone_block(tone)}"""


@router.post("/answer")
async def answer_mock(body: AnswerBody):
    if sess.get_session(body.session_id) is None:
        raise HTTPException(404, "Mock session not found")
    if not body.answer.strip():
        raise HTTPException(400, "Answer is empty")

    profile, context = _candidate_context(body.cv_id)
    tone = _resolve_tone(body.response_tone)
    name = profile.get("name") or "the candidate"
    _, scenario = scenario_from_tags(sess.get_session(body.session_id)["tags"])
    exam = exams.exam_for(scenario.get("exam"))
    if exam:
        check_pro("exams")
    language = languages.for_session(body.session_id)
    phrasing_field = PHRASING_FIELD.replace("LANG", "English" if languages.is_english(language) else languages.name(language))
    if exam:
        message = (f"TASK: {body.question}\n" + (f"A HIGH SCORE NEEDS: {body.looking_for}\n" if body.looking_for else "")
                   + f"CANDIDATE'S ANSWER: {body.answer.strip()}")
        data = await _ask_model(body.model, _exam_feedback_prompt(exam, name, body.part or "", tone), message,
                                kind="mock.answer", session_id=body.session_id)
        scored = exams.clean_bands(exam, data.get("bands") or {}, spoken=False)
        result = {
            "score": scored["score"],
            "verdict": str(data.get("verdict", "")).strip(),
            "strengths": [str(s).strip() for s in data.get("strengths", []) if str(s).strip()][:3],
            "improvements": [str(s).strip() for s in data.get("improvements", []) if str(s).strip()][:3],
            "better_answer": str(data.get("better_answer", "")).strip(),
            "response_tone": tone,
            "phrasing": [
                {"said": str(p.get("said", "")).strip(), "better": str(p.get("better", "")).strip(), "why": str(p.get("why", "")).strip()}
                for p in data.get("phrasing", []) or []
                if isinstance(p, dict) and str(p.get("said", "")).strip() and str(p.get("better", "")).strip()
            ][:4],
            "exam": scored,
        }
        _save_answer(body, result)
        return result
    files = _files_block(_files_for(body.document_ids, body.plan_id),
                         "what the answer should speak to — judge fit against them, and use them in the stronger answer")

    system_prompt = f"""You are a fair, encouraging coach scoring one practice answer from a {scenario["event"]}.

CANDIDATE
{context}
{_persona_block(profile)}
{files}
Judge the answer against {scenario["judge"]}, at this candidate's level.
Be specific: quote or reference what they actually said.

Score 1–10 (10 = would clearly advance them; 5 = passable but forgettable; 1–3 = hurts them).

Return ONLY JSON, no prose:
{{"score": <int 1-10>,
  "verdict": "one honest sentence summarising the answer",
  "strengths": ["up to 3 specific things that worked"],
  "improvements": ["up to 3 specific, actionable fixes"],
  "better_answer": "a stronger version {name} could say, first person, 120-200 words, only using facts from the candidate context and their answer; use [placeholders] for unknown specifics"{phrasing_field if english_support_enabled() else ""}}}

{tone_block(tone, language)}{languages.json_block(language)}"""

    message = (
        f"QUESTION: {body.question}\n"
        + (f"A STRONG ANSWER SHOWS: {body.looking_for}\n" if body.looking_for else "")
        + f"CANDIDATE'S ANSWER: {body.answer.strip()}"
    )
    data = await _ask_model(body.model, system_prompt, message)

    try:
        score = max(1, min(10, int(round(float(data.get("score", 0))))))
    except (TypeError, ValueError):
        score = 0
    result = {
        "score": score,
        "verdict": str(data.get("verdict", "")).strip(),
        "strengths": [str(s).strip() for s in data.get("strengths", []) if str(s).strip()][:3],
        "improvements": [str(s).strip() for s in data.get("improvements", []) if str(s).strip()][:3],
        "better_answer": str(data.get("better_answer", "")).strip(),
        "response_tone": tone,
        "phrasing": [
            {"said": str(p.get("said", "")).strip(), "better": str(p.get("better", "")).strip(), "why": str(p.get("why", "")).strip()}
            for p in data.get("phrasing", []) or []
            if isinstance(p, dict) and str(p.get("said", "")).strip() and str(p.get("better", "")).strip()
        ][:3],
    }

    _save_answer(body, result)
    return result


def _save_answer(body: "AnswerBody", result: dict) -> None:
    """Keep the question, the answer and the feedback in the session transcript."""
    exam = result.get("exam")
    if exam and exam.get("overall") is not None:
        headline = f"**{'Band' if exam.get('scaled') is None else 'Score'} {exam['overall']:g}** — {result['verdict']}"
    else:
        headline = f"**Score: {result['score']}/10** — {result['verdict']}"
    feedback_md = "\n".join([
        headline,
        "", "**What worked**", *[f"- {s}" for s in result["strengths"]],
        "", "**Improve**", *[f"- {s}" for s in result["improvements"]],
        "", "**Stronger answer**", result["better_answer"],
    ])
    sess.append_message(body.session_id, "user", body.question, speaker="interviewer")
    sess.append_message(body.session_id, "user", body.answer.strip(), speaker="you")
    sess.append_message(body.session_id, "assistant", feedback_md)
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (_now(), body.session_id))


# ── Voice mock interview (Deepgram Voice Agent) ──────────────────────────────

import os
import time

import numpy as np
import websockets
from fastapi import WebSocket, WebSocketDisconnect

from .audio import _STREAM_INIT_LOCK, _open_stream_for
from .sessions import end_session as _end_session_record

# The Voice Agent's model. For ordinary accounts our relay overrides whatever
# is sent here (website/server/agent.js); it matters only for the admin's own key.
AGENT_LLM = {"type": "google", "model": "gemini-3.1-flash-lite"}
MIC_RATE = 16_000
AGENT_RATE = 24_000
# Two per accent (female + male where both exist). All verified against the
# Voice Agent API on 2026-09-16.
_CURATED = [
    ("hannah",   "American",    "female", "flux"),  ("cole",     "American",    "male", "flux"),
    ("gemma",    "British",     "female", "flux"),  ("kit",      "British",     "male", "flux"),
    ("maeve",    "Irish",       "female", "flux"),  ("conor",    "Irish",       "male", "flux"),
    ("sharon",   "Australian",  "female", "flux"),  ("hyperion", "Australian",  "male", "aura2"),
    ("meena",    "Indian",      "female", "flux"),  ("naveen",   "Indian",      "male", "flux"),
    ("amalthea", "Filipino",    "female", "aura2"), ("marcelo",  "Filipino",    "male", "flux"),
    ("kai",      "Singaporean", "male",   "flux"),
]
VOICE_CATALOG = {
    v: {"id": v, "name": v.capitalize(), "accent": a, "gender": g, "family": fam,
        "model": f"flux-{v}-en" if fam == "flux" else f"aura-2-{v}-en"}
    for v, a, g, fam in _CURATED
}
DEFAULT_VOICE = "hannah"
_preview_cache: dict[str, bytes] = {}


def _speak_provider(voice: dict) -> dict:
    if voice["family"] == "flux":
        return {"type": "deepgram", "version": "v2", "model": voice["model"]}
    return {"type": "deepgram", "model": voice["model"]}


async def _speak(text: str, voice_model: str) -> bytes:
    """
    A phrase as MP3, through our service for an ordinary account (charged in
    credits) or the admin's own key — see core/hosted.speak. These used to
    read a Deepgram key from this computer, so they failed for every ordinary
    account (audit 178-H6).
    """
    from ..core import hosted
    loop = asyncio.get_running_loop()
    try:
        return await loop.run_in_executor(None, hosted.speak, text, voice_model)
    except hosted.NotAvailable as e:
        raise FriendlyError("signed_out", "Sign in to hear voices", str(e), "settings")
    except Exception as e:
        raise classify(e, "deepgram")


@router.get("/voices")
def list_voices():
    return list(VOICE_CATALOG.values())


@router.get("/voices/{voice_id}/preview")
async def preview_voice(voice_id: str):
    from fastapi.responses import Response

    voice = VOICE_CATALOG.get(voice_id)
    if not voice:
        raise HTTPException(404, "Unknown voice")
    if voice_id not in _preview_cache:
        text = f"Hi, I'm {voice['name']}. I'll be your interviewer today. Take a breath, and let's begin whenever you're ready."
        _preview_cache[voice_id] = await _speak(text, voice["model"])
    return Response(_preview_cache[voice_id], media_type="audio/mpeg")
_pronounce_cache: dict[str, bytes] = {}


@router.get("/pronounce")
async def pronounce(text: str):
    """Speaks a word or short phrase slowly so the user can hear how it's said."""
    from fastapi.responses import Response

    phrase = " ".join(text.split())[:60]
    if not phrase:
        raise HTTPException(400, "Nothing to pronounce")
    cache_key = phrase.lower()
    if cache_key not in _pronounce_cache:
        voice = VOICE_CATALOG[DEFAULT_VOICE]
        # Said twice with a pause: once to hear it, once to repeat along.
        audio = await _speak(f"{phrase}. ... {phrase}.", voice["model"])
        if len(_pronounce_cache) > 200:
            _pronounce_cache.clear()
        _pronounce_cache[cache_key] = audio
    return Response(_pronounce_cache[cache_key], media_type="audio/mpeg")


GOODBYE_TIMEOUT_SEC = 10.0


def _interviewer_prompt(interviewer: str, role: str, focus: str, count: int,
                        profile: dict, context: str, jd: str, scenario: dict, files: str = "") -> str:
    exam = exams.exam_for(scenario.get("exam"))
    if exam:
        return f"""You are {interviewer}, a real {exam['name']} examiner, running a practice test over a voice call.

HOW TO SPEAK
- This is spoken audio: natural, warm but neutral, short sentences. Never use lists, markdown or symbols.

{exams.examiner_voice_prompt(exam)}
- {("Use this topic area for the long turn: " + role + ".") if role and role != scenario["subject_default"] else "Choose varied, everyday topics."}
- At the end, thank them, say the test is finished, and call end_interview.
- If the candidate wants to stop early, say a short goodbye and call end_interview."""
    jd_block = (f"\nBACKGROUND DETAILS\n{jd[:6000]}\n" if jd else "") + files
    return f"""You are {interviewer}, a real person acting as the {scenario["counterpart"]} in {scenario["setting"].format(subject=role)}, over a voice call.

CANDIDATE
{context}

{_level_text(profile)} Pitch every question at that level.
{jd_block}
HOW TO SPEAK
- This is spoken audio. Talk like a warm, professional human: natural phrasing, contractions,
  short sentences. Never use lists, markdown, emojis, or read out symbols.
- Keep each of your turns to one to three sentences.

HOW TO RUN THE {scenario["event"].upper()}
- After the candidate responds to your greeting, briefly say the plan in one sentence. Then
  ask the first question.
- Cover {count} main points, one at a time, in a natural order: {_question_brief(scenario, focus)}.
- If an answer is very short or vague, ask at most one short follow-up, then move on.
- Acknowledge answers briefly and neutrally ("Thanks, that's helpful."). Do not coach, score,
  or give feedback during the interview.
- If the candidate asks you to repeat or clarify, do it.
- After the last answer, ask if they have a quick question for you and answer it briefly.
- Then thank them, say goodbye, and call end_interview.
- If the candidate wants to stop early, say a short goodbye and call end_interview."""


class _CallState:
    def __init__(self):
        self.agent_playing = False   # frontend is still playing interviewer audio
        self.muted = False
        self.headphones = False
        self.ending = False
        self.ending_at = 0.0
        self.goodbye_audio = False   # interviewer audio arrived after end_interview was called
        self.closed = asyncio.Event()


@router.websocket("/voice")
async def voice_mock(ws: WebSocket):
    await ws.accept()
    loop = asyncio.get_running_loop()
    try:
        init = await asyncio.wait_for(ws.receive_json(), timeout=15)
    except Exception:
        await ws.close()
        return

    # Our relay for an ordinary account (charged in credits), the admin's own
    # key otherwise: core/hosted.agent_endpoint. Audit 178-H6.
    from ..core import hosted
    try:
        # Off the loop: this can need a token refresh (see deepgram_stream).
        agent_url, agent_headers = await loop.run_in_executor(None, hosted.agent_endpoint)
    except hosted.NotAvailable as e:
        await ws.send_json({"type": "error", **FriendlyError(
            "signed_out", "Sign in to use voice practice", str(e), "settings").as_dict()})
        await ws.close()
        return

    profile, context = _candidate_context(init.get("cv_id"))
    scenario_id, scenario = get_scenario(init.get("scenario"))
    if exams.exam_for(scenario.get("exam")):
        await ws.send_json({"type": "error", **pro_required("exams").detail})
        await ws.close()
        return
    default_subject = profile.get("target_role") if scenario_id == "job" else None
    role = (init.get("role") or default_subject or scenario["subject_default"]).strip()
    focus = init.get("focus") or "mixed"
    count = max(1, min(15, int(init.get("count") or 5)))
    voice = VOICE_CATALOG.get(init.get("voice") or "") or VOICE_CATALOG[DEFAULT_VOICE]
    interviewer = voice["name"]
    first_name = (profile.get("name") or "").split(" ")[0]

    state = _CallState()
    state.headphones = bool(init.get("headphones"))

    session_id = sess.create_session(title=f"Mock {scenario['event']} — {role}", mode="voice-mock")
    with sess._connect() as conn:
        conn.execute(
            "UPDATE sessions SET subtitle = ?, tags = ?, status = 'active', started_at = ?, updated_at = ? WHERE id = ?",
            (f"Voice call · {scenario['label'] if scenario_id != 'job' else f'{count} {focus} questions'}",
             f"mock,voice,{scenario_id}", _now(), _now(), session_id),
        )
    await ws.send_json({"type": "session", "session_id": session_id, "interviewer": interviewer})
    # The Voice Agent bundles speech-to-text, a model and speech synthesis into
    # one per-minute charge, which makes a voice mock the most expensive minute
    # in the app — and until now the only one nothing measured at all.
    agent_started = time.monotonic()

    settings = {
        "type": "Settings",
        # No model training on the call's audio (the Privacy Policy). Our relay
        # sets this for ordinary accounts too; this covers the admin's own key.
        "mip_opt_out": True,
        "audio": {
            "input": {"encoding": "linear16", "sample_rate": MIC_RATE},
            "output": {"encoding": "linear16", "sample_rate": AGENT_RATE, "container": "none"},
        },
        "agent": {
            "language": "en",
            "listen": {"provider": {"type": "deepgram", "version": "v2", "model": "flux-general-en"}},
            "think": {
                "provider": AGENT_LLM,
                "prompt": _interviewer_prompt(interviewer, role, focus, count, profile, context,
                                              (init.get("job_description") or "").strip(), scenario,
                                              _files_block(_files_for(init.get("document_ids"), init.get("plan_id")),
                                                           "base your questions on these: their requirements, topics and terms")),
                "functions": [{
                    "name": "end_interview",
                    "description": "End the interview call. Call only after you have said goodbye.",
                    "parameters": {"type": "object", "properties": {}, "required": []},
                }],
            },
            "speak": {"provider": _speak_provider(voice)},
            "greeting": f"Hi{(' ' + first_name) if first_name else ''}, I'm {interviewer}. "
                        f"Thanks for making time today. Can you hear me okay?",
        },
    }

    # Consecutive lines from the same speaker are stored as one message.
    pending: dict = {"role": None, "text": []}

    def flush_transcript():
        if pending["role"] and pending["text"]:
            speaker = "interviewer" if pending["role"] == "assistant" else "you"
            sess.append_message(session_id, "user", " ".join(pending["text"]), speaker=speaker)
        pending["role"], pending["text"] = None, []

    mic_queue: asyncio.Queue = asyncio.Queue()
    stream = None
    try:
        async with websockets.connect(agent_url, additional_headers=agent_headers,
                                      max_size=None,
                                      # Same reason as deepgram_stream: a socket
                                      # that has quietly gone must not take forty
                                      # seconds to notice.
                                      ping_interval=5, ping_timeout=10) as dg:
            await dg.send(json.dumps(settings))

            async with _STREAM_INIT_LOCK:
                stream, err = _open_stream_for("mic", loop, mic_queue, None)
            if err:
                await ws.send_json({"type": "error", **err.as_dict()})
                return
            await ws.send_json({"type": "state", "state": "connecting"})

            async def pump_mic():
                last_level = 0.0
                while not state.closed.is_set():
                    try:
                        pcm = await asyncio.wait_for(mic_queue.get(), timeout=0.5)
                    except asyncio.TimeoutError:
                        continue
                    silence = state.muted or (state.agent_playing and not state.headphones)
                    await dg.send(b"\x00" * len(pcm) if silence else pcm)
                    now = time.time()
                    if now - last_level > 0.1:
                        last_level = now
                        samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
                        level = 0.0 if silence else float(np.sqrt(np.mean(samples ** 2)))
                        try:
                            await ws.send_json({"type": "level", "mic": round(level, 4)})
                        except Exception:
                            return

            async def pump_agent():
                try:
                    await _pump_agent()
                except websockets.exceptions.ConnectionClosed as closed:
                    # Our relay closes with 4402 when the call's credits run
                    # out, and with 4403 when an admin blocks the account
                    # mid-call: say which, rather than ending as if the
                    # interviewer simply hung up.
                    why = relay_closed(closed)
                    if why is not None:
                        await ws.send_json({"type": "error", **why.as_dict()})
                    state.closed.set()

            async def _pump_agent():
                async for msg in dg:
                    if isinstance(msg, bytes):
                        if state.ending:
                            state.goodbye_audio = True
                        if not state.agent_playing:
                            state.agent_playing = True
                            await ws.send_json({"type": "state", "state": "speaking"})
                        await ws.send_bytes(msg)
                        continue
                    data = json.loads(msg)
                    kind = data.get("type")
                    if kind == "ConversationText":
                        role_ = data.get("role")
                        text = (data.get("content") or "").strip()
                        if not text:
                            continue
                        if pending["role"] not in (None, role_):
                            flush_transcript()
                        pending["role"] = role_
                        pending["text"].append(text)
                        await ws.send_json({"type": "caption",
                                            "role": "interviewer" if role_ == "assistant" else "you",
                                            "text": text})
                    elif kind == "UserStartedSpeaking":
                        await ws.send_json({"type": "state", "state": "user_speaking"})
                        if state.headphones:
                            await ws.send_json({"type": "interrupt"})
                    elif kind == "EndOfTurn":
                        await ws.send_json({"type": "state", "state": "thinking"})
                    elif kind == "AgentAudioDone":
                        await ws.send_json({"type": "agent_audio_done"})
                    elif kind == "FunctionCallRequest":
                        for fn in data.get("functions", []):
                            await dg.send(json.dumps({
                                "type": "FunctionCallResponse", "id": fn.get("id"),
                                "name": fn.get("name"), "content": "Interview ended.",
                            }))
                            if fn.get("name") == "end_interview" and not state.ending:
                                state.ending = True
                                state.ending_at = time.time()
                    elif kind == "Error":
                        fe = classify(Exception(f"{data.get('code', '')} {data.get('description', '')}"), "deepgram")
                        await ws.send_json({"type": "error", **fe.as_dict()})
                        state.closed.set()
                        return

            async def pump_client():
                while not state.closed.is_set():
                    msg = await ws.receive_json()
                    kind = msg.get("type")
                    if kind == "mute":
                        state.muted = bool(msg.get("muted"))
                    elif kind == "playback":
                        state.agent_playing = bool(msg.get("playing"))
                        if not state.agent_playing:
                            await ws.send_json({"type": "state", "state": "listening"})
                    elif kind == "end":
                        state.closed.set()
                        return

            async def watch_goodbye():
                # end_interview may arrive before or after the spoken goodbye.
                while not state.closed.is_set():
                    await asyncio.sleep(0.25)
                    if not state.ending:
                        continue
                    waited = time.time() - state.ending_at
                    finished_goodbye = state.goodbye_audio and not state.agent_playing
                    no_goodbye_coming = not state.goodbye_audio and not state.agent_playing and waited > 3
                    if finished_goodbye or no_goodbye_coming or waited > GOODBYE_TIMEOUT_SEC:
                        state.closed.set()

            tasks = [asyncio.create_task(t()) for t in (pump_mic, pump_agent, pump_client, watch_goodbye)]
            closed = asyncio.create_task(state.closed.wait())
            await asyncio.wait([*tasks, closed], return_when=asyncio.FIRST_COMPLETED)
            state.closed.set()
            for t in tasks:
                t.cancel()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await ws.send_json({"type": "error", **classify(e, "deepgram").as_dict()})
        except Exception:
            pass
    finally:
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass
        flush_transcript()
        try:
            costs.record("mock.voice", "deepgram-agent", AGENT_LLM.get("model", "agent"),
                         seconds=time.monotonic() - agent_started, session_id=session_id)
        except Exception:
            pass
        try:
            with sess._connect() as conn:
                answered = conn.execute(
                    "SELECT 1 FROM messages WHERE session_id = ? AND speaker = 'you' LIMIT 1", (session_id,)
                ).fetchone()
            # A call where the candidate never spoke isn't worth keeping in history.
            if answered:
                _end_session_record(session_id)
            else:
                sess.delete_session(session_id)
        except Exception:
            pass
        try:
            await ws.send_json({"type": "ended", "session_id": session_id})
            await ws.close()
        except Exception:
            pass


class FeedbackBody(BaseModel):
    session_id: int
    model: Optional[str] = None
    response_tone: Optional[str] = None


@router.post("/voice/feedback")
async def voice_feedback(body: FeedbackBody):
    from ..debrief import generate_debrief
    return await generate_debrief(body.session_id, body.model, body.response_tone)
