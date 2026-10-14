"""
Licence endpoints for the UI.

Everything here is local and fast. `GET /licence/status` in particular is on the
app's startup path and is called again whenever a gated screen opens, so it
never waits on the network: it reads the local entitlement and, if a refresh is
due, hands that to a background thread.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import entitlements
from ..core import licence

router = APIRouter()


class ActivateBody(BaseModel):
    key: str


class TokenBody(BaseModel):
    token: str


def _fail(e: licence.LicenceError) -> HTTPException:
    return HTTPException(400, {"error": "licence_error", "message": str(e)})


@router.get("/status")
def get_status(refresh: bool = True, session_id: Optional[int] = None):
    """
    The current entitlement plus the free-tier counters.

    `refresh=false` skips even the background refresh - used by the live-session
    preflight, which runs when the user is about to join a call and should not
    cause any network traffic at that moment.
    """
    if refresh:
        licence.refresh_in_background()
    return entitlements.status(session_id)


@router.post("/activate")
def activate(body: ActivateBody):
    """Exchange a licence key for an entitlement token."""
    try:
        licence.activate(body.key)
    except licence.LicenceError as e:
        raise _fail(e)
    return entitlements.status()


@router.post("/import")
def import_token(body: TokenBody):
    """Install an entitlement token directly, with no network - team and offline installs."""
    try:
        licence.import_token(body.token)
    except licence.LicenceError as e:
        raise _fail(e)
    return entitlements.status()


@router.post("/refresh")
def refresh_now():
    """Check with the licence service right now. Never fails: grace absorbs the error."""
    licence.refresh(force=True)
    return entitlements.status()


@router.post("/deactivate")
def deactivate():
    """Release this device so its seat can be used on another computer."""
    licence.deactivate()
    return entitlements.status()


@router.get("/device")
def device():
    """This machine's licence identity, for support and for the device list."""
    return {"id": licence.device_id(), "label": licence.device_label()}
