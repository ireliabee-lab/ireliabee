import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  BookOpen, BookOpenCheck, Check, ChevronLeft, ChevronRight, CircleHelp, ClipboardList, ExternalLink, Flame,
  Lightbulb, Loader2, Map as MapIcon, Mic, PartyPopper, PenLine, Play, RotateCcw, Sparkles, Trophy, Users, X,
} from "lucide-react";
import { openMockWith } from "./MockInterviewView";
import { ReviewDeck } from "./ResearchTerms";
import { countWords, researchApi, sessionProgress, speakSeconds, supervisorDetails, type Session, type SessionStep, type StepKind, type Track } from "../lib/research";
import { notifyError } from "../lib/errors";
import { openExternal } from "../lib/openExternal";

type GoTab = "papers" | "projects" | "readiness" | "roadmap";

/** The parts of a day both tracks share: Research and Wordcraft sessions have this shape. */
export interface GuidedStep { id: string; kind: string; title: string; done: boolean; lesson?: { title?: string } | null }
export interface GuidedDay {
  day: string; steps: GuidedStep[]; current: number | null; complete: boolean; started: boolean;
  minutes: number; streak: number;
  level: { id: number; name: string; lessons_done: number; lessons_total: number; exit_passed: boolean; levels: number };
  next_lesson: { id: string; title: string; minutes?: number } | null;
}
export type IconSet = Record<string, typeof BookOpen>;

const ICONS: Record<StepKind, typeof BookOpen> = {
  cards: BookOpenCheck, intro: Lightbulb, read: BookOpen, do: PenLine, speak: Mic, check: CircleHelp,
  weekly: Users, project: ClipboardList, exit: Trophy, unknown: Sparkles,
};

/** A line under each step in the journey, so the whole day reads at a glance. */
function caption(step: SessionStep): string {
  switch (step.kind) {
    case "cards": return `${step.due ?? 0} to review, ${step.new ?? 0} new`;
    case "intro": return step.lesson?.title ?? "";
    case "read": return `${step.lesson?.read?.length ?? 0} reading${step.lesson?.read?.length === 1 ? "" : "s"}`;
    case "do": return "Write it down";
    case "speak": return "Out loud, one minute";
    case "check": return "Can you explain it?";
    case "weekly": return WEEKLY[step.what ?? ""]?.title ?? "";
    case "project": return step.project?.title ?? "Start it";
    case "exit": return "The test that opens the next level";
    default: return "";
  }
}

const WEEKLY: Record<string, { title: string; text: string; action: string; go?: GoTab }> = {
  supervisor: { title: "Meet your Supervisor", text: "Your weekly meeting: what you did, what comes next, and where you are stuck. Ten minutes.", action: "Start the meeting" },
  journal_club: { title: "Present at journal club", text: "Pick a paper card and present it in five minutes: the question, the method, the result and one weakness.", action: "Choose a paper", go: "papers" },
  reviewer: { title: "Face Reviewer 2", text: "Defend your current project against a tough, fair reviewer.", action: "Open your project", go: "projects" },
  peer_review: { title: "Write a peer review", text: "Review a published paper, then compare with its public reviews.", action: "Open reviews", go: "projects" },
  sprint: { title: "A writing sprint", text: "25 minutes of focused writing on your project. Only writing, no editing.", action: "Open your project", go: "projects" },
  conference: { title: "Give your talk", text: "Present to the conference audience and take their questions.", action: "Open your talk", go: "projects" },
};

export default function ResearchSession({ track, onTab, onFocus }: {
  track: Track; onTab: (t: GoTab) => void; onFocus: (running: boolean) => void;
}) {
  const [s, setS] = useState<Session | null>(null);
  const [mode, setMode] = useState<"overview" | "run" | "cards">("overview");
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => { researchApi.session().then(setS).catch(notifyError); }, []);
  useEffect(() => { onFocus(mode !== "overview"); }, [mode, onFocus]);

  const apply = useCallback((next: Session, stay = false) => {
    setS(next);
    if (!stay && next.current !== null) setIdx(next.current);
  }, []);

  async function finish(step: SessionStep, body: { answer?: string; done?: boolean } = {}) {
    setBusy(true);
    try {
      const next = await researchApi.sessionStep(step.id, body);
      if (step.kind === "check" && body.done !== false) toast.success("Lesson complete");
      apply(next);
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  async function keepGoing() {
    setBusy(true);
    try { const next = await researchApi.sessionMore(); apply(next); setMode("run"); }
    catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  if (!s) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;

  if (mode === "cards") {
    const step = s.steps[idx];
    return (
      <div className="rs-frame rs-enter">
        <ReviewDeck onDone={async () => {
          try {
            const q = await researchApi.queue();
            if (!q.due.length && !q.new.length) await finish(step);
            else apply(await researchApi.session(), true);
          } catch (e) { notifyError(e); }
          setMode("run");
        }} />
      </div>
    );
  }

  if (mode === "run") {
    if (s.complete) return <Celebration s={s} busy={busy} onMore={keepGoing} onClose={() => setMode("overview")} onRoadmap={() => onTab("roadmap")} />;
    const step = s.steps[idx] ?? s.steps[s.current ?? 0];
    return (
      <div className="rs-frame">
        <Rail s={s} idx={idx} onPick={i => setIdx(i)} onClose={() => setMode("overview")} />
        <div key={step.id} className="rs-stage rs-enter">
          <StepView step={step} track={track} busy={busy} onTab={onTab}
            onFinish={body => finish(step, body)} onCards={() => setMode("cards")} />
        </div>
        <div className="rs-nav">
          <button className="btn-neutral" onClick={() => (idx === 0 ? setMode("overview") : setIdx(i => i - 1))}>
            <ChevronLeft size={15} /> {idx === 0 ? "Back to today" : "Back"}
          </button>
          {step.done && s.current !== null && idx !== s.current &&
            <button className="btn-neutral" onClick={() => setIdx(s.current!)}>Back to where I was <ChevronRight size={15} /></button>}
        </div>
      </div>
    );
  }

  return <Overview s={s} busy={busy} onStart={() => { setIdx(s.current ?? 0); setMode("run"); }}
    onMore={keepGoing} onCelebrate={() => setMode("run")} onRoadmap={() => onTab("roadmap")} />;
}

// ── The overview: today's journey at a glance ───────────────────────────────

export function Ring({ pct, size = 112, stroke = 9, children }: { pct: number; size?: number; stroke?: number; children?: React.ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="rs-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="rs-ring-track" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} className="rs-ring-fill" strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <div className="rs-ring-label">{children}</div>
    </div>
  );
}

export function LevelPath({ s, onRoadmap, unit = "Level" }: { s: GuidedDay; onRoadmap: () => void; unit?: string }) {
  return (
    <button className="rs-path" onClick={onRoadmap} title="Open the map">
      {Array.from({ length: s.level.levels }, (_, i) => (
        <span key={i} className={`rs-path-node ${i < s.level.id ? "done" : i === s.level.id ? "here" : ""}`}>
          {i < s.level.id ? <Check size={11} /> : i}
        </span>
      ))}
      <span className="rs-path-label"><MapIcon size={13} /> {unit} {s.level.id}: {s.level.name}</span>
    </button>
  );
}

export function Overview({ s, busy, onStart, onMore, onCelebrate, onRoadmap, icons = ICONS, describe = caption as (st: GuidedStep) => string, unit = "Level", fallback = "Review, practise and move your project on." }: {
  s: GuidedDay; busy: boolean; onStart: () => void; onMore: () => void; onCelebrate: () => void; onRoadmap: () => void;
  icons?: IconSet; describe?: (st: GuidedStep) => string; unit?: string; fallback?: string;
}) {
  const p = sessionProgress(s);
  const lesson = s.steps.find(x => x.lesson && !x.done)?.lesson ?? s.steps.find(x => x.lesson)?.lesson;
  const heading = s.complete ? "Done for today" : s.started ? "Welcome back" : "Today's session";
  const sub = s.complete
    ? (s.next_lesson ? `Tomorrow: ${s.next_lesson.title}` : `Every lesson in this ${unit.toLowerCase()} is done. The exit test is next.`)
    : lesson?.title ? lesson.title : fallback;

  return (
    <section className={`rs-hero rs-enter ${s.complete ? "is-complete" : ""}`}>
      <div className="rs-hero-glow" aria-hidden="true" />
      <div className="rs-hero-top">
        <div className="rs-hero-text">
          <div className="rs-eyebrow"><Sparkles size={13} /> {new Date(s.day + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</div>
          <h2 className="rs-hero-title">{heading}</h2>
          <p className="rs-hero-sub">{sub}</p>
          <div className="rs-chips">
            {!s.complete && s.minutes > 0 && <span className="rs-chip">About {s.minutes} min</span>}
            <span className={`rs-chip rs-streak ${s.streak ? "lit" : ""}`}><Flame size={13} /> {s.streak ? `${s.streak} day${s.streak === 1 ? "" : "s"} in a row` : "Start a streak today"}</span>
            <span className="rs-chip">Lesson {Math.min(s.level.lessons_done + (s.complete ? 0 : 1), s.level.lessons_total)} of {s.level.lessons_total}</span>
          </div>
        </div>
        <Ring pct={p.pct}>
          {s.complete ? <Check size={30} className="rs-ring-check" /> : <><b>{p.done}</b><span>of {p.total}</span></>}
        </Ring>
      </div>

      <ol className="rs-journey">
        {s.steps.map((step, i) => {
          const Icon = icons[step.kind] ?? Sparkles;
          const here = i === s.current;
          return (
            <li key={step.id} className={`rs-journey-item ${step.done ? "done" : ""} ${here ? "here" : ""}`} style={{ ["--i" as string]: i }}>
              <span className="rs-journey-dot">{step.done ? <Check size={14} /> : <Icon size={14} />}</span>
              <span className="rs-journey-text"><b>{step.title}</b><small>{describe(step)}</small></span>
            </li>
          );
        })}
      </ol>

      <div className="rs-hero-actions">
        {s.complete ? <>
          <button className="btn-primary rs-cta" disabled={busy} onClick={onMore}><Play size={16} /> Keep going</button>
          <button className="btn-neutral" onClick={onCelebrate}><PartyPopper size={15} /> Today's summary</button>
        </> : (
          <button className="btn-primary rs-cta" onClick={onStart}>
            <Play size={16} /> {s.started ? `Continue: step ${(s.current ?? 0) + 1} of ${p.total}` : "Start today's session"}
          </button>
        )}
      </div>
      <LevelPath s={s} onRoadmap={onRoadmap} unit={unit} />
    </section>
  );
}

// ── The runner ───────────────────────────────────────────────────────────────

export function Rail({ s, idx, onPick, onClose, icons = ICONS }: { s: GuidedDay; idx: number; onPick: (i: number) => void; onClose: () => void; icons?: IconSet }) {
  const p = sessionProgress(s);
  return (
    <div className="rs-rail">
      <div className="rs-rail-dots">
        {s.steps.map((step, i) => {
          const Icon = icons[step.kind] ?? Sparkles;
          const reachable = step.done || i === s.current;
          return (
            <button key={step.id} disabled={!reachable} title={step.title} onClick={() => onPick(i)}
              className={`rs-rail-dot ${step.done ? "done" : ""} ${i === idx ? "on" : ""}`}>
              {step.done ? <Check size={12} /> : <Icon size={12} />}
            </button>
          );
        })}
      </div>
      <div className="rs-rail-bar"><span style={{ width: `${p.pct}%` }} /></div>
      <div className="rs-rail-meta">
        <span>Step {idx + 1} of {p.total}</span>
        <button className="rs-rail-close" onClick={onClose} title="Pause: you'll come back to this step"><X size={14} /> Pause</button>
      </div>
    </div>
  );
}

function StepHead({ step, kicker }: { step: SessionStep; kicker?: string }) {
  const Icon = ICONS[step.kind];
  return (
    <header className="rs-step-head">
      <span className={`rs-step-icon k-${step.kind}`}><Icon size={22} /></span>
      <div>
        <div className="rs-eyebrow">{kicker ?? step.lesson?.title ?? ""}</div>
        <h2 className="rs-step-title">{step.title}</h2>
      </div>
    </header>
  );
}

export function NextButton({ onClick, busy, disabled, label = "Next" }: { onClick: () => void; busy: boolean; disabled?: boolean; label?: string }) {
  return (
    <button className="btn-primary rs-next" disabled={busy || disabled} onClick={onClick}>
      {busy ? <Loader2 size={16} className="spin" /> : null} {label} <ChevronRight size={16} />
    </button>
  );
}

function StepView({ step, track, busy, onFinish, onCards, onTab }: {
  step: SessionStep; track: Track; busy: boolean;
  onFinish: (body?: { answer?: string; done?: boolean }) => void; onCards: () => void; onTab: (t: GoTab) => void;
}) {
  const lesson = step.lesson;
  const next = (label?: string) => step.done
    ? <div className="rs-done-note"><Check size={15} /> Done</div>
    : <NextButton busy={busy} onClick={() => onFinish()} label={label} />;

  switch (step.kind) {
    case "cards":
      return (
        <div className="rs-card">
          <StepHead step={step} kicker="Warm up" />
          <p className="rs-lead">Say each word's meaning out loud, then turn the card and grade yourself honestly. The words you find hard come back sooner.</p>
          <div className="rs-stat-row">
            <div className="rs-stat"><b>{step.due ?? 0}</b><span>to review</span></div>
            <div className="rs-stat"><b>{step.new ?? 0}</b><span>new today</span></div>
            <div className="rs-stat"><b>10</b><span>minutes</span></div>
          </div>
          {step.done ? next() : (step.due || step.new)
            ? <button className="btn-primary rs-next" onClick={onCards}><Play size={15} /> Start the cards</button>
            : <NextButton busy={busy} onClick={() => onFinish()} label="Nothing due: next" />}
        </div>
      );

    case "intro":
      return (
        <div className="rs-card">
          <StepHead step={step} kicker={`Lesson · ${lesson?.minutes ?? ""} min${lesson?.pack_name ? ` · ${lesson.pack_name}` : ""}`} />
          <h3 className="rs-lesson-title">{lesson?.title}</h3>
          <blockquote className="rs-why"><Lightbulb size={16} /> {lesson?.why}</blockquote>
          {!!step.terms?.length && <>
            <div className="rs-section-label">Words for this lesson · tap a card to turn it</div>
            <div className="rs-flips">{step.terms.map((t, i) => <FlipCard key={t.term} term={t} i={i} />)}</div>
          </>}
          {next("Start the lesson")}
        </div>
      );

    case "read":
      return <ReadStep step={step} busy={busy} onFinish={onFinish} />;

    case "do":
      return <DoStep step={step} busy={busy} onFinish={onFinish} />;

    case "speak":
      return (
        <div className="rs-card">
          <StepHead step={step} />
          <p className="rs-prompt">{lesson?.speak}</p>
          <SpeakTimer key={step.id} seconds={speakSeconds(lesson?.speak ?? "")} />
          <div className="rs-actions">
            <button className="btn-neutral" onClick={() => openMockWith({
              scenario: "supervisor", subject: lesson?.title ?? track.field,
              details: `${supervisorDetails(track)}\n\nToday's speaking task: ${lesson?.speak ?? ""}`,
            })}><Mic size={15} /> Practise it with the Supervisor</button>
            {next("I said it out loud")}
          </div>
        </div>
      );

    case "check":
      return (
        <div className="rs-card">
          <StepHead step={step} />
          <p className="rs-prompt">{lesson?.check ?? "Can you explain what this lesson was about, in your own words?"}</p>
          <p className="rs-lead">Answer it out loud first. Be honest: "not yet" is how learning works.</p>
          {step.done ? next() : (
            <div className="rs-actions rs-check">
              <button className="btn-neutral" disabled={busy} onClick={() => onFinish({ done: false })}><RotateCcw size={15} /> Not yet, go back over it</button>
              <button className="btn-primary rs-next" disabled={busy} onClick={() => onFinish()}><Check size={16} /> Yes, I can explain it</button>
            </div>
          )}
        </div>
      );

    case "weekly": {
      const w = WEEKLY[step.what ?? ""] ?? { title: "This week", text: "", action: "Open" };
      return (
        <div className="rs-card">
          <StepHead step={step} kicker="Once a week" />
          <h3 className="rs-lesson-title">{w.title}</h3>
          <p className="rs-lead">{w.text}</p>
          <div className="rs-actions">
            <button className="btn-neutral" onClick={() => w.go ? onTab(w.go) : openMockWith({
              scenario: "supervisor", subject: track.brief ? track.brief.split(/[.\n]/)[0] : track.field, details: supervisorDetails(track),
            })}>{w.action} <ExternalLink size={14} /></button>
            {next("Done, next")}
          </div>
        </div>
      );
    }

    case "project":
      return (
        <div className="rs-card">
          <StepHead step={step} kicker="Build something real" />
          <h3 className="rs-lesson-title">{step.project?.title ?? "Start your project"}</h3>
          {step.project?.progress?.next && <p className="rs-lead">Next: {step.project.progress.next}</p>}
          {step.project?.progress && (
            <div className="rs-meter"><span style={{ width: `${Math.round((step.project.progress.done / Math.max(1, step.project.progress.total)) * 100)}%` }} /></div>
          )}
          <div className="rs-actions">
            <button className="btn-neutral" onClick={() => onTab("projects")}>Open the project <ExternalLink size={14} /></button>
            {next("I worked on it")}
          </div>
        </div>
      );

    case "exit":
      return <ExitStep step={step} busy={busy} onFinish={onFinish} onTab={onTab} />;

    default:
      return <div className="rs-card"><StepHead step={step} />{next()}</div>;
  }
}

function FlipCard({ term, i }: { term: { term: string; definition: string; example: string }; i: number }) {
  const [on, setOn] = useState(false);
  return (
    <button className={`rs-flip ${on ? "on" : ""}`} style={{ ["--i" as string]: i }} onClick={() => setOn(v => !v)} aria-pressed={on}>
      <span className="rs-flip-inner">
        <span className="rs-flip-face rs-flip-front"><b>{term.term}</b><small>Say what it means, then tap</small></span>
        <span className="rs-flip-face rs-flip-back"><span>{term.definition}</span>{term.example && <em>{term.example}</em>}</span>
      </span>
    </button>
  );
}

function ReadStep({ step, busy, onFinish }: { step: SessionStep; busy: boolean; onFinish: (b?: { answer?: string; done?: boolean }) => void }) {
  const reads = step.lesson?.read ?? [];
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(step.done ? reads.map(r => r.url) : []));
  const all = reads.every(r => ticked.has(r.url));
  const toggle = (url: string) => setTicked(t => { const n = new Set(t); if (n.has(url)) n.delete(url); else n.add(url); return n; });
  return (
    <div className="rs-card">
      <StepHead step={step} />
      <p className="rs-lead">Open each one, read it, then tick it off. Skim first, then read the parts that matter.</p>
      <div className="rs-reads">
        {reads.map((r, i) => (
          <div key={r.url} className={`rs-read ${ticked.has(r.url) ? "on" : ""}`} style={{ ["--i" as string]: i }}>
            <button className="rs-read-tick" onClick={() => toggle(r.url)} aria-pressed={ticked.has(r.url)} title="I've read it">
              {ticked.has(r.url) && <Check size={14} />}
            </button>
            <div className="rs-read-text"><b>{r.title}</b>{r.by && <small>{r.by}</small>}</div>
            <button className="btn-neutral rs-read-open" onClick={() => openExternal(r.url)}>Open <ExternalLink size={13} /></button>
          </div>
        ))}
      </div>
      {step.done ? <div className="rs-done-note"><Check size={15} /> Done</div>
        : <NextButton busy={busy} disabled={!all} onClick={() => onFinish()} label={all ? "Next" : `Tick ${reads.length - ticked.size} more`} />}
    </div>
  );
}

function DoStep({ step, busy, onFinish }: { step: SessionStep; busy: boolean; onFinish: (b?: { answer?: string; done?: boolean }) => void }) {
  const [text, setText] = useState(step.answer ?? "");
  const [saved, setSaved] = useState(true);
  const timer = useRef<number>();
  const words = countWords(text);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  function change(v: string) {
    setText(v); setSaved(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      researchApi.sessionStep(step.id, { answer: v, done: false }).then(() => setSaved(true)).catch(notifyError);
    }, 800);
  }
  return (
    <div className="rs-card">
      <StepHead step={step} />
      <p className="rs-prompt">{step.lesson?.do}</p>
      <textarea id={`rs-answer-${step.id}`} className="glass-input rs-answer" rows={8} value={text}
        placeholder="Write your answer here. It is saved as you type." onChange={e => change(e.target.value)} />
      <div className="rs-answer-meta"><span>{words} word{words === 1 ? "" : "s"}</span><span>{saved ? "Saved" : "Saving…"}</span></div>
      {step.done ? <div className="rs-done-note"><Check size={15} /> Done</div>
        : <NextButton busy={busy} disabled={words < 3} onClick={() => onFinish({ answer: text })} label={words < 3 ? "Write a little first" : "Next"} />}
    </div>
  );
}

function SpeakTimer({ seconds = 60 }: { seconds?: number }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (left === null || left <= 0) return;
    const t = window.setTimeout(() => setLeft(l => (l ?? 1) - 1), 1000);
    return () => window.clearTimeout(t);
  }, [left]);
  const pct = left === null ? 0 : ((seconds - left) / seconds) * 100;
  return (
    <div className={`rs-timer ${left !== null && left > 0 ? "running" : ""}`}>
      <Ring pct={pct} size={92} stroke={7}>
        {left === null ? <Mic size={22} /> : left > 0 ? <b>{left}</b> : <Check size={24} className="rs-ring-check" />}
      </Ring>
      <div>
        <b>{left === null ? `Speak for ${seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} seconds`}` : left > 0 ? "Keep talking…" : "Time. Well done."}</b>
        <p className="muted">{left === null ? "Start the timer and answer out loud. Pauses are fine." : left > 0 ? "No need to be fluent: say the idea clearly." : "Try once more if it felt rushed."}</p>
        <button className="btn-neutral" onClick={() => setLeft(seconds)}>{left === null ? <><Play size={14} /> Start the timer</> : <><RotateCcw size={14} /> Again</>}</button>
      </div>
    </div>
  );
}

function ExitStep({ step, busy, onFinish, onTab }: {
  step: SessionStep; busy: boolean; onFinish: (b?: { answer?: string; done?: boolean }) => void; onTab: (t: GoTab) => void;
}) {
  const exit = step.exit;
  const [going, setGoing] = useState(false);
  async function levelUp() {
    setGoing(true);
    try { await researchApi.advance(); toast.success("New level unlocked"); onFinish(); }
    catch (e) { notifyError(e); } finally { setGoing(false); }
  }
  return (
    <div className="rs-card">
      <StepHead step={step} kicker={exit?.exit?.title ?? "Exit test"} />
      {exit?.exit?.description && <p className="rs-lead">{exit.exit.description}</p>}
      <ul className="rs-checks">
        {exit?.checks.map(c => (
          <li key={c.id} className={c.met ? "met" : ""}><span className="rs-check-dot">{c.met && <Check size={12} />}</span>{c.label}<small>{c.value}</small></li>
        ))}
      </ul>
      <div className="rs-actions">
        {exit?.passed
          ? <button className="btn-primary rs-next rs-level-up" disabled={going || busy} onClick={levelUp}><Trophy size={16} /> Level up</button>
          : <>
              <button className="btn-neutral" onClick={() => onTab("readiness")}>See what's left <ExternalLink size={14} /></button>
              {step.done ? <div className="rs-done-note"><Check size={15} /> Done</div> : <NextButton busy={busy} onClick={() => onFinish()} label="Finish for today" />}
            </>}
      </div>
    </div>
  );
}

// ── Done for today ───────────────────────────────────────────────────────────

export function Celebration({ s, busy, onMore, onClose, onRoadmap, unit = "level" }: {
  s: GuidedDay; busy: boolean; onMore: () => void; onClose: () => void; onRoadmap: () => void; unit?: string;
}) {
  const pieces = useMemo(() => Array.from({ length: 28 }, (_, i) => i), []);
  const levelPct = s.level.lessons_total ? Math.round((s.level.lessons_done / s.level.lessons_total) * 100) : 0;
  return (
    <section className="rs-celebrate rs-enter">
      <div className="rs-confetti" aria-hidden="true">
        {pieces.map(i => <span key={i} style={{ ["--i" as string]: i }} />)}
      </div>
      <div className="rs-trophy"><PartyPopper size={34} /></div>
      <h2 className="rs-hero-title">You're done for today</h2>
      <p className="rs-hero-sub">Every step finished. Come back tomorrow to keep the streak going.</p>
      <div className="rs-stat-row">
        <div className="rs-stat rs-streak lit"><b><Flame size={18} /> {s.streak}</b><span>day{s.streak === 1 ? "" : "s"} in a row</span></div>
        <div className="rs-stat"><b>{s.steps.length}</b><span>steps done</span></div>
        <div className="rs-stat"><b>{s.level.lessons_done}/{s.level.lessons_total}</b><span>lessons in {unit} {s.level.id}</span></div>
      </div>
      <div className="rs-level-meter">
        <div className="rs-level-meter-label"><span>{unit[0].toUpperCase() + unit.slice(1)} {s.level.id}: {s.level.name}</span><span>{levelPct}%</span></div>
        <div className="rs-meter"><span style={{ width: `${levelPct}%` }} /></div>
      </div>
      {s.next_lesson && <p className="rs-tomorrow"><Sparkles size={14} /> Tomorrow: <b>{s.next_lesson.title}</b></p>}
      <div className="rs-actions rs-center">
        <button className="btn-neutral" onClick={onRoadmap}><MapIcon size={15} /> See the map</button>
        <button className="btn-neutral" onClick={onClose}>Back to Today</button>
        <button className="btn-primary" disabled={busy} onClick={onMore}><Play size={15} /> Keep going</button>
      </div>
    </section>
  );
}
