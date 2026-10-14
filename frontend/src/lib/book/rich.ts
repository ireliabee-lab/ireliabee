/**
 * Rich text as plain text plus formatting ranges.
 *
 * Keeping the text itself plain means every existing piece of the pipeline
 * (caret mapping, typesetting, search) keeps working; formatting rides
 * alongside as character ranges ("marks") and one style per line ("paras").
 * Every edit is expressed as a single replace, and marks are remapped around
 * it, so formatting stays attached to the words it was applied to.
 */

export type BoolMark = 'bold' | 'italic' | 'underline' | 'strike';
export type ValueMark = 'color' | 'highlight';
export type MarkType = BoolMark | ValueMark;
/** Per-line styles. Image lines carry their picture id: `image:<id>`. */
export type ParaStyle =
  | 'normal'
  | 'bullet'
  /** A key point: a bullet drawn as a star (notebooks). */
  | 'key'
  | 'numbered'
  | 'check'
  | 'checked'
  | 'quote'
  | 'center'
  | 'heading'
  | 'divider'
  | 'table'
  | `image:${string}`;

export type ToggleParaStyle = Exclude<ParaStyle, 'normal' | 'checked' | 'divider' | `image:${string}`>;

/** Stands in for an image in the text; every image line holds exactly this. */
export const OBJECT_CHAR = '\uFFFC';

export const isImagePara = (p: ParaStyle | undefined): p is `image:${string}` => !!p && p.startsWith('image:');
export const imageIdOf = (p: ParaStyle | undefined): string | null => (isImagePara(p) ? p.slice(6) : null);

export interface Mark {
  readonly type: MarkType;
  readonly start: number;
  readonly end: number;
  readonly value?: string;
}

export interface InlineStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly color?: string;
  readonly highlight?: string;
  /** Heading size (used for heading paragraphs, never stored as a mark). */
  readonly large?: boolean;
}

export interface RichDoc {
  readonly text: string;
  readonly marks: readonly Mark[];
  /** One style per line (lines are separated by \n). */
  readonly paras: readonly ParaStyle[];
}

export interface StyledRange {
  readonly start: number;
  readonly end: number;
  readonly style: InlineStyle;
}

export const BOOL_MARKS: readonly BoolMark[] = ['bold', 'italic', 'underline', 'strike'];

export function plainDoc(text: string): RichDoc {
  return { text, marks: [], paras: text.split('\n').map(() => 'normal') };
}

export function lineCount(text: string): number {
  return text.split('\n').length;
}

/** Makes paras match the line count (older entries have none). */
export function withParas(doc: { text: string; marks?: readonly Mark[]; paras?: readonly ParaStyle[] }): RichDoc {
  const n = lineCount(doc.text);
  const paras = (doc.paras ?? []).slice(0, n);
  while (paras.length < n) paras.push('normal');
  return { text: doc.text, marks: normalizeMarks(doc.marks ?? [], doc.text.length), paras };
}

export function isEmptyStyle(s: InlineStyle): boolean {
  return !s.bold && !s.italic && !s.underline && !s.strike && !s.color && !s.highlight;
}

export function sameStyle(a: InlineStyle, b: InlineStyle): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike &&
    (a.color ?? '') === (b.color ?? '') &&
    (a.highlight ?? '') === (b.highlight ?? '')
  );
}

/** Sorts, clamps, drops empty ranges and merges touching ranges of the same kind. */
export function normalizeMarks(marks: readonly Mark[], length: number): Mark[] {
  const clamped = marks
    .map((m) => ({ ...m, start: Math.max(0, Math.min(m.start, length)), end: Math.max(0, Math.min(m.end, length)) }))
    .filter((m) => m.end > m.start)
    .sort((a, b) => (a.type === b.type ? (a.value ?? '').localeCompare(b.value ?? '') || a.start - b.start : a.type.localeCompare(b.type)));
  const out: Mark[] = [];
  for (const m of clamped) {
    const last = out[out.length - 1];
    if (last && last.type === m.type && (last.value ?? '') === (m.value ?? '') && m.start <= last.end) {
      out[out.length - 1] = { ...last, end: Math.max(last.end, m.end) };
    } else out.push(m);
  }
  return out;
}

/** The style of the character at `pos`. */
export function styleAt(marks: readonly Mark[], pos: number): InlineStyle {
  const s: { -readonly [K in keyof InlineStyle]: InlineStyle[K] } = {};
  for (const m of marks) {
    if (m.start <= pos && pos < m.end) {
      if (m.type === 'color' || m.type === 'highlight') s[m.type] = m.value;
      else s[m.type] = true;
    }
  }
  return s;
}

/** Uniformly styled ranges covering [from, to). */
export function styledRanges(marks: readonly Mark[], from: number, to: number): StyledRange[] {
  if (to <= from) return [];
  const cuts = new Set<number>([from, to]);
  for (const m of marks) {
    if (m.end <= from || m.start >= to) continue;
    cuts.add(Math.max(from, m.start));
    cuts.add(Math.min(to, m.end));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: StyledRange[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i] as number;
    const end = points[i + 1] as number;
    const style = styleAt(marks, start);
    const prev = out[out.length - 1];
    if (prev && prev.end === start && sameStyle(prev.style, style)) out[out.length - 1] = { ...prev, end };
    else out.push({ start, end, style });
  }
  return out;
}

function styleToMarks(style: InlineStyle, start: number, end: number): Mark[] {
  const out: Mark[] = [];
  for (const t of BOOL_MARKS) if (style[t]) out.push({ type: t, start, end });
  if (style.color) out.push({ type: 'color', start, end, value: style.color });
  if (style.highlight) out.push({ type: 'highlight', start, end, value: style.highlight });
  return out;
}

/** The single replace that turns `before` into `after`. */
export function diffText(before: string, after: string): { start: number; deleteCount: number; insert: string } {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let tail = 0;
  while (
    tail < max - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;
  return { start, deleteCount: before.length - start - tail, insert: after.slice(start, after.length - tail) };
}

/**
 * Replaces `deleteCount` characters at `start` with `insert`. Inserted text
 * takes `inherit` if given, otherwise the style of the character before it
 * (or after it, at the start of a line) — the way word processors behave.
 */
export function replaceText(doc: RichDoc, start: number, deleteCount: number, insert: string, inherit?: InlineStyle | null): RichDoc {
  const end = start + deleteCount;
  const delta = insert.length - deleteCount;
  const insEnd = start + insert.length;

  const mapStart = (p: number): number => (p < start ? p : p >= end ? p + delta : insEnd);
  const mapEnd = (p: number): number => (p <= start ? p : p >= end ? p + delta : start);

  let style: InlineStyle;
  if (inherit) style = inherit;
  else if (start > 0 && doc.text[start - 1] !== '\n') style = styleAt(doc.marks, start - 1);
  else style = styleAt(doc.marks, end);

  const text = doc.text.slice(0, start) + insert + doc.text.slice(end);
  const moved = doc.marks.map((m) => ({ ...m, start: mapStart(m.start), end: mapEnd(m.end) }));
  const added = insert.length ? styleToMarks(style, start, insEnd).map((m) => splitAtNewlines(m, text)).flat() : [];
  const marks = normalizeMarks([...moved, ...added], text.length);

  // Paragraph styles: lines created by the edit inherit the line they split from.
  const line = lineIndexAt(doc.text, start);
  const removed = (doc.text.slice(start, end).match(/\n/g) ?? []).length;
  const addedLines = (insert.match(/\n/g) ?? []).length;
  const base = continuation(doc.paras[line] ?? 'normal');
  const paras = [
    ...doc.paras.slice(0, line + 1),
    ...Array<ParaStyle>(addedLines).fill(base),
    ...doc.paras.slice(line + 1 + removed),
  ];
  return withParas({ text, marks, paras });
}

/** The style a new line gets when you press Enter on a line with this style. */
export function continuation(style: ParaStyle): ParaStyle {
  if (style === 'checked') return 'check';
  if (style === 'heading' || style === 'divider' || isImagePara(style)) return 'normal';
  return style;
}

/**
 * Keeps images on lines of their own and dividers empty. Returns the fixed
 * document and where a caret at `caret` ends up.
 */
export function normalizeBlocks(doc: RichDoc, caret: number): { doc: RichDoc; caret: number } {
  const ranges = lineRanges(doc.text);
  const needsWork = ranges.some((r, i) => {
    const text = doc.text.slice(r.start, r.end);
    const p = doc.paras[i];
    return (
      (isImagePara(p) && text !== OBJECT_CHAR) ||
      (!isImagePara(p) && text.includes(OBJECT_CHAR)) ||
      (p === 'divider' && text.length > 0)
    );
  });
  if (!needsWork) return { doc, caret };

  let out = doc;
  let at = caret;
  // Walk from the end so earlier offsets stay valid while we edit.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i] as { start: number; end: number };
    const text = out.text.slice(r.start, r.end);
    const p = out.paras[i] ?? 'normal';
    if (p === 'divider' && text.length) {
      const paras = out.paras.slice();
      paras[i] = 'normal';
      out = { ...out, paras };
      continue;
    }
    const obj = text.indexOf(OBJECT_CHAR);
    if (isImagePara(p) && obj < 0) {
      const paras = out.paras.slice();
      paras[i] = 'normal';
      out = { ...out, paras };
      continue;
    }
    if (obj < 0) continue;
    if (!isImagePara(p)) {
      // A stray object character (e.g. after merging lines) is removed.
      out = replaceText(out, r.start + obj, 1, '');
      if (at > r.start + obj) at -= 1;
      continue;
    }
    // Split text off either side of the image onto its own lines.
    const after = r.start + obj + 1;
    if (after < r.end) {
      out = replaceText(out, after, 0, '\n');
      const paras = out.paras.slice();
      paras[i + 1] = 'normal';
      out = { ...out, paras };
      if (at >= after) at += 1;
    }
    if (obj > 0) {
      out = replaceText(out, r.start + obj, 0, '\n');
      const paras = out.paras.slice();
      paras[i] = 'normal';
      paras[i + 1] = p;
      out = { ...out, paras };
      // Text typed just before the image stays on its own line, caret included.
      if (at > r.start + obj) at += 1;
    }
  }
  return { doc: withParas(out), caret: at };
}

/** Sets the style of one line directly (e.g. ticking a checklist item). */
export function setLineStyle(doc: RichDoc, line: number, style: ParaStyle): RichDoc {
  if (line < 0 || line >= doc.paras.length) return doc;
  const paras = doc.paras.slice();
  paras[line] = style;
  return { ...doc, paras };
}

/** Formatting never needs to cover line breaks themselves. */
function splitAtNewlines(m: Mark, text: string): Mark[] {
  const out: Mark[] = [];
  let s = m.start;
  for (let i = m.start; i < m.end; i++) {
    if (text[i] === '\n') {
      if (i > s) out.push({ ...m, start: s, end: i });
      s = i + 1;
    }
  }
  if (m.end > s) out.push({ ...m, start: s, end: m.end });
  return out;
}

export function lineIndexAt(text: string, pos: number): number {
  let n = 0;
  for (let i = 0; i < pos && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

/** [start, end) of every line, in order. */
export function lineRanges(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let s = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      out.push({ start: s, end: i });
      s = i + 1;
    }
  }
  return out;
}

function removeType(marks: readonly Mark[], type: MarkType, a: number, b: number): Mark[] {
  const out: Mark[] = [];
  for (const m of marks) {
    if (m.type !== type || m.end <= a || m.start >= b) {
      out.push(m);
      continue;
    }
    if (m.start < a) out.push({ ...m, end: a });
    if (m.end > b) out.push({ ...m, start: b });
  }
  return out;
}

/** True when every non-newline character in [a, b) has the mark. */
export function hasMarkThroughout(doc: RichDoc, type: BoolMark, a: number, b: number): boolean {
  let any = false;
  for (let i = a; i < b; i++) {
    if (doc.text[i] === '\n') continue;
    any = true;
    if (!styleAt(doc.marks, i)[type]) return false;
  }
  return any;
}

export function toggleMark(doc: RichDoc, type: BoolMark, a: number, b: number): RichDoc {
  if (b <= a) return doc;
  const on = hasMarkThroughout(doc, type, a, b);
  const stripped = removeType(doc.marks, type, a, b);
  const added = on ? [] : splitAtNewlines({ type, start: a, end: b }, doc.text);
  return { ...doc, marks: normalizeMarks([...stripped, ...added], doc.text.length) };
}

/** Sets (or with null, removes) a colour or highlight over [a, b). */
export function setValueMark(doc: RichDoc, type: ValueMark, value: string | null, a: number, b: number): RichDoc {
  if (b <= a) return doc;
  const stripped = removeType(doc.marks, type, a, b);
  const added = value ? splitAtNewlines({ type, start: a, end: b, value }, doc.text) : [];
  return { ...doc, marks: normalizeMarks([...stripped, ...added], doc.text.length) };
}

export function clearFormatting(doc: RichDoc, a: number, b: number): RichDoc {
  let marks: Mark[] = [...doc.marks];
  for (const t of [...BOOL_MARKS, 'color', 'highlight'] as MarkType[]) marks = removeType(marks, t, a, b);
  const paras = doc.paras.slice();
  const first = lineIndexAt(doc.text, a);
  const last = lineIndexAt(doc.text, b);
  // Text styles reset; images, dividers and tables are content, not formatting.
  for (let i = first; i <= last; i++) {
    const p = paras[i];
    if (!isImagePara(p) && p !== 'divider' && p !== 'table') paras[i] = 'normal';
  }
  return { ...doc, marks: normalizeMarks(marks, doc.text.length), paras };
}

/** Applies a paragraph style to every line the range touches (toggling back to normal if all have it). */
export function toggleParaStyle(doc: RichDoc, style: ToggleParaStyle, a: number, b: number): RichDoc {
  const first = lineIndexAt(doc.text, a);
  const last = lineIndexAt(doc.text, b);
  const paras = doc.paras.slice();
  const same = (p: ParaStyle | undefined) => p === style || (style === 'check' && p === 'checked');
  let all = true;
  for (let i = first; i <= last; i++) if (!same(paras[i]) && !isImagePara(paras[i])) all = false;
  for (let i = first; i <= last; i++) {
    if (isImagePara(paras[i]) || paras[i] === 'divider') continue;
    paras[i] = all ? 'normal' : style === 'check' && paras[i] === 'checked' ? 'checked' : style;
  }
  return { ...doc, paras };
}

/** The style to show in the toolbar for a selection (or the caret). */
export function selectionState(doc: RichDoc, a: number, b: number): InlineStyle & { para: ParaStyle } {
  const para = doc.paras[lineIndexAt(doc.text, a)] ?? 'normal';
  if (b <= a) {
    const at = a > 0 && doc.text[a - 1] !== '\n' ? a - 1 : a;
    return { ...styleAt(doc.marks, at), para };
  }
  const s = styleAt(doc.marks, a);
  return {
    bold: hasMarkThroughout(doc, 'bold', a, b),
    italic: hasMarkThroughout(doc, 'italic', a, b),
    underline: hasMarkThroughout(doc, 'underline', a, b),
    strike: hasMarkThroughout(doc, 'strike', a, b),
    ...(s.color ? { color: s.color } : {}),
    ...(s.highlight ? { highlight: s.highlight } : {}),
    para,
  };
}
