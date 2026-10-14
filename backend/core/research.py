"""
General-purpose research module.

Given a counterparty (a name + optional affiliation), assembles a briefing the
coach can use during any conversation — job interview, academic call, sales
discovery, medical consult, whatever.

Sources (all optional — each contributes what it can, skips gracefully):
  * Web search (Tavily API) — general web results, news, blog posts, talks
  * Semantic Scholar (free API) — academic papers if the person publishes
  * GitHub REST API (free) — open-source presence if the person builds software

The raw findings then get run through the user's chosen LLM to produce a
condensed "briefing" grouped by domain (background, recent work, tone/style,
things worth knowing). Findings and briefing are attached to a MeetingPlan so
the coach can reference them during the live conversation.

No source is hardcoded. If you're prepping for a sales call, the academic
lookup will just return empty and the web search carries the load. If you're
prepping for a coding interview, the GitHub lookup carries it. The synthesis
step handles whichever mix comes back.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from typing import Optional

import requests


TAVILY_URL = "https://api.tavily.com/search"
SEMANTIC_SCHOLAR_URL = "https://api.semanticscholar.org/graph/v1/paper/search"
GITHUB_SEARCH_URL = "https://api.github.com/search/users"


@dataclass
class ResearchFinding:
    """A single piece of retrieved info."""
    source: str          # "web" | "semantic-scholar" | "github"
    title: str
    url: str
    snippet: str
    year: Optional[int] = None
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ResearchResult:
    """Everything gathered about a counterparty."""
    query_name: str
    affiliation: str
    findings: list[ResearchFinding]
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "query_name": self.query_name,
            "affiliation": self.affiliation,
            "findings": [f.to_dict() for f in self.findings],
            "errors": self.errors,
        }

    def by_source(self, source: str) -> list[ResearchFinding]:
        return [f for f in self.findings if f.source == source]


# ─── Tavily web search ────────────────────────────────────────────────────
def _search_tavily(query: str, max_results: int = 8) -> tuple[list[ResearchFinding], Optional[str]]:
    api_key = os.environ.get("TAVILY_API_KEY")
    if not api_key:
        return [], "TAVILY_API_KEY not set — skipping web search"
    try:
        resp = requests.post(
            TAVILY_URL,
            json={
                "api_key": api_key,
                "query": query,
                "search_depth": "advanced",
                "max_results": max_results,
                "include_answer": False,
            },
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as e:
        return [], f"Tavily error: {e}"

    data = resp.json()
    out: list[ResearchFinding] = []
    for r in data.get("results", []):
        out.append(ResearchFinding(
            source="web",
            title=r.get("title", "(no title)"),
            url=r.get("url", ""),
            snippet=(r.get("content") or "")[:800],
        ))
    return out, None


# ─── Semantic Scholar (papers) ────────────────────────────────────────────
def _search_semantic_scholar(query: str, limit: int = 6) -> tuple[list[ResearchFinding], Optional[str]]:
    try:
        resp = requests.get(
            SEMANTIC_SCHOLAR_URL,
            params={
                "query": query,
                "limit": limit,
                "fields": "title,abstract,year,authors,externalIds,url",
            },
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as e:
        return [], f"Semantic Scholar error: {e}"

    data = resp.json()
    out: list[ResearchFinding] = []
    for p in data.get("data", []):
        title = p.get("title", "(no title)")
        year = p.get("year")
        abstract = (p.get("abstract") or "")[:800]
        url = p.get("url") or ""
        authors_raw = p.get("authors") or []
        author_names = ", ".join(a.get("name", "") for a in authors_raw[:5])
        snippet = f"Authors: {author_names}\n{abstract}" if abstract else f"Authors: {author_names}"
        out.append(ResearchFinding(
            source="semantic-scholar",
            title=title,
            url=url,
            snippet=snippet,
            year=year,
            extra={"authors": author_names},
        ))
    return out, None


# ─── GitHub presence ──────────────────────────────────────────────────────
def _search_github(query: str, limit: int = 3) -> tuple[list[ResearchFinding], Optional[str]]:
    """Look up GitHub users matching `query`. Returns top candidates."""
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        resp = requests.get(
            GITHUB_SEARCH_URL,
            params={"q": query, "per_page": limit},
            headers=headers,
            timeout=15,
        )
        if resp.status_code == 403:
            return [], "GitHub rate-limited — set GITHUB_TOKEN for more"
        resp.raise_for_status()
    except Exception as e:
        return [], f"GitHub error: {e}"

    data = resp.json()
    out: list[ResearchFinding] = []
    for u in data.get("items", []):
        login = u.get("login", "")
        try:
            profile_resp = requests.get(
                f"https://api.github.com/users/{login}",
                headers=headers, timeout=10,
            )
            profile = profile_resp.json() if profile_resp.ok else {}
        except Exception:
            profile = {}
        bio = (profile.get("bio") or "").strip()
        name = profile.get("name") or login
        pubs = profile.get("public_repos", 0)
        followers = profile.get("followers", 0)
        snippet = f"{name} — {bio or '(no bio)'} · {pubs} repos · {followers} followers"
        out.append(ResearchFinding(
            source="github",
            title=login,
            url=u.get("html_url", f"https://github.com/{login}"),
            snippet=snippet,
            extra={"login": login, "bio": bio, "pubs": pubs, "followers": followers},
        ))
    return out, None


# ─── Orchestrator ─────────────────────────────────────────────────────────
def research_counterparty(
    name: str,
    affiliation: str = "",
    include_web: bool = True,
    include_papers: bool = True,
    include_github: bool = True,
) -> ResearchResult:
    """Run every enabled source and collect findings."""
    result = ResearchResult(query_name=name, affiliation=affiliation, findings=[])
    combined_query = f"{name} {affiliation}".strip()

    if include_web:
        findings, err = _search_tavily(combined_query)
        result.findings.extend(findings)
        if err:
            result.errors.append(err)

    if include_papers:
        # Search by name only for papers to widen the net
        findings, err = _search_semantic_scholar(name)
        result.findings.extend(findings)
        if err:
            result.errors.append(err)

    if include_github:
        findings, err = _search_github(name)
        result.findings.extend(findings)
        if err:
            result.errors.append(err)

    return result


# ─── LLM synthesis into a briefing ────────────────────────────────────────
BRIEFING_SYSTEM_PROMPT = """You are a research assistant preparing a briefing on a person the user is about to have a conversation with. Your goal is a compact, actionable brief the user can skim before the call.

Structure your output EXACTLY as follows using markdown headings:

# {name}
One-line description. Who they are, current role/affiliation, what they're known for.

## Snapshot
2-3 bullets — the essentials to remember in the first 30 seconds of the conversation.

## Recent focus
Bullet list of things they seem currently interested in (papers from the last 2 years, projects, public talks, blog posts). Cite sources by title.

## Signature themes
2-4 recurring themes across their work that shape their worldview.

## Tone and style
One paragraph. How do they seem to communicate? Formal / informal? What kind of questions do they typically ask? Do they value directness, depth, humility?

## Conversation openings
3-5 concrete questions or observations the user could raise that would signal genuine engagement with their work.

## Watch-outs
Things to avoid saying / assuming. Anything that would make the user look uninformed.

## Sources
Numbered list of the underlying URLs referenced in the brief, one per line.

RULES:
- Base every claim on the raw findings provided. If findings are thin in some area, say so plainly ("no recent public papers found") rather than inventing.
- Prefer specifics over generalisations. Cite paper titles, project names, dates.
- Keep the whole brief under 500 words.
- Don't editorialise. Sound like a good analyst, not a fan."""


def synthesize_briefing(
    result: ResearchResult,
    llm_provider: str,
    llm_model: str,
) -> str:
    """Run the LLM synthesis pass. Returns a markdown briefing."""
    from .providers import respond

    raw_dump_lines = [
        f"Counterparty name (as searched): {result.query_name}",
        f"Affiliation (as provided): {result.affiliation or '(not provided)'}",
        f"Errors during collection: {result.errors or 'none'}",
        "",
        "─" * 60,
        "RAW FINDINGS (grouped by source):",
        "─" * 60,
    ]

    for source in ("web", "semantic-scholar", "github"):
        items = result.by_source(source)
        if not items:
            raw_dump_lines.append(f"\n[{source.upper()}] (no results)")
            continue
        raw_dump_lines.append(f"\n[{source.upper()}]")
        for i, f in enumerate(items, 1):
            year_bit = f" ({f.year})" if f.year else ""
            raw_dump_lines.append(
                f"\n{i}. {f.title}{year_bit}\n"
                f"   URL: {f.url}\n"
                f"   {f.snippet}"
            )

    raw_dump = "\n".join(raw_dump_lines)

    user_message = (
        f"Produce the briefing for {result.query_name}"
        f"{' (' + result.affiliation + ')' if result.affiliation else ''} using the "
        f"findings below. Follow the exact structure specified in the system prompt.\n\n"
        + raw_dump
    )

    # We call respond() directly, bypassing conversation history.
    system_prompt = BRIEFING_SYSTEM_PROMPT.replace("{name}", result.query_name)
    return respond(llm_provider, llm_model, user_message, [], system_prompt)


def run_full_research(
    name: str,
    affiliation: str,
    llm_provider: str,
    llm_model: str,
) -> tuple[ResearchResult, str]:
    """One-shot: collect findings + synthesise briefing."""
    result = research_counterparty(name=name, affiliation=affiliation)
    briefing = synthesize_briefing(result, llm_provider, llm_model)
    return result, briefing
