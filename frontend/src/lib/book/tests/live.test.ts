// @vitest-environment jsdom
import "./setup";
import { LAYOUT } from '../pages';
import { describe, expect, it } from 'vitest';
import { FIRST_TEXT_PAGE, pageSignature, spreadOf } from '../live';
import { fakeTypesetter, SAMPLE_MANUSCRIPT, sampleLive } from './helpers';
import { LiveBook } from '../live';

describe('pageSignature and spreadOf', () => {
  it('fingerprints non-text pages by kind', () => {
    expect(pageSignature({ kind: 'cover' })).toBe('cover');
  });

  it('maps page indices to spreads', () => {
    expect([0, 1, 2, 3, 4].map(spreadOf)).toEqual([0, 1, 1, 2, 2]);
  });
});

describe('LiveBook', () => {
  it('typesets the manuscript into a full book', () => {
    const live = sampleLive();
    expect(live.pages[0]?.kind).toBe('cover');
    expect(live.pages.length % 2).toBe(0);
    expect(live.pages.filter((p) => p.kind === 'text').length).toBeGreaterThan(2);
  });

  it('reports only the pages an edit actually changes', () => {
    const live = sampleLive();
    const firstRun = live.pages.length;
    const edited = SAMPLE_MANUSCRIPT.replace('word5x39', 'word5x39 extra');
    const update = live.update(edited);
    expect(update.wrapped).toBe(1);
    expect(update.reused).toBeGreaterThan(3);
    expect(update.changed.length).toBeGreaterThan(0);
    expect(update.changed.every((i) => i >= FIRST_TEXT_PAGE)).toBe(true);
    expect(update.changed.length).toBeLessThan(firstRun);
    expect(live.update(edited).changed).toEqual([]);
  });

  it('marks shifted pages as changed when text reflows', () => {
    const live = sampleLive();
    const before = live.pages.length;
    const update = live.update(SAMPLE_MANUSCRIPT.replace('# Second wind', `${'more '.repeat(400)}\n\n# Second wind`));
    expect(live.pages.length).toBeGreaterThan(before);
    expect(update.changed).toContain(live.pages.length - 1);
  });

  it('locates the caret on its page and line, including headings', () => {
    const live = sampleLive();
    const inPara = live.locate(SAMPLE_MANUSCRIPT.indexOf('word2x20'));
    expect(inPara?.page).toBeGreaterThanOrEqual(FIRST_TEXT_PAGE);
    expect(typeof inPara?.line).toBe('number');
    expect(inPara?.rect?.w).toBeGreaterThan(0);

    const heading = live.locate(SAMPLE_MANUSCRIPT.indexOf('Second wind'));
    expect(heading?.line).toBe('chapter');
    const spec = live.pages[heading!.page];
    expect(spec?.kind === 'text' && spec.content.chapter?.title).toBe('Second wind');
  });

  it('falls back gracefully for an empty manuscript', () => {
    const live = sampleLive('');
    expect(live.locate(0)).toBeNull();
    const blank = sampleLive('# Only a heading');
    expect(blank.locate(3)?.line).toBe('chapter');
  });

  it('maps a tap on a line back to the caret, and round-trips with locate', () => {
    const live = sampleLive();
    const caret = SAMPLE_MANUSCRIPT.indexOf('word2x10');
    const loc = live.locate(caret)!;
    expect(typeof loc.line).toBe('number');
    const rect = loc.rect!;
    const offset = live.caretAt(loc.page, rect.x + 1, rect.y + rect.h / 2)!;
    expect(live.locate(offset)).toEqual(loc);
  });

  it('maps a tap on a chapter heading to the heading text', () => {
    const live = sampleLive();
    const offset = live.caretAt(FIRST_TEXT_PAGE, 250, LAYOUT.top + 10);   // on the heading's title
    expect(SAMPLE_MANUSCRIPT.slice(offset!, offset! + 11)).toBe('First light');
  });

  it('ignores taps on pages without text', () => {
    const live = sampleLive();
    expect(live.caretAt(0, 100, 100)).toBeNull();
    expect(live.caretAt(999, 100, 100)).toBeNull();
  });
});

describe('pageSignature with formatting', () => {
  it('changes when only formatting changes', () => {
    const plain = { kind: 'text' as const, content: { lines: [{ words: ['a'], indent: 0, justify: false, block: 0, firstWord: 0 }] } };
    const bold = {
      kind: 'text' as const,
      content: { lines: [{ words: ['a'], indent: 0, justify: false, block: 0, firstWord: 0, spans: [[{ text: 'a', style: { bold: true } }]] }] },
    };
    expect(pageSignature(plain)).not.toBe(pageSignature(bold));
    expect(pageSignature({ kind: 'custom', name: 'x', data: { a: '1' } })).toContain('custom:x');
  });
});

describe('cursor and selection on the page', () => {
  const live = sampleLive();
  const at = (word: string, plus = 0) => SAMPLE_MANUSCRIPT.indexOf(word) + plus;

  it('places the cursor between characters and maps taps back exactly', () => {
    const p = live.caretPoint(at('word2x10', 3))!;
    expect(p.page).toBeGreaterThanOrEqual(FIRST_TEXT_PAGE);
    const back = live.caretAt(p.page, p.x, p.y + p.h / 2);
    expect(back).toBe(at('word2x10', 3));
  });

  it('handles the drop cap and the start of an entry', () => {
    const start = at('word1x0');
    const cap = live.caretPoint(start)!;
    const afterCap = live.caretPoint(start + 1)!;
    expect(afterCap.x).toBeGreaterThan(cap.x);
    expect(live.caretAt(cap.page, cap.x - 20, cap.y + 5)).toBe(start); // tapping the capital
    expect(live.caretPoint(SAMPLE_MANUSCRIPT.indexOf('First light'))).toBeNull(); // headings aren't written in
  });

  it('draws selections across lines and pages', () => {
    const rects = live.selectionRects(at('word1x5'), at('word2x5'));
    expect(rects.length).toBeGreaterThan(2);
    expect(live.selectionRects(5, 5)).toEqual([]);
    expect(live.selectionRects(at('First'), at('word1x3'))).toEqual([]);
  });

  it('moves up and down by printed lines, across pages, and to line ends', () => {
    const o = at('word2x20');
    const down = live.verticalMove(o, 1);
    const up = live.verticalMove(down, -1);
    expect(down).toBeGreaterThan(o);
    expect(Math.abs(up - o)).toBeLessThan(12);
    expect(live.verticalMove(at('word1x0'), -1)).toBe(at('word1x0'));
    const end = live.lineEdge(o, 'end');
    const start = live.lineEdge(o, 'start');
    expect(start).toBeLessThanOrEqual(o);
    expect(end).toBeGreaterThanOrEqual(o);
    expect(SAMPLE_MANUSCRIPT[end]).toMatch(/\s|$/);
    // The last line of one page continues on the first line of the next.
    let cursor = at('word1x0');
    const pages = new Set<number>();
    for (let i = 0; i < 40; i++) {
      pages.add(live.caretPoint(cursor)?.page ?? -1);
      cursor = live.verticalMove(cursor, 1);
    }
    expect(pages.size).toBeGreaterThan(1);
    expect(live.lineEdge(SAMPLE_MANUSCRIPT.indexOf('First light'), 'end')).toBe(SAMPLE_MANUSCRIPT.indexOf('First light'));
  });
});

describe('tables, checklists and pictures in the live book', () => {
  const src = 'Todo\n\nMilk\n\nA\tB\n\nxy\tz';
  function liveWith(): LiveBook {
    // Build blocks directly so the table and checklist behave as in the diary.
    const typesetter = fakeTypesetter();
    return new LiveBook(typesetter, src, {
      parse: () => ({
        blocks: [
          { kind: 'chapter', numeral: 'I', title: 'Todo' },
          { kind: 'para', text: 'Milk', style: 'check' },
          { kind: 'para', text: 'A\tB', style: 'table', table: { cols: 2, row: 0, last: false } },
          { kind: 'para', text: 'xy\tz', style: 'table', table: { cols: 2, row: 1, last: true } },
        ],
        ranges: [
          { start: 0, end: 4 },
          { start: 6, end: 10 },
          { start: 12, end: 15 },
          { start: 17, end: 21 },
        ],
      }),
    });
  }

  it('maps a cursor inside a table cell to the page and back', () => {
    const live = liveWith();
    const offset = src.indexOf('xy') + 1;
    const p = live.caretPoint(offset)!;
    expect(live.caretAt(p.page, p.x, p.y + 4)).toBe(offset);
    const cellB = live.caretPoint(src.indexOf('B'))!;
    expect(cellB.x).toBeGreaterThan(p.x);
    expect(live.lineEdge(offset, 'start')).toBe(src.indexOf('xy'));
    expect(live.lineEdge(offset, 'end')).toBe(src.length);
    expect(live.caretAt(p.page, 9999, p.y + 4)).toBe(src.length);
  });

  it('finds the checklist box under a tap', () => {
    const live = liveWith();
    const milk = live.caretPoint(src.indexOf('Milk'))!;
    expect(live.checkboxAt(milk.page, milk.x - 15, milk.y + 5)).toBe(1);
    expect(live.checkboxAt(milk.page, milk.x + 50, milk.y + 5)).toBeNull();
    expect(live.checkboxAt(0, 1, 1)).toBeNull();
    expect(live.pagesWithImage('none')).toEqual([]);
  });
});
