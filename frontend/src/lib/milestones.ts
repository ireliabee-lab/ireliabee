// Milestones and activity for the Research track and Wordcraft (backend/milestones.py).
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";

export type TrackName = "research" | "wordcraft";

/** The streak lengths that earn a milestone (kept in step with STREAKS in backend/milestones.py). */
export const STREAK_STEPS = [3, 7, 14, 30, 60, 100, 200, 365];

export interface Milestone {
  key: string; kind: string; title: string; body: string; big: boolean; earned_at: string; seen: boolean;
}
export interface ActivityDay { day: string; planned: number; done: number; complete: boolean; lessons: number }
export interface ActivityWeek { week: string; lessons: number; days: number; exercises?: number; accuracy?: number | null }
export interface ActivityLevel { id: number; name: string; cefr?: string; done: number; total: number; state: "done" | "current" | "locked"; skipped?: boolean }
export interface Activity {
  today: string; start: string; days: ActivityDay[]; weeks: ActivityWeek[]; climb: { day: string; total: number }[];
  streak: number; best_streak: number; days_finished: number; lessons_finished: number; levels: ActivityLevel[];
}

export interface DayDetail {
  day: string; planned: boolean; complete: boolean;
  steps: { kind: string; id: string; label: string; done: number; total: number }[];
  lessons: { id: string; title: string }[];
  rounds: { id: number; title: string; score: number | null; answers: number }[];
  writing?: { id: number; score: number | null; words: number; lesson_id: string }[];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}

export const milestonesApi = (track: TrackName) => ({
  list: () => fetchApi(`/${track}/milestones`).then(r => json<{ pending: Milestone[]; earned: Milestone[] }>(r)),
  seen: (keys: string[]) => fetchApi(`/${track}/milestones/seen`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }),
  }).then(r => json<{ ok: boolean }>(r)),
  activity: () => fetchApi(`/${track}/activity`).then(r => json<Activity>(r)),
  day: (day: string) => fetchApi(`/${track}/activity/day/${encodeURIComponent(day)}`).then(r => json<DayDetail>(r)),
});

/** Ask the milestone overlay to look again: something was just done that may have earned one. */
export const MILESTONE_EVENT = "ireliabee:milestones";
export function checkMilestones(track: TrackName) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(MILESTONE_EVENT, { detail: { track } }));
}

// ── The calendar ─────────────────────────────────────────────────────────────

export interface CalendarCell { day: string; level: 0 | 1 | 2 | 3 | 4; future: boolean; data?: ActivityDay }

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };

/** How much happened on a day, 0-4: nothing, opened, some steps, most steps, the whole day. */
export function dayLevel(d?: ActivityDay): 0 | 1 | 2 | 3 | 4 {
  if (!d) return 0;
  if (d.complete) return 4;
  const share = d.planned ? d.done / d.planned : 0;
  if (share >= 0.6 || d.lessons >= 1) return 3;
  if (d.done > 0) return 2;
  return 1;
}

/** Columns of weeks (Monday first), the last `weeks` weeks up to today; days after today are marked future. */
export function calendarWeeks(a: Pick<Activity, "today" | "days">, weeks = 26): CalendarCell[][] {
  const byDay = new Map(a.days.map(d => [d.day, d]));
  const today = parse(a.today);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const first = new Date(monday);
  first.setDate(monday.getDate() - (weeks - 1) * 7);
  const out: CalendarCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: CalendarCell[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(first);
      d.setDate(first.getDate() + w * 7 + i);
      const key = iso(d);
      const data = byDay.get(key);
      col.push({ day: key, level: dayLevel(data), future: d > today, data });
    }
    out.push(col);
  }
  return out;
}

/** Month labels for the calendar's columns: the month's short name where it starts, else "". */
export function monthLabels(cols: CalendarCell[][]): string[] {
  let last = -1, lastAt = -9;
  return cols.map((col, i) => {
    const m = parse(col[col.length - 1].day).getMonth();     // the month the week ends in
    if (m === last) return "";
    last = m;
    if (i - lastAt < 3) return "";                            // too close to the last label to fit
    lastAt = i;
    return parse(col[col.length - 1].day).toLocaleString("en-GB", { month: "short" });
  });
}

/** The climb as a step line over the last `span` days: [{x 0-1, y total}] ready to scale. */
export function climbPoints(a: Pick<Activity, "climb" | "start" | "today">): { x: number; y: number }[] {
  const t0 = parse(a.start).getTime(), t1 = parse(a.today).getTime();
  const span = Math.max(1, t1 - t0);
  const before = a.climb.filter(c => c.day < a.start).pop()?.total ?? 0;
  const pts = [{ x: 0, y: before }];
  for (const c of a.climb.filter(c => c.day >= a.start)) {
    const x = (parse(c.day).getTime() - t0) / span;
    pts.push({ x, y: pts[pts.length - 1].y }, { x, y: c.total });
  }
  pts.push({ x: 1, y: pts[pts.length - 1].y });
  return pts;
}

/** A round ceiling for a chart's axis, and ticks at nice steps. */
export function niceMax(n: number): number {
  if (n <= 4) return 4;
  const step = n <= 10 ? 2 : n <= 25 ? 5 : n <= 50 ? 10 : 25;
  return Math.ceil(n / step) * step;
}
