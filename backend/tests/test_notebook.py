"""Notebook (specs 184/185): cleaning, CRUD with versions, generation from a session, export."""
import asyncio
import threading
import time
import unittest
from unittest import mock

from fastapi import HTTPException

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend import notebook as nb  # noqa: E402
from backend.routers import sessions as sessions_router, mock as mock_router  # noqa: E402
from backend.routers import notebook as nb_router  # noqa: E402


def say(sid, text, speaker="interviewer"):
    sessions_router.record_transcript(sid, sessions_router.TranscriptBody(text=text, speaker=speaker))


LECTURE_DOC = {
    "title": "Photosynthesis",
    "summary": "Two stages turn light into sugar.",
    "cues": ["Where does the oxygen come from?", ""],
    "sections": [
        {"title": "Light reactions", "src": [1, 2], "blocks": [
            {"type": "key", "text": "Water is split and oxygen released", "src": [2, 999]},
            {"type": "definition", "term": "NADPH", "text": "carries electrons", "src": [3]},
            {"type": "made-up-type", "text": "dropped"},
            {"type": "point", "text": "   "},
            {"type": "table", "rows": [["Stage", "Where"], ["Light", "Thylakoid"]], "caption": "Stages"},
            {"type": "table", "rows": []},
            {"type": "tutor", "text": "Like charging a battery"},
        ]},
        {"title": "", "blocks": []},
        "not a section",
    ],
    "board": {"decisions": [{"text": "should be ignored for a lecture"}]},
}

MEETING_DOC = {
    "title": "Ambassador sync",
    "summary": "Pilot at three campuses.",
    "sections": [{"title": "Scope", "blocks": [{"type": "point", "text": "Three campuses first", "src": [1]}]}],
    "board": {
        "decisions": [{"text": "Pilot at three campuses", "src": [2]}],
        "actions": [{"text": "Publish the form", "who": "Kofi", "due": "Friday", "src": [3]},
                    {"text": "Weekly report", "owner": "", "due": ""}],
        "questions": [{"text": "Stipend or per sign-up?"}],
        "risks": [{"type": "decision", "text": "Exams in October"}],   # a board column decides the type
        "numbers": [{"value": "GHS 12,000", "text": "pilot budget"}],
        "nonsense": [{"text": "dropped"}],
    },
}


class CleaningTest(unittest.TestCase):
    def test_unknown_empty_and_out_of_range_things_are_dropped(self):
        doc = nb.clean_doc(LECTURE_DOC, "lecture", max_src=10)
        self.assertEqual(len(doc["sections"]), 1)
        types = [b["type"] for b in doc["sections"][0]["blocks"]]
        self.assertEqual(types, ["key", "definition", "table", "tutor"])
        self.assertEqual(doc["sections"][0]["blocks"][0]["src"], [2])       # 999 is past the transcript
        self.assertEqual(doc["cues"], ["Where does the oxygen come from?"])
        self.assertEqual(doc["board"]["decisions"], [])                    # lectures have no board
        self.assertTrue(all(b["id"] for b in doc["sections"][0]["blocks"]))

    def test_cover_label_is_kept_trimmed_and_only_when_written(self):
        doc = nb.clean_doc({"cover": {"name": "  Ama Mensah ", "class": "Form 2", "year": 2026, "extra": "x"}}, "lecture")
        self.assertEqual(doc["cover"], {"name": "Ama Mensah", "class": "Form 2", "year": "2026"})
        self.assertNotIn("cover", nb.clean_doc({"cover": {"name": " "}}, "lecture"))
        self.assertNotIn("cover", nb.clean_doc({"cover": "Ama"}, "lecture"))
        self.assertEqual(len(nb.clean_doc({"cover": {"name": "a" * 500}}, "lecture")["cover"]["name"]), nb.LIMITS["short"])

    def test_a_line_style_from_the_book_is_kept_and_bad_ones_dropped(self):
        blocks = [{"type": "point", "text": "step one", "para": "numbered"},
                  {"type": "note", "text": "", "para": "blank"},
                  {"type": "note", "text": "", "para": "divider"},
                  {"type": "point", "text": "odd", "para": "sparkly"},
                  {"type": "point", "text": "", "para": "numbered"}]
        doc = nb.clean_doc({"sections": [{"title": "S", "blocks": blocks}]}, "lecture")
        kept = [(b["text"], b.get("para")) for b in doc["sections"][0]["blocks"]]
        self.assertEqual(kept, [("step one", "numbered"), ("", "blank"), ("", "divider"), ("odd", None)])

    def test_spacing_lines_are_not_searched_or_exported_as_bullets(self):
        doc = nb.clean_doc({"sections": [{"title": "S", "blocks": [
            {"type": "point", "text": "alpha", "para": "numbered"}, {"type": "note", "text": "", "para": "divider"},
            {"type": "note", "text": "", "para": "blank"}, {"type": "point", "text": "beta"}]}]}, "lecture")
        self.assertNotIn("numbered", nb._words(doc))
        md = nb.to_markdown({"title": "T", "doc": doc})
        self.assertIn("- alpha\n---\n- beta", md)

    def test_a_photo_is_kept_only_as_a_small_image_data_url(self):
        ok = "data:image/jpeg;base64," + "A" * 100
        blocks = [{"type": "image", "image": ok, "w": 400, "h": 300, "text": "whiteboard"},
                  {"type": "image", "image": "https://example.com/x.jpg"},
                  {"type": "image", "image": "data:text/html;base64,PHNjcmlwdD4="},
                  {"type": "image", "image": "data:image/jpeg;base64," + "A" * (nb.LIMITS["image"] + 1)}]
        doc = nb.clean_doc({"sections": [{"title": "S", "blocks": blocks}]}, "lecture")
        kept = doc["sections"][0]["blocks"]
        self.assertEqual([(b["type"], b["w"], b["h"]) for b in kept], [("image", 400, 300)])
        self.assertNotIn("base64", nb._words(doc))
        self.assertIn("*[Photo: whiteboard]*", nb.to_markdown({"title": "T", "doc": doc}))

    def test_only_so_many_photos_per_notebook(self):
        ok = {"type": "image", "image": "data:image/jpeg;base64,AAAA"}
        doc = nb.clean_doc({"sections": [{"title": "A", "blocks": [ok] * 20}, {"title": "B", "blocks": [ok] * 20}]}, "lecture")
        self.assertEqual(sum(len(s["blocks"]) for s in doc["sections"]), nb.LIMITS["images"])

    def test_the_paper_is_kept_and_defaults_by_kind(self):
        self.assertEqual(nb.clean_style({"paper": "school"}, "lecture")["paper"], "school")
        self.assertEqual(nb.clean_style({"paper": "velvet"}, "meeting")["paper"], "dotgrid")
        self.assertEqual(nb.clean_style({}, "reading")["paper"], "parchment")

    def test_meeting_board_columns_set_their_own_type(self):
        doc = nb.clean_doc(MEETING_DOC, "meeting")
        self.assertEqual(doc["board"]["risks"][0]["type"], "risk")
        self.assertEqual(doc["board"]["actions"][0]["owner"], "Kofi")
        self.assertEqual(doc["board"]["actions"][1]["owner"], "Not agreed")
        self.assertFalse(doc["board"]["actions"][0]["done"])
        self.assertEqual(doc["board"]["numbers"][0]["term"], "GHS 12,000")
        self.assertNotIn("nonsense", doc["board"])

    def test_style_falls_back_to_the_kinds_default(self):
        self.assertEqual(nb.clean_style({"family": "comic-sans", "size": "xl", "style": "bold"}, "meeting"),
                         {"family": "sans", "size": "xl", "style": "bold", "list": "bullet", "paper": "dotgrid"})
        self.assertEqual(nb.clean_style(None, "lecture"), nb.DEFAULT_STYLE["lecture"])

    def test_list_markers_survive_the_api(self):
        from backend.routers import notebook as api        # the request models, not just clean_style
        made = api.create(api.CreateBody(kind="lecture", title="Markers", style={"list": "number"}))
        self.assertEqual(made["style"]["list"], "number")
        saved = api.update(made["id"], api.UpdateBody(version=made["version"], style={**made["style"], "list": "none"}))
        self.assertEqual(saved["style"]["list"], "none")
        self.assertEqual(nb.get_notebook(made["id"])["style"]["list"], "none")
        nb.delete_notebook(made["id"])

    def test_list_markers_are_kept_or_fall_back_to_bullets(self):
        self.assertEqual(nb.clean_style({"list": "number"}, "reading")["list"], "number")
        self.assertEqual(nb.clean_style({"list": "none"}, "reading")["list"], "none")
        self.assertEqual(nb.clean_style({"list": "roman"}, "reading")["list"], "bullet")

    def test_long_values_are_capped(self):
        block = nb.clean_block({"type": "point", "text": "x" * 10000, "src": list(range(1, 100))})
        self.assertEqual(len(block["text"]), nb.LIMITS["text"])
        self.assertEqual(len(block["src"]), nb.LIMITS["src"])


class CrudTest(unittest.TestCase):
    def test_create_read_update_delete(self):
        made = nb.create_notebook("lecture", title="My notes", style={"family": "readable", "size": "l"})
        self.assertEqual(made["style"], {"family": "readable", "size": "l", "style": "regular", "list": "bullet", "paper": "classic"})
        self.assertEqual(made["version"], 1)
        self.assertFalse(made["edited"])

        doc = made["doc"]
        doc["sections"].append({"title": "Week 1", "blocks": [{"type": "note", "text": "my own note"}]})
        saved = nb.update_notebook(made["id"], 1, title="Renamed", doc=doc)
        self.assertEqual(saved["version"], 2)
        self.assertTrue(saved["edited"])
        self.assertEqual(saved["title"], "Renamed")
        self.assertEqual(saved["doc"]["sections"][0]["blocks"][0]["text"], "my own note")

        listed = [n for n in nb.list_notebooks(q="own note") if n["id"] == made["id"]]
        self.assertEqual(len(listed), 1)
        self.assertNotIn("doc", listed[0])                                  # the list stays light

        brief = nb.update_notebook(made["id"], 2, title="Autosaved", doc=doc, brief=True)   # the editor's autosave
        self.assertEqual((brief["version"], brief["title"]), (3, "Autosaved"))
        self.assertNotIn("doc", brief)                                      # it has the text already
        self.assertEqual(nb.get_notebook(made["id"])["doc"]["sections"][0]["blocks"][0]["text"], "my own note")

        nb.delete_notebook(made["id"])
        with self.assertRaises(HTTPException) as e:
            nb.get_notebook(made["id"])
        self.assertEqual(e.exception.status_code, 404)

    def test_a_stale_save_is_refused_not_lost(self):
        made = nb.create_notebook("meeting", title="Sync")
        nb.update_notebook(made["id"], 1, title="First edit")
        with self.assertRaises(HTTPException) as e:
            nb.update_notebook(made["id"], 1, title="Second edit from an old copy")
        self.assertEqual(e.exception.status_code, 409)
        self.assertEqual(nb.get_notebook(made["id"])["title"], "First edit")

    def test_style_only_change_does_not_mark_the_content_edited(self):
        made = nb.create_notebook("lecture", title="Style")
        saved = nb.update_notebook(made["id"], 1, style={"size": "xl"})
        self.assertFalse(saved["edited"])
        self.assertEqual(saved["style"]["size"], "xl")

    @mock.patch.object(nb, "SNAPSHOT_EVERY_S", 0)
    def test_versions_can_be_restored(self):
        made = nb.create_notebook("lecture", title="v1")
        nb.update_notebook(made["id"], 1, title="v2")
        nb.update_notebook(made["id"], 2, title="v3")
        self.assertEqual([v["version"] for v in nb.list_versions(made["id"])], [2, 1])
        restored = nb.restore_version(made["id"], 1, current_version=3)
        self.assertEqual(restored["title"], "v1")
        self.assertEqual(restored["version"], 4)                            # a restore is a new version

    @mock.patch.object(nb, "SNAPSHOT_EVERY_S", 0)
    def test_only_the_last_ten_versions_are_kept(self):
        made = nb.create_notebook("lecture", title="many")
        for v in range(1, 15):
            nb.update_notebook(made["id"], v, title=f"t{v}")
        self.assertEqual(len(nb.list_versions(made["id"])), nb.VERSIONS_KEPT)

    def test_autosave_keeps_one_version_per_few_minutes(self):
        made = nb.create_notebook("lecture", title="typing")
        for v in range(1, 30):                                   # thirty autosaves in a row
            nb.update_notebook(made["id"], v, title=f"t{v}")
        self.assertEqual(len(nb.list_versions(made["id"])), 1)   # not thirty: one per five minutes

    def test_the_ais_version_survives_any_amount_of_editing(self):
        made = nb.create_notebook("lecture", title="From the AI", doc={"sections": [{"title": "S", "blocks": [{"type": "point", "text": "a"}]}]},
                                  generated=True)
        with mock.patch.object(nb, "SNAPSHOT_EVERY_S", 0):
            for v in range(1, 25):
                nb.update_notebook(made["id"], v, title=f"mine {v}")
        kept = nb.list_versions(made["id"])
        ai = [k for k in kept if k["pinned"]]
        self.assertEqual([k["title"] for k in ai], ["From the AI"])
        self.assertEqual(len([k for k in kept if not k["pinned"]]), nb.VERSIONS_KEPT)

    def test_a_restore_always_keeps_what_it_replaces(self):
        made = nb.create_notebook("lecture", title="first")
        nb.update_notebook(made["id"], 1, title="second")         # inside the window: no version kept
        nb.update_notebook(made["id"], 2, title="third")
        restored = nb.restore_version(made["id"], 1, current_version=3)
        self.assertEqual(restored["title"], "first")
        self.assertIn("third", [v["title"] for v in nb.list_versions(made["id"])])

    def test_search_matches_words_not_the_json_around_them(self):
        a = nb.create_notebook("lecture", title="Zeta lecture", doc={"sections": [{"title": "Café culture", "blocks": [{"type": "point", "text": "50% of ratios"}]}]})
        nb.create_notebook("lecture", title="Other one")
        found = lambda q: [n["id"] for n in nb.list_notebooks(q=q)]
        self.assertNotIn(a["id"], found("type"))                # a JSON key, not a word in the notes
        self.assertNotIn(a["id"], found("src"))
        self.assertIn(a["id"], found("café"))                    # accents, which the stored JSON escapes
        self.assertIn(a["id"], found("50%"))                      # a literal %, not a wildcard
        self.assertNotIn(a["id"], found("5_%"))

    def test_unknown_kind_is_refused(self):
        with self.assertRaises(HTTPException):
            nb.create_notebook("diary")

    def test_deleting_a_session_keeps_its_notebook(self):
        """Review 11-2: the notes are the user's; only the link to the recording goes."""
        sid = sess.create_session(title="Gone", mode="general")
        made = nb.create_notebook("meeting", title="x", session_id=sid)
        nb.update_notebook(made["id"], 1, title="My edited notes")          # leaves a version row too
        sess.delete_session(sid)
        self.assertIsNone(nb.for_session(sid))
        kept = nb.get_notebook(made["id"])
        self.assertEqual(kept["title"], "My edited notes")
        self.assertIsNone(kept["session_id"])
        self.assertNotIn("line_times", kept)                                  # no recording to jump to
        self.assertEqual(len(nb.list_versions(made["id"])), 1)               # its history stays too
        self.assertEqual(nb.source_lines(made["id"], [1]), [])

    def test_one_notebook_per_session(self):
        sid = sess.create_session(title="One", mode="general")
        nb.create_notebook("meeting", session_id=sid)
        with self.assertRaises(HTTPException) as e:
            nb.create_notebook("meeting", session_id=sid)
        self.assertEqual(e.exception.status_code, 409)


class GenerateTest(unittest.TestCase):
    def setUp(self):
        self.lecture = sess.create_session(title="Bio 201", mode="lecture")
        for i in range(12):
            say(self.lecture, f"Sentence {i} about photosynthesis and the thylakoid membranes and water splitting.")
        self.meeting = sess.create_session(title="Weekly sync", mode="general")
        for i in range(8):
            say(self.meeting, f"Point {i}: we agreed to pilot at three campuses with a budget.", "interviewer")
            say(self.meeting, f"Reply {i}: I will share the budget sheet today.", "you")

    def run_generate(self, sid, reply, **kw):
        calls = []

        async def fake(model, system_prompt, message, **k):
            calls.append((system_prompt, message, k))
            return reply

        with _env.pro(), mock.patch.object(mock_router, "_ask_model", side_effect=fake):
            out = asyncio.run(nb.generate_for_session(sid, **kw))
        return out, calls

    def test_a_lecture_becomes_a_lecture_notebook_with_the_chosen_style(self):
        out, calls = self.run_generate(self.lecture, LECTURE_DOC, style={"family": "hand", "size": "s"})
        self.assertEqual(out["kind"], "lecture")
        self.assertEqual(out["style"], {"family": "hand", "size": "s", "style": "regular", "list": "bullet", "paper": "classic"})
        self.assertEqual(out["session_id"], self.lecture)
        self.assertEqual(set(out["line_times"]), {str(n) for n in range(1, 13)})
        system_prompt, message, k = calls[0]
        self.assertIn("[L1]", message)
        self.assertEqual(k["kind"], "notebook")

    def test_the_prompt_never_carries_the_cv_or_the_interview_persona(self):
        with mock.patch.object(mock_router, "_candidate_context",
                               return_value=({"name": "Ama", "background": "SECRET-BACKGROUND"}, "SECRET-CV")):
            _, calls = self.run_generate(self.meeting, MEETING_DOC)
        system_prompt, message, _ = calls[0]
        for leak in ("SECRET-CV", "SECRET-BACKGROUND", "SPEAK AS"):
            self.assertNotIn(leak, system_prompt + message)
        self.assertIn("Ama", system_prompt)                                # a name only

    def test_a_meeting_gets_its_board(self):
        out, _ = self.run_generate(self.meeting, MEETING_DOC)
        self.assertEqual(out["kind"], "meeting")
        self.assertEqual(out["doc"]["board"]["decisions"][0]["text"], "Pilot at three campuses")
        self.assertEqual(out["style"]["family"], "sans")                    # the meeting default

    def test_rewriting_keeps_the_old_notes_as_a_version(self):
        first, _ = self.run_generate(self.lecture, LECTURE_DOC)
        edited = nb.update_notebook(first["id"], first["version"], title="My own title")
        again, _ = self.run_generate(self.lecture, {**LECTURE_DOC, "title": "Rewritten"})
        self.assertEqual(again["id"], first["id"])
        self.assertEqual(again["version"], edited["version"] + 1)
        self.assertFalse(again["edited"])
        self.assertIn("My own title", [v["title"] for v in nb.list_versions(first["id"])])

    def test_an_empty_answer_is_an_error_not_an_empty_notebook(self):
        with self.assertRaises(HTTPException) as e:
            self.run_generate(self.lecture, {"title": "nothing"})
        self.assertEqual(e.exception.status_code, 502)

    def test_too_little_said_is_refused_before_any_ai_call(self):
        sid = sess.create_session(title="Short", mode="lecture")
        say(sid, "Hello.")
        with self.assertRaises(HTTPException) as e:
            self.run_generate(sid, LECTURE_DOC)
        self.assertEqual(e.exception.status_code, 400)

    def test_tutor_notes_can_be_switched_off(self):
        _, calls = self.run_generate(self.lecture, LECTURE_DOC, tutor=False)
        self.assertIn("Do NOT add any tutor blocks", calls[0][0])

    def test_long_transcripts_are_condensed_at_most_three_at_a_time(self):
        sid = sess.create_session(title="Long", mode="lecture")
        for i in range(700):
            say(sid, f"Long lecture line {i} " + "about the Calvin cycle and RuBisCO " * 2)
        live, peak, lock = [0], [0], threading.Lock()

        def slow_respond(*a, **k):
            with lock:
                live[0] += 1
                peak[0] = max(peak[0], live[0])
            time.sleep(0.05)
            with lock:
                live[0] -= 1
            return "[L1] condensed"

        with mock.patch.object(mock_router, "respond", side_effect=slow_respond), \
             mock.patch.object(mock_router, "resolve_llm", return_value=("m", "anthropic")):
            out, calls = self.run_generate(sid, LECTURE_DOC)
        self.assertLessEqual(peak[0], nb.MAX_PARALLEL)
        self.assertGreater(peak[0], 0)
        self.assertIn("[Part 1]", calls[0][1])


class ExportAndRouterTest(unittest.TestCase):
    def test_markdown_export_has_every_part(self):
        made = nb.create_notebook("meeting", title="Sync", doc=MEETING_DOC)
        md = nb.to_markdown(made)
        for piece in ("# Sync", "## Summary", "## Scope", "## Decisions", "- [ ] **Kofi**: Publish the form (due Friday)",
                      "## Numbers and dates", "**GHS 12,000**"):
            self.assertIn(piece, md)

    def test_generation_is_a_pro_feature_but_editing_is_not(self):
        from backend.entitlements import allows
        self.assertFalse(allows("notebook"))                                # signed out, no licence
        made = nb_router.create(nb_router.CreateBody(kind="lecture", title="free to write"))
        nb_router.update(made["id"], nb_router.UpdateBody(version=1, title="free to edit"))
        nb_router.delete(made["id"])


if __name__ == "__main__":
    unittest.main()


class AutoTest(unittest.TestCase):
    """Decision 184-1 and 184-4: written when a lecture or meeting ends, with a floor and an ask."""

    def setUp(self):
        self.sid = sess.create_session(title="Bio 202", mode="lecture")
        say(self.sid, "The Calvin cycle fixes carbon.")
        nb._AUTO.clear()

    def run_auto(self, seconds=1800, words=4000, enabled=True, pro=True, writer=None):
        async def fake_write(session_id, style=None, **k):
            return nb.create_notebook("lecture", title="Auto", session_id=session_id, style=style, generated=True)

        async def go():
            out = await nb.start_auto(self.sid, style={"family": "hand"})
            await asyncio.sleep(0.01)           # let the background task finish
            return out, nb.auto_status(self.sid)

        cfg = {} if enabled else {"notebook_auto": False}
        patches = [
            mock.patch.object(nb, "_session_shape", return_value=([], seconds, words)),
            mock.patch.object(nb, "generate_for_session", side_effect=writer or fake_write),
            mock.patch("backend.core.config.load_config", return_value=cfg),
            mock.patch("backend.entitlements.allows", return_value=pro),
        ]
        for p in patches:
            p.start()
        try:
            return asyncio.run(go())
        finally:
            for p in patches:
                p.stop()

    def test_a_long_enough_lecture_is_written_in_the_background(self):
        first, final = self.run_auto()
        self.assertEqual(first["state"], "writing")
        self.assertEqual(final["state"], "done")
        made = nb.get_notebook(final["notebook_id"])
        self.assertEqual(made["session_id"], self.sid)
        self.assertEqual(made["style"]["family"], "hand")           # the look the user last chose

    def test_under_five_minutes_or_300_words_is_skipped(self):
        self.assertEqual(self.run_auto(seconds=240)[0], {"state": "skipped", "reason": "short"})
        nb._AUTO.clear()
        self.assertEqual(self.run_auto(words=250)[0], {"state": "skipped", "reason": "short"})

    def test_the_settings_switch_turns_it_off(self):
        self.assertEqual(self.run_auto(enabled=False)[0]["reason"], "off")

    def test_a_free_account_is_skipped_not_refused(self):
        self.assertEqual(self.run_auto(pro=False)[0]["reason"], "pro")

    def test_an_existing_notebook_is_never_replaced(self):
        nb.create_notebook("lecture", session_id=self.sid)
        self.assertEqual(self.run_auto()[0]["reason"], "exists")

    def test_over_two_hours_it_asks_with_an_estimate_instead_of_writing(self):
        with mock.patch.object(nb, "estimate_for_session", return_value={"credits": 0.4}):
            first, final = self.run_auto(seconds=3 * 3600)
        self.assertEqual(first["state"], "ask")
        self.assertEqual(first["estimate"]["credits"], 0.4)
        self.assertIsNone(nb.for_session(self.sid), "nothing written until the user says yes")

    def test_a_failure_is_reported_for_the_notebook_tab(self):
        async def broken(session_id, style=None, **k):
            raise HTTPException(502, detail={"code": "unknown", "title": "The notes came back empty", "message": "x"})
        _, final = self.run_auto(writer=broken)
        self.assertEqual(final["state"], "failed")
        self.assertEqual(final["error"]["title"], "The notes came back empty")

    def test_the_estimate_is_in_credits_for_an_ordinary_account(self):
        from backend.core import hosted
        for i in range(40):
            say(self.sid, "word " * 50)
        rates = {"creditsPerUsd": 2, "perMillionTokensUsd": {"fast": {"in": 0.15, "out": 0.75}}}
        with mock.patch.object(hosted, "rates", return_value=rates), mock.patch.object(hosted, "is_admin", return_value=False):
            est = nb.estimate_for_session(self.sid)
        self.assertGreater(est["words"], 1900)
        self.assertIsNotNone(est["credits"])
        self.assertLess(est["credits"], 1)


class HighlightTest(unittest.TestCase):
    """The user's highlights are kept with the block, and stay on their words."""
    TEXT = "RuBisCO fixes carbon dioxide onto RuBP in the stroma."

    def block(self, marks, text=TEXT):
        return nb.clean_block({"type": "point", "text": text, "marks": marks})

    def test_a_highlight_is_kept(self):
        b = self.block([{"s": 0, "e": 7, "c": "yellow", "q": "RuBisCO"}])
        self.assertEqual(b["marks"], [{"s": 0, "e": 7, "c": "yellow", "q": "RuBisCO"}])

    def test_it_finds_its_words_after_an_edit_or_goes(self):
        mark = [{"s": 34, "e": 38, "c": "pink", "q": "RuBP"}]
        self.assertEqual(self.block(mark, "Note: " + self.TEXT)["marks"][0]["s"], 40)
        self.assertNotIn("marks", self.block(mark, self.TEXT.replace("RuBP", "ribulose")))

    def test_unknown_colours_overlaps_and_junk_are_dropped(self):
        b = self.block([
            {"s": 0, "e": 7, "c": "purple", "q": "RuBisCO"},
            {"s": 8, "e": 13, "c": "green", "q": "fixes"},
            {"s": 8, "e": 20, "c": "blue", "q": "fixes carbon"},   # overlaps the one before: the first wins
            "not a mark", {"c": "yellow"},
        ])
        self.assertEqual([(m["q"], m["c"]) for m in b["marks"]], [("fixes", "green")])

    def test_highlights_survive_a_save(self):
        made = nb.create_notebook("lecture", title="H")
        doc = made["doc"]
        doc["sections"] = [{"title": "S", "blocks": [{"type": "point", "text": self.TEXT,
                                                       "marks": [{"s": 0, "e": 7, "c": "blue", "q": "RuBisCO"}]}]}]
        saved = nb.update_notebook(made["id"], made["version"], doc=doc)
        self.assertEqual(saved["doc"]["sections"][0]["blocks"][0]["marks"][0]["c"], "blue")


class FormattingTest(unittest.TestCase):
    """Bold, italic, underline and strikethrough are kept with the block and exported to Markdown."""
    TEXT = "RuBisCO fixes carbon dioxide onto RuBP."

    def test_styles_are_kept_merged_and_follow_their_words(self):
        b = nb.clean_block({"type": "point", "text": "Note: " + self.TEXT, "fmt": {
            "b": [{"s": 0, "e": 7, "q": "RuBisCO"}, {"s": 7, "e": 13, "q": " fixes"}],
            "i": [{"s": 34, "e": 38, "q": "RuBP"}],
            "z": [{"s": 0, "e": 3, "q": "Not"}],             # not a style
        }})
        self.assertEqual(b["fmt"]["b"], [{"s": 6, "e": 19, "q": "RuBisCO fixes"}])   # found again, merged
        self.assertEqual(b["fmt"]["i"][0]["q"], "RuBP")
        self.assertNotIn("z", b["fmt"])

    def test_markdown_keeps_bold_italic_and_strikethrough(self):
        block = nb.clean_block({"type": "point", "text": self.TEXT, "fmt": {
            "b": [{"s": 0, "e": 7, "q": "RuBisCO"}], "i": [{"s": 8, "e": 13, "q": "fixes"}],
            "x": [{"s": 34, "e": 38, "q": "RuBP"}], "u": [{"s": 14, "e": 20, "q": "carbon"}]}})
        self.assertEqual(nb._md_block(block), "- **RuBisCO** *fixes* carbon dioxide onto ~~RuBP~~.")

    def test_a_block_without_formatting_exports_as_before(self):
        self.assertEqual(nb._md_block(nb.clean_block({"type": "point", "text": "Plain."})), "- Plain.")


class InkTest(unittest.TestCase):
    """Text colours are kept with the block, on their words, in the colours the app offers."""

    def test_text_colours_are_kept_and_checked(self):
        b = nb.clean_block({"type": "point", "text": "Note: RuBisCO fixes carbon.", "ink": [
            {"s": 0, "e": 7, "c": "red", "q": "RuBisCO"},        # moved: found again at 6
            {"s": 14, "e": 19, "c": "yellow", "q": "fixes"},     # a highlight colour, not a text colour
        ]})
        self.assertEqual(b["ink"], [{"s": 6, "e": 13, "c": "red", "q": "RuBisCO"}])

    def test_a_block_without_text_colour_has_no_ink_field(self):
        self.assertNotIn("ink", nb.clean_block({"type": "point", "text": "Plain."}))


class RichEverywhereTest(unittest.TestCase):
    """Every text in a notebook can carry formatting, kept on save and checked like the rest."""

    def test_the_notebook_section_and_block_texts_keep_their_formatting(self):
        bold = lambda q: {"fmt": {"b": [{"s": 0, "e": len(q), "q": q}]}}
        doc = nb.clean_doc({
            "title": "Photosynthesis", "summary": "Light makes sugar.", "cues": ["What is RuBisCO?"],
            "rich": {"title": bold("Photosynthesis"), "cue:0": {"ink": [{"s": 8, "e": 15, "c": "red", "q": "RuBisCO"}]},
                     "cue:5": bold("gone"), "nonsense": bold("x")},
            "sections": [{"title": "The Calvin cycle", "rich": {"title": bold("The Calvin cycle")}, "blocks": [
                {"type": "definition", "term": "RuBisCO", "text": "attaches CO2", "rich": {"term": bold("RuBisCO")}},
                {"type": "table", "rows": [["Good", "PED"], ["Petrol", "-0.2"]], "rich": {"cell:1:0": bold("Petrol"), "cell:9:9": bold("x")}},
            ]}],
        }, "lecture")
        self.assertEqual(set(doc["rich"]), {"title", "cue:0"})          # a cue that isn't there, and junk, dropped
        self.assertEqual(doc["rich"]["cue:0"]["ink"][0]["c"], "red")
        self.assertEqual(doc["sections"][0]["rich"]["title"]["fmt"]["b"][0]["q"], "The Calvin cycle")
        self.assertEqual(doc["sections"][0]["blocks"][0]["rich"]["term"]["fmt"]["b"][0]["q"], "RuBisCO")
        self.assertEqual(set(doc["sections"][0]["blocks"][1]["rich"]), {"cell:1:0"})

    def test_texts_without_formatting_carry_no_rich_field(self):
        doc = nb.clean_doc({"title": "T", "sections": [{"title": "S", "blocks": [{"type": "point", "text": "x"}]}]}, "lecture")
        self.assertNotIn("rich", doc)
        self.assertNotIn("rich", doc["sections"][0])
        self.assertNotIn("rich", doc["sections"][0]["blocks"][0])
