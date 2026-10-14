"""
Multi-provider speech-to-text dispatch.

Each transcriber exposes:
    transcribe(audio: np.ndarray, model: str) -> str

`audio` is a float32 mono numpy array at 16 kHz (what Whisper expects and what
`recorder.py` produces). Cloud providers get it re-encoded to WAV bytes.

Supported (batch):
    - local       (openai-whisper, offline, no key)
    - groq        (Whisper on Groq LPU — very fast, cheap)
    - openai      (Whisper-1 + GPT-4o transcribe family)
    - deepgram    (Nova-3, streaming-quality accuracy)

Supported (streaming, --stream flag):
    - deepgram    (WebSocket, true word-by-word, ~$0.0043/min)
    - openai      (WebSocket realtime, delta events, ~$0.017/min)
"""
from __future__ import annotations

import io
import json
import os
import threading
from typing import Optional
import numpy as np


SAMPLE_RATE = 16000


STT_PROVIDERS = {
    "local": {
        "env": None,
        "models": {
            "tiny":   "tiny   — <1s latency, low accuracy",
            "base":   "base   — quick, moderate accuracy",
            "small":  "small  — recommended for real calls (local)",
            "medium": "medium — slower, higher accuracy",
        },
        "default_model": "small",
    },
    "groq": {
        "env": "GROQ_API_KEY",
        "models": {
            "whisper-large-v3-turbo": "Fastest — sub-second on LPU (default)",
            "whisper-large-v3":       "Highest accuracy, still fast",
        },
        "default_model": "whisper-large-v3-turbo",
        "base_url": "https://api.groq.com/openai/v1",
    },
    "openai": {
        "env": "OPENAI_API_KEY",
        "models": {
            "whisper-1":            "Classic Whisper API",
            "gpt-4o-mini-transcribe": "Newer, cheaper, accurate (default)",
            "gpt-4o-transcribe":    "Most accurate cloud Whisper",
        },
        "default_model": "gpt-4o-mini-transcribe",
    },
    "deepgram": {
        "env": "DEEPGRAM_API_KEY",
        "models": {
            "nova-3":  "Fastest + most accurate (default)",
            "nova-2":  "Prior generation",
        },
        "default_model": "nova-3",
    },
}


def _audio_to_wav_bytes(audio: np.ndarray) -> bytes:
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue()


# ─── Local Whisper ─────────────────────────────────────────────────────────
_local_model = None
_local_size = None


def local_available() -> bool:
    """Offline Whisper needs the openai-whisper package (and PyTorch), which the
    packaged app doesn't ship — it would add gigabytes."""
    import importlib.util
    return importlib.util.find_spec("whisper") is not None


def available_stt_providers() -> dict:
    """The STT providers this install can actually use, for Settings."""
    return {p: cfg for p, cfg in STT_PROVIDERS.items() if p != "local" or local_available()}


def _transcribe_local(audio: np.ndarray, model: str, language: Optional[str] = "en") -> str:
    global _local_model, _local_size
    if not local_available():
        from ..errors import FriendlyError
        raise FriendlyError(
            "config", "Offline Whisper isn't included in this version",
            "Choose Deepgram, Groq or OpenAI in Settings → Speech-to-Text.", "settings",
        )
    import whisper
    if _local_model is None or _local_size != model:
        print(f"  [Loading Whisper {model} model...]")
        _local_model = whisper.load_model(model)
        _local_size = model
        print("  [Model ready]")
    result = _local_model.transcribe(audio, fp16=False, language=language)
    return result["text"].strip()


# ─── OpenAI-compatible (OpenAI + Groq) ─────────────────────────────────────
_openai_clients: dict = {}


def _transcribe_openai_compat(provider: str, audio: np.ndarray, model: str, language: Optional[str] = "en") -> str:
    from openai import OpenAI
    cfg = STT_PROVIDERS[provider]
    key = os.environ.get(cfg["env"])
    if not key:
        raise RuntimeError(f"Missing env var {cfg['env']}")
    cached = _openai_clients.get(provider)
    if not cached or cached[0] != key:
        kwargs = {"api_key": key}
        if "base_url" in cfg:
            kwargs["base_url"] = cfg["base_url"]
        _openai_clients[provider] = (key, OpenAI(**kwargs))
    client = _openai_clients[provider][1]

    wav = _audio_to_wav_bytes(audio)
    resp = client.audio.transcriptions.create(
        model=model,
        file=("audio.wav", wav, "audio/wav"),
        **({"language": language} if language else {}),
    )
    return resp.text.strip()


# ─── Deepgram ──────────────────────────────────────────────────────────────
def _transcribe_deepgram(audio: np.ndarray, model: str, language: Optional[str] = "en") -> str:
    import requests
    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        raise RuntimeError("Missing env var DEEPGRAM_API_KEY")

    wav = _audio_to_wav_bytes(audio)
    resp = requests.post(
        "https://api.deepgram.com/v1/listen",
        params={"model": model, "language": language or "en", "smart_format": "true"},
        headers={
            "Authorization": f"Token {key}",
            "Content-Type": "audio/wav",
        },
        data=wav,
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    return data["results"]["channels"][0]["alternatives"][0]["transcript"].strip()


# ─── What Whisper says when nobody said anything ───────────────────────────
#
# Whisper was trained on subtitles, and when it is handed silence, a keyboard
# tap or a breath it writes what subtitles say at such moments: "Thank you.",
# "Thanks for watching!", "you". It does this confidently, and in a live
# session the invented line goes to the coach as if the other person had said
# it — an answer to a question nobody asked. Two rules keep it out.

#: A whole output that is only one of these is a subtitle reflex, not speech.
#: Compared after lowercasing and dropping punctuation.
INVENTED = frozenset({
    "you", "thank you", "thanks", "thank you very much", "thank you so much",
    "thanks for watching", "thank you for watching", "thanks for listening",
    "please subscribe", "subscribe", "like and subscribe", "see you next time",
    "see you in the next video", "bye", "bye bye", "goodbye", "the end",
    "okay", "ok", "so", "uh", "um", "er", "mm", "hmm", "yeah", "ah",
    "music", "applause", "silence", "beep", "outro", "intro", "laughter",
})

#: Anything below this much actual speech is a click, a breath or a door.
MIN_VOICED_SEC = 0.40
#: Up to this much, a stock phrase is far likelier invented than said.
INVENTED_UP_TO_SEC = 1.6
#: Quiet speech still counts as speech; room tone sits well below this.
VOICED_RMS = 0.008


def voiced_seconds(blocks, floor: float = VOICED_RMS) -> float:
    """
    How much of a buffer was actually someone speaking.

    `blocks` are ``(seconds, rms)`` pairs, in the sizes the sound card
    delivered. A fixed floor, not one scaled to the loudest moment: a door
    slamming before a quiet sentence would otherwise put the bar above the
    sentence and throw the sentence away.
    """
    return sum(secs for secs, rms in blocks if rms >= floor)


def _bare(text: str) -> str:
    """The words alone: no case, no punctuation, no doubled spaces."""
    keep = [c.lower() if (c.isalnum() or c.isspace()) else " " for c in text]
    return " ".join("".join(keep).split())


def clean_batch_text(text: str, voiced_sec: float) -> str:
    """
    What is worth keeping from one batch transcription — "" for nothing.

    Never judges long speech: a real answer that happens to end in "thank you"
    is longer than any of these phrases, and dropping something a person
    actually said would be far worse than letting one through.
    """
    said = (text or "").strip()
    if not said:
        return ""
    if voiced_sec < MIN_VOICED_SEC:
        return ""
    if voiced_sec <= INVENTED_UP_TO_SEC and _bare(said) in INVENTED:
        return ""
    return said


# ─── Dispatch ──────────────────────────────────────────────────────────────
def transcribe(audio: np.ndarray, provider: str = "local", model: str = "small", language: Optional[str] = "en") -> str:
    """`language` is the session's (roadmap 3.3): a Deepgram code for Deepgram, ISO 639-1 (or None to detect) otherwise."""
    if audio is None or len(audio) == 0:
        return ""
    if provider == "local":
        return _transcribe_local(audio, model, language)
    if provider in ("openai", "groq"):
        return _transcribe_openai_compat(provider, audio, model, language)
    if provider == "deepgram":
        return _transcribe_deepgram(audio, model, language)
    raise ValueError(f"Unknown STT provider: {provider}")


def preload_local(model: str):
    """Warm up the local Whisper model so first turn isn't laggy."""
    _transcribe_local(np.zeros(SAMPLE_RATE // 10, dtype=np.float32), model)


# ─── Streaming providers ───────────────────────────────────────────────────

STREAMING_PROVIDERS = frozenset(["deepgram", "openai"])


def transcribe_streaming(
    provider: str,
    model: str,
    get_chunk,   # () -> np.ndarray | None  (None = end of audio)
    on_partial,  # (str) -> None  called with interim text as it arrives
) -> str:
    """
    Stream audio to an STT provider in real-time. Returns final transcript.

    get_chunk() is called repeatedly in a background sender thread; returning
    None signals end of audio and closes the WebSocket cleanly.
    on_partial(text) is called from the receiver thread whenever interim text
    arrives — update a Rich Live display from it.
    """
    if provider == "deepgram":
        return _stream_deepgram(model, get_chunk, on_partial)
    if provider == "openai":
        return _stream_openai(model, get_chunk, on_partial)
    raise ValueError(
        f"Provider '{provider}' does not support streaming. Use deepgram or openai."
    )


def _stream_deepgram(model: str, get_chunk, on_partial) -> str:
    from websockets.sync.client import connect

    key = os.environ.get("DEEPGRAM_API_KEY")
    if not key:
        raise RuntimeError("Missing env var DEEPGRAM_API_KEY")

    url = (
        "wss://api.deepgram.com/v1/listen"
        f"?model={model}&encoding=linear16&sample_rate={SAMPLE_RATE}"
        "&channels=1&interim_results=true&punctuate=true&smart_format=true"
    )

    with connect(url, additional_headers={"Authorization": f"Token {key}"}) as ws:
        accumulated = ""   # locked final utterances so far
        send_err: list = [None]

        def _sender():
            try:
                while True:
                    chunk = get_chunk()
                    if chunk is None:
                        ws.send(json.dumps({"type": "CloseStream"}))
                        break
                    pcm = (np.clip(chunk, -1.0, 1.0) * 32_767).astype(np.int16).tobytes()
                    ws.send(pcm)
            except Exception as exc:
                send_err[0] = exc

        sender = threading.Thread(target=_sender, daemon=True)
        sender.start()

        try:
            for raw in ws:
                data = json.loads(raw)
                if data.get("type") != "Results":
                    continue
                alts = data.get("channel", {}).get("alternatives", [{}])
                text = (alts[0].get("transcript", "") if alts else "").strip()
                if data.get("is_final"):
                    if text:
                        accumulated = (accumulated + " " + text).strip()
                    on_partial(accumulated)
                else:
                    preview = (accumulated + " " + text).strip() if text else accumulated
                    on_partial(preview)
        except Exception:
            pass

        sender.join(timeout=5)
        if send_err[0]:
            raise send_err[0]
        return accumulated.strip()


def _stream_openai(model: str, get_chunk, on_partial) -> str:
    import base64
    from websockets.sync.client import connect

    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise RuntimeError("Missing env var OPENAI_API_KEY")

    url = "wss://api.openai.com/v1/realtime?intent=transcription"
    headers = {
        "Authorization": f"Bearer {key}",
        "OpenAI-Beta": "realtime=v1",
    }

    with connect(url, additional_headers=headers) as ws:
        ws.send(json.dumps({
            "type": "transcription_session.update",
            "session": {
                "input_audio_format": "pcm16",
                "input_audio_transcription": {"model": model},
                "turn_detection": None,
            },
        }))

        current = ""
        send_err: list = [None]

        def _sender():
            try:
                while True:
                    chunk = get_chunk()
                    if chunk is None:
                        ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                        break
                    pcm = (np.clip(chunk, -1.0, 1.0) * 32_767).astype(np.int16).tobytes()
                    ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(pcm).decode(),
                    }))
            except Exception as exc:
                send_err[0] = exc

        sender = threading.Thread(target=_sender, daemon=True)
        sender.start()

        final = ""
        try:
            for raw in ws:
                data = json.loads(raw)
                ev = data.get("type", "")
                if ev == "conversation.item.input_audio_transcription.delta":
                    current += data.get("delta", "")
                    on_partial(current)
                elif ev == "conversation.item.input_audio_transcription.completed":
                    final = data.get("transcript", current)
                    on_partial(final)
                    break
                elif ev == "error":
                    raise RuntimeError(f"OpenAI realtime error: {data.get('error', data)}")
        except Exception:
            pass

        sender.join(timeout=5)
        if send_err[0]:
            raise send_err[0]
        return (final or current).strip()


def stt_key_status() -> dict:
    return {
        p: (True if cfg["env"] is None else bool(os.environ.get(cfg["env"])))
        for p, cfg in STT_PROVIDERS.items()
    }
