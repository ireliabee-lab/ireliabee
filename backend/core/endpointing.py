"""
Where one utterance ends and the next begins.

When no streaming transcriber is available — offline Whisper, Groq, OpenAI, or
push-to-talk — the audio does not arrive as words. It arrives as blocks of
samples, and something has to decide which run of blocks is one thing somebody
said, so it can be sent off and paid for as a single transcription. That
decision is here.

The rule is silence: a run of speech ends when the room has been quiet for
`SILENCE_SECS`, and a very long one is also ended at `MAX_UTTERANCE_SEC` so a
single segment cannot grow without limit. What counts as speech in the first
place is decided one layer down, against the room's own noise rather than a
fixed level — see `core/gain.py`.

What makes this its own module is the counting. The length that the cap is
measured against must be the length of the *utterance*, not the length of the
socket: someone who listens for a minute before answering has spent a minute of
blocks going past, and if those count, their first sentence is already over the
cap before they open their mouth and gets cut off at the first pause in it.
Silence before anyone speaks is dropped and not counted — that is the whole
point of the `started` flag — and every counter is reset when an utterance is
handed over.

Nothing here talks to an audio device: blocks of samples in, one finished
utterance out, so all of it can be tested without a microphone.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from .transcribers import voiced_seconds

SAMPLE_RATE = 16_000

#: Quiet for this long and whatever was being said is finished.
SILENCE_SECS = 1.2

#: And a segment never grows past this, however long the answer. Checked once
#: the speaker has paused, so the cap ends a long answer at a break in it
#: rather than mid-word.
MAX_UTTERANCE_SEC = 60.0


class Utterance:
    """
    One utterance being collected, block by block.

    Feed it every block the sound card delivers, with `gain.AutoGain`'s verdict
    on whether that block was someone speaking. It returns ``None`` while the
    utterance is still going, and ``(audio, voiced_sec)`` on the block that
    ends it — the samples to transcribe, and how much of them was actually
    speech rather than the room. After that it is empty and ready for the next.
    """

    def __init__(self, sample_rate: int = SAMPLE_RATE,
                 silence_secs: float = SILENCE_SECS,
                 max_sec: float = MAX_UTTERANCE_SEC) -> None:
        self.sample_rate = sample_rate
        self.silence_secs = silence_secs
        self.max_sec = max_sec
        #: Has anyone spoken yet? Until they have, blocks are thrown away.
        self.started = False
        #: Quiet since the last block of speech.
        self.silence_time = 0.0
        #: Seconds held — speech and the pauses inside it, nothing before it.
        self.length = 0.0
        self._buf: list[np.ndarray] = []
        # One (seconds, rms) pair per block, so the end of an utterance knows
        # how much of it was speech and how much was the room.
        self._levels: list[tuple[float, float]] = []

    def push(self, chunk: np.ndarray, speaking: bool) -> Optional[tuple[np.ndarray, float]]:
        seconds = len(chunk) / self.sample_rate
        if speaking:
            rms = float(np.sqrt(np.mean(np.asarray(chunk, dtype=np.float32) ** 2)))
            self.started = True
            self.silence_time = 0.0
            self._keep(chunk, seconds, rms)
            return None
        if not self.started:
            # Nobody is speaking and nobody has yet: an empty room, or someone
            # listening. Not kept, and — the bug this module exists for — not
            # counted towards the length of the answer they have not given.
            return None
        self.silence_time += seconds
        # The pause is kept: it is what tells the transcriber the sentence
        # finished, and it is scored as silence so it never reads as speech.
        self._keep(chunk, seconds, 0.0)
        if self.silence_time >= self.silence_secs or self.length >= self.max_sec:
            return self._flush()
        return None

    def _keep(self, chunk: np.ndarray, seconds: float, rms: float) -> None:
        self._buf.append(chunk)
        self._levels.append((seconds, rms))
        self.length += seconds

    def _flush(self) -> tuple[np.ndarray, float]:
        audio = np.concatenate(self._buf).astype(np.float32)
        voiced = voiced_seconds(self._levels)
        self.reset()
        return audio, voiced

    def reset(self) -> None:
        """Forget what is held — a new utterance starts from nothing."""
        self.started = False
        self.silence_time = 0.0
        self.length = 0.0
        self._buf = []
        self._levels = []
