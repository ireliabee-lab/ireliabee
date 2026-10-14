import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Bell, Check, ClipboardList, Mail, MessageSquare, Plus, X } from "lucide-react";
import { notifyError } from "../lib/errors";
import { track } from "../lib/usage";
import {
  FOLLOWUP_KINDS, daysUntil, dueLabel, followUpKindLabel, meetingsApi,
  type Channel, type FollowUp, type OpenFollowUp, type PhoneInfo,
} from "../lib/meetings";

const REMIND: { id: Channel; label: string; icon: JSX.Element }[] = [
  { id: "desktop", label: "On this computer", icon: <Bell size={11} /> },
  { id: "email", label: "Email", icon: <Mail size={11} /> },
  { id: "sms", label: "Text", icon: <MessageSquare size={11} /> },
];

/**
 * The follow-ups of one meeting, in its form: what they asked of you, what you
 * promised, your own to-dos, each with an optional due date. A dated one is
 * reminded that morning at 9, on this computer and by email or text if chosen.
 */
export function FollowUpEditor({ value, onChange, phone }: {
  value: FollowUp[];
  onChange: (list: FollowUp[]) => void;
  phone: PhoneInfo | null;
}) {
  const set = (i: number, f: FollowUp | null) => onChange(f ? value.map((x, j) => (j === i ? f : x)) : value.filter((_, j) => j !== i));
  const ready = (c: Channel) => c === "desktop" || (phone?.signed_in && (c === "email" || phone.confirmed));
  return (
    <>
      <ul className="fu-edit">
        {value.map((f, i) => (
          <li key={f.id ?? `new-${i}`} className={f.done ? "done" : ""}>
            <div className="fu-row">
              <input type="checkbox" aria-label="Done" checked={f.done} onChange={e => set(i, { ...f, done: e.target.checked })} />
              <input className="mt-input fu-text" aria-label="Follow-up" placeholder="Send the research plan" value={f.text}
                onChange={e => set(i, { ...f, text: e.target.value })} />
              <button type="button" className="nb-icon-btn" aria-label="Remove this follow-up" onClick={() => set(i, null)}><X size={13} /></button>
            </div>
            <div className="fu-row fu-row-meta">
            <select className="mt-input fu-kind" aria-label="What kind" value={f.kind}
              onChange={e => set(i, { ...f, kind: e.target.value as FollowUp["kind"] })}>
              {FOLLOWUP_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
            <input className="mt-input fu-due" type="date" aria-label="Due" value={f.due ?? ""}
              onChange={e => set(i, { ...f, due: e.target.value || null })} />
            {f.due && !f.done && REMIND.map(c => {
              const on = f.remind.includes(c.id);
              const off = !on && !ready(c.id);
              return (
                <label key={c.id} className={`mt-chip fu-remind${on ? " on" : ""}${off ? " soon" : ""}`}
                  title={off ? (c.id === "sms" ? "Add and confirm your phone number in Settings first" : "Sign in to iReliabee first") : `Remind me at 9 that morning: ${c.label}`}>
                  <input type="checkbox" disabled={off} checked={on}
                    onChange={e => set(i, { ...f, remind: e.target.checked ? [...f.remind, c.id] : f.remind.filter(x => x !== c.id) })} />
                  {c.icon}
                </label>
              );
            })}
            {f.due && !f.done && <span className="muted fu-at">reminded at 9 that morning</span>}
            </div>
          </li>
        ))}
      </ul>
      {value.length < 30 && (
        <button type="button" className="mt-add" onClick={() => onChange([...value, { text: "", kind: "promised", due: null, done: false, remind: ["desktop"] }])}>
          <Plus size={13} /> Add a follow-up
        </button>
      )}
    </>
  );
}

/**
 * "To follow up": every follow-up not yet done, from past meetings too (a
 * promise made on a call lives past the call), soonest due first. Tick one off
 * here, or open the meeting it came from.
 */
export function FollowUpBoard({ refresh, onOpenMeeting }: { refresh: number; onOpenMeeting: (id: number) => void }) {
  const [items, setItems] = useState<OpenFollowUp[] | null>(null);
  useEffect(() => { meetingsApi.followups().then(setItems).catch(() => setItems([])); }, [refresh]);

  async function tick(f: OpenFollowUp) {
    setItems(list => list?.filter(x => !(x.id === f.id && x.meeting_id === f.meeting_id)) ?? null);
    try {
      await meetingsApi.tickFollowUp(f.meeting_id, f.id, true);
      track("meeting.followup.done");
      toast.success("Done", { duration: 2000 });
    } catch (e) {
      notifyError(e);
      meetingsApi.followups().then(setItems).catch(() => {});
    }
  }

  if (!items?.length) return null;
  return (
    <section className="glass-card fu-board" aria-label="To follow up">
      <div className="fu-board-head"><ClipboardList size={14} /> <strong>To follow up</strong> <span className="muted">{items.length}</span></div>
      <ul>
        {items.map(f => {
          const n = f.due ? daysUntil(f.due) : null;
          return (
            <li key={`${f.meeting_id}:${f.id}`}>
              <button type="button" className="fu-tick" aria-label={`Mark done: ${f.text}`} title="Mark done" onClick={() => tick(f)}><Check size={12} /></button>
              <div className="fu-body">
                <div className="fu-line">{f.text}</div>
                <div className="fu-meta muted">
                  <span className={`fu-kind-chip ${f.kind}`}>{followUpKindLabel(f.kind)}</span>
                  {f.source === "notes" && <span className="fu-source" title="An action item from the notes of the call">from the notes</span>}
                  {f.due && <span className={n !== null && n < 0 ? "fu-overdue" : n === 0 ? "fu-today" : ""}>{dueLabel(f.due)}</span>}
                  <button type="button" className="fu-from" onClick={() => onOpenMeeting(f.meeting_id)}>
                    from {f.meeting_title}, {new Date(f.meeting_start).toLocaleDateString([], { day: "numeric", month: "short" })}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
