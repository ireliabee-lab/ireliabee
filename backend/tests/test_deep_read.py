"""Deep Read, B1 (docs/notebook-book-and-deep-read.md, Part B): chapter by chapter, a map, and a glossary in learning order."""
import json
import re
import unittest
from unittest import mock

from fastapi import HTTPException

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend import reading  # noqa: E402
from backend.routers import reading as reading_router  # noqa: E402
from backend.tests.test_reading import BOOK, BOOK_MARKS, FakeModel, make_pdf, run, run_job, upload, wait_read  # noqa: E402


class DeepModel(FakeModel):
    """The reading fake, plus a glossary: RuBisCO builds on "enzyme", which the book defines too."""

    async def __call__(self, model, system, message, document_id, **_):
        if system.startswith(reading.GLOSSARY_PROMPT[:40]):
            with self.lock:
                self.calls.append((system, message))
            ids = dict((term, tid) for tid, term in re.findall(r"^(T\d+) (.+?) \(p\.", message, re.M))
            terms = [{"id": ids["RuBisCO"], "plain": "The enzyme plants use to fix carbon.", "example": "Like a factory's first machine.",
                      "builds_on": [ids["enzyme"]], "unclear": False}]
            if "enzyme" in ids:
                terms.append({"id": ids["enzyme"], "plain": "A protein that speeds up a reaction.", "example": "",
                              "builds_on": [], "unclear": True})
            return {"terms": terms}
        out = await super().__call__(model, system, message, document_id)
        if system.startswith(reading.EXTRACT_PROMPT[:40]):
            pages = [int(p) for p in re.findall(r"\[p\. (\d+)\]", message)]
            if 5 in pages:          # chapter 2 defines the basic term the first one needs
                out["points"].append({"text": "A protein catalyst", "kind": "definition", "term": "enzyme",
                                      "importance": "core", "pages": [5]})
        elif "slides" in out and out["slides"][0]["blocks"]:
            out["slides"][0]["blocks"].insert(0, {"type": "key", "text": "The gist of this chapter", "src": [1], "covers": []})
        return out


class DeepRead(unittest.TestCase):
    def setUp(self):
        self.doc = upload(make_pdf(BOOK, BOOK_MARKS))
        wait_read(self.doc)
        self.model = DeepModel(cover_fraction=1.0)
        for p in (mock.patch.object(reading, "_ask", new=self.model),
                  mock.patch("backend.errors.resolve_llm", return_value=("claude-sonnet-5", "anthropic"))):
            p.start()
            self.addCleanup(p.stop)
        from backend.core import hosted
        p = mock.patch.object(hosted, "rates", return_value=None)
        p.start()
        self.addCleanup(p.stop)

    def test_a_deep_read_has_a_map_then_a_glossary_in_learning_order(self):
        nb, _ = run(run_job(document_id=self.doc, scope={"mode": "all"}, template="deep", level="new"))
        self.assertEqual(nb["template"], "deep")
        secs = nb["doc"]["sections"]
        self.assertEqual(secs[0]["title"], "Map of the text")
        self.assertTrue(all(b["text"].endswith("The gist of this chapter") for b in secs[0]["blocks"]))
        self.assertGreaterEqual(len(secs[0]["blocks"]), 2)                         # one line per chapter
        glossary = secs[1]
        self.assertEqual(glossary["title"], "Glossary, in learning order")
        terms = [b["term"] for b in glossary["blocks"]]
        self.assertLess(terms.index("enzyme"), terms.index("RuBisCO"))              # basics first
        rubisco = glossary["blocks"][terms.index("RuBisCO")]
        self.assertIn("Example (iReliabee's): Like a factory's first machine.", rubisco["text"])
        self.assertIn("Builds on: enzyme.", rubisco["text"])
        self.assertTrue(rubisco["src"])                                              # cites its pages
        self.assertIn("this meaning is iReliabee's", glossary["blocks"][terms.index("enzyme")]["text"])
        # The reader's level reaches the prompts; the coverage check is unchanged by the front pages.
        self.assertTrue(any("new to this field" in s for s, _ in self.model.calls if s.startswith(reading.GLOSSARY_PROMPT[:40])))
        self.assertEqual(nb["coverage"]["covered"], nb["coverage"]["required"])

    def test_chapters_are_written_one_at_a_time(self):
        run(run_job(document_id=self.doc, scope={"mode": "all"}, template="deep"))
        composes = [m for s, m in self.model.calls if s.startswith(reading.COMPOSE_PROMPT[:40])]
        self.assertGreaterEqual(len(composes), 2)
        self.assertTrue(all("reader who is" in s for s, _ in self.model.calls if s.startswith(reading.COMPOSE_PROMPT[:40])))

    def test_the_glossary_is_cached(self):
        run(run_job(document_id=self.doc, scope={"mode": "all"}, template="deep"))
        before = len([1 for s, _ in self.model.calls if s.startswith(reading.GLOSSARY_PROMPT[:40])])
        run(run_job(document_id=self.doc, scope={"mode": "all"}, template="deep"))
        after = len([1 for s, _ in self.model.calls if s.startswith(reading.GLOSSARY_PROMPT[:40])])
        self.assertEqual(before, after)

    def test_a_deep_read_costs_more_than_a_brief_and_says_so(self):
        brief = reading.estimate(self.doc, {"mode": "all"}, "brief")
        deep = reading.estimate(self.doc, {"mode": "all"}, "deep", level="expert")
        self.assertGreater(deep["calls"], brief["calls"])
        self.assertGreater(deep["tokens"]["output"], brief["tokens"]["output"])


class Ordering(unittest.TestCase):
    def test_a_loop_still_lists_every_term_once(self):
        terms = [{"id": "T1", "term": "a", "text": "", "pages": [1]}, {"id": "T2", "term": "b", "text": "", "pages": [2]}]
        order = reading.learning_order(terms, {"T1": {"builds_on": ["T2"]}, "T2": {"builds_on": ["T1"]}})
        self.assertEqual(sorted(t["id"] for t in order), ["T1", "T2"])


class NoOverdraw(unittest.TestCase):
    def test_a_job_the_balance_cannot_pay_for_is_refused(self):
        body = reading_router.GenerateBody(document_id=1, scope={"mode": "all"}, template="deep")
        with mock.patch.object(reading, "resolve_scope", return_value={}), \
                mock.patch.object(reading, "estimate", return_value={"credits": 3.5}), \
                mock.patch("backend.core.account.balance", return_value={"available": 1.25}), \
                mock.patch.object(reading, "start_job") as start:
            with self.assertRaises(HTTPException) as e:
                run(reading_router.generate(body))
        self.assertEqual(e.exception.status_code, 402)
        self.assertIn("about 3.50 credits and you have 1.25", e.exception.detail["message"])
        start.assert_not_called()

    def test_the_admin_on_their_own_keys_is_not_asked(self):
        self.assertIsNone(reading.shortfall(None))
        with mock.patch("backend.core.account.balance", side_effect=OSError("offline")):
            self.assertIsNone(reading.shortfall(2.0))


if __name__ == "__main__":
    unittest.main()


class Simplify(unittest.TestCase):
    def test_one_paragraph_in_plainer_words_with_its_page_as_context(self):
        doc = upload(make_pdf(BOOK, BOOK_MARKS))
        wait_read(doc)
        seen = {}

        async def fake(model, system, message, document_id, **_):
            seen.update(system=system, message=message)
            return {"plain": "Plants need lots of RuBisCO because it works slowly."}

        with mock.patch.object(reading, "_ask", new=fake):
            out = run(reading.simplify(doc, "RuBisCO is slow, so plants make a lot of it.", [2], "new"))
        self.assertEqual(out, {"plain": "Plants need lots of RuBisCO because it works slowly."})
        self.assertIn("new to this field", seen["system"])
        self.assertIn("PARAGRAPH\nRuBisCO is slow", seen["message"])
        self.assertIn("[p. 2]", seen["message"])                       # the page goes along, for context only

    def test_each_way_to_understand_it_asks_its_own_question_and_keeps_the_paragraph_exact(self):
        systems = {}

        async def fake(model, system, message, document_id, **_):
            mode = next(m for m, (task, _) in reading.UNDERSTAND_MODES.items() if task in system)
            systems[mode] = system
            if mode == "terms":
                return {"plain": "", "terms": [{"term": "RuBisCO", "meaning": "The enzyme that fixes carbon.", "from": "source"},
                                               {"term": "", "meaning": "dropped"}, {"term": "Calvin cycle", "meaning": "x", "from": "odd"}]}
            return {"plain": f"{mode} answer"}

        with mock.patch.object(reading, "_ask", new=fake):
            for mode in reading.UNDERSTAND_MODES:
                out = run(reading.simplify(None, "RuBisCO is slow, so plants make a lot of it.", [], "new", mode=mode))
                if mode == "terms":
                    self.assertEqual([t["term"] for t in out["terms"]], ["RuBisCO", "Calvin cycle"])
                    self.assertEqual(out["terms"][1]["from"], "general")
                else:
                    self.assertEqual(out, {"plain": f"{mode} answer"})
        for system in systems.values():
            self.assertIn("never change what it claims", system)
            self.assertIn("Return ONLY: {", system)                       # the shape's braces are single in the prompt
        self.assertIn(r"1. ...\n2.", systems["steps"])          # the line break is written as \n inside the JSON

    def test_an_unknown_mode_is_the_plain_rewrite(self):
        seen = {}

        async def fake(model, system, message, document_id, **_):
            seen["system"] = system
            return {"plain": "ok"}

        with mock.patch.object(reading, "_ask", new=fake):
            run(reading.simplify(None, "Text.", [], mode="sing it"))
        self.assertTrue(seen["system"].startswith(reading.SIMPLIFY_PROMPT[:40]))

    def test_nothing_to_simplify_is_a_plain_400(self):
        with self.assertRaises(HTTPException) as e:
            run(reading.simplify(None, "   ", []))
        self.assertEqual(e.exception.status_code, 400)


class ExplainBack(unittest.TestCase):
    def setUp(self):
        from backend import notebook
        self.nb = notebook.create_notebook("reading", title="Leaves")
        doc = {"sections": [
            {"title": "Map of the text", "blocks": [{"type": "point", "text": "Chapter 1: gist", "src": [1]}]},
            {"title": "Chapter 1 Cells", "blocks": [
                {"type": "key", "text": "Cells make energy from light.", "src": [2]},
                {"type": "point", "text": "Chloroplasts hold chlorophyll.", "src": [2]},
                {"type": "definition", "term": "RuBisCO", "text": "The enzyme that fixes carbon.", "src": [3]},
                {"type": "question", "text": "What does RuBisCO do?"}]},
            {"title": "Chapter 2 Energy", "blocks": [{"type": "point", "text": "ATP carries energy.", "src": [5]}]}]}
        self.nb = notebook.update_notebook(self.nb["id"], self.nb["version"], doc=doc) and notebook.get_notebook(self.nb["id"])
        self.ch1 = self.nb["doc"]["sections"][1]["id"]

    def test_what_was_got_missed_and_wrong_with_pages_and_a_kept_score(self):
        seen = {}

        async def fake(model, system, message, document_id, **_):
            seen["message"] = message
            return {"got": ["B1"], "missed": ["B3"], "wrong": [{"said": "Chlorophyll is an enzyme", "fix": "Chloroplasts hold chlorophyll", "item": "B2"}],
                    "score": 45, "note": "Go over what RuBisCO does."}

        with mock.patch.object(reading, "_ask", new=fake):
            out = run(reading.explain_back(self.nb["id"], self.ch1, "Cells turn light into energy, and chlorophyll is an enzyme."))
        self.assertEqual(out["score"], 45)
        self.assertEqual(out["missed"], [{"text": "RuBisCO: The enzyme that fixes carbon.", "src": [3]}])
        self.assertEqual(out["wrong"][0]["src"], [2])
        self.assertNotIn("What does RuBisCO do?", seen["message"])            # questions aren't what's checked
        self.assertEqual(out["progress"], {"chapters": 2, "explained": 1, "understood": 0,
                                           "sections": {self.ch1: {"score": 45, "tries": 1, "at": mock.ANY}}})

        # A better try keeps the best score and counts the tries.
        async def better(*a, **_):
            return {"got": ["B1", "B2", "B3"], "missed": [], "wrong": [], "score": 90, "note": ""}
        with mock.patch.object(reading, "_ask", new=better):
            out = run(reading.explain_back(self.nb["id"], self.ch1, "Cells turn light into energy; RuBisCO fixes carbon from the air."))
        self.assertEqual(out["progress"]["sections"][self.ch1]["score"], 90)
        self.assertEqual(out["progress"]["sections"][self.ch1]["tries"], 2)
        self.assertEqual(out["progress"]["understood"], 1)

    def test_too_short_to_check_is_a_plain_400(self):
        with self.assertRaises(HTTPException) as e:
            run(reading.explain_back(self.nb["id"], self.ch1, "cells"))
        self.assertEqual(e.exception.status_code, 400)


class IdeasKept(DeepRead):
    def test_the_deep_read_keeps_its_ideas_for_the_map(self):
        nb, _ = run(run_job(document_id=self.doc, scope={"mode": "all"}, template="deep"))
        ideas = {i["term"]: i["builds_on"] for i in nb["coverage"]["ideas"]}
        self.assertEqual(ideas["RuBisCO"], ["enzyme"])
        self.assertEqual(ideas["enzyme"], [])


class LookUp(unittest.TestCase):
    """Select any words in a notebook and ask what they mean (the Explain card)."""
    DOC = 990001

    @classmethod
    def setUpClass(cls):
        with reading.sess._connect() as conn:
            conn.execute("DELETE FROM document_pages WHERE document_id = ?", (cls.DOC,))
            conn.executemany("INSERT INTO document_pages (document_id, page, label, text) VALUES (?, ?, '', ?)", [
                (cls.DOC, 1, "We replicate the 2026 paper on open data."),
                (cls.DOC, 2, "Words with higher surprisal were stuttered more often."),
                (cls.DOC, 5, "FluencyBank Timestamped aligns every word of the interviews in FluencyBank."),
            ])

    def setUp(self):
        with reading.sess._connect() as conn:
            conn.execute("DELETE FROM reading_lookups")

    def test_finds_the_pages_that_mention_the_words(self):
        self.assertEqual(reading.mentions(self.DOC, "fluencybank"), [5])
        self.assertEqual(reading.mentions(self.DOC, "Fluency"), [])        # whole words only

    def test_the_source_goes_along_with_the_cited_page_and_the_pages_that_mention_it(self):
        seen = {}

        async def fake(model, system, message, document_id, **_):
            seen.update(system=system, message=message)
            return {"meaning": "A shared archive of recorded speech from people who stutter.", "example": "",
                    "from": "source", "pages": [5, 44], "unsure": False}

        with mock.patch.object(reading, "_ask", new=fake):
            out = run(reading.lookup("FluencyBank", "Using FluencyBank Timestamped, are words…", self.DOC, [2], "basic", "new"))
        self.assertIn("[p. 2]", seen["message"])
        self.assertIn("[p. 5]", seen["message"])
        self.assertIn("very clear, basic", seen["system"])
        self.assertEqual(out["pages"], [5])                                 # p. 44 was never sent: dropped
        self.assertEqual(out["from"], "source")
        self.assertFalse(out["cached"])

    def test_general_knowledge_is_labelled_and_a_claimed_source_without_pages_is_not_believed(self):
        async def fake(model, system, message, document_id, **_):
            return {"meaning": "Something.", "from": "source", "pages": [], "unsure": True}

        with mock.patch.object(reading, "_ask", new=fake):
            out = run(reading.lookup("TalkBank", "", None, [], "technical"))
        self.assertEqual(out["from"], "general")
        self.assertTrue(out["unsure"])

    def test_a_word_is_looked_up_once_then_kept_for_that_depth(self):
        calls = []

        async def fake(model, system, message, document_id, **_):
            calls.append(system)
            return {"meaning": "Meaning.", "from": "general", "pages": []}

        with mock.patch.object(reading, "_ask", new=fake):
            run(reading.lookup("surprisal", "", self.DOC, [], "basic"))
            again = run(reading.lookup("  Surprisal ", "", self.DOC, [], "basic"))
            run(reading.lookup("surprisal", "", self.DOC, [], "technical"))
        self.assertTrue(again["cached"])
        self.assertEqual(len(calls), 2)

    def test_nothing_selected_is_a_plain_400(self):
        with self.assertRaises(HTTPException) as e:
            run(reading.lookup("  "))
        self.assertEqual(e.exception.status_code, 400)


class FollowUp(unittest.TestCase):
    """Ask about words or a paragraph after it was explained."""
    DOC = LookUp.DOC

    @classmethod
    def setUpClass(cls):
        LookUp.setUpClass()

    def test_the_question_goes_with_the_passage_the_explanation_the_conversation_and_the_source(self):
        seen = {}

        async def fake(model, system, message, document_id, **_):
            seen.update(system=system, message=message)
            return {"answer": "Because its words are timed.", "from": "source", "pages": [5, 77], "unsure": False}

        history = [{"q": "What is it?", "a": "An archive."}] * 9 + [{"q": "", "a": "skipped"}]
        with mock.patch.object(reading, "_ask", new=fake):
            out = run(reading.ask("Why does the study use it?", "FluencyBank", "A shared archive of speech.",
                                  history, self.DOC, [2], None, "new"))
        self.assertEqual(out, {"answer": "Because its words are timed.", "from": "source", "pages": [5], "unsure": False})
        m = seen["message"]
        for part in ("PASSAGE\nFluencyBank", "EXPLANATION\nA shared archive", "QUESTION\nWhy does the study use it?",
                     "[p. 2]", "[p. 5]"):
            self.assertIn(part, m)
        self.assertEqual(m.count("Q: What is it?"), reading.ASK_HISTORY - 1)   # the last few turns; the empty one dropped
        self.assertNotIn("skipped", m)
        self.assertIn("Never invent studies", seen["system"])

    def test_an_answer_with_no_pages_is_general_knowledge(self):
        async def fake(model, system, message, document_id, **_):
            return {"answer": "It is a TalkBank project.", "from": "both", "pages": []}

        with mock.patch.object(reading, "_ask", new=fake):
            out = run(reading.ask("Who runs it?", "FluencyBank"))
        self.assertEqual(out["from"], "general")

    def test_an_empty_question_is_a_plain_400(self):
        with self.assertRaises(HTTPException) as e:
            run(reading.ask("  ", "FluencyBank"))
        self.assertEqual(e.exception.status_code, 400)


class CheckUnderstanding(unittest.TestCase):
    """One question about a paragraph, then the answer marked against it."""

    def test_asks_a_new_question_each_time_with_the_points_to_mark_against(self):
        seen = {}

        async def fake(model, system, message, document_id, **_):
            seen.update(system=system, message=message)
            return {"question": "Why do plants make so much RuBisCO?", "points": ["It is slow.", "", "So more is needed."] * 3}

        with mock.patch.object(reading, "_ask", new=fake):
            out = run(reading.check_question("RuBisCO is slow, so plants make a lot of it.", avoid=["What is RuBisCO?"]))
        self.assertEqual(out["question"], "Why do plants make so much RuBisCO?")
        self.assertEqual(len(out["points"]), 4)                              # empty points dropped, at most 4
        self.assertIn("What is RuBisCO?", seen["system"])                     # not asked again
        self.assertIn("PARAGRAPH\nRuBisCO is slow", seen["message"])

    def test_marks_against_the_points_and_shows_every_point_it_did_not_get(self):
        async def fake(model, system, message, document_id, **_):
            self.assertIn("1. It is slow.", message)
            self.assertIn("ANSWER\nBecause it is slow", message)
            return {"got": [1, 9], "missed": [], "wrong": [{"said": "it is fast", "fix": "It is slow."}, {"said": "x"}],
                    "score": 140, "note": "Look again at why more is needed."}

        with mock.patch.object(reading, "_ask", new=fake):
            out = run(reading.check_answer("RuBisCO is slow, so plants make a lot of it.", "Why so much RuBisCO?",
                                           ["It is slow.", "So more is needed."], "Because it is slow"))
        self.assertEqual(out["got"], [1])                                     # 9 is not a point
        self.assertEqual(out["missed"], [2])                                  # not got, so shown as missed
        self.assertEqual(out["score"], 100)
        self.assertEqual([w["fix"] for w in out["wrong"]], ["It is slow."])   # a "wrong" without a fix is dropped

    def test_an_empty_answer_is_a_plain_400(self):
        with self.assertRaises(HTTPException) as e:
            run(reading.check_answer("Text.", "Q?", ["P."], "   "))
        self.assertEqual(e.exception.status_code, 400)


class FullerGlossary(unittest.TestCase):
    """Every unfamiliar term in a notebook, including names the notes never explain."""

    def setUp(self):
        LookUp.setUpClass()
        from backend import notebook as nb
        self.nb = nb
        doc = {"title": "Surprisal and stuttering", "sections": [{"title": "Data", "blocks": [
            {"type": "point", "text": "We use FluencyBank Timestamped and SEP-28k.", "src": [5]},
            {"type": "definition", "term": "Surprisal", "text": "How unexpected a word is."},
        ]}], "terms": [{"term": "GPT-2", "meaning": "A language model.", "from": "general"}]}
        self.id = nb.create_notebook("reading", title="Surprisal and stuttering", doc=doc, document_id=LookUp.DOC)["id"]

    def test_finds_the_terms_the_notes_do_not_explain_and_explains_them_from_the_source(self):
        calls = []

        async def fake(model, system, message, document_id, **_):
            calls.append((system, message))
            if system.startswith(reading.FIND_TERMS_PROMPT[:40]):
                self.assertIn("FluencyBank Timestamped", message)
                self.assertIn("Surprisal", message.split("ALREADY EXPLAINED")[1])   # defined: not asked for again
                self.assertIn("GPT-2", message.split("ALREADY EXPLAINED")[1])       # found before: not again
                return {"terms": ["FluencyBank", "SEP-28k", "surprisal", "GPT-2", "FluencyBank"]}
            self.assertIn("[p. 5]", message)                                          # the page that mentions it
            return {"terms": [
                {"term": "FluencyBank", "meaning": "An archive of speech from people who stutter.", "from": "source", "pages": [5, 99]},
                {"term": "SEP-28k", "meaning": "A set of labelled clips.", "from": "source", "pages": []},
                {"term": "Invented", "meaning": "Not asked for."},
            ]}

        with mock.patch.object(reading, "_ask", new=fake):
            out = run(reading.find_terms(self.id, "new"))
        self.assertEqual(len(calls), 2)
        self.assertEqual([t["term"] for t in out["terms"]], ["FluencyBank", "SEP-28k"])
        self.assertEqual(out["terms"][0]["pages"], [5])                            # p. 99 was never sent
        self.assertEqual(out["terms"][1]["from"], "general")                       # "source" with no pages is not believed

    def test_nothing_new_found_costs_one_call(self):
        calls = []

        async def fake(model, system, message, document_id, **_):
            calls.append(system)
            return {"terms": ["Surprisal"]}

        with mock.patch.object(reading, "_ask", new=fake):
            out = run(reading.find_terms(self.id))
        self.assertEqual(out, {"terms": []})
        self.assertEqual(len(calls), 1)

    def test_the_notebook_keeps_its_terms_once_each(self):
        kept = self.nb.clean_terms([{"term": "SEP-28k", "meaning": "Clips.", "pages": [2, "x"]},
                                    {"term": "sep-28k", "meaning": "Again."}, {"term": "", "meaning": "none"}])
        self.assertEqual(kept, [{"term": "SEP-28k", "meaning": "Clips.", "from": "general", "pages": [2], "unsure": False}])
