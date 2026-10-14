import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useStableCallback } from "../../lib/useStableCallback";
import { RESTARTING } from "../../lib/restart";
import toast from "react-hot-toast";
import { Download, Copy, Printer, History, Trash2, Loader2, ArrowLeft, X, RotateCw, ShieldCheck, MessageSquareText, Network } from "lucide-react";
import ConfirmDialog from "../ConfirmDialog";
import { notifyError, toFriendly } from "../../lib/errors";
import { track } from "../../lib/usage";
import { clock, notebookApi, type Notebook, type NotebookDoc, type NotebookStyle } from "../../lib/notebook";
import NotebookPage from "./NotebookPage";
import NotebookBook from "./NotebookBook";
import IdeasMap from "./IdeasMap";
import { readingApi, type ReadingProgress } from "../../lib/reading";

// pdf.js is large: loaded only when someone opens a cited page.
const PdfSource = lazy(() => import("./PdfSource"));
// Releasing the open book is only needed if the panel was ever loaded.
const releasePdf = () => { import("./PdfSource").then(m => m.releasePdf()).catch(() => {}); };

/** Whether two plain JSON values hold the same data. */
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

type SaveState = "saved" | "dirty" | "saving" | "conflict";
const AUTOSAVE_MS = 1200;

function isConflict(e: unknown): boolean {
  return toFriendly(e).code === "conflict";
}

/**
 * One notebook: read it (slides or the whole page), edit it, restyle it,
 * export it, go back to an earlier version, or delete it. Saves itself a moment
 * after you stop typing; a save that loses a race is never silently overwritten.
 */
export default function NotebookEditor({ initial, onBack, onDeleted, onChanged, onRemake }: {
  initial: Notebook;
  onBack?: () => void;
  onDeleted?: () => void;
  onChanged?: (nb: Notebook) => void;
  /** Reading decks: choose the pages or template again and remake it. */
  onRemake?: () => void;
}) {
  const [nb, setNb] = useState(initial);
  const [progress, setProgress] = useState<ReadingProgress | null>(null);
  const [showIdeas, setShowIdeas] = useState(false);
  // The header floats at the top corners only when the book leaves room beside it (a spread is about 10 wide
  // for 7 high); otherwise it would sit on the book's corners, and stays an ordinary row above it.
  const [floatHeader, setFloatHeader] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const height = window.innerHeight - r.top;
      const bookWidth = Math.min(r.width, height * (1000 / 700));
      setFloatHeader((r.width - bookWidth) / 2 >= 200);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  useEffect(() => {
    if (initial.kind !== "reading") return;
    readingApi.progress(initial.id).then(setProgress).catch(() => {});
  }, [initial.id, initial.kind]);
  const [doc, setDoc] = useState<NotebookDoc>(initial.doc);
  const [style, setStyle] = useState<NotebookStyle>(initial.style);
  const [state, setState] = useState<SaveState>("saved");
  // Bumped when the whole document is replaced (restore, load theirs), so the book is drawn again from it.
  const [bookGen, setBookGen] = useState(0);
  const [panel, setPanel] = useState<null | "versions" | "export">(null);
  const [versions, setVersions] = useState<{ version: number; title: string; saved_at: string }[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [pdfPages, setPdfPages] = useState<number[] | null>(null);
  // A key term being shown in the source: its words are marked on the page.
  const [pdfFind, setPdfFind] = useState<string | null>(null);
  const [source, setSource] = useState<null | { n: number; who: string; text: string; t: number; cited: boolean }[]>(null);

  // What the next save sends, and whether one is running — refs, so the timer
  // and the unmount flush always see the latest edit.
  const latest = useRef({ doc, style, version: nb.version });
  latest.current = { doc, style, version: nb.version };
  const saving = useRef(false);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>();
  // A save that lost a race stops saving until the user chooses (Keep mine / Load theirs):
  // never retried in a loop, never hidden behind "Saving…".
  const conflicted = useRef(false);
  const failures = useRef(0);
  // Closed while a save was on its way: whatever was typed meanwhile goes the moment
  // that save returns, not an autosave pause later (the app may be quitting).
  const closed = useRef(false);
  // The save on its way, so anything that needs the latest version can wait for it.
  const inflight = useRef<Promise<void> | null>(null);

  const schedule = (ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = undefined; save(); }, ms);
  };

  const save = useCallback(async (force = false) => {
    if (saving.current || !dirty.current || (conflicted.current && !force)) return;
    saving.current = true;
    let done: () => void = () => {};
    inflight.current = new Promise<void>(resolve => { done = resolve; });
    dirty.current = false;
    setState("saving");
    const { doc: d, style: s, version } = latest.current;
    try {
      const saved = await notebookApi.save(nb.id, version, { title: d.title.trim() || nb.title, style: s, doc: d });
      latest.current.version = saved.version;
      // Keep what is on screen (the server copy may drop empty blocks), and keep the
      // objects a save didn't change, so the pages drawn from them aren't redrawn.
      setNb(prev => ({
        ...saved, doc: prev.doc,
        line_times: saved.line_times === undefined || same(prev.line_times, saved.line_times) ? prev.line_times : saved.line_times,
        coverage: same(prev.coverage, saved.coverage) ? prev.coverage : saved.coverage,
        scope: same(prev.scope, saved.scope) ? prev.scope : saved.scope,
      }));
      onChanged?.(saved);
      failures.current = 0;
      saving.current = false;
      done();
      if (dirty.current && closed.current) void save();                  // edits made while it was saving, editor gone
      else if (dirty.current) { setState("dirty"); schedule(AUTOSAVE_MS); } // edits made while it was saving
      else setState("saved");
    } catch (e) {
      saving.current = false;
      done();
      dirty.current = true;
      if (isConflict(e)) {
        conflicted.current = true;
        setState("conflict");
      } else {
        // The engine is busy or down: try again, a little later each time, and say so once.
        failures.current += 1;
        if (failures.current === 1) notifyError(e);
        setState("dirty");
        schedule(Math.min(30000, AUTOSAVE_MS * 2 ** failures.current));
      }
    }
  }, [nb.id, nb.title, onChanged]);  // eslint-disable-line react-hooks/exhaustive-deps

  function change(nextDoc: NotebookDoc, nextStyle = latest.current.style) {
    // The next edit (even one made before React redraws) builds on this one.
    latest.current = { ...latest.current, doc: nextDoc, style: nextStyle };
    setDoc(nextDoc);
    setStyle(nextStyle);
    dirty.current = true;
    if (!conflicted.current) {
      setState("dirty");
      schedule(AUTOSAVE_MS);
    }
  }

  // Leaving with unsaved edits: send them now (not after a conflict — that's the user's call).
  useEffect(() => () => {
    closed.current = true;
    if (nb.kind === "reading") releasePdf();
    window.clearTimeout(timer.current);
    if (dirty.current && !saving.current && !conflicted.current) {
      const { doc: d, style: s, version } = latest.current;
      notebookApi.save(nb.id, version, { title: d.title.trim() || nb.title, style: s, doc: d }).catch(() => {});
    }
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // The app is about to restart (sidebar): send unsaved edits now, not after a pause.
  useEffect(() => {
    const flush = () => { window.clearTimeout(timer.current); if (dirty.current && !conflicted.current) void save(); };
    window.addEventListener(RESTARTING, flush);
    return () => window.removeEventListener(RESTARTING, flush);
  }, [save]);

  // Escape closes whichever popover or dialog is open.
  useEffect(() => {
    if (!panel && !source) return;
    // Capture phase, and stopped there: Escape closes the popover, not the session window behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPanel(null); setSource(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [panel, source]);

  async function reloadLatest() {
    try {
      const fresh = await notebookApi.get(nb.id);
      setNb(fresh); setDoc(fresh.doc); setStyle(fresh.style); setBookGen(g => g + 1);
      dirty.current = false; conflicted.current = false; setState("saved");
      latest.current = { doc: fresh.doc, style: fresh.style, version: fresh.version };
    } catch (e) { notifyError(e); }
  }

  async function keepMine() {
    try {
      const fresh = await notebookApi.get(nb.id);
      latest.current.version = fresh.version;
      setNb(prev => ({ ...fresh, doc: prev.doc }));
      dirty.current = true; conflicted.current = false; setState("dirty");
      await save(true);
    } catch (e) { notifyError(e); }
  }

  /** Wait for a save already on its way, then send any edits still unsaved: after this the version is current. */
  async function settle() {
    if (saving.current && inflight.current) await inflight.current;
    window.clearTimeout(timer.current);
    if (dirty.current) await save();
  }

  async function openVersions() {
    setPanel(p => (p === "versions" ? null : "versions"));
    try { setVersions(await notebookApi.versions(nb.id)); } catch (e) { notifyError(e); }
  }

  async function restore(version: number) {
    await settle();          // review 11-6: never restore against a version a running save is about to replace
    try {
      const restored = await notebookApi.restore(nb.id, version, latest.current.version);
      setNb(restored); setDoc(restored.doc); setStyle(restored.style); setBookGen(g => g + 1);
      latest.current = { doc: restored.doc, style: restored.style, version: restored.version };
      setPanel(null);
      toast.success(`Version ${version} restored — the one before it is kept too`);
      track("notebook.restore");
    } catch (e) { notifyError(e); }
  }

  async function exportMarkdown(how: "copy" | "file") {
    await settle();
    try {
      const md = await notebookApi.markdown(nb.id);
      if (how === "copy") {
        await navigator.clipboard.writeText(md);
        toast.success("Copied as Markdown — paste it into any notes app");
      } else {
        const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
        const a = document.createElement("a");
        a.href = url; a.download = `${(nb.title || "notebook").replace(/[^\w\- ]+/g, "").trim() || "notebook"}.md`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      track(`notebook.export.${how}`);
    } catch (e) { notifyError(e); }
    setPanel(null);
  }

  function print() {
    setPanel(null);
    track("notebook.print");
    setTimeout(() => window.print(), 80);
  }

  async function remove() {
    setConfirmDelete(false);
    window.clearTimeout(timer.current);
    dirty.current = false;
    try {
      await notebookApi.remove(nb.id);
      toast.success("Notebook deleted");
      track("notebook.delete");
      onDeleted?.();
    } catch (e) { notifyError(e); }
  }

  async function showSource(src: number[], find?: string) {
    if (nb.kind === "reading") {
      if (nb.document_id) { setPdfFind(find ?? null); setPdfPages(src); }
      else toast("The document these notes came from isn't in your Library any more.");
      return;
    }
    try { setSource(await notebookApi.source(nb.id, src)); } catch (e) { notifyError(e); }
  }

  // Stable for the notebook's lifetime, so memoized notes and sections skip re-rendering.
  const edit = useStableCallback((fn: (d: NotebookDoc) => NotebookDoc) => change(fn(latest.current.doc)));
  const replaceDoc = useStableCallback((d: NotebookDoc) => change(d));
  const onSource = useStableCallback(showSource);

  const status = { saved: "Saved", dirty: "Unsaved changes", saving: "Saving…", conflict: "Changed elsewhere" }[state];

  return (
    <div className="nb-editor" ref={rootRef} data-float-header={floatHeader ? "true" : undefined}
      onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } }}>
      <div className="nb-toolbar" role="toolbar" aria-label="Notebook">
        <div className="nb-toolbar-start">
        {onBack && <button type="button" className="btn-neutral" onClick={onBack}><ArrowLeft size={14} /> All notebooks</button>}
        {nb.kind === "reading" && nb.coverage?.required ? (
          <span className="nb-coverage-chip" title="Key points from the pages you chose that these notes cover">
            <ShieldCheck size={13} /> {nb.coverage.covered}/{nb.coverage.required} key points
          </span>
        ) : null}
        {nb.kind === "reading" && progress && progress.chapters > 0 ? (
          <span className="nb-coverage-chip" title="Chapters you have explained back from memory (Explain it back, in the bar)">
            <MessageSquareText size={13} /> Explained {progress.explained}/{progress.chapters}
          </span>
        ) : null}
        {nb.coverage?.ideas?.length ? (
          <button type="button" className="btn-neutral" onClick={() => setShowIdeas(true)} title="The terms as one picture: what builds on what">
            <Network size={14} /> Map of ideas
          </button>
        ) : null}
        {onRemake && (
          <button type="button" className="btn-neutral" onClick={onRemake}
            title="Choose other pages, chapters or another template. This deck is kept as an earlier version.">
            <RotateCw size={14} /> Make again
          </button>
        )}
        </div>
        <span className="nb-toolbar-spacer" />
        <div className="nb-toolbar-end">
        <span className={`nb-save-state ${state}`} role="status">
          {state === "saving" && <Loader2 size={12} className="spin" />} {status}
        </span>
        <button type="button" className="btn-neutral" aria-expanded={panel === "export"} onClick={() => setPanel(p => (p === "export" ? null : "export"))}>
          <Download size={14} /> Export
        </button>
        <button type="button" className="btn-neutral" aria-expanded={panel === "versions"} onClick={openVersions} aria-label="Earlier versions">
          <History size={14} />
        </button>
        <button type="button" className="btn-neutral danger" onClick={() => setConfirmDelete(true)} aria-label="Delete notebook">
          <Trash2 size={14} />
        </button>
        </div>
      </div>

      {state === "conflict" && (
        <div className="nb-banner" role="alert">
          <span>This notebook was saved somewhere else while you were editing.</span>
          <button type="button" className="btn-neutral" onClick={reloadLatest}>Load theirs</button>
          <button type="button" className="btn-primary" onClick={keepMine}>Keep mine</button>
        </div>
      )}

      {panel === "export" && (
        <div className="glass-card nb-popover nb-popover-small">
          <button type="button" className="nb-menu-item" onClick={() => exportMarkdown("copy")}><Copy size={14} /> Copy as Markdown</button>
          <button type="button" className="nb-menu-item" onClick={() => exportMarkdown("file")}><Download size={14} /> Save as a .md file</button>
          <button type="button" className="nb-menu-item" onClick={print}><Printer size={14} /> Print or save as PDF</button>
        </div>
      )}
      {panel === "versions" && (
        <div className="glass-card nb-popover nb-popover-small">
          <div className="nb-popover-head"><strong>Earlier versions</strong></div>
          {versions == null ? <Loader2 size={14} className="spin" /> : versions.length === 0 ? (
            <p className="muted">No earlier versions yet. Each save keeps the one before it (the last ten).</p>
          ) : versions.map(v => (
            <button key={v.version} type="button" className="nb-menu-item" onClick={() => restore(v.version)}>
              <History size={13} /> Version {v.version} · {v.title} <span className="muted">{new Date(v.saved_at + "Z").toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}

      <NotebookBook key={bookGen} nb={nb} doc={doc} style={style} onDoc={replaceDoc}
        onStyle={s => change(latest.current.doc, s)} onSource={onSource} onProgress={setProgress} />
      {showIdeas && nb.coverage?.ideas?.length ? (
        <IdeasMap ideas={nb.coverage.ideas} title={nb.title} onClose={() => setShowIdeas(false)} />
      ) : null}

      {/* Printing and "save as PDF" use the whole notebook as a page; the book is drawn on a canvas. */}
      <div className="nb-print-root nb-print-only" aria-hidden="true">
        <NotebookPage nb={nb} doc={doc} style={style} editing={false} fallbackTitle={nb.title} onEdit={edit} onSource={onSource} />
      </div>

      {pdfPages && nb.document_id && (
        <Suspense fallback={null}>
          <PdfSource documentId={nb.document_id} pages={pdfPages} find={pdfFind} onClose={() => { setPdfPages(null); setPdfFind(null); }} />
        </Suspense>
      )}

      {source && (
        <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setSource(null); }}>
          <div className="glass-card nb-source" role="dialog" aria-modal="true" aria-label="Where this was said" tabIndex={-1}
            ref={el => el?.focus()}>
            <div className="nb-popover-head"><strong>Where this was said</strong>
              <button type="button" className="nb-icon-btn" onClick={() => setSource(null)} aria-label="Close"><X size={14} /></button></div>
            {source.length === 0 ? <p className="muted">The transcript for this part isn't available any more.</p> : source.map(l => (
              <div key={l.n} className={`nb-source-line ${l.cited ? "cited" : ""}`}>
                <span className="nb-src">{clock(l.t)}</span>
                <span className="nb-source-who">{l.who === "Them" ? (nb.kind === "lecture" ? "Lecturer" : "Others") : l.who}</span>
                <span>{l.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog message="Delete this notebook?" detail={nb.session_id ? "Its earlier versions go too. The session and its transcript stay." : nb.document_id ? "Its earlier versions go too. The document stays in your Library." : "Its earlier versions go too."}
          onConfirm={remove} onCancel={() => setConfirmDelete(false)} />
      )}
    </div>
  );
}
