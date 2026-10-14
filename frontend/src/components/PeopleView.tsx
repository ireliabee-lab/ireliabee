import { useEffect, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import {
  ArrowLeft, Search, BookOpen, PenLine, Check, Loader2, Plus, RefreshCw, Pencil, Trash2, UserSearch,
  Sparkles, Target, MessageCircle, Handshake, Lightbulb, MessagesSquare, ShieldAlert, AlertTriangle,
  HelpCircle, Link2, Info, KeyRound, ShieldCheck,
} from "lucide-react";
import Page from "./Page";
import ConfirmDialog from "./ConfirmDialog";
import { fetchApi } from "../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../lib/errors";
import { openExternal } from "../lib/openExternal";
import { track } from "../lib/usage";
import Illustration from "./Illustration";
import { AiSuggest, SuggestLabel } from "./Suggested";

export interface Source { n: number; title: string; url: string; source: string; tier?: "official" | "reference" | "news" | "record" | "secondary"; }
export interface Brief {
  identity?: { summary?: string; confidence?: "high" | "medium" | "low"; note?: string };
  snapshot?: string[];
  cares_about?: string[];
  style?: string;
  common_ground?: string[];
  win_them_over?: string[];
  openers?: string[];
  they_may_ask?: { question: string; answer: string }[];
  objections?: { concern: string; response: string }[];
  watch_outs?: string[];
  gaps?: string[];
  sources?: Source[];
  search_engine?: string | null;
  problems?: string[];
  unconfirmed?: string[];
  verification?: { ran: boolean; checked: number; removed: number; unconfirmed: number; bad_citations?: number };
}
export interface Person {
  id: number;
  name: string;
  organisation: string;
  role: string;
  links: string[];
  known: string;
  purpose: string;
  status: "new" | "running" | "done" | "failed";
  stage: "" | "search" | "read" | "write" | "check";
  error: { title: string; message: string } | null;
  brief: Brief | null;
  sources_checked: number;
  researched_at: string | null;
  updated_at: string;
}

const STEPS = [
  { id: "search", label: "Searching", hint: "Their work, talks, interviews, writing and their organisation's news", icon: <Search size={14} /> },
  { id: "read",   label: "Reading pages", hint: "Your links first, then the most relevant results", icon: <BookOpen size={14} /> },
  { id: "write",  label: "Writing your brief", hint: "Checking it's the right person, then how to win them over", icon: <PenLine size={14} /> },
  { id: "check",  label: "Checking every fact", hint: "Each claim against the source it cites — unsupported ones are removed", icon: <ShieldCheck size={14} /> },
] as const;

const TIER_LABEL: Record<NonNullable<Source["tier"]>, { label: string; hint: string }> = {
  official:  { label: "Official",  hint: "Their organisation, an institution, or a link you gave" },
  reference: { label: "Reference", hint: "Encyclopedia" },
  news:      { label: "News",      hint: "Established publication" },
  record:    { label: "Record",    hint: "Their own papers or code" },
  secondary: { label: "Secondary", hint: "Blog, forum or aggregator — weakest; not used alone for facts" },
};

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetchApi(path, {
    method, headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join("");
const describe = (p: Pick<Person, "role" | "organisation">) => [p.role, p.organisation].filter(Boolean).join(" · ");

function formatDate(iso: string | null) {
  if (!iso) return "";
  return new Date(iso + (iso.endsWith("Z") ? "" : "Z")).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/** Start research after checking a model is set up; returns the updated person. */
export async function startResearch(id: number): Promise<Person | null> {
  if (!(await ensureReady(["llm"]))) return null;
  track("people.research");
  try { return await api<Person>(`/people/${id}/research`, "POST"); }
  catch (e) { notifyError(e); return null; }
}

/** Poll people while any is researching. */
function usePolling(active: boolean, tick: () => void) {
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(tick, 1500);
    return () => window.clearInterval(t);
  }, [active, tick]);
}

export function StatusChip({ person }: { person: Person }) {
  if (person.status === "running") {
    const step = STEPS.find(s => s.id === person.stage);
    return <span className="person-status running"><Loader2 size={11} className="spin" /> {step?.label ?? "Starting"}…</span>;
  }
  if (person.status === "done") return <span className="person-status done"><Check size={11} /> Brief ready</span>;
  if (person.status === "failed") return <span className="person-status failed"><AlertTriangle size={11} /> Didn't finish</span>;
  return <span className="person-status">Not researched</span>;
}

/** People tab of Plans (roadmap 2.6): research anyone you're meeting. */
export default function PeopleView({ tabs }: { tabs: ReactNode }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [engine, setEngine] = useState<string | null | undefined>(undefined);
  const [openId, setOpenId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Person | "new" | null>(null);

  const load = async () => {
    try { setPeople(await api<Person[]>("/people/")); }
    catch { setPeople([]); }
  };
  useEffect(() => {
    load();
    api<{ web_search: string | null }>("/people/sources").then(s => setEngine(s.web_search)).catch(() => setEngine(null));
  }, []);
  usePolling(!!people?.some(p => p.status === "running"), load);

  const open = people?.find(p => p.id === openId) ?? null;

  if (editing) {
    return (
      <PersonForm
        initial={editing === "new" ? null : editing}
        onCancel={() => setEditing(null)}
        onSaved={async (p, research) => {
          setEditing(null);
          setOpenId(p.id);
          if (research) await startResearch(p.id);
          await load();
        }}
      />
    );
  }

  if (open) {
    return (
      <PersonDetail
        person={open}
        engine={engine}
        onBack={() => setOpenId(null)}
        onEdit={() => setEditing(open)}
        onChanged={load}
        onDeleted={() => { setOpenId(null); load(); }}
      />
    );
  }

  return (
    <Page
      title="Plans"
      subtitle="Research anyone you're meeting — a hiring manager, an examiner, a client or a whole panel — and walk in knowing how to win them over."
      actions={<button className="btn-primary" onClick={() => setEditing("new")}><UserSearch size={14} /> Research someone</button>}
      tabs={tabs}
    >
      <div className="page-content">
        {engine === null && <WebSearchNotice />}
        {people == null ? null : people.length === 0 ? (
          <div className="glass-card plans-empty">
            <Illustration name="people" />
            <div className="plans-empty-title">Who are you meeting?</div>
            <p className="muted">
              Add their name and where they work. iReliabee looks up their work, talks, interviews and writing,
              checks it's the right person, and writes a brief: what they care about, common ground with your
              experience, openers, the questions they'll likely ask and how to answer.
            </p>
            <button className="btn-primary" onClick={() => setEditing("new")}><UserSearch size={14} /> Research someone</button>
          </div>
        ) : (
          <div className="card-grid">
            {people.map(p => (
              <button key={p.id} className="glass-card person-card" onClick={() => setOpenId(p.id)}>
                <span className="person-avatar">{initials(p.name)}</span>
                <span className="person-card-main">
                  <strong>{p.name}</strong>
                  <span className="muted">{describe(p) || "—"}</span>
                  {p.brief?.identity?.summary && <span className="person-card-summary">{stripCites(p.brief.identity.summary)}</span>}
                </span>
                <span className="person-card-foot">
                  <StatusChip person={p} />
                  {p.researched_at && p.status !== "running" && <span className="muted">{formatDate(p.researched_at)}</span>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}

function WebSearchNotice() {
  return (
    <div className="glass-card research-notice">
      <KeyRound size={16} />
      <div>
        <strong>Web search is off.</strong>{" "}
        <span className="muted">
          Research still uses Wikipedia, Hacker News, papers, GitHub and the links you give, but a free Tavily or
          Brave Search key finds far more — news, interviews, talks and company pages.
        </span>
      </div>
      <button className="btn-neutral" onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "settings" }))}>
        Add a key
      </button>
    </div>
  );
}

// ─── Create / edit ──────────────────────────────────────────────────────────
function PersonForm({ initial, onCancel, onSaved }: {
  initial: Person | null;
  onCancel: () => void;
  onSaved: (p: Person, research: boolean) => void;
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? "", organisation: initial?.organisation ?? "", role: initial?.role ?? "",
    purpose: initial?.purpose ?? "", links: (initial?.links ?? []).join("\n"), known: initial?.known ?? "",
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  async function save(research: boolean) {
    if (!form.name.trim()) { toast.error("Add their name"); return; }
    setSaving(true);
    const body = { ...form, links: form.links.split(/\s*\n\s*|\s*,\s*/).filter(Boolean) };
    try {
      const saved = initial ? await api<Person>(`/people/${initial.id}`, "PUT", body) : await api<Person>("/people/", "POST", body);
      onSaved(saved, research);
    } catch (e) { notifyError(e); }
    finally { setSaving(false); }
  }

  return (
    <Page
      title={initial ? `Edit ${initial.name}` : "Research someone"}
      subtitle="The more you tell it, the surer it is that it has the right person — names are shared."
      actions={<>
        <button className="btn-neutral" onClick={onCancel}><ArrowLeft size={14} /> Back</button>
        <button className="btn-neutral" onClick={() => save(false)} disabled={saving}>Save</button>
        <button className="btn-primary" onClick={() => save(true)} disabled={saving}>
          {saving ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Save and research
        </button>
      </>}
    >
      <div className="page-content">
        <div className="page-split">
          <section className="glass-card person-form">
            <div className="plan-grid-2">
              <div><label className="settings-label">Name *</label><input className="glass-input" value={form.name} onChange={set("name")} placeholder="Ada Mensah" autoFocus /></div>
              <div><label className="settings-label">Organisation</label><input className="glass-input" value={form.organisation} onChange={set("organisation")} placeholder="Acme Payments" /></div>
            </div>
            <div className="plan-grid-2">
              <div><label className="settings-label">Role</label><input className="glass-input" value={form.role} onChange={set("role")} placeholder="Head of Data" /></div>
              <div><SuggestLabel label="Why you're meeting">
                <AiSuggest<string> field="person.purpose" label="Why you're meeting them" value={form.purpose}
                  form={() => ({ purpose: form.purpose, role: form.role, organisation: form.organisation })}
                  onSuggest={text => setForm(f => (f.purpose.trim() ? f : { ...f, purpose: text }))} />
              </SuggestLabel><input className="glass-input" value={form.purpose} onChange={set("purpose")} placeholder="Final-round interview for the analytics lead role" /></div>
            </div>
            <div>
              <label className="settings-label">Links (one per line)</label>
              <textarea className="glass-input" rows={3} value={form.links} onChange={set("links")} style={{ resize: "vertical" }}
                placeholder={"Their personal site, company bio page, a talk or article…\nhttps://acme.com/team/ada"} />
            </div>
            <div>
              <label className="settings-label">What you already know</label>
              <textarea className="glass-input" rows={6} value={form.known} onChange={set("known")} style={{ resize: "vertical" }}
                placeholder="Anything useful: what the recruiter told you, their LinkedIn About and Experience (paste the text), a post they wrote…" />
            </div>
          </section>
          <aside className="page-side">
            <section className="glass-card progress-card">
              <header><Info size={14} /> What research covers</header>
              <ul className="progress-focus">
                <li>Their public professional footprint: roles, projects, talks, interviews, writing and their organisation's news.</li>
                <li>Pages you link are read first. LinkedIn can't be read automatically — paste the text under "What you already know".</li>
                <li>Every fact in the brief links to its source, and it says when it isn't sure it's the right person.</li>
                <li>Personal life — home, family, health, politics, religion, private accounts — is left out.</li>
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </Page>
  );
}

// ─── Detail ─────────────────────────────────────────────────────────────────
function PersonDetail({ person, engine, onBack, onEdit, onChanged, onDeleted }: {
  person: Person;
  engine: string | null | undefined;
  onBack: () => void;
  onEdit: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [wasRunning, setWasRunning] = useState(person.status === "running");
  useEffect(() => {
    if (person.status === "running") setWasRunning(true);
    else if (wasRunning) {
      setWasRunning(false);
      if (person.status === "done") toast.success(`Brief on ${person.name} is ready`);
    }
  }, [person.status]);  // eslint-disable-line react-hooks/exhaustive-deps

  const research = async () => { if (await startResearch(person.id)) onChanged(); };
  const remove = async () => {
    setConfirm(false);
    try { await api(`/people/${person.id}`, "DELETE"); toast.success("Removed"); onDeleted(); }
    catch (e) { notifyError(e); }
  };

  const brief = person.brief;
  const running = person.status === "running";

  return (
    <Page
      title={person.name}
      subtitle={describe(person) || "Add their organisation and role to sharpen the research."}
      actions={<>
        <button className="btn-neutral" onClick={onBack}><ArrowLeft size={14} /> All people</button>
        <button className="btn-neutral" onClick={onEdit} disabled={running}><Pencil size={13} /> Edit</button>
        <button className="btn-primary" onClick={research} disabled={running}>
          {running ? <Loader2 size={14} className="spin" /> : brief ? <RefreshCw size={14} /> : <Sparkles size={14} />}
          {running ? "Researching…" : brief ? "Research again" : "Research now"}
        </button>
      </>}
    >
      <div className="page-content">
        {engine === null && !brief && <WebSearchNotice />}
        <div className="page-split">
          <div className="person-main">
            {running && <Progress stage={person.stage} />}
            {person.status === "failed" && person.error && (
              <div className="glass-card card-error">
                <strong>{person.error.title}</strong>
                <span>{person.error.message}</span>
                <button onClick={research}><RefreshCw size={12} /> Try again</button>
              </div>
            )}
            {!running && !brief && person.status !== "failed" && (
              <div className="glass-card plans-empty">
                <Illustration name="research" />
                <div className="plans-empty-title">Ready to research {person.name.split(" ")[0]}</div>
                <p className="muted">Takes about a minute. You can leave this screen — it keeps going.</p>
                <button className="btn-primary" onClick={research}><Sparkles size={14} /> Research now</button>
              </div>
            )}
            {brief && <BriefView brief={brief} dimmed={running} />}
          </div>

          <aside className="page-side">
            <section className="glass-card person-facts">
              <div className="person-facts-head">
                <span className="person-avatar big">{initials(person.name)}</span>
                <div>
                  <strong>{person.name}</strong>
                  <span className="muted">{describe(person) || "—"}</span>
                </div>
              </div>
              {person.purpose && <p><span className="settings-label">Why you're meeting</span>{person.purpose}</p>}
              {person.links.length > 0 && (
                <div className="person-links">
                  <span className="settings-label">Links</span>
                  {person.links.map(l => (
                    <button key={l} className="person-link" onClick={() => openExternal(l)} title={l}><Link2 size={11} /> {hostOf(l)}</button>
                  ))}
                </div>
              )}
              {person.researched_at && <p className="muted person-meta">Researched {formatDate(person.researched_at)} · {person.sources_checked} sources checked</p>}
              <button className="btn-neutral danger person-delete" onClick={() => setConfirm(true)}><Trash2 size={12} /> Remove</button>
            </section>
            {brief?.sources && brief.sources.length > 0 && <SourcesCard brief={brief} />}
          </aside>
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          message={`Remove ${person.name}?`}
          detail="Their brief is deleted and they're unlinked from any plan."
          confirmLabel="Remove"
          onConfirm={remove}
          onCancel={() => setConfirm(false)}
        />
      )}
    </Page>
  );
}

function Progress({ stage }: { stage: Person["stage"] }) {
  const at = Math.max(0, STEPS.findIndex(s => s.id === stage));
  return (
    <section className="glass-card research-progress">
      {STEPS.map((s, i) => (
        <div key={s.id} className={`research-step ${i < at ? "done" : i === at ? "current" : ""}`}>
          <span className="research-step-icon">{i < at ? <Check size={14} /> : i === at ? <Loader2 size={14} className="spin" /> : s.icon}</span>
          <span><strong>{s.label}</strong><small>{s.hint}</small></span>
        </div>
      ))}
    </section>
  );
}

const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };
export const stripCites = (text: string) => text.replace(/\s*(\[\d+\])+/g, "").replace(/\*\*/g, "");

/** Text with [n] citations turned into small links to the numbered sources (and **bold** kept as bold). */
export function Cited({ text, sources }: { text: string; sources: Source[] }) {
  const parts = text.split(/(\[\d+\]|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
        const m = part.match(/^\[(\d+)\]$/);
        if (!m) return part;
        const src = sources.find(s => s.n === Number(m[1]));
        if (!src) return null;
        return (
          <button key={i} className="cite" title={`${src.title}\n${src.url}`} onClick={() => openExternal(src.url)}>{src.n}</button>
        );
      })}
    </>
  );
}

function Section({ icon, title, className = "", children }: { icon: ReactNode; title: string; className?: string; children: ReactNode }) {
  return (
    <section className={`glass-card brief-card ${className}`}>
      <header>{icon} {title}</header>
      {children}
    </section>
  );
}

export function BriefView({ brief, dimmed }: { brief: Brief; dimmed?: boolean }) {
  const s = brief.sources ?? [];
  const unconfirmed = new Set(brief.unconfirmed ?? []);
  const flag = (t?: string) => t && unconfirmed.has(t)
    ? <span className="brief-unconfirmed" title="The sources only partly support this — check it before relying on it">unconfirmed</span>
    : null;
  const list = (items?: string[]) => items && items.length > 0
    ? <ul>{items.map((t, i) => <li key={i}><Cited text={t} sources={s} />{flag(t)}</li>)}</ul>
    : <p className="muted">Nothing confirmed.</p>;
  const v = brief.verification;
  const conf = brief.identity?.confidence ?? "low";

  return (
    <div className={`brief ${dimmed ? "dimmed" : ""}`}>
      <section className="glass-card brief-identity">
        <span className={`brief-confidence ${conf}`} title="How sure the research is that these sources are about the right person">
          {conf === "high" ? "Right person — confident" : conf === "medium" ? "Probably the right person" : "Not sure it's the right person"}
        </span>
        <p className="brief-summary"><Cited text={brief.identity?.summary || "Not enough public information to say who they are."} sources={s} />{flag(brief.identity?.summary)}</p>
        {brief.identity?.note && <p className="muted brief-note">{brief.identity.note}</p>}
        {v && (
          <p className={`brief-verified ${v.ran ? "" : "off"}`}>
            <ShieldCheck size={13} />
            {v.ran
              ? <>Facts checked against their sources: {v.checked} checked{v.removed ? `, ${v.removed} removed as unsupported` : ""}{v.unconfirmed ? `, ${v.unconfirmed} marked unconfirmed` : ""}.</>
              : <>The fact-check didn't run — treat this brief as unchecked and verify key facts.</>}
          </p>
        )}
      </section>

      <div className="brief-grid">
        <Section icon={<Target size={14} />} title="Walk in knowing">{list(brief.snapshot)}</Section>
        <Section icon={<Lightbulb size={14} />} title="What they care about">{list(brief.cares_about)}</Section>
        <Section icon={<MessageCircle size={14} />} title="How they communicate">
          <p><Cited text={brief.style || "Not enough to go on."} sources={s} />{flag(brief.style)}</p>
        </Section>
        <Section icon={<Handshake size={14} />} title="Common ground with you" className="accent">{list(brief.common_ground)}</Section>
        <Section icon={<Sparkles size={14} />} title="How to win them over" className="accent wide">{list(brief.win_them_over)}</Section>
        <Section icon={<MessagesSquare size={14} />} title="Openers">{list(brief.openers)}</Section>
        <Section icon={<HelpCircle size={14} />} title="They may ask you" className="wide">
          {brief.they_may_ask?.length ? (
            <dl className="brief-qa">
              {brief.they_may_ask.map((q, i) => <div key={i}><dt><Cited text={q.question} sources={s} /></dt><dd><Cited text={q.answer} sources={s} /></dd></div>)}
            </dl>
          ) : <p className="muted">Nothing specific.</p>}
        </Section>
        <Section icon={<ShieldAlert size={14} />} title="Possible concerns">
          {brief.objections?.length ? (
            <dl className="brief-qa">
              {brief.objections.map((o, i) => <div key={i}><dt><Cited text={o.concern} sources={s} /></dt><dd><Cited text={o.response} sources={s} /></dd></div>)}
            </dl>
          ) : <p className="muted">None expected.</p>}
        </Section>
        <Section icon={<AlertTriangle size={14} />} title="Watch out">{list(brief.watch_outs)}</Section>
        {brief.gaps && brief.gaps.length > 0 && <Section icon={<Search size={14} />} title="Worth finding out">{list(brief.gaps)}</Section>}
      </div>
    </div>
  );
}

function SourcesCard({ brief }: { brief: Brief }) {
  const [showProblems, setShowProblems] = useState(false);
  return (
    <section className="glass-card person-sources">
      <div className="plan-section-title">Sources</div>
      <ol>
        {(brief.sources ?? []).map(src => (
          <li key={src.n}>
            <span className="cite static">{src.n}</span>
            <button className="person-source" onClick={() => openExternal(src.url)} title={src.url}>
              <span>{src.title || hostOf(src.url)}</span>
              <small>
                {src.tier && TIER_LABEL[src.tier] && <span className={`tier-badge ${src.tier}`} title={TIER_LABEL[src.tier].hint}>{TIER_LABEL[src.tier].label}</span>}
                {src.source === "link" ? "your link" : src.source} · {hostOf(src.url)}
              </small>
            </button>
          </li>
        ))}
      </ol>
      <p className="muted person-meta">
        {brief.search_engine ? `Web search: ${brief.search_engine === "tavily" ? "Tavily" : "Brave"}` : "Web search off — keyless sources only"}
        {brief.problems && brief.problems.length > 0 && (
          <> · <button className="link-btn" onClick={() => setShowProblems(v => !v)}>{brief.problems.length} couldn't be read</button></>
        )}
      </p>
      {showProblems && <ul className="person-problems">{brief.problems!.map((p, i) => <li key={i}>{p}</li>)}</ul>}
    </section>
  );
}
