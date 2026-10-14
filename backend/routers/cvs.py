"""CVs & Resumes CRUD + upload router."""
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from starlette.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel

from ..uploads import read_valid_upload

from ..document_store import (
    create_cv, list_cvs, get_cv, activate_cv, rename_cv, delete_cv, cv_to_document,
)

router = APIRouter()


@router.get("/")
def list_all():
    return list_cvs()


@router.post("/")
async def upload(file: UploadFile = File(...), name: str = Form(None)):
    filename, mime, data = await read_valid_upload(file, max_mb=5, what="CV")
    cv_id = await run_in_threadpool(
        create_cv, name=name or filename, original_filename=filename, mime=mime, content=data,
    )
    return await run_in_threadpool(get_cv, cv_id)


@router.get("/{cv_id}")
def get_one(cv_id: int):
    cv = get_cv(cv_id)
    if not cv:
        raise HTTPException(404, "CV not found")
    return cv


@router.get("/{cv_id}/file")
def view_file(cv_id: int):
    cv = get_cv(cv_id, include_content=True)
    if not cv:
        raise HTTPException(404, "CV not found")
    return Response(content=cv["content"], media_type=cv["mime"] or "application/octet-stream")


@router.get("/{cv_id}/download")
def download(cv_id: int):
    cv = get_cv(cv_id, include_content=True)
    if not cv:
        raise HTTPException(404, "CV not found")
    return Response(
        content=cv["content"],
        media_type=cv["mime"] or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{cv["original_filename"]}"'},
    )


class RenameBody(BaseModel):
    name: str


@router.put("/{cv_id}")
def rename(cv_id: int, body: RenameBody):
    if not get_cv(cv_id):
        raise HTTPException(404, "CV not found")
    rename_cv(cv_id, body.name)
    return get_cv(cv_id)


@router.post("/{cv_id}/activate")
def activate(cv_id: int):
    if not get_cv(cv_id):
        raise HTTPException(404, "CV not found")
    activate_cv(cv_id)
    return {"ok": True}


@router.post("/{cv_id}/make-document")
def make_document(cv_id: int):
    """Library: turn this CV into a reference file."""
    doc_id = cv_to_document(cv_id)
    if doc_id is None:
        raise HTTPException(404, "CV not found")
    return {"document_id": doc_id}


@router.delete("/{cv_id}")
def delete(cv_id: int):
    if not get_cv(cv_id):
        raise HTTPException(404, "CV not found")
    delete_cv(cv_id)
    return {"ok": True}
