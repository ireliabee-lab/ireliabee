"""
Multi-provider LLM support.

Each provider exposes:
    respond(transcript: str, history: list, system_prompt: str, model: str) -> str

`history` is a list of {"role": "user"|"assistant", "content": str}. The provider
mutates it in place with the new turn (user message then assistant reply) so the
caller can persist the running conversation.

Supported providers:
    - anthropic   (Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5)
    - openai      (GPT-5, GPT-5-mini, GPT-4o)
    - deepseek    (DeepSeek V4 chat, DeepSeek Reasoner) via OpenAI-compatible API
    - gemini      (Gemini 2.5 Pro / 2.5 Flash)
"""
from __future__ import annotations

import asyncio
import json
import os
import re


PROVIDERS = {
    "anthropic": {
        "env": "ANTHROPIC_API_KEY",
        "models": {
            "claude-opus-4-7":   "Claude Opus 4.7 — most capable",
            "claude-sonnet-4-6": "Claude Sonnet 4.6 — balanced (default)",
            "claude-haiku-4-5":  "Claude Haiku 4.5 — fastest, cheapest",
        },
        "default_model": "claude-sonnet-4-6",
    },
    "openai": {
        "env": "OPENAI_API_KEY",
        "models": {
            "gpt-5":       "GPT-5 — flagship",
            "gpt-5-mini":  "GPT-5 mini — fast + cheap",
            "gpt-4o":      "GPT-4o — mature, real-time",
        },
        "default_model": "gpt-5-mini",
    },
    "deepseek": {
        "env": "DEEPSEEK_API_KEY",
        "models": {
            "deepseek-chat":      "DeepSeek V4 chat — fast, very cheap",
            "deepseek-reasoner":  "DeepSeek Reasoner — chain-of-thought",
        },
        "default_model": "deepseek-chat",
        "base_url": "https://api.deepseek.com",
    },
    "gemini": {
        "env": "GEMINI_API_KEY",
        "models": {
            "gemini-2.5-pro":   "Gemini 2.5 Pro — most capable",
            "gemini-2.5-flash": "Gemini 2.5 Flash — fast",
        },
        "default_model": "gemini-2.5-flash",
    },
}


# ─── Clients ───────────────────────────────────────────────────────────────
# Keyed by the API key so a key added or changed in Settings takes effect
# without restarting the app.
_clients: dict = {}


def _limits() -> dict:
    """
    How long a provider may take before the call is given up on.

    The SDK defaults are ten minutes and two retries, so a provider that never
    answers held a recap for half an hour: the screen spun, then a 502. Ten
    seconds to connect, two minutes to answer (a full report runs that long),
    and one retry: a dead provider now fails in minutes and _ask_model can
    hand the work to another one.
    """
    return {"timeout": (120.0, 10.0), "max_retries": 1}


_LIMITS = _limits()


def _sdk_limits(sdk) -> dict:
    """The limits as `sdk` takes them. Each SDK builds its own Timeout: anthropic 1.7 moved to httpx2
    and refuses an httpx.Timeout outright, so a shared one failed every Claude call (0.4.14-0.4.15)."""
    total, connect = _LIMITS["timeout"]
    return {"timeout": sdk.Timeout(total, connect=connect), "max_retries": _LIMITS["max_retries"]}


def _anthropic_client():
    """
    The Anthropic client, pointed at whoever is paying.

    Under the hosted model this is our own service, which speaks Anthropic's
    wire format precisely so that this stays a one-line difference rather than
    a second client with its own streaming, retries and image handling. See
    `core/hosted.py` and `website/functions/v1/messages.js`.

    Cached by the credentials, so signing in or out takes effect on the next
    call instead of on the next restart — and an access token that has been
    re-minted makes a new client rather than reusing one with a stale token.
    """
    import anthropic
    from . import hosted

    key, base_url = hosted.anthropic_credentials()
    cached = _clients.get("anthropic")
    if not cached or cached[0] != (key, base_url):
        kwargs = {"api_key": key, **_sdk_limits(anthropic)}
        if base_url:
            kwargs["base_url"] = base_url
        _clients["anthropic"] = ((key, base_url), anthropic.Anthropic(**kwargs))
    return _clients["anthropic"][1]


def _openai_client(provider: str):
    import openai
    from openai import OpenAI
    cfg = PROVIDERS[provider]
    key = os.environ.get(cfg["env"])
    if not key:
        raise RuntimeError(f"Missing env var {cfg['env']}")
    cached = _clients.get(provider)
    if not cached or cached[0] != key:
        kwargs = {"api_key": key, **_sdk_limits(openai)}
        if "base_url" in cfg:
            kwargs["base_url"] = cfg["base_url"]
        _clients[provider] = (key, OpenAI(**kwargs))
    return _clients[provider][1]


# ─── Metering ──────────────────────────────────────────────────────────────
# Every provider reports token usage differently, and none of them promise to
# keep reporting it. `_meter` reads whichever shape it finds and records what it
# can; a provider that stops reporting usage costs us a row, not a response.
#
# `kind` and `session_id` are set by the caller through `metering_context`, so
# the call sites here stay unchanged as features are added.
import contextlib
import threading

from . import context, prompt_cache

import contextvars

_context = threading.local()
_fallback_var = contextvars.ContextVar("fallback_credits", default=False)
#: The feature a call belongs to, for async code. The thread-local above is only
#: safe inside one worker thread: set on the event loop it leaks across `await`s
#: into whatever other request runs there (a notebook build read "explain").
_kind_var = contextvars.ContextVar("metering_kind", default=None)

#: How long the user's own assistant may take, by feature. A live call can't
#: wait; a notebook step reads up to ~20,000 characters and writes a long answer.
RELAY_TIMEOUTS = {"live_turn": 60.0, "coach": 60.0, "explain": 180.0, "mind_map": 180.0, "study_questions": 180.0, "study_explain": 180.0, "talk_drill": 180.0, "talk_shorten": 180.0, "translate": 120.0, "tidy": 180.0, "write_review": 180.0}
RELAY_DEFAULT_TIMEOUT = 600.0


def relay_wait_seconds(kind: Optional[str]) -> float:
    return RELAY_TIMEOUTS.get(kind or "", RELAY_DEFAULT_TIMEOUT)


@contextlib.contextmanager
def relay_task(name: Optional[str]):
    """Name the task a call does, for the user's own assistant (not for billing)."""
    previous = getattr(_context, "relay_task", None)
    _context.relay_task = name
    try:
        yield
    finally:
        _context.relay_task = previous


def current_kind() -> Optional[str]:
    """The feature of the call being made: the worker thread's tag, else the async one."""
    value = getattr(_context, "value", None)
    return (value[0] if value else None) or _kind_var.get()


def is_fallback_credits() -> bool:
    return bool(_fallback_var.get())


@contextlib.contextmanager
def metering_context(kind: str, session_id=None):
    """Tag every provider call made inside this block, for cost reporting."""
    previous = getattr(_context, "value", None)
    _context.value = (kind, session_id)
    token = _kind_var.set(kind)
    try:
        yield
    finally:
        _context.value = previous
        _kind_var.reset(token)


@contextlib.contextmanager
def fallback_credits_context(enabled: bool = True):
    """Bypass the assistant relay and use hosted credits inside this block."""
    token = _fallback_var.set(enabled)
    try:
        yield
    finally:
        _fallback_var.reset(token)


class Stopped(Exception):
    """The user stopped the job this call belonged to; its stream was closed."""


@contextlib.contextmanager
def cancellable(event: "threading.Event | None"):
    """
    Calls made inside this block stop when `event` is set: a streamed answer is
    closed between events (the server then stops the model and charges only
    what it sent), and a call that hasn't started yet never starts.
    """
    previous = getattr(_context, "cancel", None)
    _context.cancel = event
    try:
        if event is not None and event.is_set():
            raise Stopped("stopped before it started")
        yield
    finally:
        _context.cancel = previous


def _usage_counts(usage) -> tuple[int, int]:
    """(input, output) tokens from an Anthropic, OpenAI or Gemini usage object."""
    if usage is None:
        return 0, 0
    for got, want in (("input_tokens", "output_tokens"),          # Anthropic
                      ("prompt_tokens", "completion_tokens"),      # OpenAI, DeepSeek
                      ("prompt_token_count", "candidates_token_count")):  # Gemini
        a, b = getattr(usage, got, None), getattr(usage, want, None)
        if a is not None or b is not None:
            return int(a or 0), int(b or 0)
    return 0, 0


def _meter(provider: str, model: str, usage) -> None:
    try:
        from . import costs, prompt_cache
        kind, session_id = getattr(_context, "value", None) or ("other", None)
        in_tokens, out_tokens = _usage_counts(usage)
        _context.last_usage = (provider, model, in_tokens, out_tokens)
        cache_read, cache_write = prompt_cache.cache_stats(usage)
        if in_tokens or out_tokens or cache_read:
            costs.record(kind, provider, model, in_tokens=max(0, in_tokens),
                         out_tokens=out_tokens, cache_read=cache_read,
                         cache_write=cache_write, session_id=session_id)
    except Exception:
        pass


def last_usage() -> "tuple[str, str, int, int] | None":
    """
    (provider, model, input tokens, output tokens) of the last call metered on
    this thread, then forgotten. For a caller that shows what a call actually
    cost straight after it (routers/suggest.py); call it on the same thread.
    """
    found = getattr(_context, "last_usage", None)
    _context.last_usage = None
    return found


#: Jobs the service is told the name of, so the ledger (and the user's credit
#: history) can say what a call was for: "call · suggest". Read by
#: website/functions/v1/messages.js as `x-ireliabee-kind`; anything not named
#: here is recorded there as "other", as it always was.
KIND_HEADER = "x-ireliabee-kind"
NAMED_KINDS = frozenset({"suggest"})


def _kind_headers() -> dict:
    """The kind header for a hosted call; nothing for the admin's own keys."""
    kind = (getattr(_context, "value", None) or ("other", None))[0]
    if kind not in NAMED_KINDS:
        return {}
    try:
        from . import hosted
        if hosted.is_admin():
            return {}
    except Exception:
        return {}
    return {KIND_HEADER: kind}


# ─── Anthropic ─────────────────────────────────────────────────────────────
def _final_message(**kwargs):
    """
    One whole answer, received as a stream.

    A non-streamed call sends nothing until the answer is complete, and a long
    debrief or a screenshot read with thinking can take longer than Cloudflare
    lets any response stay silent (about 100 s) — the call was cut off with
    the work done and paid for (audit 180-H1). Streamed, the first bytes come
    at once, and the SDK assembles the same Message at the end.
    """
    cancel = getattr(_context, "cancel", None)
    client = kwargs.pop("_client", None) or _anthropic_client()
    with client.messages.stream(**kwargs) as stream:
        if cancel is not None:
            for _event in stream:
                if cancel.is_set():
                    # Leaving the block closes the HTTP stream, which is what
                    # tells the server to stop generating (and billing).
                    raise Stopped("stopped by the user")
        return stream.get_final_message()


def _respond_anthropic(transcript, history, system_prompt, model, max_tokens=1024):
    history.append({"role": "user", "content": transcript})
    named = _kind_headers()
    msg = _final_message(
        model=model,
        max_tokens=max_tokens,
        system=prompt_cache.anthropic_system(system_prompt),
        # The caller's history is left intact — it is what gets saved to the
        # session; only what we send is trimmed.
        messages=context.trim_history(history),
        **({"extra_headers": named} if named else {}),
    )
    reply = msg.content[0].text
    _meter("anthropic", model, getattr(msg, "usage", None))
    history.append({"role": "assistant", "content": reply})
    return reply


# ─── OpenAI + DeepSeek (OpenAI-compatible) ─────────────────────────────────
def _openai_like(provider: str, transcript, history, system_prompt, model, max_tokens=1024):
    client = _openai_client(provider)

    history.append({"role": "user", "content": transcript})
    # System prompt first and unchanged, so automatic prefix caching can hit.
    messages = [{"role": "system", "content": system_prompt}] + context.trim_history(history)
    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
    )
    reply = resp.choices[0].message.content
    _meter(provider, model, getattr(resp, "usage", None))
    history.append({"role": "assistant", "content": reply})
    return reply


# ─── Gemini ────────────────────────────────────────────────────────────────
_gemini_client = None


def _respond_gemini(transcript, history, system_prompt, model, max_tokens=1024):
    global _gemini_client
    from google import genai
    from google.genai import types
    if _gemini_client is None:
        _gemini_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

    history.append({"role": "user", "content": transcript})
    contents = []
    for m in context.trim_history(history):
        role = "user" if m["role"] == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})

    resp = _gemini_client.models.generate_content(
        model=model,
        contents=contents,
        config=types.GenerateContentConfig(
            system_instruction=system_prompt,
            max_output_tokens=max_tokens,
        ),
    )
    reply = resp.text
    _meter("gemini", model, getattr(resp, "usage_metadata", None))
    history.append({"role": "assistant", "content": reply})
    return reply


# ─── Dispatch ──────────────────────────────────────────────────────────────
def _hosted(provider: str, model: str) -> tuple[str, str]:
    """Move a pre-pivot provider choice onto the one we actually serve."""
    from . import hosted
    return hosted.coerce(provider, model)


def respond(provider: str, model: str, transcript: str, history: list, system_prompt: str,
            max_tokens: int = 1024, *, kind: Optional[str] = None, fallback_credits: bool = False) -> str:
    from .. import relay
    from ..errors import relay_not_listening, relay_timeout

    effective_fallback = fallback_credits or is_fallback_credits()
    if relay.is_enabled() and not effective_fallback:
        if not relay.ready():
            raise relay_not_listening()
        effective_kind = kind or getattr(_context, "relay_task", None) or current_kind() or "text"
        context_data = {"text": transcript}
        if history:
            context_data["history"] = history
        try:
            ans = relay.enqueue_sync(
                kind=effective_kind,
                instructions=system_prompt,
                context=context_data,
                timeout_s=relay_wait_seconds(effective_kind),
            )
            if isinstance(ans, (dict, list)):
                return json.dumps(ans)
            return str(ans)
        except (TimeoutError, asyncio.TimeoutError):
            raise relay_timeout(relay_wait_seconds(effective_kind))

    provider, model = _hosted(provider, model)
    if provider == "anthropic":
        return _respond_anthropic(transcript, history, system_prompt, model, max_tokens)
    if provider in ("openai", "deepseek"):
        return _openai_like(provider, transcript, history, system_prompt, model, max_tokens)
    if provider == "gemini":
        return _respond_gemini(transcript, history, system_prompt, model, max_tokens)
    raise ValueError(f"Unknown provider: {provider}")


# ─── Vision: analyse an image (screenshot) with a text prompt ──────────────
import base64
from pathlib import Path


def _read_image_b64(image_path: str | Path) -> str:
    return base64.b64encode(Path(image_path).read_bytes()).decode()


def respond_with_image(provider: str, model: str, image_path: str | Path,
                       prompt: str, system_prompt: str = "", max_tokens: int = 1500,
                       think: bool = False, hosted_only: bool = False) -> str:
    """Vision-model call. Returns text response about the image.

    think=True lets Claude reason before answering (worth the extra seconds
    when the answer must be correct, e.g. solving a coding problem)."""
    if hosted_only:
        import anthropic
        from . import hosted
        token = hosted.access_token()
        if not token:
            raise hosted.NotAvailable("Sign in before reading a screenshot.")
        client = anthropic.Anthropic(api_key=token, base_url=hosted.anthropic_base())
        return _vision_anthropic(hosted.HOSTED_DEFAULT, image_path, prompt, system_prompt,
                                max_tokens, False, client=client)
    provider, model = _hosted(provider, model)
    if provider == "anthropic":
        return _vision_anthropic(model, image_path, prompt, system_prompt, max_tokens, think)
    if provider in ("openai", "deepseek"):
        return _vision_openai_compat(provider, model, image_path, prompt, system_prompt, max_tokens)
    if provider == "gemini":
        return _vision_gemini(model, image_path, prompt, system_prompt, max_tokens)
    raise ValueError(f"Vision not implemented for provider: {provider}")


def _anthropic_thinking(model: str, max_tokens: int) -> dict | None:
    """Thinking config for a Claude model: adaptive on 4.6+, a fixed budget before."""
    if re.search(r"claude-3-(?!7)|claude-3-5", model):
        return None  # no extended thinking
    if re.search(r"haiku-4-5|(sonnet|opus)-4-(0|1|5)\b|sonnet-4-20|opus-4-20|3-7", model):
        return {"type": "enabled", "budget_tokens": max(1024, min(8000, max_tokens // 2))}
    return {"type": "adaptive"}


def _vision_anthropic(model, image_path, prompt, system_prompt, max_tokens=1500, think=False, client=None):
    b64 = _read_image_b64(image_path)
    extra = {"_client": client, "extra_headers": {KIND_HEADER: "link_screenshot"}} if client is not None else {}
    thinking = _anthropic_thinking(model, max_tokens) if think else None
    if thinking:
        extra["thinking"] = thinking
    msg = _final_message(
        model=model,
        max_tokens=max_tokens,
        **extra,
        system=system_prompt or (
            "You are a live coach analysing a screenshot the user just showed "
            "you during a conversation. Explain what's on screen, identify the "
            "task or question, and give the user something they can say or do "
            "in the next 30 seconds."
        ),
        messages=[{
            "role": "user",
            "content": [
                {"type": "image",
                 "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                {"type": "text", "text": prompt},
            ],
        }],
    )
    # With thinking on, content starts with thinking blocks; keep the answer text only.
    if client is not None:
        _meter("anthropic", model, getattr(msg, "usage", None))
        if getattr(msg, "stop_reason", "") == "max_tokens":
            raise ValueError("The screenshot has too much text. Crop it into smaller images.")
    return "".join(b.text for b in msg.content if b.type == "text")


def _vision_openai_compat(provider, model, image_path, prompt, system_prompt, max_tokens=1500):
    client = _openai_client(provider)
    b64 = _read_image_b64(image_path)
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({
        "role": "user",
        "content": [
            {"type": "image_url",
             "image_url": {"url": f"data:image/png;base64,{b64}"}},
            {"type": "text", "text": prompt},
        ],
    })
    resp = client.chat.completions.create(model=model, messages=messages, max_tokens=max_tokens)
    return resp.choices[0].message.content


def _vision_gemini(model, image_path, prompt, system_prompt, max_tokens=1500):
    global _gemini_client
    from google import genai
    from google.genai import types
    if _gemini_client is None:
        _gemini_client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    image_bytes = Path(image_path).read_bytes()
    resp = _gemini_client.models.generate_content(
        model=model,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type="image/png"),
            prompt,
        ],
        config=types.GenerateContentConfig(
            system_instruction=system_prompt or None,
            max_output_tokens=max_tokens,
        ),
    )
    return resp.text


def key_status() -> dict:
    """Return {provider: bool} — True if API key env var is set."""
    return {p: bool(os.environ.get(cfg["env"])) for p, cfg in PROVIDERS.items()}
