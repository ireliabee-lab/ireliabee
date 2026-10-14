import { useEffect, useRef, useState, type ReactNode } from "react";
import toast from "react-hot-toast";
import {
  RefreshCw, Link2, Upload, Trash2, Video, Play, Sparkles, Loader2, AlertTriangle, Copy, ChevronDown,
  ListChecks, CalendarDays, LogIn, Users, Headphones, CalendarPlus, Pencil, Bell, NotebookPen,
} from "lucide-react";
import MeetingForm from "./MeetingForm";
import { FollowUpBoard } from "./FollowUps";
import { dueLabel, followUpKindLabel, isOwn, meetingsApi, openNotebook, reminderLabel, theirTime, type Meeting } from "../lib/meetings";
import Page from "./Page";
import Illustration from "./Illustration";
import ConfirmDialog from "./ConfirmDialog";
import { fetchApi } from "../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../lib/errors";
import { openExternal } from "../lib/openExternal";
import { track } from "../lib/usage";
import { type CalEvent, callApp, dayKey, dayLabel, joinAndListen, startMeeting, timing, withWhom } from "../lib/calendar";

interface Calendar { id: number; kind: string; label: string; hint?: string; synced_at?: string | null; error?: string | null; }
interface Provider { label: string; ready: boolean; redirect_uri: string; keys: Record<string, boolean>; }

async function api(path: string, method = "GET", body?: unknown) {
  const res = await fetchApi(path, {
    method, headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

const KIND_LABEL: Record<string, string> = { ics_url: "iCal link", ics_file: "Imported file", google: "Google", microsoft: "Outlook" };
const ago = (iso?: string | null) => {
  if (!iso) return "not synced yet";
  const min = Math.round((Date.now() - Date.parse(iso + "Z")) / 60000);
  return min < 1 ? "synced just now" : min < 60 ? `synced ${min} min ago` : `synced ${Math.round(min / 60)} h ago`;
};

/**
 * Plans → Calendar (roadmap 3.2): the week's meetings from the user's calendars,
 * a plan drafted from any invite, and the live session started on time.
 */
export default function CalendarView({ tabs, onDraft, onOpenPlan }: {
  tabs: ReactNode;
  onDraft: (draft: any, eventId: number) => void;
  onOpenPlan: (planId: number) => void;
}) {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [calendars, setCalendars] = useState<Calendar[]>([]);
  const [providers, setProviders] = useState<Record<string, Provider>>({});
  const [syncing, setSyncing] = useState(false);
  const [drafting, setDrafting] = useState<number | null>(null);
  const [, tick] = useState(0);
  // Your own meetings after this week (the week's show with the rest).
  const [later, setLater] = useState<Meeting[]>([]);
  const [form, setForm] = useState<null | { meeting?: Meeting }>(null);
  // Bumped after a save, so "To follow up" reads again.
  const [followRefresh, setFollowRefresh] = useState(0);
  const openMeeting = (id: number) => meetingsApi.get(id).then(m => setForm({ meeting: m })).catch(notifyError);

  const loadEvents = () => Promise.all([
    api("/calendar/events?days=7").then(setEvents).catch(() => setEvents([])),
    meetingsApi.upcoming(90).then(ms => {
      const weekEnd = new Date(); weekEnd.setHours(0, 0, 0, 0); weekEnd.setDate(weekEnd.getDate() + 7);
      setLater(ms.filter(m => Date.parse(m.start) >= weekEnd.getTime()));
    }).catch(() => setLater([])),
  ]);
  const loadCalendars = () => api("/calendar/calendars").then(d => { setCalendars(d.calendars); setProviders(d.providers); }).catch(notifyError);
  const reload = () => Promise.all([loadEvents(), loadCalendars()]);

  useEffect(() => { reload(); }, []);
  // Keep "In 5 min" labels honest.
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 30000); return () => clearInterval(t); }, []);

  async function sync() {
    setSyncing(true);
    try {
      const d = await api("/calendar/sync", "POST");
      setCalendars(d.calendars);
      await loadEvents();
      const failed = (d.calendars as Calendar[]).filter(c => c.error);
      if (failed.length) toast.error(`${failed[0].label}: ${failed[0].error}`);
    } catch (e) { notifyError(e); } finally { setSyncing(false); }
  }

  async function draft(ev: CalEvent) {
    if (!(await ensureReady(["llm"]))) return;
    setDrafting(ev.id);
    try {
      const cfg = await fetchApi("/config").then(r => r.json()).catch(() => ({}));
      track("calendar.plan_from_invite");
      const d = await api(`/calendar/events/${ev.id}/draft`, "POST", { model: cfg?.saved?.model });
      onDraft(d, ev.id);
      toast.success("Plan drafted from the invite — review it, then save");
    } catch (e) { notifyError(e); } finally { setDrafting(null); }
  }

  const days: { key: string; label: string; items: CalEvent[] }[] = [];
  for (const ev of events ?? []) {
    const key = dayKey(ev.start);
    let day = days.find(d => d.key === key);
    if (!day) days.push(day = { key, label: dayLabel(ev.start), items: [] });
    day.items.push(ev);
  }

  return (
    <Page
      title="Plans"
      subtitle="Your meetings for the week. Make a plan from any invite, and start the coach when the call begins."
      tabs={tabs}
      actions={<>
        {calendars.length > 0 && (
          <button className="btn-neutral" onClick={sync} disabled={syncing}>
            {syncing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} Sync
          </button>
        )}
        <button className="btn-primary" onClick={() => setForm({})}><CalendarPlus size={14} /> New meeting</button>
      </>}
    >
      <div className="page-content">
        <div className="page-split">
          <section className="cal-days">
            <FollowUpBoard refresh={followRefresh} onOpenMeeting={openMeeting} />
            {events == null ? null : events.length === 0 && later.length === 0 ? (
              <div className="glass-card plans-empty">
                <Illustration name="calendar" />
                <div className="plans-empty-title">{calendars.length ? "No meetings this week" : "Your meetings, in one place"}</div>
                <p className="muted">{calendars.length
                  ? "Nothing in the next seven days. New invites show up after a sync, or add one yourself."
                  : "Add a meeting yourself, with its topics, what to prepare and reminders 30 and 15 minutes before. Or bring in your calendar: an iCal link, a file, or Google or Outlook sign-in."}</p>
                <button className="btn-primary" onClick={() => setForm({})}><CalendarPlus size={14} /> New meeting</button>
              </div>
            ) : days.map(day => (
              <div key={day.key} className="cal-day">
                <div className="cal-day-label">{day.label}</div>
                {day.items.map(ev => {
                  const t = timing(ev);
                  const who = withWhom(ev);
                  return (
                    <article key={ev.id} className={`glass-card cal-event ${t.state}`}>
                      <div className="cal-time">
                        <strong>{ev.all_day ? "All day" : new Date(ev.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</strong>
                        {!ev.all_day && <span>{new Date(ev.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
                      </div>
                      <div className="cal-main">
                        <div className="cal-title">
                          {ev.title}
                          {t.label && t.state !== "later" && <span className={`cal-when ${t.state}`}>{t.label}</span>}
                          {t.state === "later" && t.label && <span className="cal-when">{t.label}</span>}
                        </div>
                        <div className="cal-meta muted">
                          {who && <span><Users size={11} /> {who}</span>}
                          {isOwn(ev) && theirTime(ev as Meeting) && <span>{theirTime(ev as Meeting)}</span>}
                          <span className={isOwn(ev) ? "cal-own" : ""}><CalendarDays size={11} /> {ev.calendar}</span>
                          {isOwn(ev) && (ev as Meeting).reminders?.length ? (
                            <span title="Reminders"><Bell size={11} /> {(ev as Meeting).reminders!.map(r => reminderLabel(r.minutes)).join(", ")}</span>
                          ) : null}
                          {ev.plan_id && <button className="cal-plan" onClick={() => onOpenPlan(ev.plan_id!)}><ListChecks size={11} /> {ev.plan_title ?? "Plan"}</button>}
                        </div>
                        {isOwn(ev) && (ev as Meeting).topics?.length ? (
                          <ul className="cal-topics">{(ev as Meeting).topics.slice(0, 4).map(t => <li key={t}>{t}</li>)}</ul>
                        ) : null}
                        {isOwn(ev) && <Brief m={ev as Meeting} />}
                      </div>
                      {t.state === "past" && isOwn(ev) && (
                        <div className="cal-actions">
                          <button className="btn-neutral" onClick={() => setForm({ meeting: ev as Meeting })}><Pencil size={13} /> Follow-ups and notes</button>
                        </div>
                      )}
                      {!ev.all_day && t.state !== "past" && (
                        <div className="cal-actions">
                          {isOwn(ev) && (
                            <button className="btn-neutral" onClick={() => setForm({ meeting: ev as Meeting })}><Pencil size={13} /> Edit</button>
                          )}
                          {ev.join_url && (
                            <button className="btn-neutral" title={`Only open the ${callApp(ev.join_url)} call`} onClick={() => { track("calendar.join"); openExternal(ev.join_url); }}>
                              <Video size={13} /> Join
                            </button>
                          )}
                          {!ev.plan_id && (
                            <button className="btn-neutral" onClick={() => draft(ev)} disabled={drafting != null}>
                              {drafting === ev.id ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Make a plan
                            </button>
                          )}
                          <button className="btn-neutral" title="Choose the coach, CV and language first"
                            onClick={() => { track("calendar.start"); startMeeting(ev); }}>
                            <Play size={13} /> Set up session
                          </button>
                          <button className={t.state === "soon" || t.state === "now" ? "btn-primary" : "btn-neutral"}
                            title={ev.join_url ? `Open the ${callApp(ev.join_url)} call and start the coach listening to it` : "Start the session and the coach listening to the call"}
                            onClick={() => { track("calendar.join_listen"); joinAndListen(ev); }}>
                            <Headphones size={13} /> {ev.join_url ? "Join & listen" : "Start & listen"}
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            ))}
            {later.length > 0 && <>
              <div className="cal-day-label cal-later-label">Later</div>
              {later.map(m => (
                <article key={m.id} className="glass-card cal-event later">
                  <div className="cal-time">
                    <strong>{new Date(m.start).toLocaleDateString([], { day: "numeric", month: "short" })}</strong>
                    <span>{new Date(m.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                  </div>
                  <div className="cal-main">
                    <div className="cal-title">{m.title}</div>
                    <div className="cal-meta muted">
                      {theirTime(m) && <span>{theirTime(m)}</span>}
                      {m.reminders?.length ? <span><Bell size={11} /> {m.reminders.map(r => reminderLabel(r.minutes)).join(", ")}</span> : null}
                    </div>
                    {m.topics.length > 0 && <ul className="cal-topics">{m.topics.slice(0, 4).map(t => <li key={t}>{t}</li>)}</ul>}
                    <Brief m={m} />
                  </div>
                  <div className="cal-actions">
                    <button className="btn-neutral" onClick={() => setForm({ meeting: m })}><Pencil size={13} /> Edit</button>
                  </div>
                </article>
              ))}
            </>}
          </section>

          <aside className="page-side">
            <CalendarSources calendars={calendars} providers={providers} onChanged={reload} />
          </aside>
        </div>
      </div>
      {form && <MeetingForm meeting={form.meeting} onClose={() => setForm(null)}
        onSaved={() => { toast.success("In your calendar"); loadEvents(); setFollowRefresh(n => n + 1); }}
        onDeleted={() => { loadEvents(); setFollowRefresh(n => n + 1); }} />}
    </Page>
  );
}

/**
 * The "Get ready" brief on your own meeting's card: who they are, and what is
 * still open between you (what they asked, what you promised).
 */
function Brief({ m }: { m: Meeting }) {
  const open = (m.followups ?? []).filter(f => !f.done);
  const notes = (m.links ?? []).filter(l => l.kind === "notebook");
  if (!m.about && !open.length && !notes.length) return null;
  return (
    <div className="cal-brief">
      {m.about && <p className="cal-about">{m.about}</p>}
      {notes.length > 0 && (
        <div className="cal-notes">
          {notes.map(l => (
            <button key={String(l.id)} type="button" className="cal-plan" onClick={() => openNotebook(l.id)} title="The notes written from the call">
              <NotebookPen size={11} /> {l.label || "Notes from the call"}
            </button>
          ))}
        </div>
      )}
      {open.length > 0 && (
        <ul className="cal-open">
          {open.slice(0, 4).map(f => (
            <li key={f.id ?? f.text}><span className={`fu-kind-chip ${f.kind}`}>{followUpKindLabel(f.kind)}</span> {f.text}
              {f.due && <span className="muted"> · {dueLabel(f.due)}</span>}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CalendarSources({ calendars, providers, onChanged }: {
  calendars: Calendar[]; providers: Record<string, Provider>; onChanged: () => void;
}) {
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Calendar | null>(null);
  const [setup, setSetup] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function addLink() {
    if (!url.trim()) { toast("Paste your calendar's iCal link first", { icon: "📅" }); return; }
    setAdding(true);
    try {
      const c = await api("/calendar/calendars/link", "POST", { url: url.trim() });
      track("calendar.add_link");
      setUrl("");
      toast.success(`Added ${c.label}`);
      onChanged();
    } catch (e) { notifyError(e); } finally { setAdding(false); }
  }

  async function addFile(file: File) {
    setAdding(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetchApi("/calendar/calendars/file", { method: "POST", body: fd });
      if (!res.ok) throw await errorFromResponse(res);
      const c = await res.json();
      track("calendar.add_file");
      toast.success(`Imported ${c.label}`);
      onChanged();
    } catch (e) { notifyError(e); } finally { setAdding(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function remove(c: Calendar) {
    try { await api(`/calendar/calendars/${c.id}`, "DELETE"); onChanged(); } catch (e) { notifyError(e); }
    setRemoving(null);
  }

  async function signIn(provider: string) {
    try {
      const { url } = await api(`/calendar/oauth/${provider}/start`);
      track(`calendar.signin.${provider}`);
      const before = new Set(calendars.map(c => c.id));
      await openExternal(url);
      setWaiting(provider);
      // The browser hands the sign-in back to the engine; watch for the new calendar.
      if (pollRef.current) clearInterval(pollRef.current);
      const started = Date.now();
      pollRef.current = window.setInterval(async () => {
        const d = await api("/calendar/calendars").catch(() => null);
        const fresh = d?.calendars.find((c: Calendar) => !before.has(c.id) && c.kind === provider);
        if (fresh || Date.now() - started > 5 * 60000) {
          clearInterval(pollRef.current!); pollRef.current = null; setWaiting(null);
          if (fresh) { toast.success(`Connected ${fresh.label}`); onChanged(); }
        }
      }, 2500);
    } catch (e) { notifyError(e); }
  }

  return (
    <>
      <section className="glass-card progress-card cal-sources">
        <header><CalendarDays size={14} /> Your calendars</header>
        {calendars.length === 0 && <p className="progress-hint">None yet — add one below.</p>}
        {calendars.map(c => (
          <div key={c.id} className="cal-source">
            <div>
              <strong>{c.label}</strong>
              <span className="muted">{KIND_LABEL[c.kind] ?? c.kind}{c.hint ? ` · ${c.hint}` : ""} · {ago(c.synced_at)}</span>
              {c.error && <span className="cal-error"><AlertTriangle size={11} /> {c.error}</span>}
            </div>
            <button className="icon-btn" title="Remove this calendar" onClick={() => setRemoving(c)}><Trash2 size={13} /></button>
          </div>
        ))}
      </section>

      <section className="glass-card progress-card cal-add">
        <header><Link2 size={14} /> Add a calendar</header>
        <label className="settings-label">iCal link</label>
        <div className="cal-link-row">
          <input className="glass-input" value={url} placeholder="https://… .ics or webcal://…" onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") addLink(); }} />
          <button className="btn-primary" onClick={addLink} disabled={adding}>{adding ? <Loader2 size={13} className="spin" /> : "Add"}</button>
        </div>
        <p className="progress-hint">
          <b>Google:</b> Settings → your calendar → Integrate calendar → <i>Secret address in iCal format</i>.{" "}
          <b>Outlook:</b> Settings → Calendar → Shared calendars → Publish a calendar → <i>ICS</i> link.
          The link is private: it stays on this computer.
        </p>
        <input ref={fileRef} type="file" accept=".ics,text/calendar" hidden onChange={e => e.target.files?.[0] && addFile(e.target.files[0])} />
        <button className="btn-neutral cal-file" onClick={() => fileRef.current?.click()} disabled={adding}>
          <Upload size={13} /> Import a calendar file (.ics)
        </button>

        <div className="cal-divider"><span>or sign in</span></div>
        {Object.entries(providers).map(([id, p]) => (
          <div key={id} className="cal-provider">
            <div className="cal-provider-row">
              <button className="btn-neutral" onClick={() => (p.ready ? signIn(id) : setSetup(s => (s === id ? null : id)))} disabled={waiting === id}>
                {waiting === id ? <Loader2 size={13} className="spin" /> : <LogIn size={13} />}
                {waiting === id ? "Finish signing in in your browser…" : `Sign in with ${id === "google" ? "Google" : "Outlook"}`}
              </button>
              <button className="icon-btn" title={p.ready ? "App settings" : "Set up first"} onClick={() => setSetup(s => (s === id ? null : id))}>
                <ChevronDown size={14} style={{ transform: setup === id ? "rotate(180deg)" : undefined }} />
              </button>
            </div>
            {setup === id && <ProviderSetup id={id} provider={p} onSaved={() => { setSetup(null); onChanged(); }} />}
          </div>
        ))}
      </section>

      {removing && (
        <ConfirmDialog
          message={`Remove ${removing.label}?`}
          detail="Its meetings disappear from iReliabee. Your plans stay, and the calendar itself isn't touched."
          confirmLabel="Remove"
          onConfirm={() => remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}

/** One-time setup: the user registers their own sign-in app and pastes its client ID here. */
function ProviderSetup({ id, provider, onSaved }: { id: string; provider: Provider; onSaved: () => void }) {
  const fields = id === "google"
    ? [{ env: "GOOGLE_CLIENT_ID", label: "Client ID" }, { env: "GOOGLE_CLIENT_SECRET", label: "Client secret" }]
    : [{ env: "MICROSOFT_CLIENT_ID", label: "Application (client) ID" }];
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function save() {
    const filled = fields.filter(f => (values[f.env] ?? "").trim());
    if (!filled.length) { toast("Paste the app's details first", { icon: "🔑" }); return; }
    setSaving(true);
    try {
      for (const f of filled) await api("/config/key", "POST", { env_var: f.env, value: values[f.env].trim() });
      toast.success("Saved — now sign in");
      onSaved();
    } catch (e) { notifyError(e); } finally { setSaving(false); }
  }

  const copy = () => navigator.clipboard.writeText(provider.redirect_uri).then(() => toast.success("Copied"));
  return (
    <div className="cal-setup">
      {id === "google" ? (
        <ol>
          <li>In <a onClick={() => openExternal("https://console.cloud.google.com/apis/library/calendar-json.googleapis.com")}>Google Cloud Console</a>, create a project and enable the <b>Google Calendar API</b>.</li>
          <li>Set up the <b>OAuth consent screen</b> (External) and add your own Google account as a <b>test user</b>.</li>
          <li>Under <b>Credentials</b>, create an <b>OAuth client ID</b> of type <b>Desktop app</b>, then paste its ID and secret here.</li>
        </ol>
      ) : (
        <ol>
          <li>In the <a onClick={() => openExternal("https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade")}>Microsoft Entra admin center</a>, open <b>App registrations → New registration</b> and allow <b>personal Microsoft accounts</b> too.</li>
          <li>Under <b>Authentication</b>, add the <b>Mobile and desktop applications</b> platform with this redirect URI:
            <button className="cal-copy" onClick={copy} title="Copy"><code>{provider.redirect_uri}</code> <Copy size={11} /></button></li>
          <li>Under <b>API permissions</b>, add Microsoft Graph → Delegated → <b>Calendars.Read</b>. Paste the Application (client) ID here.</li>
        </ol>
      )}
      {fields.map(f => (
        <div key={f.env}>
          <label className="settings-label">{f.label} {provider.keys[f.env] && <span className="cal-set">✓ set</span>}</label>
          <input className="glass-input" type={f.env.endsWith("SECRET") ? "password" : "text"} value={values[f.env] ?? ""}
            placeholder={provider.keys[f.env] ? "Paste to replace…" : ""} onChange={e => setValues(v => ({ ...v, [f.env]: e.target.value }))} />
        </div>
      ))}
      <p className="progress-hint">Read-only access to your calendar. The sign-in stays on this computer and is never exported.</p>
      <button className="btn-primary" onClick={save} disabled={saving}>{saving ? <Loader2 size={13} className="spin" /> : null} Save</button>
    </div>
  );
}
