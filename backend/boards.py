"""
Idea boards: sticky notes on a cork wall.

For the thinking that happens before there is a plan — a student breaking a
topic apart, an engineer sketching an approach, anyone with more ideas than
order. One thought per note, moved around by hand, pinned where it belongs.

Everything saves as it is typed or dragged; there is no Save button and nothing
to lose. Notes are the user's own words: nothing here is written by the AI.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import HTTPException

from .core import sessions as sess

#: The paper a note is written on.
COLOURS = ("yellow", "green", "blue", "pink", "orange", "white", "lined")
#: The pin holding it up.
PINS = ("red", "blue", "green", "yellow", "pink", "white")

LIMITS = {"title": 120, "text": 2000, "boards": 200, "notes": 500}
#: The wall's size in points; a note lives somewhere on it.
WALL = 12000
NOTE_MIN, NOTE_MAX = 120, 900
#: How far a note can be turned either way; a note is straightened back to 0.
ROT_MAX = 180
NOTE_SIZE = (220, 200)
#: Where a dropped note settles when the board snaps to its grid. The app uses
#: the same step, so a note sits in the same place wherever it is arranged.
GRID = 20


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _ensure_schema() -> None:
    with sess._connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS boards (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                title      TEXT NOT NULL,
                snap       INTEGER NOT NULL DEFAULT 1,   -- notes settle onto the grid
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS board_notes (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                board_id   INTEGER NOT NULL,
                text       TEXT NOT NULL,
                colour     TEXT NOT NULL,
                pin        TEXT NOT NULL,
                x          REAL NOT NULL,
                y          REAL NOT NULL,
                w          REAL NOT NULL,
                h          REAL NOT NULL,
                z          INTEGER NOT NULL,             -- which note is on top
                rot        REAL NOT NULL DEFAULT 0,       -- how it hangs on its pin, in degrees
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(board_id) REFERENCES boards(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_board_notes_board ON board_notes(board_id);
            CREATE INDEX IF NOT EXISTS idx_boards_updated ON boards(updated_at);
            """
        )


def _ensure_columns() -> None:
    """Boards made before a note could be turned on its pin, or scheduled as a meeting."""
    with sess._connect() as conn:
        have = {r[1] for r in conn.execute("PRAGMA table_info(board_notes)")}
        if "rot" not in have:
            conn.execute("ALTER TABLE board_notes ADD COLUMN rot REAL NOT NULL DEFAULT 0")
        if "event_id" not in have:        # the meeting made from this note (backend/meetings.py)
            conn.execute("ALTER TABLE board_notes ADD COLUMN event_id INTEGER")


_ensure_schema()
_ensure_columns()


# ── Cleaning what comes in ───────────────────────────────────────────────────

def _s(value: Any, limit: int) -> str:
    """A name: trimmed, because a board called " " is a mistake."""
    return str(value).strip()[:limit] if isinstance(value, (str, int, float)) else ""


def _note_text(value: Any, limit: int = LIMITS["text"]) -> str:
    """
    What is written on a note, kept as it was written.

    Line breaks and the space at the end of a half-typed word are the user's;
    trimming them mid-sentence pulled the words back under their own cursor.
    Only the length is enforced.
    """
    return str(value)[:limit] if isinstance(value, (str, int, float)) else ""


def _num(value: Any, low: float, high: float, fallback: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    if n != n or n in (float("inf"), float("-inf")):      # NaN, infinity
        return fallback
    return round(min(high, max(low, n)), 2)


def _one_of(value: Any, allowed: tuple[str, ...]) -> str:
    return value if isinstance(value, str) and value in allowed else allowed[0]


def _row_to_note(row, meetings: Optional[dict] = None) -> dict:
    note = {
        "id": row["id"], "text": row["text"], "colour": row["colour"], "pin": row["pin"],
        "x": row["x"], "y": row["y"], "w": row["w"], "h": row["h"], "z": row["z"], "rot": row["rot"],
        "created_at": row["created_at"], "updated_at": row["updated_at"],
        "event_id": row["event_id"] if "event_id" in row.keys() else None,
    }
    if note["event_id"]:
        note["meeting"] = (meetings if meetings is not None else _meetings([note["event_id"]])).get(note["event_id"])
    return note


def _meetings(ids: list) -> dict:
    """When and what the meetings made from notes are, for the date on each note."""
    ids = [i for i in ids if i]
    if not ids:
        return {}
    with sess._connect() as conn:
        rows = conn.execute(f"SELECT id, title, start, timezone FROM calendar_events WHERE id IN ({','.join('?' * len(ids))})",
                            ids).fetchall()
    return {r["id"]: {"title": r["title"], "start": r["start"], "timezone": r["timezone"]} for r in rows}


# ── Boards ───────────────────────────────────────────────────────────────────

def create_board(title: str = "") -> dict:
    now = _now()
    with sess._connect() as conn:
        cur = conn.execute("INSERT INTO boards (title, snap, created_at, updated_at) VALUES (?, 1, ?, ?)",
                           (_s(title, LIMITS["title"]) or "Untitled board", now, now))
        board_id = cur.lastrowid
    return get_board(board_id)


def list_boards(q: Optional[str] = None, limit: int = LIMITS["boards"]) -> list[dict]:
    """Every board, newest first, with how many notes it holds and a few of their words."""
    sql = ("SELECT b.id, b.title, b.snap, b.created_at, b.updated_at, "
           "       COUNT(n.id) AS notes, "
           "       (SELECT group_concat(substr(t.text, 1, 60), ' · ') FROM "
           "           (SELECT text FROM board_notes WHERE board_id = b.id AND text <> '' "
           "            ORDER BY updated_at DESC LIMIT 4) t) AS preview "
           "FROM boards b LEFT JOIN board_notes n ON n.board_id = b.id ")
    args: list = []
    needle = (q or "").strip()[:100].lower()
    # SQLite's lower() only knows ASCII, and LIKE reads % and _ as wildcards. A
    # plain-ASCII search is narrowed in SQL (wildcards escaped); anything else is
    # matched below in Python, which folds case in every language.
    if needle and needle.isascii():
        like = "%" + needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        sql += ("WHERE lower(b.title) LIKE ? ESCAPE '\\' OR EXISTS "
                "(SELECT 1 FROM board_notes m WHERE m.board_id = b.id "
                "AND lower(m.text) LIKE ? ESCAPE '\\') ")
        args += [like, like]
    sql += "GROUP BY b.id ORDER BY b.updated_at DESC LIMIT ?"
    args.append(max(1, min(limit, LIMITS["boards"])))
    with sess._connect() as conn:
        rows = conn.execute(sql, args).fetchall()
        out = [{"id": r["id"], "title": r["title"], "snap": bool(r["snap"]), "notes": r["notes"],
                "preview": r["preview"] or "", "created_at": r["created_at"], "updated_at": r["updated_at"]}
               for r in rows]
        if needle and not needle.isascii():
            ids = [b["id"] for b in out]
            notes: dict = {}
            if ids:
                for r in conn.execute(
                    f"SELECT board_id, text FROM board_notes WHERE board_id IN ({','.join('?' * len(ids))})", ids):
                    notes.setdefault(r["board_id"], []).append(r["text"])
            out = [b for b in out
                   if needle in b["title"].lower() or any(needle in t.lower() for t in notes.get(b["id"], ()))]
    return out


def get_board(board_id: int) -> dict:
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Board not found")
        notes = conn.execute("SELECT * FROM board_notes WHERE board_id = ? ORDER BY z, id", (board_id,)).fetchall()
    meetings = _meetings([n["event_id"] for n in notes])
    return {"id": row["id"], "title": row["title"], "snap": bool(row["snap"]),
            "created_at": row["created_at"], "updated_at": row["updated_at"],
            "notes": [_row_to_note(n, meetings) for n in notes]}


def update_board(board_id: int, title: Optional[str] = None, snap: Optional[bool] = None) -> dict:
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Board not found")
        conn.execute(
            "UPDATE boards SET title = ?, snap = ?, updated_at = ? WHERE id = ?",
            (row["title"] if title is None else (_s(title, LIMITS["title"]) or "Untitled board"),
             row["snap"] if snap is None else (1 if snap else 0), _now(), board_id),
        )
    return get_board(board_id)


def delete_board(board_id: int) -> dict:
    with sess._connect() as conn:
        if conn.execute("SELECT 1 FROM boards WHERE id = ?", (board_id,)).fetchone() is None:
            raise HTTPException(404, "Board not found")
        conn.execute("DELETE FROM board_notes WHERE board_id = ?", (board_id,))
        conn.execute("DELETE FROM boards WHERE id = ?", (board_id,))
    return {"ok": True}


# ── Notes ────────────────────────────────────────────────────────────────────

def _touch(conn, board_id: int) -> None:
    conn.execute("UPDATE boards SET updated_at = ? WHERE id = ?", (_now(), board_id))


def add_note(board_id: int, note: Any = None) -> dict:
    raw = note if isinstance(note, dict) else {}
    now = _now()
    with sess._connect() as conn:
        if conn.execute("SELECT 1 FROM boards WHERE id = ?", (board_id,)).fetchone() is None:
            raise HTTPException(404, "Board not found")
        count = conn.execute("SELECT COUNT(*) FROM board_notes WHERE board_id = ?", (board_id,)).fetchone()[0]
        if count >= LIMITS["notes"]:
            raise HTTPException(400, {
                "code": "full", "title": "This board is full",
                "message": f"A board holds {LIMITS['notes']} notes. Start another board for the rest.",
            })
        top = conn.execute("SELECT COALESCE(MAX(z), 0) FROM board_notes WHERE board_id = ?", (board_id,)).fetchone()[0]
        cur = conn.execute(
            "INSERT INTO board_notes (board_id, text, colour, pin, x, y, w, h, z, rot, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (board_id, _note_text(raw.get("text")), _one_of(raw.get("colour"), COLOURS),
             _one_of(raw.get("pin"), PINS),
             _num(raw.get("x"), 0, WALL, 40), _num(raw.get("y"), 0, WALL, 40),
             _num(raw.get("w"), NOTE_MIN, NOTE_MAX, NOTE_SIZE[0]), _num(raw.get("h"), NOTE_MIN, NOTE_MAX, NOTE_SIZE[1]),
             top + 1, _num(raw.get("rot"), -ROT_MAX, ROT_MAX, 0), now, now),
        )
        note_id = cur.lastrowid
        _touch(conn, board_id)
        row = conn.execute("SELECT * FROM board_notes WHERE id = ?", (note_id,)).fetchone()
    return _row_to_note(row)


def update_note(board_id: int, note_id: int, patch: Any) -> dict:
    """Change one note. Only the fields given are touched, so typing and dragging don't fight."""
    raw = patch if isinstance(patch, dict) else {}
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM board_notes WHERE id = ? AND board_id = ?", (note_id, board_id)).fetchone()
        if row is None:
            raise HTTPException(404, "Note not found")
        values = {
            "text": _note_text(raw["text"]) if "text" in raw else row["text"],
            "colour": _one_of(raw["colour"], COLOURS) if "colour" in raw else row["colour"],
            "pin": _one_of(raw["pin"], PINS) if "pin" in raw else row["pin"],
            "x": _num(raw["x"], 0, WALL, row["x"]) if "x" in raw else row["x"],
            "y": _num(raw["y"], 0, WALL, row["y"]) if "y" in raw else row["y"],
            "w": _num(raw["w"], NOTE_MIN, NOTE_MAX, row["w"]) if "w" in raw else row["w"],
            "h": _num(raw["h"], NOTE_MIN, NOTE_MAX, row["h"]) if "h" in raw else row["h"],
            "rot": _num(raw["rot"], -ROT_MAX, ROT_MAX, row["rot"]) if "rot" in raw else row["rot"],
        }
        if raw.get("front"):                   # brought to the front by a drag or a click
            top = conn.execute("SELECT COALESCE(MAX(z), 0) FROM board_notes WHERE board_id = ?", (board_id,)).fetchone()[0]
            values["z"] = top + 1 if row["z"] != top else row["z"]
        conn.execute(
            "UPDATE board_notes SET text = ?, colour = ?, pin = ?, x = ?, y = ?, w = ?, h = ?, z = ?, rot = ?, "
            "updated_at = ? WHERE id = ?",
            (values["text"], values["colour"], values["pin"], values["x"], values["y"], values["w"], values["h"],
             values.get("z", row["z"]), values["rot"], _now(), note_id),
        )
        _touch(conn, board_id)
        fresh = conn.execute("SELECT * FROM board_notes WHERE id = ?", (note_id,)).fetchone()
    return _row_to_note(fresh)


def move_notes(board_id: int, moves: Any) -> list[dict]:
    """Where several notes ended up, in one go (dragging a selection)."""
    wanted = [m for m in (moves if isinstance(moves, list) else []) if isinstance(m, dict)]
    if not wanted:
        return []
    now = _now()
    with sess._connect() as conn:
        rows = {r["id"]: r for r in conn.execute("SELECT * FROM board_notes WHERE board_id = ?", (board_id,))}
        for m in wanted:
            row = rows.get(m.get("id"))
            if row is None:
                continue
            conn.execute("UPDATE board_notes SET x = ?, y = ?, z = ?, updated_at = ? WHERE id = ?",
                         (_num(m.get("x"), 0, WALL, row["x"]), _num(m.get("y"), 0, WALL, row["y"]),
                          int(m["z"]) if isinstance(m.get("z"), int) else row["z"], now, row["id"]))
        _touch(conn, board_id)
        fresh = conn.execute("SELECT * FROM board_notes WHERE board_id = ? AND id IN (%s)"
                             % ",".join("?" * len(wanted)),
                             (board_id, *[m.get("id") for m in wanted])).fetchall()
    return [_row_to_note(r) for r in fresh]


def delete_note(board_id: int, note_id: int) -> dict:
    with sess._connect() as conn:
        row = conn.execute("SELECT 1 FROM board_notes WHERE id = ? AND board_id = ?", (note_id, board_id)).fetchone()
        if row is None:
            raise HTTPException(404, "Note not found")
        conn.execute("DELETE FROM board_notes WHERE id = ?", (note_id,))
        _touch(conn, board_id)
    return {"ok": True}


# ── A note as a meeting ──────────────────────────────────────────────────────

def meeting_from_text(text: str) -> dict:
    """A note's first line is the meeting's title; the lines after it are its topics."""
    lines = [ln.strip(" \t-•*") for ln in (text or "").splitlines()]
    lines = [ln for ln in lines if ln]
    return {"title": (lines[0] if lines else "")[:200], "topics": lines[1:21]}


def schedule_note(board_id: int, note_id: int, meeting: Any) -> dict:
    """Make (or change) the meeting for a note. Returns the note, now carrying its meeting."""
    from . import meetings                       # the calendar's module; imported here to keep boards light
    raw = meeting if isinstance(meeting, dict) else {}
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM board_notes WHERE id = ? AND board_id = ?", (note_id, board_id)).fetchone()
        if row is None:
            raise HTTPException(404, "Note not found")
    from_note = meeting_from_text(row["text"])
    body = {**{k: v for k, v in from_note.items() if v}, **raw, "note_id": note_id}
    if row["event_id"]:
        try:
            meetings.update_meeting(row["event_id"], body)
            event_id = row["event_id"]
        except Exception:                        # the meeting was deleted in the calendar: make a new one
            event_id = meetings.create_meeting(body)["id"]
    else:
        event_id = meetings.create_meeting(body)["id"]
    with sess._connect() as conn:
        conn.execute("UPDATE board_notes SET event_id = ?, updated_at = ? WHERE id = ?", (event_id, _now(), note_id))
        _touch(conn, board_id)
        fresh = conn.execute("SELECT * FROM board_notes WHERE id = ?", (note_id,)).fetchone()
    return _row_to_note(fresh)


def unschedule_note(board_id: int, note_id: int, delete_meeting: bool = False) -> dict:
    """Unlink a note from its meeting (and, if asked, delete the meeting too)."""
    from . import meetings
    with sess._connect() as conn:
        row = conn.execute("SELECT * FROM board_notes WHERE id = ? AND board_id = ?", (note_id, board_id)).fetchone()
        if row is None:
            raise HTTPException(404, "Note not found")
    if delete_meeting and row["event_id"]:
        try:
            meetings.delete_meeting(row["event_id"])
        except Exception:
            pass
    with sess._connect() as conn:
        conn.execute("UPDATE board_notes SET event_id = NULL, updated_at = ? WHERE id = ?", (_now(), note_id))
        _touch(conn, board_id)
        fresh = conn.execute("SELECT * FROM board_notes WHERE id = ?", (note_id,)).fetchone()
    return _row_to_note(fresh)
