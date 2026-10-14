import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpenCheck, CalendarCheck, Check, ChevronRight, ClipboardList, Compass, Crown, Flame, Layers, Loader2, Lock, Mic, PenLine, Play,
  ScrollText, Star, Trophy, Users, X } from "lucide-react";
import { calendarWeeks, climbPoints, milestonesApi, monthLabels, niceMax, MILESTONE_EVENT, STREAK_STEPS,
  type Activity, type DayDetail, type Milestone, type TrackName } from "../lib/milestones";

/**
 * Milestones and progress charts, shared by the Research track and Wordcraft.
 *
 * MilestoneOverlay pops confetti when something is reached: a new level or
 * realm fills the screen, smaller things (a streak, a count of lessons) get a
 * badge at the foot of the window with a small burst. ProgressCharts draws the
 * calendar, the weekly bars, the climb, each level's lessons and the trophies.
 */

const KIND_ICON: Record<string, typeof Trophy> = {
  lesson: BookOpenCheck, level: Crown, exit: Trophy, streak: Flame, days: CalendarCheck,
  cards: Layers, paper: ScrollText, skill: Star, mission: Compass,
};
export const milestoneIcon = (kind: string) => KIND_ICON[kind] ?? Trophy;

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// ── Confetti ─────────────────────────────────────────────────────────────────

interface Piece { x: number; y: number; vx: number; vy: number; r: number; vr: number; w: number; h: number; color: string; shape: 0 | 1 | 2; wob: number }

function themeColors(): string[] {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const rgb = (name: string) => (v(name) ? `rgb(${v(name)})` : "");
  return [v("--primary"), rgb("--highlight-rgb"), v("--success"), "#f59e0b", "#f472b6", rgb("--accent-rgb")].filter(Boolean);
}

/** A burst of confetti on a canvas over the whole window. Big bursts fire from both bottom corners. */
function ConfettiBurst({ big, from }: { big: boolean; from?: { x: number; y: number } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || reducedMotion()) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth, H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    const colors = themeColors();
    const pieces: Piece[] = [];
    const launch = (x: number, y: number, n: number, angle: number, spread: number, speed: number) => {
      for (let i = 0; i < n; i++) {
        const a = angle + (Math.random() - 0.5) * spread;
        const s = speed * (0.55 + Math.random() * 0.6);
        pieces.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
          w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, color: colors[i % colors.length],
          shape: (i % 3) as 0 | 1 | 2, wob: Math.random() * 10 });
      }
    };
    if (big) {
      launch(0, H, 90, -Math.PI / 3.2, 0.9, Math.min(W, H) * 0.045);
      launch(W, H, 90, -Math.PI + Math.PI / 3.2, 0.9, Math.min(W, H) * 0.045);
      launch(W / 2, H * 0.42, 50, -Math.PI / 2, Math.PI * 2, Math.min(W, H) * 0.02);
    } else {
      const o = from ?? { x: W / 2, y: H - 90 };
      launch(o.x, o.y, 60, -Math.PI / 2, 1.6, Math.min(W, H) * 0.028);
    }
    let raf = 0, t = 0;
    const tick = () => {
      t++;
      ctx.clearRect(0, 0, W, H);
      let alive = 0;
      for (const p of pieces) {
        p.vy += 0.32; p.vx *= 0.985; p.vy *= 0.985;
        p.x += p.vx + Math.sin((t + p.wob) / 9) * 0.8; p.y += p.vy; p.r += p.vr;
        if (p.y > H + 30) continue;
        alive++;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, 1.6 - t / 140));
        ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.color;
        if (p.shape === 1) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); }
        else { const flip = Math.abs(Math.cos((t + p.wob) / 6)); ctx.fillRect(-p.w / 2, -p.h / 2 * flip, p.w, (p.shape === 2 ? p.h * 1.6 : p.h) * flip); }
        ctx.restore();
      }
      if (alive && t < 240) raf = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [big, from]);
  return <canvas ref={ref} className="ms-confetti" aria-hidden="true" />;
}

// ── The overlay ──────────────────────────────────────────────────────────────

/** Watches for milestones on one track and celebrates each, one at a time. */
export function MilestoneOverlay({ track }: { track: TrackName }) {
  const api = useMemo(() => milestonesApi(track), [track]);
  const [queue, setQueue] = useState<Milestone[]>([]);
  const [shown, setShown] = useState(false);
  const handled = useRef(new Set<string>());
  const timer = useRef<number>();

  const look = useCallback(() => {
    api.list().then(r => {
      const fresh = r.pending.filter(m => !handled.current.has(m.key));
      fresh.forEach(m => handled.current.add(m.key));
      if (fresh.length) setQueue(q => [...q, ...fresh]);
    }).catch(() => {});                                   // a missed celebration is not worth an error
  }, [api]);

  useEffect(() => {
    look();
    const onEvent = (e: Event) => {
      if ((e as CustomEvent).detail?.track !== track) return;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(look, 700);       // card reviews come in quick runs: look once
    };
    window.addEventListener(MILESTONE_EVENT, onEvent);
    return () => { window.removeEventListener(MILESTONE_EVENT, onEvent); window.clearTimeout(timer.current); };
  }, [look, track]);

  const current = queue[0];
  // A short pause first, so a finished day's own celebration lands before a milestone covers it.
  useEffect(() => {
    setShown(false);
    if (!current) return;
    const t = window.setTimeout(() => setShown(true), current.big ? 900 : 500);
    return () => window.clearTimeout(t);
  }, [current]);

  const dismiss = useCallback(() => {
    if (!current) return;
    api.seen([current.key]).catch(() => {});
    setQueue(q => q.slice(1));
  }, [api, current]);

  useEffect(() => {
    if (!shown || !current) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || (current.big && e.key === "Enter")) dismiss(); };
    window.addEventListener("keydown", onKey);
    if (current.big) return () => window.removeEventListener("keydown", onKey);
    const t = window.setTimeout(dismiss, 6500);
    return () => { window.removeEventListener("keydown", onKey); window.clearTimeout(t); };
  }, [shown, current, dismiss]);

  if (!current || !shown) return null;
  const Icon = milestoneIcon(current.kind);
  const more = queue.length - 1;
  if (current.big) {
    return (
      <div className="ms-backdrop" onClick={dismiss}>
        <ConfettiBurst big key={current.key} />
        <div className="ms-modal" role="dialog" aria-modal="true" aria-labelledby="ms-title" onClick={e => e.stopPropagation()}>
          <div className="ms-rays" aria-hidden="true" />
          <div className="ms-badge big"><Icon size={40} /></div>
          <div className="ms-eyebrow">Milestone reached</div>
          <h2 id="ms-title" className="ms-title">{current.title}</h2>
          {current.body && <p className="ms-body">{current.body}</p>}
          <button className="btn-primary" autoFocus onClick={dismiss}>{more ? `Next (${more} more)` : "Keep going"}</button>
        </div>
      </div>
    );
  }
  return (
    <>
      <ConfettiBurst big={false} key={current.key} />
      <div className="ms-toast" role="status">
        <div className="ms-badge"><Icon size={22} /></div>
        <div className="ms-toast-text">
          <b>{current.title}</b>
          {current.body && <span>{current.body}</span>}
        </div>
        <button className="ms-close" aria-label="Close" onClick={dismiss}><X size={15} /></button>
      </div>
    </>
  );
}

// ── Charts ───────────────────────────────────────────────────────────────────

const fmtDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
};

/** Where a click in the progress charts can take the learner. */
export type OpenTarget =
  | { kind: "today" }
  | { kind: "lesson"; id: string }
  | { kind: "session"; id: number }
  | { kind: "writing" };

function Calendar({ a, selected, onPick }: { a: Activity; selected: string; onPick: (day: string) => void }) {
  const cols = useMemo(() => calendarWeeks(a, 26), [a]);
  const months = useMemo(() => monthLabels(cols), [cols]);
  const cell = 14, gap = 3, left = 30, top = 18;
  const w = left + cols.length * (cell + gap), h = top + 7 * (cell + gap);
  const scroller = useRef<HTMLDivElement>(null);
  // In a narrow window the calendar scrolls: open it on the latest weeks.
  useEffect(() => { const el = scroller.current; if (el) el.scrollLeft = el.scrollWidth; }, [cols]);
  return (
    <div className="ms-cal-wrap">
      <div className="ms-scroll" ref={scroller}>
        <svg className="ms-cal" width={w} height={h} viewBox={`0 0 ${w} ${h}`}
          aria-label={`Activity calendar: ${a.days_finished} days finished. Pick a day to see what you did.`}>
          {months.map((m, i) => m && <text key={i} x={left + i * (cell + gap)} y={11} className="ms-axis">{m}</text>)}
          {["Mon", "Wed", "Fri"].map((d, i) => <text key={d} x={0} y={top + (i * 2) * (cell + gap) + cell - 3} className="ms-axis">{d}</text>)}
          {cols.map((col, ci) => col.map((c, ri) => c.future ? null : (
            <rect key={c.day} x={left + ci * (cell + gap)} y={top + ri * (cell + gap)} width={cell} height={cell} rx={3}
              className={`ms-cell l${c.level}${c.day === a.today ? " today" : ""}${c.day === selected ? " picked" : ""}`}
              tabIndex={0} role="button" aria-pressed={c.day === selected} aria-label={fmtDay(c.day)}
              onClick={() => onPick(c.day)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(c.day); } }}>
              <title>{fmtDay(c.day)}: {c.data ? (c.data.complete ? "the whole day done" : `${c.data.done} of ${c.data.planned} steps`)
                + (c.data.lessons ? `, ${c.data.lessons} lesson${c.data.lessons === 1 ? "" : "s"}` : "") : "nothing"}</title>
            </rect>
          )))}
        </svg>
      </div>
      <div className="ms-legend"><span>Less</span>{[0, 1, 2, 3, 4].map(l => <i key={l} className={`ms-cell-key l${l}`} />)}<span>More</span></div>
      <p className="ms-cal-hint">A full square is a whole day's session. Pick any day to see what you did.</p>
    </div>
  );
}

const STEP_ICON: Record<string, typeof Trophy> = {
  cards: Layers, lesson: BookOpenCheck, weekly: Users, project: ClipboardList, exit: Trophy, mission: Compass,
};

/** One day in full: the session's steps, lessons finished, practice rounds and writing, each one openable. */
function DayPanel({ track, day, today, onOpen }: { track: TrackName; day: string; today: string; onOpen?: (t: OpenTarget) => void }) {
  const api = useMemo(() => milestonesApi(track), [track]);
  const [d, setD] = useState<DayDetail | null>(null);
  useEffect(() => {
    let live = true;
    setD(null);
    api.day(day).then(v => { if (live) setD(v); }).catch(() => {});
    return () => { live = false; };
  }, [api, day]);
  const isToday = day === today;
  const nothing = d && !d.steps.length && !d.lessons.length && !d.rounds.length && !d.writing?.length;
  return (
    <div className="ms-day" aria-live="polite" key={day}>
      <div className="ms-day-head">
        <b>{isToday ? "Today" : fmtDay(day)}</b>
        {d?.planned && <span className={`ms-day-chip${d.complete ? " done" : ""}`}>{d.complete ? "Whole day done" : "Part done"}</span>}
      </div>
      {!d && <div className="ms-day-empty"><Loader2 size={15} className="spin" /></div>}
      {nothing && (
        <div className="ms-day-empty">
          <p className="muted">{isToday ? "Nothing yet today." : "No session this day."}</p>
          {isToday && onOpen && <button className="btn-primary" onClick={() => onOpen({ kind: "today" })}><Play size={14} /> Start today</button>}
        </div>
      )}
      {d && !nothing && (
        <ul className="ms-day-list">
          {d.steps.map(st => {
            const Icon = STEP_ICON[st.kind] ?? CalendarCheck;
            const full = st.done >= st.total;
            const target: OpenTarget | null = st.kind === "lesson" ? { kind: "lesson", id: st.id } : isToday ? { kind: "today" } : null;
            return (
              <li key={st.id}>
                <span className={`ms-day-ico${full ? " done" : ""}`}>{full ? <Check size={13} /> : <Icon size={13} />}</span>
                <span className="ms-day-text"><b>{st.label}</b>
                  <small>{st.kind === "lesson" ? `Lesson · ${st.done} of ${st.total} parts` : full ? "Done" : "Not done"}</small></span>
                {target && onOpen && <button className="ms-day-go" onClick={() => onOpen(target)}>
                  {target.kind === "lesson" ? "Open lesson" : "Go to today"} <ChevronRight size={13} /></button>}
              </li>
            );
          })}
          {d.lessons.filter(l => !d.steps.some(st => st.kind === "lesson" && st.id === l.id)).map(l => (
            <li key={l.id}>
              <span className="ms-day-ico done"><Check size={13} /></span>
              <span className="ms-day-text"><b>{l.title}</b><small>Lesson finished</small></span>
              {onOpen && <button className="ms-day-go" onClick={() => onOpen({ kind: "lesson", id: l.id })}>Open lesson <ChevronRight size={13} /></button>}
            </li>
          ))}
          {d.rounds.map(r => (
            <li key={r.id}>
              <span className="ms-day-ico"><Mic size={13} /></span>
              <span className="ms-day-text"><b>{r.title}</b>
                <small>{r.score != null ? `Scored ${r.score}/10` : "Practice round"}{r.answers ? ` · ${r.answers} answer${r.answers === 1 ? "" : "s"}` : ""}</small></span>
              {onOpen && <button className="ms-day-go" onClick={() => onOpen({ kind: "session", id: r.id })}>Open round <ChevronRight size={13} /></button>}
            </li>
          ))}
          {d.writing?.map(w => (
            <li key={`w${w.id}`}>
              <span className="ms-day-ico"><PenLine size={13} /></span>
              <span className="ms-day-text"><b>Writing, {w.words} words</b>
                <small>{w.score != null ? `The Editor scored it ${w.score}/10` : "Saved"}</small></span>
              {onOpen && <button className="ms-day-go" onClick={() => onOpen({ kind: "writing" })}>Open writing <ChevronRight size={13} /></button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WeekBars({ a, accuracy }: { a: Activity; accuracy: boolean }) {
  const W = 520, H = 170, pad = { l: 28, r: accuracy ? 34 : 8, t: 14, b: 26 };
  const max = niceMax(Math.max(...a.weeks.map(w => w.lessons), 1));
  const bw = (W - pad.l - pad.r) / a.weeks.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ya = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v);
  const acc = a.weeks.map((w, i) => (w.accuracy == null ? null : { x: pad.l + bw * i + bw / 2, y: ya(w.accuracy) }));
  const line = acc.filter(Boolean).map((p, i) => `${i ? "L" : "M"}${p!.x.toFixed(1)},${p!.y.toFixed(1)}`).join(" ");
  return (
    <svg className="ms-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Lessons finished each week">
      {[0, max / 2, max].map(v => (
        <g key={v}><line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="ms-grid" />
          <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="ms-axis">{v}</text></g>
      ))}
      {accuracy && [0, 0.5, 1].map(v => <text key={v} x={W - pad.r + 6} y={ya(v) + 4} className="ms-axis acc">{v * 100}%</text>)}
      {a.weeks.map((w, i) => {
        const x = pad.l + bw * i + bw * 0.18, bh = H - pad.b - y(w.lessons);
        const thisWeek = i === a.weeks.length - 1;
        return (
          <g key={w.week}>
            <rect x={x} y={y(w.lessons)} width={bw * 0.64} height={Math.max(bh, w.lessons ? 2 : 0)} rx={4}
              className={`ms-bar${thisWeek ? " now" : ""}`} style={{ ["--i" as string]: i }}>
              <title>Week of {fmtDay(w.week)}: {w.lessons} lesson{w.lessons === 1 ? "" : "s"}, {w.days} full day{w.days === 1 ? "" : "s"}
                {w.accuracy != null ? `, ${Math.round(w.accuracy * 100)}% right first try` : ""}</title>
            </rect>
            {(i % 2 === a.weeks.length % 2 || thisWeek) &&
              <text x={x + bw * 0.32} y={H - 8} textAnchor="middle" className="ms-axis">{thisWeek ? "now" : fmtDay(w.week).split(" ").slice(1).join(" ")}</text>}
          </g>
        );
      })}
      {accuracy && line && <path d={line} className="ms-line acc" />}
      {accuracy && acc.map((p, i) => p && <circle key={i} cx={p.x} cy={p.y} r={3.2} className="ms-dot acc" />)}
    </svg>
  );
}

function Climb({ a }: { a: Activity }) {
  const W = 520, H = 170, pad = { l: 28, r: 8, t: 14, b: 26 };
  const pts = climbPoints(a);
  const max = niceMax(Math.max(...pts.map(p => p.y), 1));
  const X = (x: number) => pad.l + (W - pad.l - pad.r) * x;
  const Y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  const area = `${d} L${X(1)},${Y(0)} L${X(0)},${Y(0)} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg className="ms-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Lessons done so far: ${last.y}`}>
      <defs>
        <linearGradient id="ms-climb-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="ms-stop-a" /><stop offset="1" className="ms-stop-b" />
        </linearGradient>
      </defs>
      {[0, max / 2, max].map(v => (
        <g key={v}><line x1={pad.l} x2={W - pad.r} y1={Y(v)} y2={Y(v)} className="ms-grid" />
          <text x={pad.l - 6} y={Y(v) + 4} textAnchor="end" className="ms-axis">{v}</text></g>
      ))}
      <path d={area} fill="url(#ms-climb-fill)" />
      <path d={d} className="ms-line" />
      <circle cx={X(1)} cy={Y(last.y)} r={4.5} className="ms-dot" />
      <text x={X(0)} y={H - 8} className="ms-axis">{fmtDay(a.start).split(" ").slice(1).join(" ")}</text>
      <text x={X(1)} y={H - 8} textAnchor="end" className="ms-axis">today</text>
    </svg>
  );
}

function LevelBars({ a, unit }: { a: Activity; unit: string }) {
  return (
    <ul className="ms-levels">
      {a.levels.map((lv, i) => {
        const pct = lv.total ? Math.round((lv.done / lv.total) * 100) : 0;
        const state = lv.skipped ? "skipped" : lv.state;
        return (
          <li key={lv.id} className={`ms-level ${state}`} style={{ ["--i" as string]: i }}>
            <span className="ms-level-id">{lv.id}</span>
            <span className="ms-level-name">{lv.name}{lv.cefr ? <small> · {lv.cefr}</small> : null}</span>
            <span className="ms-level-bar"><span style={{ width: `${state === "skipped" ? 100 : pct}%` }} /></span>
            <span className="ms-level-num">
              {state === "skipped" ? "placed past" : state === "locked" && !lv.done ? <><Lock size={11} /> locked</> : `${lv.done}/${lv.total}`}
            </span>
          </li>
        );
      })}
      <li className="ms-level-foot muted">Lessons done in each {unit}{a.levels.some(l => l.skipped) ? "; your placement check started you past the greyed ones" : ""}.</li>
    </ul>
  );
}

function Trophies({ earned, a }: { earned: Milestone[]; a: Activity }) {
  const nextStreak = STREAK_STEPS.find(s => s > a.best_streak);
  const nextLessons = [1, 5, 10, 25, 50].find(s => s > a.lessons_finished);
  const next = [
    nextStreak && { title: `${nextStreak}-day streak`, hint: `best so far: ${a.best_streak}`, kind: "streak" },
    nextLessons && { title: nextLessons === 1 ? "First lesson done" : `${nextLessons} lessons done`, hint: `${a.lessons_finished} so far`, kind: "lesson" },
  ].filter(Boolean) as { title: string; hint: string; kind: string }[];
  return (
    <div className="ms-trophies">
      {earned.map((m, i) => {
        const Icon = milestoneIcon(m.kind);
        return (
          <div key={m.key} className={`ms-trophy${m.big ? " big" : ""}`} style={{ ["--i" as string]: i }} title={m.body}>
            <div className="ms-badge"><Icon size={18} /></div>
            <b>{m.title}</b><small>{fmtDay(m.earned_at.slice(0, 10))}</small>
          </div>
        );
      })}
      {next.map(n => {
        const Icon = milestoneIcon(n.kind);
        return (
          <div key={n.title} className="ms-trophy next">
            <div className="ms-badge"><Icon size={18} /></div>
            <b>{n.title}</b><small>Next · {n.hint}</small>
          </div>
        );
      })}
    </div>
  );
}

/** The analytics block: streak tiles, calendar, weekly bars, the climb, each level and the trophies. */
export function ProgressCharts({ track, unit, onOpen }: { track: TrackName; unit: "level" | "realm"; onOpen?: (t: OpenTarget) => void }) {
  const api = useMemo(() => milestonesApi(track), [track]);
  const [a, setA] = useState<Activity | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [earned, setEarned] = useState<Milestone[]>([]);
  useEffect(() => {
    api.activity().then(setA).catch(() => setA(null));
    api.list().then(r => setEarned(r.earned)).catch(() => {});
  }, [api]);
  if (!a) return null;
  const accuracy = a.weeks.some(w => w.accuracy != null);
  return (
    <div className="ms-progress">
      <div className="rs-stat-row">
        <div className={`rs-stat rs-streak${a.streak ? " lit" : ""}`}><b><Flame size={18} /> {a.streak}</b><span>day streak now</span></div>
        <div className="rs-stat"><b>{a.best_streak}</b><span>best streak</span></div>
        <div className="rs-stat"><b>{a.days_finished}</b><span>full days finished</span></div>
        <div className="rs-stat"><b>{a.lessons_finished}</b><span>lessons done</span></div>
      </div>
      <section className="rs-card ms-card">
        <div className="rs-section-label">Your last six months</div>
        <div className="ms-cal-row">
          <Calendar a={a} selected={picked ?? a.today} onPick={setPicked} />
          <DayPanel track={track} day={picked ?? a.today} today={a.today} onOpen={onOpen} />
        </div>
      </section>
      <div className="ms-pair">
        <section className="rs-card ms-card">
          <div className="rs-section-label">Lessons each week{accuracy && <span className="ms-key-acc"> · right first try</span>}</div>
          <WeekBars a={a} accuracy={accuracy} />
        </section>
        <section className="rs-card ms-card">
          <div className="rs-section-label">The climb: lessons done so far</div>
          <Climb a={a} />
        </section>
      </div>
      <section className="rs-card ms-card">
        <div className="rs-section-label">{unit === "realm" ? "Realm by realm" : "Level by level"}</div>
        <LevelBars a={a} unit={unit} />
      </section>
      <section className="rs-card ms-card">
        <div className="rs-section-label">Trophies</div>
        {earned.length ? null : <p className="muted">Your first trophy comes with your first lesson. Every milestone lands here.</p>}
        <Trophies earned={earned} a={a} />
      </section>
    </div>
  );
}
