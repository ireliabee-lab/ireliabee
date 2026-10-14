"""
Config router — read/write provider & model preferences, manage API keys.
"""
import os
from typing import Optional


from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.config import load_config, save_config, _write_env_var
from ..core.providers import PROVIDERS, key_status
from ..core.transcribers import STT_PROVIDERS, available_stt_providers, stt_key_status

router = APIRouter()

# Optional keys that make research better (Settings → Research). Web search needs
# one of the first two; GITHUB_TOKEN only lifts GitHub's rate limit.
RESEARCH_KEYS = [
    {"env": "TAVILY_API_KEY", "label": "Tavily", "hint": "Web search — free tier at tavily.com", "url": "https://tavily.com"},
    {"env": "BRAVE_SEARCH_API_KEY", "label": "Brave Search", "hint": "Web search — free tier at brave.com/search/api", "url": "https://brave.com/search/api/"},
    {"env": "GITHUB_TOKEN", "label": "GitHub", "hint": "Optional — more GitHub lookups per hour", "url": "https://github.com/settings/tokens"},
]


def _provider_catalog(catalog: dict, statuses: dict) -> list[dict]:
    result = []
    for name, cfg in catalog.items():
        result.append({
            "id": name,
            "env": cfg.get("env"),
            "has_key": statuses.get(name, False),
            "models": [
                {"id": mid, "label": desc}
                for mid, desc in cfg["models"].items()
            ],
            "default_model": cfg["default_model"],
        })
    return result


@router.get("")
def get_config():
    cfg = load_config()
    # Provider catalogues and key status are the admin's: everyone else is
    # served whatever the backoffice chose, and has no keys (audit 180-H5).
    from ..core import hosted
    if not hosted.is_admin():
        return {"saved": cfg, "llm_providers": [], "stt_providers": [], "research_keys": []}
    llm_statuses = key_status()
    stt_statuses = stt_key_status()
    return {
        "saved": cfg,
        "llm_providers": _provider_catalog(PROVIDERS, llm_statuses),
        "stt_providers": _provider_catalog(available_stt_providers(), stt_statuses),
        "research_keys": [{**k, "has_key": bool(os.environ.get(k["env"]))} for k in RESEARCH_KEYS],
    }


class SaveConfigRequest(BaseModel):
    provider: str
    model: str
    stt_provider: str
    stt_model: str
    response_tone: Optional[str] = None
    english_support: Optional[bool] = None
    language: Optional[str] = None
    notebook_auto: Optional[bool] = None       # write a notebook when a lecture or meeting ends
    notebook_relay: Optional[bool] = None      # use own AI assistant for notebook features


@router.post("")
def post_config(body: SaveConfigRequest):
    if body.provider not in PROVIDERS:
        raise HTTPException(400, f"Unknown LLM provider: {body.provider}")
    if body.stt_provider not in available_stt_providers():
        raise HTTPException(400, f"Unknown STT provider: {body.stt_provider}")

    if body.response_tone is not None and body.response_tone not in ("basic", "advanced"):
        raise HTTPException(400, f"Unknown response tone: {body.response_tone}")

    cfg = load_config()  # merge so keys not on this form survive
    cfg.update({
        "provider": body.provider,
        "model": body.model,
        "stt_provider": body.stt_provider,
        "stt_model": body.stt_model,
    })
    if body.response_tone is not None:
        cfg["response_tone"] = body.response_tone
    if body.english_support is not None:
        cfg["english_support"] = body.english_support
    if body.notebook_auto is not None:
        cfg["notebook_auto"] = body.notebook_auto
    if body.notebook_relay is not None:
        cfg["notebook_relay"] = body.notebook_relay
    if body.language is not None:
        from ..languages import LANGUAGES
        if body.language not in LANGUAGES:
            raise HTTPException(400, f"Unknown language: {body.language}")
        cfg["language"] = body.language
    save_config(cfg)
    return {"ok": True}


# Who the user is. Chosen in onboarding (roadmap 1.1); tailors the default
# coach, the suggested practice and wording. Not a secret, so it travels in
# Transfer preferences.
PERSONAS = ("student", "job-seeker", "professional", "other")


class PersonaRequest(BaseModel):
    persona: str


@router.get("/persona")
def get_persona():
    persona = load_config().get("persona")
    return {"persona": persona if persona in PERSONAS else None}


@router.put("/persona")
def put_persona(body: PersonaRequest):
    if body.persona not in PERSONAS:
        raise HTTPException(400, f"Unknown persona: {body.persona}")
    cfg = load_config()
    cfg["persona"] = body.persona
    save_config(cfg)
    return {"persona": body.persona}


class SetKeyRequest(BaseModel):
    env_var: str
    value: str


@router.post("/key")
def set_key(body: SetKeyRequest):
    allowed_vars = {cfg["env"] for cfg in PROVIDERS.values() if cfg.get("env")}
    allowed_vars |= {cfg["env"] for cfg in STT_PROVIDERS.values() if cfg.get("env")}
    allowed_vars |= {k["env"] for k in RESEARCH_KEYS}
    from .calendar import CALENDAR_KEYS
    allowed_vars |= {k["env"] for k in CALENDAR_KEYS}
    if body.env_var not in allowed_vars:
        raise HTTPException(400, f"Unknown env var: {body.env_var}")
    # Provider and research keys are the admin's: everyone else is served by
    # our service and has no use for one (audit 178-M13). Calendar sign-in
    # keys stay open to all.
    from ..core import hosted
    if body.env_var not in {k["env"] for k in CALENDAR_KEYS} and not hosted.is_admin():
        raise HTTPException(403, "Keys are managed by iReliabee for this account.")
    from ..core.config import BadKeyValue
    try:
        _write_env_var(body.env_var, body.value)
    except BadKeyValue as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@router.get("/readiness")
def readiness():
    """
    What the user still needs to set up, as friendly errors (null = ready).

    The question changed with the hosted pivot. It used to be "has a key been
    pasted for each provider", asked three times; it is now "is this machine
    signed in to something that can pay", asked once. A signed-in account is
    ready for all three, because the AI comes with the credits.

    The admin account is the exception and keeps the old answer, since the
    point of that account is to run against its own keys and find out whether
    the proxy is the problem.
    """
    import os
    from ..core import hosted
    from ..errors import FriendlyError, missing_key, resolve_llm

    state = hosted.readiness()
    if not state["ready"]:
        blocked = {"error": "signed_out", "message": state["message"]}
        return {"llm": blocked, "stt": blocked, "voice": blocked, "credits": None}
    if state["mode"] == "hosted":
        return {"llm": None, "stt": None, "voice": None, "credits": hosted.credit_warning()}

    cfg = load_config()
    try:
        resolve_llm(cfg.get("model"))
        llm = None
    except FriendlyError as fe:
        llm = fe.as_dict()
    stt_provider = cfg.get("stt_provider") or "deepgram"
    stt_env = STT_PROVIDERS.get(stt_provider, {}).get("env")
    stt = missing_key(stt_provider).as_dict() if stt_env and not os.environ.get(stt_env) else None
    voice = None if os.environ.get("DEEPGRAM_API_KEY") else missing_key("deepgram").as_dict()
    # No credit line for the admin account: it runs on its own keys and spends
    # none of them.
    return {"llm": llm, "stt": stt, "voice": voice, "credits": None}


@router.get("/onboarding")
def onboarding():
    """First-run checklist: which setup steps are done, detected from real data."""
    from ..core import profile_store, sessions as sess
    from ..document_store import list_cvs

    ready = readiness()
    profile = profile_store.get_active_profile()
    with sess._connect() as conn:
        practised = conn.execute("SELECT 1 FROM sessions LIMIT 1").fetchone() is not None
        if not practised:
            try:
                practised = conn.execute("SELECT 1 FROM drills LIMIT 1").fetchone() is not None
            except Exception:
                pass
    steps = [
        {"id": "persona", "done": load_config().get("persona") in PERSONAS},
        # One step where there were two: there is one thing to set up now,
        # and it is an account rather than a pair of API keys.
        {"id": "account", "done": ready["llm"] is None},
        {"id": "profile", "done": bool(profile and (profile["name"] or "").strip())},
        {"id": "cv", "done": bool(list_cvs())},
        {"id": "practice", "done": practised},
    ]
    return {"steps": steps, "done": sum(s["done"] for s in steps), "total": len(steps)}


@router.post("/relay/regenerate-key")
def regenerate_relay_key():
    """Regenerate the separate pairing key used for assistant MCP relay connections."""
    from .. import relay
    key = relay.regenerate_pairing_key()
    return {"pairing_key": key}
