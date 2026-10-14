/**
 * The Notebook (product specs 184/185): types, API calls and the pure editing
 * helpers the notebook screens use. Everything that changes a document here
 * returns a new document — nothing mutates — so an edit can always be undone
 * by keeping the old one, and the helpers can be tested on their own.
 */
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";

export type NotebookKind = "lecture" | "meeting" | "reading";

export type BlockType =
  | "point" | "key" | "definition" | "example" | "exam" | "question" | "quote" | "formula"
  | "table" | "unclear" | "decision" | "action" | "risk" | "number" | "note" | "tutor" | "image";

export interface Block {
  id: string;
  type: BlockType;
  text: string;
  src: number[];
  term?: string;
  speaker?: string;
  owner?: string;
  due?: string;
  done?: boolean;
  rows?: string[][];
  caption?: string;
  /** A photo: a downscaled JPEG as a data URL, and its size. */
  image?: string;
  w?: number;
  h?: number;
  /** The user's highlights in `text`, in their colours. */
  marks?: Mark[];
  /** The user's bold, italic, underline and strikethrough in `text`. */
  fmt?: Formatting;
  /** The user's text colours in `text`. */
  ink?: Ink[];
  /** Formatting on the block's other texts: term, speaker, owner, due, caption, cell:R:C. */
  rich?: Record<string, Rich>;
  /**
   * How the block's line is drawn in the book, when the reader styled it away
   * from its type's usual look; "blank" and "divider" are lines with no words.
   */
  para?: BlockPara;
}

export const BLOCK_PARAS = ["normal", "bullet", "numbered", "check", "checked", "quote", "center", "key", "divider", "blank"] as const;
export type BlockPara = (typeof BLOCK_PARAS)[number];

export const MARK_COLORS = ["yellow", "green", "blue", "pink", "orange"] as const;
export type MarkColor = (typeof MARK_COLORS)[number];
/**
 * A highlight: characters s..e of the block's text, and those characters (q),
 * so it can find its words again after the text is edited.
 */
export interface Mark { s: number; e: number; c: MarkColor; q: string }

/** Text colours: the letters themselves, tuned per theme in notebook.css. */
export const INK_COLORS = ["red", "orange", "green", "blue", "purple"] as const;
export type InkColor = (typeof INK_COLORS)[number];
export interface Ink { s: number; e: number; c: InkColor; q: string }

/** Bold, italic, underline, strikethrough: each its own layer, so they combine with each other and with a highlight. */
export const STYLES = ["b", "i", "u", "x"] as const;
export type StyleKey = (typeof STYLES)[number];
/** Characters s..e, and those characters (q), as for a highlight. */
export interface Span { s: number; e: number; q: string }
export type Formatting = Partial<Record<StyleKey, Span[]>>;

/** Where `q` sits in `text` now: at `s` if it's still there, else the nearest place it appears; -1 if it's gone. */
function relocate(text: string, s: number, q: string): number {
  if (text.slice(s, s + q.length) === q) return s;
  let best = -1, at = text.indexOf(q);
  while (at !== -1) {
    if (best === -1 || Math.abs(at - s) < Math.abs(best - s)) best = at;
    at = text.indexOf(q, at + 1);
  }
  return best;
}

const blank = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/** Maximal runs of equal, non-empty values in `paint`, with spaces left off both ends. */
function runsOf<T>(text: string, paint: (T | null)[]): { s: number; e: number; v: T }[] {
  const out: { s: number; e: number; v: T }[] = [];
  for (let i = 0; i < paint.length;) {
    const v = paint[i];
    let j = i + 1;
    while (j < paint.length && paint[j] === v) j++;
    if (v !== null && v !== undefined) {
      let a = i, b = j;
      while (a < b && blank(text[a])) a++;
      while (b > a && blank(text[b - 1])) b--;
      if (b > a) out.push({ s: a, e: b, v });
    }
    i = j;
  }
  return out;
}

/** from..to within the text, without the spaces a drag picks up at its ends. */
function clampRange(text: string, from: number, to: number): [number, number] {
  let lo = Math.max(0, Math.min(from, to)), hi = Math.min(text.length, Math.max(from, to));
  while (lo < hi && blank(text[lo])) lo++;
  while (hi > lo && blank(text[hi - 1])) hi--;
  return [lo, hi];
}

/**
 * A coloured layer (highlights, text colours) as it falls on `text` now. One whose
 * words moved is found again (the nearest place they appear); one whose words are
 * gone is dropped. Sorted, never overlapping.
 */
function anchorColored<C extends string>(text: string, list: { s: number; c: C; q: string }[] | undefined,
  palette: readonly C[]): { s: number; e: number; c: C; q: string }[] {
  const out: { s: number; e: number; c: C; q: string }[] = [];
  for (const m of list ?? []) {
    if (!m || !m.q || !palette.includes(m.c)) continue;
    const s = relocate(text, m.s, m.q);
    if (s !== -1) out.push({ s, e: s + m.q.length, c: m.c, q: m.q });
  }
  out.sort((a, b) => a.s - b.s);
  const kept: typeof out = [];
  let end = 0;
  for (const m of out) if (m.s >= end) { kept.push(m); end = m.e; }   // two found in the same place: the first wins
  return kept;
}

/** Colour characters from..to (or clear them, null). What was there before gives way; the rest stays. */
function applyColored<C extends string>(text: string, list: { s: number; c: C; q: string }[] | undefined, palette: readonly C[],
  from: number, to: number, color: C | null): { s: number; e: number; c: C; q: string }[] {
  const [lo, hi] = color ? clampRange(text, from, to)
    : [Math.max(0, Math.min(from, to)), Math.min(text.length, Math.max(from, to))];
  const paint: (C | null)[] = new Array(text.length).fill(null);
  for (const m of anchorColored(text, list, palette)) for (let i = m.s; i < m.e; i++) paint[i] = m.c;
  for (let i = lo; i < hi; i++) paint[i] = color;
  return runsOf(text, paint).map(r => ({ s: r.s, e: r.e, c: r.v, q: text.slice(r.s, r.e) }));
}

/** The highlights as they fall on `text` now (see anchorColored). */
export function anchorMarks(text: string, marks: Mark[] | undefined): Mark[] {
  return anchorColored(text, marks, MARK_COLORS);
}

/** Highlight characters from..to of `text` in `color`, or clear them (null). */
export function applyMark(text: string, marks: Mark[] | undefined, from: number, to: number, color: MarkColor | null): Mark[] {
  return applyColored(text, marks, MARK_COLORS, from, to, color);
}

/** Colour the letters from..to of `text`, or put them back to the notebook's ink (null). */
export function applyInk(text: string, ink: Ink[] | undefined, from: number, to: number, color: InkColor | null): Ink[] {
  return applyColored(text, ink, INK_COLORS, from, to, color);
}

/** Where one style falls on `text` now, as a character mask. */
function styleMask(text: string, spans: Span[] | undefined): boolean[] {
  const mask = new Array(text.length).fill(false);
  for (const sp of spans ?? []) {
    if (!sp || !sp.q) continue;
    const s = relocate(text, sp.s, sp.q);
    if (s !== -1) for (let i = s; i < s + sp.q.length; i++) mask[i] = true;
  }
  return mask;
}



/** Whether every letter in from..to already has this style (the toolbar shows it pressed). */
export function hasStyle(text: string, fmt: Formatting | undefined, key: StyleKey, from: number, to: number): boolean {
  const [lo, hi] = clampRange(text, from, to);
  if (hi <= lo) return false;
  const mask = styleMask(text, fmt?.[key]);
  for (let i = lo; i < hi; i++) if (!blank(text[i]) && !mask[i]) return false;
  return true;
}

function withStyle(text: string, fmt: Formatting | undefined, key: StyleKey, mask: boolean[]): Formatting {
  const spans = runsOf(text, mask.map(v => (v ? true : null))).map(r => ({ s: r.s, e: r.e, q: text.slice(r.s, r.e) }));
  const out: Formatting = { ...(fmt ?? {}) };
  if (spans.length) out[key] = spans; else delete out[key];
  return out;
}

/** Turn a style on over from..to, or off where it's already on throughout (as a word processor does). */
export function toggleStyle(text: string, fmt: Formatting | undefined, key: StyleKey, from: number, to: number): Formatting {
  const [lo, hi] = clampRange(text, from, to);
  const on = !hasStyle(text, fmt, key, from, to);
  const mask = styleMask(text, fmt?.[key]);
  for (let i = lo; i < hi; i++) mask[i] = on;
  return withStyle(text, fmt, key, mask);
}

/** Take every highlight, style and text colour off from..to. */
export function clearFormatting(text: string, marks: Mark[] | undefined, fmt: Formatting | undefined,
  from: number, to: number, ink?: Ink[]): { marks: Mark[]; fmt: Formatting; ink: Ink[] } {
  const lo = Math.max(0, Math.min(from, to)), hi = Math.min(text.length, Math.max(from, to));
  let next: Formatting = { ...(fmt ?? {}) };
  for (const key of STYLES) {
    const mask = styleMask(text, fmt?.[key]);
    for (let i = lo; i < hi; i++) mask[i] = false;
    next = withStyle(text, next, key, mask);
  }
  return { marks: applyMark(text, marks, lo, hi, null), fmt: next, ink: applyInk(text, ink, lo, hi, null) };
}

/** Whether anything in from..to is highlighted or styled (the toolbar then offers to clear it). */
export function hasFormatting(text: string, marks: Mark[] | undefined, fmt: Formatting | undefined, from: number, to: number,
  ink?: Ink[]): boolean {
  if (anchorMarks(text, marks).some(m => m.s < to && m.e > from)) return true;
  if (anchorColored(text, ink, INK_COLORS).some(m => m.s < to && m.e > from)) return true;
  return STYLES.some(key => styleMask(text, fmt?.[key]).slice(from, to).some(Boolean));
}

/** One stretch of text drawn one way: its highlight and styles. */
export interface Run { text: string; c: MarkColor | null; k: InkColor | null; b: boolean; i: boolean; u: boolean; x: boolean }

/** A block's text cut into runs that each look the same, for drawing. */
export function richRuns(text: string, marks: Mark[] | undefined, fmt: Formatting | undefined, ink?: Ink[]): Run[] {
  if (!text) return [];
  // Most text has no formatting at all: one plain run, no per-character work.
  if (!marks?.length && !ink?.length && !(fmt && STYLES.some(key => fmt[key]?.length))) {
    return [{ text, c: null, k: null, b: false, i: false, u: false, x: false }];
  }
  const color: (MarkColor | null)[] = new Array(text.length).fill(null);
  for (const m of anchorMarks(text, marks)) for (let k = m.s; k < m.e; k++) color[k] = m.c;
  const inkAt: (InkColor | null)[] = new Array(text.length).fill(null);
  for (const m of anchorColored(text, ink, INK_COLORS)) for (let k = m.s; k < m.e; k++) inkAt[k] = m.c;
  const masks = Object.fromEntries(STYLES.map(key => [key, styleMask(text, fmt?.[key])])) as Record<StyleKey, boolean[]>;
  const same = (a: number, b: number) => color[a] === color[b] && inkAt[a] === inkAt[b] && masks.b[a] === masks.b[b]
    && masks.i[a] === masks.i[b] && masks.u[a] === masks.u[b] && masks.x[a] === masks.x[b];
  // Cut the text where its look changes (slices, not one character at a time).
  const runs: Run[] = [];
  let start = 0;
  for (let k = 1; k <= text.length; k++) {
    if (k < text.length && same(k, start)) continue;
    runs.push({ text: text.slice(start, k), c: color[start], k: inkAt[start],
      b: masks.b[start], i: masks.i[start], u: masks.u[start], x: masks.x[start] });
    start = k;
  }
  return runs;
}

/** Formatting for one text: its highlights, styles and text colours. */
export interface Rich { marks?: Mark[]; fmt?: Formatting; ink?: Ink[] }

/**
 * Any text in a notebook that can be formatted: a block's field (b), a section's
 * title (s) or one of the notebook's own texts (d). Written into the page as
 * data-rich="scope:id:field", so a selection can be traced back to its text.
 */
export interface RichTarget { scope: "b" | "s" | "d"; id: string; field: string }

export const richKey = (t: RichTarget) => `${t.scope}:${t.id}:${t.field}`;
export function parseRichKey(key: string | undefined): RichTarget | null {
  const m = /^([bsd]):([^:]*):(.+)$/.exec(key ?? "");
  return m ? { scope: m[1] as RichTarget["scope"], id: m[2], field: m[3] } : null;
}

function findBlock(doc: NotebookDoc, id: string): Block | undefined {
  for (const sec of doc.sections) { const b = sec.blocks.find(x => x.id === id); if (b) return b; }
  for (const list of Object.values(doc.board)) { const b = list.find(x => x.id === id); if (b) return b; }
  return undefined;
}

/** The words a target holds now, or null if it no longer exists. */
export function textAt(doc: NotebookDoc, t: RichTarget): string | null {
  if (t.scope === "d") {
    if (t.field.startsWith("cue:")) return doc.cues[Number(t.field.slice(4))] ?? null;
    const v = (doc as unknown as Record<string, unknown>)[t.field];
    return typeof v === "string" ? v : null;
  }
  if (t.scope === "s") return doc.sections.find(x => x.id === t.id)?.title ?? null;
  const b = findBlock(doc, t.id);
  if (!b) return null;
  const cell = /^cell:(\d+):(\d+)$/.exec(t.field);
  if (cell) return b.rows?.[Number(cell[1])]?.[Number(cell[2])] ?? null;
  const v = (b as unknown as Record<string, unknown>)[t.field];
  return typeof v === "string" ? v : null;
}

/** A target's formatting. A block's main text keeps its formatting on the block itself. */
export function richAt(doc: NotebookDoc, t: RichTarget): Rich {
  if (t.scope === "d") return doc.rich?.[t.field] ?? {};
  if (t.scope === "s") return doc.sections.find(x => x.id === t.id)?.rich?.title ?? {};
  const b = findBlock(doc, t.id);
  if (!b) return {};
  return t.field === "text" ? { marks: b.marks, fmt: b.fmt, ink: b.ink } : b.rich?.[t.field] ?? {};
}

/** The document with a target's formatting replaced. */
export function withRich(doc: NotebookDoc, t: RichTarget, rich: Rich): NotebookDoc {
  if (t.scope === "d") return { ...doc, rich: { ...(doc.rich ?? {}), [t.field]: rich } };
  if (t.scope === "s") {
    const sec = doc.sections.find(x => x.id === t.id);
    return sec ? updateSection(doc, t.id, { rich: { ...(sec.rich ?? {}), title: rich } }) : doc;
  }
  const b = findBlock(doc, t.id);
  const at = placeOf(doc, t.id);
  if (!b || !at) return doc;
  return updateBlock(doc, at, t.id, t.field === "text"
    ? { marks: rich.marks, fmt: rich.fmt, ink: rich.ink }
    : { rich: { ...(b.rich ?? {}), [t.field]: rich } });
}

/** Where a block lives in the document (for updateBlock), or null. */
export function placeOf(doc: NotebookDoc, blockId: string): Place | null {
  for (const sec of doc.sections) if (sec.blocks.some(b => b.id === blockId)) return { section: sec.id };
  for (const key of Object.keys(doc.board) as BoardKey[]) if (doc.board[key].some(b => b.id === blockId)) return { board: key };
  return null;
}

export interface Section { id: string; title: string; src: number[]; blocks: Block[]; rich?: { title?: Rich } }

export type BoardKey = "decisions" | "actions" | "questions" | "risks" | "numbers";

/** A term found in a notebook: its meaning, and whether that came from the source (with pages) or is iReliabee's. */
export interface FoundTerm { term: string; meaning: string; from: "source" | "general" | "both"; pages: number[]; unsure?: boolean }

export interface NotebookDoc {
  title: string;
  /** Who wrote the source: a paper's authors, the lecturer. Shown on the cover. */
  author?: string;
  summary: string;
  cues: string[];
  sections: Section[];
  board: Record<BoardKey, Block[]>;
  /** Formatting on the notebook's own texts: title, author, summary, cue:N. */
  rich?: Record<string, Rich>;
  /** What is written on an exercise-book cover's label, edited on the cover. */
  cover?: { name?: string; class?: string; year?: string };
  /** Unfamiliar terms found for this notebook (the fuller glossary), each labelled where its meaning came from. */
  terms?: FoundTerm[];
}

export interface NotebookStyle {
  family: FontFamily; size: FontSize; style: FontStyle; list?: ListMarker; paper?: Paper;
  /** A page colour over the paper theme (lib/book/themes PAGE_COLORS), if chosen. */
  pageColor?: string | null;
}
/** The book's paper and cover (the Nkɔmmɔ themes); "auto" follows the system's light or dark. */
export type Paper = "classic" | "light" | "dark" | "school" | "parchment" | "dotgrid" | "clean" | "cleandark" | "auto";
/** How list items (Test yourself questions, cues) are marked. */
export type ListMarker = "bullet" | "number" | "none";
export type FontFamily = "serif" | "sans" | "readable" | "hand";
export type FontSize = "xs" | "s" | "m" | "l" | "xl";
export type FontStyle = "regular" | "light" | "bold" | "italic";

export interface Notebook {
  id: number;
  kind: NotebookKind;
  session_id: number | null;
  document_id: number | null;
  title: string;
  template: string;
  style: NotebookStyle;
  version: number;
  edited: boolean;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
  doc: NotebookDoc;
  line_times?: Record<string, number>;
  /** Reading decks: how many of the document's key points the slides cover (spec 185 §5.3). */
  coverage?: Partial<Coverage>;
  /** Reading decks: what was covered ("Chapter 3", "Pages 12–48"). */
  scope?: { mode?: string; label?: string; pages?: string; chapters?: number[] };
}

export interface Coverage {
  core_total: number;
  core_by_ai: number;
  supporting_total: number;
  supporting_by_ai: number;
  added_by_check: number;
  details: number;
  required: number;
  covered: number;
  by_ai_pct: number;
  left_out: string[];
  pages: number;
  /** A deep read: its terms and what each builds on (the map of ideas). */
  ideas?: import("./reading").Idea[];
}

export interface NotebookSummary extends Omit<Notebook, "doc" | "line_times"> {
  summary: string;
  counts: { sections: number; key: number; actions: number; decisions: number };
}

// ── How it looks ─────────────────────────────────────────────────────────────

export const FONT_FAMILIES: { id: FontFamily; label: string; hint: string; stack: string }[] = [
  { id: "serif",    label: "Book serif",   hint: "Newsreader — classic and calm", stack: "'Newsreader', Georgia, 'Times New Roman', serif" },
  { id: "sans",     label: "Modern sans",  hint: "Instrument Sans — clean",       stack: "'Instrument Sans', 'Segoe UI', system-ui, sans-serif" },
  { id: "readable", label: "Easy to read", hint: "Atkinson Hyperlegible",         stack: "'Atkinson Hyperlegible', 'Segoe UI', system-ui, sans-serif" },
  { id: "hand",     label: "Handwritten",  hint: "Caveat — like your own notes",  stack: "'Caveat', 'Segoe Print', 'Bradley Hand', cursive" },
];

export const FONT_SIZES: { id: FontSize; label: string; px: number }[] = [
  { id: "xs", label: "Extra small", px: 13 }, { id: "s", label: "Small", px: 14 }, { id: "m", label: "Medium", px: 16 },
  { id: "l", label: "Large", px: 18 }, { id: "xl", label: "Extra large", px: 20 },
];

export const FONT_STYLES: { id: FontStyle; label: string }[] = [
  { id: "regular", label: "Regular" }, { id: "light", label: "Light" },
  { id: "bold", label: "Bold" }, { id: "italic", label: "Italic" },
];

export const LIST_MARKERS: { id: ListMarker; label: string; css: string }[] = [
  { id: "bullet", label: "• Bullets", css: "disc" }, { id: "number", label: "1. Numbers", css: "decimal" },
  { id: "none", label: "None", css: "none" },
];

export const DEFAULT_STYLE: Record<NotebookKind, NotebookStyle> = {
  lecture: { family: "serif", size: "m", style: "regular", list: "bullet", paper: "classic" },
  reading: { family: "serif", size: "m", style: "regular", list: "bullet", paper: "parchment" },
  meeting: { family: "sans", size: "m", style: "regular", list: "bullet", paper: "dotgrid" },
};

/** The CSS variables a notebook page reads for its body text. */
export function styleVars(style: NotebookStyle): Record<string, string> {
  const family = FONT_FAMILIES.find(f => f.id === style.family) ?? FONT_FAMILIES[0];
  const size = FONT_SIZES.find(s => s.id === style.size) ?? FONT_SIZES[1];
  // Handwriting reads small; give it a little more room.
  const px = style.family === "hand" ? Math.round(size.px * 1.25) : size.px;
  return {
    "--nb-font": family.stack,
    "--nb-size": `${px}px`,
    "--nb-weight": style.style === "bold" ? "600" : style.style === "light" ? "300" : "400",
    "--nb-italic": style.style === "italic" ? "italic" : "normal",
    "--nb-line": `${Math.round(px * 1.75)}px`,
    "--nb-list": (LIST_MARKERS.find(m => m.id === style.list) ?? LIST_MARKERS[0]).css,
  };
}

// ── What each block is ───────────────────────────────────────────────────────

export const BLOCK_META: Record<BlockType, { label: string; hint: string }> = {
  point:      { label: "Note",           hint: "A point that was made" },
  key:        { label: "Key point",      hint: "One of the things most worth remembering" },
  definition: { label: "Term",           hint: "A term and what it means" },
  example:    { label: "Example",        hint: "An example or analogy that was given" },
  exam:       { label: "Exam point",     hint: "Flagged as important for the exam" },
  question:   { label: "Question",       hint: "Something to ask or look up" },
  quote:      { label: "Quote",          hint: "Exact words worth keeping" },
  formula:    { label: "Formula",        hint: "A formula or equation, kept exactly" },
  table:      { label: "Table",          hint: "Rows and columns" },
  unclear:    { label: "Check this",     hint: "Hard to hear or unclear — check the source" },
  decision:   { label: "Decision",       hint: "A decision that was reached" },
  action:     { label: "Action",         hint: "A task, with an owner and a due date" },
  risk:       { label: "Risk",           hint: "A risk or blocker someone raised" },
  number:     { label: "Number or date", hint: "A figure or date worth keeping" },
  note:       { label: "My note",        hint: "Your own note" },
  tutor:      { label: "iReliabee's explanation", hint: "A simpler explanation, not from the source" },
  image:      { label: "Photo",          hint: "A picture you added" },
};

/** Types offered in the section editor, per kind. The board holds the rest for meetings. */
export const SECTION_TYPES: Record<NotebookKind, BlockType[]> = {
  lecture: ["point", "key", "definition", "example", "exam", "question", "quote", "formula", "table", "unclear", "note", "tutor"],
  reading: ["point", "key", "definition", "example", "exam", "question", "quote", "formula", "table", "unclear", "note", "tutor"],
  meeting: ["point", "key", "quote", "table", "unclear", "note"],
};

export const BOARD: { key: BoardKey; type: BlockType; label: string }[] = [
  { key: "decisions", type: "decision", label: "Decisions" },
  { key: "actions",   type: "action",   label: "Action items" },
  { key: "questions", type: "question", label: "Open questions" },
  { key: "risks",     type: "risk",     label: "Risks" },
  { key: "numbers",   type: "number",   label: "Numbers and dates" },
];

// ── Pure editing helpers ─────────────────────────────────────────────────────

export function newId(): string {
  return Math.random().toString(36).slice(2, 12);
}

export function newBlock(type: BlockType, text = ""): Block {
  const b: Block = { id: newId(), type, text, src: [] };
  if (type === "definition" || type === "number") b.term = "";
  if (type === "action") { b.owner = ""; b.due = ""; b.done = false; }
  if (type === "table") { b.rows = [["", ""], ["", ""]]; b.caption = ""; }
  return b;
}

export function newSection(title = "New section"): Section {
  return { id: newId(), title, src: [], blocks: [] };
}

export function emptyDoc(): NotebookDoc {
  return { title: "", author: "", summary: "", cues: [], sections: [], board: { decisions: [], actions: [], questions: [], risks: [], numbers: [] } };
}

/** Where a block lives: a section's blocks, or a board column. */
export type Place = { section: string } | { board: BoardKey };

function listAt(doc: NotebookDoc, at: Place): Block[] {
  if ("board" in at) return doc.board[at.board];
  return doc.sections.find(s => s.id === at.section)?.blocks ?? [];
}

function withList(doc: NotebookDoc, at: Place, blocks: Block[]): NotebookDoc {
  if ("board" in at) return { ...doc, board: { ...doc.board, [at.board]: blocks } };
  return { ...doc, sections: doc.sections.map(s => (s.id === at.section ? { ...s, blocks } : s)) };
}

export function addBlock(doc: NotebookDoc, at: Place, block: Block, afterId?: string): NotebookDoc {
  const list = listAt(doc, at);
  const i = afterId ? list.findIndex(b => b.id === afterId) : -1;
  const next = i >= 0 ? [...list.slice(0, i + 1), block, ...list.slice(i + 1)] : [...list, block];
  return withList(doc, at, next);
}

export function updateBlock(doc: NotebookDoc, at: Place, id: string, patch: Partial<Block>): NotebookDoc {
  return withList(doc, at, listAt(doc, at).map(b => {
    if (b.id !== id) return b;
    const merged = { ...b, ...patch, id: b.id };
    // Changing the type keeps the text and adds the new type's own fields.
    if (patch.type && patch.type !== b.type) return { ...newBlock(patch.type, merged.text), ...merged, id: b.id };
    return merged;
  }));
}

export function deleteBlock(doc: NotebookDoc, at: Place, id: string): NotebookDoc {
  return withList(doc, at, listAt(doc, at).filter(b => b.id !== id));
}

export function moveBlock(doc: NotebookDoc, at: Place, id: string, by: -1 | 1): NotebookDoc {
  const list = [...listAt(doc, at)];
  const i = list.findIndex(b => b.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return doc;
  [list[i], list[j]] = [list[j], list[i]];
  return withList(doc, at, list);
}

export function addSection(doc: NotebookDoc, section: Section, afterId?: string): NotebookDoc {
  const i = afterId ? doc.sections.findIndex(s => s.id === afterId) : -1;
  const sections = i >= 0 ? [...doc.sections.slice(0, i + 1), section, ...doc.sections.slice(i + 1)] : [...doc.sections, section];
  return { ...doc, sections };
}

export function updateSection(doc: NotebookDoc, id: string, patch: Partial<Omit<Section, "id" | "blocks">>): NotebookDoc {
  return { ...doc, sections: doc.sections.map(s => (s.id === id ? { ...s, ...patch } : s)) };
}

export function deleteSection(doc: NotebookDoc, id: string): NotebookDoc {
  return { ...doc, sections: doc.sections.filter(s => s.id !== id) };
}

export function moveSection(doc: NotebookDoc, id: string, by: -1 | 1): NotebookDoc {
  const list = [...doc.sections];
  const i = list.findIndex(s => s.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= list.length) return doc;
  [list[i], list[j]] = [list[j], list[i]];
  return { ...doc, sections: list };
}

/** "m:ss" or "h:mm:ss" from seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** The label a block's source chip shows: a time for a session, a page for a document. */
export function sourceLabel(nb: Pick<Notebook, "kind" | "line_times">, src: number[]): string | null {
  if (!src.length) return null;
  if (nb.kind === "reading") {
    const lo = Math.min(...src), hi = Math.max(...src);
    return lo === hi ? `p. ${lo}` : `p. ${lo}–${hi}`;
  }
  const t = nb.line_times?.[String(src[0])];
  return t === undefined ? null : clock(t);
}

const STYLE_KEY = (kind: NotebookKind) => `nb.style.${kind}`;

/** The look the user last chose for this kind of notebook (per device), or the default. */
export function rememberedStyle(kind: NotebookKind): NotebookStyle {
  try {
    const saved = JSON.parse(localStorage.getItem(STYLE_KEY(kind)) || "null");
    if (saved && saved.family && saved.size && saved.style) return saved;
  } catch { /* private mode or bad JSON: use the default */ }
  return DEFAULT_STYLE[kind];
}

export function rememberStyle(kind: NotebookKind, style: NotebookStyle) {
  try { localStorage.setItem(STYLE_KEY(kind), JSON.stringify(style)); } catch { /* not essential */ }
}

/** Where an automatic notebook stands. "ask": over two hours, so it waits for a yes, with the price. */
export type AutoState =
  | { state: "none" | "writing" }
  | { state: "done"; notebook_id: number }
  | { state: "skipped"; reason: "off" | "exists" | "pro" | "short" }
  | { state: "failed"; error: { title: string; message: string } }
  | { state: "ask"; estimate: { seconds: number; words: number; credits: number | null; usd: number | null; model: string } };

// ── API ──────────────────────────────────────────────────────────────────────

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export const notebookApi = {
  list: (kind?: NotebookKind | "", q?: string) => {
    const p = new URLSearchParams();
    if (kind) p.set("kind", kind);
    if (q?.trim()) p.set("q", q.trim());
    const qs = p.toString();
    return fetchApi(`/notebooks/${qs ? `?${qs}` : ""}`).then(r => json<NotebookSummary[]>(r));
  },
  get: (id: number) => fetchApi(`/notebooks/${id}`).then(r => json<Notebook>(r)),
  forSession: (sessionId: number) => fetchApi(`/notebooks/session/${sessionId}`).then(r => json<Notebook | null>(r)),
  /** A lecture or meeting ended: the backend writes its notebook if it should (decision 184-1). */
  auto: (sessionId: number, style?: NotebookStyle) =>
    fetchApi(`/notebooks/auto/${sessionId}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ style }) })
      .then(r => json<AutoState>(r)),
  autoStatus: (sessionId: number) => fetchApi(`/notebooks/auto/${sessionId}`).then(r => json<AutoState>(r)),
  create: (kind: NotebookKind, title: string, style: NotebookStyle) =>
    fetchApi("/notebooks/", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ kind, title, style }) })
      .then(r => json<Notebook>(r)),
  generate: (body: { session_id: number; style: NotebookStyle; model?: string; document_ids?: number[]; tutor?: boolean; fallback_credits?: boolean }) => {
    const headers = { ...JSON_HEADERS, ...(body.fallback_credits ? { "X-IRB-Use-Credits": "1" } : {}) };
    return fetchApi("/notebooks/generate", { method: "POST", headers, body: JSON.stringify(body) })
      .then(r => json<Notebook>(r));
  },
  save: (id: number, version: number, patch: { title?: string; style?: NotebookStyle; doc?: NotebookDoc }) =>
    fetchApi(`/notebooks/${id}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ version, ...patch }) })
      .then(r => json<Notebook>(r)),
  remove: (id: number) => fetchApi(`/notebooks/${id}`, { method: "DELETE" }).then(r => json<{ ok: boolean }>(r)),
  versions: (id: number) => fetchApi(`/notebooks/${id}/versions`).then(r => json<{ version: number; title: string; saved_at: string }[]>(r)),
  restore: (id: number, version: number, currentVersion: number) =>
    fetchApi(`/notebooks/${id}/restore`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ version, current_version: currentVersion }) })
      .then(r => json<Notebook>(r)),
  source: (id: number, lines: number[]) =>
    fetchApi(`/notebooks/${id}/source?lines=${lines.join(",")}`)
      .then(r => json<{ n: number; who: string; text: string; t: number; cited: boolean }[]>(r)),
  markdown: (id: number) => fetchApi(`/notebooks/${id}/export.md`).then(async r => {
    if (!r.ok) throw await errorFromResponse(r);
    return r.text();
  }),
};
