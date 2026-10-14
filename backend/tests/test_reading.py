"""Reading notes (spec 185): upload, per-page reading, structure, scope, estimate, generation, coverage, cache."""
import asyncio
import io
import json
import re
import threading
import time
import unittest
from unittest import mock

from fastapi import HTTPException

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend import reading, notebook, document_store  # noqa: E402
from backend.routers import reading as reading_router, documents as documents_router, mock as mock_router  # noqa: E402


def make_pdf(pages, bookmarks=None) -> bytes:
    """A real PDF: one text page per item. `bookmarks`: {page_index: [(title, level)]}."""
    from fpdf import FPDF

    pdf = FPDF(format="A4")
    pdf.set_font("Helvetica", size=11)
    for i, text in enumerate(pages):
        pdf.add_page()
        for title, level in (bookmarks or {}).get(i, []):
            pdf.start_section(title, level=level)
        if text:
            pdf.multi_cell(0, 6, text)
    return bytes(pdf.output())


def scanned_pdf(n=3) -> bytes:
    from fpdf import FPDF

    pdf = FPDF(format="A4")
    for _ in range(n):
        pdf.add_page()
        pdf.rect(20, 20, 150, 200, style="F")      # a "page image": drawing, no text
    return bytes(pdf.output())


BODY = ("Photosynthesis converts light energy into chemical energy stored in glucose. "
        "The light reactions happen in the thylakoid membranes and release oxygen. ") * 4


def wait_read(doc_id, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        st = reading.status(doc_id)
        if st["state"] != "reading":
            return st
        time.sleep(0.05)
    raise AssertionError("reading did not finish")


def upload(data: bytes, name="paper.pdf") -> int:
    return reading.save_upload(io.BytesIO(data), name)


PAPER = [
    "A Study of Leaves\nAbstract\n" + BODY,
    "1 Introduction\n" + BODY,
    "2 Methods\n" + BODY,
    "3 Results\nYield rose by 12.5% at 25 C.\n" + BODY,
    "4 Discussion\n" + BODY,
    "References\n[1] Smith, J. (2020). Leaves. Journal of Plants 4, 1-9.\n[2] Doe, A. (2019). Light.",
]

BOOK_MARKS = {0: [("Preface", 0)], 1: [("Chapter 1 Cells", 0)], 3: [("1.1 Membranes", 1)],
              4: [("Chapter 2 Energy", 0)], 6: [("References", 0)]}
BOOK = [BODY] * 7


# ── A fake model: lists points per page, covers only some of them ───────────

class FakeModel:
    def __init__(self, cover_fraction=0.5):
        self.cover_fraction = cover_fraction
        self.calls = []
        self.lock = threading.Lock()

    async def __call__(self, model, system, message, document_id, **_):
        with self.lock:
            self.calls.append((system, message))
        await asyncio.sleep(0)
        if system.startswith(reading.EXTRACT_PROMPT[:40]):
            pages = [int(p) for p in re.findall(r"\[p\. (\d+)\]", message)]
            points = []
            for p in pages:
                points += [
                    {"text": f"Core fact from page {p}", "kind": "claim", "importance": "core", "pages": [p]},
                    {"text": f"Supporting step from page {p}", "kind": "method", "importance": "supporting", "pages": [p, 999]},
                    {"text": f"Small detail on page {p}", "kind": "claim", "importance": "detail", "pages": [p]},
                    {"text": f"Core fact from page {p}", "kind": "claim", "importance": "core", "pages": [p]},  # duplicate
                ]
            points.append({"text": "Enzyme", "kind": "definition", "term": "RuBisCO", "importance": "core", "pages": pages[:1]})
            return {"points": points}
        if system.startswith(reading.FRAME_PROMPT[:40]):
            return {"title": "Deck title", "summary": "What it covers.", "cues": ["Why?", "How?"]}
        ids = re.findall(r"^(P\d+) \[(\w+)\] \(p\. ([\d, ]+)\)", message, re.M)
        take = ids[: max(1, int(len(ids) * self.cover_fraction))]
        blocks = [{"type": "point", "text": f"About {pid}", "src": [int(pages.split(",")[0])], "covers": [pid]}
                  for pid, _imp, pages in take]
        out = {"slides": [{"title": "First slide", "pages": [1, 2], "blocks": blocks},
                          {"title": "Empty slide", "blocks": [{"type": "point", "text": "  ", "covers": ["P9999"]}]}]}
        if '"title": "a short title for the deck"' in system:
            out.update(title="Leaves, briefly", summary="A study of leaves.", cues=["What rose?"])
        return out

    def extract_calls(self):
        return [c for c in self.calls if c[0].startswith(reading.EXTRACT_PROMPT[:40])]


def run(coro):
    return asyncio.run(coro)


async def run_job(**kw):
    job = {"done": 0, "total": 0, "step": ""}
    return await reading.generate(job, **kw), job


class Pages(unittest.TestCase):
    def test_page_ranges(self):
        self.assertEqual(reading.parse_pages("12–14, 20", 50), [12, 13, 14, 20])
        self.assertEqual(reading.parse_pages("3 to 5; pp. 7", 50), [3, 4, 5, 7])
        self.assertEqual(reading.parse_pages("9-7", 50), [7, 8, 9])
        for bad in ("abc", "0-3", "40-60", "", "1-2-3"):
            with self.assertRaises(HTTPException, msg=bad):
                reading.parse_pages(bad, 50)

    def test_windows_keep_pages_whole_and_consecutive(self):
        texts = {p: "x" * 6000 for p in range(1, 8)}
        ws = reading.windows([1, 2, 3, 5, 6, 7], texts)
        self.assertEqual(ws, [[1, 2], [3], [5, 6], [7]])
        self.assertTrue(all(len(w) <= reading.WINDOW_PAGES for w in ws))


class Upload(unittest.TestCase):
    def test_a_paper_is_stored_and_read_page_by_page(self):
        doc_id = upload(make_pdf(PAPER))
        st = wait_read(doc_id)
        self.assertEqual(st["state"], "ready", st)
        self.assertEqual(st["pages"], 6)
        texts = reading.page_texts(doc_id)
        self.assertIn("Yield rose by 12.5%", texts[4])
        self.assertNotIn("Yield rose", texts[3])                    # page boundaries kept
        self.assertIn("Photosynthesis", document_store.get_document_text(doc_id))  # the Library sees the text
        # the original bytes are intact
        stored = b"".join(document_store.iter_document(doc_id))
        self.assertTrue(stored.startswith(b"%PDF"))

    def test_refuses_what_it_cannot_read(self):
        with self.assertRaises(HTTPException) as e:
            upload(b"hello", "notes.txt")
        self.assertEqual(e.exception.status_code, 400)
        with self.assertRaises(HTTPException) as e:
            upload(b"not a pdf at all", "fake.pdf")
        self.assertEqual(e.exception.detail["title"], "Not a valid PDF")
        with self.assertRaises(HTTPException):
            upload(b"", "empty.pdf")

    def test_size_limit_is_checked_while_streaming(self):
        with mock.patch.object(reading, "MAX_UPLOAD_MB", 0.001):          # about 1 KB
            with self.assertRaises(HTTPException) as e:
                upload(make_pdf(PAPER))
        self.assertEqual(e.exception.detail["title"], "File too large")

    def test_a_scanned_pdf_is_refused_not_summarised(self):
        doc_id = upload(scanned_pdf())
        st = wait_read(doc_id)
        self.assertEqual(st["state"], "scanned")
        self.assertIn("page images", st["error"])
        with self.assertRaises(HTTPException):
            reading.resolve_scope(doc_id, {"mode": "all"})

    def test_page_limit(self):
        with mock.patch.object(reading, "MAX_PAGES", 3):
            st = wait_read(upload(make_pdf(PAPER)))
        self.assertEqual(st["state"], "failed")
        self.assertIn("limit is 3", st["error"])

    def test_reading_can_be_cancelled(self):
        gate = threading.Event()
        real = reading._clean_text

        def slow(text):
            gate.wait(5)
            return real(text)

        with mock.patch.object(reading, "_clean_text", side_effect=slow):
            doc_id = upload(make_pdf(BOOK))
            reading.cancel_reading(doc_id)
            gate.set()
            st = wait_read(doc_id)
        self.assertEqual(st["state"], "cancelled")

    def test_deleting_while_reading_leaves_nothing_behind(self):
        gate = threading.Event()
        real = reading._clean_text

        def slow(text):
            gate.wait(5)
            return real(text)

        with mock.patch.object(reading, "_clean_text", side_effect=slow):
            doc_id = upload(make_pdf(BOOK))
            document_store.delete_document(doc_id)
            gate.set()
            for _ in range(200):
                t = reading._running.get(doc_id)
                if not t or not t.is_alive():
                    break
                time.sleep(0.02)
        with sess._connect() as conn:
            for table in ("document_pages", "document_outline", "document_reading"):
                n = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE document_id = ?", (doc_id,)).fetchone()[0]
                self.assertEqual(n, 0, table)

    def test_an_old_library_pdf_can_be_read(self):
        doc_id = document_store.create_document("Old", "old.pdf", "application/pdf", make_pdf(PAPER[:2]))
        self.assertEqual(reading.status(doc_id)["state"], "new")
        reading.start_reading(doc_id)
        self.assertEqual(wait_read(doc_id)["state"], "ready")
        txt = document_store.create_document("Notes", "notes.txt", "text/plain", b"plain text")
        with self.assertRaises(HTTPException):
            reading.start_reading(txt)


class Structure(unittest.TestCase):
    def test_bookmarks_give_chapters_and_mark_references(self):
        doc_id = upload(make_pdf(BOOK, BOOK_MARKS), "book.pdf")
        st = wait_read(doc_id)
        self.assertEqual(st["source"], "bookmarks")
        ol = {e["title"]: e for e in st["outline"]}
        self.assertEqual((ol["Chapter 1 Cells"]["page_from"], ol["Chapter 1 Cells"]["page_to"]), (2, 4))
        self.assertEqual(ol["1.1 Membranes"]["level"], 2)
        self.assertEqual((ol["1.1 Membranes"]["page_from"], ol["1.1 Membranes"]["page_to"]), (4, 4))
        self.assertEqual(ol["References"]["kind"], "references")
        self.assertEqual(ol["Chapter 2 Energy"]["page_to"], 6)

    def test_headings_found_in_a_paper_without_bookmarks(self):
        doc_id = upload(make_pdf(PAPER))
        st = wait_read(doc_id)
        self.assertEqual(st["source"], "headings")
        self.assertEqual(st["kind"], "paper")
        titles = [e["title"] for e in st["outline"]]
        for t in ("Abstract", "1 Introduction", "2 Methods", "3 Results", "References"):
            self.assertIn(t, titles)
        refs = next(e for e in st["outline"] if e["title"] == "References")
        self.assertEqual((refs["page_from"], refs["kind"]), (6, "references"))
        self.assertEqual(st["suggested"], {"mode": "all"})

    def test_kind_of_titles(self):
        self.assertEqual(reading.kind_of("7 References"), "references")
        self.assertEqual(reading.kind_of("Appendix B: Proofs"), "appendix")
        self.assertEqual(reading.kind_of("Acknowledgments"), "acknowledgements")
        self.assertEqual(reading.kind_of("Referencing styles in practice".replace("Referencing", "Results")), "")


class Author(unittest.TestCase):
    def _pdf(self, author, title="A Study of Leaves"):
        from fpdf import FPDF
        pdf = FPDF(format="A4")
        pdf.set_author(author)
        pdf.set_title(title)
        pdf.set_font("Helvetica", size=11)
        for text in PAPER:
            pdf.add_page()
            pdf.multi_cell(0, 6, text)
        return bytes(pdf.output())

    def test_the_pdfs_author_goes_on_the_deck(self):
        doc = upload(self._pdf("Ama Mensah and Kofi Boateng"))
        st = wait_read(doc)
        self.assertEqual((st["author"], st["doc_title"]), ("Ama Mensah and Kofi Boateng", "A Study of Leaves"))
        with mock.patch.object(reading, "_ask", new=FakeModel()),              mock.patch("backend.errors.resolve_llm", return_value=("m", "anthropic")):
            nb, _ = run(run_job(document_id=doc, scope={"mode": "all"}, template="brief"))
        self.assertEqual(nb["doc"]["author"], "Ama Mensah and Kofi Boateng")
        self.assertIn("*Ama Mensah and Kofi Boateng*", notebook.to_markdown(nb))

    def test_tool_names_are_not_authors(self):
        st = wait_read(upload(self._pdf("Microsoft Word", "Document1.docx")))
        self.assertEqual((st["author"], st["doc_title"]), ("", ""))

    def test_the_author_is_kept_when_edited(self):
        nb = notebook.create_notebook("lecture", "Week 3")
        saved = notebook.update_notebook(nb["id"], nb["version"], doc={**nb["doc"], "author": "Dr. Mensah"})
        self.assertEqual(saved["doc"]["author"], "Dr. Mensah")


class Scope(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.paper = upload(make_pdf(PAPER))
        cls.book = upload(make_pdf(BOOK, BOOK_MARKS), "book.pdf")
        wait_read(cls.paper)
        wait_read(cls.book)

    def test_whole_paper_leaves_out_the_references(self):
        plan = reading.resolve_scope(self.paper, {"mode": "all"})
        self.assertEqual(plan["pages"], [1, 2, 3, 4, 5])
        self.assertEqual(plan["left_out"], ["References"])
        self.assertIn("without references", plan["label"])

    def test_chapters_and_pages(self):
        st = reading.status(self.book)
        ch1 = next(e for e in st["outline"] if e["title"] == "Chapter 1 Cells")
        plan = reading.resolve_scope(self.book, {"mode": "chapters", "chapters": [ch1["idx"]]})
        self.assertEqual(plan["pages"], [2, 3, 4])
        self.assertEqual([u["title"] for u in plan["units"]], ["Chapter 1 Cells"])
        plan = reading.resolve_scope(self.book, {"mode": "pages", "pages": "1-2, 6"})
        self.assertEqual(plan["pages"], [1, 2, 6])
        with self.assertRaises(HTTPException):
            reading.resolve_scope(self.book, {"mode": "chapters", "chapters": []})
        self.assertEqual(st["suggested"]["mode"], "chapters")      # a book: one chapter at a time

    def test_a_run_is_capped(self):
        with mock.patch.object(reading, "RUN_PAGE_CAP", 2), self.assertRaises(HTTPException) as e:
            reading.resolve_scope(self.paper, {"mode": "all"})
        self.assertIn("up to 2 pages", e.exception.detail["message"])

    RATES = {"creditsPerUsd": 2, "perMillionTokensUsd": {"fast": {"in": 1, "out": 5}, "careful": {"in": 2, "out": 10}}}

    def test_estimate_before_anything_is_spent(self):
        from backend.core import hosted
        with mock.patch.object(hosted, "rates", return_value=self.RATES),              mock.patch.object(hosted, "is_admin", return_value=False):
            est = reading.estimate(self.paper, {"mode": "all"}, "research", "claude-sonnet-5")
        self.assertEqual(est["pages"], 5)
        self.assertGreaterEqual(est["calls"], 2)
        self.assertGreater(est["tokens"]["input"], 0)
        self.assertIsNotNone(est["usd"])
        self.assertEqual(est["cached_windows"], 0)
        # An ordinary account is shown the service's price in credits (decision 185-1):
        # careful tier at $2/$10 per million, 2 credits per dollar.
        want = (est["tokens"]["input"] * 2 + est["tokens"]["output"] * 10) / 1e6 * 2
        self.assertAlmostEqual(est["credits"], round(want, 2), places=2)

    def test_the_admin_sees_dollars_not_credits(self):
        from backend.core import hosted
        with mock.patch.object(hosted, "rates", return_value=self.RATES),              mock.patch.object(hosted, "is_admin", return_value=True):
            est = reading.estimate(self.paper, {"mode": "all"}, "research", "claude-haiku-4-5")
        self.assertIsNone(est["credits"])
        self.assertIsNotNone(est["usd"])

    def test_no_price_is_shown_when_the_service_prices_are_unknown(self):
        from backend.core import hosted
        with mock.patch.object(hosted, "rates", return_value=None),              mock.patch.object(hosted, "is_admin", return_value=False):
            est = reading.estimate(self.paper, {"mode": "all"}, "research", "claude-haiku-4-5")
        self.assertIsNone(est["credits"], "never a guessed price")


class Rates(unittest.TestCase):
    def test_credits_follow_the_service_formula_and_tier(self):
        from backend.core import hosted
        with mock.patch.object(hosted, "rates", return_value=Scope.RATES):
            self.assertAlmostEqual(hosted.credits_for("claude-haiku-4-5", 1_000_000, 0), 2.0)   # fast: $1 x 2
            self.assertAlmostEqual(hosted.credits_for("claude-sonnet-5", 0, 1_000_000), 20.0)   # careful: $10 x 2

    def test_a_tier_without_a_price_gives_no_number(self):
        from backend.core import hosted
        rates = {"creditsPerUsd": 2, "perMillionTokensUsd": {"fast": None}}
        with mock.patch.object(hosted, "rates", return_value=rates):
            self.assertIsNone(hosted.credits_for("claude-haiku-4-5", 1000, 1000))

    def test_the_price_list_is_cached_and_survives_an_outage(self):
        from backend.core import hosted
        ok = mock.Mock(status_code=200, **{"json.return_value": {"rates": Scope.RATES}})
        ok.raise_for_status = mock.Mock()
        hosted._RATES.update(at=0.0, value=None)
        with mock.patch("requests.get", return_value=ok) as get:
            self.assertEqual(hosted.rates(), Scope.RATES)
            hosted.rates()
            self.assertEqual(get.call_count, 1, "cached")
            self.assertTrue(get.call_args[0][0].endswith("/api/checkout"))
            self.assertNotIn("/v1/api", get.call_args[0][0])
        hosted._RATES["at"] = 0.0
        with mock.patch("requests.get", side_effect=OSError("offline")):
            self.assertEqual(hosted.rates(), Scope.RATES, "the last good copy")
        hosted._RATES.update(at=0.0, value=None)


class Generate(unittest.TestCase):
    def setUp(self):
        self.doc = upload(make_pdf(PAPER))
        wait_read(self.doc)
        self.model = FakeModel()
        self.ask = mock.patch.object(reading, "_ask", new=self.model)
        self.ask.start()
        self.llm = mock.patch("backend.errors.resolve_llm", return_value=("claude-sonnet-5", "anthropic"))
        self.llm.start()
        from backend.core import hosted
        rates = mock.patch.object(hosted, "rates", return_value=None)      # no network in tests
        rates.start()
        self.addCleanup(rates.stop)

    def tearDown(self):
        self.ask.stop()
        self.llm.stop()

    def test_every_key_point_is_in_the_deck(self):
        nb, job = run(run_job(document_id=self.doc, scope={"mode": "all"}, template="research"))
        self.assertEqual(nb["kind"], "reading")
        self.assertEqual(nb["document_id"], self.doc)
        self.assertEqual(nb["title"], "Leaves, briefly")
        cov = nb["coverage"]
        # 5 pages × (1 core + 1 supporting) + the one definition every page repeats: duplicates are merged
        # within a section and across sections; details don't count
        self.assertEqual(cov["core_total"] + cov["supporting_total"], 11)
        self.assertEqual(cov["covered"], cov["required"])
        self.assertGreater(cov["added_by_check"], 0)                 # the model skipped some; the check put them back
        self.assertLess(cov["by_ai_pct"], 100)
        self.assertEqual(cov["left_out"], ["References"])
        text = json.dumps(nb["doc"])
        # Each required point is on a slide: named by the model ("About P3") or added in full by the check.
        more = [s for s in nb["doc"]["sections"] if s["title"].startswith("More from")]
        self.assertTrue(more)
        self.assertEqual(sum(len(s["blocks"]) for s in more), cov["added_by_check"])
        self.assertNotIn("Small detail", json.dumps(more))              # details are never forced in
        for s in nb["doc"]["sections"]:
            for b in s["blocks"]:
                self.assertTrue(all(1 <= p <= 6 for p in b["src"]), b)   # pages stay inside the document
        self.assertNotIn("Empty slide", [s["title"] for s in nb["doc"]["sections"]])

    def test_points_the_check_adds_keep_their_kind(self):
        d = reading.point_block({"text": "attaches CO2", "kind": "definition", "term": "RuBisCO", "importance": "core", "pages": [3]})
        self.assertEqual((d["type"], d["term"], d["src"]), ("definition", "RuBisCO", [3]))
        self.assertEqual(reading.point_block({"text": "x", "kind": "claim", "importance": "core", "pages": [1]})["type"], "key")
        self.assertEqual(reading.point_block({"text": "x", "kind": "warning", "importance": "core", "pages": [1]})["type"], "unclear")
        self.assertEqual(reading.point_block({"text": "x", "kind": "definition", "importance": "supporting", "pages": [1]})["type"], "point")

    def test_a_second_template_reuses_the_reading(self):
        run(run_job(document_id=self.doc, scope={"mode": "all"}, template="research"))
        first = len(self.model.extract_calls())
        self.assertGreater(first, 0)
        est = reading.estimate(self.doc, {"mode": "all"}, "brief", "claude-sonnet-5")
        self.assertEqual(est["cached_windows"], est["windows"])      # the estimate knows it's already read
        run(run_job(document_id=self.doc, scope={"mode": "all"}, template="brief"))
        self.assertEqual(len(self.model.extract_calls()), first)      # no second extraction bill

    def test_rewrite_keeps_the_old_deck_as_a_version(self):
        nb, _ = run(run_job(document_id=self.doc, scope={"mode": "all"}, template="research"))
        again, _ = run(run_job(document_id=self.doc, scope={"mode": "pages", "pages": "1-2"}, template="brief",
                               notebook_id=nb["id"]))
        self.assertEqual(again["id"], nb["id"])
        self.assertEqual(again["version"], nb["version"] + 1)
        self.assertEqual(again["template"], "brief")
        self.assertEqual(len(notebook.list_versions(nb["id"])), 1)
        self.assertEqual(reading.decks_for(self.doc)[0]["id"], nb["id"])

    def test_rewrite_right_after_an_edit_keeps_the_edit(self):
        """Review 11-1: the snapshot before a rewrite is forced, not throttled like autosave."""
        nb, _ = run(run_job(document_id=self.doc, scope={"mode": "all"}, template="research"))
        doc = nb["doc"]
        doc["sections"][0]["title"] = "My own heading"
        edited = notebook.update_notebook(nb["id"], nb["version"], doc=doc)              # snapshot: the AI's deck
        edited = notebook.update_notebook(nb["id"], edited["version"], title="Renamed")  # within 5 min: not snapshotted
        run(run_job(document_id=self.doc, scope={"mode": "all"}, template="brief", notebook_id=nb["id"]))
        kept = [notebook.get_notebook(nb["id"])]
        with sess._connect() as conn:
            docs = [json.loads(r["doc_json"]) for r in conn.execute(
                "SELECT doc_json FROM notebook_versions WHERE notebook_id = ?", (nb["id"],))]
        self.assertTrue(any(d["sections"] and d["sections"][0]["title"] == "My own heading" for d in docs),
                        "the edited deck must be restorable after a rewrite")
        titles = {r["title"] for r in notebook.list_versions(nb["id"])}
        self.assertIn("Renamed", titles, "the latest save, not just the one before it")
        self.assertTrue(kept)

    def test_long_documents_are_composed_in_parts_with_a_cover(self):
        with mock.patch.object(reading, "COMPOSE_POINTS", 4):
            nb, _ = run(run_job(document_id=self.doc, scope={"mode": "all"}, template="textbook"))
        self.assertEqual(nb["title"], "Deck title")                   # from the separate cover call
        self.assertEqual(nb["doc"]["cues"], ["Why?", "How?"])
        self.assertEqual(nb["coverage"]["covered"], nb["coverage"]["required"])

    def test_prompts_never_carry_the_users_cv_or_persona(self):
        with mock.patch.object(mock_router, "_candidate_context", side_effect=AssertionError("persona used")):
            run(run_job(document_id=self.doc, scope={"mode": "all"}, template="research", tutor=True))
        for system, message in self.model.calls:
            self.assertNotIn("CV", message)
        compose = [s for s, _ in self.model.calls if s.startswith(reading.COMPOSE_PROMPT[:40])]
        self.assertTrue(all("tutor" in s for s in compose))


class Review(unittest.TestCase):
    """Fixes from the Phase 5 code review."""

    def test_coverage_is_counted_from_the_slides_kept(self):
        doc = upload(make_pdf(PAPER))
        wait_read(doc)
        with mock.patch.object(reading, "_ask", new=FakeModel(cover_fraction=0.5)), \
             mock.patch("backend.errors.resolve_llm", return_value=("m", "anthropic")), \
             mock.patch.dict(notebook.LIMITS, {"reading_sections": 1}):
            nb, _ = run(run_job(document_id=doc, scope={"mode": "all"}, template="brief"))
        cov = nb["coverage"]
        self.assertEqual(len(nb["doc"]["sections"]), 1)
        self.assertGreater(cov["dropped_slides"], 0)
        self.assertLess(cov["covered"], cov["required"])          # honest, not "100%"

    def test_a_long_deck_survives_its_first_save(self):
        sections = [{"title": f"Slide {i}", "blocks": [{"type": "point", "text": "x", "src": [1]}]} for i in range(150)]
        made = notebook.create_notebook("reading", title="Book", doc={"sections": sections})
        self.assertEqual(len(made["doc"]["sections"]), 150)
        saved = notebook.update_notebook(made["id"], made["version"], doc=made["doc"])
        self.assertEqual(len(saved["doc"]["sections"]), 150)

    def test_streamed_files_can_be_read_across_threads(self):
        data = make_pdf(PAPER)
        doc = upload(data)
        wait_read(doc)
        chunks = document_store.iter_document(doc, chunk=512)
        got = [next(chunks)]
        out = []
        t = threading.Thread(target=lambda: out.extend(chunks))  # the rest on another thread, like Starlette does
        t.start(); t.join(10)
        self.assertEqual(b"".join(got + out), data)

    def test_one_reader_per_document(self):
        doc_id = document_store.create_document("Twice", "twice.pdf", "application/pdf", make_pdf(PAPER[:2]))
        started = []
        real = reading._start_thread
        with mock.patch.object(reading, "_start_thread", side_effect=lambda d, p: (started.append(d), real(d, p))):
            ts = [threading.Thread(target=reading.start_reading, args=(doc_id,)) for _ in range(4)]
            [t.start() for t in ts]
            [t.join(10) for t in ts]
        self.assertEqual(started.count(doc_id), 1)
        self.assertEqual(wait_read(doc_id)["state"], "ready")

    def test_the_ai_limit_is_shared_by_every_job(self):
        docs = [upload(make_pdf([BODY * 3] * 6)) for _ in range(2)]
        [wait_read(d) for d in docs]
        live, peak = [0], [0]
        lock = threading.Lock()

        def slow_respond(provider, model, text, history, system, max_tokens):
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
            time.sleep(0.05)
            with lock:
                live[0] -= 1
            if system.startswith(reading.EXTRACT_PROMPT[:40]):
                return json.dumps({"points": [{"text": "A point", "importance": "core", "pages": [1]}]})
            return json.dumps({"title": "T", "summary": "S", "cues": [], "slides": [
                {"title": "S", "blocks": [{"type": "point", "text": "x", "src": [1], "covers": ["P1"]}]}]})

        async def both():
            return await asyncio.gather(*[run_job(document_id=d, scope={"mode": "all"}, template="brief") for d in docs])

        with mock.patch.object(reading, "WINDOW_PAGES", 1), \
             mock.patch.object(mock_router, "respond", side_effect=slow_respond), \
             mock.patch.object(mock_router, "resolve_llm", return_value=("m", "anthropic")):
            run(both())
        self.assertLessEqual(peak[0], notebook.MAX_PARALLEL)

    def test_a_failure_stops_the_other_calls(self):
        doc = upload(make_pdf([BODY * 3] * 8))
        wait_read(doc)
        calls = [0]
        from backend.errors import FriendlyError

        async def failing(model, system, message, document_id, **_):
            calls[0] += 1
            await asyncio.sleep(0.01 if calls[0] == 1 else 0.3)
            if calls[0] == 1:
                raise FriendlyError("rate_limited", "Busy", "Try again.")
            return {"points": []}

        with mock.patch.object(reading, "_ask", new=failing), mock.patch.object(reading, "WINDOW_PAGES", 1):
            with self.assertRaises(FriendlyError):
                run(run_job(document_id=doc, scope={"mode": "all"}, template="brief"))
        self.assertLessEqual(calls[0], notebook.MAX_PARALLEL)     # nothing new started after the failure


class Calls(unittest.TestCase):
    """The real call path: metered under "reading", never more than three at once."""

    def test_concurrency_and_metering(self):
        doc = upload(make_pdf([BODY * 3] * 12))
        wait_read(doc)
        from backend.core import providers
        live, peak, kinds = [0], [0], []
        lock = threading.Lock()

        def slow_respond(provider, model, text, history, system, max_tokens):
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
                kinds.append(getattr(providers._context, "value", None))
            time.sleep(0.05)
            with lock:
                live[0] -= 1
            if system.startswith(reading.EXTRACT_PROMPT[:40]):
                return json.dumps({"points": [{"text": "A point", "importance": "core", "pages": [1]}]})
            return json.dumps({"title": "T", "summary": "S", "cues": [], "slides": [
                {"title": "S", "blocks": [{"type": "point", "text": "x", "src": [1], "covers": ["P1"]}]}]})

        with mock.patch.object(reading, "WINDOW_PAGES", 1), \
             mock.patch.object(mock_router, "respond", side_effect=slow_respond), \
             mock.patch.object(mock_router, "resolve_llm", return_value=("m", "anthropic")):
            nb, _ = run(run_job(document_id=doc, scope={"mode": "all"}, template="brief"))
        self.assertLessEqual(peak[0], reading.MAX_PARALLEL)
        self.assertGreater(len(kinds), 3)
        self.assertTrue(all(k and k[0] == "reading" for k in kinds))


class Api(unittest.TestCase):
    def test_generate_is_a_pro_feature_and_checks_the_scope_first(self):
        from backend.entitlements import require_pro
        with self.assertRaises(HTTPException):
            require_pro("notebook")()                                  # signed out
        doc = upload(make_pdf(PAPER))
        wait_read(doc)
        body = reading_router.GenerateBody(document_id=doc, scope={"mode": "pages", "pages": "90-99"})
        with _env.pro(), self.assertRaises(HTTPException) as e:
            run(reading_router.generate(body))
        self.assertEqual(e.exception.status_code, 400)

    def test_a_job_runs_in_the_background_and_reports(self):
        doc = upload(make_pdf(PAPER))
        wait_read(doc)
        model = FakeModel(cover_fraction=1.0)

        async def go():
            with mock.patch.object(reading, "_ask", new=model), \
                 mock.patch("backend.errors.resolve_llm", return_value=("claude-sonnet-5", "anthropic")):
                job = await reading_router.generate(reading_router.GenerateBody(document_id=doc, scope={"mode": "all"}))
                self.assertEqual(job["state"], "running")
                for _ in range(200):
                    view = reading_router.job(job["id"])
                    if view["state"] != "running":
                        return view
                    await asyncio.sleep(0.01)
            raise AssertionError("job did not finish")

        with _env.pro():
            view = run(go())
        self.assertEqual(view["state"], "done", view)
        self.assertEqual(notebook.get_notebook(view["notebook_id"])["kind"], "reading")
        self.assertNotIn("_task", view)

    def test_a_failing_model_fails_the_job_with_a_friendly_error(self):
        doc = upload(make_pdf(PAPER))
        wait_read(doc)
        from backend.errors import FriendlyError

        async def boom(*a, **k):
            raise FriendlyError("no_model", "No AI model selected", "Choose one in Settings.", "settings")

        async def go():
            with mock.patch.object(reading, "_ask", side_effect=boom):
                job = reading.start_job(lambda j: reading.generate(j, doc, {"mode": "all"}, "research"), doc)
                for _ in range(200):
                    view = reading.job_view(job["id"])
                    if view["state"] != "running":
                        return view
                    await asyncio.sleep(0.01)

        view = run(go())
        self.assertEqual(view["state"], "failed")
        self.assertEqual(view["error"]["code"], "no_model")

    def test_deleting_the_document_keeps_the_notes(self):
        doc = upload(make_pdf(PAPER))
        wait_read(doc)
        with mock.patch.object(reading, "_ask", new=FakeModel()), \
             mock.patch("backend.errors.resolve_llm", return_value=("m", "anthropic")):
            nb, _ = run(run_job(document_id=doc, scope={"mode": "all"}, template="brief"))
        documents_router.delete(doc)
        with sess._connect() as conn:
            for table in ("document_pages", "document_outline", "reading_extracts", "document_reading"):
                self.assertEqual(conn.execute(f"SELECT COUNT(*) FROM {table} WHERE document_id = ?", (doc,)).fetchone()[0], 0)
        self.assertEqual(notebook.get_notebook(nb["id"])["title"], nb["title"])

    def test_big_files_are_streamed(self):
        data = make_pdf(PAPER)
        doc = upload(data)
        wait_read(doc)
        with mock.patch.object(documents_router, "STREAM_OVER", 10):
            resp = documents_router.view_file(doc)

        async def body():
            return b"".join([c async for c in resp.body_iterator])

        self.assertEqual(type(resp).__name__, "StreamingResponse")
        self.assertEqual(run(body()), data)
        self.assertEqual(resp.headers["content-length"], str(len(data)))


if __name__ == "__main__":
    unittest.main()
