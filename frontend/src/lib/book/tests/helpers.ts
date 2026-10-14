import type { PageSpec } from '../book';
import { assemblePages } from '../book';
import { LiveBook } from '../live';
import { LAYOUT, LINES_PER_PAGE, TEXT_WIDTH } from '../pages';
import { createTypesetter, type PageContent, type Typesetter } from '../typeset';

export const sampleContent = (n: number): PageContent => ({
  ...(n === 0 ? { chapter: { numeral: 'I', title: 'Start', block: 0 } } : {}),
  lines: [
    n === 0
      ? { words: ['nce', 'upon', 'a', 'time'], indent: 40, justify: true, dropCap: 'O', block: 1, firstWord: 0 }
      : { words: ['Once', 'upon', 'a', 'time'], indent: 0, justify: true, block: 1, firstWord: 0 },
    { words: ['the', 'end.'], indent: 20, justify: false, block: 1, firstWord: 4 },
  ],
  isLast: n === 3,
});

/** Cover, endpaper, title, 4 text pages, colophon, endpaper, back cover: 10 pages, spreads 0–5. */
export function samplePages(): PageSpec[] {
  return assemblePages([0, 1, 2, 3].map(sampleContent));
}

export function pointer(type: string, clientX: number, clientY: number, extra: Partial<PointerEventInit> = {}): Event {
  const e = new MouseEvent(type, { clientX, clientY, bubbles: true, button: 0, ...extra });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  return e;
}

/** A deterministic typesetter: every character is 9px, spaces 5px. */
export function fakeTypesetter(): Typesetter {
  return createTypesetter({
    measure: (w) => w.length * 9,
    spaceWidth: 5,
    width: TEXT_WIDTH,
    linesPerPage: LINES_PER_PAGE,
    chapterLines: LAYOUT.chapterLines,
    paragraphIndent: LAYOUT.indent,
    dropCapWidth: () => 50,
  });
}

const para = (n: number): string =>
  Array.from({ length: 40 }, (_, i) => `word${n}x${i}`).join(' ');

export const SAMPLE_MANUSCRIPT = [
  '# First light',
  para(1),
  para(2),
  para(3),
  '# Second wind',
  para(4),
  para(5),
].join('\n\n');

export function sampleLive(source = SAMPLE_MANUSCRIPT): LiveBook {
  return new LiveBook(fakeTypesetter(), source);
}
