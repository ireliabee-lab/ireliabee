import { BOOK_TITLE, type PageSpec } from './book';
import { sharedMeasurer } from './measure';
import { THEMES, type PageTheme } from './themes';
import type { InlineStyle } from './rich';
import { CELL_PAD, type PageContent, type Segment, type TextLine } from './typeset';

/** All page painting happens in this logical coordinate space. */
export const PAGE_W = 500;
export const PAGE_H = 700;

/**
 * Where text goes on a page. Notes, not a novel: narrower margins than the
 * Nkɔmmɔ diary, so a page holds more (owner, 27 Sep 2026). The text size can
 * change (setTextSize), and everything below follows it.
 */
export const LAYOUT = {
  top: 42,
  bottom: 50,
  inner: 40,
  outer: 30,
  bodySize: 19,
  lineHeight: 29,
  chapterLines: 2,
  indent: 26,
};

export let TEXT_WIDTH = PAGE_W - LAYOUT.inner - LAYOUT.outer;
export let LINES_PER_PAGE = Math.floor((PAGE_H - LAYOUT.top - LAYOUT.bottom) / LAYOUT.lineHeight);

/** The text sizes a notebook can use: the body size and its line spacing, in page units. */
export const TEXT_SIZES = {
  xs: { bodySize: 14, lineHeight: 22 },
  s: { bodySize: 16, lineHeight: 25 },
  m: { bodySize: 19, lineHeight: 29 },
  l: { bodySize: 22, lineHeight: 33 },
  xl: { bodySize: 25, lineHeight: 37 },
} as const;
export type TextSize = keyof typeof TEXT_SIZES;

/** How many text lines a section heading takes: its title and rule need about 50 page units. */
function headingLines(): number {
  return Math.max(2, Math.ceil(HEADING_ROOM / LAYOUT.lineHeight));
}
const HEADING_ROOM = 50;

/**
 * On a Clean paper the size is pixels on screen, as everywhere else in the app
 * (owner, 30 Sep 2026): the book is scaled to fill the window, so a size in page
 * units showed Extra small bigger than the sidebar's text on a large window.
 */
export const SCREEN_PX: Readonly<Record<TextSize, number>> = { xs: 13, s: 14.5, m: 16, l: 18, xl: 20 };

/**
 * Set the text size for everything laid out and painted from now on (the book is typeset again after).
 * With `scale` (screen pixels per page unit, Clean papers), the size is SCREEN_PX on screen whatever the window.
 */
export function setTextSize(size: TextSize, scale?: number): void {
  const s = TEXT_SIZES[size] ?? TEXT_SIZES.m;
  if (scale && scale > 0) {
    const body = Math.round(((SCREEN_PX[size] ?? SCREEN_PX.m) / scale) * 10) / 10;
    LAYOUT.bodySize = body;
    LAYOUT.lineHeight = Math.round(body * 1.6 * 10) / 10;
  } else {
    LAYOUT.bodySize = s.bodySize;
    LAYOUT.lineHeight = s.lineHeight;
  }
  LAYOUT.chapterLines = headingLines();
  TEXT_WIDTH = PAGE_W - LAYOUT.inner - LAYOUT.outer;
  LINES_PER_PAGE = Math.floor((PAGE_H - LAYOUT.top - LAYOUT.bottom) / LAYOUT.lineHeight);
}
/** Sized so the capital spans three lines, from cap-height to the third baseline. */
export const DROP_CAP_SIZE = 104;

/** The active theme's page colours (updated in place by applyPageTheme). */
export const COLORS: { -readonly [K in keyof PageTheme['colors']]: string } = { ...(THEMES[0] as PageTheme).colors };

let theme: PageTheme = THEMES[0] as PageTheme;

/** Switches the look of everything painted from now on. */
/** A word as it is matched against glossary terms: lower case, no surrounding punctuation or possessive. */
const bare = (w: string): string => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/['’]s$/u, '');

/** Glossary terms underlined on the page (the fuller glossary), each as its words; longest first. */
let marked: string[][] = [];

/** The terms to underline wherever they are written (the notebook's found and defined terms). */
export function setMarkedTerms(terms: readonly string[]): void {
  marked = terms.map((t) => t.split(/\s+/).map(bare).filter(Boolean)).filter((w) => w.length > 0)
    .sort((a, b) => b.length - a.length);
}

/** The word ranges [first, last] on a line that spell a marked term, whole words only. */
export function markedRanges(words: readonly string[]): [number, number][] {
  if (!marked.length) return [];
  const bares = words.map(bare);
  const out: [number, number][] = [];
  for (let i = 0; i < bares.length; i++) {
    const term = marked.find((t) => t.every((w, k) => bares[i + k] === w));
    if (term) {
      out.push([i, i + term.length - 1]);
      i += term.length - 1;
    }
  }
  return out;
}

export function applyPageTheme(next: PageTheme): void {
  theme = next;
  Object.assign(COLORS, next.colors);
  paperCache.clear();
}

export function pageTheme(): PageTheme {
  return theme;
}

export const font = (size: number, style = ''): string => `${style} ${size}px ${theme.family}`.trim();

/** How a stored ink or highlighter value shows on the current paper. */
export const inkColor = (value: string | undefined): string => (value ? (theme.inkMap?.[value] ?? value) : COLORS.ink);
export const highlightColor = (value: string): string => theme.highlightMap?.[value] ?? value;

export type PageSide = 'left' | 'right';
export const sideOf = (index: number): PageSide => (index % 2 === 0 ? 'right' : 'left');

let noiseCanvas: HTMLCanvasElement | null = null;

/** A small tile of paper grain, generated once. */
function grainTile(): HTMLCanvasElement | null {
  if (noiseCanvas) return noiseCanvas;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (!g) return null;
  const img = g.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random();
    const shade = v > 0.5 ? 255 : 60;
    img.data[i] = shade;
    img.data[i + 1] = shade - 10;
    img.data[i + 2] = shade - 30;
    img.data[i + 3] = Math.floor(Math.random() * 14);
  }
  g.putImageData(img, 0, 0);
  noiseCanvas = c;
  return c;
}

export function drawGrain(ctx: CanvasRenderingContext2D, alpha = 1): void {
  const tile = grainTile();
  if (!tile) return;
  const pattern = ctx.createPattern(tile, 'repeat');
  if (!pattern) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.restore();
}

/** 0 (black) to 1 (white): how light a "#rrggbb" colour looks. */
export function lightness(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return 1;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h as string, 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whether the current page is dark paper (a dark theme, or a dark page colour). */
export const darkPaper = (): boolean => lightness(COLORS.paper) < 0.35;

/**
 * Where the page curves into the binding: a deep, narrow crease at the fold,
 * the curve's shadow falling off across a few centimetres, and a faint light
 * where the paper rises out of it. On light paper the shadow is a warm brown; on
 * dark paper it is black, and the rise is barely lighter, so a dark book shows
 * a fold, not stripes.
 */
function drawGutter(ctx: CanvasRenderingContext2D, side: PageSide, strength = theme.paper.gutter): void {
  const inner = side === 'right' ? 0 : PAGE_W;
  const dir = side === 'right' ? 1 : -1;
  const dark = darkPaper();
  const shade = dark ? '0, 0, 0' : '60, 40, 22';
  const deep = dark ? 0.62 : 0.36;

  const g = ctx.createLinearGradient(inner, 0, inner + dir * 90, 0);
  g.addColorStop(0, `rgba(${shade}, ${deep * strength})`);
  g.addColorStop(0.06, `rgba(${shade}, ${deep * 0.62 * strength})`);
  g.addColorStop(0.2, `rgba(${shade}, ${deep * 0.3 * strength})`);
  g.addColorStop(0.5, `rgba(${shade}, ${deep * 0.08 * strength})`);
  g.addColorStop(1, `rgba(${shade}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);

  // The rise out of the fold: a soft, wide light on cream paper, only a breath of it on dark.
  const rise = dark ? '255, 255, 255' : '255, 250, 238';
  const lift = dark ? 0.035 : 0.16;
  const h = ctx.createLinearGradient(inner + dir * 22, 0, inner + dir * 70, 0);
  h.addColorStop(0, `rgba(${rise}, 0)`);
  h.addColorStop(0.45, `rgba(${rise}, ${lift * strength})`);
  h.addColorStop(1, `rgba(${rise}, 0)`);
  ctx.fillStyle = h;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
}

const paperCache = new Map<string, HTMLCanvasElement>();


/**
 * Blank paper (tone, lighting, grain, gutter) is identical for every page on a
 * side, so it is rendered once per side and size and stamped with drawImage.
 * That leaves only the text to draw when an edited page is repainted.
 */
export function drawPaper(ctx: CanvasRenderingContext2D, side: PageSide): void {
  const t = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const pw = t ? Math.round(PAGE_W * Math.abs(t.a)) : 0;
  const ph = t ? Math.round(PAGE_H * Math.abs(t.d)) : 0;
  if (pw > 0 && ph > 0 && pw <= 4096 && ph <= 4096 && typeof document !== 'undefined') {
    const key = `${theme.id}:${side}:${pw}x${ph}`;
    let bitmap = paperCache.get(key);
    if (!bitmap) {
      bitmap = document.createElement('canvas');
      bitmap.width = pw;
      bitmap.height = ph;
      const g = bitmap.getContext('2d');
      if (g) {
        g.scale(pw / PAGE_W, ph / PAGE_H);
        paintPaper(g, side);
      }
      if (paperCache.size >= 8) paperCache.clear();
      paperCache.set(key, bitmap);
    }
    ctx.drawImage(bitmap, 0, 0, PAGE_W, PAGE_H);
    return;
  }
  paintPaper(ctx, side);
}

function paintPaper(ctx: CanvasRenderingContext2D, side: PageSide): void {
  const p = theme.paper;
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  const light = ctx.createRadialGradient(PAGE_W * 0.5, PAGE_H * 0.35, 40, PAGE_W * 0.5, PAGE_H * 0.5, PAGE_H * 0.75);
  light.addColorStop(0, p.glow);
  light.addColorStop(1, p.shade);
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  if (p.foxing) drawFoxing(ctx);
  drawGrain(ctx, p.grain);
  drawRuling(ctx, side);
  drawGutter(ctx, side);
}

/** Age spots for parchment, placed the same way every time. */
function drawFoxing(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  for (let i = 0; i < 26; i++) {
    const x = Math.abs(Math.sin(i * 91.7) * 10_000) % PAGE_W;
    const y = Math.abs(Math.sin(i * 47.3) * 10_000) % PAGE_H;
    const r = 6 + (i % 7) * 5;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(140, 90, 40, 0.10)');
    g.addColorStop(1, 'rgba(140, 90, 40, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Darker, browned edges.
  const edge = ctx.createRadialGradient(PAGE_W / 2, PAGE_H / 2, PAGE_W * 0.45, PAGE_W / 2, PAGE_H / 2, PAGE_H * 0.72);
  edge.addColorStop(0, 'rgba(120, 75, 30, 0)');
  edge.addColorStop(1, 'rgba(120, 75, 30, 0.28)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.restore();
}

/** School ruling (lines on every baseline, a red margin) or a bullet-journal dot grid. */
function drawRuling(ctx: CanvasRenderingContext2D, side: PageSide): void {
  const p = theme.paper;
  if (p.rule === 'none') return;
  const first = LAYOUT.top + LAYOUT.bodySize + 5;
  ctx.save();
  ctx.fillStyle = p.ruleColor;
  ctx.strokeStyle = p.ruleColor;
  if (p.rule === 'ruled') {
    ctx.lineWidth = 1;
    for (let y = first; y < PAGE_H - 30; y += LAYOUT.lineHeight) {
      ctx.beginPath();
      ctx.moveTo(0, y + 0.5);
      ctx.lineTo(PAGE_W, y + 0.5);
      ctx.stroke();
    }
    if (p.margin) {
      ctx.strokeStyle = p.margin;
      ctx.lineWidth = 1.4;
      const x = textLeft(side) - 16;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, PAGE_H);
      ctx.stroke();
    }
  } else {
    const step = LAYOUT.lineHeight;
    const x0 = textLeft(side) % step;
    for (let y = first % step; y < PAGE_H; y += step) {
      for (let x = x0; x < PAGE_W; x += step) {
        ctx.beginPath();
        ctx.arc(x, y, 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/** A raindrop with a ripple beneath it, the book's emblem. */
export function drawEmblem(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 1.55);
  ctx.bezierCurveTo(cx + r * 0.25, cy - r * 0.9, cx + r, cy - r * 0.35, cx + r, cy + r * 0.2);
  ctx.arc(cx, cy + r * 0.2, r, 0, Math.PI, false);
  ctx.bezierCurveTo(cx - r, cy - r * 0.35, cx - r * 0.25, cy - r * 0.9, cx, cy - r * 1.55);
  ctx.fill();
  for (let i = 1; i <= 2; i++) {
    ctx.globalAlpha = 1 - i * 0.3;
    ctx.beginPath();
    ctx.ellipse(cx, cy + r * 1.9, r * (1 + i * 0.9), r * (0.22 + i * 0.16), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawRule(ctx: CanvasRenderingContext2D, cx: number, y: number, half: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - half, y);
  ctx.lineTo(cx - 7, y);
  ctx.moveTo(cx + 7, y);
  ctx.lineTo(cx + half, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, y - 4);
  ctx.lineTo(cx + 4, y);
  ctx.lineTo(cx, y + 4);
  ctx.lineTo(cx - 4, y);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function textLeft(side: PageSide): number {
  return side === 'right' ? LAYOUT.inner : LAYOUT.outer;
}

function wordWidth(ctx: CanvasRenderingContext2D | null, word: string, f: string): number {
  const m = sharedMeasurer();
  if (m) return m.width(word, f);
  return ctx ? ctx.measureText(word).width : word.length * LAYOUT.bodySize * 0.45;
}

/** The body font with a style's weight and slant. */
export function styleFont(style: InlineStyle, size: number = LAYOUT.bodySize): string {
  return font(style.large ? HEADING_SIZE : size, `${style.italic ? 'italic ' : ''}${style.bold ? '600' : ''}`.trim());
}

export const HEADING_SIZE = 24;

// ── Pictures ─────────────────────────────────────────────────────────────────

const pictures = new Map<string, { src: string; img: HTMLImageElement }>();

/** Makes a picture available to the painter; `onReady` fires once it can be drawn. */
export function registerImage(id: string, src: string, onReady?: (id: string) => void): void {
  const known = pictures.get(id);
  if (known?.src === src || typeof Image === 'undefined') return;
  const img = new Image();
  img.onload = () => onReady?.(id);
  img.src = src;
  pictures.set(id, { src, img });
}

/** Drops every picture (e.g. when the diary locks). */
export function forgetImages(): void {
  pictures.clear();
}

export function imageReady(id: string): boolean {
  const img = pictures.get(id)?.img;
  return !!img && img.complete && img.naturalWidth > 0;
}

function segmentWidths(ctx: CanvasRenderingContext2D | null, segments: readonly Segment[]): number[] {
  return segments.map((seg) => wordWidth(ctx, seg.text, styleFont(seg.style)));
}

/** Word x positions for a line, with justification — shared by painting and hit testing. */
export function layoutLine(line: TextLine, x: number, ctx: CanvasRenderingContext2D | null = null): { xs: number[]; widths: number[] } {
  const f = font(LAYOUT.bodySize);
  const available = (line.measure ?? TEXT_WIDTH) - line.indent;
  const widths = line.words.map((w, i) => {
    const seg = line.spans?.[i];
    return seg ? segmentWidths(ctx, seg).reduce((a, b) => a + b, 0) : wordWidth(ctx, w, f);
  });
  const natural = widths.reduce((a, b) => a + b, 0);
  const space = wordWidth(ctx, ' ', f) || LAYOUT.bodySize * 0.25;
  let gap = space;
  // Clean pages set text ragged-right, as the app does: justified, a long name opened wide gaps.
  if (line.justify && !theme.plain && line.words.length > 1) {
    const stretched = (available - natural) / (line.words.length - 1);
    if (stretched < space * 5) gap = stretched;
  }
  if (line.cells && line.cellOfWord) {
    // Table rows: words flow within their own cell.
    const xs: number[] = [];
    const cursors = line.cells.map((c) => x + c.x + CELL_PAD);
    line.cellOfWord.forEach((c, i) => {
      xs.push(cursors[c] ?? x);
      cursors[c] = (cursors[c] ?? x) + (widths[i] ?? 0) + space;
    });
    return { xs, widths };
  }
  let cursor = x + line.indent;
  if (line.align === 'center') {
    const used = natural + space * Math.max(0, line.words.length - 1);
    cursor += Math.max(0, (available - used) / 2);
  }
  const xs: number[] = [];
  widths.forEach((w) => {
    xs.push(cursor);
    cursor += w + gap;
  });
  return { xs, widths };
}

/** Highlighter bands, joined across the gaps between highlighted words. */
function drawHighlights(ctx: CanvasRenderingContext2D, line: TextLine, xs: number[], widths: number[], baseline: number): void {
  if (!line.spans) return;
  const top = baseline - LAYOUT.bodySize * 0.82;
  const h = LAYOUT.bodySize * 1.12;
  line.spans.forEach((segs, i) => {
    if (!segs) return;
    const segW = segmentWidths(ctx, segs);
    let sx = xs[i] ?? 0;
    segs.forEach((seg, k) => {
      const w = segW[k] ?? 0;
      if (seg.style.highlight) {
        let right = sx + w;
        const nextFirst = line.spans?.[i + 1]?.[0];
        if (k === segs.length - 1 && nextFirst?.style.highlight === seg.style.highlight) right = xs[i + 1] ?? right;
        ctx.fillStyle = highlightColor(seg.style.highlight);
        ctx.fillRect(sx - 1, top, right - sx + 2, h);
      }
      sx += w;
    });
  });
}

function drawSegment(ctx: CanvasRenderingContext2D, seg: Segment, x: number, baseline: number, w: number): void {
  ctx.font = styleFont(seg.style);
  const color = inkColor(seg.style.color);
  ctx.fillStyle = color;
  ctx.fillText(seg.text, x, baseline);
  if (seg.style.underline || seg.style.strike) {
    ctx.fillStyle = color;
    if (seg.style.underline) ctx.fillRect(x, baseline + 2.5, w, 1.2);
    if (seg.style.strike) ctx.fillRect(x, baseline - LAYOUT.bodySize * 0.3, w, 1.2);
  }
}

function drawCheckbox(ctx: CanvasRenderingContext2D, cx: number, baseline: number, checked: boolean): void {
  const s = 13;
  const top = baseline - s + 1;
  ctx.save();
  ctx.strokeStyle = COLORS.inkSoft;
  ctx.lineWidth = 1.3;
  ctx.strokeRect(cx - s / 2, top, s, s);
  if (checked) {
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 4, top + 7);
    ctx.lineTo(cx - 1, top + 10.5);
    ctx.lineTo(cx + 6, top + 1.5);
    ctx.stroke();
  }
  ctx.restore();
}

/** Picture ids starting with this are mind maps: drawn flat on the paper, no photo frame. */
export const MIND_MAP_PREFIX = 'mm';

function drawPicture(ctx: CanvasRenderingContext2D, line: TextLine, x: number, top: number): void {
  const info = line.image;
  if (!info) return;
  const boxW = TEXT_WIDTH;
  const boxH = info.lines * LAYOUT.lineHeight - 10;
  const scale = Math.min(boxW / info.w, boxH / info.h);
  const w = info.w * scale;
  const h = info.h * scale;
  const px = x + (boxW - w) / 2;
  const py = top + (boxH - h) / 2 + 2;
  if (!info.id.startsWith(MIND_MAP_PREFIX)) {
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(px - 5, py - 5, w + 10, h + 10); // photo border
    ctx.restore();
  }
  const pic = pictures.get(info.id)?.img;
  if (pic && pic.complete && pic.naturalWidth > 0) {
    ctx.drawImage(pic, px, py, w, h);
  } else {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.fillRect(px, py, w, h);
  }
}

function drawTableRow(ctx: CanvasRenderingContext2D, line: TextLine, x: number, baseline: number): void {
  if (!line.cells || !line.table) return;
  const top = baseline - LAYOUT.bodySize - 4;
  const bottom = top + LAYOUT.lineHeight;
  ctx.save();
  if (line.table.row === 0) {
    ctx.fillStyle = 'rgba(128, 110, 90, 0.10)';
    ctx.fillRect(x, top, TEXT_WIDTH, LAYOUT.lineHeight);
  }
  ctx.strokeStyle = COLORS.inkSoft;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (line.table.row === 0) {
    ctx.moveTo(x, top + 0.5);
    ctx.lineTo(x + TEXT_WIDTH, top + 0.5);
  }
  ctx.moveTo(x, bottom + 0.5);
  ctx.lineTo(x + TEXT_WIDTH, bottom + 0.5);
  for (const c of line.cells) {
    ctx.moveTo(x + c.x + 0.5, top);
    ctx.lineTo(x + c.x + 0.5, bottom);
  }
  ctx.moveTo(x + TEXT_WIDTH - 0.5, top);
  ctx.lineTo(x + TEXT_WIDTH - 0.5, bottom);
  ctx.stroke();
  ctx.restore();
}

function drawLine(ctx: CanvasRenderingContext2D, line: TextLine, x: number, baseline: number): void {
  ctx.font = font(LAYOUT.bodySize);
  if (line.image) {
    drawPicture(ctx, line, x, baseline - LAYOUT.bodySize - 4);
    return;
  }
  if (line.divider) {
    drawRule(ctx, x + TEXT_WIDTH / 2, baseline - LAYOUT.bodySize * 0.35, 70, COLORS.inkSoft);
    return;
  }
  if (line.table) drawTableRow(ctx, line, x, baseline);
  const { xs, widths } = layoutLine(line, x, ctx);
  if (line.cells) {
    // Keep table text inside its cells.
    ctx.save();
    ctx.beginPath();
    for (const c of line.cells) ctx.rect(x + c.x + 2, baseline - LAYOUT.lineHeight, c.w - 4, LAYOUT.lineHeight + 8);
    ctx.clip();
  }

  if (line.quote) {
    ctx.fillStyle = 'rgba(107, 37, 48, 0.45)';
    ctx.fillRect(x + 8, baseline - LAYOUT.bodySize - 4, 2, LAYOUT.lineHeight);
  }
  drawHighlights(ctx, line, xs, widths, baseline);

  // Key terms are written in the accent ink so they stand out to click.
  const ranges = markedRanges(line.words);
  const isTerm = (i: number): boolean => ranges.some(([a, b]) => i >= a && i <= b);

  line.words.forEach((word, i) => {
    const segs = line.spans?.[i];
    const wx = xs[i] ?? x;
    if (!segs) {
      ctx.font = font(LAYOUT.bodySize);
      ctx.fillStyle = isTerm(i) ? COLORS.accent : COLORS.ink;
      ctx.fillText(word, wx, baseline);
      return;
    }
    const segW = segmentWidths(ctx, segs);
    let sx = wx;
    const term = isTerm(i);
    segs.forEach((seg, k) => {
      drawSegment(ctx, term && !seg.style.color ? { ...seg, style: { ...seg.style, color: COLORS.accent } } : seg, sx, baseline, segW[k] ?? 0);
      sx += segW[k] ?? 0;
    });
    // Underline and strike continue across the space to a formatted neighbour.
    const last = segs[segs.length - 1];
    const next = line.spans?.[i + 1]?.[0];
    const nx = xs[i + 1];
    if (last && next && nx !== undefined) {
      const gapX = wx + (widths[i] ?? 0);
      ctx.fillStyle = inkColor(last.style.color);
      if (last.style.underline && next.style.underline) ctx.fillRect(gapX, baseline + 2.5, nx - gapX, 1.2);
      if (last.style.strike && next.style.strike) ctx.fillRect(gapX, baseline - LAYOUT.bodySize * 0.3, nx - gapX, 1.2);
    }
  });

  // Glossary terms: a dotted underline says there is a meaning to see (the cursor on it shows the card).
  for (const [a, b] of ranges) {
    const from = xs[a];
    const to = (xs[b] ?? 0) + (widths[b] ?? 0);
    if (from === undefined || to <= from) continue;
    ctx.save();
    ctx.fillStyle = COLORS.accent;
    ctx.globalAlpha = 0.45;
    for (let dx = from; dx < to; dx += 3.5) ctx.fillRect(dx, baseline + 3.5, 1.6, 1.2);
    ctx.restore();
  }

  if (line.cells) ctx.restore();
  if (line.marker === 'checked') {
    // A ticked item fades and is struck through.
    const end = (xs[xs.length - 1] ?? 0) + (widths[widths.length - 1] ?? 0);
    if (line.words.length) {
      ctx.save();
      ctx.fillStyle = COLORS.paper;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(x + line.indent - 2, baseline - LAYOUT.bodySize, end - x - line.indent + 4, LAYOUT.bodySize + 6);
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.inkSoft;
      ctx.fillRect(x + line.indent, baseline - LAYOUT.bodySize * 0.3, end - x - line.indent, 1.2);
      ctx.restore();
    }
  }
  if (line.bullet) {
    ctx.font = font(LAYOUT.bodySize);
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(line.star ? '★' : '•', x + line.indent - (line.star ? 17 : 15), baseline);
  }
  if (line.marker === 'number') {
    ctx.save();
    ctx.font = font(LAYOUT.bodySize);
    ctx.fillStyle = COLORS.accent;
    ctx.textAlign = 'right';
    ctx.fillText(`${line.number ?? 1}.`, x + line.indent - 7, baseline);
    ctx.restore();
  }
  if (line.marker === 'check' || line.marker === 'checked') {
    drawCheckbox(ctx, x + line.indent - 15, baseline, line.marker === 'checked');
  }

  if (line.dropCap) {
    ctx.save();
    ctx.font = font(DROP_CAP_SIZE, '500');
    ctx.fillStyle = COLORS.accent;
    ctx.fillText(line.dropCap, x - 2, baseline + LAYOUT.lineHeight * 2);
    ctx.restore();
  }
}

function drawEndOrnament(ctx: CanvasRenderingContext2D, cy: number): void {
  ctx.save();
  ctx.fillStyle = COLORS.accent;
  for (const dx of [-16, 0, 16]) {
    const s = dx === 0 ? 5 : 3.2;
    ctx.beginPath();
    ctx.moveTo(PAGE_W / 2 + dx, cy - s);
    ctx.lineTo(PAGE_W / 2 + dx + s, cy);
    ctx.lineTo(PAGE_W / 2 + dx, cy + s);
    ctx.lineTo(PAGE_W / 2 + dx - s, cy);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** The printed page number at the foot of a page. */
export function drawFolio(ctx: CanvasRenderingContext2D, folio: number): void {
  ctx.save();
  ctx.font = theme.plain ? font(12) : font(15, 'italic');
  ctx.fillStyle = COLORS.inkSoft;
  ctx.textAlign = 'center';
  ctx.fillText(String(folio), PAGE_W / 2, PAGE_H - 22);
  ctx.restore();
}

function drawTextPage(ctx: CanvasRenderingContext2D, content: PageContent, index: number, side: PageSide, folio = index + 1): void {
  drawPaper(ctx, side);
  const x = textLeft(side);
  const centre = x + TEXT_WIDTH / 2;
  let firstLine = 0;

  if (content.chapter) {
    // Notes, not a novel: the section's title and a short rule, no chapter number, so the writing starts high.
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.ink;
    if (theme.plain) {
      // The app's look: the title upright and semibold on the left, a hairline under it.
      ctx.textAlign = 'left';
      ctx.font = font(Math.round(LAYOUT.bodySize * 1.15), '600');
      ctx.fillText(content.chapter.title, x, LAYOUT.top + 20, TEXT_WIDTH);
      ctx.fillStyle = COLORS.inkSoft;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x, LAYOUT.top + 31, TEXT_WIDTH, 1);
      ctx.restore();
    } else {
      ctx.font = font(22, 'italic');
      ctx.fillText(content.chapter.title, centre, LAYOUT.top + 20, TEXT_WIDTH);
      ctx.restore();
      drawRule(ctx, centre, LAYOUT.top + 34, 30, COLORS.inkSoft);
    }
    firstLine = LAYOUT.chapterLines;
  }

  content.lines.forEach((line, i) => {
    const baseline = LAYOUT.top + (firstLine + i) * LAYOUT.lineHeight + LAYOUT.bodySize;
    drawLine(ctx, line, x, baseline);
  });

  if (content.isLast) {
    const y = LAYOUT.top + (firstLine + content.lines.length) * LAYOUT.lineHeight + 26;
    if (y < PAGE_H - LAYOUT.bottom + 10) drawEndOrnament(ctx, y);
  }
  drawFolio(ctx, folio);
}

function drawTitlePage(ctx: CanvasRenderingContext2D, side: PageSide): void {
  drawPaper(ctx, side);
  ctx.save();
  ctx.textAlign = 'center';
  const cx = PAGE_W / 2 + (side === 'right' ? 5 : -5);
  ctx.fillStyle = COLORS.ink;
  ctx.font = font(38, '500');
  ctx.fillText('The Cartographer', cx, 238);
  ctx.font = font(38, 'italic');
  ctx.fillText('of Small Rains', cx, 284);
  drawRule(ctx, cx, 322, 60, COLORS.accent);
  ctx.fillStyle = COLORS.inkSoft;
  ctx.font = font(18, 'italic');
  ctx.fillText('A short tale in three chapters', cx, 360);
  drawEmblem(ctx, cx, 470, 13, COLORS.accent);
  ctx.font = font(15);
  ctx.fillText('Halden Press', cx, PAGE_H - 70);
  ctx.restore();
}

function drawColophon(ctx: CanvasRenderingContext2D, index: number, side: PageSide): void {
  drawPaper(ctx, side);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.inkSoft;
  ctx.font = font(16, 'italic');
  const cx = PAGE_W / 2;
  ['Set in EB Garamond.', 'Every page in this book was drawn', 'on a canvas and turned by hand.'].forEach((t, i) =>
    ctx.fillText(t, cx, 300 + i * 26),
  );
  ctx.restore();
  drawEmblem(ctx, cx, 420, 8, COLORS.inkSoft);
  drawFolio(ctx, index + 1);
}

function drawEndpaper(ctx: CanvasRenderingContext2D, side: PageSide): void {
  ctx.fillStyle = COLORS.endpaper;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.save();
  ctx.strokeStyle = 'rgba(201, 164, 92, 0.28)';
  ctx.lineWidth = 1;
  const step = 34;
  for (let i = -PAGE_H; i < PAGE_W + PAGE_H; i += step) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + PAGE_H, PAGE_H);
    ctx.moveTo(i, PAGE_H);
    ctx.lineTo(i + PAGE_H, 0);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(201, 164, 92, 0.45)';
  for (let y = step / 2; y < PAGE_H; y += step) {
    for (let x = (y / step) % 2 < 1 ? 0 : step / 2; x < PAGE_W + step; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
  drawGrain(ctx, 0.8);
  drawGutter(ctx, side, 1.3);
}

function drawCloth(ctx: CanvasRenderingContext2D, side: PageSide): void {
  const base = ctx.createLinearGradient(0, 0, PAGE_W, PAGE_H);
  base.addColorStop(0, '#652431');
  base.addColorStop(1, COLORS.cloth);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  // Woven cloth texture.
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = '#000';
  for (let y = 0; y < PAGE_H; y += 3) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(PAGE_W, y + 0.5);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = '#fff';
  for (let x = 0; x < PAGE_W; x += 3) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, PAGE_H);
    ctx.stroke();
  }
  ctx.restore();
  drawGrain(ctx, 1.4);

  // Hinge groove along the spine edge.
  const spine = side === 'right' ? 0 : PAGE_W;
  const dir = side === 'right' ? 1 : -1;
  const hinge = ctx.createLinearGradient(spine, 0, spine + dir * 40, 0);
  hinge.addColorStop(0, 'rgba(0,0,0,0.55)');
  hinge.addColorStop(0.35, 'rgba(0,0,0,0.15)');
  hinge.addColorStop(0.45, 'rgba(255,255,255,0.10)');
  hinge.addColorStop(0.6, 'rgba(0,0,0,0.20)');
  hinge.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = hinge;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);

  const vignette = ctx.createRadialGradient(PAGE_W / 2, PAGE_H / 2, PAGE_W * 0.3, PAGE_W / 2, PAGE_H / 2, PAGE_H * 0.7);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
}

function goldFill(ctx: CanvasRenderingContext2D, y0: number, y1: number): CanvasGradient {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  g.addColorStop(0, COLORS.goldLight);
  g.addColorStop(0.5, COLORS.gold);
  g.addColorStop(1, '#9C7A3A');
  return g;
}

/** Debossed foil: a dark offset impression under a gold face. */
function foilText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, style = ''): void {
  ctx.font = font(size, style);
  ctx.fillStyle = 'rgba(20, 4, 8, 0.55)';
  ctx.fillText(text, x + 1, y + 1.5);
  ctx.fillStyle = goldFill(ctx, y - size, y);
  ctx.fillText(text, x, y);
}

function drawFrame(ctx: CanvasRenderingContext2D, side: PageSide): void {
  const shift = side === 'right' ? 10 : -10;
  ctx.save();
  ctx.strokeStyle = COLORS.gold;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1.6;
  ctx.strokeRect(34 + shift, 34, PAGE_W - 68, PAGE_H - 68);
  ctx.lineWidth = 0.8;
  ctx.strokeRect(42 + shift, 42, PAGE_W - 84, PAGE_H - 84);
  ctx.restore();
}

function drawCover(ctx: CanvasRenderingContext2D): void {
  drawCloth(ctx, 'right');
  drawFrame(ctx, 'right');
  ctx.save();
  ctx.textAlign = 'center';
  const cx = PAGE_W / 2 + 10;
  foilText(ctx, 'The Cartographer', cx, 236, 46, '500');
  foilText(ctx, 'of Small Rains', cx, 292, 46, 'italic');
  ctx.restore();
  drawRule(ctx, cx, 334, 70, COLORS.gold);
  drawEmblem(ctx, cx, 450, 22, COLORS.gold);
  ctx.save();
  ctx.textAlign = 'center';
  foilText(ctx, 'A tale of weather and small mercies', cx, PAGE_H - 96, 17, 'italic');
  ctx.restore();
}

function drawBackCover(ctx: CanvasRenderingContext2D): void {
  drawCloth(ctx, 'left');
  drawFrame(ctx, 'left');
  const cx = PAGE_W / 2 - 10;
  drawEmblem(ctx, cx, 300, 14, COLORS.gold);
  ctx.save();
  ctx.textAlign = 'center';
  foilText(ctx, 'Some rains need help getting home.', cx, 400, 18, 'italic');
  ctx.restore();
}

/** Paints one page in logical PAGE_W × PAGE_H units onto ctx. */
export function paintPage(ctx: CanvasRenderingContext2D, spec: PageSpec, index: number): void {
  const side = sideOf(index);
  ctx.textBaseline = 'alphabetic';
  switch (spec.kind) {
    case 'cover':
      drawCover(ctx);
      break;
    case 'back-cover':
      drawBackCover(ctx);
      break;
    case 'endpaper':
      drawEndpaper(ctx, side);
      break;
    case 'title':
      drawTitlePage(ctx, side);
      break;
    case 'colophon':
      drawColophon(ctx, index, side);
      break;
    case 'text':
      drawTextPage(ctx, spec.content, index, side, spec.folio);
      break;
    case 'blank':
      drawPaper(ctx, side);
      if (spec.folio) drawFolio(ctx, spec.folio);
      break;
    case 'custom':
      drawPaper(ctx, side);
      break;
  }
}

/** Plain-text rendition of a page for assistive technology. */
export function describePage(spec: PageSpec, index: number): string {
  switch (spec.kind) {
    case 'cover':
      return `Front cover: ${BOOK_TITLE}.`;
    case 'back-cover':
      return 'Back cover: Some rains need help getting home.';
    case 'endpaper':
      return 'Endpaper.';
    case 'title':
      return `${BOOK_TITLE}. A short tale in three chapters.`;
    case 'colophon':
      return 'Set in EB Garamond. Every page in this book was drawn on a canvas and turned by hand.';
    case 'blank':
      return 'Blank page.';
    case 'custom':
      return spec.data?.label ?? '';
    case 'text': {
      const heading = spec.content.chapter ? `Chapter ${spec.content.chapter.numeral}: ${spec.content.chapter.title}. ` : '';
      const body = spec.content.lines.map((l) => `${l.dropCap ?? ''}${l.words.join(' ')}`).join(' ');
      return `Page ${spec.folio ?? index + 1}. ${heading}${body}`;
    }
  }
}

export interface LineHit {
  /** 'chapter' when the tap landed on the chapter heading. */
  readonly line: number | 'chapter';
  /** Word index within the line (0 for headings). */
  readonly word: number;
  /** Characters into that word; -1 means before a drop cap. */
  readonly char: number;
}

/** Width of the first `chars` characters of a line's word, honouring its styles. */
export function prefixWidth(line: TextLine, wordIndex: number, chars: number): number {
  const word = line.words[wordIndex] ?? '';
  const segs = line.spans?.[wordIndex];
  if (!segs) return wordWidth(null, word.slice(0, chars), font(LAYOUT.bodySize));
  let left = chars;
  let w = 0;
  for (const seg of segs) {
    if (left <= 0) break;
    const take = seg.text.slice(0, left);
    w += wordWidth(null, take, styleFont(seg.style));
    left -= take.length;
  }
  return w;
}

/** Maps a point (logical page units) to a line, word and character on a text page. */
export function hitTestLine(spec: PageSpec, index: number, x: number, y: number): LineHit | null {
  if (spec.kind !== 'text') return null;
  const { chapter, lines } = spec.content;
  const first = chapter ? LAYOUT.chapterLines : 0;
  const row = Math.floor((y - LAYOUT.top) / LAYOUT.lineHeight) - first;
  if ((row < 0 || !lines.length) && chapter) return { line: 'chapter', word: 0, char: 0 };
  if (!lines.length) return null;
  const lineIndex = Math.max(0, Math.min(lines.length - 1, row));
  const line = lines[lineIndex] as TextLine;
  if (!line.words.length) return { line: lineIndex, word: 0, char: 0 };
  const { xs, widths } = layoutLine(line, textLeft(sideOf(index)));
  if (line.dropCap && x < (xs[0] ?? 0) - 4) return { line: lineIndex, word: 0, char: -1 };
  let word = 0;
  xs.forEach((wx, i) => {
    if (x >= wx - 4) word = i;
  });
  // Nearest character boundary within the word.
  const text = line.words[word] ?? '';
  const start = xs[word] ?? 0;
  let char = 0;
  let best = Infinity;
  for (let c = 0; c <= text.length; c++) {
    const d = Math.abs(x - (start + prefixWidth(line, word, c)));
    if (d < best) {
      best = d;
      char = c;
    }
  }
  if (x > start + (widths[word] ?? 0)) char = text.length;
  return { line: lineIndex, word, char };
}

/**
 * Where to draw a text cursor. `char` counts characters of the word as it
 * appears in the source (so on a drop-cap line, word 0 includes the capital).
 */
export function caretRect(spec: PageSpec, index: number, lineIndex: number, wordInLine: number, char: number): { x: number; y: number; h: number } | null {
  if (spec.kind !== 'text') return null;
  const line = spec.content.lines[lineIndex];
  if (!line) return null;
  const first = spec.content.chapter ? LAYOUT.chapterLines : 0;
  const y = LAYOUT.top + (first + lineIndex) * LAYOUT.lineHeight + 2;
  const h = LAYOUT.bodySize * 1.25;
  const left = textLeft(sideOf(index));
  if (!line.words.length) {
    const indent = line.align === 'center' ? ((line.measure ?? TEXT_WIDTH) + line.indent) / 2 : line.indent;
    return { x: left + indent, y, h };
  }
  const { xs, widths } = layoutLine(line, left);
  const cap = line.dropCap ?? '';
  if (cap && wordInLine <= 0) {
    // The word that begins with the drop cap: before it, inside it, or in the rest.
    if (wordInLine < 0 || char <= 0) return { x: left - 2, y, h };
    if (char <= cap.length) return { x: xs[0] ?? left, y, h };
    char -= cap.length;
  }
  const w = Math.max(0, Math.min(wordInLine, line.words.length - 1));
  const word = line.words[w] ?? '';
  const start = xs[w] ?? left;
  if (char > word.length) return { x: start + (widths[w] ?? 0) + wordWidth(null, ' ', font(LAYOUT.bodySize)), y, h };
  return { x: start + prefixWidth(line, w, Math.max(0, char)), y, h };
}

export interface PageRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Rectangle (logical page units) of a text line, or of the heading for 'chapter'. */
export function lineRect(spec: PageSpec, index: number, line: number | 'chapter'): PageRect | null {
  if (spec.kind !== 'text') return null;
  const x = textLeft(sideOf(index));
  if (line === 'chapter') {
    return spec.content.chapter ? { x, y: LAYOUT.top - 4, w: TEXT_WIDTH, h: 32 } : null;
  }
  if (line < 0 || line >= spec.content.lines.length) return null;
  const first = spec.content.chapter ? LAYOUT.chapterLines : 0;
  return { x, y: LAYOUT.top + (first + line) * LAYOUT.lineHeight - 1, w: TEXT_WIDTH, h: LAYOUT.lineHeight };
}


/** Cursor x inside a table cell, from the raw text typed before it in that cell. */
export function tableCaretX(line: TextLine, index: number, cell: number, prefix: string): number {
  const c = line.cells?.[Math.max(0, Math.min(cell, (line.cells?.length ?? 1) - 1))];
  const f = line.table?.row === 0 ? styleFont({ bold: true }) : font(LAYOUT.bodySize);
  return textLeft(sideOf(index)) + (c?.x ?? 0) + CELL_PAD + wordWidth(null, prefix, f);
}

/** Which table cell a point falls in, and the nearest character within its raw text. */
export function tableHit(line: TextLine, index: number, x: number, cellTexts: readonly string[]): { cell: number; char: number } {
  const cells = line.cells ?? [];
  const left = textLeft(sideOf(index));
  let cell = cells.findIndex((c) => x < left + c.x + c.w);
  if (cell < 0) cell = cells.length - 1;
  const text = cellTexts[cell] ?? '';
  let char = 0;
  let best = Infinity;
  for (let k = 0; k <= text.length; k++) {
    const d = Math.abs(x - tableCaretX(line, index, cell, text.slice(0, k)));
    if (d < best) {
      best = d;
      char = k;
    }
  }
  return { cell, char };
}

/** True when a point is on a checklist box. */
export function onCheckbox(line: TextLine, index: number, x: number): boolean {
  if (line.marker !== 'check' && line.marker !== 'checked') return false;
  const boxX = textLeft(sideOf(index)) + line.indent - 15;
  return Math.abs(x - boxX) <= 13;
}
