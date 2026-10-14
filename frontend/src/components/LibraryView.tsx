import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, FileText, Eye, Download, Trash2, Star, ArrowLeftRight, Library, X, NotebookPen, Wand2 } from "lucide-react";
import toast from "react-hot-toast";
import ConfirmDialog from "./ConfirmDialog";
import LinkImport from "./LinkImport";
import TidyTranscript from "./TidyTranscript";
import { canTidy } from "../lib/sourceTidy";
import type { SourceMetadata } from "../lib/links";
import { serverDate } from "../lib/dates";
import { fetchApi, apiMediaUrl } from "../lib/api";
import { errorFromResponse, notifyError } from "../lib/errors";
import { track } from "../lib/usage";
import Page, { PageTab } from "./Page";
import Illustration from "./Illustration";
import { MAX_UPLOAD_MB, openReading, readingApi } from "../lib/reading";

// Loaded on demand: pdf.js is large and only needed when previewing.
const FilePreview = lazy(() => import("./FilePreview"));

type Kind = "cv" | "doc";
interface Row {
  id: number;
  name: string;
  original_filename: string;
  mime: string;
  is_active?: number;
  created_at: string;
  extracted_text_preview?: string;
  source?: SourceMetadata | null;
}
interface Item extends Row { kind: Kind; }

// Upload limits enforced by the backend (routers/cvs.py 5 MB, routers/documents.py 10 MB).
const MAX_BYTES: Record<Kind, number> = { cv: 5 * 1024 * 1024, doc: 10 * 1024 * 1024 };
const BASE: Record<Kind, string> = { cv: "/cvs", doc: "/documents" };

type Filter = "all" | Kind;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All files" },
  { id: "cv",  label: "My CV" },
  { id: "doc", label: "Reference files" },
];

function formatDate(iso: string): string {
  const d = serverDate(iso);
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

const isPdf = (item: { mime: string; original_filename: string }) =>
  item.mime === "application/pdf" || /\.pdf$/i.test(item.original_filename);

const looksLikeCv = (name: string) => /\b(cv|resume|résumé|curriculum)\b/i.test(name.replace(/[_\-.]/g, " "));

/**
 * All your files in one place (roadmap 1.7): CVs and reference material —
 * job specs, lecture slides, notes, briefs. Mark which one is your CV; the
 * coach uses the active CV everywhere and reference files when you attach
 * them to a session.
 */
export default function LibraryView({ section }: { section?: string }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [filter, setFilter] = useState<Filter>(section === "cvs" ? "cv" : section === "docs" ? "doc" : "all");
  const [importingLink, setImportingLink] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewing, setPreviewing] = useState<Item | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Item | null>(null);
  const [confirmMove, setConfirmMove] = useState<Item | null>(null);
  const [tidying, setTidying] = useState<Item | null>(null);
  const closeTidy = useCallback(() => setTidying(null), []);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const [cvs, docs] = await Promise.all([
        fetchApi("/cvs/").then(r => r.json()) as Promise<Row[]>,
        fetchApi("/documents/").then(r => r.json()) as Promise<Row[]>,
      ]);
      setItems([...cvs.map(r => ({ ...r, kind: "cv" as const })), ...docs.map(r => ({ ...r, kind: "doc" as const }))]);
    } catch {
      setItems([]);
      toast.error("Couldn't load your files");
    }
  }
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    const list = (items ?? []).filter(i => filter === "all" || i.kind === filter);
    // Active CV first, then CVs, then everything newest first.
    return list.sort((a, b) =>
      (b.is_active ?? 0) - (a.is_active ?? 0) || (a.kind === b.kind ? 0 : a.kind === "cv" ? -1 : 1)
      || b.created_at.localeCompare(a.created_at));
  }, [items, filter]);
  const hasCv = (items ?? []).some(i => i.kind === "cv");

  function choose(file: File) {
    if (fileRef.current) fileRef.current.value = "";
    if (!/\.(pdf|txt|md)$/i.test(file.name)) {
      notifyError({ title: "Unsupported file type", message: "Upload a PDF, .txt or .md file." });
      return;
    }
    setPending(file);
  }

  async function upload(file: File, kind: Kind) {
    setPending(null);
    if (file.size > MAX_BYTES[kind]) {
      notifyError({ title: "File too large", message: `${kind === "cv" ? "CVs" : "Reference files"} can be up to ${MAX_BYTES[kind] / 1024 / 1024} MB. Try exporting a smaller PDF.` });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("name", file.name.replace(/\.[^.]+$/, ""));
      track(`library.upload.${kind}`);
      const res = await fetchApi(`${BASE[kind]}/`, { method: "POST", body: fd });
      if (!res.ok) throw await errorFromResponse(res);
      const made: Row = await res.json();
      // The first CV becomes the one the coach uses.
      if (kind === "cv" && !hasCv) await fetchApi(`/cvs/${made.id}/activate`, { method: "POST" });
      toast.success(kind === "cv" ? "CV added" : "File added");
      window.dispatchEvent(new Event("onboarding-refresh"));
      await load();
    } catch (e) {
      notifyError(e);
    } finally {
      setUploading(false);
    }
  }

  /** A paper or book: stored with its pages kept apart, then straight to "What should I cover?". */
  async function uploadForNotes(file: File) {
    setPending(null);
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      notifyError({ title: "File too large", message: `Papers and books can be up to ${MAX_UPLOAD_MB} MB. Split the book, or upload the chapters you need.` });
      return;
    }
    setUploading(true);
    try {
      track("library.upload.reading");
      const st = await readingApi.upload(file);
      toast.success("Added — iReliabee is reading it now");
      openReading(st.document_id);
    } catch (e) {
      notifyError(e);
    } finally {
      setUploading(false);
    }
  }

  async function act(path: string, done: string) {
    const res = await fetchApi(path, { method: "POST" });
    if (res.ok) { toast.success(done); await load(); } else notifyError(await errorFromResponse(res));
  }

  async function remove(item: Item) {
    setConfirmDelete(null);
    const res = await fetchApi(`${BASE[item.kind]}/${item.id}`, { method: "DELETE" });
    if (res.ok) { toast.success("Deleted"); await load(); } else toast.error("Couldn't delete that file");
  }

  return (
    <Page
      title="Library"
      subtitle="Your CV and reference files — job specs, lecture slides, notes, briefs. The coach always uses your active CV, and reference files you attach to a session."
      actions={
        <><button className="btn-neutral" onClick={() => setImportingLink(true)}>Add a link</button><label className="btn-primary library-upload" style={{ cursor: uploading ? "wait" : "pointer" }}>
          <Upload size={14} /> {uploading ? "Uploading…" : "Upload"}
          <input ref={fileRef} type="file" accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" style={{ display: "none" }}
            onChange={e => { const f = e.target.files?.[0]; if (f) choose(f); }} />
        </label></>
      }
      tabs={FILTERS.map(f => (
        <PageTab key={f.id} active={filter === f.id} onClick={() => setFilter(f.id)}
          count={(items ?? []).filter(i => f.id === "all" || i.kind === f.id).length}>
          {f.label}
        </PageTab>
      ))}
    >
    <div className="page-content">
      {importingLink && <LinkImport target="library" onClose={() => setImportingLink(false)} onSaved={() => { setImportingLink(false); toast.success("Source added to Library"); void load(); }} />}
      {items == null ? null : visible.length === 0 ? (
        <div className="glass-card plans-empty">
          <Illustration name="library" />
          <div className="plans-empty-title">{filter === "doc" ? "No reference files yet" : filter === "cv" ? "No CV yet" : "Your library is empty"}</div>
          <p className="muted">Upload a PDF, .txt or .md file. Start with your CV — the coach uses your real projects and results from it.</p>
        </div>
      ) : (
        <div className="card-grid">
          {visible.map(item => (
            <div key={`${item.kind}-${item.id}`} className={`glass-card library-item ${item.kind}`}>
              <div className="library-item-head">
                <FileText size={18} className="library-icon" />
                <div className="library-main">
                  <div className="library-title">
                    <span title={item.name}>{item.name}</span>
                    {item.kind === "cv" && <span className={`library-badge ${item.is_active ? "active" : ""}`}>{item.is_active ? "Active CV" : "CV"}</span>}
                  </div>
                  <div className="muted library-meta">{item.original_filename} · added {formatDate(item.created_at)}</div>
                </div>
              </div>
              {item.source && <p className="muted library-source">{item.source.url}{item.source.author ? ` · ${item.source.author}` : ""} · {formatDate(item.source.captured_at)}{item.source.partial ? " · start only" : ""}</p>}
              {item.extracted_text_preview && <div className="muted library-preview">{item.extracted_text_preview}</div>}
              <div className="library-actions">
                {item.kind === "cv" && !item.is_active && (
                  <button className="btn-primary" onClick={() => act(`/cvs/${item.id}/activate`, "The coach now uses this CV")} title="Use this CV for the coach">
                    <Star size={12} /> Use this CV
                  </button>
                )}
                {item.kind === "doc" && (isPdf(item) || item.source) && (
                  <button className="btn-neutral" onClick={() => openReading(item.id)}
                    title="Turn this paper or book into notebook slides that cover every key point">
                    <NotebookPen size={12} /> Make notes
                  </button>
                )}
                {item.kind === "doc" && canTidy(item.source) && (
                  <button className="btn-neutral" onClick={() => setTidying(item)}
                    title="Punctuation, paragraphs and who is speaking, saved as a new copy. Uses credits; the cost is shown first.">
                    <Wand2 size={12} /> Tidy transcript
                  </button>
                )}
                <button className="btn-neutral" onClick={() => setPreviewing(item)} title="Preview"><Eye size={12} /></button>
                <a className="btn-neutral" href={apiMediaUrl(`${BASE[item.kind]}/${item.id}/download`)} download title="Download"><Download size={12} /></a>
                <button className="btn-neutral"
                  title={item.kind === "cv"
                    ? "Not your CV? Move it to reference files (job specs, notes, slides). The coach only uses reference files you attach to a session."
                    : "Is this actually your CV? Move it to your CVs so the coach can use your experience from it."}
                  onClick={() => item.kind === "cv"
                    ? (item.is_active ? setConfirmMove(item) : act(`/cvs/${item.id}/make-document`, "Moved to reference files"))
                    : act(`/documents/${item.id}/make-cv`, "Moved to your CVs — choose Use this CV to switch to it")}>
                  <ArrowLeftRight size={12} /> {item.kind === "cv" ? "Not a CV" : "This is a CV"}
                </button>
                <button className="btn-neutral danger library-danger" onClick={() => setConfirmDelete(item)} title="Delete"><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {pending && (
        <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setPending(null); }}>
          <div className="debrief-panel library-kind-panel">
            <header className="debrief-panel-head">
              <div style={{ minWidth: 0 }}>
                <div className="debrief-kicker">Upload</div>
                <div className="debrief-title">{pending.name}</div>
              </div>
              <button className="titlebar-btn" onClick={() => setPending(null)} title="Cancel"><X size={16} /></button>
            </header>
            <div className="debrief-panel-body library-kind">
              <p className="muted">What is this file?</p>
              {pending.size > MAX_BYTES.doc && (
                <p className="muted">It's {Math.round(pending.size / 1024 / 1024)} MB — too big for a CV or reference file, but fine as a paper or book to make notes from.</p>
              )}
              <button className={`persona-choice ${looksLikeCv(pending.name) ? "suggested" : ""}`} onClick={() => upload(pending, "cv")}
                disabled={pending.size > MAX_BYTES.cv}>
                <strong>My CV</strong><small>The coach uses your real experience from it{!hasCv ? " — it becomes your active CV" : ""}.</small>
              </button>
              <button className={`persona-choice ${looksLikeCv(pending.name) || pending.size > MAX_BYTES.doc ? "" : "suggested"}`} onClick={() => upload(pending, "doc")}
                disabled={pending.size > MAX_BYTES.doc}>
                <strong>Reference file</strong><small>A job spec, lecture slides, notes or a brief to attach to sessions.</small>
              </button>
              {/\.pdf$/i.test(pending.name) && (
                <button className={`persona-choice ${pending.size > MAX_BYTES.doc ? "suggested" : ""}`} onClick={() => uploadForNotes(pending)}>
                  <strong>A paper or book to make notes from</strong>
                  <small>Up to {MAX_UPLOAD_MB} MB. iReliabee reads it page by page, then you choose the chapters and turn them into notebook slides.</small>
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {tidying && (
        <TidyTranscript docId={tidying.id} name={tidying.name} onClose={closeTidy}
          onDone={r => {
            setTidying(null);
            toast.success(r.speakers.length ? `Tidied copy saved: ${r.speakers.join(", ")}` : "Tidied copy saved to your Library");
            if (r.kept_original) toast(`${r.kept_original} of ${r.parts} parts didn't come back cleanly and are as they were.`);
            void load();
          }} />
      )}

      {previewing && (
        <Suspense fallback={null}>
          <FilePreview
            file={{ path: `${BASE[previewing.kind]}/${previewing.id}/file`, name: previewing.name, mime: previewing.mime, kind: previewing.kind === "cv" ? "CV" : "Document" }}
            onClose={() => setPreviewing(null)}
          />
        </Suspense>
      )}

      {confirmMove && (
        <ConfirmDialog
          message={`Move "${confirmMove.name}" to reference files?`}
          detail="This is the CV the coach uses. After moving it, the coach has no CV until you choose another one with Use this CV."
          confirmLabel="Move it"
          onConfirm={() => { const it = confirmMove; setConfirmMove(null); act(`/cvs/${it.id}/make-document`, "Moved to reference files"); }}
          onCancel={() => setConfirmMove(null)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          message={`Delete "${confirmDelete.name}"?`}
          detail="This file will be permanently removed."
          confirmLabel="Delete"
          onConfirm={() => remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
    </Page>
  );
}
