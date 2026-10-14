import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, BookOpen, Check, FileText, Layers, Loader2, NotebookPen, RotateCw, Sparkles, Upload, X,
} from "lucide-react";
import toast from "react-hot-toast";
import { fetchApi } from "../../lib/api";
import { AppError, ensureReady, notifyError, toFriendly } from "../../lib/errors";
import { track } from "../../lib/usage";
import { useAccount } from "../../lib/account";
import { DEFAULT_STYLE, notebookApi, type Notebook, type NotebookStyle, type NotebookSummary } from "../../lib/notebook";
import {
  KIND_LABEL, MAX_UPLOAD_MB, SKIPPED_BY_DEFAULT, defaultChapters, formatBytes, formatDuration, pagesLabel, parsePages, estimateCost, percent, readingApi, linkKind, linkSite, type Estimate, type Job, type ReadStatus, type Scope, type Template, READER_LEVELS, rememberLevel, rememberedLevel, type ReaderLevel,
} from "../../lib/reading";
import StylePicker from "./StylePicker";
import JobProgress from "./JobProgress";
import { OWN_ASSISTANT_COST, useOwnAssistant } from "../../lib/relay";

const STYLE_KEY = "nb.style.reading";
const FALLBACK_TEMPLATES: Template[] = [
  { id: "research", label: "Research paper", for: "Journal and conference papers", slides: "Question → key idea → method → results → limitations → contributions" },
  { id: "textbook", label: "Textbook chapter", for: "Lecture books and textbooks", slides: "Chapter map → concepts → definitions → worked examples → formulas → summary → practice questions" },
  { id: "brief", label: "Quick brief", for: "Busy readers", slides: "Three to five points per section, then a TL;DR" },
  { id: "deep", label: "Deep read", for: "Hard texts you want to understand to the core", slides: "", shows: "A map of the text → its terms in learning order → each chapter as a one-line gist, key points, claims with their evidence and what's uncertain, and questions to check it stuck" },
];

function rememberedStyle(): NotebookStyle {
  try {
    const s = JSON.parse(localStorage.getItem(STYLE_KEY) || "null");
    if (s && s.family && s.size && s.style) return s;
  } catch { /* private mode or bad JSON */ }
  return DEFAULT_STYLE.reading;
}

type Mode = Scope["mode"];

/**
 * Reading notes (spec 185 §4.1–4.2): pick a paper or book, let iReliabee read
 * it, choose what to cover and how the notes should look — before the AI
 * writes a word — see what it will take, then make the deck.
 */
export default function ReadingSetup({ documentId, rewrite, onBack, onMade, onOpen }: {
  documentId?: number;
  /** Remake this deck (kept as an earlier version). */
  rewrite?: Notebook;
  onBack: () => void;
  onMade: (nb: Notebook) => void;
  onOpen: (id: number) => void;
}) {
  const account = useAccount();
  const [docId, setDocId] = useState<number | undefined>(documentId ?? rewrite?.document_id ?? undefined);
  const [st, setSt] = useState<ReadStatus | null>(null);
  const [templates, setTemplates] = useState<Template[]>(FALLBACK_TEMPLATES);
  const [mode, setMode] = useState<Mode>("all");
  const [chapters, setChapters] = useState<number[]>([]);
  const [pages, setPages] = useState("");
  const [template, setTemplate] = useState(rewrite?.template || "research");
  const [style, setStyle] = useState<NotebookStyle>(() => rewrite?.style ?? rememberedStyle());
  const [tutor, setTutor] = useState(false);
  const [level, setLevel] = useState<ReaderLevel>(rememberedLevel);
  const [est, setEst] = useState<Estimate | null>(null);
  const [estError, setEstError] = useState<string | null>(null);
  // With the user's own assistant switched on, it does the work and no credits are spent.
  const ownAssistant = useOwnAssistant();
  const cost = !est ? { text: "", short: false }
    : ownAssistant ? { text: OWN_ASSISTANT_COST, short: false }
    : estimateCost(est, { admin: account.admin, available: account.balance?.available, credits: account.balance?.credits });
  const [job, setJob] = useState<Job | null>(null);
  const [decks, setDecks] = useState<NotebookSummary[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [library, setLibrary] = useState<{ id: number; name: string; original_filename: string }[] | null>(null);
  const [pollKey, setPollKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [gone, setGone] = useState(false);
  const alive = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    readingApi.templates().then(r => { if (alive.current) setTemplates(r.templates); }).catch(() => {});
  }, []);

  // No document yet: offer the Library's PDFs next to an upload.
  useEffect(() => {
    if (docId) return;
    fetchApi("/documents/").then(r => r.json()).then((rows: { id: number; name: string; original_filename: string; mime: string; source?: unknown }[]) => {
      if (alive.current) setLibrary(rows.filter(d => d.mime === "application/pdf" || /\.pdf$/i.test(d.original_filename) || !!d.source));
    }).catch(() => setLibrary([]));
  }, [docId]);

  // Load the document's reading status; start reading it if it never was; follow progress.
  useEffect(() => {
    if (!docId) return;
    let timer: number | undefined;
    let stop = false;
    const poll = async (first: boolean) => {
      try {
        let s = await readingApi.status(docId);
        if (first && s.state === "new") s = await readingApi.read(docId);
        if (stop || !alive.current) return;
        setSt(s);
        if (s.state === "reading") timer = window.setTimeout(() => poll(false), 700);
        if (first || s.state === "ready") readingApi.decks(docId).then(d => alive.current && setDecks(d)).catch(() => {});
      } catch (e) {
        if (stop) return;
        if (toFriendly(e).message === "Document not found") setGone(true);   // deleted from the Library
        else { notifyError(e); setSt(null); }
      }
    };
    poll(true);
    return () => { stop = true; window.clearTimeout(timer); };
  }, [docId, pollKey]);

  // When the document is ready, start from its suggestion (a paper: all of it; a book: one chapter).
  useEffect(() => {
    if (st?.state !== "ready") return;
    // Remaking a deck starts from what it covered; a new one from the document's suggestion.
    const was = rewrite?.scope;
    setMode(((was?.mode ?? st.suggested?.mode) as Mode) || "all");
    setChapters(was?.mode === "chapters" && was.chapters?.length ? was.chapters : defaultChapters(st));
    if (was?.mode === "pages" && was.pages) setPages(was.pages);
    // The template that fits what it is: a paper, a textbook, or anything else.
    if (!rewrite) setTemplate(st.kind === "book" ? "textbook" : st.kind === "paper" ? "research" : "brief");
  }, [st?.state, st?.document_id]);  // eslint-disable-line react-hooks/exhaustive-deps

  const scope: Scope | null = useMemo(() => {
    if (mode === "all") return { mode };
    if (mode === "chapters") return chapters.length ? { mode, chapters } : null;
    return pages.trim() ? { mode, pages } : null;
  }, [mode, chapters, pages]);

  const pageCheck = useMemo(() => (mode === "pages" && st && pages.trim() ? parsePages(pages, st.pages) : null), [mode, pages, st]);

  // The estimate follows every change, a moment after the user stops.
  useEffect(() => {
    if (st?.state !== "ready" || !docId) return;
    setEst(null);
    if (!scope || (pageCheck && "error" in pageCheck)) { setEstError(pageCheck && "error" in pageCheck ? pageCheck.error : null); return; }
    setEstError(null);
    let stale = false;
    const t = window.setTimeout(async () => {
      try {
        const cfg = await fetchApi("/config").then(r => r.json()).catch(() => ({}));
        const e = await readingApi.estimate({ document_id: docId, scope, template, model: cfg?.saved?.model || undefined, level });
        if (!stale && alive.current) setEst(e);
      } catch (e) {
        if (!stale && alive.current) setEstError(toFriendly(e).message);
      }
    }, 350);
    return () => { stale = true; window.clearTimeout(t); };
  }, [st?.state, docId, scope, template, pageCheck, level]);

  // A running job: follow it until it's done, then open the deck.
  useEffect(() => {
    if (!job || job.state !== "running") return;
    const t = window.setTimeout(async () => {
      try {
        const next = await readingApi.job(job.id);
        if (!alive.current) return;
        setJob(next);
        if (next.state === "done" && next.notebook_id) {
          track(rewrite ? "reading.rewrite.done" : "reading.generate.done");
          const nb = await notebookApi.get(next.notebook_id);
          if (alive.current) onMade(nb);
        } else if (next.state === "failed") {
          notifyError(new AppError(next.error ?? { message: "The notes couldn't be made." }));
          setJob(null);
        } else if (next.state === "cancelled") {
          toast("Stopped. Anything already read is kept, so starting again costs less.");
          setJob(null);
        }
      } catch (e) {
        if (alive.current) { notifyError(e); setJob(null); }
      }
    }, 800);
    return () => window.clearTimeout(t);
  }, [job]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function upload(file: File) {
    if (fileRef.current) fileRef.current.value = "";
    if (!/\.pdf$/i.test(file.name)) {
      notifyError({ title: "Upload a PDF", message: "Reading notes work from PDF files for now." });
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      notifyError({ title: "File too large", message: `Files can be up to ${MAX_UPLOAD_MB} MB. Split the book, or upload the chapters you need.` });
      return;
    }
    setUploading(file.name);
    try {
      track("reading.upload");
      const s = await readingApi.upload(file);
      if (!alive.current) return;
      setSt(s);
      setDocId(s.document_id);
      window.dispatchEvent(new Event("onboarding-refresh"));
    } catch (e) {
      notifyError(e);
    } finally {
      if (alive.current) setUploading(null);
    }
  }

  async function make() {
    if (!docId || !scope || starting) return;     // one job per click, however fast the clicks
    setStarting(true);
    try { await startJob(); } finally { if (alive.current) setStarting(false); }
  }

  async function startJob() {
    if (!docId || !scope) return;
    if (!(await ensureReady(["llm"]))) return;
    try { localStorage.setItem(STYLE_KEY, JSON.stringify(style)); } catch { /* not essential */ }
    try {
      const cfg = await fetchApi("/config").then(r => r.json()).catch(() => ({}));
      track(rewrite ? "reading.rewrite" : "reading.generate");
      const started = await readingApi.generate({
        document_id: docId, scope, template, style, tutor, model: cfg?.saved?.model || undefined, level,
        notebook_id: rewrite?.id,
      });
      if (alive.current) setJob(started);
    } catch (e) {
      notifyError(e);
    }
  }

  async function stopJob() {
    if (!job) return;
    try { setJob(await readingApi.cancelJob(job.id)); } catch (e) { notifyError(e); }
  }

  async function stopReading() {
    if (!docId) return;
    try { setSt(await readingApi.cancelRead(docId)); } catch (e) { notifyError(e); }
  }

  async function readAgain() {
    if (!docId) return;
    try {
      setSt(await readingApi.read(docId));
      setPollKey(k => k + 1);            // follow the new reading's progress
    } catch (e) { notifyError(e); }
  }

  const head = (
    <div className="nb-read-top">
      <button type="button" className="btn-neutral" onClick={onBack} disabled={!!job}><ArrowLeft size={14} /> {rewrite ? "Back to the deck" : "All notebooks"}</button>
      <div className="nb-read-heading">
        <div className="nb-kicker-app">{rewrite ? "Make this deck again" : st?.link ? linkKind(st.link).kicker : "Notes from a paper or book"}</div>
        <h2>{st?.name ?? (uploading ? uploading : "Choose a source")}</h2>
      </div>
    </div>
  );

  // ── Pick a document ─────────────────────────────────────────────────────
  if (!docId) {
    return (
      <div className="nb-read">
        {head}
        <div
          className={`glass-card nb-drop ${uploading ? "busy" : ""}`}
          onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("over"); }}
          onDragLeave={e => e.currentTarget.classList.remove("over")}
          onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove("over"); const f = e.dataTransfer.files?.[0]; if (f) upload(f); }}
        >
          {uploading ? (
            <><Loader2 size={22} className="spin" /><strong>Uploading {uploading}…</strong><span className="muted">A big book can take a few seconds.</span></>
          ) : (
            <>
              <Upload size={22} />
              <strong>Drop a research paper or a book here</strong>
              <span className="muted">A PDF of up to {MAX_UPLOAD_MB} MB and 2,000 pages. It's stored in your Library, on this computer.</span>
              <button type="button" className="btn-primary nb-drop-btn" onClick={() => fileRef.current?.click()}>
                <Upload size={14} /> Choose a PDF
              </button>
              <input ref={fileRef} type="file" accept=".pdf,application/pdf" hidden tabIndex={-1} aria-hidden="true"
                onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); }} />
            </>
          )}
        </div>
        {library && library.length > 0 && !uploading && (
          <section className="glass-card nb-read-card">
            <h3 className="nb-read-step"><FileText size={14} /> Or use a source already in your Library</h3>
            <div className="nb-lib-list">
              {library.map(d => (
                <button key={d.id} type="button" className="nb-lib-item" onClick={() => setDocId(d.id)}>
                  <FileText size={15} /> <span>{d.name}</span> <span className="muted">{d.original_filename}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  if (gone) {
    return (
      <div className="nb-read">
        {head}
        <div className="glass-card nb-read-card nb-progress-card" role="alert">
          <FileText size={22} />
          <strong>This document isn't in your Library any more</strong>
          <span className="muted">Its notes are still in your Notebook. To make new ones, upload the PDF again.</span>
          <div className="nb-make-actions">
            <button type="button" className="btn-neutral" onClick={onBack}>Back</button>
            <button type="button" className="btn-primary" onClick={() => { setGone(false); setDocId(undefined); setSt(null); }}>Choose a PDF</button>
          </div>
        </div>
      </div>
    );
  }

  // ── Reading it ──────────────────────────────────────────────────────────
  if (!st || st.state === "reading" || st.state === "new") {
    const pct = st ? percent(st.done, st.pages) : 0;
    return (
      <div className="nb-read">
        {head}
        <div className="glass-card nb-read-card nb-progress-card" aria-live="polite">
          <BookOpen size={22} />
          <strong>{!st || !st.pages ? "Opening the document…" : `Reading page ${Math.max(1, st.done)} of ${st.pages}`}</strong>
          <div className="nb-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
          <span className="muted">iReliabee keeps every page separately so your notes can say where each point came from. You can keep using the app meanwhile.</span>
          {st && <button type="button" className="btn-neutral" onClick={stopReading}><X size={14} /> Stop</button>}
        </div>
      </div>
    );
  }

  if (st.state !== "ready") {
    return (
      <div className="nb-read">
        {head}
        <div className="glass-card nb-read-card nb-progress-card" role="alert">
          <FileText size={22} />
          <strong>{st.state === "scanned" ? "This PDF is made of page images" : st.state === "cancelled" ? "Reading was stopped" : "This PDF couldn't be read"}</strong>
          <span className="muted">
            {st.state === "scanned"
              ? "iReliabee can't read scanned pages yet, and it won't make notes from nothing. If you have a text version of this PDF (you can select its words), upload that instead."
              : st.error || "Try reading it again, or choose another file."}
          </span>
          <div className="nb-make-actions">
            <button type="button" className="btn-neutral" onClick={() => { setDocId(undefined); setSt(null); }}>Choose another file</button>
            {st.state !== "scanned" && <button type="button" className="btn-primary" onClick={readAgain}><RotateCw size={14} /> Read it again</button>}
          </div>
        </div>
      </div>
    );
  }

  // ── Making the deck ─────────────────────────────────────────────────────
  if (job && job.state === "running") {
    return (
      <div className="nb-read">
        {head}
        <JobProgress job={job} deep={template === "deep"} onStop={stopJob} />
      </div>
    );
  }

  // ── What should I cover? ────────────────────────────────────────────────
  const top = st.outline.length ? Math.min(...st.outline.map(e => e.level)) : 1;
  const shown = st.outline.filter(e => e.level <= top + 1);
  const skipped = st.outline.filter(e => e.level === top && SKIPPED_BY_DEFAULT.includes(e.kind));
  const toggle = (idx: number) => setChapters(c => (c.includes(idx) ? c.filter(x => x !== idx) : [...c, idx]));
  const pageCount = pageCheck && "pages" in pageCheck ? pageCheck.pages.length : null;

  return (
    <div className="nb-read">
      {head}
      {st.link ? (
        <p className="muted nb-read-meta">
          {linkKind(st.link).label} · {linkSite(st.link.url)}
          {st.link.author ? ` · by ${st.link.author}` : ""}
          {st.link.captured_at ? ` · saved ${new Date(st.link.captured_at).toLocaleDateString()}` : ""}
          {st.link.url && <> · <a href={st.link.url} target="_blank" rel="noreferrer">open the original</a></>}
        </p>
      ) : (
        <p className="muted nb-read-meta">
          {KIND_LABEL[st.kind]} · {st.pages} pages · {formatBytes(st.bytes)} ·{" "}
          {st.source === "bookmarks" ? "chapters from its bookmarks" : st.outline.length ? "sections found in the text" : "no chapters found — choose pages"}
        </p>
      )}

      {st.error && <p className="nb-field-error nb-read-meta" role="status">{st.error}</p>}

      {decks.length > 0 && !rewrite && (
        <div className="nb-read-decks">
          <span className="muted">Already made from this document:</span>
          {decks.map(d => (
            <button key={d.id} type="button" className="nb-chip-btn" onClick={() => onOpen(d.id)}>
              <Layers size={12} /> {d.title}
            </button>
          ))}
        </div>
      )}

      <div className="nb-read-layout">
      <div className="nb-read-main">
      <section className="glass-card nb-read-card" aria-labelledby="nb-read-scope">
        <h3 className="nb-read-step" id="nb-read-scope"><span className="nb-step-no">1</span> What should I cover?</h3>
        <div className="nb-segment" role="radiogroup" aria-label="What to cover">
          {([["all", "Whole document"], ["chapters", "Chapters"], ["pages", "Pages"]] as [Mode, string][]).map(([m, label]) => (
            <label key={m} className={mode === m ? "active" : ""}>
              <input type="radio" name="nb-scope" checked={mode === m} disabled={m === "chapters" && !st.outline.length}
                onChange={() => setMode(m)} />
              <span>{label}</span>
            </label>
          ))}
        </div>

        {mode === "all" && (
          <p className="muted nb-read-hint">
            All {st.pages} pages{skipped.length ? ` except ${skipped.map(s => s.title.toLowerCase()).join(", ")}` : ""}.
            {skipped.length ? " Choose Chapters to include them." : ""}
          </p>
        )}

        {mode === "chapters" && (
          <>
            <div className="nb-chapters" role="group" aria-label="Chapters and sections">
              {shown.map(e => (
                <label key={e.idx} className={`nb-chapter lvl-${e.level - top + 1} ${chapters.includes(e.idx) ? "on" : ""}`}>
                  <input type="checkbox" checked={chapters.includes(e.idx)} onChange={() => toggle(e.idx)} />
                  <span className="nb-chapter-title">{e.title}</span>
                  {SKIPPED_BY_DEFAULT.includes(e.kind) && <span className="nb-chapter-tag">left out by default</span>}
                  <span className="muted nb-chapter-pages">{pagesLabel(e)}</span>
                </label>
              ))}
            </div>
            <div className="nb-chapter-tools">
              <button type="button" className="nb-add" onClick={() => setChapters(shown.filter(e => e.level === top && !SKIPPED_BY_DEFAULT.includes(e.kind)).map(e => e.idx))}>All main chapters</button>
              <button type="button" className="nb-add" onClick={() => setChapters([])}>None</button>
              <span className="muted">{chapters.length} chosen</span>
            </div>
          </>
        )}

        {mode === "pages" && (
          <div className="nb-pages-field">
            <label className="settings-label" htmlFor="nb-pages">Pages</label>
            <input id="nb-pages" className="nb-input" value={pages} onChange={e => setPages(e.target.value)}
              placeholder={`e.g. 12–48, 60 (1–${st.pages})`} aria-invalid={!!(pageCheck && "error" in pageCheck)} />
            <span className={pageCheck && "error" in pageCheck ? "nb-field-error" : "muted"}>
              {pageCheck && "error" in pageCheck ? pageCheck.error : pageCount ? `${pageCount} page${pageCount === 1 ? "" : "s"}` : "Separate ranges with commas."}
            </span>
          </div>
        )}
      </section>

      <section className="glass-card nb-read-card" aria-labelledby="nb-read-template">
        <h3 className="nb-read-step" id="nb-read-template"><span className="nb-step-no">2</span> Which kind of notes?</h3>
        <div className="nb-templates" role="radiogroup" aria-label="Note template">
          {templates.map(t => (
            <label key={t.id} className={`nb-template ${template === t.id ? "active" : ""}`}>
              <input type="radio" name="nb-template" checked={template === t.id} onChange={() => setTemplate(t.id)} />
              <span className="nb-template-name">{template === t.id && <Check size={13} />} {t.label}</span>
              <span className="muted nb-template-for">{t.for}</span>
              <span className="nb-template-slides">{t.shows ?? t.slides}</span>
            </label>
          ))}
        </div>
        {template === "deep" && (
          <div className="nb-levels">
            <span className="settings-label" id="nb-level-label">How much do you already know about this?</span>
            <div className="nb-templates" role="radiogroup" aria-labelledby="nb-level-label">
              {READER_LEVELS.map(l => (
                <label key={l.id} className={`nb-template nb-level ${level === l.id ? "active" : ""}`}>
                  <input type="radio" name="nb-level" checked={level === l.id} onChange={() => { setLevel(l.id); rememberLevel(l.id); }} />
                  <span className="nb-template-name">{level === l.id && <Check size={13} />} {l.label}</span>
                  <span className="muted nb-template-for">{l.hint}</span>
                </label>
              ))}
            </div>
            <p className="muted nb-level-note">
              You get a map of the text first, then its terms in the order to learn them, each with a plain meaning,
              an example and what it builds on, then every chapter as a one-line gist, its key points, its claims
              with the evidence given, and a few questions to answer from memory. Everything cites its page.
            </p>
          </div>
        )}
      </section>

      <section className="glass-card nb-read-card" aria-labelledby="nb-read-look">
        <h3 className="nb-read-step" id="nb-read-look"><span className="nb-step-no">3</span> How should they look?</h3>
        <StylePicker kind="reading" value={style} onChange={setStyle} />
        <label className="nb-toggle">
          <input type="checkbox" checked={tutor} onChange={e => setTutor(e.target.checked)} />
          <span>Add a few simple explanations where the text is hard <span className="muted">(labelled as iReliabee's, never mixed with what the document says)</span></span>
        </label>
      </section>

      </div>
      <aside className="nb-read-side">
      <div className="glass-card nb-read-go" aria-live="polite">
        <div className="nb-estimate">
          {estError ? <span className="nb-field-error">{estError}</span>
            : !scope ? <span className="muted">Choose what to cover.</span>
            : !est ? <span className="muted"><Loader2 size={13} className="spin" /> Working out what it takes…</span>
            : (
              <>
                <strong>{est.pages} pages · {formatDuration(est.seconds)}</strong>
                <span className="muted">
                  {est.calls} AI {est.calls === 1 ? "step" : "steps"}
                  {est.cached_windows ? ` · ${est.cached_windows} of ${est.windows} parts already read, so they're free` : ""}
                </span>
                {cost.text && <span className={cost.short ? "nb-field-error" : "nb-estimate-cost"}>{cost.text}</span>}
                {est.left_out.length > 0 && <span className="muted">Leaves out: {est.left_out.join(", ")}</span>}
              </>
            )}
        </div>
        {/* A job the balance can't pay for never starts (the app refuses it too). */}
        <button type="button" className="btn-primary" onClick={make} disabled={!scope || !!estError || !est || starting || cost.short}
          title={cost.short ? "Not enough credits for these pages: top up, or choose fewer pages" : undefined}>
          {starting ? <Loader2 size={14} className="spin" /> : <NotebookPen size={14} />} {rewrite ? "Make it again" : "Make my notes"}
        </button>
      </div>
      </aside>
      </div>
    </div>
  );
}
