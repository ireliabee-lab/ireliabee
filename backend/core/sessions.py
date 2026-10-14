"""
SQLite-backed session storage.

DB lives at ~/.local/share/cli-interview-recorder/sessions.db.

A session is a titled conversation with its full history. Messages are appended
as each turn happens (auto-save on every turn) so nothing is lost on crash.
"""
from __future__ import annotations

import os
import re
import shutil
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Optional


from .appdirs import DATA_DIR as DB_DIR
DB_PATH = DB_DIR / "sessions.db"


#: Set when startup found the database unreadable and moved it aside, so the
#: app can say so: {"moved_to": path, "reason": text}.
RECOVERED: dict = {}
#: Daily copies kept next to the database.
BACKUPS_KEPT = 3


def _files(path: Path) -> list[Path]:
    return [path, path.with_name(path.name + "-wal"), path.with_name(path.name + "-shm")]


def _tables(path: Path) -> int:
    """How many tables a database file holds. Raises if it cannot be read."""
    conn = sqlite3.connect(path)
    try:
        row = conn.execute("PRAGMA quick_check").fetchone()
        if not row or row[0] != "ok":
            raise sqlite3.DatabaseError(f"integrity check: {row[0] if row else 'no answer'}")
        return conn.execute("SELECT count(*) FROM sqlite_master WHERE type = 'table'").fetchone()[0]
    finally:
        conn.close()


def _newest_good_backup() -> "Path | None":
    """The most recent daily copy that passes its own integrity check."""
    for candidate in sorted(DB_PATH.parent.glob(f"{DB_PATH.name}.backup-*"), reverse=True):
        try:
            if _tables(candidate) > 0:
                return candidate
        except (sqlite3.Error, OSError):
            continue                     # try the one before it
    return None


def open_or_recover() -> None:
    """
    Make sure the database opens, before anything else touches it.

    A corrupt sessions.db used to stop the backend before it opened its port:
    every module that sets up its tables at import time raised, and the app
    said "the engine didn't start" for ever (audit 181-H10). An unreadable file
    is moved aside, never deleted, and the newest good daily copy is put in its
    place — or a fresh database started when there is none — so the app opens
    and says what happened.

    Only a file that is really unreadable. ``OperationalError`` is a
    ``DatabaseError`` too, and it covers "database is locked", "unable to open
    database file" and "attempt to write a readonly database" — none of which
    mean the data is damaged. Treating those as corruption renamed a perfectly
    good database and started the user with nothing: every session, notebook,
    board, story and CV gone from the app, sitting intact on disk where nothing
    would ever offer it back.
    """
    DB_DIR.mkdir(parents=True, exist_ok=True)
    release_connection()           # nothing of ours holds the file while it's checked or moved
    if DB_PATH.exists():
        reason = ""
        try:
            conn = sqlite3.connect(DB_PATH)
            try:
                result = conn.execute("PRAGMA quick_check").fetchone()
                if not result or result[0] != "ok":
                    reason = f"integrity check: {result[0] if result else 'no answer'}"
            finally:
                conn.close()
        except sqlite3.OperationalError:
            # Busy, locked, read-only, or not openable right now. The file is
            # not damaged; moving it aside would be the damage. Leave it and
            # let whatever opens it next report the real problem.
            return
        except sqlite3.DatabaseError as e:
            reason = str(e)
        if reason:
            stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
            moved = DB_PATH.with_name(f"{DB_PATH.name}.corrupt-{stamp}")
            try:
                for f in _files(DB_PATH):
                    if f.exists():
                        f.rename(f.with_name(f.name.replace(DB_PATH.name, moved.name, 1)))
            except OSError as e:
                # Cannot move it: another process has it open, or the folder is
                # read-only. Starting is still better than not starting.
                RECOVERED.update(moved_to="", reason=f"{reason} (could not be moved aside: {e})")
                return
            # A copy from this morning beats starting from nothing. Three of
            # these have been written every day and nothing has ever read one.
            restored = _newest_good_backup()
            if restored is not None:
                try:
                    shutil.copy2(restored, DB_PATH)
                    RECOVERED.update(moved_to=str(moved), reason=reason, restored_from=str(restored))
                except OSError as e:
                    RECOVERED.update(moved_to=str(moved), reason=f"{reason} (a backup could not be restored: {e})")
            else:
                RECOVERED.update(moved_to=str(moved), reason=reason)
    _daily_backup()


def _daily_backup() -> None:
    """A copy of a healthy database, once a day, keeping the last few."""
    if not DB_PATH.exists():
        return
    today = datetime.utcnow().strftime("%Y%m%d")
    target = DB_PATH.with_name(f"{DB_PATH.name}.backup-{today}")
    if target.exists():
        return
    src = dst = None
    try:
        src = sqlite3.connect(DB_PATH)
        dst = sqlite3.connect(target)
        with dst:
            src.backup(dst)
    except (sqlite3.Error, OSError):
        # A full disk raises OSError, not sqlite3.Error, and the half-written
        # copy then could not be removed while it was still open — so the
        # first launch of the day on a full disk stopped the app from starting
        # at all. A missing backup is not worth that.
        pass
    finally:
        for conn in (src, dst):
            if conn is not None:
                try:
                    conn.close()
                except sqlite3.Error:
                    pass
    # Keep no copy we would not be willing to restore from. An empty file is a
    # perfectly valid empty database, so "it opens" is not enough — a copy that
    # died halfway through passes that and would come back later as an app with
    # nothing in it.
    try:
        if _tables(target) < _tables(DB_PATH):
            raise sqlite3.DatabaseError("the copy came out short")
    except (sqlite3.Error, OSError):
        try:
            target.unlink(missing_ok=True)
        except OSError:
            pass
        return
    old = sorted(DB_PATH.parent.glob(f"{DB_PATH.name}.backup-*"))
    for extra in old[:-BACKUPS_KEPT]:
        extra.unlink(missing_ok=True)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    mode         TEXT NOT NULL,
    llm_provider TEXT,
    llm_model    TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    role       TEXT NOT NULL,   -- 'user' | 'assistant'
    speaker    TEXT,            -- 'you' | 'interviewer' | 'unknown' | NULL for assistant
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
"""


class _Conn(sqlite3.Connection):
    """A connection that knows whether a `with` block is using it (see _connect)."""
    depth = 0

    def __enter__(self):
        self.depth += 1
        return super().__enter__()

    def __exit__(self, *exc):
        try:
            return super().__exit__(*exc)
        finally:
            self.depth -= 1

    def close(self):
        # The thread's kept connection stays open for the next caller; like a real
        # close, anything left uncommitted is dropped.
        if getattr(_local, "conn", None) is self:
            if self.in_transaction:
                self.rollback()
            return
        super().close()


def _open(path: str) -> _Conn:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=5, factory=_Conn)
    conn.row_factory = sqlite3.Row
    # WAL survives a crash mid-write far better than the default journal and
    # lets the audio pumps read while a turn is written; busy_timeout waits
    # for a lock rather than failing a turn with "database is locked".
    # synchronous=NORMAL is WAL's recommended setting: a power cut can lose the
    # last moment of writes but never corrupts the file, and a commit no longer
    # waits for the disk.
    conn.execute("PRAGMA busy_timeout = 5000")
    if not _is_wal(path):               # the mode is kept in the file; setting it again costs ~15 ms
        conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    # Connections now stay open, so SQLite never deletes the WAL file on the last
    # close; without a limit it would stay as big as the biggest write (a 200 MB
    # PDF upload) until the app restarts. Trimmed back after each checkpoint.
    conn.execute("PRAGMA journal_size_limit = 16777216")
    conn.executescript(_SCHEMA)
    return conn


_local = threading.local()


def _is_wal(path: str) -> bool:
    """Whether the file on disk is already in WAL mode (header bytes 18-19 are 2)."""
    try:
        with open(path, "rb") as f:
            head = f.read(20)
    except OSError:
        return False
    return len(head) == 20 and head[18] == 2 and head[19] == 2


def _file_id(path: str):
    try:
        return os.stat(path).st_ino
    except OSError:
        return None


def _connect() -> sqlite3.Connection:
    """A connection to the sessions database, for a `with` block.

    Opening one used to cost ~15 ms on Windows (setting WAL on every open, then a
    WAL checkpoint when it closed); a coach turn opens a dozen. So each thread
    keeps one, set up once, and gets it back each time. A block that asks while
    its thread's connection is already in use further up the stack gets a
    separate one, as before, so nested blocks keep their own transactions. A
    moved or replaced database file is noticed and reopened.
    """
    path = str(DB_PATH)
    key = (path, _file_id(path))
    conn = getattr(_local, "conn", None)
    if conn is not None and conn.depth:
        return _open(path)
    if conn is not None and getattr(_local, "key", None) == key and key[1] is not None:
        if conn.in_transaction:          # left open by someone who never finished: as a close would have
            conn.rollback()
        return conn
    release_connection()
    conn = _open(path)
    _local.conn, _local.key = conn, (path, _file_id(path))
    return conn


def release_connection() -> None:
    """Close this thread's kept connection (before the database file is checked or moved)."""
    conn = getattr(_local, "conn", None)
    _local.conn = None
    if conn is not None:
        try:
            sqlite3.Connection.close(conn)
        except sqlite3.Error:
            pass


def create_session(title: str, mode: str,
                   llm_provider: str = "", llm_model: str = "") -> int:
    now = datetime.utcnow().isoformat(timespec="seconds")
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO sessions (title, mode, llm_provider, llm_model, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (title, mode, llm_provider, llm_model, now, now),
        )
        return cur.lastrowid


def rename_session(session_id: int, new_title: str):
    with _connect() as conn:
        conn.execute(
            "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
            (new_title, datetime.utcnow().isoformat(timespec="seconds"), session_id),
        )


def delete_session(session_id: int):
    with _connect() as conn:
        conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        # Its notebook stays: those are the user's notes, often edited for hours,
        # just as deleting a document keeps the decks made from it. It only stops
        # pointing at the recording, which is gone. The table exists once
        # backend/notebook.py has loaded; before then there is nothing to keep.
        try:
            conn.execute("UPDATE notebooks SET session_id = NULL WHERE session_id = ?", (session_id,))
        except sqlite3.OperationalError:
            pass
        # Translations of its lines (backend/transcript_translate.py) go with them.
        try:
            conn.execute("DELETE FROM message_translations WHERE session_id = ?", (session_id,))
        except sqlite3.OperationalError:
            pass


def append_message(session_id: int, role: str, content: str, speaker: Optional[str] = None):
    now = datetime.utcnow().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute(
            "INSERT INTO messages (session_id, role, speaker, content, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (session_id, role, speaker, content, now),
        )
        conn.execute(
            "UPDATE sessions SET updated_at = ? WHERE id = ?",
            (now, session_id),
        )


def _squash(text: str) -> str:
    return " ".join(text.split())


def delete_superseded_exchange(session_id: int, question: str) -> bool:
    """
    A speaker carried on talking and `question` is the whole thing, asked
    again. Remove the answer to its earlier part: the most recent user message
    (tags like "[INTERVIEWER] [§1: …]" stripped) if `question` starts with it,
    plus the assistant reply after it. Only the most recent question is
    considered — nobody else spoke in between, so older turns are never touched.
    """
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, role, content FROM messages WHERE session_id = ? "
            "ORDER BY id DESC LIMIT 20",
            (session_id,),
        ).fetchall()
        # rows are newest first: the user message, then the reply after it
        for i, row in enumerate(rows):
            if row["role"] != "user":
                continue
            asked = _squash(re.sub(r"^(\[[^\]]*\]\s*)+", "", row["content"]))
            if not asked or not _squash(question).startswith(asked):
                return False
            ids = [row["id"]]
            if i > 0 and rows[i - 1]["role"] == "assistant":
                ids.append(rows[i - 1]["id"])
            conn.execute(f"DELETE FROM messages WHERE id IN ({','.join('?' * len(ids))})", ids)
            return True
    return False


def list_sessions(limit: int = 20) -> list[sqlite3.Row]:
    with _connect() as conn:
        cur = conn.execute(
            "SELECT s.id, s.title, s.mode, s.llm_provider, s.llm_model, "
            "       s.created_at, s.updated_at, "
            "       (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS turns "
            "FROM sessions s ORDER BY s.updated_at DESC LIMIT ?",
            (limit,),
        )
        return cur.fetchall()


def load_messages(session_id: int) -> list[dict]:
    """Return messages in the {role, content} shape LLMs expect."""
    with _connect() as conn:
        cur = conn.execute(
            "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        )
        return [{"role": r["role"], "content": r["content"]} for r in cur.fetchall()]


def get_session(session_id: int) -> Optional[sqlite3.Row]:
    with _connect() as conn:
        cur = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        return cur.fetchone()
