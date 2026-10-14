"""
What the app does with audio nobody spoke into.

Whisper was trained on subtitles, so when it is handed a keyboard tap, a breath
or a second of room tone it writes what subtitles say at such moments —
"Thank you.", "Thanks for watching!", "you" — and it does so confidently. In a
live session that invented line reaches the coach as if the other person had
said it, and the user gets a paid answer to a question nobody asked.

These pin down the two rules that keep it out (core/transcribers.py):
speech too short to be a sentence is never transcribed at all, and a whole
output that is only a stock phrase, from barely any speech, is not kept.
"""
import unittest

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core.transcribers import (  # noqa: E402
    INVENTED_UP_TO_SEC, MIN_VOICED_SEC, clean_batch_text, voiced_seconds,
)

BLOCK = 0.05          # what the sound card hands over at a time
LOUD = 0.08           # someone speaking
QUIET = 0.011         # someone speaking quietly, a few feet from the laptop
ROOM = 0.002          # the room with nobody in it


def blocks(*runs):
    """(seconds, rms) pairs from (level, seconds) runs, as the buffer sees them."""
    out = []
    for level, secs in runs:
        out += [(BLOCK, level)] * round(secs / BLOCK)
    return out


class HowMuchWasSpeechTest(unittest.TestCase):
    def test_silence_is_no_speech_at_all(self):
        self.assertEqual(voiced_seconds(blocks((ROOM, 2.0))), 0.0)

    def test_a_tap_then_silence_is_a_fraction_of_a_second(self):
        # The buffer the batch path builds: one loud block, then the 1.2s
        # of quiet that ends the utterance. This is the "Thank you." case.
        self.assertAlmostEqual(voiced_seconds(blocks((LOUD, 0.05), (ROOM, 1.2))), 0.05)

    def test_a_sentence_is_seconds_of_speech(self):
        self.assertAlmostEqual(voiced_seconds(blocks((LOUD, 3.0), (ROOM, 1.2))), 3.0)

    def test_a_quiet_speaker_is_still_speaking(self):
        # The bar is well under normal speech: dropping what someone actually
        # said would be far worse than letting an invention through.
        self.assertAlmostEqual(voiced_seconds(blocks((QUIET, 2.0), (ROOM, 1.2))), 2.0)

    def test_a_slammed_door_does_not_raise_the_bar_over_the_answer(self):
        # A fixed floor, not one scaled to the loudest moment: the bang must
        # not make the quiet sentence after it look like silence.
        heard = voiced_seconds(blocks((0.6, 0.1), (QUIET, 2.0), (ROOM, 1.2)))
        self.assertAlmostEqual(heard, 2.1)


class WhatIsKeptTest(unittest.TestCase):
    def test_a_tap_is_never_transcribed_into_thanks(self):
        self.assertEqual(clean_batch_text("Thank you.", 0.05), "")

    def test_the_stock_phrases_are_dropped_however_they_are_written(self):
        for invented in ("Thank you.", "THANK YOU!", "you", "Thanks for watching!",
                         "Please subscribe", "[Music]", "(applause)", "Bye-bye."):
            self.assertEqual(clean_batch_text(invented, 1.0), "", invented)

    def test_a_real_sentence_is_kept(self):
        said = "Tell me about a time you led a project that went wrong."
        self.assertEqual(clean_batch_text(said, 3.4), said)

    def test_an_answer_that_ends_in_thank_you_is_kept(self):
        # The rule is about the whole output being a stock phrase, not about
        # the words appearing in it.
        said = "That's everything I wanted to cover — thank you."
        self.assertEqual(clean_batch_text(said, 4.0), said)

    def test_someone_really_saying_thank_you_at_length_is_kept(self):
        # Past the short-speech window we stop second-guessing the microphone.
        self.assertEqual(clean_batch_text("Thank you", INVENTED_UP_TO_SEC + 0.5), "Thank you")

    def test_nothing_heard_stays_nothing(self):
        self.assertEqual(clean_batch_text("", 3.0), "")
        self.assertEqual(clean_batch_text("   ", 3.0), "")
        self.assertEqual(clean_batch_text(None, 3.0), "")

    def test_a_real_word_from_barely_any_speech_is_not_kept(self):
        # Under the floor nothing is transcribed at all, whatever came back.
        self.assertEqual(clean_batch_text("Yes, absolutely.", MIN_VOICED_SEC - 0.01), "")

    def test_the_floor_is_low_enough_for_one_quick_word(self):
        self.assertEqual(clean_batch_text("Absolutely.", MIN_VOICED_SEC + 0.01), "Absolutely.")


if __name__ == "__main__":
    unittest.main()
