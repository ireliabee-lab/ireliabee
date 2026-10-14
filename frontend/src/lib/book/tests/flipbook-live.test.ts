// @vitest-environment jsdom
import "./setup";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assemblePages } from '../book';
import { FlipBook } from '../flipbook';
import { pointer, sampleContent, samplePages } from './helpers';

const VIEW_W = 1000;
const VIEW_H = 700;

function setup(onTap = vi.fn()) {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const paint = vi.fn();
  const onChange = vi.fn();
  const book = new FlipBook({ canvas, pages: samplePages(), paint, onChange, onTap, duration: 600 });
  book.resize(VIEW_W, VIEW_H, 1);
  const { width: W, height: H } = book.pageSize;
  const at = (bx: number, by: number): [number, number] => {
    const offset = book.spread === 0 ? -W / 2 : book.spread === book.lastSpread ? W / 2 : 0;
    return [(VIEW_W - 2 * W) / 2 + offset + bx, (VIEW_H - H) / 2 + by];
  };
  book.jumpTo(2);
  paint.mockClear();
  onChange.mockClear();
  return { canvas, book, paint, onChange, onTap, W, H, at };
}

const paintedIndices = (paint: ReturnType<typeof vi.fn>): number[] => paint.mock.calls.map((c) => c[2] as number);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('FlipBook live updates', () => {
  it('jumps between spreads without animating', () => {
    const { book, onChange } = setup();
    book.jumpTo(4);
    expect(book.spread).toBe(4);
    expect(book.isTurning).toBe(false);
    expect(onChange).toHaveBeenCalledWith(4);
    book.jumpTo(99);
    expect(book.spread).toBe(book.lastSpread);
  });

  it('repaints only the changed pages that are on screen, reusing their bitmaps', () => {
    const { book, paint } = setup();
    const pages = samplePages();
    book.setPages(pages, [4]);
    expect(paintedIndices(paint)).toEqual([4]);
    paint.mockClear();
    book.setPages(pages, [7]); // off-screen and never painted: stays lazy
    expect(paintedIndices(paint)).toEqual([]);
  });

  it('pre-paints neighbouring spreads while idle', () => {
    const { paint } = setup();
    vi.advanceTimersByTime(1000);
    expect(paintedIndices(paint)).toEqual(expect.arrayContaining([1, 2, 5, 6]));
  });

  it('holds updates until a turn lands', () => {
    const { book, paint } = setup();
    book.next();
    vi.advanceTimersByTime(100);
    paint.mockClear();
    const longer = assemblePages([0, 1, 2, 3, 1, 2].map(sampleContent));
    book.setPages(longer, [3, 4]);
    book.setPages(longer, [5]);
    expect(book.pageCount).toBe(10);
    vi.advanceTimersByTime(1000);
    expect(book.spread).toBe(3);
    expect(book.pageCount).toBe(12);
  });

  it('clamps the spread when the book gets shorter', () => {
    const { book, onChange } = setup();
    book.jumpTo(book.lastSpread);
    const shorter = assemblePages([sampleContent(0)]);
    book.setPages(shorter);
    expect(book.spread).toBe(book.lastSpread);
    expect(onChange).toHaveBeenLastCalledWith(book.lastSpread);
  });

  it('applies held updates when jumping mid-turn', () => {
    const { book } = setup();
    book.next();
    vi.advanceTimersByTime(100);
    book.setPages(assemblePages([0, 1, 2, 3, 1, 2].map(sampleContent)));
    book.jumpTo(1);
    expect(book.pageCount).toBe(12);
    expect(book.isTurning).toBe(false);
  });

  it('rejects odd page lists', () => {
    const { book } = setup();
    expect(() => book.setPages(samplePages().slice(1))).toThrow(/even/);
  });

  it('hit-tests points in logical page units', () => {
    const { book, W, H, at } = setup();
    const right = book.hitTest(...at(1.5 * W, H / 2));
    expect(right).toEqual({ index: 4, x: expect.closeTo(250, 3), y: expect.closeTo(350, 3) });
    expect(book.hitTest(...at(0.25 * W, H / 4))?.index).toBe(3);
    expect(book.hitTest(...at(W, H + 20))).toBeNull();
    book.jumpTo(0);
    expect(book.hitTest(...at(0.5 * W, H / 2))).toBeNull(); // no page left of the closed cover
  });

  it('hit-tests the point under the pointer when the app is zoomed (Settings, CSS zoom)', () => {
    const { book, canvas, W, H, at } = setup();
    const zoom = 0.92;
    Object.defineProperty(canvas, 'offsetWidth', { configurable: true, value: VIEW_W });
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: VIEW_W * zoom, height: VIEW_H * zoom } as DOMRect);
    const [x, y] = at(1.5 * W, H * 0.9);
    // Where the pointer is on screen: the zoomed canvas, shifted to its rect.
    const hit = book.hitTest(10 + x * zoom, 20 + y * zoom);
    // The same page point as unzoomed, in logical page units (a 500 × 700 page): not a line above it.
    expect(hit).toEqual({ index: 4, x: expect.closeTo(250, 3), y: expect.closeTo(630, 3) });
  });

  it('reports taps instead of turning when tapToTurn is off', () => {
    const { book, canvas, W, H, at, onTap } = setup();
    book.tapToTurn = false;
    const [x, y] = at(1.4 * W, H / 3);
    canvas.dispatchEvent(pointer('pointerdown', x, y));
    canvas.dispatchEvent(pointer('pointerup', x, y));
    vi.advanceTimersByTime(1000);
    expect(book.spread).toBe(2);
    expect(onTap).toHaveBeenCalledWith(expect.objectContaining({ index: 4 }));
  });

  it('draws a line marker only while the book is at rest', () => {
    const { book, canvas } = setup();
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D & {
      __clearDrawCalls(): void;
      __getDrawCalls(): { type: string }[];
    };
    const fillRects = (): number => ctx.__getDrawCalls().filter((c) => c.type === 'fillRect').length;
    ctx.__clearDrawCalls();
    book.setMarker({ page: 4, x: 60, y: 100, w: 390, h: 29 });
    const withMarker = fillRects();
    ctx.__clearDrawCalls();
    book.setMarker(null);
    expect(withMarker - fillRects()).toBe(2); // highlight band + margin bar
    book.setMarker({ page: 4, x: 60, y: 100, w: 390, h: 29 });
    ctx.__clearDrawCalls();
    book.setMarker({ page: 4, x: 60, y: 100, w: 390, h: 29 }); // unchanged: no redraw
    expect(ctx.__getDrawCalls()).toHaveLength(0);
    book.setMarker({ page: 9, x: 0, y: 0, w: 10, h: 10 }); // off-screen page: nothing drawn for it
    book.setMarker(null);
    book.setPages(assemblePages([sampleContent(0)]));
  });
});

describe('FlipBook sharpness', () => {
  it('lays pages out on whole device pixels, and paints at the size the canvas shows at when the app is zoomed', () => {
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    Object.defineProperty(canvas, 'offsetWidth', { configurable: true, value: 1459 });
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1459 * 0.92, height: 1245 * 0.92 } as DOMRect);
    const book = new FlipBook({ canvas, pages: samplePages(), paint: vi.fn(), onChange: vi.fn(), duration: 600 });
    book.resize(1459, 1245, 2);
    const dpr = 2 * 0.92;
    const { width, height } = book.pageSize;
    expect(Math.abs(width * dpr - Math.round(width * dpr))).toBeLessThan(1e-6);
    expect(Math.abs(height * dpr - Math.round(height * dpr))).toBeLessThan(1e-6);
    expect(canvas.width).toBe(Math.round(1459 * dpr));                 // the bitmap is the size shown, not laid out
  });
});
