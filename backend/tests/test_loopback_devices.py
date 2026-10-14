"""
Windows system-audio capture across a device change.

The bug: PortAudio reads the device list once, when it initialises, and never
looks again. Earbuds plugged in after listening started were invisible — the
call moved to them, we carried on recording a speaker that had gone quiet, and
nothing said so. Bluetooth makes it routine rather than rare, because enabling
a headset's microphone moves Windows to a different output endpoint on its own.

These run everywhere: PyAudioWPatch is faked, so the logic is covered on the
machine that is actually likely to run the tests.
"""
import io
import sys
import types
import unittest
from unittest import mock

import numpy as np

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)


class FakeStream:
    def __init__(self, callback, name=""):
        self.callback = callback
        self.name = name
        self.started = False
        self.closed = False

    def start_stream(self):
        # WASAPI does most of its work at start, not at open: a device can be
        # opened and then refuse to run. `unstartable` is that device.
        if self.name in FakePyAudio.unstartable:
            raise OSError(f"device invalidated: {self.name}")
        self.started = True

    def stop_stream(self):
        self.started = False

    def close(self):
        self.closed = True

    def is_active(self):
        return self.started and not self.closed


class FakePyAudio:
    """One PortAudio instance: it sees the devices present when it was made."""

    instances = []
    devices = ["Speakers"]
    unopenable = set()
    unstartable = set()

    def __init__(self):
        self.snapshot = list(FakePyAudio.devices)   # frozen, like the real thing
        self.streams = []
        self.terminated = False
        FakePyAudio.instances.append(self)

    def get_loopback_device_info_generator(self):
        for i, name in enumerate(self.snapshot):
            yield {"name": name, "index": i, "defaultSampleRate": 16000, "maxInputChannels": 1}

    def open(self, **kwargs):
        name = self.snapshot[kwargs["input_device_index"]]
        if name in FakePyAudio.unopenable:
            raise OSError(f"device busy: {name}")
        stream = FakeStream(kwargs["stream_callback"], name)
        self.streams.append(stream)
        return stream

    def terminate(self):
        self.terminated = True


def fake_module():
    module = types.ModuleType("pyaudiowpatch")
    module.PyAudio = FakePyAudio
    module.paFloat32 = 1
    module.paContinue = 0
    return module


class LoopbackTestCase(unittest.TestCase):
    def setUp(self):
        FakePyAudio.instances = []
        FakePyAudio.devices = ["Speakers"]
        FakePyAudio.unopenable = set()
        FakePyAudio.unstartable = set()
        patch = mock.patch.dict(sys.modules, {"pyaudiowpatch": fake_module()})
        patch.start()
        self.addCleanup(patch.stop)
        from backend.routers import audio
        self.audio = audio

    def capture(self):
        cap = self.audio._WindowsLoopbackCapture(lambda *a, **k: None)
        self.addCleanup(cap.close)
        return cap


class OpeningTest(LoopbackTestCase):
    def test_every_output_device_is_captured_not_just_the_default(self):
        FakePyAudio.devices = ["Speakers", "Earbuds", "Monitor"]
        cap = self.capture()
        self.assertEqual(cap.device_names, ["Speakers", "Earbuds", "Monitor"])

    def test_a_device_that_will_not_open_is_reported_rather_than_swallowed(self):
        # One device failing while another works used to be indistinguishable
        # from everything working.
        FakePyAudio.devices = ["Speakers", "Earbuds"]
        FakePyAudio.unopenable = {"Earbuds"}
        cap = self.capture()
        self.assertEqual(cap.device_names, ["Speakers"])
        self.assertEqual(len(cap.errors), 1)
        self.assertIn("Earbuds", cap.errors[0])

    def test_no_usable_device_is_an_error_not_silence(self):
        FakePyAudio.devices = ["Speakers"]
        FakePyAudio.unopenable = {"Speakers"}
        with self.assertRaises(RuntimeError) as caught:
            self.audio._WindowsLoopbackCapture(lambda *a, **k: None)
        self.assertIn("Speakers", str(caught.exception))


class DeviceChangeTest(LoopbackTestCase):
    def test_a_new_device_is_seen_even_though_portaudio_caches_the_list(self):
        cap = self.capture()
        self.assertEqual(cap.device_names, ["Speakers"])

        FakePyAudio.devices = ["Speakers", "Earbuds"]
        # A fresh instance is the only way to see the change; the live one
        # would answer "Speakers" for ever, which was the whole bug.
        self.assertEqual(cap._fingerprint(), ("Earbuds", "Speakers"))

        cap._build()
        self.assertEqual(cap.device_names, ["Speakers", "Earbuds"])

    def test_rebuilding_starts_the_new_streams_when_already_running(self):
        cap = self.capture()
        cap._started = True
        FakePyAudio.devices = ["Speakers", "Earbuds"]
        cap._build()
        self.assertTrue(all(s.started for s in FakePyAudio.instances[-1].streams))

    def test_a_failed_rebuild_does_not_leave_the_call_without_audio(self):
        cap = self.capture()
        working = cap._streams
        FakePyAudio.devices = ["Earbuds"]
        FakePyAudio.unopenable = {"Earbuds"}
        with self.assertRaises(RuntimeError):
            cap._build()
        # The watcher restores what was working rather than ending up with
        # nothing; here we just assert the old streams were never closed.
        self.assertFalse(any(s.closed for s in working))

    def test_audio_still_flows_after_a_rebuild_that_could_not_open_anything(self):
        # The Zoom bug. A Bluetooth headset moving to the hands-free profile
        # offers a loopback endpoint that will not open; the rebuild failed,
        # and the half-applied state meant every block from the streams that
        # were still working got dropped as stale. Silence, no error, and a
        # device list that still looked right.
        cap = self.capture()
        callback = FakePyAudio.instances[-1].streams[0].callback

        FakePyAudio.devices = ["Headset"]
        FakePyAudio.unopenable = {"Headset"}
        with self.assertRaises(RuntimeError):
            cap._build()

        callback(np.ones(160, dtype=np.float32).tobytes(), 160, None, None)
        with cap._lock:
            self.assertEqual(len(cap._buffers[0]), 160,
                             "the surviving device must keep feeding the call")
        self.assertEqual(cap.device_names, ["Speakers"])

    def test_a_failed_rebuild_releases_the_portaudio_instance_it_opened(self):
        # Every attempt costs a PortAudio instance, and the watcher retries for
        # as long as the device list keeps changing.
        cap = self.capture()
        live = cap._pa
        FakePyAudio.devices = ["Headset"]
        FakePyAudio.unopenable = {"Headset"}
        with self.assertRaises(RuntimeError):
            cap._build()
        self.assertTrue(FakePyAudio.instances[-1].terminated)
        self.assertIs(cap._pa, live, "the live instance must not be touched")

    def test_a_stale_callback_cannot_write_into_a_reused_slot(self):
        FakePyAudio.devices = ["Speakers"]
        cap = self.capture()
        old_callback = FakePyAudio.instances[-1].streams[0].callback

        FakePyAudio.devices = ["Earbuds"]
        cap._build()                      # generation bumped, slots reused

        audio = np.ones(160, dtype=np.float32).tobytes()
        old_callback(audio, 160, None, None)
        with cap._lock:
            self.assertEqual(len(cap._buffers[0]), 0,
                             "a closed stream's block must not land in the new device's slot")

    def test_a_current_callback_still_writes(self):
        cap = self.capture()
        callback = FakePyAudio.instances[-1].streams[0].callback
        callback(np.ones(160, dtype=np.float32).tobytes(), 160, None, None)
        with cap._lock:
            self.assertEqual(len(cap._buffers[0]), 160)


class WillNotStartTest(LoopbackTestCase):
    """
    A device that opens and then will not run.

    WASAPI does most of its work at start, not at open: opening reserves the
    endpoint, starting is what actually begins moving audio. So a headset that
    changes profile — which is exactly what makes the watcher rebuild — fails
    at `start_stream`, not at `open`.

    That failure used to be swallowed. The rebuild counted the device as
    working, published it, discarded the streams that *were* working, and the
    capture went silent for the rest of the call: a healthy device list, no
    error, `stale` cleared, and a level meter reading zero for ever. It is the
    one state the app cannot tell apart from a quiet room.
    """

    def test_a_device_that_will_not_start_is_reported_like_one_that_will_not_open(self):
        FakePyAudio.devices = ["Speakers", "Earbuds"]
        FakePyAudio.unstartable = {"Earbuds"}
        cap = self.capture()
        cap.start()
        self.addCleanup(cap.stop)
        self.assertEqual(cap.device_names, ["Speakers"],
                         "a device that is not running is not being recorded")
        self.assertTrue(any("Earbuds" in e for e in cap.errors), cap.errors)

    def test_nothing_starting_is_an_error_not_silence(self):
        FakePyAudio.devices = ["Speakers"]
        FakePyAudio.unstartable = {"Speakers"}
        cap = self.capture()
        with self.assertRaises(RuntimeError) as caught:
            cap.start()
        self.addCleanup(cap.stop)
        self.assertIn("Speakers", str(caught.exception))

    def test_a_rebuild_that_will_not_start_keeps_the_capture_that_works(self):
        # The live bug, in the order it happened: listening on the speakers,
        # the Bluetooth headset appears, the watcher rebuilds, the new
        # endpoints open but refuse to run.
        cap = self.capture()
        cap.start()
        self.addCleanup(cap.stop)
        working = cap._streams

        FakePyAudio.devices = ["Headset"]
        FakePyAudio.unstartable = {"Headset"}
        with self.assertRaises(RuntimeError):
            cap._build()

        self.assertIs(cap._streams, working, "the working capture is kept")
        self.assertFalse(any(s.closed for s in working))

    def test_the_capture_that_survives_a_bad_rebuild_still_feeds_the_call(self):
        cap = self.capture()
        cap.start()
        self.addCleanup(cap.stop)
        # From the live stream, not the newest PyAudio instance: once the
        # watcher is running it makes instances of its own.
        callback = cap._streams[0].callback

        FakePyAudio.devices = ["Headset"]
        FakePyAudio.unstartable = {"Headset"}
        with self.assertRaises(RuntimeError):
            cap._build()

        callback(np.ones(160, dtype=np.float32).tobytes(), 160, None, None)
        with cap._lock:
            self.assertEqual(len(cap._buffers[0]), 160,
                             "blocks from the device that still works must not be dropped")

    def test_a_watcher_rebuild_that_cannot_start_anything_says_so(self):
        # `stale` is what puts "we cannot record this" on screen. A rebuild
        # that failed at start used to succeed instead, which cleared it.
        cap = self.capture()
        cap.start()
        self.addCleanup(cap.stop)

        FakePyAudio.devices = ["Headset"]
        FakePyAudio.unstartable = {"Headset"}
        self.assertTrue(cap._watch_once(), "the device list changed, so it rebuilt")
        self.assertIsNotNone(cap.stale)
        self.assertIn("Headset", cap.stale)

    def test_a_rebuild_that_failed_is_tried_again_on_the_next_pass(self):
        # The watcher used to record the new device list before attempting the
        # rebuild, so a rebuild that failed still counted as having caught up:
        # the next pass saw no change, and the old streams are open and still
        # answer is_active(), so the capture looked alive. One warning, then
        # "Not hearing the call" for the rest of the session with nothing
        # trying again — and a Bluetooth headset switching profile is the
        # ordinary way to get there.
        cap = self.capture()
        cap.start()
        self.addCleanup(cap.stop)

        FakePyAudio.devices = ["Headset"]
        FakePyAudio.unopenable = {"Headset"}
        self.assertTrue(cap._watch_once(), "the device list changed, so it rebuilt")
        self.assertIsNotNone(cap.stale)

        self.assertTrue(cap._watch_once(), "the next pass must try the new device again")

    def test_the_capture_comes_back_on_its_own_once_the_device_will_open(self):
        # The point of retrying: the user does not have to restart anything.
        cap = self.capture()
        cap.start()
        self.addCleanup(cap.stop)

        FakePyAudio.devices = ["Headset"]
        FakePyAudio.unopenable = {"Headset"}
        cap._watch_once()
        self.assertIsNotNone(cap.stale)

        FakePyAudio.unopenable = set()          # the profile settled
        self.assertTrue(cap._watch_once())
        self.assertIsNone(cap.stale, "a rebuild that worked clears the warning")
        self.assertEqual(cap.device_names, ["Headset"])

    def test_a_rebuild_that_keeps_failing_says_so_once(self):
        # Retrying every three seconds must not mean warning every three
        # seconds in the log.
        cap = self.capture()
        cap.start()
        self.addCleanup(cap.stop)

        FakePyAudio.devices = ["Headset"]
        FakePyAudio.unopenable = {"Headset"}
        said = []
        with mock.patch.object(self.audio.sys, "stderr", io.StringIO()) as err:
            cap._watch_once()
            said.append(err.getvalue())
            cap._watch_once()
            cap._watch_once()
            said.append(err.getvalue())
        self.assertIn("rebuild failed", said[0])
        self.assertEqual(said[0], said[1], "the same failure should be logged once")

    def test_streams_that_die_after_starting_are_noticed(self):
        # Nothing raises when WASAPI invalidates a running endpoint: the
        # callbacks simply stop. Without this the capture is deaf and content.
        cap = self.capture()
        cap.start()
        self.addCleanup(cap.stop)
        for stream in cap._streams:
            stream.started = False          # the endpoint went away underneath us
        self.assertTrue(cap._watch_once(), "a dead capture is rebuilt, not left running")
        self.assertTrue(all(s.is_active() for s in cap._streams))


class ChosenDeviceTest(LoopbackTestCase):
    """
    Picking one output to listen to.

    Mixing every output is the right default — a call is heard wherever it
    plays, with nothing to configure. But when the wrong thing is being heard,
    saying *which* device to listen to is the difference between fixing it and
    guessing, which is how an evening went earlier this week.
    """

    def test_only_the_chosen_device_is_opened(self):
        FakePyAudio.devices = ["Speakers", "Earbuds", "Monitor"]
        cap = self.audio._WindowsLoopbackCapture(lambda *a, **k: None, only="Earbuds")
        self.addCleanup(cap.close)
        self.assertEqual(cap.device_names, ["Earbuds"])

    def test_no_choice_still_means_all_of_them(self):
        FakePyAudio.devices = ["Speakers", "Earbuds"]
        cap = self.capture()
        self.assertEqual(cap.device_names, ["Speakers", "Earbuds"])

    def test_choosing_a_device_that_is_gone_says_so(self):
        # Rather than silently falling back to everything, which would look
        # like the choice was honoured.
        FakePyAudio.devices = ["Speakers"]
        with self.assertRaises(RuntimeError) as caught:
            self.audio._WindowsLoopbackCapture(lambda *a, **k: None, only="Earbuds")
        self.assertIn("Earbuds", str(caught.exception))

    def test_the_choice_survives_a_rebuild(self):
        # The watcher rebuilds when devices change; it must not quietly widen
        # to every output when it does.
        FakePyAudio.devices = ["Speakers", "Earbuds"]
        cap = self.audio._WindowsLoopbackCapture(lambda *a, **k: None, only="Earbuds")
        self.addCleanup(cap.close)
        FakePyAudio.devices = ["Speakers", "Earbuds", "Monitor"]
        cap._build()
        self.assertEqual(cap.device_names, ["Earbuds"])


class ChosenMicTest(unittest.TestCase):
    """
    Picking a microphone.

    The picker lists WASAPI devices, and WASAPI in shared mode refuses any rate
    but the device's own — usually 48 kHz — so opening a chosen mic at our
    16 kHz failed with "Invalid sample rate". The loopback tests above use a
    fake PyAudio and could never have caught it; it took real hardware. These
    pin the fix: a WASAPI mic asks Windows to resample.
    """

    def setUp(self):
        from backend.routers import audio
        self.audio = audio
        self.opened = {}

        class FakeStream:
            def __init__(inner, **kw):
                self.opened.update(kw)
                inner.device = kw.get("device")
            def start(inner): pass
            def stop(inner): pass
            def close(inner): pass

        apis = [{"name": "MME"}, {"name": "Windows WASAPI"}]
        devices = {14: {"hostapi": 1, "name": "Mic"}, 3: {"hostapi": 0, "name": "Old mic"}}
        for target, value in (
            ("InputStream", FakeStream),
            ("query_hostapis", lambda i=None: apis if i is None else apis[i]),
            ("query_devices", lambda i=None: devices[i]),
        ):
            patch = mock.patch.object(audio.sd, target, value)
            patch.start()
            self.addCleanup(patch.stop)

    def open(self, devices):
        import asyncio
        loop = asyncio.new_event_loop()
        self.addCleanup(loop.close)
        return self.audio._open_stream_for("mic", loop, asyncio.Queue(), None, devices)

    def test_a_chosen_wasapi_mic_asks_windows_to_resample(self):
        _, err = self.open({"mic": "14"})
        self.assertIsNone(err)
        self.assertEqual(self.opened["device"], 14)
        self.assertIsInstance(self.opened["extra_settings"], self.audio.sd.WasapiSettings)

    def test_a_non_wasapi_mic_is_left_alone(self):
        # Passing WASAPI settings to an MME device is its own error.
        self.open({"mic": "3"})
        self.assertIsNone(self.opened["extra_settings"])

    def test_no_choice_still_means_the_system_default(self):
        self.open({})
        self.assertIsNone(self.opened["device"])
        self.assertIsNone(self.opened["extra_settings"])


class PickerOnTheBatchPathTest(unittest.TestCase):
    """
    The picker applies whoever is transcribing.

    The batch path — local Whisper, groq, openai — opened the default
    microphone and mixed every output, whatever the toolbar said. So the same
    control, on the same screen, aimed a Deepgram session at the device you
    chose and a Whisper one at whatever Windows felt like. The device you pick
    when the wrong thing is being heard is the one control that has to work.
    """

    def setUp(self):
        from backend.routers import audio
        self.audio = audio
        self.opened = {}

        class FakeCapture:
            device_names = ["Speakers"]
            errors: list = []
            stale = None
            gain = None

            def stop(self): pass
            def close(self): pass

        self.FakeCapture = FakeCapture

        def fake_open_system_capture(callback, only=None):
            self.opened["system_only"] = only
            return FakeCapture(), None

        # Only the system capture is patched here, and deliberately: patching
        # `_open_microphone` too would make these fail with "no such attribute"
        # on the code they are meant to catch, instead of on what it does.
        patch = mock.patch.object(audio, "_open_system_capture", fake_open_system_capture)
        patch.start()
        self.addCleanup(patch.stop)

    def patch_microphone(self):
        def fake_open_microphone(chosen, callback):
            self.opened["mic_chosen"] = chosen
            return self.FakeCapture()

        patch = mock.patch.object(self.audio, "_open_microphone", fake_open_microphone)
        patch.start()
        self.addCleanup(patch.stop)

    def run_batch(self, source, devices):
        """Open the source on the batch path, with Stop already pressed."""
        import asyncio

        class FakeWs:
            async def send_json(self, payload): pass

        async def scenario():
            stop = asyncio.Event()
            stop.set()                      # open, then unwind straight away
            return await self.audio._run_one_source_batch(
                FakeWs(), asyncio.get_running_loop(), source, stop,
                "local", None, emit_speech_final=True, devices=devices,
            )

        # A fresh lock per run: an asyncio primitive remembers the loop it was
        # first awaited on, and every test here brings its own.
        with mock.patch.object(self.audio, "_STREAM_INIT_LOCK", asyncio.Lock()):
            return asyncio.run(scenario())

    def test_the_chosen_output_is_what_the_batch_path_records(self):
        self.run_batch("system", {"system": "Earbuds"})
        self.assertEqual(self.opened["system_only"], "Earbuds")

    def test_no_chosen_output_still_means_every_output(self):
        self.run_batch("system", {})
        self.assertIsNone(self.opened["system_only"])

    def test_an_empty_choice_is_not_a_device_name(self):
        # The app sends "" for "let the machine decide"; passing it through
        # would look for an output literally called "".
        self.run_batch("system", {"system": ""})
        self.assertIsNone(self.opened["system_only"])

    def test_the_chosen_microphone_is_what_the_batch_path_records(self):
        self.patch_microphone()
        self.run_batch("mic", {"mic": "14"})
        self.assertEqual(self.opened["mic_chosen"], "14")

    def test_both_live_and_push_to_talk_hand_the_choice_on(self):
        # The fix is only worth anything if the loops pass `devices` down; they
        # took it from the socket and dropped it on the floor for this path.
        import inspect
        for loop in (self.audio._live_loop, self.audio._push_to_talk_loop):
            body = inspect.getsource(loop)
            batch = body[body.index("_run_one_source_batch"):]
            self.assertIn("devices=devices", batch[:batch.index(")")],
                          f"{loop.__name__} drops the chosen device")


class WhatTheUserIsToldTest(LoopbackTestCase):
    """
    A device that will not open says something a person can act on.

    PortAudio's own words went straight to the toast: "open mic: Error opening
    InputStream: Invalid device [PaErrorCode -9996]". True, and useless — and
    the ordinary way to see it is a Bluetooth headset connecting mid-call, which
    makes it the most frequent ugliness in the product rather than a rare one.
    The error code belongs in the log; the toast gets the sentence.
    """

    PORTAUDIO = "Error opening InputStream: Invalid device [PaErrorCode -9996]"

    def setUp(self):
        super().setUp()
        for name, value in (("IS_WINDOWS", True), ("IS_LINUX", False)):
            patch = mock.patch.object(self.audio, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_an_output_that_will_not_open_is_a_sentence_not_portaudio(self):
        FakePyAudio.unopenable = {"Speakers"}
        capture, err = self.audio._open_system_capture(lambda *a: None)
        self.assertIsNone(capture)
        self.assertEqual(err.code, "system_lost")
        self.assertNotIn("PaErrorCode", err.message)
        self.assertNotIn("device busy", err.message)
        self.assertTrue(err.title and err.message, "both halves are shown to the user")

    def test_the_portaudio_text_still_reaches_the_log(self):
        FakePyAudio.unopenable = {"Speakers"}
        with mock.patch.object(self.audio.sys, "stderr", io.StringIO()) as err:
            self.audio._open_system_capture(lambda *a: None)
            self.assertIn("device busy", err.getvalue(),
                          "the error code is worth keeping, in the log")

    def test_an_os_that_cannot_do_it_is_told_apart_from_a_lost_device(self):
        # Nothing the user picks under Sound helps here, so it must not read
        # like a device that went away.
        with mock.patch.object(self.audio, "IS_WINDOWS", False):
            _, err = self.audio._open_system_capture(lambda *a: None)
        self.assertEqual(err.code, "audio_unsupported")

    def test_a_microphone_that_will_not_open_is_a_sentence_too(self):
        import asyncio
        loop = asyncio.new_event_loop()
        self.addCleanup(loop.close)

        def refuse(chosen, callback):
            raise OSError(self.PORTAUDIO)

        with mock.patch.object(self.audio, "_open_microphone", refuse), \
                mock.patch.object(self.audio.sys, "stderr", io.StringIO()) as log:
            stream, err = self.audio._open_stream_for("mic", loop, asyncio.Queue(), None, {})
        self.assertIsNone(stream)
        self.assertEqual(err.code, "mic_lost")
        self.assertNotIn("PaErrorCode", err.message)
        self.assertIn("PaErrorCode", log.getvalue(), "and the log keeps it")

    def test_the_two_sides_get_their_own_code_so_one_toast_is_not_lost(self):
        # Auto opens both. Keyed on the code (frontend/src/lib/errors.tsx), one
        # shared code would mean a microphone problem and a call-audio problem
        # replacing each other's toast.
        from backend import errors
        self.assertNotEqual(errors.mic_lost().code, errors.system_lost().code)

    def test_the_sound_panel_is_not_shown_portaudio_either(self):
        # `stale` is printed verbatim under "Not hearing the call".
        cap = self.capture()
        cap.start()
        self.addCleanup(cap.stop)
        FakePyAudio.devices = ["Headset"]
        FakePyAudio.unopenable = {"Headset"}
        cap._watch_once()
        self.assertIsNotNone(cap.stale)
        self.assertNotIn("PaErrorCode", cap.stale)
        self.assertNotIn("device busy", cap.stale)
        self.assertIn("Headset", cap.stale, "it still says where the audio went")


class BatchPathIsToldTooTest(unittest.TestCase):
    """The Whisper/groq path had its own copy of the same raw string."""

    def setUp(self):
        from backend.routers import audio
        self.audio = audio
        self.sent: list = []

    def run_batch_with_a_dead_microphone(self):
        import asyncio

        sent = self.sent

        class FakeWs:
            async def send_json(self, payload):
                sent.append(payload)

        def refuse(chosen, callback):
            raise OSError("Error opening InputStream: Invalid device [PaErrorCode -9996]")

        async def scenario():
            stop = asyncio.Event()
            stop.set()
            return await self.audio._run_one_source_batch(
                FakeWs(), asyncio.get_running_loop(), "mic", stop,
                "local", None, emit_speech_final=True, devices={},
            )

        with mock.patch.object(self.audio, "_open_microphone", refuse), \
                mock.patch.object(self.audio, "_STREAM_INIT_LOCK", asyncio.Lock()), \
                mock.patch.object(self.audio.sys, "stderr", io.StringIO()):
            return asyncio.run(scenario())

    def test_the_batch_path_sends_a_code_and_a_sentence(self):
        self.run_batch_with_a_dead_microphone()
        self.assertTrue(self.sent, "the app has to be told something")
        first = self.sent[0]
        self.assertEqual(first["type"], "error")
        self.assertEqual(first["code"], "mic_lost")
        self.assertNotIn("PaErrorCode", first["message"])


class SharedMicrophoneOpenTest(unittest.TestCase):
    """
    One microphone opener, not two.

    `_open_stream_for` had learned that a chosen WASAPI mic needs
    `auto_convert`, because WASAPI in shared mode refuses any rate but the
    device's own. The batch path never learned it, having its own copy that
    passed no device at all.
    """

    def setUp(self):
        from backend.routers import audio
        self.audio = audio
        self.opened = {}

        class FakeStream:
            def __init__(inner, **kw):
                self.opened.update(kw)
            def start(inner): pass

        apis = [{"name": "MME"}, {"name": "Windows WASAPI"}]
        devices = {14: {"hostapi": 1, "name": "Mic"}, 3: {"hostapi": 0, "name": "Old mic"}}
        for target, value in (
            ("InputStream", FakeStream),
            ("query_hostapis", lambda i=None: apis if i is None else apis[i]),
            ("query_devices", lambda i=None: devices[i]),
        ):
            patch = mock.patch.object(audio.sd, target, value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_a_chosen_wasapi_mic_resamples_wherever_it_is_opened_from(self):
        self.audio._open_microphone("14", lambda *a: None)
        self.assertEqual(self.opened["device"], 14)
        self.assertIsInstance(self.opened["extra_settings"], self.audio.sd.WasapiSettings)

    def test_no_choice_is_the_system_default(self):
        self.audio._open_microphone(None, lambda *a: None)
        self.assertIsNone(self.opened["device"])

    def test_a_microphone_that_will_not_open_raises_for_the_caller_to_report(self):
        def boom(**kw):
            raise OSError("Invalid sample rate")
        with mock.patch.object(self.audio.sd, "InputStream", boom):
            with self.assertRaises(OSError):
                self.audio._open_microphone("14", lambda *a: None)


if __name__ == "__main__":
    unittest.main()
