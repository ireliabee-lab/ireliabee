"""
People research (roadmap 2.6): prepare for anyone you're meeting.

A *person* is who you're about to talk to — a hiring manager, an examiner, a
client, a panel member. Research runs in the background in five stages:

  1. search   — several angles (their work, talks and interviews, writing,
                their organisation's news) across whatever sources are set up
  2. read     — the pages the user linked, then the most relevant results
  3. write    — one model call turns the evidence into a brief aimed at
                winning them over, using the user's own profile and CV for
                common ground, with every claim tied to a numbered source
  4. check    — accuracy pass: invented or missing citations are removed,
                then a second model call checks each factual claim against
                the text of the sources it cites; unsupported claims are
                dropped and partly-supported ones marked unconfirmed
  5. done     — the brief is stored; plans and live sessions that include
                this person hand it to the coach

Every source carries a reliability tier (official, reference, news, record,
secondary). Role, employer, dates and achievements must rest on the first
four; secondary sources alone only support "reportedly".

Scope is deliberately limited to public professional information. The model
is told to leave out home address, family, health, politics, religion and
private social accounts even when a source mentions them, and the reader
skips personal social networks.
"""
from __future__ import annotations

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Callable, Optional
from urllib.parse import urlparse

from .core.sessions import _connect
from .core import web_search as ws

STAGES = {
    "search": "Searching",
    "read": "Reading pages",
    "write": "Writing your brief",
    "check": "Checking every fact",
}

# ─── Source reliability ─────────────────────────────────────────────────────
TIERS = {
    "official": "official — their organisation, an institution, or a link the user gave",
    "reference": "reference — encyclopedia",
    "news": "news — established publication",
    "record": "record — their own papers or code",
    "secondary": "secondary — blogs, forums, aggregators (weakest)",
}
NEWS_SITES = (
    "reuters.com", "apnews.com", "bbc.com", "bbc.co.uk", "ft.com", "wsj.com", "nytimes.com", "theguardian.com",
    "bloomberg.com", "economist.com", "washingtonpost.com", "cnbc.com", "axios.com", "fortune.com", "forbes.com",
    "businessinsider.com", "techcrunch.com", "theverge.com", "wired.com", "arstechnica.com", "venturebeat.com",
    "technologyreview.com", "nature.com", "science.org", "newscientist.com", "theatlantic.com", "time.com",
    "aljazeera.com", "npr.org", "cnn.com", "semafor.com", "theinformation.com", "zdnet.com", "techrepublic.com",
)
INSTITUTION_SUFFIXES = (".gov", ".edu", ".mil", ".int", ".ac.uk", ".gov.uk", ".edu.au", ".ac.za", ".edu.gh", ".gov.gh", ".ac.in", ".nhs.uk")


def _host(url: str) -> str:
    host = urlparse(url).netloc.lower().split(":")[0]
    return host[4:] if host.startswith("www.") else host


def source_tier(url: str, source: str, organisation: str = "") -> str:
    """How much to trust a source for facts about the person."""
    host = _host(url)
    if source == "link":
        return "official"
    if source in ("papers", "github"):
        return "record"
    if "wikipedia.org" in host:
        return "reference"
    if host.endswith(INSTITUTION_SUFFIXES):
        return "official"
    tokens = [t for t in re.findall(r"[a-z0-9]+", organisation.lower()) if len(t) >= 4 and t not in ("group", "holdings", "company", "limited", "global", "international")]
    labels = host.split(".")
    if tokens and any(t in labels[-3:-1] or any(t == l.replace("-", "") for l in labels) for t in tokens):
        return "official"
    if any(host == n or host.endswith("." + n) for n in NEWS_SITES):
        return "news"
    return "secondary"

# Networks that are private by nature or can't be read without signing in.
SKIP_READING = ("facebook.com", "instagram.com", "tiktok.com", "x.com", "twitter.com", "linkedin.com", "threads.net")
MAX_FINDINGS = 30
MAX_PAGES = 6


def _ensure_schema():
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS people (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                name          TEXT NOT NULL,
                organisation  TEXT DEFAULT '',
                role          TEXT DEFAULT '',
                links_json    TEXT NOT NULL DEFAULT '[]',
                known         TEXT DEFAULT '',
                purpose       TEXT DEFAULT '',
                status        TEXT NOT NULL DEFAULT 'new',
                stage         TEXT DEFAULT '',
                error         TEXT DEFAULT '',
                brief_json    TEXT DEFAULT '',
                findings_json TEXT DEFAULT '',
                researched_at TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            )
            """
        )
        # A run can't survive an app restart; don't leave it spinning forever.
        conn.execute("UPDATE people SET status='failed', stage='', error=? WHERE status='running'",
                     (json.dumps({"title": "Research was interrupted", "message": "The app closed while it was running. Run it again."}),))


_ensure_schema()


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _row(r) -> dict:
    d = dict(r)
    d["links"] = json.loads(d.pop("links_json") or "[]")
    d["brief"] = json.loads(d.pop("brief_json") or "null") if d.get("brief_json") else None
    d.pop("brief_json", None)
    findings = d.pop("findings_json", "") or ""
    d["sources_checked"] = len(json.loads(findings).get("findings", [])) if findings else 0
    d["error"] = json.loads(d["error"]) if d.get("error") else None
    return d


def list_people() -> list[dict]:
    with _connect() as conn:
        return [_row(r) for r in conn.execute("SELECT * FROM people ORDER BY updated_at DESC")]


def get_person(pid: int) -> Optional[dict]:
    with _connect() as conn:
        r = conn.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
    return _row(r) if r else None


FIELDS = ("name", "organisation", "role", "known", "purpose")


def create_person(data: dict) -> dict:
    now = _now()
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO people (name, organisation, role, links_json, known, purpose, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (data["name"].strip(), data.get("organisation", "").strip(), data.get("role", "").strip(),
             json.dumps(clean_links(data.get("links", []))), data.get("known", "").strip(), data.get("purpose", "").strip(), now, now),
        )
        pid = cur.lastrowid
    return get_person(pid)


def update_person(pid: int, data: dict) -> Optional[dict]:
    sets, vals = [], []
    for f in FIELDS:
        if f in data and data[f] is not None:
            sets.append(f"{f}=?"); vals.append(str(data[f]).strip())
    if data.get("links") is not None:
        sets.append("links_json=?"); vals.append(json.dumps(clean_links(data["links"])))
    if sets:
        with _connect() as conn:
            conn.execute(f"UPDATE people SET {', '.join(sets)}, updated_at=? WHERE id=?", (*vals, _now(), pid))
    return get_person(pid)


def delete_person(pid: int):
    with _connect() as conn:
        conn.execute("DELETE FROM people WHERE id=?", (pid,))


def _set(pid: int, **cols):
    cols["updated_at"] = _now()
    with _connect() as conn:
        conn.execute(f"UPDATE people SET {', '.join(f'{k}=?' for k in cols)} WHERE id=?", (*cols.values(), pid))


def clean_links(links) -> list[str]:
    out: list[str] = []
    for raw in links or []:
        link = str(raw).strip()
        if not link:
            continue
        if not re.match(r"^https?://", link, re.I):
            link = "https://" + link
        if urlparse(link).netloc and link not in out:
            out.append(link)
    return out[:8]


# ─── Stage 1: search ────────────────────────────────────────────────────────
def search_queries(person: dict) -> list[str]:
    """Angles to search from. Quoting the name keeps results about this person."""
    name, org, role = person["name"].strip(), person.get("organisation", "").strip(), person.get("role", "").strip()
    q = f'"{name}"'
    queries = [
        f"{q} {org} {role}".strip(),
        f"{q} {org} interview OR podcast OR talk OR keynote".strip(),
        f"{q} {org} article OR blog OR wrote OR paper".strip(),
    ]
    if org:
        queries.append(f"{org} news {datetime.utcnow().year}")
        queries.append(f"{org} mission values culture")
    return queries


def gather(person: dict) -> tuple[list[dict], list[str]]:
    """Findings from every configured source, de-duplicated by URL."""
    from .core.research import _search_semantic_scholar, _search_github

    name, org = person["name"].strip(), person.get("organisation", "").strip()
    jobs: list[tuple[str, Callable[[], tuple[list, Optional[str]]]]] = [
        ("web", lambda q=q: ws.web_search(q, 6)) for q in search_queries(person)
    ] if ws.search_engine() else []
    jobs += [
        ("wikipedia", lambda: ws.wikipedia(f"{name} {org}".strip())),
        ("hacker-news", lambda: ws.hacker_news(f'"{name}"')),
        ("papers", lambda: _to_dicts(_search_semantic_scholar(name, 5))),
        ("github", lambda: _to_dicts(_search_github(name, 3))),
    ]
    if org:
        jobs.append(("wikipedia", lambda: ws.wikipedia(org, 1)))

    findings, errors, seen = [], [], set()
    with ThreadPoolExecutor(max_workers=6) as pool:
        for source, (items, err) in zip([s for s, _ in jobs], pool.map(lambda j: j[1](), jobs)):
            if err:
                errors.append(err)
            for it in items:
                url = (it.get("url") or "").rstrip("/")
                if not url or url in seen:
                    continue
                seen.add(url)
                findings.append({**it, "source": source})
    return findings[:MAX_FINDINGS], errors


def _to_dicts(result) -> tuple[list[dict], Optional[str]]:
    items, err = result
    return [{"title": f.title, "url": f.url, "snippet": f.snippet + (f" ({f.year})" if f.year else "")} for f in items], err


# ─── Stage 2: read ──────────────────────────────────────────────────────────
def pages_to_read(person: dict, findings: list[dict]) -> list[str]:
    """The user's own links first, then web results worth opening."""
    def readable(url: str) -> bool:
        host = urlparse(url).netloc.lower()
        return not any(host == d or host.endswith("." + d) for d in SKIP_READING)
    urls = [u for u in person.get("links", []) if readable(u)]
    for f in findings:
        if len(urls) >= MAX_PAGES:
            break
        if f["source"] in ("web", "hacker-news") and readable(f["url"]) and f["url"] not in urls:
            urls.append(f["url"])
    return urls[:MAX_PAGES]


def read_pages(urls: list[str]) -> tuple[list[dict], list[str]]:
    pages, errors = [], []
    with ThreadPoolExecutor(max_workers=4) as pool:
        for url, (text, err) in zip(urls, pool.map(lambda u: ws.fetch_text(u, 5000), urls)):
            if text:
                pages.append({"url": url, "text": text})
            elif err:
                errors.append(err)
    return pages, errors


# ─── Stage 3: write ─────────────────────────────────────────────────────────
BRIEF_PROMPT = """You prepare people for important conversations. The user is about to meet someone and wants to understand them well enough to win them over — build rapport, speak to what they care about, and answer their concerns — honestly, as themselves.

You get: who the user is meeting and why, what the user already knows, and numbered SOURCES (search results and page text), plus the user's own profile and CV.

First, decide which sources are really about THIS person. Names are shared: use the organisation, role, links and known facts to tell them apart. Ignore sources about someone else, and say so.

Then write the brief. Every factual claim about the person ends with its source number(s) like [3] or [2][5]. If the evidence is thin, say so plainly — never invent facts, quotes, dates or opinions. Advice and suggested wording need no citation, but must follow from cited facts or from the user's profile.

Each source is labelled with a reliability tier. Their current role, employer, titles, dates and achievements must be backed by an official, reference, news or record source; if only secondary sources say it, write "reportedly" or leave it out. When sources disagree, prefer the most recent official source and mention the disagreement in identity.note. Don't present old information as current — give the year when you know it. Cite only sources that actually say the thing.

Stay within public professional information: their work, roles, projects, publications, talks, interviews, stated views on their field, their organisation's news and values. Leave out home address, family, relationships, health, finances, politics, religion and private social media — even if a source mentions them.

Write plain text inside the JSON strings — no markdown (no **bold**, headings or bullets).

Reply with ONLY this JSON:
{
  "identity": {
    "summary": "one or two sentences: who they are now [n]",
    "confidence": "high" | "medium" | "low",
    "note": "how sure you are these sources are the right person, and what you excluded",
  },
  "snapshot": ["3-5 essentials to remember walking in [n]"],
  "cares_about": ["what they focus on and value right now, most recent first [n]"],
  "style": "how they seem to communicate and what they respond to — direct, data-driven, story-driven, formal… [n]",
  "common_ground": ["specific overlaps between the user's own experience/CV and this person's work or interests — name the user's project or result"],
  "win_them_over": ["concrete ways to earn their trust and interest in THIS conversation, tied to what they care about"],
  "openers": ["3-5 opening lines or questions that show genuine homework, in the user's voice"],
  "they_may_ask": [{"question": "a question this person is likely to ask the user", "answer": "how the user should answer, using their real experience"}],
  "objections": [{"concern": "a doubt they may have about the user or the proposal", "response": "how to address it honestly"}],
  "watch_outs": ["things to avoid saying or assuming"],
  "gaps": ["what couldn't be found and would be worth asking or checking"]
}"""


def _source_block(findings: list[dict], pages: list[dict], organisation: str = "") -> tuple[str, list[dict]]:
    """Numbered sources for the prompt, and the matching list kept with the brief."""
    sources, lines = [], []
    page_text = {p["url"]: p["text"] for p in pages}
    for p in pages:  # user links and read pages first: the richest evidence
        if not any(p["url"] == f["url"] for f in findings):
            findings = [{"title": p["url"], "url": p["url"], "snippet": "", "source": "link"}] + findings
    for i, f in enumerate(findings, 1):
        body = (page_text.get(f["url"]) or f.get("snippet") or "").strip()[:5000]
        tier = source_tier(f["url"], f["source"], organisation)
        sources.append({"n": i, "title": f["title"], "url": f["url"], "source": f["source"], "tier": tier, "text": body})
        lines.append(f"[{i}] ({f['source']}; reliability: {TIERS[tier]}) {f['title']}\nURL: {f['url']}\n{body}")
    return "\n\n".join(lines), sources


def brief_message(person: dict, findings: list[dict], pages: list[dict], me: str) -> tuple[str, list[dict]]:
    """The writer's message, and the numbered sources (with their text, for checking)."""
    block, sources = _source_block(findings, pages, person.get("organisation", ""))
    msg = "\n".join([
        f"MEETING: {person['name']}"
        + (f", {person['role']}" if person.get("role") else "")
        + (f" at {person['organisation']}" if person.get("organisation") else ""),
        f"WHY THE USER IS MEETING THEM: {person.get('purpose') or '(not given)'}",
        f"WHAT THE USER ALREADY KNOWS:\n{person.get('known') or '(nothing yet)'}",
        f"LINKS THE USER GAVE: {', '.join(person.get('links') or []) or '(none)'}",
        "",
        "THE USER (for common ground and answers):",
        me or "(no profile yet)",
        "",
        "SOURCES:",
        block or "(no sources found)",
    ])
    return msg, sources


def to_markdown(person: dict, brief: dict) -> str:
    """The brief as text for the live coach's prompt."""
    who = person["name"] + (f" — {person['role']}" if person.get("role") else "") + (f", {person['organisation']}" if person.get("organisation") else "")
    identity = brief.get("identity") or {}
    checked = (brief.get("verification") or {}).get("ran")
    out = [
        f"PERSON: {who}",
        f"(identity confidence: {identity.get('confidence', 'unknown')}; researched {(person.get('researched_at') or '')[:10] or 'recently'}; "
        + ("facts checked against sources)" if checked else "facts NOT independently checked)"),
        identity.get("summary", ""),
    ]
    unconfirmed = set(brief.get("unconfirmed") or [])

    def bullets(title: str, items):
        if items:
            out.append(f"{title}:")
            out.extend(f"  • {i}" + (" (unconfirmed)" if i in unconfirmed else "") for i in items)
    bullets("Essentials", brief.get("snapshot"))
    bullets("Cares about", brief.get("cares_about"))
    if brief.get("style"):
        out.append(f"Style: {brief['style']}" + (" (unconfirmed)" if brief["style"] in unconfirmed else ""))
    bullets("Common ground with the user", brief.get("common_ground"))
    bullets("How to win them over", brief.get("win_them_over"))
    bullets("Likely questions", [f"{q.get('question')} → {q.get('answer')}" for q in brief.get("they_may_ask") or []])
    bullets("Possible concerns", [f"{o.get('concern')} → {o.get('response')}" for o in brief.get("objections") or []])
    bullets("Avoid", brief.get("watch_outs"))
    # Citation markers help the reader click through; in the coach's prompt they're noise.
    return re.sub(r"\s*(\[\d+\])+", "", "\n".join(x for x in out if x))


# ─── Stage 4: check ─────────────────────────────────────────────────────────
CITE = re.compile(r"\[(\d+)\]")
FACT_LISTS = ("snapshot", "cares_about")


def _map_strings(value, fn):
    if isinstance(value, str):
        return fn(value)
    if isinstance(value, list):
        return [_map_strings(v, fn) for v in value]
    if isinstance(value, dict):
        return {k: _map_strings(v, fn) for k, v in value.items()}
    return value


def clean_citations(brief: dict, n_sources: int) -> tuple[dict, int]:
    """Remove citation numbers that point at no source. Returns (brief, how many removed)."""
    removed = 0

    def fix(text: str) -> str:
        nonlocal removed
        def keep(m):
            nonlocal removed
            if 1 <= int(m.group(1)) <= n_sources:
                return m.group(0)
            removed += 1
            return ""
        return CITE.sub(keep, text)
    body = {k: v for k, v in brief.items() if k != "sources"}
    return {**_map_strings(body, fix), **({"sources": brief["sources"]} if "sources" in brief else {})}, removed


def fact_claims(brief: dict) -> list[dict]:
    """The factual statements about the person that must be backed by sources."""
    claims = []
    summary = (brief.get("identity") or {}).get("summary") or ""
    if summary:
        claims.append({"field": "summary", "text": summary})
    if brief.get("style"):
        claims.append({"field": "style", "text": brief["style"]})
    for f in FACT_LISTS:
        for text in brief.get(f) or []:
            claims.append({"field": f, "text": text})
    for i, c in enumerate(claims, 1):
        c["id"] = i
        c["cites"] = sorted({int(n) for n in CITE.findall(c["text"])})
    return claims


VERIFY_PROMPT = """You are a strict fact-checker. For each numbered CLAIM about a person, read ONLY the sources the claim cites (given below it) and decide:
- "supported": the cited sources clearly state it
- "partly": the sources suggest it but don't fully state it, it's out of date, or only a secondary source says it
- "unsupported": the cited sources don't say it
Judge the facts, not the wording or tone. Reply with ONLY JSON:
{"verdicts": [{"id": 1, "verdict": "supported" | "partly" | "unsupported", "why": "a few words"}]}"""


def verify_message(claims: list[dict], sources: list[dict]) -> str:
    by_n = {s["n"]: s for s in sources}
    parts = []
    for c in claims:
        parts.append(f"CLAIM {c['id']}: {c['text']}")
        for n in c["cites"]:
            s = by_n.get(n)
            if s:
                parts.append(f"  SOURCE [{n}] ({TIERS[s.get('tier', 'secondary')]}) {s['title']}\n  {s.get('text', '')[:2500]}")
        parts.append("")
    return "\n".join(parts)


def apply_verdicts(brief: dict, claims: list[dict], verdicts: dict[int, str]) -> dict:
    """Drop unsupported facts, mark partly-supported ones, and record what the check did."""
    removed, unconfirmed = [], []
    drop = {c["id"] for c in claims if verdicts.get(c["id"]) == "unsupported" or not c["cites"]}
    for c in claims:
        if c["id"] in drop:
            removed.append(c["text"])
        elif verdicts.get(c["id"]) == "partly":
            unconfirmed.append(c["text"])
    for f in FACT_LISTS:
        brief[f] = [t for t in brief.get(f) or [] if t not in removed]
    identity = brief.setdefault("identity", {})
    if identity.get("summary") in removed:
        identity["summary"] = "Couldn't confirm who they are from the sources found — check the details before the meeting."
        identity["confidence"] = "low"
    if brief.get("style") in removed:
        brief["style"] = ""
    brief["unconfirmed"] = unconfirmed
    brief["verification"] = {"ran": bool(verdicts), "checked": len(claims), "removed": len(removed), "unconfirmed": len(unconfirmed)}
    return brief


def _check(brief: dict, sources: list[dict]) -> tuple[dict, Optional[str]]:
    brief, bad_refs = clean_citations(brief, len(sources))
    claims = fact_claims(brief)
    verdicts: dict[int, str] = {}
    problem = None
    checkable = [c for c in claims if c["cites"]]
    if checkable:
        try:
            out = _ask(VERIFY_PROMPT, verify_message(checkable, sources), 2048)
            verdicts = {int(v["id"]): v.get("verdict", "") for v in out.get("verdicts", []) if str(v.get("id", "")).isdigit()}
        except Exception:
            problem = "The fact-check step didn't run — treat the brief as unchecked."
    brief = apply_verdicts(brief, claims, verdicts)
    if not verdicts:
        brief["verification"]["ran"] = False
    brief["verification"]["bad_citations"] = bad_refs
    return brief, problem


def _user_context() -> str:
    from .routers.mock import _candidate_context
    return _candidate_context(None)[1]


def _ask(system: str, message: str, max_tokens: int = 4096) -> dict:
    from .errors import resolve_llm, classify
    from .core.providers import respond
    from .routers.mock import _parse_json

    model, provider = resolve_llm(None)
    try:
        raw = respond(provider, model, message, [], system, max_tokens)
        try:
            return _parse_json(raw)
        except (ValueError, json.JSONDecodeError):
            return _parse_json(respond(provider, model, message + "\n\nReply with ONLY the JSON object.", [], system, max_tokens))
    except Exception as e:
        raise classify(e, provider)


def _write(message: str) -> dict:
    return _ask(BRIEF_PROMPT, message)


def run_research(pid: int) -> None:
    """The whole pipeline, run on a background thread. Progress is stored on the row."""
    person = get_person(pid)
    if person is None:
        return
    try:
        _set(pid, status="running", stage="search", error="")
        findings, errors = gather(person)

        _set(pid, stage="read")
        pages, read_errors = read_pages(pages_to_read(person, findings))
        errors += read_errors

        _set(pid, stage="write")
        message, sources = brief_message(person, findings, pages, _user_context())
        brief = _write(message)

        _set(pid, stage="check")
        brief, problem = _check(brief, sources)
        if problem:
            errors.insert(0, problem)
        brief["sources"] = [{k: v for k, v in s.items() if k != "text"} for s in sources]
        brief["search_engine"] = ws.search_engine()
        brief["problems"] = errors[:8]
        _set(pid, status="done", stage="", brief_json=json.dumps(brief),
             findings_json=json.dumps({"findings": findings, "pages": [p["url"] for p in pages], "errors": errors}),
             researched_at=_now())
    except Exception as e:  # keep the reason for the UI
        from .errors import FriendlyError
        err = e.as_dict() if isinstance(e, FriendlyError) else {"title": "Research failed", "message": str(e)[:300]}
        _set(pid, status="failed", stage="", error=json.dumps(err))


def start_research(pid: int) -> dict:
    person = get_person(pid)
    if person and person["status"] != "running":
        _set(pid, status="running", stage="search", error="")
        threading.Thread(target=run_research, args=(pid,), daemon=True).start()
    return get_person(pid)


COACH_GUIDANCE = """How to use these briefs in every suggestion:
  • When this person asks something, frame the answer around what they care about, in the style they respond to.
  • Weave in the listed common ground where it genuinely fits — never force it.
  • If a question matches one of their likely questions, build on the prepared answer, adapted to the exact wording.
  • If a listed concern comes up, address it with the prepared response, honestly.
  • When there's a natural opening, suggest one of the openers or a question to ask them.
  • Steer clear of the watch-outs.
  • Use ONLY facts written here — never invent details about them. Treat anything marked (unconfirmed) as uncertain and don't have the user state it as fact.
  • Mention their public work naturally ("I read your post on…"); never have the user reveal personal details or that they "researched" them.
  • If identity confidence is low, lean on the user's own experience rather than the brief."""


def coach_block(ids: list[int]) -> str:
    """Researched people for the live coach: their briefs and how to use them ('' if none are ready)."""
    briefs = briefs_for(ids)
    if not briefs:
        return ""
    return (
        "\n\n" + "═" * 56 + "\n  WHO YOU'RE MEETING — researched briefs (HIGH PRIORITY)\n" + "═" * 56
        + "\n\n" + briefs + "\n\n" + COACH_GUIDANCE
    )


def briefs_for(ids: list[int]) -> str:
    """Brief text for the people linked to a plan (what the live coach reads)."""
    parts = []
    for pid in ids:
        p = get_person(pid)
        if p and p.get("brief"):
            parts.append(to_markdown(p, p["brief"]))
    return "\n\n".join(parts)
