"""Public links become ordinary Library documents; no cookies, AI or relay in fetching."""
from __future__ import annotations

import http.client
import ipaddress
import json
import re
import socket
import ssl
import time
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import quote, urlencode, urljoin, urlsplit, urlunsplit

from fastapi import HTTPException

MAX_BYTES = 10 * 1024 * 1024  # Library reference-file limit
MAX_CHARS = 5_000_000        # reading.LIBRARY_TEXT_CHARS
FETCH_SECONDS = 20


class Unreadable(ValueError):
    #: The HTTP status that made the page unreadable, when one did (429: the site is rate-limiting us).
    status = 0


def clean_url(value: str) -> str:
    try:
        u = urlsplit(value.strip())
        host = (u.hostname or "").rstrip(".").lower()
        if len(value) > 4096 or u.scheme not in ("http", "https") or not host or u.username is not None or u.password is not None:
            raise ValueError()
        if u.port not in (None, 80, 443):
            raise ValueError()
        if host in ("localhost", "tauri.localhost") or host.endswith((".localhost", ".local", ".internal")) or "." not in host and ":" not in host:
            raise ValueError()
        try:
            if not ipaddress.ip_address(host).is_global:
                raise ValueError()
        except ValueError:
            # A numeric address must never fall through as a hostname.
            if re.fullmatch(r"[\d.]+", host) or ":" in host:
                raise
        return urlunsplit((u.scheme, u.netloc, u.path or "/", u.query, ""))
    except (ValueError, AttributeError):
        raise HTTPException(400, "Paste one public http or https link, without a password or a private address.")


def public_addresses(host: str, port: int) -> list[str]:
    addresses = list(dict.fromkeys(x[4][0] for x in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)))
    if not addresses or any(not ipaddress.ip_address(x).is_global for x in addresses):
        raise Unreadable("This link points to a private address.")
    return addresses


def _connection(u, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError()
    port = u.port or (443 if u.scheme == "https" else 80)
    addresses = public_addresses(u.hostname, port)
    # Connect to the checked numeric address, preserving the original TLS SNI
    # and Host. No second DNS lookup, ambient proxy, cookies or credentials.
    sock = socket.create_connection((addresses[0], port), timeout=min(10, remaining))
    try:
        if u.scheme == "https":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=u.hostname)
            conn = http.client.HTTPSConnection(u.hostname, port, timeout=min(10, remaining))
        else:
            conn = http.client.HTTPConnection(u.hostname, port, timeout=min(10, remaining))
        conn.sock = sock
        return conn
    except BaseException:
        sock.close()
        raise


def fetch_public(url: str, *, deadline: float | None = None, json_body: dict | None = None,
                 accept: str | None = None) -> tuple[bytes, str, str]:
    """GET a public URL, or POST `json_body` to it (a public API such as YouTube's player).
    `accept` asks for a particular format, such as citation data from doi.org."""
    deadline = deadline or time.monotonic() + FETCH_SECONDS
    current = clean_url(url)
    for _ in range(5):
        u = urlsplit(current)
        conn = _connection(u, deadline)
        try:
            headers = {
                # Named honestly, with a contact page: sites like Wikipedia and Reddit
                # refuse anonymous clients.
                "User-Agent": "Mozilla/5.0 (compatible; iReliabee/1.0; +https://ireliabee.co.uk)",
                "Accept": accept or "text/html,application/xhtml+xml,application/pdf,application/json;q=0.9,*/*;q=0.5",
                "Accept-Language": "en", "Accept-Encoding": "identity",
            }
            body = None
            if json_body is not None:
                body = json.dumps(json_body).encode()
                headers["Content-Type"] = "application/json"
            conn.request("POST" if body else "GET", urlunsplit(("", "", u.path or "/", u.query, "")), body=body, headers=headers)
            res = conn.getresponse()
            if res.status in (301, 302, 303, 307, 308):
                target = res.getheader("Location")
                if not target:
                    raise Unreadable("The page redirected without a destination.")
                if "google.com/sorry" in target or "/captcha" in target.lower():
                    raise Unreadable("The site asked to confirm you're not a robot. Open the link yourself or use a screenshot.")
                current = clean_url(urljoin(current, target))
                json_body = None  # a redirected POST is not re-sent
                continue
            if not 200 <= res.status < 300:
                err = Unreadable("The public page could not be read. Open it yourself or use a screenshot.")
                err.status = res.status
                raise err
            length = res.getheader("Content-Length")
            if length and int(length) > MAX_BYTES:
                raise Unreadable("The page exceeds the Library's 10 MB limit.")
            chunks, size = [], 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                if conn.sock is not None:
                    conn.sock.settimeout(min(10, remaining))
                chunk = res.read(64 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    raise Unreadable("The page exceeds the Library's 10 MB limit.")
                chunks.append(chunk)
            return b"".join(chunks), res.getheader("Content-Type", ""), current
        finally:
            conn.close()
    raise Unreadable("The page redirects too many times.")


@dataclass
class Node:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)


#: Classes and ids that mark page furniture rather than the article: side panels,
#: Wikipedia's infobox, edit links and citation markers, menus, share bars,
#: cookie banners, comments and "related" lists.
BOILERPLATE = re.compile(
    r"^(infobox.*|navbox.*|vertical-navbox|sidebar.*|side-bar|mw-editsection.*|reference|references|reflist.*|refbegin|"
    r"citation|cite-bracket|toc|toccolours|catlinks|printfooter|metadata|ambox.*|hatnote|shortdescription|noprint|"
    r"mw-jump-link|navigation-not-searchable|cookie.*|consent.*|gdpr.*|share|shares|sharing|share-.*|social|social-.*|"
    r"related|related-.*|recommend.*|newsletter.*|subscribe.*|signup|advert.*|ads?|ad-.*|promo.*|sponsor.*|"
    r"breadcrumbs?|comments?|comment-list|comments-.*|site-footer|footer|menu|main-menu|navigation|navbar|"
    r"skip-link|author-bio|paywall.*|modal|popup|outbrain.*|taboola.*)$", re.I)
#: Elements that are the page or the article itself: never treated as furniture.
NEVER_FURNITURE = {"html", "body", "main", "article"}
SKIP = {"script", "style", "noscript", "nav", "aside", "footer", "header", "form", "button", "svg", "iframe",
        "template", "head", "select", "option", "label", "dialog", "figure"}
BLOCK = {"p", "div", "section", "article", "main", "li", "h1", "h2", "h3", "h4", "h5", "h6", "br", "blockquote",
         "pre", "tr", "dd", "dt", "figcaption", "table", "ul", "ol"}
HEADINGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
#: Headings after which an article is only end matter.
END_MATTER = re.compile(r"^(references|notes|notes and references|footnotes|citations|sources|bibliography|"
                        r"see also|external links|further reading|works cited|related articles|read more|"
                        r"more from .*|you may also like|recommended|comments?)$", re.I)


REFERENCE_LIST = re.compile(r"^(\d+\.?\s*)?(references|reference list|bibliography|works cited|citations|"
                            r"literature cited|notes and references|footnotes)$", re.I)


def _is_furniture(tag: str, attrs: dict) -> bool:
    if tag in NEVER_FURNITURE:
        return False
    if tag in SKIP or "hidden" in attrs or attrs.get("aria-hidden") == "true" or attrs.get("role") in ("navigation", "banner", "contentinfo", "complementary", "dialog"):
        return True
    style = str(attrs.get("style") or "").replace(" ", "").lower()
    if "display:none" in style or "visibility:hidden" in style:
        return True
    names = f"{attrs.get('class') or ''} {attrs.get('id') or ''}".split()
    return any(BOILERPLATE.match(name) for name in names)


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("body")
        self.stack = [self.root]
        self.nodes = [self.root]
        self.meta = {}
        self.json_ld = []
        self._in_ld = False

    def handle_starttag(self, tag, attrs):
        attrs = {k: (v or "") for k, v in attrs}
        parent = self.stack[-1]
        if tag == "script" and attrs.get("type", "").lower() == "application/ld+json":
            self._in_ld = True
        if parent.attrs.get("_blocked") or _is_furniture(parent.tag, parent.attrs):
            attrs["_blocked"] = True
        n = Node(tag, attrs)
        self.stack[-1].children.append(n)
        self.nodes.append(n)
        if tag == "meta":
            key = (attrs.get("property") or attrs.get("name") or attrs.get("itemprop") or "").lower()
            if key and key not in self.meta:
                self.meta[key] = attrs.get("content", "")
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            if len(self.stack) > 256:
                raise Unreadable("The page is too deeply nested to read safely.")
            self.stack.append(n)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag == "script":
            self._in_ld = False
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, text):
        if self._in_ld:
            self.json_ld.append(text)
            return
        self.stack[-1].children.append(text)


def node_text(node, *, links=False):
    if isinstance(node, str):
        return node if not links else ""
    if _is_furniture(node.tag, node.attrs):
        return ""
    if node.tag == "sup" and re.fullmatch(r"\s*\[?\s*(\d+|[a-z]|citation needed|note \d+)\s*\]?\s*", "".join(c for c in node.children if isinstance(c, str)) or "x", re.I):
        return ""  # a citation marker like [12]
    if links and node.tag == "a":
        return node_text(node)
    inner = "".join(node_text(n, links=links) for n in node.children)
    if node.tag in ("td", "th"):
        return inner.strip() + " | "
    if node.tag in HEADINGS:
        return "\n" + inner.strip() + "\n"
    return inner + ("\n" if node.tag in BLOCK else "")


def plain(text):
    lines = (re.sub(r"[ \t\r\f\v]+", " ", line).strip(" |") for line in text.split("\n"))
    return "\n".join(line for line in lines if line).strip()


def tidy(text: str) -> str:
    """Drop leftovers of page furniture and the end matter after the article."""
    text = re.sub(r"\[(\d+|[a-z]|citation needed|clarification needed|edit|note \d+)\]", "", text, flags=re.I)
    lines = [ln for ln in text.split("\n") if ln.strip() and ln.strip().lower() not in ("[edit]", "edit", "share", "advertisement", "skip to content")]
    # End matter ends the article: a reference list (often a third of a paper's
    # page) after the first fifth, the softer "see also / read more" kind only
    # in the last 40%.
    cut = len(lines)
    for i, ln in enumerate(lines):
        heading = ln.strip().rstrip(":")
        if len(heading) >= 60:
            continue
        if (i > len(lines) * 0.2 and REFERENCE_LIST.match(heading)) or (i > len(lines) * 0.6 and END_MATTER.match(heading)):
            cut = i
            break
    return "\n".join(lines[:cut]).strip()


def _json_ld_article(parser) -> dict:
    """News sites often publish the clean article inside their page as JSON-LD."""
    found = {}

    def walk(x):
        if isinstance(x, list):
            for y in x:
                walk(y)
        elif isinstance(x, dict):
            if isinstance(x.get("articleBody"), str) and len(x["articleBody"]) > len(found.get("text", "")):
                author = x.get("author")
                if isinstance(author, list):
                    author = author[0] if author else ""
                found.update(text=x["articleBody"], title=str(x.get("headline") or ""),
                             author=str(author.get("name", "") if isinstance(author, dict) else author or ""))
            for v in x.values():
                if isinstance(v, (dict, list)):
                    walk(v)
    for raw in parser.json_ld:
        try:
            walk(json.loads(raw))
        except (ValueError, RecursionError):
            continue
    return found


#: Pages that stand in for the real one while a site checks for robots.
BOT_CHECK = re.compile(r"(checking your browser|just a moment\.\.\.|enable javascript and cookies to continue|"
                       r"verify you are (a )?human|are you a robot|attention required|access denied|"
                       r"please complete the security check|unusual traffic from your computer)", re.I)


#: A sign-in page standing in for the content ("LinkedIn Login, Sign in | LinkedIn", "Log in to Facebook").
SIGN_IN_WALL = re.compile(r"^\s*(log ?in|sign ?in|sign up|join)\b|\b(log ?in|sign ?in)\s*(to\b|[|·•:–-])", re.I)


def extract_html(html: str) -> dict:
    head = re.sub(r"<[^>]+>", " ", html[:20000])
    if BOT_CHECK.search(head) and len(re.sub(r"\s+", " ", head)) < 4000:
        raise Unreadable("The site asked to confirm you're not a robot. Open the link yourself or use a screenshot.")
    parser = PageParser()
    parser.feed(html)
    meta = parser.meta
    h1 = next((n for n in parser.nodes if n.tag == "h1" and not n.attrs.get("_blocked")), None)
    title_node = next((n for n in parser.nodes if n.tag == "title"), None)
    title = meta.get("citation_title") or meta.get("og:title") or (node_text(title_node) if title_node else "") \
        or (plain(node_text(h1)) if h1 else "")
    # Readability-style ranking: prefer article/main, otherwise the block with the
    # most prose and least link text. Furniture was already left out above.
    candidates = [n for n in parser.nodes if n.tag in {"article", "main", "section", "div", "body"} and not n.attrs.get("_blocked")]

    def score(n):
        text = node_text(n)
        prose = max(0, len(text) - 2 * len(node_text(n, links=True)))
        semantic = n.tag in {"article", "main"} or n.attrs.get("role") == "main" or n.attrs.get("itemprop") == "articleBody" \
            or "mw-parser-output" in (n.attrs.get("class") or "")
        return prose * (3 if semantic else 1)

    best = max(candidates, key=score, default=parser.root)
    text = tidy(plain(node_text(best)))
    ld = _json_ld_article(parser)
    if len(ld.get("text", "")) > max(500, len(text) * 0.6):
        text = tidy(plain(ld["text"]))
        title = title or ld.get("title", "")
    description = plain(meta.get("og:description") or meta.get("description") or meta.get("citation_abstract") or "")
    if len(text) < 200 and len(description) > len(text):
        # Login-walled social pages (LinkedIn, Threads, Instagram) often carry only their preview text.
        text = description
    if not text:
        raise Unreadable("There is no readable public text on this page.")
    if SIGN_IN_WALL.search(plain(title)) and len(text) < 1500:
        raise Unreadable("This page asks you to sign in first. Open it in the app browser, sign in yourself, "
                         "then click Save to notebook.")
    author = meta.get("author") or meta.get("article:author") or meta.get("citation_author") or ld.get("author", "")
    found = {"title": plain(title)[:200], "text": text, "author": plain(author)[:200]}
    if meta.get("citation_pdf_url"):
        found["pdf_url"] = meta["citation_pdf_url"]
    return found


def parse_oembed(data: dict) -> dict:
    html = data.get("html")
    if not isinstance(html, str) or not html:
        raise Unreadable("This public post did not include readable text.")
    parser = PageParser()
    parser.feed(html)
    paragraphs = [plain(node_text(n)) for n in parser.nodes if n.tag == "p"]
    text = "\n".join(x for x in paragraphs if x) or plain(node_text(parser.root))
    if not text:
        raise Unreadable("This public post did not include readable text.")
    author = plain(str(data.get("author_name") or ""))[:200]
    return {"text": text, "author": author, "title": plain(str(data.get("title") or (f"Post by {author}" if author else "Public post")))[:200]}


#: Hosts that show an X post at the same /<user>/status/<id> path. The mirrors are only
#: read as the post's address: the post itself is always read from X.
X_HOSTS = ("x.com", "twitter.com", "fxtwitter.com", "fixupx.com", "vxtwitter.com", "fixvx.com", "twittpr.com")
X_STATUS = re.compile(r"^/(?:(\w{1,15})/status(?:es)?|i(?:/web)?/status)/(\d{1,25})(?:/|$)")


def x_post(url: str) -> tuple[str, str]:
    """The post's id and its plain x.com address: no ?s=20 / ?t= tracking, no /photo/1, one host."""
    m = X_STATUS.match(urlsplit(url).path or "")
    if not m:
        raise Unreadable("This X link isn't a post. Open it yourself or use a screenshot.")
    user, post_id = m.groups()
    return post_id, f"https://x.com/{user or 'i'}/status/{post_id}"


def _x_token(post_id: str) -> str:
    """The token X's own embed widget sends with a post id (react-tweet's formula)."""
    x = int(post_id) / 1e15 * 3.141592653589793
    digits, whole, frac = "0123456789abcdefghijklmnopqrstuvwxyz", int(x), x - int(x)
    head = ""
    while whole:
        head, whole = digits[whole % 36] + head, whole // 36
    tail = ""
    for _ in range(12):
        frac *= 36
        tail += digits[int(frac)]
        frac -= int(frac)
    return re.sub(r"(0+|\.)", "", (head or "0") + "." + tail) or "0"


def _x_syndication(post_id: str, deadline) -> dict:
    """X's own public embed data for a post: what the embed widget on any site reads, no sign-in."""
    data = _json("https://cdn.syndication.twimg.com/tweet-result?" + urlencode(
        {"id": post_id, "lang": "en", "token": _x_token(post_id)}), deadline)
    if not isinstance(data, dict) or not isinstance(data.get("text"), str):
        raise Unreadable("This public post did not include readable text.")
    return data


def _x_body(post: dict, quoted_id: str = "") -> str:
    """A post's text with its links expanded, and its photo/video links and the link to
    the post it quotes (which follows in full) dropped."""
    import html as html_lib
    text = html_lib.unescape(post.get("text") or "")
    urls = {u.get("url"): u.get("expanded_url") for u in (post.get("entities") or {}).get("urls") or []
            if isinstance(u, dict) and u.get("url") and u.get("expanded_url")
            and not (quoted_id and X_STATUS.match(urlsplit(u["expanded_url"]).path or "")
                     and urlsplit(u["expanded_url"]).path.rstrip("/").endswith("/" + quoted_id))}
    text = re.sub(r"https://t\.co/\w+", lambda m: urls.get(m.group(0), ""), text)
    return plain(re.sub(r"[ \t]+\n", "\n", text).strip())


def _x_name(user) -> str:
    user = user if isinstance(user, dict) else {}
    name, handle = plain(str(user.get("name") or "")), str(user.get("screen_name") or "")
    return f"{name} (@{handle})" if name and handle else name or (f"@{handle}" if handle else "")


#: Where a long post's public start ends, in the saved text.
X_CUT = "… [X shows only the start of this long post]"
#: What a cut long post says, so the review screen can offer the whole one.
X_PARTIAL = ("X shares only the start of long posts with apps, so this is not the whole post. "
             "To save all of it, open it in the app browser and click Save to notebook, or use a screenshot.")


def x_text(url: str, deadline) -> dict:
    """A public X post and the post it quotes, from X's own embed data (oEmbed if that fails).

    A long post ("note tweet") is public only up to its first ~280 characters: no
    sign-in-free X endpoint gives the rest. The start is kept, marked `partial`,
    so it is never saved as if it were the whole post."""
    post_id, canonical = x_post(url)
    try:
        post = _x_syndication(post_id, deadline)
    except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
        raw, _, _ = fetch_public("https://publish.twitter.com/oembed?" + urlencode(
            {"url": canonical, "omit_script": "true"}), deadline=deadline)
        data = parse_oembed(json.loads(raw))
        # oEmbed cuts a long post with "…", then links the rest (or the quoted post).
        if re.search(r"…\s*(https://t\.co/\w+\s*)*$", data["text"]):
            data["partial"] = X_PARTIAL
        return {**data, "url": canonical}
    author = plain(str((post.get("user") or {}).get("name") or ""))[:200]
    quoted = post.get("quoted_tweet") if isinstance(post.get("quoted_tweet"), dict) else None
    if quoted and quoted.get("id_str") and "note_tweet" not in quoted:
        # The quoted post's own record says whether it, too, is a cut long post.
        try:
            if "note_tweet" in _x_syndication(str(quoted["id_str"]), deadline):
                quoted = {**quoted, "note_tweet": True}
        except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException):
            pass

    def body(p, quoted_id=""):
        # The cut is marked in the text itself, so a notebook built from it knows.
        return _x_body(p, quoted_id) + (f" {X_CUT}" if "note_tweet" in p else "")
    parts = [body(post, str(quoted.get("id_str") or "") if quoted else "")]
    if quoted and quoted.get("text"):
        parts.append(f"Quoting {_x_name(quoted.get('user')) or 'another post'}:\n{body(quoted)}")
    partial = "note_tweet" in post or bool(quoted and "note_tweet" in quoted)
    found = {"text": "\n\n".join(p for p in parts if p), "author": author,
             "title": f"Post by {author}" if author else "X post", "url": canonical}
    if partial:
        found["partial"] = X_PARTIAL
    return found


PLATFORMS = (
    ("youtube", ("youtube.com", "youtu.be")),
    ("x", X_HOSTS),
    ("instagram", ("instagram.com",)),
    ("facebook", ("facebook.com", "fb.com", "fb.watch")),
    ("reddit", ("reddit.com", "redd.it")),
    ("bluesky", ("bsky.app",)),
    ("tiktok", ("tiktok.com",)),
    ("linkedin", ("linkedin.com",)),
    ("threads", ("threads.net", "threads.com")),
    ("arxiv", ("arxiv.org",)),
    ("pubmed", ("pubmed.ncbi.nlm.nih.gov",)),
    ("pmc", ("pmc.ncbi.nlm.nih.gov", "europepmc.org")),
)


def platform_for(url):
    host = (urlsplit(url).hostname or "").lower().removeprefix("www.")
    for platform, domains in PLATFORMS:
        if any(host == d or host.endswith("." + d) for d in domains):
            return platform
    if host == "ncbi.nlm.nih.gov" and (urlsplit(url).path or "").startswith("/pmc/articles/"):
        return "pmc"
    if re.match(r"^/@[\w.]+/\d+$", urlsplit(url).path or ""):
        return "mastodon"  # any Mastodon server: /@user/123456
    return "web"


#: The client YouTube's own Android app sends; its caption links work without a browser token.
YOUTUBE_CLIENT = {"clientName": "ANDROID", "clientVersion": "20.10.38"}


def _youtube_tracks(html, video_id, deadline) -> tuple[list[dict], Optional[int]]:
    """The caption tracks, and the one YouTube itself would show for the video's audio (or None)."""
    key = re.search(r'"INNERTUBE_API_KEY"\s*:\s*"([\w-]+)"', html)
    if not key or not re.fullmatch(r"[\w-]{6,20}", video_id or ""):
        return [], None
    raw, _, _ = fetch_public(f"https://www.youtube.com/youtubei/v1/player?key={key.group(1)}", deadline=deadline,
                             json_body={"context": {"client": YOUTUBE_CLIENT}, "videoId": video_id})
    renderer = json.loads(raw).get("captions", {}).get("playerCaptionsTracklistRenderer", {})
    return renderer.get("captionTracks", []), default_track(renderer.get("audioTracks") or [])


def default_track(audio_tracks: list) -> Optional[int]:
    """YouTube's own pick of caption track for the video's audio. A video dubbed into other languages
    has one audio track per language; they name the same default, so the most named one wins."""
    picks = [a.get("defaultCaptionTrackIndex") for a in audio_tracks
             if isinstance(a, dict) and a.get("hasDefaultTrack") and isinstance(a.get("defaultCaptionTrackIndex"), int)]
    return max(set(picks), key=picks.count) if picks else None


def _spoken_track(tracks: list[dict], default: Optional[int] = None) -> dict:
    """The track in the language actually spoken: a video can carry dozens of
    translations, listed alphabetically, so the first is often not it.

    YouTube's own default for the audio comes first. Without it: a single set of
    automatic captions ("asr") is in the spoken language, and a person-made track in
    that language is better still. Several automatic tracks mean the video is dubbed
    (an Arabic dub has Arabic automatic captions), so they say nothing about the
    original: then a person-made track, English first, else English automatic ones."""
    if default is not None and 0 <= default < len(tracks):
        return tracks[default]
    autos = [t for t in tracks if t.get("kind") == "asr"]
    if len(autos) > 1:
        english = lambda t: (t.get("languageCode") or "").split("-")[0] == "en"  # noqa: E731
        made = [t for t in tracks if t.get("kind") != "asr"]
        return next((t for t in made if english(t)), None) or (made[0] if made else None) \
            or next((t for t in autos if english(t)), autos[0])
    auto = autos[0] if autos else None
    if auto:
        lang = auto.get("languageCode", "")
        return next((t for t in tracks if t.get("kind") != "asr" and t.get("languageCode") == lang), auto)
    return next((t for t in tracks if (t.get("languageCode") or "").split("-")[0] == "en"), tracks[0])


#: A paragraph is closed at the first good place once it is this long, and cut anyway at the hard limit.
PARAGRAPH_CHARS, PARAGRAPH_MAX = 420, 1200
#: A silence this long (ms) between caption lines ends a paragraph: the speaker has moved on.
PARAGRAPH_PAUSE_MS = 1500
#: Human-made captions mark a new speaker with ">>" or a leading "- ".
SPEAKER_MARK = re.compile(r"^\s*(?:>>+\s*|-\s+|–\s+)")


def caption_paragraphs(events: list[dict]) -> list[str]:
    """YouTube's caption events as readable paragraphs.

    Captions arrive as screen-sized fragments ("so by now you have probably" /
    "heard of chat GPT it has taken the world"); kept one per line they read as a
    thin column of broken lines. They are joined into paragraphs that end at a
    sentence end (or, for older automatic captions with no punctuation, at a
    pause), and a marked speaker change starts a new turn, shown with a dash."""
    lines = []
    for e in events:
        if e.get("aAppend") or not e.get("segs"):
            continue  # automatic captions' "\n" events only roll the screen
        text = re.sub(r"\s+", " ", "".join(s.get("utf8", "") for s in e["segs"])).strip()
        if not text:
            continue
        start = int(e.get("tStartMs") or 0)
        last = max([int(s.get("tOffsetMs") or 0) for s in e["segs"]] + [0])
        # The end of the last word, roughly: automatic captions overlap their durations.
        lines.append((start, start + (last + 400 if last else int(e.get("dDurationMs") or 0)), text))
    joined = " ".join(t for _, _, t in lines)
    punctuated = len(re.findall(r"[.?!](?:\s|$)", joined)) * 600 >= len(joined)

    paragraphs, current, prev_end = [], "", None
    def close():
        nonlocal current
        if current.strip():
            paragraphs.append(current.strip())
        current = ""
    for start, end, text in lines:
        turn = bool(SPEAKER_MARK.match(text))
        if turn:
            close()
            text = "— " + SPEAKER_MARK.sub("", text)
        elif current:
            gap = start - prev_end if prev_end is not None else 0
            pause = gap >= PARAGRAPH_PAUSE_MS
            at_sentence = bool(re.search(r"[.?!][\"')\]]*$", current))
            # With no punctuation to go by, the longer the paragraph, the shorter the breath that ends it.
            breath = gap >= (700 if len(current) < 800 else 250)
            if len(current) >= PARAGRAPH_MAX or (len(current) >= PARAGRAPH_CHARS and (at_sentence if punctuated else breath)) \
                    or (pause and len(current) >= 120 and (at_sentence or not punctuated)):
                close()
        current = f"{current} {text}" if current else text
        prev_end = end
    close()
    return paragraphs


def youtube_text(html, deadline):
    match = re.search(r'(?:var\s+)?ytInitialPlayerResponse\s*=\s*', html)
    if not match:
        raise Unreadable("No public YouTube transcript is available. Use a screenshot instead.")
    data, _ = json.JSONDecoder().raw_decode(html[match.end():])
    if data.get("playabilityStatus", {}).get("status") != "OK":
        raise Unreadable("This video is not publicly playable.")
    details = data.get("videoDetails", {})
    # The watch page's own caption links now need a browser token and come back
    # empty, so the tracks come from YouTube's public player API, as its app asks.
    tracks, default = _youtube_tracks(html, details.get("videoId", ""), deadline)
    if not tracks:
        raise Unreadable("No public YouTube transcript is available.")
    caption_url = _spoken_track(tracks, default).get("baseUrl", "")
    if platform_for(caption_url) != "youtube":
        raise Unreadable("The transcript endpoint is not a public YouTube endpoint.")
    raw, _, _ = fetch_public(re.sub(r"&fmt=[^&]*", "", caption_url) + "&fmt=json3", deadline=deadline)
    if not raw.strip():
        raise Unreadable("YouTube sent an empty transcript. Open the video yourself or use a screenshot.")
    captions = json.loads(raw)
    text = "\n".join(caption_paragraphs(captions.get("events", [])))
    if not text.strip():
        raise Unreadable("The transcript is empty.")
    description = plain(details.get("shortDescription", ""))
    body = plain(text) + (f"\n\nVideo description\n{description}" if description else "")
    return {"text": body, "title": details.get("title", "YouTube transcript"), "author": details.get("author", "")}


def meta_oembed(url):
    import requests
    from .core import hosted
    token = hosted.access_token()
    if not token:
        raise Unreadable("Sign in to use public Meta posts, or open the link yourself.")
    # Only the post URL and our service authentication go to the hosted service.
    # The Meta app access token stays exclusively in its server environment.
    with requests.post(hosted.api_base() + "/links/oembed", json={"url": url}, headers={"Authorization": f"Bearer {token}"}, timeout=12) as res:
        if res.status_code != 200:
            raise Unreadable("Public Meta import is unavailable. Open the link yourself.")
        return parse_oembed(res.json())


def _json(url, deadline):
    raw, _, _ = fetch_public(url, deadline=deadline)
    return json.loads(raw.decode("utf-8", errors="replace"))


def reddit_text(url, deadline):
    """A public Reddit post and its top comments, from Reddit's own public JSON."""
    try:
        return _reddit_json(url, deadline)
    except Unreadable:
        raise Unreadable("Reddit doesn't let apps read posts directly. Open the link yourself to save the post and its comments.")


def _reddit_json(url, deadline):
    u = urlsplit(url)
    if (u.hostname or "").lower().endswith("redd.it"):
        u = urlsplit(f"https://www.reddit.com/comments/{u.path.strip('/')}")
    api = urlunsplit(("https", "www.reddit.com", u.path.rstrip("/") + ".json", "raw_json=1&limit=30", ""))
    data = _json(api, deadline)
    post = data[0]["data"]["children"][0]["data"]
    comments = [c["data"] for c in data[1]["data"]["children"] if c.get("kind") == "t1"][:30]
    lines = [post.get("title", ""), plain(post.get("selftext", ""))]
    if post.get("url") and not post.get("is_self"):
        lines.append(f"Link: {post['url']}")
    if comments:
        lines.append("\nTop comments")
        lines += [f"{c.get('author', '')}: {plain(c.get('body', ''))}" for c in comments if c.get("body")]
    return {"text": plain("\n".join(lines)), "title": plain(post.get("title", ""))[:200] or "Reddit post",
            "author": post.get("author", "")}


def bluesky_text(url, deadline):
    """A public Bluesky post and its replies, from Bluesky's public API."""
    m = re.match(r"^/profile/([^/]+)/post/([\w]+)", urlsplit(url).path)
    if not m:
        raise Unreadable("This Bluesky link isn't a post.")
    handle, rkey = m.groups()
    did = handle if handle.startswith("did:") else _json(
        "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?" + urlencode({"handle": handle}), deadline)["did"]
    thread = _json("https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?" + urlencode(
        {"uri": f"at://{did}/app.bsky.feed.post/{rkey}", "depth": 1}), deadline)["thread"]
    post = thread["post"]
    author = post.get("author", {}).get("displayName") or post.get("author", {}).get("handle", "")
    lines = [post.get("record", {}).get("text", "")]
    replies = [r["post"] for r in thread.get("replies", []) if isinstance(r, dict) and "post" in r][:30]
    if replies:
        lines.append("\nReplies")
        lines += [f"{r.get('author', {}).get('handle', '')}: {r.get('record', {}).get('text', '')}" for r in replies]
    return {"text": plain("\n".join(lines)), "title": f"Post by {author}" if author else "Bluesky post", "author": author}


def mastodon_text(url, deadline):
    """A public Mastodon post, from its own server's public API."""
    u = urlsplit(url)
    status_id = u.path.rstrip("/").rsplit("/", 1)[-1]
    data = _json(urlunsplit((u.scheme, u.netloc, f"/api/v1/statuses/{status_id}", "", "")), deadline)
    parser = PageParser()
    parser.feed(data.get("content", ""))
    author = data.get("account", {}).get("display_name") or data.get("account", {}).get("acct", "")
    return {"text": plain(node_text(parser.root)), "title": f"Post by {author}" if author else "Mastodon post", "author": author}


def pubmed_text(url, deadline):
    """A PubMed record's citation and abstract, from NCBI's public E-utilities API
    (PubMed's web pages refuse apps)."""
    m = re.match(r"^/(\d+)", urlsplit(url).path)
    if not m:
        raise Unreadable("This PubMed link isn't an article.")
    pmid = m.group(1)
    base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
    raw, _, _ = fetch_public(base + "efetch.fcgi?" + urlencode({"db": "pubmed", "id": pmid, "rettype": "abstract",
                                                                "retmode": "text", "tool": "ireliabee"}), deadline=deadline)
    text = raw.decode("utf-8", errors="replace").strip()
    if not text:
        raise Unreadable("PubMed returned no abstract for this article.")
    try:
        summary = _json(base + "esummary.fcgi?" + urlencode({"db": "pubmed", "id": pmid, "retmode": "json", "tool": "ireliabee"}),
                        deadline)["result"][pmid]
        title = summary.get("title", "")
        author = ", ".join(a.get("name", "") for a in summary.get("authors", [])[:3])
    except (OSError, ValueError, KeyError):
        title, author = "", ""
    return {"text": text, "title": plain(title)[:200] or f"PubMed {pmid}", "author": plain(author)[:200]}


def pmc_text(url, deadline):
    """A PubMed Central article's full text (title, abstract, sections), from NCBI's
    public API: the reference list is left out, figures keep their captions."""
    import xml.etree.ElementTree as ET
    m = re.search(r"PMC(\d+)", url, re.I)
    if not m:
        raise Unreadable("This PubMed Central link isn't an article.")
    raw, _, _ = fetch_public("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?" + urlencode(
        {"db": "pmc", "id": m.group(1), "tool": "ireliabee"}), deadline=deadline)
    if b"<!ENTITY" in raw[:65536]:
        # NCBI never declares entities; a response that does is refused rather than
        # risk an entity-expansion attack (the parser fetches no external entities).
        raise Unreadable("PubMed Central returned an unexpected response.")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        raise Unreadable("PubMed Central returned an unreadable article.")
    article = root.find(".//article")
    if article is None:
        raise Unreadable("PubMed Central has no public text for this article.")

    def words(el):
        return plain(" ".join(el.itertext())) if el is not None else ""

    title = words(article.find(".//article-meta//article-title"))
    names = [words(n) for n in article.findall(".//article-meta//contrib[@contrib-type='author']/name")[:3]]
    lines = [title]
    abstract = article.find(".//article-meta/abstract")
    if abstract is not None:
        lines += ["Abstract", words(abstract)]
    body = article.find("body")
    if body is None and abstract is None:
        raise Unreadable("PubMed Central has no public text for this article.")
    if body is not None:
        for el in body.iter():
            if el.tag == "title":
                lines.append("\n" + words(el))
            elif el.tag == "p":
                lines.append(words(el))
            elif el.tag == "caption":
                lines.append("Figure: " + words(el))
    return {"text": plain("\n".join(x for x in lines if x)), "title": title[:200] or f"PMC{m.group(1)}",
            "author": ", ".join(n for n in names if n)[:200]}


def tiktok_text(url, deadline):
    data = _json("https://www.tiktok.com/oembed?" + urlencode({"url": url}), deadline)
    caption = plain(str(data.get("title") or ""))
    if not caption:
        raise Unreadable("This TikTok has no public caption. Use a screenshot instead.")
    author = str(data.get("author_name") or "")
    return {"text": caption, "title": f"TikTok by {author}" if author else "TikTok", "author": author}


#: Extra time to read a PDF's text once it has downloaded.
PDF_EXTRA_SECONDS = 40


def pdf_text(raw: bytes, deadline: float | None = None) -> str:
    """A PDF's text with a [p. N] line before each page, so citations keep real page numbers."""
    import io
    import pypdf
    try:
        reader = pypdf.PdfReader(io.BytesIO(raw))
        if reader.is_encrypted:
            reader.decrypt("")
        pages = []
        for page in reader.pages[:2000]:
            # 4. pypdf can be slow on a large or hostile PDF: stop at the fetch deadline.
            if deadline is not None and time.monotonic() > deadline + PDF_EXTRA_SECONDS:
                raise Unreadable("This PDF is too large to read from its link. Download it and add it from the Library.")
            pages.append((page.extract_text() or "").strip())
    except Unreadable:
        raise
    except Exception:
        raise Unreadable("This PDF couldn't be read. Download it and add it from the Library instead.")
    if not any(pages):
        raise Unreadable("This PDF has no text layer (it's scanned). Download it and add it from the Library.")
    return "\n\n".join(f"[p. {i}]\n{t}" for i, t in enumerate(pages, 1))


def _arxiv_pdf(url):
    m = re.match(r"^/(?:abs|pdf|html)/([\w.\-/]+?)(?:v\d+)?(?:\.pdf)?/?$", urlsplit(url).path)
    return f"https://arxiv.org/pdf/{m.group(1)}" if m else None


def _media(media: str) -> str:
    return media.split(";")[0].strip().lower()


def _decode(raw: bytes, media: str) -> str:
    m = re.search(r"charset=([\w-]+)", media, re.I) or re.search(rb'<meta[^>]+charset=["\']?([\w-]+)', raw[:4096], re.I)
    charset = (m.group(1).decode() if isinstance(m.group(1), bytes) else m.group(1)) if m else "utf-8"
    try:
        return raw.decode(charset, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def read_page(url, deadline) -> dict:
    """Any public web page: an article, a blog, a paper's page or the paper itself."""
    platform = platform_for(url)
    if platform == "arxiv" and urlsplit(url).path.startswith("/html/"):
        url = _arxiv_pdf(url) or url
    raw, media, final = fetch_public(url, deadline=deadline)
    kind = _media(media)
    if kind == "application/pdf" or raw[:5] == b"%PDF-":
        return {"text": pdf_text(raw, deadline), "title": urlsplit(final).path.rsplit("/", 1)[-1] or "Paper", "author": ""}
    html = _decode(raw, media)
    if platform == "youtube":
        return youtube_text(html, deadline)
    if kind in ("text/plain", "text/markdown"):
        return {"text": html.strip(), "title": urlsplit(url).hostname, "author": ""}
    if kind not in ("text/html", "application/xhtml+xml", ""):
        raise Unreadable("This link isn't a page or a PDF. Open it yourself or use a screenshot.")
    data = extract_html(html)
    # A paper's landing page (a journal, PubMed Central, a DOI link) that offers its
    # PDF: read the paper itself, keeping the page's title and authors.
    pdf_url = data.pop("pdf_url", "")
    if pdf_url:
        try:
            pdf_raw, pdf_media, _ = fetch_public(urljoin(final, pdf_url), deadline=deadline)
            if _media(pdf_media) == "application/pdf" or pdf_raw[:5] == b"%PDF-":
                return {**data, "text": pdf_text(pdf_raw, deadline)}
        except (OSError, ValueError, http.client.HTTPException, HTTPException):
            pass  # closed access or blocked: the abstract page is what we can read
    return data


def preview(url: str) -> dict:
    url = clean_url(url)
    platform = platform_for(url)
    if platform == "x":
        try:
            url = x_post(url)[1]  # one address per post, without ?s=20 tracking
        except Unreadable:
            pass
    deadline = time.monotonic() + FETCH_SECONDS
    try:
        if platform in {"instagram", "facebook"}:
            try:
                data = meta_oembed(url)
            except Unreadable:
                data = read_page(url, deadline)  # the public preview text, when there is any
        elif platform == "x":
            data = x_text(url, deadline)
            data.pop("url", None)
        elif platform == "reddit":
            data = reddit_text(url, deadline)
        elif platform == "bluesky":
            data = bluesky_text(url, deadline)
        elif platform == "mastodon":
            data = mastodon_text(url, deadline)
        elif platform == "tiktok":
            data = tiktok_text(url, deadline)
        elif platform == "pubmed":
            data = pubmed_text(url, deadline)
        elif platform == "pmc":
            data = pmc_text(url, deadline)
        else:
            data = read_page(url, deadline)
        check_text(data["text"])
        if platform in {"instagram", "facebook", "linkedin", "threads"} and len(data["text"]) < 80:
            raise Unreadable("Only a short preview is public. Open the link yourself to save the whole post.")
        return {**data, "url": url, "platform": platform, "method": "public", "captured_at": datetime.now(timezone.utc).isoformat()}
    except HTTPException as e:
        if e.status_code != 400:
            raise
        return {"url": url, "platform": platform, "fallback": True, "reason": "The page redirected to an address this app cannot open."}
    except (OSError, ValueError, KeyError, IndexError, TypeError, RecursionError, http.client.HTTPException) as e:
        reason = str(e) if isinstance(e, Unreadable) else "The public page could not be read in time. Open it yourself or use a screenshot."
        return {"url": url, "platform": platform, "fallback": True, "reason": reason}


def split_pages(text: str, limit: int) -> list[str]:
    """Pages for a saved source: a PDF's own [p. N] pages, else paragraphs packed up to `limit`."""
    marked = re.split(r"(?m)^\[p\. (\d+)\]\n?", text)
    if len(marked) >= 3 and not marked[0].strip():
        # A PDF: page N goes in position N, blank pages included, so "p. 12" stays page 12.
        # (A page longer than `limit` is still split, which is rare: ~6,000 is tiny print.)
        numbered = {int(n): body.strip() for n, body in zip(marked[1::2], marked[2::2])}
        pages = [numbered.get(i, "") for i in range(1, max(numbered) + 1)]
        return [chunk for p in pages for chunk in (split_pages(p, limit) if len(p) > limit else [p])]
    pages, current = [], ""
    for para in text.split("\n"):
        while len(para) > limit:  # one enormous paragraph: cut at a sentence or word end
            cut = max(para.rfind(". ", 0, limit), para.rfind(" ", 0, limit))
            cut = cut + 1 if cut > limit // 2 else limit
            if current:
                pages.append(current)
                current = ""
            pages.append(para[:cut].strip())
            para = para[cut:].strip()
        if current and len(current) + 1 + len(para) > limit:
            pages.append(current)
            current = para
        else:
            current = f"{current}\n{para}" if current else para
    if current:
        pages.append(current)
    return pages or [text[:limit]]


def check_text(text):
    if not isinstance(text, str) or not text.strip():
        raise Unreadable("There is no text to save. Try a screenshot.")
    if len(text) > MAX_CHARS or len(text.encode("utf-8")) > MAX_BYTES:
        raise Unreadable("The text exceeds the Library's size limit. Capture a smaller passage.")


def save_source(url, title, text, author="", method="public", partial=False):
    from . import document_store, reading
    from .core.sessions import _connect
    url = clean_url(url)
    try:
        check_text(text)
    except Unreadable as e:
        raise HTTPException(400, str(e))
    # Naive UTC, like every other Library row: the app reads these times as UTC.
    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")
    title = title.strip()[:200] or urlsplit(url).hostname
    metadata = {"url": url, "platform": platform_for(url), "author": author.strip()[:200], "captured_at": now, "method": method}
    if partial:
        metadata["partial"] = True  # only the start of the post or page was public
    content = text.encode("utf-8")
    # A plain-text source split into synthetic pages uses the same context and
    # citations as PDF sources. No new generation/Explain/study path is needed.
    pages = split_pages(text, reading.MAX_PAGE_CHARS)
    filename = (re.sub(r'[^\w .-]', '', title)[:180] or "link") + ".txt"
    with _connect() as conn:
        cur = conn.execute("INSERT INTO documents (name, original_filename, mime, content, extracted_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                           (title, filename, "text/plain", content, text, now, now))
        doc_id = cur.lastrowid
        conn.execute("INSERT INTO document_sources (document_id, metadata) VALUES (?, ?)", (doc_id, json.dumps(metadata)))
        conn.executemany("INSERT INTO document_pages (document_id, page, label, text) VALUES (?, ?, ?, ?)",
                         [(doc_id, i + 1, str(i + 1), p) for i, p in enumerate(pages)])
        conn.execute("INSERT INTO document_reading (document_id, state, pages, done, kind, source, error, updated_at, author, title) VALUES (?, 'ready', ?, ?, 'document', 'link', '', ?, ?, ?)",
                     (doc_id, len(pages), len(pages), now, metadata["author"], title))
        conn.execute("INSERT INTO document_outline (document_id, idx, level, title, page_from, page_to, kind) VALUES (?, 0, 1, ?, 1, ?, '')", (doc_id, title, len(pages)))
    return document_store.get_document(doc_id)
