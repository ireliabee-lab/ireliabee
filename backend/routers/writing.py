"""Write: the academic writing framework (backend/writing.py, docs/academic-writing.md)."""
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from .. import writing

router = APIRouter()


@router.get("/framework")
def framework():
    """The stages, the kinds of writing and their structures, the citation styles."""
    return writing.framework()


@router.get("/projects")
def projects():
    return writing.list_projects()


class NewProject(BaseModel):
    title: str = Field(default="", max_length=writing.TITLE_MAX)
    genre: str = Field(max_length=40)
    word_limit: int = 0
    style: str = Field(default="apa", max_length=20)


@router.post("/projects")
def create(body: NewProject):
    return writing.create_project(body.title, body.genre, body.word_limit, body.style)


@router.get("/projects/{project_id}")
def get(project_id: int):
    return writing.get_project(project_id)


class ProjectPatch(BaseModel):
    title: Optional[str] = Field(default=None, max_length=writing.TITLE_MAX)
    genre: Optional[str] = Field(default=None, max_length=40)
    word_limit: Optional[int] = None
    style: Optional[str] = Field(default=None, max_length=20)
    brief: Optional[str] = Field(default=None, max_length=writing.TEXT_MAX)
    focus: Optional[str] = Field(default=None, max_length=writing.TEXT_MAX)
    thesis: Optional[str] = Field(default=None, max_length=writing.TEXT_MAX)
    stage: Optional[str] = Field(default=None, max_length=20)
    ticks: Optional[dict] = None
    key_terms: Optional[list[str]] = Field(default=None, max_length=writing.KEY_TERMS_MAX)


@router.patch("/projects/{project_id}")
def update(project_id: int, body: ProjectPatch):
    return writing.update_project(project_id, body.model_dump(exclude_unset=True))


@router.delete("/projects/{project_id}")
def delete(project_id: int):
    writing.delete_project(project_id)
    return {"ok": True}


class NewSection(BaseModel):
    title: str = Field(default="", max_length=writing.TITLE_MAX)
    after_id: Optional[int] = None


@router.post("/projects/{project_id}/sections")
def add_section(project_id: int, body: NewSection):
    return writing.add_section(project_id, body.title, body.after_id)


class Order(BaseModel):
    ids: list[int]


@router.put("/projects/{project_id}/sections/order")
def reorder(project_id: int, body: Order):
    return writing.reorder_sections(project_id, body.ids)


class SectionPatch(BaseModel):
    title: Optional[str] = Field(default=None, max_length=writing.TITLE_MAX)
    body: Optional[str] = None   # writing.update_section refuses an over-long one with a message saying what to do
    notes: Optional[str] = Field(default=None, max_length=writing.TEXT_MAX)
    target: Optional[int] = None


@router.patch("/sections/{section_id}")
def update_section(section_id: int, body: SectionPatch):
    return writing.update_section(section_id, body.model_dump(exclude_unset=True))


@router.delete("/sections/{section_id}")
def delete_section(section_id: int):
    return writing.delete_section(section_id)


# ── Sources (backend/writing_refs.py) ───────────────────────────────────────────

from fastapi.concurrency import run_in_threadpool  # noqa: E402

from fastapi import Query  # noqa: E402

from .. import scholar, writing_refs  # noqa: E402


@router.get("/projects/{project_id}/refs")
def refs(project_id: int):
    return writing_refs.list_refs(project_id)


class NewRef(BaseModel):
    """One of: a DOI to look up, a Library document, a source typed in (CSL-JSON), or a paper
    from Find papers (backend/scholar.py)."""
    doi: Optional[str] = Field(default=None, max_length=300)
    document_id: Optional[int] = None
    item: Optional[dict] = None
    paper: Optional[dict] = None


@router.post("/projects/{project_id}/refs")
async def add_ref(project_id: int, body: NewRef):
    if body.paper is not None:
        return await run_in_threadpool(scholar.add_to_project, project_id, body.paper)
    if body.doi:
        item = await run_in_threadpool(writing_refs.lookup_doi, body.doi)
        return writing_refs.add(project_id, item)
    if body.document_id is not None:
        return writing_refs.add(project_id, writing_refs.from_document(body.document_id), document_id=body.document_id)
    if body.item is not None:
        return writing_refs.add(project_id, body.item)
    raise HTTPException(400, "Give a DOI, a Library document or the source's details.")


@router.get("/papers/search")
async def papers_search(q: str = Query(default="", max_length=1000), year_from: Optional[int] = None, year_to: Optional[int] = None,
                        open_access: bool = False, min_citations: int = 0, preprints: bool = True, field: str = Query(default="", max_length=40)):
    """Find papers: OpenAlex and Semantic Scholar, merged. Only these words and filters are sent."""
    return await run_in_threadpool(scholar.search, q, year_from=year_from, year_to=year_to, open_access=open_access,
                                   min_citations=min_citations, preprints=preprints, field=field)


class RefPatch(BaseModel):
    item: Optional[dict] = None
    note: Optional[str] = Field(default=None, max_length=4000)


@router.patch("/refs/{ref_id}")
def update_ref(ref_id: int, body: RefPatch):
    return writing_refs.update(ref_id, body.item, body.note)


@router.delete("/refs/{ref_id}")
def delete_ref(ref_id: int):
    writing_refs.delete(ref_id)
    return {"ok": True}


# ── AI review: a coach, never a writer (backend/writing_review.py) ─────────────────

from .. import writing_review  # noqa: E402


@router.get("/projects/{project_id}/review/estimate")
def review_estimate(project_id: int, section_id: Optional[int] = None, model: Optional[str] = None):
    """What a review costs, and the one already kept for this text, before anything is spent."""
    return writing_review.estimate(project_id, section_id, model)


@router.get("/projects/{project_id}/review")
def saved_review(project_id: int, section_id: Optional[int] = None):
    return writing_review.saved(project_id, section_id)


class ReviewBody(BaseModel):
    section_id: Optional[int] = None   # None: the whole draft
    model: Optional[str] = None
    fallback_credits: bool = False
    text_hash: Optional[str] = Field(default=None, max_length=64)   # the estimate's: the text that was priced


@router.post("/projects/{project_id}/review")
async def run_review(project_id: int, body: ReviewBody):
    return await writing_review.review(project_id, body.section_id, body.model, body.fallback_credits, body.text_hash)


# ── Export (backend/writing_export.py; Word and Markdown are made in the app) ──────

from fastapi import Response  # noqa: E402

from .. import writing_export  # noqa: E402


@router.post("/export.pdf")
async def export_pdf(doc: dict):
    """The finished document, its citations already formatted by the app, as a PDF."""
    pdf = await run_in_threadpool(writing_export.export_pdf, doc)
    return Response(content=pdf, media_type="application/pdf")
