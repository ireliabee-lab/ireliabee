/**
 * The editable manuscript is plain text:
 *   # Chapter title      → starts a new chapter (numbered automatically)
 *   blank line           → separates paragraphs
 * Every block remembers where it came from in the source, so the caret in the
 * editor can be mapped to a line on a page and a tap on a page back to text.
 */

import type { Block } from './typeset';

export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

export interface Manuscript {
  readonly blocks: readonly Block[];
  readonly ranges: readonly SourceRange[];
}

/** Turns a chapter's ordinal and raw heading text into its printed label. */
export type ChapterLabel = (ordinal: number, heading: string) => { numeral: string; title: string };

const romanLabel: ChapterLabel = (ordinal, heading) => ({ numeral: toRoman(ordinal), title: heading });

export interface WordPosition {
  readonly block: number;
  /** Word index within the block (the chapter title's words for a chapter). */
  readonly word: number;
}

export function toRoman(n: number): string {
  if (n <= 0) return String(n);
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let rest = Math.floor(n);
  for (const [value, glyph] of table) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

export function parseManuscript(source: string, label: ChapterLabel = romanLabel): Manuscript {
  const blocks: Block[] = [];
  const ranges: SourceRange[] = [];
  let chapter = 0;
  let paraStart = -1;
  let paraEnd = -1;

  const flush = (): void => {
    if (paraStart < 0) return;
    blocks.push({ kind: 'para', text: source.slice(paraStart, paraEnd).replace(/\s+/g, ' ').trim() });
    ranges.push({ start: paraStart, end: paraEnd });
    paraStart = -1;
  };

  let offset = 0;
  for (const line of source.split('\n')) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (trimmed.startsWith('#')) {
      flush();
      chapter++;
      blocks.push({ kind: 'chapter', ...label(chapter, trimmed.replace(/^#+\s*/, '')) });
      ranges.push({ start, end });
      continue;
    }
    if (paraStart < 0) paraStart = start;
    paraEnd = end;
  }
  flush();
  return { blocks, ranges };
}

export function toManuscript(blocks: readonly Block[]): string {
  return blocks.map((b) => (b.kind === 'chapter' ? `# ${b.title}` : b.text)).join('\n\n');
}

const WORD = /\S+/g;

/** Offsets of each word in a block's source text (chapter lines skip the leading #). */
function wordOffsets(source: string, range: SourceRange, isChapter: boolean): number[] {
  const text = source.slice(range.start, range.end);
  const skip = isChapter ? (/^\s*#+\s*/.exec(text)?.[0].length ?? 0) : 0;
  const out: number[] = [];
  for (const m of text.slice(skip).matchAll(WORD)) out.push(range.start + skip + (m.index ?? 0));
  return out;
}

/** Which block and word the caret sits in (a caret in a gap belongs to the next block). */
export function caretPosition(source: string, manuscript: Manuscript, caret: number): WordPosition | null {
  const { ranges, blocks } = manuscript;
  if (!ranges.length) return null;
  let block = ranges.findIndex((r) => caret <= r.end);
  if (block < 0) block = ranges.length - 1;
  const range = ranges[block] as SourceRange;
  const offsets = wordOffsets(source, range, blocks[block]?.kind === 'chapter');
  let word = 0;
  for (let i = 0; i < offsets.length; i++) if ((offsets[i] as number) <= caret) word = i;
  return { block, word };
}

/** Source offset of a word, for placing the caret from a tap on the page. */
export function sourceOffset(source: string, manuscript: Manuscript, position: WordPosition): number | null {
  const range = manuscript.ranges[position.block];
  if (!range) return null;
  const offsets = wordOffsets(source, range, manuscript.blocks[position.block]?.kind === 'chapter');
  if (!offsets.length) return range.start;
  return offsets[Math.max(0, Math.min(position.word, offsets.length - 1))] as number;
}
