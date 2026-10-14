"""Roadmap 1.3: Progress shows saved confidence scores; fillers are counted one way."""
import json
import re
import unittest
from pathlib import Path

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend import confidence  # noqa: E402
from backend import debrief  # noqa: E402,F401  (adds sessions.debrief_json)
from backend.routers import sessions as sessions_router  # noqa: E402,F401  (adds sessions.delivery_json)
from backend.routers import progress  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


class ProgressConfidenceTest(unittest.TestCase):
    def setUp(self):
        with sess._connect() as conn:
            conn.execute("DELETE FROM messages")
            conn.execute("DELETE FROM sessions")

    def _session(self, title: str, overall):
        sid = sess.create_session(title, "live", "", "")
        if overall is not None:
            with sess._connect() as conn:
                conn.execute("UPDATE sessions SET confidence_json = ? WHERE id = ?",
                             (json.dumps({"overall": overall, "components": {}}), sid))
        return sid

    def test_confidence_scores_are_charted_and_summarised(self):
        for i, score in enumerate([50, 55, 60, 70, 75, 80]):
            self._session(f"S{i}", score)
        self._session("Never scored", None)

        data = progress.get_progress()

        self.assertEqual([c["confidence"] for c in data["confidence"]], [50, 55, 60, 70, 75, 80])
        self.assertEqual(data["summary"]["avg_confidence"], 68.0)          # last five
        self.assertEqual(data["summary"]["confidence_change"], 20.0)       # latest 3 vs the 3 before

    def test_no_scores_means_no_confidence_trend(self):
        self._session("Unscored", None)
        data = progress.get_progress()
        self.assertEqual(data["confidence"], [])
        self.assertIsNone(data["summary"]["avg_confidence"])

    def test_live_filler_counter_uses_the_scorers_word_list(self):
        src = (REPO / "frontend" / "src" / "lib" / "delivery.tsx").read_text(encoding="utf-8")
        m = re.search(r"const FILLERS = /(.+)/gi;", src)
        self.assertIsNotNone(m, "FILLERS regex not found in delivery.tsx")
        self.assertEqual(m.group(1), confidence.FILLERS.pattern)


class WarmupStreakTest(unittest.TestCase):
    """Roadmap 1.4: a finished warm-up counts as a practice day."""

    def setUp(self):
        from backend import usage
        self.usage = usage
        with sess._connect() as conn:
            conn.execute("DELETE FROM messages")
            conn.execute("DELETE FROM sessions")
            conn.execute("DELETE FROM usage_counts")

    def test_warmups_keep_the_streak_going(self):
        from datetime import date, timedelta
        today = date.today()
        self.usage.record("practice.warmup.done", today)
        self.usage.record("practice.warmup.done", today - timedelta(days=1))
        self.usage.record("view:plans", today - timedelta(days=2))   # opening a screen isn't practice
        self.assertEqual(progress.get_progress()["summary"]["streak_days"], 2)


if __name__ == "__main__":
    unittest.main()
