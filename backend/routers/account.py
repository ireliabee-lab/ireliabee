"""
Account endpoints for the UI, plus the loopback landing the sign-in link uses.

`GET /account/complete` is the one endpoint here a browser reaches rather than
the app: the email link redirects to it on 127.0.0.1, which is how the code
crosses from the browser to this process. Only something already running on
this machine can receive it.
"""
from __future__ import annotations

import html

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from ..core import account
from .. import remote_reminders

from .calendar import _our_port  # the port we are really listening on

router = APIRouter()

_PAGE = """<!doctype html><html><head><meta charset="utf-8"><title>iReliabee</title>
<style>body{{font:15px system-ui,sans-serif;background:#f6f5f0;color:#1d2b2a;display:grid;
place-items:center;height:100vh;margin:0}}div{{max-width:420px;padding:28px;border-radius:14px;
background:#fff;box-shadow:0 6px 30px rgba(0,0,0,.08);text-align:center}}
h1{{font-size:19px;margin:0 0 8px}}p{{margin:0;color:#5b6664;line-height:1.5}}</style>
</head><body><div><h1>{title}</h1><p>{message}</p></div></body></html>"""


def _fail(e: account.AccountError) -> HTTPException:
    return HTTPException(400, {"error": "account_error", "message": str(e)})


class SignInBody(BaseModel):
    email: str


class CodeBody(BaseModel):
    code: str
    email: str


@router.get("/status")
def get_status(refresh: bool = False):
    """
    Who is signed in. On the app's startup path, so it does not touch the
    network unless `refresh` is asked for.
    """
    return account.status(refresh)


@router.post("/signin")
def sign_in(body: SignInBody, request: Request):
    """
    Email a sign-in link.

    The link carries the port this app is listening on, so it knows where to
    send the code back when the browser follows it.
    """
    try:
        message = account.request_sign_in(body.email, _our_port(request))
    except account.AccountError as e:
        raise _fail(e)
    return {"ok": True, "message": message}


@router.get("/complete", response_class=HTMLResponse)
def complete(code: str = "", state: str = ""):
    """Where the sign-in link lands. The browser shows the result; the app has the tokens."""
    try:
        signed_in = account.complete(code, state)
    except account.AccountError as e:
        return HTMLResponse(
            _PAGE.format(title="Sign-in did not finish",
                         message=html.escape(str(e)) + "<br><br>You can close this tab."),
            status_code=400,
        )
    who = html.escape(signed_in.get("email") or "your account")
    return HTMLResponse(_PAGE.format(
        title="You are signed in",
        message=f"iReliabee is now signed in as {who}.<br><br>You can close this tab and go back to the app.",
    ))


@router.post("/code")
def sign_in_with_code(body: CodeBody):
    """
    Finish a sign-in with the code from the page the link opened.

    The way in when the link's loopback handoff cannot land: the link was opened
    on a phone, or this backend is no longer on the port the link was told
    about. The address comes with the code and has to be the one the code
    resolves to — that, not the guard, is what stops a code somebody was talked
    into typing. See `account.complete_with_code`.
    """
    try:
        return {"ok": True, "account": account.complete_with_code(body.code, body.email)}
    except account.AccountError as e:
        raise _fail(e)


@router.get("/balance")
def get_balance():
    """
    The live credit balance.

    Separate from `/status` because it always touches the network and `/status`
    is on the startup path. A failure here is not fatal: the caller falls back
    to the cached figure `/status` carries.
    """
    try:
        return account.balance()
    except account.AccountError as e:
        raise _fail(e)


@router.post("/backoffice")
def open_backoffice():
    """A single-use link into the web backoffice. Refused by the service for non-admins."""
    try:
        return {"url": account.backoffice_link()}
    except account.AccountError as e:
        raise _fail(e)


@router.post("/signout")
def sign_out():
    """Revoke this device, then forget it locally whatever the service said."""
    account.sign_out()
    return account.status()


# -- Your phone, for text reminders (remote_reminders.py) ------------------------

class PhoneBody(BaseModel):
    number: str


class PhoneCodeBody(BaseModel):
    code: str


def _remote_fail(e: Exception) -> HTTPException:
    return HTTPException(400, {"error": "reminders_error", "message": str(e)})


@router.get("/phone")
def get_phone():
    """The number text reminders go to (masked), and what a text costs."""
    try:
        return remote_reminders.phone()
    except remote_reminders.RemoteError as e:
        raise _remote_fail(e)


@router.post("/phone")
def start_phone(body: PhoneBody):
    """Text a code to this number, to confirm it."""
    try:
        return remote_reminders.phone_start(body.number)
    except remote_reminders.RemoteError as e:
        raise _remote_fail(e)


@router.post("/phone/confirm")
def confirm_phone(body: PhoneCodeBody):
    try:
        return remote_reminders.phone_confirm(body.code)
    except remote_reminders.RemoteError as e:
        raise _remote_fail(e)
