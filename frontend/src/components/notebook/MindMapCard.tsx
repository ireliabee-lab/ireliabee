import { useEffect, useMemo, useState } from "react";
import { BookOpen, Loader2, Network, RotateCcw, Save, X, ZoomIn, ZoomOut } from "lucide-react";
import { readingApi, type MindMap, type ReaderLevel } from "../../lib/reading";
import { OWN_ASSISTANT_COST, relayIssueLine, useAssistantAuto, useOwnAssistant } from "../../lib/relay";
import { notifyError, toFriendly } from "../../lib/errors";
import { layoutMindMap, labelWidth, MAP_H, MAP_W, mindMapSvg, type PlacedNode } from "../../lib/mindMapLayout";
import type { Selected } from "./ExplainCard";

/** Timing of the entrance: the centre, then each branch drawn like ink, then its details. */
const BRANCH_DELAY = 0.5;
const BRANCH_STEP = 0.32;
const LEAF_STEP = 0.11;

function delayOf(p: PlacedNode): number {
  const base = BRANCH_DELAY + p.branch * BRANCH_STEP;
  return p.leaf < 0 ? base : base + 0.45 + p.leaf * LEAF_STEP;
}

/**
 * A highlighted passage drawn as a radial mind map (POST /reading/mind-map):
 * the main idea pops in, branches draw out like ink, the details follow.
 * Hover lights a branch's path; click an idea for its note and source page.
 * The finished map can be kept in the notebook as a picture.
 */
export default function MindMapCard({ selected, documentId, level, paper, ink, onSource, onSave, onClose }: {
  selected: Selected;
  documentId: number | null;
  level: ReaderLevel;
  /** The book's paper and ink, so the kept picture matches the page it sits on. */
  paper?: string;
  ink?: string;
  onSource?: (src: number[]) => void;
  /** Keep the map in the notebook: a picture of it, as an SVG file. */
  onSave: (svg: Blob) => Promise<void> | void;
  onClose: () => void;
}) {
  const ownAssistant = useOwnAssistant();
  const [map, setMap] = useState<MindMap | null>(null);
  const [busy, setBusy] = useState(false);
  const [relayIssue, setRelayIssue] = useState<"not_listening" | "timeout" | null>(null);
  const relayAuto = useAssistantAuto(relayIssue);
  const [hover, setHover] = useState<number | null>(null);
  const [picked, setPicked] = useState<PlacedNode | null>(null);
  const [run, setRun] = useState(0);   // replays the entrance
  const [saved, setSaved] = useState(false);
  const [zoom, setZoom] = useState(1);
  const zoomBy = (f: number) => setZoom(z => Math.min(3, Math.max(0.6, +(z * f).toFixed(2))));
  const placed = useMemo(() => (map ? layoutMindMap(map) : []), [map]);

  function build(fallbackCredits = false) {
    setBusy(true);
    setRelayIssue(null);
    readingApi.mindMap({ passage: selected.text, document_id: documentId, pages: selected.src, level, fallback_credits: fallbackCredits })
      .then(m => { setMap(m); setPicked(null); setSaved(false); setRun(r => r + 1); })
      .catch(e => {
        const code = toFriendly(e).code;
        if (code === "relay_not_listening") setRelayIssue("not_listening");
        else if (code === "relay_timeout") setRelayIssue("timeout");
        else notifyError(e);
      })
      .finally(() => setBusy(false));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  async function save() {
    if (!map) return;
    try {
      await onSave(new Blob([mindMapSvg(map, placed, paper, ink, false)], { type: "image/svg+xml" }));
      setSaved(true);
    } catch (e) { notifyError(e); }
  }

  const shown = selected.text.length > 140 ? `${selected.text.slice(0, 137)}…` : selected.text;
  const centerW = map ? labelWidth(map.center, 22) : 0;
  const lit = (p: PlacedNode) => hover === null || hover === p.branch;

  return (
    <div className="debrief-overlay mm-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-card mm-card" role="dialog" aria-modal="true" aria-label="Mind map">
        <header className="mm-head">
          <div className="mm-title"><Network size={16} /> <strong>Mind map</strong>
            <span className="muted mm-passage">“{shown}”</span></div>
          <div className="mm-tools">
            {map && <>
              <button type="button" className="nb-icon-btn" onClick={() => zoomBy(1 / 1.25)} disabled={zoom <= 0.6} aria-label="Zoom out" title="Zoom out (Ctrl + scroll)"><ZoomOut size={15} /></button>
              <button type="button" className="mm-zoom" onClick={() => setZoom(1)} title="Back to 100%">{Math.round(zoom * 100)}%</button>
              <button type="button" className="nb-icon-btn" onClick={() => zoomBy(1.25)} disabled={zoom >= 3} aria-label="Zoom in" title="Zoom in (Ctrl + scroll)"><ZoomIn size={15} /></button>
              <button type="button" className="nb-icon-btn" onClick={() => setRun(r => r + 1)} aria-label="Play the map again" title="Play again"><RotateCcw size={15} /></button>
              <button type="button" className="nbk-pill" onClick={() => void save()} disabled={saved}>
                <Save size={13} /> {saved ? "In your notebook" : "Keep in notebook"}
              </button>
            </>}
            <button type="button" className="nb-icon-btn" onClick={onClose} aria-label="Close (Esc)"><X size={16} /></button>
          </div>
        </header>

        {!map && (
          <div className="mm-start">
            <div className={`mm-seed ${busy ? "growing" : ""}`} aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map(i => <span key={i} style={{ ["--i" as string]: i }} />)}
              <i />
            </div>
            {busy ? (
              <p className="mm-status"><Loader2 size={14} className="spin" /> Mapping the ideas{ownAssistant ? " with your assistant" : ""}…</p>
            ) : relayIssue ? (
              <div className="mm-status">
                <p>{relayIssueLine(relayIssue === "timeout" ? "relay_timeout" : "relay_not_listening", relayAuto)}</p>
                <div className="mm-actions">
                  <button type="button" className="nbk-pill" onClick={() => build(false)}>Try again</button>
                  <button type="button" className="btn-neutral" onClick={() => build(true)}>Use credits instead</button>
                </div>
              </div>
            ) : (
              <div className="mm-status">
                <p>See this passage as a map: its main idea in the middle, what it rests on around it, and the details beyond.</p>
                <p className="muted">{ownAssistant ? `${OWN_ASSISTANT_COST}.` : "Uses a few credits, about the same as an explanation."}</p>
                <div className="mm-actions">
                  <button type="button" className="nbk-pill mm-go" onClick={() => build(false)} autoFocus><Network size={14} /> Build the map</button>
                </div>
              </div>
            )}
          </div>
        )}

        {map && (
          <div className="mm-body">
            <div className="mm-scroll" onWheel={e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); } }}>
            <svg key={run} className="mm-svg" style={{ width: `${zoom * 100}%`, maxHeight: zoom === 1 ? undefined : "none" }} viewBox={`${-MAP_W / 2} ${-MAP_H / 2} ${MAP_W} ${MAP_H}`} role="img"
              aria-label={`Mind map of ${map.center}: ${map.branches.map(b => b.label).join(", ")}`}
              onMouseLeave={() => setHover(null)}>
              <defs>
                <radialGradient id="mm-glow"><stop offset="0" stopColor="var(--mm-glow)" /><stop offset="1" stopColor="var(--mm-glow)" stopOpacity="0" /></radialGradient>
              </defs>
              <circle className="mm-halo" r="260" fill="url(#mm-glow)" />
              {placed.map((p, i) => (
                <path key={`p${i}`} d={p.path} pathLength={1} className={`mm-path ${p.leaf < 0 ? "trunk" : "twig"} ${lit(p) ? "" : "dim"} ${hover === p.branch ? "lit" : ""}`}
                  style={{ stroke: p.color, animationDelay: `${delayOf(p) - (p.leaf < 0 ? 0.25 : 0.2)}s` }} />
              ))}
              {placed.map((p, i) => (
                <g key={`n${i}`} className={`mm-node ${p.leaf < 0 ? "branch" : "leaf"} ${lit(p) ? "" : "dim"} ${picked === p ? "picked" : ""}`}
                  transform={`translate(${p.x} ${p.y})`} tabIndex={0} role="button" aria-label={`${p.node.label}: ${p.node.note}`}
                  onMouseEnter={() => setHover(p.branch)} onFocus={() => setHover(p.branch)}
                  onClick={() => setPicked(p)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setPicked(p); } }}>
                  <g className="mm-pop" style={{ animationDelay: `${delayOf(p)}s`, ["--c" as string]: p.color }}>
                    <rect x={-p.w / 2} y={-p.h / 2} width={p.w} height={p.h} rx={p.h / 2} />
                    <text dominantBaseline="central" textAnchor="middle">{p.node.label}</text>
                  </g>
                </g>
              ))}
              <g className="mm-center">
                <g className="mm-pop">
                  <circle className="mm-ring" r={Math.max(centerW / 2, 40) + 14} />
                  <rect x={-centerW / 2} y={-30} width={centerW} height={60} rx={30} />
                  <text dominantBaseline="central" textAnchor="middle">{map.center}</text>
                </g>
              </g>
            </svg>
            </div>

            <aside className={`mm-note ${picked ? "open" : ""}`} aria-live="polite">
              {picked ? (
                <>
                  <span className="mm-note-dot" style={{ background: picked.color }} />
                  <strong>{picked.node.label}</strong>
                  <p>{picked.node.note || "No note for this one."}</p>
                  {picked.node.pages.length > 0 && onSource ? (
                    <button type="button" className="nbk-help-src" onClick={() => onSource(picked.node.pages)}>
                      <BookOpen size={12} /> From your source, p. {picked.node.pages.join(", ")}
                    </button>
                  ) : <span className="muted mm-note-src">From the passage you highlighted</span>}
                </>
              ) : (
                <p className="muted">Hover a branch to follow it. Click an idea to see what it means and where the source says it.</p>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
