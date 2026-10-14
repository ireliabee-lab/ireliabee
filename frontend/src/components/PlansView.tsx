import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import ReactMarkdown from "react-markdown";
import {
  Plus, ArrowLeft, Link2, ClipboardPaste, Sparkles, Loader2, Trash2, Pencil, Search, Play, X, Clock,
  ListOrdered, MessageSquareText, HelpCircle, AlertTriangle, Target, ListChecks, Users, FileText, CalendarDays,
} from "lucide-react";
import ConfirmDialog from "./ConfirmDialog";
import { fetchApi } from "../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../lib/errors";
import { track } from "../lib/usage";
import { planFromAgenda, type AgendaPrep } from "../lib/planFromAgenda";
import Page, { PageTab } from "./Page";
import PeopleView from "./PeopleView";
import CalendarView from "./CalendarView";
import PlanPeople from "./PlanPeople";
import FilePicker from "./FilePicker";
import Illustration from "./Illustration";
import { AiSuggest, SuggestedChip, usePrefill } from "./Suggested";
import { withSuggestedItems, withSuggestion } from "../lib/suggestApi";
import type { CalEvent } from "../lib/calendar";
import {
  agendaSuggestionsFromEvent, meetingForNewPlan, planSuggestionsFromEvent, planSuggestionsFromJob,
} from "../lib/prefill";

interface Section { title: string; minutes: number | null; goal: string; }

export interface Plan {
  id?: number;
  title: string;
  counterparty: string;
  purpose: string;
  duration_min: number;
  sections: Section[];
  answers_prep: string[];
  questions_ask: string[];
  traps_avoid: string[];
  commitments: string[];
  notes: string;
  people_ids: number[];
  document_ids: number[];
  briefing?: string;
  updated_at?: string;
}

const EMPTY: Plan = {
  title: "", counterparty: "", purpose: "", duration_min: 45, sections: [],
  answers_prep: [], questions_ask: [], traps_avoid: [], commitments: [], notes: "", people_ids: [], document_ids: [],
};

async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetchApi(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

type PlanSource = "link" | "text" | "agenda";

/**
 * Plans, with People as a second tab (roadmap 2.6). `section="agenda"` (the
 * old Meeting Prep link) opens a new plan built from an agenda;
 * `section="people"` opens People.
 */
export default function PlansView({ section }: { section?: string } = {}) {
  const [tab, setTab] = useState<"plans" | "people" | "calendar">(section === "people" ? "people" : section === "calendar" ? "calendar" : "plans");
  // A plan drafted from a calendar invite is linked to that meeting when saved (roadmap 3.2).
  const [fromEvent, setFromEvent] = useState<number | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [editing, setEditing] = useState<Plan | null>(section === "agenda" ? { ...EMPTY } : null);
  const [newSource, setNewSource] = useState<PlanSource>(section === "agenda" ? "agenda" : "link");
  const startNew = (from: PlanSource) => { setNewSource(from); setEditing({ ...EMPTY }); };
  const [researching, setResearching] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Plan | null>(null);

  const load = () => api("/plans/").then(setPlans).catch(notifyError);
  useEffect(() => { load(); }, []);

  async function research(plan: Plan) {
    if (!(await ensureReady(["llm"]))) return;
    setResearching(plan.id!);
    try {
      const updated: Plan = await api(`/plans/${plan.id}/research`, "POST");
      setPlans(prev => prev.map(p => p.id === updated.id ? updated : p));
      if (editing?.id === updated.id) setEditing(e => e && { ...e, briefing: updated.briefing });
      toast.success(`Briefing ready for ${updated.counterparty}`);
    } catch (e) {
      notifyError(e);
    } finally {
      setResearching(null);
    }
  }

  async function remove(plan: Plan) {
    try {
      await api(`/plans/${plan.id}`, "DELETE");
      toast.success("Plan deleted");
      load();
    } catch (e) {
      notifyError(e);
    }
    setConfirmDelete(null);
  }

  function useInSession(plan: Plan) {
    track("plan.use_live");
    localStorage.setItem("activePlanId", String(plan.id));
    window.dispatchEvent(new CustomEvent("navigate", { detail: "session" }));
    toast.success(`"${plan.title}" is ready in your session`);
  }

  if (editing) {
    return (
      <PlanEditor
        initial={editing}
        initialSource={newSource}
        researching={researching === editing.id}
        onResearch={research}
        onCancel={() => { setEditing(null); setFromEvent(null); }}
        onSaved={saved => {
          if (fromEvent != null && saved.id != null) {
            api(`/calendar/events/${fromEvent}/plan`, "PUT", { plan_id: saved.id }).catch(notifyError);
          }
          setEditing(null); setFromEvent(null); load(); toast.success(`Saved "${saved.title}"`);
        }}
      />
    );
  }

  const tabs = <>
    <PageTab active={tab === "plans"} icon={<ListChecks size={14} />} onClick={() => setTab("plans")} count={plans.length}>Plans</PageTab>
    <PageTab active={tab === "people"} icon={<Users size={14} />} onClick={() => setTab("people")}>People</PageTab>
    <PageTab active={tab === "calendar"} icon={<CalendarDays size={14} />} onClick={() => setTab("calendar")}>Calendar</PageTab>
  </>;

  if (tab === "people") return <PeopleView tabs={tabs} />;
  if (tab === "calendar") return (
    <CalendarView
      tabs={tabs}
      onDraft={(draft, eventId) => {
        const { template: _t, kind: _k, ...fields } = draft;
        setFromEvent(eventId);
        setNewSource("agenda");
        setEditing({ ...EMPTY, ...fields });
      }}
      onOpenPlan={id => api(`/plans/${id}`).then(p => setEditing(p)).catch(notifyError)}
    />
  );

  return (
    <Page
      title="Plans"
      subtitle="Turn a job post or a meeting agenda into a game plan the coach follows during the call."
      tabs={tabs}
      actions={<>
        <button className="btn-neutral" onClick={() => startNew("agenda")}><ListChecks size={14} /> From an agenda</button>
        <button className="btn-primary" onClick={() => startNew("link")}><Plus size={14} /> New plan</button>
      </>}
    >
    <div className="page-content">

      {plans.length === 0 ? (
        <div className="glass-card plans-empty">
          <Illustration name="plan" />
          <div className="plans-empty-title">No plans yet</div>
          <p className="muted">Paste a job link or description and get an agenda, likely questions with your best examples, traps to avoid and questions to ask.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <button className="btn-primary" onClick={() => startNew("link")}><Sparkles size={14} /> From a job post</button>
            <button className="btn-neutral" onClick={() => startNew("agenda")}><ListChecks size={14} /> From a meeting agenda</button>
          </div>
        </div>
      ) : (
        <div className="plans-grid">
          {plans.map(p => (
            <article key={p.id} className="glass-card plan-card">
              <div className="plan-card-top">
                <div style={{ minWidth: 0 }}>
                  <div className="plan-card-title">{p.title}</div>
                  {p.counterparty && <div className="plan-card-company">{p.counterparty}</div>}
                </div>
                {p.briefing && <span className="plan-badge" title="Company research briefing added">Researched</span>}
              </div>
              {p.purpose && <p className="plan-card-purpose">{p.purpose}</p>}
              <div className="plan-card-stats">
                <span><Clock size={11} /> {p.duration_min} min</span>
                <span><ListOrdered size={11} /> {p.sections.length} agenda</span>
                <span><MessageSquareText size={11} /> {p.answers_prep.length} answers</span>
              </div>
              <div className="plan-card-actions">
                <button className="btn-primary" onClick={() => useInSession(p)}><Play size={12} /> Use in session</button>
                <button className="btn-neutral" onClick={() => setEditing(p)} title="Edit"><Pencil size={12} /></button>
                <button className="btn-neutral" onClick={() => research(p)} disabled={researching === p.id} title="Research the company or interviewer">
                  {researching === p.id ? <Loader2 size={12} className="spin" /> : <Search size={12} />}
                </button>
                <button className="btn-neutral danger" onClick={() => setConfirmDelete(p)} title="Delete"><Trash2 size={12} /></button>
              </div>
            </article>
          ))}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          message={`Delete "${confirmDelete.title}"?`}
          detail="This plan and its briefing will be permanently removed."
          confirmLabel="Delete"
          onConfirm={() => remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
    </Page>
  );
}

function PlanEditor({ initial, initialSource = "link", researching, onResearch, onCancel, onSaved }: {
  initial: Plan;
  initialSource?: PlanSource;
  researching: boolean;
  onResearch: (plan: Plan) => void;
  onCancel: () => void;
  onSaved: (plan: Plan) => void;
}) {
  const [plan, setPlan] = useState<Plan>(initial);
  const [source, setSource] = useState<PlanSource>(initialSource);
  const [url, setUrl] = useState("");
  const [jobText, setJobText] = useState("");
  const [agendaBox, setAgendaBox] = useState({ agenda: "", context: "" });
  const agenda = agendaBox.agenda, agendaContext = agendaBox.context;
  const setAgenda = (v: string) => setAgendaBox(b => ({ ...b, agenda: v }));
  const setAgendaContext = (v: string) => setAgendaBox(b => ({ ...b, context: v }));
  const [importing, setImporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const isNew = plan.id == null;

  useEffect(() => { setPlan(p => ({ ...p, briefing: initial.briefing })); }, [initial.briefing]);

  // Free suggestions for a new plan (lib/prefill.ts), no AI: title and company
  // from the job link or description as it's pasted, else from the next
  // meeting today that has no plan; the agenda boxes from that meeting's invite.
  const [events, setEvents] = useState<CalEvent[]>([]);
  useEffect(() => {
    if (!isNew) return;
    let alive = true;
    fetchApi("/calendar/events?days=1").then(r => (r.ok ? r.json() : [])).then(e => alive && setEvents(Array.isArray(e) ? e : [])).catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const meeting = isNew ? meetingForNewPlan(events) : null;
  const fromJob = isNew ? planSuggestionsFromJob({ url: source === "link" ? url : "", text: source === "text" ? jobText : "" }) : {};
  const planPrefill = usePrefill(plan, setPlan, Object.keys(fromJob).length || !meeting ? fromJob : planSuggestionsFromEvent(meeting));
  const agendaPrefill = usePrefill(agendaBox, setAgendaBox, meeting && source === "agenda" ? agendaSuggestionsFromEvent(meeting) : {});
  const chip = (field: "title" | "counterparty") => planPrefill.isSuggested(field)
    ? <SuggestedChip source={planPrefill.sourceOf(field)} onClear={() => planPrefill.clear(field)} /> : null;
  const suggested = (field: "title" | "counterparty") => planPrefill.isSuggested(field) ? " is-suggested" : "";

  // What the paid AI Suggest reads (backend/routers/suggest.py): this form, never a name or contact detail.
  const suggestForm = () => ({
    title: plan.title, counterparty: plan.counterparty, purpose: plan.purpose, duration_min: plan.duration_min,
    job: source === "text" ? jobText : source === "link" ? url : "", agenda: source === "agenda" ? agenda : "",
    context: source === "agenda" ? agendaContext : "",
    sections: plan.sections, answers_prep: plan.answers_prep, questions_ask: plan.questions_ask,
    traps_avoid: plan.traps_avoid, commitments: plan.commitments, notes: plan.notes,
  });
  // Paid Suggest for a list box: new items go under the ones already there.
  const listSuggest = (key: "questions_ask" | "traps_avoid" | "commitments", label: string) => (
    <AiSuggest<string[]> field={`plan.${key}`} label={label} shape="list" form={suggestForm}
      ready={hasContext} notReadyHint="Fill in the title or company first"
      onSuggest={items => setPlan(p => ({ ...p, [key]: withSuggestedItems(p[key], items) }))} />
  );
  const hasContext = Boolean(plan.title.trim() || plan.counterparty.trim() || jobText.trim() || url.trim() || agenda.trim());

  const set = <K extends keyof Plan>(key: K, value: Plan[K]) => setPlan(p => ({ ...p, [key]: value }));
  const agendaMinutes = plan.sections.reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);

  // Meeting agenda → likely questions, talking points and risks (roadmap 1.5,
  // formerly the Meeting Prep page), mapped into the plan for review.
  async function generateFromAgenda() {
    if (agenda.trim().length < 10) { toast("Add a short agenda or a few bullet points first", { icon: "📋" }); return; }
    if (!(await ensureReady(["llm"]))) return;
    setImporting(true);
    try {
      const cfg = await fetchApi("/config").then(r => r.json()).catch(() => ({}));
      track("plan.from_agenda");
      const prep: AgendaPrep = await api("/meeting-prep/", "POST", { agenda, context: agendaContext, model: cfg?.saved?.model });
      setPlan(p => planFromAgenda(p, agenda, prep));
      toast.success("Plan drafted from the agenda — review it, then save");
    } catch (e) {
      notifyError(e);
    } finally {
      setImporting(false);
    }
  }

  async function generate() {
    if (source === "agenda") return generateFromAgenda();
    const body = source === "link" ? { url: url.trim() } : { text: jobText.trim() };
    if (!(body as any).url && !(body as any).text) {
      toast(source === "link" ? "Paste a job link first" : "Paste the job description first", { icon: "📋" });
      return;
    }
    if (!(await ensureReady(["llm"]))) return;
    setImporting(true);
    try {
      const draft = await api("/plans/import", "POST", body);
      setPlan(p => ({ ...p, ...draft, id: p.id, briefing: p.briefing }));
      toast.success("Plan drafted — review it, then save");
    } catch (e) {
      notifyError(e);
    } finally {
      setImporting(false);
    }
  }

  async function save() {
    if (!plan.title.trim()) { toast.error("Give the plan a title"); return; }
    setSaving(true);
    try {
      const saved: Plan = isNew ? await api("/plans/", "POST", plan) : await api(`/plans/${plan.id}`, "PUT", plan);
      onSaved(saved);
    } catch (e) {
      notifyError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page
      title={isNew ? "New plan" : plan.title || "Edit plan"}
      subtitle={isNew ? "Fill it from a job post or agenda, or write it yourself. The coach follows it during the call." : plan.counterparty || "Edit the plan the coach follows during the call."}
      actions={<>
        <button className="btn-neutral" onClick={onCancel}><ArrowLeft size={14} /> All plans</button>
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : null} {isNew ? "Save plan" : "Save changes"}
        </button>
      </>}
    >
    <div className="page-content">
    <div className="page-split plan-editor">
      <aside className="page-side">
      <section className="glass-card plan-import">
        <div className="plan-import-head">
          <Sparkles size={16} />
          <div>
            <div className="plan-section-title">{source === "agenda" ? "Fill this plan from a meeting agenda" : "Fill this plan from a job post"}</div>
            <p className="muted">{source === "agenda"
              ? "The coach reads the agenda, then drafts the questions you'll likely face, what to watch out for and your talking points."
              : "The coach reads the posting and your profile, then drafts everything below."}</p>
          </div>
        </div>
        <div className="voice-gender plan-source">
          <button className={source === "link" ? "active" : ""} onClick={() => setSource("link")}><Link2 size={12} /> Job link</button>
          <button className={source === "text" ? "active" : ""} onClick={() => setSource("text")}><ClipboardPaste size={12} /> Paste description</button>
          <button className={source === "agenda" ? "active" : ""} onClick={() => setSource("agenda")}><ListChecks size={12} /> Meeting agenda</button>
        </div>
        {source === "agenda" ? (
          <>
            <div className="label-row">
              {agendaPrefill.isSuggested("agenda") && <SuggestedChip source={agendaPrefill.sourceOf("agenda")} onClear={() => agendaPrefill.clear("agenda")} />}
              <AiSuggest<string> field="plan.agenda" label="Meeting agenda" length="long" form={suggestForm}
                ready={hasContext} notReadyHint="Fill in the title or company first"
                onSuggest={text => setAgendaBox(b => ({ ...b, agenda: withSuggestion(b.agenda, text) }))} />
            </div>
            <textarea className={`glass-input${agendaPrefill.isSuggested("agenda") ? " is-suggested" : ""}`} rows={5} value={agenda} onChange={e => setAgenda(e.target.value)}
              placeholder="What the meeting is about, and the points on the agenda…" style={{ resize: "vertical" }} />
            <div className="label-row">
              {agendaPrefill.isSuggested("context") && <SuggestedChip source={agendaPrefill.sourceOf("context")} onClear={() => agendaPrefill.clear("context")} />}
              <AiSuggest<string> field="plan.context" label="Meeting context: who you're meeting and the stakes" length="long" form={suggestForm}
                ready={hasContext || Boolean(agenda.trim())} notReadyHint="Fill in the agenda or title first"
                onSuggest={text => setAgendaBox(b => ({ ...b, context: withSuggestion(b.context, text) }))} />
            </div>
            <textarea className={`glass-input${agendaPrefill.isSuggested("context") ? " is-suggested" : ""}`} rows={2} value={agendaContext} onChange={e => setAgendaContext(e.target.value)}
              placeholder="Context (optional): who you're meeting, the stakes, anything they might push on…" style={{ resize: "vertical" }} />
          </>
        ) : source === "link" ? (
          <input className="glass-input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://jobs.example.com/backend-engineer" />
        ) : (
          <textarea className="glass-input" rows={5} value={jobText} onChange={e => setJobText(e.target.value)} placeholder="Paste the full job description…" style={{ resize: "vertical" }} />
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 11 }}>{source === "agenda" ? "Anything you've already typed below is kept — the draft adds to it." : "LinkedIn and some job boards need a sign-in — paste the description for those."}</span>
          <button className="btn-primary" onClick={generate} disabled={importing}>
            {importing ? <><Loader2 size={14} className="spin" /> {source === "agenda" ? "Reading the agenda…" : "Reading the job post…"}</> : <><Sparkles size={14} /> Generate plan</>}
          </button>
        </div>
      </section>

      <PlanPeople ids={plan.people_ids ?? []} onChange={ids => set("people_ids", ids)} />

      <section className="glass-card plan-people">
        <div className="plan-people-head">
          <FileText size={15} />
          <div>
            <div className="plan-section-title">Files for this meeting</div>
            <p className="muted">The job spec, their deck, your notes. The live coach reads them whenever this plan is used, and practice builds questions from them.</p>
          </div>
        </div>
        <FilePicker value={plan.document_ids ?? []} onChange={ids => set("document_ids", ids)} />
      </section>

      {!isNew && (
        <section className="glass-card plan-side-card">
          <PlanBlock icon={<Search size={14} />} title="Research briefing" hint={
            <button className="btn-neutral small" onClick={() => onResearch(plan)} disabled={researching || !plan.counterparty.trim()}>
              {researching ? <><Loader2 size={12} className="spin" /> Researching…</> : plan.briefing ? "Refresh" : "Research"}
            </button>
          }>
            {plan.briefing
              ? <div className="markdown-body plan-briefing"><ReactMarkdown>{plan.briefing}</ReactMarkdown></div>
              : <p className="muted" style={{ fontSize: 12 }}>Look up the company or interviewer on the web, GitHub and Semantic Scholar, and summarise what's worth knowing.</p>}
          </PlanBlock>
        </section>
      )}
      </aside>

      <section className={`glass-card plan-form ${importing ? "is-loading" : ""}`}>
        <div className="plan-grid-2">
          <Field label="Title *" extra={<>{chip("title")}
            <AiSuggest<string> field="plan.title" label="Plan title" value={plan.title} form={suggestForm}
              onSuggest={text => setPlan(p => (p.title.trim() ? p : { ...p, title: text }))} /></>}>
            <input className={`glass-input${suggested("title")}`} value={plan.title} onChange={e => set("title", e.target.value)} placeholder="Acme — Backend Engineer interview" />
          </Field>
          <Field label="Company or interviewer" extra={<>{chip("counterparty")}
            <AiSuggest<string> field="plan.counterparty" label="Company or team" value={plan.counterparty} form={suggestForm}
              onSuggest={text => setPlan(p => (p.counterparty.trim() ? p : { ...p, counterparty: text }))} /></>}>
            <input className={`glass-input${suggested("counterparty")}`} value={plan.counterparty} onChange={e => set("counterparty", e.target.value)} placeholder="Acme, Payments team" />
          </Field>
        </div>
        <div className="plan-grid-2 purpose">
          <Field label="What you want from this interview" extra={
            <AiSuggest<string>
              field="plan.purpose"
              label="What you want from this interview"
              value={plan.purpose}
              ready={hasContext}
              notReadyHint="Fill in the title or company first"
              form={suggestForm}
              onSuggest={text => setPlan(p => (p.purpose.trim() ? p : { ...p, purpose: text }))}
            />
          }>
            <input className="glass-input" value={plan.purpose} onChange={e => set("purpose", e.target.value)} placeholder="Show I can own reliable APIs and get to the next round" />
          </Field>
          <Field label="Length (minutes)">
            <input className="glass-input" type="number" min={5} max={240} value={plan.duration_min} onChange={e => set("duration_min", Number(e.target.value) || 0)} />
          </Field>
        </div>

        <PlanBlock icon={<ListOrdered size={14} />} title="Agenda" hint={<>
          {plan.sections.length ? (
            <span className={agendaMinutes === plan.duration_min ? "plan-total ok" : "plan-total"}>
              {agendaMinutes} / {plan.duration_min} min
            </span>
          ) : null}
          {/* Sections come back as "Section — goal"; minutes are left to the person. */}
          <AiSuggest<string[]> field="plan.sections" label="Agenda sections, each as: section — goal for it" shape="list"
            form={suggestForm} ready={hasContext} notReadyHint="Fill in the title or company first"
            onSuggest={items => setPlan(p => ({
              ...p,
              sections: [...p.sections.filter(x => x.title.trim() || x.goal.trim()), ...items.map(item => {
                const [title, ...goal] = item.split(/\s+[—–-]\s+/);
                return { title: title.trim(), minutes: null, goal: goal.join(" — ").trim() };
              })],
            }))} />
        </>}>
          {plan.sections.map((s, i) => (
            <div key={i} className="agenda-row">
              <span className="agenda-index">{i + 1}</span>
              <input className="glass-input" value={s.title} placeholder="Section" onChange={e => set("sections", plan.sections.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} />
              <input className="glass-input agenda-min" type="number" min={0} value={s.minutes ?? ""} placeholder="min" onChange={e => set("sections", plan.sections.map((x, j) => j === i ? { ...x, minutes: e.target.value === "" ? null : Number(e.target.value) } : x))} />
              <input className="glass-input agenda-goal" value={s.goal} placeholder="Goal for this part" onChange={e => set("sections", plan.sections.map((x, j) => j === i ? { ...x, goal: e.target.value } : x))} />
              <button className="icon-btn" onClick={() => set("sections", plan.sections.filter((_, j) => j !== i))} title="Remove"><X size={13} /></button>
            </div>
          ))}
          <button className="add-row" onClick={() => set("sections", [...plan.sections, { title: "", minutes: null, goal: "" }])}><Plus size={12} /> Add section</button>
        </PlanBlock>

        <div className="plan-lists">
        <ListBlock icon={<MessageSquareText size={14} />} title="Prepared answers" hint="Likely questions and the example you'll use" items={plan.answers_prep} onChange={v => set("answers_prep", v)} placeholder="Tell me about a hard bug → the WebSocket pipeline drop issue…"
          extra={
            <AiSuggest<string[]>
              field="plan.answers_prep"
              ready={hasContext}
              notReadyHint="Fill in the title or company first"
              form={suggestForm}
              // Added under what is there; nothing typed is replaced.
              label="Prepared answers"
              shape="list"
              onSuggest={items => setPlan(p => ({ ...p, answers_prep: withSuggestedItems(p.answers_prep, items) }))}
            />
          } />
        <ListBlock icon={<HelpCircle size={14} />} title="Questions to ask them" items={plan.questions_ask} onChange={v => set("questions_ask", v)} placeholder="How does the team handle on-call?"
          extra={listSuggest("questions_ask", "Questions to ask them")} />
        <ListBlock icon={<AlertTriangle size={14} />} title="Traps to avoid" items={plan.traps_avoid} onChange={v => set("traps_avoid", v)} placeholder="Don't overstate Kubernetes experience"
          extra={listSuggest("traps_avoid", "Traps to avoid")} />
        <ListBlock icon={<Target size={14} />} title="Leave the interview with" items={plan.commitments} onChange={v => set("commitments", v)} placeholder="Clear next steps and timeline"
          extra={listSuggest("commitments", "What to leave the meeting with")} />
        </div>

        <PlanBlock icon={<Pencil size={14} />} title="Notes" hint={
          <AiSuggest<string> field="plan.notes" label="Notes: must-haves and things to remember" length="long" form={suggestForm}
            ready={hasContext} notReadyHint="Fill in the title or company first"
            onSuggest={text => setPlan(p => ({ ...p, notes: withSuggestion(p.notes, text) }))} />
        }>
          <textarea className="glass-input" rows={4} value={plan.notes} onChange={e => set("notes", e.target.value)} placeholder="Must-have requirements, things to remember…" style={{ resize: "vertical" }} />
        </PlanBlock>

      </section>
    </div>
    </div>
    </Page>
  );
}

function Field({ label, extra, children }: { label: string; extra?: React.ReactNode; children: React.ReactNode }) {
  if (!extra) return <div><label className="settings-label">{label}</label>{children}</div>;
  return <div><div className="label-row"><label className="settings-label">{label}</label>{extra}</div>{children}</div>;
}

function PlanBlock({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="plan-block">
      <div className="plan-block-head">
        <span className="plan-block-icon">{icon}</span>
        <span className="plan-section-title">{title}</span>
        {hint && <span className="plan-block-hint">{hint}</span>}
      </div>
      <div className="plan-block-body">{children}</div>
    </div>
  );
}

function ListBlock({ icon, title, hint, extra, items, onChange, placeholder }: {
  icon: React.ReactNode; title: string; hint?: string; extra?: React.ReactNode; items: string[]; onChange: (v: string[]) => void; placeholder: string;
}) {
  const hintNode = hint || extra
    ? <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>{hint}{extra}</span>
    : undefined;
  return (
    <PlanBlock icon={icon} title={title} hint={hintNode}>
      {items.map((item, i) => (
        <div key={i} className="list-row">
          <textarea
            className="glass-input"
            rows={Math.min(4, Math.max(1, Math.ceil(item.length / 90)))}
            value={item}
            placeholder={placeholder}
            onChange={e => onChange(items.map((x, j) => j === i ? e.target.value : x))}
            style={{ resize: "vertical" }}
          />
          <button className="icon-btn" onClick={() => onChange(items.filter((_, j) => j !== i))} title="Remove"><X size={13} /></button>
        </div>
      ))}
      <button className="add-row" onClick={() => onChange([...items, ""])}><Plus size={12} /> Add</button>
    </PlanBlock>
  );
}
