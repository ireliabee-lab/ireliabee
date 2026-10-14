"""
Live caption translation (docs/translation.md, T2).

Each finished transcript line is translated into the language the user reads, with the last few
lines as context so names and pronouns stay consistent, and sent to the app as
``{"type": "translation", "text": <original>, "translation": ..., "speaker": ...}`` beside the
original. Partials are never translated: they arrive many times a second.

Billing: the session is charged PRICES.translate more per 30 minutes (website/server/billing.js),
and these calls are fast-tier calls covered by the live session's AI allowance. They always use
iReliabee's AI, never the user's own assistant, which is far too slow for live captions.
"""
from __future__ import annotations

import asyncio
from collections import deque
from typing import Optional

from . import languages

TRANSLATE_PROMPT = """You translate live call captions into {target}, line by line.
You get the LINE to translate and, for context only, the few lines before it.
Translate the LINE only: natural, faithful {target}, keeping names, numbers and technical terms.
If the LINE is already in {target}, return it unchanged. Reply with the translation and nothing else."""

#: Lines of context sent with each line, and translations running at once.
CONTEXT_LINES = 3
CONCURRENT = 2
#: A caption line is short: a small answer budget also keeps each call's reservation small.
MAX_TOKENS = 300


class CaptionTranslator:
    def __init__(self, send, target: str, session_id: Optional[int] = None, model: Optional[str] = None):
        self.send = send                      # async (dict) -> None
        self.target = target
        self.session_id = session_id
        self.model = model
        self.recent: deque[str] = deque(maxlen=CONTEXT_LINES)
        self.gate = asyncio.Semaphore(CONCURRENT)
        self.tasks: set[asyncio.Task] = set()

    @classmethod
    def for_call(cls, send, spoken: Optional[str], reading: Optional[str], session_id: Optional[int] = None):
        """A translator when the user reads in another single language than the call; else None."""
        if not reading or reading not in languages.LANGUAGES or reading == "multi" or reading == spoken:
            return None
        return cls(send, reading, session_id)

    def add(self, text: str, speaker: str) -> None:
        """Translate a finished line in the background; the caption itself is never held up."""
        text = (text or "").strip()
        if not text:
            return
        context = list(self.recent)
        self.recent.append(text)
        task = asyncio.create_task(self._translate(text, speaker, context))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _translate(self, text: str, speaker: str, context: list[str]) -> None:
        async with self.gate:
            try:
                translation = await asyncio.get_running_loop().run_in_executor(None, self._call, text, context)
            except Exception:
                return            # a caption without its translation is better than a broken call
        if translation:
            try:
                await self.send({"type": "translation", "text": text, "translation": translation, "speaker": speaker})
            except Exception:
                pass

    def _call(self, text: str, context: list[str]) -> str:
        from .errors import resolve_llm
        from .core.providers import fallback_credits_context, metering_context, respond
        model, provider = resolve_llm(self.model)
        before = "\n".join(context) if context else "(start of the call)"
        message = f"BEFORE\n{before}\n\nLINE\n{text}"
        # iReliabee's AI even when the user's own assistant is on: live captions can't wait for it.
        with metering_context("translate", self.session_id), fallback_credits_context(True):
            out = respond(provider, model, message, [], TRANSLATE_PROMPT.format(target=languages.name(self.target)), MAX_TOKENS)
        return (out or "").strip()

    async def close(self) -> None:
        if self.tasks:
            await asyncio.wait(self.tasks, timeout=10)
