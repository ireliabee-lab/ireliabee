"""Roadmap 1.6: a profile can be linked to a CV; switching profile switches CV."""
import unittest

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend.core import profile_store  # noqa: E402
from backend import document_store as docs  # noqa: E402
from backend import transfer  # noqa: E402
from backend.routers import profiles  # noqa: E402


def _active_cv():
    return next((c["id"] for c in docs.list_cvs() if c.get("is_active")), None)


class ProfileCvTest(unittest.TestCase):
    def setUp(self):
        with sess._connect() as conn:
            conn.execute("DELETE FROM profiles")
            conn.execute("DELETE FROM cvs")
        self.cv_a = docs.create_cv(name="Academic CV", original_filename="a.txt", mime="text/plain", content=b"a")
        self.cv_b = docs.create_cv(name="Industry CV", original_filename="b.txt", mime="text/plain", content=b"b")
        self.p1 = profile_store.create_profile("Ama")
        self.p2 = profile_store.create_profile("Ama (industry)")

    def link(self, pid, cv_id):
        return profiles.update_profile(pid, profiles.ProfileUpdateBody(cv_id=cv_id))

    def test_switching_profile_switches_cv(self):
        self.link(self.p1, self.cv_a)
        self.link(self.p2, self.cv_b)
        profiles.activate_profile(self.p2)
        self.assertEqual(_active_cv(), self.cv_b)
        out = profiles.activate_profile(self.p1)
        self.assertEqual(_active_cv(), self.cv_a)
        self.assertEqual(out["active_cv_id"], self.cv_a)

    def test_unlinked_profile_leaves_the_active_cv_alone(self):
        docs.activate_cv(self.cv_b)
        profiles.activate_profile(self.p1)
        self.assertEqual(_active_cv(), self.cv_b)

    def test_zero_unlinks(self):
        self.link(self.p1, self.cv_a)
        self.assertIsNone(self.link(self.p1, 0)["cv_id"])

    def test_deleted_cv_is_ignored_on_switch(self):
        self.link(self.p1, self.cv_a)
        docs.activate_cv(self.cv_b)
        docs.delete_cv(self.cv_a)
        out = profiles.activate_profile(self.p1)
        self.assertEqual(_active_cv(), self.cv_b)
        self.assertIsNone(out["active_cv_id"])

    def test_cv_link_never_travels_in_a_transfer_file(self):
        self.link(self.p1, self.cv_a)
        bundle = transfer.build_bundle(["profiles"])
        self.assertTrue(all("cv_id" not in p for p in bundle["data"]["profiles"]))

    def test_imported_cv_link_is_ignored(self):
        import json
        raw = json.dumps({"format": transfer.FORMAT, "version": transfer.VERSION,
                          "data": {"profiles": [{"ref": 9, "name": "Kofi", "cv_id": self.cv_a}]}}).encode()
        transfer.import_bundle(raw, ["profiles"])
        kofi = next(p for p in profile_store.list_profiles() if p["name"] == "Kofi")
        self.assertIsNone(dict(kofi)["cv_id"])


if __name__ == "__main__":
    unittest.main()
