// @vitest-environment jsdom
import "./setup";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlipBook, type FlipBookOptions } from '../flipbook';
import { pointer, samplePages } from './helpers';

const VIEW_W = 1000;
const VIEW_H = 700;

function setup(overrides: Partial<FlipBookOptions> = {}) {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const onChange = vi.fn();
  const onTurn = vi.fn();
  const book = new FlipBook({ canvas, pages: samplePages(), onChange, onTurn, duration: 600, ...overrides });
  book.resize(VIEW_W, VIEW_H, 1);
  const { width: W, height: H } = book.pageSize;
  const padY = (VIEW_H - H) / 2;
  /** Client coordinates of a point in book space for the current spread. */
  const at = (bx: number, by: number): [number, number] => {
    const offset = book.spread === 0 ? -W / 2 : book.spread === book.lastSpread ? W / 2 : 0;
    return [(VIEW_W - 2 * W) / 2 + offset + bx, padY + by];
  };
  const drag = (from: [number, number], to: [number, number], steps = 10, msPerStep = 16): void => {
    canvas.dispatchEvent(pointer('pointerdown', ...from));
    for (let i = 1; i <= steps; i++) {
      vi.advanceTimersByTime(msPerStep);
      const x = from[0] + ((to[0] - from[0]) * i) / steps;
      const y = from[1] + ((to[1] - from[1]) * i) / steps;
      canvas.dispatchEvent(pointer('pointermove', x, y));
    }
    canvas.dispatchEvent(pointer('pointerup', ...to));
  };
  return { canvas, book, onChange, onTurn, W, H, at, drag };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('FlipBook', () => {
  it('rejects books with an odd number of pages', () => {
    const canvas = document.createElement('canvas');
    expect(() => new FlipBook({ canvas, pages: samplePages().slice(1) })).toThrow(/even number/);
  });

  it('opens closed on the front cover', () => {
    const { book } = setup();
    expect(book.spread).toBe(0);
    expect(book.visiblePages()).toEqual({ left: null, right: 0 });
    expect(book.canTurn(-1)).toBe(false);
    expect(book.canTurn(1)).toBe(true);
    expect(book.lastSpread).toBe(5);
  });

  it('animates next() and prev() before changing spread', () => {
    const { book, onChange, onTurn } = setup();
    expect(book.next()).toBe(true);
    expect(onTurn).toHaveBeenCalledWith(1);
    expect(book.isTurning).toBe(true);
    vi.advanceTimersByTime(300);
    expect(book.spread).toBe(0);
    vi.advanceTimersByTime(400);
    expect(book.spread).toBe(1);
    expect(onChange).toHaveBeenLastCalledWith(1);
    book.prev();
    vi.advanceTimersByTime(700);
    expect(book.spread).toBe(0);
    expect(book.prev()).toBe(false);
  });

  it('queues rapid requests and plays them in order', () => {
    const { book } = setup();
    book.next();
    book.next();
    book.next();
    vi.advanceTimersByTime(3000);
    expect(book.spread).toBe(3);
  });

  it('goTo turns page by page and stops at the ends', () => {
    const { book } = setup();
    book.goTo(99);
    vi.advanceTimersByTime(10_000);
    expect(book.spread).toBe(book.lastSpread);
    expect(book.visiblePages()).toEqual({ left: 9, right: null });
    expect(book.next()).toBe(false);
    book.goTo(2);
    vi.advanceTimersByTime(10_000);
    expect(book.spread).toBe(2);
  });

  it('turns instantly with reduced motion', () => {
    const { book } = setup({ reducedMotion: true });
    book.next();
    expect(book.spread).toBe(1);
    expect(book.isTurning).toBe(false);
  });

  describe('dragging', () => {
    const openAt = (spread: number) => {
      const ctx = setup();
      ctx.book.goTo(spread);
      vi.advanceTimersByTime(10_000);
      return ctx;
    };

    it('turns forward when a corner is dragged across the spine', () => {
      const { book, W, H, at, drag, onTurn } = openAt(2);
      drag(at(2 * W - 4, H - 4), at(W * 0.4, H * 0.7));
      expect(book.isTurning).toBe(true);
      expect(onTurn).toHaveBeenLastCalledWith(1);
      vi.advanceTimersByTime(1000);
      expect(book.spread).toBe(3);
    });

    it('falls back when released before the spine', () => {
      const { book, W, H, at, drag } = openAt(2);
      drag(at(2 * W - 4, 4), at(W * 1.7, H * 0.2), 10, 60);
      vi.advanceTimersByTime(1000);
      expect(book.spread).toBe(2);
      expect(book.isTurning).toBe(false);
    });

    it('turns on a fast flick even without crossing the spine', () => {
      const { book, W, H, at, drag } = openAt(2);
      drag(at(1.9 * W, H / 2), at(1.6 * W, H / 2), 4, 8);
      vi.advanceTimersByTime(1000);
      expect(book.spread).toBe(3);
    });

    it('turns backward from the left page', () => {
      const { book, W, H, at, drag } = openAt(2);
      drag(at(4, H - 4), at(W * 1.6, H * 0.8));
      vi.advanceTimersByTime(1000);
      expect(book.spread).toBe(1);
    });

    it('turns when a page is tapped', () => {
      const { book, canvas, W, H, at } = openAt(2);
      const [x, y] = at(1.8 * W, H / 2);
      canvas.dispatchEvent(pointer('pointerdown', x, y));
      canvas.dispatchEvent(pointer('pointerup', x + 1, y));
      vi.advanceTimersByTime(1000);
      expect(book.spread).toBe(3);
    });

    it('drags the hard front cover open', () => {
      const { book, W, H, at, drag } = setup();
      drag(at(2 * W - 4, H - 4), at(0, H - 4));
      vi.advanceTimersByTime(1000);
      expect(book.spread).toBe(1);
    });

    it('returns the page when the pointer is cancelled', () => {
      const { book, canvas, W, H, at } = openAt(2);
      canvas.dispatchEvent(pointer('pointerdown', ...at(2 * W - 4, H - 4)));
      canvas.dispatchEvent(pointer('pointermove', ...at(W * 0.5, H / 2)));
      canvas.dispatchEvent(new Event('pointercancel'));
      vi.advanceTimersByTime(1000);
      expect(book.spread).toBe(2);
    });

    it('ignores presses outside the pages and with other buttons', () => {
      const { book, canvas, W, H, at } = openAt(2);
      canvas.dispatchEvent(pointer('pointerdown', ...at(W, H + 40)));
      canvas.dispatchEvent(pointer('pointerdown', ...at(1.5 * W, H / 2), { button: 2 }));
      expect(book.isTurning).toBe(false);
      canvas.dispatchEvent(pointer('pointerup', ...at(1.5 * W, H / 2)));
      expect(book.spread).toBe(2);
    });
  });

  it('peeks a corner on hover and lays it back down on leave', () => {
    const { book, canvas, W, H, at } = setup();
    book.goTo(2);
    vi.advanceTimersByTime(10_000);
    canvas.dispatchEvent(pointer('pointermove', ...at(2 * W - 10, H - 10)));
    vi.advanceTimersByTime(200);
    expect(book.isTurning).toBe(false); // a peek is not a turn
    canvas.dispatchEvent(pointer('pointermove', ...at(10, 10)));
    vi.advanceTimersByTime(200);
    canvas.dispatchEvent(pointer('pointermove', ...at(W, H / 2)));
    canvas.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(1000);
    // A press on a peeking corner becomes a drag.
    canvas.dispatchEvent(pointer('pointermove', ...at(2 * W - 10, H - 10)));
    vi.advanceTimersByTime(100);
    canvas.dispatchEvent(pointer('pointerdown', ...at(2 * W - 10, H - 10)));
    expect(book.isTurning).toBe(true);
    canvas.dispatchEvent(pointer('pointerup', ...at(2 * W - 10, H - 10)));
    vi.advanceTimersByTime(1000);
    expect(book.spread).toBe(3);
  });

  it('draws with shadows, clips and the mirrored back of the page mid-turn', () => {
    const { book, canvas } = setup();
    book.goTo(2);
    vi.advanceTimersByTime(10_000);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D & { __clearDrawCalls(): void; __getDrawCalls(): unknown[] };
    ctx.__clearDrawCalls();
    book.next();
    vi.advanceTimersByTime(300);
    expect(ctx.__getDrawCalls().length).toBeGreaterThan(3);
  });

  it('resizes to fit the viewport and cleans up on destroy', () => {
    const { book, canvas } = setup();
    book.resize(400, 300, 2);
    expect(canvas.width).toBe(800);
    expect(book.pageSize.width).toBeLessThanOrEqual(200);
    book.destroy();
    canvas.dispatchEvent(pointer('pointerdown', 10, 10));
    expect(book.isTurning).toBe(false);
  });
});
