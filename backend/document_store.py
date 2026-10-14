"""
CVs & Documents storage — desktop-only, uses the CLI's sessions DB.

Two tables:
  cvs        — candidate CVs / resumes; one can be flagged is_active.
  documents  — arbitrary reference material attached to sessions (job specs,
               research briefs, etc.). No is_active — attached per-session.

Both hold:
  original bytes (BLOB) + extracted plain text (TEXT).
Only the extracted text is fed to the LLM; the original bytes let us re-download.

Supported types on upload: .txt, .md, .pdf.
"""
from __future__ import annotations

import io
import json
import sqlite3
from datetime import datetime
from typing import Optional

from .core.sessions import _connect


def _ensure_schema():
    with _connect() as conn:
        # An earlier build indexed the preview expression, which blocks blob writes: replace it.
        old = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_documents_meta'").fetchone()
        if old and "substr" in (old[0] or ""):
            conn.execute("DROP INDEX idx_documents_meta")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS cvs (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                name               TEXT NOT NULL,
                original_filename  TEXT NOT NULL,
                mime               TEXT NOT NULL,
                content            BLOB NOT NULL,
                extracted_text     TEXT NOT NULL,
                is_active          INTEGER NOT NULL DEFAULT 0,
                created_at         TEXT NOT NULL,
                updated_at         TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS documents (
                id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                name               TEXT NOT NULL,
                original_filename  TEXT NOT NULL,
                mime               TEXT NOT NULL,
                content            BLOB NOT NULL,
                extracted_text     TEXT NOT NULL,
                created_at         TEXT NOT NULL,
                updated_at         TEXT NOT NULL
            );
            -- The file sits before the dates in each row, and SQLite reaches a column
            -- by walking through the ones before it: listing the Library read every
            -- stored PDF (up to 200 MB each) to get at the dates. These indexes hold
            -- what a list or a lookup shows, so neither touches the files.
            --
            -- Documents: a plain index, plus the 201-character preview in a table of
            -- its own that triggers keep in step. (An index on an expression would be
            -- simpler, but SQLite then refuses to open any column of the table for
            -- writing as a blob, which is how reading.py stores big files.)
            CREATE INDEX IF NOT EXISTS idx_documents_meta ON documents
                (id, name, original_filename, mime, created_at, updated_at);
            CREATE TABLE IF NOT EXISTS document_sources (
                document_id INTEGER PRIMARY KEY,
                metadata TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS document_source_gone AFTER DELETE ON documents BEGIN
                DELETE FROM document_sources WHERE document_id = old.id;
            END;
            CREATE TABLE IF NOT EXISTS document_previews (
                document_id INTEGER PRIMARY KEY,
                preview     TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS document_preview_add AFTER INSERT ON documents BEGIN
                INSERT OR REPLACE INTO document_previews (document_id, preview)
                VALUES (new.id, substr(new.extracted_text, 1, 201));
            END;
            CREATE TRIGGER IF NOT EXISTS document_preview_text AFTER UPDATE OF extracted_text ON documents BEGIN
                INSERT OR REPLACE INTO document_previews (document_id, preview)
                VALUES (new.id, substr(new.extracted_text, 1, 201));
            END;
            CREATE TRIGGER IF NOT EXISTS document_preview_gone AFTER DELETE ON documents BEGIN
                DELETE FROM document_previews WHERE document_id = old.id;
            END;
            -- Documents stored before this existed get their preview once.
            INSERT OR IGNORE INTO document_previews (document_id, preview)
                SELECT id, substr(extracted_text, 1, 201) FROM documents
                WHERE id NOT IN (SELECT document_id FROM document_previews);
            -- CVs: nothing writes their files as blobs, so the preview can sit in the
            -- index itself. (Keep it that way, or move it out as for documents.)
            CREATE INDEX IF NOT EXISTS idx_cvs_meta ON cvs
                (id, name, original_filename, mime, is_active, created_at, updated_at, substr(extracted_text, 1, 201));
            """
        )


_ensure_schema()


# ── Text extraction ──────────────────────────────────────────────────────────

#: The last PDF read while checking an upload, so storing it doesn't read it again
#: (a big PDF takes seconds). Taken, not kept: one entry, dropped on use.
_checked: dict = {}


def extract_text(filename: str, mime: str, data: bytes) -> str:
    """Best-effort text extraction. Returns "" if not supported."""
    hit = _checked.pop("pdf", None)
    if hit is not None and hit[0] is data:
        return hit[1]
    text = _extract_text(filename, mime, data)
    return text


def remember_checked(data: bytes, text: str) -> None:
    """An upload's text, just extracted to check it; the store call that follows reuses it."""
    _checked["pdf"] = (data, text)


def _extract_text(filename: str, mime: str, data: bytes) -> str:
    lower = filename.lower()
    if lower.endswith(".pdf") or "pdf" in (mime or ""):
        try:
            import pypdf
            reader = pypdf.PdfReader(io.BytesIO(data))
            parts: list[str] = []
            for page in reader.pages:
                try:
                    parts.append(page.extract_text() or "")
                except Exception:
                    continue
            return "\n\n".join(p.strip() for p in parts if p.strip())
        except Exception:
            return ""
    # text-like: .txt, .md, .html, .json, .csv — try decoding
    for enc in ("utf-8", "latin-1"):
        try:
            return data.decode(enc, errors="ignore")
        except Exception:
            continue
    return ""


# ── CVs ───────────────────────────────────────────────────────────────────────

def _row_to_dict(row: sqlite3.Row, include_content: bool = False) -> dict:
    d = dict(row)
    if "source" in d:
        d["source"] = json.loads(d["source"]) if d["source"] else None
    if not include_content:
        d.pop("content", None)
        # Also trim extracted_text preview
        if "extracted_text" in d and d["extracted_text"]:
            preview = d["extracted_text"][:200]
            d["extracted_text_preview"] = preview + ("…" if len(d["extracted_text"]) > 200 else "")
            del d["extracted_text"]
    return d


def create_cv(name: str, original_filename: str, mime: str, content: bytes) -> int:
    text = extract_text(original_filename, mime, content)
    now = datetime.utcnow().isoformat(timespec="seconds")
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO cvs (name, original_filename, mime, content, extracted_text, is_active, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
            (name, original_filename, mime, content, text, now, now),
        )
        return cur.lastrowid


#: A CV's details without its file (what lists and lookups show); matches idx_cvs_meta.
_CV_META = ("id, name, original_filename, mime, substr(extracted_text, 1, 201) AS extracted_text, "
            "is_active, created_at, updated_at")


def list_cvs() -> list[dict]:
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            # INDEXED BY, like the documents list: without it, whether the
            # planner picks the covering index is up to the SQLite version.
            f"SELECT {_CV_META} FROM cvs INDEXED BY idx_cvs_meta "
            "ORDER BY is_active DESC, updated_at DESC"
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def get_cv(cv_id: int, include_content: bool = False) -> Optional[dict]:
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        sql = "SELECT * FROM cvs WHERE id = ?" if include_content else \
            f"SELECT {_CV_META} FROM cvs INDEXED BY idx_cvs_meta WHERE id = ?"
        row = conn.execute(sql, (cv_id,)).fetchone()
        return _row_to_dict(row, include_content) if row else None


def get_cv_text(cv_id: int) -> str:
    with _connect() as conn:
        row = conn.execute("SELECT extracted_text FROM cvs WHERE id = ?", (cv_id,)).fetchone()
        return row[0] if row else ""


def get_active_cv_text() -> str:
    with _connect() as conn:
        row = conn.execute("SELECT extracted_text FROM cvs WHERE is_active = 1 LIMIT 1").fetchone()
        return row[0] if row else ""


def activate_cv(cv_id: int) -> None:
    now = datetime.utcnow().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute("UPDATE cvs SET is_active = 0")
        conn.execute("UPDATE cvs SET is_active = 1, updated_at = ? WHERE id = ?", (now, cv_id))


def rename_cv(cv_id: int, name: str) -> None:
    now = datetime.utcnow().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute("UPDATE cvs SET name = ?, updated_at = ? WHERE id = ?", (name, now, cv_id))


def delete_cv(cv_id: int) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM cvs WHERE id = ?", (cv_id,))


# ── Documents ────────────────────────────────────────────────────────────────

def create_document(name: str, original_filename: str, mime: str, content: bytes) -> int:
    text = extract_text(original_filename, mime, content)
    now = datetime.utcnow().isoformat(timespec="seconds")
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO documents (name, original_filename, mime, content, extracted_text, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (name, original_filename, mime, content, text, now, now),
        )
        return cur.lastrowid


# Everything but the file itself: a book can be 150 MB, and listing the Library
# or looking one up must not read every file's bytes only to throw them away.
# The text only as far as the Library's 200-character preview needs (a book's is up to 5 MB).
#: A document's details without its file or full text (what lists and lookups show).
_DOC_META = ("d.id, d.name, d.original_filename, d.mime, p.preview AS extracted_text, d.created_at, d.updated_at, s.metadata AS source")
_DOC_FROM = ("documents d INDEXED BY idx_documents_meta "
             "LEFT JOIN document_previews p ON p.document_id = d.id "
             "LEFT JOIN document_sources s ON s.document_id = d.id")


def list_documents() -> list[dict]:
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(f"SELECT {_DOC_META} FROM {_DOC_FROM} ORDER BY d.updated_at DESC").fetchall()
        return [_row_to_dict(r) for r in rows]


def get_document(doc_id: int, include_content: bool = False) -> Optional[dict]:
    sql = "SELECT d.*, s.metadata AS source FROM documents d LEFT JOIN document_sources s ON s.document_id = d.id WHERE d.id = ?" if include_content else \
        f"SELECT {_DOC_META} FROM {_DOC_FROM} WHERE d.id = ?"
    with _connect() as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(sql, (doc_id,)).fetchone()
        return _row_to_dict(row, include_content) if row else None


def get_document_text(doc_id: int) -> str:
    with _connect() as conn:
        row = conn.execute("SELECT extracted_text FROM documents WHERE id = ?", (doc_id,)).fetchone()
        return row[0] if row else ""


def rename_document(doc_id: int, name: str) -> None:
    now = datetime.utcnow().isoformat(timespec="seconds")
    with _connect() as conn:
        conn.execute("UPDATE documents SET name = ?, updated_at = ? WHERE id = ?", (name, now, doc_id))


def delete_document(doc_id: int) -> None:
    # Imported before the transaction: a first import sets up reading's tables on its
    # own connection, which would wait (5 s, twice) for this one's write lock.
    from .reading import forget_document
    with _connect() as conn:
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        try:
            forget_document(conn, doc_id)      # its pages, outline and cached reading; the notes stay
        except sqlite3.OperationalError:
            pass


def document_size(doc_id: int) -> Optional[int]:
    with _connect() as conn:
        row = conn.execute("SELECT length(content) FROM documents WHERE id = ?", (doc_id,)).fetchone()
        return row[0] if row else None


def iter_document(doc_id: int, chunk: int = 1024 * 1024):
    """A document's bytes in pieces, so a 150 MB book is never held in memory whole.

    Its own connection, allowed across threads: a streamed response reads each piece
    on whichever worker thread is free, and the default connection refuses that.
    """
    from .core import sessions as _sess
    conn = sqlite3.connect(_sess.DB_PATH, timeout=5, check_same_thread=False)
    try:
        with conn.blobopen("documents", "content", doc_id, readonly=True) as blob:
            while data := blob.read(chunk):
                yield data
    finally:
        conn.close()


# ── Library: move a file between "my CV" and "reference file" (roadmap 1.7) ─
# CVs and reference documents stay in their own tables (everything that reads
# the active CV keeps working); the Library shows them as one list and these
# move a file from one to the other in a single transaction.

_FILE_COLUMNS = "name, original_filename, mime, content, extracted_text, created_at"


def cv_to_document(cv_id: int) -> Optional[int]:
    """Make a CV a reference file. Profiles linked to it are unlinked."""
    now = datetime.utcnow().isoformat(timespec="seconds")
    with _connect() as conn:
        if not conn.execute("SELECT 1 FROM cvs WHERE id = ?", (cv_id,)).fetchone():
            return None
        cur = conn.execute(
            f"INSERT INTO documents ({_FILE_COLUMNS}, updated_at) "
            f"SELECT {_FILE_COLUMNS}, ? FROM cvs WHERE id = ?",
            (now, cv_id),
        )
        try:
            conn.execute("UPDATE profiles SET cv_id = NULL WHERE cv_id = ?", (cv_id,))
        except sqlite3.OperationalError:
            pass  # profiles table/column not created yet
        conn.execute("DELETE FROM cvs WHERE id = ?", (cv_id,))
        return cur.lastrowid


def document_to_cv(doc_id: int) -> Optional[int]:
    """Make a reference file a CV (not activated)."""
    now = datetime.utcnow().isoformat(timespec="seconds")
    with _connect() as conn:
        if not conn.execute("SELECT 1 FROM documents WHERE id = ?", (doc_id,)).fetchone():
            return None
        cur = conn.execute(
            f"INSERT INTO cvs ({_FILE_COLUMNS}, is_active, updated_at) "
            f"SELECT {_FILE_COLUMNS}, 0, ? FROM documents WHERE id = ?",
            (now, doc_id),
        )
        conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
        try:
            from .reading import forget_document
            forget_document(conn, doc_id)      # a CV has no pages to cite
        except sqlite3.OperationalError:
            pass
        return cur.lastrowid


#: Reference files as the coach last read them: {id: ((name, text bytes, file bytes), start of the
#: stripped text, its length)}. No prompt uses more than a file's first _CONTEXT_CHARS.
_CONTEXT_CACHE: dict = {}
_CONTEXT_CHARS = 32000


def documents_context(doc_ids, budget: int = 16000, heading: str = "REFERENCE FILE") -> str:
    """Reference files as one prompt block (roadmap 2.5).

    The budget is shared fairly: every file gets an equal slice, and what a
    short file doesn't use goes to the longer ones, so one long file can't
    crowd out the rest. Unknown or empty files are skipped.
    """
    seen, ids = set(), []
    for did in doc_ids or []:
        if did not in seen:
            seen.add(did)
            ids.append(did)
    if not ids:
        return ""
    # Runs on every coach turn, and a file's text can be megabytes: each file is
    # read (and stripped) once, then again only when it changes. A document's text
    # is written once, when it is read, and never edited, so its name and the byte
    # sizes of its text and file (kept in the row's header: no walking the file)
    # tell a change. The text itself is handled exactly as before, in Python.
    with _connect() as conn:
        rows = conn.execute(
            # length(CAST(x AS BLOB)) and not octet_length(x): the latter needs
            # SQLite 3.43, Ubuntu 22.04 ships 3.37, and Python links the system
            # library on Linux while bundling a newer one on Windows — so this
            # worked here and raised "no such function" on a user's machine.
            "SELECT id, name, length(CAST(extracted_text AS BLOB)) AS size, "
            "length(CAST(content AS BLOB)) AS file "
            f"FROM documents WHERE id IN ({','.join('?' * len(ids))})", ids,
        ).fetchall()
        found = {r["id"]: r for r in rows}
        docs = []
        for did in ids:
            r = found.get(did)
            if r is None and str(did).isdigit():
                r = found.get(int(did))
            if r is None:
                continue
            key = (r["name"], r["size"], r["file"])
            hit = _CONTEXT_CACHE.get(r["id"])
            if hit is not None and hit[0] == key and budget <= _CONTEXT_CHARS:
                head, size = hit[1], hit[2]
            else:
                row = conn.execute("SELECT extracted_text FROM documents WHERE id = ?", (r["id"],)).fetchone()
                text = ((row[0] if row else "") or "").strip()
                if len(_CONTEXT_CACHE) >= 256:
                    _CONTEXT_CACHE.clear()
                _CONTEXT_CACHE[r["id"]] = (key, text[:_CONTEXT_CHARS], len(text))
                head, size = (text[:_CONTEXT_CHARS] if budget <= _CONTEXT_CHARS else text), len(text)
            if size:
                docs.append((r["name"] or f"File {did}", head, size))
    if not docs:
        return ""
    remaining, left, parts = budget, len(docs), []
    for name, text, size in sorted(docs, key=lambda d: d[2]):  # shortest first, so leftovers roll forward
        share = remaining // left
        chunk = text[:share]
        if size > share:
            chunk = chunk.rstrip() + "\n[…file continues — trimmed to fit]"
        parts.append((name, chunk))
        remaining -= min(size, share)
        left -= 1
    order = {name: i for i, (name, _, _) in enumerate(docs)}
    parts.sort(key=lambda p: order[p[0]])
    return "\n\n".join(f"{heading}: {name}\n{chunk}" for name, chunk in parts)
