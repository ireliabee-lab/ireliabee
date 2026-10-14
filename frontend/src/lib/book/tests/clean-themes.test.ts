// @vitest-environment jsdom
import "./setup";
import { afterEach, describe, expect, it } from 'vitest';
import { themeById } from '../themes';
import { applyPageTheme, LAYOUT, paintPage, SCREEN_PX, setTextSize } from '../pages';
import { sampleContent } from './helpers';

type MockCtx = CanvasRenderingContext2D & { __getEvents(): { type: string; props: Record<string, unknown> }[] };

afterEach(() => { applyPageTheme(themeById('classic')); setTextSize('m'); });

describe('the Clean themes (the app\'s own look)', () => {
  it('draw a section title upright and semibold on the left, not the book\'s centred italic', () => {
    applyPageTheme(themeById('cleandark'));
    const ctx = document.createElement('canvas').getContext('2d') as MockCtx;
    const content = { ...sampleContent(1), chapter: { numeral: '', title: 'Three Research Aims', block: 0 } };
    paintPage(ctx, { kind: 'text', content, folio: 3 }, 2);
    const events = ctx.__getEvents();
    const title = events.findIndex((e) => e.type === 'fillText' && e.props.text === 'Three Research Aims');
    expect(title).toBeGreaterThan(-1);
    const fontBefore = events.slice(0, title).reverse().find((e) => e.type === 'font');
    expect(String(fontBefore?.props.value ?? '')).not.toMatch(/italic/);
    expect(String(fontBefore?.props.value ?? '')).toMatch(/600/);
  });

  it('have an extra-small text size to match the app\'s cards', () => {
    setTextSize('xs');
    expect(LAYOUT.bodySize).toBe(14);
  });

  it("size their text in pixels on screen, so Extra small is the sidebar's 13 px however big the book is drawn", () => {
    for (const scale of [0.7, 1, 1.4]) {
      setTextSize('xs', scale);
      expect(LAYOUT.bodySize * scale).toBeCloseTo(SCREEN_PX.xs, 0);
      expect(LAYOUT.lineHeight).toBeCloseTo(LAYOUT.bodySize * 1.6, 0);
    }
    setTextSize('xs');
    expect(LAYOUT.bodySize).toBe(14);                                  // other papers keep page units
  });
});
