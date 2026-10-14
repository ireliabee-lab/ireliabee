"""
Wordcraft's dictionary and phrase builder (docs/dictionary.md).

The data (Open English WordNet, CC BY 4.0, and Tatoeba's English sentences, CC BY 2.0 FR,
built by scripts/build_dictionary.py) is downloaded from our CDN the first time the
dictionary is opened, checked against its published SHA-256, and kept on this computer.
Every lookup is local: nothing about what you look up leaves the computer, and it costs
no credits.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import shutil
import sqlite3
import threading
import urllib.request
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from .core.appdirs import DATA_DIR

BASE_URL = os.environ.get("IRELIABEE_DICTIONARY_URL", "")
DB_PATH = DATA_DIR / "dictionary.db"
SCHEMA = 1
CREDITS = [
    {"name": "Open English WordNet", "licence": "CC BY 4.0", "url": "https://en-word.net/"},
    {"name": "Tatoeba", "licence": "CC BY 2.0 FR", "url": "https://tatoeba.org/"},
]

#: Cloudflare refuses Python's default user agent (403), so the app names itself.
HEADERS = {"User-Agent": "iReliabee (dictionary)"}

_lock = threading.Lock()
_job: dict = {"state": "idle", "done": 0, "total": 0, "error": ""}


def _open() -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


def installed() -> Optional[dict]:
    if not DB_PATH.exists():
        return None
    try:
        with _open() as con:
            meta = {r["key"]: r["value"] for r in con.execute("SELECT key, value FROM meta")}
        return meta if int(meta.get("schema", 0)) == SCHEMA else None
    except sqlite3.Error:
        return None


def status() -> dict:
    meta = installed()
    with _lock:
        job = dict(_job)
    return {"installed": bool(meta), "words": int(meta["words"]) if meta else 0, "download": job, "credits": CREDITS}


def _fetch_manifest() -> dict:
    if not BASE_URL:
        raise ValueError("This build has no dictionary to download. Build one with scripts/build_dictionary.py "
                         "and set IRELIABEE_DICTIONARY_URL to the folder holding it (a file:/// address works).")
    with urllib.request.urlopen(urllib.request.Request(f"{BASE_URL}/manifest.json", headers=HEADERS), timeout=20) as r:
        manifest = json.loads(r.read().decode("utf-8"))
    if int(manifest.get("schema", 0)) != SCHEMA or not re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("sha256", ""))):
        raise ValueError("The dictionary on the server isn't one this version of iReliabee can read.")
    return manifest


def _download(manifest: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    part, unpacked = DB_PATH.with_suffix(".db.gz.part"), DB_PATH.with_suffix(".db.new")
    digest = hashlib.sha256()
    url = f"{BASE_URL}/{manifest.get('file', 'dictionary.db.gz')}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as r, open(part, "wb") as f:
        while chunk := r.read(1 << 16):
            f.write(chunk)
            digest.update(chunk)
            with _lock:
                _job["done"] += len(chunk)
    if digest.hexdigest() != manifest["sha256"]:
        part.unlink(missing_ok=True)
        raise ValueError("The download was damaged. Try again.")
    with gzip.open(part, "rb") as src, open(unpacked, "wb") as dst:
        shutil.copyfileobj(src, dst)
    part.unlink(missing_ok=True)
    os.replace(unpacked, DB_PATH)


def _run() -> None:
    try:
        manifest = _fetch_manifest()
        with _lock:
            _job.update(total=int(manifest.get("size") or 0))
        _download(manifest)
        with _lock:
            _job.update(state="done")
    except Exception as e:  # shown to the user, who can try again
        with _lock:
            _job.update(state="error", error=str(e) if isinstance(e, ValueError) else
                        "The dictionary couldn't be downloaded. Check your connection and try again.")


def start_download() -> dict:
    """Download the dictionary in the background (once); status() reports progress."""
    if installed():
        return status()
    with _lock:
        if _job["state"] == "downloading":
            return status()
        _job.update(state="downloading", done=0, total=0, error="")
    threading.Thread(target=_run, name="dictionary-download", daemon=True).start()
    return status()


def _bases(word: str) -> list[str]:
    """The word, then likely dictionary forms of it (cats → cat, studied → study, running → run)."""
    w = word.lower()
    out = [w]
    rules = [("ies", "y"), ("ves", "f"), ("es", ""), ("s", ""), ("ied", "y"), ("ed", ""), ("ed", "e"),
             ("ing", ""), ("ing", "e"), ("er", ""), ("est", "")]
    for suffix, rep in rules:
        if w.endswith(suffix) and len(w) - len(suffix) >= 2:
            out.append(w[: len(w) - len(suffix)] + rep)
    for doubled in ("ing", "ed"):          # running → run, stopped → stop
        if w.endswith(doubled) and len(w) > len(doubled) + 2 and w[-len(doubled) - 1] == w[-len(doubled) - 2]:
            out.append(w[: -len(doubled) - 1])
    return list(dict.fromkeys(out))


def lookup(q: str) -> dict:
    """Meanings by part of speech (with examples and synonyms), real sentences, and the phrase builder."""
    q = re.sub(r"\s+", " ", (q or "").strip())[:80]
    if not q:
        raise HTTPException(400, detail={"code": "invalid", "title": "Type a word", "message": "Type a word or phrase to look up."})
    if not installed():
        raise HTTPException(409, detail={"code": "dictionary_missing", "title": "Download the dictionary first",
                                         "message": "It downloads once, then works offline."})
    with _open() as con:
        found, rows = q.lower(), []
        for base in _bases(q) if " " not in q else [q.lower()]:
            rows = con.execute("SELECT s.lemma, s.pos, s.synset, y.definition, y.examples FROM senses s "
                               "JOIN synsets y ON y.id = s.synset WHERE s.lower = ? ORDER BY s.rank", (base,)).fetchall()
            if rows:
                found = base
                break
        meanings: dict[str, list] = {}
        for r in rows:
            synonyms = [x["lemma"] for x in con.execute(
                "SELECT lemma FROM senses WHERE synset = ? AND lower != ? ORDER BY rank LIMIT 6", (r["synset"], found))]
            meanings.setdefault(r["pos"] or "other", []).append(
                {"definition": r["definition"], "examples": json.loads(r["examples"] or "[]"), "synonyms": synonyms})
        sentences = [x["text"] for x in con.execute("SELECT text FROM sentences WHERE lower = ? LIMIT 6", (found,))]
        phrases = {side: [{"word": x["word"], "count": x["count"]} for x in con.execute(
            "SELECT word, count FROM phrases WHERE lower = ? AND side = ? ORDER BY count DESC LIMIT 10", (found, side))]
            for side in ("before", "after")}
        # "running" is a word of its own, and also a form of "run": offer both.
        forms = [b for b in (_bases(q)[1:] if " " not in q else []) if b != found and
                 con.execute("SELECT 1 FROM senses WHERE lower = ? LIMIT 1", (b,)).fetchone()][:2]
    return {"query": q, "word": found if rows else q.lower(), "found": bool(rows), "forms_of": forms,
            "meanings": [{"pos": p, "senses": s[:8]} for p, s in meanings.items()],
            "sentences": sentences, "phrases": phrases}


def suggest(prefix: str, limit: int = 8) -> list[str]:
    prefix = (prefix or "").strip().lower()[:40]
    if len(prefix) < 2 or not installed():
        return []
    with _open() as con:
        # Common words first (how often Tatoeba's sentences use them), then shorter ones.
        return [r["lemma"] for r in con.execute(
            "SELECT s.lemma FROM senses s LEFT JOIN freq f ON f.lower = s.lower WHERE s.lower >= ? AND s.lower < ? "
            "GROUP BY s.lower ORDER BY COALESCE(f.count, 0) DESC, length(s.lower), s.lower LIMIT ?",
            (prefix, prefix + "￿", max(1, min(limit, 20))))]
