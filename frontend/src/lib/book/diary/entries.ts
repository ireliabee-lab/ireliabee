/**
 * Diary entries and their mapping onto the shared typesetting pipeline.
 *
 * Each entry becomes a "chapter" whose heading is its timestamp. In the diary
 * a single line break starts a new paragraph (as it does when you write by
 * hand), so line breaks are doubled for the manuscript; offsets are mapped
 * both ways so the cursor and taps on the page line up exactly.
 */

import type { ChapterLabel, Manuscript, SourceRange } from '../manuscript';
import { imageIdOf, lineRanges, styledRanges, withParas, type Mark, type ParaStyle, type StyledRange } from '../rich';
import type { Block } from '../typeset';

export interface Entry {
  readonly id: string;
  /** ISO timestamp of when the entry was started. */
  readonly createdAt: string;
  readonly text: string;
  /** Formatting ranges over `text` (absent in older entries). */
  readonly marks?: readonly Mark[];
  /** One paragraph style per line of `text`. */
  readonly paras?: readonly ParaStyle[];
  /** Pictures in this entry, by id (downscaled JPEG data URLs). */
  readonly media?: Readonly<Record<string, Picture>>;
}

export interface Picture {
  readonly src: string;
  readonly w: number;
  readonly h: number;
}

export interface DiaryData {
  readonly version: 1;
  readonly owner: string;
  readonly entries: readonly Entry[];
  readonly settings: DiarySettings;
}

export interface DiarySettings {
  /** Lock as soon as the page is hidden (tab switch, app switch, screen off). */
  readonly lockWhenHidden: boolean;
}

export const DEFAULT_SETTINGS: DiarySettings = { lockWhenHidden: true };

export function emptyDiary(owner = ''): DiaryData {
  return { version: 1, owner, entries: [], settings: DEFAULT_SETTINGS };
}

export function newEntry(now: Date, id = randomId()): Entry {
  return { id, createdAt: now.toISOString(), text: '' };
}

function randomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** An ordinary-looking diary to show behind a decoy passcode. */
export function decoyDiary(owner: string, now: Date): DiaryData {
  const day = (offset: number, hour: number): string => {
    const d = new Date(now);
    d.setDate(d.getDate() - offset);
    d.setHours(hour, 12, 0, 0);
    return d.toISOString();
  };
  const entries: Entry[] = [
    { id: 'd1', createdAt: day(6, 19), text: 'Market run after work. Tomatoes were cheaper than last week.\nNeed to remember the gas refill on Saturday.' },
    { id: 'd2', createdAt: day(3, 21), text: 'Long day. Watched two episodes and slept early.' },
    { id: 'd3', createdAt: day(1, 18), text: 'Church choir practice moved to Thursday.\nTry the new jollof recipe this weekend.' },
  ];
  return { version: 1, owner, entries, settings: DEFAULT_SETTINGS };
}

// ── Manuscript mapping ───────────────────────────────────────────────────────

/** Characters in entry text that would change the manuscript's structure. */
function escapeLine(text: string): string {
  // A line starting with # would become a heading; a same-length lookalike keeps offsets intact.
  return text.replace(/^(\s*)#/gm, '$1\uFF03');
}

export interface EntryManuscript {
  readonly source: string;
  /** Blocks with formatting, ready for the typesetter. */
  readonly manuscript: Manuscript;
  /** For each block, the entry and line it came from (null for headings). */
  readonly blockLines: readonly ({ readonly entry: number; readonly line: number } | null)[];
  /** Source offset where each entry's body begins. */
  readonly bodyStarts: readonly number[];
  /** Source offset where each entry's heading begins. */
  readonly headingStarts: readonly number[];
}

/** Collapses whitespace like the plain parser does, remembering where each character went. */
function collapse(line: string): { text: string; map: number[] } {
  const map: number[] = [];
  let text = '';
  let pendingSpace = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (/\s/.test(ch)) {
      if (text.length) pendingSpace = true;
      map.push(-1);
      continue;
    }
    if (pendingSpace) {
      text += ' ';
      pendingSpace = false;
    }
    map.push(text.length);
    text += ch;
  }
  return { text, map };
}

function runsForLine(marks: readonly Mark[], start: number, end: number, map: number[]): StyledRange[] {
  const out: StyledRange[] = [];
  for (const r of styledRanges(marks, start, end)) {
    if (!Object.keys(r.style).length) continue;
    let a = -1;
    let b = -1;
    for (let i = r.start; i < r.end; i++) {
      const m = map[i - start] ?? -1;
      if (m < 0) continue;
      if (a < 0) a = m;
      b = m + 1;
    }
    if (a >= 0) out.push({ start: a, end: b, style: r.style });
  }
  return out;
}

export function buildManuscript(entries: readonly Entry[], label?: ChapterLabel): EntryManuscript {
  let source = '';
  const bodyStarts: number[] = [];
  const headingStarts: number[] = [];
  const blocks: Block[] = [];
  const ranges: SourceRange[] = [];
  const blockLines: ({ entry: number; line: number } | null)[] = [];

  entries.forEach((entry, i) => {
    if (i > 0) source += '\n\n';
    headingStarts.push(source.length);
    const heading = `# ${entry.createdAt}`;
    blocks.push({ kind: 'chapter', ...(label ? label(i + 1, entry.createdAt) : { numeral: String(i + 1), title: entry.createdAt }) });
    ranges.push({ start: source.length, end: source.length + heading.length });
    blockLines.push(null);
    source += `${heading}\n\n`;
    bodyStarts.push(source.length);

    const doc = withParas(entry);
    const escaped = escapeLine(entry.text);
    const lines = lineRanges(entry.text);
    // Tables: consecutive table lines share a column count.
    const tableInfo: ({ cols: number; row: number; last: boolean } | null)[] = lines.map(() => null);
    for (let li = 0; li < lines.length; ) {
      if (doc.paras[li] !== 'table') {
        li++;
        continue;
      }
      let end = li;
      while (end < lines.length && doc.paras[end] === 'table') end++;
      const cols = Math.max(
        1,
        ...lines.slice(li, end).map((r) => entry.text.slice(r.start, r.end).split('\t').length),
      );
      for (let k = li; k < end; k++) tableInfo[k] = { cols, row: k - li, last: k === end - 1 };
      li = end;
    }
    let ordinal = 0;
    lines.forEach((r, li) => {
      const style = doc.paras[li] ?? 'normal';
      ordinal = style === 'numbered' ? ordinal + 1 : 0;
      const raw = escaped.slice(r.start, r.end);
      const table = tableInfo[li];
      const pictureId = imageIdOf(style);
      const picture = pictureId ? entry.media?.[pictureId] : undefined;
      // Table rows keep their tabs so cells line up with the source text.
      const { text, map } = table ? { text: raw, map: [...raw].map((_, k) => k) } : collapse(raw);
      const runs = pictureId ? [] : runsForLine(doc.marks, r.start, r.end, map);
      // Each line sits at bodyStart + its offset + one extra char per preceding line break.
      const at = source.length + r.start + li;
      blocks.push({
        kind: 'para',
        text: pictureId ? '' : text,
        ...(runs.length ? { runs } : {}),
        ...(style !== 'normal' ? { style } : {}),
        ...(style === 'numbered' ? { ordinal } : {}),
        ...(table ? { table } : {}),
        ...(picture && pictureId ? { image: { id: pictureId, w: picture.w, h: picture.h } } : {}),
      });
      ranges.push({ start: at, end: at + (r.end - r.start) });
      blockLines.push({ entry: i, line: li });
    });
    source += escaped.replace(/\n/g, '\n\n');
  });
  return { source, bodyStarts, headingStarts, manuscript: { blocks, ranges }, blockLines };
}

/** Manuscript offset of a caret inside an entry's own text. */
export function toSourceOffset(m: EntryManuscript, entries: readonly Entry[], index: number, caret: number): number {
  const entry = entries[index];
  const start = m.bodyStarts[index];
  if (!entry || start === undefined) return 0;
  const before = entry.text.slice(0, Math.max(0, Math.min(caret, entry.text.length)));
  return start + before.length + (before.match(/\n/g)?.length ?? 0);
}

/** Which entry, and where in its text, a manuscript offset falls. */
export function fromSourceOffset(
  m: EntryManuscript,
  entries: readonly Entry[],
  offset: number,
): { index: number; caret: number } | null {
  if (!entries.length) return null;
  let index = 0;
  for (let i = 0; i < m.headingStarts.length; i++) if ((m.headingStarts[i] ?? 0) <= offset) index = i;
  const entry = entries[index] as Entry;
  const start = m.bodyStarts[index] ?? 0;
  if (offset <= start) return { index, caret: 0 };
  let sourcePos = start;
  for (let caret = 0; caret < entry.text.length; caret++) {
    if (sourcePos >= offset) return { index, caret };
    sourcePos += entry.text[caret] === '\n' ? 2 : 1;
  }
  return { index, caret: entry.text.length };
}

// ── Labels ───────────────────────────────────────────────────────────────────

export function formatEntryDate(iso: string, timeZone?: string): { day: string; time: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { day: iso, time: '' };
  const tz = timeZone ? { timeZone } : {};
  return {
    day: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', ...tz }).format(date),
    time: new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, ...tz })
      .format(date)
      .replace(/\s/g, ' ')
      .toLowerCase(),
  };
}

/** Headings print the time large and the date beneath it. */
export function diaryChapterLabel(timeZone?: string): ChapterLabel {
  return (_ordinal, heading) => {
    const { day, time } = formatEntryDate(heading, timeZone);
    return { numeral: time, title: day };
  };
}
