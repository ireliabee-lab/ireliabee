/**
 * `measureText` is the hot path of live typesetting. Words repeat constantly
 * ("the", "and", "she"), so each (font, word) pair is measured once and cached.
 * Line widths are then sums of cached word widths plus spaces, which turns
 * re-wrapping a paragraph into simple arithmetic.
 */

export interface TextMeasurer {
  width(text: string, font: string): number;
  /** Entries currently cached. */
  readonly size: number;
  readonly hits: number;
  readonly misses: number;
  clear(): void;
}

type MeasureContext = Pick<CanvasRenderingContext2D, 'font' | 'measureText'>;

export function createMeasurer(ctx: MeasureContext, limit = 20_000): TextMeasurer {
  const cache = new Map<string, number>();
  let currentFont = '';
  let hits = 0;
  let misses = 0;

  return {
    width(text: string, font: string): number {
      const key = `${font}\u0000${text}`;
      const cached = cache.get(key);
      if (cached !== undefined) {
        hits++;
        return cached;
      }
      misses++;
      // Assigning ctx.font re-parses the font string, so only do it on change.
      if (currentFont !== font) {
        ctx.font = font;
        currentFont = font;
      }
      const w = ctx.measureText(text).width;
      if (cache.size >= limit) cache.clear();
      cache.set(key, w);
      return w;
    },
    get size() {
      return cache.size;
    },
    get hits() {
      return hits;
    },
    get misses() {
      return misses;
    },
    clear(): void {
      cache.clear();
      currentFont = '';
    },
  };
}

let shared: TextMeasurer | null = null;

/** A page-wide measurer backed by an offscreen canvas (null outside the browser). */
export function sharedMeasurer(): TextMeasurer | null {
  if (shared) return shared;
  if (typeof document === 'undefined') return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  shared = createMeasurer(ctx);
  return shared;
}
