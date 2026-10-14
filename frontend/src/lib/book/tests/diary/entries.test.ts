// @vitest-environment jsdom
import "../setup";
import { describe, expect, it } from 'vitest';
import {
  buildManuscript,
  decoyDiary,
  diaryChapterLabel,
  emptyDiary,
  formatEntryDate,
  fromSourceOffset,
  newEntry,
  toSourceOffset,
  type Entry,
} from '../../diary/entries';
import { parseManuscript } from '../../manuscript';

const entries: Entry[] = [
  { id: 'a', createdAt: '2026-09-23T08:05:00.000Z', text: 'First line.\nSecond line.' },
  { id: 'b', createdAt: '2026-09-24T21:41:00.000Z', text: '# not a heading\nAnd more.' },
  { id: 'c', createdAt: '2026-09-24T22:00:00.000Z', text: '' },
];

describe('buildManuscript', () => {
  const m = buildManuscript(entries);

  it('turns every entry into a dated chapter with one paragraph per line', () => {
    const parsed = parseManuscript(m.source);
    expect(parsed.blocks.filter((b) => b.kind === 'chapter')).toHaveLength(3);
    expect(parsed.blocks[1]).toEqual({ kind: 'para', text: 'First line.' });
    expect(parsed.blocks[2]).toEqual({ kind: 'para', text: 'Second line.' });
  });

  it('never lets entry text create headings', () => {
    const parsed = parseManuscript(m.source);
    expect(parsed.blocks[4]).toEqual({ kind: 'para', text: '＃ not a heading' });
  });

  it('maps every caret position to the manuscript and back', () => {
    entries.forEach((entry, index) => {
      for (let caret = 0; caret <= entry.text.length; caret++) {
        const offset = toSourceOffset(m, entries, index, caret);
        expect(fromSourceOffset(m, entries, offset)).toEqual({ index, caret });
      }
    });
  });

  it('handles headings, out-of-range and empty cases', () => {
    expect(fromSourceOffset(m, entries, m.headingStarts[1]! + 3)).toEqual({ index: 1, caret: 0 });
    expect(fromSourceOffset(m, entries, 10_000)).toEqual({ index: 2, caret: 0 });
    expect(fromSourceOffset(buildManuscript([]), [], 0)).toBeNull();
    expect(toSourceOffset(m, entries, 9, 0)).toBe(0);
  });
});

describe('labels', () => {
  it('formats the entry time and day for the heading', () => {
    const { day, time } = formatEntryDate('2026-09-24T21:41:00.000Z', 'Africa/Accra');
    expect(day).toMatch(/Thursday,? 24 September 2026/);
    expect(time).toBe('9:41 pm');
    expect(formatEntryDate('garbage')).toEqual({ day: 'garbage', time: '' });
  });

  it('labels chapters with time above date', () => {
    const label = diaryChapterLabel('Africa/Accra')(1, '2026-09-24T08:05:00.000Z');
    expect(label.numeral).toBe('8:05 am');
    expect(label.title).toMatch(/24 September 2026/);
  });
});

describe('diary data', () => {
  it('creates empty diaries and new entries', () => {
    expect(emptyDiary('Ama')).toMatchObject({ owner: 'Ama', entries: [], settings: { lockWhenHidden: true } });
    const e = newEntry(new Date('2026-09-24T10:00:00Z'));
    expect(e.text).toBe('');
    expect(e.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('fills a decoy with ordinary entries from the past week', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    const decoy = decoyDiary('', now);
    expect(decoy.entries).toHaveLength(3);
    decoy.entries.forEach((e) => expect(new Date(e.createdAt).getTime()).toBeLessThan(now.getTime()));
  });
});

describe('formatted entries', () => {
  const RED = '#8A1F2D';
  const entry: Entry = {
    id: 'f',
    createdAt: '2026-09-24T21:41:00.000Z',
    text: '  Hello   bold world\n\nmilk\neggs',
    marks: [
      { type: 'bold', start: 10, end: 14 },
      { type: 'color', start: 2, end: 7, value: RED },
    ],
    paras: ['normal', 'normal', 'bullet', 'bullet'],
  };

  it('carries formatting and paragraph styles into the book’s blocks', () => {
    const { manuscript } = buildManuscript([entry], diaryChapterLabel('Africa/Accra'));
    const [heading, first, blank, milk, eggs] = manuscript.blocks;
    expect(blank).toEqual({ kind: 'para', text: '' }); // a blank line stays as space on the page
    expect(heading).toMatchObject({ kind: 'chapter', numeral: '9:41 pm' });
    expect(first).toEqual({
      kind: 'para',
      text: 'Hello bold world',
      runs: [
        { start: 0, end: 5, style: { color: RED } },
        { start: 6, end: 10, style: { bold: true } },
      ],
    });
    expect(milk).toMatchObject({ text: 'milk', style: 'bullet' });
    expect(eggs).toMatchObject({ text: 'eggs', style: 'bullet' });
    expect(manuscript.blocks).toHaveLength(5);
  });

  it('keeps source ranges exact for cursor mapping', () => {
    const built = buildManuscript([entry]);
    built.manuscript.ranges.slice(1).forEach((r, i) => {
      const block = built.manuscript.blocks[i + 1];
      const words = built.source.slice(r.start, r.end).trim().split(/\s+/).join(' ');
      expect(block?.kind === 'para' && block.text).toBe(words);
    });
  });
});

describe('entries with lists, tables and pictures', () => {
  const entry: Entry = {
    id: 'b',
    createdAt: '2026-09-24T10:00:00.000Z',
    text: `one\ntwo\nbreak\nthree\nItem\tCost\nBread\t5\t\n\uFFFC`,
    paras: ['numbered', 'numbered', 'normal', 'numbered', 'table', 'table', 'image:p'],
    media: { p: { src: 'data:x', w: 400, h: 300 } },
  };
  const built = buildManuscript([entry]);
  const paras = built.manuscript.blocks.slice(1);

  it('numbers each run of list items from one', () => {
    expect(paras.slice(0, 4).map((b) => (b.kind === 'para' ? b.ordinal : 'h'))).toEqual([1, 2, undefined, 1]);
  });

  it('sizes tables by their widest row and keeps tabs in the text', () => {
    expect(paras[4]).toMatchObject({ text: 'Item\tCost', table: { cols: 3, row: 0, last: false } });
    expect(paras[5]).toMatchObject({ table: { cols: 3, row: 1, last: true } });
  });

  it('turns picture lines into image blocks and maps blocks back to lines', () => {
    expect(paras[6]).toMatchObject({ text: '', image: { id: 'p', w: 400, h: 300 } });
    expect(built.blockLines[0]).toBeNull();
    expect(built.blockLines[7]).toEqual({ entry: 0, line: 6 });
  });
});
