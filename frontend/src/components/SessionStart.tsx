import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Loader2, Plus, Zap } from "lucide-react";
import Illustration from "./Illustration";
import type { SessionDraft } from "./CreateSessionWizard";
import { fetchApi } from "../lib/api";
import type { CalEvent, SessionPrefill } from "../lib/calendar";
import { isTypingTarget } from "../lib/liveKeys";
import { isLiveShortcut,lastUsed, meetingForQuickStart, quickStartDraft, type ListedSession } from "../lib/liveGate";

interface Option { id: string; label: string }

/**
 * The Live Companion when there is no session (lib/liveGate.ts). Listening,
 * answers, the question box and screen capture all belong to a session, so
 * instead of controls that half work, one step: start a session, or Quick
 * start one with the last session's coach, CV and language, named after the
 * meeting on now (or a plan waiting from "Use in session").
 *
 * The live keys (L, Y, R, C, …) do nothing here but point at this step.
 */
export default function SessionStart({ base, templates, languages, onStart, onQuickStart }: {
  base: SessionDraft;
  templates: Option[];
  languages: Option[];
  /** Open the New Session wizard. */
  onStart: () => void;
  /** Create the session straight away. */
  onQuickStart: (draft: SessionDraft, prefill: SessionPrefill) => Promise<void> | void;
}) {
  const [sessions, setSessions] = useState<ListedSession[] | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [plan, setPlan] = useState<{ id: number; title: string } | null>(null);
  const [cvs, setCvs] = useState<Option[]>([]);
  const [busy, setBusy] = useState(false);
  const [nudge, setNudge] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchApi("/sessions/").then(r => (r.ok ? r.json() : [])).then(s => alive && setSessions(s)).catch(() => alive && setSessions([]));
    // The calendar is optional (and Pro): no answer just means no meeting title.
    fetchApi("/calendar/events?days=1").then(r => (r.ok ? r.json() : [])).then(e => alive && setEvents(Array.isArray(e) ? e : [])).catch(() => {});
    fetchApi("/cvs/").then(r => (r.ok ? r.json() : [])).then(rows => alive && setCvs((rows as any[]).map(c => ({ id: String(c.id), label: c.name })))).catch(() => {});
    // "Use in session" from Plans leaves its plan waiting here; it opens with whichever session starts next.
    const waiting = localStorage.getItem("activePlanId");
    if (waiting) {
      fetchApi(`/plans/${waiting}`).then(r => (r.ok ? r.json() : null))
        .then(p => { if (alive && p?.id) setPlan({ id: p.id, title: p.title || "your plan" }); }).catch(() => {});
    }
    return () => { alive = false; };
  }, []);

  // Live keys with no session: say where to start instead of doing nothing silently.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (isTypingTarget(el) || isTypingTarget(e.target) || e.isComposing) return;
      if (e.key === "Enter" && el?.tagName === "BUTTON") return;
      if (document.querySelector(".debrief-overlay")) return;   // a dialog owns the keyboard
      if (!isLiveShortcut(e)) return;
      e.preventDefault();
      setNudge(n => n + 1);
      toast("Start a session first: that key works once one is running.", { id: "start-first", icon: "🎙️" });
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => {
    if (!nudge) return;
    const t = window.setTimeout(() => root.current?.classList.remove("nudge"), 600);
    root.current?.classList.add("nudge");
    return () => window.clearTimeout(t);
  }, [nudge]);

  const templateIds = new Set(templates.map(t => t.id));
  const last = lastUsed(sessions, templateIds);
  const meeting = meetingForQuickStart(events);
  const { draft, prefill } = quickStartDraft(base, { last, meeting: meeting as CalEvent | null, plan });
  const label = (list: Option[], id: string | null | undefined) => list.find(o => o.id === id)?.label;
  const cvLabel = draft.cvId != null ? label(cvs, String(draft.cvId)) : null;

  async function quick() {
    if (busy) return;
    setBusy(true);
    try { await onQuickStart(draft, prefill); } finally { setBusy(false); }
  }

  return (
    <div ref={root} className="session-start">
      <div className="session-empty">
        <Illustration name="listen" size={180} />
        <h3>Start a session to use the Live Companion</h3>
        <p>Listening to the call, your mic, coach answers, typed questions and screen capture all run inside a
          session, so what happens is saved with it and you can review it afterwards.</p>
        <div className="session-start-actions">
          <button className="btn-primary" onClick={onStart} title="Choose the title, coach, CV and language (N)">
            <Plus size={14} /> Start a session <span className="kbd">N</span>
          </button>
          <button className="btn-neutral" onClick={quick} disabled={busy || sessions == null}
            title="One click: a session with your usual settings">
            {busy ? <Loader2 size={14} className="spin" /> : <Zap size={14} />} Quick start
          </button>
        </div>
        <p className="session-start-quick">
          Quick start makes <strong>“{draft.title}”</strong>
          {" "}with {label(templates, draft.template) ?? "your usual coach"}, {label(languages, draft.language) ?? draft.language}
          {cvLabel ? <>, CV {cvLabel}</> : null}
          {prefill.planId && plan ? <>, and the plan <strong>{plan.title}</strong></> : null}.
          {meeting ? " Named after the meeting in your calendar." : last ? " Set up like your last session." : ""}
        </p>
        <button className="practice-crosslink" onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "warmup" }))}>
          Nervous? Take a two-minute voice warm-up first →
        </button>
      </div>
    </div>
  );
}
