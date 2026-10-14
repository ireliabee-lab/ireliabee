"""
Making quiet speech loud enough to be transcribed.

Microphones and call audio arrive at wildly different levels. On the machine
this was written for, the laptop's microphone array delivers ordinary speech at
about -35 dBFS while the same person's call audio arrives at -17 dBFS: eighteen
decibels apart, about eight times quieter. Speech-to-text does not fail loudly
at that level — it just misses words, or hears nothing at all and waits — so
the user's experience is "I have to shout at it", which is not something anyone
can do in an interview.

Two things follow from that, and this module does both:

**Level.** Each source is brought up to a level speech recognition actually
works at, and no further. The gain follows how loud this person's speech has
been, not the moment-to-moment waveform, so the boost is steady rather than
breathing in and out between words. It only ever rises while someone is
speaking: silence is left where it is, because amplifying an empty room by
twenty-four just hands the transcriber louder nothing.

**The bar for "someone is speaking".** A fixed threshold cannot work across an
eighteen-decibel spread — set high enough for a noisy room and it misses a
quiet speaker entirely. The bar here sits a little above whatever the room is
doing, measured continuously, with a floor under it so a silent room does not
make every breath count as speech.

Nothing here talks to an audio device: blocks of samples in, blocks of samples
out, so all of it can be tested without a microphone.
"""
from __future__ import annotations

import numpy as np

#: Where speech should end up: about -24 dBFS. Loud enough for every
#: transcriber we use, with plenty of room left before anything clips.
TARGET_RMS = 0.06

#: The most we will ever boost: about 28 dB. Past this, what is being
#: amplified is the room, not the person.
MAX_GAIN = 24.0

#: Never quieter than it arrived. Anything already loud enough is left alone.
MIN_GAIN = 1.0

#: How fast the gain may move per block, as a share of the distance to where it
#: wants to be. Up quickly enough to catch the first sentence, down gently, so
#: the level never audibly pumps between words.
RISE = 0.25
FALL = 0.05

#: And never more than this much in one block, however far off the level is:
#: about 4 dB per 50 ms going up. Faster than that is heard as a click rather
#: than as the volume coming up.
MAX_STEP_UP = 1.6
MAX_STEP_DOWN = 0.85

#: How loud a block is ever allowed to come out. Just under full scale, so a
#: transient is turned down rather than squared off.
CEILING = 0.97

#: The quietest thing that can count as speech however silent the room is.
#: Below this is a fan, a hard drive, a hand on the desk.
MIN_SPEECH_RMS = 0.0015

#: Speech has to go on for at least this long before its level is believed.
#: A door, a keyboard, a chair all cross the bar for a block or two; taking one
#: of those for "this is how loud this person is" ran the gain to its limit in
#: an empty room, which the meter showed the moment it existed.
MIN_SPEECH_SEC = 0.15

#: How far above the room's own noise speech has to be. Deliberately small: a
#: missed quiet sentence costs the user far more than a room noise counted as
#: speech, which only holds a turn open a moment longer.
OVER_FLOOR = 2.5

#: The floor follows the room down at once and up slowly, so a door slamming
#: does not raise the bar for the sentence after it.
FLOOR_FALL = 0.30
FLOOR_RISE = 0.002


class AutoGain:
    """
    One source's loudness: what the room is doing, what this person's speech is
    doing, and the gain that brings the second to a level worth transcribing.

    Feed it every block in order; it returns the block to send on.
    """

    def __init__(self, target: float = TARGET_RMS, max_gain: float = MAX_GAIN,
                 rate: int = 16_000):
        self.target = target
        self.max_gain = max_gain
        self.rate = rate
        #: How long the current run of speech has lasted.
        self._speaking_for = 0.0
        self.gain = 1.0
        #: What the room sounds like with nobody speaking.
        self.floor = 0.0
        #: How loud this person's speech has been lately.
        self.speech = 0.0
        #: Whether the last block was someone speaking.
        self.speaking = False
        #: The level of the last block, after gain — what the transcriber hears.
        self.level = 0.0
        self._started = False

    # ── What the room is doing ──────────────────────────────────────────────
    def _follow_floor(self, rms: float) -> None:
        if not self._started:
            # Start low, never at whatever the first block happened to be:
            # listening often starts with someone already talking, and taking
            # their voice as the room's noise would put the bar above them and
            # leave them shouting at it — the very bug this module exists for.
            self.floor = min(rms, MIN_SPEECH_RMS)
            self._started = True
        elif rms < self.floor:
            self.floor += (rms - self.floor) * FLOOR_FALL
        else:
            self.floor += (rms - self.floor) * FLOOR_RISE
        self.floor = max(self.floor, 1e-6)

    def threshold(self) -> float:
        """The level above which this source counts as someone speaking."""
        return max(MIN_SPEECH_RMS, self.floor * OVER_FLOOR)

    # ── The gain ────────────────────────────────────────────────────────────
    def _wanted(self) -> float:
        if self.speech <= 1e-5:
            return self.gain                      # nothing to judge by yet: hold
        return min(self.max_gain, max(MIN_GAIN, self.target / self.speech))

    def push(self, block: np.ndarray) -> np.ndarray:
        """
        Take one block of float32 mono, return it at a level worth transcribing.

        The gain is ramped across the block rather than switched at its edge:
        a step in gain is an audible click, and clicks are exactly the sort of
        thing Whisper writes "Thank you." about.
        """
        if block is None or len(block) == 0:
            return block
        mono = block.astype(np.float32, copy=False)
        rms = float(np.sqrt(np.mean(mono * mono)))

        self._follow_floor(rms)
        self.speaking = rms > self.threshold()
        self._speaking_for = self._speaking_for + len(mono) / self.rate if self.speaking else 0.0
        if self._speaking_for >= MIN_SPEECH_SEC:
            # A peak follower: rises to the loudest recent speech at once, and
            # forgets it slowly, so moving closer to the microphone is followed
            # within a second and a cough does not quieten the next sentence.
            self.speech = max(rms, self.speech * 0.995)

        # The gain only climbs while someone is actually speaking. Between
        # sentences it holds: a room that goes quiet is not a cue to turn
        # everything up until the room itself is loud.
        want = self._wanted()
        if want > self.gain and self._speaking_for < MIN_SPEECH_SEC:
            want = self.gain
        step = RISE if want > self.gain else FALL
        after = self.gain + (want - self.gain) * step
        after = min(after, self.gain * MAX_STEP_UP)
        after = max(after, self.gain * MAX_STEP_DOWN)

        # A limiter, under everything else: the gain follows how loud someone
        # has *been*, so the first loud word after a quiet stretch arrives with
        # the quiet setting still applied. Clipped speech is worse to transcribe
        # than quiet speech, so this block's own peak has the last word — it can
        # even pull the gain below one, which nothing else here may do. It takes
        # effect from the block's first sample rather than easing in: a limiter
        # that ramps has already let the loud part through.
        start = self.gain
        peak = float(np.abs(mono).max())
        if peak > 1e-6:
            room = CEILING / peak
            after = min(after, room)
            start = min(start, room)

        if abs(after - 1.0) < 1e-3 and abs(start - 1.0) < 1e-3:
            self.gain = after
            self.level = rms
            return mono

        ramp = np.linspace(start, after, num=len(mono), dtype=np.float32)
        out = np.clip(mono * ramp, -1.0, 1.0)
        self.gain = after
        self.level = float(np.sqrt(np.mean(out * out)))
        return out

    def describe(self) -> dict:
        """What this source sounds like, for the app and for the log."""
        return {
            "gain": round(self.gain, 2),
            "floor": round(self.floor, 5),
            "speech": round(self.speech, 5),
            "level": round(self.level, 5),
        }
