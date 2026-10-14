// @vitest-environment jsdom
import "./setup";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlipBook, type FlipBookOptions } from '../flipbook';
import { pointer, samplePages } from './helpers';

type DrawCtx = CanvasRenderingContext2D & { __clearDrawCalls(): void; __getDrawCalls(): { type: string; props: Record<string, unknown> }[] };

function setup(overrides: Partial<FlipBookOptions> = {}, size: [number, number] = [1000, 700]) {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const onPress = vi.fn();
  const onChange = vi.fn();
  const book = new FlipBook({ canvas, pages: samplePages(), onPress, onChange, duration: 400, ...overrides });
  book.resize(size[0], size[1], 1);
  const ctx = canvas.getContext('2d') as DrawCtx;
  return { canvas, book, onPress, onChange, ctx };
}

/** Client point for logical page coordinates on the current spread (spread view, no pan). */
function clientPoint(book: FlipBook, index: number, lx: number, ly: number, view = [1000, 700]): [number, number] {
  const { width: W, height: H } = book.pageSize;
  const offset = book.spread === 0 ? -W / 2 : book.spread === book.lastSpread ? W / 2 : 0;
  const left = (view[0]! - 2 * W) / 2 + offset + (index % 2 === 0 ? W : 0);
  return [left + (lx * W) / 500, (view[1]! - H) / 2 + (ly * H) / 700];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('writing on the page', () => {
  it('sends presses in the text area to the writer and keeps the outer edge for turning', () => {
    const { book, canvas, onPress } = setup();
    book.jumpTo(2);
    book.tapToTurn = false;
    book.grabZone = 0.12;
    const inside = clientPoint(book, 4, 250, 300);
    canvas.dispatchEvent(pointer('pointerdown', ...inside));
    canvas.dispatchEvent(pointer('pointermove', inside[0] + 30, inside[1]));
    canvas.dispatchEvent(pointer('pointerup', inside[0] + 30, inside[1]));
    expect(onPress.mock.calls.map((c) => c[0])).toEqual(['down', 'move', 'up']);
    expect(onPress.mock.calls[0]![1]).toMatchObject({ index: 4 });
    expect(book.isTurning).toBe(false);

    onPress.mockClear();
    const edge = clientPoint(book, 4, 495, 690);
    canvas.dispatchEvent(pointer('pointerdown', ...edge));
    const target = clientPoint(book, 3, 100, 600);
    for (let i = 1; i <= 10; i++) {
      vi.advanceTimersByTime(16);
      canvas.dispatchEvent(pointer('pointermove', edge[0] + ((target[0] - edge[0]) * i) / 10, edge[1] + ((target[1] - edge[1]) * i) / 10));
    }
    expect(onPress).not.toHaveBeenCalled();
    expect(book.isTurning).toBe(true);
    canvas.dispatchEvent(pointer('pointerup', ...target));
    vi.advanceTimersByTime(1000);
    expect(book.spread).toBe(3);
  });

  it('draws a blinking cursor and selection only for pages on screen', () => {
    const { book, ctx } = setup();
    book.jumpTo(2);
    const fills = () => ctx.__getDrawCalls().filter((c) => c.type === 'fillRect').length;
    ctx.__clearDrawCalls();
    book.setOverlay(null);
    const base = fills();
    ctx.__clearDrawCalls();
    book.setOverlay({ caret: { page: 4, x: 100, y: 200, h: 24 } });
    expect(fills()).toBe(base + 1);
    ctx.__clearDrawCalls();
    vi.advanceTimersByTime(540); // blink off
    expect(fills()).toBe(base);
    ctx.__clearDrawCalls();
    book.setOverlay({ selection: [{ page: 3, x: 50, y: 100, w: 200, h: 27 }, { page: 9, x: 0, y: 0, w: 1, h: 1 }] });
    expect(fills()).toBe(base + 1);
    book.setOverlay({ caret: { page: 8, x: 0, y: 0, h: 10 } });
    book.destroy();
  });
});

describe('single-page view on narrow screens', () => {
  const narrow = (): ReturnType<typeof setup> => setup({ singlePageWhenNarrow: true }, [390, 700]);

  it('shows one page at a time and pans before turning', () => {
    const { book, onChange } = narrow();
    expect(book.isSinglePage).toBe(true);
    expect(book.pageSize.width).toBeGreaterThan(300);
    book.jumpTo(2);
    expect(book.visibleSide).toBe('right');
    book.prev(); // pans to the left page, no turn
    expect(book.visibleSide).toBe('left');
    expect(book.isTurning).toBe(false);
    book.next();
    expect(book.visibleSide).toBe('right');
    onChange.mockClear();
    book.next(); // now it really turns
    vi.advanceTimersByTime(1000);
    expect(book.spread).toBe(3);
    expect(book.visibleSide).toBe('left'); // continue on the page you turned over
    book.prev(); // already on the left page, so this turns back
    vi.advanceTimersByTime(1000);
    expect(book.spread).toBe(2);
    expect(book.visibleSide).toBe('right');
  });

  it('reveals a page by turning or panning to it', () => {
    const { book } = narrow();
    book.jumpTo(2);
    book.reveal(3);
    expect(book.visibleSide).toBe('left');
    book.reveal(5); // next spread, left page: animated turn
    vi.advanceTimersByTime(1000);
    expect(book.spread).toBe(3);
    expect(book.visibleSide).toBe('left');
    book.reveal(8, false); // far away: instant
    expect(book.spread).toBe(4);
    expect(book.visibleSide).toBe('right');
    book.reveal(999);
    expect(book.spread).toBe(4);
  });

  it('zooms to full width for writing and scrolls to keep the cursor in view', () => {
    const { book } = setup({ singlePageWhenNarrow: true }, [390, 480]);
    const fitted = book.pageSize.width;
    book.setFillWidth(true);
    expect(book.pageSize.width).toBeGreaterThan(fitted);
    book.setFocusY(book.pageSize.height * 0.9);
    vi.advanceTimersByTime(500);
    book.setFocusY(null);
    book.setFillWidth(true); // no-op
    book.setFillWidth(false);
    expect(book.pageSize.width).toBe(fitted);
  });

  it('keeps the spread on wide screens even when allowed to go single', () => {
    const { book } = setup({ singlePageWhenNarrow: true }, [1000, 700]);
    expect(book.isSinglePage).toBe(false);
    book.showSide('left'); // harmless in spread view
  });
});
