import { useEffect } from "react";
import toast from "react-hot-toast";
import { CalendarClock, Headphones, Play } from "lucide-react";
import { fetchApi, isTauri } from "../lib/api";
import { type CalEvent, callApp, joinAndListen, reminderId, startMeeting, timeRange } from "../lib/calendar";
import { dueFollowUps, dueReminders, followUpKindLabel, meetingsApi, reminderText, type Meeting } from "../lib/meetings";
import { keepInTray, notify, setKeepInTray } from "../lib/notify";
import { listeningNow, reminderSound } from "../lib/reminderSound";
import { track } from "../lib/usage";
import { parseReminder, reminderPayload } from "./ReminderWindow";

const SYNC_EVERY = 15 * 60_000;
const CHECK_EVERY = 30_000;
/** Reminders already given, kept a day so a restart doesn't repeat them. */
const GIVEN_KEY = "ireliabee.remindersGiven";

function given(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(GIVEN_KEY) || "{}"); } catch { return {}; }
}
function markGiven(key: string) {
  try {
    const now = Date.now();
    const kept = Object.fromEntries(Object.entries(given()).filter(([, t]) => now - t < 36 * 3600_000));
    localStorage.setItem(GIVEN_KEY, JSON.stringify({ ...kept, [key]: now }));
  } catch { /* reminders just may repeat */ }
}

function remind(ev: CalEvent & Partial<Meeting>, minutes: number) {
  const { title, body } = reminderText(ev, minutes);
  // Also in Windows' notification centre, so it can be found afterwards.
  void notify(title, body);
  if (isTauri()) {
    // Its own window, over everything, until answered: the system pop-up
    // leaves after a few seconds and the card below needs the app open.
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("show_reminder", { data: reminderPayload(ev, minutes, reminderSound() && !listeningNow()) }))
      .catch(() => remindInApp(ev, minutes, body));
    return;
  }
  remindInApp(ev, minutes, body);
}

function remindInApp(ev: CalEvent & Partial<Meeting>, minutes: number, body: string) {
  toast(t => (
    <div className="meeting-reminder">
      <div className="meeting-reminder-head"><CalendarClock size={15} /> <strong>{ev.title}</strong></div>
      <div className="muted">{minutes >= 60 ? body.split("\n")[0] : `${timeRange(ev)} · in ${minutes} min`}{ev.plan_title ? ` · plan: ${ev.plan_title}` : ""}</div>
      {ev.topics?.length ? <div className="muted">{ev.topics.slice(0, 3).join(" · ")}</div> : null}
      <div className="meeting-reminder-actions">
        <button className="btn-primary" onClick={() => { track("calendar.reminder.join_listen"); toast.dismiss(t.id); joinAndListen(ev); }}
          title={ev.join_url ? `Open the ${callApp(ev.join_url)} call and start the coach listening` : "Start the session and the coach listening"}>
          <Headphones size={12} /> {ev.join_url ? "Join & listen" : "Start & listen"}
        </button>
        <button className="btn-neutral" onClick={() => { track("calendar.reminder.start"); toast.dismiss(t.id); startMeeting(ev); }}
          title="Choose the coach, CV and language first">
          <Play size={12} /> Set up
        </button>
        <button className="btn-neutral" onClick={() => toast.dismiss(t.id)}>Later</button>
      </div>
    </div>
  ), { duration: Math.min(minutes, 15) * 60_000 + 60_000, id: reminderId(ev) });
}

/**
 * Keeps calendars in sync in the background and gives each meeting's
 * reminders: your own meetings' (30 and 15 minutes before unless you chose
 * others), 5 minutes before a synced invite. Each is a system notification and
 * a card in the app offering to start the coach. Renders nothing.
 */
export default function MeetingReminders() {
  useEffect(() => {
    let alive = true;
    // Calendars, and any email or text reminders that could not reach ireliabee.co.uk before.
    const sync = () => Promise.all([
      fetchApi("/calendar/sync", { method: "POST" }).catch(() => {}),
      fetchApi("/calendar/meetings/resend", { method: "POST" }).catch(() => {}),
    ]);
    const check = async () => {
      // Two days, so a reminder a day before is seen.
      const events: (CalEvent & Partial<Meeting>)[] = await fetchApi("/calendar/events?days=2").then(r => (r.ok ? r.json() : [])).catch(() => []);
      if (!alive) return;
      const seen = given();
      for (const due of dueReminders(events, Date.now(), key => key in seen)) {
        markGiven(due.key);
        remind(due.ev, due.minutes);
      }
      // Follow-ups due today (a promise to send a plan, a form to fill): once, from 9 in the morning.
      const followups = await meetingsApi.followups().catch(() => []);
      if (!alive) return;
      for (const { f, key } of dueFollowUps(followups, new Date(), k => k in seen)) {
        markGiven(key);
        void notify(`Due today: ${f.text}`, `${followUpKindLabel(f.kind)}, from ${f.meeting_title}`);
        toast(`Due today: ${f.text}`, { duration: 60_000, icon: "📌" });
      }
    };
    sync().then(check);
    void setKeepInTray(keepInTray());          // the window starts from the saved choice
    // The first time the window is closed, say that iReliabee is still in the tray (so reminders come).
    let unlisten: (() => void) | undefined;
    let unlistenChoice: (() => void) | undefined;
    if (isTauri()) {
      import("@tauri-apps/api/event").then(({ listen }) => listen("hidden-to-tray", () => {
        try { if (localStorage.getItem("ireliabee.trayExplained")) return; localStorage.setItem("ireliabee.trayExplained", "1"); } catch { /* say it again next time */ }
        void notify("iReliabee is still running", "It sits in the tray so your meeting reminders arrive. Click the tray icon to open it, or choose Quit there.");
      })).then(u => { unlisten = u; }).catch(() => {});
      // A button pressed on the reminder window (Join & listen, Set up).
      import("@tauri-apps/api/event").then(({ listen }) => listen<[string, string]>("reminder-choice", e => {
        const [choice, raw] = e.payload;
        const d = parseReminder(decodeURIComponent(raw));
        if (!d) return;
        if (choice === "join") { track("calendar.reminder.join_listen"); joinAndListen(d.ev); }
        if (choice === "setup") { track("calendar.reminder.start"); startMeeting(d.ev); }
      })).then(u => { unlistenChoice = u; }).catch(() => {});
    }
    const s = setInterval(sync, SYNC_EVERY);
    const c = setInterval(check, CHECK_EVERY);
    return () => { alive = false; clearInterval(s); clearInterval(c); unlisten?.(); unlistenChoice?.(); };
  }, []);
  return null;
}
