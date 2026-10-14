"""
Configuration: choose LLM + STT providers, store API keys in .env, remember choice.

Files:
    ~/.config/ireliabee/.env         — API keys (chmod 600). Loaded on startup.
    ~/.config/ireliabee/config.json — last-used choices
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path

from .providers import PROVIDERS, key_status
from .transcribers import STT_PROVIDERS, stt_key_status


from .appdirs import CONFIG_DIR
ENV_PATH = CONFIG_DIR / ".env"
CONFIG_PATH = CONFIG_DIR / "config.json"


#: The app's own settings are never taken from .env. It holds the user's
#: provider keys, written by /config/key; were IRELIABEE_* read from it, one
#: injected line could pin the local guard's token or send the refresh token
#: to another server (audit 182-H1). They come from the real environment only.
_NOT_FROM_DOTENV = ("IRELIABEE_",)


def load_env():
    """Load .env into os.environ — provider keys only, never the app's own settings."""
    if not ENV_PATH.exists():
        return
    for line in _read_env_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k.upper().startswith(_NOT_FROM_DOTENV):
            continue
        os.environ[k] = v


class BadKeyValue(ValueError):
    """A key value that would not stay on its own line of .env."""


def _clean_value(value: str) -> str:
    value = (value or "").strip()
    if len(value) > 1024:
        raise BadKeyValue("That key is far longer than any real one.")
    if any(ord(c) < 32 or ord(c) == 127 for c in value):
        # A newline would start a line of its own: any variable, any value
        # (audit 181-H9, 182-H1). No real key contains a control character.
        raise BadKeyValue("That key contains a line break or control character. Paste just the key.")
    return value


#: One writer at a time. The temp file's name is fixed, so two overlapping
#: saves — FastAPI runs these endpoints on a threadpool, and the settings form
#: and the persona step both save — could otherwise have one truncate the
#: other's temp file and rename the wreck into place: the exact corruption this
#: is here to remove.
_write_lock = threading.Lock()


def _write_atomically(path: Path, text: str, private: bool = False) -> None:
    """
    Write through a temp file beside it, then one rename.

    The shape ``core.account._save`` and ``LicenceStore.save`` already use, and
    the one these two files were missing: an interrupted write now leaves the
    previous file intact instead of a truncated one. A lost config.json silently
    resets persona, language and tone; a lost .env loses pasted API keys.

    ``private`` chmods the temp file *before* it is moved into place, so a file
    holding keys is never even briefly readable by anyone else — the old code
    wrote .env and chmodded it a moment later.
    """
    with _write_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        if private:
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass              # Windows and some filesystems do not do modes
        os.replace(tmp, path)


def _read_env_text() -> str:
    """
    .env as text.

    UTF-8, now that we write UTF-8. A file an older build wrote in the machine's
    own codepage stays readable rather than fatal: ``load_env`` runs at startup
    and has nowhere to report a decode error, so raising here is a backend that
    will not start before an interview.
    """
    try:
        return ENV_PATH.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return ENV_PATH.read_text(encoding="latin-1")


def load_config() -> dict:
    if CONFIG_PATH.exists():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_config(cfg: dict):
    _write_atomically(CONFIG_PATH, json.dumps(cfg, indent=2))


def _write_env_var(key: str, value: str):
    """Append or replace a KEY=value line in .env (chmod 600)."""
    value = _clean_value(value)
    if not key.replace("_", "").isalnum() or key.upper().startswith(_NOT_FROM_DOTENV):
        raise BadKeyValue(f"Not a key name: {key}")
    lines = []
    found = False
    if ENV_PATH.exists():
        for line in _read_env_text().splitlines():
            if line.startswith(f"{key}="):
                lines.append(f"{key}={value}")
                found = True
            else:
                lines.append(line)
    if not found:
        lines.append(f"{key}={value}")
    _write_atomically(ENV_PATH, "\n".join(lines) + "\n", private=True)
    os.environ[key] = value


def _pick(kind: str, catalog: dict, current: str | None) -> tuple[str, str]:
    """Interactive picker for a provider + model. Returns (provider, model)."""
    keys = list(catalog.keys())
    print(f"\n  Choose a {kind} provider:\n")
    for i, p in enumerate(keys, 1):
        env = catalog[p].get("env")
        if env is None:
            state = "✓ no key needed"
        elif os.environ.get(env):
            state = "✓ key set"
        else:
            state = "  needs key"
        marker = "  ← current" if p == current else ""
        print(f"    {i}. {p:<10} [{state}]{marker}")

    while True:
        raw = input(f"\n  Pick {kind} provider (1-{len(keys)}, Enter to keep current): ").strip()
        if raw == "" and current:
            provider = current
            break
        if raw.isdigit() and 1 <= int(raw) <= len(keys):
            provider = keys[int(raw) - 1]
            break
        print("  Invalid choice.")

    cfg = catalog[provider]
    models = list(cfg["models"].keys())
    print(f"\n  Choose a {provider} model:\n")
    for i, m in enumerate(models, 1):
        tag = "  (default)" if m == cfg["default_model"] else ""
        print(f"    {i}. {m:<26} — {cfg['models'][m]}{tag}")

    while True:
        raw = input(f"\n  Pick model (1-{len(models)}, Enter for default): ").strip()
        if raw == "":
            model = cfg["default_model"]
            break
        if raw.isdigit() and 1 <= int(raw) <= len(models):
            model = models[int(raw) - 1]
            break
        print("  Invalid choice.")

    env_var = cfg.get("env")
    if env_var and not os.environ.get(env_var):
        print(f"\n  No {env_var} found.")
        key = input(f"  Paste your {provider} API key (or Enter to skip): ").strip()
        if key:
            _write_env_var(env_var, key)
            print(f"  Saved to {ENV_PATH} (chmod 600).")
        else:
            print(f"  Skipped — set {env_var} before running.")

    return provider, model


def interactive_setup() -> dict:
    """First-run wizard: pick LLM + STT provider/model, paste keys if missing."""
    print("\n" + "─" * 60)
    print("  CLI Interview Recorder — Setup")
    print("─" * 60)
    saved = load_config()

    print("\n" + "=" * 60)
    print("  STEP 1 of 2 — Language model (answers your interview questions)")
    print("=" * 60)
    llm_provider, llm_model = _pick("LLM", PROVIDERS, saved.get("provider"))

    print("\n" + "=" * 60)
    print("  STEP 2 of 2 — Speech-to-text (transcribes the audio)")
    print("=" * 60)
    stt_provider, stt_model = _pick("STT", STT_PROVIDERS, saved.get("stt_provider"))

    choice = {
        "provider": llm_provider,
        "model": llm_model,
        "stt_provider": stt_provider,
        "stt_model": stt_model,
    }
    save_config(choice)
    print(f"\n  Saved to {CONFIG_PATH}")
    print("─" * 60 + "\n")
    return choice


def show_status():
    print("\n  LLM providers:")
    for provider, has_key in key_status().items():
        marker = "✓" if has_key else "✗"
        env = PROVIDERS[provider]["env"]
        print(f"    {marker} {provider:<10} ({env})")

    print("\n  STT providers:")
    for provider, has_key in stt_key_status().items():
        marker = "✓" if has_key else "✗"
        env = STT_PROVIDERS[provider].get("env") or "no key needed"
        print(f"    {marker} {provider:<10} ({env})")

    saved = load_config()
    if saved:
        print(f"\n  Saved LLM: {saved.get('provider')} / {saved.get('model')}")
        print(f"  Saved STT: {saved.get('stt_provider', 'local')} / {saved.get('stt_model', 'small')}")
    print()
