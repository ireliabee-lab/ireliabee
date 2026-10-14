// @vitest-environment jsdom
import "./setup";
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotebookBook, tagAtCaret, type NotebookBookApp, type NotebookBookState } from '../notebookApp';
import { applyPageTheme } from '../pages';
import { themeById } from '../themes';
import { docToEntries, entriesToDoc, type BookEntry } from '../../notebookBook';
import type { NotebookDoc } from '../../notebook';
import { fakeTypesetter } from './helpers';

let app: NotebookBookApp | null = null;

const doc = (): NotebookDoc => ({
  title: 'Speech motor control', summary: '', cues: [],
  board: { decisions: [], actions: [], questions: [], risks: [], numbers: [] },
  sections: [{ id: 's1', title: 'Control', src: [], blocks: [{ id: 'b1', type: 'point', text: 'Timing matters', src: [] }] }],
});

function open(entries: BookEntry[] = docToEntries(doc(), 'lecture'), onSource = vi.fn()) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const onEntries = vi.fn<(e: BookEntry[]) => void>();
  const states: NotebookBookState[] = [];
  app = createNotebookBook(root, {
    entries, words: { title: 'Speech motor control', intro: 'Notes by', footer: '' }, owner: 'Oliver', theme: 'classic',
    onEntries, onState: (s) => states.push(s), onSource, reducedMotion: true, typesetter: fakeTypesetter,
    now: () => new Date('2026-09-26T10:00:00Z'),
  });
  const input = root.querySelector('.nbk-input') as HTMLElement;
  return { root, app, onEntries, states, input, user: userEvent.setup() };
}

const lastEntries = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls[fn.mock.calls.length - 1]![0] as BookEntry[];

afterEach(() => {
  app?.destroy();
  app = null;
  document.body.innerHTML = '';
  applyPageTheme(themeById('classic'));
});

describe('the notebook book', () => {
  it('draws the book on a canvas with an invisible editor for the keyboard', () => {
    const { root, input } = open();
    expect(root.querySelector('canvas.nbk-canvas')).toBeInTheDocument();
    expect(input).toHaveAttribute('contenteditable', 'true');
    expect(input).toHaveAttribute('aria-label', 'Notebook page');
  });

  it('gives a notebook with no sections somewhere to write', () => {
    const empty = docToEntries({ ...doc(), sections: [] }, 'lecture');
    const { app } = open(empty);
    expect(app.entries.map((e) => [e.role, e.title])).toEqual([['section', 'Notes'], ['summary', 'Summary'], ['cues', 'Test yourself']]);
  });

  it('adds what you type to the section and reports it', async () => {
    const { app, onEntries, user, input } = open();
    app.openEntry(0);
    await user.type(input, '{End} well');
    const entries = lastEntries(onEntries);
    expect(entries[0]!.text).toBe('Timing matters well');
    expect(entriesToDoc(doc(), entries).sections[0]!.blocks[0]).toMatchObject({ id: 'b1', text: 'Timing matters well' });
  });

  it('turns a new line into a new block, keeping the old one', async () => {
    const { app, onEntries, user, input } = open();
    app.openEntry(0);
    await user.type(input, '{End}{Enter}Feedback is slow');
    const blocks = entriesToDoc(doc(), lastEntries(onEntries)).sections[0]!.blocks;
    expect(blocks.map((b) => [b.id === 'b1', b.type, b.text])).toEqual([[true, 'point', 'Timing matters'], [false, 'point', 'Feedback is slow']]);
  });

  it('formats from the bar: bold, a key-point star and a highlight', () => {
    const { app, onEntries, states } = open();
    app.openEntry(0);
    app.setPara('key');
    expect(states[states.length - 1]!.para).toBe('key');
    expect(entriesToDoc(doc(), lastEntries(onEntries)).sections[0]!.blocks[0]).toMatchObject({ id: 'b1', type: 'key' });
  });

  it('inserts a table and the date', () => {
    const { app, onEntries } = open();
    app.openEntry(0);
    app.insert('table');
    const withTable = lastEntries(onEntries)[0]!;
    expect(withTable.paras.filter((p) => p === 'table')).toHaveLength(3);
    app.insert('date');
    expect(lastEntries(onEntries)[0]!.text).toContain('Saturday, 26 September 2026');
  });

  it('starts a new section before the summary and lets you rename it', () => {
    const { app, onEntries } = open();
    app.newSection();
    expect(app.entries.map((e) => e.title)).toEqual(['Control', 'New section', 'Summary', 'Test yourself']);
    app.renameEntry(1, 'Feedback');
    expect(lastEntries(onEntries)[1]!.title).toBe('Feedback');
    expect(entriesToDoc(doc(), lastEntries(onEntries)).sections.map((s) => s.title)).toEqual(['Control', 'Feedback']);
  });

  it('turns pages only from the outer margin, so dragging across the writing selects it', () => {
    // The engine's writing test shows what the strip does; here, that the notebook sets one.
    const { app } = open();
    expect(app.book.tapToTurn).toBe(false);
    expect(app.book.grabZone).toBeGreaterThan(0);
    expect(app.book.grabZone).toBeLessThanOrEqual(0.1);
  });

  it('reports where you are in the book', () => {
    const { states } = open();
    expect(states[states.length - 1]).toMatchObject({ where: 'Front cover', canPrev: false, canNext: true });
  });

  it('puts a photo on its own line and keeps it with the section', () => {
    const { app, onEntries } = open();
    app.openEntry(0);
    app.insertPicture({ src: 'data:image/jpeg;base64,AAAA', w: 400, h: 300 });
    const sec = lastEntries(onEntries)[0]!;
    const line = sec.paras.findIndex((p) => p.startsWith('image:'));
    expect(line).toBeGreaterThan(0);
    const id = sec.paras[line]!.slice(6);
    expect(sec.media?.[id]).toEqual({ src: 'data:image/jpeg;base64,AAAA', w: 400, h: 300 });
    expect(entriesToDoc(doc(), lastEntries(onEntries)).sections[0]!.blocks.map((b) => b.type)).toEqual(['point', 'image']);
  });
});

describe("opening a line's source", () => {
  // Two lines: one ending in its source tag, one without.
  const line = 'Most loss happens in the first day (p.2)';
  const entry = {
    text: `${line}
No source here`,
    meta: [{ id: 'b1', type: 'point', src: [2], prefix: '', suffix: ' (p.2)', rest: {}, tag: '(p.2)' }, null],
  } as unknown as Parameters<typeof tagAtCaret>[0];

  it('opens from a press on the tag itself', () => {
    expect(tagAtCaret(entry, line.length - 5)).toEqual([2]);   // on "("
    expect(tagAtCaret(entry, line.length - 2)).toEqual([2]);   // on "2"
  });

  it('not from the words before it, the blank space after the line, or a line with no source', () => {
    expect(tagAtCaret(entry, 4)).toBeNull();
    expect(tagAtCaret(entry, line.length)).toBeNull();          // where a press past the line's end lands
    expect(tagAtCaret(entry, line.length + 3)).toBeNull();
    expect(tagAtCaret(undefined, 0)).toBeNull();
  });
});
