import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { BookPlus, Copy, ExternalLink, Library, Loader2, Quote, Search, Trash2, X } from "lucide-react";
import { fetchApi } from "../lib/api";
import { notifyError } from "../lib/errors";
import { openExternal } from "../lib/openExternal";
import { formatDocument, markerFor, type CslItem, type FormattedDocument, type Ref } from "../lib/citations";
import { writingApi, type Project } from "../lib/writing";
import { ExportButtons } from "./WriteExport";
import { FindPapers } from "./WriteFindPapers";

const CITEPROC_URL = "https://github.com/Juris-M/citeproc-js";

/** The credit citeproc-js's licence (CPAL) asks for, wherever Write shows formatted citations. */
export function CiteprocCredit() {
  return (
    <button type="button" className="write-credit" onClick={() => void openExternal(CITEPROC_URL)} title="citeproc-js source code">
      Citations by citeproc-js <ExternalLink size={10} />
    </button>
  );
}

/** Every source formatted in the project's style, in the style's own order. */
function useFormatted(refs: Ref[], style: string, texts: string[] = []): FormattedDocument | null {
  const [doc, setDoc] = useState<FormattedDocument | null>(null);
  const key = JSON.stringify([refs.map(r => [r.key, r.item]), style, texts]);
  useEffect(() => {
    let live = true;
    formatDocument(texts, refs, style).then(d => { if (live) setDoc(d); }).catch(() => { if (live) setDoc(null); });
    return () => { live = false; };
    // The key stands for refs, style and texts.
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return doc;
}

/** The project's sources: add by DOI, from the Library or by hand; each with the key the draft cites. */
export function SourcesPanel({ p, refs, setRefs }: { p: Project; refs: Ref[]; setRefs: (update: (prev: Ref[]) => Ref[]) => void }) {
  const [how, setHow] = useState<"find" | "doi" | "library" | "manual">("find");
  const formatted = useFormatted(refs, p.style);
  const byKey = useMemo(() => {
    // Formatted entries in the style's order; matched back to each source by its title.
    const out: Record<string, string> = {};
    // Case aside: APA and others put titles in sentence case.
    for (const r of refs) out[r.key] = formatted?.bibliography.find(e => r.item.title && e.toLowerCase().includes(String(r.item.title).slice(0, 40).toLowerCase())) ?? String(r.item.title);
    return out;
  }, [refs, formatted]);

  const added = (r: Ref & { existing?: boolean }) => {
    if (r.existing) toast("Already in your sources, as " + markerFor(r.key));
    else { setRefs(prev => [...prev, r]); toast.success(`Added. Cite it as ${markerFor(r.key)}`); }
  };
  const remove = (r: Ref) => writingApi.removeRef(r.id).then(() => setRefs(prev => prev.filter(x => x.id !== r.id))).catch(notifyError);

  return (
    <div className="write-sources">
      <div className="write-sources-head">
        <span className="write-kicker">Your sources ({refs.length})</span>
        <CiteprocCredit />
      </div>
      {refs.length === 0 ? (
        <p className="muted">No sources yet. Add each one once here; then cite it anywhere in your draft with the Cite button.</p>
      ) : (
        <ul className="write-source-list">
          {refs.map(r => (
            <li key={r.id}>
              <code className="write-cite-key" title="Type this in your draft, or use Cite">{markerFor(r.key)}</code>
              <span className="write-source-entry">{byKey[r.key]}</span>
              <button type="button" className="btn-ghost danger" aria-label={`Remove ${r.item.title}`} onClick={() => void remove(r)}><Trash2 size={13} /></button>
            </li>
          ))}
        </ul>
      )}
      <div className="write-add-source">
        <div className="write-seg" role="tablist" aria-label="Add a source">
          {([["find", "Find papers"], ["doi", "By DOI"], ["library", "From your Library"], ["manual", "By hand"]] as const).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={how === k} className={how === k ? "active" : ""} onClick={() => setHow(k)}>{label}</button>
          ))}
        </div>
        {how === "find" && <FindPapers projectId={p.id} refs={refs} onAdded={added} />}
        {how === "doi" && <AddByDoi projectId={p.id} onAdded={added} />}
        {how === "library" && <AddFromLibrary projectId={p.id} refs={refs} onAdded={added} />}
        {how === "manual" && <AddByHand projectId={p.id} onAdded={added} />}
      </div>
    </div>
  );
}

function AddByDoi({ projectId, onAdded }: { projectId: number; onAdded: (r: Ref & { existing?: boolean }) => void }) {
  const [doi, setDoi] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try { onAdded(await writingApi.addRef(projectId, { doi })); setDoi(""); } catch (e) { notifyError(e); } finally { setBusy(false); }
  };
  return (
    <form className="write-inline-form" onSubmit={e => { e.preventDefault(); if (doi.trim()) void add(); }}>
      <input value={doi} onChange={e => setDoi(e.target.value)} placeholder="10.1038/nature14539, or a doi.org link" aria-label="DOI" />
      <button className="btn-primary" disabled={busy || !doi.trim()}>{busy ? <Loader2 size={13} className="spin" /> : <Search size={13} />} Look up and add</button>
    </form>
  );
}

interface LibraryDoc { id: number; name: string; source?: { url?: string; author?: string } | null }

function AddFromLibrary({ projectId, refs, onAdded }: { projectId: number; refs: Ref[]; onAdded: (r: Ref & { existing?: boolean }) => void }) {
  const [docs, setDocs] = useState<LibraryDoc[] | null>(null);
  const [q, setQ] = useState("");
  useEffect(() => { fetchApi("/documents/").then(r => r.json()).then(setDocs).catch(() => setDocs([])); }, []);
  const have = new Set(refs.map(r => r.document_id));
  const shown = (docs ?? []).filter(d => d.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  return (
    <div className="write-library-pick">
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search your Library" aria-label="Search your Library" />
      {docs == null ? <p className="muted"><Loader2 size={13} className="spin" /> Reading your Library…</p>
        : shown.length === 0 ? <p className="muted">Nothing in your Library matches. Save papers and links there first.</p>
        : (
          <ul>
            {shown.map(d => (
              <li key={d.id}>
                <span><Library size={13} /> {d.name}{d.source?.author ? <span className="muted"> · {d.source.author}</span> : null}</span>
                <button type="button" className="btn-ghost" disabled={have.has(d.id)}
                  onClick={() => writingApi.addRef(projectId, { document_id: d.id }).then(onAdded).catch(notifyError)}>
                  {have.has(d.id) ? "Added" : <><BookPlus size={13} /> Add</>}
                </button>
              </li>
            ))}
          </ul>
        )}
      <p className="muted write-small">A saved link brings its title, author and address. Add the year and journal by hand if the style needs them.</p>
    </div>
  );
}

const TYPES: [string, string][] = [
  ["article-journal", "Journal article"], ["book", "Book"], ["chapter", "Book chapter"], ["paper-conference", "Conference paper"],
  ["report", "Report"], ["thesis", "Thesis"], ["webpage", "Web page"], ["article-newspaper", "Newspaper article"], ["dataset", "Dataset"],
];

function AddByHand({ projectId, onAdded }: { projectId: number; onAdded: (r: Ref & { existing?: boolean }) => void }) {
  const [f, setF] = useState({ type: "article-journal", authors: "", year: "", title: "", container: "", volume: "", issue: "", pages: "", publisher: "", url: "", doi: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const add = async () => {
    const authors = f.authors.split(/;|\n/).map(a => a.trim()).filter(Boolean).map(a => {
      const [family, given] = a.split(",").map(x => x.trim());
      return a.includes(",") ? { family, given } : { literal: a };
    });
    const item: CslItem = { type: f.type, title: f.title };
    if (authors.length) item.author = authors;
    if (/^\d{4}$/.test(f.year.trim())) item.issued = { "date-parts": [[Number(f.year.trim())]] };
    for (const [k, v] of [["container-title", f.container], ["volume", f.volume], ["issue", f.issue], ["page", f.pages], ["publisher", f.publisher], ["URL", f.url], ["DOI", f.doi]] as const) {
      if (v.trim()) item[k] = v.trim();
    }
    try { onAdded(await writingApi.addRef(projectId, { item })); setF({ ...f, authors: "", year: "", title: "", container: "", volume: "", issue: "", pages: "", url: "", doi: "" }); }
    catch (e) { notifyError(e); }
  };
  const journal = f.type === "article-journal" || f.type === "article-newspaper";
  return (
    <form className="write-manual" onSubmit={e => { e.preventDefault(); if (f.title.trim()) void add(); }}>
      <label className="write-field"><span>Type</span>
        <select value={f.type} onChange={set("type")}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      <label className="write-field wide"><span>Authors: Family, Given; Family, Given (an organisation as written)</span>
        <input value={f.authors} onChange={set("authors")} placeholder="Kim, Ji-Hoon; Smith, Jane" /></label>
      <label className="write-field"><span>Year</span><input value={f.year} onChange={set("year")} inputMode="numeric" placeholder="2020" /></label>
      <label className="write-field wide"><span>Title</span><input value={f.title} onChange={set("title")} required /></label>
      <label className="write-field wide"><span>{journal ? "Journal or newspaper" : f.type === "chapter" ? "Book title" : f.type === "paper-conference" ? "Conference" : "Website or series"}</span>
        <input value={f.container} onChange={set("container")} /></label>
      {journal && <>
        <label className="write-field"><span>Volume</span><input value={f.volume} onChange={set("volume")} /></label>
        <label className="write-field"><span>Issue</span><input value={f.issue} onChange={set("issue")} /></label>
      </>}
      <label className="write-field"><span>Pages</span><input value={f.pages} onChange={set("pages")} placeholder="436-444" /></label>
      {!journal && <label className="write-field"><span>Publisher</span><input value={f.publisher} onChange={set("publisher")} /></label>}
      <label className="write-field wide"><span>Web address</span><input value={f.url} onChange={set("url")} /></label>
      <label className="write-field"><span>DOI</span><input value={f.doi} onChange={set("doi")} /></label>
      <button className="btn-primary" disabled={!f.title.trim()}><BookPlus size={13} /> Add source</button>
    </form>
  );
}

/** Choose a source to cite, with an optional page; inserts its marker where the cursor is. */
export function CitePicker({ refs, onPick, onClose }: { refs: Ref[]; onPick: (marker: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState("");
  const shown = refs.filter(r => `${r.key} ${r.item.title ?? ""} ${JSON.stringify(r.item.author ?? "")}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="write-cite-picker" role="dialog" aria-label="Cite a source">
      <div className="write-cite-picker-head">
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Find a source" aria-label="Find a source"
          onKeyDown={e => { if (e.key === "Escape") onClose(); if (e.key === "Enter" && shown[0]) onPick(markerFor(shown[0].key, page)); }} />
        <input value={page} onChange={e => setPage(e.target.value)} placeholder="page" aria-label="Page (optional)" className="write-cite-page" />
        <button type="button" className="btn-ghost" onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      {refs.length === 0 ? <p className="muted">No sources yet. Add them in the stage "Paraphrase and cite".</p> : (
        <ul>
          {shown.map(r => (
            <li key={r.id}>
              <button type="button" onClick={() => onPick(markerFor(r.key, page))}>
                <Quote size={12} /> <strong>{r.key}</strong> <span className="muted">{String(r.item.title ?? "")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The whole document as it will read: citations formatted, the reference list at the end. */
export function DocumentPreview({ p, refs, onClose, headings = true }: { p: Project; refs: Ref[]; onClose: () => void; headings?: boolean }) {
  const sections = p.sections ?? [];
  const doc = useFormatted(refs, p.style, sections.map(s => s.body));
  const plain = doc ? [p.title, "", ...sections.flatMap((s, i) => [s.title, doc.texts[i] ?? "", ""]), "References", "", ...doc.bibliography].join("\n") : "";
  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="debrief-panel write-preview" role="dialog" aria-modal="true" aria-label="Preview">
        <header className="debrief-panel-head">
          <div><div className="debrief-kicker">Preview</div><div className="debrief-title">{p.title}</div></div>
          <div className="write-preview-actions">
            <CiteprocCredit />
            <ExportButtons p={p} refs={refs} headings={headings} />
            <button className="btn-ghost" disabled={!doc} onClick={() => void navigator.clipboard.writeText(plain).then(() => toast.success("Copied"))}><Copy size={13} /> Copy text</button>
            <button className="titlebar-btn" onClick={onClose} title="Close"><X size={16} /></button>
          </div>
        </header>
        <div className="debrief-panel-body write-preview-body">
          {!doc ? <p className="muted"><Loader2 size={14} className="spin" /> Formatting…</p> : (
            <article className="write-paper">
              <h1>{p.title}</h1>
              {doc.unknown.length > 0 && <p className="write-warn">Cited but not in your sources: {doc.unknown.map(k => `@${k}`).join(", ")}. Add them, or fix the key.</p>}
              {sections.map((s, i) => (
                <section key={s.id}>
                  {headings && <h2>{s.title}</h2>}
                  {(doc.texts[i] ?? "").split(/\n{2,}|\n/).filter(x => x.trim()).map((para, j) => <p key={j}>{para}</p>)}
                </section>
              ))}
              <section>
                <h2>References</h2>
                {doc.bibliography.length ? doc.bibliography.map((e, i) => <p key={i} className="write-ref-entry">{e}</p>)
                  : <p className="muted">No sources yet.</p>}
                {doc.uncited.length > 0 && refs.length > 0 && doc.unknown.length === 0 && doc.bibliography.length < refs.length && (
                  <p className="muted write-small">Not cited yet, so not listed: {doc.uncited.map(k => `@${k}`).join(", ")}.</p>
                )}
              </section>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
