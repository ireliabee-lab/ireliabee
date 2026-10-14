import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { Network, X } from "lucide-react";
import type { Idea } from "../../lib/reading";

/** Each term's depth: how many layers of other terms it builds on (0 for the basics). A loop counts once. */
export function depths(ideas: Idea[]): Map<string, number> {
  const by = new Map(ideas.map(i => [i.term, i]));
  const memo = new Map<string, number>();
  const visit = (term: string, path: Set<string>): number => {
    if (memo.has(term)) return memo.get(term)!;
    if (path.has(term)) return 0;
    path.add(term);
    const needs = (by.get(term)?.builds_on ?? []).filter(t => by.has(t));
    const d = needs.length ? 1 + Math.max(...needs.map(n => visit(n, path))) : 0;
    path.delete(term);
    memo.set(term, d);
    return d;
  };
  ideas.forEach(i => visit(i.term, new Set()));
  return memo;
}

const COL_W = 190, ROW_H = 46, NODE_W = 156, NODE_H = 32, PAD = 16, TOP = 34;

/**
 * The map of ideas (Deep Read, B4): the document's terms as one picture, the
 * basics on the left and what builds on them to the right, a line for each
 * "builds on". Read left to right, it is the order to learn them in.
 */
export default function IdeasMap({ ideas, title, onClose }: { ideas: Idea[]; title: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const layout = useMemo(() => {
    const d = depths(ideas);
    const cols: string[][] = [];
    for (const i of ideas) (cols[d.get(i.term) ?? 0] ??= []).push(i.term);
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((col, c) => col.forEach((t, r) => pos.set(t, { x: PAD + c * COL_W, y: TOP + r * ROW_H })));
    const width = PAD * 2 + Math.max(1, cols.length) * COL_W - (COL_W - NODE_W);
    const height = TOP + PAD + Math.max(1, ...cols.map(c => c.length)) * ROW_H - (ROW_H - NODE_H);
    return { pos, width, height, columns: cols.length };
  }, [ideas]);

  // On the page itself, not inside the editor: the book's canvas would otherwise be drawn over it.
  return createPortal(
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="nb-ideas" role="dialog" aria-modal="true" aria-label="Map of ideas">
        <div className="nb-popover-head">
          <strong><Network size={15} /> Map of ideas</strong> <span className="muted">{title}</span>
          <button type="button" className="nb-icon-btn" onClick={onClose} aria-label="Close"><X size={14} /></button>
        </div>
        <p className="muted nb-ideas-lede">The basics are on the left; each line leads to a term that builds on it. Left to right is the order to learn them in.</p>
        <div className="nb-ideas-scroll">
          <svg width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img"
            aria-label={`${ideas.length} terms in ${layout.columns} layers`}>
            {ideas.flatMap(i => i.builds_on.filter(b => layout.pos.has(b)).map(b => {
              const from = layout.pos.get(b)!, to = layout.pos.get(i.term)!;
              const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2, x2 = to.x, y2 = to.y + NODE_H / 2;
              // A line that skips a column arcs over the boxes between, so it is never hidden behind one.
              if (to.x - from.x > COL_W) {
                const lift = Math.min(y1, y2) - NODE_H / 2 - 10;
                return <path key={`${b}>${i.term}`} className="nb-ideas-edge"
                  d={`M${from.x + NODE_W / 2},${from.y} C${from.x + NODE_W / 2},${lift} ${to.x + NODE_W / 2},${lift} ${to.x + NODE_W / 2},${to.y}`} />;
              }
              return <path key={`${b}>${i.term}`} className="nb-ideas-edge" d={`M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}`} />;
            }))}
            {ideas.map(i => {
              const p = layout.pos.get(i.term)!;
              return (
                <g key={i.term} transform={`translate(${p.x},${p.y})`}>
                  <title>{i.term}{i.pages?.length ? ` (p. ${i.pages.join(", ")})` : ""}</title>
                  <rect className="nb-ideas-node" width={NODE_W} height={NODE_H} rx={8} />
                  <text className="nb-ideas-label" x={NODE_W / 2} y={NODE_H / 2} dominantBaseline="central" textAnchor="middle">
                    {i.term.length > 22 ? `${i.term.slice(0, 21)}…` : i.term}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
    </div>,
    document.body,
  );
}
