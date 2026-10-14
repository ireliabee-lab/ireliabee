// @vitest-environment jsdom
import "../setup";
import { afterEach, describe, expect, it } from 'vitest';
import { assembleDiary, BLANK_PAGES_AHEAD, DIARY_NAME, paintDiaryPage } from '../../diary/pages';
import type { PageSpec } from '../../book';
import { sampleContent } from '../helpers';

type MockCtx = CanvasRenderingContext2D & { __getEvents(): { type: string; props: Record<string, unknown> }[] };
const texts = (spec: PageSpec, index: number): string[] => {
  const ctx = document.createElement('canvas').getContext('2d') as MockCtx;
  paintDiaryPage(ctx, spec, index);
  return ctx.__getEvents().filter((e) => e.type === 'fillText').map((e) => String(e.props.text));
};

describe('assembleDiary', () => {
  it('shows a waiting first page when the diary is empty', () => {
    const pages = assembleDiary([], '');
    expect(pages.length % 2).toBe(0);
    expect(pages.some((p) => p.kind === 'custom' && p.name === 'diary-empty')).toBe(true);
    expect(pages[pages.length - 1]).toMatchObject({ kind: 'custom', name: 'diary-back' });
  });

  it('always leaves blank pages ahead of the last entry', () => {
    const pages = assembleDiary([sampleContent(1), sampleContent(2)], 'Ama');
    const lastText = pages.map((p) => p.kind).lastIndexOf('text');
    const after = pages.slice(lastText + 1).filter((p) => p.kind === 'blank');
    expect(after.length).toBeGreaterThanOrEqual(BLANK_PAGES_AHEAD);
    expect(pages.length % 2).toBe(0);
    expect(pages[2]).toMatchObject({ data: { owner: 'Ama' } });
  });
});

describe('paintDiaryPage', () => {
  it('embosses the name on the cover', () => {
    expect(texts({ kind: 'custom', name: 'diary-cover' }, 0)).toContain(DIARY_NAME);
  });

  it('writes the owner’s name, or leaves a line for it', () => {
    expect(texts({ kind: 'custom', name: 'diary-owner', data: { owner: 'Ama' } }, 2)).toContain('Ama');
    expect(texts({ kind: 'custom', name: 'diary-owner' }, 2)).not.toContain('Ama');
  });

  it('paints the other diary pages and delegates the rest', () => {
    expect(texts({ kind: 'custom', name: 'diary-empty' }, 3)).toContain('Your first page is waiting.');
    expect(() => texts({ kind: 'custom', name: 'diary-back' }, 9)).not.toThrow();
    expect(() => texts({ kind: 'custom', name: 'something-else' }, 4)).not.toThrow();
    expect(texts({ kind: 'text', content: sampleContent(1) }, 4)).toContain('Once');
  });
});

import { applyPageTheme } from '../../pages';
import { themeById } from '../../themes';

describe('covers for every theme', () => {
  afterEach(() => applyPageTheme(themeById('classic')));

  it('prints an exercise-book label with the owner and times tables on the back', () => {
    applyPageTheme(themeById('school'));
    const front = texts({ kind: 'custom', name: 'diary-cover', data: { owner: 'Ama' } }, 0);
    expect(front).toEqual(expect.arrayContaining([DIARY_NAME, 'Name', 'Class', 'Ama']));
    expect(texts({ kind: 'custom', name: 'diary-back' }, 9)).toContain('7 × 8 = 56');
  });

  it('uses cloth for the light and dot-grid looks', () => {
    for (const id of ['light', 'dotgrid'] as const) {
      applyPageTheme(themeById(id));
      expect(texts({ kind: 'custom', name: 'diary-cover' }, 0)).toContain(DIARY_NAME);
    }
  });
});

import { folioOf, FRONT_MATTER, writingPageCount } from '../../diary/pages';
import { describePage } from '../../pages';

describe('page numbers', () => {
  it('numbers writing pages from 1, leaving covers and the name page unnumbered', () => {
    const pages = assembleDiary([sampleContent(1), sampleContent(2)], 'Ama');
    expect(folioOf(pages[0])).toBeNull(); // front cover
    expect(folioOf(pages[1])).toBeNull(); // endpaper
    expect(folioOf(pages[2])).toBeNull(); // "This diary belongs to"
    expect(folioOf(pages[FRONT_MATTER])).toBe(1);
    expect(folioOf(pages[FRONT_MATTER + 1])).toBe(2);
    expect(folioOf(pages[FRONT_MATTER + 2])).toBe(3); // blank pages ahead carry on counting
    expect(folioOf(pages[pages.length - 1])).toBeNull(); // back cover
    expect(writingPageCount(pages)).toBe(pages.length - 5);
    expect(folioOf(undefined)).toBeNull();
  });

  it('prints and reads out the diary page number, not the physical position', () => {
    const pages = assembleDiary([sampleContent(1)], '');
    expect(texts(pages[FRONT_MATTER]!, FRONT_MATTER)).toContain('1');
    expect(texts(pages[FRONT_MATTER]!, FRONT_MATTER)).not.toContain('4');
    expect(describePage(pages[FRONT_MATTER]!, FRONT_MATTER)).toMatch(/^Page 1\./);
    expect(texts(pages[FRONT_MATTER + 1]!, FRONT_MATTER + 1)).toContain('2'); // numbered blank page
    const empty = assembleDiary([], '');
    expect(folioOf(empty[FRONT_MATTER])).toBe(1);
    expect(texts(empty[FRONT_MATTER]!, FRONT_MATTER)).toContain('1');
  });
});

import { fitTitle } from '../../diary/pages';

/** A stand-in canvas whose letters are half as wide as the font is tall. */
const measuring = () => {
  const ctx = { font: '', measureText: (t: string) => ({ width: t.length * (parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? '10') / 2) }) };
  return ctx as unknown as CanvasRenderingContext2D;
};

describe('the exercise-book label', () => {
  afterEach(() => applyPageTheme(themeById('classic')));

  it('keeps a short title on one line at full size', () => {
    expect(fitTitle(measuring(), 'Biology', 296)).toEqual({ size: 34, lines: ['Biology'] });
  });

  it('puts a long title on two lines inside the label, cutting only what still cannot fit', () => {
    const ctx = measuring();
    const long = fitTitle(ctx, 'Surprisal and Stuttering: Replication and Extensions in Spontaneous Speech', 296);
    expect(long.lines).toHaveLength(2);
    for (const line of long.lines) expect(line.length * (long.size / 2)).toBeLessThanOrEqual(296);
    const huge = fitTitle(ctx, 'word '.repeat(80).trim(), 296);
    expect(huge.lines).toHaveLength(2);
    expect(huge.lines[1].endsWith('…')).toBe(true);
  });

  it('writes the name, class and year it is given, and not the title in the name', () => {
    applyPageTheme(themeById('school'));
    const [cover] = assembleDiary([], 'The notes title', { title: 'Biology', label: { name: 'Ama Mensah', class: 'Form 2', year: '2026' } });
    const front = texts(cover, 0);
    expect(front).toEqual(expect.arrayContaining(['Biology', 'Ama Mensah', 'Form 2', '2026']));
    expect(front).not.toContain('The notes title');
    const [blank] = assembleDiary([], 'The notes title', { title: 'Biology', label: {} });
    expect(texts(blank, 0)).not.toContain('The notes title');
  });
});

describe('the title page', () => {
  it('puts a long notebook title on two lines at a readable size, never squeezed into one', () => {
    const ctx = document.createElement('canvas').getContext('2d') as MockCtx;
    // Letters half as wide as the type is tall, as a real font measures.
    ctx.measureText = (t: string) => ({ width: t.length * (parseFloat(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? '10') / 2) }) as TextMetrics;
    const title = 'Surprisal and Stuttering: Replication and Extensions in Spontaneous Speech';
    paintDiaryPage(ctx, { kind: 'custom', name: 'diary-owner', data: { owner: title, intro: 'Reading notes' } }, 2);
    const drawn = ctx.__getEvents().filter((e) => e.type === 'fillText');
    const parts = drawn.filter((e) => title.includes(String(e.props.text)) && String(e.props.text).length > 10);
    expect(parts.map((e) => e.props.text).join(' ')).toBe(title);
    for (const e of parts) expect(e.props.maxWidth ?? null).toBeNull();       // no horizontal squeeze
    expect(parts.length).toBe(2);
  });
});
