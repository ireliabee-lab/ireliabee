# The book engine

Ported from the owner's Nkɔmmɔ diary (flipbook v1.5.1, `nkomo-project/flipbook`), so
the Notebook can be written in a real book: pages drawn on a canvas that curl when
turned, typeset text you write on directly, and the same formatting bar.

| File | What it does |
| --- | --- |
| `flipbook.ts`, `geometry.ts` | The book: page-curl physics, covers, the cursor and selection overlay, single-page mode |
| `typeset.ts`, `measure.ts`, `pages.ts` | Line breaking with a paragraph cache, and painting paper, text, lists, tables and pictures |
| `rich.ts` | The rich-text model: plain text + formatting ranges + one style per line |
| `live.ts`, `manuscript.ts` | Re-typesetting as you type, and mapping taps and the caret between page and text |
| `themes.ts`, `sound.ts`, `book.ts` | Paper and cover themes, the page-turn sound, page assembly |
| `diary/editor.ts` | The hidden editor that keyboards, IME, spellcheck and screen readers use |
| `diary/entries.ts`, `diary/pages.ts`, `diary/pictures.ts` | Entries (here: notebook sections) as book chapters, covers and folios, photo downscaling |

`docs/ARCHITECTURE.md` in the Nkɔmmɔ project explains the whole pipeline. The tests
in `tests/` came with it and run under jsdom (each file opts in with
`// @vitest-environment jsdom` and imports `tests/setup.ts`).

Changes from the original are kept small so fixes can move between the two:
- `.at(-1)` became index access (this app still builds for older WebKit).
- A `key` line style: a bullet drawn as a star, for a notebook's key points (`rich.ts`, `typeset.ts`, `pages.ts`, `live.ts`).
