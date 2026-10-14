# The Notebook as a Book, and Deep Read

> The design write-up for this work, kept with the code so the feature can
> always be understood to the core. The working copy the owner reviews is the
> Claude Doc of the same name
> (https://claude.ai/artifact/3YbnwVM3z1L9xBcrie2WSu); this file is updated
> alongside it as each phase lands.

Two pieces of work, in order. **Part A** moves iReliabee's Notebook onto the book from Nkɔmmɔ: pages you write on directly, that curl when turned, with Nkɔmmɔ's formatting bar. **Part B**, *Deep Read*, builds on Reading notes so that any paper, book, blog post or document can be understood to the core: its terms broken down, every chapter summarised in bullets, and what you read made to stick.

Decided with the owner on 26 September 2026: port the real Nkɔmmɔ engine (not a look-alike), and use the book for every notebook kind, meetings included.

## Where things stand today

- **Notebook** (spec 184) stores each notebook as structured JSON: sections of typed blocks (point, key, definition, example, exam, question, quote, formula, table, decision, action, risk, number, note, tutor), a summary, "Test yourself" cues, and a meeting board. Blocks carry `src` (transcript lines or PDF pages) and the user's highlights, bold/italic/underline/strike and text colours as spans.
- The page is a flat ruled sheet (Cornell layout for lectures and reading, a dashboard for meetings). There is no formatting toolbar while writing; formatting only happens through a floating bar on selected text in read mode. Slides flip with a page-curl.
- **Many things read that JSON**: search, Markdown export, version history, the reading-notes builder, the Research term harvest (definition blocks become term cards), and the counts on the covers.
- **Reading notes** (spec 185) already reads a PDF page by page (per-page text kept in `document_pages`, outline in `document_outline`), lets you pick chapters or pages, estimates the cost, extracts points per window of pages (cached), composes slides from them, and runs a coverage check that adds anything the slides missed.
- **Nkɔmmɔ** (flipbook v1.5.1) is plain TypeScript: a canvas book with page-curl physics, a typesetter with a paragraph cache, a rich-text model (plain text + formatting ranges + one style per line), a hidden editor for keyboards/IME/spellcheck/screen readers, themes, tables, photos, and 267 tests.

## Part A: the Notebook as a book

### What the owner will see

- **The shelf**: every notebook as a small bound book on a shelf (leather, cloth or board covers from Nkɔmmɔ's themes), filtered by Lectures, Meetings and Reading, with the same search.
- **Opening one**: the cover turns and the book opens to a two-page spread (one page on a narrow window). You tap a page and write, exactly as in Nkɔmmɔ.
- **The formatting bar** under the book: undo, redo · bold, italic, underline, strikethrough · text colour, highlight · heading, bulleted, numbered, checklist, quote, centre · clear · insert (photo, table, divider, date and time). Plus notebook tools: *key point* (a star in the margin), *definition* (term in bold, meaning after), and *source* (the page or moment it came from).
- **Themes** instead of the Look menu: Nkɔmmɔ's paper and cover themes, including handwriting ones. The old font family, size and list choices become part of a theme.
- **Every kind is a book**: lectures and reading notes read as chapters; a meeting opens on a front page with its decisions, actions (a checklist you tick on the page), open questions, risks and numbers, then what was covered.
- **Sources stay one tap away**: a small `p. 12` or `14:32` tag at the end of a line; tapping it opens the PDF at that page, or the transcript at that moment, as today.
- Export (Markdown, print to PDF), history and restore, and delete work as now.

### How it works

- **The saved format does not change.** The notebook JSON stays the source of truth, so search, export, history, reading notes and the term harvest keep working untouched.
- **Each section becomes one "entry"** in the book (in Nkɔmmɔ an entry is a dated diary page; here its heading is the section title). A converter (`frontend/src/lib/notebookBook.ts`) turns a section's blocks into Nkɔmmɔ's rich text, one block per line, and turns your edits back into blocks.
- **Nothing is lost on the way back**: each line keeps its block's id, type and `src` in a small side list (`LineMeta`), so a line you only restyled keeps its page reference; a line you add gets a new id and no source. While you type, `remapMeta` keeps that list lined up: unchanged lines keep theirs, a split line keeps its block for the first half, joined lines keep the first block.
- **Decorations are drawn as text and taken off on save**: a label ("Decision: "), a definition's term ("entropy — "), a quote's speaker, an action's owner and due date, and the source tag ("  · p. 12"). The side list records the exact strings; delete a label and the words stay.
- **Formatting maps one to one**: Nkɔmmɔ's bold/italic/underline/strike become the block's `fmt`, text colour its `ink`, highlight its `marks`. The palettes match exactly: highlights yellow/pink/green/blue/orange; ink Oxblood→red, Indigo→blue, Forest→green, Plum→purple, Sepia→orange (plain Ink is no colour).
- **Block types become line styles**: point → bullet, key → a new `key` style (a bullet drawn as a star), definition → a normal line "term — meaning", quote → quote, formula → centred, table → table lines, action → checklist (ticked when done), decision/risk/question/number → labelled lines on the meeting front page, tutor → a quote line labelled "Tutor note", the summary and "Test yourself" → their own closing pages. Starring a point makes it a key point, and back.
- **New lines** become blocks by their style (bullet/numbered → point, key → key, quote → quote, centre → formula, table → table, checklist → action on the front page, plain → note). A heading line starts a new section. On a meeting's front page a new line joins the column whose heading is above it.
- **Blocks may keep the reader's line style** in a new optional `para` field (normal, bullet, numbered, check, checked, quote, center, key, divider, blank), so a numbered list stays numbered; blank lines and dividers are saved as empty notes. The backend (`backend/notebook.py`) keeps `para`, leaves it out of search, and exports dividers as `---`.
- **Saving** keeps today's autosave (1.2 s), version check and conflict banner; only the editing surface changes.

### Phases

| Phase | What it delivers | Status |
| --- | --- | --- |
| A1. Engine in | Nkɔmmɔ's book engine and its tests inside iReliabee (`frontend/src/lib/book`) | **Done**: 595 frontend tests pass, types clean (commit 0778ceb, branch `feat/notebook-book`) |
| A2. Blocks ↔ book | The converter both ways, the key-point style, the backend `para` field, round-trip tests | **Done**: lectures and meetings round-trip unchanged (commit c87e546) |
| A3. Write in the book | A React `NotebookBook` that mounts the book, the hidden editor and the formatting bar; autosave through the existing API | **Done**: notebooks open as a book (new *Book* view, the default); write, format, star key points, insert tables, dividers and the date, add and rename sections, change paper and cover; saved and reopened intact. Controller `frontend/src/lib/book/notebookApp.ts` (8 behaviour tests); Slides and Notebook views remain until A4 |
| A4. Every kind | Lecture and reading chapters, meeting front page, summary and Test yourself pages, source tags opening the PDF or transcript, paper saved with the notebook, photos, formatting kept on the summary; the old views retired | **Done**: see "What A4 settled" below |
| A5. The shelf and finish | The bookshelf home, covers per theme, keyboard and screen-reader pass, narrow-window mode, end-to-end tests, docs | **Done** (end-to-end tests moved to the E2E phase): the Notebook home is a bookshelf, each notebook a bound book in its own paper theme's leather, cloth or card, one button per book with a spoken summary; Page Up / Page Down turn pages (the arrow keys too outside the writing), described to screen readers; a narrow window shows one page, names the page in view ("Inside cover"), wraps the formatting bar and fades the page arrows |

### What A4 settled

- **The book is the notebook.** The Slides and Notebook views, the separate Edit mode, the Look menu, the floating highlight bar and the pen cursor are gone (their files were removed). Printing and "save as PDF" still use a whole-page copy of the notebook, shown only when printing.
- **Layout (owner, 26 Sep 2026):** no dark desk; the book is as wide and tall as the window allows; page arrows sit at the book's sides; the formatting bar sits at the window's bottom edge, below the sidebar's Settings row, and **Ctrl + .** hides it (a small pill brings it back) so the book takes the whole height (owner, 27 Sep 2026). The controls use the app's colours; the paper and cover themes restyle only the book.
- **Paper is saved with each notebook** (`style.paper`): lectures default to Classic, reading notes to Parchment, meetings to Dot grid; any of Classic, Light, Dark, Exercise book, Parchment, Dot grid or Match my system can be chosen from the bar.
- **Notes, not a novel:** no drop caps and no first-line indents, so a bold term at the start of a line stays whole.
- **More writing on every page (owner, 27 Sep 2026):** narrower margins (42/50 top and bottom, 40/30 inside and out, in page units of 500 × 700), the page number lower, and a section's heading is its title and a short rule in about two lines, with no chapter number.
- **The look menu** (the palette button in the bar): paper and cover theme, a **page colour** over it (White, Cream, Sage, Sky, Blush, Sand, Slate, Night; each brings the ink that reads on it), and the **text size** (small to extra large; the book is typeset again). All three are saved with the notebook (`style.paper`, `style.pageColor`, `style.size`). The paper choice had never been saved before this: the save route's style model left it out.
- **The fold** takes its colours from the page: a warm crease on cream paper, a black one with only a faint rise on dark paper.
- **The header** starts right under the title bar; when the book leaves room beside it, its two ends float in the top corners.
- **Source tags** are written without spaces, "(p.12)" or "(14:32)", so a tag never breaks across lines; tapping one opens the PDF at that page, or the transcript at that moment.
- **Meeting front page:** "At a glance" with Decisions, Action items (checkboxes you tick on the page), Open questions, Risks, and Numbers and dates; no repeated labels under the column headings.
- **Photos:** Insert → Photo, downscaled as in Nkɔmmɔ and saved as an `image` block (a JPEG data URL). Limits, until the owner decides otherwise: about 500 KB per photo, 24 per notebook. Photos are left out of search and export to Markdown as "[Photo]".
- **Formatting on the Summary and Test yourself** is kept (in the document's `rich` map). Line styles there (a star, a list) are not: the summary is saved as one text.
- **Reading notes** keep their coverage chip ("11/12 key points") and "Make again" in the toolbar.

### Risks

- **Text is drawn, not browser text**: no spell-check squiggles on the page (the hidden editor still spell-checks for screen readers). Copy and paste work.
- **Photos make notebooks bigger**: they are downscaled like Nkɔmmɔ's, and stored with the notebook; a size cap and a warning are needed.
- **Two copies of the engine**: fixes should move between Nkɔmmɔ and iReliabee; `frontend/src/lib/book/README.md` records every change from the original.

## Part B: Deep Read

### The problem

Hard texts are hard for three reasons: unknown terms (one undefined word per paragraph and the reader is lost), no map (every paragraph feels equally important), and nothing sticks (a day later little is left). Deep Read fixes each, in the order a good student would: map first, vocabulary before reading, then help while reading, then checking what stuck.

### What it adds, per document

1. **Parts**: chapters and sections with page numbers. *Exists* (Reading notes outline).
2. **Glossary in learning order**: every technical term, with a one-sentence plain meaning at the reader's level, the sentence it was used in and its page, an everyday example, and what it builds on ("p-value" needs "null hypothesis" first). Terms are ordered so basics come before what depends on them.
3. **Chapter digests at three depths**: one line; 5–8 bullets; the claims, the evidence for each and what the author admits is uncertain.
4. **A map**: how chapters and ideas connect, as one picture.
5. **Help while reading**: in the book, tap a term for its plain meaning; mark a hard paragraph with "simplify this" for a plain rewrite beside the original.
6. **Make it stick**: glossary terms become spaced-review cards (the Research term bank already harvests definitions from reading notes); 3–5 recall questions per chapter; *Explain it back*, typed or spoken, marked for what was missed.

### The order to study with it

Map (2 minutes) → terms (10 minutes) → read with help → bullets as a check → explain it back → cards return over the following days. Summaries alone give an illusion of understanding; recall and spacing are what make it stick, so those are not optional extras.

### How it builds on Reading notes

- **Glossary**: the map step already tags `definition` points with a term and pages. A new step groups them across the document, asks for the plain meaning at the reader's level and the prerequisites, and orders them. Cached like the map.
- **Digests**: a new template, *Deep read*, composes one chapter per unit with the three depths, citing pages.
- **Help while reading**: glossary terms are known, so the book can mark them on the page; "simplify this" sends only that paragraph's page text.
- **Recall and explain-back**: Test yourself cues already exist per notebook; explain-back uses the Practice speaking coach.
- **Cards**: extend the Research term harvest to take glossary terms, tagged with the document.

### Rules it must keep

- **Every definition and bullet cites the page it came from**; anything the model could not find in the text is flagged, never presented as the author's.
- **Cost shown first, and reserved**: the 21 September decision says the estimate is reserved before any call so a book can never overdraw a balance; the code today only shows it (and gates on Pro). Deep Read closes that gap.
- **Privacy Policy before shipping**: sending document text to the AI must be listed (what, which providers, where processed). Check the policy covers document passages already for Reading notes, and add "simplify" and explain-back.
- **Your files**: the Terms line agreed for Reading notes applies: you must have the right to use what you upload; notes are for your own study.

### Phases

| Phase | What it delivers | Status |
| --- | --- | --- |
| B1 | Glossary in learning order and three-depth chapter digests, with page citations; the Deep read template; credit reservation | **Done**: the *Deep read* template (`backend/reading.py`) writes chapter by chapter (gist as a key block, 5-8 points, "Claim: … Evidence: …" and "Uncertain: …" points, definitions), puts a **Map of the text** (each chapter's gist and pages, no extra AI call) and a **Glossary, in learning order** in front (`deep_read_front`: the map step's definitions, one plain sentence at the reader's level, an everyday example labelled as iReliabee's, what each builds on, flagged when the text doesn't say; ordered basics first; cached in `reading_glossary`). **Reader level** is asked per document (New to this / Some background / Expert nearby), the last choice remembered. **No overdraw**: `/reading/generate` refuses (402) a job whose estimate is more than the balance, and the button is disabled when short; the service still holds each call's worst case. Privacy Policy names the terms and level sent. |
| B2 | Glossary terms into spaced review; recall questions per chapter | **Half done**: each Deep read chapter ends with 3-5 recall questions. The cards wait for the Research branch (#32, where the term harvest lives); since the glossary is written as definition blocks, that harvest already picks it up |
| B3 | Help while reading in the book: term taps and "simplify this" | **Done**: with the cursor on a term the notebook defines (its glossary, or any definition), a card over the book's foot gives the meaning and its page (`lib/readingHelp.ts`; follows the cursor, so it works from the keyboard too); **Simplify** in the bar (reading notebooks) rewrites the paragraph at the cursor in plainer words at the notebook's reader level, with its page(s) as context only (`POST /reading/simplify`), shown as iReliabee's, and *Add under the paragraph* puts it in the notes as a quote labelled "In plainer words (iReliabee's)". Privacy Policy names the paragraph and page sent |
| B4 | Explain it back (typed and spoken), the map of ideas, progress per document | **Done, typed**: *Explain it back* in the bar (reading notebooks) takes the chapter at the cursor, you write it from memory, and `POST /reading/explain` marks it against that chapter's notes only: what you got, what's worth going over and what to put right, each with its page, plus a score; the best score per chapter is kept (`reading_progress`). The notebook shows **Explained n/m**. A deep read keeps its terms and what each builds on (`coverage.ideas`), shown as the **Map of ideas**: basics on the left, a line to each term that builds on them. **Spoken** explain-back is not in yet: it needs the live transcription wired into this panel |

## Open questions for the owner

- Meetings: keep a quick one-page view as well as the book, for glancing at actions during a busy day?
- Photos in notebooks: a size cap per notebook (Nkɔmmɔ fits about 15–20 in 5 MB)?
- ~~Deep Read's reader level~~: decided 27 Sep 2026, per document, the last choice remembered.
