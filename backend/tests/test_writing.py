"""Write's projects (backend/writing.py). The ways storage can go wrong, written down first (CLAUDE.md,
Testing, rule 3), one test each:

1. An unknown kind of writing or citation style is stored and breaks the screen: refused.
2. A new project is missing its structure: it gets its genre's sections, budgeted from the limit.
3. Changing the word limit loses a target set by hand: hand targets stay, the rest re-budget.
4. Edits are lost, or a deleted project leaves its sections behind.
5. Stage ticks keep an unknown stage or an item the stage doesn't have.
6. Adding, removing or reordering sections loses text or skips a section.
7. Data transfer drops sections, splits them from their project, or imports a genre this version
   doesn't know.
8. The framework file ships broken: every genre's shares add to 1, every stage's videos are known.
"""
from backend.tests import _env  # noqa: F401

import pytest
from fastapi import HTTPException

from backend import writing
from backend.core import sessions as sess


def test_unknown_kinds_and_styles_are_refused():
    with pytest.raises(HTTPException):
        writing.create_project("x", "poem")
    with pytest.raises(HTTPException):
        writing.create_project("x", "essay", style="comic-sans")
    p = writing.create_project("x", "essay")
    with pytest.raises(HTTPException):
        writing.update_project(p["id"], {"genre": "poem"})
    with pytest.raises(HTTPException):
        writing.update_project(p["id"], {"stage": "nap"})


def test_a_new_project_gets_its_structure_budgeted_from_the_limit():
    p = writing.create_project("Climate policy", "essay", 2000)
    assert [s["key"] for s in p["sections"]] == ["intro", "body1", "body2", "body3", "conclusion"]
    assert [s["target"] for s in p["sections"]] == [100, 600, 600, 600, 100]
    assert p["style"] == "apa" and p["stage"] == "task" and p["words"] == 0
    blank = writing.create_project("", "reflective")
    assert blank["title"] == "Untitled reflective writing"
    assert all(s["target"] == 0 for s in blank["sections"])   # no limit yet


def test_a_new_limit_rebudgets_but_keeps_a_target_set_by_hand():
    p = writing.create_project("Review", "literature_review", 1000)
    gap = next(s for s in p["sections"] if s["key"] == "gap")
    writing.update_section(gap["id"], {"target": 300})
    p = writing.update_project(p["id"], {"word_limit": 2000})
    by_key = {s["key"]: s for s in p["sections"]}
    assert by_key["gap"]["target"] == 300 and by_key["gap"]["target_set"]
    assert by_key["intro"]["target"] == 160
    p = writing.update_section(gap["id"], {"target": None})
    assert next(s for s in p["sections"] if s["key"] == "gap")["target"] == 240


def test_edits_are_kept_and_deleting_a_project_deletes_its_sections():
    p = writing.create_project("Paper", "research_paper", 5000)
    intro = p["sections"][1]
    p = writing.update_section(intro["id"], {"body": "Speech timing matters. It shapes fluency.", "notes": "cite Kim"})
    s = next(x for x in p["sections"] if x["id"] == intro["id"])
    assert s["words"] == 6 and s["notes"] == "cite Kim" and p["words"] == 6
    writing.update_project(p["id"], {"thesis": "Timing predicts fluency.", "brief": "Write a paper", "focus": "How does timing…?"})
    again = writing.get_project(p["id"])
    assert again["thesis"] == "Timing predicts fluency." and again["focus"].startswith("How")
    writing.delete_project(p["id"])
    with pytest.raises(HTTPException):
        writing.get_project(p["id"])
    with sess._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM writing_sections WHERE project_id = ?", (p["id"],)).fetchone()[0] == 0


def test_ticks_keep_only_known_stages_and_items():
    p = writing.create_project("x", "essay")
    p = writing.update_project(p["id"], {"ticks": {"task": [0, 2, 2, 99, -1, "x"], "nap": [0], "plan": "all"}})
    assert p["ticks"] == {"task": [0, 2]}


def test_sections_can_be_added_removed_and_reordered_without_losing_text():
    p = writing.create_project("x", "reflective", 1000)
    ids = [s["id"] for s in p["sections"]]
    writing.update_section(ids[1], {"body": "What it meant to me."})
    p = writing.add_section(p["id"], "Links to theory", after_id=ids[1])
    assert [s["title"] for s in p["sections"]][:3] == ["Describe", "Interpret", "Links to theory"]
    new_id = p["sections"][2]["id"]
    p = writing.reorder_sections(p["id"], [new_id, *ids])
    assert p["sections"][0]["id"] == new_id
    assert next(s for s in p["sections"] if s["id"] == ids[1])["body"] == "What it meant to me."
    with pytest.raises(HTTPException):
        writing.reorder_sections(p["id"], ids)   # leaves one out
    p = writing.delete_section(new_id)
    assert [s["id"] for s in p["sections"]] == ids


def test_transfer_keeps_sections_with_their_project_and_skips_unknown_genres():
    p = writing.create_project("Transfer me", "report", 1500)
    writing.update_section(p["sections"][0]["id"], {"body": "Summary text."})
    exported = [x for x in writing.export_all() if x["title"] == "Transfer me"]
    assert exported[0]["sections"][0]["body"] == "Summary text."
    assert writing.import_all(exported) == {"added": 0, "skipped": 1}          # already here
    got = writing.import_all(exported, "add")
    assert got["added"] == 1
    copies = [x for x in writing.list_projects() if x["title"] == "Transfer me"]
    assert len(copies) == 2 and all(c["words"] == 2 for c in copies)
    assert writing.import_all([{**exported[0], "genre": "poem", "created_at": "new"}])["added"] == 0


def test_the_framework_file_is_whole():
    fw = writing.framework()
    for g in fw["genres"]:
        assert abs(sum(s["share"] for s in g["sections"]) - 1) < 1e-9, g["key"]
        assert len({s["key"] for s in g["sections"]}) == len(g["sections"])
    for st in fw["stages"]:
        assert st["checklist"] and all(v in fw["videos"] for v in st["videos"]), st["key"]
    assert len(fw["stages"]) == 10


def test_key_terms_are_kept_clean_and_travel_with_the_project():
    p = writing.create_project("Terms", "essay")
    p = writing.update_project(p["id"], {"key_terms": ["remote work", " wellbeing ", "remote work", "", "policy"]})
    assert p["key_terms"] == ["remote work", "wellbeing", "policy"]
    with pytest.raises(HTTPException):
        writing.update_project(p["id"], {"key_terms": "remote work"})
    assert next(x for x in writing.export_all() if x["title"] == "Terms")["key_terms_json"] == '["remote work", "wellbeing", "policy"]'


def test_a_hand_edited_bundle_imports_what_it_can_and_never_breaks_the_screen():
    bundle = [{"title": "Edited", "genre": "essay", "created_at": "edited-1", "ticks_json": "not json",
               "key_terms_json": "{}", "sections": [{"title": "One", "body": None, "notes": ["x"]}, {"title": 5}]}]
    assert writing.import_all(bundle)["added"] == 1
    p = next(x for x in writing.list_projects() if x["created_at"] == "edited-1")
    full = writing.get_project(p["id"])
    assert full["ticks"] == {} and full["key_terms"] == []
    assert [s["title"] for s in full["sections"]] == ["One"] and full["sections"][0]["body"] == ""


def test_citation_markers_are_not_counted_as_words():
    assert writing.words("Timing matters [@kim2020, p. 12] a lot.") == 4
