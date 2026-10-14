"""Roadmap 1.7: the Library moves files between "my CV" and "reference file"."""
import unittest

from fastapi import HTTPException

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend.core import profile_store  # noqa: E402
from backend import document_store as docs  # noqa: E402
from backend.routers import cvs as cvs_router, documents as docs_router  # noqa: E402


class LibraryMoveTest(unittest.TestCase):
    def setUp(self):
        with sess._connect() as conn:
            for t in ("cvs", "documents", "profiles"):
                conn.execute(f"DELETE FROM {t}")

    def test_reference_file_becomes_a_cv_with_its_content(self):
        doc = docs.create_document(name="Resume 2026", original_filename="r.txt", mime="text/plain", content=b"Built payments at a bank")
        cv_id = docs_router.make_cv(doc)["cv_id"]
        self.assertIsNone(docs.get_document(doc))
        cv = docs.get_cv(cv_id, include_content=True)
        self.assertEqual((cv["name"], cv["content"], cv["is_active"]), ("Resume 2026", b"Built payments at a bank", 0))
        self.assertIn("payments", docs.get_cv_text(cv_id))

    def test_cv_becomes_a_reference_file_and_profiles_unlink(self):
        cv = docs.create_cv(name="Old CV", original_filename="o.txt", mime="text/plain", content=b"old")
        pid = profile_store.create_profile("Ama")
        profile_store.update_profile(pid, cv_id=cv)
        doc_id = cvs_router.make_document(cv)["document_id"]
        self.assertIsNone(docs.get_cv(cv))
        self.assertEqual(docs.get_document(doc_id)["name"], "Old CV")
        self.assertIsNone(dict(profile_store.get_profile(pid))["cv_id"])

    def test_moving_a_missing_file_is_a_404(self):
        with self.assertRaises(HTTPException):
            cvs_router.make_document(999)
        with self.assertRaises(HTTPException):
            docs_router.make_cv(999)


if __name__ == "__main__":
    unittest.main()
