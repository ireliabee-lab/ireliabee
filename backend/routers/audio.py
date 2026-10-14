"""
Audio WebSocket router with Deepgram streaming STT and parallel mic + system
audio capture.

Client → server (JSON messages):
  {"mode": "live", "sources": ["mic"|"system", ...], "speaker_map": {...}}
  {"action": "start"}   (push-to-talk only)
  {"action": "stop_record"} | {"action": "stop"}
  {"action": "set_sources", "sources": [...]}   (change mid-session)

Server → client:
  {"type": "ready"}
  {"type": "recording"}
  {"type": "partial", "text": "...", "is_final": bool, "speaker": "..."}
  {"type": "transcript", "text": "...", "speaker": "..."}
  {"type": "error", "message": "..."}

Sources:
  mic     → default microphone, tagged as speaker="user"
  system  → monitor of the current default output, tagged as speaker="interviewer"
            (Linux: recorded with pw-record/parec; Windows: WASAPI loopback)
"""
import asyncio
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
import time
import weakref
from typing import Optional

import numpy as np
import sounddevice as sd
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

IS_WINDOWS = platform.system() == "Windows"
IS_LINUX   = platform.system() == "Linux"
IS_MACOS   = platform.system() == "Darwin"

from ..deepgram_stream import DeepgramSession
from .. import languages
from .. import entitlements
from ..core import costs, stt_routing
from ..errors import (FriendlyError, audio_unsupported, classify, mic_lost, mic_silent,
                      system_lost)

# CLI's multi-provider batch transcriber (local Whisper / Groq / OpenAI / Deepgram)
from ..core.transcribers import transcribe as batch_transcribe  # type: ignore
from ..core.transcribers import MIN_VOICED_SEC, clean_batch_text
from ..core.gain import AutoGain
from ..core.endpointing import Utterance

router = APIRouter()

SAMPLE_RATE = 16_000
BLOCK_MS = 50
BLOCK_SIZE = SAMPLE_RATE * BLOCK_MS // 1000
ACTIVITY_HANGOVER_SEC = 0.25

# Whether a block is someone speaking is no longer a fixed level: a microphone
# and a call arrive eighteen decibels apart, and a single number set high enough
# for the loud one made the quiet one inaudible until it was shouted at. The bar
# now sits just above whatever the room is doing, measured continuously, and the
# audio is brought up to a level worth transcribing on the way past — both in
# core/gain.py.

# Batch mode (non-Deepgram) endpointing — which run of blocks is one thing
# somebody said, and how long the quiet after it has to be: core/endpointing.py.


def stt_task(mode: str) -> str:
    """
    What kind of work this socket is, for choosing a transcriber.

    "live" means someone is in a conversation right now and the words have to
    appear while they are still speaking. It is the mode that says so — not
    whether the session has been saved, which happens only once the coach has
    answered, i.e. always after the listening has started.
    """
    return "live" if mode == "live" else "rehearsal"


_STREAM_INIT_LOCK = asyncio.Lock()

# A real mic always picks up some noise; exact zeros mean the OS handed us a
# muted/wrong device (e.g. a Bluetooth sink monitor as the default source).
SILENT_INPUT_CHECK_SEC = 4.0

#: How long without a single block before the microphone counts as gone.
#:
#: Measured rather than chosen: a healthy stream on this laptop calls back every
#: 47 ms, and the worst gap that could be provoked — every core deliberately
#: saturated — was 328 ms. Five seconds is a hundred missed blocks and fifteen
#: times that worst case, which is the margin a false "your microphone is gone"
#: mid-interview deserves.
MIC_GONE_SEC = 5.0


def _stream_stopped(stream) -> bool:
    """
    Whether PortAudio says outright that this stream is no longer running.

    Conservative in the same direction as `_running` and `_stream_is_open`: a
    stream that cannot answer counts as running, and only a definite False
    counts. Being wrong in this direction misses a dead microphone; being wrong
    in the other one interrupts a live answer.
    """
    try:
        return stream.active is False
    except Exception:
        return False


async def _watch_microphone(ws: WebSocket, source: str, levels: dict, stream,
                            stop_evt: asyncio.Event) -> None:
    """
    Notice a microphone that has stopped, and say so as a microphone problem.

    System audio had a watcher and the microphone had none: its only check ran
    once, four seconds in, against a running maximum that is never reset — so
    one non-zero sample in the first four seconds and nothing could be noticed
    for the rest of the session. A microphone that went away mid-call produced no
    audio, Deepgram eventually closed the socket for want of any, and the user was
    told "Speech recognition stopped", which sent them looking in the wrong place.

    Both checks here are one-sided on purpose. Each has a state that definitely
    means trouble, and every other answer is taken as fine. Nothing infers
    anything from silence — a person who has stopped talking is indistinguishable
    from a microphone that has died — only from *no blocks at all*, which a
    running stream cannot produce, and from PortAudio saying outright that the
    stream is no longer active.

    A stall has to survive two passes. `time.monotonic()` on Windows counts time
    the machine spent asleep, so coming back from sleep looks exactly like a
    device that stopped; if the stream is in fact fine, the next pass sees fresh
    blocks and the alarm is dropped.

    System audio is not watched here: on Windows it has its own watcher, and its
    pacer emits blocks even while idle, so a block clock would never fire for it.
    """
    if source != "mic":
        return
    said = False
    first = True
    suspect = False
    while not stop_evt.is_set():
        try:
            await asyncio.wait_for(stop_evt.wait(), timeout=SILENT_INPUT_CHECK_SEC)
            return
        except asyncio.TimeoutError:
            pass
        if first:
            first = False
            # The original check, unchanged: exact zeros for the first few
            # seconds means the OS opened something that is not a microphone.
            if levels["peak"] == 0.0:
                await _say_mic_problem(ws, mic_silent())
                said = True
        if said:
            continue
        gone, suspect = mic_verdict(levels, _stream_stopped(stream), suspect,
                                   time.monotonic())
        if not gone:
            continue
        print(f"  [microphone: nothing for {MIC_GONE_SEC:.0f}s across two checks — "
              f"treating it as gone]", file=sys.stderr, flush=True)
        await _say_mic_problem(ws, mic_lost())
        said = True


def mic_verdict(levels: dict, stopped: bool, suspect: bool, now: float) -> tuple[bool, bool]:
    """
    One pass of the microphone watch: ``(say it is gone, suspect it next time)``.

    Pulled out of the loop so the rule can be tested as a rule. The tests for it
    used to drive the real loop and count what came out within a wall-clock
    window, which only ever passed because Windows' coarse timers happened to
    fit exactly one pass into that window — one more and the test asserted the
    opposite of what it claims. A decision that takes its inputs and returns its
    answer cannot be read differently by a faster clock.

    Two rules, both one-sided. Nothing is concluded from silence: someone who has
    stopped talking looks exactly like a microphone that has died. Only *no blocks
    at all* counts, which a running stream cannot produce, or PortAudio saying
    outright that the stream has stopped.

    And it has to hold for two passes. Monotonic time on Windows counts time the
    machine spent asleep, so coming back from sleep looks just like a device that
    stopped; a stream that is in fact fine clears the suspicion on the next pass.
    """
    last = levels.get("last_block") or 0.0
    stalled = bool(last) and (now - last) > MIC_GONE_SEC
    if not (stalled or stopped):
        return False, False         # delivering: nothing is wrong, forget any suspicion
    if not suspect:
        return False, True          # one more pass before saying anything
    return True, True


async def _say_mic_problem(ws: WebSocket, err: FriendlyError) -> None:
    try:
        await ws.send_json({"type": "error", **err.as_dict()})
    except Exception:
        pass


def _detect_system_monitor() -> Optional[str]:
    """Linux only: find a PulseAudio-compatible monitor device name for the default sink."""
    if not IS_LINUX:
        return None
    # 1. Best: query the active default sink via pactl info
    try:
        out = subprocess.check_output(["pactl", "info"], stderr=subprocess.DEVNULL, text=True)
        for line in out.splitlines():
            if line.strip().lower().startswith("default sink:"):
                sink = line.split(":", 1)[1].strip()
                if sink:
                    return f"{sink}.monitor"
    except Exception:
        pass
    # 2. Fallback: pactl list sinks short
    try:
        out = subprocess.check_output(["pactl", "list", "sinks", "short"], stderr=subprocess.DEVNULL, text=True)
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 2 and ("alsa" in parts[1] or "RUNNING" in line):
                return f"{parts[1]}.monitor"
        lines = [l.strip() for l in out.splitlines() if l.strip()]
        if lines:
            parts = lines[0].split()
            if len(parts) >= 2:
                return f"{parts[1]}.monitor"
    except Exception:
        pass
    # 3. Fallback: pw-cli ls Node
    try:
        out = subprocess.check_output(["pw-cli", "ls", "Node"], stderr=subprocess.DEVNULL, text=True)
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("node.name") and ("sink" in line or "output" in line):
                return line.split("=", 1)[1].strip().strip('"') + ".monitor"
    except Exception:
        pass
    return None


def _system_tool_env() -> dict:
    env = os.environ.copy()
    # PyInstaller prepends its bundle dir to LD_LIBRARY_PATH; system audio
    # tools must load the system's own libpipewire/libpulse instead.
    orig = env.pop("LD_LIBRARY_PATH_ORIG", None)
    if orig is not None:
        env["LD_LIBRARY_PATH"] = orig
    elif getattr(sys, "frozen", False):
        env.pop("LD_LIBRARY_PATH", None)
    return env


def _default_sink_name() -> Optional[str]:
    """Linux: node name of the output the user is currently hearing."""
    try:
        out = subprocess.check_output(["pw-metadata", "0", "default.audio.sink"],
                                      stderr=subprocess.DEVNULL, text=True, timeout=3, env=_system_tool_env())
        m = re.search(r'"name"\s*:\s*"([^"]+)"', out)
        if m:
            return m.group(1)
    except Exception:
        pass
    try:
        out = subprocess.check_output(["pactl", "get-default-sink"],
                                      stderr=subprocess.DEVNULL, text=True, timeout=3, env=_system_tool_env()).strip()
        if out:
            return out
    except Exception:
        pass
    mon = _detect_system_monitor()
    return mon[: -len(".monitor")] if mon and mon.endswith(".monitor") else None


def _linux_system_capture_cmd() -> tuple[Optional[list[str]], Optional[FriendlyError]]:
    sink = _default_sink_name()
    if not sink:
        return None, FriendlyError(
            "system_lost", "Can’t find the audio output",
            "Linux didn’t report a default output, so there is nothing to record. "
            "Choose one under Sound, then start listening again.",
        )
    if shutil.which("pw-record"):
        return ["pw-record", "--target", sink, "-P", "{ stream.capture.sink=true }",
                "--rate", str(SAMPLE_RATE), "--channels", "1", "--format", "f32", "-"], None
    if shutil.which("parec"):
        return ["parec", f"--device={sink}.monitor", "--format=float32le",
                f"--rate={SAMPLE_RATE}", "--channels=1", "--raw"], None
    return None, audio_unsupported(
        "Recording what’s playing needs pw-record (PipeWire) or parec (PulseAudio). "
        "Install either one, then start listening again.",
    )


class _SubprocessCapture:
    """
    Linux system-audio capture. PipeWire's ALSA plugin ignores PULSE_SOURCE,
    so a sounddevice stream can't be pointed at a sink monitor — it silently
    records the default mic instead. Record the monitor with the native tool
    and feed blocks to the same (indata, frames, time, status) callback.
    """

    def __init__(self, cmd: list[str], callback):
        self._callback = callback
        self._stopped = False
        self._proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      env=_system_tool_env())
        self._thread = threading.Thread(target=self._read, daemon=True)

    def start(self):
        self._thread.start()

    def _read(self):
        nbytes = BLOCK_SIZE * 4  # float32
        out = self._proc.stdout
        while not self._stopped:
            buf = out.read(nbytes)
            if not buf or len(buf) < nbytes:
                break
            block = np.frombuffer(buf, dtype=np.float32).reshape(-1, 1)
            self._callback(block, len(block), None, None)

    def stop(self):
        self._stopped = True
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._proc.kill()

    def close(self):
        pass


class _CaptureState:
    """One rebuild's worth of capture, kept apart from the live object until it works."""

    def __init__(self, generation: int):
        self.generation = generation
        self.streams: list = []
        self.buffers: list[np.ndarray] = []
        self.primed: list[bool] = []
        self.names: list[str] = []
        self.errors: list[str] = []


def _discard(pa, streams) -> None:
    """Close streams and release a PortAudio instance, never raising."""
    for stream in streams:
        for shut in (getattr(stream, "stop_stream", None), getattr(stream, "close", None)):
            try:
                if shut:
                    shut()
            except Exception:
                pass
    if pa is not None:
        try:
            pa.terminate()
        except Exception:
            pass


class _WindowsLoopbackCapture:
    """
    Windows system-audio capture via WASAPI loopback (PyAudioWPatch).

    Loopback-records every output device at once and mixes them, so the other
    side of a call is heard whether Zoom/Teams plays it on the speakers,
    earbuds, a headset or a monitor — not only on the default device. WASAPI
    delivers nothing while a device is idle, so a pacer thread emits steady
    16 kHz mono blocks (zeros when idle) to the same (indata, frames, time,
    status) callback, keeping activity and end-of-utterance detection moving.

    **Devices are watched, not just enumerated once.** PortAudio reads the
    device list when it initialises and never looks again, so earbuds plugged
    in mid-call used to be invisible: the call moved to them and we carried on
    recording a speaker that had gone silent, with no error. A watcher thread
    compares the device list every few seconds and rebuilds the capture when it
    changes. Rebuilding costs a fraction of a second of audio, which is less
    than the device change itself costs.

    Bluetooth makes this routine rather than rare: turning on a headset's
    microphone moves Windows to the hands-free profile, which is a different
    endpoint, so the output device can change without anyone touching anything.
    """

    MAX_BUFFERED = SAMPLE_RATE // 2   # cap per-device backlog (clock drift)
    PRIME_SAMPLES = BLOCK_SIZE * 2    # jitter buffer before draining a device

    #: How often to check whether the set of output devices has changed.
    WATCH_SECONDS = 3

    def __init__(self, callback, only: "str | None" = None):
        import pyaudiowpatch as pyaudio  # Windows-only dependency
        self._pyaudio = pyaudio
        self._callback = callback
        #: Capture just this output device, by name, instead of all of them.
        #: Mixing every output is the right default — it means a call is heard
        #: whether it plays on the speakers, the earbuds or a monitor, with
        #: nothing to configure. But when the wrong thing is being heard, being
        #: able to say *which* device to listen to is the difference between
        #: fixing it and guessing.
        self._only = only
        self._lock = threading.Lock()
        self._buffers: list[np.ndarray] = []
        self._primed: list[bool] = []
        self._streams = []
        self._stop_evt = threading.Event()
        self._thread = threading.Thread(target=self._pace, daemon=True)
        self._watcher = threading.Thread(target=self._watch, daemon=True)
        self._pa = None
        #: Bumped on every rebuild. A callback from a stream we have since
        #: closed carries the old value and is dropped, so a device that goes
        #: away mid-flight cannot write into a slot that now means something
        #: else.
        self._generation = 0
        self._started = False
        self.device_names: list[str] = []
        self.errors: list[str] = []
        #: Set when the output device changed and the new one would not open.
        #: We keep recording the device we had, but it has almost certainly
        #: gone quiet — the audio moved with the user. Silence that we know
        #: about has to reach the screen; the alternative is a session that
        #: looks like it is listening and is not.
        self.stale: str | None = None
        #: The device list this capture was last built against, recorded by
        #: `_build` from the very instance it enumerated, so the watcher
        #: compares against what we actually opened rather than against
        #: whatever the machine looked like when its thread happened to start.
        self._known: tuple = ()
        #: The last rebuild failure we logged, so retrying every few seconds
        #: does not fill the log with the same line.
        self._last_failure: str | None = None
        self._build()

    def _fingerprint(self) -> tuple:
        # A chosen device is watched for the same reason all of them are: it
        # can disappear mid-call. The watcher rebuilds either way.
        """
        The current set of loopback devices.

        Read through a throwaway PyAudio instance because PortAudio only reads
        the device list when it initialises: asking the live one would return
        the same answer for ever, which is the bug this exists to catch.
        """
        pa = None
        try:
            pa = self._pyaudio.PyAudio()
            return tuple(sorted(d["name"] for d in pa.get_loopback_device_info_generator()))
        except Exception:
            return ()
        finally:
            if pa is not None:
                try:
                    pa.terminate()
                except Exception:
                    pass

    def _build(self):
        """
        Open every loopback device and swap the result in, all or nothing.

        **Nothing touches `self` until the whole rebuild has succeeded.** It
        used to publish as it went and unwind on failure, which left the object
        half-rebuilt: the old streams were handed back, but the buffers they
        write into had already been replaced by the new empty ones and the
        generation counter had already moved on, so every block those streams
        delivered was dropped as stale. The call went silent for good, with a
        healthy-looking device list and no error anywhere.

        That is not a rare path. A Bluetooth headset moving to the hands-free
        profile — which is what happens the moment a meeting app opens the
        microphone — changes the device list to one whose loopback endpoint
        often will not open at all. Playing a video never touches the
        microphone, so it never triggered this. Hence system audio that worked
        on YouTube and died in Zoom.

        **A device is started here too, not after publishing.** Opening a WASAPI
        endpoint only reserves it; starting is what begins moving audio, and a
        device whose profile has just changed fails at the second, not the
        first. That failure used to be swallowed, so the rebuild counted a
        stream that would never run as a working device, published it, and
        discarded the streams that *were* working. The call went silent for
        good behind a healthy device list, an empty error list and a cleared
        `stale` — the one state the app cannot tell apart from a quiet room.

        Raises only if no device would open *and start*, and in that case
        `self` is exactly as it was.
        """
        pa = self._pyaudio.PyAudio()
        # One past the live generation: callbacks tagged with it are dropped
        # until publish, and the streams are opened stopped, so nothing can
        # write into the new buffers before they are the real ones.
        generation = self._generation + 1
        state = _CaptureState(generation)
        seen: list[str] = []
        try:
            for dev in pa.get_loopback_device_info_generator():
                seen.append(dev["name"])
                if self._only and dev["name"] != self._only:
                    continue
                try:
                    self._open_device(pa, state, dev, start=self._started)
                    state.names.append(dev["name"])
                except Exception as e:
                    # Kept rather than swallowed: one device failing while
                    # another works used to look exactly like everything working.
                    state.errors.append(f"{dev['name']}: {e}")
        except Exception:
            _discard(pa, state.streams)
            raise
        if not state.streams:
            detail = ("; ".join(state.errors) if state.errors else
                      (f"the chosen output '{self._only}' is not available"
                       if self._only else "no output devices found"))
            _discard(pa, state.streams)
            raise RuntimeError(f"no WASAPI loopback device could be opened ({detail})")

        with self._lock:
            self.stale = None
            self._last_failure = None
            self._generation = generation
            self._known = tuple(sorted(seen))
            self._pa, self._streams = pa, state.streams
            self._buffers, self._primed = state.buffers, state.primed
            self.device_names, self.errors = state.names, state.errors

    def _running(self) -> bool:
        """
        Whether anything we opened is still actually recording.

        Deliberately generous: a stream that cannot answer is taken to be
        working, so an unfamiliar backend cannot push the capture into a
        rebuild loop. Only a definite "none of these is running" counts.
        """
        with self._lock:
            streams = list(self._streams)
        if not streams:
            return False
        for stream in streams:
            try:
                if stream.is_active():
                    return True
            except Exception:
                return True
        return False

    def _watch(self):
        """Rebuild the capture whenever it stops matching the machine, or stops working."""
        while not self._stop_evt.wait(self.WATCH_SECONDS):
            self._watch_once()

    def _watch_once(self) -> bool:
        """
        One pass of the watcher. Returns whether a rebuild was attempted.

        Two reasons to rebuild, and the second matters as much as the first.
        The devices changing is the one this class was written for. But WASAPI
        raises nothing when it invalidates a stream that was already running —
        the callbacks simply stop — and a capture whose streams have all died
        looks, from every angle the app can see, exactly like a quiet room.
        Nothing noticed that, which is how a live call spent its length
        listening to a capture that had been dead since the first minute.
        """
        latest = self._fingerprint()
        # `_known` is deliberately *not* recorded here. `_build` records it, and
        # only once it has succeeded. Writing it first meant a rebuild that
        # failed still counted as having caught up, so the next pass saw no
        # change — and because the old streams are open and still answer
        # `is_active()`, a capture that had lost its device looked alive. One
        # warning, then nothing tried again for the rest of the call. Leaving it
        # alone means every pass keeps trying, and the moment the device will
        # open the capture comes back on its own.
        moved = bool(latest) and latest != self._known
        if not moved and self._running():
            return False

        old_pa, old_streams = self._pa, self._streams
        try:
            self._build()
        except Exception as e:
            # Keep whatever was working. A failed rebuild leaves the object
            # untouched, so the old streams are still the live ones — but
            # they are recording a device the sound has just left, so say so
            # rather than serving convincing silence.
            # No exception text here: the Sound panel prints this sentence as it
            # is, and "[PaErrorCode -9996]" under "Not hearing the call" tells
            # the user nothing. It goes to the log instead, one line down.
            stale = (
                f"The audio moved to a device we cannot record "
                f"({', '.join(latest) or 'unknown'})."
            )
            # Every pass retries now, so say it once per distinct failure rather
            # than once every three seconds for the length of the call. Keyed on
            # the exception, not on `stale`, so a *different* failure on the same
            # devices still reaches the log.
            if str(e) != self._last_failure:
                print(f"  [system audio: rebuild failed — {e}]", file=sys.stderr, flush=True)
                self._last_failure = str(e)
            self.stale = stale
            return True
        _discard(old_pa, old_streams)
        # A rebuild used to leave no trace at all: the log showed the device
        # list once, at the start, and every swap after that was invisible —
        # which is most of why this took an evening to find.
        print(f"  [system audio: now {', '.join(self.device_names)}]", flush=True)
        for problem in self.errors:
            print(f"  [system audio device not opened — {problem}]", flush=True)
        return True

    def _open_device(self, pa, state, dev: dict, start: bool = False):
        pyaudio = self._pyaudio
        idx = len(state.buffers)
        generation = state.generation
        rate = int(dev["defaultSampleRate"])
        channels = max(1, int(dev["maxInputChannels"]))
        step = rate / SAMPLE_RATE

        def _cb(in_data, frame_count, time_info, status):
            x = np.frombuffer(in_data, dtype=np.float32).reshape(-1, channels).mean(axis=1)
            if rate != SAMPLE_RATE and len(x):
                n_out = int(len(x) / step)
                x = np.interp(np.arange(n_out) * step, np.arange(len(x)), x).astype(np.float32)
            with self._lock:
                # A stream we have already replaced may still deliver a block or
                # two. Its slot belongs to a different device now, so drop it.
                if generation != self._generation or idx >= len(self._buffers):
                    return (None, pyaudio.paContinue)
                buf = np.concatenate((self._buffers[idx], x))
                self._buffers[idx] = buf[-self.MAX_BUFFERED:]
            return (None, pyaudio.paContinue)

        state.buffers.append(np.zeros(0, dtype=np.float32))
        state.primed.append(False)
        try:
            stream = pa.open(
                format=pyaudio.paFloat32, channels=channels, rate=rate,
                input=True, input_device_index=dev["index"],
                frames_per_buffer=rate * BLOCK_MS // 1000,
                stream_callback=_cb, start=False,
            )
            # Starting belongs in here, under the same unwind as opening: a
            # device that will not run has to leave no slot behind, or the
            # indices its neighbours' callbacks hold stop meaning what they say.
            # Blocks delivered between here and the publish carry the new
            # generation while the old one is still live, so they are dropped —
            # which is exactly what the generation counter is for.
            if start:
                try:
                    stream.start_stream()
                except Exception as e:
                    try:
                        stream.close()
                    except Exception:
                        pass
                    raise RuntimeError(f"opened but would not start ({e})") from e
        except Exception:
            state.buffers.pop()
            state.primed.pop()
            raise
        state.streams.append(stream)

    def _start_streams(self) -> None:
        """
        Start the streams `_build` opened, dropping any that will not run.

        A stream that opened and then refuses to start delivers nothing, for
        ever, and raises nothing anyone sees. Counting it as a working device
        is how a capture ends up listed as healthy and deaf, so it is dropped
        and said out loud instead — the same treatment as a device that would
        not open at all.

        The buffer slots are deliberately left alone. Each stream's callback
        holds the index of its own slot, so compacting them would send a live
        device's audio into another device's place. A dropped device's slot
        simply stays empty and mixes in as the silence it is.
        """
        live, kept, lost = [], [], []
        for stream, name in zip(self._streams, self.device_names):
            try:
                stream.start_stream()
            except Exception as e:
                lost.append(f"{name}: opened but would not start ({e})")
                try:
                    stream.close()
                except Exception:
                    pass
                continue
            live.append(stream)
            kept.append(name)
        with self._lock:
            self._streams, self.device_names = live, kept
            self.errors = list(self.errors) + lost
        if not live:
            detail = "; ".join(lost) if lost else "no output devices found"
            raise RuntimeError(f"no WASAPI loopback device would start ({detail})")

    def start(self):
        self._started = True
        self._start_streams()
        self._thread.start()
        self._watcher.start()

    def _pace(self):
        period = BLOCK_SIZE / SAMPLE_RATE
        next_t = time.monotonic()
        while not self._stop_evt.is_set():
            next_t += period
            delay = next_t - time.monotonic()
            if delay > 0:
                if self._stop_evt.wait(delay):
                    break
            elif delay < -1.0:
                next_t = time.monotonic()  # resumed from sleep; don't burst
            block = np.zeros(BLOCK_SIZE, dtype=np.float32)
            with self._lock:
                for i, buf in enumerate(self._buffers):
                    if not self._primed[i]:
                        if len(buf) < self.PRIME_SAMPLES:
                            continue
                        self._primed[i] = True
                    n = min(len(buf), BLOCK_SIZE)
                    block[:n] += buf[:n]
                    self._buffers[i] = buf[n:]
                    if n < BLOCK_SIZE:
                        self._primed[i] = False  # underrun: device went idle
            np.clip(block, -1.0, 1.0, out=block)
            try:
                self._callback(block.reshape(-1, 1), BLOCK_SIZE, None, None)
            except Exception:
                pass

    def stop(self):
        self._stop_evt.set()
        for thread in (self._thread, self._watcher):
            if thread.is_alive():
                thread.join(timeout=1 + self.WATCH_SECONDS)
        for stream in self._streams:
            try:
                stream.stop_stream()
            except Exception:
                pass

    def close(self):
        for stream in self._streams:
            try:
                stream.close()
            except Exception:
                pass
        self._streams = []
        if self._pa is not None:
            try:
                self._pa.terminate()
            except Exception:
                pass
            self._pa = None


def _open_system_capture(callback, only: "str | None" = None):
    """
    Start capturing what the computer is playing, feeding 16 kHz mono float32
    blocks to callback(indata, frames, time, status). Returns (capture, FriendlyError).
    """
    if IS_LINUX:
        cmd, err = _linux_system_capture_cmd()
        if err:
            return None, err
        try:
            capture = _SubprocessCapture(cmd, callback)
        except Exception as e:
            print(f"  [system audio: could not start the recorder — {e}]", file=sys.stderr, flush=True)
            return None, system_lost(e)
    elif IS_WINDOWS:
        try:
            capture = _WindowsLoopbackCapture(callback, only=only)
        except Exception as e:
            # PortAudio’s text is worth keeping, and worth keeping *here*: the
            # log gets the error code, the user gets a sentence.
            print(f"  [system audio: could not open — {e}]", file=sys.stderr, flush=True)
            return None, system_lost(e)
    else:
        return None, audio_unsupported(
            "Recording what’s playing isn’t supported on this operating system yet.")
    try:
        capture.start()
    except Exception as e:
        try:
            capture.stop()
            capture.close()
        except Exception:
            pass
        print(f"  [system audio: would not start — {e}]", file=sys.stderr, flush=True)
        return None, system_lost(e)

    # What we ended up listening to. A capture that opened the wrong device
    # sounds exactly like one that opened nothing, so say it out loud.
    names = getattr(capture, "device_names", None) or []
    failed = getattr(capture, "errors", None) or []
    if names:
        print(f"  [system audio: {', '.join(names)}]", flush=True)
    for problem in failed:
        print(f"  [system audio device not opened — {problem}]", flush=True)
    return capture, None


async def _report_capture(ws: WebSocket, stream, source: str = "system") -> None:
    """
    Tell the client which devices a source is actually being captured from.

    Sent from both the streaming and the batch paths. It lived on only one of
    them at first, which meant the toolbar said nothing during a live session —
    exactly when knowing the device matters, because a capture on the wrong
    device sounds identical to a capture on nothing.

    It reported only system audio at first, for the same reason: a microphone
    had nothing to report, because "Automatic" was `device=None` and whatever
    PortAudio did with that was between PortAudio and the OS. Now that an
    unchosen microphone resolves to a particular device (`_default_microphone`),
    it has something to say, and not saying it would make the resolution
    invisible — which is the failure mode this whole line exists to prevent.
    """
    try:
        await ws.send_json({
            "type": "capture",
            "source": source,
            "devices": getattr(stream, "device_names", []) or [],
            "stale": getattr(stream, "stale", None),
            "skipped": getattr(stream, "errors", []) or [],
        })
    except Exception:
        pass


def _microphone_host_api() -> int:
    """
    The host API whose microphones this app uses.

    WASAPI on Windows, the system default everywhere else. One function,
    because the two places that need this answer — the picker in `list_devices`
    and an unchosen microphone in `_open_microphone` — disagreeing *is* the bug:
    the picker offered WASAPI devices while "Automatic" opened whatever
    PortAudio's own default host API handed over, so the row with the tick on
    it and the device actually recording were two different devices.
    """
    if IS_WINDOWS:
        for i, api in enumerate(sd.query_hostapis()):
            if "wasapi" in (api.get("name") or "").lower():
                return i
    return sd.default.hostapi


def _default_microphone() -> Optional[int]:
    """
    Which device an unchosen microphone should open, or None for PortAudio's.

    None off Windows, where PortAudio's default host API *is* the one the OS
    means by "the default microphone" — CoreAudio on macOS, ALSA or Pulse on
    Linux — and `device=None` is already the right answer. Nothing below this
    line runs there.

    On Windows it is not. PortAudio defaults to MME, a compatibility layer over
    whatever the driver chooses to expose through it, while the picker lists
    WASAPI, where a laptop's microphone array appears as the OS itself
    describes it. So "Automatic" is resolved here to the WASAPI default input:
    the same device the picker ticks, opened the same way the picker's own rows
    are opened.

    Returns None rather than raising if any of that is unavailable. A machine
    with no WASAPI input still has PortAudio's default, and a microphone that
    opens is worth more than one that is provably the right one.
    """
    if not IS_WINDOWS:
        return None
    try:
        api = sd.query_hostapis(_microphone_host_api())
        index = int(api.get("default_input_device", -1))
        return index if index >= 0 else None
    except Exception:
        return None


#: Separates a microphone name from the index that disambiguates it, for the
#: uncommon case of two inputs with the same name on one host API. Chosen because
#: no device name observed on this machine contains it.
DEVICE_ID_SEP = "#"


def _microphone_index(chosen: str):
    """
    The device index for a microphone the picker offered, by its exact name.

    The picker’s ids are names, and only one host API is listed, so an exact
    match over that host API’s inputs repeats the lookup the picker itself did.
    A trailing ``#<index>`` is honoured when the name at that index agrees, which
    is how two identically named microphones stay apart.

    Returns ``chosen`` unchanged when nothing matches, so sounddevice still gets
    its usual chance to resolve it or to complain: a microphone that opens is
    worth more than one that is provably the right one.
    """
    try:
        name, _, tail = chosen.rpartition(DEVICE_ID_SEP)
        if name and tail.isdigit():
            at = int(tail)
            if (sd.query_devices(at).get("name") or "").strip() == name.strip():
                return at
        wanted = _microphone_host_api()
        for i, d in enumerate(sd.query_devices()):
            if int(d.get("max_input_channels") or 0) <= 0:
                continue
            if d.get("hostapi") != wanted:
                continue
            if (d.get("name") or "").strip() == chosen.strip():
                return i
    except Exception:
        pass
    return chosen


def _microphone_name(device) -> Optional[str]:
    """What PortAudio calls a device, for saying which one was opened."""
    try:
        info = sd.query_devices(device if device is not None else None, "input")
        return (info.get("name") or "").strip() or None
    except Exception:
        return None


def _open_microphone(chosen: Optional[str], callback) -> "sd.InputStream":
    """
    Open a microphone — the chosen one, or the system default — and start it.

    Shared by the streaming and the batch paths. It lived in `_open_stream_for`
    alone, so the batch path opened the default microphone whatever the picker
    said, and a chosen WASAPI mic failed there with "Invalid sample rate" long
    after the streaming path had learned not to. One device is one job; two
    copies of the job is two behaviours, and only one of them ever gets fixed.

    The stream carries `device_names`, the same attribute system audio carries,
    so whoever opened it can say which microphone that turned out to be.
    "Automatic" is a resolution now rather than a shrug, and a resolution
    nobody can see is indistinguishable from the wrong device.

    Raises whatever PortAudio raises — the caller is the one that can say it
    out loud, to the right socket.
    """
    # mic → clear any prior PULSE_SOURCE so default input is used
    prev_pulse_source = os.environ.get("PULSE_SOURCE")
    if IS_LINUX:
        os.environ.pop("PULSE_SOURCE", None)
    try:
        # Everything that turns an answer into a device index, and the open
        # that spends it, under the lock the device picker takes before it
        # restarts PortAudio. An index resolved on one side of that restart
        # names a different device on the other. Only `start()` is left
        # outside: by then the stream is constructed and registered, so the
        # picker can see it and will leave PortAudio alone.
        with _SD_LOCK:
            extra = None
            if chosen is not None:
                try:
                    mic = int(chosen)     # an app from before the change
                except (TypeError, ValueError):
                    # Resolved here, by exact name, over the one host API the
                    # picker lists. Handing the string to sounddevice instead
                    # would use its substring matching, which opens the wrong
                    # device when one name contains another and raises outright
                    # when two of them match.
                    mic = _microphone_index(chosen)
            else:
                # `device=None` is sounddevice's "use the system default", and
                # off Windows that is exactly right — `_default_microphone`
                # returns None there, so Linux and macOS open what they always
                # opened.
                mic = _default_microphone()

            # The picker lists WASAPI devices, and WASAPI in shared mode only
            # accepts a device's native rate — usually 48 kHz — so opening one
            # at our 16 kHz fails outright with "Invalid sample rate".
            # `auto_convert` asks Windows to resample, so everything past this
            # line still sees 16 kHz. This ran only for a chosen device before,
            # because an unchosen one went to MME, which resamples on its own.
            # Now that "Automatic" resolves to WASAPI as well it has to run for
            # both, or the fix above would stop Automatic opening at all.
            if mic is not None:
                try:
                    api = sd.query_hostapis(sd.query_devices(mic)["hostapi"])["name"]
                    if "wasapi" in api.lower():
                        extra = sd.WasapiSettings(auto_convert=True)
                except Exception:
                    extra = None      # unknown device: let PortAudio report it

            stream = _open_sd_stream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                     blocksize=BLOCK_SIZE, callback=callback, device=mic,
                                     extra_settings=extra)
            name = _microphone_name(mic)

        stream.start()
        stream.device_names = [name] if name else []
        return stream
    finally:
        # Restore PULSE_SOURCE after binding (Linux only)
        if IS_LINUX:
            if prev_pulse_source is None:
                os.environ.pop("PULSE_SOURCE", None)
            else:
                os.environ["PULSE_SOURCE"] = prev_pulse_source


def _open_stream_for(source: str, loop: asyncio.AbstractEventLoop,
                     out_queue: asyncio.Queue,
                     activity_queue: Optional[asyncio.Queue] = None,
                     devices: Optional[dict] = None) -> tuple[sd.InputStream, Optional[str]]:
    """
    Open a per-platform capture for a source:
      source="mic"    → default microphone (native to each OS)
      source="system" → what the computer is playing
                        - Linux: pw-record/parec on the default sink's monitor
                        - Windows: WASAPI loopback of every output device
                        - macOS: not supported (needs BlackHole or similar)
    Brings each block up to a level speech-to-text can hear (core/gain.py) and
    reports who is speaking, for the pulse in the app.
    """
    state = {"active": False, "last_active": 0.0, "peak": 0.0, "last_block": 0.0}
    #: This source's own level: a microphone and a call arrive nothing alike.
    agc = AutoGain()

    def _cb(indata, frames, t, status):
        raw = indata[:, 0]
        # The peak as it arrived, before any gain: this is what tells us the OS
        # handed us a dead device, and a boosted silence is still silence.
        state["peak"] = max(state["peak"], float(np.abs(raw).max()))
        # Written straight from the audio thread, deliberately not through the
        # event loop: a loop that is busy must not look like a microphone that
        # has stopped.
        state["last_block"] = time.monotonic()
        mono = agc.push(raw)
        pcm16 = (np.clip(mono, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
        loop.call_soon_threadsafe(out_queue.put_nowait, pcm16)
        if activity_queue is not None:
            now = time.time()
            if agc.speaking:
                state["last_active"] = now
                if not state["active"]:
                    state["active"] = True
                    loop.call_soon_threadsafe(activity_queue.put_nowait, True)
            elif state["active"] and (now - state["last_active"]) > ACTIVITY_HANGOVER_SEC:
                state["active"] = False
                loop.call_soon_threadsafe(activity_queue.put_nowait, False)

    chosen = (devices or {}).get(source) or None

    if source == "system":
        stream, err = _open_system_capture(_cb, only=chosen)
        if err:
            return None, err  # type: ignore
        stream.levels = state  # type: ignore[attr-defined]
        stream.gain = agc      # type: ignore[attr-defined]
        return stream, None

    try:
        stream = _open_microphone(chosen, _cb)
    except Exception as e:
        print(f"  [microphone: could not open — {e}]", file=sys.stderr, flush=True)
        return None, mic_lost(e)  # type: ignore

    stream.levels = state  # type: ignore[attr-defined]
    stream.gain = agc      # type: ignore[attr-defined]
    return stream, None


# Source → speaker semantics (natural mapping for Zoom/Teams calls)
# mic     = your voice going INTO the PC via microphone → YOU (interviewee)
# system  = other person's voice coming OUT of your speakers → INTERVIEWER
SPEAKER_MAP = {"mic": "user", "system": "interviewer"}

# Every sounddevice stream this process opens. PortAudio reads the machine's
# devices once, when it starts, so a headset plugged in later never appears in
# the picker (and one unplugged never leaves) until PortAudio is restarted.
#
# Restarting it is not a local act. `sd._terminate()` is `Pa_Terminate`, which
# closes **every** open PortAudio stream in the process — not only the one the
# caller had in mind. So the device list restarts it only when nothing at all
# is open, and this set is how that is known.
#
# Which makes `_open_sd_stream` the one door a sounddevice stream may be opened
# through, playback included: a stream opened around it is invisible here and
# will be closed mid-sentence by someone else opening the device picker. That
# is not hypothetical — it is what happened to the first harness written to
# measure this bug, whose tone player was an `sd.OutputStream` and went quiet
# the moment the test called `list_devices()`.
_SD_STREAMS: "weakref.WeakSet" = weakref.WeakSet()
#: Reentrant so that a caller which has to resolve a device index and then open
#: it can hold this across both. A PortAudio device index means nothing across
#: a restart of PortAudio, and `_refresh_microphones` — which any
#: `GET /audio/devices` can reach — is exactly that restart. It skips while
#: anything is open, but between resolving an index and constructing the stream
#: nothing is open yet, so that window is real and this is how it is closed.
_SD_LOCK = threading.RLock()


def _open_sd_stream(stream_class=None, **kwargs):
    """
    Open a sounddevice stream and remember it. The only door — see `_SD_STREAMS`.

    `stream_class` defaults to `sd.InputStream` because recording is all this
    has ever opened; it is a parameter so that playback goes through here too,
    rather than being the thing that discovers the hard way that the device
    picker restarts PortAudio underneath it.
    """
    with _SD_LOCK:
        stream = (stream_class or sd.InputStream)(**kwargs)
        _SD_STREAMS.add(stream)
    return stream


def _stream_is_open(stream) -> bool:
    """
    Whether a registered stream is still open.

    Conservative on purpose: a stream that cannot answer counts as open. The
    two wrong answers are not the same size — a needless skipped refresh means
    the picker is a few seconds stale, while a wrong "closed" cuts off a live
    recording, and it would do it from inside a `GET /audio/devices`.
    """
    try:
        return not stream.closed
    except Exception:
        return True


def _refresh_microphones() -> bool:
    """
    Re-read the microphones, unless anything is recording or playing.

    True when the list was actually re-read.
    """
    with _SD_LOCK:
        if any(_stream_is_open(s) for s in list(_SD_STREAMS)):
            return False
        try:
            sd._terminate()
        except Exception as e:
            print(f"audio: could not refresh microphones: {e}", file=sys.stderr)
            return False
        try:
            sd._initialize()
        except Exception as e:
            # Without PortAudio no microphone opens at all: say so loudly.
            print(f"audio: PortAudio did not restart: {e}", file=sys.stderr)
            return False
        return True


def list_devices() -> dict:
    """
    What the app can listen to, for the pickers in the session toolbar.

    Two different questions, because they are answered by different parts of
    the operating system:

    * **inputs** are microphones, enumerated by PortAudio. Identified by
      *name*, for the same reason outputs are: an index is a position in a list
      that is re-read whenever PortAudio restarts, so pairing a headset
      renumbers it and a remembered index quietly starts meaning a *different*
      microphone. Only one host API is listed (below), which is what makes the
      names usable as ids; a name that does repeat within it gets its index
      appended so both rows stay separately choosable.
    * **outputs** are what the machine is playing, and only Windows can be
      asked to record them per-device. They are identified by *name*, because
      a WASAPI loopback endpoint's index moves when devices come and go, and a
      Bluetooth headset does that constantly.

    An empty `outputs` means "this platform captures whatever is playing and
    cannot be told which" — true on Linux, where it is the default sink's
    monitor, and on macOS, where it needs a virtual device.
    """
    inputs: list[dict] = []
    _refresh_microphones()
    try:
        # PortAudio lists every device once per host API, so a single headset
        # appears three times — and not even under the same name, because MME
        # truncates to 31 characters and WDM-KS reports raw driver strings like
        # "Input (@System32\drivers\btha2dp.sys,#1;...)". Deduplicating by name
        # cannot work on that.
        #
        # So one host API is chosen and only its devices are listed: WASAPI on
        # Windows, which gives full names and is what the loopback capture uses
        # anyway; the system default elsewhere.
        wanted = _microphone_host_api()
        default_in = sd.query_hostapis(wanted).get("default_input_device", -1)

        for i, d in enumerate(sd.query_devices()):
            if int(d.get("max_input_channels") or 0) <= 0:
                continue
            if d.get("hostapi") != wanted:
                continue
            label = (d.get("name") or f"Input {i}").strip()
            # The name is the id, exactly as an output's is. An index survives a
            # renumbering — it just means somebody else's device afterwards — so
            # the stale-choice guard in the app can never catch it, and a
            # remembered microphone silently becomes the wrong one. A name that
            # has gone is gone, and falls back to Automatic.
            #
            # Two inputs can share a name on one host API (two identical USB
            # microphones, a dock exposing one twice). The first keeps the bare
            # name, so a choice remembered before this cannot be broken by a
            # second one appearing; later ones carry their index.
            taken = {row["id"] for row in inputs}
            inputs.append({
                "id": label if label not in taken else f"{label}{DEVICE_ID_SEP}{i}",
                "label": label,
                "default": i == default_in,
            })
    except Exception as e:
        print(f"audio: could not list input devices: {e}", file=sys.stderr)

    outputs: list[dict] = []
    if IS_WINDOWS:
        pa = None
        try:
            import pyaudiowpatch as pyaudio
            pa = pyaudio.PyAudio()
            for d in pa.get_loopback_device_info_generator():
                name = d["name"]
                outputs.append({
                    # The name is the id: see the docstring on why not the index.
                    "id": name,
                    # "[Loopback]" is an implementation detail of how we record
                    # it, not something to show someone choosing a headset.
                    "label": name.replace(" [Loopback]", ""),
                    "default": False,
                })
        except Exception as e:
            print(f"audio: could not list output devices: {e}", file=sys.stderr)
        finally:
            if pa is not None:
                try:
                    pa.terminate()
                except Exception:
                    pass

    return {
        "inputs": inputs,
        "outputs": outputs,
        # Whether "all outputs at once" is available, which is the default and
        # the reason this works with no configuration at all.
        "can_mix_outputs": IS_WINDOWS,
    }


# ── Endpoint ─────────────────────────────────────────────────────────────────

@router.get("/devices")
def get_devices():
    """Microphones, and the outputs that can be listened to, for the pickers."""
    return list_devices()


@router.websocket("/stream")
async def audio_stream(ws: WebSocket):
    await ws.accept()
    loop = asyncio.get_event_loop()

    try:
        init = await asyncio.wait_for(ws.receive_json(), timeout=10)

        # The live companion is the one paid feature on the audio path. The free
        # tier includes two live sessions, counted by session id: reconnecting
        # after a dropped call, resuming from pause and switching between the
        # microphone and system audio all belong to a session that has already
        # spent its grant, so none of them costs a second one.
        allowed, reason = entitlements.claim_live_session(init.get("session_id"))
        if not allowed:
            await ws.send_json({"type": "error", "error": "pro_required",
                                "feature": "live", "message": reason})
            await ws.close()
            return

        mode = init.get("mode", "push-to-talk")
        if "sources" in init and init["sources"]:
            sources = [s for s in init["sources"] if s in ("mic", "system")]
        else:
            legacy_speaker = init.get("speaker", "user")
            sources = ["mic"] if legacy_speaker == "user" else ["system"]
        sources = list(dict.fromkeys(sources))

        # Which microphone, and which output to listen to. Absent or empty
        # means "let the machine decide", which is the default and the reason
        # this works with nothing configured: the mic is the system default and
        # every output is mixed, so a call is heard wherever it plays.
        raw = init.get("devices") if isinstance(init.get("devices"), dict) else {}
        devices = {k: (str(v) if v not in (None, "") else None)
                   for k, v in raw.items() if k in ("mic", "system")}
        # STT provider: deepgram = streaming; local/groq/openai = batch (silence-gated).
        # A live meeting keeps whatever the user chose as long as it can stream —
        # interim words are the feature people are paying for. Rehearsal falls
        # through to the cheapest provider available. See core/stt_routing.py.
        #
        # What makes this live is the mode, not whether the session has been
        # saved yet. Reading it from `session_id` made every call that started
        # before its first answer — which is every call, since the session is
        # only written when the coach first replies — buy the rehearsal
        # provider: no interim words while the user spoke, and Whisper's
        # inventions in the silences between sentences.
        stt_provider, stt_model, route_reason = stt_routing.route(
            stt_task(mode),
            init.get("stt_provider", "deepgram"),
            init.get("stt_model"),
        )
        # The session's language (roadmap 3.3), as each provider spells it.
        language     = init.get("language")

        await ws.send_json({"type": "ready"})
        # Say who is transcribing and whether it can keep up with the speaking.
        # A provider that only transcribes after a pause is a different product
        # from one that writes as you speak, and the app silently looking broken
        # is what this costs when it is not said out loud.
        await ws.send_json({
            "type": "stt",
            "provider": stt_provider,
            "model": stt_model,
            "streaming": stt_provider in stt_routing.STREAMING,
            # What was asked for, not yet what answered: for an ordinary
            # account the relay picks the transcriber on the server. A second
            # one of these follows, confirmed, once it names itself.
            "confirmed": False,
            "why": route_reason,
        })

        # Speech-to-text is billed by the minute and is the largest single cost
        # in a live session, so the whole listening period is timed — a
        # streaming provider charges for the connection, not for the speech in
        # it. Recorded in the finally below so a dropped call still counts.
        listening_since = time.monotonic()
        try:
            if mode == "push-to-talk":
                await _push_to_talk_loop(ws, loop, sources, stt_provider, stt_model, language, devices)
            else:
                # Captions in another language than the call (docs/translation.md, T2): billed with the session.
                from ..caption_translate import CaptionTranslator
                translator = CaptionTranslator.for_call(ws.send_json, language, init.get("display_language"),
                                                        init.get("session_id"))
                await _live_loop(ws, loop, sources, stt_provider, stt_model, language, devices, translator)
        finally:
            costs.record("stt", stt_provider, stt_model or "default",
                         seconds=time.monotonic() - listening_since,
                         session_id=init.get("session_id"))

    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    except Exception as e:
        try:
            service = locals().get("stt_provider") or "deepgram"
            await ws.send_json({"type": "error", **classify(e, service).as_dict()})
        except Exception:
            pass


#: How often the app is told how loud a source is. Eight times a second is
#: below what anyone reads as lag and far below what a meter needs to look
#: alive; every block (twenty a second) would be noise on the wire.
LEVEL_EVERY = 0.12


async def _pump_levels(ws: WebSocket, source: str, speaker: str, agc,
                       stop_evt: asyncio.Event, every: float = LEVEL_EVERY) -> None:
    """
    Tell the app how loud this source is, so it can show a meter.

    Sent while nobody is speaking too: the question a meter answers is "is it
    hearing me at all?", and silence is most of when that gets asked. Repeats
    are dropped, so a dead microphone costs one message and then nothing.
    """
    last = None
    try:
        while not stop_evt.is_set():
            await asyncio.sleep(every)
            # Six places, not four: a microphone delivering -90 dBFS is very
            # quiet, not broken, and rounding it to zero told the app it was
            # dead. The difference matters — one needs a louder voice, the
            # other needs a different device.
            now = (round(float(agc.level), 6), bool(agc.speaking), round(float(agc.gain), 1))
            if now == last:
                continue
            last = now
            await ws.send_json({
                "type": "level", "source": source, "speaker": speaker,
                "level": now[0], "speaking": now[1], "gain": now[2],
            })
    except Exception:
        return                      # the socket went: the meter goes with it


async def _report_speech_ended(ws: WebSocket, transcript_task: asyncio.Task) -> None:
    """Tell the app why transcription stopped before the user pressed Stop."""
    exc = transcript_task.exception() if not transcript_task.cancelled() else None
    if exc is None:
        err = FriendlyError(
            "speech_stopped", "Speech recognition stopped",
            "The connection to speech recognition closed. Start listening again to carry on.",
        )
    else:
        err = classify(exc, "deepgram")
    try:
        await ws.send_json({"type": "error", **err.as_dict()})
    except Exception:
        pass                    # the app has gone too


async def _run_one_source(ws: WebSocket, loop: asyncio.AbstractEventLoop,
                          source: str, stop_evt: asyncio.Event,
                          emit_speech_final: bool, language: Optional[str] = None,
                          devices: Optional[dict] = None, translator=None) -> str:
    """
    Own one source end-to-end: open audio stream, pipe to Deepgram, forward
    partials + finals to the client with speaker=SPEAKER_MAP[source].
    Returns the accumulated final transcript when stop_evt is set.
    """
    speaker = SPEAKER_MAP.get(source, "user")
    audio_queue: asyncio.Queue = asyncio.Queue()
    activity_queue: asyncio.Queue = asyncio.Queue()
    final_parts: list[str] = []

    async with DeepgramSession(language=languages.stt_code(language, "deepgram"), translate=translator is not None) as dg:
        async with _STREAM_INIT_LOCK:
            stream, err = _open_stream_for(source, loop, audio_queue, activity_queue, devices)
        if err:
            await ws.send_json({"type": "error", **err.as_dict()})
            return ""
        await _report_capture(ws, stream, source)

        async def pump_audio():
            try:
                while not stop_evt.is_set():
                    try:
                        pcm = await asyncio.wait_for(audio_queue.get(), timeout=0.1)
                        await dg.send_audio(pcm)
                    except asyncio.TimeoutError:
                        continue
            finally:
                await dg.finish()

        async def pump_activity():
            try:
                while not stop_evt.is_set():
                    try:
                        active = await asyncio.wait_for(activity_queue.get(), timeout=0.2)
                    except asyncio.TimeoutError:
                        continue
                    try:
                        await ws.send_json({
                            "type": "activity",
                            "source": source,
                            "speaker": speaker,
                            "active": bool(active),
                        })
                    except Exception:
                        return
            except Exception:
                return

        segment_parts: list[str] = []

        async def flush_segment():
            if not segment_parts:
                return
            utterance = " ".join(segment_parts).strip()
            segment_parts.clear()
            final_parts.append(utterance)
            if emit_speech_final:
                await ws.send_json({"type": "transcript", "text": utterance, "speaker": speaker})
                if translator:
                    translator.add(utterance, speaker)

        told_model = ""

        async def pump_transcripts():
            nonlocal told_model
            async for msg in dg.transcripts():
                # The transcriber names itself in its own frames. Through our
                # relay that name is the server's choice, so this is the only
                # place the app can learn it rather than assume it.
                if dg.model and dg.model != told_model:
                    told_model = dg.model
                    await ws.send_json({"type": "stt", "provider": "deepgram", "model": dg.model,
                                        "streaming": True, "confirmed": True,
                                        "why": "the transcriber named itself"})
                text = msg["text"]
                if msg["is_final"] and text:
                    segment_parts.append(text)
                    await ws.send_json({
                        "type": "partial",
                        "text": " ".join(segment_parts),
                        "is_final": True,
                        "speaker": speaker,
                    })
                elif text:
                    display = (" ".join(segment_parts) + " " + text).strip()
                    await ws.send_json({
                        "type": "partial",
                        "text": display,
                        "is_final": False,
                        "speaker": speaker,
                    })
                if emit_speech_final and (msg["speech_final"] or msg["utterance_end"]):
                    await flush_segment()

        async def follow_capture():
            """
            Re-send the capture line whenever the output device changes.

            Sending it once at the start is not enough: the interesting change
            happens mid-call, when a meeting app opens the microphone and the
            headset moves to a profile we may not be able to record. The
            toolbar has to follow that, not show where the audio was.
            """
            last = None
            while not stop_evt.is_set():
                current = (tuple(getattr(stream, "device_names", []) or []),
                           getattr(stream, "stale", None))
                if last is not None and current != last:
                    await _report_capture(ws, stream, source)
                last = current
                try:
                    await asyncio.wait_for(stop_evt.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

        audio_task = asyncio.create_task(pump_audio())
        transcript_task = asyncio.create_task(pump_transcripts())
        activity_task = asyncio.create_task(pump_activity())
        level_task = asyncio.create_task(_pump_levels(ws, source, speaker, stream.gain, stop_evt))
        silence_task = asyncio.create_task(
            _watch_microphone(ws, source, stream.levels, stream, stop_evt))
        capture_task = (asyncio.create_task(follow_capture())
                        if source == "system" else None)

        stream_closed = False

        def close_stream():
            nonlocal stream_closed
            if stream_closed:
                return
            stream_closed = True
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass

        try:
            # Wait for Stop — or for the transcription stream to end on its own,
            # which is how the relay says "out of credits" (4402), "signed out"
            # or simply "gone". Waiting only for Stop left that news unread in a
            # background task while the screen kept saying "listening" (audit
            # 178-H1). The user is told why, and the whole session stops.
            stop_wait = asyncio.create_task(stop_evt.wait())
            await asyncio.wait({stop_wait, transcript_task}, return_when=asyncio.FIRST_COMPLETED)
            stop_wait.cancel()
            if transcript_task.done() and not stop_evt.is_set():
                await _report_speech_ended(ws, transcript_task)
                stop_evt.set()

            if capture_task:
                capture_task.cancel()
            close_stream()

            await audio_task
            if not transcript_task.done():
                try:
                    await asyncio.wait_for(transcript_task, timeout=2.0)
                except asyncio.TimeoutError:
                    transcript_task.cancel()
                except Exception:
                    pass            # the stream's own error; Stop was already pressed
            activity_task.cancel()
            level_task.cancel()
            silence_task.cancel()
            # Words finalized after the last turn boundary (or all words in
            # push-to-talk) would otherwise be dropped on stop.
            try:
                await flush_segment()
            except Exception:
                pass
        finally:
            # A sibling source failing cancels this one (audit 178-C3), and a
            # cancelled coroutine skips everything above: the OS capture, and
            # the microphone light, stayed on (audit 180-M5).
            for task in (audio_task, transcript_task, activity_task, silence_task, capture_task):
                if task is not None and not task.done():
                    task.cancel()
            close_stream()

    return " ".join(final_parts).strip()


async def _run_one_source_batch(ws: WebSocket, loop: asyncio.AbstractEventLoop,
                                source: str, stop_evt: asyncio.Event,
                                stt_provider: str, stt_model: Optional[str],
                                emit_speech_final: bool, language: Optional[str] = None,
                                devices: Optional[dict] = None, translator=None) -> str:
    """
    Batch-STT path for local/groq/openai. Accumulates float32 audio, gates on
    silence (RMS + hangover). On each utterance end, calls transcribers.transcribe
    off the event loop and forwards {type:"transcript"}. No live partials.
    """
    speaker = SPEAKER_MAP.get(source, "user")
    audio_queue: asyncio.Queue = asyncio.Queue()          # PCM16 bytes (unused here)
    activity_queue: asyncio.Queue = asyncio.Queue()        # bool activity
    chunk_queue: asyncio.Queue = asyncio.Queue()          # (float32 chunk, speaking)
    state = {"active": False, "last_active": 0.0, "peak": 0.0, "last_block": 0.0}
    agc = AutoGain()
    finals: list[str] = []

    def _cb(indata, frames, t, status):
        raw = indata[:, 0]
        state["peak"] = max(state["peak"], float(np.abs(raw).max()))
        # Written straight from the audio thread, deliberately not through the
        # event loop: a loop that is busy must not look like a microphone that
        # has stopped.
        state["last_block"] = time.monotonic()
        # Copied because the driver reuses its buffer, and because at a gain of
        # one the level stage hands the very same block back.
        mono = agc.push(raw).copy()
        speaking = agc.speaking
        loop.call_soon_threadsafe(chunk_queue.put_nowait, (mono, speaking))
        now = time.time()
        if speaking:
            state["last_active"] = now
            if not state["active"]:
                state["active"] = True
                loop.call_soon_threadsafe(activity_queue.put_nowait, True)
        elif state["active"] and (now - state["last_active"]) > ACTIVITY_HANGOVER_SEC:
            state["active"] = False
            loop.call_soon_threadsafe(activity_queue.put_nowait, False)

    # Which microphone, which output. This path used to ignore the picker
    # altogether: choosing an output in the toolbar changed what a Deepgram
    # session recorded and nothing whatsoever about a Whisper one, from the
    # same control, on the same screen.
    chosen = (devices or {}).get(source) or None

    async with _STREAM_INIT_LOCK:
        if source == "system":
            stream, err = _open_system_capture(_cb, only=chosen)
            if err:
                await ws.send_json({"type": "error", **err.as_dict()})
                return ""
            await _report_capture(ws, stream, source)
        else:
            try:
                stream = _open_microphone(chosen, _cb)
            except Exception as e:
                print(f"  [microphone: could not open — {e}]", file=sys.stderr, flush=True)
                await ws.send_json({"type": "error", **mic_lost(e).as_dict()})
                return ""
            await _report_capture(ws, stream, source)

    async def pump_activity():
        try:
            while not stop_evt.is_set():
                try:
                    active = await asyncio.wait_for(activity_queue.get(), timeout=0.2)
                except asyncio.TimeoutError:
                    continue
                try:
                    await ws.send_json({
                        "type": "activity", "source": source,
                        "speaker": speaker, "active": bool(active),
                    })
                except Exception:
                    return
        except Exception:
            return

    async def pump_batch():
        stt_error_sent = False
        # Whether a block is speech is decided against the room's own noise,
        # not a fixed number (core/gain.py); where the sentence it belongs to
        # starts and ends is core/endpointing.py.
        utterance = Utterance(sample_rate=SAMPLE_RATE)
        try:
            while not stop_evt.is_set():
                try:
                    chunk, speaking = await asyncio.wait_for(chunk_queue.get(), timeout=0.2)
                except asyncio.TimeoutError:
                    continue
                ended = utterance.push(chunk, speaking)
                if ended is None:
                    continue
                audio, voiced = ended
                # Too little speech to be a sentence: a tap, a breath, a
                # chair. Handing that to Whisper is how "Thank you."
                # ends up in a transcript nobody said it in — and it is
                # a paid call, so don't make it either.
                if voiced < MIN_VOICED_SEC:
                    continue
                try:
                    text = await loop.run_in_executor(
                        None,
                        lambda a=audio: batch_transcribe(
                            a, stt_provider,
                            languages.deepgram_model(stt_model or "small", language) if stt_provider == "deepgram" else (stt_model or "small"),
                            languages.stt_code(language, stt_provider)),
                    )
                except Exception as e:
                    # Report once per stream, not on every utterance.
                    if not stt_error_sent:
                        await ws.send_json({"type": "error", **classify(e, stt_provider).as_dict()})
                        stt_error_sent = True
                    continue
                text = clean_batch_text(text, voiced)
                if text:
                    finals.append(text)
                    if emit_speech_final:
                        await ws.send_json({
                            "type": "transcript", "text": text, "speaker": speaker,
                        })
                        if translator:
                            translator.add(text, speaker)
        except Exception:
            return

    activity_task = asyncio.create_task(pump_activity())
    level_task = asyncio.create_task(_pump_levels(ws, source, speaker, agc, stop_evt))
    batch_task = asyncio.create_task(pump_batch())
    silence_task = asyncio.create_task(_watch_microphone(ws, source, state, stream, stop_evt))

    await stop_evt.wait()

    try:
        stream.stop(); stream.close()
    except Exception:
        pass

    try:
        await asyncio.wait_for(batch_task, timeout=3.0)
    except asyncio.TimeoutError:
        batch_task.cancel()
    activity_task.cancel()
    level_task.cancel()
    silence_task.cancel()

    return " ".join(finals).strip()


async def _push_to_talk_loop(ws: WebSocket, loop: asyncio.AbstractEventLoop, sources: list[str],
                              stt_provider: str = "deepgram", stt_model: Optional[str] = None,
                              language: Optional[str] = None, devices: Optional[dict] = None):
    """Push-to-talk with one or more sources — hold to record, release to send."""
    if not sources:
        sources = ["mic"]

    while True:
        try:
            msg = await ws.receive_json()
        except Exception:
            return
        action = msg.get("action")
        if action == "stop":
            return
        if action != "start":
            continue

        stop_evt = asyncio.Event()
        await ws.send_json({"type": "recording"})

        # Watch for stop message concurrently
        async def _wait_stop():
            try:
                while True:
                    stop_msg = await ws.receive_json()
                    if stop_msg.get("action") in ("stop_record", "stop"):
                        stop_evt.set()
                        return stop_msg.get("action")
            except Exception:
                stop_evt.set()
                return "stop"

        stop_task = asyncio.create_task(_wait_stop())

        # Pick per-source runner based on STT provider
        def _runner(s: str):
            if stt_provider == "deepgram":
                return _run_one_source(ws, loop, s, stop_evt, emit_speech_final=False,
                                       language=language, devices=devices)
            return _run_one_source_batch(ws, loop, s, stop_evt, stt_provider, stt_model,
                                         emit_speech_final=False, language=language,
                                         devices=devices)
        try:
            results = await _run_sources([_runner(s) for s in sources], stop_evt)
        except BaseException:
            stop_task.cancel()
            raise
        if not stop_task.done():
            # The recording ended without the user letting go: the relay ended
            # it (out of credits, signed out) and the user has been told why.
            # Waiting for the next press would only open another connection
            # to be refused (audit 180-M11).
            stop_task.cancel()
            return
        end_action = await stop_task

        for s, transcript in zip(sources, results):
            if transcript:
                await ws.send_json({
                    "type": "transcript",
                    "text": transcript,
                    "speaker": SPEAKER_MAP.get(s, "user"),
                })

        if not any(results):
            await ws.send_json({"type": "empty"})

        if end_action == "stop":
            return


async def _run_sources(runners, stop_evt: asyncio.Event) -> list:
    """
    Run one coroutine per audio source, and never leave one running alone.

    With a bare ``gather``, a source that failed — the call's socket refused,
    say — raised out of the loop while the other kept streaming to the relay,
    which kept the session's credits reserved and billing after the screen had
    already gone idle (audit 178-C3). So a failure stops every source, and
    none is left behind however the group ends.
    """
    tasks = [asyncio.create_task(r) for r in runners]
    try:
        return await asyncio.gather(*tasks)
    finally:
        stop_evt.set()
        for t in tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _live_loop(ws: WebSocket, loop: asyncio.AbstractEventLoop, sources: list[str],
                      stt_provider: str = "deepgram", stt_model: Optional[str] = None,
                      language: Optional[str] = None, devices: Optional[dict] = None, translator=None):
    """
    Live mode with one or more sources running in parallel.
    Deepgram = streaming with partials; other providers = batch, silence-gated.
    """
    if not sources:
        sources = ["mic"]

    stop_evt = asyncio.Event()

    async def _wait_stop():
        try:
            while True:
                msg = await ws.receive_json()
                if msg.get("action") == "stop":
                    stop_evt.set()
                    return
        except Exception:
            stop_evt.set()

    stop_task = asyncio.create_task(_wait_stop())
    await ws.send_json({"type": "recording"})

    def _runner(s: str):
        if stt_provider == "deepgram":
            return _run_one_source(ws, loop, s, stop_evt, emit_speech_final=True,
                                   language=language, devices=devices, translator=translator)
        return _run_one_source_batch(ws, loop, s, stop_evt, stt_provider, stt_model,
                                     emit_speech_final=True, language=language,
                                     devices=devices, translator=translator)

    try:
        await _run_sources([_runner(s) for s in sources], stop_evt)
    finally:
        stop_task.cancel()
