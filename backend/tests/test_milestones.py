"""Milestones and activity for the Research track and Wordcraft."""
from backend.tests import _env  # noqa: F401
import json  # noqa: E402
import unittest  # noqa: E402
from datetime import date, datetime, timedelta  # noqa: E402

from backend.routers import sessions as _sessions_router  # noqa: E402,F401
from backend import debrief as _debrief  # noqa: E402,F401
from backend import milestones as ms  # noqa: E402
from backend import research_track as rt  # noqa: E402
from backend import wordcraft as wc  # noqa: E402
from backend.core import sessions as sess  # noqa: E402


def _reset():
    with sess._connect() as conn:
        for t in ("wc_track", "wc_cards", "wc_lessons", "wc_attempts", "wc_writing", "wc_days", "wc_missions",
                  "wc_cando", "wc_placements", "research_track", "term_cards", "paper_cards", "research_lessons",
                  "research_evidence", "research_projects", "research_sprints", "research_days", "track_milestones"):
            conn.execute(f"DELETE FROM {t}")


def _finished_days(table: str, days: list[date]) -> None:
    with sess._connect() as conn:
        for d in days:
            conn.execute(f"INSERT INTO {table} (day, steps_json, done_json, answers_json, completed_at, created_at) "
                         "VALUES (?,?,?,'{{}}',?,?)", (d.isoformat(), json.dumps(["cards"]), json.dumps(["cards"]),
                                                       d.isoformat() + "T12:00:00", d.isoformat() + "T08:00:00"))


def _keys(items: list[dict]) -> set[str]:
    return {m["key"] for m in items}


class RunsTest(unittest.TestCase):
    def test_best_run_of_consecutive_days(self):
        days = {"2026-09-01", "2026-09-02", "2026-09-03", "2026-09-05", "2026-09-06"}
        self.assertEqual(ms._runs(days)[0], 3)
        self.assertEqual(ms._runs(set()), (0, 0))


class WordcraftMilestonesTest(unittest.TestCase):
    def setUp(self):
        _reset()
        wc.start(0)

    def _lesson(self, i: int = 0) -> str:
        return wc._realm(0)["lessons"][i]["id"]

    def test_first_lesson_is_celebrated_once(self):
        self.assertEqual(wc.milestones()["pending"], [])           # the first look: nothing yet
        wc.mark_lesson(self._lesson())
        pending = wc.milestones()["pending"]
        self.assertEqual(_keys(pending), {"lessons:1"})
        self.assertEqual(pending[0]["title"], "First lesson done")
        wc.milestones_seen(["lessons:1"])
        self.assertEqual(wc.milestones()["pending"], [])
        self.assertIn("lessons:1", _keys(wc.milestones()["earned"]))

    def test_progress_from_before_milestones_is_filed_quietly(self):
        wc.mark_lesson(self._lesson(0))
        wc.mark_lesson(self._lesson(1))
        self.assertEqual(wc.milestones()["pending"], [])           # already had progress: no pile of old confetti
        self.assertIn("lessons:1", _keys(wc.milestones()["earned"]))
        for i in range(2, 5):
            wc.mark_lesson(self._lesson(i))
        self.assertEqual(_keys(wc.milestones()["pending"]), {"lessons:5"})

    def test_a_week_in_a_row_earns_the_streak_milestones(self):
        wc.milestones()
        today = date.today()
        _finished_days("wc_days", [today - timedelta(days=i) for i in range(7)])
        keys = _keys(wc.milestones()["pending"])
        self.assertTrue({"streak:3", "streak:7", "days:1"} <= keys)
        self.assertNotIn("streak:14", keys)
        big = {m["key"]: m["big"] for m in wc.milestones()["pending"]}
        self.assertFalse(big["streak:3"])
        self.assertTrue(big["streak:7"])

    def test_a_new_realm_is_a_big_moment(self):
        wc.milestones()
        now = wc._iso(wc._now())
        with sess._connect() as conn:
            conn.execute("UPDATE wc_track SET realm = 1, realm_at = ? WHERE id = 1", (now,))
        pending = {m["key"]: m for m in wc.milestones()["pending"]}
        self.assertIn("realm:1", pending)
        self.assertTrue(pending["realm:1"]["big"])
        self.assertIn(wc._realm(1)["name"], pending["realm:1"]["title"])

    def test_realms_skipped_by_placement_are_not_celebrated(self):
        _reset()
        wc.start(2)
        self.assertFalse({"realm:1", "realm:2"} & _keys(wc.milestones()["earned"]))

    def test_activity_has_the_calendar_weeks_and_realms(self):
        today = date.today()
        _finished_days("wc_days", [today, today - timedelta(days=1), today - timedelta(days=3)])
        wc.mark_lesson(self._lesson())
        act = wc.activity()
        self.assertEqual(act["today"], today.isoformat())
        self.assertEqual(len(act["weeks"]), 12)
        self.assertEqual(act["days_finished"], 3)
        self.assertEqual(act["best_streak"], max(2, act["streak"]))
        self.assertEqual(act["climb"][-1]["total"], 1)
        self.assertTrue(any(d["day"] == today.isoformat() and d["complete"] for d in act["days"]))
        self.assertEqual([lv["id"] for lv in act["levels"]], list(range(7)))
        self.assertEqual(act["levels"][0]["done"], 1)
        self.assertEqual(act["levels"][0]["state"], "current")

    def test_activity_measures_first_try_accuracy_by_week(self):
        wc.record_drills(self._lesson(), [True, True, False, True])
        this_week = wc.activity()["weeks"][-1]
        n = min(4, len(wc._realm(0)["lessons"][0]["drills"]))
        self.assertEqual(this_week["exercises"], n)
        self.assertIsNotNone(this_week["accuracy"])


class ResearchMilestonesTest(unittest.TestCase):
    def setUp(self):
        _reset()
        rt.start_track("ecology", "curious")

    def test_first_lesson_and_levels(self):
        rt.milestones()
        rt.mark_lesson(rt.content()["levels"][0]["lessons"][0]["id"])
        self.assertIn("lessons:1", _keys(rt.milestones()["pending"]))
        now = rt._iso(rt._now())
        with sess._connect() as conn:
            conn.execute("UPDATE research_track SET level = 1, level_at = ? WHERE id = 1", (now,))
        pending = {m["key"]: m for m in rt.milestones()["pending"]}
        self.assertTrue(pending["level:1"]["big"])

    def test_activity_lists_every_level(self):
        rt.mark_lesson(rt.content()["levels"][0]["lessons"][0]["id"])
        act = rt.activity()
        self.assertEqual(len(act["levels"]), len(rt.content()["levels"]))
        self.assertEqual(act["levels"][0]["done"], 1)
        self.assertEqual(act["lessons_finished"], 1)


class DayDetailTest(unittest.TestCase):
    def setUp(self):
        _reset()
        wc.start(0)

    def test_a_day_folds_each_lesson_into_one_line(self):
        today = date.today()
        lesson = wc._realm(0)["lessons"][0]
        with sess._connect() as conn:
            steps = ["cards"] + [f"lesson:{lesson['id']}:{p}" for p in wc.LESSON_STEPS] + ["mission"]
            conn.execute("INSERT INTO wc_days (day, steps_json, done_json, answers_json, completed_at, created_at) "
                         "VALUES (?,?,?,'{}',NULL,?)", (today.isoformat(), json.dumps(steps),
                                                        json.dumps(steps[:3]), today.isoformat() + "T08:00:00"))
        wc.mark_lesson(lesson["id"])
        d = wc.activity_day(today.isoformat())
        self.assertTrue(d["planned"])
        self.assertFalse(d["complete"])
        self.assertEqual([s["kind"] for s in d["steps"]], ["cards", "lesson", "mission"])
        self.assertEqual(d["steps"][0]["label"], "Word cards")
        self.assertEqual(d["steps"][1]["label"], lesson["title"])
        self.assertEqual((d["steps"][1]["done"], d["steps"][1]["total"]), (2, len(wc.LESSON_STEPS)))
        self.assertEqual(d["lessons"], [{"id": lesson["id"], "title": lesson["title"]}])

    def test_an_empty_or_bad_day(self):
        self.assertFalse(wc.activity_day("2020-01-01")["planned"])
        self.assertEqual(rt.activity_day("not-a-day")["steps"], [])


if __name__ == "__main__":
    unittest.main()
