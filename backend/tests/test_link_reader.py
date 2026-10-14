"""Any link gives clean, readable content: articles without their furniture, papers as
papers, and social posts through each platform's own public service. No live network."""
from backend.tests import _env  # noqa: F401
from unittest import mock

import pytest

from backend import link_import as links

WIKI = """<html><head><title>Stuttering - Wikipedia</title></head>
<body class="skin-vector vector-toc-available"><div id="mw-content-text" class="mw-body-content">
<div class="mw-content-ltr mw-parser-output">
<table class="infobox"><tr><th>Other names</th><td>Stammering</td></tr></table>
<p>Stuttering is a speech disorder.<sup class="reference">[1]</sup> It affects about 1% of people.<sup>[2]</sup></p>
<div class="mw-heading"><h2>Causes</h2><span class="mw-editsection">[edit]</span></div>
<p>Its causes are mostly neurological and genetic, and it varies by situation.</p>
<p>More prose about how it starts in childhood and often resolves by the teens.</p>
<p>Further prose so the article is long enough to rank as the main block of text.</p>
<p>And one more paragraph on treatment, which includes speech therapy and support.</p>
<div class="mw-heading"><h2>References</h2></div>
<ol class="references"><li>NIDCD. Retrieved 2020.</li></ol>
</div></div></body></html>"""


def test_a_wikipedia_article_keeps_its_prose_and_drops_its_furniture():
    data = links.extract_html(WIKI)
    text = data["text"]
    assert text.startswith("Stuttering is a speech disorder.")
    assert "Causes" in text and "speech therapy" in text
    for junk in ("Other names", "[edit]", "[1]", "[2]", "NIDCD", "Retrieved"):
        assert junk not in text, junk
    assert data["title"] == "Stuttering - Wikipedia"


def test_furniture_is_matched_by_whole_class_names_not_parts_of_them():
    # "vector-toc-available" on <body> once hid the whole page.
    assert not links._is_furniture("div", {"class": "vector-toc-available"})
    assert links._is_furniture("div", {"class": "toc"})
    assert not links._is_furniture("body", {"class": "toc"})


def test_a_news_page_prefers_the_article_it_publishes_as_json_ld():
    body = "The full article text. " * 60
    html = f"""<html><head><script type="application/ld+json">
    {{"@type": "NewsArticle", "headline": "Big news", "articleBody": "{body}", "author": {{"name": "A Writer"}}}}
    </script></head><body><div id="app">Loading…</div></body></html>"""
    data = links.extract_html(html)
    assert data["text"].startswith("The full article text.")
    assert data["author"] == "A Writer"


def test_a_login_walled_social_page_falls_back_to_its_public_preview_text():
    html = """<html><head><meta property="og:description" content="A long public preview of the post that the
    site shows to everyone, which is far better than the sign-in prompt alone."></head>
    <body><p>Sign in</p></body></html>"""
    assert "public preview of the post" in links.extract_html(html)["text"]


def test_a_robot_check_page_is_never_taken_for_the_article():
    with pytest.raises(links.Unreadable, match="not a robot"):
        links.extract_html("<html><title>Just a moment...</title><body>Checking your browser before accessing</body></html>")


def test_long_text_is_split_between_paragraphs_never_mid_word():
    text = "\n".join(f"Paragraph {i} " + "word " * 300 for i in range(40))
    pages = links.split_pages(text, 5000)
    assert len(pages) > 1
    assert all(len(p) <= 5000 for p in pages)
    assert all(p.startswith("Paragraph") for p in pages)


def test_a_papers_own_page_numbers_become_the_sources_pages():
    pages = links.split_pages("[p. 1]\nIntro.\n\n[p. 2]\nMethod.\n\n[p. 3]\nResults.", 20000)
    assert pages == ["Intro.", "Method.", "Results."]


def test_a_paper_page_offering_its_pdf_is_read_as_the_paper():
    page = b"""<html><head><meta name="citation_title" content="A Paper"><meta name="citation_author" content="Doe, J">
    <meta name="citation_pdf_url" content="/paper.pdf"></head><body><p>Only the abstract is on this page,
    which is short.</p></body></html>"""
    replies = [(page, "text/html; charset=utf-8", "https://journal.example/a"), (b"%PDF-1.7 ...", "application/pdf", "https://journal.example/paper.pdf")]
    with mock.patch.object(links, "fetch_public", side_effect=replies), \
         mock.patch.object(links, "pdf_text", return_value="[p. 1]\nThe whole paper."):
        data = links.read_page("https://journal.example/a", 0)
    assert data["text"] == "[p. 1]\nThe whole paper."
    assert (data["title"], data["author"]) == ("A Paper", "Doe, J")


def test_a_closed_access_paper_keeps_the_abstract_page():
    page = b"""<html><head><meta name="citation_pdf_url" content="/locked.pdf"></head>
    <body><article><p>The abstract of a paper behind a paywall, long enough to be the article text.</p></article></body></html>"""
    with mock.patch.object(links, "fetch_public", side_effect=[(page, "text/html", "https://j.example/a"), links.Unreadable("403")]):
        data = links.read_page("https://j.example/a", 0)
    assert "behind a paywall" in data["text"]


def test_pubmed_reads_the_abstract_through_ncbis_public_api():
    with mock.patch.object(links, "fetch_public", return_value=(b"1. Front Neurosci. 2020.\nAbstract text.", "text/plain", "")), \
         mock.patch.object(links, "_json", return_value={"result": {"32292321": {"title": "A Title", "authors": [{"name": "Maguire GA"}]}}}):
        data = links.pubmed_text("https://pubmed.ncbi.nlm.nih.gov/32292321/", 0)
    assert "Abstract text." in data["text"] and data["title"] == "A Title" and data["author"] == "Maguire GA"


PMC_XML = b"""<pmc-articleset><article><front><article-meta><title-group><article-title>Stuttering drugs</article-title></title-group>
<contrib-group><contrib contrib-type="author"><name><surname>Maguire</surname><given-names>G</given-names></name></contrib></contrib-group>
<abstract><p>An abstract.</p></abstract></article-meta></front>
<body><sec><title>Introduction</title><p>Body text.</p></sec></body>
<back><ref-list><ref>Citation that must not appear.</ref></ref-list></back></article></pmc-articleset>"""


def test_pubmed_central_gives_the_full_article_without_its_reference_list():
    with mock.patch.object(links, "fetch_public", return_value=(PMC_XML, "text/xml", "")):
        data = links.pmc_text("https://pmc.ncbi.nlm.nih.gov/articles/PMC7118465/", 0)
    assert "An abstract." in data["text"] and "Introduction" in data["text"] and "Body text." in data["text"]
    assert "must not appear" not in data["text"]
    assert data["title"] == "Stuttering drugs"


def test_an_xml_reply_declaring_entities_is_refused():
    evil = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>'
    with mock.patch.object(links, "fetch_public", return_value=(evil, "text/xml", "")), pytest.raises(links.Unreadable):
        links.pmc_text("https://pmc.ncbi.nlm.nih.gov/articles/PMC1/", 0)


def test_bluesky_reads_a_post_and_its_replies():
    thread = {"thread": {"post": {"author": {"displayName": "Ann", "handle": "ann.bsky.social"}, "record": {"text": "Hello world"}},
                         "replies": [{"post": {"author": {"handle": "bob.bsky.social"}, "record": {"text": "Hi Ann"}}}]}}
    with mock.patch.object(links, "_json", side_effect=[{"did": "did:plc:1"}, thread]):
        data = links.bluesky_text("https://bsky.app/profile/ann.bsky.social/post/3abc", 0)
    assert "Hello world" in data["text"] and "bob.bsky.social: Hi Ann" in data["text"]


def test_mastodon_and_tiktok_use_their_public_services():
    with mock.patch.object(links, "_json", return_value={"content": "<p>Toot <b>text</b></p>", "account": {"display_name": "Eu"}}):
        assert links.mastodon_text("https://mastodon.social/@Gargron/1", 0)["text"] == "Toot text"
    with mock.patch.object(links, "_json", return_value={"title": "A caption #tag", "author_name": "Scout"}):
        assert links.tiktok_text("https://www.tiktok.com/@s/video/1", 0)["text"] == "A caption #tag"


def test_reddit_explains_why_it_needs_the_users_own_browser():
    with mock.patch.object(links, "_json", side_effect=links.Unreadable("403")):
        with pytest.raises(links.Unreadable, match="Open the link yourself"):
            links.reddit_text("https://www.reddit.com/r/x/comments/1/", 0)


@pytest.mark.parametrize("url,platform", [
    ("https://mastodon.social/@Gargron/1", "mastodon"),
    ("https://pmc.ncbi.nlm.nih.gov/articles/PMC1/", "pmc"),
    ("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1/", "pmc"),
    ("https://pubmed.ncbi.nlm.nih.gov/1/", "pubmed"),
    ("https://bsky.app/profile/a/post/b", "bluesky"),
    ("https://example.com/blog/post", "web"),
])
def test_each_link_goes_to_its_platforms_reader(url, platform):
    assert links.platform_for(url) == platform


# ── From the review of these changes ─────────────────────────────────────────

def test_a_pdfs_blank_pages_keep_later_page_numbers_right():
    pages = links.split_pages("[p. 1]\nIntro.\n\n[p. 2]\n\n\n[p. 3]\nResults.", 20000)
    assert pages == ["Intro.", "", "Results."]


def test_a_one_page_pdf_keeps_no_page_marker_in_its_text():
    assert links.split_pages("[p. 1]\nThe only page.", 20000) == ["The only page."]


def test_an_abstract_only_pubmed_central_article_keeps_its_abstract():
    xml = b"""<pmc-articleset><article><front><article-meta><title-group><article-title>T</article-title></title-group>
    <abstract><p>Just the abstract.</p></abstract></article-meta></front></article></pmc-articleset>"""
    with mock.patch.object(links, "fetch_public", return_value=(xml, "text/xml", "")):
        assert "Just the abstract." in links.pmc_text("https://pmc.ncbi.nlm.nih.gov/articles/PMC2/", 0)["text"]


def test_deeply_nested_json_ld_cannot_crash_the_reader():
    deep = "[" * 20000 + "]" * 20000
    html = f'<html><head><script type="application/ld+json">{deep}</script></head><body><article><p>{"Real text. " * 30}</p></article></body></html>'
    assert "Real text." in links.extract_html(html)["text"]


def test_a_reddit_short_link_goes_to_the_post():
    seen = []
    with mock.patch.object(links, "_json", side_effect=lambda url, d: seen.append(url) or (_ for _ in ()).throw(links.Unreadable("403"))):
        with pytest.raises(links.Unreadable):
            links.reddit_text("https://redd.it/1abc", 0)
    assert seen[0].startswith("https://www.reddit.com/comments/1abc.json")


def test_a_sign_in_page_is_not_taken_for_the_content():
    login = ('<html><head><title>LinkedIn Login, Sign in | LinkedIn</title>'
             '<meta property="og:description" content="Login to LinkedIn to keep in touch with people you know."></head>'
             '<body><form><input name="session_key"></form></body></html>')
    with pytest.raises(links.Unreadable, match="sign in"):
        links.extract_html(login)


def test_an_article_about_signing_in_is_still_read():
    article = ("<html><head><title>Why passkeys beat passwords</title></head><body><article>"
               + "<p>Passkeys replace passwords when you log in to a site. " * 40 + "</p></article></body></html>")
    assert "Passkeys" in links.extract_html(article)["text"]
