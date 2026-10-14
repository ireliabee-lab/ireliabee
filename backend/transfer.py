"""
Portable data transfer — export your prep work as one JSON bundle and import it
into another person's copy of the app.

What travels: profiles, meeting plans, your stories, practice history, CVs and
documents (originals carried as base64), non-secret preferences, and the
Research Track (your place on the ladder, term cards with their review
schedule, paper cards, lessons, projects, sprints and skill evidence).

What never travels: API keys, session transcripts and their derived notes /
confidence reports, and any story flagged private. Those are private to the
machine they were recorded on.

Bundle shape (``format``/``version`` are the compatibility contract):

    {"format": "ireliabee.transfer", "version": 1,
     "exported_at": "2026-09-18T10:00:00", "app_version": "0.4.0",
     "counts": {"plans": 3, ...},
     "data": {"profiles": [{"ref": 1, "name": ...}], "plans": [{"profile_ref": 1, ...}], ...}}

``ref``/``profile_ref`` are bundle-local ids, not database ids: the importer
remaps them so nothing collides with the rows already in the target install.
"""
from __future__ import annotations

import base64
import json
from datetime import datetime
from typing import Any, Iterable, Optional

from .core import sessions as sess
from .core.config import load_config, save_config
from .errors import FriendlyError

FORMAT = "ireliabee.transfer"
VERSION = 1

SECTIONS = ("profiles", "plans", "stories", "drills", "cvs", "documents", "preferences", "research", "wordcraft", "writing")

# Section -> human label, used by the UI and in import reports.
SECTION_LABELS = {
    "profiles": "Profiles",
    "plans": "Meeting plans",
    "stories": "Your stories",
    "drills": "Practice history",
    "cvs": "CVs & resumes",
    "documents": "Documents",
    "preferences": "Preferences",
    "research": "Research Track",
    "wordcraft": "Wordcraft",
    "writing": "Writing projects",
}

#: The Research Track's tables, in the order they are written back. Each: bundle key,
#: table, and the columns that say "this is already here" on import.
RESEARCH_PARTS = (
    ("cards", "term_cards", ("term_key",)),
    ("papers", "paper_cards", ("title",)),
    ("lessons", "research_lessons", ("lesson_id",)),
    ("projects", "research_projects", ("kind", "title")),
    ("sprints", "research_sprints", ("created_at", "minutes")),
    ("evidence", "research_evidence", ("skill_id", "kind", "created_at")),
    ("days", "research_days", ("day",)),
)
#: Local links that mean nothing on another machine.
_RESEARCH_DROP = {"id", "document_id", "notebook_id", "project_id"}

#: Wordcraft's tables, the same way.
WORDCRAFT_PARTS = (
    ("cards", "wc_cards", ("card_id",)),
    ("lessons", "wc_lessons", ("lesson_id",)),
    ("attempts", "wc_attempts", ("lesson_id", "drill", "created_at")),
    ("writing", "wc_writing", ("created_at", "text")),
    ("days", "wc_days", ("day",)),
    ("missions", "wc_missions", ("week",)),
    ("cando", "wc_cando", ("realm", "item", "rated_at")),
    ("placements", "wc_placements", ("created_at",)),
)

#: Each learning track: its module, its one-row table, the field that says a track is real, and its parts.
TRACKS = {
    "research": ("research_track", "research_track", "field", RESEARCH_PARTS, _RESEARCH_DROP),
    "wordcraft": ("wordcraft", "wc_track", "started_at", WORDCRAFT_PARTS, {"id"}),
}

# Columns we never carry across installs (ids are remapped, activity is local).
# Local ids mean nothing on another machine: links to files and people are left behind.
_DROP = {"id", "is_active", "profile_id", "cv_id", "document_id", "people_json", "documents_json"}

# Anything whose preference key smells like a credential stays behind.
_SECRETISH = ("key", "token", "secret", "password")

MAX_BUNDLE_MB = 50
#: Files bigger than this stay behind (a 150 MB book as base64 would make a bundle
#: nobody can import). The bundle lists them under "left_out".
LARGE_FILE_MB = 20


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _has_table(conn, table: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone() is not None


def _rows(table: str, where: str = "", args: tuple = ()) -> list[dict]:
    """Rows of `table`, or [] when the feature that owns it never ran here."""
    with sess._connect() as conn:
        if not _has_table(conn, table):
            return []
        sql = f"SELECT * FROM {table} {where} ORDER BY id"
        return [dict(r) for r in conn.execute(sql, args)]


def _clean(row: dict, drop: Iterable[str] = _DROP) -> dict:
    return {k: v for k, v in row.items() if k not in drop}


# ── Export ───────────────────────────────────────────────────────────────────

def _export_profiles(profile_id: Optional[int]) -> list[dict]:
    where, args = ("WHERE id = ?", (profile_id,)) if profile_id is not None else ("", ())
    return [{"ref": r["id"], **_clean(r)} for r in _rows("profiles", where, args)]


def _export_plans(profile_id: Optional[int]) -> list[dict]:
    where, args = ("WHERE profile_id = ?", (profile_id,)) if profile_id is not None else ("", ())
    out = []
    for r in _rows("meeting_plans", where, args):
        plan = _clean(r)
        plan.pop("raw_research_json", None)      # research dumps are bulky and rebuildable
        plan["profile_ref"] = r["profile_id"]
        out.append(plan)
    return out


def _export_stories() -> list[dict]:
    """Private stories never leave this machine — see the `is_private` flag."""
    return [_clean(r) for r in _rows("stories") if not r.get("is_private")]


def _export_drills() -> list[dict]:
    return [_clean(r) for r in _rows("drills")]


def _export_files(table: str, left_out: Optional[list] = None) -> list[dict]:
    """Files with their originals, one at a time: never every file in memory at once."""
    out = []
    with sess._connect() as conn:
        if not _has_table(conn, table):
            return []
        sizes = conn.execute(f"SELECT id, name, length(content) AS n FROM {table} ORDER BY id").fetchall()
        for s in sizes:
            if (s["n"] or 0) > LARGE_FILE_MB * 1024 * 1024:
                if left_out is not None:
                    left_out.append({"section": table, "name": s["name"], "bytes": s["n"]})
                continue
            r = dict(conn.execute(f"SELECT * FROM {table} WHERE id = ?", (s["id"],)).fetchone())
            row = _clean(r)
            row["content_b64"] = base64.b64encode(r["content"] or b"").decode("ascii")
            row.pop("content", None)
            out.append(row)
    return out


def _export_research() -> dict:
    """The whole Research Track, or {} if it was never started here."""
    return _export_track("research")


def _export_track(name: str) -> dict:
    """A learning track (Research or Wordcraft) in full, or {} if it was never started here."""
    import importlib
    module, table, _, parts, drop = TRACKS[name]
    importlib.import_module(f".{module}", __package__)   # makes sure its tables exist
    track = _rows(table)
    if not track:
        return {}
    out: dict[str, Any] = {"track": _clean(track[0], {"id"})}
    for key, part_table, _ in parts:
        rows = [dict(r) for r in _raw_rows(part_table)]
        out[key] = [_clean(r, drop) for r in rows]
    return out


def _raw_rows(table: str) -> list[dict]:
    """Rows of a table without an ``id`` column to order by."""
    with sess._connect() as conn:
        if not _has_table(conn, table):
            return []
        return [dict(r) for r in conn.execute(f"SELECT * FROM {table}")]


def _export_preferences() -> dict:
    cfg = load_config()
    return {k: v for k, v in cfg.items()
            if not any(s in k.lower() for s in _SECRETISH)}


def build_bundle(sections: Iterable[str], profile_id: Optional[int] = None,
                 app_version: str = "") -> dict:
    """Collect the requested sections into a bundle dict."""
    wanted = [s for s in sections if s in SECTIONS]
    if not wanted:
        raise FriendlyError("invalid", "Nothing selected",
                            "Pick at least one kind of data to export.")

    data: dict[str, Any] = {}
    left_out: list[dict] = []
    if "profiles" in wanted:
        data["profiles"] = _export_profiles(profile_id)
    if "plans" in wanted:
        data["plans"] = _export_plans(profile_id)
    if "stories" in wanted:
        data["stories"] = _export_stories()
    if "drills" in wanted:
        data["drills"] = _export_drills()
    if "cvs" in wanted:
        data["cvs"] = _export_files("cvs", left_out)
    if "documents" in wanted:
        data["documents"] = _export_files("documents", left_out)
    if "preferences" in wanted:
        data["preferences"] = _export_preferences()
    for name in ("research", "wordcraft"):
        if name in wanted:
            exported = _export_track(name)
            if exported:
                data[name] = exported
    if "writing" in wanted:
        from . import writing
        data["writing"] = writing.export_all()   # each project with its sections nested

    return {
        "format": FORMAT,
        "version": VERSION,
        "exported_at": _now(),
        "app_version": app_version,
        "counts": counts_of(data),
        "data": data,
        **({"left_out": left_out} if left_out else {}),
    }


def counts_of(data: dict) -> dict[str, int]:
    out = {}
    for key, value in data.items():
        if key in TRACKS and isinstance(value, dict):
            out[key] = _track_count(key, value)
        else:
            out[key] = len(value) if isinstance(value, (list, dict)) else 0
    return out


def _research_count(research: dict) -> int:
    """The track itself, plus every card, paper, lesson, project, sprint and piece of evidence."""
    return _track_count("research", research)


def _track_count(name: str, data: dict) -> int:
    return (1 if data.get("track") else 0) + sum(len(data.get(key) or []) for key, _, _ in TRACKS[name][3])


def summary() -> dict:
    """How much of each section this install currently holds."""
    def n(table: str, where: str = "") -> int:
        with sess._connect() as conn:
            if not _has_table(conn, table):
                return 0
            return conn.execute(f"SELECT COUNT(*) FROM {table} {where}").fetchone()[0]

    stories = n("stories", "WHERE IFNULL(is_private, 0) = 0")
    return {
        "profiles": n("profiles"),
        "plans": n("meeting_plans"),
        "stories": stories,
        # Shown next to the Stories row so it is obvious why the count is short.
        "stories_private": n("stories") - stories,
        "drills": n("drills"),
        "cvs": n("cvs"),
        "documents": n("documents"),
        "preferences": len(_export_preferences()),
        "research": _research_count(_export_research()),
        "wordcraft": _track_count("wordcraft", _export_track("wordcraft")),
        "writing": n("writing_projects"),
    }


# ── Import ───────────────────────────────────────────────────────────────────

def parse_bundle(raw: bytes) -> dict:
    """Validate raw bytes as a transfer bundle, or raise a friendly error."""
    if len(raw) > MAX_BUNDLE_MB * 1024 * 1024:
        raise FriendlyError("invalid", "File too large",
                            f"Transfer files can be up to {MAX_BUNDLE_MB} MB.")
    try:
        bundle = json.loads(raw.decode("utf-8"))
    except Exception:
        raise FriendlyError("invalid", "Not a transfer file",
                            "That file isn't readable JSON. Pick the .json file the app exported.")
    if not isinstance(bundle, dict) or bundle.get("format") != FORMAT:
        raise FriendlyError("invalid", "Not an iReliabee transfer file",
                            "Pick a .json file exported from iReliabee's Transfer screen.")
    if int(bundle.get("version", 0)) > VERSION:
        raise FriendlyError("invalid", "Made by a newer version",
                            "This file came from a newer iReliabee. Update the app, then import again.")
    if not isinstance(bundle.get("data"), dict):
        raise FriendlyError("invalid", "Transfer file is empty",
                            "There's no data in that file.")
    return bundle


def inspect(raw: bytes) -> dict:
    """Preview a bundle: what's inside, without writing anything."""
    bundle = parse_bundle(raw)
    data = bundle["data"]
    preview: dict[str, list[str]] = {}
    for key, label_field in (("profiles", "name"), ("plans", "title"), ("stories", "title"),
                             ("cvs", "name"), ("documents", "name"), ("writing", "title")):
        items = data.get(key) or []
        if isinstance(items, list):
            preview[key] = [str(i.get(label_field, "")).strip() or "(untitled)" for i in items[:5]]
    return {
        "exported_at": bundle.get("exported_at", ""),
        "app_version": bundle.get("app_version", ""),
        "counts": counts_of(data),
        "preview": preview,
        "sections": [s for s in SECTIONS if s in data],
    }


def _existing(conn, table: str, where: str, args: tuple) -> Optional[int]:
    row = conn.execute(f"SELECT id FROM {table} WHERE {where} LIMIT 1", args).fetchone()
    return row["id"] if row else None


def _insert(conn, table: str, row: dict) -> int:
    cols = list(row.keys())
    cur = conn.execute(
        f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join(['?'] * len(cols))})",
        [row[c] for c in cols],
    )
    return cur.lastrowid


def _table_columns(conn, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def _stamped(row: dict, columns: set[str]) -> dict:
    """
    Drop unknown columns (bundle from another version) and stamp timestamps.
    Database ids are never taken from a file: a hand-edited or older bundle
    carrying one would collide with rows already here and abort the import.
    """
    out = {k: v for k, v in row.items() if k in columns and k not in ("id", "ref", "profile_ref", "cv_id")}
    now = _now()
    if "created_at" in columns:
        out.setdefault("created_at", now)
    if "updated_at" in columns:
        out["updated_at"] = out.get("updated_at") or now
    return out


def _import_research(research: dict) -> dict:
    """
    Merge a Research Track into this install. What is already here wins: the
    track keeps its place if one exists, and a card, paper, lesson, project,
    sprint or piece of evidence that is already here is left alone.
    """
    return _import_track("research", research)


def _import_track(name: str, research: dict) -> dict:
    """Merge a learning track into this install; what is already here wins."""
    import importlib
    module, track_table, marker, parts, drop = TRACKS[name]
    importlib.import_module(f".{module}", __package__)   # makes sure its tables exist
    result = {"imported": 0, "skipped": 0}
    with sess._connect() as conn:
        track = research.get("track")
        if isinstance(track, dict) and track.get(marker):
            if conn.execute(f"SELECT 1 FROM {track_table} WHERE id = 1").fetchone():
                result["skipped"] += 1
            else:
                cols = _table_columns(conn, track_table)
                row = {k: v for k, v in track.items() if k in cols and k != "id"}
                row["id"] = 1
                now = _now()
                for key in ("started_at", "level_at", "realm_at", "updated_at"):
                    if key in cols:
                        row.setdefault(key, now)
                _insert(conn, track_table, row)
                result["imported"] += 1
        for key, table, match in parts:
            cols = _table_columns(conn, table)
            for item in research.get(key) or []:
                if not isinstance(item, dict) or any(item.get(m) in (None, "") for m in match):
                    continue
                where = " AND ".join(f"{m} = ?" for m in match)
                if conn.execute(f"SELECT 1 FROM {table} WHERE {where} LIMIT 1",
                                tuple(item[m] for m in match)).fetchone():
                    result["skipped"] += 1
                    continue
                row = {k: v for k, v in item.items() if k in cols and k not in drop}
                if "created_at" in cols:
                    row.setdefault("created_at", _now())
                if "updated_at" in cols:
                    row["updated_at"] = row.get("updated_at") or _now()
                _insert(conn, table, row)
                result["imported"] += 1
    return result


def import_bundle(raw: bytes, sections: Iterable[str], duplicates: str = "skip",
                  target_profile_id: Optional[int] = None) -> dict:
    """
    Write a bundle into this install.

    ``duplicates``: "skip" leaves an existing same-named item alone, "add"
    imports it anyway as a second copy.
    ``target_profile_id``: attach every imported plan to this profile instead of
    the one the bundle came from — how you pull someone else's plans into your
    own profile.
    """
    bundle = parse_bundle(raw)
    data = bundle["data"]
    wanted = [s for s in sections if s in SECTIONS]
    if not wanted:
        raise FriendlyError("invalid", "Nothing selected",
                            "Pick at least one kind of data to import.")
    always_add = duplicates == "add"

    report = {s: {"imported": 0, "skipped": 0} for s in wanted}
    profile_map: dict[int, int] = {}

    with sess._connect() as conn:
        if "profiles" in wanted:
            cols = _table_columns(conn, "profiles")
            for item in data.get("profiles") or []:
                name = str(item.get("name", "")).strip()
                if not name:
                    continue
                found = None if always_add else _existing(conn, "profiles", "name = ?", (name,))
                if found:
                    profile_map[item.get("ref")] = found
                    report["profiles"]["skipped"] += 1
                    continue
                new_id = _insert(conn, "profiles", {**_stamped(item, cols), "name": name, "is_active": 0})
                profile_map[item.get("ref")] = new_id
                report["profiles"]["imported"] += 1

        if "plans" in wanted:
            cols = _table_columns(conn, "meeting_plans")
            for item in data.get("plans") or []:
                title = str(item.get("title", "")).strip()
                if not title:
                    continue
                if not always_add and _existing(conn, "meeting_plans",
                                                "title = ? AND IFNULL(counterparty,'') = ?",
                                                (title, str(item.get("counterparty") or ""))):
                    report["plans"]["skipped"] += 1
                    continue
                row = _stamped(item, cols)
                row["title"] = title
                row["profile_id"] = (target_profile_id
                                     if target_profile_id is not None
                                     else profile_map.get(item.get("profile_ref")))
                _insert(conn, "meeting_plans", row)
                report["plans"]["imported"] += 1

        if "stories" in wanted:
            cols = _table_columns(conn, "stories")
            for item in data.get("stories") or []:
                title = str(item.get("title", "")).strip()
                if not title:
                    continue
                if not always_add and _existing(conn, "stories", "title = ?", (title,)):
                    report["stories"]["skipped"] += 1
                    continue
                _insert(conn, "stories", {**_stamped(item, cols), "title": title})
                report["stories"]["imported"] += 1

        if "drills" in wanted:
            cols = _table_columns(conn, "drills")
            for item in data.get("drills") or []:
                topic = str(item.get("topic", "")).strip()
                if not topic:
                    continue
                # The same attempt (topic + when it happened) is only counted
                # once, so importing a file twice doesn't inflate Progress.
                if not always_add and _existing(conn, "drills", "topic = ? AND created_at = ?",
                                                (topic, str(item.get("created_at") or ""))):
                    report["drills"]["skipped"] += 1
                    continue
                _insert(conn, "drills", {**_stamped(item, cols), "topic": topic})
                report["drills"]["imported"] += 1

        for table in ("cvs", "documents"):
            if table not in wanted:
                continue
            cols = _table_columns(conn, table)
            for item in data.get(table) or []:
                name = str(item.get("name", "")).strip()
                if not name:
                    continue
                if not always_add and _existing(conn, table, "name = ?", (name,)):
                    report[table]["skipped"] += 1
                    continue
                try:
                    content = base64.b64decode(item.get("content_b64") or "")
                except Exception:
                    report[table]["skipped"] += 1
                    continue
                row = _stamped(item, cols)
                row.update({
                    "name": name,
                    "content": content,
                    "original_filename": item.get("original_filename") or name,
                    "mime": item.get("mime") or "application/octet-stream",
                    "extracted_text": item.get("extracted_text") or "",
                })
                row.pop("is_active", None)
                _insert(conn, table, row)
                report[table]["imported"] += 1

    for name in TRACKS:
        if name in wanted and isinstance(data.get(name), dict):
            report[name] = _import_track(name, data[name])
    if "writing" in wanted and isinstance(data.get("writing"), list):
        from . import writing
        got = writing.import_all(data["writing"], "add" if always_add else "skip")
        report["writing"] = {"imported": got["added"], "skipped": got["skipped"]}

    if "preferences" in wanted:
        prefs = data.get("preferences") or {}
        if isinstance(prefs, dict) and prefs:
            safe = {k: v for k, v in prefs.items()
                    if not any(s in k.lower() for s in _SECRETISH)}
            cfg = load_config()
            cfg.update(safe)
            save_config(cfg)
            report["preferences"]["imported"] = len(safe)

    return {"report": report, "labels": SECTION_LABELS,
            "exported_at": bundle.get("exported_at", "")}
