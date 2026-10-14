// @vitest-environment jsdom
import "./setup";
import { describe, expect, it, vi } from 'vitest';

// Deterministic metrics: 9px per character, 5px spaces.
vi.mock('../measure', () => ({
  sharedMeasurer: () => ({ width: (t: string) => (t === ' ' ? 5 : t.length * 9), size: 0, hits: 0, misses: 0, clear() {} }),
}));
import type { PageSpec } from '../book';
import { describePage, paintPage, sideOf } from '../pages';
import { sampleContent } from './helpers';

type MockCtx = CanvasRenderingContext2D & { __getEvents(): { type: string; props: Record<string, unknown> }[] };

function paint(spec: PageSpec, index: number): string[] {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d') as MockCtx;
  paintPage(ctx, spec, index);
  return ctx
    .__getEvents()
    .filter((e) => e.type === 'fillText')
    .map((e) => String(e.props.text));
}

describe('paintPage', () => {
  it('knows which side of the spine a page sits on', () => {
    expect(sideOf(0)).toBe('right');
    expect(sideOf(3)).toBe('left');
  });

  it('typesets a chapter page with heading, drop cap and folio', () => {
    const text = paint({ kind: 'text', content: sampleContent(0) }, 3);
    // The heading is the section's title and a rule: no chapter number any more (compact headings, 27 Sep 2026).
    expect(text).toEqual(expect.arrayContaining(['Start', 'nce', 'end.', '4']));
    expect(text).not.toContain('I');
  });

  it('marks the final text page with an ornament instead of more text', () => {
    const text = paint({ kind: 'text', content: sampleContent(3) }, 6);
    expect(text).toContain('7');
  });

  it.each<PageSpec['kind']>(['endpaper', 'title', 'colophon', 'blank', 'back-cover'])('paints a %s page', (kind) => {
    const spec = { kind } as PageSpec;
    expect(() => paint(spec, 5)).not.toThrow();
    expect(describePage(spec, 5).length).toBeGreaterThan(3);
  });

  it('describes a text page without a chapter heading', () => {
    expect(describePage({ kind: 'text', content: sampleContent(1) }, 4)).toBe('Page 5. Once upon a time the end.');
  });
});

import { hitTestLine, layoutLine, lineRect, LAYOUT, TEXT_WIDTH } from '../pages';

describe('line geometry', () => {
  const spec: PageSpec = { kind: 'text', content: sampleContent(0) };
  const plain: PageSpec = { kind: 'text', content: sampleContent(1) };

  it('justifies full lines to the measure and leaves last lines natural', () => {
    const words = ['abcdef', 'abcdef', 'abcdef', 'abcdef', 'abcdef', 'abcdef'];
    const full = layoutLine({ words, indent: 0, justify: true, block: 0, firstWord: 0 }, 0);
    expect((full.xs[full.xs.length - 1] ?? 0) + (full.widths[full.widths.length - 1] ?? 0)).toBeCloseTo(TEXT_WIDTH, 5);
    const ragged = layoutLine({ words, indent: 0, justify: false, block: 0, firstWord: 0 }, 0);
    expect((ragged.xs[1] ?? 0) - (ragged.xs[0] ?? 0)).toBe(54 + 5);
    // Too few words to fill the measure: fall back to natural spacing rather than rivers.
    const sparse = layoutLine({ words: ['a', 'b'], indent: 0, justify: true, block: 0, firstWord: 0 }, 0);
    expect((sparse.xs[1] ?? 0) - (sparse.xs[0] ?? 0)).toBe(9 + 5);
  });

  it('finds the line and word under a point', () => {
    const y = LAYOUT.top + (LAYOUT.chapterLines + 1) * LAYOUT.lineHeight + 10;
    expect(hitTestLine(spec, 3, LAYOUT.inner, y)).toEqual({ line: 1, word: 0, char: 0 });
    expect(hitTestLine(spec, 3, 480, y)).toEqual({ line: 1, word: 1, char: 4 });
    expect(hitTestLine(spec, 3, 200, LAYOUT.top + 20)).toEqual({ line: 'chapter', word: 0, char: 0 });
    expect(hitTestLine(plain, 4, 100, 690)?.line).toBe(1);
    expect(hitTestLine({ kind: 'cover' }, 0, 1, 1)).toBeNull();
    expect(hitTestLine({ kind: 'text', content: { lines: [] } }, 4, 1, 1)).toBeNull();
  });

  it('gives rectangles for lines and headings', () => {
    expect(lineRect(spec, 3, 0)?.y).toBeGreaterThan(LAYOUT.top);
    expect(lineRect(spec, 3, 'chapter')).not.toBeNull();
    expect(lineRect(plain, 4, 'chapter')).toBeNull();
    expect(lineRect(spec, 3, 9)).toBeNull();
    expect(lineRect({ kind: 'blank' }, 5, 0)).toBeNull();
  });
});

import { styleFont } from '../pages';

describe('formatted lines on the page', () => {
  type Ev = { type: string; props: Record<string, unknown> };
  const paint = (content: PageSpec): Ev[] => {
    const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D & { __getEvents(): Ev[] };
    paintPage(ctx, content, 4);
    return ctx.__getEvents();
  };
  const HL = 'rgba(247, 214, 76, 0.55)';
  const line = {
    words: ['plain', 'marked', 'words'],
    indent: 24,
    justify: false,
    block: 1,
    firstWord: 0,
    bullet: true,
    spans: [
      null,
      [{ text: 'marked', style: { bold: true, italic: true, highlight: HL, underline: true, strike: true, color: '#2B3F8C' } }],
      [{ text: 'words', style: { highlight: HL, underline: true, strike: true } }],
    ],
  };

  it('uses the style’s weight and slant', () => {
    expect(styleFont({ bold: true, italic: true })).toMatch(/^italic 600 19px/);
    expect(styleFont({})).toMatch(/^19px/);
  });

  it('draws highlights, coloured text, underline, strike and the bullet', () => {
    const events = paint({ kind: 'text', content: { lines: [line] } });
    const texts = events.filter((e) => e.type === 'fillText').map((e) => String(e.props.text));
    expect(texts).toEqual(expect.arrayContaining(['plain', 'marked', 'words', '•']));
    const fills = events.filter((e) => e.type === 'fillRect').length;
    expect(fills).toBeGreaterThan(6); // highlight bands, rules and the gap between formatted words
  });

  it('draws a star instead of a dot for a key point', () => {
    const events = paint({ kind: 'text', content: { lines: [{ ...line, star: true }] } });
    const texts = events.filter((e) => e.type === 'fillText').map((e) => String(e.props.text));
    expect(texts).toContain('★');
    expect(texts).not.toContain('•');
  });

  it('centres short lines and marks quotes with a bar', () => {
    const centred = { words: ['hi'], indent: 0, justify: false, block: 0, firstWord: 0, align: 'center' as const };
    const { xs } = layoutLine(centred, 0);
    expect(xs[0]).toBeGreaterThan(TEXT_WIDTH / 3);
    const quote = { words: ['q'], indent: 28, justify: false, block: 0, firstWord: 0, quote: true, measure: TEXT_WIDTH - 28 };
    expect(() => paint({ kind: 'text', content: { lines: [quote] } })).not.toThrow();
  });
});

import { caretRect, prefixWidth } from '../pages';

describe('cursor geometry', () => {
  const spec: PageSpec = { kind: 'text', content: sampleContent(0) };

  it('measures word prefixes, styled or plain', () => {
    const line = sampleContent(1).lines[0]!;
    expect(prefixWidth(line, 0, 2)).toBe(18);
    const styled = { ...line, spans: [[{ text: 'On', style: { bold: true } }, { text: 'ce', style: {} }], null, null, null] };
    expect(prefixWidth(styled, 0, 3)).toBe(27);
  });

  it('puts the cursor before, after or inside words and around the drop cap', () => {
    const before = caretRect(spec, 3, 0, 0, 0)!;
    const afterCap = caretRect(spec, 3, 0, 0, 1)!;
    const inWord = caretRect(spec, 3, 0, 0, 3)!;
    const pastWord = caretRect(spec, 3, 0, 1, 99)!;
    expect(afterCap.x).toBeGreaterThan(before.x);
    expect(inWord.x).toBeGreaterThan(afterCap.x);
    expect(pastWord.x).toBeGreaterThan(inWord.x);
    expect(caretRect(spec, 3, 0, -1, 0)!.x).toBe(before.x);
    expect(caretRect(spec, 3, 9, 0, 0)).toBeNull();
    expect(caretRect({ kind: 'blank' }, 3, 0, 0, 0)).toBeNull();
    const blank = { kind: 'text' as const, content: { lines: [{ words: [], indent: 0, justify: false, block: 0, firstWord: 0, align: 'center' as const }] } };
    expect(caretRect(blank, 4, 0, 0, 0)!.x).toBeGreaterThan(200);
  });

  it('reports a tap before the drop cap and on blank lines', () => {
    const y = LAYOUT.top + LAYOUT.chapterLines * LAYOUT.lineHeight + 10;
    expect(hitTestLine(spec, 3, 51, y)).toEqual({ line: 0, word: 0, char: -1 });
    const blank = { kind: 'text' as const, content: { lines: [{ words: [], indent: 0, justify: false, block: 0, firstWord: 0 }] } };
    expect(hitTestLine(blank, 4, 100, LAYOUT.top + 5)).toEqual({ line: 0, word: 0, char: 0 });
  });
});

import { onCheckbox, registerImage, tableCaretX, tableHit, forgetImages } from '../pages';

describe('drawing blocks on the page', () => {
  type Ev = { type: string; props: Record<string, unknown> };
  const events = (lines: PageSpec extends never ? never : unknown[]): Ev[] => {
    const ctx = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D & { __getEvents(): Ev[] };
    paintPage(ctx, { kind: 'text', content: { lines: lines as never } }, 4);
    return ctx.__getEvents();
  };
  const base = { indent: 28, justify: false, block: 0, firstWord: 0 };
  const texts = (ev: Ev[]) => ev.filter((e) => e.type === 'fillText').map((e) => String(e.props.text));

  it('numbers list items and draws checkboxes, ticked or not', () => {
    const ev = events([
      { ...base, words: ['one'], marker: 'number', number: 7 },
      { ...base, words: ['todo'], marker: 'check' },
      { ...base, words: ['done'], marker: 'checked' },
    ]);
    expect(texts(ev)).toContain('7.');
    expect(ev.filter((e) => e.type === 'strokeRect')).toHaveLength(2);
  });

  it('draws dividers, pictures (or a placeholder) and table grids', () => {
    const table = { ...base, indent: 0, words: ['Item', 'Cost'], cells: [{ x: 0, w: 195 }, { x: 195, w: 195 }], cellOfWord: [0, 1], table: { row: 0, cols: 2, last: true } };
    const ev = events([
      { ...base, words: [], divider: true },
      { ...base, words: [], image: { id: 'nope', lines: 4, w: 400, h: 300 } },
      table,
    ]);
    expect(texts(ev)).toEqual(expect.arrayContaining(['Item', 'Cost']));
    expect(ev.some((e) => e.type === 'clip')).toBe(true);
    registerImage('shown', 'data:image/png;base64,AAAA');
    expect(() => events([{ ...base, words: [], image: { id: 'shown', lines: 3, w: 10, h: 10 } }])).not.toThrow();
    forgetImages();
  });

  it('places the cursor inside table cells and finds the cell under a tap', () => {
    const row = { words: ['ab'], indent: 0, justify: false, block: 0, firstWord: 0, cells: [{ x: 0, w: 130 }, { x: 130, w: 130 }, { x: 260, w: 130 }], cellOfWord: [0], table: { row: 1, cols: 3, last: true } };
    const x0 = tableCaretX(row, 4, 1, '');
    const x2 = tableCaretX(row, 4, 1, 'ab');
    expect(x2).toBeGreaterThan(x0);
    expect(tableHit(row, 4, x2 + 1, ['', 'ab', ''])).toEqual({ cell: 1, char: 2 });
    expect(tableHit(row, 4, 9999, ['', '', 'xyz']).cell).toBe(2);
  });

  it('recognises taps on a checklist box', () => {
    const line = { words: ['todo'], indent: 28, justify: false, block: 0, firstWord: 0, marker: 'check' as const };
    const boxX = LAYOUT.inner + 28 - 15;
    expect(onCheckbox(line, 4, boxX)).toBe(true);
    expect(onCheckbox(line, 4, boxX + 60)).toBe(false);
    expect(onCheckbox({ ...line, marker: undefined }, 4, boxX)).toBe(false);
  });
});
