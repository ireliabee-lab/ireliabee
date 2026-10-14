"""
/notebooks — the Notebook (product specs 184 and 185).

Reading, editing and deleting a notebook is the user's own data and always
free; only writing one with the AI is a Pro feature (it spends credits).

    GET    /notebooks/                 list (kind=lecture|meeting|reading, q=search)
    GET    /notebooks/options          font families, sizes and styles to choose from
    GET    /notebooks/session/{sid}    the notebook for a session, or null
    POST   /notebooks/auto/{sid}       a lecture or meeting ended: write its notebook if it should be
    GET    /notebooks/auto/{sid}       how that is going (writing | done | failed | skipped | ask)
    POST   /notebooks/                 a blank notebook to write in yourself
    POST   /notebooks/generate         write (or rewrite) the notebook for a session
    GET    /notebooks/{id}             one notebook, with its line times
    PUT    /notebooks/{id}             save changes (title, style, document), version-checked
    DELETE /notebooks/{id}
    GET    /notebooks/{id}/versions    earlier versions kept
    POST   /notebooks/{id}/restore     put an earlier version back (itself a new version)
    GET    /notebooks/{id}/source      the transcript lines a note came from (lines=12,13)
    GET    /notebooks/{id}/export.md   the notebook as Markdown
"""
from typing import Any, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel

from .. import notebook as nb
from ..entitlements import require_pro

router = APIRouter()


class Style(BaseModel):
    family: Optional[str] = None
    size: Optional[str] = None
    style: Optional[str] = None
    list: Optional[str] = None          # list markers: bullet | number | none (notebook.LIST_MARKERS)
    # The book's paper theme and page colour. Without these here they were dropped on every save,
    # so a notebook reopened on its default paper (owner, 27 Sep 2026).
    paper: Optional[str] = None
    pageColor: Optional[str] = None


class CreateBody(BaseModel):
    kind: str
    title: str = ""
    style: Optional[Style] = None


class GenerateBody(BaseModel):
    session_id: int
    style: Optional[Style] = None
    model: Optional[str] = None
    document_ids: Optional[list[int]] = None
    tutor: Optional[bool] = None


class UpdateBody(BaseModel):
    version: int
    title: Optional[str] = None
    style: Optional[Style] = None
    doc: Optional[dict[str, Any]] = None


class RestoreBody(BaseModel):
    version: int            # the version to restore
    current_version: int    # the version the user is looking at now


def _style(s: Optional[Style]):
    return s.model_dump() if s is not None else None


@router.get("/")
def list_notebooks(kind: Optional[str] = None, q: Optional[str] = None):
    return nb.list_notebooks(kind, q)


@router.get("/options")
def options():
    return {
        "families": [{"id": k, "label": v} for k, v in nb.FONT_FAMILIES.items()],
        "sizes": [{"id": k, "px": v} for k, v in nb.FONT_SIZES.items()],
        "styles": [{"id": k, "label": v} for k, v in nb.FONT_STYLES.items()],
        "defaults": nb.DEFAULT_STYLE,
        "block_types": list(nb.BLOCK_TYPES),
    }


@router.get("/session/{session_id}")
def for_session(session_id: int):
    return nb.for_session(session_id)


class AutoBody(BaseModel):
    style: Optional[Style] = None


@router.post("/auto/{session_id}")
async def auto(session_id: int, body: Optional[AutoBody] = None):
    # Not behind require_pro: a free account is simply skipped ("pro"), never refused.
    return await nb.start_auto(session_id, style=_style(body.style) if body else None)


@router.get("/auto/{session_id}")
def auto_status(session_id: int):
    return nb.auto_status(session_id)


@router.post("/")
def create(body: CreateBody):
    return nb.create_notebook(body.kind, title=body.title, style=_style(body.style))


@router.post("/generate", dependencies=[Depends(require_pro("notebook"))])
async def generate(body: GenerateBody):
    return await nb.generate_for_session(body.session_id, style=_style(body.style), model=body.model,
                                         document_ids=body.document_ids, tutor=body.tutor)


@router.get("/{notebook_id}")
def get_one(notebook_id: int):
    return nb.get_notebook(notebook_id)


@router.put("/{notebook_id}")
def update(notebook_id: int, body: UpdateBody):
    # The editor keeps its own copy of the text: answer with the details only.
    return nb.update_notebook(notebook_id, body.version, title=body.title, style=_style(body.style), doc=body.doc,
                              brief=True)


@router.delete("/{notebook_id}")
def delete(notebook_id: int):
    return nb.delete_notebook(notebook_id)


@router.get("/{notebook_id}/versions")
def versions(notebook_id: int):
    return nb.list_versions(notebook_id)


@router.post("/{notebook_id}/restore")
def restore(notebook_id: int, body: RestoreBody):
    return nb.restore_version(notebook_id, body.version, body.current_version)


@router.get("/{notebook_id}/source")
def source(notebook_id: int, lines: str = ""):
    """`lines=12,13` → those transcript lines (and their neighbours), to check a note against."""
    wanted = [int(x) for x in lines.split(",") if x.strip().isdigit()][:20]
    return nb.source_lines(notebook_id, wanted)


@router.get("/{notebook_id}/export.md", response_class=PlainTextResponse)
def export_markdown(notebook_id: int):
    return nb.to_markdown(nb.get_notebook(notebook_id))
