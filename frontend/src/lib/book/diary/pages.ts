import type { PageSpec } from '../book';
import { COLORS, drawFolio, drawGrain, drawPaper, drawRule, font, PAGE_H, PAGE_W, pageTheme, paintPage, sideOf, type PageSide } from '../pages';
import type { PageContent } from '../typeset';

export const DIARY_NAME = 'Nkɔmmɔ';

/** Blank pages kept after the last entry, so the diary never looks full. */
export const BLANK_PAGES_AHEAD = 6;

/** Pages before the first writing page: cover, endpaper, the name page. */
export const FRONT_MATTER = 3;

/**
 * The printed number of a writing page, counting the first page you write on
 * as 1. Covers, endpapers and the name page have none.
 */
export function folioOf(spec: PageSpec | undefined): number | null {
  if (!spec) return null;
  if (spec.kind === 'text' || spec.kind === 'blank') return spec.folio ?? null;
  if (spec.kind === 'custom' && spec.name === 'diary-empty') return 1;
  return null;
}

/** How many numbered writing pages the diary has. */
export function writingPageCount(pages: readonly PageSpec[]): number {
  return pages.filter((p) => folioOf(p) !== null).length;
}

/** Physical page order: cover, endpaper, owner page, entries, endpaper, back cover. */
/**
 * What the covers and the first page say. The diary's own words are the
 * default; a notebook passes its title, who it is by, and its own wording.
 */
export interface BookWords {
  /** Embossed on the front cover. */
  readonly title?: string;
  /** Above the name on the first page. */
  readonly intro?: string;
  /** At the foot of the first page. */
  readonly footer?: string;
  /** On the first writing page while there is nothing written. */
  readonly empty?: string;
  /**
   * What is written on an exercise-book cover's label. Without it the label
   * shows the owner as the name, as the diary does.
   */
  readonly label?: CoverLabel;
}

/** The lines of an exercise-book cover's label. */
export interface CoverLabel {
  readonly name?: string;
  readonly class?: string;
  readonly year?: string;
}

/** The label's lines as page data (page data is flat strings). */
function labelData(label: CoverLabel | undefined, owner: string): Record<string, string> {
  return label
    ? { labelName: label.name ?? '', labelClass: label.class ?? '', labelYear: label.year ?? '' }
    : { labelName: owner, labelClass: '', labelYear: '' };
}

export function assembleDiary(textPages: readonly PageContent[], owner: string, words: BookWords = {}): PageSpec[] {
  const intro = words.intro ?? 'This diary belongs to';
  const pages: PageSpec[] = [
    { kind: 'custom', name: 'diary-cover', data: { owner, title: words.title ?? DIARY_NAME, ...labelData(words.label, owner), label: `Front cover of ${words.title ? `“${words.title}”` : 'the diary'}.` } },
    { kind: 'endpaper' },
    { kind: 'custom', name: 'diary-owner', data: { owner, intro, footer: words.footer ?? 'Only your passcode opens it.', label: owner ? `${intro} ${owner}.` : `${intro} you.` } },
  ];
  if (!textPages.length) {
    pages.push({ kind: 'custom', name: 'diary-empty', data: { label: words.empty ?? 'Your first page is waiting.' } });
  }
  // Writing pages are numbered from 1, like the pages of a real diary.
  const folio = () => pages.length - FRONT_MATTER + 1;
  for (const content of textPages) pages.push({ kind: 'text', content, folio: folio() });
  // A diary always has empty pages ahead of you.
  for (let i = 0; i < BLANK_PAGES_AHEAD; i++) pages.push({ kind: 'blank', folio: folio() });
  if ((pages.length + 2) % 2 !== 0) pages.push({ kind: 'blank', folio: folio() });
  pages.push({ kind: 'endpaper' }, { kind: 'custom', name: 'diary-back', data: { label: 'Back cover.' } });
  return pages;
}

function drawCoverBase(ctx: CanvasRenderingContext2D, side: PageSide): void {
  const style = pageTheme().cover.style;
  if (style === 'card') drawCard(ctx, side);
  else if (style === 'cloth') drawClothCover(ctx, side);
  else drawLeather(ctx, side);
}

function hingeShadow(ctx: CanvasRenderingContext2D, side: PageSide, strength = 0.55): void {
  const spine = side === 'right' ? 0 : PAGE_W;
  const dir = side === 'right' ? 1 : -1;
  const hinge = ctx.createLinearGradient(spine, 0, spine + dir * 34, 0);
  hinge.addColorStop(0, `rgba(0,0,0,${strength})`);
  hinge.addColorStop(0.5, 'rgba(255,255,255,0.06)');
  hinge.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = hinge;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
}

/** Book cloth: a fine woven texture, no stitching. */
function drawClothCover(ctx: CanvasRenderingContext2D, side: PageSide): void {
  const c = pageTheme().cover;
  const g = ctx.createLinearGradient(0, 0, PAGE_W, PAGE_H);
  g.addColorStop(0, c.light);
  g.addColorStop(1, c.dark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.save();
  ctx.globalAlpha = 0.07;
  for (let y = 0; y < PAGE_H; y += 2) {
    ctx.fillStyle = y % 4 ? '#000' : '#fff';
    ctx.fillRect(0, y, PAGE_W, 1);
  }
  for (let x = 0; x < PAGE_W; x += 2) {
    ctx.fillStyle = x % 4 ? '#000' : '#fff';
    ctx.fillRect(x, 0, 1, PAGE_H);
  }
  ctx.restore();
  drawGrain(ctx, 1);
  hingeShadow(ctx, side, 0.35);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** A school exercise-book cover: flat card with a printed label. */
function drawCard(ctx: CanvasRenderingContext2D, side: PageSide): void {
  const c = pageTheme().cover;
  ctx.fillStyle = c.base;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  drawGrain(ctx, 0.8);
  // Stapled spine strip.
  const spine = side === 'right' ? 0 : PAGE_W - 26;
  ctx.fillStyle = c.dark;
  ctx.fillRect(spine, 0, 26, PAGE_H);
  hingeShadow(ctx, side, 0.3);
}

/** Words broken into lines no wider than `width` at the font already set. */
function wrapWords(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** `text` cut short with an ellipsis so it fits `width` at the font already set. */
function clipText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/**
 * How a title sits in the label's heading space: one line, shrinking from
 * `max` to `oneLineMin`; then two lines, shrinking to `min`; then two lines
 * with the rest cut short. Exported for tests.
 */
export function fitTitle(ctx: CanvasRenderingContext2D, title: string, width: number,
  max = 34, oneLineMin = 24, min = 15, style = ''): { size: number; lines: string[] } {
  for (let size = max; size >= oneLineMin; size--) {
    ctx.font = font(size, style);
    if (ctx.measureText(title).width <= width) return { size, lines: [title] };
  }
  for (let size = oneLineMin; size >= min; size--) {
    ctx.font = font(size, style);
    const lines = wrapWords(ctx, title, width);
    if (lines.length <= 2 && lines.every((l) => ctx.measureText(l).width <= width)) return { size, lines };
  }
  ctx.font = font(min, style);
  const lines = wrapWords(ctx, title, width);
  const second = lines.slice(1).join(' ');
  return { size: min, lines: [clipText(ctx, lines[0] ?? '', width), ...(second ? [clipText(ctx, second, width)] : [])] };
}

/** One line of writing on a label's ruled line: shrinks to fit, then is cut short. */
function fitLine(ctx: CanvasRenderingContext2D, text: string, width: number, max = 20, min = 13): { size: number; text: string } {
  for (let size = max; size >= min; size--) {
    ctx.font = font(size);
    if (ctx.measureText(text).width <= width) return { size, text };
  }
  return { size: min, text: clipText(ctx, text, width) };
}

function drawLabel(ctx: CanvasRenderingContext2D, title: string, fields: CoverLabel): void {
  const c = pageTheme().cover;
  const x = 90;
  const y = 150;
  const w = PAGE_W - 160;
  const h = 210;
  ctx.save();
  ctx.fillStyle = '#FFFFFF';
  ctx.shadowColor = 'rgba(0,0,0,0.2)';
  ctx.shadowBlur = 6;
  ctx.beginPath();
  roundRect(ctx, x, y, w, h, 14);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = c.base;
  ctx.lineWidth = 2;
  ctx.beginPath();
  roundRect(ctx, x + 8, y + 8, w - 16, h - 16, 10);
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = c.emboss;
  // The title keeps inside the label: smaller, then on two lines, then cut short.
  const heading = fitTitle(ctx, title, w - 44);
  ctx.font = font(heading.size);
  if (heading.lines.length === 1) ctx.fillText(heading.lines[0], x + w / 2, y + 62);
  else heading.lines.forEach((line, i) => ctx.fillText(line, x + w / 2, y + 46 + i * (heading.size + 4)));
  ctx.font = font(17);
  ctx.textAlign = 'left';
  ['Name', 'Class', 'Year'].forEach((label, i) => {
    const ly = y + 108 + i * 32;
    ctx.fillStyle = c.emboss;
    ctx.fillText(label, x + 28, ly);
    ctx.strokeStyle = 'rgba(31, 42, 72, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 90, ly + 3);
    ctx.lineTo(x + w - 28, ly + 3);
    ctx.stroke();
  });
  // What is written on the ruled lines stays on them.
  ctx.fillStyle = COLORS.ink;
  [fields.name, fields.class, fields.year].forEach((value, i) => {
    const text = value?.trim();
    if (!text) return;
    const line = fitLine(ctx, text, w - 124);
    ctx.font = font(line.size);
    ctx.fillText(line.text, x + 96, y + 106 + i * 32);
  });
  ctx.restore();
}

/** Times tables on the back of the exercise book, as they always were. */
function drawTimesTable(ctx: CanvasRenderingContext2D): void {
  const c = pageTheme().cover;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = font(15);
  ctx.textAlign = 'left';
  for (let t = 2; t <= 9; t++) {
    const col = (t - 2) % 4;
    const row = Math.floor((t - 2) / 4);
    const x = 60 + col * 100;
    const y = 120 + row * 280;
    ctx.fillStyle = '#FFFFFF';
    ctx.font = font(18);
    ctx.fillText(`${t} times`, x, y);
    ctx.font = font(14);
    for (let n = 1; n <= 12; n++) ctx.fillText(`${n} × ${t} = ${n * t}`, x, y + 8 + n * 19);
  }
  ctx.fillStyle = c.light;
  ctx.restore();
}

function drawLeather(ctx: CanvasRenderingContext2D, side: PageSide): void {
  const cover = pageTheme().cover;
  const g = ctx.createLinearGradient(0, 0, PAGE_W, PAGE_H);
  g.addColorStop(0, cover.light);
  g.addColorStop(0.55, cover.base);
  g.addColorStop(1, cover.dark);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);

  // Pebbled grain: soft blotches plus fine noise.
  ctx.save();
  for (let i = 0; i < 900; i++) {
    const x = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    const y = (Math.sin(i * 78.233) * 12345.6789) % 1;
    ctx.fillStyle = i % 2 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.025)';
    ctx.beginPath();
    ctx.arc(Math.abs(x) * PAGE_W, Math.abs(y) * PAGE_H, 2 + (i % 5), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  drawGrain(ctx, 2);

  // Worn, lighter edges where hands hold it.
  const wear = ctx.createRadialGradient(PAGE_W / 2, PAGE_H / 2, PAGE_W * 0.35, PAGE_W / 2, PAGE_H / 2, PAGE_H * 0.72);
  wear.addColorStop(0, 'rgba(0,0,0,0)');
  wear.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = wear;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);

  // Saddle stitching inset from the edge.
  ctx.save();
  ctx.strokeStyle = cover.stitch;
  ctx.lineWidth = 2;
  ctx.setLineDash([9, 7]);
  const inset = 22;
  ctx.strokeRect(inset, inset, PAGE_W - inset * 2, PAGE_H - inset * 2);
  ctx.restore();

  // Hinge fold along the spine.
  const spine = side === 'right' ? 0 : PAGE_W;
  const dir = side === 'right' ? 1 : -1;
  const hinge = ctx.createLinearGradient(spine, 0, spine + dir * 34, 0);
  hinge.addColorStop(0, 'rgba(0,0,0,0.55)');
  hinge.addColorStop(0.5, 'rgba(255,255,255,0.06)');
  hinge.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = hinge;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
}

/** Blind emboss: the name pressed into the leather, no foil. */
function emboss(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, style = ''): void {
  ctx.save();
  ctx.textAlign = 'center';
  const c = pageTheme().cover;
  ctx.font = font(size, style);
  ctx.fillStyle = c.embossHighlight;
  ctx.fillText(text, x + 1, y + 1.5);
  ctx.fillStyle = c.emboss;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawCover(ctx: CanvasRenderingContext2D, owner: string, title = DIARY_NAME, fields: CoverLabel = { name: owner }): void {
  drawCoverBase(ctx, 'right');
  if (pageTheme().cover.style === 'card') {
    drawLabel(ctx, title, fields);
    return;
  }
  // A long title takes two lines, smaller, rather than running off the cover.
  const fit = fitTitle(ctx, title, PAGE_W - 110, 56, 30, 20, 'italic');
  const gap = fit.size * 1.15;
  const top = 250 - ((fit.lines.length - 1) * gap) / 2;
  fit.lines.forEach((line, i) => emboss(ctx, line, PAGE_W / 2, top + i * gap, fit.size, 'italic'));
  const rule = top + (fit.lines.length - 1) * gap + 40;
  ctx.save();
  ctx.strokeStyle = pageTheme().cover.emboss;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAGE_W / 2 - 50, rule);
  ctx.lineTo(PAGE_W / 2 + 50, rule);
  ctx.stroke();
  ctx.restore();
}

function drawOwnerPage(ctx: CanvasRenderingContext2D, owner: string, side: PageSide,
  intro = 'This diary belongs to', footer = 'Only your passcode opens it.'): void {
  drawPaper(ctx, side);
  const cx = PAGE_W / 2;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.inkSoft;
  ctx.font = font(19, 'italic');
  ctx.fillText(intro, cx, 270);
  // A long name or notebook title gets smaller type and a second line, never squeezed into one line
  // (fillText's maxWidth narrowed every letter of a 74-character title).
  let rule = 380;
  if (owner) {
    ctx.fillStyle = COLORS.ink;
    const fit = fitTitle(ctx, owner, PAGE_W - 120, 34, 26, 18, '500');
    const gap = Math.round(fit.size * 1.3);
    const first = 325 - ((fit.lines.length - 1) * gap) / 2;
    ctx.font = font(fit.size, '500');
    fit.lines.forEach((line, i) => ctx.fillText(line, cx, first + i * gap));
    rule = Math.max(380, first + (fit.lines.length - 1) * gap + 55);
  } else {
    ctx.strokeStyle = 'rgba(110, 98, 88, 0.5)';
    ctx.beginPath();
    ctx.moveTo(cx - 120, 330);
    ctx.lineTo(cx + 120, 330);
    ctx.stroke();
  }
  ctx.restore();
  drawRule(ctx, cx, rule, 50, COLORS.accent);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.inkSoft;
  ctx.font = font(15, 'italic');
  if (footer) ctx.fillText(footer, cx, PAGE_H - 90);
  ctx.restore();
}

function drawEmptyPage(ctx: CanvasRenderingContext2D, side: PageSide): void {
  drawPaper(ctx, side);
  drawFolio(ctx, 1);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.inkSoft;
  ctx.font = font(20, 'italic');
  ctx.fillText('Your first page is waiting.', PAGE_W / 2, PAGE_H / 2);
  ctx.restore();
}

export function paintDiaryPage(ctx: CanvasRenderingContext2D, spec: PageSpec, index: number): void {
  if (spec.kind !== 'custom') {
    paintPage(ctx, spec, index);
    return;
  }
  const side = sideOf(index);
  switch (spec.name) {
    case 'diary-cover':
      drawCover(ctx, spec.data?.owner ?? '', spec.data?.title ?? DIARY_NAME, {
        name: spec.data?.labelName ?? spec.data?.owner, class: spec.data?.labelClass, year: spec.data?.labelYear,
      });
      return;
    case 'diary-back':
      drawCoverBase(ctx, side);
      if (pageTheme().cover.style === 'card') drawTimesTable(ctx);
      return;
    case 'diary-owner':
      drawOwnerPage(ctx, spec.data?.owner ?? '', side, spec.data?.intro, spec.data?.footer);
      return;
    case 'diary-empty':
      drawEmptyPage(ctx, side);
      return;
    default:
      paintPage(ctx, spec, index);
  }
}
