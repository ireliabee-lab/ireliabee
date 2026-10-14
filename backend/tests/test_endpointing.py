"""
When the app decides you have finished a sentence (core/endpointing.py).

Without a streaming transcriber — offline Whisper, Groq, OpenAI, or
push-to-talk — audio arrives as blocks of samples and something has to cut it
into utterances. Cut too early and the transcriber is handed half a sentence,
which is what the user actually sees: an answer that stops mid-thought.

The bug these pin down: the length a segment was measured against used to be
the length of the *socket*, every block since the microphone opened, speech or
not. Listening quietly for a minute before answering — an interview, in other
words — pushed that length past the one-minute cap before the first word, and
the first sentence was sent off at its first comma.
"""
import unittest

import numpy as np

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core.endpointing import (  # noqa: E402
    MAX_UTTERANCE_SEC, SILENCE_SECS, Utterance,
)

RATE = 16_000
BLOCK = 800                     # 50 ms, as the sound card delivers it
BLOCK_SEC = BLOCK / RATE
LOUD = 0.08                     # someone speaking
ROOM = 0.002                    # the room with nobody in it


def block(level: float) -> np.ndarray:
    return np.full(BLOCK, level, dtype=np.float32)


def feed(u: Utterance, level: float, seconds: float, speaking: bool):
    """Run seconds of audio through, and collect whatever utterances came out."""
    out = []
    for _ in range(round(seconds / BLOCK_SEC)):
        ended = u.push(block(level), speaking)
        if ended is not None:
            out.append(ended)
    return out


def quiet(u: Utterance, seconds: float):
    return feed(u, ROOM, seconds, speaking=False)


def speech(u: Utterance, seconds: float):
    return feed(u, LOUD, seconds, speaking=True)


class WhereASentenceEndsTest(unittest.TestCase):
    def test_a_sentence_ends_when_the_room_goes_quiet(self):
        u = Utterance(sample_rate=RATE)
        self.assertEqual(speech(u, 3.0), [])
        self.assertEqual(quiet(u, SILENCE_SECS - 0.1), [])   # a pause, not an ending
        ended = quiet(u, 0.1)
        self.assertEqual(len(ended), 1)
        audio, voiced = ended[0]
        self.assertAlmostEqual(len(audio) / RATE, 3.0 + SILENCE_SECS, places=2)
        self.assertAlmostEqual(voiced, 3.0, places=2)

    def test_a_pause_inside_a_sentence_does_not_end_it(self):
        u = Utterance(sample_rate=RATE)
        speech(u, 2.0)
        self.assertEqual(quiet(u, 0.6), [])       # thinking mid-answer
        self.assertEqual(speech(u, 2.0), [])      # and carrying on
        ended = quiet(u, SILENCE_SECS)
        self.assertEqual(len(ended), 1)
        _, voiced = ended[0]
        self.assertAlmostEqual(voiced, 4.0, places=2)

    def test_silence_before_anyone_speaks_is_thrown_away(self):
        u = Utterance(sample_rate=RATE)
        self.assertEqual(quiet(u, 5.0), [])
        ended = speech(u, 1.0) + quiet(u, SILENCE_SECS)
        self.assertEqual(len(ended), 1)
        audio, _ = ended[0]
        # The five seconds nobody spoke in are not in what gets transcribed.
        self.assertAlmostEqual(len(audio) / RATE, 1.0 + SILENCE_SECS, places=2)


class ListeningBeforeYouAnswerTest(unittest.TestCase):
    def test_a_minute_of_listening_does_not_truncate_the_answer(self):
        # The regression. Someone hears out a long question, then answers.
        u = Utterance(sample_rate=RATE)
        quiet(u, MAX_UTTERANCE_SEC + 10)

        speech(u, 2.0)
        self.assertEqual(quiet(u, 0.5), [], "cut off at the first comma of the answer")
        speech(u, 2.0)
        ended = quiet(u, SILENCE_SECS)
        self.assertEqual(len(ended), 1)
        _, voiced = ended[0]
        self.assertAlmostEqual(voiced, 4.0, places=2)

    def test_the_wait_between_two_answers_does_not_count_either(self):
        u = Utterance(sample_rate=RATE)
        speech(u, 1.0)
        quiet(u, SILENCE_SECS)
        quiet(u, MAX_UTTERANCE_SEC + 10)          # listening to the next question
        self.assertEqual(u.length, 0.0)

        speech(u, 2.0)
        self.assertEqual(quiet(u, 0.5), [])
        ended = speech(u, 1.0) + quiet(u, SILENCE_SECS)
        self.assertEqual(len(ended), 1)
        _, voiced = ended[0]
        self.assertAlmostEqual(voiced, 3.0, places=2)


class TheLongAnswerCapTest(unittest.TestCase):
    def test_a_very_long_answer_is_still_capped(self):
        u = Utterance(sample_rate=RATE)
        speech(u, MAX_UTTERANCE_SEC + 1)
        # One block of quiet is enough once the answer is past the cap: it does
        # not get the usual second of silence first.
        ended = quiet(u, BLOCK_SEC)
        self.assertEqual(len(ended), 1)
        audio, _ = ended[0]
        self.assertGreater(len(audio) / RATE, MAX_UTTERANCE_SEC)

    def test_the_cap_waits_for_a_breath_rather_than_cutting_mid_word(self):
        # Deliberate: the cap is checked when the speaker pauses, so a long
        # answer is sent at a break in it and not halfway through a sentence.
        u = Utterance(sample_rate=RATE)
        self.assertEqual(speech(u, MAX_UTTERANCE_SEC + 5), [])


class ReadyForTheNextOneTest(unittest.TestCase):
    def test_nothing_is_carried_over_into_the_next_utterance(self):
        u = Utterance(sample_rate=RATE)
        speech(u, 3.0)
        quiet(u, SILENCE_SECS)
        self.assertFalse(u.started)
        self.assertEqual(u.length, 0.0)
        self.assertEqual(u.silence_time, 0.0)

        ended = speech(u, 1.0) + quiet(u, SILENCE_SECS)
        self.assertEqual(len(ended), 1)
        audio, voiced = ended[0]
        self.assertAlmostEqual(len(audio) / RATE, 1.0 + SILENCE_SECS, places=2)
        self.assertAlmostEqual(voiced, 1.0, places=2)

    def test_two_sentences_come_out_one_at_a_time(self):
        u = Utterance(sample_rate=RATE)
        ended = (speech(u, 1.0) + quiet(u, SILENCE_SECS)
                 + speech(u, 2.0) + quiet(u, SILENCE_SECS))
        self.assertEqual(len(ended), 2)
        self.assertAlmostEqual(ended[0][1], 1.0, places=2)
        self.assertAlmostEqual(ended[1][1], 2.0, places=2)


if __name__ == "__main__":
    unittest.main()
