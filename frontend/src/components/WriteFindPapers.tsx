import { useState } from "react";
import { BookPlus, Check, ChevronDown, ChevronRight, ExternalLink, Loader2, Search, SlidersHorizontal } from "lucide-react";
import { toFriendly, notifyError } from "../lib/errors";
import { openExternal } from "../lib/openExternal";
import {
  FIELDS, addedAs, authorLine, moreLine, searchPapers, type Paper, type PaperFilters, type PaperSearch,
} from "../lib/papers";
import { writingApi } from "../lib/writing";
import type { Ref } from "../lib/citations";

/**
 * Find papers (docs/write-citation-backbone.md): search OpenAlex and Semantic Scholar from the
 * Sources panel and add a result as a source. Nothing is sent until Search is pressed, and then
 * only the words and filters. No AI.
 */
export function FindPapers({ projectId, refs, onAdded }: {
  projectId: number; refs: Ref[]; onAdded: (r: Ref & { existing?: boolean }) => void;
}) {
  const [q, setQ] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [f, setF] = useState({ from: "", to: "", oa: false, preprints: true, minCites: "", field: "" });
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<PaperSearch | null>(null);
  const [error, setError] = useState("");

  const filters = (): PaperFilters => {
    const out: PaperFilters = { preprints: f.preprints };
    if (/^\d{4}$/.test(f.from)) out.year_from = Number(f.from);
    if (/^\d{4}$/.test(f.to)) out.year_to = Number(f.to);
    if (f.oa) out.open_access = true;
    if (Number(f.minCites) > 0) out.min_citations = Number(f.minCites);
    if (f.field) out.field = f.field;
    return out;
  };
  const run = async () => {
    setBusy(true); setError("");
    try { setFound(await searchPapers(q.trim(), filters())); }
    catch (e) { setFound(null); setError(toFriendly(e).message); }
    finally { setBusy(false); }
  };
  const active = [f.from || f.to, f.oa, !f.preprints, Number(f.minCites) > 0, f.field].filter(Boolean).length;

  return (
    <div className="write-find">
      <form className="write-inline-form" role="search" onSubmit={e => { e.preventDefault(); if (q.trim().length >= 2) void run(); }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Words from your topic, e.g. situational variability stuttering adults"
          aria-label="Search for papers" maxLength={300} />
        <button type="button" className="btn-ghost" aria-expanded={showFilters} onClick={() => setShowFilters(s => !s)}>
          <SlidersHorizontal size={13} /> Filters{active ? ` (${active})` : ""}
        </button>
        <button className="btn-primary" disabled={busy || q.trim().length < 2}>
          {busy ? <Loader2 size={13} className="spin" /> : <Search size={13} />} Search
        </button>
      </form>
      {showFilters && (
        <div className="write-find-filters">
          <label className="write-field"><span>From year</span>
            <input inputMode="numeric" maxLength={4} value={f.from} onChange={e => setF({ ...f, from: e.target.value.replace(/\D/g, "") })} placeholder="2010" aria-label="From year" /></label>
          <label className="write-field"><span>To year</span>
            <input inputMode="numeric" maxLength={4} value={f.to} onChange={e => setF({ ...f, to: e.target.value.replace(/\D/g, "") })} placeholder="2026" aria-label="To year" /></label>
          <label className="write-field"><span>Min. citations</span>
            <input inputMode="numeric" maxLength={6} value={f.minCites} onChange={e => setF({ ...f, minCites: e.target.value.replace(/\D/g, "") })} placeholder="0" aria-label="At least this many citations" /></label>
          <label className="write-field"><span>Field</span>
            <select value={f.field} onChange={e => setF({ ...f, field: e.target.value })} aria-label="Field">
              {FIELDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select></label>
          <label className="write-check"><input type="checkbox" checked={f.oa} onChange={e => setF({ ...f, oa: e.target.checked })} /> Open access only</label>
          <label className="write-check"><input type="checkbox" checked={f.preprints} onChange={e => setF({ ...f, preprints: e.target.checked })} /> Include preprints</label>
        </div>
      )}
      {error && <p className="write-warn" role="alert">{error}</p>}
      {found && (
        <>
          {found.notice && <p className="write-find-notice" role="status">{found.notice}</p>}
          {found.results.length === 0 ? (
            <p className="muted">No papers matched. Try fewer or broader words, or loosen the filters.</p>
          ) : (
            <>
              {moreLine(found) && <p className="muted write-small">{moreLine(found)}</p>}
              <div className="write-paper-list">
                {found.results.map(p => <PaperCard key={p.id} p={p} added={addedAs(p, refs)} projectId={projectId} onAdded={onAdded} />)}
              </div>
            </>
          )}
          <p className="muted write-small">From OpenAlex and Semantic Scholar. Only your search words and filters were sent.</p>
        </>
      )}
    </div>
  );
}

function PaperCard({ p, added, projectId, onAdded }: { p: Paper; added?: Ref; projectId: number; onAdded: (r: Ref & { existing?: boolean }) => void }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const titleId = `paper-${p.id.replace(/[^\w-]/g, "_")}`;
  const add = async () => {
    setAdding(true);
    try { onAdded(await writingApi.addRef(projectId, { paper: p })); } catch (e) { notifyError(e); } finally { setAdding(false); }
  };
  const link = p.doi ? `https://doi.org/${p.doi}` : p.url;
  return (
    <article className="write-paper-card" aria-labelledby={titleId}>
      <div className="write-paper-main">
        <h4 id={titleId}>{p.title}</h4>
        <p className="write-paper-authors">{authorLine(p.authors)}</p>
        <p className="muted write-paper-meta">
          {p.venue ? <span>{p.venue}</span> : null}
          <span>{p.year ?? "n.d."}</span>
          <span>{p.citations.toLocaleString("en-GB")} citation{p.citations === 1 ? "" : "s"}</span>
        </p>
        <div className="write-paper-badges">
          {p.open_access && <span className="write-badge oa">Open access</span>}
          {p.preprint && <span className="write-badge preprint" title="Not yet peer reviewed, or posted before review">Preprint</span>}
          {p.retracted && <span className="write-badge retracted" title="The publisher has withdrawn this paper">Retracted</span>}
        </div>
        {open && p.abstract && <p className="write-paper-abstract">{p.abstract}</p>}
      </div>
      <div className="write-paper-actions">
        <button type="button" className="btn-primary" disabled={!!added || adding} onClick={() => void add()}>
          {added ? <><Check size={13} /> Added</> : adding ? <><Loader2 size={13} className="spin" /> Add</> : <><BookPlus size={13} /> Add</>}
        </button>
        {p.abstract && (
          <button type="button" className="btn-ghost" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Abstract
          </button>
        )}
        {link && <button type="button" className="btn-ghost" onClick={() => void openExternal(link)} title={link}><ExternalLink size={13} /> Open</button>}
      </div>
    </article>
  );
}
