"""
Audio sources run as a group (audit 178-C3).

If the call's socket was refused while the microphone's was accepted, the
microphone kept streaming — and the relay kept billing — after the screen had
already shown the error and gone idle.
"""
import asyncio
import unittest

from backend.tests import _env  # noqa: F401

from backend.core.gain import AutoGain
from backend.routers.audio import _run_sources


class RunSourcesTest(unittest.TestCase):
    def test_one_source_failing_stops_the_other(self):
        async def scenario():
            stop = asyncio.Event()
            still_streaming = {"mic": False}

            async def mic():
                try:
                    while not stop.is_set():
                        await asyncio.sleep(0.01)
                finally:
                    still_streaming["mic"] = False

            async def system():
                await asyncio.sleep(0.02)
                raise RuntimeError("HTTP 503 from the relay")

            still_streaming["mic"] = True
            with self.assertRaises(RuntimeError):
                await _run_sources([mic(), system()], stop)
            return stop.is_set(), still_streaming["mic"]

        stopped, mic_running = asyncio.run(scenario())
        self.assertTrue(stopped, "every source is told to stop")
        self.assertFalse(mic_running, "and none is left streaming")

    def test_a_normal_stop_returns_every_result(self):
        async def scenario():
            stop = asyncio.Event()

            async def source(text):
                await stop.wait()
                return text

            async def press_stop():
                await asyncio.sleep(0.01)
                stop.set()

            asyncio.get_running_loop().create_task(press_stop())
            return await _run_sources([source("a"), source("b")], stop)

        self.assertEqual(asyncio.run(scenario()), ["a", "b"])


class CancelledSourceTest(unittest.TestCase):
    """Audit 180-M5: a source cancelled by its failing sibling still closes its capture."""

    def test_the_microphone_is_released_when_the_source_is_cancelled(self):
        from unittest import mock
        from backend.routers import audio

        closed = {"stop": False, "close": False}

        class FakeStream:
            levels = {"peak": 0.5}
            device_names = []
            stale = None
            # Every real capture carries its own level stage now, and the
            # meter task reads it (routers/audio._pump_levels).
            gain = AutoGain()

            def stop(self):
                closed["stop"] = True

            def close(self):
                closed["close"] = True

        class FakeSession:
            def __init__(self, **_):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_):
                return False

            async def send_audio(self, _):
                pass

            async def finish(self):
                pass

            async def transcripts(self):
                await asyncio.Event().wait()          # never ends on its own
                yield {}

        class FakeWs:
            async def send_json(self, _):
                pass

        async def scenario():
            loop = asyncio.get_running_loop()
            with mock.patch.object(audio, "DeepgramSession", FakeSession),                  mock.patch.object(audio, "_open_stream_for", return_value=(FakeStream(), None)):
                task = loop.create_task(audio._run_one_source(FakeWs(), loop, "mic", asyncio.Event(), False))
                await asyncio.sleep(0.05)
                task.cancel()                          # what _run_sources does to a sibling
                try:
                    await task
                except asyncio.CancelledError:
                    pass

        asyncio.run(scenario())
        self.assertTrue(closed["stop"] and closed["close"], "the OS capture was left open")


if __name__ == "__main__":
    unittest.main()


class ConnectSettingsTest(unittest.TestCase):
    """
    A speech socket that has quietly gone is noticed in seconds.

    The library waits twenty seconds before its first ping and twenty more for
    the reply, so a dropped Wi-Fi or a sleep/resume left the screen saying
    "listening" to nothing for up to forty seconds — in an interview, most of an
    answer. The pong has to come from our own event loop, which is also pumping
    transcripts and levels, so the deadline is deliberately not as tight as it
    could be: closing a healthy socket mid-answer would be worse than the bug.
    """

    def kwargs_of_connect(self) -> dict:
        from unittest import mock
        from backend import deepgram_stream

        seen: dict = {}

        async def fake_connect(url, **kwargs):
            seen.update(kwargs)
            return mock.AsyncMock()

        async def scenario():
            with mock.patch.object(deepgram_stream.websockets, "connect", fake_connect):
                # An explicit key takes the direct endpoint, so this never
                # reaches core/hosted.
                session = deepgram_stream.DeepgramSession(api_key="k")
                await session.__aenter__()

        asyncio.run(scenario())
        return seen

    def test_a_dead_speech_socket_is_noticed_in_seconds_not_most_of_a_minute(self):
        seen = self.kwargs_of_connect()
        self.assertEqual(seen["ping_interval"], 5)
        self.assertLessEqual(seen["ping_timeout"], 10)

    def test_the_deadline_is_not_so_tight_that_a_busy_moment_closes_it(self):
        self.assertGreaterEqual(self.kwargs_of_connect()["ping_timeout"], 10)


class SpeechEndedTest(unittest.TestCase):
    """Audit 178-H1: when the relay ends transcription, the user is told why."""

    def _report(self, task_coro):
        from backend.routers.audio import _report_speech_ended

        sent = []

        class FakeWs:
            async def send_json(self, data):
                sent.append(data)

        async def scenario():
            task = asyncio.get_running_loop().create_task(task_coro())
            try:
                await task
            except Exception:
                pass
            await _report_speech_ended(FakeWs(), task)

        asyncio.run(scenario())
        return sent

    def test_out_of_credits_reaches_the_app(self):
        from unittest import mock
        from backend import errors
        from backend.core import hosted

        async def relay_said_4402():
            raise errors.out_of_credits()

        with mock.patch.object(hosted, "is_admin", return_value=False):
            sent = self._report(relay_said_4402)
        self.assertEqual(sent[0]["type"], "error")
        self.assertEqual(sent[0]["code"], "out_of_credits")

    def test_a_quiet_close_is_still_said_out_loud(self):
        async def relay_closed():
            return None

        sent = self._report(relay_closed)
        self.assertEqual(sent[0]["code"], "speech_stopped")
