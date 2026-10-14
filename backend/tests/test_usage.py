import unittest
from datetime import date, timedelta

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend import usage  # noqa: E402
from backend import transfer  # noqa: E402


def _wipe():
    with sess._connect() as conn:
        conn.execute("DELETE FROM usage_counts")


class UsageTest(unittest.TestCase):
    def setUp(self):
        _wipe()

    def _totals(self, days=90):
        return {e["event"]: e["total"] for e in usage.summary(days)["events"]}

    def test_counts_accumulate_per_event(self):
        for _ in range(3):
            usage.record("view:plans")
        usage.record("session.listen")
        self.assertEqual(self._totals(), {"view:plans": 3, "session.listen": 1})

    def test_most_used_first_with_active_days(self):
        today = date.today()
        usage.record("view:plans", today)
        usage.record("view:plans", today - timedelta(days=1))
        usage.record("view:warmup", today)
        events = usage.summary()["events"]
        self.assertEqual(events[0]["event"], "view:plans")
        self.assertEqual(events[0]["active_days"], 2)
        self.assertEqual(events[0]["last_day"], today.isoformat())

    def test_window_excludes_old_days(self):
        usage.record("view:notes", date.today() - timedelta(days=200))
        usage.record("view:notes")
        self.assertEqual(self._totals(days=30), {"view:notes": 1})

    def test_free_text_and_junk_names_are_ignored(self):
        for bad in ("", "Has Spaces", "<script>", "x" * 80, "UPPER", "../etc"):
            usage.record(bad)
            self.assertFalse(usage.valid_event(bad), bad)
        self.assertEqual(self._totals(), {})

    def test_counts_never_travel_in_a_transfer_file(self):
        usage.record("view:plans")
        bundle = transfer.build_bundle(transfer.SECTIONS)
        # No usage section, and no recorded event anywhere in the file. (The word itself can
        # appear in ordinary text, such as a research term's definition.)
        self.assertFalse(any("usage" in key for key in bundle["data"]))
        self.assertNotIn("view:plans", str(bundle))


if __name__ == "__main__":
    unittest.main()
