"""
What a copy of iReliabee is allowed to do, and the gates that enforce it.

The boundary itself is written down in ``docs/pricing-boundary.md``. This module
is its only implementation: every Pro feature is gated here and nowhere else, so
the list of gates and the list of paid features cannot drift apart.

Two kinds of allowance:

* **Pro** - a signed-in account (``core.account``), or, for copies still
  carrying one, a valid licence (``core.licence``). All or nothing.

  Under the hosted model (``docs/hosted-pivot.md``) the account *is* the
  entitlement: what a feature costs is paid in credits, per use, on the
  server. So the gate here only asks "is someone signed in", and the balance
  is enforced where it cannot be edited — at the proxy.
* **Free live sessions** - the free tier includes two live sessions, counted by
  *session id*, for ever. A dropped call that reconnects, a pause and resume, or
  switching between microphone and system audio all belong to the session that
  already spent its grant, so none of them costs a second one.

Refusals use **402 Payment Required** with a machine-readable body, so the
frontend can tell "you need Pro" apart from a genuine failure and show the
upgrade screen instead of an error.
"""
from __future__ import annotations

from datetime import datetime
from typing import Callable, Optional

from fastapi import HTTPException

from .core import account, licence
from .core.sessions import _connect

FREE_LIVE_SESSIONS = licence.FREE_LIVE_SESSIONS

#: Whether the local free-session ledger actually refuses anyone.
#:
#: **Off.** It counts two free live sessions per machine, which was the rule for
#: the bring-your-own-key model we have since left (``docs/hosted-pivot.md``).
#: Under the hosted model the free allowance is minutes, not sessions, and it
#: lives on the server where deleting a local database cannot reset it.
#:
#: The ledger keeps recording, because the grant history is still the honest
#: answer to "has this session gone live before" and reconnect behaviour
#: depends on it. It simply stops saying no. The tests set this True so the
#: counting logic stays covered for whoever ports it server-side.
ENFORCE_FREE_LIMIT = False

#: What the user is told when a gate closes, per feature. Written for the person
#: who just clicked the thing, not for a log file.
_REASONS = {
    "live":     "Live coaching in real calls is part of iReliabee Pro.",
    "calendar": "Calendar sync and meeting reminders are part of iReliabee Pro.",
    "recap":    "Meeting recaps and follow-up emails are part of iReliabee Pro.",
    "people":   "People research is part of iReliabee Pro.",
    "study":    "The lecture companion and study packs are part of iReliabee Pro.",
    "notebook": "Notebooks written from your lectures, meetings and documents are part of iReliabee Pro.",
    "retry":    "Practising hard moments from real calls is part of iReliabee Pro.",
    "exams":    "IELTS and TOEFL band scoring is part of iReliabee Pro.",
    "export":   "Exporting a debrief as a PDF is part of iReliabee Pro. "
                "You can still read it here and copy the text.",
}


def _ensure_schema():
    with _connect() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS live_session_grants (
                session_id INTEGER PRIMARY KEY,
                first_used TEXT NOT NULL
            )
        """)


_ensure_schema()


# -- Free live sessions ------------------------------------------------------

def live_grants_used() -> int:
    with _connect() as conn:
        return int(conn.execute("SELECT COUNT(*) FROM live_session_grants").fetchone()[0])


def live_grant_held(session_id: int) -> bool:
    """Whether this session has already spent a grant (so it may always go live)."""
    with _connect() as conn:
        row = conn.execute("SELECT 1 FROM live_session_grants WHERE session_id = ?",
                           (int(session_id),)).fetchone()
    return row is not None


def live_sessions_left() -> int:
    return max(0, FREE_LIVE_SESSIONS - live_grants_used())


def claim_live_session(session_id: Optional[int]) -> tuple[bool, str]:
    """
    Take the permission to go live for `session_id`.

    Returns ``(allowed, reason)``. Idempotent: a session that already holds a
    grant keeps it, so reconnecting mid-call never costs anything. Pro skips the
    ledger entirely - a licence that later lapses must not leave the user with a
    pile of spent free sessions.

    Deleting a session does **not** return its grant. The row stays.
    """
    if _is_pro():
        return True, ""
    if session_id is None:
        # No session to charge it to. Practice and warmups don't come through
        # here, so this is a caller that forgot to send one: fail closed —
        # unless nothing is being enforced, when there is nothing to fail to.
        if not ENFORCE_FREE_LIMIT:
            return True, ""
        return False, _REASONS["live"]

    session_id = int(session_id)
    if live_grant_held(session_id):
        return True, ""
    with _connect() as conn:
        used = int(conn.execute("SELECT COUNT(*) FROM live_session_grants").fetchone()[0])
        if ENFORCE_FREE_LIMIT and used >= FREE_LIVE_SESSIONS:
            return False, (
                f"You have used both free live sessions. "
                f"{_REASONS['live']}"
            )
        conn.execute(
            "INSERT OR IGNORE INTO live_session_grants (session_id, first_used) VALUES (?, ?)",
            (session_id, datetime.utcnow().isoformat(timespec="seconds")),
        )
    return True, ""


# -- Gates -------------------------------------------------------------------

def _open_edition() -> bool:
    """The open edition has every feature: its user pays the providers directly (backend/edition.py)."""
    from . import edition
    return edition.is_open()


def _signed_in() -> bool:
    """Reads the local account file only: a gate must never wait on the network."""
    try:
        return bool(account.status()["signed_in"])
    except Exception:
        return False


def _is_pro() -> bool:
    return _open_edition() or _signed_in() or licence.is_pro()


def allows(feature: str) -> bool:
    """Whether `feature` is available right now. Unknown features are free."""
    return _open_edition() or _signed_in() or licence.allows(feature)


def pro_required(feature: str) -> HTTPException:
    """The 402 to raise when `feature` is not available."""
    reason = _REASONS.get(feature, "This is part of iReliabee Pro.")
    return HTTPException(
        status_code=402,
        detail={
            "error": "pro_required",
            "feature": feature,
            # The only way to Pro now is an account, so say that rather than
            # pointing at a licence nobody can buy any more.
            "message": f"{reason} Sign in to your iReliabee account to use it.",
        },
    )


def require_pro(feature: str) -> Callable[[], None]:
    """
    A FastAPI dependency that refuses the request unless Pro is active.

        @router.get("/", dependencies=[Depends(require_pro("people"))])

    Use the dependency form for whole routers and whole endpoints; call
    `check_pro` inline where only part of an endpoint is paid.
    """
    def dependency() -> None:
        if not allows(feature):
            raise pro_required(feature)
    return dependency


def check_pro(feature: str) -> None:
    """Inline gate for a branch inside an otherwise free endpoint (exams, mostly)."""
    if not allows(feature):
        raise pro_required(feature)


# -- Status for the UI -------------------------------------------------------

def status(session_id: Optional[int] = None) -> dict:
    """
    Everything the frontend needs to decide what to show, in one call.

    `features` is computed from the entitlement rather than listed by hand, so a
    new Pro feature is added in exactly one place: `licence.PRO_FEATURES`.

    Pass `session_id` when asking on behalf of one session - the answer then
    accounts for a grant that session already holds, which is what lets the UI
    promise "this call will work" before the user joins it.
    """
    ent = licence.evaluate()
    pro = ent.is_pro or _signed_in() or _open_edition()
    left = live_sessions_left()
    held = session_id is not None and live_grant_held(session_id)
    return {
        "licence": ent.as_dict(),
        "features": {f: pro for f in licence.PRO_FEATURES},
        "free_live_sessions": {
            "limit": FREE_LIVE_SESSIONS,
            "used": min(live_grants_used(), FREE_LIVE_SESSIONS),
            "left": left,
        },
        # Can this session go live right now? Pro always; a session that has
        # already spent a grant always; otherwise while free grants remain.
        "can_start_live": pro or held or left > 0 or not ENFORCE_FREE_LIMIT,
        "holds_grant": held,
        # The UI hides the remaining-sessions chip when nothing is being
        # enforced, rather than counting down to a limit that never arrives.
        "enforced": ENFORCE_FREE_LIMIT,
    }
