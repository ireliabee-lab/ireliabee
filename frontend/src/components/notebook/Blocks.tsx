import { memo, useEffect, useRef, useLayoutEffect } from "react";
import {
  Star, BookMarked, Lightbulb, Flag, HelpCircle, Quote, Sigma, Table2, AlertCircle, CheckCircle2,
  AlertTriangle, Hash, Pencil, Sparkles, ArrowUp, ArrowDown, Trash2, Plus, Clock, Minus,
} from "lucide-react";
import { BLOCK_META, richKey, richRuns, sourceLabel, type NotebookDoc, type Rich, type RichTarget, type Block, type BlockType, type Notebook } from "../../lib/notebook";

const ICON: Partial<Record<BlockType, JSX.Element>> = {
  key: <Star size={14} />, definition: <BookMarked size={14} />, example: <Lightbulb size={14} />,
  exam: <Flag size={14} />, question: <HelpCircle size={14} />, quote: <Quote size={14} />,
  formula: <Sigma size={14} />, table: <Table2 size={14} />, unclear: <AlertCircle size={14} />,
  decision: <CheckCircle2 size={14} />, risk: <AlertTriangle size={14} />, number: <Hash size={14} />,
  note: <Pencil size={14} />, tutor: <Sparkles size={14} />,
};

/** The small chip that says where a note came from; clicking it shows the source. */
export function SourceChip({ nb, src, onSource }: {
  nb: Pick<Notebook, "kind" | "line_times">; src: number[]; onSource?: (src: number[]) => void;
}) {
  const label = sourceLabel(nb, src);
  if (!label) return null;
  return (
    <button type="button" className="nb-src" onClick={() => onSource?.(src)}
      title={nb.kind === "reading" ? "Open the page this came from" : "Show where this was said"}>
      <Clock size={10} aria-hidden="true" /> {label}
    </button>
  );
}

/** One block, as the reader sees it. */
/**
 * Any notebook text as the user marked it up: highlights, bold, italic, underline,
 * strikethrough and text colour. Tagged with its address (data-rich) so a selection
 * can be traced back to it. Empty text draws nothing: there is nothing to format.
 */
export const RichText = memo(function RichText({ value, rich, target }: { value: string; rich?: Rich; target: RichTarget }) {
  if (!value) return null;
  return (
    <span data-rich={richKey(target)}>
      {richRuns(value, rich?.marks, rich?.fmt, rich?.ink).map((r, k) => {
        let node: React.ReactNode = r.text;
        if (r.x) node = <s>{node}</s>;
        if (r.u) node = <u>{node}</u>;
        if (r.i) node = <em>{node}</em>;
        if (r.b) node = <strong>{node}</strong>;
        if (r.c) node = <mark className={`nb-mark nb-mark-${r.c}`}>{node}</mark>;
        return <span key={k} className={r.k ? `nb-ink nb-ink-${r.k}` : undefined}>{node}</span>;
      })}
    </span>
  );
}, (a, b) => a.value === b.value && a.rich?.marks === b.rich?.marks && a.rich?.fmt === b.rich?.fmt
  && a.rich?.ink === b.rich?.ink && richKey(a.target) === richKey(b.target));

/** A block's main text. */
export function MarkedText({ block }: { block: Block }) {
  return <RichText value={block.text} rich={{ marks: block.marks, fmt: block.fmt, ink: block.ink }}
    target={{ scope: "b", id: block.id, field: "text" }} />;
}

/** One of the notebook's own texts (title, author, summary, cue:N), with its formatting. */
export function DocText({ doc, field, value }: { doc: NotebookDoc; field: string; value?: string }) {
  const text = value ?? ((doc as unknown as Record<string, unknown>)[field] as string | undefined) ?? "";
  return <RichText value={text} rich={doc.rich?.[field]} target={{ scope: "d", id: "", field }} />;
}

/** One of a block's other texts (term, speaker, owner, due, caption, cell:R:C). */
function Field({ block, field, value }: { block: Block; field: string; value: string }) {
  return <RichText value={value} rich={block.rich?.[field]} target={{ scope: "b", id: block.id, field }} />;
}

export function BlockView({ block, nb, onSource, onToggleDone }: {
  block: Block;
  nb: Pick<Notebook, "kind" | "line_times">;
  onSource?: (src: number[]) => void;
  onToggleDone?: (done: boolean) => void;
}) {
  const chip = <SourceChip nb={nb} src={block.src} onSource={onSource} />;
  const label = (text: string) => <span className="nb-label">{ICON[block.type]}{text}</span>;
  switch (block.type) {
    case "point":
      return <div className="nb-b nb-b-point"><span className="nb-bullet" aria-hidden="true" /><MarkedText block={block} /> {chip}</div>;
    case "key":
      return (
        <div className="nb-b nb-b-key">
          <span className="nb-hl"><MarkedText block={block} /></span>
          <Star size={13} className="nb-key-star" aria-label="Key point" /> {chip}
        </div>
      );
    case "definition":
      return <div className="nb-b nb-b-definition">{label("Term")}<div><strong><Field block={block} field="term" value={block.term ?? ""} /></strong>{block.term ? ": " : ""}<MarkedText block={block} /> {chip}</div></div>;
    case "example":
      return <div className="nb-b nb-b-example">{label("Example")}<div><MarkedText block={block} /> {chip}</div></div>;
    case "exam":
      return <div className="nb-b nb-b-exam">{label("Exam point")}<div><MarkedText block={block} /> {chip}</div></div>;
    case "question":
      return <div className="nb-b nb-b-question">{label("Question")}<div><MarkedText block={block} /> {chip}</div></div>;
    case "quote":
      return (
        <blockquote className="nb-b nb-b-quote">
          “<MarkedText block={block} />”{block.speaker && <span className="nb-quote-who"> — <Field block={block} field="speaker" value={block.speaker} /></span>} {chip}
        </blockquote>
      );
    case "formula":
      return <div className="nb-b nb-b-formula">{label("Formula")}<pre>{block.text}</pre>{chip}</div>;
    case "table": {
      const rows = block.rows ?? [];
      return (
        <div className="nb-b nb-b-table">
          <table>
            {block.caption && <caption><Field block={block} field="caption" value={block.caption} /></caption>}
            {rows.length > 0 && <thead><tr>{rows[0].map((c, i) => <th key={i} scope="col"><Field block={block} field={`cell:0:${i}`} value={c} /></th>)}</tr></thead>}
            <tbody>{rows.slice(1).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}><Field block={block} field={`cell:${i + 1}:${j}`} value={c} /></td>)}</tr>)}</tbody>
          </table>
          {chip}
        </div>
      );
    }
    case "unclear":
      return <div className="nb-b nb-b-unclear">{label("Check this")}<div><MarkedText block={block} /> {chip}</div></div>;
    case "decision":
      return <div className="nb-b nb-b-decision"><CheckCircle2 size={16} aria-label="Decision" /><div><MarkedText block={block} /> {chip}</div></div>;
    case "action":
      return (
        <label className={`nb-b nb-b-action ${block.done ? "done" : ""}`}>
          <input type="checkbox" checked={!!block.done} disabled={!onToggleDone}
            onChange={e => onToggleDone?.(e.target.checked)} aria-label={`Done: ${block.text}`} />
          <span className="nb-action-body">
            <span className="nb-action-text"><MarkedText block={block} /></span>
            <span className="nb-action-meta">
              <span className="nb-chip">{block.owner ? <Field block={block} field="owner" value={block.owner} /> : "Not agreed"}</span>
              <span className={`nb-chip ${block.due ? "due" : "undecided"}`}>{block.due ? <Field block={block} field="due" value={block.due} /> : "Due: not agreed"}</span>
              {chip}
            </span>
          </span>
        </label>
      );
    case "risk":
      return <div className="nb-b nb-b-risk">{label("Risk")}<div><MarkedText block={block} /> {chip}</div></div>;
    case "number":
      return <div className="nb-b nb-b-number"><span className="nb-number"><Field block={block} field="term" value={block.term ?? ""} /></span><span className="nb-number-what"><MarkedText block={block} /></span>{chip}</div>;
    case "note":
      return <div className="nb-b nb-b-note">{label("My note")}<div><MarkedText block={block} /></div></div>;
    case "tutor":
      return <div className="nb-b nb-b-tutor">{label("iReliabee's explanation")}<div><MarkedText block={block} /></div></div>;
  }
}

// Text boxes exactly as tall as their lines, so on ruled paper they span whole rows.
// Where the engine can size a text box to its content (CSS field-sizing), it does, with
// no script at all. Elsewhere boxes are measured in batches: every box waiting is set
// to auto, then all are read in one layout, then all are sized — one layout for the
// lot instead of one per box (opening the editor on a long notebook mounts hundreds).
const NATIVE_FIT = typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content");
const waiting = new Set<HTMLTextAreaElement>();
function fitSoon(el: HTMLTextAreaElement) {
  if (NATIVE_FIT) return;
  if (!waiting.size) queueMicrotask(fitWaiting);
  waiting.add(el);
}
function fitWaiting() {
  const els = [...waiting].filter(el => el.isConnected);
  waiting.clear();
  if (!els.length) return;
  // Shrinking every box at once shortens the page for a moment; keep the reader's place.
  const scrollers: [Element, number][] = [];
  for (let n: Element | null = els[0].parentElement; n; n = n.parentElement) if (n.scrollTop) scrollers.push([n, n.scrollTop]);
  for (const el of els) el.style.height = "auto";
  const heights = els.map(el => el.scrollHeight);
  els.forEach((el, i) => { el.style.height = `${heights[i]}px`; });
  for (const [n, top] of scrollers) n.scrollTop = top;
}
// One observer for every box: when a box's width changes its text re-wraps.
const widths = new WeakMap<Element, number>();
const resized = typeof ResizeObserver === "undefined" || NATIVE_FIT ? null : new ResizeObserver(entries => {
  for (const e of entries) {
    const w = Math.round(e.contentRect.width);
    if (widths.get(e.target) !== w) { widths.set(e.target, w); fitSoon(e.target as HTMLTextAreaElement); }
  }
});
// Once the notebook fonts arrive every box is measured again (a font changes line breaks).
const mounted = new Set<HTMLTextAreaElement>();
if (!NATIVE_FIT && typeof document !== "undefined") document.fonts?.ready.then(() => mounted.forEach(fitSoon)).catch(() => {});

/** Measure every text box again (the notebook's font or size changed). */
export function refitText() { mounted.forEach(fitSoon); }

export function AutoText({ value, onChange, label, placeholder, mono = false }: {
  value: string; onChange: (v: string) => void; label: string; placeholder?: string; mono?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Measured when its words or its own font change (a note turned into a formula is
  // set in mono); width and notebook-font changes come from the shared observers.
  useLayoutEffect(() => { if (ref.current) fitSoon(ref.current); }, [value, mono, placeholder]);
  useEffect(() => {
    const el = ref.current;
    if (!el || NATIVE_FIT) return;
    mounted.add(el);
    resized?.observe(el);
    return () => { mounted.delete(el); resized?.unobserve(el); };
  }, []);
  return (
    <textarea ref={ref} className={`nb-input nb-textarea ${mono ? "mono" : ""}`} value={value} rows={1}
      aria-label={label} placeholder={placeholder} onChange={e => onChange(e.target.value)} />
  );
}

/** One block, as the editor sees it: every field of its type, plus move / delete / add. */
export function BlockEditor({ block, types, onChange, onDelete, onMove, onAddBelow, first, last }: {
  block: Block;
  types: BlockType[];
  onChange: (patch: Partial<Block>) => void;
  onDelete: () => void;
  onMove: (by: -1 | 1) => void;
  onAddBelow: () => void;
  first: boolean;
  last: boolean;
}) {
  const typeChoices = types.includes(block.type) ? types : [block.type, ...types];
  const rows = block.rows ?? [];
  const setCell = (i: number, j: number, v: string) =>
    onChange({ rows: rows.map((r, a) => (a === i ? r.map((c, b) => (b === j ? v : c)) : r)) });
  return (
    <div className={`nb-edit nb-edit-${block.type}`} data-block={block.id}>
      <div className="nb-edit-bar">
        <select className="nb-input nb-type" value={block.type} aria-label="Kind of note"
          onChange={e => onChange({ type: e.target.value as BlockType })}>
          {typeChoices.map(t => <option key={t} value={t}>{BLOCK_META[t].label}</option>)}
        </select>
        <span className="nb-edit-spacer" />
        <button type="button" className="nb-icon-btn" onClick={() => onMove(-1)} disabled={first} aria-label="Move up"><ArrowUp size={14} /></button>
        <button type="button" className="nb-icon-btn" onClick={() => onMove(1)} disabled={last} aria-label="Move down"><ArrowDown size={14} /></button>
        <button type="button" className="nb-icon-btn" onClick={onAddBelow} aria-label="Add a note below"><Plus size={14} /></button>
        <button type="button" className="nb-icon-btn danger" onClick={onDelete} aria-label="Delete this note"><Trash2 size={14} /></button>
      </div>

      {(block.type === "definition" || block.type === "number") && (
        <input className="nb-input" value={block.term ?? ""} aria-label={block.type === "number" ? "The figure or date" : "Term"}
          placeholder={block.type === "number" ? "GHS 12,000 · 20 Oct" : "Term"} onChange={e => onChange({ term: e.target.value })} />
      )}

      {block.type === "table" ? (
        <div className="nb-table-edit">
          <input className="nb-input" value={block.caption ?? ""} aria-label="Table caption" placeholder="Caption (optional)"
            onChange={e => onChange({ caption: e.target.value })} />
          <table>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j}>
                      <input className="nb-input" value={c} aria-label={`Row ${i + 1}, column ${j + 1}`}
                        onChange={e => setCell(i, j, e.target.value)} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="nb-table-tools">
            <button type="button" className="btn-neutral" onClick={() => onChange({ rows: [...rows, (rows[0] ?? [""]).map(() => "")] })}><Plus size={12} /> Row</button>
            <button type="button" className="btn-neutral" disabled={rows.length <= 1} onClick={() => onChange({ rows: rows.slice(0, -1) })}><Minus size={12} /> Row</button>
            <button type="button" className="btn-neutral" disabled={(rows[0]?.length ?? 0) >= 6} onClick={() => onChange({ rows: rows.map(r => [...r, ""]) })}><Plus size={12} /> Column</button>
            <button type="button" className="btn-neutral" disabled={(rows[0]?.length ?? 0) <= 1} onClick={() => onChange({ rows: rows.map(r => r.slice(0, -1)) })}><Minus size={12} /> Column</button>
          </div>
        </div>
      ) : (
        <AutoText value={block.text} onChange={text => onChange({ text })} label={BLOCK_META[block.type].label}
          placeholder={BLOCK_META[block.type].hint} mono={block.type === "formula"} />
      )}

      {block.type === "quote" && (
        <input className="nb-input" value={block.speaker ?? ""} aria-label="Who said it" placeholder="Who said it"
          onChange={e => onChange({ speaker: e.target.value })} />
      )}
      {block.type === "action" && (
        <div className="nb-edit-row">
          <input className="nb-input" value={block.owner ?? ""} aria-label="Owner" placeholder="Owner"
            onChange={e => onChange({ owner: e.target.value })} />
          <input className="nb-input" value={block.due ?? ""} aria-label="Due" placeholder="Due (as agreed)"
            onChange={e => onChange({ due: e.target.value })} />
          <label className="nb-done"><input type="checkbox" checked={!!block.done} onChange={e => onChange({ done: e.target.checked })} /> Done</label>
        </div>
      )}
    </div>
  );
}
