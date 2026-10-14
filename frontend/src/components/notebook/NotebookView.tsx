import { useEffect, useMemo, useState } from "react";
import { Plus, Search, GraduationCap, Users, BookOpen, Loader2, X, CalendarClock } from "lucide-react";
import Page, { PageTab } from "../Page";
import { AiSuggest, SuggestLabel } from "../Suggested";
import Illustration from "../Illustration";
import { notifyError } from "../../lib/errors";
import { track } from "../../lib/usage";
import {
  DEFAULT_STYLE, notebookApi, type Notebook, type NotebookKind, type NotebookStyle, type NotebookSummary,
} from "../../lib/notebook";
import NotebookEditor from "./NotebookEditor";
import ReadingSetup from "./ReadingSetup";
import LinkImport from "../LinkImport";
import { parseNotebookSection } from "../../lib/reading";
import StylePicker from "./StylePicker";
import Shelf from "./Shelf";
import StudyReview from "./StudyReview";
import { studyApi } from "../../lib/study";

type Filter = "" | NotebookKind;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "", label: "All" }, { id: "lecture", label: "Lectures" }, { id: "meeting", label: "Meetings" }, { id: "reading", label: "Reading" },
];
const KIND_ICON: Record<NotebookKind, JSX.Element> = {
  lecture: <GraduationCap size={14} />, meeting: <Users size={14} />, reading: <BookOpen size={14} />,
};
const KIND_LABEL: Record<NotebookKind, string> = { lecture: "Lecture", meeting: "Meeting", reading: "Reading" };

/**
 * Every notebook in one place (spec 184 §4.4): lectures, meetings and reading
 * notes as covers you can filter and search; open one to read, edit or export
 * it, or start reading notes from a paper or book (spec 185).
 */
export default function NotebookView({ section }: { section?: string }) {
  const start = parseNotebookSection(section);
  const [items, setItems] = useState<NotebookSummary[] | null>(null);
  const [filter, setFilter] = useState<Filter>(start.read ? "reading" : "");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Notebook | null>(null);
  const [importingLink, setImportingLink] = useState(false);
  // Study mode: questions due for review today, and the review session.
  const [dueCount, setDueCount] = useState(0);
  const [reviewing, setReviewing] = useState(false);
  const refreshDue = () => { studyApi.due().then(r => setDueCount(r.due)).catch(() => setDueCount(0)); };
  useEffect(() => { if (!open) refreshDue(); }, [open]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [creating, setCreating] = useState<null | { kind: NotebookKind; title: string; style: NotebookStyle }>(null);
  const [reading, setReading] = useState<null | { documentId?: number; rewrite?: Notebook }>(start.read ?? null);

  async function load(q = query) {
    try { setItems(await notebookApi.list("", q)); } catch (e) { notifyError(e); setItems([]); }
  }

  useEffect(() => { load(""); if (start.openId) openNotebook(start.openId); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => load(query), 250);
    return () => clearTimeout(t);
  }, [query]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function openNotebook(id: number) {
    try { setOpen(await notebookApi.get(id)); setReading(null); track("notebook.open"); } catch (e) { notifyError(e); }
  }

  async function create() {
    if (!creating) return;
    try {
      const made = await notebookApi.create(creating.kind, creating.title.trim() || "Untitled notebook", creating.style);
      setCreating(null);
      track("notebook.create");
      setOpen(made);
    } catch (e) { notifyError(e); }
  }

  const visible = useMemo(() => (items ?? []).filter(i => !filter || i.kind === filter), [items, filter]);

  useEffect(() => {
    if (!creating) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setCreating(null); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [creating]);

  if (reading) {
    return (
      // Its own scroll area: the notebook screens sit outside the app's scrolling page
      // (the book view fills the window), so a long setup page was cut off at the bottom.
      <div className="page-content nb-open nb-reading-page">
        <ReadingSetup key={`${reading.documentId ?? "new"}-${reading.rewrite?.id ?? ""}`}
          documentId={reading.documentId} rewrite={reading.rewrite}
          onBack={() => { const back = reading.rewrite?.id; setReading(null); if (back) openNotebook(back); else load(); }}
          onMade={nb => { setReading(null); setOpen(nb); setFilter("reading"); }}
          onOpen={openNotebook} />
      </div>
    );
  }

  if (open) {
    return (
      <div className="page-content nb-open">
        <NotebookEditor key={`${open.id}-${open.version}`} initial={open}
          onBack={() => { setOpen(null); load(); }}
          onDeleted={() => { setOpen(null); load(); }}
          onRemake={open.kind === "reading" && open.document_id ? () => setReading({ rewrite: open }) : undefined} />
      </div>
    );
  }

  const emptyReading = filter === "reading" && !query;
  return (
    <Page
      title="Notebook"
      subtitle="Notes from your lectures, meetings and reading — highlighted, organised and yours to edit."
      actions={
        <div className="nb-page-actions">
          {dueCount > 0 && (
            <button type="button" className="nbk-pill study-due-pill" onClick={() => setReviewing(true)}
              title="Questions you answered in your notebooks, due for review">
              <CalendarClock size={14} /> Review · {dueCount} due
            </button>
          )}
          <button type="button" className="btn-neutral" onClick={() => setImportingLink(true)}>Add a link</button>
          <button type="button" className="btn-neutral" onClick={() => setReading({})}>
            <BookOpen size={14} /> From a paper or book
          </button>
          <button type="button" className="btn-primary" onClick={() => setCreating({ kind: "lecture", title: "", style: DEFAULT_STYLE.lecture })}>
            <Plus size={14} /> New notebook
          </button>
        </div>
      }
      tabs={FILTERS.map(f => (
        <PageTab key={f.id || "all"} active={filter === f.id} onClick={() => setFilter(f.id)}
          count={(items ?? []).filter(i => !f.id || i.kind === f.id).length}>
          {f.label}
        </PageTab>
      ))}
    >
      <div className="page-content">
        {reviewing && <StudyReview onClose={() => { setReviewing(false); refreshDue(); }} onDone={refreshDue} />}
        {importingLink && <LinkImport onClose={() => setImportingLink(false)} onSaved={doc => { setImportingLink(false); setReading({ documentId: doc.id }); }} />}
        <label className="nb-search">
          <Search size={14} aria-hidden="true" />
          <input className="nb-input" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search titles and notes" aria-label="Search notebooks" />
          {query && <button type="button" className="nb-icon-btn" onClick={() => setQuery("")} aria-label="Clear search"><X size={13} /></button>}
        </label>

        {items == null ? (
          <div className="glass-card plans-empty"><Loader2 size={18} className="spin" /></div>
        ) : visible.length === 0 ? (
          <div className="glass-card plans-empty">
            <Illustration name="library" />
            <div className="plans-empty-title">{query ? "Nothing matches that search" : emptyReading ? "No reading notes yet" : "No notebooks yet"}</div>
            <p className="muted">
              {query ? "Try another word."
                : emptyReading ? "Drop in a research paper or a whole textbook, pick the chapters, and flip through notebook slides that cover every key point — each linked to its page."
                : "Open a lecture or meeting in Sessions and choose Notebook, start one from a paper or book, or begin a blank one with New notebook."}
            </p>
            {emptyReading && (
              <button type="button" className="btn-primary" onClick={() => setReading({})}><BookOpen size={14} /> From a paper or book</button>
            )}
          </div>
        ) : (
          <Shelf items={visible} onOpen={openNotebook} />
        )}
      </div>

      {creating && (
        <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) setCreating(null); }}>
          <div className="glass-card nb-create" role="dialog" aria-modal="true" aria-label="New notebook">
            <div className="nb-popover-head"><strong>New notebook</strong>
              <button type="button" className="nb-icon-btn" onClick={() => setCreating(null)} aria-label="Close"><X size={14} /></button></div>
            <SuggestLabel label="Title" htmlFor="nb-new-title">
              <AiSuggest<string> field="notebook.title" label="Notebook title" value={creating.title}
                form={() => ({ kind: creating.kind, title: creating.title })}
                onSuggest={text => setCreating(c => (c && !c.title.trim() ? { ...c, title: text } : c))} />
            </SuggestLabel>
            <input id="nb-new-title" className="nb-input" value={creating.title} autoFocus placeholder="e.g. Biology 201 — week 3"
              onChange={e => setCreating({ ...creating, title: e.target.value })} />
            <div className="settings-label">Kind</div>
            <div className="nb-segment" role="radiogroup" aria-label="Kind">
              {(["lecture", "meeting"] as NotebookKind[]).map(k => (
                <label key={k} className={creating.kind === k ? "active" : ""}>
                  <input type="radio" name="nb-new-kind" checked={creating.kind === k}
                    onChange={() => setCreating({ ...creating, kind: k, style: DEFAULT_STYLE[k] })} />
                  <span>{KIND_ICON[k]} {KIND_LABEL[k]} notes</span>
                </label>
              ))}
            </div>
            <StylePicker kind={creating.kind} value={creating.style} onChange={style => setCreating({ ...creating, style })} />
            <div className="nb-make-actions">
              <button type="button" className="btn-neutral" onClick={() => setCreating(null)}>Cancel</button>
              <button type="button" className="btn-primary" onClick={create}><Plus size={14} /> Create</button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}
