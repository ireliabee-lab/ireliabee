# Notices

iReliabee's open edition is licensed under the GNU Affero General Public License, version 3
(see `LICENSE`). Copyright (C) 2026 iReliabee Lab.

It includes, or downloads on first use, the third-party material below. Each keeps its own
licence, which is not changed by the AGPL; where a licence asks for its text or for attribution
to travel with the material, it does.

## Bundled in this repository

| Material | Where | Licence |
|---|---|---|
| Noto Sans, Noto Sans Arabic, Noto Sans Devanagari (Google, the Noto Project Authors) | `backend/fonts/` | SIL Open Font License 1.1, text in `backend/fonts/OFL.txt` |
| Citation Style Language styles: APA, Harvard (Cite Them Right), IEEE, NLM/Vancouver, MLA, Chicago author-date | `frontend/src/assets/csl/*.csl` | Creative Commons Attribution-ShareAlike 3.0. Authors are named in each style's `<info>` block; sources in `frontend/src/assets/csl/ATTRIBUTION.md` |
| Citation Style Language locales, en-GB and en-US | `frontend/src/assets/csl/locales-*.xml` | Creative Commons Attribution-ShareAlike 3.0 |

## Used as dependencies (installed by npm, pip and cargo, not copied here)

The interface, the backend and the desktop shell depend on open-source packages listed in
`frontend/package.json` (with `frontend/package-lock.json`), `backend/requirements.txt` (with
`backend/constraints.txt`) and `frontend/src-tauri/Cargo.toml` (with `Cargo.lock`). Each is
used under its own licence. Of note:

- **citeproc-js** formats citations in Write, under the Common Public Attribution License 1.0;
  Write shows "Citations by citeproc-js" with a link to its source, as that licence asks.
- **Tauri** and its plugins (MIT or Apache-2.0), **React** (MIT), **FastAPI** (MIT),
  **PyInstaller** (GPL-2.0 with its bootloader exception) for packaging.

## Downloaded on first use

| Material | Used by | Licence |
|---|---|---|
| Open English WordNet | Wordcraft's dictionary | Creative Commons Attribution 4.0 |
| Tatoeba English sentences | Wordcraft's dictionary | Creative Commons Attribution 2.0 France |

The app names both, with links, where the dictionary is shown. `scripts/build_dictionary.py`
builds the file from their published releases.

## Services you connect

Providers you add keys for (Anthropic, OpenAI, Google Gemini, DeepSeek, Groq, Deepgram, Tavily
and others) are third-party services under their own terms. Scholarly search in Write uses
OpenAlex, whose data is CC0.
