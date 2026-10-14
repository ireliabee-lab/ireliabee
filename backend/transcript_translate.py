"""
A saved session's transcript, translated afterwards (docs/translation.md, T3).

The original words stay as they were said; each line's translation is kept beside it, per
language, so the transcript can be read and exported either way and is only ever paid for once.
Unlike live captions this is an ordinary text job: it goes to the user's own assistant when that
is on (kind ``translate``), and its cost is shown before it runs.
"""
from __future__ import annotations

import re
from typing import Optional

from . import languages
from .core import sessions as sess

#: Lines sent in one call: enough context for names and pronouns, small enough to answer quickly.
BATCH = 25
#: For the estimate: the instructions, the share of each line the reply repeats, and JSON overhead.
PROMPT_TOKENS = 160
LINE_OVERHEAD = 12

TRANSLATE_PROMPT = """You translate a saved call transcript into {target}.
You get numbered LINES. Translate every line, faithfully and naturally, keeping names, numbers and
technical terms. A line already in {target} is returned unchanged. Never merge, split, drop or
reorder lines.

Return ONLY JSON: {{"lines": ["translation of line 1", "translation of line 2", ...]}} with exactly
{count} strings, in the same order."""

_TAG = re.compile(r"^(\[[^\]]*\]\s*)+")


def _ensure_table(conn) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS message_translations ("
        " session_id INTEGER NOT NULL, message_id INTEGER NOT NULL, language TEXT NOT NULL,"
        " text TEXT NOT NULL, PRIMARY KEY (message_id, language))"
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_msg_tr_session ON message_translations(session_id, language)")


def target_ok(code: Optional[str]) -> bool:
    return bool(code) and code in languages.LANGUAGES and code != "multi"


def lines(session_id: int) -> list[dict]:
    """What was said, line by line: ``{id, speaker ("you" | "them"), text}``. Screen questions are not speech."""
    with sess._connect() as conn:
        rows = conn.execute(
            "SELECT id, speaker, content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id",
            (session_id,),
        ).fetchall()
    out = []
    for r in rows:
        content = r["content"] or ""
        if content.startswith("[SCREEN"):
            continue
        text = _TAG.sub("", content).strip()
        if text:
            them = content.startswith("[INTERVIEWER") or r["speaker"] == "interviewer"
            out.append({"id": r["id"], "speaker": "them" if them else "you", "text": text})
    return out


def stored(session_id: int, language: str) -> dict[int, str]:
    with sess._connect() as conn:
        _ensure_table(conn)
        rows = conn.execute(
            "SELECT message_id, text FROM message_translations WHERE session_id = ? AND language = ?",
            (session_id, language),
        ).fetchall()
    return {r["message_id"]: r["text"] for r in rows}


def status(session_id: int, language: str) -> dict:
    """The translations kept so far, and how many lines still need one."""
    have = stored(session_id, language)
    all_lines = lines(session_id)
    return {"language": language, "total": len(all_lines),
            "done": sum(1 for x in all_lines if x["id"] in have),
            "lines": {str(k): v for k, v in have.items()}}


def _missing(session_id: int, language: str) -> list[dict]:
    have = stored(session_id, language)
    return [x for x in lines(session_id) if x["id"] not in have]


def estimate(session_id: int, language: str, model: Optional[str] = None) -> dict:
    """Credits to translate the lines that have no translation yet. ``credits`` is None when the
    service's prices aren't known: never a guess, because it is shown as a price."""
    from .core import hosted
    from .errors import resolve_llm
    todo = _missing(session_id, language)
    text_tokens = sum(len(x["text"]) for x in todo) // 4
    calls = -(-len(todo) // BATCH)
    in_tokens = calls * PROMPT_TOKENS + text_tokens + len(todo) * LINE_OVERHEAD
    out_tokens = text_tokens + len(todo) * LINE_OVERHEAD
    try:
        model_name, _ = resolve_llm(model)
    except Exception:
        model_name = model or "default"
    credits = None
    if todo and not hosted.is_admin():
        credits = hosted.credits_for(model_name, in_tokens, out_tokens)
    return {"lines": len(todo), "credits": round(credits, 2) if credits is not None else (0 if not todo else None)}


async def translate(session_id: int, language: str, model: Optional[str] = None,
                    fallback_credits: bool = False) -> dict:
    """Translate every line that has none yet, a batch at a time, keeping each batch as it lands so
    a failure part-way never pays twice. A batch whose answer doesn't line up is not kept."""
    from .routers.mock import _ask_model
    todo = _missing(session_id, language)
    target = languages.name(language)
    for start in range(0, len(todo), BATCH):
        batch = todo[start:start + BATCH]
        numbered = "\n".join(f"{i + 1}. {x['text']}" for i, x in enumerate(batch))
        data = await _ask_model(model, TRANSLATE_PROMPT.format(target=target, count=len(batch)),
                                f"LINES\n{numbered}", kind="translate", session_id=session_id,
                                fallback_credits=fallback_credits)
        got = data.get("lines") if isinstance(data, dict) else None
        if not isinstance(got, list) or len(got) != len(batch):
            continue
        rows = [(session_id, x["id"], language, str(t).strip()) for x, t in zip(batch, got) if str(t).strip()]
        with sess._connect() as conn:
            _ensure_table(conn)
            conn.executemany(
                "INSERT OR REPLACE INTO message_translations (session_id, message_id, language, text) VALUES (?, ?, ?, ?)",
                rows,
            )
    return status(session_id, language)


def markdown(session_id: int, language: Optional[str] = None, them: str = "Them") -> str:
    """The transcript as Markdown, in the words said or in ``language`` (a line with no translation
    yet keeps its original)."""
    row = sess.get_session(session_id)
    title = (row["title"] if row else None) or "Session"
    tr = stored(session_id, language) if language and target_ok(language) else {}
    head = f"# {title}\n\n"
    said = lines(session_id)
    if tr:
        left = sum(1 for x in said if x["id"] not in tr)
        rest = f" {left} lines not translated yet are as said." if left else ""
        head += f"_Transcript in {languages.name(language)}, translated from what was said.{rest}_\n\n"
    body = []
    for x in said:
        who = them if x["speaker"] == "them" else "You"
        body.append(f"**{who}:** {tr.get(x['id'], x['text'])}")
    return head + "\n\n".join(body) + "\n"

