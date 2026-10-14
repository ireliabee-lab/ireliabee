"""Research Track: spaced repetition, the term bank, paper cards, the panel and the exit test."""
from backend.tests import _env  # noqa: F401
import json  # noqa: E402
import unittest  # noqa: E402
from datetime import datetime, timedelta  # noqa: E402

from fastapi import HTTPException  # noqa: E402

# The columns and tables the track reads are added by these modules as they load,
# as backend.main does in the app.
from backend.routers import sessions as _sessions_router  # noqa: E402,F401
from backend import debrief as _debrief, notebook as _notebook  # noqa: E402,F401
from backend import research_track as rt  # noqa: E402
from backend.core import sessions as sess  # noqa: E402

NOW = datetime(2026, 9, 26, 9, 0, 0)


def _reset():
    with sess._connect() as conn:
        for t in ("research_track", "term_cards", "paper_cards", "research_lessons", "research_evidence", "research_projects", "research_sprints", "research_days"):
            conn.execute(f"DELETE FROM {t}")
        # The practice and meeting sessions these tests make (titled "Mock" and "Lab meeting").
        conn.execute("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE title IN ('Mock', 'Lab meeting'))")
        conn.execute("DELETE FROM sessions WHERE title IN ('Mock', 'Lab meeting')")


class ContentTest(unittest.TestCase):
    def test_the_shipped_curriculum_is_whole_and_cross_referenced(self):
        c = rt.content()
        terms = {t["id"] for t in c["terms"]}
        skills = {s["id"] for p in c["pillars"] for s in p["skills"]}
        pillars = {p["id"] for p in c["pillars"]}
        self.assertGreaterEqual(len(terms), 150)
        self.assertEqual([lv["id"] for lv in c["levels"]], list(range(7)))
        for lv in c["levels"]:
            self.assertTrue(lv["exit"]["rubric"], lv["name"])
            self.assertTrue(set(lv["exit"].get("skills", [])) <= skills)
            for lesson in lv["lessons"]:
                self.assertIn(lesson["pillar"], pillars)
                self.assertTrue(set(lesson["terms"]) <= terms, lesson["id"])
                self.assertTrue(set(lesson.get("skills", [])) <= skills, lesson["id"])
        # The skills the app scores itself must exist.
        for sid in ("research-vocabulary", "paper-cards", "three-pass-reading", "field-map", "present-a-paper", "discuss-research"):
            self.assertIn(sid, skills)
        self.assertTrue(c["levels"][0]["lessons"] and c["levels"][1]["lessons"])

    def test_every_shipped_pack_is_whole_and_cross_referenced(self):
        c = rt.content()
        skills = {s["id"] for p in c["pillars"] for s in p["skills"]}
        pillars = {p["id"] for p in c["pillars"]}
        core = {t["id"] for t in c["terms"]}
        pack_terms = [t["id"] for p in c["packs"].values() for t in p["terms"]]
        self.assertEqual(len(pack_terms), len(set(pack_terms)))          # no term defined by two packs
        self.assertFalse(core & set(pack_terms))                          # nor by a pack and the core
        known = core | set(pack_terms)
        lesson_ids = [l["id"] for p in c["packs"].values() for l in p["lessons"]]
        lesson_ids += [l["id"] for lv in c["levels"] for l in lv["lessons"]]
        self.assertEqual(len(lesson_ids), len(set(lesson_ids)))
        for pid, pack in c["packs"].items():
            self.assertEqual(pack["id"], pid)
            self.assertTrue(pack["name"] and pack["description"], pid)
            for t in pack["terms"]:
                self.assertTrue(t["definition"] and t["group"] == pack["name"], t["id"])
                self.assertTrue(set(t.get("related", [])) <= known, t["id"])
            for r in pack["resources"]:
                self.assertTrue(r["url"].startswith("https://"), r["title"])
            for lesson in pack["lessons"]:
                self.assertIn(lesson["level"], range(7), lesson["id"])
                self.assertIn(lesson["pillar"], pillars, lesson["id"])
                self.assertTrue(set(lesson["terms"]) <= known, lesson["id"])
                self.assertTrue(set(lesson["skills"]) <= skills, lesson["id"])
                self.assertTrue(lesson["read"] and lesson["do"] and lesson["speak"] and lesson["check"], lesson["id"])
                self.assertTrue(all(r["url"].startswith("https://") for r in lesson["read"]), lesson["id"])


class ScheduleTest(unittest.TestCase):
    def test_a_remembered_card_waits_longer_each_time(self):
        card = {"reps": 0, "ease": 2.5, "interval_days": 0, "lapses": 0}
        gaps = []
        for _ in range(4):
            card = rt.schedule(card, 2, NOW)
            gaps.append(card["interval_days"])
        self.assertEqual(gaps[:2], [1.0, 4.0])
        self.assertTrue(gaps[2] > gaps[1] and gaps[3] > gaps[2])

    def test_a_forgotten_card_comes_back_in_ten_minutes_and_starts_again(self):
        card = rt.schedule({"reps": 3, "ease": 2.5, "interval_days": 10, "lapses": 0}, 0, NOW)
        self.assertEqual(card["reps"], 0)
        self.assertEqual(card["lapses"], 1)
        self.assertEqual(card["due"], (NOW + timedelta(minutes=10)).isoformat())
        self.assertAlmostEqual(card["ease"], 2.3)

    def test_easy_beats_good_and_ease_never_falls_below_a_floor(self):
        base = {"reps": 2, "ease": 2.5, "interval_days": 4, "lapses": 0}
        self.assertGreater(rt.schedule(base, 3, NOW)["interval_days"], rt.schedule(base, 2, NOW)["interval_days"])
        card = {"reps": 0, "ease": 1.3, "interval_days": 0, "lapses": 0}
        self.assertEqual(rt.schedule(card, 0, NOW)["ease"], 1.3)

    def test_grades_outside_zero_to_three_are_refused(self):
        with self.assertRaises(ValueError):
            rt.schedule({}, 5, NOW)


class TrackTest(unittest.TestCase):
    def setUp(self):
        _reset()

    def test_nothing_works_before_the_track_starts(self):
        self.assertIsNone(rt.get_track())
        with self.assertRaises(HTTPException):
            rt.today(NOW)

    def test_starting_seeds_the_core_terms_once_with_lesson_terms_first(self):
        rt.start_track("Speech science", "phd", 10, "Surprisal and disfluency")
        total = len(rt.content()["terms"])
        self.assertEqual(len(rt.list_terms(tier="core")), total)
        rt.start_track("Speech science", "phd", 12, "Surprisal and disfluency")   # restart keeps cards and progress
        self.assertEqual(len(rt.list_terms(tier="core")), total)
        self.assertEqual(rt.get_track()["weekly_hours"], 12)
        first_lesson_terms = rt.content()["levels"][0]["lessons"][0]["terms"]
        new = rt.review_queue(NOW)["new"]
        self.assertEqual(len(new), rt.NEW_PER_DAY)
        self.assertEqual(new[0]["core_id"], first_lesson_terms[0])

    def test_only_ten_new_cards_a_day_and_reviewed_cards_come_back_when_due(self):
        rt.start_track("Speech science", "phd")
        for c in rt.review_queue(NOW)["new"]:
            rt.review(c["id"], 2, NOW)
        later = NOW + timedelta(hours=2)
        q = rt.review_queue(later)
        self.assertEqual(q["new"], [])          # today's allowance is spent
        self.assertEqual(q["due"], [])          # and nothing is due yet
        q = rt.review_queue(NOW + timedelta(days=1, hours=1))
        self.assertEqual(len(q["due"]), rt.NEW_PER_DAY)
        self.assertEqual(len(q["new"]), rt.NEW_PER_DAY)
        self.assertEqual(rt.term_stats()["held"], rt.NEW_PER_DAY)

    def test_definitions_in_reading_notes_become_field_cards(self):
        # Other test files share this database: their notes and study packs
        # (one defines "Surprisal") would be harvested first.
        with sess._connect() as conn:
            conn.execute("DELETE FROM notebooks WHERE kind IN ('reading', 'lecture')")
            conn.execute("UPDATE sessions SET study_json = NULL")
        rt.start_track("Speech science", "phd")
        doc = {"sections": [{"title": "Terms", "blocks": [
            {"type": "definition", "term": "Surprisal", "text": "How unexpected a word is given what came before."},
            {"type": "point", "text": "Not a term."}]}]}
        with sess._connect() as conn:
            conn.execute("INSERT INTO notebooks (kind, title, style_json, doc_json, version, edited, created_at, updated_at) "
                         "VALUES ('reading', 'Warner et al.', '{}', ?, 1, 0, ?, ?)", (json.dumps(doc), NOW.isoformat(), NOW.isoformat()))
        self.assertEqual(rt.harvest_terms(), 1)
        self.assertEqual(rt.harvest_terms(), 0)       # once only
        card = rt.list_terms("Surprisal")[0]
        self.assertEqual((card["tier"], card["source"]), ("field", "Warner et al."))

    def test_a_term_you_add_is_yours_and_duplicates_are_refused(self):
        rt.start_track("Speech science", "phd")
        self.assertEqual(rt.add_term("Disfluency", "A break in the flow of speech.")["tier"], "mine")
        with self.assertRaises(HTTPException):
            rt.add_term("disfluency ", "Again.")


class PaperAndPanelTest(unittest.TestCase):
    def setUp(self):
        _reset()
        rt.start_track("Speech science", "phd")

    def test_a_card_is_complete_only_when_every_field_is_written(self):
        p = rt.add_paper("Information load predicts stuttering events")
        self.assertFalse(p["complete"])
        p = rt.update_paper(p["id"], {f: "Written." for f in rt.PAPER_FIELDS} | {"pass": 9})
        self.assertTrue(p["complete"])
        self.assertEqual(p["pass"], 3)                 # clamped to three passes

    def _mock(self, scenario: str, scores: list[float]) -> int:
        sid = sess.create_session("Mock", "text")
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET tags = ? WHERE id = ?", (f"mock,interview,{scenario}", sid))
        for s in scores:
            sess.append_message(sid, "user", "[INTERVIEWER] Q?", speaker="interviewer")
            sess.append_message(sid, "user", "A.", speaker="you")
            sess.append_message(sid, "assistant", f"**Score: {s}/10** — verdict")
        return sid

    def test_supervisor_and_journal_club_rounds_are_read_back_from_practice(self):
        self._mock("supervisor", [6, 8])
        self._mock("journal_club", [9])
        self._mock("job", [10])                          # other practice doesn't count
        rounds = {r["persona"]: r for r in rt.panel_sessions()}
        self.assertEqual(set(rounds), {"supervisor", "journal_club"})
        self.assertEqual(rounds["supervisor"]["score"], 7.0)
        scores = rt.skill_scores()
        self.assertEqual(scores["discuss-research"]["score"], 3)
        self.assertEqual(scores["present-a-paper"]["score"], 4)

    def test_level_zero_needs_both_the_recall_and_the_oral_before_moving_up(self):
        status = rt.exit_status(0)
        self.assertFalse(status["passed"])
        with self.assertRaises(HTTPException):
            rt.advance()
        ids = {t for lesson in rt.content()["levels"][0]["lessons"] for t in lesson["terms"]}
        with sess._connect() as conn:
            conn.execute("UPDATE term_cards SET reps = 1, last_grade = 2, first_seen = ? WHERE core_id IN (%s)"
                         % ",".join("?" * len(ids)), (NOW.isoformat(), *ids))
        status = rt.exit_status(0)
        self.assertTrue(status["checks"][0]["met"])
        self.assertFalse(status["passed"])               # the oral is still to do
        self._mock("supervisor", [7, 8])
        self.assertTrue(rt.exit_status(0)["passed"])
        self.assertEqual(rt.advance()["level"], 1)
        skills = rt.content()["levels"][0]["exit"].get("skills", [])
        if skills:
            self.assertEqual(rt.skill_scores()[skills[0]]["score"], 3)

    def test_today_points_at_the_first_unfinished_lesson(self):
        first, second = rt.content()["levels"][0]["lessons"][:2]
        rt.mark_lesson(first["id"], "My answer to the check question.")
        self.assertEqual(rt.today(NOW)["lesson"]["id"], second["id"])
        self.assertGreaterEqual(rt.skill_scores()[first["skills"][0]]["score"], 1)
        with self.assertRaises(HTTPException):
            rt.mark_lesson("no-such-lesson")

    def test_readiness_covers_every_pillar(self):
        r = rt.readiness()
        self.assertEqual([p["id"] for p in r["pillars"]], ["read", "think", "do", "write", "speak", "operate"])
        self.assertEqual(len(r["weakest"]), 3)


class ProjectTest(unittest.TestCase):
    def setUp(self):
        _reset()
        rt.start_track("Speech science", "phd")

    def _mock(self, scenario: str, scores: list[float]) -> None:
        sid = sess.create_session("Mock", "text")
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET tags = ? WHERE id = ?", (f"mock,interview,{scenario}", sid))
        for s in scores:
            sess.append_message(sid, "assistant", f"**Score: {s}/10** — verdict")

    def test_every_level_now_has_lessons_up_to_three(self):
        for lv in rt.content()["levels"][:4]:
            self.assertGreaterEqual(len(lv["lessons"]), 6, lv["name"])
        self.assertEqual(rt.content()["levels"][2]["exit"]["persona"], "proposal")

    def test_a_proposal_is_complete_only_with_a_question_a_hypothesis_and_all_eight_answers(self):
        p = rt.create_project("proposal", "Surprisal and disfluency")
        self.assertEqual(p["progress"], {"done": 0, "total": 10, "complete": False, "next": "Write your research question."})
        p = rt.update_project(p["id"], data={"question": "Does surprisal predict stuttering?", "hypothesis": "Higher surprisal, more stutters."})
        self.assertEqual(p["progress"]["next"], rt.HEILMEIER[0][1])
        long = "A full answer that is comfortably longer than forty characters."
        p = rt.update_project(p["id"], data={"answers": {qid: long for qid, _ in rt.HEILMEIER[:7]}})
        self.assertFalse(p["progress"]["complete"])
        p = rt.update_project(p["id"], data={"answers": {"exams": "too short"}})
        self.assertEqual(p["progress"]["next"], rt.HEILMEIER[7][1])
        p = rt.update_project(p["id"], data={"answers": {"exams": long}})
        self.assertTrue(p["progress"]["complete"])
        self.assertEqual(p["data"]["answers"]["aim"], long)           # earlier answers survive a partial update

    def test_a_replication_needs_every_milestone_and_both_links(self):
        r = rt.create_project("replication", "Warner et al. 2026", {"claim": "Surprisal predicts stuttering."})
        r = rt.update_project(r["id"], data={"steps": {sid: True for sid, _ in rt.REPLICATION_STEPS}})
        self.assertEqual(r["progress"]["next"], "Add the link to your preregistration or plan.")
        r = rt.update_project(r["id"], data={"prereg_url": "https://osf.io/abcd", "code_url": "https://github.com/x/y", "junk": 1})
        self.assertTrue(r["progress"]["complete"])
        self.assertNotIn("junk", r["data"])
        scores = rt.skill_scores()
        for sid in ("preregistering", "reproducible-pipeline", "data-analysis", "study-design"):
            self.assertEqual(scores[sid]["score"], 2, sid)

    def test_projects_must_have_a_kind_and_a_title(self):
        with self.assertRaises(HTTPException):
            rt.create_project("essay", "x")
        with self.assertRaises(HTTPException):
            rt.create_project("proposal", "  ")

    def test_level_two_needs_the_proposal_and_a_passed_defence(self):
        with sess._connect() as conn:
            conn.execute("UPDATE research_track SET level = 2, level_at = '2000-01-01T00:00:00'")
        self.assertFalse(rt.exit_status(2)["passed"])
        long = "A full answer that is comfortably longer than forty characters."
        rt.create_project("proposal", "P", {"question": "Q?", "hypothesis": "H.", "answers": {q: long for q, _ in rt.HEILMEIER}})
        self._mock("proposal", [6])
        self.assertFalse(rt.exit_status(2)["passed"])
        self._mock("proposal", [7, 8])
        self.assertTrue(rt.exit_status(2)["passed"])
        self.assertEqual(rt.today()["project"], None)                  # nothing left open at level 2

    def test_level_three_needs_the_replication_and_reviewer_two(self):
        with sess._connect() as conn:
            conn.execute("UPDATE research_track SET level = 3, level_at = '2000-01-01T00:00:00'")
        self.assertEqual(rt.today()["project"]["kind"], "replication")  # nudged to start one
        rt.create_project("replication", "R", {"claim": "C", "prereg_url": "u", "code_url": "v",
                                                "steps": {s: True for s, _ in rt.REPLICATION_STEPS}})
        self.assertFalse(rt.exit_status(3)["passed"])
        self._mock("reviewer", [8])
        self.assertTrue(rt.exit_status(3)["passed"])
        self.assertTrue(rt.today()["weekly"]["reviewer"] is False)


class PhaseCTest(unittest.TestCase):
    def setUp(self):
        _reset()
        rt.start_track("Speech science", "phd", 10, "Surprisal and disfluency.")

    def _level(self, n: int) -> None:
        with sess._connect() as conn:
            conn.execute("UPDATE research_track SET level = ?, level_at = '2000-01-01T00:00:00'", (n,))

    def _mock(self, scenario: str, scores: list[float]) -> None:
        sid = sess.create_session("Mock", "text")
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET tags = ? WHERE id = ?", (f"mock,interview,{scenario}", sid))
        for s in scores:
            sess.append_message(sid, "assistant", f"**Score: {s}/10** — verdict")

    def _fill(self, kind: str) -> dict:
        data = {}
        for fid, _label, spec, *rest in rt.FLAT_KINDS[kind]:
            data[fid] = spec[-1] if isinstance(spec, tuple) else "x" * max(rest[-1], 1)
        return data

    def test_the_whole_ladder_has_lessons(self):
        self.assertEqual([len(lv["lessons"]) for lv in rt.content()["levels"]], [6] * 7)
        self.assertEqual([lv["exit"]["persona"] for lv in rt.content()["levels"][4:]], ["reviewer", "audience", "committee"])

    def test_a_paper_is_complete_when_every_section_is_long_enough(self):
        p = rt.create_project("paper", "Draft")
        self.assertEqual(p["progress"]["next"], "Write the abstract.")
        p = rt.update_project(p["id"], data=self._fill("paper") | {"limitations": "short"})
        self.assertEqual(p["progress"]["next"], "Write the limitations.")
        p = rt.update_project(p["id"], data={"limitations": "y" * 200})
        self.assertTrue(p["progress"]["complete"])

    def test_a_review_needs_a_recommendation_and_the_comparison_is_optional(self):
        data = self._fill("review")
        data.pop("recommendation")
        r = rt.create_project("review", "Review of Orpella", data | {"recommendation": "Maybe"})
        self.assertEqual(r["data"]["recommendation"], "")           # not one of the options
        self.assertEqual(r["progress"]["next"], "Choose your recommendation.")
        r = rt.update_project(r["id"], data={"recommendation": "Weak accept", "compare": ""})
        self.assertTrue(r["progress"]["complete"])

    def test_sprints_are_counted_and_clamped(self):
        rt.add_sprint(25, 310)
        rt.add_sprint(999, -5)
        self.assertEqual(rt.sprint_stats(), {"sprints": 2, "minutes": 265, "words": 310})
        rt.add_sprint(45, 100)
        self.assertEqual(rt.skill_scores()["structuring-a-paper"]["score"], 1)

    def test_level_four_needs_the_draft_two_reviews_and_reviewer_two(self):
        self._level(4)
        self.assertEqual(rt.today()["project"]["kind"], "paper")
        rt.create_project("paper", "Draft", self._fill("paper"))
        self.assertEqual(rt.today()["project"]["kind"], "review")   # the draft is done: reviews are next
        rt.create_project("review", "R1", self._fill("review"))
        self._mock("reviewer", [8])
        self.assertFalse(rt.exit_status(4)["passed"])
        rt.create_project("review", "R2", self._fill("review"))
        self.assertTrue(rt.exit_status(4)["passed"])
        self.assertEqual(rt.skill_scores()["peer-reviewing"]["score"], 2)

    def test_level_five_needs_the_talk_and_the_audience(self):
        self._level(5)
        rt.create_project("talk", "Talk", self._fill("talk"))
        self.assertTrue(rt.today()["weekly"]["conference"])
        self._mock("audience", [7.5])
        self.assertTrue(rt.exit_status(5)["passed"])
        self.assertFalse(rt.today()["weekly"]["conference"])

    def test_level_six_needs_a_long_enough_viva(self):
        self._level(6)
        self._mock("committee", [9] * 5)                              # too short to count
        self.assertFalse(rt.exit_status(6)["passed"])
        self._mock("committee", [7, 8, 7, 8, 7, 8, 7, 8])
        self.assertTrue(rt.exit_status(6)["passed"])

    def test_the_portfolio_gathers_the_work(self):
        rt.create_project("proposal", "My proposal", {"question": "Does surprisal predict stuttering?"})
        rt.create_project("talk", "My talk", {"message": "Hard words are surprising words."})
        p = rt.add_paper("Warner et al. 2026")
        rt.update_paper(p["id"], {"question": "Does information load predict stuttering?"})
        rt.add_sprint(25, 120)
        self._mock("supervisor", [8])
        md = rt.portfolio()
        for needle in ("# Research portfolio: Speech science", "Surprisal and disfluency.", "## Proposals",
                       "Does surprisal predict stuttering?", "## Talks", "Hard words are surprising words.",
                       "## Paper cards", "Warner et al. 2026", "Writing sprints: 1 (25 minutes, 120 words)",
                       "| Supervisor meeting | 8.0/10 |"):
            self.assertIn(needle, md)


TEST_PACK = {"id": "test-pack", "name": "Test science", "description": "A pack for tests.",
             "terms": [{"id": "lexical-surprisal", "term": "Lexical surprisal", "group": "Test science", "definition": "How unexpected a word is."},
                       {"id": "block", "term": "Block", "group": "Test science", "definition": "A silent stoppage in speech."}],
             "resources": [{"title": "TalkBank", "url": "https://talkbank.org/", "kind": "dataset", "level": 1}],
             "lessons": [{"id": "tp-1", "level": 0, "title": "Reading a fluency paper", "minutes": 20, "pillar": "read",
                          "why": "w", "read": [], "do": "d", "speak": "s", "check": "c", "terms": [], "skills": ["paper-cards"]}]}


class PhaseDTest(unittest.TestCase):
    def setUp(self):
        _reset()
        rt.content()["packs"]["test-pack"] = TEST_PACK
        rt.start_track("Speech science", "phd")

    def tearDown(self):
        rt.content()["packs"].pop("test-pack", None)

    def _session(self, lines: list[str], tags: str = "") -> int:
        sid = sess.create_session("Lab meeting", "academic-phd")
        with sess._connect() as conn:
            conn.execute("UPDATE sessions SET tags = ? WHERE id = ?", (tags, sid))
        for line in lines:
            sess.append_message(sid, "user", line, speaker="user")
            sess.append_message(sid, "user", "[INTERVIEWER] And then?", speaker="interviewer")
        return sid

    def test_turning_a_pack_on_adds_its_terms_once_and_its_lessons_to_the_ladder(self):
        self.assertFalse(next(p for p in rt.pack_list() if p["id"] == "test-pack")["active"])
        rt.set_packs(["test-pack", "no-such-pack"])
        self.assertEqual(rt.active_packs(), ["test-pack"])
        self.assertEqual({c["term"] for c in rt.list_terms(tier="pack")}, {"Lexical surprisal", "Block"})
        level0 = rt.curriculum()["levels"][0]["lessons"]
        self.assertEqual(level0[-1]["id"], "tp-1")
        self.assertEqual(level0[-1]["pack_name"], "Test science")
        rt.mark_lesson("tp-1", "an answer")                        # pack lessons count like any other
        rt.set_packs([])                                           # off again: the lesson goes, the cards stay
        self.assertNotIn("tp-1", [l["id"] for l in rt.curriculum()["levels"][0]["lessons"]])
        self.assertEqual(len(rt.list_terms(tier="pack")), 2)
        rt.set_packs(["test-pack"])
        self.assertEqual(len(rt.list_terms(tier="pack")), 2)       # not added twice

    def test_real_meetings_count_your_terms_and_flag_overclaims_but_ignore_practice(self):
        rt.set_packs(["test-pack"])
        real = self._session(["Our results suggest lexical surprisal predicts a block. We found no evidence of an effect of speech rate.",
                              "This proves the hypothesis. It always happens."])
        practice = self._session(["This definitely proves surprisal matters."], tags="mock,interview,supervisor")
        report = rt.meeting_report(limit=100)
        ids = [x["id"] for x in report["sessions"]]
        self.assertIn(real, ids)
        self.assertNotIn(practice, ids)                            # practice is not a real meeting
        s = next(x for x in report["sessions"] if x["id"] == real)
        terms = {t["term"]: t["count"] for t in s["terms"]}
        self.assertEqual(terms["Lexical surprisal"], 1)
        self.assertIn("Hypothesis", terms)                          # a core term
        self.assertEqual([o["word"].lower() for o in s["overclaims"]], ["proves", "always"])
        self.assertGreaterEqual(s["hedges"], 2)
        self.assertNotIn("And then", " ".join(o["sentence"] for o in s["overclaims"]))   # only your own lines

    def test_real_meetings_raise_vocabulary_and_hedging(self):
        many = [c["term"] for c in rt.list_terms(tier="core")[:12]]
        for _ in range(3):
            self._session([f"We used {t.lower()} here, which suggests something." for t in many])
        scores = rt.skill_scores()
        self.assertEqual(scores["research-vocabulary"]["score"], 3)
        self.assertEqual(scores["hedging-claims"]["score"], 3)

    def test_a_mentor_sign_off_is_evidence_and_appears_in_the_portfolio(self):
        rt.set_mentor("Dr. Mensah", "mensah@example.com")
        self.assertEqual(rt.get_track()["mentor_name"], "Dr. Mensah")
        with self.assertRaises(HTTPException):
            rt.sign_off("Dr. Mensah", 1, ["no-such-skill"])
        with self.assertRaises(HTTPException):
            rt.sign_off(" ", 1, ["paper-cards"])
        rt.sign_off("Dr. Mensah", 1, ["paper-cards", "three-pass-reading"], "Solid cards.")
        self.assertEqual(rt.skill_scores()["paper-cards"]["score"], 3)
        signed = rt.sign_offs()
        self.assertEqual(len(signed), 1)
        self.assertEqual(sorted(signed[0]["skills"]), ["Paper cards", "Three-pass reading"])
        md = rt.portfolio()
        self.assertIn("Mentor: Dr. Mensah", md)
        self.assertIn("Signed off by Dr. Mensah at level 1: Solid cards.", md)


class SessionTest(unittest.TestCase):
    """The guided daily session: cards, then the next lesson step by step, then done for the day."""
    DAY = datetime(2026, 9, 26, 9, 0, 0)

    def setUp(self):
        _reset()
        rt.start_track("Speech science", "phd")

    def _s(self, **kw):
        return rt.session(now=self.DAY, local=kw.get("local", self.DAY))

    def _finish(self, step_id, local=None, **kw):
        return rt.session_step(step_id, now=self.DAY, local=local or self.DAY, **kw)

    def test_a_day_starts_with_the_cards_then_walks_the_next_lesson(self):
        s = self._s()
        first = rt.content()["levels"][0]["lessons"][0]
        ids = [st["id"] for st in s["steps"]]
        self.assertEqual(ids[0], "cards")
        self.assertEqual(ids[1:6], [f"lesson:{first['id']}:{p}" for p in rt.LESSON_STEPS])
        self.assertEqual(s["current"], 0)
        self.assertFalse(s["complete"])
        intro = s["steps"][1]
        self.assertEqual(intro["lesson"]["title"], first["title"])
        self.assertEqual(len(intro["terms"]), len(first["terms"]))            # the lesson's words, defined
        self.assertEqual(s["level"]["lessons_total"], 6)

    def test_finishing_every_step_ends_the_day_and_counts_the_lesson(self):
        s = self._s()
        lesson_id = s["steps"][1]["lesson"]["id"]
        self._finish(f"lesson:{lesson_id}:do", answer="Five sentences.", done=False)   # saved, not finished
        self.assertEqual(self._s()["steps"][3]["answer"], "Five sentences.")
        for st in s["steps"]:
            s = self._finish(st["id"])
        self.assertTrue(s["complete"])
        self.assertIsNone(s["current"])
        self.assertEqual(s["streak"], 1)
        self.assertEqual(rt.lessons_done()[lesson_id]["answer"], "Five sentences.")
        self.assertEqual(s["level"]["lessons_done"], 1)
        self.assertEqual(s["next_lesson"]["id"], rt.content()["levels"][0]["lessons"][1]["id"])

    def test_the_plan_is_fixed_for_the_day_and_a_new_day_brings_the_next_lesson(self):
        s = self._s()
        for st in s["steps"]:
            self._finish(st["id"])
        again = self._s()
        self.assertEqual([st["id"] for st in again["steps"]], [st["id"] for st in s["steps"]])   # not reshuffled
        tomorrow = self.DAY + timedelta(days=1)
        nxt = rt.session(now=tomorrow, local=tomorrow)
        second = rt.content()["levels"][0]["lessons"][1]["id"]
        self.assertIn(f"lesson:{second}:intro", [st["id"] for st in nxt["steps"]])
        self.assertEqual(nxt["streak"], 1)                                       # yesterday counts until today is done

    def test_not_yet_on_the_check_sends_you_back_to_the_reading(self):
        s = self._s()
        lesson_id = s["steps"][1]["lesson"]["id"]
        for part in ("intro", "read", "do", "speak"):
            self._finish(f"lesson:{lesson_id}:{part}")
        back = self._finish(f"lesson:{lesson_id}:check", done=False)
        done = {st["id"] for st in back["steps"] if st["done"]}
        self.assertIn(f"lesson:{lesson_id}:intro", done)
        self.assertNotIn(f"lesson:{lesson_id}:read", done)
        self.assertEqual(back["steps"][back["current"]]["id"], "cards")          # the cards were never finished
        self.assertNotIn(lesson_id, rt.lessons_done())

    def test_keep_going_adds_the_next_lesson_then_the_exit_test(self):
        s = self._s()
        for st in s["steps"]:
            self._finish(st["id"])
        more = rt.session_more(now=self.DAY, local=self.DAY)
        self.assertFalse(more["complete"])
        second = rt.content()["levels"][0]["lessons"][1]["id"]
        self.assertEqual(more["steps"][more["current"]]["id"], f"lesson:{second}:intro")
        for lesson in rt.content()["levels"][0]["lessons"]:
            rt.mark_lesson(lesson["id"])
        more = rt.session_more(now=self.DAY, local=self.DAY)
        self.assertEqual(more["steps"][-1]["kind"], "exit")
        self.assertIn("checks", more["steps"][-1]["exit"])
        with self.assertRaises(HTTPException):
            rt.session_more(now=self.DAY, local=self.DAY)

    def test_a_step_not_in_today_is_refused(self):
        self._s()
        with self.assertRaises(HTTPException):
            self._finish("lesson:nope:intro")

    def test_the_streak_counts_days_in_a_row(self):
        for back in (3, 2, 1):
            day = self.DAY - timedelta(days=back)
            s = rt.session(now=day, local=day)
            for st in s["steps"]:
                rt.session_step(st["id"], now=day, local=day)
        self.assertEqual(rt.streak(self.DAY), 3)
        s = self._s()
        for st in s["steps"]:
            s = self._finish(st["id"])
        self.assertEqual(s["streak"], 4)


if __name__ == "__main__":
    unittest.main()
