"""Reading notes (spec 185): upload a paper or book, choose what to cover, make a deck."""
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from .. import reading
from ..entitlements import require_pro

router = APIRouter()


@router.get("/templates")
def templates():
    return {"templates": [{"id": k, **v} for k, v in reading.TEMPLATES.items()],
            "limits": {"upload_mb": reading.MAX_UPLOAD_MB, "pages": reading.MAX_PAGES, "run_pages": reading.RUN_PAGE_CAP}}


@router.post("/upload")
async def upload(file: UploadFile = File(...), name: str = Form(None)):
    # Copying and storing a large file is blocking work: do it off the event loop.
    doc_id = await run_in_threadpool(reading.save_upload, file.file, file.filename or "", name)
    return reading.status(doc_id)


@router.get("/documents/{doc_id}")
def document_status(doc_id: int):
    return reading.status(doc_id)


@router.post("/documents/{doc_id}/read")
async def read_again(doc_id: int):
    """Read a Library PDF (one uploaded before reading notes existed, or one that failed)."""
    return await run_in_threadpool(reading.start_reading, doc_id)


@router.post("/documents/{doc_id}/cancel")
def cancel(doc_id: int):
    return reading.cancel_reading(doc_id)


@router.get("/documents/{doc_id}/pages")
def pages(doc_id: int, p: str = Query(..., description="pages, e.g. 12,13")):
    try:
        wanted = [int(x) for x in p.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(400, "Pages must be numbers")
    return {"pages": reading.pages_text(doc_id, wanted)}


@router.get("/documents/{doc_id}/find")
def find(doc_id: int, q: str = Query(..., min_length=1, max_length=200)):
    """The pages of the source that mention these words, for "show it in the book"."""
    return {"pages": reading.mentions(doc_id, q, limit=200)}


@router.get("/documents/{doc_id}/decks")
def decks(doc_id: int):
    return reading.decks_for(doc_id)


class EstimateBody(BaseModel):
    document_id: int
    scope: dict = {}
    template: str = "research"
    model: Optional[str] = None
    #: Deep Read: how much the reader already knows ("new", "some", "expert").
    level: str = "some"


@router.post("/estimate")
async def estimate(body: EstimateBody):
    return await run_in_threadpool(reading.estimate, body.document_id, body.scope, body.template, body.model, body.level)


class GenerateBody(EstimateBody):
    style: Optional[dict] = None
    tutor: bool = False
    notebook_id: Optional[int] = None


@router.post("/generate", dependencies=[Depends(require_pro("notebook"))])
async def generate(body: GenerateBody):
    # Check the selection now, so a bad page range is a plain 400, not a failed job.
    await run_in_threadpool(reading.resolve_scope, body.document_id, body.scope)
    # Never start a job the balance cannot pay for (the 21 September decision): the
    # service still holds each call's worst case, but a book must not stop halfway.
    est = await run_in_threadpool(reading.estimate, body.document_id, body.scope, body.template, body.model, body.level)
    # The user's own assistant pays for these notes, so the balance doesn't matter then.
    from .. import relay
    from ..errors import relay_not_listening
    if relay.is_enabled() and not relay.ready():
        # Say so before starting, not after the first step fails.
        raise relay_not_listening().http()
    short = None if relay.is_enabled() else await run_in_threadpool(reading.shortfall, est.get("credits"))
    if short:
        raise HTTPException(402, detail={
            "code": "insufficient_credits", "title": "Not enough credits for these notes",
            "message": f"These notes need about {est['credits']:.2f} credits and you have {short['available']:.2f}. "
                       "Top up, or choose fewer pages.",
        })

    def work(job: dict) -> Any:
        return reading.generate(job, body.document_id, body.scope, body.template, body.style, body.model,
                                body.tutor, body.notebook_id, body.level)

    return reading.start_job(work, body.document_id)


class SimplifyBody(BaseModel):
    document_id: Optional[int] = None
    text: str
    pages: list[int] = []
    level: str = "some"
    model: Optional[str] = None
    mode: str = "plainer"               # plainer | newcomer | example | analogy | steps | terms


@router.post("/simplify", dependencies=[Depends(require_pro("notebook"))])
async def simplify(body: SimplifyBody):
    """One paragraph of a reading notebook in plainer words (Deep Read, B3)."""
    return await reading.simplify(body.document_id, body.text, body.pages, body.level, body.model, body.mode)


class LookupBody(BaseModel):
    text: str
    line: str = ""
    document_id: Optional[int] = None
    pages: list[int] = []
    depth: str = "basic"                # basic | technical
    level: str = "some"
    model: Optional[str] = None
    fallback_credits: bool = False


@router.post("/lookup", dependencies=[Depends(require_pro("notebook"))])
async def lookup(body: LookupBody):
    """What the words selected in a notebook mean: from the source when it says, else labelled as general."""
    return await reading.lookup(body.text, body.line, body.document_id, body.pages, body.depth, body.level, body.model,
                                fallback_credits=body.fallback_credits)


class MindMapBody(BaseModel):
    passage: str
    document_id: Optional[int] = None
    pages: list[int] = []
    level: str = "some"
    model: Optional[str] = None
    fallback_credits: bool = False


@router.post("/mind-map", dependencies=[Depends(require_pro("notebook"))])
async def mind_map(body: MindMapBody):
    """A highlighted passage as a mind map: its centre idea, branches and details, with source pages."""
    return await reading.mind_map(body.passage, body.document_id, body.pages, body.level, body.model,
                                  fallback_credits=body.fallback_credits)


class AskBody(BaseModel):
    question: str
    passage: str
    explained: str = ""
    history: list[dict] = []            # [{q, a}], the conversation so far
    document_id: Optional[int] = None
    pages: list[int] = []
    notebook_id: Optional[int] = None
    level: str = "some"
    model: Optional[str] = None


@router.post("/ask", dependencies=[Depends(require_pro("notebook"))])
async def ask(body: AskBody):
    """A follow-up question about words or a paragraph already explained: grounded in the source, labelled."""
    return await reading.ask(body.question, body.passage, body.explained, body.history, body.document_id,
                             body.pages, body.notebook_id, body.level, body.model)


class CheckQuestionBody(BaseModel):
    text: str
    document_id: Optional[int] = None
    pages: list[int] = []
    level: str = "some"
    avoid: list[str] = []               # questions already asked about this paragraph
    model: Optional[str] = None


@router.post("/check/question", dependencies=[Depends(require_pro("notebook"))])
async def check_question(body: CheckQuestionBody):
    """One question that checks a paragraph was understood, with the points a good answer contains."""
    return await reading.check_question(body.text, body.document_id, body.pages, body.level, body.avoid, body.model)


class CheckMarkBody(BaseModel):
    text: str
    question: str
    points: list[str]
    answer: str
    level: str = "some"
    document_id: Optional[int] = None
    model: Optional[str] = None


@router.post("/check/mark", dependencies=[Depends(require_pro("notebook"))])
async def check_mark(body: CheckMarkBody):
    """Mark an answer in the reader's own words against the paragraph: what it got, missed and got wrong."""
    return await reading.check_answer(body.text, body.question, body.points, body.answer, body.level,
                                      body.document_id, body.model)


class FindTermsBody(BaseModel):
    notebook_id: int
    level: str = "some"
    model: Optional[str] = None


@router.post("/glossary/find", dependencies=[Depends(require_pro("notebook"))])
async def find_terms(body: FindTermsBody):
    """Every unfamiliar term in a notebook, explained from its source where the source says (the fuller glossary)."""
    return await reading.find_terms(body.notebook_id, body.level, body.model)


class ExplainBody(BaseModel):
    notebook_id: int
    section_id: str
    text: str
    level: Optional[str] = None
    model: Optional[str] = None


@router.post("/explain", dependencies=[Depends(require_pro("notebook"))])
async def explain(body: ExplainBody):
    """Explain a chapter back from memory, and learn what was missed (Deep Read, B4)."""
    return await reading.explain_back(body.notebook_id, body.section_id, body.text, body.level, body.model)


@router.get("/progress/{notebook_id}")
def progress(notebook_id: int):
    return reading.progress(notebook_id)


@router.get("/jobs/{job_id}")
def job(job_id: str):
    return reading.job_view(job_id)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    return reading.cancel_job(job_id)
