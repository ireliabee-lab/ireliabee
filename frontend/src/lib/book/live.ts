import { assemblePages, type PageSpec } from './book';
import { caretPosition, parseManuscript, sourceOffset, type ChapterLabel, type Manuscript } from './manuscript';
import { caretRect, hitTestLine, LAYOUT, lineRect, onCheckbox, tableCaretX, tableHit, type PageRect } from './pages';
import type { PageContent, TextLine, Typesetter } from './typeset';

/** Physical index of the first text page (after cover, endpaper, title page). */
export const FIRST_TEXT_PAGE = 3;

export interface LiveUpdate {
  readonly pages: readonly PageSpec[];
  /** Physical page indices whose painted content differs from before. */
  readonly changed: readonly number[];
  /** Paragraphs re-wrapped vs. reused from cache. */
  readonly wrapped: number;
  readonly reused: number;
  /** Parse + typeset + diff time in ms. */
  readonly ms: number;
}

export interface LiveBookOptions {
  /** Physical page order around the text pages (defaults to the novel layout). */
  readonly assemble?: (textPages: readonly PageContent[]) => PageSpec[];
  /** How chapter headings are labelled (defaults to roman numerals). */
  readonly chapterLabel?: ChapterLabel;
  /** Custom parser, e.g. to attach formatting the plain-text source can't express. */
  readonly parse?: (source: string) => Manuscript;
}

/** A caret drawn on a page (logical page units). */
export interface CaretPoint {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly h: number;
}

export interface PageSelectionRect extends PageRect {
  readonly page: number;
}

interface Position {
  readonly page: number;
  readonly lineIndex: number;
  readonly line: TextLine;
  readonly wordInLine: number;
  readonly char: number;
}

export interface CaretLocation {
  readonly page: number;
  readonly line: number | 'chapter';
  readonly rect: PageRect | null;
}

/** A cheap fingerprint of everything that affects how a page is painted. */
export function pageSignature(spec: PageSpec): string {
  if (spec.kind === 'custom') return `custom:${spec.name}:${JSON.stringify(spec.data ?? {})}`;
  if (spec.kind === 'blank') return `blank:${spec.folio ?? ''}`;
  if (spec.kind !== 'text') return spec.kind;
  const { chapter, lines, isLast } = spec.content;
  let sig = chapter ? `#${chapter.numeral}|${chapter.title}\n` : '';
  for (const l of lines) {
    sig += `${l.indent}|${l.justify ? 1 : 0}|${l.dropCap ?? ''}|${l.align ?? ''}|${l.bullet ? (l.star ? 2 : 1) : 0}|${l.quote ? 1 : 0}|${l.words.join(' ')}`;
    sig += `|${l.marker ?? ''}${l.number ?? ''}|${l.heading ? 1 : 0}|${l.divider ? 1 : 0}|${l.image ? `${l.image.id}:${l.image.lines}` : ''}`;
    if (l.table) sig += `|${l.table.row}/${l.table.cols}/${l.table.last ? 1 : 0}|${l.cellOfWord?.join(',') ?? ''}`;
    // Formatting-only edits (bold, colour, highlight) must repaint the page too.
    if (l.spans) sig += `|${JSON.stringify(l.spans)}`;
    sig += '\n';
  }
  sig += `#${spec.folio ?? ''}`;
  return isLast ? `${sig}$` : sig;
}

export function spreadOf(pageIndex: number): number {
  return pageIndex % 2 === 0 ? pageIndex / 2 : (pageIndex + 1) / 2;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class LiveBook {
  source = '';
  manuscript: Manuscript = { blocks: [], ranges: [] };
  pages: readonly PageSpec[] = [];
  private textPages: readonly PageContent[] = [];
  private signatures: string[] = [];
  /** Physical index of each text page, in order. */
  private textIndex: number[] = [];
  private readonly assemble: (textPages: readonly PageContent[]) => PageSpec[];
  private readonly chapterLabel?: ChapterLabel;
  private readonly parse?: (source: string) => Manuscript;

  constructor(
    private readonly typesetter: Typesetter,
    source: string,
    options: LiveBookOptions = {},
  ) {
    this.assemble = options.assemble ?? assemblePages;
    this.chapterLabel = options.chapterLabel;
    this.parse = options.parse;
    this.update(source);
  }

  /** Physical index of the last text page, or of the page text would start on. */
  get lastTextPage(): number {
    return this.textIndex[this.textIndex.length - 1] ?? FIRST_TEXT_PAGE;
  }

  update(source: string): LiveUpdate {
    const start = now();
    this.source = source;
    this.manuscript = this.parse ? this.parse(source) : parseManuscript(source, this.chapterLabel);
    this.textPages = this.typesetter.typeset(this.manuscript.blocks);
    const pages = this.assemble(this.textPages);
    this.textIndex = pages.flatMap((p, i) => (p.kind === 'text' ? [i] : []));
    const signatures = pages.map(pageSignature);
    const changed: number[] = [];
    const span = Math.max(signatures.length, this.signatures.length);
    for (let i = 0; i < span; i++) if (signatures[i] !== this.signatures[i]) changed.push(i);
    this.pages = pages;
    this.signatures = signatures;
    const { wrapped, reused } = this.typesetter.stats;
    return { pages, changed, wrapped, reused, ms: now() - start };
  }

  /** The page and line the caret is on. */
  locate(caret: number): CaretLocation | null {
    const pos = caretPosition(this.source, this.manuscript, caret);
    if (!pos) return null;
    const isChapter = this.manuscript.blocks[pos.block]?.kind === 'chapter';
    let found: { page: number; line: number | 'chapter' } | null = null;
    let inBlock = false;

    this.textPages.forEach((content, i) => {
      const page = this.textIndex[i] ?? FIRST_TEXT_PAGE + i;
      if (isChapter) {
        if (content.chapter?.block === pos.block) found = { page, line: 'chapter' };
        return;
      }
      content.lines.forEach((line, li) => {
        if (line.block !== pos.block) return;
        // A block's first line always matches (the caret may be in its drop cap).
        if (!inBlock || line.firstWord <= pos.word) found = { page, line: li };
        inBlock = true;
      });
    });

    if (!found) {
      // Caret in an empty block: fall back to the nearest earlier text.
      return { page: this.lastTextPage, line: 0, rect: null };
    }
    const { page, line } = found as { page: number; line: number | 'chapter' };
    const spec = this.pages[page];
    return { page, line, rect: spec ? lineRect(spec, page, line) : null };
  }

  /** Source offset for a tap at logical (x, y) on a page, or null off the text. */
  caretAt(pageIndex: number, x: number, y: number): number | null {
    const spec = this.pages[pageIndex];
    if (!spec || spec.kind !== 'text') return null;
    const hit = hitTestLine(spec, pageIndex, x, y);
    if (!hit) return null;
    if (hit.line === 'chapter') {
      const block = spec.content.chapter?.block;
      return block === undefined ? null : sourceOffset(this.source, this.manuscript, { block, word: 0 });
    }
    const line = spec.content.lines[hit.line];
    if (!line) return null;
    if (line.table) {
      const range = this.manuscript.ranges[line.block];
      if (!range) return null;
      const raw = this.source.slice(range.start, range.end);
      const texts = raw.split('\t');
      const { cell, char } = tableHit(line, pageIndex, x, texts);
      if (cell >= texts.length) return range.end;
      const before = texts.slice(0, cell).reduce((n, t) => n + t.length + 1, 0);
      return range.start + before + Math.min(char, (texts[cell] ?? '').length);
    }
    const cap = line.dropCap ?? '';
    // On a drop-cap line the first word's source text starts with the capital.
    const consumed = cap && line.firstWord > 0; // the capital was a whole word
    let word = line.firstWord + hit.word;
    let char = hit.char;
    if (cap && hit.word === 0) {
      if (hit.char < 0) {
        word = consumed ? line.firstWord - 1 : line.firstWord;
        char = 0;
      } else if (!consumed) char += cap.length;
    }
    const start = sourceOffset(this.source, this.manuscript, { block: line.block, word });
    return start === null ? null : start + Math.max(0, char);
  }

  /** Page, line, word and character of a source offset. */
  private position(offset: number): Position | null {
    const pos = caretPosition(this.source, this.manuscript, offset);
    if (!pos || this.manuscript.blocks[pos.block]?.kind === 'chapter') return null;
    const wordStart = sourceOffset(this.source, this.manuscript, pos) ?? offset;
    const char = Math.max(0, offset - wordStart);
    let found: Position | null = null;
    let inBlock = false;
    this.textPages.forEach((content, i) => {
      const page = this.textIndex[i] ?? FIRST_TEXT_PAGE + i;
      content.lines.forEach((line, lineIndex) => {
        if (line.block !== pos.block) return;
        if (!inBlock || line.firstWord <= pos.word) {
          found = { page, lineIndex, line, wordInLine: pos.word - line.firstWord, char };
        }
        inBlock = true;
      });
    });
    return found;
  }

  /** Where to draw the text cursor for a source offset. */
  caretPoint(offset: number): CaretPoint | null {
    const p = this.position(offset);
    if (!p) return null;
    if (p.line.table) {
      const range = this.manuscript.ranges[p.line.block];
      const spec = this.pages[p.page];
      const base = spec ? caretRect(spec, p.page, p.lineIndex, 0, 0) : null;
      if (!range || !base) return null;
      const rel = Math.max(0, Math.min(offset, range.end) - range.start);
      const raw = this.source.slice(range.start, range.end);
      const cell = (raw.slice(0, rel).match(/\t/g) ?? []).length;
      const cellStart = raw.lastIndexOf('\t', rel - 1) + 1;
      return { page: p.page, x: tableCaretX(p.line, p.page, cell, raw.slice(cellStart, rel)), y: base.y, h: base.h };
    }
    const spec = this.pages[p.page];
    const r = spec ? caretRect(spec, p.page, p.lineIndex, p.wordInLine, p.char) : null;
    return r ? { page: p.page, ...r } : null;
  }

  /** Highlight rectangles covering the source range [a, b). */
  selectionRects(a: number, b: number): PageSelectionRect[] {
    if (b <= a) return [];
    const from = this.caretPoint(a);
    const to = this.caretPoint(b);
    if (!from || !to) return [];
    const out: PageSelectionRect[] = [];
    const top = (p: CaretPoint): number => p.y - 3;
    this.textIndex.forEach((page) => {
      if (page < from.page || page > to.page) return;
      const spec = this.pages[page];
      if (!spec || spec.kind !== 'text') return;
      const first = spec.content.chapter ? LAYOUT.chapterLines : 0;
      spec.content.lines.forEach((line, i) => {
        const rect = lineRect(spec, page, i);
        if (!rect) return;
        const y = LAYOUT.top + (first + i) * LAYOUT.lineHeight + 2 - 3;
        const startsHere = page === from.page && Math.abs(y - top(from)) < 1;
        const endsHere = page === to.page && Math.abs(y - top(to)) < 1;
        const afterStart = page > from.page || y >= top(from) - 0.5;
        const beforeEnd = page < to.page || y <= top(to) + 0.5;
        if (!afterStart || !beforeEnd) return;
        const x1 = startsHere ? from.x : rect.x + line.indent;
        const lineEnd = rect.x + (line.measure ?? rect.w);
        const x2 = endsHere ? to.x : lineEnd;
        if (x2 > x1) out.push({ page, x: x1, y, w: x2 - x1, h: LAYOUT.lineHeight - 2 });
      });
    });
    return out;
  }

  /** The block whose checklist box is under a tap, if any. */
  checkboxAt(pageIndex: number, x: number, y: number): number | null {
    const spec = this.pages[pageIndex];
    if (!spec || spec.kind !== 'text') return null;
    const hit = hitTestLine(spec, pageIndex, x, y);
    if (!hit || hit.line === 'chapter') return null;
    const line = spec.content.lines[hit.line];
    return line && onCheckbox(line, pageIndex, x) ? line.block : null;
  }

  /** Pages that show a given picture (to repaint once it has loaded). */
  pagesWithImage(id: string): number[] {
    const out: number[] = [];
    this.textPages.forEach((content, i) => {
      if (content.lines.some((l) => l.image?.id === id)) out.push(this.textIndex[i] ?? FIRST_TEXT_PAGE + i);
    });
    return out;
  }

  /** Start or end of the printed line the offset sits on. */
  lineEdge(offset: number, edge: 'start' | 'end'): number {
    const p = this.position(offset);
    if (!p) return offset;
    const { line } = p;
    if (line.table) {
      const range = this.manuscript.ranges[line.block];
      if (range) return edge === 'start' ? range.start : range.end;
    }
    const cap = line.dropCap ?? '';
    const consumed = !!cap && line.firstWord > 0;
    if (edge === 'start' || !line.words.length) {
      const word = consumed ? line.firstWord - 1 : line.firstWord;
      return sourceOffset(this.source, this.manuscript, { block: line.block, word }) ?? offset;
    }
    const lastIndex = line.words.length - 1;
    const lastWord = line.firstWord + lastIndex;
    const start = sourceOffset(this.source, this.manuscript, { block: line.block, word: lastWord }) ?? offset;
    const capExtra = cap && !consumed && lastIndex === 0 ? cap.length : 0;
    return start + (line.words[lastIndex]?.length ?? 0) + capExtra;
  }

  /** The offset one line above (-1) or below (1), keeping the cursor's x, crossing pages as needed. */
  verticalMove(offset: number, dir: -1 | 1): number {
    const p = this.position(offset);
    const point = this.caretPoint(offset);
    if (!p || !point) return offset;
    const spec = this.pages[p.page];
    if (!spec || spec.kind !== 'text') return offset;
    const targetRow = p.lineIndex + dir;
    const first = (s: typeof spec) => (s.kind === 'text' && s.content.chapter ? LAYOUT.chapterLines : 0);
    const rowY = (s: typeof spec, row: number) => LAYOUT.top + (first(s) + row) * LAYOUT.lineHeight + LAYOUT.lineHeight / 2;
    if (targetRow >= 0 && targetRow < spec.content.lines.length) {
      return this.caretAt(p.page, point.x, rowY(spec, targetRow)) ?? offset;
    }
    const at = this.textIndex.indexOf(p.page);
    const neighbour = this.textIndex[at + dir];
    const next = neighbour === undefined ? undefined : this.pages[neighbour];
    if (neighbour === undefined || !next || next.kind !== 'text' || !next.content.lines.length) {
      return dir < 0 ? offset : offset;
    }
    const row = dir < 0 ? next.content.lines.length - 1 : 0;
    // Keep the same distance from the text's left edge on the facing page.
    const shift = (neighbour % 2 === 0 ? LAYOUT.inner : LAYOUT.outer) - (p.page % 2 === 0 ? LAYOUT.inner : LAYOUT.outer);
    return this.caretAt(neighbour, point.x + shift, rowY(next, row)) ?? offset;
  }
}
