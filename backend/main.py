"""
FastAPI backend — HTTP/WebSocket API over the coach core (backend/core).
"""
import asyncio
import json
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from contextlib import asynccontextmanager

from .core.config import load_env, load_config, PROVIDERS
load_env()

from .core import sessions as sess
# Before any module sets up its tables at import time: a corrupt database is
# moved aside rather than stopping the backend (audit 181-H10).
sess.open_or_recover()
from .core import profile_store
from .core import licence
from .core import account as account_core
from .core.meeting_plans import list_plans, get_plan
from .core.research import run_full_research

from backend.routers import audio, coach, plans, profiles, config as config_router, sessions as sessions_router, cvs as cvs_router, documents as documents_router, mock as mock_router, stories as stories_router, drills as drills_router, progress as progress_router, confidence as confidence_router, notes as notes_router, presentation as presentation_router, meeting_prep as meeting_prep_router, transfer as transfer_router, usage as usage_router, people as people_router, retry as retry_router, calendar as calendar_router, licence as licence_router, account as account_router, notebook as notebook_router, reading as reading_router, boards as boards_router, research_track as research_track_router, wordcraft as wordcraft_router, suggest as suggest_router, mcp as mcp_router, links as links_router, study_reviews as study_router, talk_drills as talk_router, dictionary as dictionary_router, writing as writing_router

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Trigger DB schema creation on startup (each module auto-creates on first connect)
    sess.list_sessions(limit=1)
    profile_store.list_profiles()
    licence.refresh_in_background()
    account_core.keep_fresh_in_background()
    yield

def _app_version() -> str:
    # The desktop app passes its own version to the bundled backend; from source,
    # read it from the Tauri config that release-please bumps.
    if os.environ.get("IRELIABEE_VERSION"):
        return os.environ["IRELIABEE_VERSION"]
    try:
        conf = Path(__file__).resolve().parent.parent / "frontend" / "src-tauri" / "tauri.conf.json"
        return json.loads(conf.read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError):
        return "dev"


APP_VERSION = _app_version()

app = FastAPI(title="iReliabee", version=APP_VERSION, lifespan=lifespan)

# Only this app may use the backend: every web page can reach 127.0.0.1, and
# CORS alone stops none of a WebSocket, an <img> or a form post (audit
# 180-C3). The guard is inner, so CORS answers preflights and labels its
# refusals for the app's own page.
from .core.local_guard import ALLOWED_ORIGINS, LocalGuard

app.add_middleware(LocalGuard)
class CreditsFallbackMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            headers = dict(scope.get("headers", []))
            if headers.get(b"x-irb-use-credits") == b"1":
                from .core.providers import fallback_credits_context
                with fallback_credits_context(True):
                    await self.app(scope, receive, send)
                return
        await self.app(scope, receive, send)


app.add_middleware(CreditsFallbackMiddleware)


class RecordPortMiddleware:
    """Learn this backend's own port from the first request it serves. The packaged app records
    it at start (main_bundled.py); run from source (uvicorn) nothing did until /relay/status was
    asked, so a Claude Code run the app started was pointed at whatever relay.json said, which
    can be another backend's port."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            from . import relay
            server = scope.get("server")
            if relay.known_port() is None and server and server[1]:
                relay.record_port(int(server[1]))
        await self.app(scope, receive, send)


app.add_middleware(RecordPortMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["x-irb-auth"],
)

from .errors import FriendlyError, HTTP_STATUS


@app.exception_handler(FriendlyError)
async def friendly_error_handler(request, exc: FriendlyError):
    return JSONResponse(status_code=HTTP_STATUS.get(exc.code, 502), content={"detail": exc.as_dict()})


app.include_router(audio.router,         prefix="/audio",    tags=["audio"])
app.include_router(coach.router,         prefix="/coach",    tags=["coach"])
app.include_router(plans.router,         prefix="/plans",    tags=["plans"])
app.include_router(profiles.router,      prefix="/profiles", tags=["profiles"])
app.include_router(config_router.router,   prefix="/config",   tags=["config"])
app.include_router(sessions_router.router, prefix="/sessions", tags=["sessions"])
app.include_router(cvs_router.router,      prefix="/cvs",      tags=["cvs"])
app.include_router(documents_router.router, prefix="/documents", tags=["documents"])
app.include_router(mock_router.router,     prefix="/mock",     tags=["mock"])
app.include_router(stories_router.router,  prefix="/stories",  tags=["stories"])
app.include_router(drills_router.router,   prefix="/drills",   tags=["drills"])
app.include_router(progress_router.router, prefix="/progress", tags=["progress"])
app.include_router(confidence_router.router, prefix="/confidence", tags=["confidence"])
app.include_router(notes_router.router, prefix="/notes", tags=["notes"])
app.include_router(presentation_router.router, prefix="/presentation", tags=["presentation"])
app.include_router(meeting_prep_router.router, prefix="/meeting-prep", tags=["meeting-prep"])
app.include_router(transfer_router.router, prefix="/transfer", tags=["transfer"])
app.include_router(usage_router.router, prefix="/usage", tags=["usage"])
app.include_router(people_router.router, prefix="/people", tags=["people"])
app.include_router(retry_router.router, prefix="/retry", tags=["retry"])
app.include_router(calendar_router.router, prefix="/calendar", tags=["calendar"])
app.include_router(licence_router.router, prefix="/licence", tags=["licence"])
app.include_router(account_router.router, prefix="/account", tags=["account"])
app.include_router(notebook_router.router, prefix="/notebooks", tags=["notebooks"])
app.include_router(boards_router.router,   prefix="/boards",   tags=["boards"])
app.include_router(reading_router.router, prefix="/reading", tags=["reading"])
app.include_router(links_router.router, prefix="/links", tags=["links"])
app.include_router(research_track_router.router, prefix="/research", tags=["research"])
app.include_router(writing_router.router, prefix="/writing", tags=["writing"])
app.include_router(wordcraft_router.router, prefix="/wordcraft", tags=["wordcraft"])
app.include_router(study_router.router, prefix="/study", tags=["study"])
app.include_router(talk_router.router, prefix="/talk", tags=["talk"])
app.include_router(dictionary_router.router, prefix="/dictionary", tags=["dictionary"])
app.include_router(suggest_router.router, prefix="/suggest", tags=["suggest"])
app.include_router(mcp_router.router, tags=["mcp"])

@app.get("/status")
def status():
    cfg = load_config()
    return {"version": APP_VERSION, "providers": list(PROVIDERS.keys()), "config": cfg,
            # Startup found the sessions database unreadable and started afresh.
            "recovered_db": sess.RECOVERED or None}
