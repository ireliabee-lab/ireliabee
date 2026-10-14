"""
Notebook (product specs 184 and 185): notes you'd be proud to have written.

A lecture, a meeting or a document becomes a *notebook*: a title, a summary,
sections of typed blocks (a point, a key point, a definition, an example, an
exam point, a question, a quote, a formula, a table, a "check this", a
decision, an action, a risk, a number, your own note, a tutor note) and, for
meetings, a board of decisions / actions / questions / risks / numbers. The
app lays those blocks out like a notebook page; nothing here is HTML.

Everything the AI writes must come from the source. Each block carries `src`:
the transcript line numbers (or document pages) it came from, so the app can
jump to the moment it was said. Tutor notes are the only exception, and they
are labelled as such.

The notebook is the user's to edit: every save replaces the whole document
after validation, bumps `version`, and is refused (409) if someone else saved
first. The previous versions are kept (the last ten) and can be restored.

The user picks how it looks — font family, size and style — before the AI
writes a word; that choice is stored with the notebook and can be changed.
"""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException

from . import languages
from .core import sessions as sess

# ── What a notebook may contain ──────────────────────────────────────────────

KINDS = ("lecture", "meeting", "reading")

BLOCK_TYPES = (
    "point", "key", "definition", "example", "exam", "question", "quote", "formula",
    "table", "unclear", "decision", "action", "risk", "number", "note", "tutor", "image",
)
BOARD_KEYS = ("decisions", "actions", "questions", "risks", "numbers")
#: How a block's line is drawn in the book, when the reader styled it away from its type's usual look.
#: "blank" and "divider" are lines with no words: spacing and rules the reader put between notes.
BLOCK_PARAS = ("normal", "bullet", "numbered", "check", "checked", "quote", "center", "key", "divider", "blank")
#: Which block type each board column holds.
BOARD_TYPES = {"decisions": "decision", "actions": "action", "questions": "question",
               "risks": "risk", "numbers": "number"}

#: How the notes look. Ids are stable; the app maps them to real fonts.
FONT_FAMILIES = {
    "serif":    "Newsreader — classic book serif",
    "sans":     "Instrument Sans — clean and modern",
    "readable": "Atkinson Hyperlegible — easiest to read",
    "hand":     "Caveat — handwritten",
}
FONT_SIZES = {"xs": 13, "s": 14, "m": 16, "l": 18, "xl": 20}
FONT_STYLES = {
    "regular": "Regular",
    "light":   "Light",
    "bold":    "Bold",
    "italic":  "Italic",
}
#: How list items (Test yourself questions, cues) are marked.
LIST_MARKERS = ("bullet", "number", "none")
#: The book's paper and cover (the Nkɔmmɔ themes); "auto" follows the system's light or dark.
PAPERS = ("classic", "light", "dark", "school", "parchment", "dotgrid", "clean", "cleandark", "auto")
DEFAULT_STYLE = {
    "lecture": {"family": "serif", "size": "m", "style": "regular", "list": "bullet", "paper": "classic"},
    "reading": {"family": "serif", "size": "m", "style": "regular", "list": "bullet", "paper": "parchment"},
    "meeting": {"family": "sans",  "size": "m", "style": "regular", "list": "bullet", "paper": "dotgrid"},
}

LIMITS = {
    "title": 200, "text": 4000, "summary": 2000, "term": 200, "short": 120,
    "sections": 60, "reading_sections": 400, "blocks": 80, "board": 40, "cues": 40, "src": 20,
    "rows": 20, "cols": 6, "cell": 300,
    "image": 700_000,      # one photo, as a data URL (downscaled JPEG, about 500 KB)
    "images": 24,          # photos in one notebook
}
_IMAGE_URL = re.compile(r"^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$")
VERSIONS_KEPT = 10          # your own edits
PINNED_KEPT = 3             # versions the AI wrote, kept apart so a burst of edits can't push them out
SNAPSHOT_EVERY_S = 300      # autosave saves every pause; keep at most one version per five minutes of them


# ── Storage ──────────────────────────────────────────────────────────────────

def _ensure_schema() -> None:
    with sess._connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS notebooks (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                kind          TEXT NOT NULL,              -- lecture | meeting | reading
                session_id    INTEGER,                    -- the lecture or meeting it came from
                document_id   INTEGER,                    -- the paper or book it came from
                title         TEXT NOT NULL,
                template      TEXT NOT NULL DEFAULT '',
                style_json    TEXT NOT NULL,
                doc_json      TEXT NOT NULL,
                scope_json    TEXT NOT NULL DEFAULT '{}', -- pages / chapters covered (reading)
                coverage_json TEXT NOT NULL DEFAULT '{}',
                version       INTEGER NOT NULL DEFAULT 1,
                edited        INTEGER NOT NULL DEFAULT 0, -- the user changed it since it was written
                generated_at  TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_notebooks_session
                ON notebooks(session_id) WHERE session_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_notebooks_updated ON notebooks(updated_at);
            CREATE TABLE IF NOT EXISTS notebook_versions (
                notebook_id INTEGER NOT NULL,
                version     INTEGER NOT NULL,
                title       TEXT NOT NULL,
                style_json  TEXT NOT NULL,
                doc_json    TEXT NOT NULL,
                saved_at    TEXT NOT NULL,
                PRIMARY KEY (notebook_id, version)
            );
            """
        )


_ensure_schema()


def _ensure_columns() -> None:
    with sess._connect() as conn:
        have = {r[1] for r in conn.execute("PRAGMA table_info(notebook_versions)")}
        if "pinned" not in have:
            conn.execute("ALTER TABLE notebook_versions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")


_ensure_columns()

# One gate for every AI call a notebook or reading job makes, across the whole
# app (audit 181-M7): two jobs at once still make at most MAX_PARALLEL calls.
_gates: dict = {}


def ai_gate() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    gate = _gates.get(loop)
    if gate is None:
        for old in [l for l in _gates if l.is_closed()]:
            _gates.pop(old, None)
        gate = _gates[loop] = asyncio.Semaphore(MAX_PARALLEL)
    return gate


async def gather_all(coros) -> list:
    """Like asyncio.gather, but when one fails the others are cancelled, not left calling the AI."""
    tasks = [asyncio.ensure_future(c) for c in coros]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for t in tasks:
            t.cancel()
        raise


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _new_id() -> str:
    return uuid.uuid4().hex[:10]


# ── Cleaning: whatever arrives (the model, the app) leaves in one strict shape ─

def _s(value: Any, limit: int) -> str:
    return str(value if value is not None else "").strip()[:limit]


def _clamp_int(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _ints(value: Any, lo: int = 1, hi: int = 10**6) -> list[int]:
    out: list[int] = []
    for v in value if isinstance(value, list) else []:
        try:
            n = int(v)
        except (TypeError, ValueError):
            continue
        if lo <= n <= hi and n not in out:
            out.append(n)
    return out[: LIMITS["src"]]


def clean_style(style: Any, kind: str = "lecture") -> dict:
    base = dict(DEFAULT_STYLE.get(kind, DEFAULT_STYLE["lecture"]))
    if isinstance(style, dict):
        if style.get("family") in FONT_FAMILIES:
            base["family"] = style["family"]
        if style.get("size") in FONT_SIZES:
            base["size"] = style["size"]
        if style.get("style") in FONT_STYLES:
            base["style"] = style["style"]
        if style.get("list") in LIST_MARKERS:
            base["list"] = style["list"]
        if style.get("paper") in PAPERS:
            base["paper"] = style["paper"]
        if style.get("pageColor") in PAGE_COLORS:
            base["pageColor"] = style["pageColor"]
    return base


#: Page colours over the paper theme (frontend/src/lib/book/themes.ts, PAGE_COLORS).
PAGE_COLORS = ("white", "cream", "sage", "sky", "blush", "sand", "slate", "night")


MARK_COLORS = ("yellow", "green", "blue", "pink", "orange")
INK_COLORS = ("red", "orange", "green", "blue", "purple")      # text colours
MAX_MARKS = 200


def clean_marks(raw: Any, text: str, palette: tuple = MARK_COLORS) -> list[dict]:
    """
    The user's highlights on `text`, as the app draws them (lib/notebook.ts anchorMarks):
    each keeps its words (q); one whose words moved is found again at the nearest place
    they appear, one whose words are gone is dropped. Sorted, never overlapping.
    """
    found = []
    for m in raw if isinstance(raw, list) else []:
        if not isinstance(m, dict) or m.get("c") not in palette:
            continue
        q = str(m.get("q") or "")
        if not q or len(q) > len(text):
            continue
        try:
            start = int(m.get("s"))
        except (TypeError, ValueError):
            start = 0
        if text[start:start + len(q)] != q or start < 0:
            spots = [i for i in range(len(text)) if text.startswith(q, i)]
            if not spots:
                continue
            start = min(spots, key=lambda i: abs(i - start))
        found.append({"s": start, "e": start + len(q), "c": m["c"], "q": q})
    found.sort(key=lambda m: m["s"])
    kept, end = [], 0
    for m in found:
        if m["s"] >= end:
            kept.append(m)
            end = m["e"]
    return kept[:MAX_MARKS]


STYLES = ("b", "i", "u", "x")          # bold, italic, underline, strikethrough


def _relocate(text: str, start: int, q: str) -> int:
    """Where q sits in text now: at start if it's still there, else the nearest place it appears; -1 if gone."""
    if 0 <= start and text[start:start + len(q)] == q:
        return start
    at = max(start, 0)
    after = text.find(q, at)                            # the first at or after start
    before = text.rfind(q, 0, at + len(q) - 1) if at else -1   # the last that begins before it
    if before == -1:
        return after
    if after == -1:
        return before
    return before if start - before <= after - start else after     # a tie goes to the earlier one


def clean_fmt(raw: Any, text: str) -> dict:
    """
    The user's bold / italic / underline / strikethrough on `text` (lib/notebook.ts
    Formatting): per style, spans {s, e, q} that find their words again after an
    edit, merged where they touch, at most MAX_MARKS each.
    """
    out: dict = {}
    if not isinstance(raw, dict):
        return out
    for key in STYLES:
        spans = raw.get(key)
        if not spans or not isinstance(spans, list):
            continue
        mask = [False] * len(text)
        for sp in spans if isinstance(spans, list) else []:
            if not isinstance(sp, dict):
                continue
            q = str(sp.get("q") or "")
            if not q or len(q) > len(text):
                continue
            try:
                start = int(sp.get("s"))
            except (TypeError, ValueError):
                start = 0
            at = _relocate(text, start, q)
            if at != -1:
                for i in range(at, at + len(q)):
                    mask[i] = True
        runs, i = [], 0
        while i < len(mask):
            if mask[i]:
                j = i
                while j < len(mask) and mask[j]:
                    j += 1
                runs.append({"s": i, "e": j, "q": text[i:j]})
                i = j
            else:
                i += 1
        if runs:
            out[key] = runs[:MAX_MARKS]
    return out


BLOCK_RICH_FIELDS = ("term", "speaker", "owner", "due", "caption")


def clean_rich(raw: Any, text: str) -> dict:
    """One text's formatting (lib/notebook.ts Rich): highlights, styles, text colours."""
    if not isinstance(raw, dict) or not text:
        return {}
    out = {}
    marks = clean_marks(raw.get("marks"), text)
    fmt = clean_fmt(raw.get("fmt"), text)
    ink = clean_marks(raw.get("ink"), text, INK_COLORS)
    if marks:
        out["marks"] = marks
    if fmt:
        out["fmt"] = fmt
    if ink:
        out["ink"] = ink
    return out


def clean_rich_map(raw: Any, texts: dict) -> dict:
    """Formatting for several named texts (title, cue:0, cell:1:2...): only texts that exist keep any."""
    out = {}
    for key, text in texts.items():
        r = clean_rich(raw.get(key) if isinstance(raw, dict) else None, text)
        if r:
            out[key] = r
    return out


def clean_block(raw: Any, max_src: int = 10**6, force_type: Optional[str] = None) -> Optional[dict]:
    """One block, or None if it is empty or of a type we don't have."""
    if not isinstance(raw, dict):
        return None
    btype = force_type or str(raw.get("type", "point")).strip().lower()
    if btype not in BLOCK_TYPES:
        return None
    block = {
        "id": _s(raw.get("id"), 40) or _new_id(),
        "type": btype,
        "text": _s(raw.get("text"), LIMITS["text"]),
        "src": _ints(raw.get("src"), 1, max_src),
    }
    if btype == "definition":
        block["term"] = _s(raw.get("term"), LIMITS["term"])
    if btype == "number":
        block["term"] = _s(raw.get("term") or raw.get("value"), LIMITS["short"])
    if btype == "quote":
        block["speaker"] = _s(raw.get("speaker"), LIMITS["short"])
    if btype == "action":
        block["owner"] = _s(raw.get("owner") or raw.get("who"), LIMITS["short"]) or "Not agreed"
        block["due"] = _s(raw.get("due"), LIMITS["short"])
        block["done"] = bool(raw.get("done", False))
    if btype == "image":
        url = raw.get("image")
        if not isinstance(url, str) or len(url) > LIMITS["image"] or not _IMAGE_URL.match(url):
            return None
        block["image"] = url
        block["w"] = _clamp_int(raw.get("w"), 1, 4000, 400)
        block["h"] = _clamp_int(raw.get("h"), 1, 4000, 300)
    if btype == "table":
        rows = []
        for row in raw.get("rows") if isinstance(raw.get("rows"), list) else []:
            if isinstance(row, list):
                cells = [_s(c, LIMITS["cell"]) for c in row[: LIMITS["cols"]]]
                if any(cells):
                    rows.append(cells)
        block["rows"] = rows[: LIMITS["rows"]]
        block["caption"] = _s(raw.get("caption"), LIMITS["title"])
        if not block["rows"]:
            return None
    para = raw.get("para")
    if para in BLOCK_PARAS:
        block["para"] = para
    marks = clean_marks(raw.get("marks"), block["text"])
    if marks:
        block["marks"] = marks
    fmt = clean_fmt(raw.get("fmt"), block["text"])
    if fmt:
        block["fmt"] = fmt
    ink = clean_marks(raw.get("ink"), block["text"], INK_COLORS)
    if ink:
        block["ink"] = ink
    # Formatting on the block's other texts.
    texts = {f: block[f] for f in BLOCK_RICH_FIELDS if isinstance(block.get(f), str) and block[f]}
    for r, row in enumerate(block.get("rows") or []):
        for c, cell in enumerate(row):
            if cell:
                texts[f"cell:{r}:{c}"] = cell
    rich = clean_rich_map(raw.get("rich"), texts)
    if rich:
        block["rich"] = rich
    has_content = block["text"] or block.get("term") or block.get("rows") or block.get("image")
    spacing = btype == "note" and block.get("para") in ("blank", "divider")
    return block if has_content or spacing else None


def clean_doc(raw: Any, kind: str, max_src: int = 10**6) -> dict:
    """A whole notebook document in the one shape the app renders."""
    raw = raw if isinstance(raw, dict) else {}
    # A deck from a whole textbook has far more slides than a lecture has sections.
    max_sections = LIMITS["reading_sections"] if kind == "reading" else LIMITS["sections"]
    sections = []
    for sec in raw.get("sections") if isinstance(raw.get("sections"), list) else []:
        if not isinstance(sec, dict):
            continue
        blocks = [b for b in (clean_block(x, max_src) for x in (sec.get("blocks") or [])[: LIMITS["blocks"] * 2]) if b]
        title = _s(sec.get("title") or sec.get("heading"), LIMITS["title"])
        if not title and not blocks:
            continue
        section = {
            "id": _s(sec.get("id"), 40) or _new_id(),
            "title": title or "Untitled section",
            "src": _ints(sec.get("src"), 1, max_src),
            "blocks": blocks[: LIMITS["blocks"]],
        }
        title_rich = clean_rich((sec.get("rich") or {}).get("title") if isinstance(sec.get("rich"), dict) else None,
                                section["title"])
        if title_rich:
            section["rich"] = {"title": title_rich}
        sections.append(section)
        if len(sections) >= max_sections:
            break
    # Photos are big: only so many per notebook, the first ones kept.
    seen_images = 0
    for section in sections:
        kept = []
        for b in section["blocks"]:
            if b["type"] == "image":
                seen_images += 1
                if seen_images > LIMITS["images"]:
                    continue
            kept.append(b)
        section["blocks"] = kept
    board_raw = raw.get("board") if isinstance(raw.get("board"), dict) else {}
    board = {}
    for key in BOARD_KEYS:
        items = board_raw.get(key) if isinstance(board_raw.get(key), list) else []
        board[key] = [b for b in (clean_block(x, max_src, BOARD_TYPES[key]) for x in items[: LIMITS["board"] * 2]) if b][: LIMITS["board"]]
    cues = [_s(c, LIMITS["title"]) for c in (raw.get("cues") if isinstance(raw.get("cues"), list) else [])]
    out = {
        "title": _s(raw.get("title"), LIMITS["title"]),
        "author": _s(raw.get("author"), LIMITS["title"]),        # who wrote the source (a paper's authors, a lecturer)
        "summary": _s(raw.get("summary"), LIMITS["summary"]),
        "cues": [c for c in cues if c][: LIMITS["cues"]],
        "sections": sections,
        "board": board if kind == "meeting" else {k: [] for k in BOARD_KEYS},
    }
    # The exercise-book cover's label (name, class, year), kept only when something is written on it.
    cover_raw = raw.get("cover") if isinstance(raw.get("cover"), dict) else {}
    cover = {k: _s(cover_raw.get(k), LIMITS["short"]) for k in ("name", "class", "year")}
    if any(cover.values()):
        out["cover"] = cover
    # Unfamiliar terms found for this notebook (reading.find_terms): meanings, and where each came from.
    terms = clean_terms(raw.get("terms"))
    if terms:
        out["terms"] = terms
    # Formatting on the notebook's own texts (title, author, summary, cue:N).
    texts = {k: out[k] for k in ("title", "author", "summary") if out[k]}
    texts.update({f"cue:{i}": c for i, c in enumerate(out["cues"])})
    rich = clean_rich_map(raw.get("rich"), texts)
    if rich:
        out["rich"] = rich
    return out


#: How many found terms a notebook keeps.
MAX_TERMS = 60


def clean_terms(raw: Any) -> list[dict]:
    """The notebook's found terms, in one shape: {term, meaning, from, pages, unsure}, once each."""
    out, seen = [], set()
    for t in raw if isinstance(raw, list) else []:
        if not isinstance(t, dict):
            continue
        term, meaning = _s(t.get("term"), LIMITS["short"]), _s(t.get("meaning"), 600)
        if not term or not meaning or term.lower() in seen:
            continue
        seen.add(term.lower())
        out.append({"term": term, "meaning": meaning,
                    "from": t.get("from") if t.get("from") in ("source", "general", "both") else "general",
                    "pages": _ints(t.get("pages"), 1, 10**6)[:5], "unsure": bool(t.get("unsure"))})
        if len(out) >= MAX_TERMS:
            break
    return out


def empty_doc() -> dict:
    return {"title": "", "author": "", "summary": "", "cues": [], "sections": [], "board": {k: [] for k in BOARD_KEYS}}


# ── CRUD ─────────────────────────────────────────────────────────────────────

def _row_to_dict(row, full: bool = True, with_doc: bool = True) -> dict:
    doc = json.loads(row["doc_json"]) if with_doc or not full else None
    out = {
        "id": row["id"], "kind": row["kind"], "session_id": row["session_id"], "document_id": row["document_id"],
        "title": row["title"], "template": row["template"], "style": json.loads(row["style_json"]),
        "version": row["version"], "edited": bool(row["edited"]), "generated_at": row["generated_at"],
        "created_at": row["created_at"], "updated_at": row["updated_at"],
        "coverage": json.loads(row["coverage_json"] or "{}"), "scope": json.loads(row["scope_json"] or "{}"),
    }
    if full:
        if with_doc:
            out["doc"] = doc
    else:
        blocks = [b for s in doc.get("sections", []) for b in s.get("blocks", [])]
        board = doc.get("board", {})
        out["counts"] = {
            "sections": len(doc.get("sections", [])),
            "key": sum(1 for b in blocks if b["type"] == "key"),
            "actions": len(board.get("actions", [])),
            "decisions": len(board.get("decisions", [])),
        }
        out["summary"] = doc.get("summary", "")[:240]
    return out


def _get_row(notebook_id: int):
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM notebooks WHERE id = ?", (notebook_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Notebook not found")
    return row


def get_notebook(notebook_id: int) -> dict:
    out = _row_to_dict(_get_row(notebook_id))
    if out["session_id"]:
        out["line_times"] = line_times(out["session_id"])
    return out


def for_session(session_id: int) -> Optional[dict]:
    with sess._connect() as conn:
        row = conn.execute("SELECT id FROM notebooks WHERE session_id = ?", (session_id,)).fetchone()
    return get_notebook(row["id"]) if row else None


def list_notebooks(kind: Optional[str] = None, q: Optional[str] = None, limit: int = 200) -> list[dict]:
    sql, args = "SELECT * FROM notebooks", []
    where = []
    if kind:
        if kind not in KINDS:
            raise HTTPException(400, "Unknown kind of notebook")
        where.append("kind = ?"); args.append(kind)
    needle = (q or "").strip()[:100].lower()
    # Stored JSON escapes non-English letters (é is é), so only a plain-ASCII search can be narrowed in SQL.
    if needle and needle.isascii():
        # Narrow in SQL (wildcards escaped), then match only the words of the notes —
        # not the JSON around them, where "type" or "src" would match every notebook.
        like = "%" + needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        where.append("(lower(title) LIKE ? ESCAPE '\\' OR lower(doc_json) LIKE ? ESCAPE '\\')")
        args += [like, like]
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY updated_at DESC LIMIT ?"
    args.append(max(1, min(int(limit), 500)) if not needle else 2000)
    with sess._connect() as conn:
        rows = conn.execute(sql, args).fetchall()
    if needle:
        rows = [r for r in rows if needle in r["title"].lower() or needle in _words(json.loads(r["doc_json"]))][: max(1, min(int(limit), 500))]
    return [_row_to_dict(r, full=False) for r in rows]


def _words(value: Any) -> str:
    """Every piece of text a person wrote or reads in a notebook, lower-cased — no keys, ids or page numbers."""
    out: list[str] = []

    def walk(v: Any, key: str = "") -> None:
        if isinstance(v, dict):
            for k, x in v.items():
                if k not in ("id", "type", "src", "done", "para", "image", "w", "h"):
                    walk(x, k)
        elif isinstance(v, list):
            for x in v:
                walk(x, key)
        elif isinstance(v, str):
            out.append(v)

    walk(value)
    return "\n".join(out).lower()


def create_notebook(kind: str, title: str = "", style: Any = None, doc: Any = None,
                    session_id: Optional[int] = None, document_id: Optional[int] = None,
                    template: str = "", generated: bool = False, scope: Any = None, coverage: Any = None) -> dict:
    if kind not in KINDS:
        raise HTTPException(400, "Unknown kind of notebook")
    cleaned = clean_doc(doc, kind) if doc is not None else empty_doc()
    title = _s(title, LIMITS["title"]) or cleaned["title"] or "Untitled notebook"
    now = _now()
    with sess._connect() as conn:
        try:
            cur = conn.execute(
                "INSERT INTO notebooks (kind, session_id, document_id, title, template, style_json, doc_json, "
                "scope_json, coverage_json, version, edited, generated_at, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)",
                (kind, session_id, document_id, title, _s(template, 40), json.dumps(clean_style(style, kind)),
                 json.dumps(cleaned), json.dumps(scope or {}), json.dumps(coverage or {}),
                 now if generated else None, now, now),
            )
        except Exception as e:  # the unique index: this session already has a notebook
            if "UNIQUE" in str(e):
                raise HTTPException(409, "This session already has a notebook")
            raise
        new_id = cur.lastrowid
    return get_notebook(new_id)


def _snapshot(conn, row, force: bool = False) -> None:
    """Keep the notebook as it is now, before it changes.

    The AI's own writing (generated and not yet edited) is always kept, pinned.
    Your edits are kept at most once per SNAPSHOT_EVERY_S, so autosave's many small
    saves don't push the useful versions out; `force` (a restore, a rewrite) always keeps one.
    """
    pinned = bool(row["generated_at"]) and not row["edited"]
    if not force and not pinned:
        last = conn.execute(
            "SELECT saved_at FROM notebook_versions WHERE notebook_id = ? AND pinned = 0 ORDER BY version DESC LIMIT 1",
            (row["id"],),
        ).fetchone()
        if last:
            try:
                age = (datetime.utcnow() - datetime.fromisoformat(last["saved_at"])).total_seconds()
            except (TypeError, ValueError):
                age = SNAPSHOT_EVERY_S
            if age < SNAPSHOT_EVERY_S:
                return
    conn.execute(
        "INSERT OR REPLACE INTO notebook_versions (notebook_id, version, title, style_json, doc_json, saved_at, pinned) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (row["id"], row["version"], row["title"], row["style_json"], row["doc_json"], _now(), 1 if pinned else 0),
    )
    for flag, keep in ((0, VERSIONS_KEPT), (1, PINNED_KEPT)):
        conn.execute(
            "DELETE FROM notebook_versions WHERE notebook_id = ? AND pinned = ? AND version NOT IN "
            "(SELECT version FROM notebook_versions WHERE notebook_id = ? AND pinned = ? ORDER BY version DESC LIMIT ?)",
            (row["id"], flag, row["id"], flag, keep),
        )


def update_notebook(notebook_id: int, version: int, title: Optional[str] = None, style: Any = None,
                    doc: Any = None, keep_version: bool = False, brief: bool = False) -> dict:
    """Save the user's changes. `version` must be the one they started from.

    `brief`: answer with the notebook's details but not its text or line times (the
    editor's autosave already has the text, and re-reading a session's transcript
    for line times on every save was most of a save's cost)."""
    row = _get_row(notebook_id)
    kind = row["kind"]
    new_title = row["title"] if title is None else (_s(title, LIMITS["title"]) or "Untitled notebook")
    new_style = row["style_json"] if style is None else json.dumps(clean_style(style, kind))
    new_doc = row["doc_json"] if doc is None else json.dumps(clean_doc(doc, kind))
    content_changed = new_doc != row["doc_json"] or new_title != row["title"]
    with sess._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT * FROM notebooks WHERE id = ?", (notebook_id,)).fetchone()
        if current is None:
            raise HTTPException(404, "Notebook not found")
        if int(version) != current["version"]:
            raise HTTPException(409, detail={
                "code": "conflict", "title": "This notebook changed",
                "message": "It was saved somewhere else since you opened it. Reload to see the latest, then edit again.",
            })
        _snapshot(conn, current, force=keep_version)
        conn.execute(
            "UPDATE notebooks SET title = ?, style_json = ?, doc_json = ?, version = version + 1, "
            "edited = CASE WHEN ? THEN 1 ELSE edited END, updated_at = ? WHERE id = ?",
            (new_title, new_style, new_doc, 1 if content_changed else 0, _now(), notebook_id),
        )
    if brief:
        return _row_to_dict(_get_row(notebook_id), with_doc=False)
    return get_notebook(notebook_id)


def delete_notebook(notebook_id: int) -> dict:
    _get_row(notebook_id)
    with sess._connect() as conn:
        conn.execute("DELETE FROM notebook_versions WHERE notebook_id = ?", (notebook_id,))
        conn.execute("DELETE FROM notebooks WHERE id = ?", (notebook_id,))
    from . import study_reviews  # its review cards go with the notebook
    study_reviews.forget_notebook(notebook_id)
    return {"ok": True}


def list_versions(notebook_id: int) -> list[dict]:
    _get_row(notebook_id)
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT version, title, saved_at, pinned FROM notebook_versions WHERE notebook_id = ? ORDER BY version DESC",
            (notebook_id,),
        ).fetchall()
    return [{**dict(r), "pinned": bool(r["pinned"])} for r in rows]


def restore_version(notebook_id: int, version: int, current_version: int) -> dict:
    with sess._connect() as conn:
        old = conn.execute(
            "SELECT * FROM notebook_versions WHERE notebook_id = ? AND version = ?", (notebook_id, version),
        ).fetchone()
    if old is None:
        raise HTTPException(404, "That version is no longer kept")
    return update_notebook(notebook_id, current_version, title=old["title"],
                           style=json.loads(old["style_json"]), doc=json.loads(old["doc_json"]), keep_version=True)


# ── Export ───────────────────────────────────────────────────────────────────

_MD_LABEL = {
    "key": "**Key point:** ", "exam": "**Exam point:** ", "question": "**Question:** ",
    "unclear": "**Check this:** ", "decision": "**Decision:** ", "risk": "**Risk:** ",
    "example": "**Example:** ", "tutor": "**iReliabee's explanation:** ", "note": "**My note:** ",
}


def _md_text(b: dict) -> str:
    """A block's text with its bold (**), italic (*) and strikethrough (~~) as Markdown."""
    text = b.get("text", "")
    fmt = b.get("fmt") or {}
    if not fmt:
        return text
    on = {key: [False] * len(text) for key in ("b", "i", "x")}
    for key in on:
        for sp in fmt.get(key) or []:
            for k in range(max(0, sp.get("s", 0)), min(len(text), sp.get("e", 0))):
                on[key][k] = True
    out, k = [], 0
    while k < len(text):
        look = (on["b"][k], on["i"][k], on["x"][k])
        j = k
        while j < len(text) and (on["b"][j], on["i"][j], on["x"][j]) == look:
            j += 1
        chunk = text[k:j]
        core = chunk.strip()
        if core and any(look):
            lead, trail = chunk[: len(chunk) - len(chunk.lstrip())], chunk[len(chunk.rstrip()):]
            wrap = ("**" if look[0] else "") + ("*" if look[1] else "") + ("~~" if look[2] else "")
            chunk = f"{lead}{wrap}{core}{wrap[::-1]}{trail}"
        out.append(chunk)
        k = j
    return "".join(out)


def _md_block(b: dict) -> str:
    if b.get("para") == "divider":
        return "---"
    if b.get("para") == "blank":
        return ""
    if b.get("type") == "image":
        return f"*[Photo{': ' + b['text'] if b.get('text') else ''}]*"
    b = {**b, "text": _md_text(b)}
    t = b["type"]
    if t == "definition":
        return f"- **{b.get('term', '')}**: {b['text']}"
    if t == "quote":
        who = f" — {b['speaker']}" if b.get("speaker") else ""
        return f"> {b['text']}{who}"
    if t == "formula":
        return f"```\n{b['text']}\n```"
    if t == "action":
        box = "x" if b.get("done") else " "
        due = f" (due {b['due']})" if b.get("due") else ""
        return f"- [{box}] **{b.get('owner', '')}**: {b['text']}{due}"
    if t == "number":
        return f"- **{b.get('term', '')}**: {b['text']}"
    if t == "table":
        rows = b.get("rows") or []
        if not rows:
            return ""
        head = "| " + " | ".join(rows[0]) + " |"
        sep = "| " + " | ".join("---" for _ in rows[0]) + " |"
        body = ["| " + " | ".join(r + [""] * (len(rows[0]) - len(r))) + " |" for r in rows[1:]]
        cap = f"*{b['caption']}*\n\n" if b.get("caption") else ""
        return cap + "\n".join([head, sep, *body])
    return f"- {_MD_LABEL.get(t, '')}{b['text']}"


def to_markdown(notebook: dict) -> str:
    doc = notebook["doc"]
    out = [f"# {notebook['title']}", ""]
    if doc.get("author"):
        out += [f"*{doc['author']}*", ""]
    if doc.get("summary"):
        out += ["## Summary", "", doc["summary"], ""]
    for sec in doc.get("sections", []):
        out += [f"## {sec['title']}", ""]
        out += [line for line in (_md_block(b) for b in sec.get("blocks", [])) if line]
        out.append("")
    names = {"decisions": "Decisions", "actions": "Action items", "questions": "Open questions",
             "risks": "Risks", "numbers": "Numbers and dates"}
    for key in BOARD_KEYS:
        items = doc.get("board", {}).get(key) or []
        if items:
            out += [f"## {names[key]}", ""] + [_md_block(b) for b in items] + [""]
    if doc.get("cues"):
        out += ["## Test yourself", ""] + [f"- {c}" for c in doc["cues"]] + [""]
    return "\n".join(out).rstrip() + "\n"


# ── Writing a notebook from a session ────────────────────────────────────────

CHUNK_CHARS = 18000
DIRECT_LIMIT = 36000
MAX_PARALLEL = 3            # never more AI calls than this at once (audit 181-M7)
_TAG = re.compile(r"^\s*(\[[^\]]*\]\s*)+")


def transcript(session_id: int) -> list[dict]:
    """The session's spoken lines, numbered from 1, with seconds from the start."""
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT speaker, content, created_at FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id",
            (session_id,),
        ).fetchall()
    lines, start = [], None
    for r in rows:
        text = _TAG.sub("", r["content"] or "").strip()
        if not text:
            continue
        try:
            at = datetime.fromisoformat(r["created_at"])
        except (TypeError, ValueError):
            at = None
        if start is None and at is not None:
            start = at
        t = int((at - start).total_seconds()) if (at and start) else 0
        lines.append({"n": len(lines) + 1, "who": "Them" if r["speaker"] == "interviewer" else "You",
                      "text": text, "t": max(0, t)})
    return lines


def line_times(session_id: int) -> dict[str, int]:
    return {str(line["n"]): line["t"] for line in transcript(session_id)}


def source_lines(notebook_id: int, lines: list[int], around: int = 1) -> list[dict]:
    """The transcript lines a block cites, with one line either side for context."""
    row = _get_row(notebook_id)
    if not row["session_id"]:
        return []
    everything = transcript(row["session_id"])
    wanted: set[int] = set()
    for n in lines[: LIMITS["src"]]:
        wanted.update(range(max(1, n - around), n + around + 1))
    cited = set(lines)
    return [{**line, "cited": line["n"] in cited} for line in everything if line["n"] in wanted][:30]


def _numbered(lines: list[dict], kind: str) -> str:
    who = {"Them": "Lecturer" if kind == "lecture" else "Them", "You": "Student" if kind == "lecture" else "You"}
    return "\n".join(f"[L{line['n']}] {who[line['who']]}: {line['text']}" for line in lines)


def _chunks(text: str, size: int = CHUNK_CHARS) -> list[str]:
    out, cur, n = [], [], 0
    for line in text.split("\n"):
        if n + len(line) > size and cur:
            out.append("\n".join(cur)); cur, n = [], 0
        cur.append(line); n += len(line) + 1
    if cur:
        out.append("\n".join(cur))
    return out


CONDENSE_PROMPT = """You condense one part of a transcript into detailed notes, as plain text.
Keep every definition, formula, example, number, name, date, decision, task and claim, in order, in the
speaker's own terms. KEEP THE [L#] LINE MARKERS: start each note with the marker(s) of the line(s) it came
from, e.g. "[L12][L13] RuBisCO attaches CO2 to RuBP". Drop filler and repetition. Never add anything."""

_RULES = """
RULES — these matter more than anything else:
- Use ONLY what is in the transcript (and the attached material, if any). Never add facts from elsewhere.
- Every block's "src" lists the [L#] numbers it came from, as integers: [L12] → 12.
- If something was garbled or cut off, write an "unclear" block saying what was heard; never guess.
- Keep numbers, names, dates and formulas exactly as said.
- Speech-recognition errors: fix obvious ones silently from context.
- Do not write about the note-taker, their background or their CV. These are notes about the content."""

LECTURE_PROMPT = """You write a student's lecture notes as a notebook, returned as JSON only.
""" + _RULES + """
- You may add at most three "tutor" blocks: a short, simpler explanation or analogy of your own, only where
  the lecture is hard to follow. They are shown to the student labelled as iReliabee's explanation.{tutor_rule}

Block types: "point" (a note), "key" (one of the few things most worth remembering), "definition"
(with "term"), "example" (an example or analogy the lecturer gave), "exam" (only where the lecturer said it
matters for the exam or must be remembered), "question" (something to ask the lecturer), "quote" (the
lecturer's exact words worth keeping, with "speaker": "Lecturer"), "formula" (verbatim), "table" (with "rows":
first row is the header, and an optional "caption"), "unclear", "tutor".

Return ONLY JSON:
{{"title": "a short title for the lecture",
 "summary": "3-5 sentences: what the lecture covered and its main argument",
 "cues": ["short self-test questions a student would write in the margin, 4-10 of them"],
 "sections": [{{"title": "a part of the lecture, in order", "src": [first, last line numbers],
               "blocks": [{{"type": "point", "text": "...", "src": [12, 13]}}]}}]}}
Aim for 3-8 sections that follow the lecture's own order, each with the points that were made in it."""

MEETING_PROMPT = """You write the notes of a meeting as a notebook, returned as JSON only.
""" + _RULES + """
- Lines marked "You" are {me}; lines marked "Them" are the other people in the meeting.
- Action owners and due dates exactly as said. If nobody took a task, "owner" is "Not agreed";
  if no date was agreed, "due" is "".

Block types inside topic sections: "point", "key", "quote" (with "speaker" if known), "table", "unclear".

Return ONLY JSON:
{{"title": "the meeting's topic, short",
 "summary": "2-3 sentences: where the meeting landed (the TL;DR)",
 "sections": [{{"title": "a topic that was discussed", "src": [first, last line numbers],
               "blocks": [{{"type": "point", "text": "...", "src": [4]}}]}}],
 "board": {{"decisions": [{{"text": "a decision reached", "src": [9]}}],
           "actions": [{{"text": "the task", "owner": "who", "due": "when, as said", "src": [15]}}],
           "questions": [{{"text": "something raised but not settled", "src": [20]}}],
           "risks": [{{"text": "a risk or blocker someone raised", "src": [22]}}],
           "numbers": [{{"term": "the figure or date", "text": "what it is", "src": [18]}}]}}}}
Use [] for anything with nothing to report."""


async def _condense(lines_text: str, model: Optional[str], lang_rule: str, session_id: int) -> str:
    """Long transcripts: condense each part first, at most MAX_PARALLEL at a time."""
    from .routers.mock import resolve_llm, respond, classify
    from .core.providers import metering_context

    model_id, provider = resolve_llm(model)
    loop = asyncio.get_running_loop()
    parts = _chunks(lines_text)
    gate = ai_gate()

    def run(i: int, part: str) -> str:
        with metering_context("notebook", session_id):
            return respond(provider, model_id, f"PART {i + 1} OF {len(parts)}\n{part}", [],
                           CONDENSE_PROMPT + lang_rule, 4096)

    async def one(i: int, part: str) -> str:
        async with gate:
            try:
                return await loop.run_in_executor(None, run, i, part)
            except Exception as e:
                raise classify(e, provider)

    notes = await gather_all([one(i, p) for i, p in enumerate(parts)])
    return "\n\n".join(f"[Part {i + 1}]\n{n}" for i, n in enumerate(notes))


def build_prompt(kind: str, session_id: int, tutor: bool) -> str:
    from .routers.mock import _candidate_context

    lang_rule = languages.json_block(languages.output_for_session(session_id))
    if kind == "lecture":
        rule = "" if tutor else "\n- Do NOT add any tutor blocks."
        return LECTURE_PROMPT.format(tutor_rule=rule) + lang_rule
    profile, _ = _candidate_context(None)
    me = (profile.get("name") or "").strip() or "the user"   # a name only; nothing else about them
    return MEETING_PROMPT.format(me=me) + lang_rule


def session_kind(session_id: int) -> str:
    row = sess.get_session(session_id)
    if row is None:
        raise HTTPException(404, "Session not found")
    # A session's `mode` is the template it was created with (routers/sessions.py).
    return "lecture" if row["mode"] == "lecture" else "meeting"


async def generate_for_session(session_id: int, style: Any = None, model: Optional[str] = None,
                               document_ids: Optional[list[int]] = None, tutor: Optional[bool] = None) -> dict:
    """Write (or rewrite) the notebook for a lecture or meeting. A rewrite keeps the old one as a version."""
    from .routers.mock import _ask_model
    from .document_store import documents_context

    kind = session_kind(session_id)
    lines = transcript(session_id)
    text = _numbered(lines, kind)
    if len(text) < 200:
        raise HTTPException(400, detail={
            "code": "invalid", "title": "Not enough to write notes from yet",
            "message": "Record a little more of the lecture or meeting, then make the notes.",
        })
    tutor = (kind == "lecture") if tutor is None else bool(tutor)
    system_prompt = build_prompt(kind, session_id, tutor)
    lang_rule = languages.json_block(languages.output_for_session(session_id))

    body = text
    if len(text) > DIRECT_LIMIT:
        body = await _condense(text, model, lang_rule, session_id)
    material = documents_context(document_ids or [], budget=10000, heading="ATTACHED MATERIAL")
    message = (f"{material}\n\n" if material else "") + "TRANSCRIPT (numbered lines)\n" + body

    raw = await _ask_model(model, system_prompt, message, kind="notebook", session_id=session_id)
    doc = clean_doc(raw, kind, max_src=len(lines))
    if not doc["sections"] and not any(doc["board"].values()):
        raise HTTPException(502, detail={
            "code": "unknown", "title": "The notes came back empty",
            "message": "Try again in a moment.",
        })
    title = doc["title"] or sess.get_session(session_id)["title"]

    existing = for_session(session_id)
    if existing is None:
        return _to_meeting(session_id, create_notebook(kind, title=title, style=style, doc=doc, session_id=session_id,
                                                       template=kind, generated=True))
    # A rewrite: keep what was there as a version the user can restore.
    row = _get_row(existing["id"])
    with sess._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _snapshot(conn, row, force=True)
        conn.execute(
            "UPDATE notebooks SET title = ?, style_json = ?, doc_json = ?, version = version + 1, edited = 0, "
            "generated_at = ?, updated_at = ? WHERE id = ?",
            (title, json.dumps(clean_style(style if style is not None else json.loads(row["style_json"]), kind)),
             json.dumps(doc), _now(), _now(), row["id"]),
        )
    return _to_meeting(session_id, get_notebook(row["id"]))


def _to_meeting(session_id: int, notebook: dict) -> dict:
    """The meeting this session was started from gets the notebook and its action items (never fails the notes)."""
    try:
        from . import meetings
        meetings.attach_notebook(session_id, notebook)
    except Exception as e:                       # noqa: BLE001 - the notes are written whatever happens here
        import logging
        logging.getLogger(__name__).warning("notebook: could not attach to its meeting: %s", e)
    return notebook


# ── Written automatically when a lecture or meeting ends (decision 184-1) ───────
#
# Skipped under five minutes or 300 words (nothing worth paying for), and when the
# user has turned it off in Settings. Over two hours it doesn't write: it works out
# what the notes would cost and waits for the user to say yes (decision 184-4). It
# runs in the background, so closing the session window loses nothing.

AUTO_MIN_SECONDS = 5 * 60
AUTO_MIN_WORDS = 300
AUTO_ASK_SECONDS = 2 * 60 * 60

_AUTO: dict[int, dict] = {}         # session_id -> {"state": writing|done|failed|skipped|ask, ...}
_AUTO_TASKS: set = set()


def auto_enabled() -> bool:
    from .core.config import load_config
    return load_config().get("notebook_auto", True) is not False


def _session_shape(session_id: int) -> tuple[list[dict], int, int]:
    lines = transcript(session_id)
    seconds = lines[-1]["t"] if lines else 0
    words = sum(len(line["text"].split()) for line in lines)
    return lines, seconds, words


def estimate_for_session(session_id: int) -> dict:
    """What writing this session's notebook would take, before anything is spent."""
    from .core import costs, hosted
    from .errors import resolve_llm

    kind = session_kind(session_id)
    lines, seconds, words = _session_shape(session_id)
    text = _numbered(lines, kind)
    in_tokens, out_tokens = len(text) // 4 + 3000, 6000
    if len(text) > DIRECT_LIMIT:                    # condensed in parts first, then written
        parts = len(_chunks(text))
        in_tokens += len(text) // 4 + parts * 800
        out_tokens += parts * 3000
    try:
        model, _ = resolve_llm(None)
    except Exception:
        model = hosted.HOSTED_DEFAULT
    credits = None if hosted.is_admin() else hosted.credits_for(model, in_tokens, out_tokens)
    usd = costs.token_cost(model, in_tokens, out_tokens)
    return {"seconds": seconds, "words": words, "tokens": {"input": in_tokens, "output": out_tokens},
            "credits": round(credits, 2) if credits is not None else None,
            "usd": round(usd, 3) if usd is not None else None, "model": model}


def auto_status(session_id: int) -> dict:
    return _AUTO.get(session_id) or {"state": "none"}


async def start_auto(session_id: int, style: Any = None) -> dict:
    """Called when a lecture or meeting ends. Returns what happened (never raises for a skip)."""
    from . import entitlements

    now = _AUTO.get(session_id)
    if now and now["state"] == "writing":
        return now

    def skip(reason: str) -> dict:
        _AUTO[session_id] = {"state": "skipped", "reason": reason}
        return _AUTO[session_id]

    if not auto_enabled():
        return skip("off")
    session_kind(session_id)                       # 404 for a session that doesn't exist
    if for_session(session_id) is not None:
        return skip("exists")
    if not entitlements.allows("notebook"):
        return skip("pro")
    _lines, seconds, words = _session_shape(session_id)
    if seconds < AUTO_MIN_SECONDS or words < AUTO_MIN_WORDS:
        return skip("short")
    if seconds > AUTO_ASK_SECONDS:
        _AUTO[session_id] = {"state": "ask", "estimate": estimate_for_session(session_id)}
        return _AUTO[session_id]

    _AUTO[session_id] = {"state": "writing"}

    async def write() -> None:
        from .errors import FriendlyError
        try:
            made = await generate_for_session(session_id, style=style)
            _AUTO[session_id] = {"state": "done", "notebook_id": made["id"]}
        except HTTPException as e:
            detail = e.detail if isinstance(e.detail, dict) else {"code": "unknown", "title": "The notes couldn't be made", "message": str(e.detail)}
            _AUTO[session_id] = {"state": "failed", "error": detail}
        except FriendlyError as e:
            _AUTO[session_id] = {"state": "failed", "error": e.as_dict()}
        except Exception:
            _AUTO[session_id] = {"state": "failed", "error": {"code": "unknown", "title": "The notes couldn't be made",
                                                             "message": "Try again from the Notebook tab."}}

    task = asyncio.get_running_loop().create_task(write())
    _AUTO_TASKS.add(task)
    task.add_done_callback(_AUTO_TASKS.discard)
    return _AUTO[session_id]
