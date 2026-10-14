import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, ClipboardList, FileText, FlaskConical, Loader2, Mic, PenLine, Plus, ScanSearch, ShieldQuestion, Timer, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { openMockWith } from "./MockInterviewView";
import { countWords, flatDetails, projectText, proposalDetails, replicationDetails, researchApi, type FlatField, type Project, type ProjectMeta, type ProjectKind } from "../lib/research";
import { openExternal } from "../lib/openExternal";
import { notifyError } from "../lib/errors";
import { track } from "../lib/usage";

const KINDS: { id: ProjectKind; label: string; hint: string; icon: JSX.Element }[] = [
  { id: "proposal", label: "Proposal", hint: "A one-page proposal answering DARPA's eight Heilmeier questions", icon: <ClipboardList size={14} /> },
  { id: "replication", label: "Replication", hint: "Reproduce one published result, with a plan and code", icon: <FlaskConical size={14} /> },
  { id: "paper", label: "Paper draft", hint: "A workshop-length paper: abstract, introduction, methods, results, discussion, limitations", icon: <FileText size={14} /> },
  { id: "review", label: "Peer review", hint: "Review a published paper, then compare with its real public reviews", icon: <ScanSearch size={14} /> },
  { id: "talk", label: "Talk", hint: "A 10-minute research talk: one message, outline, script, expected questions", icon: <Mic size={14} /> },
];
const KIND_LABEL: Record<ProjectKind, string> = { proposal: "Proposal", replication: "Replication", paper: "Paper draft", review: "Peer review", talk: "Talk" };
const TITLE_HINT: Record<ProjectKind, string> = {
  proposal: "e.g. Surprisal and disfluency in conversational speech",
  replication: "e.g. Warner et al. (2026): information load predicts stuttering",
  paper: "e.g. Word surprisal predicts disfluency in conversational speech",
  review: "e.g. Review of Orpella et al. (2024)",
  talk: "e.g. What makes a word hard to say? Surprisal and stuttering",
};

/**
 * Projects: the level 2 proposal and the level 3 replication. Both are the
 * learner's own writing; the panel (proposal panel, Reviewer 2) reads them
 * in Practice.
 */
export default function ResearchProjects() {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState<ProjectKind | null>(null);
  const [title, setTitle] = useState("");

  const load = () => researchApi.projects().then(setMeta).catch(notifyError);
  useEffect(() => { load(); }, []);

  async function add() {
    if (!adding) return;
    try {
      const p = await researchApi.addProject(adding, title);
      track(`research.project.add.${adding}`);
      setAdding(null); setTitle(""); setOpen(p.id); load();
    } catch (e) { notifyError(e); }
  }

  if (!meta) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;
  return (
    <div className="research-papers">
      <div className="research-toolbar">
        <span className="muted">{meta.sprints.sprints} writing sprint{meta.sprints.sprints === 1 ? "" : "s"} · {meta.sprints.words} words written in them.</span>
        {KINDS.map(k => (
          <button key={k.id} className="btn-neutral" title={k.hint} onClick={() => { setAdding(k.id); setTitle(""); }}>
            <Plus size={14} /> {k.label}
          </button>
        ))}
      </div>
      {adding && (
        <div className="glass-card research-form">
          <label className="settings-label" htmlFor="rt-proj">{KIND_LABEL[adding]}: title</label>
          <input id="rt-proj" className="glass-input" value={title} onChange={e => setTitle(e.target.value)} autoFocus placeholder={TITLE_HINT[adding]} />
          <div className="research-actions">
            <button className="btn-neutral" onClick={() => setAdding(null)}>Cancel</button>
            <button className="btn-primary" disabled={!title.trim()} onClick={add}>Create</button>
          </div>
        </div>
      )}
      {meta.projects.length === 0 && !adding && (
        <div className="glass-card plans-empty">
          <div className="plans-empty-title">No projects yet</div>
          <p className="muted">A proposal at level 2, a replication at level 3, a paper draft and two peer reviews at level 4, a talk at level 5. You can start any of them early.</p>
        </div>
      )}
      {meta.projects.map(p => (
        <ProjectCard key={p.id} project={p} meta={meta} open={open === p.id}
          onToggle={() => setOpen(open === p.id ? null : p.id)} onChange={load} />
      ))}
    </div>
  );
}

function ProjectCard({ project, meta, open, onToggle, onChange }:
  { project: Project; meta: ProjectMeta; open: boolean; onToggle: () => void; onChange: () => void }) {
  const [draft, setDraft] = useState(project.data);
  useEffect(() => setDraft(project.data), [project]);

  async function save(data: Record<string, unknown>) {
    try { await researchApi.updateProject(project.id, { data }); onChange(); } catch (e) { notifyError(e); }
  }
  async function remove() {
    try { await researchApi.deleteProject(project.id); track("research.project.delete"); onChange(); } catch (e) { notifyError(e); }
  }
  const pr = project.progress;
  const isProposal = project.kind === "proposal";
  const flat = project.kind === "paper" || project.kind === "review" || project.kind === "talk" ? meta.kinds[project.kind] : null;
  const icon = KINDS.find(k => k.id === project.kind)?.icon;

  return (
    <section className="glass-card research-paper">
      <button className="research-paper-head" onClick={onToggle}>
        {icon}
        <b>{project.title}</b>
        <span className="muted">{KIND_LABEL[project.kind]} · {pr.done}/{pr.total}</span>
        {pr.complete && <span className="research-due held">complete</span>}
      </button>
      {open && (
        <div className="research-paper-body">
          {pr.next && <p className="muted">Next: {pr.next}</p>}
          {project.kind !== "review" && project.kind !== "replication" && <Sprint project={project} text={projectText({ ...project, data: draft })} onDone={onChange} />}
          {flat ? <FlatFields fields={flat} project={project} draft={draft} setDraft={setDraft} save={save} />
          : isProposal ? <>
            <Field label="Research question" hint="One specific question a single study could answer." rows={2}
              value={draft.question ?? ""} onChange={v => setDraft({ ...draft, question: v })}
              onSave={() => draft.question !== project.data.question && save({ question: draft.question })} />
            <Field label="Hypothesis" hint="A prediction that could turn out false." rows={2}
              value={draft.hypothesis ?? ""} onChange={v => setDraft({ ...draft, hypothesis: v })}
              onSave={() => draft.hypothesis !== project.data.hypothesis && save({ hypothesis: draft.hypothesis })} />
            <div className="settings-label">The Heilmeier Catechism</div>
            {meta.heilmeier.map((q, i) => {
              const value = draft.answers?.[q.id] ?? "";
              const ok = value.trim().length >= meta.answer_min;
              return (
                <Field key={q.id} label={<>{ok ? <CheckCircle2 size={12} /> : <Circle size={12} />} {i + 1}. {q.question}</>}
                  hint={`At least ${meta.answer_min} characters.`} rows={3} value={value}
                  onChange={v => setDraft({ ...draft, answers: { ...(draft.answers ?? {}), [q.id]: v } })}
                  onSave={() => value !== (project.data.answers?.[q.id] ?? "") && save({ answers: { [q.id]: value } })} />
              );
            })}
          </> : <>
            <Field label="The paper" hint="Authors, year and title." rows={1} value={draft.paper ?? ""}
              onChange={v => setDraft({ ...draft, paper: v })} onSave={() => draft.paper !== project.data.paper && save({ paper: draft.paper })} />
            <Field label="The result you'll reproduce" hint="One claim, with the number or figure it rests on." rows={2} value={draft.claim ?? ""}
              onChange={v => setDraft({ ...draft, claim: v })} onSave={() => draft.claim !== project.data.claim && save({ claim: draft.claim })} />
            <Field label="Data" hint="Where it comes from, and how it differs from the paper's." rows={2} value={draft.data ?? ""}
              onChange={v => setDraft({ ...draft, data: v })} onSave={() => draft.data !== project.data.data && save({ data: draft.data })} />
            <div className="settings-label">Milestones</div>
            <ul className="research-checks research-steps">
              {meta.steps.map(s => {
                const done = !!project.data.steps?.[s.id];
                return (
                  <li key={s.id} className={done ? "met" : ""}>
                    <label><input type="checkbox" checked={done} onChange={e => { save({ steps: { [s.id]: e.target.checked } }); track("research.project.step"); }} /> {s.label}</label>
                  </li>
                );
              })}
            </ul>
            <Field label="Link to your plan or preregistration" hint="An OSF page, a document, or a file in your repository." rows={1} value={draft.prereg_url ?? ""}
              onChange={v => setDraft({ ...draft, prereg_url: v })} onSave={() => draft.prereg_url !== project.data.prereg_url && save({ prereg_url: draft.prereg_url })} />
            <Field label="Link to your code" hint="A repository people can run." rows={1} value={draft.code_url ?? ""}
              onChange={v => setDraft({ ...draft, code_url: v })} onSave={() => draft.code_url !== project.data.code_url && save({ code_url: draft.code_url })} />
            <Field label="What you found" hint="Your number next to theirs, and every difference explained." rows={3} value={draft.notes ?? ""}
              onChange={v => setDraft({ ...draft, notes: v })} onSave={() => draft.notes !== project.data.notes && save({ notes: draft.notes })} />
          </>}
          <div className="research-actions">
            <button className="btn-neutral danger" onClick={remove}><Trash2 size={14} /> Remove</button>
            {project.kind === "paper" && (
              <button className="btn-primary" disabled={!project.data.abstract}
                title={project.data.abstract ? "Defend the draft to a sceptical reviewer" : "Write the abstract first"}
                onClick={() => openMockWith({ scenario: "reviewer", subject: project.title, details: flatDetails(project, meta.kinds.paper) })}>
                <ShieldQuestion size={14} /> Defend to Reviewer 2
              </button>
            )}
            {project.kind === "review" && typeof project.data.link === "string" && project.data.link.trim() && (
              <button className="btn-neutral" onClick={() => openExternal(project.data.link as string)}>Open the public reviews</button>
            )}
            {project.kind === "talk" && (
              <button className="btn-primary" disabled={!project.data.message}
                title={project.data.message ? "Give the talk, then take the audience's questions" : "Write your one message first"}
                onClick={() => openMockWith({ scenario: "audience", subject: project.title, details: flatDetails(project, meta.kinds.talk) })}>
                <Mic size={14} /> Take the conference questions
              </button>
            )}
            {flat ? null : isProposal
              ? <button className="btn-primary" disabled={!project.data.question?.trim()}
                  title={project.data.question?.trim() ? "Defend it live to the proposal panel" : "Write your research question first"}
                  onClick={() => openMockWith({ scenario: "proposal", subject: project.data.question || project.title, details: proposalDetails(project, meta) })}>
                  <ShieldQuestion size={14} /> Defend to the proposal panel
                </button>
              : <button className="btn-primary" disabled={!project.data.claim?.trim()}
                  title={project.data.claim?.trim() ? "Defend the design to a sceptical reviewer" : "Write the result you'll reproduce first"}
                  onClick={() => openMockWith({ scenario: "reviewer", subject: project.title, details: replicationDetails(project, meta) })}>
                  <ShieldQuestion size={14} /> Defend to Reviewer 2
                </button>}
          </div>
        </div>
      )}
    </section>
  );
}

function FlatFields({ fields, project, draft, setDraft, save }: {
  fields: FlatField[]; project: Project; draft: Project["data"]; setDraft: (d: Project["data"]) => void;
  save: (data: Record<string, unknown>) => void;
}) {
  return <>{fields.map(f => {
    const value = typeof draft[f.id] === "string" ? (draft[f.id] as string) : "";
    if (f.options) {
      return (
        <div key={f.id} className="research-field">
          <div className="settings-label">{f.label}</div>
          <div className="research-passes">
            {f.options.map(o => (
              <button key={o} className={`scenario-option ${project.data[f.id] === o ? "active" : ""}`} onClick={() => save({ [f.id]: o })}>{o}</button>
            ))}
          </div>
        </div>
      );
    }
    const ok = !f.min || value.trim().length >= f.min;
    return (
      <Field key={f.id} rows={f.rows ?? 3} value={value}
        label={<>{f.min ? (ok ? <CheckCircle2 size={12} /> : <Circle size={12} />) : null} {f.label}{f.rows && f.rows > 3 ? <span className="muted"> · {countWords(value)} words</span> : null}</>}
        hint={f.hint ?? ""}
        onChange={v => setDraft({ ...draft, [f.id]: v })}
        onSave={() => value !== (project.data[f.id] ?? "") && save({ [f.id]: value })} />
    );
  })}</>;
}

const SPRINT_MINUTES = [25, 45, 60];

/**
 * A writing sprint: a fixed block of time on one piece of writing, counted in
 * words added. Short daily sessions beat waiting for inspiration (Boice).
 */
function Sprint({ project, text, onDone }: { project: Project; text: string; onDone: () => void }) {
  const [minutes, setMinutes] = useState(25);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const startWords = useRef(0);
  // What is on screen now, typed or saved: a sprint ended mid-sentence still counts it.
  const latest = useRef(text);
  latest.current = text;

  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  async function finish() {
    if (startedAt === null) return;
    const spent = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    const words = Math.max(0, countWords(latest.current) - startWords.current);
    setStartedAt(null);
    try {
      await researchApi.addSprint(spent, words, project.id);
      track("research.sprint");
      toast.success(`Sprint saved: ${spent} min, ${words} word${words === 1 ? "" : "s"} added`);
      onDone();
    } catch (e) { notifyError(e); }
  }

  const left = startedAt === null ? 0 : Math.max(0, minutes * 60 - Math.floor((now - startedAt) / 1000));
  useEffect(() => { if (startedAt !== null && left === 0) finish(); }, [left]);  // eslint-disable-line react-hooks/exhaustive-deps

  if (startedAt === null) {
    return (
      <div className="research-sprint">
        <Timer size={14} /> <span>Writing sprint</span>
        {SPRINT_MINUTES.map(m => (
          <button key={m} className={`scenario-option ${minutes === m ? "active" : ""}`} onClick={() => setMinutes(m)}>{m} min</button>
        ))}
        <button className="btn-neutral" onClick={() => { startWords.current = countWords(text); setStartedAt(Date.now()); setNow(Date.now()); }}>
          <PenLine size={14} /> Start
        </button>
      </div>
    );
  }
  return (
    <div className="research-sprint running">
      <Timer size={14} /> <b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</b>
      <span className="muted">Write; don't edit. Your words save as you leave each box.</span>
      <button className="btn-primary" onClick={finish}>Stop and save</button>
    </div>
  );
}

function Field({ label, hint, rows, value, onChange, onSave }:
  { label: React.ReactNode; hint: string; rows: number; value: string; onChange: (v: string) => void; onSave: () => void }) {
  return (
    <div className="research-field">
      <label className="settings-label">{label}</label>
      {rows === 1
        ? <input className="glass-input" placeholder={hint} value={value} onChange={e => onChange(e.target.value)} onBlur={onSave} />
        : <textarea className="glass-input" rows={rows} placeholder={hint} value={value} onChange={e => onChange(e.target.value)} onBlur={onSave} />}
    </div>
  );
}
