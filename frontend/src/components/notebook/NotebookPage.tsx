import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import {
  addBlock, addSection, BOARD, BLOCK_META, deleteBlock, deleteSection, moveBlock, moveSection, newBlock, newSection,
  SECTION_TYPES, styleVars, updateBlock, updateSection,
  type Block, type BlockType, type BoardKey, type Notebook, type NotebookDoc, type NotebookStyle, type Place,
} from "../../lib/notebook";
import { AutoText, BlockEditor, BlockView, DocText, RichText, refitText } from "./Blocks";

/** Put the cursor in something just added, once React has drawn it. */
function focusSoon(selector: string) {
  setTimeout(() => {
    const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (el) { el.focus(); el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  }, 30);
}

/** A change to the notebook, applied to its latest copy (so callers never hold a stale one). */
export type Edit = (fn: (doc: NotebookDoc) => NotebookDoc) => void;

type Common = {
  nb: Pick<Notebook, "kind" | "line_times">;
  doc: NotebookDoc;
  editing: boolean;
  /** Stable across renders: memoized notes rely on it. */
  onEdit: Edit;
  onSource?: (src: number[]) => void;
};

const placeKey = (p: Place) => ("section" in p ? `s:${p.section}` : `b:${p.board}`);
const samePlace = (a: Place, b: Place) => placeKey(a) === placeKey(b);

/** Add a note of `type` at `at` (after `afterId`, or at the end) and put the cursor in it. */
function addNote(onEdit: Edit, at: Place, type: BlockType, afterId?: string) {
  const block = newBlock(type);
  onEdit(d => addBlock(d, at, block, afterId));
  focusSoon(`[data-block="${block.id}"] :is(textarea, input:not([type="checkbox"]))`);
}

type RowProps = {
  block: Block; at: Place; onEdit: Edit;
  nb: Pick<Notebook, "kind" | "line_times">; onSource?: (src: number[]) => void;
};

/**
 * One note as read. Memoized on the note itself: editing or formatting one note
 * redraws that note, not the other hundreds (an edit makes new objects only for
 * what it changed).
 */
const ViewRow = memo(function ViewRow({ block, at, onEdit, nb, onSource }: RowProps) {
  return (
    <BlockView block={block} nb={nb} onSource={onSource}
      onToggleDone={block.type === "action" ? done => onEdit(d => updateBlock(d, at, block.id, { done })) : undefined} />
  );
}, (a, b) => a.block === b.block && samePlace(a.at, b.at) && a.onEdit === b.onEdit && a.onSource === b.onSource
  && a.nb.kind === b.nb.kind && a.nb.line_times === b.nb.line_times);

/** One note as edited; memoized the same way, so typing redraws only the note being typed in. */
const EditRow = memo(function EditRow({ block, at, onEdit, types, first, last }: Omit<RowProps, "nb" | "onSource"> & {
  types: BlockType[]; first: boolean; last: boolean;
}) {
  return (
    <BlockEditor block={block} types={types} first={first} last={last}
      onChange={patch => onEdit(d => updateBlock(d, at, block.id, patch))}
      onDelete={() => onEdit(d => deleteBlock(d, at, block.id))}
      onMove={by => onEdit(d => moveBlock(d, at, block.id, by))}
      onAddBelow={() => addNote(onEdit, at, types[0], block.id)} />
  );
}, (a, b) => a.block === b.block && samePlace(a.at, b.at) && a.onEdit === b.onEdit && a.first === b.first
  && a.last === b.last && a.types.join() === b.types.join());

/** A list of blocks at one place (a section or a board column), read or edited. */
export function BlockList({ nb, editing, onEdit, onSource, at, blocks, types }: Omit<Common, "doc"> & {
  at: Place; blocks: Block[]; types: BlockType[];
}) {
  if (!editing) {
    return (
      <div className="nb-blocks">
        {blocks.map(b => <ViewRow key={b.id} block={b} at={at} onEdit={onEdit} nb={nb} onSource={onSource} />)}
      </div>
    );
  }
  const add = (type: BlockType) => addNote(onEdit, at, type);
  return (
    <div className="nb-blocks editing">
      {blocks.map((b, i) => (
        <EditRow key={b.id} block={b} at={at} onEdit={onEdit} types={types}
          first={i === 0} last={i === blocks.length - 1} />
      ))}
      <div className="nb-add-row" role="group" aria-label="Add a note">
        {types.slice(0, 6).map(t => (
          <button key={t} type="button" className="nb-add" onClick={() => add(t)}>
            <Plus size={12} /> {BLOCK_META[t].label}
          </button>
        ))}
        {types.length > 6 && (
          <select className="nb-input nb-add-more" value="" aria-label="Add another kind of note"
            onChange={e => { if (e.target.value) add(e.target.value as BlockType); }}>
            <option value="">More…</option>
            {types.slice(6).map(t => <option key={t} value={t}>{BLOCK_META[t].label}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

/** One section: its heading and its blocks. Memoized on the section, like the notes. */
export const SectionView = memo(function SectionView(props: Omit<Common, "doc"> & {
  section: NotebookDoc["sections"][number]; index: number; count: number;
}) {
  const { nb, editing, onEdit, onSource, section, index, count } = props;
  const types = SECTION_TYPES[nb.kind];
  return (
    <section className="nb-section" id={`nb-s-${section.id}`} aria-label={section.title}>
      {editing ? (
        <div className="nb-section-edit">
          <span className="nb-section-no">{index + 1}</span>
          <input className="nb-input nb-section-title-input" value={section.title} aria-label="Section heading"
            onChange={e => { const title = e.target.value; onEdit(d => updateSection(d, section.id, { title })); }} />
          <button type="button" className="nb-icon-btn" disabled={index === 0} aria-label="Move section up"
            onClick={() => onEdit(d => moveSection(d, section.id, -1))}><ArrowUp size={14} /></button>
          <button type="button" className="nb-icon-btn" disabled={index === count - 1} aria-label="Move section down"
            onClick={() => onEdit(d => moveSection(d, section.id, 1))}><ArrowDown size={14} /></button>
          <button type="button" className="nb-icon-btn danger" aria-label="Delete section"
            onClick={() => onEdit(d => deleteSection(d, section.id))}><Trash2 size={14} /></button>
        </div>
      ) : (
        <h2 className="nb-section-title"><span className="nb-section-no">{index + 1}</span><RichText value={section.title} rich={section.rich?.title} target={{ scope: "s", id: section.id, field: "title" }} /></h2>
      )}
      <BlockList nb={nb} editing={editing} onEdit={onEdit} onSource={onSource}
        at={{ section: section.id }} blocks={section.blocks} types={types} />
    </section>
  );
}, (a, b) => a.section === b.section && a.index === b.index && a.count === b.count && a.editing === b.editing
  && a.onEdit === b.onEdit && a.onSource === b.onSource && a.nb.kind === b.nb.kind && a.nb.line_times === b.nb.line_times);

function Heading({ doc, editing, onEdit, fallback }: Pick<Common, "doc" | "editing" | "onEdit"> & { fallback: string }) {
  return editing ? (
    <>
      <input className="nb-input nb-title-input" value={doc.title} aria-label="Title" placeholder={fallback}
        onChange={e => { const title = e.target.value; onEdit(d => ({ ...d, title })); }} />
      <input className="nb-input nb-author-input" value={doc.author ?? ""} aria-label="Author"
        placeholder="Author — who wrote it or taught it (optional, shown on the cover)"
        onChange={e => { const author = e.target.value; onEdit(d => ({ ...d, author })); }} />
    </>
  ) : (
    <>
      <h1 className="nb-title">{doc.title ? <DocText doc={doc} field="title" /> : fallback}</h1>
      {doc.author && <div className="nb-byline">by <DocText doc={doc} field="author" /></div>}
    </>
  );
}

function Summary({ doc, editing, onEdit, label }: Pick<Common, "doc" | "editing" | "onEdit"> & { label: string }) {
  if (editing) {
    return (
      <AutoText value={doc.summary} label={label} placeholder={label} onChange={summary => onEdit(d => ({ ...d, summary }))} />
    );
  }
  return doc.summary ? <p className="nb-summary-text"><DocText doc={doc} field="summary" /></p> : null;
}

/** The self-test questions in the lecture margin. */
function Cues({ doc, editing, onEdit }: Pick<Common, "doc" | "editing" | "onEdit">) {
  const set = (cues: (old: string[]) => string[]) => onEdit(d => ({ ...d, cues: cues(d.cues) }));
  return (
    <aside className="nb-cues" aria-label="Test yourself">
      <div className="nb-kicker">Test yourself</div>
      {editing ? (
        <>
          {doc.cues.map((c, i) => (
            <div key={i} className="nb-cue-edit">
              <input className="nb-input" value={c} aria-label={`Question ${i + 1}`}
                onChange={e => { const v = e.target.value; set(cs => cs.map((x, j) => (j === i ? v : x))); }} />
              <button type="button" className="nb-icon-btn danger" aria-label="Remove question"
                onClick={() => set(cs => cs.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
            </div>
          ))}
          <button type="button" className="nb-add" onClick={() => { set(cs => [...cs, ""]); focusSoon(".nb-cues .nb-cue-edit:last-of-type input"); }}><Plus size={12} /> Question</button>
        </>
      ) : doc.cues.length ? (
        <ul className="nb-cue-list">{doc.cues.map((c, i) => <li key={i}><DocText doc={doc} field={`cue:${i}`} value={c} /></li>)}</ul>
      ) : <p className="muted">No questions yet.</p>}
    </aside>
  );
}

// The "Test yourself" column's width, as a percentage of the page so it keeps its
// proportion when the window changes. One setting for every notebook, per device.
const CUE_KEY = "nb.cueWidth";
export const CUE_DEFAULT = 26;
export const CUE_MIN = 12;
export const CUE_MAX = 50;

export function clampCue(pct: number): number {
  if (!Number.isFinite(pct)) return CUE_DEFAULT;
  return Math.round(Math.min(CUE_MAX, Math.max(CUE_MIN, pct)) * 10) / 10;
}
function readCueWidth(): number {
  try {
    const v = localStorage.getItem(CUE_KEY);
    return v === null ? CUE_DEFAULT : clampCue(Number(v));
  } catch { return CUE_DEFAULT; }
}
function saveCueWidth(pct: number) {
  try { localStorage.setItem(CUE_KEY, String(pct)); } catch { /* not essential */ }
}

/**
 * The red margin line between the questions and the notes, as a handle: drag it,
 * or focus it and use the arrow keys (Shift for bigger steps, Home / End for the
 * limits); a double-click or Enter puts it back to the default.
 */
function CueResizer({ width, onWidth }: { width: number; onWidth: (pct: number, save: boolean) => void }) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const grid = e.currentTarget.closest<HTMLElement>(".nb-cornell");
    if (!grid) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const box = grid.getBoundingClientRect();
    let last = width;
    const move = (ev: PointerEvent) => {
      last = clampCue(((ev.clientX - box.left) / box.width) * 100);
      onWidth(last, false);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.documentElement.classList.remove("nb-resizing");
      onWidth(last, true);
    };
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    document.documentElement.classList.add("nb-resizing");
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 5 : 1;
    const next =
      e.key === "ArrowLeft" ? width - step :
      e.key === "ArrowRight" ? width + step :
      e.key === "Home" ? CUE_MIN :
      e.key === "End" ? CUE_MAX :
      e.key === "Enter" ? CUE_DEFAULT : null;
    if (next === null) return;
    e.preventDefault();
    onWidth(clampCue(next), true);
  };
  return (
    <div className="nb-cue-resizer" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label="Width of the Test yourself column" aria-valuemin={CUE_MIN} aria-valuemax={CUE_MAX}
      aria-valuenow={width} aria-valuetext={`${Math.round(width)}% of the page`}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown} onKeyDown={onKeyDown}
      onDoubleClick={() => onWidth(CUE_DEFAULT, true)} />
  );
}

// How many board columns each meeting card spans. The board fills the window with
// as many columns as fit, so a card's width snaps to whole columns instead of
// sliding freely (free widths would leave ragged gaps). Per device, all meetings.
const SPAN_KEY = "nb.boardSpans";
export const SPAN_MAX = 3;
export const SPAN_DEFAULT: Record<BoardKey, number> = { decisions: 1, actions: 2, questions: 1, risks: 1, numbers: 1 };

export function cleanSpans(raw: unknown): Record<BoardKey, number> {
  const out = { ...SPAN_DEFAULT };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(out) as BoardKey[]) {
      const v = Number((raw as Record<string, unknown>)[key]);
      if (Number.isInteger(v) && v >= 1 && v <= SPAN_MAX) out[key] = v;
    }
  }
  return out;
}
function readSpans(): Record<BoardKey, number> {
  try { return cleanSpans(JSON.parse(localStorage.getItem(SPAN_KEY) || "null")); } catch { return { ...SPAN_DEFAULT }; }
}
function saveSpans(spans: Record<BoardKey, number>) {
  try { localStorage.setItem(SPAN_KEY, JSON.stringify(spans)); } catch { /* not essential */ }
}

// The narrowest a board column may be: keep in step with `.nb-board` in notebook.css.
const BOARD_COL_MIN = 260;

/**
 * How many columns the board has room for right now (it changes with the window).
 * Worked out from the width, not read from the grid: a wide card would otherwise
 * make the grid add a column of its own, and we would count that one too.
 */
function useBoardColumns(el: HTMLElement | null): number {
  const [cols, setCols] = useState(SPAN_MAX);
  useEffect(() => {
    if (!el) return;
    const measure = () => {
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      setCols(Math.max(1, Math.floor((el.clientWidth + gap) / (BOARD_COL_MIN + gap))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return cols;
}

/**
 * The right edge of a meeting card, as a handle: drag it to make the card one, two
 * or three columns wide (it snaps), or focus it and use ←/→; Enter or a
 * double-click puts the card back to its usual width.
 */
function CardResizer({ label, span, cols, onSpan }: {
  label: string; span: number; cols: number; onSpan: (span: number, save: boolean) => void;
}) {
  const max = Math.min(SPAN_MAX, cols);
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const card = e.currentTarget.parentElement;
    const board = card?.parentElement;
    if (!card || !board) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const gap = parseFloat(getComputedStyle(board).columnGap) || 0;
    const track = (board.getBoundingClientRect().width - gap * (cols - 1)) / cols;
    const left = card.getBoundingClientRect().left;
    let last = span;
    const move = (ev: PointerEvent) => {
      const next = Math.min(max, Math.max(1, Math.round((ev.clientX - left + gap) / (track + gap))));
      if (next !== last) { last = next; onSpan(next, false); }
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.documentElement.classList.remove("nb-resizing");
      onSpan(last, true);
    };
    handle.setPointerCapture(e.pointerId);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    document.documentElement.classList.add("nb-resizing");
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const next = e.key === "ArrowLeft" ? span - 1 : e.key === "ArrowRight" ? span + 1 : e.key === "Enter" ? -1 : null;
    if (next === null) return;
    e.preventDefault();
    onSpan(next === -1 ? -1 : Math.min(max, Math.max(1, next)), true);
  };
  if (max < 2) return null;
  return (
    <div className="nb-card-resizer" role="separator" aria-orientation="vertical" tabIndex={0}
      aria-label={`Width of ${label}`} aria-valuemin={1} aria-valuemax={max} aria-valuenow={span}
      aria-valuetext={`${span} of ${cols} columns`} title="Drag to widen or narrow · double-click to reset"
      onPointerDown={onPointerDown} onKeyDown={onKeyDown} onDoubleClick={() => onSpan(-1, true)} />
  );
}

/**
 * The whole notebook as one page (the "Notebook" view, and the view you edit in).
 * Lectures and reading notes: classic paper. Meetings: the modern dot-grid board.
 */
export default function NotebookPage({ nb, doc, editing, onEdit, onSource, style, fallbackTitle }: Common & {
  style: NotebookStyle; fallbackTitle: string;
}) {
  const vars = styleVars(style) as React.CSSProperties;
  // A new font or size changes every text box's line breaks.
  useLayoutEffect(refitText, [style.family, style.size, style.style]);
  const common = { nb, doc, editing, onEdit, onSource };
  const endRef = useRef<HTMLDivElement>(null);
  const [cueWidth, setCueWidth] = useState(readCueWidth);
  const onCueWidth = (pct: number, save: boolean) => {
    setCueWidth(pct);
    if (save) saveCueWidth(pct);
  };
  // A callback ref, so the board is measured whenever it appears, not only on first render.
  const [boardEl, setBoardEl] = useState<HTMLDivElement | null>(null);
  const cols = useBoardColumns(boardEl);
  const [spans, setSpans] = useState(readSpans);
  // -1 means "back to this card's usual width".
  const onCardSpan = (key: BoardKey) => (span: number, save: boolean) => {
    setSpans(prev => {
      const next = { ...prev, [key]: span === -1 ? SPAN_DEFAULT[key] : span };
      if (save) saveSpans(next);
      return next;
    });
  };
  const addSec = () => {
    const section = newSection(nb.kind === "meeting" ? "New topic" : "New section");
    onEdit(d => addSection(d, section));
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
    setTimeout(() => document.querySelector<HTMLInputElement>(`#nb-s-${section.id} .nb-section-title-input`)?.select(), 60);
  };

  if (nb.kind === "meeting") {
    return (
      <article className={`nb-paper nb-paper-modern${editing ? " editing" : ""}`} style={vars}>
        <header className="nb-head">
          <div className="nb-kicker">Meeting notes</div>
          <Heading {...common} fallback={fallbackTitle} />
        </header>
        {(editing || doc.summary) && (
          <section className="nb-tldr" aria-label="TL;DR">
            <div className="nb-kicker">TL;DR</div>
            <Summary {...common} label="Where the meeting landed" />
          </section>
        )}
        <div className="nb-board" ref={setBoardEl}>
          {BOARD.map(col => {
            const blocks = doc.board[col.key];
            if (!editing && !blocks.length) return null;
            const span = Math.min(spans[col.key], cols);
            return (
              <section key={col.key} className={`nb-card nb-card-${col.key}`} aria-label={col.label}
                style={{ gridColumn: `span ${span}` }}>
                <CardResizer label={col.label} span={span} cols={cols} onSpan={onCardSpan(col.key)} />
                <h2 className="nb-card-title">{col.label}{col.key === "actions" && blocks.length > 0 &&
                  <span className="nb-card-count">{blocks.filter(b => b.done).length} of {blocks.length} done</span>}</h2>
                <BlockList {...common} at={{ board: col.key }} blocks={blocks} types={[col.type]} />
              </section>
            );
          })}
        </div>
        {(doc.sections.length > 0 || editing) && (
          <section className="nb-card nb-topics" aria-label="What we covered">
            <h2 className="nb-card-title">What we covered</h2>
            {doc.sections.map((s, i) => <SectionView key={s.id} {...common} section={s} index={i} count={doc.sections.length} />)}
            {editing && <button type="button" className="nb-add" onClick={addSec}><Plus size={12} /> Topic</button>}
          </section>
        )}
        <div ref={endRef} />
      </article>
    );
  }

  return (
    <article className={`nb-paper nb-paper-classic${editing ? " editing" : ""}`} style={vars}>
      <header className="nb-head">
        <div className="nb-kicker">{nb.kind === "reading" ? "Reading notes" : "Lecture notes"}</div>
        <Heading {...common} fallback={fallbackTitle} />
      </header>
      <div className="nb-cornell" style={{ "--nb-cue-w": `${cueWidth}%` } as React.CSSProperties}>
        <Cues {...common} />
        <div className="nb-main">
          <CueResizer width={cueWidth} onWidth={onCueWidth} />
          {doc.sections.map((s, i) => <SectionView key={s.id} {...common} section={s} index={i} count={doc.sections.length} />)}
          {editing && <button type="button" className="nb-add nb-add-section" onClick={addSec}><Plus size={12} /> Section</button>}
          {!editing && doc.sections.length === 0 && <p className="muted">Nothing here yet. Press Edit to start writing.</p>}
        </div>
      </div>
      {(editing || doc.summary) && (
        <section className="nb-summary" aria-label="Summary">
          <div className="nb-kicker">Summary</div>
          <Summary {...common} label="A few sentences on the whole thing" />
        </section>
      )}
      <div ref={endRef} />
    </article>
  );
}
