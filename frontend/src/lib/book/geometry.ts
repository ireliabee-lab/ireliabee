/**
 * Pure 2D geometry for a paper page fold.
 *
 * A page turn is modelled the way a sheet of paper physically folds: the
 * grabbed corner C is carried to the pointer P, so the fold line is the
 * perpendicular bisector of C and P. Everything on C's side of that line is
 * lifted and mirrored across it; everything else stays flat on the book.
 */

export interface Vec {
  readonly x: number;
  readonly y: number;
}

/** Canvas-style affine matrix [a, b, c, d, e, f]: x' = ax + cy + e, y' = bx + dy + f */
export type Matrix = readonly [number, number, number, number, number, number];

export interface Fold {
  /** A point on the fold line (midpoint of corner and pointer). */
  readonly mid: Vec;
  /** Unit normal pointing from the pointer towards the lifted corner. */
  readonly normal: Vec;
}

export const vec = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
export const length = (a: Vec): number => Math.hypot(a.x, a.y);
export const distance = (a: Vec, b: Vec): number => length(sub(a, b));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpVec = (a: Vec, b: Vec, t: number): Vec => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * clamp(t, 0, 1)) - 1) / 2;

const EPSILON = 1e-6;

/** Fold line for a corner carried to a pointer, or null when they coincide. */
export function computeFold(corner: Vec, pointer: Vec): Fold | null {
  const d = sub(corner, pointer);
  const len = length(d);
  if (len < EPSILON) return null;
  return { mid: scale(add(corner, pointer), 0.5), normal: scale(d, 1 / len) };
}

/** Positive on the lifted (corner) side of the fold, negative on the flat side. */
export function signedDistance(p: Vec, fold: Fold): number {
  return dot(sub(p, fold.mid), fold.normal);
}

export function reflectPoint(p: Vec, fold: Fold): Vec {
  const d = signedDistance(p, fold);
  return sub(p, scale(fold.normal, 2 * d));
}

/**
 * Sutherland–Hodgman clip of a convex polygon against one side of the fold.
 * `side` = 1 keeps the lifted part, -1 keeps the flat part.
 */
export function clipPolygon(polygon: readonly Vec[], fold: Fold, side: 1 | -1): Vec[] {
  const out: Vec[] = [];
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const current = polygon[i] as Vec;
    const next = polygon[(i + 1) % n] as Vec;
    const dc = side * signedDistance(current, fold);
    const dn = side * signedDistance(next, fold);
    if (dc >= 0) out.push(current);
    if ((dc >= 0) !== (dn >= 0)) {
      const t = dc / (dc - dn);
      out.push(lerpVec(current, next, t));
    }
  }
  return out;
}

export function rectPolygon(x: number, y: number, w: number, h: number): Vec[] {
  return [vec(x, y), vec(x + w, y), vec(x + w, y + h), vec(x, y + h)];
}

/**
 * Keeps the pointer where a real sheet could reach without tearing from the
 * spine: both spine endpoints must stay on the flat side of the fold, i.e.
 * no closer to the corner than to the pointer.
 */
export function constrainPointer(pointer: Vec, corner: Vec, spineTop: Vec, spineBottom: Vec): Vec {
  let p = pointer;
  for (let pass = 0; pass < 4; pass++) {
    for (const anchor of [spineTop, spineBottom]) {
      const radius = distance(corner, anchor);
      const d = distance(p, anchor);
      if (d > radius && d > EPSILON) {
        p = add(anchor, scale(sub(p, anchor), radius / d));
      }
    }
  }
  return p;
}

/** Reflection across the fold line as an affine matrix. */
export function reflectionMatrix(fold: Fold): Matrix {
  const { x: nx, y: ny } = fold.normal;
  const k = dot(fold.mid, fold.normal);
  return [1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * ny, 1 - 2 * ny * ny, 2 * nx * k, 2 * ny * k];
}

/** Horizontal mirror about the vertical line x = axisX (the book's spine). */
export function mirrorXMatrix(axisX: number): Matrix {
  return [-1, 0, 0, 1, 2 * axisX, 0];
}

/** Composition m1 ∘ m2 — applies m2 first, then m1. */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function applyMatrix(m: Matrix, p: Vec): Vec {
  const [a, b, c, d, e, f] = m;
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}

/** How far a turn has travelled from its corner (0) to its landing point (1). */
export function flipProgress(corner: Vec, pointer: Vec, target: Vec): number {
  const span = corner.x - target.x;
  if (Math.abs(span) < EPSILON) return 0;
  return clamp((corner.x - pointer.x) / span, 0, 1);
}

/** Largest distance from the fold line among polygon vertices. */
export function maxFoldDistance(polygon: readonly Vec[], fold: Fold): number {
  return polygon.reduce((m, p) => Math.max(m, Math.abs(signedDistance(p, fold))), 0);
}
