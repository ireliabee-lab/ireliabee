"""
A microphone that goes away mid-call says so (audit rough edge 4).

System audio had a watcher and the microphone had none. Its only check ran once,
four seconds in, against a running maximum that is never reset — so one non-zero
sample in the first four seconds and nothing could be noticed for the rest of the
session. A headset unplugged mid-interview produced no audio, the speech service
eventually closed the socket for want of any, and the user was told "Speech
recognition stopped", which sent them looking in the wrong place entirely.

The threshold is measured, not chosen: on the owner's laptop a healthy stream
calls back every 47 ms, and the worst gap that could be provoked — every core
deliberately saturated — was 328 ms. MIC_GONE_SEC is fifteen times that.

The false positive is the whole risk here: this is the app he interviews with, and
a wrong "your microphone is gone" mid-answer is worse than the bug. Hence the
one-sided checks below, and the test that a live microphone is left alone.
"""
import asyncio
import time
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.routers import audio  # noqa: E402


class FakeWs:
    def __init__(self):
        self.sent: list = []

    async def send_json(self, payload):
        self.sent.append(payload)


class LiveStream:
    active = True


class DeadStream:
    active = False


class MuteStream:
    """A stream that cannot say — an unfamiliar backend, or one mid-teardown."""

    @property
    def active(self):
        raise RuntimeError("no idea")


class WatchingTest(unittest.TestCase):
    def setUp(self):
        # Wound right in so the test is quick; the ratios are what matter.
        for name, value in (("SILENT_INPUT_CHECK_SEC", 0.01), ("MIC_GONE_SEC", 0.05)):
            patch = mock.patch.object(audio, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def watch(self, levels, stream, source="mic", passes=6):
        ws = FakeWs()

        async def go():
            stop = asyncio.Event()
            task = asyncio.create_task(
                audio._watch_microphone(ws, source, levels, stream, stop))
            await asyncio.sleep(audio.SILENT_INPUT_CHECK_SEC * passes)
            stop.set()
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        asyncio.run(go())
        return ws.sent

    def test_a_microphone_that_stops_delivering_is_reported_as_a_microphone(self):
        sent = self.watch({"peak": 0.5, "last_block": time.monotonic() - 60}, LiveStream())
        self.assertTrue(sent, "a microphone that has gone must be said out loud")
        self.assertEqual(sent[0]["code"], "mic_lost")
        self.assertNotIn("speech", sent[0]["title"].lower(),
                         "it is the microphone, not speech recognition")

    def test_a_microphone_still_delivering_is_left_alone(self):
        # The one that matters most. A person who has stopped talking is
        # indistinguishable from a dead microphone, so only *no blocks* counts.
        levels = {"peak": 0.5, "last_block": time.monotonic()}
        ws = FakeWs()

        async def go():
            stop = asyncio.Event()
            watcher = asyncio.create_task(
                audio._watch_microphone(ws, "mic", levels, LiveStream(), stop))

            async def keep_delivering():
                while not stop.is_set():
                    levels["last_block"] = time.monotonic()
                    await asyncio.sleep(0.005)

            feeder = asyncio.create_task(keep_delivering())
            await asyncio.sleep(audio.SILENT_INPUT_CHECK_SEC * 8)
            stop.set()
            for t in (watcher, feeder):
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass

        asyncio.run(go())
        self.assertEqual(ws.sent, [], "a working microphone must never be declared gone")

    def test_a_stall_has_to_survive_two_checks(self):
        # Coming back from sleep looks exactly like a device that stopped, because
        # monotonic time on Windows counts the sleep. One pass must not be enough.
        #
        # Asked of the rule rather than of the loop. Driving the loop and counting
        # what came out inside a wall-clock window only passed because Windows'
        # coarse timers fitted exactly one pass into it; one more pass and the
        # assertion said the opposite of what it claims, which is what a finer
        # clock gives you.
        stale = {"peak": 0.5, "last_block": 100.0}
        now = 100.0 + audio.MIC_GONE_SEC + 1

        gone, suspect = audio.mic_verdict(stale, stopped=False, suspect=False, now=now)
        self.assertFalse(gone, "one missed check is not a dead microphone")
        self.assertTrue(suspect, "but it is worth another look")

        gone, suspect = audio.mic_verdict(stale, stopped=False, suspect=suspect, now=now)
        self.assertTrue(gone, "twice over, and it really is gone")

    def test_a_stream_that_resumes_is_forgiven(self):
        stale = {"peak": 0.5, "last_block": 100.0}
        now = 100.0 + audio.MIC_GONE_SEC + 1
        _, suspect = audio.mic_verdict(stale, stopped=False, suspect=False, now=now)
        self.assertTrue(suspect)

        # …and then a block arrives.
        fresh = {"peak": 0.5, "last_block": now}
        gone, suspect = audio.mic_verdict(fresh, stopped=False, suspect=suspect, now=now)
        self.assertFalse(gone, "a stream that resumed must not be mourned")
        self.assertFalse(suspect, "and the suspicion is dropped, not carried")

    def test_the_rule_never_reads_anything_into_silence(self):
        # A person who has stopped talking is indistinguishable from a microphone
        # that has died, so a quiet room must never be enough on its own.
        quiet_but_delivering = {"peak": 0.0, "last_block": 500.0}
        for suspect in (False, True):
            gone, _ = audio.mic_verdict(quiet_but_delivering, stopped=False,
                                        suspect=suspect, now=500.0)
            self.assertFalse(gone, "silence alone is not a dead microphone")

    def test_a_microphone_that_never_delivered_is_not_judged_by_the_clock(self):
        # last_block of zero means no block has ever arrived, which the opening
        # check covers; the stall clock must not also fire on it.
        never = {"peak": 0.5, "last_block": 0.0}
        gone, suspect = audio.mic_verdict(never, stopped=False, suspect=True, now=1e9)
        self.assertFalse(gone)
        self.assertFalse(suspect)

    def test_portaudio_saying_the_stream_is_dead_is_enough(self):
        sent = self.watch({"peak": 0.5, "last_block": time.monotonic()}, DeadStream())
        self.assertEqual(sent[0]["code"], "mic_lost")

    def test_a_stream_that_cannot_say_counts_as_running(self):
        self.assertFalse(audio._stream_stopped(MuteStream()))
        sent = self.watch({"peak": 0.5, "last_block": time.monotonic()}, MuteStream())
        self.assertEqual(sent, [])

    def test_the_first_check_still_catches_a_device_that_is_not_a_microphone(self):
        sent = self.watch({"peak": 0.0, "last_block": 0.0}, LiveStream())
        self.assertEqual(sent[0]["code"], "mic_silent")

    def test_it_says_it_once_however_long_the_call_runs(self):
        sent = self.watch({"peak": 0.0, "last_block": 0.0}, LiveStream(), passes=10)
        self.assertEqual(len(sent), 1, "one toast, not one every few seconds")

    def test_system_audio_is_not_watched_here(self):
        # It has its own watcher, and its pacer emits blocks even while idle.
        sent = self.watch({"peak": 0.0, "last_block": 0.0}, LiveStream(), source="system")
        self.assertEqual(sent, [])

    def test_a_microphone_that_never_delivered_anything_is_not_blamed_for_it(self):
        # last_block of 0 means no block has ever arrived, which the first check
        # already covers; the stall clock must not fire on it as well.
        sent = self.watch({"peak": 0.5, "last_block": 0.0}, LiveStream())
        self.assertEqual(sent, [])


if __name__ == "__main__":
    unittest.main()
