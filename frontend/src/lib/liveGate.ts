/**
 * The live screen needs a session.
 *
 * Listening, Respond / Auto Answer, the typed question box, coach answers and
 * screen capture all belong to a session: they save into it, bill against it
 * and end with it. Without one, the Live Companion shows one step instead —
 * start a session, or Quick start one with sensible defaults (SessionStart.tsx).
 *
 * The pure parts live here so they can be tested: which meeting a Quick start
 * is for, what it is called, what it is set up with, and which keys belong to
 * the live screen.
 */
import type { SessionDraft } from "../components/CreateSessionWizard";
import type { CalEvent, SessionPrefill } from "./calendar";

/** A meeting this close (or already running) names the Quick start session. */
export const QUICK_START_WINDOW_MIN = 15;

/**
 * The meeting a Quick start is for: one happening now, or the next one starting
 * within the window. All-day and finished meetings never count.
 */
export function meetingForQuickStart(
  events: Pick<CalEvent, "start" | "end" | "all_day" | "title">[] | null | undefined,
  now = Date.now(),
  windowMin = QUICK_START_WINDOW_MIN,
) {
  const fits = (events ?? []).filter(ev => {
    if (ev.all_day || !ev.title?.trim()) return false;
    const s = Date.parse(ev.start), e = Date.parse(ev.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= now) return false;
    return s - now <= windowMin * 60_000;
  });
  // The one about to start beats one that began an hour ago and runs on.
  fits.sort((a, b) => Math.abs(Date.parse(a.start) - now) - Math.abs(Date.parse(b.start) - now));
  return fits[0] ?? null;
}

/** "Session, 28 Sept 14:05" — the title when there is no meeting to name it after. */
export function fallbackTitle(now: Date = new Date()): string {
  const day = now.toLocaleDateString([], { day: "numeric", month: "short" });
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Session, ${day} ${time}`;
}

/** What the last session was set up with, as GET /sessions/ lists it. */
export interface ListedSession {
  mode?: string | null;
  language?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  tags?: string[] | null;
  setup?: { cv_id?: number | null } | null;
}

export interface LastUsed { template?: string; language?: string; cvId?: number | null }

/**
 * The template, language and CV of the most recent live session. Practice
 * runs are saved as sessions too (tagged "mock", or a voice mock), and are
 * not a live coach, so they are skipped; so is any mode that is not one of
 * the live templates, when the caller knows them.
 */
export function lastUsed(sessions: ListedSession[] | null | undefined, liveTemplates?: Set<string>): LastUsed | null {
  const at = (s: ListedSession) => Date.parse(s.updated_at || s.created_at || "") || 0;
  const live = (sessions ?? [])
    .filter(s => s.mode && s.mode !== "voice-mock" && !/^mock/.test(s.tags?.[0] ?? "")
      && (!liveTemplates || liveTemplates.has(s.mode)))
    .sort((a, b) => at(b) - at(a));
  const last = live[0];
  if (!last) return null;
  return {
    template: last.mode || undefined,
    language: last.language || undefined,
    cvId: last.setup?.cv_id ?? null,
  };
}

/**
 * The session Quick start makes: the defaults, the last session's template,
 * language and CV, titled after the meeting (or a plan waiting from "Use in
 * session"), else "Session, <date time>".
 */
export function quickStartDraft(
  base: SessionDraft,
  opts: {
    last?: LastUsed | null;
    meeting?: Pick<CalEvent, "title" | "plan_id"> | null;
    plan?: { id: number; title: string } | null;
    now?: Date;
  } = {},
): { draft: SessionDraft; prefill: SessionPrefill } {
  const { last, meeting, plan } = opts;
  const title = meeting?.title?.trim() || plan?.title?.trim() || fallbackTitle(opts.now);
  const draft: SessionDraft = {
    ...base,
    title,
    template: last?.template || base.template,
    language: last?.language || base.language,
    cvId: last?.cvId ?? base.cvId,
  };
  const planId = plan?.id ?? meeting?.plan_id ?? null;
  return { draft, prefill: { title, planId } };
}

/**
 * Keys that act on a live session (SessionView's shortcuts). With no session
 * they must not look like they did something: the start screen answers them
 * by pointing at the start step instead.
 */
const LIVE_KEYS = new Set(["r", "y", "l", "a", "c", "x", "p", "t", "o", "e", "g"]);

export function isLiveShortcut(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  const key = (e.key || "").toLowerCase();
  if ((e.metaKey || e.ctrlKey) && key === "s") return true;   // Save session
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return LIVE_KEYS.has(key) || e.key === "Enter";
}
