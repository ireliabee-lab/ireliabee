"""
Wordcraft's dictionary and phrase builder, all on this computer (docs/dictionary.md).

    GET  /dictionary/status        installed?, how many words, download progress, data credits
    POST /dictionary/download      download it once (in the background)
    GET  /dictionary/lookup?q=     meanings, examples, synonyms, sentences, phrase builder
    GET  /dictionary/suggest?q=    words starting with q, for the search box
"""
from fastapi import APIRouter

from .. import dictionary

router = APIRouter()


@router.get("/status")
def status():
    return dictionary.status()


@router.post("/download")
def download():
    return dictionary.start_download()


@router.get("/lookup")
def lookup(q: str):
    return dictionary.lookup(q)


@router.get("/suggest")
def suggest(q: str, limit: int = 8):
    return {"words": dictionary.suggest(q, limit)}
