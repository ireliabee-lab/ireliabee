"""
A writing project's sources (docs/academic-writing.md, stage 3).

Each source is kept as CSL-JSON, the format citeproc-js formats in any citation style
(frontend/src/lib/citations.ts), with a citation key the writer cites it by: ``[@lecun2015]``.
Sources come from a DOI (doi.org's citation data, through Crossref), from a Library document, or are
typed in. Nothing here calls the AI.
"""
from __future__ import annotations

import json
import re
import time
import unicodedata
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

from .core import sessions as sess

#: The CSL fields a citation or reference list uses; the rest of Crossref's record (abstract,
#: its own reference list, licences, funders) is dropped.
CSL_KEEP = ("type", "title", "author", "editor", "issued", "container-title", "volume", "issue", "page",
            "publisher", "publisher-place", "DOI", "URL", "ISBN", "edition", "genre", "accessed", "number",
            "collection-title", "event-title", "language", "medium")
CSL_TYPES = {"article-journal", "book", "chapter", "paper-conference", "report", "thesis", "webpage",
             "article-newspaper", "article-magazine", "dataset", "post", "article", "manuscript", "legislation",
             "motion_picture", "broadcast", "entry-encyclopedia", "entry-dictionary", "standard", "software"}
DOI_RE = re.compile(r"\b(10\.\d{4,9}/[^\s\"]+)", re.I)   # old Wiley DOIs carry < and >
SOURCES_MAX = 500


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ensure_schema() -> None:
    with sess._connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS writing_refs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id   INTEGER NOT NULL REFERENCES writing_projects(id) ON DELETE CASCADE,
                cite_key     TEXT NOT NULL,                -- what the draft cites: [@cite_key]
                csl_json     TEXT NOT NULL,                -- one CSL-JSON item, CSL_KEEP fields only
                doi          TEXT NOT NULL DEFAULT '',     -- lower case, for "already added"
                document_id  INTEGER,                      -- the Library document it came from, if any
                note         TEXT NOT NULL DEFAULT '',     -- the writer's note on the source
                created_at   TEXT NOT NULL,
                UNIQUE (project_id, cite_key)
            );
            CREATE INDEX IF NOT EXISTS idx_writing_refs ON writing_refs(project_id);
            """
        )


_ensure_schema()


def _ensure_columns() -> None:
    """Columns added after the first version of the table (docs/write-citation-backbone.md)."""
    with sess._connect() as conn:
        have = {r["name"] for r in conn.execute("PRAGMA table_info(writing_refs)")}
        if "abstract" not in have:    # the paper's abstract, as Find papers found it, for its citation card
            conn.execute("ALTER TABLE writing_refs ADD COLUMN abstract TEXT NOT NULL DEFAULT ''")
        if "meta_json" not in have:   # what a search or check knows about it: citations, open access, preprint, retraction
            conn.execute("ALTER TABLE writing_refs ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}'")


_ensure_columns()
ABSTRACT_MAX = 10_000


def normalise_doi(text: str) -> Optional[str]:
    """A DOI from what was pasted: "10.1038/x", "doi:10.1038/x", "https://doi.org/10.1038/x"."""
    m = DOI_RE.search((text or "").strip())
    if not m:
        return None
    return m.group(1).rstrip(".,;)]").lower()


def clean_item(item: dict) -> dict:
    """Only the fields a citation needs, in the shapes citeproc-js expects."""
    if not isinstance(item, dict):
        raise HTTPException(400, "A source must be an object.")
    out = {k: item[k] for k in CSL_KEEP if k in item and item[k] not in (None, "", [])}
    for key in ("title", "container-title", "collection-title"):
        v = out.get(key)
        if isinstance(v, list):                     # Crossref sends ["Title"]
            out[key] = str(v[0]) if v else ""
        elif v is not None:
            out[key] = str(v)
        if key in out:
            out[key] = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", out[key])).strip()[:500]
    for key in ("author", "editor"):
        if key in out:
            names = []
            for n in out[key] if isinstance(out[key], list) else []:
                if isinstance(n, dict):
                    clean = {k: str(n[k])[:120] for k in ("family", "given", "literal", "suffix", "non-dropping-particle") if n.get(k)}
                    if clean:
                        names.append(clean)
            out[key] = names[:100]
    if "issued" in out and not (isinstance(out["issued"], dict) and isinstance(out["issued"].get("date-parts"), list)):
        out.pop("issued")
    if out.get("type") not in CSL_TYPES:
        out["type"] = "article-journal" if out.get("container-title") else "book" if out.get("publisher") else "webpage" if out.get("URL") else "article"
    if not out.get("title"):
        raise HTTPException(400, "A source needs a title.")
    return out


def parse_names(text: str) -> list[dict]:
    """ "Smith, Jane; van Dijk, P.; World Health Organization" as CSL names. A name without a comma is
    an organisation, kept whole."""
    names = []
    for part in re.split(r";|\n|\s+and\s+|&", text or ""):
        part = part.strip()
        if not part:
            continue
        if "," in part:
            family, given = (x.strip() for x in part.split(",", 1))
            names.append({"family": family, "given": given} if given else {"family": family})
        else:
            names.append({"literal": part})
    return names


def display_names(text: str) -> list[dict]:
    """Names as a page shows them, "Jane Smith, Bob van Lee and A. Kim", as CSL names: the last
    word is the family name. One word alone (an organisation, a username) is kept whole."""
    names = []
    for part in re.split(r",|;|\n|\s+and\s+|&", text or ""):
        words = part.split()
        if not words:
            continue
        names.append({"family": words[-1], "given": " ".join(words[:-1])} if len(words) > 1 else {"literal": words[0]})
    return names[:100]


def _ascii(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def cite_key(item: dict, taken: set[str]) -> str:
    """lecun2015, then lecun2015a, lecun2015b… never one already used in the project."""
    names = item.get("author") or item.get("editor") or []
    first = names[0] if names else {}
    who = first.get("family") or first.get("literal") or (item.get("title") or "source").split()[0]
    who = re.sub(r"[^a-z0-9]", "", _ascii(who.split()[-1] if first.get("family") else who.split()[0])) or "source"
    parts = (item.get("issued") or {}).get("date-parts") or [[]]
    year = str(parts[0][0]) if parts and parts[0] else "nd"
    base = f"{who[:20]}{year}"
    key, n = base, 0
    while key in taken:
        key = f"{base}{chr(ord('a') + n)}" if n < 26 else f"{base}-{n}"
        n += 1
    return key


def _project_exists(conn, project_id: int) -> None:
    if not conn.execute("SELECT 1 FROM writing_projects WHERE id = ?", (project_id,)).fetchone():
        raise HTTPException(404, "Writing project not found.")


def _meta(text: str) -> dict:
    try:
        meta = json.loads(text or "{}")
    except ValueError:
        return {}
    return meta if isinstance(meta, dict) else {}


def _row(r) -> dict:
    return {"id": r["id"], "key": r["cite_key"], "item": json.loads(r["csl_json"]), "doi": r["doi"],
            "document_id": r["document_id"], "note": r["note"], "created_at": r["created_at"],
            "abstract": r["abstract"], "meta": _meta(r["meta_json"])}


def title_key(title: str, year) -> str:
    """The same title however it is cased, spaced or punctuated, in any script, with its year."""
    letters = re.sub(r"[\W_]+", "", unicodedata.normalize("NFKC", title or "").casefold())
    return f"{letters}|{year or ''}" if letters else ""


def _year(item: dict):
    parts = (item.get("issued") or {}).get("date-parts") or [[]]
    return parts[0][0] if parts and parts[0] else None


def list_refs(project_id: int) -> list[dict]:
    with sess._connect() as conn:
        _project_exists(conn, project_id)
        rows = conn.execute("SELECT * FROM writing_refs WHERE project_id = ? ORDER BY id", (project_id,)).fetchall()
    return [_row(r) for r in rows]


def add(project_id: int, item: dict, document_id: Optional[int] = None, *, abstract: str = "",
        meta: Optional[dict] = None, same_title: bool = False) -> dict:
    """A source, unless the project already has it (the same DOI, or the same Library document, or
    with `same_title`, a source without a DOI with the same title and year): then the one already
    there, so the writer never ends up citing two copies. A paper found by search keeps its abstract
    and what the search knew about it (`meta`), for its citation card."""
    item = clean_item(item)
    abstract = re.sub(r"\s+", " ", str(abstract or "")).strip()[:ABSTRACT_MAX]
    meta_json = json.dumps(meta or {}, ensure_ascii=False)[:20_000]
    doi = normalise_doi(item.get("DOI", "")) or ""
    if doi:
        item["DOI"] = doi
    with sess._connect() as conn:
        _project_exists(conn, project_id)
        if conn.execute("SELECT COUNT(*) FROM writing_refs WHERE project_id = ?", (project_id,)).fetchone()[0] >= SOURCES_MAX:
            raise HTTPException(400, f"A project can hold up to {SOURCES_MAX} sources.")
        same = None
        if doi:
            same = conn.execute("SELECT * FROM writing_refs WHERE project_id = ? AND doi = ?", (project_id, doi)).fetchone()
        if same is None and document_id is not None:
            same = conn.execute("SELECT * FROM writing_refs WHERE project_id = ? AND document_id = ?", (project_id, document_id)).fetchone()
        if same is None and same_title:
            mine = title_key(item.get("title", ""), _year(item))
            for r in conn.execute("SELECT * FROM writing_refs WHERE project_id = ? AND (doi = '' OR ? = '')", (project_id, doi)):
                theirs = json.loads(r["csl_json"])
                if mine and title_key(theirs.get("title", ""), _year(theirs)) == mine:
                    same = r
                    break
        if same is not None:
            if abstract and not same["abstract"]:   # found again, with the abstract the first add lacked
                conn.execute("UPDATE writing_refs SET abstract = ?, meta_json = ? WHERE id = ?", (abstract, meta_json, same["id"]))
                same = conn.execute("SELECT * FROM writing_refs WHERE id = ?", (same["id"],)).fetchone()
            return {**_row(same), "existing": True}
        taken = {r["cite_key"] for r in conn.execute("SELECT cite_key FROM writing_refs WHERE project_id = ?", (project_id,))}
        key = cite_key(item, taken)
        cur = conn.execute(
            "INSERT INTO writing_refs (project_id, cite_key, csl_json, doi, document_id, created_at, abstract, meta_json)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (project_id, key, json.dumps(item, ensure_ascii=False), doi, document_id, _now(), abstract, meta_json))
        row = conn.execute("SELECT * FROM writing_refs WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {**_row(row), "existing": False}


def lookup_doi(text: str) -> dict:
    """The citation data for a DOI, from doi.org (Crossref, DataCite or mEDRA answer for their own DOIs)."""
    from . import link_import
    doi = normalise_doi(text)
    if not doi:
        raise HTTPException(400, "That doesn't look like a DOI. A DOI starts with 10., like 10.1038/nature14539.")
    try:
        from urllib.parse import quote
        raw, _, _ = link_import.fetch_public(f"https://doi.org/{quote(doi, safe='/')}", deadline=time.monotonic() + 15,
                                             accept="application/vnd.citationstyles.csl+json")
        item = json.loads(raw)
    except (OSError, ValueError, link_import.HTTPException, link_import.http.client.HTTPException):
        raise HTTPException(404, f"No record was found for the DOI {doi}. Check it, or add the source by hand.")
    if not isinstance(item, dict):
        raise HTTPException(404, f"No record was found for the DOI {doi}.")
    item["DOI"] = doi
    return clean_item(item)


def from_document(document_id: int) -> dict:
    """A Library document as a source: its title, author and link, as saved."""
    from . import document_store
    doc = document_store.get_document(document_id)
    if doc is None:
        raise HTTPException(404, "That document isn't in your Library any more.")
    meta = doc.get("source") or {}
    if isinstance(meta, str):
        meta = json.loads(meta or "{}")
    item: dict = {"title": doc.get("name") or doc.get("original_filename") or "Untitled document"}
    if meta.get("author"):
        item["author"] = display_names(meta["author"])
    if meta.get("url"):
        item["URL"] = meta["url"]
        doi = normalise_doi(meta["url"])
        if doi:
            item["DOI"] = doi
        item["type"] = "webpage"
    captured = (meta.get("captured_at") or "")[:10]
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", captured):
        y, m, d = (int(x) for x in captured.split("-"))
        item["accessed"] = {"date-parts": [[y, m, d]]}
    return clean_item(item)


def update(ref_id: int, item: Optional[dict] = None, note: Optional[str] = None) -> dict:
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM writing_refs WHERE id = ?", (ref_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Source not found.")
        if item is not None:
            clean = clean_item(item)
            conn.execute("UPDATE writing_refs SET csl_json = ?, doi = ? WHERE id = ?",
                         (json.dumps(clean, ensure_ascii=False), normalise_doi(clean.get("DOI", "")) or "", ref_id))
        if note is not None:
            conn.execute("UPDATE writing_refs SET note = ? WHERE id = ?", (str(note)[:4000], ref_id))
        row = conn.execute("SELECT * FROM writing_refs WHERE id = ?", (ref_id,)).fetchone()
    return _row(row)


def delete(ref_id: int) -> None:
    with sess._connect() as conn:
        conn.execute("DELETE FROM writing_refs WHERE id = ?", (ref_id,))


def export_for(project_id: int) -> list[dict]:
    with sess._connect() as conn:
        rows = conn.execute("SELECT * FROM writing_refs WHERE project_id = ? ORDER BY id", (project_id,)).fetchall()
    return [{"cite_key": r["cite_key"], "csl_json": r["csl_json"], "doi": r["doi"], "note": r["note"], "created_at": r["created_at"],
             "abstract": r["abstract"], "meta": r["meta_json"]} for r in rows]


def import_for(conn, project_id: int, refs: list) -> None:
    for r in refs if isinstance(refs, list) else []:
        if not isinstance(r, dict) or not r.get("cite_key"):
            continue
        try:
            item = clean_item(json.loads(r.get("csl_json") or "{}"))
        except (ValueError, HTTPException):
            continue
        meta = r.get("meta") if isinstance(r.get("meta"), str) else "{}"
        conn.execute("INSERT OR IGNORE INTO writing_refs (project_id, cite_key, csl_json, doi, note, created_at, abstract, meta_json)"
                     " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                     (project_id, str(r["cite_key"])[:60], json.dumps(item, ensure_ascii=False), str(r.get("doi") or "")[:200],
                      str(r.get("note") or "")[:4000], r.get("created_at") or _now(),
                      str(r.get("abstract") or "")[:ABSTRACT_MAX], json.dumps(_meta(meta), ensure_ascii=False)))
