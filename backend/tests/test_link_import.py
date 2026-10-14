"""Offline fixtures for public link extraction, fetch boundaries and source reuse."""
from backend.tests import _env  # noqa: F401

import json
import time
from unittest import mock

import pytest
from fastapi import HTTPException

from backend import link_import as links, document_store, reading
from backend.core.sessions import _connect


def test_article_extraction_omits_navigation_scripts_and_hidden_content():
    result = links.extract_html('''<html><head><title>A useful article</title><meta name="author" content="Ada"></head><body>
    <nav><a>Noise noise noise</a></nav><main><h1>Readable heading</h1><p>The main readable article.</p>
    <script>secret()</script><p hidden>Hidden text</p><aside>Ads</aside></main><footer>Copyright</footer></body></html>''')
    assert result == {"title": "A useful article", "author": "Ada", "text": "Readable heading\nThe main readable article."}


def test_readability_prefers_prose_over_link_heavy_sidebar():
    data = links.extract_html('<title>Story</title><body><div><a>' + 'Menu ' * 80 + '</a></div><div><p>' + 'Real prose. ' * 40 + '</p></div></body>')
    assert 'Real prose.' in data['text']
    assert 'Menu' not in data['text']


def test_oembed_takes_post_text_and_author_without_script_or_author_footer():
    result = links.parse_oembed({"html": '<blockquote><p>Hello &amp; goodbye <a>link</a></p>— Author <a>Date</a></blockquote><script>bad()</script>', "author_name": "Ada"})
    assert result == {"text": "Hello & goodbye link", "author": "Ada", "title": "Post by Ada"}


@pytest.mark.parametrize('url', ['file:///etc/passwd', 'http://localhost/x', 'http://127.0.0.1', 'http://10.0.0.1', 'http://169.254.169.254', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'https://a:b@example.com', 'http://example.com:8000/', 'javascript:alert(1)'])
def test_private_and_non_web_urls_are_rejected(url):
    with pytest.raises(HTTPException):
        links.clean_url(url)


def test_dns_rebinding_and_mixed_public_private_dns_are_rejected():
    with mock.patch.object(links.socket, 'getaddrinfo', return_value=[(2, 1, 6, '', ('8.8.8.8', 443)), (2, 1, 6, '', ('127.0.0.1', 443))]):
        with pytest.raises(links.Unreadable):
            links.public_addresses('example.com', 443)


def test_connection_uses_checked_numeric_address_and_original_tls_name():
    sock, tls = mock.Mock(), mock.Mock()
    ctx = mock.Mock()
    ctx.wrap_socket.return_value = tls
    with mock.patch.object(links, 'public_addresses', return_value=['8.8.8.8']), mock.patch.object(links.socket, 'create_connection', return_value=sock) as connect, mock.patch.object(links.ssl, 'create_default_context', return_value=ctx):
        conn = links._connection(links.urlsplit('https://example.com/article'), time.monotonic() + 20)
    assert connect.call_args.args[0] == ('8.8.8.8', 443)
    ctx.wrap_socket.assert_called_once_with(sock, server_hostname='example.com')
    assert conn.host == 'example.com'
    assert conn.sock is tls


def response(status=200, body=b'<main>Article</main>', headers=None):
    res = mock.Mock(status=status)
    headers = headers or {'Content-Type': 'text/html'}
    res.getheader.side_effect = lambda key, default=None: headers.get(key, default)
    res.read.side_effect = [body, b'']
    conn = mock.Mock()
    conn.getresponse.return_value = res
    return conn


def test_redirect_to_loopback_is_not_followed():
    conn = response(status=302, headers={'Location': 'http://127.0.0.1/status'})
    with mock.patch.object(links, '_connection', return_value=conn) as connect:
        out = links.preview('https://example.com')
    assert out['fallback'] is True
    assert connect.call_count == 1
    conn.close.assert_called_once()


def test_fetch_limit_enforced_without_content_length():
    conn = response(body=b'x' * 21)
    with mock.patch.object(links, 'MAX_BYTES', 20), mock.patch.object(links, '_connection', return_value=conn):
        with pytest.raises(links.Unreadable, match='10 MB'):
            links.fetch_public('https://example.com')
    conn.close.assert_called_once()


def test_public_request_has_no_cookie_authorization_or_proxy():
    conn = response()
    with mock.patch.object(links, '_connection', return_value=conn):
        links.fetch_public('https://example.com')
    headers = conn.request.call_args.kwargs['headers']
    assert set(headers) == {'User-Agent', 'Accept', 'Accept-Language', 'Accept-Encoding'}
    assert not {'Cookie', 'Authorization', 'Proxy-Authorization'} & set(headers)


def test_timeout_cleanly_offers_browser_fallback():
    with mock.patch.object(links, '_connection', side_effect=TimeoutError()):
        assert links.preview('https://example.com')['fallback'] is True


def test_x_falls_back_to_public_oembed_when_embed_data_is_unreadable():
    # (Full X behaviour, from recorded responses, is in test_link_x.py.)
    with mock.patch.object(links, 'fetch_public', return_value=(json.dumps({'html': '<p>A public post</p>', 'author_name': 'Ada'}).encode(), 'application/json', '')) as fetch:
        out = links.preview('https://x.com/ada/status/123')
    assert fetch.call_args_list[0].args[0].startswith('https://cdn.syndication.twimg.com/tweet-result?')
    assert fetch.call_args.args[0].startswith('https://publish.twitter.com/oembed?')
    assert out['text'] == 'A public post'
    assert out['author'] == 'Ada'
    assert out['platform'] == 'x'


def test_missing_meta_configuration_offers_browser_fallback():
    from backend.core import hosted
    with mock.patch.object(hosted, 'access_token', return_value=None):
        assert links.preview('https://www.instagram.com/p/abc/')['fallback'] is True


# A YouTube link must give the whole transcript, in the language spoken. Ways it failed or could:
# the watch page's own caption links now come back empty (they need a browser token); the first
# track is one of dozens of translations; the player API has no captions; a caption link points
# off YouTube; a link already carries its own fmt=.
YT_PAGE = 'ytcfg.set({"INNERTUBE_API_KEY": "AIzaTestKey_1"}); var ytInitialPlayerResponse = ' + json.dumps(
    {'playabilityStatus': {'status': 'OK'}, 'videoDetails': {'videoId': 'abcdEFGH123', 'title': 'Lecture', 'author': 'Ada'},
     # the page's own tracks: these links are the ones that now come back empty
     'captions': {'playerCaptionsTracklistRenderer': {'captionTracks': [{'baseUrl': 'https://www.youtube.com/api/timedtext?v=page&exp=xpe'}]}}}) + ';'
CAPTION = {'events': [{'segs': [{'utf8': 'First line.'}]}, {'segs': [{'utf8': 'Second line.'}]}]}


def _youtube(tracks, caption=CAPTION, audio_tracks=None):
    """youtube_text with the player API answering `tracks`; returns the result and every fetch made."""
    calls = []

    def fetch(url, deadline=None, json_body=None):
        calls.append((url, json_body))
        if '/youtubei/v1/player' in url:
            renderer = {'captionTracks': tracks, **({'audioTracks': audio_tracks} if audio_tracks else {})}
            return json.dumps({'captions': {'playerCaptionsTracklistRenderer': renderer}}).encode(), 'application/json', url
        return (caption if isinstance(caption, bytes) else json.dumps(caption).encode()), 'application/json', url
    with mock.patch.object(links, 'fetch_public', side_effect=fetch):
        return links.youtube_text(YT_PAGE, time.monotonic() + 20), calls


def track(lang, kind=None, v='x'):
    return {'languageCode': lang, 'baseUrl': f'https://www.youtube.com/api/timedtext?v={v}&lang={lang}&fmt=srv3', **({'kind': kind} if kind else {})}


def test_youtube_reads_tracks_from_the_player_api_not_the_page():
    out, calls = _youtube([track('en')])
    assert out == {'title': 'Lecture', 'author': 'Ada', 'text': 'First line. Second line.'}
    player_url, body = calls[0]
    assert player_url == 'https://www.youtube.com/youtubei/v1/player?key=AIzaTestKey_1'
    assert body['videoId'] == 'abcdEFGH123' and body['context']['client']['clientName'] == 'ANDROID'
    assert 'v=page' not in calls[1][0], "the page's own caption link comes back empty"


def test_youtube_takes_the_spoken_language_not_the_first_translation():
    _, calls = _youtube([track('ar'), track('de'), track('fr', 'asr'), track('fr'), track('en')])
    assert '&lang=fr&' in calls[1][0] and 'kind' not in calls[1][0]
    _, calls = _youtube([track('ar'), track('en', 'asr')])
    assert '&lang=en&' in calls[1][0], 'automatic captions in the spoken language beat a translation'
    _, calls = _youtube([track('ar'), track('en-GB')])
    assert '&lang=en-GB&' in calls[1][0], 'with no automatic track, English'


def test_youtube_replaces_the_links_own_format():
    _, calls = _youtube([track('en')])
    assert calls[1][0].endswith('&lang=en&fmt=json3') and calls[1][0].count('fmt=') == 1


def test_youtube_refuses_a_caption_link_off_youtube():
    with pytest.raises(links.Unreadable):
        _youtube([{'languageCode': 'en', 'baseUrl': 'https://evil.example/timedtext?v=1'}])


@pytest.mark.parametrize('tracks,caption', [([], CAPTION), ([track('en')], b''), ([track('en')], {'events': []})])
def test_youtube_without_captions_says_so(tracks, caption):
    with pytest.raises(links.Unreadable):
        _youtube(tracks, caption)


def test_youtube_no_transcript_offers_fallback():
    with mock.patch.object(links, 'fetch_public', return_value=(b'var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"}};', 'text/html', '')):
        assert links.preview('https://www.youtube.com/watch?v=123')['fallback'] is True


def test_saved_link_is_normal_document_with_pages_and_provenance():
    doc = links.save_source('https://example.com/article', 'Article', 'A paragraph.\nAnother paragraph.', 'Ada', 'browser')
    assert document_store.get_document_text(doc['id']) == 'A paragraph.\nAnother paragraph.'
    assert doc['source']['url'] == 'https://example.com/article'
    assert doc['source']['author'] == 'Ada'
    assert doc['source']['method'] == 'browser'
    assert doc['source']['captured_at']
    assert reading.status(doc['id'])['state'] == 'ready'
    assert reading.pages_text(doc['id'], [1])[0]['text'] == 'A paragraph.\nAnother paragraph.'
    assert next(d for d in document_store.list_documents() if d['id'] == doc['id'])['source'] == doc['source']
    document_store.delete_document(doc['id'])
    with _connect() as conn:
        assert conn.execute('SELECT 1 FROM document_sources WHERE document_id = ?', (doc['id'],)).fetchone() is None


def test_social_origin_without_token_cannot_reach_local_backend():
    from fastapi.testclient import TestClient
    from backend.main import app
    client = TestClient(app, base_url='http://127.0.0.1:8000')
    for origin in ['https://www.instagram.com', 'https://www.facebook.com', 'https://x.com']:
        res = client.get('/status', headers={'Origin': origin})
        assert res.status_code == 403


def test_hidden_ancestors_do_not_win_article_ranking():
    data = links.extract_html('<div hidden><article>' + 'Hidden secret ' * 100 + '</article></div><main><p>Visible text.</p></main>')
    assert data['text'] == 'Visible text.'


# Captions arrive as screen-sized fragments; saved one per line they read as a thin column.
# Ways joining them could go wrong: a word lost or duplicated; the automatic captions' "\n"
# roll events kept; a paragraph cut mid-sentence when there is punctuation; unpunctuated
# captions never broken; a marked speaker change merged into the last speaker's words.
def ev(ms, text, **kw):
    return {"tStartMs": ms, "dDurationMs": 800, "segs": [{"utf8": text}], **kw}


def test_captions_join_into_paragraphs_without_losing_a_word():
    events = [ev(0, "so by now you have"), {"tStartMs": 900, "aAppend": 1, "segs": [{"utf8": "\n"}]}, ev(1000, "probably heard of it")]
    assert links.caption_paragraphs(events) == ["so by now you have probably heard of it"]
    many = [ev(i * 1000, f"Sentence number {i} is here.") for i in range(200)]
    joined = " ".join(links.caption_paragraphs(many))
    assert joined == " ".join(f"Sentence number {i} is here." for i in range(200))


def test_punctuated_captions_break_at_a_sentence_end():
    events = [ev(i * 1000, "word " * 9 + ("ends here." if i % 3 == 2 else "and")) for i in range(60)]
    paras = links.caption_paragraphs(events)
    assert len(paras) > 1
    assert all(p.endswith(".") for p in paras[:-1])
    assert all(len(p) <= links.PARAGRAPH_MAX + 80 for p in paras)


def test_unpunctuated_captions_break_at_pauses():
    events, t = [], 0
    for i in range(40):
        events.append(ev(t, "and then we keep talking about the model"))
        t += 2600 if i % 12 == 11 else 1000   # a long breath every twelve lines
    paras = links.caption_paragraphs(events)
    assert len(paras) >= 3


def test_a_marked_speaker_change_starts_a_new_turn():
    events = [ev(0, "So tell me the history of Muse."), ev(1000, ">> Sure. The first thing is the memo."),
              ev(2000, "- And when did it start?")]
    assert links.caption_paragraphs(events) == [
        "So tell me the history of Muse.", "— Sure. The first thing is the memo.", "— And when did it start?"]



# A video YouTube has dubbed into other languages (seen 12 Oct 2026 on a University of Melbourne
# talk): one set of automatic captions per dub, Arabic listed first, so "the first automatic track
# is the spoken language" picked the Arabic dub. YouTube's own default for the audio is the answer.
DUBBED = [track('ar', 'asr', 'ar'), track('bn', 'asr', 'bn'), track('nl-NL', 'asr', 'nl'), track('en', None, 'en'), track('en', 'asr', 'enauto')]


def test_a_dubbed_video_uses_youtubes_own_default_caption_track():
    audio = [{'audioTrackId': f'{l}.10', 'hasDefaultTrack': True, 'defaultCaptionTrackIndex': 3} for l in ('ar', 'bn', 'en-US')]
    _, calls = _youtube(DUBBED, audio_tracks=audio)
    assert '&lang=en&' in calls[1][0] and 'v=en&' in calls[1][0]


def test_a_dubbed_video_with_no_default_prefers_person_made_english_over_the_first_dub():
    _, calls = _youtube(DUBBED)
    assert 'v=en&' in calls[1][0]
    _, calls = _youtube([track('ar', 'asr', 'ar'), track('en', 'asr', 'enauto')])
    assert 'v=enauto&' in calls[1][0]
