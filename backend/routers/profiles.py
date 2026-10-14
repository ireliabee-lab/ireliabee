from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from ..core import profile_store
from ..document_store import activate_cv, get_cv
router = APIRouter()


class ProfileBody(BaseModel):
    name: str
    pronouns: Optional[str] = None
    background: Optional[str] = None
    target_role: Optional[str] = None
    strengths: Optional[str] = None
    weaknesses: Optional[str] = None
    extra_context: Optional[str] = None
    experience_level: Optional[str] = None
    hard_question: Optional[str] = None


class ProfileUpdateBody(BaseModel):
    name: Optional[str] = None
    cv_id: Optional[int] = None          # 0 unlinks
    pronouns: Optional[str] = None
    background: Optional[str] = None
    target_role: Optional[str] = None
    strengths: Optional[str] = None
    weaknesses: Optional[str] = None
    extra_context: Optional[str] = None
    experience_level: Optional[str] = None
    hard_question: Optional[str] = None


@router.get("/")
def list_profiles():
    return [dict(p) for p in profile_store.list_profiles()]


@router.post("/")
def create_profile(body: ProfileBody):
    fields = body.model_dump(exclude={"name"}, exclude_none=True)
    profile_id = profile_store.create_profile(body.name, **fields)
    row = profile_store.get_profile(profile_id)
    if row is None:
        raise HTTPException(status_code=500, detail="Failed to retrieve created profile")
    return dict(row)


@router.put("/{profile_id}")
def update_profile(profile_id: int, body: ProfileUpdateBody):
    row = profile_store.get_profile(profile_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    fields = body.model_dump(exclude_none=True)
    if fields.get("cv_id") == 0:
        fields["cv_id"] = None
    if fields:
        profile_store.update_profile(profile_id, **fields)
    updated = profile_store.get_profile(profile_id)
    return dict(updated)


@router.delete("/{profile_id}")
def delete_profile(profile_id: int):
    row = profile_store.get_profile(profile_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    profile_store.delete_profile(profile_id)
    return {"ok": True}


@router.post("/{profile_id}/activate")
def activate_profile(profile_id: int):
    row = profile_store.get_profile(profile_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Profile not found")
    profile_store.set_active_profile(profile_id)
    # Switching profile switches to the CV linked to it (if it still exists).
    cv_id = dict(row).get("cv_id")
    if cv_id and get_cv(cv_id):
        activate_cv(cv_id)
    return {"ok": True, "active_id": profile_id, "active_cv_id": cv_id if cv_id and get_cv(cv_id) else None}
