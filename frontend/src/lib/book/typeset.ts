/**
 * Book typesetting: greedy line breaking, drop caps and pagination.
 *
 * Built for live editing: paragraphs are wrapped independently and cached by
 * their text, so a keystroke re-wraps only the paragraph being typed in.
 * Pagination afterwards is a cheap walk over the cached lines.
 */

import type { InlineStyle, ParaStyle, StyledRange } from './rich';

export type Block =
  | { readonly kind: 'chapter'; readonly numeral: string; readonly title: string }
  | {
      readonly kind: 'para';
      readonly text: string;
      /** Formatting as character ranges within `text`. */
      readonly runs?: readonly StyledRange[];
      readonly style?: ParaStyle;
      /** Position in a numbered list. */
      readonly ordinal?: number;
      /** For table rows: column count and row number (0 is the header). */
      readonly table?: { readonly cols: number; readonly row: number; readonly last: boolean };
      /** For image lines: picture id and natural size. */
      readonly image?: { readonly id: string; readonly w: number; readonly h: number };
    };

/** A uniformly styled piece of a word. */
export interface Segment {
  readonly text: string;
  readonly style: InlineStyle;
}

export interface TextLine {
  readonly words: readonly string[];
  /** Left offset in logical px (paragraph indent or drop-cap clearance). */
  readonly indent: number;
  /** Stretch word gaps to the full measure (false for a paragraph's last line). */
  readonly justify: boolean;
  /** Present on the first line of a chapter's opening paragraph. */
  readonly dropCap?: string;
  /** Index of the source block this line came from. */
  readonly block: number;
  /** Index, within the block's words, of this line's first word. */
  readonly firstWord: number;
  /** Per word: its styled pieces, or null for plain words. Absent when the line is unformatted. */
  readonly spans?: readonly (readonly Segment[] | null)[];
  readonly align?: 'center';
  /** First line of a bulleted paragraph. */
  readonly bullet?: boolean;
  /** The bullet is a star: a key point. */
  readonly star?: boolean;
  readonly quote?: boolean;
  /** Width this line is set to (narrower than the text block for quotes). */
  readonly measure?: number;
  /** List marker drawn before the first line: numbered or checklist. */
  readonly marker?: 'number' | 'check' | 'checked';
  readonly number?: number;
  readonly heading?: boolean;
  readonly divider?: boolean;
  /** First line of an image, which occupies `lines` lines. */
  readonly image?: { readonly id: string; readonly lines: number; readonly w: number; readonly h: number };
  /** Table row: cell boxes relative to the text block, and which cell each word is in. */
  readonly cells?: readonly { readonly x: number; readonly w: number }[];
  readonly cellOfWord?: readonly number[];
  readonly table?: { readonly row: number; readonly cols: number; readonly last: boolean };
}

export interface PageContent {
  readonly chapter?: { readonly numeral: string; readonly title: string; readonly block: number };
  readonly lines: readonly TextLine[];
  /** True when this page ends the story (an end ornament is drawn). */
  readonly isLast?: boolean;
}

/** Width of a single word (no spaces) in logical px. */
export type Measure = (word: string) => number;

export interface TypesetOptions {
  readonly measure: Measure;
  /** Width of one inter-word space. */
  readonly spaceWidth: number;
  /** Width of the text block. */
  readonly width: number;
  readonly linesPerPage: number;
  /** Lines consumed by a chapter opening. */
  readonly chapterLines: number;
  readonly paragraphIndent: number;
  /** Horizontal clearance the given drop-cap glyph needs (glyph width + gap). */
  readonly dropCapWidth: (cap: string) => number;
  readonly dropCapLines?: number;
  /** Width of a styled piece of text (bold and italic change widths). Defaults to `measure`. */
  readonly measureRun?: (text: string, style: InlineStyle) => number;
  /** Large first letters for chapter openings (default true). */
  readonly dropCaps?: boolean;
  /** Line height in the same units as `width`, used to size images. */
  readonly lineHeight?: number;
}

export const BULLET_INDENT = 24;
export const QUOTE_INDENT = 28;
export const LIST_INDENT = 28;
export const CELL_PAD = 7;

/** Lines an image takes up at full text width, capped to fit a page. */
export function imageLines(w: number, h: number, width: number, lineHeight: number, maxLines: number): number {
  if (w <= 0 || h <= 0) return 1;
  return Math.max(2, Math.min(maxLines, Math.ceil((width * (h / w)) / lineHeight) + 1));
}

type WrappedLine = Omit<TextLine, 'block'>;

export interface TypesetStats {
  /** Paragraphs wrapped from scratch on the last run. */
  readonly wrapped: number;
  /** Paragraphs served from the cache on the last run. */
  readonly reused: number;
}

export interface Typesetter {
  typeset(blocks: readonly Block[]): PageContent[];
  readonly stats: TypesetStats;
}

/**
 * Greedy line breaker over pre-measured words. `widthFor(i)` gives the
 * available width of line i, which lets drop caps and indents narrow lines.
 */
export function wrapWords(
  words: readonly string[],
  widthFor: (lineIndex: number) => number,
  measure: Measure,
  spaceWidth: number,
): string[][] {
  const lines: string[][] = [];
  let current: string[] = [];
  let lineWidth = 0;
  for (const word of words) {
    const w = measure(word);
    const candidate = current.length ? lineWidth + spaceWidth + w : w;
    if (current.length && candidate > widthFor(lines.length)) {
      lines.push(current);
      current = [word];
      lineWidth = w;
    } else {
      current.push(word);
      lineWidth = candidate;
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

export function splitWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** Splits an opening word into its drop cap (keeping leading punctuation) and the rest. */
export function splitDropCap(word: string): { cap: string; rest: string } | null {
  const match = /^([^A-Za-z0-9]*)([A-Za-z0-9])(.*)$/.exec(word);
  if (!match) return null;
  return { cap: `${match[1] ?? ''}${match[2] ?? ''}`, rest: match[3] ?? '' };
}

/** Drop-cap clearance still owed to following paragraphs when an opening paragraph is shorter than the cap. */
interface CapCarry {
  readonly lines: number;
  readonly width: number;
}

const NO_CARRY: CapCarry = { lines: 0, width: 0 };

/** Cuts one word into styled pieces using the paragraph's runs. */
function segmentsFor(word: string, start: number, runs: readonly StyledRange[]): Segment[] | null {
  const end = start + word.length;
  const out: Segment[] = [];
  let styled = false;
  let cursor = start;
  for (const r of runs) {
    if (r.end <= cursor || r.start >= end) continue;
    if (r.start > cursor) out.push({ text: word.slice(cursor - start, r.start - start), style: {} });
    const a = Math.max(cursor, r.start);
    const b = Math.min(end, r.end);
    out.push({ text: word.slice(a - start, b - start), style: r.style });
    if (Object.keys(r.style).length) styled = true;
    cursor = b;
  }
  if (cursor < end) out.push({ text: word.slice(cursor - start), style: {} });
  return styled ? out : null;
}

/** Adds a style to every character of a paragraph (headings, table headers). */
function withBase(text: string, runs: readonly StyledRange[], base: InlineStyle): StyledRange[] {
  const out: StyledRange[] = [];
  let cursor = 0;
  for (const r of [...runs].sort((a, b) => a.start - b.start)) {
    if (r.start > cursor) out.push({ start: cursor, end: r.start, style: base });
    out.push({ ...r, style: { ...r.style, ...base } });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < text.length) out.push({ start: cursor, end: text.length, style: base });
  return out;
}

function tableRow(
  text: string,
  runs: readonly StyledRange[],
  table: NonNullable<Extract<Block, { kind: 'para' }>['table']>,
  options: TypesetOptions,
): WrappedLine {
  const cw = options.width / Math.max(1, table.cols);
  const cells = Array.from({ length: table.cols }, (_, c) => ({ x: c * cw, w: cw }));
  const allRuns = table.row === 0 ? withBase(text, runs, { bold: true }) : runs;
  const words: string[] = [];
  const spans: (Segment[] | null)[] = [];
  const cellOfWord: number[] = [];
  let cell = 0;
  for (let i = 0, start = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\t') {
      for (const m of text.slice(start, i).matchAll(/[^\s]+/g)) {
        const at = start + (m.index ?? 0);
        words.push(m[0]);
        spans.push(allRuns.length ? segmentsFor(m[0], at, allRuns) : null);
        cellOfWord.push(Math.min(cell, table.cols - 1));
      }
      cell++;
      start = i + 1;
    }
  }
  return {
    words,
    indent: 0,
    justify: false,
    firstWord: 0,
    cells,
    cellOfWord,
    table: { row: table.row, cols: table.cols, last: table.last },
    ...(spans.some((x) => x !== null) ? { spans } : {}),
  };
}

function wrapParagraph(
  text: string,
  opening: boolean,
  options: TypesetOptions,
  carry: CapCarry = NO_CARRY,
  runs: readonly StyledRange[] = [],
  paraStyle: ParaStyle = 'normal',
  block?: Extract<Block, { kind: 'para' }>,
): WrappedLine[] {
  const { measure, spaceWidth, width, paragraphIndent, dropCapWidth } = options;
  if (paraStyle === 'divider') return [{ words: [], indent: 0, justify: false, firstWord: 0, divider: true }];
  if (block?.image) {
    const lh = options.lineHeight ?? 29;
    const lines = imageLines(block.image.w, block.image.h, width, lh, options.linesPerPage - 1);
    return Array.from({ length: lines }, (_, i) => ({
      words: [],
      indent: 0,
      justify: false,
      firstWord: 0,
      ...(i === 0 ? { image: { id: block.image!.id, lines, w: block.image!.w, h: block.image!.h } } : {}),
    }));
  }
  if (block?.table) return [tableRow(text, runs, block.table, options)];
  if (paraStyle === 'heading') runs = withBase(text, runs, { bold: true, large: true });
  const measureRun = options.measureRun ?? ((t: string) => measure(t));
  const dropCapLines = options.dropCapLines ?? 3;
  const found = [...text.matchAll(/\S+/g)].map((m) => ({ word: m[0], start: m.index ?? 0 }));
  if (!found.length) {
    // An empty paragraph (a blank line in a diary) is kept as vertical space.
    if (text.length > 0) return [];
    const listed = paraStyle === 'numbered' || paraStyle === 'check' || paraStyle === 'checked';
    const indent = paraStyle === 'bullet' || paraStyle === 'key' ? BULLET_INDENT : paraStyle === 'quote' ? QUOTE_INDENT : listed ? LIST_INDENT : 0;
    const marker = listed
      ? paraStyle === 'numbered'
        ? { marker: 'number' as const, number: block?.ordinal ?? 1 }
        : { marker: paraStyle as 'check' | 'checked' }
      : {};
    return [
      {
        words: [],
        indent: Math.max(indent, carry.lines > 0 ? carry.width : 0),
        justify: false,
        firstWord: 0,
        ...(paraStyle === 'bullet' ? { bullet: true } : paraStyle === 'key' ? { bullet: true, star: true } : {}),
        ...(paraStyle === 'center' ? { align: 'center' as const } : {}),
        ...marker,
      },
    ];
  }

  let dropCap: string | undefined;
  let consumedWord = false;
  if (opening && paraStyle === 'normal' && options.dropCaps !== false) {
    const first = found[0] as { word: string; start: number };
    const split = splitDropCap(first.word);
    if (split) {
      dropCap = split.cap;
      if (split.rest) found[0] = { word: split.rest, start: first.start + split.cap.length };
      else {
        found.shift();
        consumedWord = true;
      }
    }
  }

  const words = found.map((f) => f.word);
  const spans = runs.length ? found.map((f) => segmentsFor(f.word, f.start, runs)) : [];
  const hasSpans = spans.some((x) => x !== null);
  const widthOf = (i: number): number => {
    const seg = spans[i];
    return seg ? seg.reduce((sum, p) => sum + measureRun(p.text, p.style), 0) : measure(words[i] as string);
  };
  const widths = words.map((_, i) => widthOf(i));

  const capClearance = dropCap ? dropCapWidth(dropCap) : 0;
  const listed = paraStyle === 'numbered' || paraStyle === 'check' || paraStyle === 'checked';
  const styleIndent = paraStyle === 'bullet' || paraStyle === 'key' ? BULLET_INDENT : paraStyle === 'quote' ? QUOTE_INDENT : listed ? LIST_INDENT : 0;
  const rightIndent = paraStyle === 'quote' ? QUOTE_INDENT : 0;
  const indentFor = (i: number): number => {
    if (dropCap) return i < dropCapLines ? capClearance : 0;
    if (i < carry.lines) return carry.width + styleIndent; // beside the drop cap, then any list or quote indent
    if (styleIndent) return styleIndent;
    return i === 0 && !opening && paraStyle === 'normal' ? paragraphIndent : 0;
  };

  // Wrap by index so identical words with different styles keep their own widths.
  const lines: number[][] = [];
  let current: number[] = [];
  let lineWidth = 0;
  words.forEach((_, i) => {
    const w = widths[i] as number;
    const candidate = current.length ? lineWidth + spaceWidth + w : w;
    if (current.length && candidate > width - rightIndent - indentFor(lines.length)) {
      lines.push(current);
      current = [i];
      lineWidth = w;
    } else {
      current.push(i);
      lineWidth = candidate;
    }
  });
  if (current.length) lines.push(current);

  const center = paraStyle === 'center';
  let wordCursor = consumedWord ? 1 : 0;
  return lines.map((idx, i) => {
    const line: WrappedLine = {
      words: idx.map((k) => words[k] as string),
      indent: indentFor(i),
      justify: !center && i < lines.length - 1,
      firstWord: wordCursor,
      ...(dropCap && i === 0 ? { dropCap } : {}),
      ...(hasSpans ? { spans: idx.map((k) => spans[k] ?? null) } : {}),
      ...(center ? { align: 'center' as const } : {}),
      ...(paraStyle === 'bullet' && i === 0 ? { bullet: true } : paraStyle === 'key' && i === 0 ? { bullet: true, star: true } : {}),
      ...(paraStyle === 'quote' ? { quote: true, measure: width - rightIndent } : {}),
      ...(paraStyle === 'heading' ? { heading: true } : {}),
      ...(listed && i === 0
        ? paraStyle === 'numbered'
          ? { marker: 'number' as const, number: block?.ordinal ?? 1 }
          : { marker: paraStyle as 'check' | 'checked' }
        : {}),
    };
    wordCursor += idx.length;
    return line;
  });
}

/** A typesetter that remembers every paragraph it has wrapped. */
export function createTypesetter(options: TypesetOptions, cacheLimit = 4000): Typesetter {
  const cache = new Map<string, WrappedLine[]>();
  let stats: TypesetStats = { wrapped: 0, reused: 0 };

  const linesFor = (
    block: Extract<Block, { kind: 'para' }>,
    opening: boolean,
    counters: { wrapped: number; reused: number },
    carry: CapCarry,
  ): WrappedLine[] => {
    const { text } = block;
    const runs = block.runs ?? [];
    const style = block.style ?? 'normal';
    const extra = block.ordinal ?? block.table ?? block.image;
    const format =
      runs.length || style !== 'normal' || extra
        ? `\u0002${style}\u0002${JSON.stringify(runs)}\u0002${extra ? JSON.stringify(extra) : ''}`
        : '';
    const key = `${opening ? 1 : 0}\u0001${carry.lines}:${carry.width}\u0001${text}${format}`;
    const hit = cache.get(key);
    if (hit) {
      counters.reused++;
      return hit;
    }
    counters.wrapped++;
    const lines = wrapParagraph(text, opening, options, carry, runs, style, block);
    if (cache.size >= cacheLimit) cache.clear();
    cache.set(key, lines);
    return lines;
  };

  return {
    get stats() {
      return stats;
    },
    typeset(blocks: readonly Block[]): PageContent[] {
      const { linesPerPage, chapterLines } = options;
      const counters = { wrapped: 0, reused: 0 };
      const pages: { chapter?: PageContent['chapter']; lines: TextLine[] }[] = [];
      let page: { chapter?: PageContent['chapter']; lines: TextLine[] } | null = null;
      let capacity = 0;
      let opening = false;
      let carry: CapCarry = NO_CARRY;
      const capLines = options.dropCapLines ?? 3;

      const newPage = (chapter?: PageContent['chapter']): { lines: TextLine[] } => {
        const p: { chapter?: PageContent['chapter']; lines: TextLine[] } = chapter ? { chapter, lines: [] } : { lines: [] };
        pages.push(p);
        page = p;
        capacity = linesPerPage - (chapter ? chapterLines : 0);
        return p;
      };

      blocks.forEach((block, blockIndex) => {
        if (block.kind === 'chapter') {
          newPage({ numeral: block.numeral, title: block.title, block: blockIndex });
          opening = true;
          carry = NO_CARRY;
          return;
        }
        const lines = linesFor(block, opening, counters, opening ? NO_CARRY : carry);
        if (!lines.length) return;
        const first = lines[0] as WrappedLine;
        carry = first.dropCap
          ? { lines: Math.max(0, capLines - lines.length), width: first.indent }
          : carry.lines > 0
            ? { lines: Math.max(0, carry.lines - lines.length), width: carry.width }
            : NO_CARRY;
        let target = page ?? newPage();
        // An image never splits across pages.
        if (lines.length > 1 && lines[0]?.image && capacity < lines.length) target = newPage();
        for (const line of lines) {
          if (capacity <= 0) target = newPage();
          target.lines.push({ ...line, block: blockIndex });
          capacity--;
        }
        opening = false;
      });

      stats = counters;
      return pages.map((p, i) => (i === pages.length - 1 ? { ...p, isLast: true } : p));
    },
  };
}

/** One-shot typesetting without a persistent cache. */
export function typeset(blocks: readonly Block[], options: TypesetOptions): PageContent[] {
  return createTypesetter(options).typeset(blocks);
}
