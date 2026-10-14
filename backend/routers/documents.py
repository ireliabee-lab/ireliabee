"""Documents CRUD + upload router."""
from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from starlette.concurrency import run_in_threadpool
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from ..uploads import read_valid_upload

from ..document_store import (
    create_document, list_documents, get_document, rename_document, delete_document, document_to_cv,
    document_size, iter_document,
)

router = APIRouter()


@router.get("/")
def list_all():
    return list_documents()


@router.post("/")
async def upload(file: UploadFile = File(...), name: str = Form(None)):
    filename, mime, data = await read_valid_upload(file, max_mb=10, what="document")
    doc_id = await run_in_threadpool(
        create_document, name=name or filename, original_filename=filename, mime=mime, content=data,
    )
    return await run_in_threadpool(get_document, doc_id)


@router.get("/{doc_id}")
def get_one(doc_id: int):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    return doc


STREAM_OVER = 8 * 1024 * 1024


@router.get("/{doc_id}/file")
def view_file(doc_id: int):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    size = document_size(doc_id) or 0
    media = doc["mime"] or "application/octet-stream"
    if size > STREAM_OVER:   # books: send in pieces rather than loading the whole file
        return StreamingResponse(iter_document(doc_id), media_type=media, headers={"Content-Length": str(size)})
    full = get_document(doc_id, include_content=True)
    return Response(content=full["content"], media_type=media)


@router.get("/{doc_id}/download")
def download(doc_id: int):
    doc = get_document(doc_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    size = document_size(doc_id) or 0
    headers = {"Content-Disposition": f'attachment; filename="{doc["original_filename"]}"', "Content-Length": str(size)}
    return StreamingResponse(iter_document(doc_id), media_type=doc["mime"] or "application/octet-stream", headers=headers)


class RenameBody(BaseModel):
    name: str


@router.put("/{doc_id}")
def rename(doc_id: int, body: RenameBody):
    if not get_document(doc_id):
        raise HTTPException(404, "Document not found")
    rename_document(doc_id, body.name)
    return get_document(doc_id)


@router.delete("/{doc_id}")
def delete(doc_id: int):
    if not get_document(doc_id):
        raise HTTPException(404, "Document not found")
    delete_document(doc_id)
    return {"ok": True}


@router.post("/{doc_id}/make-cv")
def make_cv(doc_id: int):
    """Library: turn this reference file into a CV."""
    cv_id = document_to_cv(doc_id)
    if cv_id is None:
        raise HTTPException(404, "Document not found")
    return {"cv_id": cv_id}
