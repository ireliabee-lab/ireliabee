"""Wordcraft's dictionary: built from WordNet and Tatoeba, downloaded once and checked, looked up offline."""
from backend.tests import _env  # noqa: F401
import bz2  # noqa: E402
import gzip  # noqa: E402
import importlib.util  # noqa: E402
import json  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

from backend import dictionary  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("build_dictionary", ROOT / "scripts" / "build_dictionary.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

WORDNET = """<?xml version="1.0" encoding="UTF-8"?>
<LexicalResource xmlns:dc="https://globalwordnet.github.io/schemas/dc/">
 <Lexicon id="oewn" label="Open English WordNet" language="en" email="" license="https://creativecommons.org/licenses/by/4.0/" version="2025">
  <LexicalEntry id="oewn-decision-n"><Lemma writtenForm="decision" partOfSpeech="n"/>
   <Sense id="s1" synset="oewn-1-n"/></LexicalEntry>
  <LexicalEntry id="oewn-choice-n"><Lemma writtenForm="choice" partOfSpeech="n"/>
   <Sense id="s2" synset="oewn-1-n"/></LexicalEntry>
  <LexicalEntry id="oewn-study-v"><Lemma writtenForm="study" partOfSpeech="v"/>
   <Sense id="s3" synset="oewn-2-v"/></LexicalEntry>
  <Synset id="oewn-1-n" partOfSpeech="n"><Definition>the act of making up your mind about something</Definition>
   <Example>"the burden of decision was his"</Example></Synset>
  <Synset id="oewn-2-v" partOfSpeech="v"><Definition>be a student; follow a course of study</Definition></Synset>
 </Lexicon>
</LexicalResource>"""

SENTENCES = [
    "We have to make a decision today.",
    "She made a decision quickly and stuck to it.",
    "It was a hard decision for everyone.",
    "Make a decision before the meeting ends.",
    "Please make a decision soon.",
    "I studied English every evening last year.",
    "Il fait beau.",          # not English: Tatoeba's per-language file only has eng, but be safe
]


@pytest.fixture
def built(tmp_path):
    wn = tmp_path / "english-wordnet-2025.xml.gz"
    wn.write_bytes(gzip.compress(WORDNET.encode()))
    tsv = tmp_path / "eng_sentences.tsv.bz2"
    rows = [f"{i}\t{'fra' if s.startswith('Il') else 'eng'}\t{s}" for i, s in enumerate(SENTENCES, 1)]
    tsv.write_bytes(bz2.compress("\n".join(rows).encode()))
    manifest = builder.build(wn, tsv, tmp_path / "out")
    return tmp_path / "out", manifest


@pytest.fixture
def installed_from(built, tmp_path, monkeypatch):
    out, _ = built
    monkeypatch.setattr(dictionary, "BASE_URL", out.as_uri())
    monkeypatch.setattr(dictionary, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(dictionary, "DB_PATH", tmp_path / "data" / "dictionary.db")
    monkeypatch.setattr(dictionary, "_job", {"state": "idle", "done": 0, "total": 0, "error": ""})
    return out


def _wait():
    for _ in range(100):
        if dictionary.status()["download"]["state"] in ("done", "error"):
            return dictionary.status()
        time.sleep(0.05)
    raise AssertionError("download did not finish")


def test_the_build_writes_a_checked_manifest(built):
    out, manifest = built
    assert manifest["schema"] == dictionary.SCHEMA and manifest["words"] == 3
    assert json.loads((out / "manifest.json").read_text())["sha256"] == manifest["sha256"]


def test_download_once_then_look_up_offline(installed_from):
    assert dictionary.status()["installed"] is False
    with pytest.raises(HTTPException):
        dictionary.lookup("decision")                       # not downloaded yet
    dictionary.start_download()
    st = _wait()
    assert st["installed"] and st["words"] == 3 and st["download"]["state"] == "done"

    out = dictionary.lookup("Decisions")                     # plural finds the dictionary form
    assert out["found"] and out["word"] == "decision"
    noun = out["meanings"][0]
    assert noun["pos"] == "noun" and "making up your mind" in noun["senses"][0]["definition"]
    assert noun["senses"][0]["synonyms"] == ["choice"]
    assert noun["senses"][0]["examples"] == ["the burden of decision was his"]
    assert any("make a decision" in s.lower() for s in out["sentences"])
    # Little words are skipped: "make a decision" (three times) counts as "make", never "a".
    assert {"word": "make", "count": 3} in out["phrases"]["before"]
    assert all(p["word"] not in ("a", "the") for p in out["phrases"]["before"])
    assert dictionary.lookup("studying")["word"] == "study"
    assert dictionary.lookup("decisions")["forms_of"] == []
    assert dictionary.suggest("de") == ["decision"]


def test_a_damaged_download_is_refused(installed_from):
    m = json.loads((installed_from / "manifest.json").read_text())
    m["sha256"] = "0" * 64
    (installed_from / "manifest.json").write_text(json.dumps(m))
    dictionary.start_download()
    st = _wait()
    assert st["download"]["state"] == "error" and "damaged" in st["download"]["error"]
    assert st["installed"] is False and not dictionary.DB_PATH.exists()


def test_word_forms():
    assert dictionary._bases("cats")[:2] == ["cats", "cat"]
    assert "run" in dictionary._bases("running") and "stop" in dictionary._bases("stopped")
    assert "study" in dictionary._bases("studied")
