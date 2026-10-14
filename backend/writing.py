"""
Write: an academic writing framework (docs/academic-writing.md).

A writing project is one piece of work (an essay, a literature review, a research paper or
proposal, a reflection, a report). It starts from its genre's structure in
``writing_content/framework.json`` and is worked through the ten stages there, from analysing the
task to proofreading. Nothing here calls the AI: the stages, the structure, the word budgets and the
ticks are all local. The AI only ever coaches (docs/academic-writing.md, "The AI coaches, it never
writes"), and that lives elsewhere.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Optional

from fastapi import HTTPException

from .core import sessions as sess

CONTENT = Path(__file__).resolve().parent / "writing_content" / "framework.json"
TITLE_MAX = 200
BODY_MAX = 200_000          # one section; a whole thesis chapter fits
TEXT_MAX = 20_000           # the brief, the focus, the thesis, a section's notes
WORD_LIMIT_MAX = 200_000


@lru_cache(maxsize=1)
def framework() -> dict:
    return json.loads(CONTENT.read_text(encoding="utf-8"))


def genre(key: str) -> dict:
    for g in framework()["genres"]:
        if g["key"] == key:
            return g
    raise HTTPException(400, f"Unknown kind of writing: {key!r}.")


def _styles() -> set[str]:
    return {s["key"] for s in framework()["citation_styles"]}


def _stage_items() -> dict[str, int]:
    """How many checklist items each stage has, by key."""
    return {s["key"]: len(s["checklist"]) for s in framework()["stages"]}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ensure_schema() -> None:
    with sess._connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS writing_projects (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                title       TEXT NOT NULL,
                genre       TEXT NOT NULL,                 -- framework.json genres[].key
                word_limit  INTEGER NOT NULL DEFAULT 0,    -- 0: none set yet
                style       TEXT NOT NULL DEFAULT 'apa',   -- citation style key
                brief       TEXT NOT NULL DEFAULT '',      -- the task as set
                focus       TEXT NOT NULL DEFAULT '',      -- research question, or theme
                thesis      TEXT NOT NULL DEFAULT '',
                ticks_json  TEXT NOT NULL DEFAULT '{}',    -- {stage key: [ticked item indexes]}
                stage       TEXT NOT NULL DEFAULT 'task',  -- the stage open last
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS writing_sections (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id  INTEGER NOT NULL REFERENCES writing_projects(id) ON DELETE CASCADE,
                idx         INTEGER NOT NULL,
                key         TEXT NOT NULL DEFAULT '',      -- the template section it came from, '' if added
                title       TEXT NOT NULL,
                body        TEXT NOT NULL DEFAULT '',
                notes       TEXT NOT NULL DEFAULT '',
                share       REAL NOT NULL DEFAULT 0,       -- its part of the word limit
                target      INTEGER,                       -- set by hand; NULL follows share x limit
                updated_at  TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_writing_sections ON writing_sections(project_id, idx);
            """
        )


_ensure_schema()


def _ensure_columns() -> None:
    """Columns added after the first version of the table."""
    with sess._connect() as conn:
        have = {r["name"] for r in conn.execute("PRAGMA table_info(writing_projects)")}
        if "key_terms_json" not in have:   # the brief's key terms, as the writer confirmed them
            conn.execute("ALTER TABLE writing_projects ADD COLUMN key_terms_json TEXT NOT NULL DEFAULT '[]'")


_ensure_columns()
KEY_TERMS_MAX = 30


def words(text: str) -> int:
    """Words as a marker counts them: a citation marker, [@kim2020, p. 12], is not words of the text."""
    return len(re.findall(r"[\w'’-]+", re.sub(r"\[@[^\]\n]*\]", " ", text or "")))


def _target(row, limit: int) -> int:
    if row["target"] is not None:
        return int(row["target"])
    return round((row["share"] or 0) * limit) if limit else 0


def _section(row, limit: int) -> dict:
    return {
        "id": row["id"], "key": row["key"], "title": row["title"], "body": row["body"], "notes": row["notes"],
        "share": row["share"], "target": _target(row, limit), "target_set": row["target"] is not None,
        "words": words(row["body"]), "updated_at": row["updated_at"],
    }


def _project(row, sections: Optional[list] = None) -> dict:
    try:
        ticks = json.loads(row["ticks_json"] or "{}")
    except ValueError:
        ticks = {}
    out = {k: row[k] for k in ("id", "title", "genre", "word_limit", "style", "brief", "focus", "thesis", "stage", "created_at", "updated_at")}
    out["ticks"] = ticks
    try:
        out["key_terms"] = json.loads(row["key_terms_json"] or "[]")
    except ValueError:
        out["key_terms"] = []
    if sections is not None:
        out["sections"] = sections
        out["words"] = sum(s["words"] for s in sections)
    return out


def list_projects() -> list[dict]:
    with sess._connect() as conn:
        rows = conn.execute("SELECT * FROM writing_projects ORDER BY updated_at DESC").fetchall()
        counts = {r["project_id"]: r["body"] for r in conn.execute(
            "SELECT project_id, group_concat(body, ' ') AS body FROM writing_sections GROUP BY project_id").fetchall()}
    return [{**_project(r), "words": words(counts.get(r["id"], ""))} for r in rows]


def get_project(project_id: int) -> dict:
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM writing_projects WHERE id = ?", (project_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Writing project not found.")
        secs = conn.execute("SELECT * FROM writing_sections WHERE project_id = ? ORDER BY idx, id", (project_id,)).fetchall()
    return _project(row, [_section(s, row["word_limit"]) for s in secs])


def _clean_limit(value) -> int:
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        raise HTTPException(400, "The word limit must be a number.")
    if n < 0 or n > WORD_LIMIT_MAX:
        raise HTTPException(400, f"The word limit must be between 0 and {WORD_LIMIT_MAX:,}.")
    return n


def _clean_title(value: str, fallback: str) -> str:
    title = re.sub(r"\s+", " ", value or "").strip()[:TITLE_MAX]
    return title or fallback


def create_project(title: str, genre_key: str, word_limit: int = 0, style: str = "apa") -> dict:
    g = genre(genre_key)
    if style not in _styles():
        raise HTTPException(400, f"Unknown citation style: {style!r}.")
    limit = _clean_limit(word_limit)
    now = _now()
    with sess._connect() as conn:
        cur = conn.execute(
            "INSERT INTO writing_projects (title, genre, word_limit, style, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (_clean_title(title, f"Untitled {g['title'].lower()}"), g["key"], limit, style, now, now))
        pid = cur.lastrowid
        conn.executemany(
            "INSERT INTO writing_sections (project_id, idx, key, title, share, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            [(pid, i, s["key"], s["title"], float(s["share"]), now) for i, s in enumerate(g["sections"])])
    return get_project(pid)


def _clean_ticks(value) -> dict:
    """Only known stages, and only item indexes that stage has."""
    if not isinstance(value, dict):
        raise HTTPException(400, "Ticks must be an object of stage: [items].")
    items = _stage_items()
    out = {}
    for stage, ticked in value.items():
        if stage in items and isinstance(ticked, list):
            out[stage] = sorted({int(i) for i in ticked if isinstance(i, int) and 0 <= i < items[stage]})
    return out


def update_project(project_id: int, fields: dict) -> dict:
    sets, args = [], []
    for key in ("title", "brief", "focus", "thesis", "word_limit", "style", "ticks", "stage", "genre", "key_terms"):
        if key not in fields or fields[key] is None:
            continue
        value = fields[key]
        if key == "title":
            value = _clean_title(value, "Untitled")
        elif key in ("brief", "focus", "thesis"):
            value = str(value)[:TEXT_MAX]
        elif key == "word_limit":
            value = _clean_limit(value)
        elif key == "style":
            if value not in _styles():
                raise HTTPException(400, f"Unknown citation style: {value!r}.")
        elif key == "stage":
            if value not in _stage_items():
                raise HTTPException(400, f"Unknown stage: {value!r}.")
        elif key == "genre":
            genre(value)   # known; the sections stay as written, the new genre's guidance applies
        elif key == "ticks":
            key, value = "ticks_json", json.dumps(_clean_ticks(value))
        elif key == "key_terms":
            if not isinstance(value, list):
                raise HTTPException(400, "Key terms must be a list.")
            terms = list(dict.fromkeys(re.sub(r"\s+", " ", str(t)).strip()[:60] for t in value if str(t).strip()))
            key, value = "key_terms_json", json.dumps(terms[:KEY_TERMS_MAX])
        sets.append(f"{key} = ?")
        args.append(value)
    if sets:
        with sess._connect() as conn:
            cur = conn.execute(f"UPDATE writing_projects SET {', '.join(sets)}, updated_at = ? WHERE id = ?",
                               (*args, _now(), project_id))
            if cur.rowcount == 0:
                raise HTTPException(404, "Writing project not found.")
    return get_project(project_id)


def delete_project(project_id: int) -> None:
    from . import writing_refs, writing_review  # noqa: F401  (their tables exist)
    with sess._connect() as conn:
        conn.execute("DELETE FROM writing_sections WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM writing_refs WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM writing_reviews WHERE project_id = ?", (project_id,))
        conn.execute("DELETE FROM writing_projects WHERE id = ?", (project_id,))


def _project_of(conn, section_id: int) -> int:
    row = conn.execute("SELECT project_id FROM writing_sections WHERE id = ?", (section_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Section not found.")
    return row["project_id"]


def _touch(conn, project_id: int) -> None:
    conn.execute("UPDATE writing_projects SET updated_at = ? WHERE id = ?", (_now(), project_id))


def add_section(project_id: int, title: str, after_id: Optional[int] = None) -> dict:
    get_project(project_id)   # 404 for an unknown project
    now = _now()
    with sess._connect() as conn:
        ids = [r["id"] for r in conn.execute("SELECT id FROM writing_sections WHERE project_id = ? ORDER BY idx, id", (project_id,))]
        at = ids.index(after_id) + 1 if after_id in ids else len(ids)
        cur = conn.execute(
            "INSERT INTO writing_sections (project_id, idx, title, target, updated_at) VALUES (?, ?, ?, NULL, ?)",
            (project_id, at, _clean_title(title, "New section"), now))
        ids.insert(at, cur.lastrowid)
        conn.executemany("UPDATE writing_sections SET idx = ? WHERE id = ?", [(i, sid) for i, sid in enumerate(ids)])
        _touch(conn, project_id)
    return get_project(project_id)


def update_section(section_id: int, fields: dict) -> dict:
    sets, args = [], []
    if fields.get("title") is not None:
        sets.append("title = ?"); args.append(_clean_title(fields["title"], "Untitled section"))
    if fields.get("body") is not None:
        if len(fields["body"]) > BODY_MAX:
            raise HTTPException(400, "This section is too long to keep in one piece. Split it into two sections.")
        sets.append("body = ?"); args.append(fields["body"])
    if fields.get("notes") is not None:
        sets.append("notes = ?"); args.append(str(fields["notes"])[:TEXT_MAX])
    if "target" in fields:
        target = fields["target"]
        if target is not None:
            target = _clean_limit(target)
        sets.append("target = ?"); args.append(target)   # None: back to its share of the limit
    with sess._connect() as conn:
        pid = _project_of(conn, section_id)
        if sets:
            conn.execute(f"UPDATE writing_sections SET {', '.join(sets)}, updated_at = ? WHERE id = ?", (*args, _now(), section_id))
            _touch(conn, pid)
    return get_project(pid)


def delete_section(section_id: int) -> dict:
    with sess._connect() as conn:
        pid = _project_of(conn, section_id)
        conn.execute("DELETE FROM writing_sections WHERE id = ?", (section_id,))
        conn.execute("DELETE FROM writing_reviews WHERE section_id = ?", (section_id,))
        ids = [r["id"] for r in conn.execute("SELECT id FROM writing_sections WHERE project_id = ? ORDER BY idx, id", (pid,))]
        conn.executemany("UPDATE writing_sections SET idx = ? WHERE id = ?", [(i, sid) for i, sid in enumerate(ids)])
        _touch(conn, pid)
    return get_project(pid)


def reorder_sections(project_id: int, ids: list[int]) -> dict:
    """The project's sections in this order; it must name each of them exactly once."""
    with sess._connect() as conn:
        have = {r["id"] for r in conn.execute("SELECT id FROM writing_sections WHERE project_id = ?", (project_id,))}
        if not have and not conn.execute("SELECT 1 FROM writing_projects WHERE id = ?", (project_id,)).fetchone():
            raise HTTPException(404, "Writing project not found.")
        if sorted(ids) != sorted(have):
            raise HTTPException(400, "The new order must list every section of this project once.")
        conn.executemany("UPDATE writing_sections SET idx = ? WHERE id = ?", [(i, sid) for i, sid in enumerate(ids)])
        _touch(conn, project_id)
    return get_project(project_id)


# ── Data transfer (backend/transfer.py) ──────────────────────────────────────────

_PROJECT_FIELDS = ("title", "genre", "word_limit", "style", "brief", "focus", "thesis", "ticks_json", "key_terms_json", "stage", "created_at", "updated_at")
_SECTION_FIELDS = ("idx", "key", "title", "body", "notes", "share", "target", "updated_at")


def export_all() -> list[dict]:
    """Every project with its sections nested, so they stay together on another machine."""
    with sess._connect() as conn:
        projects = conn.execute("SELECT * FROM writing_projects ORDER BY id").fetchall()
        out = []
        for p in projects:
            secs = conn.execute("SELECT * FROM writing_sections WHERE project_id = ? ORDER BY idx, id", (p["id"],)).fetchall()
            out.append({**{k: p[k] for k in _PROJECT_FIELDS}, "sections": [{k: s[k] for k in _SECTION_FIELDS} for s in secs]})
    from . import writing_refs
    for item, p in zip(out, projects):
        item["refs"] = writing_refs.export_for(p["id"])
    return out


def import_all(projects: list, duplicates: str = "skip") -> dict:
    """Projects from an export. A project with the same title and creation time is a duplicate."""
    added = skipped = 0
    with sess._connect() as conn:
        for p in projects if isinstance(projects, list) else []:
            known = {g["key"] for g in framework()["genres"]}
            if not isinstance(p, dict) or not p.get("title") or p.get("genre") not in known:
                continue   # a kind of writing this version doesn't know would break the screen
            same = conn.execute("SELECT id FROM writing_projects WHERE title = ? AND created_at = ?",
                                (p["title"], p.get("created_at") or "")).fetchone()
            if same and duplicates == "skip":
                skipped += 1
                continue
            row = {k: p.get(k) for k in _PROJECT_FIELDS if isinstance(p.get(k), (str, int, float))}
            try:   # a hand-edited bundle: keep only what this version can read
                row["ticks_json"] = json.dumps(_clean_ticks(json.loads(row.get("ticks_json") or "{}")))
            except (ValueError, TypeError, HTTPException):
                row["ticks_json"] = "{}"
            try:
                terms = json.loads(row.get("key_terms_json") or "[]")
                row["key_terms_json"] = json.dumps([str(t)[:60] for t in terms if isinstance(t, str)][:KEY_TERMS_MAX] if isinstance(terms, list) else [])
            except (ValueError, TypeError):
                row["key_terms_json"] = "[]"
            row.setdefault("created_at", _now()); row.setdefault("updated_at", row["created_at"])
            cur = conn.execute(f"INSERT INTO writing_projects ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))
            for i, s in enumerate(p.get("sections") or []):
                if isinstance(s, dict) and isinstance(s.get("title"), str):
                    srow = {k: s.get(k) for k in _SECTION_FIELDS if isinstance(s.get(k), (str, int, float))}
                    srow.setdefault("idx", i)
                    srow.setdefault("body", "")
                    srow.setdefault("notes", "")
                    srow.setdefault("updated_at", row["updated_at"])
                    conn.execute(f"INSERT INTO writing_sections (project_id, {', '.join(srow)}) VALUES (?, {', '.join('?' * len(srow))})",
                                 (cur.lastrowid, *srow.values()))
            from . import writing_refs
            writing_refs.import_for(conn, cur.lastrowid, p.get("refs") or [])
            added += 1
    return {"added": added, "skipped": skipped}
