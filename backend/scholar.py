"""
Find papers, for Write's Sources panel (docs/write-citation-backbone.md, "Find papers").

Two free scholarly indexes are searched at once, OpenAlex and Semantic Scholar, and their answers
merged into one list: the same paper from both (the same DOI, or the same title and year when a
record has none) is one result. Either provider being down or busy never fails the search; the
writer is told which one is missing. Only the search words and filters leave the computer, never
any part of a draft. No AI.

Searches are kept in ``scholar_cache`` for 7 days, or 1 hour when a provider was missing.
"""
from __future__ import annotations

import hashlib
import json
import re
import socket
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlencode

from fastapi import HTTPException

from . import link_import, writing_refs
from .core import sessions as sess

CONTACT = "support@ireliabee.co.uk"          # OpenAlex's polite pool
RESULTS_MAX = 25                            # per provider, and in the merged list
QUERY_MIN, QUERY_MAX = 2, 300
ABSTRACT_MAX = 10_000
AUTHORS_MAX = 50
CACHE_DAYS = 7
PARTIAL_CACHE_SECONDS = 3600
DEADLINE_SECONDS = 15
RRF_K = 10                                  # reciprocal rank fusion: 1 / (RRF_K + rank)

NAMES = {"openalex": "OpenAlex", "semantic_scholar": "Semantic Scholar"}

#: Fields a search can be narrowed to: OpenAlex filter (fields, or subfields where OpenAlex has no
#: field of its own) and Semantic Scholar fieldsOfStudy. Keys match frontend/src/lib/papers.ts.
FIELDS: dict[str, tuple[str, str, str]] = {
    "psychology": ("Psychology", "primary_topic.field.id:32", "Psychology"),
    "linguistics": ("Linguistics and language", "primary_topic.subfield.id:1203|3310", "Linguistics"),
    "medicine": ("Medicine and health", "primary_topic.field.id:27|36|29", "Medicine"),
    "neuroscience": ("Neuroscience", "primary_topic.field.id:28", "Biology,Medicine,Psychology"),
    "education": ("Education", "primary_topic.subfield.id:3304", "Education"),
    "computer_science": ("Computer science", "primary_topic.field.id:17", "Computer Science"),
    "social_sciences": ("Social sciences", "primary_topic.field.id:33", "Sociology,Political Science,Law,Geography"),
    "business": ("Business and economics", "primary_topic.field.id:14|20", "Business,Economics"),
    "humanities": ("Arts and humanities", "primary_topic.field.id:12", "Art,History,Philosophy"),
    "engineering": ("Engineering", "primary_topic.field.id:22", "Engineering"),
    "mathematics": ("Mathematics", "primary_topic.field.id:26", "Mathematics"),
    "biology": ("Biology", "primary_topic.field.id:13|11", "Biology"),
    "environment": ("Environmental science", "primary_topic.field.id:23", "Environmental Science"),
    "physics": ("Physics and chemistry", "primary_topic.field.id:31|16", "Physics,Chemistry"),
}

#: DOI prefixes of preprint servers: arXiv, bioRxiv and medRxiv (dated DOIs), PsyArXiv and the
#: other OSF servers, SSRN, Research Square, Preprints.org, Authorea, TechRxiv, ChemRxiv.
PREPRINT_DOI = re.compile(r"^10\.(48550/|1101/\d{4}\.\d{2}\.\d{2}|31234/|31219/|31235/|31222/|35542/|2139/ssrn|21203/rs\.|20944/preprints|22541/au\.|36227/techrxiv|26434/chemrxiv)", re.I)
PREPRINT_VENUE = re.compile(r"arxiv|biorxiv|medrxiv|psyarxiv|socarxiv|edarxiv|ssrn|research square|preprints\.org|techrxiv|chemrxiv|osf preprints|authorea", re.I)

OPENALEX_SELECT = ("id,doi,title,display_name,publication_year,authorships,primary_location,open_access,"
                   "cited_by_count,type,abstract_inverted_index,is_retracted,biblio,language")
S2_FIELDS = "title,authors,year,venue,abstract,citationCount,externalIds,isOpenAccess,openAccessPdf,publicationTypes"


def _now() -> float:
    return time.time()


def _ensure_schema() -> None:
    with sess._connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS scholar_cache (
                key         TEXT PRIMARY KEY,      -- sha256 of the query and filters
                body        TEXT NOT NULL,         -- the merged answer, as JSON
                created_at  REAL NOT NULL,         -- unix seconds
                ttl         REAL NOT NULL          -- seconds it is fresh for
            );
            """
        )


_ensure_schema()


# ── Records ───────────────────────────────────────────────────────────────────

def blank(**fields) -> dict:
    """A paper as the app shows it, whichever provider it came from."""
    paper = {"id": "", "doi": "", "title": "", "authors": [], "year": None, "venue": "", "abstract": "",
             "citations": 0, "open_access": False, "oa_url": "", "preprint": False, "retracted": False,
             "url": "", "type": "", "volume": "", "issue": "", "pages": "", "sources": [],
             "openalex_id": "", "s2_id": ""}
    paper.update(fields)
    return paper


def _doi(value) -> str:
    return writing_refs.normalise_doi(str(value or "")) or ""


def is_preprint_doi(doi: str) -> bool:
    return bool(PREPRINT_DOI.match(doi or ""))


title_key = writing_refs.title_key


def _text(value, limit: int = 500) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", str(value or ""))).strip()[:limit]


def rebuild_abstract(inverted: Optional[dict]) -> str:
    """OpenAlex keeps an abstract as {word: [positions]}; put the words back in order."""
    if not isinstance(inverted, dict):
        return ""
    at: dict[int, str] = {}
    for word, positions in inverted.items():
        for p in positions if isinstance(positions, list) else []:
            if isinstance(p, int) and 0 <= p < 20_000:
                at[p] = str(word)
    return _text(" ".join(at[i] for i in sorted(at)), ABSTRACT_MAX)


def from_openalex(work: dict) -> dict:
    loc = work.get("primary_location") or {}
    source = loc.get("source") or {}
    oa = work.get("open_access") or {}
    biblio = work.get("biblio") or {}
    doi = _doi(work.get("doi"))
    pages = "-".join(x for x in (biblio.get("first_page"), biblio.get("last_page")) if x)
    year = work.get("publication_year")
    venue = _text(source.get("display_name"), 300)
    return blank(
        id=f"doi:{doi}" if doi else f"openalex:{str(work.get('id', '')).rsplit('/', 1)[-1]}",
        doi=doi, title=_text(work.get("title") or work.get("display_name")),
        authors=[_text((a.get("author") or {}).get("display_name") or a.get("raw_author_name"), 120)
                 for a in (work.get("authorships") or [])[:AUTHORS_MAX] if isinstance(a, dict)],
        year=year if isinstance(year, int) else None, venue=venue,
        abstract=rebuild_abstract(work.get("abstract_inverted_index")),
        citations=int(work.get("cited_by_count") or 0), open_access=bool(oa.get("is_oa")),
        oa_url=str(oa.get("oa_url") or ""), retracted=bool(work.get("is_retracted")),
        preprint=work.get("type") == "preprint" or is_preprint_doi(doi) or bool(PREPRINT_VENUE.search(venue)),
        url=str(loc.get("landing_page_url") or (f"https://doi.org/{doi}" if doi else work.get("id") or "")),
        type=str(work.get("type") or ""), volume=str(biblio.get("volume") or ""), issue=str(biblio.get("issue") or ""),
        pages=pages, sources=["openalex"], openalex_id=str(work.get("id", "")).rsplit("/", 1)[-1],
    )


def from_semantic_scholar(paper: dict) -> dict:
    ids = paper.get("externalIds") or {}
    doi = _doi(ids.get("DOI"))
    venue = _text(paper.get("venue"), 300)
    pdf = (paper.get("openAccessPdf") or {}).get("url") or ""
    types = [str(t) for t in paper.get("publicationTypes") or []]
    year = paper.get("year")
    arxiv_only = bool(ids.get("ArXiv")) and (not doi or is_preprint_doi(doi))
    return blank(
        id=f"doi:{doi}" if doi else f"s2:{paper.get('paperId', '')}",
        doi=doi, title=_text(paper.get("title")),
        authors=[_text(a.get("name"), 120) for a in (paper.get("authors") or [])[:AUTHORS_MAX] if isinstance(a, dict) and a.get("name")],
        year=year if isinstance(year, int) else None, venue=venue,
        abstract=_text(paper.get("abstract"), ABSTRACT_MAX), citations=int(paper.get("citationCount") or 0),
        open_access=bool(paper.get("isOpenAccess")), oa_url=str(pdf),
        preprint=is_preprint_doi(doi) or bool(PREPRINT_VENUE.search(venue)) or arxiv_only,
        url=f"https://www.semanticscholar.org/paper/{paper.get('paperId', '')}" if paper.get("paperId") else "",
        type="conference-paper" if "Conference" in types else "review" if "Review" in types else "book" if "Book" in types else "article",
        sources=["semantic_scholar"], s2_id=str(paper.get("paperId") or ""),
    )


def _merge_into(a: dict, b: dict) -> None:
    a["sources"] = a["sources"] + [s for s in b["sources"] if s not in a["sources"]]
    a["citations"] = max(a["citations"], b["citations"])
    if len(b["abstract"]) > len(a["abstract"]):
        a["abstract"] = b["abstract"]
    for k in ("doi", "venue", "oa_url", "url", "volume", "issue", "pages", "openalex_id", "s2_id", "year"):
        if not a.get(k) and b.get(k):
            a[k] = b[k]
    if not a["authors"]:
        a["authors"] = b["authors"]
    a["open_access"] = a["open_access"] or b["open_access"]
    a["preprint"] = a["preprint"] or b["preprint"]
    a["retracted"] = a["retracted"] or b["retracted"]


def merge(lists: list[list[dict]]) -> list[dict]:
    """One result per paper, best first: reciprocal rank fusion over each provider's order, then
    citations. A paper is the same by DOI, or by title and year when either record lacks a DOI."""
    merged: list[dict] = []
    by_doi: dict[str, dict] = {}
    by_title: dict[str, dict] = {}
    score: dict[int, float] = {}
    for results in lists:
        for rank, p in enumerate(results):
            p = {**p, "authors": list(p["authors"]), "sources": list(p["sources"])}
            tk = title_key(p["title"], p["year"])
            same = by_doi.get(p["doi"]) if p["doi"] else None
            if same is None and tk:
                cand = by_title.get(tk)
                if cand is not None and (not cand["doi"] or not p["doi"]):
                    same = cand
            if same is None:
                merged.append(p)
                same = p
            else:
                _merge_into(same, p)
            score[id(same)] = score.get(id(same), 0.0) + 1.0 / (RRF_K + rank + 1)
            if same["doi"]:
                by_doi[same["doi"]] = same
            if tk:
                by_title.setdefault(tk, same)
    merged.sort(key=lambda p: (-score[id(p)], -p["citations"]))
    return merged


# ── Providers ─────────────────────────────────────────────────────────────────

class ProviderFailed(Exception):
    def __init__(self, status: str):
        super().__init__(status)
        self.status = status       # "busy", "down" or "offline"


def _get_json(url: str, deadline: float) -> dict:
    try:
        raw, _, _ = link_import.fetch_public(url, deadline=deadline, accept="application/json")
    except link_import.Unreadable as e:
        raise ProviderFailed("busy" if getattr(e, "status", 0) == 429 else "down") from e
    except socket.gaierror as e:
        raise ProviderFailed("offline") from e
    except (OSError, HTTPException, link_import.http.client.HTTPException, ValueError) as e:
        raise ProviderFailed("down") from e
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise ProviderFailed("down") from e
    if not isinstance(data, dict):
        raise ProviderFailed("down")
    return data


def _openalex(q: str, f: dict, deadline: float) -> tuple[list[dict], Optional[int]]:
    filters = []
    if f["year_from"] or f["year_to"]:
        filters.append(f"publication_year:{f['year_from'] or ''}-{f['year_to'] or ''}" if f["year_from"] and f["year_to"]
                       else f"publication_year:>{f['year_from'] - 1}" if f["year_from"] else f"publication_year:<{f['year_to'] + 1}")
    if f["open_access"]:
        filters.append("is_oa:true")
    if f["min_citations"]:
        filters.append(f"cited_by_count:>{f['min_citations'] - 1}")
    if not f["preprints"]:
        filters.append("type:!preprint")
    if f["field"]:
        filters.append(FIELDS[f["field"]][1])
    params = {"search": q, "per-page": RESULTS_MAX, "select": OPENALEX_SELECT, "mailto": CONTACT}
    if filters:
        params["filter"] = ",".join(filters)
    data = _get_json("https://api.openalex.org/works?" + urlencode(params), deadline)
    results = data.get("results")
    if not isinstance(results, list):
        raise ProviderFailed("down")
    count = (data.get("meta") or {}).get("count")
    return [from_openalex(w) for w in results if isinstance(w, dict)], count if isinstance(count, int) else None


def _semantic_scholar(q: str, f: dict, deadline: float) -> tuple[list[dict], Optional[int]]:
    # Semantic Scholar's search finds nothing for hyphenated terms; its own advice is to use spaces.
    params: dict = {"query": re.sub(r"\s+", " ", q.replace("-", " ")).strip(), "limit": RESULTS_MAX, "fields": S2_FIELDS}
    if f["year_from"] or f["year_to"]:
        params["year"] = f"{f['year_from'] or ''}-{f['year_to'] or ''}"
    if f["min_citations"]:
        params["minCitationCount"] = f["min_citations"]
    if f["field"]:
        params["fieldsOfStudy"] = FIELDS[f["field"]][2]
    url = "https://api.semanticscholar.org/graph/v1/paper/search?" + urlencode(params)
    if f["open_access"]:
        url += "&openAccessPdf"
    data = _get_json(url, deadline)
    results = data.get("data", [] if data.get("total") == 0 else None)
    if not isinstance(results, list):
        raise ProviderFailed("down")
    total = data.get("total")
    return [from_semantic_scholar(p) for p in results if isinstance(p, dict)], total if isinstance(total, int) else None


PROVIDERS = {"openalex": _openalex, "semantic_scholar": _semantic_scholar}


# ── Search ────────────────────────────────────────────────────────────────────

def _filters(year_from, year_to, open_access, min_citations, preprints, field) -> dict:
    this_year = datetime.now(timezone.utc).year
    years = []
    for y in (year_from, year_to):
        if y in (None, ""):
            years.append(None)
            continue
        try:
            y = int(y)
        except (TypeError, ValueError):
            raise HTTPException(400, "A year is four digits, like 2015.")
        if not 1000 <= y <= this_year + 1:
            raise HTTPException(400, f"Pick a year between 1000 and {this_year + 1}.")
        years.append(y)
    if years[0] and years[1] and years[0] > years[1]:
        years.reverse()
    field = (field or "").strip()
    if field and field not in FIELDS:
        raise HTTPException(400, "That field isn't one the search knows.")
    return {"year_from": years[0], "year_to": years[1], "open_access": bool(open_access),
            "min_citations": max(0, min(int(min_citations or 0), 1_000_000)), "preprints": bool(preprints), "field": field}


def _keep(p: dict, f: dict) -> bool:
    """The filters again on the merged list, so both providers' answers agree with them."""
    if (f["year_from"] or f["year_to"]) and p["year"] is None:
        return False
    if f["year_from"] and p["year"] < f["year_from"] or f["year_to"] and p["year"] > f["year_to"]:
        return False
    if f["open_access"] and not p["open_access"]:
        return False
    if p["citations"] < f["min_citations"]:
        return False
    return f["preprints"] or not p["preprint"]


def _cache_key(q: str, f: dict) -> str:
    return hashlib.sha256(json.dumps([q.casefold(), f], sort_keys=True).encode()).hexdigest()


def _cached(key: str, stale_ok: bool = False) -> Optional[dict]:
    with sess._connect() as conn:
        row = conn.execute("SELECT body, created_at, ttl FROM scholar_cache WHERE key = ?", (key,)).fetchone()
    if row is None or (not stale_ok and _now() - row["created_at"] > row["ttl"]):
        return None
    body = json.loads(row["body"])
    body["cached_at"] = datetime.fromtimestamp(row["created_at"], timezone.utc).isoformat(timespec="seconds")
    return body


def _store(key: str, body: dict, ttl: float) -> None:
    now = _now()
    with sess._connect() as conn:
        conn.execute("DELETE FROM scholar_cache WHERE created_at < ?", (now - CACHE_DAYS * 86400 - 86400,))
        conn.execute("INSERT OR REPLACE INTO scholar_cache (key, body, created_at, ttl) VALUES (?, ?, ?, ?)",
                     (key, json.dumps(body, ensure_ascii=False), now, ttl))


def _notice(statuses: dict[str, str]) -> str:
    missing = [k for k, s in statuses.items() if s != "ok"]
    if len(missing) != 1:
        return ""
    gone, there = missing[0], next(k for k in statuses if k != missing[0])
    why = {"busy": "is busy right now", "offline": "couldn't be reached"}.get(statuses[gone], "didn't answer")
    return f"{NAMES[gone]} {why}, so these results are from {NAMES[there]} only."


def search(query: str, *, year_from=None, year_to=None, open_access: bool = False, min_citations: int = 0,
           preprints: bool = True, field: str = "") -> dict:
    """Papers matching the words, from both providers, merged and filtered."""
    q = re.sub(r"\s+", " ", query or "").strip()[:QUERY_MAX].strip()
    if len(q) < QUERY_MIN:
        raise HTTPException(400, f"Type at least {QUERY_MIN} characters to search for papers.")
    f = _filters(year_from, year_to, open_access, min_citations, preprints, field)
    key = _cache_key(q, f)
    hit = _cached(key)
    if hit is not None:
        return hit

    deadline = time.monotonic() + DEADLINE_SECONDS
    statuses: dict[str, str] = {}
    found: dict[str, list[dict]] = {}
    totals: dict[str, Optional[int]] = {}
    with ThreadPoolExecutor(max_workers=len(PROVIDERS)) as pool:
        futures = {name: pool.submit(fn, q, f, deadline) for name, fn in PROVIDERS.items()}
        for name, fut in futures.items():
            try:
                found[name], totals[name] = fut.result()
                statuses[name] = "ok"
            except ProviderFailed as e:
                statuses[name] = e.status
            except Exception:   # a shape nobody expected is that provider being down, never the search failing
                statuses[name] = "down"

    if not found:
        stale = _cached(key, stale_ok=True)
        offline = all(s == "offline" for s in statuses.values())
        if stale is not None:
            when = stale["cached_at"][:10]
            stale["notice"] = (f"You seem to be offline. These are the results saved on {when}." if offline
                               else f"The search services aren't answering. These are the results saved on {when}.")
            return stale
        if offline:
            raise HTTPException(503, "You seem to be offline. Finding papers needs the internet; your sources and draft are all here.")
        if all(s == "busy" for s in statuses.values()):
            raise HTTPException(429, "Both paper search services are busy right now. Try again in a minute.")
        raise HTTPException(503, "The paper search services aren't answering. Try again in a few minutes, or add a source by its DOI.")

    results = [p for p in merge([found[n] for n in PROVIDERS if n in found]) if _keep(p, f)][:RESULTS_MAX]
    total = totals.get("openalex") if totals.get("openalex") is not None else totals.get("semantic_scholar")
    body = {
        "query": q, "results": results, "total": total, "notice": _notice(statuses),
        "providers": {n: {"status": statuses[n], "count": len(found.get(n, []))} for n in PROVIDERS},
        "cached_at": None,
    }
    _store(key, body, CACHE_DAYS * 86400 if all(s == "ok" for s in statuses.values()) else PARTIAL_CACHE_SECONDS)
    return body


# ── Adding a result as a source ───────────────────────────────────────────────

CSL_TYPE = {"article": "article-journal", "review": "article-journal", "conference-paper": "paper-conference",
            "proceedings-article": "paper-conference", "book": "book", "book-chapter": "chapter", "dissertation": "thesis",
            "report": "report", "dataset": "dataset", "preprint": "article"}


def _name(full: str) -> dict:
    """"Ji-Hoon Kim" as family Kim; one word alone (an organisation, a name in a script written
    without spaces) is kept whole."""
    words = (full or "").split()
    if len(words) > 1:
        return {"family": words[-1], "given": " ".join(words[:-1])}
    return {"literal": words[0]} if words else {}


def to_csl(paper: dict) -> dict:
    """A search result as CSL-JSON, with only what the record says: nothing guessed."""
    item: dict = {"title": paper.get("title") or ""}
    if paper.get("preprint"):
        item["type"] = "article"
    else:
        item["type"] = CSL_TYPE.get(paper.get("type") or "", "article-journal" if paper.get("venue") else "article")
    names = [n for n in (_name(a) for a in paper.get("authors") or []) if n]
    if names:
        item["author"] = names
    if isinstance(paper.get("year"), int):
        item["issued"] = {"date-parts": [[paper["year"]]]}
    if paper.get("venue"):
        item["publisher" if paper.get("preprint") else "container-title"] = paper["venue"]
    for src, dst in (("volume", "volume"), ("issue", "issue"), ("pages", "page")):
        if paper.get(src):
            item[dst] = paper[src]
    if paper.get("doi"):
        item["DOI"] = paper["doi"]
    elif paper.get("url"):
        item["URL"] = paper["url"]
    return writing_refs.clean_item(item)


def _clean_paper(paper: dict) -> dict:
    """What the app sent back from a search, held to the shapes and sizes a search gives."""
    if not isinstance(paper, dict):
        raise HTTPException(400, "A paper must be an object.")
    p = blank()
    for k in ("title", "venue", "type", "volume", "issue", "pages", "openalex_id", "s2_id"):
        p[k] = _text(paper.get(k), 500)
    p["abstract"] = _text(paper.get("abstract"), ABSTRACT_MAX)
    p["doi"] = _doi(paper.get("doi"))
    for k in ("url", "oa_url"):
        v = str(paper.get(k) or "")
        p[k] = v[:2000] if v.startswith(("https://", "http://")) else ""
    p["authors"] = [_text(a, 120) for a in (paper.get("authors") or [])[:AUTHORS_MAX] if isinstance(a, str) and a.strip()]
    year = paper.get("year")
    p["year"] = year if isinstance(year, int) and 1000 <= year <= 3000 else None
    try:
        p["citations"] = max(0, int(paper.get("citations") or 0))
    except (TypeError, ValueError):
        p["citations"] = 0
    for k in ("open_access", "preprint", "retracted"):
        p[k] = bool(paper.get(k))
    p["sources"] = [s for s in paper.get("sources") or [] if s in NAMES]
    if not p["title"]:
        raise HTTPException(400, "A paper needs a title.")
    return p


def add_to_project(project_id: int, paper: dict) -> dict:
    """A search result as one of the project's sources. With a DOI, the publisher's own record from
    doi.org (as "By DOI" adds it); without one, or if doi.org has none, the search record."""
    p = _clean_paper(paper)
    item = None
    if p["doi"]:
        try:
            item = writing_refs.lookup_doi(p["doi"])
        except HTTPException:
            item = None
    if item is None:
        item = to_csl(p)
    meta = {"citations": p["citations"], "open_access": p["open_access"], "oa_url": p["oa_url"],
            "preprint": p["preprint"], "retracted": p["retracted"], "venue": p["venue"],
            "openalex_id": p["openalex_id"], "s2_id": p["s2_id"], "found_by": p["sources"],
            "searched_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    return writing_refs.add(project_id, item, abstract=p["abstract"], meta=meta, same_title=True)
