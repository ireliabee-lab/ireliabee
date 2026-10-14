"""Export / import router — move prep data between installs as one JSON file."""
from __future__ import annotations

import json
from datetime import date
from typing import Optional

from fastapi import APIRouter, File, Form, Query, UploadFile
from fastapi.responses import Response

from .. import transfer
from ..errors import FriendlyError

router = APIRouter()

MAX_BUNDLE_BYTES = transfer.MAX_BUNDLE_MB * 1024 * 1024


def _sections(raw: str) -> list[str]:
    return [s.strip() for s in (raw or "").split(",") if s.strip()]


@router.get("/summary")
def get_summary():
    """What this install holds, so the UI can show counts next to each section."""
    return {"counts": transfer.summary(), "labels": transfer.SECTION_LABELS,
            "sections": list(transfer.SECTIONS)}


@router.get("/export")
def export(
    include: str = Query(",".join(transfer.SECTIONS)),
    profile_id: Optional[int] = Query(None),
    app_version: str = Query(""),
):
    """Download the selected data as one .json file."""
    bundle = transfer.build_bundle(_sections(include), profile_id, app_version)
    filename = f"ireliabee-export-{date.today().isoformat()}.json"
    return Response(
        content=json.dumps(bundle, indent=2, ensure_ascii=False),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _read(file: UploadFile) -> bytes:
    raw = await file.read()
    if not raw:
        raise FriendlyError("invalid", "Empty file", "That file has nothing in it.")
    if len(raw) > MAX_BUNDLE_BYTES:
        raise FriendlyError("invalid", "File too large",
                            f"Transfer files can be up to {transfer.MAX_BUNDLE_MB} MB.")
    return raw


@router.post("/inspect")
async def inspect(file: UploadFile = File(...)):
    """Look inside a transfer file without importing it."""
    return transfer.inspect(await _read(file))


@router.post("/import")
async def import_(
    file: UploadFile = File(...),
    include: str = Form(",".join(transfer.SECTIONS)),
    duplicates: str = Form("skip"),
    target_profile_id: Optional[int] = Form(None),
):
    """Merge a transfer file into this install."""
    return transfer.import_bundle(
        await _read(file), _sections(include), duplicates, target_profile_id,
    )
