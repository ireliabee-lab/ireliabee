"""
Stopping a reading job stops the AI calls it already made (review of #11, item 7):
a streamed answer is closed mid-way, so the server stops the model and charges
only what it sent, and a call that hasn't started never starts.
"""
import asyncio
import threading
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401
from backend.core import providers
from backend import reading


class FakeStream:
    def __init__(self, stop_after=None, event=None):
        self.closed = False
        self.sent = 0
        self.stop_after, self.event = stop_after, event

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True          # the SDK closes the HTTP stream here
        return False

    def __iter__(self):
        for i in range(50):
            self.sent += 1
            if self.stop_after is not None and i == self.stop_after:
                self.event.set()    # the user presses Stop mid-answer
            yield {"type": "content_block_delta"}

    def get_final_message(self):
        return "whole answer"


class Client:
    def __init__(self, stream):
        self.messages = mock.Mock(stream=mock.Mock(return_value=stream))


class StopTests(unittest.TestCase):
    def test_a_running_answer_is_closed_when_stopped(self):
        stop = threading.Event()
        stream = FakeStream(stop_after=2, event=stop)
        with mock.patch.object(providers, "_anthropic_client", return_value=Client(stream)):
            with self.assertRaises(providers.Stopped), providers.cancellable(stop):
                providers._final_message(model="m", max_tokens=10, messages=[])
        self.assertTrue(stream.closed)
        self.assertLess(stream.sent, 50, "stopped part-way, not read to the end")

    def test_a_call_after_stop_never_starts(self):
        stop = threading.Event()
        stop.set()
        client = Client(FakeStream())
        with mock.patch.object(providers, "_anthropic_client", return_value=client):
            with self.assertRaises(providers.Stopped):
                with providers.cancellable(stop):
                    providers._final_message(model="m", max_tokens=10, messages=[])
        client.messages.stream.assert_not_called()

    def test_without_a_stop_signal_the_answer_is_read_whole(self):
        with mock.patch.object(providers, "_anthropic_client", return_value=Client(FakeStream())):
            self.assertEqual(providers._final_message(model="m", max_tokens=10, messages=[]), "whole answer")

    def test_stopping_a_job_raises_its_stop_signal(self):
        seen = {}

        async def work(job):
            seen["stop"] = reading._JOB_STOP.get()
            await asyncio.sleep(10)

        async def scenario():
            view = reading.start_job(work, document_id=1)
            await asyncio.sleep(0.05)
            self.assertIsNotNone(seen.get("stop"), "the job's calls can see its stop signal")
            self.assertFalse(seen["stop"].is_set())
            reading.cancel_job(view["id"])
            self.assertTrue(seen["stop"].is_set())
            await asyncio.sleep(0.05)
            self.assertEqual(reading.job_view(view["id"])["state"], "cancelled")

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
