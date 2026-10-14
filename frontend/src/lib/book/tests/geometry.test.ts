// @vitest-environment jsdom
import "./setup";
import { describe, expect, it } from 'vitest';
import {
  applyMatrix,
  clipPolygon,
  computeFold,
  constrainPointer,
  distance,
  easeInOutSine,
  easeOutCubic,
  flipProgress,
  maxFoldDistance,
  mirrorXMatrix,
  multiply,
  rectPolygon,
  reflectionMatrix,
  reflectPoint,
  signedDistance,
  vec,
  type Fold,
} from '../geometry';

const close = (a: { x: number; y: number }, b: { x: number; y: number }): void => {
  expect(a.x).toBeCloseTo(b.x, 6);
  expect(a.y).toBeCloseTo(b.y, 6);
};

describe('computeFold', () => {
  it('returns null when the corner has not moved', () => {
    expect(computeFold(vec(10, 10), vec(10, 10))).toBeNull();
  });

  it('places the fold on the perpendicular bisector of corner and pointer', () => {
    const fold = computeFold(vec(200, 100), vec(100, 100)) as Fold;
    close(fold.mid, vec(150, 100));
    close(fold.normal, vec(1, 0));
    expect(signedDistance(vec(200, 0), fold)).toBeGreaterThan(0);
    expect(signedDistance(vec(0, 0), fold)).toBeLessThan(0);
  });
});

describe('reflection', () => {
  const fold = computeFold(vec(200, 300), vec(40, 120)) as Fold;

  it('carries the corner exactly onto the pointer', () => {
    close(reflectPoint(vec(200, 300), fold), vec(40, 120));
  });

  it('agrees with the affine reflection matrix', () => {
    const m = reflectionMatrix(fold);
    for (const p of [vec(0, 0), vec(123, 45), vec(-30, 400)]) close(applyMatrix(m, p), reflectPoint(p, fold));
  });

  it('mirrors about the spine and composes transforms in order', () => {
    close(applyMatrix(mirrorXMatrix(100), vec(130, 7)), vec(70, 7));
    const both = multiply(reflectionMatrix(fold), mirrorXMatrix(100));
    const p = vec(30, 60);
    close(applyMatrix(both, p), reflectPoint(applyMatrix(mirrorXMatrix(100), p), fold));
  });
});

describe('clipPolygon', () => {
  const page = rectPolygon(100, 0, 100, 200);

  it('splits a page into lifted and flat parts along a vertical fold', () => {
    const fold = computeFold(vec(200, 100), vec(100, 100)) as Fold; // fold at x = 150
    const lifted = clipPolygon(page, fold, 1);
    const flat = clipPolygon(page, fold, -1);
    expect(Math.min(...lifted.map((p) => p.x))).toBeCloseTo(150);
    expect(Math.max(...flat.map((p) => p.x))).toBeCloseTo(150);
    expect(maxFoldDistance(lifted, fold)).toBeCloseTo(50);
  });

  it('keeps everything or nothing when the fold misses the page', () => {
    const fold = computeFold(vec(400, 100), vec(380, 100)) as Fold; // fold at x = 390
    expect(clipPolygon(page, fold, -1)).toHaveLength(4);
    expect(clipPolygon(page, fold, 1)).toHaveLength(0);
  });

  it('cuts a triangle off a corner for a diagonal fold', () => {
    const fold = computeFold(vec(200, 200), vec(180, 180)) as Fold;
    expect(clipPolygon(page, fold, 1)).toHaveLength(3);
    expect(clipPolygon(page, fold, -1)).toHaveLength(5);
  });
});

describe('constrainPointer', () => {
  const W = 100;
  const H = 150;
  const corner = vec(2 * W, H);
  const top = vec(W, 0);
  const bottom = vec(W, H);

  it('leaves reachable positions alone', () => {
    close(constrainPointer(vec(150, 120), corner, top, bottom), vec(150, 120));
  });

  it('never lets the page tear away from the spine', () => {
    for (const p of [vec(-300, 900), vec(500, -400), vec(0, 400), vec(-50, -50)]) {
      const c = constrainPointer(p, corner, top, bottom);
      expect(distance(c, bottom)).toBeLessThanOrEqual(distance(corner, bottom) + 1e-6);
      expect(distance(c, top)).toBeLessThanOrEqual(distance(corner, top) + 1e-6);
    }
  });
});

describe('easing and progress', () => {
  it('eases from 0 to 1 and clamps', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeInOutSine(0.5)).toBeCloseTo(0.5);
    expect(easeInOutSine(-1)).toBeCloseTo(0);
  });

  it('measures progress from corner to landing point', () => {
    expect(flipProgress(vec(200, 0), vec(200, 0), vec(0, 0))).toBe(0);
    expect(flipProgress(vec(200, 0), vec(100, 50), vec(0, 0))).toBeCloseTo(0.5);
    expect(flipProgress(vec(0, 0), vec(250, 0), vec(200, 0))).toBe(1);
    expect(flipProgress(vec(5, 0), vec(5, 0), vec(5, 0))).toBe(0);
  });
});
