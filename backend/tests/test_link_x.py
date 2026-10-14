"""X (Twitter) posts by link, from recorded public responses: no live network.

The owner pasted https://x.com/karpathy/status/2109361546505966046?s=20, a long post
("note tweet") that quotes another long post. It came back as a 278-character
fragment marked as a complete public page, and the quoted post was a bare t.co link.
"""
from backend.tests import _env  # noqa: F401

import json
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import pytest

from backend import link_import as links

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "x_posts.json").read_text(encoding="utf-8"))
LONG = "2109361546505966046"   # Karpathy, October: a long post quoting the April one
APRIL = "2042334451611693415"  # Karpathy, April: itself a long post


def fake_x(syndication=None, oembed=None, down=()):
    """fetch_public answering from the recorded responses; `down` names hosts that fail."""
    syndication = FIXTURES["syndication"] if syndication is None else syndication
    oembed = FIXTURES["oembed"] if oembed is None else oembed
    calls = []

    def fetch(url, deadline=None, **_):
        calls.append(url)
        u = urlsplit(url)
        if u.hostname in down:
            raise links.Unreadable("The public page could not be read. Open it yourself or use a screenshot.")
        q = parse_qs(u.query)
        if u.hostname == "cdn.syndication.twimg.com" and u.path == "/tweet-result":
            data = syndication.get(q["id"][0])
        elif u.hostname == "publish.twitter.com" and u.path == "/oembed":
            data = oembed.get(q["url"][0].rsplit("/", 1)[-1])
        else:
            raise AssertionError(f"X posts must be read only from X's own public endpoints, not {url}")
        if data is None:
            raise links.Unreadable("The public page could not be read. Open it yourself or use a screenshot.")
        return json.dumps(data).encode(), "application/json", url
    return fetch, calls


def preview(url, **kw):
    fetch, calls = fake_x(**kw)
    with mock.patch.object(links, "fetch_public", side_effect=fetch):
        return links.preview(url), calls


def test_long_post_is_marked_partial_not_complete():
    out, _ = preview(f"https://x.com/karpathy/status/{LONG}?s=20")
    assert not out.get("fallback")
    assert out["text"].startswith("Dusting off this tweet from April")
    # Only the start is public: the result says so, and points to the browser or a screenshot.
    assert out["partial"]
    assert "app browser" in out["partial"] and "screenshot" in out["partial"]
    assert out["author"] == "Andrej Karpathy"
    # The cut is marked in the text too, for the post and the (also long) post it quotes.
    assert out["text"].count("[X shows only the start of this long post]") == 2


def test_quoted_post_comes_with_its_author_and_text_not_a_bare_link():
    out, _ = preview(f"https://x.com/karpathy/status/{LONG}?s=20")
    assert "Quoting Andrej Karpathy (@karpathy)" in out["text"]
    assert "Judging by my tl there is a growing gap in understanding of AI capability." in out["text"]
    assert "t.co/" not in out["text"]


def test_short_post_is_complete():
    out, _ = preview("https://x.com/jack/status/20")
    assert out["text"] == "just setting up my twttr"
    assert out["author"] == "jack"
    assert out["title"] == "Post by jack"
    assert out["method"] == "public"
    assert "partial" not in out


@pytest.mark.parametrize("url", [
    "https://x.com/jack/status/20?s=20",
    "https://x.com/jack/status/20?s=46&t=AbCdEf",
    "https://twitter.com/jack/status/20",
    "https://www.twitter.com/jack/status/20/",
    "https://mobile.twitter.com/jack/status/20",
    "https://mobile.x.com/jack/status/20",
    "https://fxtwitter.com/jack/status/20",
    "https://fixupx.com/jack/status/20",
    "https://vxtwitter.com/jack/status/20",
    "https://x.com/jack/status/20/photo/1",
])
def test_tracking_params_and_other_x_hosts_lead_to_the_same_post(url):
    out, calls = preview(url)
    assert out["url"] == "https://x.com/jack/status/20"
    assert out["platform"] == "x"
    assert out["text"] == "just setting up my twttr"
    # Mirror hosts are only read as the post's address: nothing is sent to them.
    assert all(urlsplit(c).hostname in ("cdn.syndication.twimg.com", "publish.twitter.com") for c in calls)
    assert not any("s=20" in c or "s%3D20" in c for c in calls)


def test_status_link_without_a_user_name_still_reads():
    out, _ = preview("https://x.com/i/web/status/20")
    assert out["text"] == "just setting up my twttr"


def test_oembed_fallback_still_spots_a_cut_long_post():
    out, _ = preview(f"https://x.com/karpathy/status/{LONG}?s=20", down=("cdn.syndication.twimg.com",))
    assert out["text"].startswith("Dusting off this tweet")
    assert out["partial"]


def test_short_quote_post_expands_links_and_entities():
    syndication = {
        "30": {"id_str": "30", "text": "Read this &amp; that https://t.co/abc https://t.co/media",
               "display_text_range": [0, 36],
               "entities": {"urls": [{"url": "https://t.co/abc", "expanded_url": "https://example.com/paper"}]},
               "user": {"name": "Ada", "screen_name": "ada"},
               "quoted_tweet": {"id_str": "31", "text": "Short and whole.", "user": {"name": "Bob", "screen_name": "bob"}}},
        "31": {"id_str": "31", "text": "Short and whole.", "user": {"name": "Bob", "screen_name": "bob"}},
    }
    out, _ = preview("https://x.com/ada/status/30", syndication=syndication)
    assert out["text"] == "Read this & that https://example.com/paper\n\nQuoting Bob (@bob):\nShort and whole."
    assert "partial" not in out


def test_a_partial_save_is_recorded_on_the_source_with_a_plain_utc_time():
    doc = links.save_source("https://x.com/karpathy/status/2109361546505966046", "Post by Andrej Karpathy",
                            "Dusting off this tweet", "Andrej Karpathy", "public", partial=True)
    assert doc["source"]["partial"] is True
    # Stored like every other Library row (naive UTC), so the Library can show the date.
    assert "+" not in doc["created_at"] and "+" not in doc["source"]["captured_at"]
