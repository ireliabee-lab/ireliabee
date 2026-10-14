"""
Each thread keeps one database connection (opening one cost ~15 ms on Windows).
These pin down that sharing it changes nothing a caller can see.
"""
import sqlite3
import threading
import unittest

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend import document_store as ds  # noqa: E402


class KeptConnectionTest(unittest.TestCase):
    def test_a_thread_gets_its_connection_back(self):
        with sess._connect() as a:
            pass
        with sess._connect() as b:
            pass
        self.assertIs(a, b)

    def test_threads_do_not_share_one(self):
        with sess._connect() as mine:
            pass
        theirs = []
        t = threading.Thread(target=lambda: theirs.append(sess._connect()))
        t.start()
        t.join()
        self.assertIsNot(mine, theirs[0])

    def test_a_nested_block_gets_its_own_transaction(self):
        sid = sess.create_session(title="outer", mode="m")
        try:
            with sess._connect() as outer:
                outer.execute("UPDATE sessions SET title = 'changed, then undone' WHERE id = ?", (sid,))
                with sess._connect() as inner:          # e.g. a helper called mid-transaction
                    self.assertIsNot(inner, outer)
                raise RuntimeError("the outer block fails")
        except RuntimeError:
            pass
        self.assertEqual(sess.get_session(sid)["title"], "outer", "the outer block's work rolled back whole")

    def test_closing_it_drops_unfinished_work_but_keeps_it_open(self):
        # reading.py holds connections and calls close(), as it did before.
        sid = sess.create_session(title="kept", mode="m")
        conn = sess._connect()
        conn.execute("UPDATE sessions SET title = 'never committed' WHERE id = ?", (sid,))
        conn.close()
        self.assertEqual(sess.get_session(sid)["title"], "kept")
        with sess._connect() as again:
            self.assertEqual(again.execute("SELECT 1").fetchone()[0], 1)

    def test_it_is_set_up_for_speed_and_a_bounded_log(self):
        with sess._connect() as conn:
            self.assertEqual(conn.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(conn.execute("PRAGMA synchronous").fetchone()[0], 1)          # NORMAL
            self.assertEqual(conn.execute("PRAGMA journal_size_limit").fetchone()[0], 16 * 1024 * 1024)


def _covers_expression_columns() -> bool:
    """
    Whether this SQLite can answer an indexed *expression* from the index alone.

    Probed rather than read off a version number: the release that gained it is
    not something to guess, and the answer is one query away. Ubuntu 22.04 ships
    3.37, which cannot, and reports "USING INDEX" where a newer library reports
    "USING COVERING INDEX".
    """
    probe = sqlite3.connect(":memory:")
    try:
        probe.execute("CREATE TABLE t (a INTEGER, b TEXT)")
        probe.execute("CREATE INDEX i ON t (a, substr(b, 1, 4))")
        plan = " ".join(r[3] for r in probe.execute(
            "EXPLAIN QUERY PLAN SELECT a, substr(b, 1, 4) FROM t INDEXED BY i"))
        return "COVERING INDEX" in plan
    finally:
        probe.close()


class DocumentReadsTest(unittest.TestCase):
    def test_lists_and_lookups_never_read_the_files(self):
        # The file sits before the dates in each row; these must be answered from the index.
        with sess._connect() as conn:
            plan = lambda q, *a: " ".join(r[3] for r in conn.execute("EXPLAIN QUERY PLAN " + q, a))
            self.assertIn("COVERING INDEX idx_documents_meta",
                          plan(f"SELECT {ds._DOC_META} FROM {ds._DOC_FROM} ORDER BY d.updated_at DESC"))
            self.assertIn("COVERING INDEX idx_documents_meta",
                          plan(f"SELECT {ds._DOC_META} FROM {ds._DOC_FROM} WHERE d.id = ?", 1))
            # CVs keep their preview as an expression in the index —
            # substr(extracted_text, 1, 201) — rather than in a column of their
            # own the way documents do. Older SQLite cannot answer an expression
            # from an index, so it walks the rows: "USING INDEX", not "USING
            # COVERING INDEX". It is a real difference, not a wording one, and on
            # Ubuntu 22.04's 3.37 the CV list does read the rows.
            #
            # So: the index must be used everywhere, and the stronger promise is
            # asserted wherever this SQLite can keep it. Asked of the library
            # itself rather than of a version number, because the version this
            # arrived in is not something to guess at.
            cv_plan = plan(f"SELECT {ds._CV_META} FROM cvs INDEXED BY idx_cvs_meta "
                           "ORDER BY is_active DESC, updated_at DESC")
            self.assertIn("idx_cvs_meta", cv_plan)
            if _covers_expression_columns():
                self.assertIn("COVERING INDEX idx_cvs_meta", cv_plan)

    def test_big_files_can_still_be_written_in_pieces(self):
        # reading.py stores uploads through a blob handle; an index on an expression
        # anywhere on the table would make SQLite refuse it.
        did = ds.create_document(name="Blob", original_filename="b.pdf", mime="application/pdf", content=b"%PDF" + bytes(64))
        with sess._connect() as conn:
            with conn.blobopen("documents", "content", did) as blob:
                blob.write(b"%PDF-1.7")
        ds.delete_document(did)

    def test_previews_follow_the_text(self):
        did = ds.create_document(name="P", original_filename="p.txt", mime="text/plain", content=b"first words")
        self.assertEqual(ds.get_document(did)["extracted_text_preview"], "first words")
        with sess._connect() as conn:                        # as reading.py does when a PDF has been read
            conn.execute("UPDATE documents SET extracted_text = ? WHERE id = ?", ("y" * 250, did))
        self.assertEqual(ds.get_document(did)["extracted_text_preview"], "y" * 200 + "…")
        ds.delete_document(did)
        with sess._connect() as conn:
            self.assertIsNone(conn.execute("SELECT 1 FROM document_previews WHERE document_id = ?", (did,)).fetchone())

    def test_a_document_reads_the_same_without_its_file(self):
        did = ds.create_document(name="Notes", original_filename="n.txt", mime="text/plain",
                                 content=("x" * 300).encode())
        doc = ds.get_document(did)
        self.assertEqual(doc["extracted_text_preview"], "x" * 200 + "…")
        self.assertNotIn("content", doc)
        self.assertEqual([d["id"] for d in ds.list_documents() if d["id"] == did], [did])
        ds.delete_document(did)

    def test_reference_text_is_kept_whole(self):
        # SQLite's text functions stop at a NUL; the coach must still see the whole file,
        # and whitespace is trimmed as Python trims it.
        nul = ds.create_document(name="Nul", original_filename="a.txt", mime="text/plain",
                                 content=("abc" + chr(0) + "def ").encode() * 50)
        wide = ds.create_document(name="Wide", original_filename="b.txt", mime="text/plain",
                                  content="　 ideographic 　".encode())
        out = ds.documents_context([nul, wide], budget=5000)
        self.assertIn("def", out)
        self.assertIn("REFERENCE FILE: Wide\nideographic", out)
        self.assertEqual(out, ds.documents_context([nul, wide], budget=5000), "the cached turn is the same")
        ds.rename_document(wide, "Renamed")
        self.assertIn("REFERENCE FILE: Renamed", ds.documents_context([wide], budget=5000))
        ds.delete_document(nul)
        ds.delete_document(wide)


if __name__ == "__main__":
    unittest.main()
