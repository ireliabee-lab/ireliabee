"""
Build Wordcraft's offline dictionary (docs/dictionary.md) from two open sources:

- Open English WordNet (CC BY 4.0): words, parts of speech, meanings, examples, synonyms.
- Tatoeba's English sentences (CC BY 2.0 FR): real example sentences, and from them the
  phrase builder: the words that most often come just before and just after each word.

Usage:
    python scripts/build_dictionary.py --wordnet english-wordnet-2025.xml.gz \
        --tatoeba eng_sentences.tsv.bz2 --out dist/dictionary

Writes dictionary.db, dictionary.db.gz and manifest.json (version, size, sha256) to --out.
Upload dictionary.db.gz and manifest.json to a file host of your own, and set IRELIABEE_DICTIONARY_URL to that folder.
"""
from __future__ import annotations

import argparse
import bz2
import gzip
import hashlib
import json
import re
import shutil
import sqlite3
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from pathlib import Path

SCHEMA_VERSION = 1
POS = {"n": "noun", "v": "verb", "a": "adjective", "s": "adjective", "r": "adverb"}
#: Example sentences kept per word, and how long one may be (in words).
SENTENCES_PER_WORD = 6
SENTENCE_WORDS = (4, 18)
#: Phrase-builder neighbours kept per word, and how often a pair must occur to count.
NEIGHBOURS = 10
MIN_PAIR = 3
WORD = re.compile(r"[a-z]+(?:'[a-z]+)?")
#: Little words skipped by the phrase builder, so "a decision" becomes "make a decision". Prepositions and
#: particles stay ("run out", "decision to"): they are what learners need.
SKIP = set("""a an the this that these those my your his her its our their me you him us them i he she it we they
is am are was were be been being have has had do does did will would shall should can could may might must
and or but so not no very just really also then there here what which who whom whose
i'm you're he's she's it's we're they're i've you've we've they've i'll you'll he'll she'll we'll they'll
i'd you'd he'd she'd we'd they'd isn't aren't wasn't weren't don't doesn't didn't can't couldn't won't
wouldn't shouldn't haven't hasn't hadn't let's that's there's what's""".split())
#: Tatoeba's stock characters, who would otherwise fill the phrase builder ("Tom running").
SKIP |= {"tom", "mary", "rima", "layla", "john", "skura", "ziri", "sami", "yanni", "tom's", "mary's"}
#: How far the phrase builder looks past little words, either side.
WINDOW = 2


def neighbour(toks: list[str], i: int, step: int) -> str | None:
    """The nearest real word before (step -1) or after (step 1) position i, past at most WINDOW words."""
    j = i + step
    for _ in range(WINDOW):
        if not 0 <= j < len(toks):
            return None
        if toks[j] not in SKIP:
            return toks[j]
        j += step
    return None


def tokens(text: str) -> list[str]:
    return WORD.findall(text.lower())


def varied(kept: list[tuple[int, int, str]], n: int) -> list[tuple[int, int, str]]:
    """The shortest sentences, skipping any that is mostly the same words as one already chosen
    ("He missed the deadline" after "She missed the deadline")."""
    chosen: list[tuple[int, int, str]] = []
    seen: list[set[str]] = []
    for item in sorted(kept):
        words = set(tokens(item[2])) - SKIP
        if any(len(words & s) >= max(1, 0.6 * max(len(words), len(s))) for s in seen):
            continue
        chosen.append(item)
        seen.append(words)
        if len(chosen) == n:
            break
    return chosen


def read_wordnet(path: Path) -> tuple[list[tuple], dict[str, dict]]:
    """(lemma, pos, synset id) rows and {synset id: {pos, definition, examples}}."""
    opener = gzip.open if path.suffix == ".gz" else open
    words, synsets = [], {}
    with opener(path, "rb") as f:
        lemma, pos = None, None
        for event, el in ET.iterparse(f, events=("start", "end")):
            tag = el.tag.rsplit("}", 1)[-1]
            if event == "start" and tag == "Lemma":
                lemma, pos = el.get("writtenForm"), el.get("partOfSpeech")
            elif event == "end" and tag == "Sense" and lemma:
                words.append((lemma, POS.get(pos or "", pos or ""), el.get("synset")))
            elif event == "end" and tag == "LexicalEntry":
                lemma = None
                el.clear()
            elif event == "end" and tag == "Synset":
                definition = next((d.text or "" for d in el if d.tag.rsplit("}", 1)[-1] == "Definition"), "")
                examples = [e.text or "" for e in el if e.tag.rsplit("}", 1)[-1] == "Example"]
                synsets[el.get("id")] = {"pos": POS.get(el.get("partOfSpeech") or "", ""),
                                         "definition": definition.strip(),
                                         "examples": [x.strip().strip('"') for x in examples if x and x.strip()][:3]}
                el.clear()
    return words, synsets


def read_sentences(path: Path):
    opener = bz2.open if path.suffix == ".bz2" else open
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3 and parts[1] == "eng":
                yield int(parts[0]), parts[2].strip()


def build(wordnet: Path, tatoeba: Path, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    db_path = out / "dictionary.db"
    if db_path.exists():
        db_path.unlink()
    words, synsets = read_wordnet(wordnet)
    single = {w.lower() for w, _, _ in words if " " not in w and "-" not in w}

    examples: dict[str, list[tuple[int, int, str]]] = defaultdict(list)
    before: dict[str, Counter] = defaultdict(Counter)
    after: dict[str, Counter] = defaultdict(Counter)
    freq: Counter = Counter()
    n_sentences = 0
    for sid, text in read_sentences(tatoeba):
        toks = tokens(text)
        if not toks:
            continue
        n_sentences += 1
        good = SENTENCE_WORDS[0] <= len(toks) <= SENTENCE_WORDS[1]
        for i, t in enumerate(toks):
            if t not in single:
                continue
            freq[t] += 1
            if (w := neighbour(toks, i, -1)) and w != t:
                before[t][w] += 1
            if (w := neighbour(toks, i, 1)) and w != t:
                after[t][w] += 1
            if good:
                kept = examples[t]
                # Keep the shortest few: they read best as examples.
                kept.append((len(toks), sid, text))
                if len(kept) > SENTENCES_PER_WORD * 10:
                    kept.sort()
                    del kept[SENTENCES_PER_WORD * 5:]

    con = sqlite3.connect(db_path)
    con.executescript("""
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE synsets (id TEXT PRIMARY KEY, pos TEXT, definition TEXT, examples TEXT);
        CREATE TABLE senses (lemma TEXT NOT NULL, lower TEXT NOT NULL, pos TEXT, synset TEXT NOT NULL, rank INTEGER);
        CREATE TABLE sentences (lower TEXT NOT NULL, tatoeba_id INTEGER, text TEXT NOT NULL);
        CREATE TABLE phrases (lower TEXT NOT NULL, side TEXT NOT NULL, word TEXT NOT NULL, count INTEGER NOT NULL);
        CREATE TABLE freq (lower TEXT PRIMARY KEY, count INTEGER NOT NULL);
    """)
    con.executemany("INSERT INTO freq VALUES (?,?)", list(freq.items()))
    con.executemany("INSERT INTO synsets VALUES (?,?,?,?)",
                    [(k, v["pos"], v["definition"], json.dumps(v["examples"])) for k, v in synsets.items()])
    rank: Counter = Counter()
    rows = []
    for lemma, pos, synset in words:
        key = lemma.lower()
        rank[key] += 1
        rows.append((lemma, key, pos, synset, rank[key]))
    con.executemany("INSERT INTO senses VALUES (?,?,?,?,?)", rows)
    con.executemany("INSERT INTO sentences VALUES (?,?,?)",
                    [(w, sid, text) for w, kept in examples.items() for _, sid, text in varied(kept, SENTENCES_PER_WORD)])
    phrase_rows = []
    for side, table in (("before", before), ("after", after)):
        for w, counts in table.items():
            phrase_rows += [(w, side, n, c) for n, c in counts.most_common(NEIGHBOURS) if c >= MIN_PAIR]
    con.executemany("INSERT INTO phrases VALUES (?,?,?,?)", phrase_rows)
    con.executescript("""
        CREATE INDEX senses_lower ON senses (lower);
        CREATE INDEX sentences_lower ON sentences (lower);
        CREATE INDEX phrases_lower ON phrases (lower, side);
    """)
    meta = {"schema": str(SCHEMA_VERSION), "wordnet": wordnet.name, "tatoeba": tatoeba.name,
            "words": str(len({r[1] for r in rows})), "sentences": str(n_sentences)}
    con.executemany("INSERT INTO meta VALUES (?,?)", list(meta.items()))
    con.commit()
    con.execute("VACUUM")
    con.close()

    gz = out / "dictionary.db.gz"
    with open(db_path, "rb") as src, gzip.open(gz, "wb", compresslevel=9) as dst:
        shutil.copyfileobj(src, dst)
    manifest = {"version": f"{SCHEMA_VERSION}.{wordnet.stem.split('.')[0]}", "schema": SCHEMA_VERSION,
                "file": gz.name, "size": gz.stat().st_size, "unpacked": db_path.stat().st_size,
                "sha256": hashlib.sha256(gz.read_bytes()).hexdigest(), "words": int(meta["words"])}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--wordnet", type=Path, required=True)
    ap.add_argument("--tatoeba", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("dist/dictionary"))
    a = ap.parse_args()
    print(json.dumps(build(a.wordnet, a.tatoeba, a.out), indent=2))
