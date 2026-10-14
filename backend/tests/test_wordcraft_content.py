"""Wordcraft content: every realm file is whole, well-formed and cross-referenced.

Run on one realm while writing it:  python backend/tests/test_wordcraft_content.py 3
"""
import json
import re
import sys
import unittest
from pathlib import Path
from urllib.parse import urlparse

CONTENT = Path(__file__).resolve().parents[1] / "wordcraft_content"
CHARACTERS = {"wc_guide", "wc_shopkeeper", "wc_neighbour", "wc_colleague", "wc_debater", "wc_interviewer", "wc_audience"}
PILLARS = {"words", "phrases", "sentences", "understanding", "speaking", "communicating"}
JOBS = {"greeting", "asking", "clarifying", "agreeing", "disagreeing", "softening", "linking", "thanking",
        "apologising", "opinion", "structuring", "persuading", "other", ""}
SITES = ("bbc.co.uk", "learnenglish.britishcouncil.org", "learningenglish.voanews.com", "wgtn.ac.nz",
         "cambridgeenglish.org", "writeandimprove.com", "oxfordlearnersdictionaries.com")
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿]")


def _words(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9'’-]+", text))


def problems(realm: int, data: dict, all_ids: set) -> list[str]:
    """Everything wrong with one realm file, as readable lines."""
    out: list[str] = []
    say = out.append
    if data.get("realm") != realm:
        say(f"realm field is {data.get('realm')!r}, expected {realm}")
    cards = data.get("cards") or []
    if not 30 <= len(cards) <= 48:
        say(f"{len(cards)} cards; want 30-48")
    ids = set()
    for c in cards:
        cid = c.get("id", "")
        where = f"card {cid or c.get('text')!r}"
        if not re.fullmatch(rf"r{realm}-[wps]-[a-z0-9-]+", cid):
            say(f"{where}: id must look like r{realm}-w-slug / r{realm}-p-slug / r{realm}-s-slug")
        if cid in ids or cid in all_ids:
            say(f"{where}: duplicate id")
        ids.add(cid)
        if c.get("kind") not in ("word", "phrase", "pattern"):
            say(f"{where}: kind must be word, phrase or pattern")
        elif cid.count("-") >= 2 and {"word": "w", "phrase": "p", "pattern": "s"}[c["kind"]] != cid.split("-")[1]:
            say(f"{where}: id letter must match kind (w word, p phrase, s pattern)")
        for f in ("text", "meaning", "example"):
            if not str(c.get(f, "")).strip():
                say(f"{where}: missing {f}")
        if not isinstance(c.get("goes_with", []), list):
            say(f"{where}: goes_with must be a list")
        if c.get("job", "") not in JOBS:
            say(f"{where}: unknown job {c.get('job')!r}")
        if c.get("kind") == "pattern" and "___" not in c.get("text", ""):
            say(f"{where}: a pattern's text needs ___ blanks")
    lessons = data.get("lessons") or []
    if len(lessons) != 6:
        say(f"{len(lessons)} lessons; want exactly 6")
    used = set()
    for i, l in enumerate(lessons, 1):
        lid = l.get("id", "")
        where = f"lesson {lid or i}"
        if lid != f"r{realm}-l{i}":
            say(f"{where}: id should be r{realm}-l{i}")
        for f in ("title", "why", "check"):
            if not str(l.get(f, "")).strip():
                say(f"{where}: missing {f}")
        if l.get("pillar") not in PILLARS:
            say(f"{where}: pillar must be one of {sorted(PILLARS)}")
        if not isinstance(l.get("minutes"), int) or not 10 <= l["minutes"] <= 60:
            say(f"{where}: minutes must be 10-60")
        lc = l.get("cards") or []
        if not 4 <= len(lc) <= 8:
            say(f"{where}: {len(lc)} cards; want 4-8")
        for cid in lc:
            if cid not in ids:
                say(f"{where}: card {cid} is not in this realm")
        used.update(lc)
        p = l.get("passage") or {}
        if p.get("kind") != "read" or not p.get("title") or not p.get("text"):
            say(f"{where}: passage needs kind 'read', a title and text")
        elif not 60 <= _words(p["text"]) <= 260:
            say(f"{where}: passage is {_words(p['text'])} words; want 60-260")
        for link in p.get("links") or []:
            host = urlparse(link.get("url", "")).netloc.lower()
            if not link.get("title") or not any(host == s or host.endswith("." + s) for s in SITES):
                say(f"{where}: link {link.get('url')!r} is not on an allowed site")
        drills = l.get("drills") or []
        if not 5 <= len(drills) <= 8:
            say(f"{where}: {len(drills)} drills; want 5-8")
        for j, d in enumerate(drills, 1):
            say_d = lambda m, j=j: say(f"{where} drill {j} ({d.get('type')}): {m}")  # noqa: E731
            if not d.get("hint") or not d.get("why"):
                say_d("needs hint and why")
            t = d.get("type")
            if t in ("choose", "gap"):
                opts = d.get("options") or []
                if not 2 <= len(opts) <= 4 or len(set(opts)) != len(opts):
                    say_d("needs 2-4 different options")
                if not isinstance(d.get("answer"), int) or not 0 <= d["answer"] < len(opts):
                    say_d("answer must be the index of an option")
                if t == "choose" and not d.get("prompt"):
                    say_d("needs a prompt")
                if t == "gap" and str(d.get("sentence", "")).count("___") != 1:
                    say_d("sentence needs exactly one ___")
            elif t == "order":
                n = len(str(d.get("answer", "")).split())
                if not 3 <= n <= 14:
                    say_d(f"answer has {n} words; want 3-14")
            elif t == "fix":
                if not d.get("sentence") or not d.get("answer") or d.get("sentence") == d.get("answer"):
                    say_d("needs a wrong sentence and a different right answer")
                if not isinstance(d.get("accept", []), list):
                    say_d("accept must be a list")
            elif t == "join":
                if len(d.get("parts") or []) < 2 or not 1 <= len(d.get("answers") or []) <= 4:
                    say_d("needs 2+ parts and 1-4 answers")
            else:
                say_d("type must be choose, gap, order, fix or join")
        w = l.get("write") or {}
        if not w.get("prompt") or not isinstance(w.get("min_words"), int):
            say(f"{where}: write needs prompt and min_words")
        s = l.get("speak") or {}
        if not s.get("prompt") or s.get("character", "") not in CHARACTERS | {""}:
            say(f"{where}: speak needs a prompt and a known character or ''")
    unused = ids - used
    if len(unused) > len(ids) // 2:
        say(f"{len(unused)} of {len(ids)} cards are in no lesson; most cards should be taught")
    items = data.get("placement") or []
    if len(items) != 3:
        say(f"{len(items)} placement items; want exactly 3")
    for k, it in enumerate(items, 1):
        where = f"placement {it.get('id') or k}"
        if it.get("id") != f"p{realm}-{k}" or it.get("realm") != realm:
            say(f"{where}: id should be p{realm}-{k} with realm {realm}")
        opts = it.get("options") or []
        if it.get("type") not in ("choose", "gap") or not 2 <= len(opts) <= 4:
            say(f"{where}: type choose/gap with 2-4 options")
        if not isinstance(it.get("answer"), int) or not 0 <= it["answer"] < len(opts):
            say(f"{where}: answer must be an option index")
        if it.get("type") == "gap" and str(it.get("sentence", "")).count("___") != 1:
            say(f"{where}: sentence needs exactly one ___")
    if EMOJI.search(json.dumps(data, ensure_ascii=False)):
        say("contains emoji")
    return out


def load(realm: int) -> dict:
    return json.loads((CONTENT / f"realm_{realm}.json").read_text(encoding="utf-8"))


class WordcraftContentTest(unittest.TestCase):
    def test_realms_file(self):
        realms = json.loads((CONTENT / "realms.json").read_text(encoding="utf-8"))["realms"]
        self.assertEqual([r["id"] for r in realms], list(range(7)))
        for r in realms:
            self.assertIn(r["exit"]["character"], CHARACTERS)
            self.assertTrue(4 <= len(r["can_do"]) <= 6)

    def test_every_realm_file(self):
        seen: set = set()
        for realm in range(7):
            path = CONTENT / f"realm_{realm}.json"
            if not path.exists():
                self.fail(f"missing {path.name}")
            data = load(realm)
            found = problems(realm, data, seen)
            self.assertEqual(found, [], f"realm {realm}:\n" + "\n".join(found))
            seen |= {c["id"] for c in data["cards"]}


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        n = int(sys.argv[1])
        issues = problems(n, load(n), set())
        print("\n".join(issues) if issues else f"realm {n}: OK")
        sys.exit(1 if issues else 0)
    unittest.main()
