// @vitest-environment jsdom
import "./setup";
import { describe, expect, it } from 'vitest';
import { createTypesetter, imageLines, splitDropCap, splitWords, typeset, wrapWords, type Block } from '../typeset';

/** Monospace stand-in: every character is 10px wide, as is a space. */
const measure = (s: string): number => s.length * 10;

const base = {
  measure,
  spaceWidth: 10,
  width: 200,
  linesPerPage: 4,
  chapterLines: 2,
  paragraphIndent: 20,
  dropCapWidth: () => 30,
};

describe('wrapWords', () => {
  it('breaks greedily at the available width', () => {
    const lines = wrapWords(splitWords('aaa bbb ccc ddd eee'), () => 75, measure, 10);
    expect(lines).toEqual([['aaa', 'bbb'], ['ccc', 'ddd'], ['eee']]);
  });

  it('never leaves an over-long word stranded on an empty line', () => {
    expect(wrapWords(['extraordinarily', 'long'], () => 50, measure, 10)).toEqual([['extraordinarily'], ['long']]);
  });

  it('handles empty input', () => {
    expect(wrapWords([], () => 100, measure, 10)).toEqual([]);
    expect(splitWords('   ')).toEqual([]);
  });
});

describe('splitDropCap', () => {
  it('keeps leading punctuation with the capital', () => {
    expect(splitDropCap('“Quoted')).toEqual({ cap: '“Q', rest: 'uoted' });
    expect(splitDropCap('—')).toBeNull();
  });
});

describe('typeset', () => {
  const story: Block[] = [
    { kind: 'chapter', numeral: 'I', title: 'Opening' },
    { kind: 'para', text: 'Once there was a very small cloud that liked to rain on one garden only.' },
    { kind: 'para', text: 'It rained and rained until the garden became a pond with fish in it.' },
    { kind: 'para', text: '   ' },
    { kind: 'chapter', numeral: 'II', title: 'Later' },
    { kind: 'para', text: '“Quoted opening line of the second chapter.”' },
  ];
  const pages = typeset(story, base);

  it('starts every chapter on a fresh page with its heading and source block', () => {
    const chapterPages = pages.filter((p) => p.chapter);
    expect(chapterPages.map((p) => [p.chapter?.numeral, p.chapter?.block])).toEqual([
      ['I', 0],
      ['II', 4],
    ]);
  });

  it('respects the lines available on each page', () => {
    for (const page of pages) {
      const capacity = base.linesPerPage - (page.chapter ? base.chapterLines : 0);
      expect(page.lines.length).toBeLessThanOrEqual(capacity);
    }
    expect(pages.length).toBeGreaterThan(2);
  });

  it('sets a drop cap on chapter openings, keeping leading punctuation', () => {
    expect(pages[0]?.lines[0]?.dropCap).toBe('O');
    expect(pages[0]?.lines[0]?.words[0]).toBe('nce');
    const second = pages.find((p) => p.chapter?.numeral === 'II');
    expect(second?.lines[0]?.dropCap).toBe('“Q');
  });

  it('indents follow-on paragraphs and leaves last lines ragged', () => {
    const flat = pages.flatMap((p) => p.lines);
    const secondPara = flat.find((l) => l.words[0] === 'It');
    expect(secondPara?.indent).toBe(20);
    const lastOfFirstChapter = flat[flat.indexOf(secondPara!) - 1];
    expect(lastOfFirstChapter?.justify).toBe(false);
  });

  it('records each line’s source block and first word', () => {
    const flat = pages.flatMap((p) => p.lines).filter((l) => l.block === 1);
    let expected = 0;
    for (const line of flat) {
      expect(line.firstWord).toBe(expected);
      expected += line.words.length;
    }
  });

  it('marks only the final page as the end of the story', () => {
    expect(pages.filter((p) => p.isLast)).toHaveLength(1);
    expect(pages[pages.length - 1]?.isLast).toBe(true);
  });

  it('flows text that has no chapter heading', () => {
    const plain = typeset([{ kind: 'para', text: 'Just a line.' }], base);
    expect(plain).toHaveLength(1);
    expect(plain[0]?.lines[0]?.indent).toBe(20);
  });

  it('drops a single-letter opening word entirely into the cap', () => {
    const [page] = typeset([{ kind: 'chapter', numeral: 'I', title: 't' }, { kind: 'para', text: 'A cloud.' }], base);
    expect(page?.lines[0]?.dropCap).toBe('A');
    expect(page?.lines[0]?.words).toEqual(['cloud.']);
    expect(page?.lines[0]?.firstWord).toBe(1);
  });
});

describe('createTypesetter', () => {
  const blocks = (edited: string): Block[] => [
    { kind: 'chapter', numeral: 'I', title: 'One' },
    { kind: 'para', text: 'An unchanged opening paragraph that stays the same.' },
    { kind: 'para', text: edited },
    { kind: 'para', text: 'Another untouched paragraph at the end.' },
  ];

  it('re-wraps only the paragraph that changed', () => {
    const ts = createTypesetter(base);
    ts.typeset(blocks('Hello'));
    expect(ts.stats).toEqual({ wrapped: 3, reused: 0 });
    ts.typeset(blocks('Hello there'));
    expect(ts.stats).toEqual({ wrapped: 1, reused: 2 });
  });

  it('matches one-shot typesetting exactly', () => {
    const ts = createTypesetter(base);
    ts.typeset(blocks('warm'));
    expect(ts.typeset(blocks('warm cache'))).toEqual(typeset(blocks('warm cache'), base));
  });

  it('drops its cache when the limit is reached', () => {
    const ts = createTypesetter(base, 2);
    ts.typeset(blocks('x'));
    ts.typeset(blocks('x'));
    expect(ts.stats.reused).toBeLessThan(3);
  });
});

describe('formatted paragraphs', () => {
  const opts = { ...base, width: 300, linesPerPage: 20 };
  const RED = '#8A1F2D';

  it('splits formatted words into styled pieces and measures them with their style', () => {
    const measureRun = (t: string, s: { bold?: boolean }) => t.length * (s.bold ? 20 : 10);
    const [page] = typeset(
      [{ kind: 'para', text: 'aa bbbb cc', runs: [{ start: 3, end: 5, style: { bold: true, color: RED } }] }],
      { ...opts, measureRun },
    );
    const line = page!.lines[0]!;
    expect(line.spans?.[0]).toBeNull();
    expect(line.spans?.[1]).toEqual([
      { text: 'bb', style: { bold: true, color: RED } },
      { text: 'bb', style: {} },
    ]);
  });

  it('wraps earlier when bold text is wider', () => {
    const measureRun = (t: string, s: { bold?: boolean }) => t.length * (s.bold ? 30 : 10);
    const text = 'one two three four five six seven';
    const plain = typeset([{ kind: 'para', text }], { ...opts, measureRun });
    const bold = typeset([{ kind: 'para', text, runs: [{ start: 0, end: text.length, style: { bold: true } }] }], { ...opts, measureRun });
    expect(bold[0]!.lines.length).toBeGreaterThan(plain[0]!.lines.length);
  });

  it('lays out bullets, quotes and centred paragraphs', () => {
    const [page] = typeset(
      [
        { kind: 'para', text: 'a bullet that is long enough to wrap onto a second line', style: 'bullet' },
        { kind: 'para', text: 'a quote', style: 'quote' },
        { kind: 'para', text: 'centred', style: 'center' },
      ],
      opts,
    );
    const lines = page!.lines;
    expect(lines[0]).toMatchObject({ bullet: true, indent: 24 });
    expect(lines[1]).toMatchObject({ indent: 24 });
    expect(lines[1]!.bullet).toBeUndefined();
    const quote = lines.find((l) => l.quote)!;
    expect(quote).toMatchObject({ indent: 28, measure: 300 - 28 });
    expect(lines[lines.length - 1]).toMatchObject({ align: 'center', justify: false });
  });

  it('lays out a key point like a bullet drawn as a star', () => {
    const [page] = typeset([{ kind: 'para', text: 'a key point that is long enough to wrap onto a second line', style: 'key' }], opts);
    const lines = page!.lines;
    expect(lines[0]).toMatchObject({ bullet: true, star: true, indent: 24 });
    expect(lines[1]!.star).toBeUndefined();
  });

  it('skips the drop cap on a styled opening paragraph and caches by formatting', () => {
    const ts = createTypesetter(opts);
    const blocks = (style?: 'bullet'): Block[] => [
      { kind: 'chapter', numeral: 'I', title: 't' },
      { kind: 'para', text: 'Hello there', ...(style ? { style } : {}) },
    ];
    expect(ts.typeset(blocks('bullet'))[0]!.lines[0]!.dropCap).toBeUndefined();
    expect(ts.typeset(blocks())[0]!.lines[0]!.dropCap).toBe('H');
    ts.typeset(blocks());
    expect(ts.stats).toEqual({ wrapped: 0, reused: 1 });
  });
});

describe('blank lines', () => {
  it('keeps an empty paragraph as a line of space', () => {
    const [page] = typeset(
      [
        { kind: 'para', text: 'Before.' },
        { kind: 'para', text: '' },
        { kind: 'para', text: 'After.' },
      ],
      { ...base, width: 300, linesPerPage: 10 },
    );
    expect(page!.lines.map((l) => l.words.join(' '))).toEqual(['Before.', '', 'After.']);
  });
});

describe('lists, headings, dividers, pictures and tables', () => {
  const opts = { ...base, width: 400, linesPerPage: 12, lineHeight: 29 };

  it('marks numbered and checklist items and makes headings bold and large', () => {
    const [page] = typeset(
      [
        { kind: 'para', text: 'Title', style: 'heading' },
        { kind: 'para', text: 'first', style: 'numbered', ordinal: 1 },
        { kind: 'para', text: 'second', style: 'numbered', ordinal: 2 },
        { kind: 'para', text: 'todo', style: 'check' },
        { kind: 'para', text: 'done', style: 'checked' },
        { kind: 'para', text: '', style: 'check' },
      ],
      opts,
    );
    const l = page!.lines;
    expect(l[0]).toMatchObject({ heading: true });
    expect(l[0]!.spans?.[0]?.[0]?.style).toMatchObject({ bold: true, large: true });
    expect(l[2]).toMatchObject({ marker: 'number', number: 2, indent: 28 });
    expect(l[3]).toMatchObject({ marker: 'check' });
    expect(l[4]).toMatchObject({ marker: 'checked' });
    expect(l[5]).toMatchObject({ marker: 'check', words: [] });
  });

  it('draws dividers and reserves space for pictures, never splitting them', () => {
    const pages = typeset(
      [
        ...Array.from({ length: 9 }, () => ({ kind: 'para' as const, text: 'line' })),
        { kind: 'para', text: '', style: 'divider' },
        { kind: 'para', text: '', style: 'image:p', image: { id: 'p', w: 400, h: 300 } },
      ],
      opts,
    );
    expect(pages[0]!.lines[pages[0]!.lines.length - 1]).toMatchObject({ divider: true });
    const pic = pages[1]!.lines[0];
    expect(pic?.image).toMatchObject({ id: 'p', lines: 12 - 1 });
    expect(pages[1]!.lines.filter((x) => x.image)).toHaveLength(1);
  });

  it('lays table rows out in cells, with a bold header row', () => {
    const [page] = typeset(
      [
        { kind: 'para', text: 'Item\tCost', style: 'table', table: { cols: 3, row: 0, last: false } },
        { kind: 'para', text: 'Bread\t\t5', style: 'table', table: { cols: 3, row: 1, last: true } },
      ],
      opts,
    );
    const [head, row] = page!.lines;
    expect(head!.cells).toHaveLength(3);
    expect(head!.cellOfWord).toEqual([0, 1]);
    expect(head!.spans?.[0]?.[0]?.style.bold).toBe(true);
    expect(row).toMatchObject({ words: ['Bread', '5'], cellOfWord: [0, 2], table: { row: 1, cols: 3, last: true } });
  });

  it('can switch drop caps off for handwriting themes', () => {
    const [page] = typeset([{ kind: 'chapter', numeral: 'I', title: 't' }, { kind: 'para', text: 'Hello' }], { ...opts, dropCaps: false });
    expect(page!.lines[0]!.dropCap).toBeUndefined();
  });

  it('gives tiny or unknown pictures at least a couple of lines', () => {
    expect(imageLines(0, 0, 400, 29, 10)).toBe(1);
    expect(imageLines(4000, 10, 400, 29, 10)).toBe(2);
  });
});
