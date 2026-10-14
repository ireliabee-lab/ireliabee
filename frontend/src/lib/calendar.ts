/**
 * Calendar (roadmap 3.2): meetings from the user's calendars, and starting
 * the live session for one with its plan.
 */
import toast from "react-hot-toast";
import { defaultTemplate } from "./persona";

export interface Person { name: string; email: string; self?: boolean; }

export interface CalEvent {
  id: number;
  calendar_id: number;
  calendar: string;
  calendar_kind: string;
  uid: string;
  start: string;   // ISO, UTC
  end: string;
  all_day: boolean;
  title: string;
  location: string;
  description: string;
  organizer: Person | null;
  attendees: Person[];
  join_url: string;
  plan_id: number | null;
  plan_title: string | null;
}

export type Timing = "past" | "now" | "soon" | "later";

/** Where a meeting is relative to now; "soon" is the 15 minutes before it starts. */
export function timing(ev: Pick<CalEvent, "start" | "end" | "all_day">, now = Date.now()): { state: Timing; label: string } {
  const s = Date.parse(ev.start), e = Date.parse(ev.end);
  if (ev.all_day) return { state: e <= now ? "past" : "later", label: "All day" };
  if (e <= now) return { state: "past", label: "Ended" };
  if (s <= now) return { state: "now", label: "Now" };
  const min = Math.round((s - now) / 60000);
  if (min <= 15) return { state: "soon", label: min <= 1 ? "Starting" : `In ${min} min` };
  if (min < 60) return { state: "later", label: `In ${min} min` };
  const h = Math.floor(min / 60), m = min % 60;
  return { state: "later", label: h < 12 ? `In ${h} h${m ? ` ${m} min` : ""}` : "" };
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function timeRange(ev: Pick<CalEvent, "start" | "end" | "all_day">): string {
  return ev.all_day ? "All day" : `${clock(ev.start)} – ${clock(ev.end)}`;
}

/** "Today", "Tomorrow" or a weekday and date, in the user's time zone. */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}

/** Local calendar day of an event, for grouping. */
export const dayKey = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

const INTERVIEW = /\b(interview|screen(ing)?|recruit(er|ing)?|hiring|onsite|on-site|final round|technical round|assessment)\b/i;
const ONE_ON_ONE = /\b(1:1|1-1|1on1|one[- ]on[- ]one)\b/i;
const INTERVIEW_TEMPLATES = /interview|academic|residency|scholarship|thesis/;

/** The live coach that fits a meeting. */
export function templateFor(ev: Pick<CalEvent, "title" | "description">): string {
  const text = `${ev.title} ${ev.description}`;
  if (INTERVIEW.test(text)) {
    const mine = defaultTemplate();
    return INTERVIEW_TEMPLATES.test(mine) ? mine : "tech-interview";
  }
  if (ONE_ON_ONE.test(ev.title)) return "one-on-one";
  return "work-meeting";
}

export interface SessionPrefill {
  title: string; subtitle?: string; template?: string; planId?: number | null;
  /** The meeting it is for, so its notes and action items come back to it (H1b). */
  eventId?: number | null;
}

/** What the one-click start does: open the call (if it has a link) and listen to it. */
export interface MeetingStart extends SessionPrefill { joinUrl?: string; listen: boolean; }

/**
 * One click: a session for this meeting with the user's defaults, its plan on
 * screen, the Teams/Zoom/Meet call opened, and the coach listening to the call.
 */
export function joinAndListen(ev: CalEvent) {
  toast.dismiss(reminderId(ev));
  const detail: MeetingStart = { ...prefillFor(ev), joinUrl: ev.join_url || undefined, listen: true };
  window.dispatchEvent(new CustomEvent("start-meeting", { detail }));
}

/** Open the new-session wizard for this meeting, with its plan and a fitting coach. */
export function startMeeting(ev: CalEvent) {
  toast.dismiss(reminderId(ev));
  window.dispatchEvent(new CustomEvent("start-new-session", { detail: prefillFor(ev) }));
}

function prefillFor(ev: CalEvent): SessionPrefill {
  const emails = new Set([ev.organizer, ...ev.attendees].filter(p => p && !p.self && p.email).map(p => p!.email.toLowerCase()));
  const others = emails.size;
  return {
    title: ev.title,
    subtitle: [timeRange(ev), others ? `${others} ${others === 1 ? "person" : "people"}` : ""].filter(Boolean).join(" · "),
    template: templateFor(ev),
    planId: ev.plan_id,
    eventId: ev.id,
  };
}

/** The name of the app a join link opens, for button labels. */
export function callApp(url: string): string {
  if (/teams\.(microsoft|live)\.com/i.test(url)) return "Teams";
  if (/zoom\.us/i.test(url)) return "Zoom";
  if (/meet\.google\.com/i.test(url)) return "Meet";
  if (/webex\.com/i.test(url)) return "Webex";
  return "call";
}

/** The id of a meeting's reminder toast (one per occurrence). */
export const reminderId = (ev: Pick<CalEvent, "uid" | "start">) => `reminded:${ev.uid}:${ev.start}`;

/** Who a meeting is with, for one line of text. */
export function withWhom(ev: CalEvent): string {
  const others = ev.attendees.filter(a => !a.self && a.email !== ev.organizer?.email);
  const org = ev.organizer?.name || ev.organizer?.email || "";
  const names = others.slice(0, 2).map(a => a.name || a.email.split("@")[0]);
  const more = others.length > 2 ? ` +${others.length - 2}` : "";
  if (org && names.length) return `${org} · ${names.join(", ")}${more}`;
  return org || (names.join(", ") + more);
}

/** A session as the sessions list returns it: just what matching a meeting needs. */
export interface SessionSummary {
  id: number;
  status?: string | null;
  updated_at?: string | null;
  setup?: { event_id?: number | null; plan_id?: number | null } | null;
}

/** How recent a session made from the meeting's plan must be to count as this meeting's. */
const SAME_PLAN_WITHIN_MS = 36 * 3600_000;

/**
 * The session the user already set up for this meeting, if there is one, so
 * Join & listen opens it instead of making another. First a session started
 * from the meeting itself; else a recent one made from the meeting's plan.
 * Ended sessions never count; the most recently used wins.
 */
export function sessionForMeeting<S extends SessionSummary>(
  sessions: S[], meeting: { eventId?: number | null; planId?: number | null }, now = Date.now(),
): S | null {
  const open = sessions
    .filter(s => (s.status ?? "draft") !== "ended")
    .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "") || b.id - a.id);
  if (meeting.eventId != null) {
    const linked = open.find(s => s.setup?.event_id === meeting.eventId);
    if (linked) return linked;
  }
  if (meeting.planId != null) {
    const fromPlan = open.find(s => s.setup?.plan_id === meeting.planId && !s.setup?.event_id
      && now - Date.parse(s.updated_at ?? "") <= SAME_PLAN_WITHIN_MS);
    if (fromPlan) return fromPlan;
  }
  return null;
}
