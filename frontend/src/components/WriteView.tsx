import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { ArrowDown, ArrowLeft, ArrowUp, CheckCircle2, Circle, Eye, GraduationCap, Loader2, PenLine, PlayCircle, Plus, Quote, Trash2, X } from "lucide-react";
import Page from "./Page";
import ConfirmDialog from "./ConfirmDialog";
import { notifyError } from "../lib/errors";
import { openExternal } from "../lib/openExternal";
import {
  countWords, stageProgress, videoUrl, wordStatus, writingApi,
  type Framework, type Genre, type Project, type Section, type Stage,
} from "../lib/writing";
import { DraftChecks, QuestionCheck, TaskAnalyser } from "./WriteTools";
import { CitePicker, DocumentPreview, SourcesPanel } from "./WriteSources";
import { ReviewPanel } from "./WriteReview";
import { insertCitation, type Ref } from "../lib/citations";
import "../write.css";

/**
 * Write: academic writing, step by step (docs/academic-writing.md). A project is one piece of
 * writing, built from its genre's structure and worked through ten stages, from analysing the task
 * to proofreading. The stages follow the University of Melbourne's Academic Skills series; each
 * links to the video that teaches it.
 */
export default function WriteView({ section }: { section?: string }) {
  const [fw, setFw] = useState<Framework | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(() => (section && /^\d+$/.test(section) ? Number(section) : null));
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => writingApi.projects().then(setProjects).catch(e => { setProjects([]); notifyError(e); }), []);
  useEffect(() => { writingApi.framework().then(setFw).catch(notifyError); void load(); }, [load]);

  // Back reloads the list now, and again once the editor's last save has landed.
  const back = useCallback(() => { setOpenId(null); void load(); window.setTimeout(() => void load(), 1200); }, [load]);
  if (fw && openId != null) {
    return <ProjectView fw={fw} id={openId} onBack={back} />;
  }
  return (
    <Page title="Write" subtitle="Academic writing, step by step: from the brief to the reference list."
      actions={<button className="btn-primary write-new" onClick={() => setCreating(true)} disabled={!fw}><Plus size={14} /> New writing</button>}>
      <div className="page-content">
        {projects == null || !fw ? (
          <div className="muted write-loading"><Loader2 size={16} className="spin" /> Opening your writing…</div>
        ) : projects.length === 0 ? (
          <Welcome fw={fw} onStart={() => setCreating(true)} />
        ) : (
          <div className="write-projects">
            {projects.map(p => <ProjectCard key={p.id} fw={fw} p={p} onOpen={() => setOpenId(p.id)} />)}
          </div>
        )}
      </div>
      {creating && fw && (
        <NewProject fw={fw} onClose={() => setCreating(false)}
          onCreated={p => { setCreating(false); setOpenId(p.id); }} />
      )}
    </Page>
  );
}

function Welcome({ fw, onStart }: { fw: Framework; onStart: () => void }) {
  return (
    <div className="write-welcome">
      <div className="write-welcome-head">
        <PenLine size={22} />
        <div>
          <h2>Write like an academic, one stage at a time</h2>
          <p className="muted">Pick what you are writing. Write gives it the right structure and a word budget, then walks you through
            ten stages, each with a checklist and a short video from the University of Melbourne's Academic Skills team.</p>
        </div>
      </div>
      <ol className="write-stage-strip">
        {fw.stages.map((s, i) => <li key={s.key}><span>{i + 1}</span>{s.title}</li>)}
      </ol>
      <div className="write-genres">
        {fw.genres.map(g => (
          <div key={g.key} className="write-genre-card">
            <strong>{g.title}</strong>
            <span className="muted">{g.summary}</span>
            <span className="write-genre-parts">{g.sections.map(s => s.title).join(" · ")}</span>
          </div>
        ))}
      </div>
      <button className="btn-primary write-new" onClick={onStart}><Plus size={14} /> Start a piece of writing</button>
    </div>
  );
}

function ProjectCard({ fw, p, onOpen }: { fw: Framework; p: Project; onOpen: () => void }) {
  const genre = fw.genres.find(g => g.key === p.genre);
  const stage = fw.stages.find(s => s.key === p.stage);
  const pct = p.word_limit ? Math.min(100, Math.round((p.words / p.word_limit) * 100)) : 0;
  return (
    <button type="button" className="write-project-card" onClick={onOpen}>
      <span className="write-kicker">{genre?.title ?? p.genre}</span>
      <strong className="write-project-title">{p.title}</strong>
      <span className="muted">Stage {fw.stages.findIndex(s => s.key === p.stage) + 1}: {stage?.title}</span>
      <span className="write-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
      <span className="muted write-project-meta">
        {p.words.toLocaleString()}{p.word_limit ? ` of ${p.word_limit.toLocaleString()} words` : " words"}
        {" · "}{new Date(p.updated_at).toLocaleDateString([], { day: "numeric", month: "short" })}
      </span>
    </button>
  );
}

function NewProject({ fw, onClose, onCreated }: { fw: Framework; onClose: () => void; onCreated: (p: Project) => void }) {
  const [genre, setGenre] = useState(fw.genres[0]?.key ?? "essay");
  const [title, setTitle] = useState("");
  const [limit, setLimit] = useState("2000");
  const [style, setStyle] = useState("apa");
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      onCreated(await writingApi.create(genre, title, Number(limit) || 0, style));
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="debrief-panel write-new-panel" role="dialog" aria-modal="true" aria-label="New writing">
        <header className="debrief-panel-head">
          <div><div className="debrief-kicker">Write</div><div className="debrief-title">What are you writing?</div></div>
          <button className="titlebar-btn" onClick={onClose} title="Cancel"><X size={16} /></button>
        </header>
        <div className="debrief-panel-body write-new-body">
          <div className="write-genre-pick" role="radiogroup" aria-label="Kind of writing">
            {fw.genres.map(g => (
              <button key={g.key} type="button" role="radio" aria-checked={genre === g.key}
                className={`write-genre-card pickable ${genre === g.key ? "picked" : ""}`} onClick={() => setGenre(g.key)}>
                <strong>{g.title}</strong>
                <span className="muted">{g.summary}</span>
              </button>
            ))}
          </div>
          <label className="write-field" htmlFor="write-new-title">
            <span>Title or working title</span>
            <input id="write-new-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={200}
              placeholder="e.g. How speech timing shapes fluency" />
          </label>
          <div className="write-field-row">
            <label className="write-field" htmlFor="write-new-limit">
              <span>Word limit</span>
              <input id="write-new-limit" inputMode="numeric" value={limit} onChange={e => setLimit(e.target.value.replace(/\D/g, ""))} />
            </label>
            <label className="write-field" htmlFor="write-new-style">
              <span>Citation style</span>
              <select id="write-new-style" value={style} onChange={e => setStyle(e.target.value)}>
                {fw.citation_styles.map(s => <option key={s.key} value={s.key}>{s.title}</option>)}
              </select>
            </label>
          </div>
          <button className="btn-primary write-new" onClick={create} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} Create
          </button>
        </div>
      </div>
    </div>
  );
}

/** Saves a field a moment after typing stops, and once more when it is left. */
function useAutosave<T>(save: (value: T) => Promise<void>, delay = 700) {
  const timer = useRef<number | undefined>();
  const pending = useRef<{ value: T } | null>(null);
  // The latest save, so a parent re-rendering never resets the timer or flushes early.
  const saveRef = useRef(save);
  saveRef.current = save;
  const [state, setState] = useState<"saved" | "saving" | "error">("saved");
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setState("saving");
    try { await saveRef.current(p.value); setState("saved"); } catch (e) { setState("error"); notifyError(e); }
  }, []);
  const queue = useCallback((value: T) => {
    pending.current = { value };
    setState("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, delay);
  }, [delay, flush]);
  /** Drop what is waiting, as when the section it belongs to is being deleted. */
  const cancel = useCallback(() => { window.clearTimeout(timer.current); pending.current = null; setState("saved"); }, []);
  useEffect(() => () => { void flush(); }, [flush]);
  return { queue, flush, cancel, state };
}

function ProjectView({ fw, id, onBack }: { fw: Framework; id: number; onBack: () => void }) {
  const [p, setP] = useState<Project | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    writingApi.project(id).then(proj => { setP(proj); setCurrent(proj.sections?.[0]?.id ?? null); })
      .catch(e => { notifyError(e); onBack(); });
    writingApi.refs(id).then(setRefs).catch(() => setRefs([]));
  }, [id, onBack]);

  const genre = useMemo(() => fw.genres.find(g => g.key === p?.genre), [fw, p?.genre]);
  const seq = useRef(0);
  const patch = useCallback(async (change: Parameters<typeof writingApi.update>[1]) => {
    const mine = ++seq.current;
    // At once, so a second quick click (a tick, a key term) builds on the first instead of undoing it.
    setP(prev => (prev ? { ...prev, ...change } as Project : prev));
    const next = await writingApi.update(id, change);
    if (mine === seq.current) setP(next);
  }, [id]);

  if (!p || !genre) return <Page title="Write"><div className="page-content muted"><Loader2 size={16} className="spin" /> Opening…</div></Page>;
  const stage = fw.stages.find(s => s.key === p.stage) ?? fw.stages[0];
  const status = wordStatus(p.words, p.word_limit);

  return (
    <Page title={p.title}
      subtitle={`${genre.title} · ${fw.citation_styles.find(s => s.key === p.style)?.title ?? p.style} · ${p.words.toLocaleString()}${p.word_limit ? ` of ${p.word_limit.toLocaleString()}` : ""} words`}
      actions={<>
        <button className="btn-ghost" onClick={onBack}><ArrowLeft size={14} /> All writing</button>
        <button className="btn-ghost" onClick={() => setPreview(true)} title="The whole document with citations formatted and the reference list; export it as Word, PDF or Markdown"><Eye size={14} /> Preview and export</button>
        <button className="btn-ghost danger" onClick={() => setConfirmDelete(true)} title="Delete this piece of writing"><Trash2 size={14} /></button>
      </>}>
      <div className="page-content write-workspace">
        <nav className="write-stages" aria-label="Stages">
          {fw.stages.map((s, i) => {
            const { done, total } = stageProgress(p, s);
            return (
              <button key={s.key} type="button" className={`write-stage-tab ${s.key === stage.key ? "active" : ""} ${done === total ? "done" : ""}`}
                aria-current={s.key === stage.key ? "step" : undefined} onClick={() => void patch({ stage: s.key }).catch(notifyError)}>
                <span className="write-stage-num">{done === total ? <CheckCircle2 size={14} /> : i + 1}</span>
                <span className="write-stage-name">{s.title}</span>
                <span className="write-stage-count">{done}/{total}</span>
              </button>
            );
          })}
          <div className={`write-total ${status}`}>
            <span>{p.words.toLocaleString()} words</span>
            {p.word_limit > 0 && <span className="muted">{status === "on" ? "within 10% of the limit" : status === "over" ? "over the limit" : `${(p.word_limit - p.words).toLocaleString()} to go`}</span>}
          </div>
        </nav>

        <div className="write-main">
          <StageCard fw={fw} stage={stage} p={p} genre={genre} onPatch={patch} refs={refs} setRefs={setRefs} onOpenSection={setCurrent} />
          <Draft p={p} genre={genre} current={current} setCurrent={setCurrent} setP={setP} refs={refs} />
        </div>
      </div>
      {preview && <DocumentPreview p={p} refs={refs} headings={genre.headings} onClose={() => setPreview(false)} />}
      {confirmDelete && (
        <ConfirmDialog message={`Delete "${p.title}"?`} detail="Its sections, plan and ticks are removed from this computer."
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => writingApi.remove(id).then(() => { toast.success("Deleted"); onBack(); }).catch(notifyError)} />
      )}
    </Page>
  );
}

function StageCard({ fw, stage, p, genre, onPatch, refs, setRefs, onOpenSection }: {
  fw: Framework; stage: Stage; p: Project; genre: Genre; onPatch: (change: Parameters<typeof writingApi.update>[1]) => Promise<void>;
  refs: Ref[]; setRefs: (update: (prev: Ref[]) => Ref[]) => void; onOpenSection: (id: number) => void;
}) {
  const ticked = new Set(p.ticks[stage.key] ?? []);
  const toggle = (i: number) => {
    const next = new Set(ticked);
    if (next.has(i)) next.delete(i); else next.add(i);
    void onPatch({ ticks: { ...p.ticks, [stage.key]: [...next].sort((a, b) => a - b) } }).catch(notifyError);
  };
  const researchy = genre.key === "research_paper" || genre.key === "research_proposal" || genre.key === "literature_review";
  return (
    <section className="write-stage-card" aria-label={stage.title}>
      <div className="write-stage-head">
        <div>
          <span className="write-kicker">Stage {fw.stages.indexOf(stage) + 1} of {fw.stages.length}</span>
          <h2>{stage.title}</h2>
        </div>
      </div>
      <p className="write-why">{stage.why}</p>
      <p className="muted"><strong>You produce:</strong> {stage.produce}</p>
      <ul className="write-checklist">
        {stage.checklist.map((item, i) => (
          <li key={i}>
            <button type="button" role="checkbox" aria-checked={ticked.has(i)} onClick={() => toggle(i)} className={ticked.has(i) ? "ticked" : ""}>
              {ticked.has(i) ? <CheckCircle2 size={16} /> : <Circle size={16} />}<span>{item}</span>
            </button>
          </li>
        ))}
      </ul>
      {stage.key === "task" && (
        <div className="write-stage-fields">
          <TextField label="The task, as set" value={p.brief} rows={5} placeholder="Paste the assignment brief or question, and the marking criteria if you have them."
            onSave={v => onPatch({ brief: v })} />
          <TaskAnalyser p={p} onPatch={onPatch} />
          <div className="write-field-row">
            <label className="write-field">
              <span>Word limit</span>
              <input inputMode="numeric" defaultValue={p.word_limit || ""} key={`limit-${p.word_limit}`}
                onBlur={e => { const n = Number(e.target.value.replace(/\D/g, "")) || 0; if (n !== p.word_limit) void onPatch({ word_limit: n }).catch(notifyError); }} />
            </label>
            <label className="write-field">
              <span>Citation style</span>
              <select value={p.style} onChange={e => void onPatch({ style: e.target.value }).catch(notifyError)}>
                {fw.citation_styles.map(s => <option key={s.key} value={s.key}>{s.title}</option>)}
              </select>
            </label>
          </div>
        </div>
      )}
      {stage.key === "focus" && (
        <div className="write-stage-fields">
          <TextField label={genre.key === "reflective" ? "Your theme" : researchy ? "Research question and purpose" : "Your focus"}
            value={p.focus} rows={3}
            placeholder={genre.key === "reflective" ? "The one theme this reflection follows." : researchy
              ? "To what extent… ? The purpose of this study is to…" : "What this piece will argue or explain, and its limits."}
            onSave={v => onPatch({ focus: v })} />
          {genre.key !== "reflective" && <QuestionCheck text={p.focus} />}
        </div>
      )}
      {stage.key === "plan" && (
        <div className="write-stage-fields">
          <TextField label="Thesis: the position you take" value={p.thesis} rows={2}
            placeholder="This essay argues that… because…" onSave={v => onPatch({ thesis: v })} />
        </div>
      )}
      {(stage.key === "cite" || stage.key === "read") && <SourcesPanel p={p} refs={refs} setRefs={setRefs} />}
      {(stage.key === "draft" || stage.key === "style" || stage.key === "proof") && (
        <DraftChecks p={p} genre={genre} videos={fw.videos} onOpenSection={onOpenSection} />
      )}
      {(stage.key === "cohesion" || stage.key === "frame" || stage.key === "proof") && p.words > 0 && (
        <ReviewPanel projectId={p.id} sectionId={null} label="the whole draft" version={`${p.words}:${p.updated_at}`} />
      )}
      <div className="write-videos">
        {stage.videos.map(v => (
          <button key={v} type="button" className="write-video" onClick={() => void openExternal(videoUrl(v))}
            title={`Watch on YouTube: ${fw.videos[v]} (${fw.video_source})`}>
            <PlayCircle size={14} /> {fw.videos[v]}
          </button>
        ))}
        <span className="muted write-video-source">Videos: {fw.video_source}</span>
      </div>
    </section>
  );
}

function TextField({ label, value, rows, placeholder, onSave }: {
  label: string; value: string; rows: number; placeholder?: string; onSave: (v: string) => Promise<void>;
}) {
  const [text, setText] = useState(value);
  const { queue, flush, state } = useAutosave<string>(onSave);
  return (
    <label className="write-field">
      <span>{label}{state === "saving" ? <em className="write-saving"> saving…</em> : null}</span>
      <textarea rows={rows} value={text} placeholder={placeholder}
        onChange={e => { setText(e.target.value); queue(e.target.value); }} onBlur={() => void flush()} />
    </label>
  );
}

function Draft({ p, genre, current, setCurrent, setP, refs }: {
  p: Project; genre: Genre; current: number | null; setCurrent: (id: number | null) => void; setP: (p: Project) => void; refs: Ref[];
}) {
  const sections = p.sections ?? [];
  const sec = sections.find(s => s.id === current) ?? sections[0];
  const move = async (from: number, to: number) => {
    const ids = sections.map(s => s.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved as number);
    try { setP(await writingApi.reorder(p.id, ids)); } catch (e) { notifyError(e); }
  };
  return (
    <section className="write-draft" aria-label="Your draft">
      <div className="write-outline">
        <div className="write-outline-head">
          <span className="write-kicker">Outline</span>
          <button className="btn-ghost write-add" title="Add a section after the one open"
            onClick={() => writingApi.addSection(p.id, "New section", sec?.id).then(next => { setP(next); setCurrent(next.sections?.[(next.sections?.findIndex(s => s.id === sec?.id) ?? -1) + 1]?.id ?? null); }).catch(notifyError)}>
            <Plus size={13} /> Section
          </button>
        </div>
        <ol>
          {sections.map((s, i) => {
            const st = wordStatus(s.words, s.target);
            return (
              <li key={s.id} className={s.id === sec?.id ? "active" : ""}>
                <button type="button" className="write-outline-item" onClick={() => setCurrent(s.id)}>
                  <span className="write-outline-title">{s.title}</span>
                  <span className={`write-outline-words ${st}`}>{s.words}{s.target ? `/${s.target}` : ""}</span>
                  <span className="write-bar thin" aria-hidden="true"><span className={st} style={{ width: `${s.target ? Math.min(100, (s.words / s.target) * 100) : 0}%` }} /></span>
                </button>
                <span className="write-outline-move">
                  <button type="button" aria-label={`Move ${s.title} up`} disabled={i === 0} onClick={() => void move(i, i - 1)}><ArrowUp size={12} /></button>
                  <button type="button" aria-label={`Move ${s.title} down`} disabled={i === sections.length - 1} onClick={() => void move(i, i + 1)}><ArrowDown size={12} /></button>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {sec ? <SectionEditor key={sec.id} sec={sec} hint={genre.sections.find(g => g.key === sec.key)?.hint} setP={setP} refs={refs} projectId={p.id}
        onDeleted={next => { setP(next); setCurrent(next.sections?.[0]?.id ?? null); }} /> : <p className="muted">Add a section to start writing.</p>}
    </section>
  );
}

function SectionEditor({ sec, hint, setP, onDeleted, refs, projectId }: {
  sec: Section; hint?: string; setP: (p: Project) => void; onDeleted: (p: Project) => void; refs: Ref[]; projectId: number;
}) {
  const [title, setTitle] = useState(sec.title);
  const [body, setBody] = useState(sec.body);
  const [confirm, setConfirm] = useState(false);
  const [citing, setCiting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const caret = useRef(0);
  const save = useCallback(async (v: { body?: string; title?: string }) => { setP(await writingApi.updateSection(sec.id, v)); }, [sec.id, setP]);
  const bodySave = useAutosave<string>(v => save({ body: v }), 900);
  const words = countWords(body);
  const st = wordStatus(words, sec.target);
  return (
    <div className="write-editor">
      <div className="write-editor-head">
        <input className="write-section-title" value={title} aria-label="Section title" maxLength={200}
          onChange={e => setTitle(e.target.value)} onBlur={() => { if (title.trim() && title !== sec.title) void save({ title }).catch(notifyError); }} />
        <span className={`write-count ${st}`}>{words.toLocaleString()}{sec.target ? ` / ${sec.target.toLocaleString()}` : ""} words</span>
        <span className="write-saving">{bodySave.state === "saving" ? "Saving…" : bodySave.state === "error" ? "Not saved" : "Saved"}</span>
        <button className="btn-ghost" title="Cite a source where the cursor is" onMouseDown={() => { caret.current = area.current?.selectionStart ?? body.length; }}
          onClick={() => setCiting(c => !c)}><Quote size={13} /> Cite</button>
        <button className="btn-ghost" title="The AI coach's notes on this section: what works and what to work on. Uses credits; the price is shown first."
          onClick={() => { void bodySave.flush().then(() => setReviewing(r => !r)); }}><GraduationCap size={13} /> Review</button>
        <button className="btn-ghost danger" title="Delete this section" onClick={() => setConfirm(true)}><Trash2 size={13} /></button>
      </div>
      {hint && <p className="write-hint">{hint}</p>}
      {reviewing && <ReviewPanel projectId={projectId} sectionId={sec.id} label={sec.title} onClose={() => setReviewing(false)}
        version={`${sec.words}:${sec.updated_at}`} />}
      {citing && (
        <CitePicker refs={refs} onClose={() => setCiting(false)} onPick={marker => {
          const { text, caret: pos } = insertCitation(body, caret.current, marker);
          setBody(text); bodySave.queue(text); setCiting(false);
          requestAnimationFrame(() => { const el = area.current; if (el) { el.focus(); el.setSelectionRange(pos, pos); } });
        }} />
      )}
      <textarea ref={area} className="write-body" value={body} spellCheck aria-label={`${sec.title}: your text`}
        placeholder="Write here. Your words are saved as you type."
        onChange={e => { setBody(e.target.value); bodySave.queue(e.target.value); }} onBlur={() => void bodySave.flush()} />
      {confirm && (
        <ConfirmDialog message={`Delete the section "${sec.title}"?`} detail={sec.words ? `Its ${sec.words} words are deleted too.` : undefined}
          onCancel={() => setConfirm(false)}
          onConfirm={() => { bodySave.cancel(); writingApi.removeSection(sec.id).then(onDeleted).catch(notifyError).finally(() => setConfirm(false)); }} />
      )}
    </div>
  );
}
