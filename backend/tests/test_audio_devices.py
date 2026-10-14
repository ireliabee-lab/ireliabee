"""
The microphone list follows what is plugged in (PortAudio only reads devices when
it starts, so the list restarts it) without ever cutting off a live recording.
"""
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401
from backend.routers import audio


class _Stream:
    def __init__(self, closed: bool):
        self.closed = closed


class MicrophoneRefreshTests(unittest.TestCase):
    def setUp(self):
        self.streams = []           # keep the fakes alive: the registry holds them weakly
        audio._SD_STREAMS.clear()

    def tearDown(self):
        audio._SD_STREAMS.clear()

    def _open(self, closed: bool):
        s = _Stream(closed)
        self.streams.append(s)
        audio._SD_STREAMS.add(s)

    def test_restarts_portaudio_when_nothing_is_recording(self):
        self._open(closed=True)
        with mock.patch.object(audio.sd, "_terminate") as term, mock.patch.object(audio.sd, "_initialize") as init:
            self.assertTrue(audio._refresh_microphones())
        term.assert_called_once()
        init.assert_called_once()

    def test_leaves_a_live_recording_alone(self):
        self._open(closed=False)
        with mock.patch.object(audio.sd, "_terminate") as term, mock.patch.object(audio.sd, "_initialize") as init:
            self.assertFalse(audio._refresh_microphones())
        term.assert_not_called()
        init.assert_not_called()

    def test_a_failed_restart_is_reported_not_raised(self):
        with mock.patch.object(audio.sd, "_terminate"), \
             mock.patch.object(audio.sd, "_initialize", side_effect=OSError("no PortAudio")):
            self.assertFalse(audio._refresh_microphones())

    def test_the_device_list_asks_for_a_fresh_read(self):
        with mock.patch.object(audio, "_refresh_microphones") as refresh, \
             mock.patch.object(audio.sd, "query_hostapis", return_value=[{"name": "Windows WASAPI", "default_input_device": 0}]), \
             mock.patch.object(audio.sd, "query_devices", return_value=[]):
            audio.list_devices()
        refresh.assert_called_once()

    def test_opened_streams_are_registered(self):
        fake = _Stream(closed=False)
        with mock.patch.object(audio.sd, "InputStream", return_value=fake):
            self.assertIs(audio._open_sd_stream(samplerate=16000), fake)
        self.assertIn(fake, audio._SD_STREAMS)


class EverythingOpenCountsTests(unittest.TestCase):
    """
    Restarting PortAudio is not a local act.

    `sd._terminate()` is `Pa_Terminate`, which closes every open PortAudio
    stream in the process — not only the microphone the caller had in mind. The
    guard was a registry that only recording could enter, so anything else
    sounddevice was doing would have been killed, silently, from inside a
    `GET /audio/devices`.

    Latent when this was written — the backend only records. It is here because
    the first harness built to measure the system-audio bug played its tone
    through an `sd.OutputStream`, and that tone died the moment the test asked
    for the device list, which cost an hour of blaming the wrong thing.
    """

    def setUp(self):
        self.streams = []           # keep the fakes alive: the registry is weak
        audio._SD_STREAMS.clear()
        self.addCleanup(audio._SD_STREAMS.clear)

    def test_playback_can_go_through_the_same_door(self):
        fake = _Stream(closed=False)
        self.streams.append(fake)
        with mock.patch.object(audio.sd, "OutputStream", return_value=fake):
            opened = audio._open_sd_stream(audio.sd.OutputStream, samplerate=16000)
        self.assertIs(opened, fake)
        self.assertIn(fake, audio._SD_STREAMS)

    def test_something_playing_stops_the_device_list_restarting_portaudio(self):
        fake = _Stream(closed=False)
        self.streams.append(fake)
        with mock.patch.object(audio.sd, "OutputStream", return_value=fake):
            audio._open_sd_stream(audio.sd.OutputStream, samplerate=16000)
        with mock.patch.object(audio.sd, "_terminate") as term, \
             mock.patch.object(audio.sd, "_initialize") as init:
            self.assertFalse(audio._refresh_microphones())
        term.assert_not_called()
        init.assert_not_called()

    def test_a_stream_that_cannot_say_whether_it_is_closed_counts_as_open(self):
        # The two wrong answers are not the same size: a skipped refresh means
        # a stale picker, a wrong "closed" cuts off a live recording.
        class Mute:
            @property
            def closed(self):
                raise RuntimeError("PortAudio is not answering")

        mute = Mute()
        self.streams.append(mute)
        audio._SD_STREAMS.add(mute)
        with mock.patch.object(audio.sd, "_terminate") as term, \
             mock.patch.object(audio.sd, "_initialize"):
            self.assertFalse(audio._refresh_microphones())
        term.assert_not_called()


if __name__ == "__main__":
    unittest.main()
