/**
 * Your own meetings (backend/meetings.py): scheduled in iReliabee, with their
 * time zones, topics, what to prepare, who they are with and their reminders.
 * They sit in the calendar beside synced invites.
 */
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";
import type { CalEvent } from "./calendar";

export type Channel = "desktop" | "email" | "sms";
export interface Reminder { minutes: number; channels: Channel[] }
export interface MeetingPerson { id?: number; name?: string; email?: string }
/** Something to follow up: they asked it of you, you promised it, or your own to-do (H1). */
export type FollowUpKind = "asked" | "promised" | "todo";
export interface FollowUp {
  id?: string; text: string; kind: FollowUpKind; due: string | null; done: boolean; remind: Channel[];
  /** "notes": an action item taken from the call's notebook. */
  source?: "notes";
}

/** Open a notebook (the notes written from a call). */
export const openNotebook = (id: number | string) => window.dispatchEvent(new CustomEvent("navigate", { detail: `notebook:${id}` }));
/** An open follow-up with the meeting it came from (GET /calendar/followups). */
export interface OpenFollowUp extends Omit<FollowUp, "id"> {
  id: string;
  meeting_id: number; meeting_title: string; meeting_start: string; timezone: string | null;
}
export const FOLLOWUP_KINDS: { id: FollowUpKind; label: string }[] = [
  { id: "promised", label: "I promised" }, { id: "asked", label: "They asked" }, { id: "todo", label: "To do" },
];
export const followUpKindLabel = (k: FollowUpKind) => FOLLOWUP_KINDS.find(x => x.id === k)?.label ?? "To do";

export interface MeetingLink { kind: "plan" | "notebook" | "research" | "outreach" | "person"; id: number | string; label?: string }

export interface Meeting extends CalEvent {
  timezone: string | null;
  their_timezone: string | null;
  topics: string[];
  prep: string | null;
  notes: string | null;
  people: MeetingPerson[];
  links: MeetingLink[];
  reminders: Reminder[] | null;
  note_id: number | null;
  /** Who they are and why the meeting matters: for the "Get ready" brief. Only on this computer. */
  about?: string | null;
  followups?: FollowUp[];
  /** After a save: whether the email and text reminders reached ireliabee.co.uk (null when there are none). */
  remote?: RemoteResult | null;
}

/** What ireliabee.co.uk said about a meeting's email and text reminders. */
export interface RemoteResult { ok: boolean; message?: string; reminders?: number; texts?: number; credits?: number }

/** What a text reminder costs, as the service prices it (website/functions/_shared/reminders.js). */
export interface SmsPrice { credits_per_text: number; max_texts_per_reminder: number; about_pesewas: number }

/** The number text reminders go to, and what a text costs. */
export interface PhoneInfo { phone: string | null; confirmed: boolean; signed_in: boolean; price: SmsPrice | null }

/** What the form sends: a start in `timezone` without an offset, and how long it runs. */
export interface MeetingInput {
  title: string;
  start: string;            // "YYYY-MM-DDTHH:MM", read in `timezone`
  minutes: number;
  timezone: string;
  their_timezone?: string | null;
  location?: string;
  topics?: string[];
  prep?: string;
  notes?: string;
  people?: MeetingPerson[];
  links?: MeetingLink[];
  reminders?: Reminder[];
  about?: string;
  followups?: FollowUp[];
}

export const OWN_KIND = "ireliabee";
export const isOwn = (ev: Pick<CalEvent, "calendar_kind">) => ev.calendar_kind === OWN_KIND;

export const DEFAULT_REMINDERS: Reminder[] = [{ minutes: 30, channels: ["desktop"] }, { minutes: 15, channels: ["desktop"] }];
export const REMINDER_CHOICES = [5, 10, 15, 30, 60, 120, 1440];
export const DURATIONS = [15, 20, 25, 30, 45, 60, 90, 120];

/** Zones people meet across most often; any other IANA name can be typed. */
export const ZONES = [
  "Africa/Accra", "Europe/London", "Europe/Amsterdam", "Europe/Brussels", "Europe/Paris", "Europe/Berlin", "Europe/Zurich",
  "Europe/Stockholm", "America/New_York", "America/Toronto", "America/Indiana/Indianapolis", "America/Chicago",
  "America/Denver", "America/Los_Angeles", "Asia/Tokyo", "Asia/Seoul", "Asia/Hong_Kong", "Australia/Sydney",
  "Pacific/Auckland", "UTC",
];

export function localZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** "GMT", "GMT+1", "GMT-4": a zone's offset from GMT at a moment. */
export function offsetLabel(zone: string, at = new Date()): string {
  try {
    const name = new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(at).find(p => p.type === "timeZoneName")?.value ?? "GMT";
    // Engines differ at offset zero: "GMT", "GMT+0", "UTC", "UTC+00:00". All read "GMT".
    return /^(GMT|UTC)([+-]0+(:00)?)?$/.test(name) ? "GMT" : name.replace(/^UTC/, "GMT");
  } catch { return "GMT"; }
}

/**
 * How a zone reads in a list. The computer's own zone reads "Your time (GMT)":
 * Windows names Ghana's zone after another city that shares it, which confuses.
 */
export function zoneChoiceLabel(zone: string, mine = localZone()): string {
  return zone === mine ? `Your time (${offsetLabel(zone)})` : `${zoneLabel(zone)} (${offsetLabel(zone)})`;
}

/** "New York", "Accra", "Indianapolis". */
export function zoneLabel(zone: string): string {
  if (zone === "UTC") return "UTC";
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

/** A UTC time as the date and clock a form shows in `zone`: { date: "2026-10-02", time: "11:00" }. */
export function partsIn(iso: string, zone: string): { date: string; time: string } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** "11:00 am, Fri 2 Oct" in `zone`. */
export function timeIn(iso: string, zone: string, withDay = true): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true }).replace(/\s/g, " ");
  if (!withDay) return time;
  return `${time}, ${d.toLocaleDateString("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" })}`;
}

/** The meeting's time for the other side, when they are in another zone: "7:00 am in New York". */
export function theirTime(m: Pick<Meeting, "start" | "their_timezone">, mine = localZone()): string | null {
  if (!m.their_timezone || m.their_timezone === mine) return null;
  const a = partsIn(m.start, mine), b = partsIn(m.start, m.their_timezone);
  const sameDay = a.date === b.date;
  return `${timeIn(m.start, m.their_timezone, !sameDay)} in ${zoneLabel(m.their_timezone)}`;
}

/** "30 min", "1 h", "1 day" before. */
export function reminderLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/** A sticky note's text as a meeting: the first line is its title, the rest its topics. */
export function fromNoteText(text: string): { title: string; topics: string[] } {
  const lines = text.split("\n").map(l => l.replace(/^[\s\-•*]+/, "").trim()).filter(Boolean);
  return { title: (lines[0] ?? "").slice(0, 200), topics: lines.slice(1, 21) };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}
const send = <T>(path: string, method: string, body?: unknown) =>
  fetchApi(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(r => json<T>(r));

export const meetingsApi = {
  upcoming: (days = 60) => fetchApi(`/calendar/meetings?days=${days}`).then(r => json<Meeting[]>(r)),
  get: (id: number) => fetchApi(`/calendar/meetings/${id}`).then(r => json<Meeting>(r)),
  create: (m: MeetingInput) => send<Meeting>("/calendar/meetings", "POST", m),
  update: (id: number, m: Partial<MeetingInput>) => send<Meeting>(`/calendar/meetings/${id}`, "PATCH", m),
  remove: (id: number) => send<{ ok: boolean }>(`/calendar/meetings/${id}`, "DELETE"),
  /** Make (or move) the meeting for an Idea board note. */
  scheduleNote: (boardId: number, noteId: number, m: Partial<MeetingInput>) =>
    send<import("./boards").Note>(`/boards/${boardId}/notes/${noteId}/meeting`, "POST", m),
  unscheduleNote: (boardId: number, noteId: number, deleteMeeting = false) =>
    send<import("./boards").Note>(`/boards/${boardId}/notes/${noteId}/meeting?delete=${deleteMeeting}`, "DELETE"),
  /** Follow-ups not yet done, from every meeting, soonest due first. */
  followups: () => fetchApi("/calendar/followups").then(r => json<OpenFollowUp[]>(r)),
  tickFollowUp: (meetingId: number, followUpId: string, done = true) =>
    send<Meeting>(`/calendar/meetings/${meetingId}/followups/${followUpId}`, "POST", { done }),
  /** What an email or text reminder of this meeting will say. */
  reminderPreview: (m: MeetingInput) => send<{ subject: string; text: string }>("/calendar/meetings/reminder-preview", "POST", m),
  /** Send email and text reminders that could not reach the service before. */
  resend: () => send<{ sent: number }>("/calendar/meetings/resend", "POST"),
};

export const phoneApi = {
  get: () => fetchApi("/account/phone").then(r => json<PhoneInfo>(r)),
  start: (number: string) => send<{ sent_to: string }>("/account/phone", "POST", { number }),
  confirm: (code: string) => send<{ phone: string; confirmed: boolean }>("/account/phone/confirm", "POST", { code }),
};

/** How many SMS pages a reminder takes: one up to 160 characters, at most two (the service cuts the rest). */
export function smsPages(text: string, max = 2): number {
  return text.length <= 160 ? 1 : Math.min(max, Math.ceil(text.length / 153));
}

/** The most this meeting's text reminders can cost, in credits. */
export function textCost(reminders: Reminder[], price: SmsPrice, pagesEach: number): { texts: number; credits: number } {
  const count = reminders.filter(r => r.channels.includes("sms")).length;
  const texts = count * Math.min(pagesEach, price.max_texts_per_reminder);
  return { texts, credits: Math.round(texts * price.credits_per_text * 1e4) / 1e4 };
}

// ── Reminders on this computer (R1) ──────────────────────────────────────────

/** A reminder that is due: which meeting, how long before it, and its key (so it fires once). */
export interface DueReminder { ev: CalEvent & Partial<Meeting>; minutes: number; key: string }

/** How late a reminder may still fire (the app was asleep, or just opened). */
export const REMINDER_GRACE_MIN = 3;
/** Synced invites have no reminders of their own: one 5 minutes before, as before. */
const INVITE_REMINDER = [{ minutes: 5, channels: ["desktop"] as Channel[] }];

export const reminderKey = (ev: Pick<CalEvent, "uid" | "start">, minutes: number) => `rem:${ev.uid}:${ev.start}:${minutes}`;

/**
 * The desktop reminders due now: each meeting's own (or 5 minutes before for a
 * synced invite), from its moment until a few minutes after, never one already
 * given, and only the latest when several are due at once (the app was closed).
 */
export function dueReminders(events: (CalEvent & Partial<Meeting>)[], now: number, given: (key: string) => boolean): DueReminder[] {
  const out: DueReminder[] = [];
  for (const ev of events) {
    if (ev.all_day) continue;
    const start = Date.parse(ev.start);
    if (start <= now - 60_000) continue;                       // already started
    const list = (isOwn(ev) ? ev.reminders ?? DEFAULT_REMINDERS : INVITE_REMINDER).filter(r => r.channels.includes("desktop"));
    const due = list
      .filter(r => now >= start - r.minutes * 60_000 && now <= start - r.minutes * 60_000 + REMINDER_GRACE_MIN * 60_000)
      .sort((a, b) => a.minutes - b.minutes)[0];
    if (!due) continue;
    const key = reminderKey(ev, due.minutes);
    if (!given(key)) out.push({ ev, minutes: due.minutes, key });
  }
  return out;
}

/** What the reminder says: when, where, and what it's about. */
export function reminderText(ev: CalEvent & Partial<Meeting>, minutes: number): { title: string; body: string } {
  const lead = minutes >= 1440 ? `Tomorrow at ${timeIn(ev.start, localZone(), false)}` : minutes >= 60
    ? `In ${reminderLabel(minutes)}, at ${timeIn(ev.start, localZone(), false)}` : `In ${minutes} minutes, at ${timeIn(ev.start, localZone(), false)}`;
  const theirs = ev.their_timezone ? theirTime(ev as Meeting) : null;
  const lines = [
    theirs ? `${lead} (${theirs})` : lead,
    ev.topics?.length ? `Topics: ${ev.topics.slice(0, 4).join("; ")}` : "",
    ev.prep ? `Prepare: ${ev.prep}` : "",
    ev.join_url ? `Join: ${ev.join_url}` : ev.location ? `Where: ${ev.location}` : "",
  ].filter(Boolean);
  return { title: ev.title, body: lines.join("\n") };
}

// ── Follow-ups (H1) ──────────────────────────────────────────────────────────

/** Whole days from today to a "YYYY-MM-DD" date, in this computer's calendar (negative when past). */
export function daysUntil(due: string, now = new Date()): number {
  const [y, m, d] = due.split("-").map(Number);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86_400_000);
}

/** "Due today", "Due tomorrow", "Overdue by 2 days", "Due Wed 30 Sep". */
export function dueLabel(due: string, now = new Date()): string {
  const n = daysUntil(due, now);
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  if (n < 0) return `Overdue by ${-n} ${n === -1 ? "day" : "days"}`;
  const [y, m, d] = due.split("-").map(Number);
  return `Due ${new Date(y, m - 1, d).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}`;
}

/** When a follow-up's reminder comes on its due day: 9 in the morning, as ireliabee.co.uk sends it. */
export const FOLLOWUP_HOUR = 9;

/**
 * Follow-ups whose desktop reminder is due: from 9:00 on the due day until the
 * day ends (the app may have been closed at 9), once each, never for one done.
 */
export function dueFollowUps(list: OpenFollowUp[], now: Date, given: (key: string) => boolean): { f: OpenFollowUp; key: string }[] {
  if (now.getHours() < FOLLOWUP_HOUR) return [];
  return list
    .filter(f => f.due && !f.done && f.remind.includes("desktop") && daysUntil(f.due, now) === 0)
    .map(f => ({ f, key: `fu:${f.meeting_id}:${f.id}:${f.due}` }))
    .filter(x => !given(x.key));
}
