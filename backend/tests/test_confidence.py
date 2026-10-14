import asyncio
import json
import unittest
from unittest.mock import patch

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess
from backend import confidence as conf  # noqa: E402  (must load after the DB is redirected)

# Real rows captured from a live session: the mic picked up the interviewer's audio,
# so the same words were saved under both speakers, with the app's bracket tags.
ECHO_ROWS = [
    ("interviewer", "[INTERVIEWER] 300,000,000. Yeah. Ghana Suds."),
    ("user", "[YOU] 300,000,000. Yeah. Ghana Suds."),
]
TAGGED_ROW = ("you", "[CURRENT SECTION §1: Open + set agenda] [USER said] Hello? Are you listening to me?")
# Real answer from a voice mock interview.
MOCK_ANSWER = ("you", "Yes. I can hear you. very clearly now. K. Thanks for having me. I am really glad to be "
                      "here and, um, looking forward to our conversation as well.")


def _answer(words: int, extra: str = "") -> str:
    return (extra + " " + " ".join(["data"] * words)).strip()


class BuildTurnsTest(unittest.TestCase):
    def test_strips_section_and_speaker_tags(self):
        turns = conf.build_turns([TAGGED_ROW])
        self.assertEqual(turns, [{"who": "you", "text": "Hello? Are you listening to me?"}])

    def test_user_speaker_counts_as_you(self):
        turns = conf.build_turns([("user", "[YOU] I built the pipeline myself.")])
        self.assertEqual(turns[0]["who"], "you")

    def test_drops_your_line_that_echoes_their_audio(self):
        turns = conf.build_turns(ECHO_ROWS)
        self.assertEqual([t["who"] for t in turns], ["them"])

    def test_merges_consecutive_lines_from_same_speaker(self):
        turns = conf.build_turns([("you", "First part."), ("you", "Second part."), ("interviewer", "Thanks.")])
        self.assertEqual(turns[0]["text"], "First part. Second part.")
        self.assertEqual(len(turns), 2)

    def test_ignores_unknown_speakers(self):
        self.assertEqual(conf.build_turns([("unknown", "noise"), (None, "noise")]), [])


class CountingTest(unittest.TestCase):
    def test_fillers_found_in_real_answer(self):
        self.assertEqual(conf.FILLERS.findall(MOCK_ANSWER[1]), ["um"])

    def test_word_repetitions_are_not_penalised(self):
        stutter = "So so so I I I want to to build models for for this."
        self.assertEqual(conf.FILLERS.findall(stutter), [])
        self.assertEqual(conf.HEDGES.findall(stutter), [])

    def test_hedges_do_not_double_count_fillers(self):
        text = "I think it is kind of maybe right"
        self.assertEqual([m.lower() for m in conf.HEDGES.findall(text)], ["i think", "maybe"])
        self.assertEqual(conf.FILLERS.findall(text), ["kind of"])

    def test_mhmm_is_a_filler(self):
        self.assertEqual(conf.FILLERS.findall("Mhmm. Right."), ["Mhmm"])


class BandScoreTest(unittest.TestCase):
    def test_inside_band_is_full_marks(self):
        self.assertEqual(conf.band_score(140, 120, 170, 70, 230), 100)

    def test_falls_off_linearly(self):
        self.assertEqual(conf.band_score(200, 120, 170, 70, 230), 50)
        self.assertEqual(conf.band_score(95, 120, 170, 70, 230), 50)

    def test_clamps_at_zero(self):
        self.assertEqual(conf.band_score(300, 120, 170, 70, 230), 0)
        self.assertEqual(conf.band_score(12, 0, 2, 0, 10), 0)


class SpeechMetricsTest(unittest.TestCase):
    def test_rejects_too_little_speech(self):
        with self.assertRaises(Exception):
            conf.speech_metrics([{"who": "you", "text": "Too short."}], None)

    def test_pace_missing_without_timing(self):
        m = conf.speech_metrics([{"who": "you", "text": _answer(60)}], None)
        self.assertIsNone(m["components"]["pace"]["score"])

    def test_uses_saved_timing_when_available(self):
        m = conf.speech_metrics([{"who": "you", "text": _answer(60)}], {"wpm": 145, "talk_share": 80})
        self.assertEqual(m["components"]["pace"]["score"], 100)
        self.assertEqual(m["components"]["talk_share"]["source"], "timing")
        self.assertEqual(m["components"]["talk_share"]["value"], 80)

    def test_talk_share_falls_back_to_word_share(self):
        turns = [{"who": "them", "text": _answer(60)}, {"who": "you", "text": _answer(60)}]
        share = conf.speech_metrics(turns, None)["components"]["talk_share"]
        self.assertEqual((share["value"], share["source"], share["score"]), (50, "words", 100))


class OverallTest(unittest.TestCase):
    def test_reweights_over_available_components(self):
        comps = {"fillers": {"score": 100}, "hedging": {"score": 50}, "pace": {"score": None}}
        self.assertEqual(conf.overall(comps), 75)

    def test_none_when_nothing_scored(self):
        self.assertIsNone(conf.overall({"pace": {"score": None}}))


class GenerateTest(unittest.TestCase):
    def setUp(self):
        sid = sess.create_session("Mock", "academic-phd", "", "")
        self.sid = sid
        with sess._connect() as conn:
            for speaker, text in [
                ("interviewer", "What drew you to speech research?"),
                ("you", "I think the question of why fluency varies is, um, what keeps me going, maybe more than "
                        "anything. " + _answer(30)),
                ("interviewer", "How would you model that?"),
                ("you", _answer(40, "I would extract time series features and test which context inputs predict a block.")),
            ]:
                conn.execute(
                    "INSERT INTO messages (session_id, role, speaker, content, created_at) VALUES (?, 'user', ?, ?, '')",
                    (sid, speaker, text),
                )

    def test_scores_saves_and_ignores_bad_model_entries(self):
        reply = {"answers": [{"index": 0, "score": 6, "note": "Point is buried."},
                             {"index": 1, "score": 8, "note": "Direct."},
                             {"index": 9, "score": 10, "note": "Out of range."}]}

        async def fake_model(model, system_prompt, message):
            self.assertIn("[0] QUESTION: What drew you to speech research?", message)
            return reply

        with patch("backend.routers.mock._ask_model", fake_model):
            report = asyncio.run(conf.generate_confidence(self.sid, None))

        structure = report["components"]["structure"]
        self.assertEqual((structure["value"], structure["score"], len(structure["answers"])), (7.0, 70, 2))
        self.assertIsNone(report["components"]["pace"]["score"])
        self.assertIsNotNone(report["overall"])
        self.assertEqual(conf.load_confidence(self.sid), json.loads(json.dumps(report)))


if __name__ == "__main__":
    unittest.main()
