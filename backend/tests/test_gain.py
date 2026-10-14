"""
Quiet speech has to be transcribed too (core/gain.py).

Measured on the owner's laptop: ordinary speech into the microphone array
arrives at about -35 dBFS, while the same conversation's call audio arrives at
about -17 dBFS. The fixed 0.015 bar for "someone is speaking" sat inside the
microphone's own speech band, so the app heard him only when he raised his
voice — in an interview, the one thing he cannot do.

These pin down both halves: the level speech is brought to, and the bar for
noticing it in the first place.
"""
import math
import unittest

import numpy as np

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core.gain import MAX_GAIN, TARGET_RMS, AutoGain  # noqa: E402

RATE = 16000
BLOCK = 800                     # 50 ms, as the sound card delivers it
BLOCKS_PER_SEC = RATE // BLOCK


def tone(rms: float, blocks: int = 1, seed: int = 0) -> list:
    """Blocks of noise at a given level — speech is close enough to noise for this."""
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(blocks):
        block = rng.normal(0.0, rms, BLOCK).astype(np.float32)
        out.append(block)
    return out


def rms_of(block: np.ndarray) -> float:
    return float(np.sqrt(np.mean(block.astype(np.float32) ** 2)))


def run(agc: AutoGain, blocks) -> list:
    return [agc.push(b) for b in blocks]


class BringingSpeechUpTest(unittest.TestCase):
    def test_a_quiet_speaker_is_brought_up_to_a_level_worth_transcribing(self):
        # -35 dBFS: what the laptop microphone actually delivers.
        agc = AutoGain()
        out = run(agc, tone(0.017, BLOCKS_PER_SEC * 2))
        ended = rms_of(out[-1])
        self.assertGreater(ended, TARGET_RMS * 0.7, "still too quiet to hear reliably")
        self.assertLess(ended, TARGET_RMS * 1.4, "overshot the target")

    def test_it_gets_there_within_about_a_second(self):
        # Longer than this and the opening words of an answer are lost.
        agc = AutoGain()
        out = run(agc, tone(0.017, BLOCKS_PER_SEC))
        self.assertGreater(rms_of(out[-1]), TARGET_RMS * 0.6)

    def test_audio_that_is_already_loud_enough_is_left_alone(self):
        # Call audio at -17 dBFS needs nothing done to it.
        agc = AutoGain()
        blocks = tone(0.14, BLOCKS_PER_SEC * 2)
        out = run(agc, blocks)
        self.assertAlmostEqual(agc.gain, 1.0, places=2)
        self.assertAlmostEqual(rms_of(out[-1]), rms_of(blocks[-1]), places=3)

    def test_it_never_boosts_past_what_is_reasonable(self):
        agc = AutoGain()
        run(agc, tone(0.00005, BLOCKS_PER_SEC * 6))     # very nearly nothing
        self.assertLessEqual(agc.gain, MAX_GAIN)

    def test_nothing_ever_comes_out_clipped(self):
        agc = AutoGain()
        for block in tone(0.02, BLOCKS_PER_SEC * 3):
            block[10] = 0.9                              # a knock on the desk
            out = agc.push(block)
            self.assertLessEqual(float(np.abs(out).max()), 1.0)

    def test_a_loud_word_after_a_quiet_stretch_is_not_squared_off(self):
        # The gain follows how loud someone has *been*, so the first loud word
        # arrives with the quiet setting still applied. Clipped speech
        # transcribes worse than quiet speech, so it must be turned down, not
        # flattened.
        agc = AutoGain()
        run(agc, tone(0.008, BLOCKS_PER_SEC * 2))        # a quiet passage: gain climbs
        self.assertGreater(agc.gain, 3.0)
        shout = tone(0.3, BLOCKS_PER_SEC, seed=11)
        flattened = 0
        for block in shout:
            out = agc.push(block)
            flattened += int((np.abs(out) >= 0.999).sum())
        self.assertLess(flattened / (BLOCK * len(shout)), 0.001,
                        "the loud words came out as distortion")

    def test_silence_is_not_amplified_into_noise(self):
        # An empty room must not creep up to full gain: that only hands the
        # transcriber louder nothing, which is what it invents words about.
        agc = AutoGain()
        run(agc, tone(0.0004, BLOCKS_PER_SEC * 10))
        self.assertLessEqual(agc.gain, 1.5, "the room was quietly turned into a noise source")

    def test_a_room_with_the_odd_noise_in_it_is_not_turned_up(self):
        # What the new meter caught on its first run: sitting in a quiet room
        # with nobody speaking, the app reported "boosted x24". A click, a
        # chair or a keystroke crosses the speech bar for a block or two, and
        # that was enough to be taken for how loud this person speaks.
        agc = AutoGain()
        blocks = []
        for i in range(BLOCKS_PER_SEC * 8):
            knock = i % 40 == 0                       # something every two seconds
            blocks += tone(0.05 if knock else 0.002, 1, seed=i)
        run(agc, blocks)
        self.assertLess(agc.gain, 2.0, f"an empty room was amplified {agc.gain:.0f}x")

    def test_speech_that_goes_on_is_still_believed(self):
        # The other half: a real sentence must still raise the level.
        agc = AutoGain()
        run(agc, tone(0.002, BLOCKS_PER_SEC * 2, seed=20))      # the room first
        run(agc, tone(0.017, BLOCKS_PER_SEC * 2, seed=21))      # then someone talks
        self.assertGreater(agc.gain, 2.0)

    def test_the_gain_holds_when_the_speaking_stops(self):
        agc = AutoGain()
        run(agc, tone(0.017, BLOCKS_PER_SEC * 2, seed=22))
        while_talking = agc.gain
        run(agc, tone(0.002, BLOCKS_PER_SEC * 4, seed=23))      # a long pause
        self.assertLessEqual(agc.gain, while_talking + 0.01, "the pause was turned up")

    def test_the_level_moves_smoothly_rather_than_jumping(self):
        agc = AutoGain()
        seen = [1.0]
        for block in tone(0.01, BLOCKS_PER_SEC * 3):
            agc.push(block)
            seen.append(agc.gain)
        jumps = [b / a for a, b in zip(seen, seen[1:]) if a > 0]
        self.assertLess(max(jumps), 2.0, "the gain stepped, which is an audible click")

    def test_a_loud_speaker_after_a_quiet_one_is_brought_back_down(self):
        agc = AutoGain()
        run(agc, tone(0.01, BLOCKS_PER_SEC * 2))          # quiet: gain goes up
        raised = agc.gain
        out = run(agc, tone(0.2, BLOCKS_PER_SEC * 3))     # then someone shouts
        self.assertLess(agc.gain, raised)
        self.assertLessEqual(rms_of(out[-1]), 0.5)


class NoticingSomeoneSpeakingTest(unittest.TestCase):
    def test_quiet_speech_in_a_quiet_room_counts_as_speaking(self):
        agc = AutoGain()
        run(agc, tone(0.002, BLOCKS_PER_SEC * 2, seed=1))      # the room
        floor_bar = agc.threshold()
        agc.push(tone(0.017, 1, seed=2)[0])                    # ordinary speech
        self.assertTrue(agc.speaking, f"speech at 0.017 missed a bar of {floor_bar:.4f}")

    def test_the_room_on_its_own_is_not_speaking(self):
        agc = AutoGain()
        run(agc, tone(0.002, BLOCKS_PER_SEC * 3, seed=3))
        self.assertFalse(agc.speaking)

    def test_a_noisier_room_raises_the_bar_without_losing_speech(self):
        quiet, noisy = AutoGain(), AutoGain()
        run(quiet, tone(0.001, BLOCKS_PER_SEC * 3, seed=4))
        run(noisy, tone(0.008, BLOCKS_PER_SEC * 3, seed=5))
        self.assertGreater(noisy.threshold(), quiet.threshold())
        # …and normal speech still clears it in the noisy room.
        noisy.push(tone(0.03, 1, seed=6)[0])
        self.assertTrue(noisy.speaking)

    def test_the_old_fixed_bar_is_what_the_user_was_fighting(self):
        # The regression this exists for: at 0.015, half of ordinary microphone
        # speech reads as silence. The measured bar must sit well below it.
        agc = AutoGain()
        run(agc, tone(0.002, BLOCKS_PER_SEC * 2, seed=7))
        self.assertLess(agc.threshold(), 0.015)

    def test_a_dead_silent_room_does_not_make_every_breath_speech(self):
        agc = AutoGain()
        run(agc, tone(0.00001, BLOCKS_PER_SEC * 2, seed=8))
        self.assertGreaterEqual(agc.threshold(), 0.001)

    def test_it_reports_what_it_is_hearing(self):
        agc = AutoGain()
        run(agc, tone(0.017, BLOCKS_PER_SEC, seed=9))
        told = agc.describe()
        self.assertEqual(sorted(told), ["floor", "gain", "level", "speech"])
        self.assertTrue(all(isinstance(v, float) and math.isfinite(v) for v in told.values()))


class EdgesTest(unittest.TestCase):
    def test_an_empty_block_is_handed_straight_back(self):
        agc = AutoGain()
        empty = np.zeros(0, dtype=np.float32)
        self.assertIs(agc.push(empty), empty)

    def test_digital_silence_does_not_divide_by_zero(self):
        agc = AutoGain()
        for _ in range(20):
            out = agc.push(np.zeros(BLOCK, dtype=np.float32))
        self.assertTrue(np.all(out == 0.0))
        self.assertTrue(math.isfinite(agc.gain))


if __name__ == "__main__":
    unittest.main()
