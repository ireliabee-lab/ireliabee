/**
 * A small rich-text editor on a contenteditable element.
 *
 * The browser handles typing, deleting, spellcheck and phone keyboards
 * natively. After each change the DOM is read back as plain text, diffed
 * against the model, the formatting is remapped, and the DOM is re-rendered
 * from the model — so the model is always the source of truth and nothing
 * the browser invents (stray <b>, pasted styles) survives. Line breaks,
 * paste and undo are handled by the editor itself.
 */

import {
  clearFormatting,
  diffText,
  isEmptyStyle,
  isImagePara,
  lineIndexAt,
  lineRanges,
  normalizeBlocks,
  setLineStyle,
  plainDoc,
  replaceText,
  selectionState,
  setValueMark,
  styledRanges,
  toggleMark,
  toggleParaStyle,
  type BoolMark,
  type InlineStyle,
  type ParaStyle,
  type RichDoc,
  type ToggleParaStyle,
} from '../rich';

export const INK_COLORS: readonly { readonly name: string; readonly value: string }[] = [
  { name: 'Ink', value: '#2C2521' },
  { name: 'Oxblood', value: '#8A1F2D' },
  { name: 'Indigo', value: '#2B3F8C' },
  { name: 'Forest', value: '#2F6B3E' },
  { name: 'Plum', value: '#6A2C70' },
  { name: 'Sepia', value: '#8A5A2B' },
];

export const HIGHLIGHTS: readonly { readonly name: string; readonly value: string }[] = [
  { name: 'Yellow', value: 'rgba(247, 214, 76, 0.55)' },
  { name: 'Pink', value: 'rgba(242, 140, 176, 0.5)' },
  { name: 'Green', value: 'rgba(140, 207, 130, 0.5)' },
  { name: 'Blue', value: 'rgba(130, 182, 235, 0.5)' },
  { name: 'Orange', value: 'rgba(245, 168, 92, 0.5)' },
];

export interface Selection {
  readonly start: number;
  readonly end: number;
}

export interface EditorState extends InlineStyle {
  readonly para: ParaStyle;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

interface Snapshot {
  readonly doc: RichDoc;
  readonly sel: Selection;
}

export interface RichEditorOptions {
  readonly onChange?: (doc: RichDoc) => void;
  readonly onSelect?: () => void;
  readonly placeholder?: string;
}

const BLOCKS = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'BLOCKQUOTE']);
const TYPING_GROUP_MS = 900;

/** Reads editor DOM (or a fragment of it) back as plain text. */
export function serialize(root: Node): string {
  let out = '';
  let started = false;
  const walk = (node: Node): void => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        out += (child as Text).data;
        started = true;
        return;
      }
      if (!(child instanceof Element)) return;
      if (child.tagName === 'BR') {
        // A trailing <br> just props open an empty line; any other is a break.
        if (child.nextSibling) out += '\n';
        return;
      }
      if (BLOCKS.has(child.tagName)) {
        if (started) out += '\n';
        started = true;
      }
      walk(child);
    });
  };
  walk(root);
  return out.replace(/\u00A0/g, ' ');
}

export class RichEditor {
  readonly el: HTMLElement;
  private doc: RichDoc = plainDoc('');
  private readonly options: RichEditorOptions;
  private saved: Selection = { start: 0, end: 0 };
  private pending: InlineStyle | null = null;
  private composing = false;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastTyping = 0;

  constructor(el: HTMLElement, options: RichEditorOptions = {}) {
    this.el = el;
    this.options = options;
    el.setAttribute('contenteditable', 'true');
    el.tabIndex = 0;
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-multiline', 'true');
    el.spellcheck = true;
    if (options.placeholder) el.dataset.placeholder = options.placeholder;
    el.addEventListener('input', this.onInput);
    el.addEventListener('keydown', this.onKeyDown);
    el.addEventListener('beforeinput', this.onBeforeInput);
    el.addEventListener('paste', this.onPaste);
    el.addEventListener('drop', this.onDrop);
    el.addEventListener('compositionstart', this.onCompositionStart);
    el.addEventListener('compositionend', this.onCompositionEnd);
    el.addEventListener('keyup', this.onSelect);
    el.addEventListener('pointerup', this.onSelect);
    document.addEventListener('selectionchange', this.onSelect);
    this.render();
  }

  // ── Model access ───────────────────────────────────────────────────────────

  get value(): RichDoc {
    return this.doc;
  }

  get text(): string {
    return this.doc.text;
  }

  /** Replaces the whole document (e.g. switching entries) and clears history. */
  setDoc(doc: RichDoc, caret = doc.text.length): void {
    this.doc = doc;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.render();
    this.setSelection(caret);
  }

  focus(): void {
    this.el.focus();
    this.setSelection(this.saved.start, this.saved.end);
  }

  hasFocus(): boolean {
    return document.activeElement === this.el;
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  /** Current selection in text offsets (the last known one when unfocused). */
  selection(): Selection {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode || !this.el.contains(sel.anchorNode) || !sel.focusNode) {
      return this.saved;
    }
    const a = this.offsetOf(sel.anchorNode, sel.anchorOffset);
    const b = this.offsetOf(sel.focusNode, sel.focusOffset);
    this.saved = { start: Math.min(a, b), end: Math.max(a, b) };
    return this.saved;
  }

  setSelection(start: number, end = start): void {
    const len = this.doc.text.length;
    const s = Math.max(0, Math.min(start, len));
    const e = Math.max(0, Math.min(end, len));
    this.saved = { start: Math.min(s, e), end: Math.max(s, e) };
    const sel = document.getSelection();
    if (!sel || !this.hasFocus()) return;
    const [an, ao] = this.pointAt(this.saved.start);
    const [fn, fo] = this.pointAt(this.saved.end);
    const range = document.createRange();
    range.setStart(an, ao);
    range.setEnd(fn, fo);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  private offsetOf(node: Node, offset: number): number {
    const range = document.createRange();
    range.setStart(this.el, 0);
    try {
      range.setEnd(node, offset);
    } catch {
      return this.saved.start;
    }
    let n = serialize(range.cloneContents()).length;
    // A caret between two line elements belongs to the start of the next line.
    if (node === this.el && offset > 0 && offset < this.el.childNodes.length) n += 1;
    return n;
  }

  private pointAt(offset: number): [Node, number] {
    let pos = 0;
    let started = false;
    let found: [Node, number] | null = null;
    const walk = (node: Node): void => {
      for (const child of Array.from(node.childNodes)) {
        if (found) return;
        if (child.nodeType === Node.TEXT_NODE) {
          const len = (child as Text).data.length;
          if (offset <= pos + len) {
            found = [child, offset - pos];
            return;
          }
          pos += len;
          started = true;
        } else if (child instanceof Element) {
          if (child.tagName === 'BR') {
            if (child.nextSibling) pos += 1;
            continue;
          }
          if (BLOCKS.has(child.tagName)) {
            if (started) pos += 1;
            started = true;
            if (offset === pos && !child.textContent) {
              found = [child, 0];
              return;
            }
          }
          walk(child);
        }
      }
    };
    walk(this.el);
    return found ?? [this.el, this.el.childNodes.length];
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private render(): void {
    const { text, marks, paras } = this.doc;
    const frag = document.createDocumentFragment();
    lineRanges(text).forEach((r, i) => {
      const line = document.createElement('div');
      line.className = 'line';
      const para = paras[i] ?? 'normal';
      if (para !== 'normal') line.dataset.para = para;
      if (r.end === r.start) line.appendChild(document.createElement('br'));
      for (const run of styledRanges(marks, r.start, r.end)) {
        const t = document.createTextNode(text.slice(run.start, run.end));
        if (isEmptyStyle(run.style)) {
          line.appendChild(t);
          continue;
        }
        const span = document.createElement('span');
        const cls = [run.style.bold && 'b', run.style.italic && 'i', run.style.underline && 'u', run.style.strike && 's'];
        span.className = cls.filter(Boolean).join(' ');
        if (run.style.color) span.style.color = run.style.color;
        if (run.style.highlight) span.style.backgroundColor = run.style.highlight;
        span.appendChild(t);
        line.appendChild(span);
      }
      frag.appendChild(line);
    });
    this.el.replaceChildren(frag);
    this.el.toggleAttribute('data-empty', text.length === 0);
  }

  // ── Editing ────────────────────────────────────────────────────────────────

  private snapshot(): Snapshot {
    return { doc: this.doc, sel: this.saved };
  }

  private remember(typing: boolean): void {
    const now = Date.now();
    if (!typing || now - this.lastTyping > TYPING_GROUP_MS) this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.lastTyping = typing ? now : 0;
    this.redoStack = [];
  }

  private commit(doc: RichDoc, sel: Selection): void {
    // Images always sit on their own line; dividers stay empty.
    const fixed = normalizeBlocks(doc, sel.end);
    const shift = fixed.caret - sel.end;
    this.doc = fixed.doc;
    this.render();
    this.setSelection(sel.start + (sel.start === sel.end ? shift : 0), fixed.caret);
    this.options.onChange?.(doc);
    this.options.onSelect?.();
  }

  /** Reads what the browser did to the DOM and folds it into the model. */
  private readonly onInput = (): void => {
    if (this.composing) return;
    const next = serialize(this.el);
    if (next === this.doc.text) {
      this.render(); // normalise any stray markup the browser added
      this.setSelection(this.saved.start, this.saved.end);
      return;
    }
    const caret = this.selection().end;
    const edit = diffAroundCaret(this.doc.text, next, caret);
    this.remember(true);
    const doc = replaceText(this.doc, edit.start, edit.deleteCount, edit.insert, this.pending);
    this.pending = null;
    const at = edit.start + edit.insert.length;
    this.commit(doc, { start: at, end: at });
  };

  /** Inserts text at the selection through the model. */
  insertText(text: string): void {
    const sel = this.selection();
    this.remember(text !== '\n');
    const doc = replaceText(this.doc, sel.start, sel.end - sel.start, text.replace(/\r\n?/g, '\n'), this.pending);
    this.pending = null;
    const at = sel.start + text.length;
    this.commit(doc, { start: at, end: at });
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.insertText('\n');
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && this.inTable()) {
      e.preventDefault();
      this.moveCell(e.shiftKey ? -1 : 1);
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey) return;
    const key = e.key.toLowerCase();
    const run = (fn: () => void): void => {
      e.preventDefault();
      fn();
    };
    if (key === 'b') run(() => this.toggle('bold'));
    else if (key === 'i') run(() => this.toggle('italic'));
    else if (key === 'u') run(() => this.toggle('underline'));
    else if (key === 'x' && e.shiftKey) run(() => this.toggle('strike'));
    else if (key === 'z' && e.shiftKey) run(() => this.redo());
    else if (key === 'z') run(() => this.undo());
    else if (key === 'y') run(() => this.redo());
    else if (key === '\\') run(() => this.clear());
  };

  private readonly onBeforeInput = (e: InputEvent): void => {
    if (e.inputType === 'historyUndo') {
      e.preventDefault();
      this.undo();
    } else if (e.inputType === 'historyRedo') {
      e.preventDefault();
      this.redo();
    } else if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
      e.preventDefault();
      this.insertText('\n');
    } else if (e.inputType.startsWith('format')) {
      e.preventDefault(); // browser formatting commands bypass the model
    }
  };

  private readonly onPaste = (e: ClipboardEvent): void => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text) this.insertText(text);
  };

  private readonly onDrop = (e: DragEvent): void => {
    e.preventDefault();
    const text = e.dataTransfer?.getData('text/plain') ?? '';
    if (text) this.insertText(text);
  };

  private readonly onCompositionStart = (): void => {
    this.composing = true;
  };

  private readonly onCompositionEnd = (): void => {
    this.composing = false;
    this.onInput();
  };

  private readonly onSelect = (): void => {
    if (!this.hasFocus()) return;
    const before = this.saved;
    const now = this.selection();
    if (now.start !== before.start || now.end !== before.end) this.pending = null;
    this.options.onSelect?.();
  };

  // ── Formatting commands ────────────────────────────────────────────────────

  private applyToSelection(change: (doc: RichDoc, a: number, b: number) => RichDoc): void {
    const sel = this.selection();
    this.remember(false);
    this.commit(change(this.doc, sel.start, sel.end), sel);
  }

  /** With a collapsed caret, formatting applies to what is typed next. */
  private setPending(update: (s: InlineStyle) => InlineStyle): void {
    const sel = this.selection();
    const { para: _p, canUndo: _u, canRedo: _r, ...current } = this.state();
    this.pending = update(this.pending ?? current);
    if (this.hasFocus()) this.setSelection(sel.start, sel.end);
    this.options.onSelect?.();
  }

  toggle(type: BoolMark): void {
    const sel = this.selection();
    if (sel.start === sel.end) this.setPending((s) => ({ ...s, [type]: !s[type] }));
    else this.applyToSelection((d, a, b) => toggleMark(d, type, a, b));
  }

  setColor(value: string | null): void {
    const sel = this.selection();
    if (sel.start === sel.end) this.setPending((s) => ({ ...s, color: value ?? undefined }));
    else this.applyToSelection((d, a, b) => setValueMark(d, 'color', value, a, b));
  }

  setHighlight(value: string | null): void {
    const sel = this.selection();
    if (sel.start === sel.end) this.setPending((s) => ({ ...s, highlight: value ?? undefined }));
    else this.applyToSelection((d, a, b) => setValueMark(d, 'highlight', value, a, b));
  }

  setPara(style: ToggleParaStyle): void {
    this.applyToSelection((d, a, b) => toggleParaStyle(d, style, a, b));
  }

  clear(): void {
    this.pending = null;
    this.applyToSelection((d, a, b) => clearFormatting(d, a, b));
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot());
    this.lastTyping = 0;
    this.commit(prev.doc, prev.sel);
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.lastTyping = 0;
    this.commit(next.doc, next.sel);
  }

  // ── Blocks: tables, pictures, dividers, checklists ─────────────────────────

  private currentLine(): number {
    return lineIndexAt(this.doc.text, this.selection().end);
  }

  inTable(): boolean {
    return this.doc.paras[this.currentLine()] === 'table';
  }

  /**
   * Inserts whole lines below the cursor's line (or in place of it when it is
   * empty), each with its own style, then puts the cursor on `caretLine`
   * of the inserted lines at `caretColumn`.
   */
  insertLines(lines: readonly { text: string; para: ParaStyle }[], caretLine = 0, caretColumn = 0, caretBelow = false): void {
    if (!lines.length) return;
    const sel = this.selection();
    const ranges = lineRanges(this.doc.text);
    let li = lineIndexAt(this.doc.text, sel.end);
    // Anything other than rows goes after the whole table, never inside it.
    if (this.doc.paras[li] === 'table' && lines[0]?.para !== 'table') {
      while (this.doc.paras[li + 1] === 'table') li++;
    }
    const here = ranges[li] as { start: number; end: number };
    const replaceEmpty = here.start === here.end && !isImagePara(this.doc.paras[li]);
    const body = lines.map((l) => l.text).join('\n');
    const at = replaceEmpty ? here.start : here.end;
    const first = replaceEmpty ? li : li + 1;
    this.remember(false);
    let doc = replaceText(this.doc, at, 0, replaceEmpty ? body : `\n${body}`, {});
    lines.forEach((l, k) => (doc = setLineStyle(doc, first + k, l.para)));
    // Leave somewhere to keep writing after the block.
    const endLine = first + lines.length;
    const nextIsFree = endLine < doc.paras.length && doc.paras[endLine] === 'normal' && lineRanges(doc.text)[endLine]?.start === lineRanges(doc.text)[endLine]?.end;
    if (endLine >= doc.paras.length || (caretBelow && !nextIsFree)) {
      const at2 = (lineRanges(doc.text)[endLine - 1] as { end: number }).end;
      doc = replaceText(doc, at2, 0, '\n', {});
      doc = setLineStyle(doc, endLine, 'normal');
    }
    const starts = lineRanges(doc.text);
    const target = (caretBelow ? starts[endLine] : starts[first + Math.min(caretLine, lines.length - 1)]) as { start: number; end: number };
    const caret = caretBelow ? target.start : Math.min(target.start + caretColumn, target.end);
    this.commit(doc, { start: caret, end: caret });
  }

  /** Sets one line's style (e.g. ticking a checklist item from the page). */
  setLineStyle(line: number, style: ParaStyle): void {
    const sel = this.selection();
    this.remember(false);
    this.commit(setLineStyle(this.doc, line, style), sel);
  }

  /** Tab moves to the next table cell, adding a row at the end of the table. */
  private moveCell(dir: 1 | -1): void {
    const { text, paras } = this.doc;
    const ranges = lineRanges(text);
    const sel = this.selection();
    const li = lineIndexAt(text, sel.end);
    const r = ranges[li] as { start: number; end: number };
    if (dir === 1) {
      const nextTab = text.indexOf('\t', sel.end);
      if (nextTab >= 0 && nextTab < r.end) {
        this.setSelection(nextTab + 1);
        this.options.onSelect?.();
        return;
      }
      const next = ranges[li + 1];
      if (next && paras[li + 1] === 'table') {
        this.setSelection(next.start);
        this.options.onSelect?.();
        return;
      }
      const cols = text.slice(r.start, r.end).split('\t').length;
      this.insertLines([{ text: '\t'.repeat(cols - 1), para: 'table' }]);
      return;
    }
    const prevTab = text.lastIndexOf('\t', Math.max(r.start, sel.start - 1) - 1);
    if (prevTab >= r.start) this.setSelection(text.lastIndexOf('\t', prevTab - 1) >= r.start ? text.lastIndexOf('\t', prevTab - 1) + 1 : r.start);
    else if (li > 0 && paras[li - 1] === 'table') {
      const p = ranges[li - 1] as { start: number; end: number };
      this.setSelection(text.lastIndexOf('\t', p.end - 1) >= p.start ? text.lastIndexOf('\t', p.end - 1) + 1 : p.start);
    } else this.setSelection(r.start);
    this.options.onSelect?.();
  }

  /** Words in the document (for the word count). */
  wordCount(): number {
    return (this.doc.text.replace(/\uFFFC/g, ' ').match(/\S+/g) ?? []).length;
  }

  /** What the toolbar should show as active. */
  state(): EditorState {
    const sel = this.saved;
    const base = selectionState(this.doc, sel.start, sel.end);
    const pending = sel.start === sel.end && this.pending ? this.pending : null;
    return {
      ...(pending ? { ...pending, para: base.para } : base),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  destroy(): void {
    document.removeEventListener('selectionchange', this.onSelect);
  }
}

/**
 * Like diffText, but uses the caret to place ambiguous edits: typing "a"
 * after "a" is recorded where the caret actually is, so formatting follows.
 */
export function diffAroundCaret(before: string, after: string, caret: number): { start: number; deleteCount: number; insert: string } {
  const grow = after.length - before.length;
  if (grow > 0) {
    const start = caret - grow;
    if (start >= 0 && after.slice(0, start) === before.slice(0, start) && after.slice(caret) === before.slice(start)) {
      return { start, deleteCount: 0, insert: after.slice(start, caret) };
    }
  } else if (grow < 0) {
    const removed = -grow;
    if (after.slice(0, caret) === before.slice(0, caret) && after.slice(caret) === before.slice(caret + removed)) {
      return { start: caret, deleteCount: removed, insert: '' };
    }
  }
  return diffText(before, after);
}
