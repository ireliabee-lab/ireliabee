"""
Deepgram WebSocket streaming client.

Opens a persistent WS to Deepgram, streams raw PCM16 audio in, yields partial
+ final transcripts as they arrive. Designed for use inside a FastAPI WS
handler where we also have the client WebSocket open.

Usage:
    async with DeepgramSession() as dg:
        # feed PCM16 bytes from mic
        await dg.send_audio(pcm_bytes)
        # get transcripts
        async for msg in dg.transcripts():
            if msg["is_final"]:
                ...
        # close the mic side when done to trigger a final flush
        await dg.finish()
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import AsyncGenerator, Optional

import websockets


DEEPGRAM_URL = (
    "wss://api.deepgram.com/v1/listen"
    "?model=nova-3"
    "&language={language}"
    "&encoding=linear16"
    "&sample_rate=16000"
    "&channels=1"
    "&interim_results=true"
    "&smart_format=true"
    "&punctuate=true"
    "&mip_opt_out=true"         # no model training on our audio (Privacy Policy)
    "&endpointing=300"          # ms of silence before end-of-utterance
    # endpointing alone never fires over steady room noise; UtteranceEnd is
    # based on word timings, so it still ends the turn in a noisy room.
    "&utterance_end_ms=1000"
)


class DeepgramSession:
    """
    A live transcription socket.

    Points at our relay by default and at Deepgram directly when an admin has
    their own key — the same rule the model client follows, decided in one
    place in `core/hosted.py`. Both ends speak Deepgram's protocol, so nothing
    below this line changes.

    `api_key`, when given, forces the direct path. Tests use it; the app does
    not pass it.
    """

    def __init__(self, api_key: Optional[str] = None, language: Optional[str] = None, translate: bool = False):
        # Session language (roadmap 3.3): a Deepgram code such as "fr", or "multi" for code-switching.
        self.language = language or "en"
        # Captions are translated in this call: the relay bills it with the session (docs/translation.md, T2).
        self.translate = translate
        self.api_key = api_key
        self.ws: Optional[websockets.WebSocketClientProtocol] = None
        #: The model Deepgram says it is transcribing with — "nova-3", and so
        #: on. Worth reading rather than assuming: an ordinary account goes
        #: through our relay, which picks the transcriber on the server, so
        #: what this machine asked for is a request and not an answer. Empty
        #: until the first result comes back.
        self.model = ""

    def _endpoint(self) -> tuple:
        if self.api_key:
            return (DEEPGRAM_URL.replace("{language}", self.language),
                    {"Authorization": f"Token {self.api_key}"})
        from .core import hosted
        if self.translate:
            return hosted.deepgram_endpoint(self.language, translate=True)
        return hosted.deepgram_endpoint(self.language)

    async def __aenter__(self) -> "DeepgramSession":
        # `_endpoint` may have to refresh the sign-in token, which is a
        # blocking HTTPS request. On the loop that freezes the whole app until
        # it answers or times out — once per source, so about twice as long
        # again for Auto, which is how a dropped network after sleep/wake turned
        # into twenty seconds of a frozen window mid-interview.
        url, headers = await asyncio.get_running_loop().run_in_executor(None, self._endpoint)
        self.ws = await websockets.connect(
            url, additional_headers=headers, max_size=None,
            # A speech socket that has died answers nothing and says nothing.
            # The library waits twenty seconds before its first ping and twenty
            # more for the reply, so up to forty seconds of a screen saying
            # "listening" to a connection that has gone — in an interview, most
            # of an answer. Five seconds between pings and ten to answer brings
            # that to about fifteen, with enough slack that a busy moment on
            # this machine cannot close a healthy socket: the reply has to come
            # from our own event loop, which is also pumping transcripts, levels
            # and everything sent to the app.
            ping_interval=5, ping_timeout=10,
        )
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass

    def _note_model(self, data: dict) -> None:
        """
        Take the model name out of whatever frame carries it.

        Deepgram puts it in two shapes: on a result, `metadata.model_info` is
        the model itself; on the closing Metadata frame, `model_info` is keyed
        by model id. Both give the same `arch` — the short name people know,
        like "nova-3", where `name` is the internal "general-nova-3".
        """
        info = (data.get("metadata") or {}).get("model_info") or data.get("model_info")
        if not isinstance(info, dict) or not info:
            return
        one = info if "arch" in info or "name" in info else next(iter(info.values()), None)
        if not isinstance(one, dict):
            return
        name = one.get("arch") or one.get("name") or ""
        if name:
            self.model = name

    async def send_audio(self, pcm16: bytes) -> None:
        """Push raw 16 kHz mono PCM16 bytes."""
        if self.ws is not None:
            await self.ws.send(pcm16)

    async def finish(self) -> None:
        """Tell Deepgram no more audio is coming so it can flush a final result."""
        if self.ws is not None:
            try:
                await self.ws.send(json.dumps({"type": "CloseStream"}))
            except Exception:
                pass

    async def transcripts(self) -> AsyncGenerator[dict, None]:
        """
        Yields dicts like:
            {"text": "...", "is_final": bool, "speech_final": bool, "utterance_end": bool}
        speech_final often arrives on a Results message with empty text, and
        UtteranceEnd carries no text at all — both mark the end of a turn.
        Stops when Deepgram closes the socket.
        """
        assert self.ws is not None
        try:
            async for raw in self.ws:
                try:
                    data = json.loads(raw)
                except Exception:
                    continue
                kind = data.get("type")
                self._note_model(data)
                if kind == "UtteranceEnd":
                    yield {"text": "", "is_final": False, "speech_final": False, "utterance_end": True}
                    continue
                if kind != "Results":
                    continue
                alts = data.get("channel", {}).get("alternatives", [])
                text = (alts[0].get("transcript", "") if alts else "").strip()
                speech_final = bool(data.get("speech_final", False))
                if not text and not speech_final:
                    continue
                yield {
                    "text": text,
                    "is_final": bool(data.get("is_final", False)),
                    "speech_final": speech_final,
                    "utterance_end": False,
                }
        except websockets.exceptions.ConnectionClosed as closed:
            # Our relay closes with 4402 when the session could not reserve its
            # next block of credits, and with 4403 when an admin blocks the
            # account mid-call (website/server/billing.js). Ending quietly
            # would leave the screen saying "start listening again" — which,
            # for a suspended account, can only be refused — so say why.
            from .errors import relay_closed
            why = relay_closed(closed)
            if why is not None:
                raise why from None
            return
