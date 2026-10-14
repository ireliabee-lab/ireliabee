import asyncio
import html
import json
import re
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core import research as research_mod
from ..core.meeting_plans import create_plan, delete_plan, get_plan, list_plans, update_plan
from ..errors import FriendlyError, classify, resolve_llm

router = APIRouter()


class Section(BaseModel):
    title: str = ""
    minutes: Optional[int] = None
    goal: str = ""


class PlanBody(BaseModel):
    title: str
    counterparty: str = ""
    purpose: str = ""
    duration_min: int = 45
    sections: list[Section] = []
    answers_prep: list[str] = []
    questions_ask: list[str] = []
    traps_avoid: list[str] = []
    commitments: list[str] = []
    notes: str = ""
    people_ids: list[int] = []
    document_ids: list[int] = []


def _clean_fields(body: PlanBody) -> dict:
    data = body.model_dump()
    data["title"] = data["title"].strip()
    if not data["title"]:
        raise HTTPException(400, detail={"code": "invalid", "title": "Plan needs a title", "message": "Give the plan a short title."})
    data["sections"] = [s for s in data["sections"] if (s.get("title") or "").strip()]
    for key in ("answers_prep", "questions_ask", "traps_avoid", "commitments"):
        data[key] = [x.strip() for x in data[key] if x and x.strip()]
    return data


@router.get("/")
def get_plans():
    plans = [get_plan(row["id"]) for row in list_plans(limit=200)]
    for p in plans:
        p.pop("raw_research_json", None)
    return plans


@router.get("/{plan_id}")
def get_one_plan(plan_id: int):
    plan = get_plan(plan_id)
    if plan is None:
        raise HTTPException(404, "Plan not found")
    return plan


@router.post("/")
def create_new_plan(body: PlanBody):
    data = _clean_fields(body)
    plan_id = create_plan(**data)
    return get_plan(plan_id)


@router.put("/{plan_id}")
def update_existing_plan(plan_id: int, body: PlanBody):
    if get_plan(plan_id) is None:
        raise HTTPException(404, "Plan not found")
    update_plan(plan_id, **_clean_fields(body))
    return get_plan(plan_id)


@router.delete("/{plan_id}")
def delete_existing_plan(plan_id: int):
    delete_plan(plan_id)
    return {"status": "deleted"}


@router.post("/{plan_id}/research")
async def run_plan_research(plan_id: int):
    plan = get_plan(plan_id)
    if plan is None:
        raise HTTPException(404, "Plan not found")
    name = (plan.get("counterparty") or "").strip()
    if not name:
        raise FriendlyError(
            "invalid", "Add who you're meeting first",
            "Research looks up the company or person in the plan's Counterparty field.",
        )
    model, provider = resolve_llm(None)
    loop = asyncio.get_running_loop()
    try:
        result, briefing = await loop.run_in_executor(
            None, research_mod.run_full_research, name, plan.get("purpose") or "", provider, model,
        )
    except Exception as e:
        raise classify(e, provider)
    update_plan(plan_id, briefing=briefing, raw_research_json=json.dumps(result.to_dict()))
    return get_plan(plan_id)


# ── Import from a job posting ────────────────────────────────────────────────

class ImportBody(BaseModel):
    url: Optional[str] = None
    text: Optional[str] = None
    model: Optional[str] = None


def _page_text(url: str) -> str:
    import requests

    try:
        res = requests.get(url, timeout=20, headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
            "Accept-Language": "en",
        })
    except Exception:
        raise FriendlyError(
            "network", "Couldn't open that link",
            "Check the link and your internet connection, or paste the job description instead.",
        )
    if res.status_code >= 400:
        raise FriendlyError(
            "unreadable", "That site blocked reading the job post",
            "Some sites (like LinkedIn) need you to be signed in. Copy the job description and paste it instead.",
        )
    raw = res.text
    raw = re.sub(r"(?is)<(script|style|noscript|svg|header|footer|nav)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<(br|/p|/div|/li|/h[1-6])\s*/?>", "\n", raw)
    text = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
    if len(text) < 300:
        raise FriendlyError(
            "unreadable", "Couldn't find the job description on that page",
            "The page may load its content with JavaScript or need a sign-in. Paste the description instead.",
        )
    return text[:12000]


@router.post("/import")
async def import_plan(body: ImportBody):
    from .mock import _ask_model, _candidate_context, _level_text

    source = (body.text or "").strip()
    if not source and (body.url or "").strip():
        loop = asyncio.get_running_loop()
        source = await loop.run_in_executor(None, _page_text, body.url.strip())
    if len(source) < 80:
        raise FriendlyError(
            "invalid", "Add a job description",
            "Paste a job link or at least a few lines of the job description.",
        )

    profile, context = _candidate_context(None)
    system_prompt = f"""You prepare a candidate for a specific job interview from its job description.

CANDIDATE
{context}

{_level_text(profile)} Tailor everything to that level and to what the candidate has actually done.

Return ONLY JSON, no prose:
{{"title": "short plan title, e.g. 'Acme — Junior Backend Engineer interview'",
  "counterparty": "company name (and team if stated)",
  "role": "job title",
  "purpose": "one sentence: what the candidate wants from this interview",
  "duration_min": <int, a typical length for this interview stage, usually 30-60>,
  "sections": [{{"title": "agenda block", "minutes": <int>, "goal": "what to achieve in it"}}],
  "answers_prep": ["likely question → the angle and real example from the candidate's background to use"],
  "questions_ask": ["smart questions to ask the interviewer about this role and company"],
  "traps_avoid": ["specific pitfalls for this role, e.g. overselling a skill the candidate lacks"],
  "commitments": ["concrete outcomes to leave the interview with"],
  "notes": "the 4-6 must-have requirements and any stated nice-to-haves, as short lines"}}
Use 4-6 sections that add up to duration_min, 5-8 answers_prep, 3-5 questions_ask, 3-5 traps_avoid, 2-3 commitments.
Only use facts from the job description and the candidate context."""

    data = await _ask_model(body.model, system_prompt, "JOB DESCRIPTION\n" + source[:12000], kind="plan")

    def strings(key, limit):
        return [str(s).strip() for s in data.get(key, []) if str(s).strip()][:limit]

    sections = []
    for s in data.get("sections", [])[:8]:
        if isinstance(s, dict) and str(s.get("title", "")).strip():
            try:
                minutes = int(s.get("minutes")) if s.get("minutes") is not None else None
            except (TypeError, ValueError):
                minutes = None
            sections.append({"title": str(s["title"]).strip(), "minutes": minutes, "goal": str(s.get("goal", "")).strip()})
    try:
        duration = max(10, min(240, int(data.get("duration_min") or 45)))
    except (TypeError, ValueError):
        duration = 45

    return {
        "title": str(data.get("title", "")).strip() or "Interview plan",
        "counterparty": str(data.get("counterparty", "")).strip(),
        "purpose": str(data.get("purpose", "")).strip(),
        "duration_min": duration,
        "sections": sections,
        "answers_prep": strings("answers_prep", 10),
        "questions_ask": strings("questions_ask", 6),
        "traps_avoid": strings("traps_avoid", 6),
        "commitments": strings("commitments", 4),
        "notes": str(data.get("notes", "")).strip(),
    }
