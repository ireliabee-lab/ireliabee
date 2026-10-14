"""
Web search and page reading for research.

General web search needs a search API key, set in Settings → Research:
Tavily (TAVILY_API_KEY) or Brave Search (BRAVE_SEARCH_API_KEY), both with
free tiers. Scraping search engines' HTML isn't an option — they answer
automated requests with a bot check — so without a key, research relies on
the keyless sources below plus the links and notes the user provides.

Keyless sources (public APIs meant for this): Wikipedia and Hacker News.
"""
from __future__ import annotations

import html
import os
import re
from typing import Optional
from urllib.parse import urlparse

import requests

UA = "iReliabee/1.0 (meeting preparation; desktop app)"
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

SEARCH_KEYS = ("TAVILY_API_KEY", "BRAVE_SEARCH_API_KEY")


def search_engine() -> Optional[str]:
    """Which web search is configured, or None."""
    if os.environ.get("TAVILY_API_KEY"):
        return "tavily"
    if os.environ.get("BRAVE_SEARCH_API_KEY"):
        return "brave"
    return None


def _tavily(query: str, limit: int) -> list[dict]:
    res = requests.post("https://api.tavily.com/search", json={
        "api_key": os.environ["TAVILY_API_KEY"], "query": query, "search_depth": "advanced",
        "max_results": limit, "include_answer": False,
    }, timeout=30)
    res.raise_for_status()
    return [
        {"title": r.get("title") or "(no title)", "url": r.get("url") or "", "snippet": (r.get("content") or "")[:800]}
        for r in res.json().get("results", [])
    ]


def _brave(query: str, limit: int) -> list[dict]:
    res = requests.get("https://api.search.brave.com/res/v1/web/search", params={"q": query, "count": limit},
                       headers={"Accept": "application/json", "X-Subscription-Token": os.environ["BRAVE_SEARCH_API_KEY"]},
                       timeout=20)
    res.raise_for_status()
    return [
        {"title": _clean(r.get("title") or "(no title)"), "url": r.get("url") or "", "snippet": _clean(r.get("description") or "")[:800]}
        for r in (res.json().get("web") or {}).get("results", [])[:limit]
    ]


def web_search(query: str, limit: int = 6) -> tuple[list[dict], Optional[str]]:
    """(results, error). Never raises — research carries on with what it has."""
    engine = search_engine()
    if engine is None:
        return [], None
    try:
        return (_tavily(query, limit) if engine == "tavily" else _brave(query, limit)), None
    except Exception as e:  # network, quota, bad key
        return [], f"{engine.title()} search failed for “{query}”: {e}"


def _clean(fragment: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", fragment))).strip()


# ─── Keyless public APIs ────────────────────────────────────────────────────
def wikipedia(query: str, limit: int = 2) -> tuple[list[dict], Optional[str]]:
    """Intro paragraphs of the best-matching Wikipedia articles (notable people and organisations)."""
    try:
        res = requests.get("https://en.wikipedia.org/w/api.php", params={
            "action": "query", "format": "json", "generator": "search", "gsrsearch": query, "gsrlimit": limit,
            "prop": "extracts|info", "exintro": 1, "explaintext": 1, "exchars": 1500, "inprop": "url",
        }, headers={"User-Agent": UA}, timeout=15)
        res.raise_for_status()
        pages = sorted((res.json().get("query") or {}).get("pages", {}).values(), key=lambda p: p.get("index", 99))
    except Exception as e:
        return [], f"Wikipedia lookup failed: {e}"
    return [{"title": p.get("title", ""), "url": p.get("fullurl", ""), "snippet": (p.get("extract") or "").strip()}
            for p in pages if (p.get("extract") or "").strip()], None


def hacker_news(query: str, limit: int = 5) -> tuple[list[dict], Optional[str]]:
    """Articles, talks and posts mentioning the query (Algolia's public HN search)."""
    try:
        res = requests.get("https://hn.algolia.com/api/v1/search", params={
            "query": query, "tags": "story", "hitsPerPage": limit,
        }, headers={"User-Agent": UA}, timeout=15)
        res.raise_for_status()
        hits = res.json().get("hits", [])
    except Exception as e:
        return [], f"Hacker News search failed: {e}"
    return [{
        "title": h.get("title") or "(untitled)",
        "url": h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID')}",
        "snippet": f"Posted {(h.get('created_at') or '')[:10]} · {h.get('points', 0)} points",
    } for h in hits if h.get("title")], None


# ─── Reading pages ──────────────────────────────────────────────────────────
def html_to_text(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style|noscript|svg|header|footer|nav|form)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?i)<(br|/p|/div|/li|/h[1-6]|/tr)\s*/?>", "\n", raw)
    text = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()


def fetch_text(url: str, limit: int = 6000) -> tuple[str, Optional[str]]:
    """(readable text, error). Pages behind a sign-in or built by JavaScript come back empty."""
    host = urlparse(url).netloc or url
    try:
        res = requests.get(url, timeout=15, headers={"User-Agent": BROWSER_UA, "Accept-Language": "en"})
    except Exception:
        return "", f"Couldn't open {host}"
    if res.status_code >= 400:
        return "", f"{host} didn't allow reading the page ({res.status_code})"
    if "html" not in res.headers.get("content-type", "text/html"):
        return "", f"{host} isn't a web page"
    text = html_to_text(res.text)
    if len(text) < 200:
        return "", f"{host} showed no readable text (it may need a sign-in)"
    return text[:limit], None
