"""Wordcraft: placement, cards, the daily session, exercises, the Editor, missions, the exit and progress."""
from backend.tests import _env  # noqa: F401
import asyncio  # noqa: E402
import json  # noqa: E402
import unittest  # noqa: E402
from datetime import datetime, timedelta  # noqa: E402
from unittest import mock  # noqa: E402

from fastapi import HTTPException  # noqa: E402

from backend.routers import sessions as _sessions_router  # noqa: E402,F401
from backend import debrief as _debrief  # noqa: E402,F401
from backend import wordcraft as wc  # noqa: E402
from backend.core import sessions as sess  # noqa: E402

DAY = datetime(2026, 9, 28, 9, 0, 0)      # a Monday


def _reset():
    with sess._connect() as conn:
        for t in ("wc_track", "wc_cards", "wc_lessons", "wc_attempts", "wc_writing", "wc_days", "wc_missions",
                  "wc_cando", "wc_placements"):
            conn.execute(f"DELETE FROM {t}")
        conn.execute("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE title IN ('WC round', 'WC call'))")
        conn.execute("DELETE FROM sessions WHERE title IN ('WC round', 'WC call')")


def _realm0():
    return wc._realm(0)


class ContentTest(unittest.TestCase):
    def test_every_realm_loads_with_its_exit(self):
        realms = wc.content()["realms"]
        self.assertEqual([r["id"] for r in realms], list(range(7)))
        for r in realms:
            self.assertIn(r["exit"]["character"], wc.CHARACTERS)

    def test_placement_items_hide_the_answers(self):
        items = wc.placement_items()
        self.assertTrue(items)
        self.assertTrue(all("answer" not in it for it in items))


class PlacementTest(unittest.TestCase):
    def setUp(self):
        _reset()

    def _answers(self, right_up_to: int) -> dict:
        out = {}
        for r in wc.content()["realms"]:
            for it in r["placement"]:
                out[it["id"]] = it["answer"] if r["id"] <= right_up_to else (it["answer"] + 1) % len(it["options"])
        return out

    def test_you_start_at_the_first_realm_you_cannot_yet_do(self):
        present = [r["id"] for r in wc.content()["realms"] if r["placement"]]
        result = wc.place(self._answers(-1))
        self.assertEqual(result["realm"], present[0])
        if len(present) > 2:
            self.assertEqual(wc.place(self._answers(present[1]))["realm"], present[2])

    def test_starting_higher_brings_lower_cards_in_as_known(self):
        wc.start(1, "work", DAY)
        with sess._connect() as conn:
            known = conn.execute("SELECT COUNT(*) FROM wc_cards WHERE realm = 0 AND known = 1 AND first_seen IS NOT NULL").fetchone()[0]
            fresh = conn.execute("SELECT COUNT(*) FROM wc_cards WHERE realm >= 1 AND first_seen IS NULL").fetchone()[0]
        self.assertEqual(known, len(_realm0()["cards"]))
        self.assertEqual(fresh, sum(len(r["cards"]) for r in wc.content()["realms"] if r["id"] >= 1))
        self.assertEqual(wc.get_track()["goal"], "work")

    def test_a_realm_that_does_not_exist_is_refused(self):
        with self.assertRaises(HTTPException):
            wc.start(99)


class CardsTest(unittest.TestCase):
    def setUp(self):
        _reset()
        wc.start(0, now=DAY)

    def test_ten_new_cards_a_day_in_lesson_order(self):
        q = wc.review_queue(DAY)
        self.assertEqual(len(q["new"]), 10)
        first = _realm0()["lessons"][0]["cards"][0]
        self.assertEqual(q["new"][0]["card_id"], first)
        for c in q["new"][:4]:
            wc.review(c["id"], 2, DAY)
        self.assertEqual(len(wc.review_queue(DAY)["new"]), 6)

    def test_your_own_cards_and_no_duplicates(self):
        wc.add_card("serendipity", "a happy accident")
        with self.assertRaises(HTTPException):
            wc.add_card("Serendipity", "again")
        self.assertEqual(len(wc.list_cards(q="serendipity")), 1)


class SessionTest(unittest.TestCase):
    def setUp(self):
        _reset()
        wc.start(0, now=DAY)

    def _s(self, local=DAY):
        return wc.session(now=local, local=local)

    def _finish(self, step_id, local=DAY, **kw):
        return wc.session_step(step_id, now=local, local=local, **kw)

    def test_a_day_is_cards_then_the_lesson_step_by_step_then_the_mission(self):
        s = self._s()
        first = _realm0()["lessons"][0]
        ids = [st["id"] for st in s["steps"]]
        self.assertEqual(ids[0], "cards")
        self.assertEqual(ids[1:7], [f"lesson:{first['id']}:{p}" for p in wc.LESSON_STEPS])
        self.assertEqual(ids[-1], "mission")
        drills = next(st for st in s["steps"] if st["kind"] == "wc_drills")
        self.assertEqual(len(drills["drills"]), len(first["drills"]))
        intro = next(st for st in s["steps"] if st["kind"] == "wc_intro")
        self.assertEqual([c["id"] for c in intro["cards"]], first["cards"])
        self.assertFalse(next(st for st in s["steps"] if st["kind"] == "wc_write")["editor"])   # realm 0: no Editor yet

    def test_finishing_the_day_scores_the_exercises_and_counts_the_lesson(self):
        s = self._s()
        first = _realm0()["lessons"][0]
        results = [True] * (len(first["drills"]) - 1) + [False]
        for st in s["steps"]:
            kw = {}
            if st["kind"] == "wc_drills":
                kw["results"] = results
            if st["kind"] == "wc_write":
                kw["answer"] = "Hello, my name is Ama."
            s = self._finish(st["id"], **kw)
        self.assertTrue(s["complete"])
        self.assertEqual(s["streak"], 1)
        done = wc.lessons_done()[first["id"]]
        self.assertAlmostEqual(done["drill_score"], round(sum(results) / len(results), 3))
        self.assertEqual(done["answer"], "Hello, my name is Ama.")

    def test_not_yet_sends_you_back_to_the_reading_and_exercises(self):
        s = self._s()
        lid = _realm0()["lessons"][0]["id"]
        for part in ("intro", "read", "drills", "write", "speak"):
            self._finish(f"lesson:{lid}:{part}", results=[True] if part == "drills" else None)
        back = self._finish(f"lesson:{lid}:check", done=False)
        done = {st["id"] for st in back["steps"] if st["done"]}
        self.assertIn(f"lesson:{lid}:write", done)
        self.assertNotIn(f"lesson:{lid}:drills", done)
        self.assertNotIn(lid, wc.lessons_done())

    def test_one_mission_step_a_week_and_keep_going(self):
        s = self._s()
        for st in s["steps"]:
            self._finish(st["id"])
        tomorrow = DAY + timedelta(days=1)
        nxt = wc.session(now=tomorrow, local=tomorrow)
        self.assertNotIn("mission", [st["id"] for st in nxt["steps"]])
        more = wc.session_more(now=DAY, local=DAY)
        second = _realm0()["lessons"][1]["id"]
        self.assertEqual(more["steps"][more["current"]]["id"], f"lesson:{second}:intro")

    def test_a_rest_day_keeps_the_streak_once_a_week(self):
        for back in (4, 3, 1):                         # Thursday, Friday, then Sunday: Saturday was a rest
            d = DAY - timedelta(days=back)
            s = wc.session(now=d, local=d)
            for st in s["steps"]:
                wc.session_step(st["id"], now=d, local=d)
        self.assertEqual(wc.streak(DAY - timedelta(days=1)), 3)
        missed_two = DAY + timedelta(days=2)
        self.assertEqual(wc.streak(missed_two), 0)     # two days off in a row breaks it


class EditorTest(unittest.TestCase):
    def setUp(self):
        _reset()
        wc.start(2, now=DAY)

    def test_the_editor_keeps_only_what_the_app_shows(self):
        raw = {"score": "8", "strengths": ["Clear order", "", "Good linking"], "extra": "x",
               "focus": {"look_at": "the verb", "quote": "I go yesterday", "better": "I went yesterday", "why": "past"},
               "next": "Try because."}
        with mock.patch("backend.routers.mock._ask_model", new=mock.AsyncMock(return_value=raw)) as ask:
            lid = wc._realm(2)["lessons"][0]["id"] if wc._realm(2)["lessons"] else ""
            out = asyncio.run(wc.check_writing("I go to the market yesterday and I buy fruit.", lid))
        self.assertEqual(out["score"], 8.0)
        self.assertEqual(out["strengths"], ["Clear order", "Good linking"])
        self.assertEqual(out["focus"]["better"], "I went yesterday")
        self.assertNotIn("extra", out)
        system = ask.call_args.args[1]
        self.assertIn("A2", system)
        self.assertIn("Never mark repeated words", system)
        self.assertEqual(wc.list_writing()[0]["score"], 8.0)

    def test_nonsense_from_the_model_is_made_safe(self):
        out = wc.clean_feedback({"score": "lots", "strengths": "no", "focus": {"better": ""}})
        self.assertIsNone(out["score"])
        self.assertIsNone(out["focus"])
        self.assertEqual(wc.clean_feedback(None)["strengths"], [])

    def test_too_little_to_check_is_refused_before_any_ai_call(self):
        with mock.patch("backend.routers.mock._ask_model", new=mock.AsyncMock()) as ask:
            with self.assertRaises(HTTPException):
                asyncio.run(wc.check_writing("Hi"))
            ask.assert_not_called()


class ExitAndMissionTest(unittest.TestCase):
    def setUp(self):
        _reset()
        wc.start(0, now=DAY)

    def _round(self, character, score, real=False):
        sid = sess.create_session("WC call" if real else "WC round", "general")
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET tags = ?, created_at = ? WHERE id = ?",
                         ("" if real else f"mock,interview,{character}", wc._iso(DAY + timedelta(hours=1)), sid))
        return sid

    def test_the_exit_needs_lessons_recall_exercises_and_a_conversation(self):
        realm = _realm0()
        status = wc.exit_status(0)
        self.assertFalse(status["passed"])
        self.assertEqual({c["id"] for c in status["checks"]}, {"lessons", "recall", "drills", "talk"})
        for lesson in realm["lessons"]:
            wc.record_drills(lesson["id"], [True] * len(lesson["drills"]))
            wc.mark_lesson(lesson["id"])
        for c in wc.list_cards(realm=0):
            wc.review(c["id"], 2, DAY)
        sid = self._round("wc_guide", 8)
        sess.append_message(sid, "assistant", "**Score: 8/10** Clear and complete.")
        status = wc.exit_status(0)
        self.assertTrue(status["passed"], status["checks"])
        track = wc.advance()
        self.assertEqual(track["realm"], 1)

    def test_advancing_early_is_refused(self):
        with self.assertRaises(HTTPException):
            wc.advance()

    def test_a_phrase_mission_counts_phrases_used_in_real_calls_only(self):
        with sess._connect() as conn:
            conn.execute("INSERT INTO wc_missions (week, kind, target, created_at) VALUES (?,?,?,?)",
                         (wc._week(DAY), "phrases", 2, "x"))
        phrases = [c for c in wc.list_cards(kind="phrase") if len(c["text"].split()) >= 2][:3]
        for c in phrases:
            wc.review(c["id"], 2, DAY)
        real = self._round("", 0, real=True)
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET created_at = ? WHERE id = ?", (wc._iso(DAY), real))
        sess.append_message(real, "user", f"Well, {phrases[0]['text']} And also {phrases[1]['text']}", speaker="user")
        practice = self._round("wc_guide", 0)
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET created_at = ? WHERE id = ?", (wc._iso(DAY), practice))
        sess.append_message(practice, "user", phrases[2]["text"], speaker="user")
        m = wc.mission(DAY)
        self.assertEqual(m["progress"], 2)
        self.assertTrue(m["done"])
        self.assertNotIn(phrases[2]["text"], m["found"])


class ProgressTest(unittest.TestCase):
    def setUp(self):
        _reset()
        wc.start(0, now=DAY)

    def test_mtld_needs_enough_words_and_rewards_variety(self):
        self.assertIsNone(wc.mtld("too short"))
        repetitive = " ".join(["the cat sat on the mat"] * 20)
        varied = ("Every morning I walk to the station, buy fresh bread from a small bakery, read the news on my phone, "
                  "and think about what the day might bring. Sometimes my neighbour joins me; we talk about football, "
                  "gardens, prices, children, holidays and whatever else crosses our minds before the train arrives.")
        self.assertGreater(wc.mtld(varied), wc.mtld(repetitive))

    def test_text_measures_count_sentences_and_joins(self):
        m = wc.text_measures("I was tired. Although it rained, we walked because the bus was late.")
        self.assertEqual(m["sentences"], 2)
        self.assertEqual(m["joins_per_sentence"], 1.0)

    def test_can_do_ratings_and_progress(self):
        out = wc.rate_cando(0, [3, 4, 2, 9])
        items = out["cando"][0]["items"]
        self.assertEqual([i["rating"] for i in items[:4]], [3, 4, 2, 4])     # clamped to 1-4
        self.assertEqual(len(out["skills"]), 6)
        self.assertIn("recall", out["cards"])


class TransferTest(unittest.TestCase):
    def setUp(self):
        _reset()

    def test_wordcraft_moves_to_another_computer_and_what_is_here_wins(self):
        from backend import transfer
        wc.start(1, "work", DAY)
        card = wc.review_queue(DAY)["new"][0]
        wc.review(card["id"], 3, DAY)
        lesson = wc._realm(1)["lessons"][0]
        wc.record_drills(lesson["id"], [True, False])
        wc.mark_lesson(lesson["id"], "My answer.")
        wc.rate_cando(1, [2, 3])
        raw = json.dumps(transfer.build_bundle(["wordcraft"])).encode()
        _reset()
        out = transfer.import_bundle(raw, ["wordcraft"])
        self.assertGreater(out["report"]["wordcraft"]["imported"], 100)
        self.assertEqual(wc.get_track()["realm"], 1)
        moved = next(c for c in wc.list_cards() if c["card_id"] == card["card_id"])
        self.assertEqual(moved["last_grade"], 3)
        self.assertEqual(wc.lessons_done()[lesson["id"]]["answer"], "My answer.")
        again = transfer.import_bundle(raw, ["wordcraft"])
        self.assertEqual(again["report"]["wordcraft"]["imported"], 0)


if __name__ == "__main__":
    unittest.main()
