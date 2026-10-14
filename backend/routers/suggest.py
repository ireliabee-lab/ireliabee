"""
Suggest: text for one box of a form, written by the AI from what the rest of
the form already says and the active profile.

Every free-text box in the app's forms can offer it (the owner's decision:
"every box gets it; the user can decide to use it or key in their own data").
A few boxes have a tuned prompt (TUNED); every other box is described by the
label the person sees and its shape, a line of text or a list.

A paid job like any other. It goes through the hosted, metered path (the
service reserves the worst case before the call and settles what it used
after), is named "suggest" to the service so the credit history can say what
the call was for, and is only ever made when the person presses Suggest. The
price is shown first (`POST /suggest/estimate`, no AI call) and what the call
actually used comes back with the text.

What it never does:
- suggest a name, an email address, a phone number, a password, a key, a
  token or a payment detail: a box whose id or label says it is one is
  refused (NOT_SUGGESTED);
- send the person's name, email or phone, or any secret: form keys that name
  one are dropped (NOT_SENT), email addresses and phone numbers are taken out
  of every value, and the profile is cut down to PROFILE_KEYS;
- save or submit anything: the frontend puts the text in the box as an
  editable suggestion.

Covered by the Privacy Policy (website/public/privacy.html, "What we handle"
and the DeepSeek list): what is on the form, plus the profile it needs.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..errors import FriendlyError, classify, resolve_llm

router = APIRouter()

#: Boxes with a tuned prompt. Anything else is described by its label.
TUNED: dict[str, dict[str, Any]] = {
    "plan.purpose": {
        "what": "one sentence, in the first person, saying what the user wants out of this meeting or interview",
        "shape": "text", "max_tokens": 200, "typical_out": 60,
    },
    "plan.answers_prep": {
        "what": ("4-6 likely questions or topics for this meeting, each followed by ' → ' and the angle or "
                 "example from the user's background to answer it with. Use only what the user's background "
                 "and the form say; where the background says nothing, name the kind of example to prepare "
                 "instead of inventing one"),
        "shape": "list", "max_tokens": 700, "typical_out": 320,
    },
    "session.ai_instructions": {
        "what": ("2-4 short instructions to the live coach for this one call: what to emphasise, what "
                 "tone to keep, what to avoid. Imperative sentences, under 60 words in all"),
        "shape": "text", "max_tokens": 220, "typical_out": 90,
    },
}

#: How much a box of each size may be given, and what it usually uses.
SIZES = {
    ("text", "short"): {"max_tokens": 120, "typical_out": 30, "what": "a short line (a few words, at most one sentence)"},
    ("text", "long"): {"max_tokens": 450, "typical_out": 160, "what": "a short paragraph (two to five sentences)"},
    ("list", "short"): {"max_tokens": 500, "typical_out": 180, "what": "3-5 short items"},
    ("list", "long"): {"max_tokens": 700, "typical_out": 300, "what": "3-6 items, a sentence or two each"},
}

_IDENTITY = r"name|email|e[-_ ]?mail|phone|mobile|tel|telephone|pronouns?|address"
_SECRET = r"password|passcode|passphrase|secret|token|api[-_ ]?key|key|licen[cs]e|card|cvv|cvc|iban|sort[-_ ]?code|account|payment|pin"
#: Boxes that are never suggested, by id (last part) or label.
NOT_SUGGESTED = re.compile(rf"(^|[\s._-])({_IDENTITY}|{_SECRET})($|[\s._-])", re.I)
#: Form keys that are never sent. "title" and "counterparty" are the meeting's, not the user's.
NOT_SENT = NOT_SUGGESTED
#: The profile lines a suggestion may use. Never the name or pronouns.
PROFILE_KEYS = ("target_role", "experience_level", "background", "strengths")

TEXT_CAP, ITEM_CAP, ITEMS_CAP, KEYS_CAP = 2000, 300, 12, 30
_CONTACT = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+|\+?\d[\d\s().-]{7,}\d")


class SuggestBody(BaseModel):
    #: "<form>.<box>", e.g. "plan.traps_avoid"; the last part is the box's key in `form`.
    field: str = Field(max_length=80)
    #: What the person sees above the box, e.g. "Traps to avoid".
    label: str = Field("", max_length=80)
    shape: Literal["text", "list"] = "text"
    length: Literal["short", "long"] = "short"
    form: dict[str, Any] = Field(default_factory=dict)
    model: Optional[str] = None


def _box_key(field: str) -> str:
    return field.rsplit(".", 1)[-1]


def _spec(body: SuggestBody) -> dict:
    """The prompt and limits for this box, or a refusal for a box never suggested."""
    if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+", body.field) \
            or NOT_SUGGESTED.search(_box_key(body.field).replace("_", " ")) \
            or NOT_SUGGESTED.search(body.label or ""):
        raise FriendlyError("invalid", "Nothing to suggest here", "Suggest isn't offered for this box.")
    tuned = TUNED.get(body.field)
    if tuned:
        return tuned
    size = SIZES[(body.shape, body.length)]
    label = _text(body.label, 80) or _box_key(body.field).replace("_", " ")
    return {**size, "shape": body.shape, "what": f"what goes in the box labelled “{label}”: {size['what']}"}


def _text(v: Any, cap: int) -> str:
    if isinstance(v, dict):
        v = " — ".join(str(x) for x in (v.get("title"), v.get("goal"), v.get("text")) if x)
    return re.sub(r"\s+", " ", str(v if v is not None else "")).strip()[:cap]


def _without_contacts(s: str) -> str:
    """Emails, and runs of nine or more digits (a phone number; a year range like 2019-2023 is eight)."""
    def drop(m: re.Match) -> str:
        found = m.group(0)
        return "" if "@" in found or sum(c.isdigit() for c in found) >= 9 else found
    return re.sub(r"\s{2,}", " ", _CONTACT.sub(drop, s)).strip()


def clean_form(form: dict[str, Any]) -> dict[str, Any]:
    """The form, cut down to what may be sent: no identity or secret keys, no contact details, short values."""
    out: dict[str, Any] = {}
    for key, v in list(form.items())[:KEYS_CAP]:
        key = str(key)[:40]
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", key) or NOT_SENT.search(key.replace("_", " ")):
            continue
        if isinstance(v, (list, tuple)):
            items = [t for t in (_without_contacts(_text(x, ITEM_CAP)) for x in v[:ITEMS_CAP]) if t]
            if items:
                out[key] = items
        else:
            t = _without_contacts(_text(v, TEXT_CAP))
            if t:
                out[key] = t
    return out


def profile_lines() -> str:
    """The active profile, without the name: role, level, background, strengths."""
    try:
        from ..core import profile_store
        row = profile_store.get_active_profile()
    except Exception:
        row = None
    if not row:
        return ""
    row = dict(row)
    labels = {"target_role": "Target role", "experience_level": "Experience level",
              "background": "Background", "strengths": "Strengths"}
    return "\n".join(f"{labels[k]}: {_without_contacts(_text(row.get(k), 600))}"
                     for k in PROFILE_KEYS if _text(row.get(k), 600))


def build_prompt(body: SuggestBody, form: dict[str, Any], profile: str) -> tuple[str, str]:
    spec = _spec(body)
    shape = ('{"suggestion": "the text"}' if spec["shape"] == "text"
             else '{"suggestion": ["item", "item"]}')
    system = f"""You fill in one box of a form in a speaking-coach app, so the user can edit it.
Write: {spec['what']}.
Build on what the form and the user's background say. Never invent names, companies, numbers or facts.
Never write anyone's name, email address, phone number or any password or key. Plain text, no markdown.
Where you would have to guess a fact about the user, write a [placeholder in brackets] for them to fill in.
If the box already has text, write something that adds to it rather than repeating it.
Return ONLY JSON: {shape}"""
    lines = [f"{k}: {'; '.join(v) if isinstance(v, list) else v}" for k, v in form.items()]
    message = "THE FORM SO FAR\n" + ("\n".join(lines) or "(empty)") + \
        "\n\nTHE USER\n" + (profile or "(no profile)") + \
        f"\n\nTHE BOX TO FILL: {_text(body.label, 80) or body.field} ({_box_key(body.field)})"
    return system, message


def shape_reply(spec: dict, data: dict) -> Any:
    """The model's answer, in the box's shape, with anything that looks like contact details taken out."""
    raw = data.get("suggestion") if isinstance(data, dict) else None
    if spec["shape"] == "list":
        items = raw if isinstance(raw, list) else [x for x in str(raw or "").split("\n")]
        items = [_without_contacts(_text(x, ITEM_CAP)).lstrip("-• ").strip() for x in items]
        return [x for x in items if x][:6]
    text = " ".join(str(x) for x in raw) if isinstance(raw, list) else str(raw or "")
    return _without_contacts(_text(text, 1200))


def _enough(body: SuggestBody, form: dict[str, Any], profile: str) -> None:
    """Something to go on: another box with something in it, or a profile."""
    box = _box_key(body.field)
    if not any(v for k, v in form.items() if k != box) and not profile:
        raise FriendlyError(
            "invalid", "Not enough to go on yet",
            "Fill in another box first (a title, or who it's with), so the suggestion has something to build on.",
        )


def _model_for_estimate(model: Optional[str]) -> str:
    from ..core import hosted
    from ..core.config import load_config
    chosen = (model or "").strip() or (load_config().get("model") or "").strip()
    if not hosted.is_admin():
        return hosted.coerce("anthropic", chosen)[1]
    return chosen or hosted.HOSTED_DEFAULT


def _price(model: str, in_tokens: int, out_tokens: int) -> dict:
    """Credits for an ordinary account (the service's own formula), dollars for the admin."""
    from ..core import hosted
    from ..core.costs import token_cost
    usd = token_cost(model, in_tokens, out_tokens)
    credits = None if hosted.is_admin() else hosted.credits_for(model, in_tokens, out_tokens)
    return {
        "model": model,
        "tokens": {"input": in_tokens, "output": out_tokens},
        "usd": round(usd, 4) if usd is not None else None,
        "credits": round(credits, 3) if credits is not None else None,
    }


@router.post("/estimate")
def estimate(body: SuggestBody):
    """What a suggestion would cost, before anything is spent. Makes no AI call."""
    from ..core.context import estimate_tokens
    spec = _spec(body)
    system, message = build_prompt(body, clean_form(body.form), profile_lines())
    return {"field": body.field,
            **_price(_model_for_estimate(body.model), estimate_tokens(system) + estimate_tokens(message),
                     spec["typical_out"]),
            "max_output": spec["max_tokens"]}


@router.post("/")
async def suggest(body: SuggestBody):
    """One suggestion for one box. Paid, metered as "suggest", never saved."""
    from ..core.providers import last_usage, metering_context, respond
    from .mock import _parse_json

    spec = _spec(body)
    form = clean_form(body.form)
    profile = profile_lines()
    _enough(body, form, profile)
    system, message = build_prompt(body, form, profile)
    model, provider = resolve_llm(body.model)

    def run(text: str):
        with metering_context("suggest"):
            reply = respond(provider, model, text, [], system, spec["max_tokens"], kind="suggest")
            return reply, last_usage()

    loop = asyncio.get_running_loop()
    spent: list = []

    async def call(text: str) -> str:
        try:
            reply, usage = await loop.run_in_executor(None, lambda: run(text))
        except Exception as e:
            raise classify(e, provider)
        if usage:
            spent.append(usage)
        return reply

    raw = await call(message)
    try:
        data = _parse_json(raw)
    except (ValueError, json.JSONDecodeError):
        # Asked again once; a second call is a second charge, and is counted below.
        raw = await call(message + "\n\nReply with ONLY the JSON object described in your instructions.")
        try:
            data = _parse_json(raw)
        except (ValueError, json.JSONDecodeError):
            data = {"suggestion": raw}
    suggestion = shape_reply(spec, data)
    if not suggestion:
        raise FriendlyError("unknown", "No suggestion this time", "Try again, or fill it in yourself.")

    used_model = spent[-1][1] if spent else model
    cost = _price(used_model, sum(u[2] for u in spent), sum(u[3] for u in spent))
    return {"field": body.field, "suggestion": suggestion, "cost": cost}
