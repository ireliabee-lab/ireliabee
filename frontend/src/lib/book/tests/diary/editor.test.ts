// @vitest-environment jsdom
import "../setup";
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diffAroundCaret, HIGHLIGHTS, INK_COLORS, RichEditor, serialize } from '../../diary/editor';
import { plainDoc, type RichDoc } from '../../rich';

let editor: RichEditor | null = null;

function mount(doc?: RichDoc) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const onChange = vi.fn();
  const onSelect = vi.fn();
  editor = new RichEditor(el, { onChange, onSelect, placeholder: 'Write here' });
  if (doc) editor.setDoc(doc);
  return { el, editor, onChange, onSelect, user: userEvent.setup() };
}

/** Selects [a, b) the way a reader would with a mouse. */
function select(ed: RichEditor, a: number, b: number): void {
  ed.el.focus();
  ed.setSelection(a, b);
  document.dispatchEvent(new Event('selectionchange'));
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

describe('serialize', () => {
  it('reads lines, breaks and browser-made blocks as plain text', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div>one</div><div><br></div><div>two<br>three</div><p>four\u00A0five</p>';
    expect(serialize(root)).toBe('one\n\ntwo\nthree\nfour five');
    const loose = document.createElement('div');
    loose.innerHTML = 'lead<div>next</div>';
    expect(serialize(loose)).toBe('lead\nnext');
  });
});

describe('diffAroundCaret', () => {
  it('places ambiguous edits where the caret is', () => {
    expect(diffAroundCaret('aa', 'aaa', 1)).toEqual({ start: 0, deleteCount: 0, insert: 'a' });
    expect(diffAroundCaret('aaa', 'aa', 0)).toEqual({ start: 0, deleteCount: 1, insert: '' });
    expect(diffAroundCaret('abc', 'axc', 2)).toEqual({ start: 1, deleteCount: 1, insert: 'x' });
  });
});

describe('RichEditor', () => {
  it('is an accessible multi-line text box with a placeholder while empty', () => {
    const { el } = mount();
    expect(el).toHaveAttribute('role', 'textbox');
    expect(el).toHaveAttribute('aria-multiline', 'true');
    expect(el).toHaveAttribute('data-empty');
    expect(el.dataset.placeholder).toBe('Write here');
  });

  it('turns typing into the model, with Enter starting a new line', async () => {
    const { el, editor, onChange, user } = mount();
    await user.click(el);
    await user.type(el, 'Dear diary');
    await user.keyboard('{Enter}');
    await user.type(el, 'Today was good.');
    expect(editor.text).toBe('Dear diary\nToday was good.');
    expect(el.querySelectorAll('.line')).toHaveLength(2);
    expect(onChange).toHaveBeenCalled();
    expect(el).not.toHaveAttribute('data-empty');
  });

  it('formats a selection from the keyboard and renders it', async () => {
    const { el, editor, user } = mount(plainDoc('I said it out loud'));
    select(editor, 2, 6);
    await user.keyboard('{Control>}b{/Control}');
    await user.keyboard('{Control>}i{/Control}');
    await user.keyboard('{Control>}u{/Control}');
    await user.keyboard('{Control>}{Shift>}x{/Shift}{/Control}');
    const span = el.querySelector('span');
    expect(span).toHaveTextContent('said');
    expect(span).toHaveClass('b', 'i', 'u', 's');
    expect(editor.state()).toMatchObject({ bold: true, italic: true, underline: true, strike: true });
  });

  it('colours and highlights a selection, and removes it again', () => {
    const { el, editor } = mount(plainDoc('something heavy'));
    select(editor, 0, 9);
    editor.setColor(INK_COLORS[1]!.value);
    editor.setHighlight(HIGHLIGHTS[0]!.value);
    const span = el.querySelector('span') as HTMLSpanElement;
    expect(span.style.color).toBeTruthy();
    expect(span.style.backgroundColor).toBeTruthy();
    expect(editor.state().color).toBe(INK_COLORS[1]!.value);
    editor.setHighlight(null);
    editor.setColor(null);
    expect(el.querySelector('span')).toBeNull();
  });

  it('applies formatting to what you type next when nothing is selected', async () => {
    const { el, editor, user } = mount(plainDoc('Plain '));
    await user.click(el);
    select(editor, 6, 6);
    editor.toggle('bold');
    editor.setColor(INK_COLORS[2]!.value);
    editor.setHighlight(HIGHLIGHTS[1]!.value);
    expect(editor.state()).toMatchObject({ bold: true, color: INK_COLORS[2]!.value, highlight: HIGHLIGHTS[1]!.value });
    await user.keyboard('bold');
    expect(editor.text).toBe('Plain bold');
    expect(editor.value.marks).toContainEqual({ type: 'bold', start: 6, end: 10 });
  });

  it('sets paragraph styles and clears formatting', () => {
    const { el, editor } = mount(plainDoc('milk\neggs'));
    select(editor, 0, 6);
    editor.setPara('bullet');
    expect(el.querySelectorAll('[data-para="bullet"]')).toHaveLength(2);
    editor.toggle('bold');
    editor.clear();
    expect(el.querySelector('[data-para]')).toBeNull();
    expect(editor.value.marks).toEqual([]);
  });

  it('undoes and redoes, grouping quick typing together', async () => {
    const { el, editor, user } = mount();
    await user.click(el);
    await user.type(el, 'abc');
    select(editor, 0, 3);
    editor.toggle('bold');
    expect(editor.state().canUndo).toBe(true);
    await user.keyboard('{Control>}z{/Control}');
    expect(editor.value.marks).toEqual([]);
    expect(editor.text).toBe('abc');
    await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(editor.value.marks).toHaveLength(1);
    editor.undo();
    editor.undo();
    expect(editor.text).toBe('');
    editor.undo(); // nothing left: no-op
    await user.keyboard('{Control>}y{/Control}');
    expect(editor.text).toBe('abc');
    editor.redo();
    editor.redo();
    expect(editor.state().canRedo).toBe(false);
  });

  it('handles history, paragraph and formatting input types itself', () => {
    const { el, editor } = mount(plainDoc('ab'));
    select(editor, 2, 2);
    const fire = (inputType: string): InputEvent => {
      const e = new InputEvent('beforeinput', { inputType, cancelable: true, bubbles: true });
      el.dispatchEvent(e);
      return e;
    };
    expect(fire('insertParagraph').defaultPrevented).toBe(true);
    expect(editor.text).toBe('ab\n');
    expect(fire('formatBold').defaultPrevented).toBe(true);
    expect(fire('historyUndo').defaultPrevented).toBe(true);
    expect(editor.text).toBe('ab');
    expect(fire('historyRedo').defaultPrevented).toBe(true);
    expect(editor.text).toBe('ab\n');
    expect(fire('insertText').defaultPrevented).toBe(false);
  });

  it('pastes and drops plain text only', () => {
    const { el, editor } = mount(plainDoc(''));
    select(editor, 0, 0);
    const paste = new Event('paste', { cancelable: true, bubbles: true }) as ClipboardEvent;
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'line one\r\nline two' } });
    el.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(editor.text).toBe('line one\nline two');
    const drop = new Event('drop', { cancelable: true, bubbles: true }) as DragEvent;
    Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => '!' } });
    el.dispatchEvent(drop);
    expect(editor.text).toContain('!');
  });

  it('waits for IME composition to finish before reading input', () => {
    const { el, editor } = mount(plainDoc(''));
    select(editor, 0, 0);
    el.dispatchEvent(new Event('compositionstart'));
    (el.querySelector('.line') as HTMLElement).textContent = 'ɔ';
    el.dispatchEvent(new Event('input'));
    expect(editor.text).toBe('');
    el.dispatchEvent(new Event('compositionend'));
    expect(editor.text).toBe('ɔ');
  });

  it('maps selections to text offsets across lines and empty lines', () => {
    const { el, editor } = mount(plainDoc('ab\n\ncd'));
    el.focus();
    for (const at of [0, 1, 2, 3, 4, 5, 6]) {
      editor.setSelection(at);
      expect(editor.selection()).toEqual({ start: at, end: at });
    }
    editor.setSelection(5, 1);
    expect(editor.selection()).toEqual({ start: 1, end: 5 });
    const sel = document.getSelection() as globalThis.Selection;
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(el, 1); // between the first and second line
    sel.addRange(r);
    expect(editor.selection().start).toBe(3);
    el.blur();
    expect(editor.selection()).toEqual({ start: 3, end: 3 }); // remembered while unfocused
  });

  it('re-renders stray browser markup without changing the text', () => {
    const { el, editor } = mount(plainDoc('keep'));
    el.focus();
    el.innerHTML = '<div class="line"><b>keep</b></div>';
    el.dispatchEvent(new Event('input'));
    expect(el.querySelector('b')).toBeNull();
    expect(editor.text).toBe('keep');
  });
});

describe('RichEditor blocks', () => {
  it('inserts a table below the current line and moves between cells with Tab', async () => {
    const { el, editor, user } = mount(plainDoc('Shopping'));
    await user.click(el);
    select(editor, 8, 8);
    editor.insertLines(
      [
        { text: 'Item\tCost', para: 'table' },
        { text: '\t', para: 'table' },
      ],
      1,
      0,
    );
    expect(editor.value.paras).toEqual(['normal', 'table', 'table', 'normal']);
    expect(editor.inTable()).toBe(true);
    await user.keyboard('Milk{Tab}3{Tab}');
    expect(editor.text.split('\n')[2]).toBe('Milk\t3');
    expect(editor.value.paras[3]).toBe('table'); // Tab at the end added a row
    await user.keyboard('Eggs{Shift>}{Tab}{/Shift}');
    await user.keyboard('X');
    expect(editor.text.split('\n')[2]).toBe('Milk\tX3');
  });

  it('replaces an empty line with a block and can put the cursor below it', () => {
    const { editor } = mount(plainDoc(''));
    select(editor, 0, 0);
    editor.insertLines([{ text: '', para: 'divider' }], 0, 0, true);
    expect(editor.value.paras).toEqual(['divider', 'normal']);
    expect(editor.selection().start).toBe(1);
  });

  it('ticks a checklist line directly and counts words', () => {
    const { editor } = mount({ text: 'buy milk\nand bread', marks: [], paras: ['check', 'check'] });
    select(editor, 0, 0);
    editor.setLineStyle(1, 'checked');
    expect(editor.value.paras).toEqual(['check', 'checked']);
    expect(editor.wordCount()).toBe(4);
    editor.undo();
    expect(editor.value.paras).toEqual(['check', 'check']);
  });

  it('leaves Tab alone outside tables so focus can move on', async () => {
    const { el, editor, user } = mount(plainDoc('text'));
    await user.click(el);
    select(editor, 2, 2);
    expect(editor.inTable()).toBe(false);
    await user.keyboard('{Tab}');
    expect(editor.text).toBe('text');
  });
});
