"""A writing project's sources (backend/writing_refs.py). Written down first (CLAUDE.md, Testing,
rule 3), one test each:

1. A DOI pasted as a link, with "doi:" or with trailing punctuation is refused, or junk is accepted.
2. A failed DOI lookup (not found, offline) saves something, or shows a technical error.
3. The same DOI, or the same Library document, added twice gives two copies to cite.
4. Two sources by the same author and year share a citation key.
5. A typed-in source with no title is kept; "Last, First; Last, First" is misread.
6. Crossref's whole record (abstract, its reference list) is kept, and its list-shaped titles break formatting.
7. Sources are lost in a data transfer, or left behind when their project is deleted.
"""
from backend.tests import _env  # noqa: F401

import json
from unittest import mock

import pytest
from fastapi import HTTPException

from backend import link_import, writing, writing_refs as refs
from backend.core import sessions as sess

CROSSREF = {
    "type": "journal-article", "title": ["Deep <i>learning</i>"], "container-title": ["Nature"],
    "author": [{"given": "Yann", "family": "LeCun", "sequence": "first", "affiliation": []},
               {"given": "Yoshua", "family": "Bengio", "sequence": "additional", "affiliation": []}],
    "issued": {"date-parts": [[2015, 5, 27]]}, "volume": "521", "issue": "7553", "page": "436-444",
    "DOI": "10.1038/NATURE14539", "abstract": "<p>Long abstract…</p>", "reference": [{"key": "1"}] * 100,
    "license": [{"URL": "x"}], "publisher": "Springer Science and Business Media LLC",
}


def project():
    return writing.create_project("Sources", "research_paper", 4000)["id"]


def test_dois_are_read_in_every_pasted_form_and_junk_is_refused():
    for text in ("10.1038/nature14539", "doi:10.1038/NATURE14539", "https://doi.org/10.1038/nature14539.",
                 "See https://dx.doi.org/10.1038/nature14539)"):
        assert refs.normalise_doi(text) == "10.1038/nature14539"
    assert refs.normalise_doi("nature 14539") is None
    with pytest.raises(HTTPException) as e:
        refs.lookup_doi("not a doi")
    assert e.value.status_code == 400


def test_a_failed_lookup_saves_nothing_and_says_what_to_do():
    pid = project()
    with mock.patch.object(link_import, "fetch_public", side_effect=link_import.Unreadable("The public page could not be read.")):
        with pytest.raises(HTTPException) as e:
            refs.lookup_doi("10.1234/missing")
    assert e.value.status_code == 404 and "by hand" in e.value.detail
    assert refs.list_refs(pid) == []


def test_crossref_records_are_trimmed_to_what_a_citation_needs():
    with mock.patch.object(link_import, "fetch_public", return_value=(json.dumps(CROSSREF).encode(), "application/json", "")):
        item = refs.lookup_doi("https://doi.org/10.1038/nature14539")
    assert item["title"] == "Deep learning" and item["container-title"] == "Nature"
    assert item["author"][0] == {"given": "Yann", "family": "LeCun"}
    assert item["DOI"] == "10.1038/nature14539" and item["type"] == "article-journal"
    assert "abstract" not in item and "reference" not in item and "license" not in item


def test_the_same_doi_or_document_is_never_added_twice():
    pid = project()
    item = {"title": "Deep learning", "DOI": "10.1038/nature14539", "author": [{"family": "LeCun"}], "issued": {"date-parts": [[2015]]}}
    first = refs.add(pid, item)
    again = refs.add(pid, {**item, "DOI": "https://doi.org/10.1038/NATURE14539"})
    assert again["existing"] and again["id"] == first["id"]
    assert len(refs.list_refs(pid)) == 1


def test_citation_keys_stay_unique():
    pid = project()
    a = refs.add(pid, {"title": "One", "author": [{"family": "van Dijk", "given": "P."}], "issued": {"date-parts": [[2020]]}})
    b = refs.add(pid, {"title": "Two", "author": [{"family": "Dijk"}], "issued": {"date-parts": [[2020]]}})
    c = refs.add(pid, {"title": "Three", "author": [{"literal": "World Health Organization"}]})
    assert (a["key"], b["key"], c["key"]) == ("dijk2020", "dijk2020a", "worldnd")


def test_typed_in_sources_need_a_title_and_names_are_read_both_ways():
    with pytest.raises(HTTPException):
        refs.clean_item({"author": [{"family": "Smith"}]})
    assert refs.parse_names("Smith, Jane; van Dijk, P. and World Health Organization") == [
        {"family": "Smith", "given": "Jane"}, {"family": "van Dijk", "given": "P."}, {"literal": "World Health Organization"}]
    assert refs.display_names("Jane Smith, Bob van Lee and Kim") == [
        {"family": "Smith", "given": "Jane"}, {"family": "Lee", "given": "Bob van"}, {"literal": "Kim"}]


def test_sources_travel_with_their_project_and_go_when_it_is_deleted():
    pid = project()
    refs.add(pid, {"title": "Deep learning", "author": [{"family": "LeCun"}], "issued": {"date-parts": [[2015]]}})
    exported = next(p for p in writing.export_all() if p["title"] == "Sources" and p["refs"])
    assert exported["refs"][0]["cite_key"] == "lecun2015"
    got = writing.import_all([{**exported, "created_at": "copy-" + exported["created_at"]}])
    assert got["added"] == 1
    copy = next(p for p in writing.list_projects() if p["created_at"].startswith("copy-"))
    assert [r["key"] for r in refs.list_refs(copy["id"])] == ["lecun2015"]
    writing.delete_project(pid)
    with sess._connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM writing_refs WHERE project_id = ?", (pid,)).fetchone()[0] == 0


def test_old_wiley_dois_with_angle_brackets_are_read_whole():
    sici = "10.1002/(SICI)1097-4571(199806)49:8<693::AID-ASI4>3.0.CO;2-0"
    assert refs.normalise_doi(f"https://doi.org/{sici}") == sici.lower()
