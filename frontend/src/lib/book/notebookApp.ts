/**
 * A notebook written in the book: the Nkɔmmɔ diary's writing loop (src/diary/app.ts
 * in the Nkɔmmɔ project) without the vault, lock and decoy, driving notebook
 * entries instead of diary entries.
 *
 * It owns the canvas book and the hidden editor. The formatting bar lives in
 * React (NotebookBook.tsx) and calls the commands here; every change to the
 * text is reported through `onEntries`, and the bar's state through `onState`.
 */
import { buildManuscript, formatEntryDate, fromSourceOffset, toSourceOffset, type Entry, type EntryManuscript } from './diary/entries';
import { RichEditor, type EditorState } from './diary/editor';
import { assembleDiary, folioOf, paintDiaryPage, type BookWords } from './diary/pages';
import { FlipBook, type PageHit } from './flipbook';
import { LiveBook, spreadOf } from './live';
import { sharedMeasurer } from './measure';
import { applyPageTheme, DROP_CAP_SIZE, font, LAYOUT, LINES_PER_PAGE, PAGE_W, pageTheme, registerImage, setMarkedTerms, setTextSize, styleFont, TEXT_WIDTH, type TextSize } from './pages';
import { imageIdOf, OBJECT_CHAR, plainDoc, withParas, type BoolMark, type RichDoc, type ToggleParaStyle } from './rich';
import type { PageSound } from './sound';
import { resolveTheme, themeFonts, withPageColor, type Theme } from './themes';
import { createTypesetter } from './typeset';
import type { PageSpec } from './book';
import { MIND_MAP_PREFIX } from './pages';
import { remapMeta, type BookEntry, type BookPicture } from '../notebookBook';

export interface NotebookBookState extends EditorState {
  /** The entry the cursor is in, or -1. */
  readonly entry: number;
  readonly entryTitle: string;
  readonly role: BookEntry['role'] | null;
  /** "Pages 3–4", "Front cover". */
  readonly where: string;
  readonly canPrev: boolean;
  readonly canNext: boolean;
  readonly words: number;
  /** The words selected in the writing (without source tags), or "" when nothing is selected. */
  readonly selected: string;
}

export interface NotebookBookOptions {
  readonly entries: readonly BookEntry[];
  /** The cover and first page: the notebook's title, and who it is by. */
  readonly words: BookWords;
  readonly owner: string;
  readonly theme: string;
  /** A page colour over the theme (PAGE_COLORS id), if chosen. */
  readonly pageColor?: string | null;
  readonly textSize?: TextSize;
  readonly onEntries: (entries: BookEntry[]) => void;
  readonly onState?: (state: NotebookBookState) => void;
  readonly reducedMotion?: boolean;
  readonly sound?: PageSound;
  readonly prefersDark?: () => boolean;
  readonly now?: () => Date;
  /** A source tag ("p. 12", "14:32") was tapped: open that page or moment. */
  readonly onSource?: (src: number[]) => void;
  /** Tests pass a stand-in; the app builds one for the page's theme. */
  readonly typesetter?: () => ReturnType<typeof createTypesetter>;
}

export interface NotebookBookApp {
  readonly book: FlipBook;
  readonly entries: readonly BookEntry[];
  toggle(mark: BoolMark): void;
  setPara(style: ToggleParaStyle): void;
  setColor(value: string | null): void;
  setHighlight(value: string | null): void;
  clear(): void;
  undo(): void;
  redo(): void;
  insert(kind: 'table' | 'divider' | 'date'): void;
  /** Put a photo (already downscaled) on its own line at the cursor. */
  /** `bare`: drawn flat on the page with no photo frame (a mind map). */
  insertPicture(picture: BookPicture, bare?: boolean): void;
  /** A new, empty section after the last one; the cursor moves into it. */
  newSection(title?: string): void;
  renameEntry(index: number, title: string): void;
  /** The line the cursor is in: its text (without its source tag), its sources, and where the cursor is in it. */
  caretLine(): { entry: number; text: string; src: number[]; offset: number } | null;
  /** Where the selected words are drawn, in CSS pixels from the book's top left; null when none is showing. */
  selectionBox(): { left: number; top: number; right: number; bottom: number } | null;
  /** The words selected, the line they start in, and the pages those lines cite; null when nothing is selected. */
  selectedWords(): { text: string; line: string; src: number[] } | null;
  /** Add a line under the one the cursor is in, styled as a quote (an explanation, labelled as such). */
  addUnderLine(text: string): void;
  /** Put the cursor at the start of an entry, turning to its page. */
  openEntry(index: number): void;
  next(): void;
  prev(): void;
  setTheme(choice: string): Promise<void>;
  /** A page colour over the theme (its ink comes with it), or null for the theme's own paper. */
  setPageColor(id: string | null): Promise<void>;
  /** Bigger or smaller text; the book is typeset again. */
  setTextSize(size: TextSize): void;
  setWords(words: BookWords, owner: string): void;
  /** Underline these glossary terms wherever they are written. */
  setMarkedTerms(terms: readonly string[]): void;
  focus(): void;
  destroy(): void;
}

/** The typesetter for the page's current theme (as the Nkɔmmɔ diary builds it). */
function makeTypesetter() {
  const m = sharedMeasurer();
  if (!m) throw new Error('Canvas 2D is not available.');
  const body = font(LAYOUT.bodySize);
  const cap = font(DROP_CAP_SIZE, '500');
  return createTypesetter({
    measure: (w) => m.width(w, body),
    spaceWidth: m.width(' ', body),
    width: TEXT_WIDTH,
    linesPerPage: LINES_PER_PAGE,
    chapterLines: LAYOUT.chapterLines,
    // Notes, not a novel: no first-line indents and no drop caps.
    paragraphIndent: 0,
    dropCapWidth: (g) => m.width(g, cap) + 6,
    measureRun: (t, st) => m.width(t, styleFont(st)),
    dropCaps: false,
    lineHeight: LAYOUT.lineHeight,
  });
}

/** Book entries as the diary pipeline's entries: the heading is the section's title. */
const asEntries = (entries: readonly BookEntry[]): Entry[] =>
  entries.map((e) => ({ id: e.id, createdAt: e.title, text: e.text, marks: e.marks, paras: e.paras, ...(e.media ? { media: e.media } : {}) }));

const EMPTY_SECTION = (id: string, title: string): BookEntry => ({
  id, title, role: 'section', text: '', marks: [], paras: ['normal'], meta: [null],
});

/**
 * The sources of the line whose tag ("(p. 6)", "(0:18)") the caret is on, if it is.
 * Only on the tag itself: a press in the blank space after a short line lands at the
 * line's very end, and that should place the cursor, not open the source.
 */
export function tagAtCaret(entry: Pick<BookEntry, 'text' | 'meta'> | undefined, caret: number): number[] | null {
  return tagInfoAtCaret(entry, caret)?.src ?? null;
}

/** The tag under the caret and its sources, as tagAtCaret, with the tag's text ("(p.2–3)"). */
export function tagInfoAtCaret(entry: Pick<BookEntry, 'text' | 'meta'> | undefined, caret: number): { src: number[]; tag: string } | null {
  if (!entry) return null;
  const lines = entry.text.split('\n');
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const end = start + line.length;
    if (caret >= start && caret <= end) {
      const meta = entry.meta[i];
      if (!meta?.tag || !meta.src.length || !line.endsWith(meta.tag)) return null;
      return caret >= end - meta.tag.length && caret < end ? { src: meta.src, tag: meta.tag } : null;
    }
    start = end + 1;
  }
  return null;
}

/** What clicking a source tag does, said on hover: "(p.2–3)" opens pages, "(0:18)" a moment. */
export function tagHint(tag: string): string {
  const inner = tag.replace(/^\(|\)$/g, '');
  const pages = /^pp?\.\s*(.+)$/.exec(inner);
  if (pages) {
    const which = pages[1] as string;
    return /[–,-]/.test(which) ? `Pages ${which} of the source · click to open them` : `Page ${which} of the source · click to open it`;
  }
  return `Said at ${inner} · click to show where`;
}

export function createNotebookBook(root: HTMLElement, options: NotebookBookOptions): NotebookBookApp {
  root.replaceChildren();
  const stage = document.createElement('div');
  stage.className = 'nbk-stage';
  const canvas = document.createElement('canvas');
  canvas.className = 'nbk-canvas';
  canvas.setAttribute('role', 'img');
  const input = document.createElement('div');
  input.className = 'nbk-input';
  input.setAttribute('aria-label', 'Notebook page');
  stage.append(canvas, input);
  root.append(stage);

  const clock = options.now ?? (() => new Date());
  const newTypesetter = options.typesetter ?? makeTypesetter;
  let words = options.words;
  let owner = options.owner;
  let entries: BookEntry[] = [...options.entries];
  // A notebook always has somewhere to write.
  if (!entries.some((e) => e.role === 'section' || e.role === 'board')) {
    const at = entries.findIndex((e) => e.role === 'summary' || e.role === 'cues');
    entries.splice(at < 0 ? entries.length : at, 0, EMPTY_SECTION(`s${Date.now().toString(36)}`, 'Notes'));
  }
  let current = -1;
  let manuscript: EntryManuscript = buildManuscript([]);
  let pages: readonly PageSpec[] = assembleDiary([], options.owner, options.words);
  let frame = 0;
  let dirty = false;
  let destroyed = false;

  // Section numbers for the chapter headings: the front page, summary and Test yourself have none.
  const label = (ordinal: number, heading: string) => {
    const e = entries[ordinal - 1];
    const n = e?.role === 'section' ? entries.slice(0, ordinal).filter((x) => x.role === 'section').length : 0;
    return { numeral: n ? String(n) : '', title: heading };
  };
  const assemble = (textPages: Parameters<typeof assembleDiary>[0]) => assembleDiary(textPages, owner, words);
  let live = new LiveBook(newTypesetter(), '', { assemble, parse: () => manuscript.manuscript });

  const editor = new RichEditor(input, {
    placeholder: 'Write here.',
    onChange: (doc) => onEdit(doc),
    onSelect: () => {
      emitState();
      schedule();
    },
  });

  const book = new FlipBook({
    canvas,
    pages,
    paint: paintDiaryPage,
    reducedMotion: options.reducedMotion,
    onChange: () => {
      refreshOverlay();
      emitState();
    },
    onTurn: () => options.sound?.play(),
    singlePageWhenNarrow: true,
    onTap: (hit) => { placeCaret('down', hit); placeCaret('up', hit); },
    onPress: (phase, hit) => placeCaret(phase, hit),
  });
  book.tapToTurn = false;
  // Only the outer margin turns pages; a press or drag on the writing places the cursor or
  // selects. (The engine's default, the whole page, turned the page mid-selection.)
  book.grabZone = LAYOUT.outer / PAGE_W;

  // ── Source tags on hover ───────────────────────────────────────────────────
  // A tag ("(p.2–3)", "(0:18)") opens its source when clicked; over one, the pointer becomes a
  // hand and a note says what a click does, so it reads as a link and not as part of the note.
  const tip = document.createElement('div');
  tip.className = 'nbk-tag-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  stage.appendChild(tip);
  let hoverFrame = 0;
  let hoverAt: { x: number; y: number } | null = null;
  const hideTip = (): void => {
    tip.hidden = true;
    canvas.style.cursor = '';
  };
  function showTagHover(): void {
    hoverFrame = 0;
    const at = hoverAt;
    if (!at || destroyed) return;
    const hit = book.hitTest(at.x, at.y);
    const offset = hit ? live.caretAt(hit.index, hit.x, hit.y) : null;
    const place = offset === null ? null : fromSourceOffset(manuscript, asEntries(entries), offset);
    const found = place ? tagInfoAtCaret(entries[place.index], place.caret) : null;
    if (!found) return hideTip();
    tip.textContent = tagHint(found.tag);
    tip.hidden = false;
    const box = stage.getBoundingClientRect();
    const scale = stage.offsetWidth ? box.width / stage.offsetWidth : 1;   // the app's text-size zoom
    const x = (at.x - box.left) / scale;
    const y = (at.y - box.top) / scale;
    // Beside the pointer, flipped to its other side when it would run off the stage.
    const room = stage.offsetWidth - x - 14;
    tip.style.left = `${room < tip.offsetWidth ? Math.max(4, x - 14 - tip.offsetWidth) : x + 14}px`;
    tip.style.top = `${y + 18 + tip.offsetHeight > stage.offsetHeight ? y - 10 - tip.offsetHeight : y + 18}px`;
    canvas.style.cursor = 'pointer';
  }
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) return hideTip();          // selecting or turning a page
    hoverAt = { x: e.clientX, y: e.clientY };
    if (!hoverFrame) hoverFrame = requestAnimationFrame(showTagHover);
  });
  canvas.addEventListener('pointerleave', () => { hoverAt = null; hideTip(); });
  canvas.addEventListener('pointerdown', hideTip);

  // ── Typesetting ────────────────────────────────────────────────────────────

  function rebuild(): void {
    manuscript = buildManuscript(asEntries(entries), label);
    const update = live.update(manuscript.source);
    pages = update.pages;
    book.setPages(update.pages, update.changed);
  }

  function retypesetAll(): void {
    live = new LiveBook(newTypesetter(), '', { assemble, parse: () => manuscript.manuscript });
    manuscript = buildManuscript(asEntries(entries), label);
    pages = live.update(manuscript.source).pages;
    book.setPages(pages);
  }

  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(flush);
  }

  function flush(): void {
    frame = 0;
    if (destroyed) return;
    if (dirty) {
      dirty = false;
      rebuild();
    }
    follow();
  }

  function sourceSelection(): { a: number; b: number } | null {
    if (current < 0 || !entries[current]) return null;
    const sel = editor.selection();
    const list = asEntries(entries);
    return { a: toSourceOffset(manuscript, list, current, sel.start), b: toSourceOffset(manuscript, list, current, sel.end) };
  }

  function refreshOverlay(): void {
    const sel = editor.hasFocus() ? sourceSelection() : null;
    if (!sel) {
      book.setOverlay(null);
      return;
    }
    if (sel.a === sel.b) book.setOverlay({ caret: live.caretPoint(sel.a) });
    else book.setOverlay({ selection: live.selectionRects(sel.a, sel.b) });
  }

  function follow(): void {
    const sel = editor.hasFocus() ? sourceSelection() : null;
    const point = sel ? live.caretPoint(sel.b) : null;
    if (point) {
      book.reveal(point.page);
      book.setFocusY((point.y * book.pageSize.width) / PAGE_W);
    }
    refreshOverlay();
    emitState();
  }

  // ── The cursor ─────────────────────────────────────────────────────────────

  function selectEntry(index: number, caret = Number.MAX_SAFE_INTEGER): void {
    const entry = entries[index];
    if (!entry) return;
    if (index !== current) {
      current = index;
      const doc = withParas(entry);
      editor.setDoc(doc, Math.min(caret, doc.text.length));
    }
    editor.focus();
    editor.setSelection(Math.min(caret, entry.text.length));
    refreshOverlay();
    emitState();
  }

  let anchor: { index: number; caret: number } | null = null;
  // The source link pressed, opened on release unless the press became a selection.
  let pendingSource: number[] | null = null;

  function placeCaret(phase: 'down' | 'move' | 'up', hit: PageHit | null): void {
    if (phase === 'up') {
      if (pendingSource) options.onSource?.(pendingSource);
      pendingSource = null;
      anchor = null;
      emitState();
      return;
    }
    if (phase === 'down' && hit) {
      // Tapping a checklist box ticks it without moving the cursor.
      const block = live.checkboxAt(hit.index, hit.x, hit.y);
      const target = block === null ? null : manuscript.blockLines[block];
      if (target) {
        if (target.entry !== current) selectEntry(target.entry, 0);
        const style = editor.value.paras[target.line];
        editor.setLineStyle(target.line, style === 'checked' ? 'check' : 'checked');
        return;
      }
    }
    const offset = hit ? live.caretAt(hit.index, hit.x, hit.y) : null;
    const at = offset === null ? null : fromSourceOffset(manuscript, asEntries(entries), offset);
    if (phase === 'down') {
      pendingSource = at ? tagAtCaret(entries[at.index], at.caret) : null;
      if (at) {
        selectEntry(at.index, at.caret);
        anchor = at;
      } else if (hit && isWritingPage(pages[hit.index])) {
        // An empty part of a writing page: back to where you were writing.
        selectEntry(current >= 0 ? current : firstWritable());
      } else if (hit?.index === 0) {
        // The front cover opens, like a book. It used to put the cursor in the first section, which turned
        // straight to page 1 and skipped the title page.
        book.next();
      }
      // The inside cover, title page and back cover: nothing to write there, so a click moves nothing.
      return;
    }
    if (at && anchor && (at.index !== anchor.index || at.caret !== anchor.caret)) pendingSource = null;
    if (at && anchor && at.index === anchor.index) {
      editor.setSelection(Math.min(anchor.caret, at.caret), Math.max(anchor.caret, at.caret));
      refreshOverlay();
    }
  }

  /** A page you write on: text, a blank page ahead, or the waiting first page. */
  const isWritingPage = (spec: PageSpec | undefined): boolean =>
    !!spec && (spec.kind === 'text' || spec.kind === 'blank' || (spec.kind === 'custom' && spec.name === 'diary-empty'));

  const firstWritable = () => Math.max(0, entries.findIndex((e) => e.role === 'section' || e.role === 'board'));

  /** Home, End, Up and Down follow the printed lines, not the hidden input. */
  const onArrow = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || current < 0) return;
    const edge = e.key === 'Home' || e.key === 'End';
    if (!edge && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (dirty) {
      dirty = false;
      rebuild();
    }
    const list = asEntries(entries);
    const sel = editor.selection();
    if (edge) {
      const end = e.key === 'End';
      const target = live.lineEdge(toSourceOffset(manuscript, list, current, end ? sel.end : sel.start), end ? 'end' : 'start');
      const at = fromSourceOffset(manuscript, list, target);
      if (!at || at.index !== current) return;
      if (e.shiftKey) editor.setSelection(end ? sel.start : at.caret, end ? at.caret : sel.end);
      else editor.setSelection(at.caret);
      follow();
      return;
    }
    const up = e.key === 'ArrowUp';
    const moved = live.verticalMove(toSourceOffset(manuscript, list, current, up ? sel.start : sel.end), up ? -1 : 1);
    const at = fromSourceOffset(manuscript, list, moved);
    if (!at) return;
    if (at.index !== current) {
      if (!e.shiftKey) selectEntry(at.index, at.caret);
    } else if (e.shiftKey) editor.setSelection(up ? at.caret : sel.start, up ? sel.end : at.caret);
    else editor.setSelection(at.caret);
    follow();
  };

  // ── Editing ────────────────────────────────────────────────────────────────

  function onEdit(doc: RichDoc): void {
    if (current < 0) current = firstWritable();
    const entry = entries[current];
    if (!entry) return;
    const meta = remapMeta(entry.text, doc.text, entry.meta);
    const used = new Set(doc.paras.map(imageIdOf).filter((x): x is string => !!x));
    const media = entry.media && Object.fromEntries(Object.entries(entry.media).filter(([id]) => used.has(id)));
    entries = entries.map((e, i) => (i === current
      ? { ...e, text: doc.text, marks: [...doc.marks], paras: [...doc.paras], meta, ...(media ? { media } : {}) } : e));
    dirty = true;
    schedule();
    options.onEntries(entries);
  }

  function withFocus(fn: () => void): void {
    if (current < 0) selectEntry(firstWritable(), 0);
    if (!editor.hasFocus()) editor.focus();
    fn();
    emitState();
  }

  function emitState(): void {
    if (!options.onState || destroyed) return;
    let { left, right } = book.visiblePages();
    // One page at a time (a narrow window): name only the page in view.
    const single = book.isSinglePage;
    if (single) {
      if (book.visibleSide === 'left') right = null;
      else left = null;
    }
    const folios = [left, right].map((i) => (i === null ? null : folioOf(pages[i]))).filter((n): n is number => n !== null);
    const where = folios.length ? (folios.length > 1 ? `Pages ${folios[0]}–${folios[1]}` : `Page ${folios[0]}`)
      : book.spread === 0 ? 'Front cover' : book.spread >= book.lastSpread ? 'Back cover'
      : single && book.visibleSide === 'left' && book.spread === 1 ? 'Inside cover' : 'Title page';
    const e = entries[current];
    options.onState({
      ...editor.state(),
      entry: current,
      entryTitle: e?.title ?? '',
      role: e?.role ?? null,
      where,
      canPrev: book.canTurn(-1),
      canNext: book.canTurn(1),
      words: current >= 0 ? editor.wordCount() : 0,
      selected: selectedWords()?.text ?? '',
    });
  }

  /** What is selected in the current entry, with its source tags taken out. */
  function selectedWords(): { text: string; line: string; src: number[] } | null {
    const entry = entries[current];
    if (!entry || !editor.hasFocus()) return null;
    const { start, end } = editor.selection();
    if (end <= start) return null;
    const lines = entry.text.split('\n');
    const parts: string[] = [];
    const src = new Set<number>();
    let first = '';
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] as string;
      const lineEnd = at + raw.length;
      if (lineEnd >= start && at <= end) {
        const meta = entry.meta[i];
        const tag = meta?.tag && raw.endsWith(meta.tag) ? meta.tag : '';
        const body = tag ? raw.slice(0, -tag.length) : raw;
        const piece = body.slice(Math.max(0, start - at), Math.max(0, Math.min(body.length, end - at)));
        if (piece.trim()) parts.push(piece.trim());
        if (!first) first = body.trim();
        for (const p of meta?.src ?? []) src.add(p);
      }
      at = lineEnd + 1;
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 600);
    return text ? { text, line: first, src: [...src].sort((a, b) => a - b) } : null;
  }

  function onPictureReady(id: string): void {
    if (!destroyed) book.setPages(pages, live.pagesWithImage(id));
  }
  for (const e of entries) for (const [id, pic] of Object.entries(e.media ?? {})) registerImage(id, pic.src, onPictureReady);

  // ── Themes ─────────────────────────────────────────────────────────────────

  let themeChoice = options.theme;
  let pageColor: string | null = options.pageColor ?? null;
  let sizeChoice: TextSize = options.textSize ?? 'm';
  setTextSize(sizeChoice);        // every book sets it: one notebook's size never carries into the next

  /**
   * The size as it should be now: on a Clean paper, pixels on screen (so it depends on how big the book is
   * drawn); otherwise page units. True when the layout changed and the book must be typeset again.
   */
  function applySize(): boolean {
    const before = LAYOUT.bodySize;
    const shown = book.pageSize.width;
    setTextSize(sizeChoice, pageTheme().plain && shown > 0 ? shown / PAGE_W : undefined);
    return Math.abs(LAYOUT.bodySize - before) > 0.2;
  }

  async function setTheme(choice: string): Promise<void> {
    themeChoice = choice;
    const theme: Theme = withPageColor(resolveTheme(choice, options.prefersDark?.() ?? false), pageColor);
    applyPageTheme(theme);
    applySize();
    // The theme restyles the book (paper, cover, ink); the app around it keeps its own colours.
    root.dataset.look = theme.id;
    if (document.fonts?.load) {
      await Promise.race([
        Promise.all(themeFonts(theme).map((f) => document.fonts.load(f).catch(() => []))),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    }
    if (destroyed) return;
    sharedMeasurer()?.clear();
    retypesetAll();
    refreshOverlay();
  }

  // ── Wiring ─────────────────────────────────────────────────────────────────

  const fit = (): void => {
    book.resize(stage.clientWidth, stage.clientHeight);
    // On a Clean paper a bigger or smaller book means a different size in page units: typeset again.
    if (pageTheme().plain && applySize()) {
      sharedMeasurer()?.clear();
      retypesetAll();
      refreshOverlay();
      emitState();
    }
  };
  const observer = new ResizeObserver(fit);
  observer.observe(stage);
  editor.el.addEventListener('keydown', onArrow);
  editor.el.addEventListener('focus', () => {
    book.setFillWidth(book.isSinglePage);
    schedule();
  });
  editor.el.addEventListener('blur', () => {
    book.setFillWidth(false);
    book.setFocusY(null);
    refreshOverlay();
  });

  void setTheme(options.theme);
  retypesetAll();
  fit();
  emitState();

  return {
    book,
    get entries() {
      return entries;
    },
    toggle: (mark) => withFocus(() => editor.toggle(mark)),
    setPara: (style) => withFocus(() => editor.setPara(style)),
    setColor: (value) => withFocus(() => editor.setColor(value)),
    setHighlight: (value) => withFocus(() => editor.setHighlight(value)),
    clear: () => withFocus(() => editor.clear()),
    undo: () => withFocus(() => editor.undo()),
    redo: () => withFocus(() => editor.redo()),
    insert(kind) {
      withFocus(() => {
        if (kind === 'table') {
          editor.insertLines([
            { text: 'Column 1\tColumn 2\tColumn 3', para: 'table' },
            { text: '\t\t', para: 'table' },
            { text: '\t\t', para: 'table' },
          ], 1, 0);
        } else if (kind === 'divider') {
          editor.insertLines([{ text: '', para: 'divider' }], 0, 0, true);
        } else {
          const { day, time } = formatEntryDate(clock().toISOString());
          editor.insertText(`${day}, ${time}`);
        }
      });
    },
    insertPicture(picture, bare = false) {
      withFocus(() => {
        const id = `${bare ? MIND_MAP_PREFIX : 'p'}${clock().getTime().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
        entries = entries.map((e, i) => (i === current ? { ...e, media: { ...(e.media ?? {}), [id]: picture } } : e));
        registerImage(id, picture.src, onPictureReady);
        // A mind map goes at the end of its section, after the passage, not in the middle of it.
        if (bare) editor.setSelection(editor.text.length);
        editor.insertLines([{ text: OBJECT_CHAR, para: `image:${id}` }], 0, 0, true);
      });
    },
    newSection(title = 'New section') {
      const lastSection = entries.map((e) => e.role).lastIndexOf('section');
      const at = lastSection < 0 ? firstWritable() + 1 : lastSection + 1;
      const id = `s${clock().getTime().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
      entries = [...entries.slice(0, at), EMPTY_SECTION(id, title), ...entries.slice(at)];
      current = -1;
      rebuild();
      editor.setDoc(plainDoc(''), 0);
      selectEntry(at, 0);
      const target = spreadOf(live.caretPoint(manuscript.bodyStarts[at] ?? 0)?.page ?? book.spread);
      if (target !== book.spread) book.jumpTo(target);
      options.onEntries(entries);
    },
    renameEntry(index, title) {
      if (!entries[index] || entries[index]!.role !== 'section') return;
      entries = entries.map((e, i) => (i === index ? { ...e, title } : e));
      dirty = true;
      schedule();
      options.onEntries(entries);
    },
    selectedWords,
    selectionBox() {
      const sel = sourceSelection();
      if (!sel || sel.a === sel.b) return null;
      const boxes = live.selectionRects(sel.a, sel.b).map((r) => book.cssRect(r.page, r)).filter((b) => b !== null);
      if (!boxes.length) return null;
      return {
        left: Math.min(...boxes.map((b) => b.x)), top: Math.min(...boxes.map((b) => b.y)),
        right: Math.max(...boxes.map((b) => b.x + b.w)), bottom: Math.max(...boxes.map((b) => b.y + b.h)),
      };
    },
    caretLine() {
      const entry = entries[current];
      if (!entry) return null;
      const caret = editor.selection().end;
      const lines = entry.text.split('\n');
      let start = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (caret <= start + line.length) {
          const meta = entry.meta[i];
          const text = meta?.tag && line.endsWith(meta.tag) ? line.slice(0, -meta.tag.length) : line;
          return { entry: current, text: text.trim(), src: meta?.src ? [...meta.src] : [], offset: caret - start };
        }
        start += line.length + 1;
      }
      return null;
    },
    addUnderLine(text) {
      const entry = entries[current];
      if (!entry || !text.trim()) return;
      withFocus(() => {
        const caret = editor.selection().end;
        const nl = entry.text.indexOf('\n', caret);
        editor.setSelection(nl < 0 ? entry.text.length : nl);
        editor.insertText('\n' + text.trim());
        editor.setPara('quote');
      });
    },
    openEntry(index) {
      selectEntry(index, 0);
      follow();
    },
    next: () => {
      book.next();
      emitState();
    },
    prev: () => {
      book.prev();
      emitState();
    },
    setTheme,
    setPageColor(id) {
      pageColor = id;
      return setTheme(themeChoice);
    },
    setTextSize(size) {
      sizeChoice = size;
      applySize();
      sharedMeasurer()?.clear();
      retypesetAll();
      refreshOverlay();
      emitState();
    },
    setMarkedTerms(terms) {
      setMarkedTerms(terms);
      retypesetAll();
    },
    setWords(next, nextOwner) {
      words = next;
      owner = nextOwner;
      retypesetAll();
    },
    focus: () => selectEntry(current >= 0 ? current : firstWritable()),
    destroy() {
      destroyed = true;
      setMarkedTerms([]);   // the next book underlines only its own terms
      cancelAnimationFrame(frame);
      observer.disconnect();
      editor.destroy();
      book.destroy();
      root.replaceChildren();
    },
  };
}
