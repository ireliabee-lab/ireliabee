// @vitest-environment jsdom
import "./setup";
import { describe, expect, it, vi } from 'vitest';
import { createMeasurer, sharedMeasurer } from '../measure';

function fakeCtx() {
  const ctx = { font: '', measureText: vi.fn((t: string) => ({ width: t.length * 7 }) as TextMetrics) };
  const fontSets = vi.fn();
  let font = '';
  Object.defineProperty(ctx, 'font', {
    get: () => font,
    set: (v: string) => {
      fontSets(v);
      font = v;
    },
  });
  return { ctx, fontSets };
}

describe('createMeasurer', () => {
  it('measures each word once per font', () => {
    const { ctx } = fakeCtx();
    const m = createMeasurer(ctx);
    expect(m.width('rain', '19px serif')).toBe(28);
    expect(m.width('rain', '19px serif')).toBe(28);
    expect(m.width('rain', 'italic 19px serif')).toBe(28);
    expect(ctx.measureText).toHaveBeenCalledTimes(2);
    expect(m.hits).toBe(1);
    expect(m.misses).toBe(2);
    expect(m.size).toBe(2);
  });

  it('only reassigns the font when it changes', () => {
    const { ctx, fontSets } = fakeCtx();
    const m = createMeasurer(ctx);
    m.width('a', 'f1');
    m.width('b', 'f1');
    m.width('c', 'f2');
    expect(fontSets).toHaveBeenCalledTimes(2);
  });

  it('bounds its memory and can be cleared', () => {
    const { ctx } = fakeCtx();
    const m = createMeasurer(ctx, 3);
    ['a', 'b', 'c', 'd'].forEach((w) => m.width(w, 'f'));
    expect(m.size).toBe(1);
    m.clear();
    expect(m.size).toBe(0);
  });

  it('provides a shared browser measurer', () => {
    const shared = sharedMeasurer();
    expect(shared).not.toBeNull();
    expect(sharedMeasurer()).toBe(shared);
  });
});
