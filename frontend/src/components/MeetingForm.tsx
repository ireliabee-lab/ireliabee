import { useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Bell, CalendarPlus, Loader2, Mail, MessageSquare, Monitor, Plus, Trash2, X } from "lucide-react";
import ConfirmDialog from "./ConfirmDialog";
import { FollowUpEditor } from "./FollowUps";
import { notifyError } from "../lib/errors";
import { track } from "../lib/usage";
import {
  DEFAULT_REMINDERS, DURATIONS, REMINDER_CHOICES, ZONES, localZone, meetingsApi, partsIn, phoneApi, reminderLabel, smsPages,
  textCost, zoneChoiceLabel,
  type Channel, type FollowUp, type Meeting, type MeetingInput, type MeetingPerson, type PhoneInfo, type Reminder,
} from "../lib/meetings";

/** What the form starts from when it makes a new meeting. */
export interface MeetingDraft { title?: string; topics?: string[]; start?: string; minutes?: number }

const CHANNELS: { id: Channel; label: string; icon: JSX.Element }[] = [
  { id: "desktop", label: "On this computer", icon: <Monitor size={13} /> },
  { id: "email", label: "Email", icon: <Mail size={13} /> },
  { id: "sms", label: "Text", icon: <MessageSquare size={13} /> },
];

/** Why a channel can't be picked yet, or null when it can. */
function notReady(id: Channel, phone: PhoneInfo | null): string | null {
  if (id === "desktop") return null;
  if (!phone) return "Checking your account…";
  if (!phone.signed_in) return "Sign in to iReliabee (Settings) to get reminders by email or text message";
  if (id === "sms" && !phone.confirmed) return "Add and confirm your phone number in Settings first";
  return null;
}

/** "1 text reminder", "2 text reminders". */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The next half hour, in `zone`, as the form's date and time. */
function nextSlot(zone: string): { date: string; time: string } {
  const d = new Date(Math.ceil((Date.now() + 5 * 60000) / 1800000) * 1800000);
  return partsIn(d.toISOString(), zone);
}

/**
 * A meeting in your own calendar: when (in your zone, and theirs), where, who
 * with, what it's about, what to prepare, and when to be reminded. Used from
 * the Calendar tab and from an Idea board note ("Schedule…").
 *
 * With `onSubmit` the caller saves it (the Idea board saves through its note);
 * otherwise the form saves to the calendar itself.
 */
export default function MeetingForm({ meeting, draft, onClose, onSaved, onDeleted, onSubmit }: {
  meeting?: Meeting | null;
  draft?: MeetingDraft;
  onClose: () => void;
  onSaved?: (m: Meeting) => void;
  onDeleted?: () => void;
  onSubmit?: (input: MeetingInput) => Promise<void>;
}) {
  const zone0 = meeting?.timezone || localZone();
  const when0 = meeting ? partsIn(meeting.start, zone0) : draft?.start ? partsIn(draft.start, zone0) : nextSlot(zone0);
  const minutes0 = meeting ? Math.round((Date.parse(meeting.end) - Date.parse(meeting.start)) / 60000) : draft?.minutes ?? 30;

  const [title, setTitle] = useState(meeting?.title ?? draft?.title ?? "");
  const [date, setDate] = useState(when0.date);
  const [time, setTime] = useState(when0.time);
  const [minutes, setMinutes] = useState(minutes0);
  const [zone, setZone] = useState(zone0);
  const [theirZone, setTheirZone] = useState(meeting?.their_timezone ?? "");
  const [location, setLocation] = useState(meeting?.location || meeting?.join_url || "");
  const [people, setPeople] = useState<MeetingPerson[]>(meeting?.people?.length ? meeting.people : [{ name: "", email: "" }]);
  const [topics, setTopics] = useState((meeting?.topics ?? draft?.topics ?? []).join("\n"));
  const [prep, setPrep] = useState(meeting?.prep ?? "");
  const [notes, setNotes] = useState(meeting?.notes ?? "");
  const [about, setAbout] = useState(meeting?.about ?? "");
  const [followups, setFollowups] = useState<FollowUp[]>(meeting?.followups ?? []);
  const [reminders, setReminders] = useState<Reminder[]>(meeting?.reminders ?? DEFAULT_REMINDERS);
  const [busy, setBusy] = useState(false);
  const [askDelete, setAskDelete] = useState(false);
  const [phone, setPhone] = useState<PhoneInfo | null>(null);
  const [preview, setPreview] = useState<{ subject: string; text: string } | null>(null);

  // Whether email and text can be picked: signed in, and a confirmed number for texts.
  useEffect(() => {
    let alive = true;
    phoneApi.get().then(p => { if (alive) setPhone(p); })
      .catch(() => { if (alive) setPhone({ phone: null, confirmed: false, signed_in: false, price: null }); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !askDelete) { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, askDelete]);

  const remote = reminders.some(r => r.channels.includes("email") || r.channels.includes("sms"));
  const texting = reminders.some(r => r.channels.includes("sms"));

  // What the email or text will say, shown before it is turned on (the Privacy Policy promises it).
  useEffect(() => {
    if (!remote || !title.trim()) { setPreview(null); return; }
    const t = setTimeout(() => { meetingsApi.reminderPreview(input()).then(setPreview).catch(() => setPreview(null)); }, 400);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, title, date, time, minutes, zone, theirZone, location, topics, prep, reminders]);

  const zones = useMemo(() => Array.from(new Set([zone, localZone(), ...ZONES, ...(theirZone ? [theirZone] : [])])), [zone, theirZone]);

  function input(): MeetingInput {
    return {
      title: title.trim(), start: `${date}T${time}`, minutes, timezone: zone, their_timezone: theirZone || null, location: location.trim(),
      topics: topics.split("\n").map(t => t.replace(/^[\s\-•*]+/, "").trim()).filter(Boolean),
      prep: prep.trim(), notes: notes.trim(),
      people: people.map(p => ({ ...p, name: p.name?.trim(), email: p.email?.trim() })).filter(p => p.name || p.email || p.id),
      reminders,
      about: about.trim(),
      followups: followups.map(f => ({ ...f, text: f.text.trim() })).filter(f => f.text),
    };
  }

  async function save() {
    if (!title.trim()) { notifyError(new Error("Give the meeting a title")); return; }
    setBusy(true);
    try {
      if (onSubmit) await onSubmit(input());
      else {
        const saved = meeting ? await meetingsApi.update(meeting.id, input()) : await meetingsApi.create(input());
        track(meeting ? "meeting.update" : "meeting.create");
        const r = saved.remote;
        if (r?.ok && r.reminders) {
          toast.success(r.texts ? `Email and text reminders set. The texts cost at most ${r.credits} credits, charged only when sent.` : "Email reminders set.");
        } else if (r?.ok && remote) {
          toast("Meeting saved. Its email and text reminder times have already passed, so none were set.", { duration: 8000 });
        } else if (r && !r.ok) {
          toast(`Meeting saved. ${r.message ?? "Its email and text reminders will be set up once iReliabee can be reached."}`, { duration: 8000 });
        }
        onSaved?.(saved);
      }
      onClose();
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  async function remove() {
    if (!meeting) return;
    setBusy(true);
    try { await meetingsApi.remove(meeting.id); track("meeting.delete"); onDeleted?.(); onClose(); }
    catch (e) { notifyError(e); } finally { setBusy(false); setAskDelete(false); }
  }

  const setReminder = (i: number, r: Reminder | null) =>
    setReminders(list => (r ? list.map((x, k) => (k === i ? r : x)) : list.filter((_, k) => k !== i)));
  const usedMinutes = new Set(reminders.map(r => r.minutes));

  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-card mt-form" role="dialog" aria-modal="true" aria-labelledby="mt-form-title">
        <div className="mt-head">
          <strong id="mt-form-title"><CalendarPlus size={16} /> {meeting ? "Meeting" : "New meeting"}</strong>
          <button type="button" className="nb-icon-btn" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>

        <label className="settings-label" htmlFor="mt-title">What is it</label>
        <input id="mt-title" className="mt-input mt-big" value={title} autoFocus placeholder="e.g. Call with Dr. Reyes"
          onChange={e => setTitle(e.target.value)} />

        <div className="mt-row">
          <div>
            <label className="settings-label" htmlFor="mt-date">Date</label>
            <input id="mt-date" className="mt-input" type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <label className="settings-label" htmlFor="mt-time">Time</label>
            <input id="mt-time" className="mt-input" type="time" value={time} onChange={e => setTime(e.target.value)} />
          </div>
          <div>
            <label className="settings-label" htmlFor="mt-len">How long</label>
            <select id="mt-len" className="mt-input" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
              {Array.from(new Set([...DURATIONS, minutes])).sort((a, b) => a - b).map(m => (
                <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-row">
          <div>
            <label className="settings-label" htmlFor="mt-zone">That time is in</label>
            <select id="mt-zone" className="mt-input" value={zone} onChange={e => setZone(e.target.value)}>
              {zones.map(z => <option key={z} value={z}>{zoneChoiceLabel(z)}</option>)}
            </select>
          </div>
          <div>
            <label className="settings-label" htmlFor="mt-their">Their time zone <span className="muted">(optional)</span></label>
            <select id="mt-their" className="mt-input" value={theirZone} onChange={e => setTheirZone(e.target.value)}>
              <option value="">Same as mine</option>
              {zones.filter(z => z !== localZone()).map(z => <option key={z} value={z}>{zoneChoiceLabel(z)}</option>)}
            </select>
          </div>
        </div>

        <label className="settings-label" htmlFor="mt-where">Where <span className="muted">(a Zoom, Meet or Teams link, or a place)</span></label>
        <input id="mt-where" className="mt-input" value={location} placeholder="https://…" onChange={e => setLocation(e.target.value)} />

        <div className="settings-label">Who with</div>
        {people.map((p, i) => (
          <div key={i} className="mt-row mt-person">
            <input className="mt-input" aria-label={`Name ${i + 1}`} placeholder="Name" value={p.name ?? ""}
              onChange={e => setPeople(list => list.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
            <input className="mt-input" aria-label={`Email ${i + 1}`} placeholder="Email (optional)" value={p.email ?? ""}
              onChange={e => setPeople(list => list.map((x, k) => (k === i ? { ...x, email: e.target.value } : x)))} />
            {people.length > 1 && <button type="button" className="nb-icon-btn" aria-label="Remove this person"
              onClick={() => setPeople(list => list.filter((_, k) => k !== i))}><X size={13} /></button>}
          </div>
        ))}
        {people.length < 20 && <button type="button" className="mt-add" onClick={() => setPeople(list => [...list, { name: "", email: "" }])}>
          <Plus size={13} /> Someone else</button>}

        <label className="settings-label" htmlFor="mt-topics">Topics <span className="muted">(one per line)</span></label>
        <textarea id="mt-topics" className="mt-input" rows={3} value={topics} placeholder={"Research plan feedback\nNext steps"}
          onChange={e => setTopics(e.target.value)} />

        <label className="settings-label" htmlFor="mt-prep">What to prepare or bring</label>
        <textarea id="mt-prep" className="mt-input" rows={2} value={prep} onChange={e => setPrep(e.target.value)} />

        <label className="settings-label" htmlFor="mt-about">About them <span className="muted">(for your brief; only on this computer)</span></label>
        <textarea id="mt-about" className="mt-input" rows={2} value={about} onChange={e => setAbout(e.target.value)}
          placeholder="Western University, SPARC Lab. Referred by Prof. Max. Positions open for Sept 2027." />

        <label className="settings-label" htmlFor="mt-notes">Notes <span className="muted">(only on this computer)</span></label>
        <textarea id="mt-notes" className="mt-input" rows={2} value={notes} onChange={e => setNotes(e.target.value)} />

        <div className="settings-label">Follow-ups <span className="muted">(what they asked, what you promised)</span></div>
        <FollowUpEditor value={followups} onChange={setFollowups} phone={phone} />

        <div className="settings-label"><Bell size={12} /> Remind me</div>
        <ul className="mt-reminders">
          {reminders.map((r, i) => (
            <li key={i}>
              <select className="mt-input" aria-label="How long before" value={r.minutes}
                onChange={e => setReminder(i, { ...r, minutes: Number(e.target.value) })}>
                {REMINDER_CHOICES.filter(m => m === r.minutes || !usedMinutes.has(m)).map(m => <option key={m} value={m}>{reminderLabel(m)} before</option>)}
              </select>
              {CHANNELS.map(c => {
                const on = r.channels.includes(c.id);
                // A channel already chosen stays changeable, so it can always be turned off.
                const why = on ? null : notReady(c.id, phone);
                return (
                  <label key={c.id} className={`mt-chip${on ? " on" : ""}${why ? " soon" : ""}`} title={why ?? c.label}>
                    <input type="checkbox" disabled={Boolean(why)} checked={on}
                      onChange={e => setReminder(i, { ...r, channels: e.target.checked ? [...r.channels, c.id] : r.channels.filter(x => x !== c.id) })} />
                    {c.icon} {c.label}
                  </label>
                );
              })}
              <button type="button" className="nb-icon-btn" aria-label="Remove this reminder" onClick={() => setReminder(i, null)}><X size={13} /></button>
            </li>
          ))}
        </ul>
        {reminders.length < 6 && (
          <button type="button" className="mt-add" onClick={() => {
            const free = REMINDER_CHOICES.find(m => !usedMinutes.has(m));
            if (free !== undefined) setReminders(list => [...list, { minutes: free, channels: ["desktop"] }]);
          }}><Plus size={13} /> Another reminder</button>
        )}
        {!remote && (
          <p className="muted mt-small">
            Email and text reminders arrive even with your laptop closed. Email is free; a text costs
            {phone?.price ? ` ${phone.price.credits_per_text} credits (about ${phone.price.about_pesewas} pesewas)` : " a little"}.
            {phone?.signed_in && !phone.confirmed ? " For texts, add your number in Settings first." : ""}
          </p>
        )}
        {remote && (
          <div className="mt-remote">
            <p className="muted mt-small">
              iReliabee's server sends these, so they arrive with your laptop closed. It receives only the message below,
              keeps it until it is sent, then deletes it: never your notes, your plan or the people you listed.
            </p>
            {texting && phone?.price && (() => {
              const { texts, credits } = textCost(reminders, phone.price, preview ? smsPages(preview.text) : 1);
              return (
                <p className="mt-small mt-cost">
                  <MessageSquare size={12} /> Texts cost {phone.price.credits_per_text} credits each (about {phone.price.about_pesewas} pesewas).
                  This meeting: {plural(reminders.filter(x => x.channels.includes("sms")).length, "text reminder")}, {plural(texts, "text")},
                  at most <strong>{credits} credits</strong>, charged only when sent{phone.phone ? ` to ${phone.phone}` : ""}.
                </p>
              );
            })()}
            {preview && (
              <figure className="mt-preview">
                <figcaption className="muted">What it will say</figcaption>
                <div className="mt-preview-subject">{preview.subject}</div>
                <pre>{preview.text}</pre>
              </figure>
            )}
          </div>
        )}

        <div className="mt-actions">
          {meeting && !onSubmit && <button type="button" className="btn-neutral danger" onClick={() => setAskDelete(true)} disabled={busy}><Trash2 size={14} /> Delete</button>}
          <span className="nb-toolbar-spacer" />
          <button type="button" className="btn-neutral" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <CalendarPlus size={14} />} {meeting ? "Save" : "Add to my calendar"}
          </button>
        </div>
      </div>
      {askDelete && <ConfirmDialog message="Delete this meeting?" detail="Its reminders go too." onConfirm={remove} onCancel={() => setAskDelete(false)} />}
    </div>
  );
}
