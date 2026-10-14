// @vitest-environment jsdom
import "./setup";
import { describe, expect, it } from 'vitest';
import { STORY } from '../book';
import { caretPosition, parseManuscript, sourceOffset, toManuscript, toRoman } from '../manuscript';

describe('toRoman', () => {
  it.each([
    [1, 'I'],
    [4, 'IV'],
    [9, 'IX'],
    [14, 'XIV'],
    [2026, 'MMXXVI'],
    [0, '0'],
  ])('%i → %s', (n, roman) => expect(toRoman(n)).toBe(roman));
});

describe('parseManuscript', () => {
  const source = '# First\n\nOne two\nthree.\n\n\nFour five.\n## Second chapter\nSix.';
  const m = parseManuscript(source);

  it('turns # lines into numbered chapters and blank lines into paragraph breaks', () => {
    expect(m.blocks).toEqual([
      { kind: 'chapter', numeral: 'I', title: 'First' },
      { kind: 'para', text: 'One two three.' },
      { kind: 'para', text: 'Four five.' },
      { kind: 'chapter', numeral: 'II', title: 'Second chapter' },
      { kind: 'para', text: 'Six.' },
    ]);
  });

  it('remembers where each block sits in the source', () => {
    m.ranges.forEach((r, i) => {
      const slice = source.slice(r.start, r.end);
      const block = m.blocks[i];
      if (block?.kind === 'para') expect(slice.replace(/\s+/g, ' ')).toBe(block.text);
      else expect(slice).toContain(block?.title);
    });
  });

  it('round-trips the built-in story', () => {
    const again = parseManuscript(toManuscript(STORY)).blocks;
    expect(again.map((b) => (b.kind === 'chapter' ? b.title : b.text))).toEqual(
      STORY.map((b) => (b.kind === 'chapter' ? b.title : b.text)),
    );
  });

  it('handles empty text', () => {
    expect(parseManuscript('').blocks).toEqual([]);
    expect(caretPosition('', parseManuscript(''), 0)).toBeNull();
  });
});

describe('caret mapping', () => {
  const source = '# The map\n\nAlpha beta gamma.\n\nDelta epsilon.';
  const m = parseManuscript(source);

  it('finds the block and word under the caret', () => {
    expect(caretPosition(source, m, source.indexOf('beta') + 2)).toEqual({ block: 1, word: 1 });
    expect(caretPosition(source, m, source.indexOf('map'))).toEqual({ block: 0, word: 1 });
    expect(caretPosition(source, m, source.indexOf('Delta') - 1)).toEqual({ block: 2, word: 0 });
    expect(caretPosition(source, m, source.length + 10)).toEqual({ block: 2, word: 1 });
  });

  it('maps a word back to its source offset', () => {
    expect(sourceOffset(source, m, { block: 1, word: 2 })).toBe(source.indexOf('gamma'));
    expect(sourceOffset(source, m, { block: 0, word: 0 })).toBe(source.indexOf('The'));
    expect(sourceOffset(source, m, { block: 2, word: 99 })).toBe(source.indexOf('epsilon'));
    expect(sourceOffset(source, m, { block: 9, word: 0 })).toBeNull();
  });

  it('places the caret at a block start when it has no words', () => {
    const odd = { blocks: m.blocks, ranges: [{ start: 3, end: 3 }] };
    expect(sourceOffset(source, odd, { block: 0, word: 0 })).toBe(3);
  });
});
