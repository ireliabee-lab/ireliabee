// @vitest-environment jsdom
import "./setup";
import { describe, expect, it } from 'vitest';
import {
  clearFormatting,
  diffText,
  hasMarkThroughout,
  isEmptyStyle,
  lineIndexAt,
  lineRanges,
  normalizeMarks,
  plainDoc,
  replaceText,
  sameStyle,
  selectionState,
  setValueMark,
  styleAt,
  styledRanges,
  toggleMark,
  toggleParaStyle,
  withParas,
  type RichDoc,
} from '../rich';

const RED = '#8A1F2D';
const YELLOW = 'rgba(247, 214, 76, 0.55)';

describe('marks', () => {
  it('normalises: clamps, drops empty, merges touching ranges of the same kind', () => {
    expect(
      normalizeMarks(
        [
          { type: 'bold', start: 5, end: 9 },
          { type: 'bold', start: 0, end: 5 },
          { type: 'bold', start: 3, end: 3 },
          { type: 'color', start: 0, end: 4, value: RED },
          { type: 'color', start: 4, end: 50, value: '#000' },
        ],
        10,
      ),
    ).toEqual([
      { type: 'bold', start: 0, end: 9 },
      { type: 'color', start: 4, end: 10, value: '#000' },
      { type: 'color', start: 0, end: 4, value: RED },
    ]);
  });

  it('resolves the style of a character and splits text into uniform ranges', () => {
    const marks = [
      { type: 'bold' as const, start: 2, end: 6 },
      { type: 'highlight' as const, start: 4, end: 8, value: YELLOW },
    ];
    expect(styleAt(marks, 5)).toEqual({ bold: true, highlight: YELLOW });
    expect(styledRanges(marks, 0, 10)).toEqual([
      { start: 0, end: 2, style: {} },
      { start: 2, end: 4, style: { bold: true } },
      { start: 4, end: 6, style: { bold: true, highlight: YELLOW } },
      { start: 6, end: 8, style: { highlight: YELLOW } },
      { start: 8, end: 10, style: {} },
    ]);
    expect(styledRanges(marks, 5, 5)).toEqual([]);
  });

  it('compares styles', () => {
    expect(isEmptyStyle({})).toBe(true);
    expect(isEmptyStyle({ strike: true })).toBe(false);
    expect(sameStyle({ bold: true }, { bold: true, italic: false })).toBe(true);
    expect(sameStyle({ color: RED }, {})).toBe(false);
  });
});

describe('lines', () => {
  it('finds line ranges and indices', () => {
    expect(lineRanges('ab\n\ncd')).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 3 },
      { start: 4, end: 6 },
    ]);
    expect(lineIndexAt('ab\n\ncd', 5)).toBe(2);
  });

  it('pads paragraph styles for older entries', () => {
    expect(withParas({ text: 'a\nb' }).paras).toEqual(['normal', 'normal']);
    expect(withParas({ text: 'a', paras: ['bullet', 'quote'] }).paras).toEqual(['bullet']);
  });
});

describe('diffText', () => {
  it('finds the single replaced span', () => {
    expect(diffText('hello world', 'hello brave world')).toEqual({ start: 6, deleteCount: 0, insert: 'brave ' });
    expect(diffText('abc', 'ac')).toEqual({ start: 1, deleteCount: 1, insert: '' });
    expect(diffText('same', 'same')).toEqual({ start: 4, deleteCount: 0, insert: '' });
  });
});

describe('replaceText', () => {
  const doc = (): RichDoc => ({
    text: 'I said it out loud',
    marks: [{ type: 'bold', start: 2, end: 6 }],
    paras: ['normal'],
  });

  it('keeps formatting attached to the same words', () => {
    const d = replaceText(doc(), 0, 0, 'Today ');
    expect(d.text).toBe('Today I said it out loud');
    expect(d.marks).toEqual([{ type: 'bold', start: 8, end: 12 }]);
  });

  it('continues formatting when typing at the end of a formatted word', () => {
    const d = replaceText(doc(), 6, 0, 'd');
    expect(d.marks).toEqual([{ type: 'bold', start: 2, end: 7 }]);
  });

  it('uses the next character’s style at the start of a line, and explicit styles when given', () => {
    const d = replaceText({ text: 'x', marks: [{ type: 'italic', start: 0, end: 1 }], paras: ['normal'] }, 0, 0, 'y');
    expect(d.marks).toEqual([{ type: 'italic', start: 0, end: 2 }]);
    const e = replaceText(doc(), 0, 0, 'Oh ', { color: RED });
    expect(e.marks).toContainEqual({ type: 'color', start: 0, end: 3, value: RED });
  });

  it('shrinks and removes formatting when its text is deleted', () => {
    expect(replaceText(doc(), 3, 2, '').marks).toEqual([{ type: 'bold', start: 2, end: 4 }]);
    expect(replaceText(doc(), 1, 6, '').marks).toEqual([]);
  });

  it('never formats line breaks, and new lines inherit the paragraph style', () => {
    const start: RichDoc = { text: 'milk', marks: [{ type: 'bold', start: 0, end: 4 }], paras: ['bullet'] };
    const d = replaceText(start, 4, 0, '\neggs');
    expect(d.paras).toEqual(['bullet', 'bullet']);
    expect(d.marks).toEqual([
      { type: 'bold', start: 0, end: 4 },
      { type: 'bold', start: 5, end: 9 },
    ]);
    const joined = replaceText(d, 4, 1, '');
    expect(joined.paras).toEqual(['bullet']);
  });
});

describe('formatting commands', () => {
  const base = plainDoc('one two\nthree');

  it('toggles bold on and off over a selection', () => {
    const on = toggleMark(base, 'bold', 0, 7);
    expect(hasMarkThroughout(on, 'bold', 0, 7)).toBe(true);
    const off = toggleMark(on, 'bold', 4, 7);
    expect(off.marks).toEqual([{ type: 'bold', start: 0, end: 4 }]);
    expect(toggleMark(base, 'bold', 3, 3)).toBe(base);
    expect(hasMarkThroughout(base, 'bold', 7, 8)).toBe(false);
  });

  it('bolds across lines without covering the break', () => {
    expect(toggleMark(base, 'bold', 4, 11).marks).toEqual([
      { type: 'bold', start: 4, end: 7 },
      { type: 'bold', start: 8, end: 11 },
    ]);
  });

  it('sets and removes colours and highlights', () => {
    const red = setValueMark(base, 'color', RED, 0, 3);
    expect(styleAt(red.marks, 1).color).toBe(RED);
    const recolour = setValueMark(red, 'color', '#000', 1, 2);
    expect(styledRanges(recolour.marks, 0, 3).map((r) => r.style.color)).toEqual([RED, '#000', RED]);
    expect(setValueMark(red, 'color', null, 0, 3).marks).toEqual([]);
    expect(setValueMark(base, 'highlight', YELLOW, 2, 2)).toBe(base);
  });

  it('toggles paragraph styles for every touched line and clears formatting', () => {
    const bullets = toggleParaStyle(base, 'bullet', 2, 10);
    expect(bullets.paras).toEqual(['bullet', 'bullet']);
    expect(toggleParaStyle(bullets, 'bullet', 0, 0).paras).toEqual(['normal', 'bullet']);
    const styled = toggleMark(setValueMark(bullets, 'highlight', YELLOW, 0, 13), 'italic', 0, 3);
    const cleared = clearFormatting(styled, 0, 13);
    expect(cleared.marks).toEqual([]);
    expect(cleared.paras).toEqual(['normal', 'normal']);
  });

  it('reports toolbar state for a caret or a selection', () => {
    const d = setValueMark(toggleMark(toggleParaStyle(base, 'quote', 0, 0), 'bold', 0, 3), 'color', RED, 0, 3);
    expect(selectionState(d, 2, 2)).toMatchObject({ bold: true, color: RED, para: 'quote' });
    expect(selectionState(d, 0, 3)).toMatchObject({ bold: true, italic: false, color: RED });
    expect(selectionState(d, 0, 7).bold).toBe(false);
    expect(selectionState(d, 8, 8).para).toBe('normal');
  });
});

import { continuation, normalizeBlocks, OBJECT_CHAR, setLineStyle, imageIdOf, isImagePara } from '../rich';

describe('blocks: checklists, images, dividers, tables', () => {
  it('continues lists on Enter but not headings or ticked items', () => {
    expect(continuation('checked')).toBe('check');
    expect(continuation('numbered')).toBe('numbered');
    expect(continuation('table')).toBe('table');
    expect(continuation('heading')).toBe('normal');
    expect(continuation('image:x')).toBe('normal');
    const d = replaceText({ text: 'done', marks: [], paras: ['checked'] }, 4, 0, '\nnext');
    expect(d.paras).toEqual(['checked', 'check']);
  });

  it('knows image lines by their id', () => {
    expect(isImagePara('image:abc')).toBe(true);
    expect(imageIdOf('image:abc')).toBe('abc');
    expect(imageIdOf('normal')).toBeNull();
  });

  it('keeps each image alone on its line, and text typed beside it on its own line', () => {
    const typedBefore: RichDoc = { text: `a${OBJECT_CHAR}`, marks: [], paras: ['image:p'] };
    const fixed = normalizeBlocks(typedBefore, 1);
    expect(fixed.doc.text).toBe(`a\n${OBJECT_CHAR}`);
    expect(fixed.doc.paras).toEqual(['normal', 'image:p']);
    expect(fixed.caret).toBe(1);

    const typedAfter: RichDoc = { text: `${OBJECT_CHAR}b`, marks: [], paras: ['image:p'] };
    const after = normalizeBlocks(typedAfter, 2);
    expect(after.doc.text).toBe(`${OBJECT_CHAR}\nb`);
    expect(after.doc.paras).toEqual(['image:p', 'normal']);
    expect(after.caret).toBe(3);
  });

  it('turns an emptied image line back into text, and removes stray object characters', () => {
    expect(normalizeBlocks({ text: 'x', marks: [], paras: ['image:p'] }, 1).doc.paras).toEqual(['normal']);
    const stray = normalizeBlocks({ text: `ab${OBJECT_CHAR}c`, marks: [], paras: ['normal'] }, 4);
    expect(stray.doc.text).toBe('abc');
    expect(stray.caret).toBe(3);
    const div = normalizeBlocks({ text: 'hi', marks: [], paras: ['divider'] }, 2);
    expect(div.doc.paras).toEqual(['normal']);
    const clean = plainDoc('fine');
    expect(normalizeBlocks(clean, 2).doc).toBe(clean);
  });

  it('sets single line styles, toggles checklists and keeps blocks when clearing', () => {
    const d = plainDoc('a\nb\nc');
    expect(setLineStyle(d, 1, 'checked').paras).toEqual(['normal', 'checked', 'normal']);
    expect(setLineStyle(d, 9, 'check')).toBe(d);
    const mixed: RichDoc = { ...d, paras: ['check', 'checked', 'normal'] };
    expect(toggleParaStyle(mixed, 'check', 0, 2).paras).toEqual(['normal', 'normal', 'normal']);
    expect(toggleParaStyle(mixed, 'check', 0, 5).paras).toEqual(['check', 'checked', 'check']);
    const blocks: RichDoc = { text: `x\n${OBJECT_CHAR}\n\ny\tz`, marks: [], paras: ['heading', 'image:p', 'divider', 'table'] };
    expect(clearFormatting(blocks, 0, blocks.text.length).paras).toEqual(['normal', 'image:p', 'divider', 'table']);
    expect(toggleParaStyle(blocks, 'bullet', 0, blocks.text.length).paras).toEqual(['bullet', 'image:p', 'divider', 'bullet']);
  });
});
