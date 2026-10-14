import { useEffect, useRef } from "react";
import { CalendarClock, Headphones, Play, X } from "lucide-react";
import { type CalEvent, callApp, timeRange } from "../lib/calendar";
import { reminderText, type Meeting } from "../lib/meetings";
import { CHIME_AGAIN_MS, playChime } from "../lib/reminderSound";

/** What the main window hands the reminder window: the meeting, and how far off it is. */
export interface ReminderData { ev: CalEvent & Partial<Meeting>; minutes: number; sound?: boolean }

/** The meeting fields the reminder and its buttons use: long text stays behind. */
export function reminderPayload(ev: CalEvent & Partial<Meeting>, minutes: number, sound = false): string {
  const { description: _d, notes: _n, about: _a, followups: _f, people: _p, links: _l, ...kept } = ev;
  const data: ReminderData = { ev: { ...kept, description: "" }, minutes, sound };
  return encodeURIComponent(JSON.stringify(data));
}

export function parseReminder(raw: string | null): ReminderData | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return d && d.ev && typeof d.ev.title === "string" ? d : null;
  } catch {
    return null;
  }
}

/** A clock whose hand sweeps while pings ripple out: the meeting is coming up. */
function ReminderClock() {
  return (
    <svg className="reminder-clock" viewBox="0 0 80 80" aria-hidden="true">
      <circle className="rc-ping" cx="40" cy="40" r="22" />
      <circle className="rc-ping rc-ping-2" cx="40" cy="40" r="22" />
      <g className="rc-orbit"><circle cx="40" cy="6" r="3" /></g>
      <circle className="rc-face" cx="40" cy="40" r="22" />
      {Array.from({ length: 12 }, (_, i) => (
        <line key={i} className="rc-tick" x1="40" y1="21" x2="40" y2={i % 3 ? 23 : 25} transform={`rotate(${i * 30} 40 40)`} />
      ))}
      <line className="rc-hour" x1="40" y1="40" x2="40" y2="30" />
      <line className="rc-hand" x1="40" y1="40" x2="40" y2="24" />
      <circle className="rc-hub" cx="40" cy="40" r="2.5" />
    </svg>
  );
}

/** How long a reminder stays once the meeting is under way, if nobody answers it. */
const STAYS_AFTER_START_MS = 15 * 60_000;

/**
 * The meeting reminder in its own small window (src-tauri: show_reminder):
 * the in-app card, over every other window, until a button is pressed.
 */
export default function ReminderWindow({ data, raw }: { data: ReminderData; raw: string }) {
  const { ev, minutes } = data;
  const { body } = reminderText(ev, minutes);

  const choose = async (choice: "join" | "setup" | "later") => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("reminder_choice", { choice, data: raw });
    } catch {
      window.close();
    }
  };

  // The window starts at its largest; it then shrinks to the card, so no empty band.
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = card.current;
    if (!el) return;
    const fit = () => {
      const height = el.offsetHeight;
      if (!height) return;
      import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("fit_reminder", { height: Math.ceil(height) }))
        .catch(() => {});
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // A soft chime now, and once more if it is still here two minutes on.
  useEffect(() => {
    if (!data.sound) return;
    playChime();
    const again = window.setTimeout(playChime, CHIME_AGAIN_MS);
    return () => window.clearTimeout(again);
  }, [data.sound]);

  // Answered or not, a reminder for a meeting well under way has done its job.
  useEffect(() => {
    const left = Date.parse(ev.start) + STAYS_AFTER_START_MS - Date.now();
    const t = window.setTimeout(() => void choose("later"), Math.max(0, left));
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={card} className="reminder-window" role="alertdialog" aria-label={`Reminder: ${ev.title}`}>
      <div className="reminder-window-head" data-tauri-drag-region>
        <CalendarClock size={16} />
        <strong data-tauri-drag-region>{ev.title}</strong>
        <button className="reminder-window-close" title="Later" onClick={() => void choose("later")}><X size={14} /></button>
      </div>
      <div className="reminder-window-body">
        <div className="reminder-window-text">
          <div className="reminder-window-when">{body.split("\n")[0]}</div>
          <div className="muted">
            {timeRange(ev)}{ev.plan_title ? ` · plan: ${ev.plan_title}` : ""}
          </div>
          {ev.topics?.length ? <div className="muted reminder-window-topics">{ev.topics.slice(0, 3).join(" · ")}</div> : null}
        </div>
        <ReminderClock />
      </div>
      <div className="meeting-reminder-actions">
        <button className="btn-primary" onClick={() => void choose("join")}
          title={ev.join_url ? `Open the ${callApp(ev.join_url)} call and start the coach listening` : "Start the session and the coach listening"}>
          <Headphones size={12} /> {ev.join_url ? "Join & listen" : "Start & listen"}
        </button>
        <button className="btn-neutral" onClick={() => void choose("setup")} title="Choose the coach, CV and language first">
          <Play size={12} /> Set up
        </button>
        <button className="btn-neutral" onClick={() => void choose("later")}>Later</button>
      </div>
    </div>
  );
}
