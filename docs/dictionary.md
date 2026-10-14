# Wordcraft's dictionary

A **Dictionary** tab in Wordcraft: meanings by part of speech, an example and synonyms for each,
real sentences, and the **phrase builder** (the words people most often put just before and just
after a word). Any meaning or phrase becomes a Wordcraft card in one click. Approved on 27
September 2026.

## Where the data comes from

| Source | Licence | Gives |
|---|---|---|
| [Open English WordNet](https://en-word.net/), 2025 edition (`english-wordnet-2025.xml.gz`) | CC BY 4.0 | words, parts of speech, meanings, examples, synonyms |
| [Tatoeba](https://tatoeba.org/) English sentences (`eng_sentences.tsv.bz2`) | CC BY 2.0 FR | example sentences and, from them, the phrase builder |

Both are credited in the app under the dictionary. Both licences allow commercial use with credit.
Not used: dictionaryapi.dev (no stated data source) and online lookups (they would send what you
look up off the computer and need a Privacy Policy entry).

## How it reaches the user

1. `scripts/build_dictionary.py` turns the two downloads into one SQLite file, `dictionary.db`, and writes
   `dictionary.db.gz` and `manifest.json` (schema, size, SHA-256, word count).
2. Upload both to a folder of your own (a web host, or a local folder as a `file:///` address) and set `IRELIABEE_DICTIONARY_URL` to it.
3. The first time someone opens the Dictionary tab, the app downloads the `.gz` (with a progress bar),
   checks its SHA-256 against the manifest, unpacks it to `~/.local/share/ireliabee/dictionary.db`
   and uses it from then on. A damaged download is thrown away and can be tried again.
4. Every lookup runs on the computer: free, offline, and nothing about it is sent anywhere. No Privacy
   Policy change is needed.

`IRELIABEE_DICTIONARY_URL` points the app at another copy (a local folder works, as `file:///…`), for
testing.

## Rebuilding

```powershell
python scripts/build_dictionary.py --wordnet english-wordnet-2025.xml.gz --tatoeba eng_sentences.tsv.bz2 --out dist/dictionary
```

A new WordNet edition or more Tatoeba sentences: rebuild and upload. A change to the tables bumps
`SCHEMA_VERSION` in the script and `SCHEMA` in `backend/dictionary.py`, and uploads to a new
`v2/` folder, so older apps keep reading the file they understand.
