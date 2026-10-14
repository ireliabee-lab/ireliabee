"""
"Automatic" opens the microphone the picker is offering, not a different one.

PortAudio's default host API on Windows is MME. The picker lists WASAPI, which
is where a laptop's microphone array appears as the OS describes it — so an
unchosen microphone (`device=None`) and the row the picker ticks were two
different devices on the same machine, one of which delivered speech and one of
which did not. These tests hold the two ends together: whatever host API the
picker lists from is the one an unchosen microphone resolves against.

Nothing here opens a real device. `sounddevice` is mocked throughout, which is
also the only way these can run on the Linux box that builds the installers.
"""
import threading
import time
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401
from backend.routers import audio


#: What `sd.query_hostapis()` says on the machine this was found on. MME's
#: default input and WASAPI's are the same physical microphone array, exposed
#: twice — four channels at 44.1 kHz through MME, two at 48 kHz through WASAPI.
HOST_APIS = [
    {"name": "MME", "default_input_device": 1},
    {"name": "Windows DirectSound", "default_input_device": 4},
    {"name": "Windows WASAPI", "default_input_device": 9},
    {"name": "Windows WDM-KS", "default_input_device": 10},
]

def _out(name, hostapi):
    return {"name": name, "hostapi": hostapi, "max_input_channels": 0}


def _in(name, hostapi, channels=2):
    return {"name": name, "hostapi": hostapi, "max_input_channels": channels}


#: Indexed exactly as PortAudio indexes them. The picker's ids are names now,
#: but the indices still decide everything underneath — `_default_microphone`,
#: `_microphone_index` and the device sounddevice is finally asked for — so a
#: fixture with the gaps closed up would quietly test the wrong device.
DEVICE_LIST = [
    _in("Microsoft Sound Mapper - Input", 0),                                   # 0
    _in("Microphone Array (2- Intel Sma", 0, channels=4),                       # 1  MME default
    _out("Microsoft Sound Mapper - Output", 0),                                 # 2
    _out("Speakers (3- Realtek(R) Audio)", 0),                                  # 3
    _in("Primary Sound Capture Driver", 1),                                     # 4  DirectSound default
    _in("Microphone Array (2- Intel Smart Sound Technology for Digital Microphones)", 1, 4),
    _out("Primary Sound Driver", 1),                                            # 6
    _out("Speakers (3- Realtek(R) Audio)", 1),                                  # 7
    _out("Speakers (3- Realtek(R) Audio)", 2),                                  # 8
    _in("Microphone Array (2- Intel Smart Sound Technology for Digital Microphones)", 2),
    _in("Microphone Array 1 ()", 3),                                            # 10 WDM-KS
]
DEVICES = {i: d for i, d in enumerate(DEVICE_LIST)}

#: The WASAPI microphone the picker offers (DEVICE_LIST index 9) — and, now that
#: ids are names rather than indices, the id it hands back.
WASAPI_MIC = DEVICE_LIST[9]["name"]


def _querier(devices):
    def _query_devices(device=None, kind=None):
        """`sounddevice`'s three shapes: everything, one device, or a kind's default."""
        if device is None and kind is None:
            return devices
        if device is None:
            return devices[1]      # PortAudio's own default input: MME #1
        return devices[device]
    return _query_devices


_query_devices = _querier(DEVICE_LIST)


def _query_hostapis(index=None):
    return HOST_APIS if index is None else HOST_APIS[index]


class _Windows:
    """
    Patch the module as it looks on the owner's laptop.

    `devices` swaps the device list for one case — two microphones sharing a
    name, say — without a second copy of the fixture drifting away from this one.
    """

    def __init__(self, devices=None):
        self._devices = DEVICE_LIST if devices is None else devices

    def __enter__(self):
        self._p = [
            mock.patch.object(audio, "IS_WINDOWS", True),
            mock.patch.object(audio, "IS_LINUX", False),
            mock.patch.object(audio.sd, "query_hostapis", side_effect=_query_hostapis),
            mock.patch.object(audio.sd, "query_devices", side_effect=_querier(self._devices)),
        ]
        for p in self._p:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in reversed(self._p):
            p.stop()
        return False


class WhichDeviceAutomaticMeansTests(unittest.TestCase):
    def test_on_windows_it_is_the_wasapi_default_input(self):
        with _Windows():
            self.assertEqual(audio._default_microphone(), 9)

    def test_off_windows_portaudio_still_decides(self):
        # Linux and macOS default host APIs *are* what the OS means by "the
        # default microphone". Resolving anything there would be changing a
        # working platform to fix a broken one.
        for linux in (True, False):
            with mock.patch.object(audio, "IS_WINDOWS", False), \
                 mock.patch.object(audio, "IS_LINUX", linux), \
                 mock.patch.object(audio.sd, "query_hostapis") as apis:
                self.assertIsNone(audio._default_microphone())
                apis.assert_not_called()

    def test_a_machine_with_no_wasapi_input_falls_back_to_portaudio(self):
        # -1 is PortAudio's "this host API has no input device". Better an
        # unresolved microphone that opens than a resolved one that cannot.
        apis = [dict(a) for a in HOST_APIS]
        apis[2]["default_input_device"] = -1
        with mock.patch.object(audio, "IS_WINDOWS", True), \
             mock.patch.object(audio.sd, "query_hostapis",
                               side_effect=lambda i=None: apis if i is None else apis[i]):
            self.assertIsNone(audio._default_microphone())

    def test_portaudio_not_answering_is_not_an_exception(self):
        with mock.patch.object(audio, "IS_WINDOWS", True), \
             mock.patch.object(audio.sd, "query_hostapis", side_effect=OSError("no PortAudio")):
            self.assertIsNone(audio._default_microphone())

    def test_no_wasapi_host_api_at_all_leaves_the_system_default(self):
        # Not a Windows this app has met, but `_microphone_host_api` must still
        # return something `query_hostapis` will accept.
        # (`sd.default.hostapi` is a read-only property, so the whole `default`
        # object is stood in for rather than the one attribute.)
        with mock.patch.object(audio, "IS_WINDOWS", True), \
             mock.patch.object(audio.sd, "query_hostapis", return_value=[{"name": "MME"}]), \
             mock.patch.object(audio.sd, "default", mock.Mock(hostapi=0)):
            self.assertEqual(audio._microphone_host_api(), 0)


class ThePickerAndAutomaticAgreeTests(unittest.TestCase):
    """
    The actual bug, stated once: the list the user chooses from and the device
    chosen for them when they do not must come from the same host API. Two
    functions asking the same question separately is how they drifted apart.
    """

    def test_automatic_resolves_to_the_device_the_picker_marks_default(self):
        with _Windows(), mock.patch.object(audio, "_refresh_microphones"):
            listed = audio.list_devices()["inputs"]
            automatic = audio._default_microphone()
        marked = [d["id"] for d in listed if d["default"]]
        self.assertEqual(marked, [DEVICE_LIST[automatic]["name"]])

    def test_the_picker_only_offers_devices_automatic_could_have_picked(self):
        with _Windows(), mock.patch.object(audio, "_refresh_microphones"):
            listed = audio.list_devices()["inputs"]
        # WASAPI's inputs, and nothing from MME — which is where the four
        # channel exposure of the same array lives.
        self.assertEqual([d["id"] for d in listed], ["Microphone Array (2- Intel Smart Sound Technology for Digital Microphones)"])


class OpeningAnUnchosenMicrophoneTests(unittest.TestCase):
    def setUp(self):
        audio._SD_STREAMS.clear()
        self.addCleanup(audio._SD_STREAMS.clear)

    def _open(self, chosen):
        """Open through the real `_open_microphone`, capturing what PortAudio was asked for."""
        stream = mock.Mock()
        stream.closed = False
        with mock.patch.object(audio, "_open_sd_stream", return_value=stream) as opener:
            opened = audio._open_microphone(chosen, lambda *a: None)
        stream.start.assert_called_once()
        return opened, opener.call_args.kwargs

    def test_a_microphone_chosen_by_name_opens_that_exact_device(self):
        # The point of the change. The picker hands back a name; an index would
        # still resolve after a headset paired and renumbered things — to a
        # different microphone — and nothing could tell.
        with _Windows():
            _, kwargs = self._open("Microphone Array (2- Intel Smart Sound Technology for Digital Microphones)")
        self.assertEqual(kwargs["device"], 9)

    def test_a_name_that_is_not_there_is_still_handed_to_portaudio(self):
        # A microphone that opens beats one that is provably the right one.
        with _Windows():
            _, kwargs = self._open("Ghost Mic")
        self.assertEqual(kwargs["device"], "Ghost Mic")

    def test_an_index_from_an_older_app_still_works(self):
        # A window open across the update sends what it was given before it.
        with _Windows():
            _, kwargs = self._open("10")
        self.assertEqual(kwargs["device"], 10)

    def test_two_microphones_with_one_name_stay_separately_choosable(self):
        # Two identical USB mics, or a dock exposing one twice. The first keeps
        # the bare name so a choice remembered before this cannot break; the
        # second carries its index.
        twins = list(DEVICE_LIST)
        twins.append(_in(WASAPI_MIC, 2))                    # index 11, same name
        with _Windows(devices=twins), mock.patch.object(audio, "_refresh_microphones"):
            listed = audio.list_devices()["inputs"]
        self.assertEqual([d["id"] for d in listed],
                         [WASAPI_MIC, f"{WASAPI_MIC}{audio.DEVICE_ID_SEP}11"])
        self.assertEqual([d["label"] for d in listed], [WASAPI_MIC, WASAPI_MIC],
                         "both rows still read as the device they are")
        with _Windows(devices=twins):
            _, kwargs = self._open(f"{WASAPI_MIC}{audio.DEVICE_ID_SEP}11")
        self.assertEqual(kwargs["device"], 11, "the second one really is the second one")

    def test_an_unchosen_microphone_is_opened_on_wasapi(self):
        with _Windows():
            _, kwargs = self._open(None)
        self.assertEqual(kwargs["device"], 9)

    def test_and_with_auto_convert_or_it_would_not_open_at_all(self):
        # WASAPI shared mode only accepts the device's native rate (48 kHz
        # here) and this app runs at 16 kHz. Resolving to WASAPI without this
        # trades a silent microphone for "Invalid sample rate", which is worse:
        # it breaks the configuration that was at least sometimes working.
        with _Windows():
            _, kwargs = self._open(None)
        self.assertIsNotNone(kwargs["extra_settings"])
        self.assertIsInstance(kwargs["extra_settings"], audio.sd.WasapiSettings)

    def test_a_chosen_microphone_is_still_the_chosen_one(self):
        with _Windows():
            _, kwargs = self._open("10")
        self.assertEqual(kwargs["device"], 10)
        self.assertIsNone(kwargs["extra_settings"])   # WDM-KS, not WASAPI

    def test_a_chosen_microphone_can_be_a_name(self):
        with _Windows(), mock.patch.object(audio.sd, "query_devices",
                                           side_effect=lambda d=None, k=None: DEVICES[9]):
            _, kwargs = self._open("Microphone Array")
        self.assertEqual(kwargs["device"], "Microphone Array")

    def test_linux_and_macos_still_hand_portaudio_none(self):
        for linux in (True, False):
            with mock.patch.object(audio, "IS_WINDOWS", False), \
                 mock.patch.object(audio, "IS_LINUX", linux), \
                 mock.patch.object(audio.sd, "query_devices", side_effect=_query_devices), \
                 mock.patch.object(audio.sd, "query_hostapis", side_effect=_query_hostapis):
                _, kwargs = self._open(None)
            self.assertIsNone(kwargs["device"])
            self.assertIsNone(kwargs["extra_settings"])

    def test_the_rest_of_the_stream_is_unchanged(self):
        # 16 kHz mono float32 is what the gain, the endpointing and Deepgram
        # all assume; `auto_convert` exists so that stays true on WASAPI.
        with _Windows():
            _, kwargs = self._open(None)
        self.assertEqual(kwargs["samplerate"], audio.SAMPLE_RATE)
        self.assertEqual(kwargs["channels"], 1)
        self.assertEqual(kwargs["dtype"], "float32")
        self.assertEqual(kwargs["blocksize"], audio.BLOCK_SIZE)

    def test_it_goes_through_the_one_door(self):
        # Opened around `_open_sd_stream`, a microphone is invisible to the
        # registry and gets closed mid-sentence by the device picker.
        fake = mock.Mock(closed=False)
        with _Windows(), mock.patch.object(audio.sd, "InputStream", return_value=fake):
            audio._open_microphone(None, lambda *a: None)
        self.assertIn(fake, audio._SD_STREAMS)


class ResolvingAndOpeningAreOneStepTests(unittest.TestCase):
    """
    A PortAudio device index means nothing across a restart of PortAudio, and
    `_refresh_microphones` — which any `GET /audio/devices` reaches — is that
    restart. It skips while anything is open, but between resolving an index
    and constructing the stream nothing is open yet, so an unlucky device
    list could have renumbered the devices under an "Automatic" that had
    already decided which number it wanted.

    `device=None` never had this problem: PortAudio resolved it at open time.
    Resolving it ourselves is what introduced the window, so closing it comes
    with the same change.
    """

    def setUp(self):
        audio._SD_STREAMS.clear()
        self.addCleanup(audio._SD_STREAMS.clear)

    def test_the_picker_cannot_restart_portaudio_between_resolve_and_open(self):
        # The window is *before* the stream is constructed: `_open_sd_stream`
        # has always held the lock around the construction itself, so a device
        # list arriving at that moment was never the problem. The problem is
        # the moment after an index has been decided and before it is spent.
        refreshed, while_holding_an_index = [], []
        real_default = audio._default_microphone

        with _Windows(), \
             mock.patch.object(audio.sd, "_terminate") as term, \
             mock.patch.object(audio.sd, "_initialize"), \
             mock.patch.object(audio.sd, "InputStream", return_value=mock.Mock(closed=False)):

            def resolve_then_a_device_list_arrives():
                index = real_default()
                t = threading.Thread(target=lambda: refreshed.append(audio._refresh_microphones()))
                t.start()
                self.addCleanup(t.join, 5)
                t.join(timeout=0.4)               # held off if the lock is ours; not if it is not
                while_holding_an_index.append(term.call_count)
                return index

            with mock.patch.object(audio, "_default_microphone",
                                   side_effect=resolve_then_a_device_list_arrives):
                audio._open_microphone(None, lambda *a: None)

            for _ in range(60):                   # the refresh is held up, not lost
                if refreshed:
                    break
                time.sleep(0.05)

        self.assertEqual(while_holding_an_index, [0],
                         "PortAudio was restarted while a device index was in hand")
        self.assertEqual(refreshed, [False], "and it still ran afterwards, declining because we are open")
        term.assert_not_called()

    def test_the_lock_is_reentrant_or_the_open_deadlocks(self):
        # `_open_sd_stream` takes the same lock. Holding it across the resolve
        # only works because it can be taken twice by one thread.
        self.assertTrue(audio._SD_LOCK.acquire(timeout=1))
        try:
            self.assertTrue(audio._SD_LOCK.acquire(timeout=1))
            audio._SD_LOCK.release()
        finally:
            audio._SD_LOCK.release()


class SayingWhichMicrophoneItWasTests(unittest.TestCase):
    """
    "Automatic" used to mean "not our problem". It is our problem now, so the
    stream carries the name of what it opened, the way system audio does.
    """

    def test_the_stream_names_the_device_that_was_opened(self):
        stream = mock.Mock(closed=False)
        with _Windows(), mock.patch.object(audio, "_open_sd_stream", return_value=stream):
            opened = audio._open_microphone(None, lambda *a: None)
        self.assertEqual(opened.device_names, [DEVICES[9]["name"]])

    def test_a_chosen_device_is_named_too(self):
        stream = mock.Mock(closed=False)
        with _Windows(), mock.patch.object(audio, "_open_sd_stream", return_value=stream):
            opened = audio._open_microphone("10", lambda *a: None)
        self.assertEqual(opened.device_names, [DEVICES[10]["name"]])

    def test_a_nameless_device_is_an_empty_list_not_a_crash(self):
        stream = mock.Mock(closed=False)
        with mock.patch.object(audio, "IS_WINDOWS", False), \
             mock.patch.object(audio, "IS_LINUX", False), \
             mock.patch.object(audio.sd, "query_devices", side_effect=OSError("gone")), \
             mock.patch.object(audio, "_open_sd_stream", return_value=stream):
            opened = audio._open_microphone(None, lambda *a: None)
        self.assertEqual(opened.device_names, [])


class TheReportSaysWhichSourceTests(unittest.IsolatedAsyncioTestCase):
    """
    One `capture` message now describes two sources, so it has to say which.
    Without that the microphone's name would land in the line that talks about
    the call's audio, and the panel would claim the call is being heard on a
    microphone.
    """

    class _WS:
        def __init__(self):
            self.sent = []

        async def send_json(self, payload):
            self.sent.append(payload)

    async def test_a_microphone_report_is_labelled_mic(self):
        ws = self._WS()
        stream = mock.Mock(device_names=["Microphone Array"], stale=None, errors=[])
        await audio._report_capture(ws, stream, "mic")
        self.assertEqual(ws.sent[0]["source"], "mic")
        self.assertEqual(ws.sent[0]["devices"], ["Microphone Array"])

    async def test_system_audio_is_still_what_it_was(self):
        ws = self._WS()
        stream = mock.Mock(device_names=["Speakers [Loopback]"], stale=None, errors=[])
        await audio._report_capture(ws, stream)
        self.assertEqual(ws.sent[0]["source"], "system")


if __name__ == "__main__":
    unittest.main()
