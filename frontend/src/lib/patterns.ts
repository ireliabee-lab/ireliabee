/**
 * Generative stipple patterns — fields of dots that follow a flow, gather in
 * clusters or drift along arcs, like hand-stippled prints. Each pattern is an
 * SVG of plain circles used as a CSS *mask*, so the dots always take the
 * current theme's colour (--pattern-rgb) and no image files are shipped.
 *
 * Generation is seeded: the same style always draws the same picture.
 */

export type PatternStyle = "flow" | "clusters" | "drift";

interface Dot { x: number; y: number; r: number; }

const W = 1200;
const H = 640;

function rng(seed: number) {
  // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rejects dots that would overlap ones already placed (grid-bucketed). */
class Spacer {
  private cells = new Map<string, Dot[]>();
  constructor(private cell: number) {}
  private key(x: number, y: number) { return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`; }
  fits(d: Dot, gap: number) {
    const cx = Math.floor(d.x / this.cell), cy = Math.floor(d.y / this.cell);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const o of this.cells.get(`${cx + i},${cy + j}`) ?? []) {
        const min = d.r + o.r + gap;
        if ((d.x - o.x) ** 2 + (d.y - o.y) ** 2 < min * min) return false;
      }
    }
    return true;
  }
  add(d: Dot) {
    const k = this.key(d.x, d.y);
    const list = this.cells.get(k);
    if (list) list.push(d); else this.cells.set(k, [d]);
  }
}

const smooth = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Streamlines through a swirling field, dense on the right and fading left (the middle print). */
function flow(rand: () => number): Dot[] {
  const dots: Dot[] = [];
  const sp = new Spacer(12);
  const cx = W * 0.78, cy = H * 0.42;
  const angle = (x: number, y: number) => {
    const dx = x - cx, dy = y - cy;
    const swirl = Math.atan2(dy, dx) + Math.PI / 2;
    const wave = Math.sin(x * 0.006 + y * 0.004) * 0.9 + Math.cos(y * 0.007 - x * 0.002) * 0.6;
    const d = Math.hypot(dx, dy);
    const w = Math.exp(-d / 360);
    return swirl * w + wave * (1 - w);
  };
  const density = (x: number, y: number) =>
    smooth(0.1, 0.75, x / W) * (0.55 + 0.45 * smooth(H * 1.05, H * 0.1, Math.abs(y - cy) * 1.6));
  for (let gy = 0; gy < H; gy += 16) {
    for (let gx = 0; gx < W; gx += 16) {
      let x = gx + rand() * 16, y = gy + rand() * 16;
      for (let step = 0; step < 26; step++) {
        const p = density(x, y);
        if (x < 0 || y < 0 || x > W || y > H) break;
        if (rand() < p) {
          const d = { x, y, r: 1.1 + p * 1.5 };
          if (sp.fits(d, 4.2)) { sp.add(d); dots.push(d); } else break;
        }
        const a = angle(x, y);
        x += Math.cos(a) * 9; y += Math.sin(a) * 9;
      }
    }
  }
  return dots;
}

/** Dense blobs of larger dots with scattered outskirts (the left print). */
function clusters(rand: () => number): Dot[] {
  const dots: Dot[] = [];
  const sp = new Spacer(14);
  const blobs = [
    { x: W * 0.62, y: H * 0.3, s: 95 },
    { x: W * 0.9, y: H * 0.22, s: 120 },
    { x: W * 0.8, y: H * 0.8, s: 140 },
    { x: W * 0.97, y: H * 0.62, s: 80 },
  ];
  const gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  for (let i = 0; i < 9000 && dots.length < 1900; i++) {
    const b = blobs[Math.floor(rand() * blobs.length)];
    const ox = gauss() * b.s, oy = gauss() * b.s;
    const core = Math.exp(-(ox * ox + oy * oy) / (2 * b.s * b.s));
    const d = { x: b.x + ox, y: b.y + oy, r: 1 + core * 3.2 * (0.7 + rand() * 0.5) };
    if (d.x < 0 || d.y < 0 || d.x > W || d.y > H) continue;
    if (sp.fits(d, 0.6 + (1 - core) * 3)) { sp.add(d); dots.push(d); }
  }
  return dots;
}

/** Sparse dots strung along wide arcs, thinning towards one corner (the right print). */
function drift(rand: () => number): Dot[] {
  const dots: Dot[] = [];
  const sp = new Spacer(16);
  const ox = W * 1.15, oy = -H * 0.35;
  for (let ring = 0; ring < 60; ring++) {
    const R = 260 + ring * 17 + rand() * 6;
    for (let a = Math.PI * 0.45; a < Math.PI * 1.05; a += 13 / R) {
      const x = ox + Math.cos(a) * R + (rand() - 0.5) * 5;
      const y = oy + Math.sin(a) * R + (rand() - 0.5) * 5;
      if (x < 0 || y < 0 || x > W || y > H) continue;
      const keep = smooth(0.05, 0.9, x / W) * smooth(H * 1.1, H * 0.2, y) * 0.95;
      if (rand() > keep) continue;
      const d = { x, y, r: 1.5 + rand() * 0.9 };
      if (sp.fits(d, 5)) { sp.add(d); dots.push(d); }
    }
  }
  return dots;
}

const GENERATORS: Record<PatternStyle, (r: () => number) => Dot[]> = { flow, clusters, drift };
const SEEDS: Record<PatternStyle, number> = { flow: 20260919, clusters: 7331, drift: 4242 };

export function patternDots(style: PatternStyle): Dot[] {
  return GENERATORS[style](rng(SEEDS[style]));
}

export function patternSvg(style: PatternStyle): string {
  const circles = patternDots(style)
    .map(d => `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(2)}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${circles}</svg>`;
}

const cache = new Map<PatternStyle, string>();

/** `url("data:…")` for use in CSS (mask-image). */
export function patternUrl(style: PatternStyle): string {
  let url = cache.get(style);
  if (!url) {
    url = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(patternSvg(style))}")`;
    cache.set(style, url);
  }
  return url;
}
