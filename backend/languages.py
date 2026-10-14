"""Session languages (roadmap 3.3): what a call is spoken in, and how everything follows it.

One code per session drives three things:
- live transcription (Deepgram's `language`, Whisper's ISO code),
- what the coach writes (suggested answers, cues, explanations), and
- what's written afterwards (debrief, recap, study pack, mock feedback).

The list must match frontend/src/lib/languages.ts (a frontend test checks).
"""
from __future__ import annotations

from typing import Optional

DEFAULT_LANGUAGE = "en"

# stt: Deepgram code (all verified against nova-3 on 2026-09-19; nova-2 has no Arabic).
# whisper: ISO 639-1 for Whisper / OpenAI / Groq; None lets Whisper detect it.
LANGUAGES: dict[str, dict] = {
    "en":    {"label": "English",            "name": "English",              "stt": "en",    "whisper": "en"},
    "en-US": {"label": "English (US)",       "name": "American English",     "stt": "en-US", "whisper": "en"},
    "en-GB": {"label": "English (UK)",       "name": "British English",      "stt": "en-GB", "whisper": "en"},
    "fr":    {"label": "Français",           "name": "French",               "stt": "fr",    "whisper": "fr"},
    "es":    {"label": "Español",            "name": "Spanish",              "stt": "es",    "whisper": "es"},
    "pt":    {"label": "Português",          "name": "Portuguese",           "stt": "pt",    "whisper": "pt"},
    "de":    {"label": "Deutsch",            "name": "German",               "stt": "de",    "whisper": "de"},
    "ar":    {"label": "العربية",            "name": "Arabic",               "stt": "ar",    "whisper": "ar", "rtl": True},
    "hi":    {"label": "हिन्दी",              "name": "Hindi",                "stt": "hi",    "whisper": "hi"},
    "multi": {"label": "Mixed",              "name": "several languages",    "stt": "multi", "whisper": None},
}


def resolve(code: Optional[str]) -> str:
    """A known code: the one given, else the saved default, else English."""
    if code in LANGUAGES:
        return code  # type: ignore[return-value]
    try:
        from .core.config import load_config
        saved = load_config().get("language")
    except Exception:
        saved = None
    return saved if saved in LANGUAGES else DEFAULT_LANGUAGE


def is_english(code: Optional[str]) -> bool:
    return (code or DEFAULT_LANGUAGE).startswith("en")


def stt_code(code: Optional[str], provider: str = "deepgram") -> Optional[str]:
    lang = LANGUAGES[resolve(code)]
    return lang["stt"] if provider == "deepgram" else lang["whisper"]


def deepgram_model(model: str, code: Optional[str]) -> str:
    """Nova-2 has no Arabic and no code-switching as good as Nova-3's: move up when needed."""
    if model.startswith("nova-2") and resolve(code) in ("ar", "multi"):
        return "nova-3"
    return model


def name(code: Optional[str]) -> str:
    return LANGUAGES[resolve(code)]["name"]


def reply_block(code: Optional[str]) -> str:
    """Prompt rule for anything written for the user to read or say."""
    code = resolve(code)
    if code == "en-GB":
        return "\n\nLANGUAGE — Use British English spelling and phrasing."
    if code == "en-US":
        return "\n\nLANGUAGE — Use American English spelling and phrasing."
    if code == "en":
        return ""
    if code == "multi":
        return (
            "\n\nLANGUAGE — The speakers may switch between languages. Write in the language of the latest "
            "line you are answering; if that's unclear, use the language most of the conversation is in. "
            "Keep the section labels and markers above exactly as written (in English) — only the content "
            "follows the conversation's language."
        )
    lang = LANGUAGES[code]["name"]
    return (
        f"\n\nLANGUAGE — This conversation is in {lang}. Write everything you produce in natural, fluent "
        f"{lang}, the way a native speaker would say it — not a translation from English. Keep code, "
        f"commands, product names and technical terms that {lang} speakers normally leave in English as they "
        f"are. Keep the section labels and markers above exactly as written (in English) — only the content "
        f"goes in {lang}. The transcript is machine-made, so read small slips as the {lang} words they sound like."
    )


def json_block(code: Optional[str]) -> str:
    """Prompt rule for JSON outputs: text values in the language, keys untouched."""
    code = resolve(code)
    if is_english(code):
        return reply_block(code)
    target = "the language most of the conversation is in" if code == "multi" else LANGUAGES[code]["name"]
    return (
        f"\n\nLANGUAGE — Write every text value in {target}, naturally, as a native speaker would. "
        "Keep the JSON keys, enum values and scores exactly as specified (in English)."
    )


def support_block(code: Optional[str]) -> str:
    """Plain-language guidance for a speaker who isn't native in the session's language."""
    code = resolve(code)
    lang = "English" if is_english(code) else ("the conversation's language" if code == "multi" else LANGUAGES[code]["name"])
    return (
        f"LANGUAGE SUPPORT — the speaker is not a native {lang} speaker. Write {lang} they can say "
        "comfortably and naturally: common words, short sentences (about 15 words or fewer), simple "
        "tenses, and no idioms, slang, sayings or long noun chains. Keep all the substance — say it "
        "simply, not less."
    )


# ── Per-session language ─────────────────────────────────────────────────────

def _ensure_column():
    from .core import sessions as sess
    with sess._connect() as conn:
        try:
            conn.execute("ALTER TABLE sessions ADD COLUMN language TEXT")
        except Exception:
            pass
        try:
            # What the user reads (cues, answers, debrief, notes) when it differs from what the call is in
            # (docs/translation.md, T1). NULL means the same as the spoken language.
            conn.execute("ALTER TABLE sessions ADD COLUMN display_language TEXT")
        except Exception:
            pass


_ensure_column()


def set_for_session(session_id: int, code: Optional[str]) -> None:
    from .core import sessions as sess
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET language = ? WHERE id = ?", (resolve(code), session_id))


def for_session(session_id: Optional[int]) -> str:
    """The language a session was held in (older sessions: English)."""
    if session_id is None:
        return resolve(None)
    from .core import sessions as sess
    with sess._connect() as conn:
        row = conn.execute("SELECT language FROM sessions WHERE id = ?", (session_id,)).fetchone()
    code = row["language"] if row else None
    return code if code in LANGUAGES else DEFAULT_LANGUAGE


def set_display_for_session(session_id: int, code: Optional[str]) -> None:
    """What the user reads in: a language code, or empty for "the same as spoken"."""
    from .core import sessions as sess
    value = code if code in LANGUAGES and code != "multi" else None
    with sess._connect() as conn:
        conn.execute("UPDATE sessions SET display_language = ? WHERE id = ?", (value, session_id))


def output_for_session(session_id: Optional[int]) -> str:
    """The language a session's cues, answers, debrief and notes are written in: the reading language if one
    was chosen, else the language the call was held in. Transcription always uses for_session()."""
    if session_id is None:
        return for_session(None)
    from .core import sessions as sess
    with sess._connect() as conn:
        row = conn.execute("SELECT display_language FROM sessions WHERE id = ?", (session_id,)).fetchone()
    code = row["display_language"] if row else None
    return code if code in LANGUAGES else for_session(session_id)
