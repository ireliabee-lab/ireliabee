"""Write's paper search (backend/scholar.py). The failure modes are written down first, in
docs/write-citation-backbone.md ("Find papers"); each test names the one it covers.

Every provider answer here is a response recorded from the real API on 14 October 2026
(backend/tests/fixtures/scholar), served by a stand-in for link_import.fetch_public: no test
touches the network.
"""
from backend.tests import _env  # noqa: F401

import json
import socket
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi import HTTPException

from backend import link_import, scholar, writing, writing_refs as refs
from backend.core import sessions as sess

FIX = Path(__file__).parent / "fixtures" / "scholar"
QUERY = "situational variability stuttering adults"


def recorded(name: str) -> bytes:
    return (FIX / name).read_bytes()


def busy(status=429):
    err = link_import.Unreadable("The public page could not be read.")
    err.status = status
    return err


class Net:
    """Answers each provider from a recording, or fails it the way the test asks."""

    def __init__(self, openalex="openalex_stuttering.json", s2="semanticscholar_stuttering.json", doi=None):
        self.openalex, self.s2, self.doi = openalex, s2, doi or {}
        self.urls: list[str] = []

    def __call__(self, url, *, deadline=None, json_body=None, accept=None):
        self.urls.append(url)
        host = urlsplit(url).hostname
        answer = {"api.openalex.org": self.openalex, "api.semanticscholar.org": self.s2}.get(host)
        if host == "doi.org":
            answer = self.doi.get(urlsplit(url).path.lstrip("/").lower(), busy(404))
        if isinstance(answer, BaseException):
            raise answer
        if answer is None:
            raise AssertionError(f"unexpected request: {url}")
        body = answer if isinstance(answer, bytes) else recorded(answer)
        return body, "application/json", url

    def params(self, host):
        return [parse_qs(urlsplit(u).query, keep_blank_values=True) for u in self.urls if urlsplit(u).hostname == host]


@pytest.fixture(autouse=True)
def empty_cache():
    with sess._connect() as conn:
        conn.execute("DELETE FROM scholar_cache")
    yield


def search(net, query=QUERY, **filters):
    with mock.patch.object(link_import, "fetch_public", net):
        return scholar.search(query, **filters)


def titles(result):
    return [p["title"] for p in result["results"]]


# ── the search itself ──────────────────────────────────────────────────────────

def test_both_providers_are_asked_and_their_results_merged_by_doi():
    """6. The same paper from both providers is one result, naming both, with the most citations."""
    net = Net()
    got = search(net)
    assert got["providers"]["openalex"]["status"] == "ok"
    assert got["providers"]["semantic_scholar"]["status"] == "ok"
    dois = [p["doi"] for p in got["results"] if p["doi"]]
    assert len(dois) == len(set(dois)), "one result per DOI"
    both = [p for p in got["results"] if set(p["sources"]) == {"openalex", "semantic_scholar"}]
    assert both, "the recordings share papers, so some results come from both"
    daily = next(p for p in got["results"] if p["doi"] == "10.1016/j.jcomdis.2016.02.001")
    assert daily["title"] == "A preliminary investigation of daily variability of stuttering in adults"
    assert daily["year"] == 2016 and daily["venue"] == "Journal of Communication Disorders"
    assert daily["citations"] >= 135
    assert daily["authors"][0]
    # Polite pool: OpenAlex is told who is asking.
    assert net.params("api.openalex.org")[0]["mailto"] == ["support@ireliabee.co.uk"]


def test_openalex_abstracts_are_rebuilt_in_word_order():
    assert scholar.rebuild_abstract({"stuttering": [1], "Situational": [0], "varies.": [2]}) == "Situational stuttering varies."
    assert scholar.rebuild_abstract(None) == ""
    got = search(Net(s2=busy()))
    behaviour = next(p for p in got["results"] if p["doi"] == "10.1044/2020_ajslp-20-00112")
    assert behaviour["abstract"].startswith("Purpose") and len(behaviour["abstract"]) > 200
    assert "  " not in behaviour["abstract"]


@pytest.mark.parametrize("failure, status", [
    (busy(429), "busy"),
    (busy(503), "down"),
    (TimeoutError(), "down"),
    (ConnectionRefusedError(), "down"),
    (b"<html>not json</html>", "down"),
    (b'{"unexpected": true}', "down"),
])
def test_one_provider_failing_never_fails_the_search(failure, status):
    """1, 2, 14. The other provider's results, and a sentence saying which one is missing."""
    got = search(Net(s2=failure))
    assert got["results"] and all(p["sources"] == ["openalex"] for p in got["results"])
    assert got["providers"]["semantic_scholar"]["status"] == status
    assert "Semantic Scholar" in got["notice"] and "OpenAlex only" in got["notice"]
    got = search(Net(openalex=failure), query=QUERY + " again")
    assert got["results"] and all(p["sources"] == ["semantic_scholar"] for p in got["results"])
    assert "OpenAlex" in got["notice"]


def test_the_recorded_rate_limit_is_read_as_busy():
    """2. Semantic Scholar's real 429 answer, recorded while this was built."""
    body = json.loads(recorded("semanticscholar_429.json"))
    assert body["code"] == "429"
    got = search(Net(s2=busy(429)))
    assert "busy" in got["notice"]


def test_both_failing_is_one_plain_message():
    """3, 4."""
    with pytest.raises(HTTPException) as e:
        search(Net(openalex=busy(429), s2=busy(429)))
    assert e.value.status_code == 429 and "busy" in e.value.detail
    offline = socket.gaierror(11001, "getaddrinfo failed")
    with pytest.raises(HTTPException) as e:
        search(Net(openalex=offline, s2=offline))
    assert e.value.status_code == 503 and "offline" in e.value.detail


def test_an_older_copy_is_shown_when_both_fail():
    """3. Offline after searching once: the saved results, dated, instead of nothing."""
    first = search(Net())
    with sess._connect() as conn:   # older than the 7 days a search is kept
        conn.execute("UPDATE scholar_cache SET created_at = created_at - ?", (8 * 86400,))
    offline = socket.gaierror(11001, "getaddrinfo failed")
    got = search(Net(openalex=offline, s2=offline))
    assert titles(got) == titles(first)
    assert got["cached_at"] and "offline" in got["notice"]


def test_a_search_is_kept_for_seven_days_and_a_partial_one_for_an_hour():
    net = Net()
    search(net)
    search(net)
    assert len(net.urls) == 2, "the second search came from the cache"
    with sess._connect() as conn:
        conn.execute("UPDATE scholar_cache SET created_at = created_at - ?", (6 * 86400,))
    search(net)
    assert len(net.urls) == 2
    with sess._connect() as conn:
        conn.execute("UPDATE scholar_cache SET created_at = created_at - ?", (2 * 86400,))
    search(net)
    assert len(net.urls) == 4, "after 7 days it is asked again"

    partial = Net(s2=busy())
    search(partial, query="anxiety stuttering")
    with sess._connect() as conn:
        conn.execute("UPDATE scholar_cache SET created_at = created_at - 7200")
    search(partial, query="anxiety stuttering")
    assert len(partial.urls) == 4, "a search one provider missed is asked again after an hour"


def test_results_without_a_doi_merge_by_title_and_year():
    """5."""
    a = {"doi": "", "title": "Day-to-day Variability of Stuttering", "year": 2012, "citations": 3, "sources": ["openalex"]}
    b = {"doi": "", "title": "Day-to-Day  variability of stuttering.", "year": 2012, "citations": 5, "sources": ["semantic_scholar"]}
    c = {"doi": "", "title": "Day-to-day Variability of Stuttering", "year": 2019, "citations": 0, "sources": ["semantic_scholar"]}
    merged = scholar.merge([[scholar.blank(**a)], [scholar.blank(**b), scholar.blank(**c)]])
    assert len(merged) == 2
    assert merged[0]["citations"] == 5 and set(merged[0]["sources"]) == {"openalex", "semantic_scholar"}


def test_non_latin_titles_and_names_are_kept_as_written():
    """8."""
    got = search(Net(openalex="openalex_cjk.json", s2=busy()), query="口吃 成人")
    first = got["results"][0]
    assert first["title"] == "口吃成人內在與外在非詞複誦表現之比較"
    assert scholar.title_key("口吃成人內在與外在非詞複誦表現之比較", 2022) != scholar.title_key("口吃", 2022)
    item = scholar.to_csl({**first, "authors": ["王小明", "Ji-Hoon Kim"]})
    assert item["author"] == [{"literal": "王小明"}, {"family": "Kim", "given": "Ji-Hoon"}]
    assert item["title"] == first["title"]


def test_huge_result_sets_show_the_most_relevant_and_say_how_many():
    """9."""
    got = search(Net())
    assert len(got["results"]) <= scholar.RESULTS_MAX
    assert got["total"] > 1000
    net = Net()
    search(net, query="anything at all")
    assert net.params("api.openalex.org")[0]["per-page"] == [str(scholar.RESULTS_MAX)]
    assert net.params("api.semanticscholar.org")[0]["limit"] == [str(scholar.RESULTS_MAX)]


def test_queries_too_short_are_refused_before_any_request_and_long_ones_cut():
    """10, 11."""
    net = Net()
    for q in ("", "  ", "a"):
        with pytest.raises(HTTPException) as e:
            search(net, query=q)
        assert e.value.status_code == 400
    assert net.urls == []
    search(net, query="self-reported  " + "x" * 600)
    oa, s2 = net.params("api.openalex.org")[0], net.params("api.semanticscholar.org")[0]
    assert len(oa["search"][0]) <= scholar.QUERY_MAX
    assert oa["search"][0].startswith("self-reported x")
    assert s2["query"][0].startswith("self reported x"), "Semantic Scholar's search breaks on hyphens"


def test_filters_reach_each_provider_and_hold_on_the_merged_list():
    net = Net()
    got = search(net, year_from=2010, year_to=2024, open_access=True, min_citations=10, preprints=False, field="psychology")
    oa = net.params("api.openalex.org")[0]["filter"][0].split(",")
    assert "publication_year:2010-2024" in oa and "is_oa:true" in oa and "cited_by_count:>9" in oa
    assert "type:!preprint" in oa and "primary_topic.field.id:32" in oa
    s2 = net.params("api.semanticscholar.org")[0]
    assert s2["year"] == ["2010-2024"] and s2["minCitationCount"] == ["10"] and s2["fieldsOfStudy"] == ["Psychology"]
    assert "openAccessPdf" in s2
    for p in got["results"]:
        assert 2010 <= p["year"] <= 2024 and p["open_access"] and p["citations"] >= 10 and not p["preprint"]
    with pytest.raises(HTTPException):
        search(net, field="astrology")
    swapped = Net()
    search(swapped, query="variability", year_from=2024, year_to=2010)
    assert "publication_year:2010-2024" in swapped.params("api.openalex.org")[0]["filter"][0]


def test_preprints_and_retractions_are_flagged():
    """12, 13."""
    got = search(Net(openalex="openalex_preprint.json", s2=busy()), query="stutter speech recognition")
    assert got["results"] and all(p["preprint"] for p in got["results"])
    assert scholar.is_preprint_doi("10.48550/arxiv.2211.09731") and scholar.is_preprint_doi("10.1101/2020.03.01.123456")
    assert not scholar.is_preprint_doi("10.1016/j.jcomdis.2016.02.001")
    oa = json.loads(recorded("openalex_stuttering.json"))
    oa["results"][0]["is_retracted"] = True
    got = search(Net(openalex=json.dumps(oa).encode(), s2=busy()), query="retracted one")
    assert got["results"][0]["retracted"] is True


def test_missing_years_venues_and_authors_are_left_missing():
    """16."""
    item = scholar.to_csl(scholar.blank(title="Untitled draft", sources=["openalex"]))
    assert item["title"] == "Untitled draft"
    assert "issued" not in item and "author" not in item and "container-title" not in item


# ── adding a result as a source ────────────────────────────────────────────────

def project():
    return writing.create_project("Find papers", "literature_review", 4000)["id"]


def first_result(doi):
    got = search(Net(s2=busy()), query=QUERY + " " + doi)
    return next(p for p in got["results"] if p["doi"] == doi)


def test_adding_a_result_uses_the_publisher_record_and_keeps_the_abstract():
    pid = project()
    paper = first_result("10.1016/j.jcomdis.2016.02.001")
    net = Net(doi={"10.1016/j.jcomdis.2016.02.001": "doi_jcomdis.json"})
    with mock.patch.object(link_import, "fetch_public", net):
        added = scholar.add_to_project(pid, paper)
    assert not added["existing"]
    assert added["item"]["container-title"] == "Journal of Communication Disorders"
    assert added["item"]["volume"] and added["item"]["page"], "the publisher's record has volume and pages"
    assert added["abstract"] == paper["abstract"]
    assert added["meta"]["citations"] == paper["citations"] and added["meta"]["openalex_id"]
    assert refs.list_refs(pid)[0]["abstract"] == paper["abstract"]


def test_a_doi_doi_org_cannot_find_is_added_from_the_search_record():
    """15."""
    pid = project()
    paper = first_result("10.1044/2020_ajslp-20-00112")
    with mock.patch.object(link_import, "fetch_public", Net()):   # doi.org answers 404
        added = scholar.add_to_project(pid, paper)
    assert added["item"]["title"] == "Variability of Stuttering: Behavior and Impact"
    assert added["item"]["DOI"] == "10.1044/2020_ajslp-20-00112"
    assert added["item"]["issued"] == {"date-parts": [[2020]]}
    assert len(added["abstract"]) > 200


def test_a_paper_is_never_added_twice_with_or_without_a_doi():
    """5, 7."""
    pid = project()
    paper = first_result("10.1044/2020_ajslp-20-00112")
    with mock.patch.object(link_import, "fetch_public", Net()):
        one = scholar.add_to_project(pid, paper)
        two = scholar.add_to_project(pid, {**paper, "doi": paper["doi"].upper()})
    assert two["existing"] and two["id"] == one["id"]
    no_doi = scholar.blank(title="Day-to-day Variability of Stuttering", year=2012, authors=["A. Writer"], sources=["openalex"])
    a = scholar.add_to_project(pid, no_doi)
    b = scholar.add_to_project(pid, {**no_doi, "title": "Day-to-Day variability of stuttering."})
    assert b["existing"] and b["id"] == a["id"]
    assert len(refs.list_refs(pid)) == 2


def test_the_abstract_and_details_travel_with_the_project():
    pid = project()
    paper = first_result("10.1044/2020_ajslp-20-00112")
    with mock.patch.object(link_import, "fetch_public", Net()):
        scholar.add_to_project(pid, paper)
    exported = next(p for p in writing.export_all() if p["id"] == pid) if "id" in writing.export_all()[0] else \
        next(p for p in writing.export_all() if p["refs"] and p["title"] == "Find papers" and p["refs"][0]["abstract"])
    assert exported["refs"][0]["abstract"] == paper["abstract"]
    assert json.loads(exported["refs"][0]["meta"])["citations"] == paper["citations"]


def test_search_and_add_through_the_routes():
    from fastapi.testclient import TestClient
    from backend.main import app
    from backend.core import local_guard
    client = TestClient(app, base_url="http://127.0.0.1:8000", headers={"x-irb-token": local_guard.TOKEN})
    pid = project()
    with mock.patch.object(link_import, "fetch_public", Net(s2=busy())):
        res = client.get("/writing/papers/search", params={"q": QUERY, "year_from": 2000})
        assert res.status_code == 200, res.text
        paper = res.json()["results"][0]
        res = client.post(f"/writing/projects/{pid}/refs", json={"paper": paper})
        assert res.status_code == 200, res.text
        assert res.json()["abstract"] == paper["abstract"]
        assert client.get("/writing/papers/search", params={"q": "a"}).status_code == 400
