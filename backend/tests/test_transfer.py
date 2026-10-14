import base64
import json
import unittest
from unittest import mock

from backend.tests import _env  # noqa: F401  (redirects the DB before feature modules load)
from backend.core import sessions as sess  # noqa: E402
from backend.core import meeting_plans as plans  # noqa: E402
from backend.core import profile_store as profiles  # noqa: E402
from backend.routers import stories as stories_router  # noqa: E402,F401  (creates the stories table)
from backend import document_store  # noqa: E402,F401  (creates the cvs/documents tables, so this file runs on its own)
from backend import transfer  # noqa: E402
from backend import research_track as rt  # noqa: E402
from backend.errors import FriendlyError  # noqa: E402


def _wipe():
    with sess._connect() as conn:
        for t in ("profiles", "meeting_plans", "stories", "cvs", "documents"):
            conn.execute(f"DELETE FROM {t}")


def _seed_story(title="Rescued the migration"):
    with sess._connect() as conn:
        conn.execute(
            "INSERT INTO stories (title, tags, situation, task, action, result, created_at, updated_at) "
            "VALUES (?, 'leadership', 's', 't', 'a', 'r', '2026-01-01', '2026-01-01')",
            (title,),
        )


def _seed_cv(name="Main CV"):
    from backend import document_store as docs
    return docs.create_cv(name=name, original_filename=f"{name}.txt",
                          mime="text/plain", content=b"hello cv")


class ExportTest(unittest.TestCase):
    def setUp(self):
        _wipe()

    def test_bundle_carries_plans_stories_and_profiles(self):
        pid = profiles.create_profile("Ama", background="geologist")
        plans.create_plan("PhD call", profile_id=pid, counterparty="Dr. Reyes",
                          questions_ask=["What does funding look like?"])
        _seed_story()

        bundle = transfer.build_bundle(["profiles", "plans", "stories"], app_version="0.4.0")

        self.assertEqual(bundle["format"], transfer.FORMAT)
        self.assertEqual(bundle["counts"], {"profiles": 1, "plans": 1, "stories": 1})
        self.assertEqual(bundle["data"]["profiles"][0]["name"], "Ama")
        # ids never travel; the bundle-local ref links a plan to its profile
        self.assertNotIn("id", bundle["data"]["plans"][0])
        self.assertEqual(bundle["data"]["plans"][0]["profile_ref"],
                         bundle["data"]["profiles"][0]["ref"])

    def test_profile_filter_limits_plans_to_that_profile(self):
        mine = profiles.create_profile("Ama")
        theirs = profiles.create_profile("Kofi")
        plans.create_plan("Mine", profile_id=mine)
        plans.create_plan("Theirs", profile_id=theirs)

        bundle = transfer.build_bundle(["profiles", "plans"], profile_id=mine)

        self.assertEqual([p["title"] for p in bundle["data"]["plans"]], ["Mine"])
        self.assertEqual([p["name"] for p in bundle["data"]["profiles"]], ["Ama"])

    def test_files_travel_as_base64(self):
        _seed_cv()
        cv = transfer.build_bundle(["cvs"])["data"]["cvs"][0]
        self.assertEqual(base64.b64decode(cv["content_b64"]), b"hello cv")
        self.assertNotIn("content", cv)

    def test_big_files_stay_behind_and_are_listed(self):
        small = document_store.create_document("Notes", "notes.txt", "text/plain", b"short")
        big = document_store.create_document("Big book", "book.pdf", "application/pdf", b"%PDF" + b"x" * 3000)
        with mock.patch.object(transfer, "LARGE_FILE_MB", 0.002):          # about 2 KB
            bundle = transfer.build_bundle(["documents"])
        names = [d["name"] for d in bundle["data"]["documents"]]
        self.assertIn("Notes", names)
        self.assertNotIn("Big book", names)
        self.assertIn({"section": "documents", "name": "Big book", "bytes": 3004}, bundle["left_out"])
        document_store.delete_document(small)
        document_store.delete_document(big)

    def test_api_keys_never_travel(self):
        with mock.patch.object(
            transfer, "load_config",
            return_value={"model": "claude-opus-5", "anthropic_api_key": "sk-secret",
                          "deepgram_token": "dg-secret"},
        ):
            prefs = transfer.build_bundle(["preferences"])["data"]["preferences"]
        self.assertEqual(prefs, {"model": "claude-opus-5"})

    def test_empty_selection_is_rejected(self):
        with self.assertRaises(FriendlyError):
            transfer.build_bundle([])


class ImportTest(unittest.TestCase):
    def setUp(self):
        _wipe()

    def _bundle_bytes(self, sections=("profiles", "plans", "stories")) -> bytes:
        return json.dumps(transfer.build_bundle(list(sections))).encode()

    def test_round_trip_into_an_empty_install(self):
        pid = profiles.create_profile("Ama")
        plans.create_plan("PhD call", profile_id=pid, counterparty="Dr. Reyes")
        _seed_story()
        raw = self._bundle_bytes()
        _wipe()

        report = transfer.import_bundle(raw, ["profiles", "plans", "stories"])["report"]

        self.assertEqual(report["plans"], {"imported": 1, "skipped": 0})
        self.assertEqual([p["name"] for p in profiles.list_profiles()], ["Ama"])
        imported = plans.get_plan(plans.list_plans()[0]["id"])
        self.assertEqual(imported["title"], "PhD call")
        # the plan hangs off the freshly created profile, not the old id
        self.assertEqual(imported["profile_id"], profiles.list_profiles()[0]["id"])

    def test_plans_can_be_pulled_into_my_own_profile(self):
        theirs = profiles.create_profile("Kofi")
        plans.create_plan("Funding pitch", profile_id=theirs)
        raw = self._bundle_bytes(("profiles", "plans"))
        _wipe()
        mine = profiles.create_profile("Ama")

        transfer.import_bundle(raw, ["plans"], target_profile_id=mine)

        imported = plans.get_plan(plans.list_plans()[0]["id"])
        self.assertEqual(imported["profile_id"], mine)
        self.assertEqual(len(profiles.list_profiles()), 1)   # profiles weren't selected

    def test_same_named_items_are_skipped_by_default(self):
        _seed_story()
        raw = self._bundle_bytes(("stories",))

        report = transfer.import_bundle(raw, ["stories"])["report"]

        self.assertEqual(report["stories"], {"imported": 0, "skipped": 1})
        with sess._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM stories").fetchone()[0], 1)

    def test_duplicates_add_keeps_both_copies(self):
        _seed_story()
        raw = self._bundle_bytes(("stories",))

        transfer.import_bundle(raw, ["stories"], duplicates="add")

        with sess._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM stories").fetchone()[0], 2)

    def test_imported_profile_never_steals_the_active_flag(self):
        mine = profiles.create_profile("Ama")          # becomes active
        raw = json.dumps({
            "format": transfer.FORMAT, "version": 1,
            "data": {"profiles": [{"ref": 9, "name": "Kofi"}]},
        }).encode()

        transfer.import_bundle(raw, ["profiles"])

        self.assertEqual(profiles.get_active_profile()["id"], mine)

    def test_cv_bytes_survive_the_round_trip(self):
        _seed_cv()
        raw = self._bundle_bytes(("cvs",))
        _wipe()

        transfer.import_bundle(raw, ["cvs"])

        from backend import document_store as docs
        cv = docs.get_cv(docs.list_cvs()[0]["id"], include_content=True)
        self.assertEqual(cv["content"], b"hello cv")
        self.assertEqual(cv["is_active"], 0)

    def test_unknown_columns_from_another_version_are_dropped(self):
        raw = json.dumps({
            "format": transfer.FORMAT, "version": 1,
            "data": {"stories": [{"title": "From the future", "vibe_score": 11}]},
        }).encode()

        transfer.import_bundle(raw, ["stories"])

        with sess._connect() as conn:
            self.assertEqual(conn.execute("SELECT title FROM stories").fetchone()["title"],
                             "From the future")

    def test_foreign_json_is_rejected(self):
        with self.assertRaises(FriendlyError):
            transfer.import_bundle(b'{"hello": "world"}', ["stories"])

    def test_garbage_file_is_rejected(self):
        with self.assertRaises(FriendlyError):
            transfer.import_bundle(b"\x00not json", ["stories"])

    def test_newer_bundle_version_is_rejected(self):
        raw = json.dumps({"format": transfer.FORMAT, "version": transfer.VERSION + 1,
                          "data": {}}).encode()
        with self.assertRaises(FriendlyError):
            transfer.import_bundle(raw, ["stories"])

    def test_inspect_reports_contents_without_writing(self):
        _seed_story("Shipped the release")
        raw = self._bundle_bytes(("stories",))
        _wipe()

        info = transfer.inspect(raw)

        self.assertEqual(info["counts"]["stories"], 1)
        self.assertEqual(info["preview"]["stories"], ["Shipped the release"])
        with sess._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM stories").fetchone()[0], 0)

    def test_ids_in_a_file_are_never_trusted(self):
        # A hand-edited (or older/buggy) file carrying database ids must not
        # collide with rows already here and abort the whole import.
        _seed_story("Already here")
        with sess._connect() as conn:
            taken = conn.execute("SELECT id FROM stories").fetchone()[0]
        raw = json.dumps({"format": transfer.FORMAT, "version": transfer.VERSION, "data": {
            "stories": [{"id": taken, "title": "Brand new story", "tags": "", "situation": "s",
                         "task": "t", "action": "a", "result": "r"}],
        }}).encode()

        report = transfer.import_bundle(raw, ["stories"])["report"]

        self.assertEqual(report["stories"], {"imported": 1, "skipped": 0})
        with sess._connect() as conn:
            titles = [r[0] for r in conn.execute("SELECT title FROM stories ORDER BY id")]
        self.assertEqual(titles, ["Already here", "Brand new story"])

    def test_reimporting_practice_history_does_not_double_it(self):
        from backend.routers import drills
        drills._ensure_table()
        with sess._connect() as conn:
            conn.execute("DELETE FROM drills")
            conn.execute("INSERT INTO drills (topic, score, rounds, solid, created_at) "
                         "VALUES ('Kafka', 80, 3, 1, '2026-09-01T10:00:00')")
        raw = self._bundle_bytes(("drills",))

        first = transfer.import_bundle(raw, ["drills"])["report"]
        second = transfer.import_bundle(raw, ["drills"], duplicates="add")["report"]

        self.assertEqual(first["drills"], {"imported": 0, "skipped": 1})
        self.assertEqual(second["drills"], {"imported": 1, "skipped": 0})   # explicit second copy
        with sess._connect() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM drills").fetchone()[0], 2)


if __name__ == "__main__":
    unittest.main()


class PrivateStoryTest(unittest.TestCase):
    """A story marked private coaches you locally but must never reach a transfer file."""

    def setUp(self):
        _wipe()

    def _seed_private(self, title="The thing I dread being asked"):
        with sess._connect() as conn:
            conn.execute(
                "INSERT INTO stories (title, tags, situation, task, action, result, is_private, "
                "created_at, updated_at) VALUES (?, '', 's', 't', 'a', 'r', 1, '2026-01-01', '2026-01-01')",
                (title,),
            )

    def test_private_stories_are_left_out_of_the_bundle(self):
        _seed_story("Rescued the migration")
        self._seed_private()

        data = transfer.build_bundle(["stories"])["data"]["stories"]

        self.assertEqual([s["title"] for s in data], ["Rescued the migration"])

    def test_a_bank_of_only_private_stories_exports_nothing(self):
        self._seed_private()
        self.assertEqual(transfer.build_bundle(["stories"])["data"]["stories"], [])

    def test_summary_counts_what_would_travel_and_flags_what_would_not(self):
        _seed_story()
        self._seed_private()

        s = transfer.summary()

        self.assertEqual(s["stories"], 1)          # the exportable one
        self.assertEqual(s["stories_private"], 1)  # held back, shown to the user

    def test_the_private_story_still_lives_in_the_bank(self):
        self._seed_private()
        titles = [s["title"] for s in stories_router.list_stories()]
        self.assertIn("The thing I dread being asked", titles)

    def test_an_imported_private_story_keeps_its_flag(self):
        raw = json.dumps({
            "format": transfer.FORMAT, "version": 1,
            "data": {"stories": [{"title": "Hand-edited", "is_private": 1}]},
        }).encode()

        transfer.import_bundle(raw, ["stories"])

        with sess._connect() as conn:
            row = conn.execute("SELECT is_private FROM stories WHERE title = 'Hand-edited'").fetchone()
        self.assertEqual(row["is_private"], 1)


class HardQuestionTest(unittest.TestCase):
    """The fact the user dreads being asked about: stored on the profile, used only by practice."""

    def setUp(self):
        _wipe()

    def test_it_round_trips_through_the_profile(self):
        pid = profiles.create_profile("Ama", hard_question="Why is my degree classification low?")
        self.assertEqual(profiles.get_profile(pid)["hard_question"],
                         "Why is my degree classification low?")

    def test_practice_context_carries_it(self):
        profiles.create_profile("Ama", hard_question="A two-year gap between jobs")
        from backend.routers.mock import _candidate_context

        with mock.patch("backend.routers.mock.get_active_cv_text", return_value=""):
            _, context = _candidate_context(None)

        self.assertIn("A two-year gap between jobs", context)

    def test_practice_prompt_asks_about_it_only_when_set(self):
        from backend.routers.mock import _hard_question_block

        self.assertEqual(_hard_question_block({}), "")
        self.assertEqual(_hard_question_block({"hard_question": "   "}), "")
        self.assertIn("difficult fact", _hard_question_block({"hard_question": "a low grade"}))



def _wipe_research():
    with sess._connect() as conn:
        for table in ("research_track", "term_cards", "paper_cards", "research_lessons",
                      "research_projects", "research_sprints", "research_evidence", "research_days"):
            conn.execute(f"DELETE FROM {table}")


class ResearchTransferTest(unittest.TestCase):
    def setUp(self):
        _wipe_research()

    def _seed(self):
        rt.start_track("Speech science", "phd", 12, "Surprisal and disfluency.")
        card = rt.review_queue()["new"][0]
        rt.review(card["id"], 3)
        p = rt.add_paper("Warner et al. 2026", document_id=99)
        rt.update_paper(p["id"], {"question": "Does information load predict stuttering?", "pass": 2})
        rt.mark_lesson(rt.content()["levels"][0]["lessons"][0]["id"], "My answer.")
        pr = rt.create_project("proposal", "Surprisal proposal", {"question": "Q?"})
        rt.add_sprint(25, 140, pr["id"])
        rt.sign_off("Dr. Mensah", 0, ["paper-cards"], "Good start.")
        return card

    def test_the_research_track_is_empty_until_started(self):
        self.assertEqual(transfer.summary()["research"], 0)
        self.assertNotIn("research", transfer.build_bundle(["research"])["data"])

    def test_the_whole_track_round_trips_into_an_empty_install(self):
        card = self._seed()
        bundle = transfer.build_bundle(["research"])
        research = bundle["data"]["research"]
        self.assertEqual(research["track"]["field"], "Speech science")
        self.assertEqual(bundle["counts"]["research"], transfer.summary()["research"])
        self.assertNotIn("document_id", research["papers"][0])        # local links stay behind
        self.assertNotIn("project_id", research["sprints"][0])
        raw = json.dumps(bundle).encode()

        _wipe_research()
        out = transfer.import_bundle(raw, ["research"])
        self.assertGreater(out["report"]["research"]["imported"], 160)
        self.assertEqual(out["report"]["research"]["skipped"], 0)
        track = rt.get_track()
        self.assertEqual((track["field"], track["weekly_hours"]), ("Speech science", 12))
        moved = next(c for c in rt.list_terms() if c["term"] == card["term"])
        self.assertEqual(moved["last_grade"], 3)                      # the review schedule came along
        self.assertEqual(rt.list_papers()[0]["question"], "Does information load predict stuttering?")
        self.assertEqual(rt.list_projects("proposal")[0]["data"]["question"], "Q?")
        self.assertEqual(rt.sprint_stats()["words"], 140)
        self.assertEqual(rt.skill_scores()["paper-cards"]["score"], 3)  # the mentor's sign-off
        self.assertEqual(len(rt.lessons_done()), 1)

        again = transfer.import_bundle(raw, ["research"])              # importing twice adds nothing
        self.assertEqual(again["report"]["research"]["imported"], 0)
        self.assertEqual(len(rt.list_papers()), 1)

    def test_what_is_already_here_wins(self):
        self._seed()
        raw = json.dumps(transfer.build_bundle(["research"])).encode()
        _wipe_research()
        rt.start_track("Machine learning", "first-paper")
        rt.add_paper("Warner et al. 2026")
        transfer.import_bundle(raw, ["research"])
        self.assertEqual(rt.get_track()["field"], "Machine learning")     # this install's track stays
        self.assertEqual(len(rt.list_papers()), 1)                        # same title: not doubled
        self.assertEqual(rt.list_projects("proposal")[0]["title"], "Surprisal proposal")

    def test_inspect_reports_the_research_section(self):
        self._seed()
        info = transfer.inspect(json.dumps(transfer.build_bundle(["research"])).encode())
        self.assertIn("research", info["sections"])
        self.assertGreater(info["counts"]["research"], 0)
