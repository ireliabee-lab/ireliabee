"""Shared checks for CV and document uploads."""
from __future__ import annotations

from fastapi import HTTPException, UploadFile
from starlette.concurrency import run_in_threadpool

ALLOWED_TYPES = {".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown"}


def _error(title: str, message: str) -> HTTPException:
    return HTTPException(400, {"code": "invalid", "title": title, "message": message})


async def read_valid_upload(file: UploadFile, max_mb: int, what: str) -> tuple[str, str, bytes]:
    """Returns (filename, mime, data) or raises a friendly 400."""
    filename = file.filename or what
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext not in ALLOWED_TYPES:
        raise _error("Unsupported file type", f"Upload your {what} as a PDF, .txt or .md file.")
    limit = max_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if not data:
        raise _error("Empty file", "That file has no content.")
    if len(data) > limit:
        raise _error("File too large", f"Files can be up to {max_mb} MB. Try exporting a smaller PDF.")
    if ext == ".pdf":
        if not data.startswith(b"%PDF"):
            raise _error("Not a valid PDF", "This file isn't a readable PDF. Re-export it and try again.")
        from .document_store import extract_text, remember_checked
        # Reading a PDF is seconds of CPU for a big one: off the event loop, so live
        # audio and streaming answers don't stall while it runs.
        text = await run_in_threadpool(extract_text, filename, "application/pdf", data)
        remember_checked(data, text)
        if not text.strip():
            raise _error(
                "No readable text in this PDF",
                "It looks like a scanned image, so the coach can't read it. Export it as a text-based PDF.",
            )
    return filename, ALLOWED_TYPES[ext], data
