"""
Reading notes (product spec 185): a research paper or a whole book becomes a
deck of notebook slides that covers every important point and says which page
each one came from.

The pipeline, and why each step is there:

1. **Upload, streamed.** A textbook can be 150 MB. The file is copied to disk in
   1 MB pieces with the size checked as it goes, then written into the Library's
   own `documents` table through SQLite's incremental blob I/O — never held in
   memory whole.
2. **Read page by page, in the background.** A worker thread keeps every page's
   text separately (`document_pages`), so page ranges can be chosen and cited.
   The app stays usable: the thread yields between pages, and it can be
   cancelled. Pages whose drawing instructions are absurdly large are skipped as
   unreadable instead of hanging the job. A PDF of page images is refused, never
   summarised from nothing.
3. **Find the structure.** The PDF's own bookmarks give chapters and sections;
   without them, headings are detected ("Chapter 3", "2.1 Methods", "Abstract",
   "References"…). References, acknowledgements and appendices are marked so they
   are left out by default.
4. **Map.** The chosen pages are cut into windows of a few pages. For each, one
   model call lists *every* point with its pages and importance. These are
   cached per window and model, so a second template or a regenerated deck never
   pays for the reading twice. At most three calls run at once.
5. **Compose.** The points become slides in the chosen template, each block
   naming the points it covers.
6. **Coverage check — not left to the model.** Every core and supporting point
   that no slide names is added to a "More from …" slide, with its pages. The
   deck records how many the model covered itself and how many the check added.

A deck is a notebook (notebook.py) of kind "reading": each slide is a section
whose `src` is its pages, so the deck, the editor, versions and export are the
same code as lecture notes.
"""
from __future__ import annotations

import asyncio
import contextvars
import hashlib
import json
import os
import re
import tempfile
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Iterable, Optional

from fastapi import HTTPException

from . import languages, notebook
from .core import sessions as sess

# ── Limits ───────────────────────────────────────────────────────────────────

MAX_UPLOAD_MB = 200
MAX_PAGES = 2000
MAX_TEXT_CHARS = 20_000_000         # all pages together (~6,000 dense pages)
LIBRARY_TEXT_CHARS = 5_000_000      # what the Library and other features keep as the document's text
MAX_PAGE_CHARS = 20_000             # one page (a page of tiny print is ~6,000)
MAX_CONTENT_BYTES = 8_000_000       # a page's drawing instructions; beyond this, skip it
RUN_PAGE_CAP = 400                  # pages in one generation run; bigger books go in parts
WINDOW_CHARS = 14_000               # text per extraction call
WINDOW_PAGES = 10
COMPOSE_POINTS = 50                 # points per compose call (keeps answers under the output limit)
MAX_PARALLEL = 3                    # never more AI calls than this at once (audit 181-M7)
SCANNED_CHARS_PER_PAGE = 30         # below this on average, the PDF is page images
PROMPT_VERSION = "r1"               # bump when the extraction prompt changes: old cache entries stop matching

#: Outline entries with these kinds are left out unless the user ticks them.
SKIPPED_BY_DEFAULT = ("references", "acknowledgements", "appendix")

TEMPLATES = {
    "research": {
        "label": "Research paper",
        "for": "Journal and conference papers",
        "slides": "Title and citation → the question or gap → the key idea in one slide → method → data and setup → "
                  "results (one slide per main result, with its numbers) → limitations the authors state → "
                  "contributions → future work → key terms",
    },
    "textbook": {
        "label": "Textbook chapter",
        "for": "Lecture books and textbooks",
        "slides": "Chapter map → concepts (one per slide) → definitions → worked examples → formulas and rules → "
                  "common mistakes the book warns about → summary → practice questions",
    },
    "brief": {
        "label": "Quick brief",
        "for": "Busy readers",
        "slides": "One slide per section with the three to five points that matter most, then a TL;DR slide",
    },
    # Deep Read (docs/notebook-book-and-deep-read.md, Part B): chapter by chapter at three depths, with a map
    # of the whole and a glossary in learning order added in front (deep_read_sections).
    "deep": {
        "label": "Deep read",
        "for": "Hard texts you want to understand to the core",
        # What the app shows; "slides" is what the model is told.
        "shows": "A map of the text → its terms in learning order → each chapter as a one-line gist, key points, "
                 "claims with their evidence and what's uncertain, and questions to check it stuck",
        "slides": "For each chapter or section, in order: first a \"key\" block with its gist in one line → then 5-8 "
                  "\"point\" blocks with what it says → then its claims, each as a \"point\" written "
                  "\"Claim: … Evidence: … \" with the evidence the author gives, and a \"point\" starting "
                  "\"Uncertain:\" for anything the author admits is open or limited → then its key terms as "
                  "\"definition\" blocks → then 3-5 \"question\" blocks: recall questions a reader answers from memory "
                  "to check the chapter stuck (they cover no points)",
    },
}

#: How much the reader already knows, for Deep Read's plain meanings and gists (asked per document).
LEVELS = {
    "new": "new to this field: use everyday words and assume no background",
    "some": "someone with some background: plain words, but the field's basics can be assumed",
    "expert": "an expert from a neighbouring field: precise and brief, no hand-holding",
}
DEFAULT_LEVEL = "some"


# ── Storage ──────────────────────────────────────────────────────────────────

def _ensure_schema() -> None:
    with sess._connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS document_pages (
                document_id INTEGER NOT NULL,
                page        INTEGER NOT NULL,           -- 1-based, in the PDF's order
                label       TEXT NOT NULL DEFAULT '',   -- the PDF's own page label ("xii", "42") if any
                text        TEXT NOT NULL,
                PRIMARY KEY (document_id, page)
            );
            CREATE TABLE IF NOT EXISTS document_outline (
                document_id INTEGER NOT NULL,
                idx         INTEGER NOT NULL,
                level       INTEGER NOT NULL,           -- 1 chapter, 2 section, 3 subsection
                title       TEXT NOT NULL,
                page_from   INTEGER NOT NULL,
                page_to     INTEGER NOT NULL,
                kind        TEXT NOT NULL DEFAULT '',   -- references | acknowledgements | appendix | ''
                PRIMARY KEY (document_id, idx)
            );
            CREATE TABLE IF NOT EXISTS reading_progress (
            notebook_id INTEGER NOT NULL,
            section_id  TEXT NOT NULL,
            score       INTEGER NOT NULL,         -- 0-100: how much of the chapter the explanation got
            missed      INTEGER NOT NULL DEFAULT 0,
            tries       INTEGER NOT NULL DEFAULT 1,
            updated_at  TEXT NOT NULL,
            PRIMARY KEY (notebook_id, section_id)
        );
        CREATE TABLE IF NOT EXISTS reading_glossary (
            document_id INTEGER NOT NULL,
            terms_key   TEXT NOT NULL,           -- a hash of the terms and their definitions in the text
            level       TEXT NOT NULL,
            model       TEXT NOT NULL,
            entries     TEXT NOT NULL,           -- JSON {"T1": {plain, example, builds_on, unclear}}
            created_at  TEXT NOT NULL,
            PRIMARY KEY (document_id, terms_key, level, model)
        );
        CREATE TABLE IF NOT EXISTS reading_extracts (
                document_id INTEGER NOT NULL,
                span        TEXT NOT NULL,              -- the pages read, e.g. "12-20"
                model       TEXT NOT NULL,              -- model and prompt version
                points      TEXT NOT NULL,              -- JSON [{text, kind, term, importance, pages}]
                created_at  TEXT NOT NULL,
                PRIMARY KEY (document_id, span, model)
            );
            CREATE TABLE IF NOT EXISTS document_reading (
                document_id INTEGER PRIMARY KEY,
                state       TEXT NOT NULL,              -- reading | ready | scanned | failed | cancelled
                pages       INTEGER NOT NULL DEFAULT 0,
                done        INTEGER NOT NULL DEFAULT 0,
                kind        TEXT NOT NULL DEFAULT '',   -- paper | book | document
                source      TEXT NOT NULL DEFAULT '',   -- bookmarks | headings | ''
                error       TEXT NOT NULL DEFAULT '',
                updated_at  TEXT NOT NULL
            );
            """
        )


_ensure_schema()


def _ensure_columns() -> None:
    """Columns added after the table first shipped: the PDF's own title and author."""
    with sess._connect() as conn:
        have = {r[1] for r in conn.execute("PRAGMA table_info(document_reading)")}
        for col in ("author", "title"):
            if col not in have:
                conn.execute(f"ALTER TABLE document_reading ADD COLUMN {col} TEXT NOT NULL DEFAULT ''")


_ensure_columns()


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds")


def _bad(title: str, message: str, status: int = 400, code: str = "invalid") -> HTTPException:
    return HTTPException(status, detail={"code": code, "title": title, "message": message})


def forget_document(conn, document_id: int) -> None:
    """Everything this module keeps about a document. Its notebooks stay: they are the user's notes."""
    for table in ("document_pages", "document_outline", "reading_extracts", "document_reading"):
        conn.execute(f"DELETE FROM {table} WHERE document_id = ?", (document_id,))
    _cancel.add(document_id)


# ── 1. Upload, streamed ──────────────────────────────────────────────────────

def save_upload(src, filename: str, name: Optional[str] = None) -> int:
    """Copy an uploaded PDF (a file object) to disk, check it, store it as a Library document,
    and start reading it in the background.

    Returns the new document id. Raises a friendly 400 for anything that isn't a
    PDF under the size limit.
    """
    filename = (filename or "document.pdf").strip()[:200] or "document.pdf"
    if not filename.lower().endswith(".pdf"):
        raise _bad("Upload a PDF", "Reading notes work from PDF files for now.")
    limit = MAX_UPLOAD_MB * 1024 * 1024
    fd, path = tempfile.mkstemp(prefix="ireliabee-", suffix=".pdf")
    size = 0
    try:
        with os.fdopen(fd, "wb") as out:
            first = True
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                if first:
                    if not chunk.startswith(b"%PDF"):
                        raise _bad("Not a valid PDF", "This file isn't a readable PDF. Re-export it and try again.")
                    first = False
                size += len(chunk)
                if size > limit:
                    raise _bad("File too large",
                               f"Files can be up to {MAX_UPLOAD_MB} MB. Split the book, or upload the chapters you need.")
                out.write(chunk)
        if size == 0:
            raise _bad("Empty file", "That file has no content.")
        doc_id = _store_file(path, size, filename, (name or "").strip()[:200] or filename.rsplit(".", 1)[0])
        _start_thread(doc_id, path)            # the reader owns the temp file now and removes it
        path = ""
        return doc_id
    finally:
        if path:
            try:
                os.remove(path)
            except OSError:
                pass


def _store_file(path: str, size: int, filename: str, name: str) -> int:
    now = _now()
    conn = sess._connect()
    doc_id = None
    try:
        with conn:                              # the row, with room for the file: one short transaction
            cur = conn.execute(
                "INSERT INTO documents (name, original_filename, mime, content, extracted_text, created_at, updated_at) "
                "VALUES (?, ?, 'application/pdf', zeroblob(?), '', ?, ?)",
                (name, filename, size, now, now),
            )
            doc_id = cur.lastrowid
            conn.execute(
                "INSERT OR REPLACE INTO document_reading (document_id, state, pages, done, kind, source, error, updated_at) "
                "VALUES (?, 'reading', 0, 0, '', '', '', ?)", (doc_id, now),
            )
        # Then the bytes, 4 MB per transaction, so a live session's writes never wait long.
        with open(path, "rb") as f:
            offset = 0
            while chunk := f.read(4 * 1024 * 1024):
                with conn.blobopen("documents", "content", doc_id) as blob:
                    blob.seek(offset)
                    blob.write(chunk)
                conn.commit()
                offset += len(chunk)
        return doc_id
    except BaseException:
        if doc_id is not None:                  # never leave a half-written file in the Library
            try:
                with conn:
                    conn.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
                    forget_document(conn, doc_id)
            except Exception:
                pass
        raise
    finally:
        conn.close()


def _copy_out(document_id: int) -> str:
    """A stored document's bytes, copied to a temp file in pieces (for reading it again)."""
    conn = sess._connect()
    try:
        row = conn.execute("SELECT mime, original_filename FROM documents WHERE id = ?", (document_id,)).fetchone()
        if row is None:
            raise HTTPException(404, "Document not found")
        if "pdf" not in (row["mime"] or "") and not (row["original_filename"] or "").lower().endswith(".pdf"):
            raise _bad("Only PDFs for now", "Reading notes work from PDF files. Upload the PDF of this document.")
        fd, path = tempfile.mkstemp(prefix="ireliabee-", suffix=".pdf")
        try:
            with os.fdopen(fd, "wb") as out, conn.blobopen("documents", "content", document_id, readonly=True) as blob:
                while chunk := blob.read(1024 * 1024):
                    out.write(chunk)
        except BaseException:
            try:
                os.remove(path)
            except OSError:
                pass
            raise
        return path
    finally:
        conn.close()


# ── 2. Reading page by page, in the background ──────────────────────────────

_cancel: set[int] = set()


def _sweep_temp(max_age_s: int = 6 * 3600) -> None:
    """Temp copies left behind by a crash or a forced quit."""
    try:
        now = time.time()
        for entry in os.scandir(tempfile.gettempdir()):
            if entry.name.startswith("ireliabee-") and entry.name.endswith(".pdf") and now - entry.stat().st_mtime > max_age_s:
                try:
                    os.remove(entry.path)
                except OSError:
                    pass
    except OSError:
        pass


_sweep_temp()
_running: dict[int, threading.Thread] = {}
_lock = threading.Lock()


def _clean_text(text: str) -> str:
    text = (text or "").replace("\x00", "")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:MAX_PAGE_CHARS]


def _set_state(conn, document_id: int, **fields) -> None:
    fields["updated_at"] = _now()
    cols = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE document_reading SET {cols} WHERE document_id = ?", (*fields.values(), document_id))
    conn.commit()


def _gone(conn, document_id: int) -> bool:
    """True if the document was deleted while it was being read; then nothing of it may stay behind."""
    if conn.execute("SELECT 1 FROM documents WHERE id = ?", (document_id,)).fetchone():
        return False
    forget_document(conn, document_id)
    conn.commit()
    return True


def read_pdf(document_id: int, path: str) -> None:
    """Extract every page, then the outline. Runs on a worker thread; writes progress as it goes."""
    import pypdf

    conn = sess._connect()
    # An open file, not a path: given a path, pypdf reads the whole file into memory first.
    handle = open(path, "rb")
    try:
        conn.execute("DELETE FROM document_pages WHERE document_id = ?", (document_id,))
        conn.execute("DELETE FROM document_outline WHERE document_id = ?", (document_id,))
        conn.commit()
        try:
            reader = pypdf.PdfReader(handle)
            if reader.is_encrypted:
                try:
                    reader.decrypt("")
                except Exception:
                    raise ValueError("encrypted")
            total = len(reader.pages)
        except Exception as e:
            msg = "This PDF is password-protected. Remove the password and upload it again." if "encrypt" in str(e).lower() \
                else "This PDF couldn't be opened. Re-export it and try again."
            _set_state(conn, document_id, state="failed", error=msg)
            return
        if total > MAX_PAGES:
            _set_state(conn, document_id, state="failed", pages=total,
                       error=f"This PDF has {total} pages; the limit is {MAX_PAGES}. Split it and upload the parts you need.")
            return
        _set_state(conn, document_id, pages=total, done=0, state="reading", error="")
        try:
            labels = list(reader.page_labels)
        except Exception:
            labels = []

        chars, capped_at = 0, 0
        for i, page in enumerate(reader.pages):
            if document_id in _cancel:
                if not _gone(conn, document_id):
                    _set_state(conn, document_id, state="cancelled")
                return
            text = ""
            try:
                contents = page.get_contents()
                size = len(contents.get_data()) if contents is not None else 0
                if size <= MAX_CONTENT_BYTES:
                    text = _clean_text(page.extract_text() or "")
            except Exception:
                text = ""                      # one broken page never stops the book
            if chars + len(text) > MAX_TEXT_CHARS:
                text = text[: max(0, MAX_TEXT_CHARS - chars)]
            if chars + len(text) >= MAX_TEXT_CHARS and not capped_at:
                capped_at = i + 1
            chars += len(text)
            label = str(labels[i]) if i < len(labels) else ""
            conn.execute("INSERT OR REPLACE INTO document_pages (document_id, page, label, text) VALUES (?, ?, ?, ?)",
                         (document_id, i + 1, label[:20] if label != str(i + 1) else "", text))
            conn.commit()                      # one page per transaction: other writers never wait long
            if (i + 1) % 10 == 0 or i + 1 == total:
                _set_state(conn, document_id, done=i + 1)
            time.sleep(0)                      # let the event loop and the audio threads in

        if total == 0 or chars / total < SCANNED_CHARS_PER_PAGE:
            _set_state(conn, document_id, state="scanned",
                       error="This PDF is made of page images, so iReliabee can't read it yet.")
            return

        author, title = _metadata(reader)
        _set_state(conn, document_id, author=author, title=title)
        if _gone(conn, document_id):
            return
        outline, source = _bookmarks(reader, total)
        pages = page_texts(document_id, conn=conn)
        if not outline:
            outline, source = detect_headings(pages), ("headings" if pages else "")
        kind = guess_kind(total, outline, pages)
        _save_outline(conn, document_id, outline)
        # The Library and every feature that reads a document's text see it too.
        joined = "\n\n".join(pages[n] for n in sorted(pages) if pages[n])
        conn.execute("UPDATE documents SET extracted_text = ?, updated_at = ? WHERE id = ?",
                     (joined[:LIBRARY_TEXT_CHARS], _now(), document_id))
        note = (f"This book is very long: only the text up to page {capped_at} could be kept. "
                "Split it and upload the later chapters separately.") if capped_at else ""
        _set_state(conn, document_id, state="ready", kind=kind, source=source, done=total, error=note)
    except Exception as e:                      # never leave a document stuck on "reading"
        try:
            _set_state(conn, document_id, state="failed", error=f"Reading stopped: {type(e).__name__}.")
        except Exception:
            pass
    finally:
        handle.close()
        conn.close()


def start_reading(document_id: int) -> dict:
    """Read (or re-read) a Library PDF in the background. Returns its status straight away."""
    with _lock:
        # Registered before the lock is let go, so two requests at once can't both start a reader.
        if document_id in _running:
            return status(document_id)
        _running[document_id] = None           # "starting"
    try:
        path = _copy_out(document_id)
        with sess._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO document_reading (document_id, state, pages, done, kind, source, error, updated_at) "
                "VALUES (?, 'reading', 0, 0, '', '', '', ?)", (document_id, _now()),
            )
    except BaseException:
        with _lock:
            _running.pop(document_id, None)
        raise
    _start_thread(document_id, path)
    return status(document_id)


def _start_thread(document_id: int, path: str) -> None:
    """Read `path` into `document_id` on a worker thread, which deletes the file when done."""
    with _lock:
        _cancel.discard(document_id)

        def work():
            try:
                read_pdf(document_id, path)
            finally:
                try:
                    os.remove(path)
                except OSError:
                    pass
                with _lock:
                    if _running.get(document_id) is threading.current_thread():
                        _running.pop(document_id, None)

        t = threading.Thread(target=work, name=f"read-doc-{document_id}", daemon=True)
        _running[document_id] = t
        t.start()


def cancel_reading(document_id: int) -> dict:
    _cancel.add(document_id)
    return status(document_id)


def page_texts(document_id: int, pages: Optional[Iterable[int]] = None, conn=None) -> dict[int, str]:
    own = conn is None
    conn = conn or sess._connect()
    try:
        rows = conn.execute("SELECT page, text FROM document_pages WHERE document_id = ? ORDER BY page",
                            (document_id,)).fetchall()
    finally:
        if own:
            conn.close()
    wanted = set(pages) if pages is not None else None
    return {r["page"]: r["text"] for r in rows if wanted is None or r["page"] in wanted}


# ── 3. Structure: bookmarks, else headings ──────────────────────────────────

_SKIP_TITLES = [
    ("references", re.compile(r"^(references|bibliography|works cited|literature cited|further reading)\b", re.I)),
    ("acknowledgements", re.compile(r"^acknowledg(e)?ments?\b", re.I)),
    ("appendix", re.compile(r"^(appendix|appendices|supplementary|supplemental)\b", re.I)),
]
_PAPER_WORDS = ("abstract", "introduction", "related work", "background", "method", "methods", "methodology",
                "materials and methods", "experiments", "experimental setup", "results", "discussion",
                "conclusion", "conclusions", "limitations", "future work", "references", "bibliography",
                "acknowledgements", "acknowledgments", "appendix")
_CHAPTER = re.compile(r"^(chapter|chap\.?|part|unit|lecture)\s+([0-9]{1,3}|[ivxlc]{1,7}|one|two|three|four|five|six|seven|"
                      r"eight|nine|ten|eleven|twelve)\b[\s.:—-]*(.{0,80})$", re.I)
_NUMBERED = re.compile(r"^(\d{1,2})(\.\d{1,2}){0,2}\.?\s+([A-Z][^\n]{2,70})$")


def kind_of(title: str) -> str:
    t = re.sub(r"^[\d.\s]+", "", title.strip())
    for kind, pattern in _SKIP_TITLES:
        if pattern.match(t):
            return kind
    return ""


def _metadata(reader) -> tuple[str, str]:
    """The PDF's own author and title, when it carries them and they look like real ones."""
    try:
        meta = reader.metadata or {}
        author = str(meta.get("/Author") or "").strip()
        title = str(meta.get("/Title") or "").strip()
    except Exception:
        return "", ""
    # Tools often stamp themselves or the user account here; those aren't authors.
    if re.search(r"(microsoft|word|latex|pdf|acrobat|admin|user|unknown|owner)", author, re.I) or len(author) < 3:
        author = ""
    if re.search(r"(\.docx?|\.tex|untitled|microsoft word)", title, re.I):
        title = ""
    return author[:200], title[:200]


def _bookmarks(reader, total: int) -> tuple[list[dict], str]:
    """The PDF's own outline, flattened: [{level, title, page_from}] sorted by page."""
    found: list[dict] = []

    def walk(items, level):
        for item in items:
            if isinstance(item, list):
                walk(item, level + 1)
                continue
            try:
                page = reader.get_destination_page_number(item)
                title = str(item.title or "").strip()
            except Exception:
                continue
            if page is None or page < 0 or not title:
                continue
            found.append({"level": min(level, 3), "title": title[:200], "page_from": page + 1})
            if len(found) >= 600:
                return

    try:
        walk(reader.outline, 1)
    except Exception:
        return [], ""
    return (_finish_outline(found, total), "bookmarks") if found else ([], "")


def detect_headings(pages: dict[int, str]) -> list[dict]:
    """Headings found in the text when there are no bookmarks."""
    total = max(pages) if pages else 0
    found, seen = [], set()
    for n in sorted(pages):
        for raw in pages[n].split("\n")[:60]:
            line = raw.strip()
            if not line or len(line) > 80 or line.endswith((".", ",", ";")) and not _CHAPTER.match(line):
                continue
            words = line.split()
            level = 0
            m = _CHAPTER.match(line)
            if m:
                level = 1
            elif line.lower().rstrip(":") in _PAPER_WORDS or re.sub(r"^[\d.\s]+", "", line.lower()).rstrip(":") in _PAPER_WORDS:
                level = 1
            else:
                m2 = _NUMBERED.match(line)
                if m2 and len(words) <= 10 and int(m2.group(1)) <= 30 and not re.search(r"\d{3,}|%|=|\$", line[3:]):
                    level = 1 + line.split()[0].rstrip(".").count(".")
            if not level:
                continue
            key = re.sub(r"\W+", " ", line.lower()).strip()
            if key in seen:
                continue
            seen.add(key)
            found.append({"level": min(level, 3), "title": line[:200], "page_from": n})
    return _finish_outline(found, total)


def _finish_outline(entries: list[dict], total: int) -> list[dict]:
    """Sort, drop duplicates, and give every entry the page where it ends."""
    entries = sorted(entries, key=lambda e: (e["page_from"], e["level"]))
    out: list[dict] = []
    for e in entries:
        if e["page_from"] > total:
            continue
        if out and out[-1]["title"] == e["title"] and out[-1]["page_from"] == e["page_from"]:
            continue
        out.append(dict(e))
    for i, e in enumerate(out):
        end = total
        for later in out[i + 1:]:
            if later["level"] <= e["level"]:
                end = max(e["page_from"], later["page_from"] - (0 if later["page_from"] == e["page_from"] else 1))
                break
        e["page_to"] = end
        e["kind"] = kind_of(e["title"])
    # Anything inside a skipped part (a section of the appendix) is skipped with it.
    for e in out:
        if not e["kind"]:
            for parent in out:
                if parent["kind"] and parent["level"] < e["level"] and parent["page_from"] <= e["page_from"] <= parent["page_to"]:
                    e["kind"] = parent["kind"]
                    break
    return out[:400]


def guess_kind(total: int, outline: list[dict], pages: dict[int, str]) -> str:
    titles = " ".join(e["title"].lower() for e in outline)
    first = " ".join(pages.get(n, "")[:3000].lower() for n in (1, 2))
    if total <= 60 and ("abstract" in titles or "abstract" in first) and ("references" in titles or "introduction" in titles):
        return "paper"
    if total >= 80 or re.search(r"\bchapter\b", titles):
        return "book"
    return "paper" if total <= 40 and "abstract" in first else "document"


def _save_outline(conn, document_id: int, outline: list[dict]) -> None:
    conn.execute("DELETE FROM document_outline WHERE document_id = ?", (document_id,))
    conn.executemany(
        "INSERT INTO document_outline (document_id, idx, level, title, page_from, page_to, kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(document_id, i, e["level"], e["title"], e["page_from"], e["page_to"], e["kind"]) for i, e in enumerate(outline)],
    )
    conn.commit()


def outline(document_id: int) -> list[dict]:
    with sess._connect() as conn:
        rows = conn.execute("SELECT * FROM document_outline WHERE document_id = ? ORDER BY idx", (document_id,)).fetchall()
    return [{"idx": r["idx"], "level": r["level"], "title": r["title"], "page_from": r["page_from"],
             "page_to": r["page_to"], "kind": r["kind"]} for r in rows]


def status(document_id: int) -> dict:
    with sess._connect() as conn:
        doc = conn.execute("SELECT id, name, original_filename, length(content) AS bytes FROM documents WHERE id = ?",
                           (document_id,)).fetchone()
        if doc is None:
            raise HTTPException(404, "Document not found")
        row = conn.execute("SELECT * FROM document_reading WHERE document_id = ?", (document_id,)).fetchone()
        labels = {r["page"]: r["label"] for r in conn.execute(
            "SELECT page, label FROM document_pages WHERE document_id = ? AND label != ''", (document_id,))}
    base = {"document_id": document_id, "name": doc["name"], "filename": doc["original_filename"], "bytes": doc["bytes"]}
    if row is None:
        return {**base, "state": "new", "pages": 0, "done": 0, "kind": "", "source": "", "error": "", "outline": []}
    out = {**base, "state": row["state"], "pages": row["pages"], "done": row["done"], "kind": row["kind"],
           "source": row["source"], "error": row["error"], "outline": [], "labels": {},
           "author": row["author"], "doc_title": row["title"]}
    if row["source"] == "link":
        # Where a link source came from (its URL, platform, author, capture date): the
        # notes page names it as a web page or post, not as a paper or book.
        with sess._connect() as conn:
            meta = conn.execute("SELECT metadata FROM document_sources WHERE document_id = ?", (document_id,)).fetchone()
        try:
            out["link"] = json.loads(meta["metadata"]) if meta else {}
        except ValueError:
            out["link"] = {}
    if row["state"] == "ready":
        out["outline"] = outline(document_id)
        out["labels"] = {str(k): v for k, v in labels.items()}
        out["suggested"] = suggested_scope(out)
    return out


def suggested_scope(st: dict) -> dict:
    """A paper: all of it but the back matter. A book: its first real chapter."""
    top = [e for e in st["outline"] if e["level"] == 1]
    if st["kind"] == "book" and top:
        chapter = next((e for e in top if not e["kind"] and (e["page_to"] - e["page_from"]) >= 2), top[0])
        return {"mode": "chapters", "chapters": [chapter["idx"]]}
    return {"mode": "all"}


# ── Choosing what to cover ──────────────────────────────────────────────────

_RANGE_SPLIT = re.compile(r"\s*(?:[-–—]|\bto\b)\s*", re.I)


def parse_pages(spec: str, total: int) -> list[int]:
    """'12–48, 60' → [12, …, 48, 60]. Raises a friendly 400 for anything else."""
    pages: set[int] = set()
    for part in re.split(r"[,;]", spec or ""):
        part = part.strip().lower().replace("pp.", "").replace("p.", "").strip()
        if not part:
            continue
        bits = _RANGE_SPLIT.split(part)
        try:
            if len(bits) == 1:
                lo = hi = int(bits[0])
            elif len(bits) == 2:
                lo, hi = int(bits[0]), int(bits[1])
            else:
                raise ValueError
        except ValueError:
            raise _bad("Check the pages", f"“{part}” isn't a page or a range. Write pages like 12–48, 60.")
        if lo > hi:
            lo, hi = hi, lo
        if lo < 1 or hi > total:
            raise _bad("Check the pages", f"This document has pages 1–{total}.")
        pages.update(range(lo, hi + 1))
    if not pages:
        raise _bad("Choose some pages", "Write the pages to cover, like 12–48, 60.")
    return sorted(pages)


def resolve_scope(document_id: int, scope: Any) -> dict:
    """What a scope means: {pages, units: [{title, pages}], left_out: [titles], label}."""
    st = status(document_id)
    if st["state"] != "ready":
        raise _bad("Not ready yet", "iReliabee is still reading this document." if st["state"] == "reading"
                   else (st["error"] or "This document can't be read."), 409 if st["state"] == "reading" else 400)
    total = st["pages"]
    scope = scope if isinstance(scope, dict) else {}
    mode = scope.get("mode") or "all"
    ol = st["outline"]
    top = [e for e in ol if e["level"] == min((x["level"] for x in ol), default=1)]
    left_out: list[str] = []
    if mode == "pages":
        pages = parse_pages(str(scope.get("pages", "")), total)
        label = "Pages " + _ranges_label(pages)
        units = _units_for(pages, top)
    elif mode == "chapters":
        chosen = {int(i) for i in scope.get("chapters") or [] if str(i).lstrip("-").isdigit()}
        picked = [e for e in ol if e["idx"] in chosen]
        if not picked:
            raise _bad("Choose a chapter", "Tick at least one chapter or section to cover.")
        pages, units = [], []
        for e in sorted(picked, key=lambda e: e["page_from"]):
            span = [p for p in range(e["page_from"], e["page_to"] + 1) if p not in pages]
            if span:
                pages += span
                units.append({"title": e["title"], "pages": span})
        pages = sorted(pages)
        label = ", ".join(e["title"] for e in picked[:3]) + (f" and {len(picked) - 3} more" if len(picked) > 3 else "")
    else:
        skip: set[int] = set()
        for e in top:
            if e["kind"] in SKIPPED_BY_DEFAULT:
                skip.update(range(e["page_from"], e["page_to"] + 1))
                left_out.append(e["title"])
        pages = [p for p in range(1, total + 1) if p not in skip]
        label = "Whole document" + (" (without " + ", ".join(t.lower() for t in left_out[:3]) + ")" if left_out else "")
        units = _units_for(pages, [e for e in top if e["kind"] not in SKIPPED_BY_DEFAULT])
    texts = page_texts(document_id, pages)
    pages = [p for p in pages if texts.get(p, "").strip()]      # blank pages have nothing to say
    if not pages:
        raise _bad("Nothing to read there", "Those pages have no readable text. Choose other pages.")
    if len(pages) > RUN_PAGE_CAP:
        raise _bad("That's a lot of pages at once",
                   f"That's {len(pages)} pages. Make notes from up to {RUN_PAGE_CAP} pages at a time — pick a few chapters.")
    keep = set(pages)
    units = [{"title": u["title"], "pages": [p for p in u["pages"] if p in keep]} for u in units]
    units = [u for u in units if u["pages"]]
    return {"pages": pages, "units": units, "left_out": left_out, "label": label, "total": total,
            "chars": sum(len(texts.get(p, "")) for p in pages)}


def _ranges_label(pages: list[int]) -> str:
    runs, start, prev = [], None, None
    for p in pages:
        if start is None:
            start = prev = p
        elif p == prev + 1:
            prev = p
        else:
            runs.append((start, prev)); start = prev = p
    if start is not None:
        runs.append((start, prev))
    return ", ".join(f"{a}–{b}" if a != b else str(a) for a, b in runs)


def _units_for(pages: list[int], entries: list[dict]) -> list[dict]:
    """Group pages by chapter/section; pages outside any become 10-page units."""
    units, used = [], set()
    for e in sorted(entries, key=lambda e: e["page_from"]):
        span = [p for p in pages if e["page_from"] <= p <= e["page_to"] and p not in used]
        if span:
            used.update(span)
            units.append({"title": e["title"], "pages": span, "_at": span[0]})
    rest = [p for p in pages if p not in used]
    run: list[int] = []
    for p in rest + [None]:
        if p is not None and (not run or (p == run[-1] + 1 and len(run) < WINDOW_PAGES)):
            run.append(p)
            continue
        if run:
            units.append({"title": f"Pages {run[0]}–{run[-1]}" if len(run) > 1 else f"Page {run[0]}",
                          "pages": run, "_at": run[0]})
        run = [p] if p is not None else []
    units.sort(key=lambda u: u["_at"])
    return [{"title": u["title"], "pages": u["pages"]} for u in units]


def windows(unit_pages: list[int], texts: dict[int, str]) -> list[list[int]]:
    """Cut a unit's pages into windows of at most WINDOW_CHARS / WINDOW_PAGES, keeping pages whole."""
    out, cur, size = [], [], 0
    for p in unit_pages:
        n = len(texts.get(p, ""))
        if cur and (size + n > WINDOW_CHARS or len(cur) >= WINDOW_PAGES or p != cur[-1] + 1):
            out.append(cur); cur, size = [], 0
        cur.append(p); size += n
    if cur:
        out.append(cur)
    return out


def span_key(pages: list[int]) -> str:
    return f"{pages[0]}-{pages[-1]}" if len(pages) > 1 else str(pages[0])


# ── Estimate ─────────────────────────────────────────────────────────────────

SECONDS_PER_CALL = 25


def _model_key(model: Optional[str]) -> str:
    from .errors import resolve_llm
    try:
        name, _ = resolve_llm(model)
    except Exception:
        name = (model or "default").strip() or "default"
    return f"{name}|{PROMPT_VERSION}"


def _cached_spans(document_id: int, model_key: str) -> set[str]:
    with sess._connect() as conn:
        rows = conn.execute("SELECT span FROM reading_extracts WHERE document_id = ? AND model = ?",
                            (document_id, model_key)).fetchall()
    return {r["span"] for r in rows}


def estimate(document_id: int, scope: Any, template: str = "research", model: Optional[str] = None,
             level: str = DEFAULT_LEVEL) -> dict:
    """Pages, calls, tokens, dollars and minutes for a selection — before anything is spent."""
    from .core.costs import token_cost

    plan = resolve_scope(document_id, scope)
    texts = page_texts(document_id, plan["pages"])
    mkey = _model_key(model)
    cached = _cached_spans(document_id, mkey)
    spans = [w for u in plan["units"] for w in windows(u["pages"], texts)]
    to_read = [w for w in spans if span_key(w) not in cached]
    read_chars = sum(len(texts.get(p, "")) for w in to_read for p in w)
    # Roughly one point per 450 characters of dense text, ~45 tokens each way per point.
    points = max(8, plan["chars"] // 450)
    compose_calls = max(1, -(-points // COMPOSE_POINTS)) + (1 if points > COMPOSE_POINTS else 0)
    in_tokens = read_chars // 4 + 1400 * len(to_read) + points * 45 + 1800 * compose_calls
    out_tokens = min(len(to_read) * 4096, points * 55) + min(compose_calls * 4096, points * 60)
    if template == "deep":
        # Chapter by chapter (one call each, plus the cover), and about one term in eight points explained.
        extra = max(0, len(plan["units"]) + 1 - compose_calls)
        compose_calls += extra
        terms = max(3, points // 8)
        glossary_calls = -(-terms // GLOSSARY_BATCH)
        in_tokens += 1800 * extra + glossary_calls * 900 + terms * 90
        out_tokens += min(extra * 4096, points * 20) + terms * 80
        compose_calls += glossary_calls
    model_name = mkey.split("|")[0]
    dollars = token_cost(model_name, in_tokens, out_tokens)
    # What an ordinary account is shown before it spends (decision 185-1): the
    # service's own price in credits. The admin runs on their own keys and sees dollars.
    from .core import hosted
    credits = None if hosted.is_admin() else hosted.credits_for(model_name, in_tokens, out_tokens)
    calls = len(to_read) + compose_calls
    return {
        "pages": len(plan["pages"]), "label": plan["label"], "units": len(plan["units"]), "left_out": plan["left_out"],
        "calls": calls, "cached_windows": len(spans) - len(to_read), "windows": len(spans),
        "tokens": {"input": in_tokens, "output": out_tokens},
        "usd": round(dollars, 3) if dollars is not None else None, "model": model_name,
        "credits": round(credits, 2) if credits is not None else None,
        "seconds": int(-(-calls // MAX_PARALLEL) * SECONDS_PER_CALL),
        "template": template if template in TEMPLATES else "research",
    }


# ── 4–6. Map, compose, coverage ─────────────────────────────────────────────

POINT_KINDS = ("claim", "definition", "result", "method", "example", "formula", "warning", "figure", "quote", "question")
IMPORTANCE = ("core", "supporting", "detail")

EXTRACT_PROMPT = """You read part of a document and list EVERY point it makes, as JSON only.
The text is marked with page numbers like [p. 12]. Completeness matters more than brevity: a later step
turns your list into notes, and anything you leave out is lost.

For each point give:
- "text": the point in one or two sentences, in the document's own terms. Numbers, units, equations,
  names and quotes EXACTLY as written. Keep the authors' hedges ("may", "suggests"): write "the authors
  report…" or "the book defines…" rather than stating a claim as settled fact when the text doesn't.
- "kind": one of claim, definition, result, method, example, formula, warning, figure, quote, question.
  A definition also has "term". A figure is "Figure N: its caption". A formula is copied verbatim.
- "importance": "core" (the main ideas, findings, definitions a reader must know), "supporting"
  (evidence, steps, examples that make the core ones understandable) or "detail" (the rest).
- "pages": the page number(s) it came from, as integers.
If text is garbled or a page is only a figure, add a point of kind "warning" saying "check page N".
Do not add anything the text does not say. Ignore running headers, footers and page numbers.

Return ONLY: {"points": [{"text": "...", "kind": "claim", "importance": "core", "pages": [12]}]}"""

COMPOSE_PROMPT = """You turn a list of numbered points from a document into notebook slides, as JSON only.
Template: {template_label}. Slide sequence to follow where the material allows: {template_slides}.

RULES — these matter more than anything else:
- Use ONLY the points given. Never add facts from elsewhere.
- Every block lists in "covers" the ids of the points it expresses (e.g. ["P3", "P7"]). Every "core" and
  every "supporting" point must be covered by some block. "detail" points may be folded into others or left out.
- Every block's "src" lists the page numbers of the points it covers, as integers.
- Numbers, equations, names and quotes exactly as in the points. Keep the authors' hedges.
- Limitations: only the ones the authors state, labelled as theirs.
- No slide is about the reader, their background or their CV.

Block types: "point", "key" (one of the few things most worth remembering), "definition" (with "term"),
"example", "exam" (a point a student is likely to be tested on — textbook template only), "question"
(a practice question — textbook and deep read templates only), "quote" (with "speaker"), "formula" (verbatim), "table"
(with "rows": first row is the header, and an optional "caption"), "unclear" (for "check page N" points).{tutor_rule}

Return ONLY JSON:
{{{frame}"slides": [{{"title": "short slide title", "pages": [first, last],
             "blocks": [{{"type": "point", "text": "...", "src": [12], "covers": ["P3"]}}]}}]}}
Aim for 4-9 blocks a slide."""

FRAME_ASK = '"title": "a short title for the deck", "summary": "3-5 sentences on what the pages cover", ' \
            '"cues": ["4-10 short self-test questions"], '

FRAME_PROMPT = """You write the cover of a deck of reading notes, as JSON only, from its slide titles and key points.
Use ONLY what is given. Return ONLY: {"title": "short deck title", "summary": "3-5 sentences on what the pages
cover and their main argument", "cues": ["4-10 short self-test questions a student would ask themselves"]}"""

GLOSSARY_PROMPT = """You explain the technical terms of a document to a reader, as JSON only.
The reader is {level}.
You get each term with an id, the page(s) it is on, and what the document itself says it means.

For each term give:
- "plain": its meaning in ONE plain sentence at the reader's level, faithful to what the document says.
- "example": one short everyday example that makes it concrete ("" if none fits). It is shown labelled as
  iReliabee's, not the author's.
- "builds_on": the ids of OTHER terms in the list a reader must understand first (e.g. a p-value builds on the
  null hypothesis). Only ids from the list; [] if none.
- "unclear": true if the document does not actually say what the term means and your "plain" comes from general
  knowledge, false otherwise.

Return ONLY: {{"terms": [{{"id": "T1", "plain": "...", "example": "...", "builds_on": ["T3"], "unclear": false}}]}}"""

#: Terms explained in one call; more are sent in several.
GLOSSARY_BATCH = 60


def glossary_terms(numbered: list[tuple[dict, list[dict]]]) -> list[dict]:
    """
    The document's defined terms, once each, in the order they first appear:
    [{id: "T1", term, text (the document's definition), pages}]. A term defined
    twice keeps its first definition and all its pages.
    """
    out, by_key = [], {}
    for _, pts in numbered:
        for p in pts:
            term = (p.get("term") or "").strip()
            if p.get("kind") != "definition" or not term:
                continue
            key = _norm(term)
            if key in by_key:
                by_key[key]["pages"] = sorted(set(by_key[key]["pages"]) | set(p.get("pages") or []))
                continue
            entry = {"id": f"T{len(out) + 1}", "term": term[:200], "text": p["text"][:600], "pages": list(p.get("pages") or [])}
            by_key[key] = entry
            out.append(entry)
    return out


def learning_order(terms: list[dict], explained: dict) -> list[dict]:
    """
    Basics first: a term comes after every term it builds on, otherwise in the
    order the document introduces them. A loop (A needs B, B needs A) is broken
    by that same order, so every term is still listed once.
    """
    ids = [t["id"] for t in terms]
    needs = {i: [d for d in (explained.get(i, {}).get("builds_on") or []) if d in ids and d != i] for i in ids}
    done, out, visiting = set(), [], set()

    def place(i: str) -> None:
        if i in done or i in visiting:
            return
        visiting.add(i)
        for d in needs[i]:
            place(d)
        visiting.discard(i)
        done.add(i)
        out.append(i)

    for i in ids:
        place(i)
    by_id = {t["id"]: t for t in terms}
    return [by_id[i] for i in out]


def glossary_section(terms: list[dict], explained: dict) -> Optional[dict]:
    """The glossary as a notebook section of definition blocks, each citing its pages."""
    if not terms:
        return None
    names = {t["id"]: t["term"] for t in terms}
    blocks = []
    for t in learning_order(terms, explained):
        e = explained.get(t["id"]) or {}
        plain = str(e.get("plain") or "").strip() or t["text"]
        text = plain
        example = str(e.get("example") or "").strip()
        if example:
            text += f" Example (iReliabee's): {example}"
        builds = [names[d] for d in (e.get("builds_on") or []) if d in names and d != t["id"]]
        if builds:
            text += f" Builds on: {', '.join(builds)}."
        if e.get("unclear"):
            text += " (The text doesn't say exactly; this meaning is iReliabee's.)"
        blocks.append({"type": "definition", "term": t["term"], "text": text, "src": t["pages"]})
    return {"title": "Glossary, in learning order", "blocks": blocks}


def map_section(batches: list[tuple[str, list[dict], bool]], results: list) -> Optional[dict]:
    """
    The map: every chapter in order with its gist (the first key block its
    slides give) and pages, to read before anything else. Built from the slides,
    so it costs nothing.
    """
    blocks = []
    for (name, pts, _), (secs, _covered, _raw) in zip(batches, results):
        if " (part " in name and not name.endswith("(part 1)"):
            continue
        gist = next((b["text"] for s in secs for b in s.get("blocks", []) if b.get("type") == "key"), "")
        pages = sorted({pg for p in pts for pg in (p.get("pages") or [])})
        label = name.replace(" (part 1)", "")
        blocks.append({"type": "point", "text": f"{label}: {gist}" if gist else label,
                       "src": [pages[0], pages[-1]] if pages else []})
    return {"title": "Map of the text", "blocks": blocks} if blocks else None


_KIND_TO_BLOCK = {"definition": "definition", "formula": "formula", "example": "example", "quote": "quote",
                  "warning": "unclear", "question": "question"}


def _norm(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", (text or "").lower()))


def clean_points(raw: Any, window: list[int]) -> list[dict]:
    """The model's point list, in one strict shape, with pages kept inside the window it read."""
    items = raw.get("points") if isinstance(raw, dict) else raw
    lo, hi = window[0], window[-1]
    out = []
    for p in items if isinstance(items, list) else []:
        if not isinstance(p, dict):
            continue
        text = str(p.get("text") or "").strip()[:1200]
        if not text:
            continue
        kind = str(p.get("kind") or "claim").strip().lower()
        imp = str(p.get("importance") or "supporting").strip().lower()
        pages = [n for n in notebook._ints(p.get("pages"), lo, hi)] or [lo]
        out.append({"text": text, "kind": kind if kind in POINT_KINDS else "claim",
                    "term": str(p.get("term") or "").strip()[:200],
                    "importance": imp if imp in IMPORTANCE else "supporting", "pages": sorted(pages)})
    return out[:120]


def merge_points(groups: list[list[dict]], seen: Optional[dict] = None) -> list[dict]:
    """All windows' points, duplicates removed (the same point read twice keeps the higher importance).

    Pass the same `seen` for every section of a deck to drop duplicates across sections too: a
    point stays in the section where it first appears.
    """
    rank = {k: i for i, k in enumerate(IMPORTANCE)}
    seen = {} if seen is None else seen
    out: list[dict] = []
    for group in groups:
        for p in group:
            key = _norm(p["text"])[:90]
            if not key:
                continue
            if key in seen:
                kept = seen[key]
                if rank[p["importance"]] < rank[kept["importance"]]:
                    kept["importance"] = p["importance"]
                kept["pages"] = sorted(set(kept["pages"]) | set(p["pages"]))[: notebook.LIMITS["src"]]
                continue
            q = dict(p)
            seen[key] = q
            out.append(q)
    for i, p in enumerate(out, 1):
        p["id"] = f"P{i}"
    return out


def _covers(raw_block: Any) -> list[str]:
    ids = raw_block.get("covers") if isinstance(raw_block, dict) else None
    return [str(x).strip().upper() for x in ids if str(x).strip()] if isinstance(ids, list) else []


def slides_to_sections(raw: Any, pages_total: int) -> tuple[list[dict], set[str]]:
    """The model's slides as notebook sections, and the point ids the surviving blocks cover."""
    slides = raw.get("slides") if isinstance(raw, dict) else None
    sections, covered = [], set()
    for s in slides if isinstance(slides, list) else []:
        if not isinstance(s, dict):
            continue
        blocks, slide_covers = [], set()
        for b in (s.get("blocks") or [])[: notebook.LIMITS["blocks"]]:
            cleaned = notebook.clean_block(b, pages_total)
            if cleaned:
                blocks.append(cleaned)
                slide_covers.update(_covers(b))
        covered |= slide_covers
        title = str(s.get("title") or "").strip()[: notebook.LIMITS["title"]]
        if not blocks:
            continue
        pages = notebook._ints(s.get("pages"), 1, pages_total) or sorted({p for b in blocks for p in b["src"]})
        sections.append({"id": notebook._new_id(), "title": title or "Notes", "src": [pages[0], pages[-1]] if len(pages) > 1 else pages,
                         "blocks": blocks, "_covers": slide_covers})
    return sections, covered


def point_block(p: dict) -> dict:
    btype = _KIND_TO_BLOCK.get(p["kind"], "key" if p["importance"] == "core" else "point")
    block = {"id": notebook._new_id(), "type": btype, "text": p["text"][: notebook.LIMITS["text"]], "src": p["pages"]}
    if btype == "definition":
        block["term"] = p.get("term") or ""
        if not block["term"]:
            block["type"] = "key" if p["importance"] == "core" else "point"
            block.pop("term")
    if btype == "quote":
        block["speaker"] = ""
    return block


def coverage_fill(unit_title: str, points: list[dict], covered: set[str]) -> tuple[list[dict], dict]:
    """Slides for every core/supporting point no slide covers, and the numbers for the Coverage slide."""
    required = [p for p in points if p["importance"] in ("core", "supporting")]
    missing = [p for p in required if p["id"] not in covered]
    sections = []
    for i in range(0, len(missing), 10):
        chunk = missing[i:i + 10]
        pages = sorted({n for p in chunk for n in p["pages"]})
        sections.append({"id": notebook._new_id(),
                         "title": f"More from {unit_title}" + (f" ({i // 10 + 1})" if len(missing) > 10 else ""),
                         "src": [pages[0], pages[-1]] if len(pages) > 1 else pages,
                         "blocks": [point_block(p) for p in chunk], "_covers": {p["id"] for p in chunk}})
    core = [p for p in required if p["importance"] == "core"]
    return sections, {
        "core_total": len(core),
        "core_by_ai": sum(1 for p in core if p["id"] in covered),
        "supporting_total": len(required) - len(core),
        "supporting_by_ai": sum(1 for p in required if p["importance"] == "supporting" and p["id"] in covered),
        "added_by_check": len(missing),
        "details": len(points) - len(required),
    }


def _lines(points: list[dict]) -> str:
    return "\n".join(
        f"{p['id']} [{p['importance']}] (p. {', '.join(map(str, p['pages']))}) {p['kind']}"
        f"{' — ' + p['term'] if p.get('term') else ''}: {p['text']}" for p in points)


# ── Jobs: generation runs in the background, with progress ──────────────────

JOBS: dict[str, dict] = {}
_tasks: set[asyncio.Task] = set()


#: The stop signal of the job running in this task, seen by every AI call it makes
#: (asyncio copies it into the tasks it starts; _ask hands it to the worker thread).
_JOB_STOP: contextvars.ContextVar = contextvars.ContextVar("reading_job_stop", default=None)


def job_view(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "That job isn't running any more")
    return {k: v for k, v in job.items() if not k.startswith("_")}


def start_job(coro_factory, document_id: int) -> dict:
    job_id = uuid.uuid4().hex[:12]
    job = {"id": job_id, "document_id": document_id, "state": "running", "step": "Starting…", "done": 0, "total": 0,
           "notebook_id": None, "error": None, "started_at": _now()}
    JOBS[job_id] = job
    # Keep the list short: finished jobs older than the last twenty go.
    finished = [k for k, v in JOBS.items() if v["state"] != "running"]
    for k in finished[:-20]:
        JOBS.pop(k, None)

    stop = threading.Event()
    job["_stop"] = stop

    async def run():
        _JOB_STOP.set(stop)
        try:
            nb = await coro_factory(job)
            job.update(state="done", step="Done", notebook_id=nb["id"])
        except asyncio.CancelledError:
            job.update(state="cancelled", step="Stopped")
        except HTTPException as e:
            job.update(state="failed", error=e.detail if isinstance(e.detail, dict) else
                       {"code": "unknown", "title": "The notes couldn't be made", "message": str(e.detail)},
                       status=e.status_code)
        except Exception as e:
            from .errors import FriendlyError
            if isinstance(e, FriendlyError):
                job.update(state="failed", error=e.as_dict())
            else:
                job.update(state="failed", error={"code": "unknown", "title": "The notes couldn't be made",
                                                  "message": "Something went wrong. Try again in a moment."})

    task = asyncio.get_running_loop().create_task(run())
    job["_task"] = task
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return job_view(job_id)


def cancel_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "That job isn't running any more")
    task = job.get("_task")
    if task and not task.done():
        stop = job.get("_stop")
        if stop is not None:
            stop.set()          # calls already running close their streams (review 11-7)
        task.cancel()
    return job_view(job_id)


async def _ask(model: Optional[str], system: str, message: str, document_id: int,
               fallback_credits: bool = False, kind: Optional[str] = None) -> Any:
    from .routers.mock import resolve_llm, respond, classify, _parse_json
    from .core.providers import metering_context, fallback_credits_context, _context, is_fallback_credits
    from .errors import FriendlyError
    from .core.providers import cancellable

    # Never the thread-local here: on the event loop it belongs to whichever
    # request last set it (an Explain running beside a notebook build).
    # `kind` names the task for the user's own assistant (relay); billing keeps
    # its own category, "reading" unless the caller set one.
    from .core.providers import _kind_var, relay_task
    effective_kind = _kind_var.get() or "reading"
    effective_fallback = fallback_credits or is_fallback_credits()

    model_id, provider = resolve_llm(model)
    loop = asyncio.get_running_loop()
    stop = _JOB_STOP.get()

    def run(text: str) -> str:
        with metering_context(effective_kind, None), relay_task(kind or effective_kind),                 fallback_credits_context(effective_fallback), cancellable(stop):
            return respond(provider, model_id, text, [], system, 4096)

    async def call(text: str) -> str:
        try:
            return await loop.run_in_executor(None, run, text)
        except Exception as e:
            raise classify(e, provider)

    raw = await call(message)
    try:
        return _parse_json(raw)
    except (ValueError, json.JSONDecodeError):
        pass
    raw = await call(message + "\n\nReply with ONLY the JSON object described in your instructions — no other text.")
    try:
        return _parse_json(raw)
    except (ValueError, json.JSONDecodeError):
        raise FriendlyError("unknown", "The AI model gave an unreadable answer",
                            "Try again, or pick a different model in Settings.", "settings")


async def generate(job: dict, document_id: int, scope: Any, template: str, style: Any = None,
                   model: Optional[str] = None, tutor: bool = False, notebook_id: Optional[int] = None,
                   level: str = DEFAULT_LEVEL) -> dict:
    """Map, compose, check coverage, and store the deck. Updates `job` as it goes."""
    template = template if template in TEMPLATES else "research"
    level = level if level in LEVELS else DEFAULT_LEVEL
    deep = template == "deep"
    plan = resolve_scope(document_id, scope)
    st = status(document_id)
    texts = page_texts(document_id, plan["pages"])
    mkey = _model_key(model)
    lang_rule = languages.json_block(None)
    gate = notebook.ai_gate()                  # shared by every job: at most MAX_PARALLEL AI calls app-wide

    unit_windows = [(u, windows(u["pages"], texts)) for u in plan["units"]]
    all_windows = [w for _, ws in unit_windows for w in ws]
    job.update(total=len(all_windows), done=0, step=f"Reading {len(plan['pages'])} pages…", phase="read", part_started=time.time())

    async def read_window(w: list[int]) -> list[dict]:
        key = span_key(w)
        with sess._connect() as conn:
            row = conn.execute("SELECT points FROM reading_extracts WHERE document_id = ? AND span = ? AND model = ?",
                               (document_id, key, mkey)).fetchone()
        if row:
            job["done"] += 1
            job["part_started"] = time.time()
            return json.loads(row["points"])
        body = "\n\n".join(f"[p. {p}]\n{texts.get(p, '')}" for p in w)
        async with gate:
            raw = await _ask(model, EXTRACT_PROMPT + lang_rule, f"PAGES {key}\n\n{body}", document_id, kind="notebook_points")
        points = clean_points(raw, w)
        with sess._connect() as conn:
            conn.execute("INSERT OR REPLACE INTO reading_extracts (document_id, span, model, points, created_at) "
                         "VALUES (?, ?, ?, ?, ?)", (document_id, key, mkey, json.dumps(points), _now()))
        job["done"] += 1
        job["part_started"] = time.time()
        job["step"] = f"Reading… {job['done']} of {job['total']} parts"
        return points

    per_unit: list[tuple[dict, list[dict]]] = []
    for unit, ws in unit_windows:
        groups = await notebook.gather_all([read_window(w) for w in ws])
        per_unit.append((unit, groups))

    # Point ids run through the whole deck, so "P12" means one thing everywhere.
    numbered, counter, seen = [], 0, {}
    for unit, groups in per_unit:
        pts = merge_points(groups, seen)
        for p in pts:
            counter += 1
            p["id"] = f"P{counter}"
        numbered.append((unit, pts))
    total_points = sum(len(p) for _, p in numbered)
    if total_points == 0:
        raise HTTPException(502, detail={"code": "unknown", "title": "Nothing came back from those pages",
                                         "message": "Try again, or choose other pages."})

    tutor_rule = ('\n- You may add at most three "tutor" blocks: a short, simpler explanation of your own where the '
                  'text is hard, shown labelled as iReliabee\'s. They cover no points.') if tutor else \
                 "\n- Do NOT add any tutor blocks."
    t = TEMPLATES[template]

    # Compose: small documents in one go (the template's whole sequence), long ones unit by unit.
    batches: list[tuple[str, list[dict], bool]] = []
    # A deep read always goes chapter by chapter, so each chapter gets its own three depths.
    if total_points <= COMPOSE_POINTS and not (deep and len(numbered) > 1):
        # Named for the "More from …" slide: "this document", or "pages 12–48" / the chapters chosen.
        whole = "this document" if (scope or {}).get("mode", "all") == "all" else (
            plan["label"][0].lower() + plan["label"][1:] if plan["label"].startswith("Pages") else plan["label"])
        batches.append((whole, [p for _, pts in numbered for p in pts], True))
    else:
        for unit, pts in numbered:
            for i in range(0, len(pts), COMPOSE_POINTS):
                part = pts[i:i + COMPOSE_POINTS]
                name = unit["title"] + (f" (part {i // COMPOSE_POINTS + 1})" if len(pts) > COMPOSE_POINTS else "")
                batches.append((name, part, False))
    job.update(step="Writing the slides…", done=0, total=len(batches) + (0 if batches[0][2] else 1), phase="write", part_started=time.time())

    async def compose(name: str, pts: list[dict], whole: bool) -> tuple[list[dict], set[str], dict]:
        system = COMPOSE_PROMPT.format(template_label=t["label"], template_slides=t["slides"], tutor_rule=tutor_rule,
                                       frame=FRAME_ASK if whole else "") + lang_rule
        if deep:
            system += f"\nWrite the gists and bullets for a reader who is {LEVELS[level]}. Every block still cites its pages."
        async with gate:
            raw = await _ask(model, system, f"POINTS FROM: {name}\n\n{_lines(pts)}", document_id, kind="notebook_slides")
        sections, covered = slides_to_sections(raw, plan["total"])
        job["done"] += 1
        job["part_started"] = time.time()
        job["step"] = f"Writing the slides… {job['done']} of {job['total']}"
        return sections, covered, raw if isinstance(raw, dict) else {}

    results = await notebook.gather_all([compose(n, p, w) for n, p, w in batches])

    # Coverage: every core and supporting point is on a slide — the model's, or one the check adds.
    sections: list[dict] = []
    totals = {"core_total": 0, "core_by_ai": 0, "supporting_total": 0, "supporting_by_ai": 0,
              "added_by_check": 0, "details": 0}
    for (name, pts, _), (secs, covered, _raw) in zip(batches, results):
        sections += secs
        extra, numbers = coverage_fill(name, pts, covered)
        sections += extra
        for k in totals:
            totals[k] += numbers[k]
    # Count coverage from the slides that are actually kept — never assume it.
    limit = notebook.LIMITS["reading_sections"]
    dropped = max(0, len(sections) - limit)
    sections = sections[:limit]
    required_ids = {p["id"] for _, pts in numbered for p in pts if p["importance"] in ("core", "supporting")}
    kept_ids = set().union(*(s.get("_covers", set()) for s in sections)) if sections else set()
    covered_count = len(required_ids & kept_ids)

    frame = results[0][2] if batches[0][2] else {}
    if not batches[0][2]:
        core = [p for _, pts in numbered for p in pts if p["importance"] == "core"][:60]
        brief = "SLIDES\n" + "\n".join(f"- {s['title']}" for s in sections) + "\n\nKEY POINTS\n" + \
                "\n".join(f"- {p['text']}" for p in core)
        async with gate:
            frame = await _ask(model, FRAME_PROMPT + lang_rule, brief, document_id, kind="notebook_frame")
        job["done"] += 1

    ideas: list[dict] = []
    if deep:
        job.update(step="Explaining the terms…", phase="terms", part_started=time.time())
        front, ideas = await deep_read_front(document_id, numbered, batches, results, level, model, lang_rule, gate)
        sections = front + sections

    doc = notebook.clean_doc({"title": frame.get("title"), "author": st.get("author") or "",
                              "summary": frame.get("summary"), "cues": frame.get("cues"),
                              "sections": sections}, "reading", max_src=plan["total"])
    if not doc["sections"]:
        raise HTTPException(502, detail={"code": "unknown", "title": "The notes came back empty",
                                         "message": "Try again in a moment."})
    required = totals["core_total"] + totals["supporting_total"]
    coverage = {**totals, "required": required,
                "covered": covered_count,             # the check adds what the slides missed; counted, not assumed
                "dropped_slides": dropped,
                "by_ai_pct": round(100 * (totals["core_by_ai"] + totals["supporting_by_ai"]) / required) if required else 100,
                "left_out": plan["left_out"], "pages": len(plan["pages"]),
                **({"ideas": ideas} if ideas else {})}
    scope_saved = {**(scope if isinstance(scope, dict) else {}), "label": plan["label"], "pages": _ranges_label(plan["pages"])}
    if deep:
        scope_saved["level"] = level                  # "simplify this" writes for the same reader
    title = doc["title"] or st["name"]

    if notebook_id:
        return _rewrite(notebook_id, document_id, title, style, doc, template, scope_saved, coverage)
    return notebook.create_notebook("reading", title=title, style=style, doc=doc, document_id=document_id,
                                    template=template, generated=True, scope=scope_saved, coverage=coverage)


async def deep_read_front(document_id: int, numbered: list, batches: list, results: list, level: str,
                          model: Optional[str], lang_rule: str, gate) -> tuple[list[dict], list[dict]]:
    """
    The map and the glossary in learning order, to put in front of a deep read's
    chapters, and the ideas behind the map of ideas (each term and what it builds on).
    """
    terms = glossary_terms(numbered)
    explained: dict = {}
    if terms:
        key = hashlib.sha1(json.dumps([[t["term"], t["text"]] for t in terms]).encode("utf-8")).hexdigest()
        mkey = _model_key(model)
        with sess._connect() as conn:
            row = conn.execute("SELECT entries FROM reading_glossary WHERE document_id = ? AND terms_key = ? AND level = ? "
                               "AND model = ?", (document_id, key, level, mkey)).fetchone()
        if row:
            explained = json.loads(row["entries"])
        else:
            for i in range(0, len(terms), GLOSSARY_BATCH):
                part = terms[i:i + GLOSSARY_BATCH]
                listing = "\n".join(f"{t['id']} {t['term']} (p. {', '.join(map(str, t['pages'])) or '?'}): {t['text']}" for t in part)
                async with gate:
                    raw = await _ask(model, GLOSSARY_PROMPT.format(level=LEVELS[level]) + lang_rule, "TERMS\n" + listing, document_id, kind="notebook_glossary")
                for e in (raw.get("terms") if isinstance(raw, dict) else None) or []:
                    if isinstance(e, dict) and isinstance(e.get("id"), str):
                        explained[e["id"]] = {
                            "plain": str(e.get("plain") or "")[:600], "example": str(e.get("example") or "")[:300],
                            "builds_on": [d for d in (e.get("builds_on") or []) if isinstance(d, str)][:10],
                            "unclear": bool(e.get("unclear")),
                        }
            with sess._connect() as conn:
                conn.execute("INSERT OR REPLACE INTO reading_glossary (document_id, terms_key, level, model, entries, created_at) "
                             "VALUES (?, ?, ?, ?, ?, ?)", (document_id, key, level, mkey, json.dumps(explained), _now()))
    ideas = [{"term": t["term"], "builds_on": [n["term"] for n in terms
                                               if n["id"] in (explained.get(t["id"], {}).get("builds_on") or []) and n["id"] != t["id"]],
              "pages": t["pages"]} for t in learning_order(terms, explained)]
    return [s for s in (map_section(batches, results), glossary_section(terms, explained)) if s], ideas


def _rewrite(notebook_id: int, document_id: int, title: str, style: Any, doc: dict, template: str,
             scope: dict, coverage: dict) -> dict:
    row = notebook._get_row(notebook_id)
    if row["kind"] != "reading" or row["document_id"] != document_id:
        raise HTTPException(400, "That notebook isn't a deck of this document")
    with sess._connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        # Keep the deck as it is right now, always: a rewrite replaces it, and the
        # user's latest edits must survive as a version even if they saved a
        # moment ago (the five-minute throttle is for autosave, not for this).
        current = conn.execute("SELECT * FROM notebooks WHERE id = ?", (notebook_id,)).fetchone() or row
        notebook._snapshot(conn, current, force=True)
        conn.execute(
            "UPDATE notebooks SET title = ?, style_json = ?, doc_json = ?, template = ?, scope_json = ?, coverage_json = ?, "
            "version = version + 1, edited = 0, generated_at = ?, updated_at = ? WHERE id = ?",
            (title, json.dumps(notebook.clean_style(style if style is not None else json.loads(row["style_json"]), "reading")),
             json.dumps(doc), template, json.dumps(scope), json.dumps(coverage), _now(), _now(), notebook_id),
        )
    return notebook.get_notebook(notebook_id)


def decks_for(document_id: int) -> list[dict]:
    with sess._connect() as conn:
        rows = conn.execute("SELECT * FROM notebooks WHERE kind = 'reading' AND document_id = ? ORDER BY updated_at DESC",
                            (document_id,)).fetchall()
    return [notebook._row_to_dict(r, full=False) for r in rows]


def pages_text(document_id: int, pages: list[int]) -> list[dict]:
    """The text of a few pages, for "where did this come from"."""
    pages = sorted(set(pages))[:6]
    with sess._connect() as conn:
        rows = conn.execute(
            f"SELECT page, label, text FROM document_pages WHERE document_id = ? AND page IN ({','.join('?' * len(pages))})",
            (document_id, *pages)).fetchall() if pages else []
    return [{"page": r["page"], "label": r["label"], "text": r["text"]} for r in rows]


def shortfall(credits: Optional[float]) -> Optional[dict]:
    """
    {"available": n} when a job priced at `credits` is more than the account
    has; None when it is affordable, priced in dollars (the admin's own keys),
    or the balance can't be read (the service still refuses a call it can't cover).
    """
    if credits is None:
        return None
    from .core import account
    try:
        available = float(account.balance().get("available") or 0)
    except Exception:                             # noqa: BLE001 - offline or signed out: the service decides
        return None
    return {"available": available} if credits > available else None


# ── Help while reading (Deep Read, B3) ───────────────────────────────────────

SIMPLIFY_PROMPT = """You rewrite one paragraph of a reader's notes in plainer words, as JSON only.
The reader is {level}.
You also get the text of the page(s) the paragraph came from, for context only.

- Say the same thing, simpler: shorter sentences, everyday words, the technical terms kept but explained in passing.
- Faithful: add nothing the paragraph or its pages do not say, keep numbers and names exactly, keep the author's hedges.
- If the paragraph is already plain, say it again briefly anyway.

Return ONLY: {{"plain": "the paragraph in plainer words"}}"""

#: How much of the source pages goes along, for context.
SIMPLIFY_CONTEXT_CHARS = 6000

#: The other ways to understand a paragraph (the Simplify menu). Anything they add beyond the paragraph and its
#: pages is iReliabee's, and the app labels it so.
UNDERSTAND_PROMPT = """You help a reader understand one paragraph of their notes, as JSON only.
The reader is {level}.
You also get the text of the page(s) the paragraph came from, for context only.

{task}

- Keep every number, name and hedge in the paragraph exactly; never change what it claims.
- Never invent facts about the paragraph's subject: studies, figures, dates or people it does not mention.

Return ONLY: {shape}"""

UNDERSTAND_MODES = {
    "newcomer": ("First give, in 2 or 3 sentences, the background the paragraph takes for granted: what its key ideas "
                 "are and why they matter. Then say what the paragraph itself says, simply.",
                 '{{"plain": "the background, then what it says"}}'),
    "example": ("Give one concrete, everyday example that shows what the paragraph means in practice. Make clear it "
                "is an illustration, not something from the text.",
                '{{"plain": "the example"}}'),
    "analogy": ("Give one everyday analogy that makes the paragraph's idea click, then one short sentence on where "
                "the analogy stops fitting.",
                '{{"plain": "the analogy, then where it stops fitting"}}'),
    "steps": ("Break the paragraph down into 3 to 6 short numbered steps that follow its reasoning: what it claims, "
              "why (the evidence or reasons it gives), and what follows. One line each, starting \"1.\", \"2.\"...",
              '{{"plain": "1. ...\\n2. ...\\n3. ..."}}'),
    "terms": ("List every technical or unfamiliar term in the paragraph, including names of datasets, tools, "
              "methods, organisations and acronyms. For each, one sentence on what it means here, at the reader's "
              "level, and whether the page text says so (\"source\") or it is general knowledge (\"general\").",
              '{{"plain": "", "terms": [{{"term": "...", "meaning": "...", "from": "source" | "general"}}]}}'),
}
SIMPLIFY_MODES = ("plainer", *UNDERSTAND_MODES)


async def simplify(document_id: Optional[int], text: str, pages: list[int], level: str = DEFAULT_LEVEL,
                   model: Optional[str] = None, mode: str = "plainer") -> dict:
    """One paragraph understood another way, with its page(s) as context: {"plain": "...", "terms": [...]}.

    "plainer" rewrites it in plainer words; the Simplify menu's other modes explain it for a newcomer, give an
    example or an analogy, break it into steps, or list its key terms (UNDERSTAND_MODES)."""
    text = (text or "").strip()[:2000]
    if not text:
        raise HTTPException(400, detail={"code": "invalid", "title": "Nothing to simplify",
                                         "message": "Put the cursor in a paragraph first."})
    level = level if level in LEVELS else DEFAULT_LEVEL
    context = ""
    if document_id:
        texts = page_texts(document_id, sorted(set(p for p in pages if isinstance(p, int)))[:3])
        context = "\n\n".join(f"[p. {p}]\n{t}" for p, t in texts.items())[:SIMPLIFY_CONTEXT_CHARS]
    message = f"PARAGRAPH\n{text}" + (f"\n\nSOURCE PAGES (context only)\n{context}" if context else "")
    mode = mode if mode in SIMPLIFY_MODES else "plainer"
    if mode == "plainer":
        system = SIMPLIFY_PROMPT.format(level=LEVELS[level])
    else:
        task, shape = UNDERSTAND_MODES[mode]
        system = UNDERSTAND_PROMPT.format(level=LEVELS[level], task=task, shape=shape.replace("{{", "{").replace("}}", "}"))
    raw = await _ask(model, system + languages.json_block(None), message, document_id or 0, kind="simplify")
    raw = raw if isinstance(raw, dict) else {}
    plain = str(raw.get("plain") or "").strip()
    terms = []
    if mode == "terms":
        for t in raw.get("terms") or []:
            if isinstance(t, dict) and str(t.get("term") or "").strip() and str(t.get("meaning") or "").strip():
                terms.append({"term": str(t["term"]).strip()[:120], "meaning": str(t["meaning"]).strip()[:600],
                              "from": "source" if t.get("from") == "source" else "general"})
        terms = terms[:12]
    if not plain and not terms:
        raise HTTPException(502, detail={"code": "unknown", "title": "Nothing came back", "message": "Try again in a moment."})
    return {"plain": plain[:3000], **({"terms": terms} if mode == "terms" else {})}


# ── Look it up: explain any words the reader selects ────────────────────────

LOOKUP_PROMPT = """You explain words a reader selected in their notes, as JSON only.
The reader is {level}. They asked for {depth}.
You get the SELECTION, the LINE it sits in, and (when there is one) text from the SOURCE they are reading:
the pages the line cites and pages where the selection is mentioned, each marked [p. N].

- Explain what the selection means here, in this line's sense: 1 to 3 sentences.
- Use the SOURCE first. If it explains or describes the selection, say so and give those pages.
- If the SOURCE does not explain it (a dataset, tool, organisation, person, acronym or method the author assumes
  the reader knows), explain it from general knowledge, and mark it as such. Never present general knowledge
  as the author's.
- If you are not sure what a name refers to, say what it most likely is and set "unsure" to true. Never invent
  facts, figures, dates or affiliations.
- A longer selection (a phrase or sentence): explain what it says and any terms in it.
- "example": one short everyday example or comparison that makes it click, or "" if none helps.

Return ONLY: {{"meaning": "...", "example": "...", "from": "source" | "general" | "both", "pages": [page numbers used], "unsure": false}}"""

LOOKUP_DEPTHS = {
    "basic": "a very clear, basic explanation: everyday words, short sentences, no jargon",
    "technical": "a technical explanation: the field's precise terms, as a specialist would put it",
}
#: Selections up to this long are looked up once per document, depth and level, then kept.
LOOKUP_CACHE_CHARS = 80
LOOKUP_SOURCE_CHARS = 7000


def _ensure_lookup_schema() -> None:
    with sess._connect() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS reading_lookups (
                   key        TEXT PRIMARY KEY,   -- hash of the words, document, depth, level and model
                   result     TEXT NOT NULL,      -- JSON {meaning, example, from, pages, unsure}
                   created_at TEXT NOT NULL
               )"""
        )


_ensure_lookup_schema()


def mentions(document_id: int, words: str, limit: int = 3) -> list[int]:
    """Pages of the document that mention these words (whole words, any case), first ones first."""
    words = words.strip()
    if not words:
        return []
    pattern = re.compile(r"(?<![\w])" + re.escape(words) + r"(?![\w])", re.IGNORECASE)
    return [page for page, text in page_texts(document_id).items() if pattern.search(text)][:limit]


def _lookup_key(text: str, document_id: int, depth: str, level: str, model_id: str) -> str:
    raw = "\x1f".join([re.sub(r"\s+", " ", text.strip().lower()), str(document_id), depth, level, model_id])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _clean_lookup(raw: Any, pages_sent: set[int]) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    meaning = str(raw.get("meaning") or "").strip()[:1500]
    source = raw.get("from") if raw.get("from") in ("source", "general", "both") else "general"
    # Only pages that were actually sent can be cited: a page the model names from nowhere is dropped.
    pages = sorted({p for p in raw.get("pages") or [] if isinstance(p, int) and p in pages_sent})[:5]
    if source != "general" and not pages:
        source = "general"
    return {"meaning": meaning, "example": str(raw.get("example") or "").strip()[:600],
            "from": source, "pages": pages, "unsure": bool(raw.get("unsure"))}


async def lookup(text: str, line: str = "", document_id: Optional[int] = None, pages: Optional[list[int]] = None,
                 depth: str = "basic", level: str = DEFAULT_LEVEL, model: Optional[str] = None,
                 fallback_credits: bool = False) -> dict:
    """What the selected words mean, from the source when it says, else general knowledge, labelled which."""
    text = re.sub(r"\s+", " ", (text or "")).strip()[:600]
    if not text:
        raise HTTPException(400, detail={"code": "invalid", "title": "Nothing selected",
                                         "message": "Select a word or a few words in your notes first."})
    depth = depth if depth in LOOKUP_DEPTHS else "basic"
    level = level if level in LEVELS else DEFAULT_LEVEL
    doc = int(document_id or 0)
    # Kept per model asked for ("" is the account's default), so switching models asks again.
    key = _lookup_key(text, doc, depth, level, model or "") if len(text) <= LOOKUP_CACHE_CHARS else None
    if key:
        with sess._connect() as conn:
            row = conn.execute("SELECT result FROM reading_lookups WHERE key = ?", (key,)).fetchone()
        if row:
            return {**json.loads(row["result"]), "cached": True}

    source, sent = "", set()
    if doc:
        wanted = sorted(set(p for p in (pages or []) if isinstance(p, int)))[:3]
        wanted += [p for p in (mentions(doc, text) if len(text) <= LOOKUP_CACHE_CHARS else []) if p not in wanted]
        texts = page_texts(doc, wanted)
        sent = set(texts)
        source = "\n\n".join(f"[p. {p}]\n{t}" for p, t in sorted(texts.items()))[:LOOKUP_SOURCE_CHARS]
    message = f"SELECTION\n{text}\n\nLINE\n{(line or '').strip()[:1500] or '(none)'}" + (f"\n\nSOURCE\n{source}" if source else "")
    system = LOOKUP_PROMPT.format(level=LEVELS[level], depth=LOOKUP_DEPTHS[depth]) + languages.json_block(None)
    from .errors import FriendlyError
    try:
        from .core.providers import metering_context, fallback_credits_context, is_fallback_credits
        effective_fallback = fallback_credits or is_fallback_credits()
        with metering_context("explain"), fallback_credits_context(effective_fallback):
            raw = await _ask(model, system, message, doc, kind="explain")
    except FriendlyError as fe:
        raise fe.http()
    result = _clean_lookup(raw, sent)
    if not result["meaning"]:
        raise HTTPException(502, detail={"code": "unknown", "title": "Nothing came back", "message": "Try again in a moment."})
    if key:
        with sess._connect() as conn:
            conn.execute("INSERT OR REPLACE INTO reading_lookups (key, result, created_at) VALUES (?, ?, ?)",
                         (key, json.dumps(result), _now()))
    return {**result, "cached": False}


# ── Mind map: a passage drawn as a centre idea and its branches ─────────────

MIND_MAP_PROMPT = """You turn a passage a reader highlighted into a mind map, as JSON only.
The reader is {level}.
You get the PASSAGE and, when there is one, text from the SOURCE it came from, each page marked [p. N].

- "center": the passage's main idea in 1 to 4 words.
- "branches": 3 to 6 ideas the passage rests on, each a short "label" (1 to 4 words) and a "note"
  (one plain sentence saying what it means here), with 0 to 4 "children" of the same shape for the
  details, examples or causes under it.
- Take every idea from the PASSAGE or the SOURCE. Never invent facts, figures, names or quotes.
- "pages": the SOURCE pages that say it, only pages you were given; [] when it is only in the passage.

Return ONLY: {{"center": "...", "branches": [{{"label": "...", "note": "...", "pages": [], "children": [{{"label": "...", "note": "...", "pages": []}}]}}]}}"""

MIND_MAP_CHARS = 4000


def _clean_node(raw: Any, pages_sent: set[int], depth: int) -> Optional[dict]:
    if not isinstance(raw, dict):
        return None
    label = re.sub(r"\s+", " ", str(raw.get("label") or "")).strip()[:60]
    if not label:
        return None
    node = {"label": label, "note": str(raw.get("note") or "").strip()[:400],
            "pages": sorted({p for p in raw.get("pages") or [] if isinstance(p, int) and p in pages_sent})[:4]}
    if depth == 0:
        kids = [_clean_node(c, pages_sent, 1) for c in (raw.get("children") or [])[:4]]
        node["children"] = [k for k in kids if k]
    return node


def clean_mind_map(raw: Any, pages_sent: set[int]) -> dict:
    """The model's map, kept to its shape: a centre, 1 to 6 branches, up to 4 leaves each, real pages only."""
    raw = raw if isinstance(raw, dict) else {}
    center = re.sub(r"\s+", " ", str(raw.get("center") or "")).strip()[:60]
    branches = [b for b in (_clean_node(b, pages_sent, 0) for b in (raw.get("branches") or [])[:6]) if b]
    return {"center": center, "branches": branches}


async def mind_map(passage: str, document_id: Optional[int] = None, pages: Optional[list[int]] = None,
                   level: str = DEFAULT_LEVEL, model: Optional[str] = None, fallback_credits: bool = False) -> dict:
    """A mind map of a highlighted passage, grounded in the source pages that mention it."""
    passage = re.sub(r"\s+", " ", passage or "").strip()[:MIND_MAP_CHARS]
    if len(passage) < 3:
        raise HTTPException(400, detail={"code": "invalid", "title": "Nothing selected",
                                         "message": "Highlight a sentence or a paragraph first."})
    level = level if level in LEVELS else DEFAULT_LEVEL
    doc = int(document_id or 0)
    source, sent = "", set()
    if doc:
        wanted = sorted(set(p for p in (pages or []) if isinstance(p, int)))[:3]
        if len(passage) <= LOOKUP_CACHE_CHARS:
            wanted += [p for p in mentions(doc, passage) if p not in wanted]
        texts = page_texts(doc, wanted)
        sent = set(texts)
        source = "\n\n".join(f"[p. {p}]\n{t}" for p, t in sorted(texts.items()))[:LOOKUP_SOURCE_CHARS]
    message = f"PASSAGE\n{passage}" + (f"\n\nSOURCE\n{source}" if source else "")
    system = MIND_MAP_PROMPT.format(level=LEVELS[level]) + languages.json_block(None)
    from .errors import FriendlyError
    from .core.providers import metering_context, fallback_credits_context, is_fallback_credits
    try:
        with metering_context("explain"), fallback_credits_context(fallback_credits or is_fallback_credits()):
            raw = await _ask(model, system, message, doc, kind="mind_map")
    except FriendlyError as fe:
        raise fe.http()
    result = clean_mind_map(raw, sent)
    if not result["center"] or len(result["branches"]) < 2:
        raise HTTPException(502, detail={"code": "unknown", "title": "No map came back",
                                         "message": "Try again, or highlight a longer passage."})
    return result


# ── Follow-up questions: ask about what was just explained ───────────────────

ASK_PROMPT = """You answer a reader's follow-up question about a passage of their notes, as JSON only.
The reader is {level}.
You get the PASSAGE (the words or paragraph they are asking about), the EXPLANATION they were already given,
the CONVERSATION so far, the NOTEBOOK they are working in (its title and summary), and, when there is one,
text from the SOURCE they are reading, each page marked [p. N]. Then their QUESTION.

- Answer the question directly in 1 to 5 sentences, at the reader's level. No preamble.
- Use the SOURCE first; say which pages. If the answer is not in the SOURCE, answer from general knowledge
  and mark it so. Never present general knowledge as the author's.
- "How does this connect to my work?": connect it to the NOTEBOOK's own subject; do not invent the reader's plans.
- If you do not know, or the question cannot be answered from what you have, say so plainly and set "unsure".
  Never invent studies, figures, dates, quotes or people.
- If the question is not about the passage or its subject, answer briefly and gently bring it back.

Return ONLY: {{"answer": "...", "from": "source" | "general" | "both", "pages": [page numbers used], "unsure": false}}"""

#: Turns of the conversation that go along with each question, and how long each may be.
ASK_HISTORY = 6
ASK_TURN_CHARS = 1200


async def ask(question: str, passage: str, explained: str = "", history: Optional[list[dict]] = None,
              document_id: Optional[int] = None, pages: Optional[list[int]] = None, notebook_id: Optional[int] = None,
              level: str = DEFAULT_LEVEL, model: Optional[str] = None) -> dict:
    """A follow-up question about a passage: {answer, from, pages, unsure}, grounded like lookup()."""
    question = re.sub(r"\s+", " ", question or "").strip()[:600]
    passage = (passage or "").strip()[:2000]
    if not question or not passage:
        raise HTTPException(400, detail={"code": "invalid", "title": "Nothing to ask",
                                         "message": "Type a question about the words or paragraph first."})
    level = level if level in LEVELS else DEFAULT_LEVEL
    doc = int(document_id or 0)

    source, sent = "", set()
    if doc:
        wanted = sorted(set(p for p in (pages or []) if isinstance(p, int)))[:3]
        if len(passage) <= LOOKUP_CACHE_CHARS:
            wanted += [p for p in mentions(doc, passage) if p not in wanted]
        texts = page_texts(doc, wanted)
        sent = set(texts)
        source = "\n\n".join(f"[p. {p}]\n{t}" for p, t in sorted(texts.items()))[:LOOKUP_SOURCE_CHARS]

    book = ""
    if notebook_id:
        try:
            nb = notebook.get_notebook(int(notebook_id))
            book = f"{nb.get('title') or nb['doc'].get('title') or ''}\n{nb['doc'].get('summary') or ''}".strip()[:1500]
        except Exception:  # a notebook deleted meanwhile: answer without it
            book = ""

    turns = []
    for t in (history or [])[-ASK_HISTORY:]:
        if isinstance(t, dict) and str(t.get("q") or "").strip() and str(t.get("a") or "").strip():
            turns.append(f"Q: {str(t['q']).strip()[:ASK_TURN_CHARS]}\nA: {str(t['a']).strip()[:ASK_TURN_CHARS]}")
    message = "\n\n".join([
        f"PASSAGE\n{passage}",
        f"EXPLANATION\n{(explained or '').strip()[:ASK_TURN_CHARS] or '(none)'}",
        "CONVERSATION\n" + ("\n".join(turns) or "(none)"),
        f"NOTEBOOK\n{book or '(none)'}",
        *([f"SOURCE\n{source}"] if source else []),
        f"QUESTION\n{question}",
    ])
    raw = await _ask(model, ASK_PROMPT.format(level=LEVELS[level]) + languages.json_block(None), message, doc, kind="explain_followup")
    raw = raw if isinstance(raw, dict) else {}
    answer = str(raw.get("answer") or "").strip()[:2500]
    if not answer:
        raise HTTPException(502, detail={"code": "unknown", "title": "Nothing came back", "message": "Try again in a moment."})
    cleaned = _clean_lookup({"meaning": answer, "from": raw.get("from"), "pages": raw.get("pages"),
                             "unsure": raw.get("unsure")}, sent)
    return {"answer": cleaned["meaning"], "from": cleaned["from"], "pages": cleaned["pages"], "unsure": cleaned["unsure"]}


# ── Check your understanding: one question on a paragraph, then mark the answer ─

CHECK_QUESTION_PROMPT = """You write one question that checks whether a reader understood a paragraph of their notes, as JSON only.
The reader is {level}. You also get the text of the page(s) the paragraph came from, for context only.

- Ask about the paragraph's main idea or reasoning, not a detail to recall word for word: "why", "what would
  happen if", "what is the difference between", or "explain in your own words". One question, one sentence.
- Do not ask something the paragraph cannot answer. Avoid yes/no questions.{avoid}
- "points": the 2 to 4 things a good answer must contain, each one short sentence, taken from the paragraph.

Return ONLY: {{"question": "...", "points": ["...", "..."]}}"""

CHECK_MARK_PROMPT = """You mark a reader's answer to a question about a paragraph of their notes, as JSON only.
The reader is {level}. You get the PARAGRAPH, the QUESTION, the numbered POINTS a good answer contains, and the ANSWER.

Judge ONLY against the paragraph and the points: which points the answer gets (in the reader's own words is fine),
which it misses, and anything it gets wrong. Be kind and specific; never invent content the paragraph does not say.

Return ONLY: {{"got": [point numbers], "missed": [point numbers], "wrong": [{{"said": "what they wrote", "fix": "what the paragraph says"}}],
  "score": 0-100, "note": "one encouraging sentence on what to look at again"}}"""


def _paragraph_context(document_id: Optional[int], pages: Optional[list[int]]) -> str:
    if not document_id:
        return ""
    texts = page_texts(int(document_id), sorted(set(p for p in (pages or []) if isinstance(p, int)))[:3])
    return "\n\n".join(f"[p. {p}]\n{t}" for p, t in texts.items())[:SIMPLIFY_CONTEXT_CHARS]


async def check_question(text: str, document_id: Optional[int] = None, pages: Optional[list[int]] = None,
                         level: str = DEFAULT_LEVEL, avoid: Optional[list[str]] = None, model: Optional[str] = None) -> dict:
    """One question about a paragraph, with the points a good answer contains: {question, points}."""
    text = (text or "").strip()[:2000]
    if not text:
        raise HTTPException(400, detail={"code": "invalid", "title": "Nothing to check",
                                         "message": "Put the cursor in the paragraph you want to be asked about."})
    level = level if level in LEVELS else DEFAULT_LEVEL
    asked = [str(q).strip()[:300] for q in (avoid or []) if str(q).strip()][:5]
    avoid_text = ("\n- Ask something different from these, already asked:\n" + "\n".join(f"  * {q}" for q in asked)) if asked else ""
    context = _paragraph_context(document_id, pages)
    message = f"PARAGRAPH\n{text}" + (f"\n\nSOURCE PAGES (context only)\n{context}" if context else "")
    raw = await _ask(model, CHECK_QUESTION_PROMPT.format(level=LEVELS[level], avoid=avoid_text) + languages.json_block(None),
                     message, int(document_id or 0), kind="check_question")
    raw = raw if isinstance(raw, dict) else {}
    question = str(raw.get("question") or "").strip()[:400]
    points = [str(p).strip()[:300] for p in (raw.get("points") or []) if str(p).strip()][:4]
    if not question or not points:
        raise HTTPException(502, detail={"code": "unknown", "title": "Nothing came back", "message": "Try again in a moment."})
    return {"question": question, "points": points}


async def check_answer(text: str, question: str, points: list[str], answer: str, level: str = DEFAULT_LEVEL,
                       document_id: Optional[int] = None, model: Optional[str] = None) -> dict:
    """What the answer got, missed and got wrong, against the paragraph: {score, got, missed, wrong, note, points}."""
    text, question, answer = (text or "").strip()[:2000], (question or "").strip()[:400], (answer or "").strip()[:2000]
    points = [str(p).strip()[:300] for p in (points or []) if str(p).strip()][:4]
    if not answer:
        raise HTTPException(400, detail={"code": "invalid", "title": "Nothing to mark",
                                         "message": "Write your answer in your own words first."})
    if not text or not question or not points:
        raise HTTPException(400, detail={"code": "invalid", "title": "The question is missing",
                                         "message": "Ask for a new question and try again."})
    level = level if level in LEVELS else DEFAULT_LEVEL
    numbered = "\n".join(f"{i + 1}. {p}" for i, p in enumerate(points))
    message = f"PARAGRAPH\n{text}\n\nQUESTION\n{question}\n\nPOINTS\n{numbered}\n\nANSWER\n{answer}"
    raw = await _ask(model, CHECK_MARK_PROMPT.format(level=LEVELS[level]) + languages.json_block(None),
                     message, int(document_id or 0), kind="check_mark")
    raw = raw if isinstance(raw, dict) else {}
    valid = range(1, len(points) + 1)
    got = sorted({n for n in raw.get("got") or [] if isinstance(n, int) and n in valid})
    missed = sorted({n for n in raw.get("missed") or [] if isinstance(n, int) and n in valid and n not in got})
    # A point neither got nor missed counts as missed: the reader should see every point.
    missed = sorted(set(missed) | (set(valid) - set(got)))
    wrong = [{"said": str(w.get("said") or "").strip()[:300], "fix": str(w.get("fix") or "").strip()[:400]}
             for w in raw.get("wrong") or [] if isinstance(w, dict) and str(w.get("fix") or "").strip()][:4]
    try:
        score = max(0, min(100, int(raw.get("score"))))
    except (TypeError, ValueError):
        score = round(100 * len(got) / len(points))
    return {"score": score, "got": got, "missed": missed, "wrong": wrong,
            "note": str(raw.get("note") or "").strip()[:300], "points": points}


# ── The fuller glossary: every unfamiliar term in a notebook ────────────────

FIND_TERMS_PROMPT = """You find the words in a reader's notes that the reader may not know, as JSON only.
The reader is {level}.

List every term in the NOTES that such a reader might not understand, INCLUDING names the notes use without
explaining: datasets, corpora, tools, software, models, organisations, acronyms and abbreviations, named methods
and statistical techniques, and technical words. Leave out everyday words, the reader's own name, and the terms
listed under ALREADY EXPLAINED. Use each term exactly as it is written in the notes. Order them as they first appear.
At most {limit}.

Return ONLY: {{"terms": ["...", "..."]}}"""

EXPLAIN_TERMS_PROMPT = """You explain terms from a reader's notes, as JSON only.
The reader is {level}. For each TERM you get the line of the notes it is used in and, when there is one,
passages from the SOURCE they are reading that mention it, each marked [p. N].

For each term: what it means here, in one or two sentences at the reader's level.
- Use the SOURCE passages first and give their pages; "from": "source".
- If the SOURCE does not explain it, explain it from general knowledge; "from": "general". Never present general
  knowledge as the author's.
- If you are not sure what a name refers to, say what it most likely is and set "unsure": true. Never invent
  facts, figures, dates or affiliations.

Return ONLY: {{"terms": [{{"term": "...", "meaning": "...", "from": "source" | "general" | "both", "pages": [...], "unsure": false}}]}}"""

#: How much of a notebook is read to find terms, and how much source goes with each term.
FIND_TERMS_NOTES_CHARS = 16000
FIND_TERMS_LIMIT = 30
TERM_SNIPPET_CHARS = 700
TERMS_SOURCE_CHARS = 14000


def _snippet(text: str, term: str, width: int = TERM_SNIPPET_CHARS) -> str:
    """The part of a page around the first mention of the term."""
    m = re.search(r"(?<![\w])" + re.escape(term) + r"(?![\w])", text, re.IGNORECASE)
    if not m:
        return ""
    start = max(0, m.start() - width // 2)
    return re.sub(r"\s+", " ", text[start:start + width]).strip()


def _line_with(notes: str, term: str) -> str:
    for line in notes.splitlines():
        if term.lower() in line.lower():
            return line.strip()[:400]
    return ""


async def find_terms(notebook_id: int, level: str = DEFAULT_LEVEL, model: Optional[str] = None) -> dict:
    """The unfamiliar terms in a notebook, explained: {"terms": [{term, meaning, from, pages, unsure}]}.

    Two calls: one reads the notes and lists the terms (the ones they already define left out), one explains
    them, each with the passages of the source document that mention it."""
    nb = notebook.get_notebook(int(notebook_id))
    level = level if level in LEVELS else DEFAULT_LEVEL
    notes = notebook.to_markdown(nb)[:FIND_TERMS_NOTES_CHARS]
    doc_id = int(nb.get("document_id") or 0)
    defined = sorted({str(b.get("term")).strip() for s in nb["doc"].get("sections") or [] for b in s.get("blocks") or []
                      if b.get("type") == "definition" and str(b.get("term") or "").strip()})
    known = defined + [t["term"] for t in nb["doc"].get("terms") or []]
    message = f"NOTES\n{notes}\n\nALREADY EXPLAINED\n" + ("\n".join(known[:80]) or "(none)")
    raw = await _ask(model, FIND_TERMS_PROMPT.format(level=LEVELS[level], limit=FIND_TERMS_LIMIT)
                     + languages.json_block(None), message, doc_id, kind="find_terms")
    raw = raw if isinstance(raw, dict) else {}
    have = {k.lower() for k in known}
    found, seen = [], set()
    for t in raw.get("terms") or []:
        term = re.sub(r"\s+", " ", str(t or "")).strip()[:120]
        if len(term) < 2 or term.lower() in have or term.lower() in seen:
            continue
        seen.add(term.lower())
        found.append(term)
    found = found[:FIND_TERMS_LIMIT]
    if not found:
        return {"terms": []}

    pages = page_texts(doc_id) if doc_id else {}
    blocks, sent = [], set()
    budget = TERMS_SOURCE_CHARS
    for term in found:
        parts = [f"TERM: {term}", f"LINE: {_line_with(notes, term) or '(not found)'}"]
        for page, text in pages.items():
            snip = _snippet(text, term)
            if snip and budget > 0:
                parts.append(f"[p. {page}] {snip}")
                sent.add(page)
                budget -= len(snip)
                break
        blocks.append("\n".join(parts))
    raw = await _ask(model, EXPLAIN_TERMS_PROMPT.format(level=LEVELS[level]) + languages.json_block(None),
                     "\n\n".join(blocks), doc_id, kind="explain_terms")
    raw = raw if isinstance(raw, dict) else {}
    wanted = {t.lower() for t in found}
    out = []
    for t in raw.get("terms") or []:
        if not isinstance(t, dict) or str(t.get("term") or "").strip().lower() not in wanted:
            continue
        c = _clean_lookup({"meaning": t.get("meaning"), "from": t.get("from"), "pages": t.get("pages"),
                           "unsure": t.get("unsure")}, sent)
        if c["meaning"]:
            out.append({"term": str(t["term"]).strip(), "meaning": c["meaning"], "from": c["from"],
                        "pages": c["pages"], "unsure": c["unsure"]})
    return {"terms": notebook.clean_terms(out)}


# ── Explain it back (Deep Read, B4) ──────────────────────────────────────────

EXPLAIN_PROMPT = """You check a reader's explanation of one chapter of their reading notes, as JSON only.
The reader is {level}. You get the chapter's notes as numbered items (with the pages they cite), then what the
reader wrote from memory.

Judge ONLY against the numbered items: what the reader got (in their own words is fine), what they missed that
matters, and anything they got wrong. Be kind and specific; never invent content that is not in the items.

Return ONLY:
{{"got": ["B2", "B5"], "missed": ["B3"], "wrong": [{{"said": "what they wrote", "fix": "what the notes say", "item": "B4"}}],
  "score": 0-100 (how much of what matters they explained correctly), "note": "one encouraging sentence on what to go over"}}"""

#: What an explanation is checked against: the chapter's substance, not its questions or photos.
_EXPLAINABLE = ("point", "key", "definition", "example", "formula", "quote", "exam", "note")


def _chapter(notebook_id: int, section_id: str) -> tuple[dict, dict]:
    nb = notebook.get_notebook(notebook_id)
    sec = next((s for s in nb["doc"]["sections"] if s.get("id") == section_id), None)
    if sec is None:
        raise HTTPException(404, detail={"code": "not_found", "title": "That chapter isn't in these notes any more",
                                         "message": "Turn to a chapter and try again."})
    return nb, sec


async def explain_back(notebook_id: int, section_id: str, said: str, level: Optional[str] = None,
                       model: Optional[str] = None) -> dict:
    """Mark what the reader explained from memory against one chapter's notes, and keep the score."""
    said = (said or "").strip()[:6000]
    if len(said.split()) < 5:
        raise HTTPException(400, detail={"code": "invalid", "title": "Say a little more",
                                         "message": "Explain the chapter in a few sentences, from memory, then check."})
    nb, sec = _chapter(notebook_id, section_id)
    items = [b for b in sec.get("blocks", []) if b.get("type") in _EXPLAINABLE and (b.get("text") or "").strip()]
    if not items:
        raise HTTPException(400, detail={"code": "invalid", "title": "Nothing to check against here",
                                         "message": "Turn to a chapter with notes on it."})
    level = level if level in LEVELS else (nb.get("scope") or {}).get("level", DEFAULT_LEVEL)
    level = level if level in LEVELS else DEFAULT_LEVEL
    numbered = {f"B{i + 1}": b for i, b in enumerate(items)}
    listing = "\n".join(
        f"{k} [{b['type']}]{' (p. ' + ', '.join(map(str, b.get('src') or [])) + ')' if b.get('src') else ''} "
        f"{(b.get('term') + ': ') if b.get('term') else ''}{b['text']}" for k, b in numbered.items())
    raw = await _ask(model, EXPLAIN_PROMPT.format(level=LEVELS[level]) + languages.json_block(None),
                     f"CHAPTER: {sec['title']}\n{listing}\n\nWHAT THE READER WROTE\n{said}", nb.get("document_id") or 0, kind="explain_back")
    raw = raw if isinstance(raw, dict) else {}

    def item(k: str) -> Optional[dict]:
        b = numbered.get(k) if isinstance(k, str) else None
        return {"text": (f"{b['term']}: " if b.get("term") else "") + b["text"], "src": b.get("src") or []} if b else None

    got = [x for x in (item(k) for k in raw.get("got") or []) if x]
    missed = [x for x in (item(k) for k in raw.get("missed") or []) if x]
    wrong = []
    for w in raw.get("wrong") or []:
        if isinstance(w, dict) and str(w.get("said") or "").strip():
            ref = item(w.get("item"))
            wrong.append({"said": str(w["said"])[:400], "fix": str(w.get("fix") or "")[:600], "src": ref["src"] if ref else []})
    try:
        score = max(0, min(100, int(raw.get("score"))))
    except (TypeError, ValueError):
        score = round(100 * len(got) / len(items))
    with sess._connect() as conn:
        conn.execute(
            "INSERT INTO reading_progress (notebook_id, section_id, score, missed, tries, updated_at) VALUES (?, ?, ?, ?, 1, ?) "
            "ON CONFLICT (notebook_id, section_id) DO UPDATE SET score = MAX(score, excluded.score), missed = excluded.missed, "
            "tries = tries + 1, updated_at = excluded.updated_at",
            (notebook_id, section_id, score, len(missed), _now()))
    return {"score": score, "got": got, "missed": missed, "wrong": wrong, "note": str(raw.get("note") or "")[:300],
            "progress": progress(notebook_id)}


def progress(notebook_id: int) -> dict:
    """How far the reader has got with a notebook: chapters explained back, and the best score for each."""
    nb = notebook.get_notebook(notebook_id)
    chapters = [s for s in nb["doc"]["sections"]
                if s.get("title") not in ("Map of the text", "Glossary, in learning order")
                and any(b.get("type") in _EXPLAINABLE for b in s.get("blocks", []))]
    with sess._connect() as conn:
        rows = conn.execute("SELECT section_id, score, tries, updated_at FROM reading_progress WHERE notebook_id = ?",
                            (notebook_id,)).fetchall()
    by_id = {r["section_id"]: {"score": r["score"], "tries": r["tries"], "at": r["updated_at"]} for r in rows}
    ids = {s["id"] for s in chapters}
    done = [v for k, v in by_id.items() if k in ids]
    return {"chapters": len(chapters), "explained": len(done), "understood": sum(1 for v in done if v["score"] >= 70),
            "sections": {k: v for k, v in by_id.items() if k in ids}}
