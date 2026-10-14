import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import toast from "react-hot-toast";
import remarkGfm from "remark-gfm";
import { BarChart3, BookOpen, BookOpenCheck, ClipboardList, Map as MapIcon, CalendarCheck, CheckCircle2, Circle, ExternalLink, FlaskConical, Layers, Loader2, Lock,
  Mic, Radar, ScrollText, Sparkles, Trophy, Users } from "lucide-react";
import Page, { PageTab } from "./Page";
import { openMockWith } from "./MockInterviewView";
import ResearchTerms, { ReviewDeck } from "./ResearchTerms";
import ResearchPapers from "./ResearchPapers";
import ResearchProjects from "./ResearchProjects";
import ResearchSession from "./ResearchSession";
import { MilestoneOverlay, ProgressCharts, type OpenTarget } from "./Milestones";
import { GOALS, mentorEmail, researchApi, roadmapTheme, scoreLabel, supervisorDetails, type Goal, type Level, type Lesson, type Readiness,
  type Today, type Track, type ExitStatus, type MeetingReport, type Pack, type SignOff } from "../lib/research";
import { renderToStaticMarkup } from "react-dom/server";
import { notifyError } from "../lib/errors";
import { openExternal } from "../lib/openExternal";
import { track as trackUsage } from "../lib/usage";
import guide from "../content/research-guide.md?raw";

type Tab = "guide" | "roadmap" | "today" | "ladder" | "papers" | "projects" | "terms" | "progress" | "readiness";
const TABS: { id: Tab; label: string; icon: JSX.Element; hint: string }[] = [
  { id: "guide",     label: "Guide",     icon: <BookOpen size={14} />,      hint: "Research Track: newcomer to research scientist" },
  { id: "roadmap",   label: "Roadmap",   icon: <MapIcon size={14} />,           hint: "The whole track as an interactive map" },
  { id: "today",     label: "Today",     icon: <CalendarCheck size={14} />, hint: "What to do today" },
  { id: "ladder",    label: "Ladder",    icon: <Layers size={14} />,        hint: "Levels, lessons and exit tests" },
  { id: "papers",    label: "Papers",    icon: <ScrollText size={14} />,    hint: "Your paper cards" },
  { id: "projects",  label: "Projects",  icon: <ClipboardList size={14} />, hint: "Your proposal and replication" },
  { id: "terms",     label: "Terms",     icon: <BookOpenCheck size={14} />, hint: "Your term bank" },
  { id: "progress",  label: "Progress",  icon: <BarChart3 size={14} />,     hint: "Your streak, calendar, charts and trophies" },
  { id: "readiness", label: "Readiness", icon: <Radar size={14} />,         hint: "Skills and what to work on" },
];
const isTab = (v: unknown): v is Tab => TABS.some(t => t.id === v);

/**
 * Research Track: the ladder from newcomer to research scientist. Today's list,
 * the curriculum, paper cards, a spaced-repetition term bank and the skill
 * scores behind them. Nothing on this screen spends credits; the Supervisor
 * and Journal Club sessions run in Practice.
 */
export default function ResearchView({ section }: { section?: string }) {
  const [tab, setTab] = useState<Tab>(() => (isTab(section) ? section : "today"));
  // Clicking Today while already on it leaves a running session for the day's overview.
  const [todayKey, setTodayKey] = useState(0);
  const [track, setTrack] = useState<Track | null | undefined>(undefined);
  const [levels, setLevels] = useState<Level[]>([]);
  const [reviewing, setReviewing] = useState(false);
  // A lesson picked from the Progress calendar: the Ladder opens on it.
  const [focusLesson, setFocusLesson] = useState<string | null>(null);
  const openFrom = (t: OpenTarget) => {
    if (t.kind === "today") { setTodayKey(k => k + 1); setTab("today"); }
    else if (t.kind === "lesson") { setFocusLesson(t.id); setTab("ladder"); }
    else if (t.kind === "session") window.dispatchEvent(new CustomEvent("navigate", { detail: `history:open:${t.id}` }));
  };

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([researchApi.track(), researchApi.curriculum()]);
      setTrack(t.track);
      setLevels(c.levels);
    } catch (e) { notifyError(e); setTrack(null); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { trackUsage(`research.tab.${tab}`); }, [tab]);

  const level = track ? levels.find(l => l.id === track.level) : undefined;
  const subtitle = track
    ? `${track.field} · Level ${track.level}${level ? `: ${level.name}` : ""}`
    : "A path from newcomer to research scientist, one level at a time.";

  if (track === undefined) {
    return <Page title="Research" subtitle={subtitle}><div className="page-content progress-loading"><Loader2 size={18} className="spin" /></div></Page>;
  }
  if (track === null) {
    return <Page title="Research" subtitle={subtitle}><Setup onStarted={load} /><div className="page-content"><Guide /></div></Page>;
  }
  if (reviewing) {
    return (
      <Page title="Research" subtitle="Term review">
        <div className="page-content"><ReviewDeck onDone={() => { setReviewing(false); load(); }} /></div>
        <MilestoneOverlay track="research" />
      </Page>
    );
  }
  return (
    <Page
      title="Research"
      subtitle={subtitle}
      tabs={<>{TABS.map(t => (
        <PageTab key={t.id} active={tab === t.id} title={t.hint} icon={t.icon} onClick={() => { if (t.id === "today" && tab === "today") setTodayKey(k => k + 1); setTab(t.id); }}>{t.label}</PageTab>
      ))}</>}
    >
      <div className="page-content">
        {tab === "guide" && <Guide />}
        {tab === "roadmap" && <Roadmap />}
        {tab === "today" && <TodayTab key={todayKey} track={track} onReview={() => setReviewing(true)} onTab={setTab} />}
        {tab === "ladder" && <><Packs onChange={load} /><Ladder levels={levels} track={track} onChange={load} focus={focusLesson} /></>}
        {tab === "papers" && <ResearchPapers />}
        {tab === "projects" && <ResearchProjects />}
        {tab === "terms" && <ResearchTerms onReview={() => setReviewing(true)} />}
        {tab === "progress" && <ProgressCharts track="research" unit="level" onOpen={openFrom} />}
        {tab === "readiness" && <ReadinessTab onTab={setTab} track={track} onTrack={load} />}
      </div>
      <MilestoneOverlay track="research" />
    </Page>
  );
}

// ── Guide ────────────────────────────────────────────────────────────────────

/** The framework itself, "Research Track: newcomer to research scientist". Links open in the browser. */
function Guide() {
  return (
    <article className="research-doc">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => <a onClick={() => href && openExternal(href)} title={href}>{children}</a>,
        table: ({ children }) => <div className="research-doc-table"><table>{children}</table></div>,
      }}>{guide}</ReactMarkdown>
    </article>
  );
}

// ── Roadmap ──────────────────────────────────────────────────────────────────

/** The whole track as an interactive map: levels, pillars, the panel, the materials and the build plan. */
function Roadmap() {
  const frame = useRef<HTMLIFrameElement>(null);

  // Give the map the app's colours, now and whenever the theme changes.
  useEffect(() => {
    const root = document.documentElement;
    const paint = () => {
      const doc = frame.current?.contentDocument?.documentElement;
      if (!doc) return;
      const css = getComputedStyle(root);
      const { tokens, light } = roadmapTheme(name => css.getPropertyValue(name), root.hasAttribute("data-light"));
      doc.setAttribute("data-theme", light ? "light" : "dark");
      for (const [k, val] of Object.entries(tokens)) doc.style.setProperty(k, val);
    };
    const el = frame.current;
    el?.addEventListener("load", paint);
    paint();
    const watch = new MutationObserver(paint);
    watch.observe(root, { attributes: true, attributeFilter: ["style", "data-theme", "data-light"] });
    return () => { el?.removeEventListener("load", paint); watch.disconnect(); };
  }, []);

  return (
    <iframe ref={frame} className="research-roadmap" src="/research-roadmap.html" title="Research Track roadmap"
      sandbox="allow-scripts allow-same-origin" />
  );
}

// ── Setup ────────────────────────────────────────────────────────────────────

function Setup({ onStarted }: { onStarted: () => void }) {
  const [field, setField] = useState("");
  const [goal, setGoal] = useState<Goal>("phd");
  const [hours, setHours] = useState(10);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      await researchApi.start({ field, goal, weekly_hours: hours, brief });
      trackUsage("research.start");
      onStarted();
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  return (
    <div className="page-content research-setup">
      <div className="glass-card research-hero">
        <FlaskConical size={22} />
        <div>
          <h2>Start your Research Track</h2>
          <p className="muted">Seven levels, each ending in a test you pass by doing: reading papers, defending a question,
            replicating a result, writing, speaking. About 10 hours a week takes most people from newcomer to their first
            independent project in 9 to 12 months. Everything here is free; practice sessions with the Supervisor and
            Journal Club use credits like any other practice.</p>
        </div>
      </div>
      <div className="glass-card research-form">
        <label className="settings-label" htmlFor="rt-field">Your field</label>
        <input id="rt-field" className="glass-input" value={field} onChange={e => setField(e.target.value)}
          placeholder="e.g. Speech and language science, Machine learning, Economics" />
        <label className="settings-label">What you're aiming for</label>
        <div className="research-goals">
          {GOALS.map(g => (
            <button key={g.id} className={`scenario-option ${goal === g.id ? "active" : ""}`} onClick={() => setGoal(g.id)}>{g.label}</button>
          ))}
        </div>
        <label className="settings-label" htmlFor="rt-hours">Hours a week</label>
        <input id="rt-hours" className="glass-input research-hours" type="number" min={1} max={60} value={hours}
          onChange={e => setHours(Number(e.target.value) || 10)} />
        <label className="settings-label" htmlFor="rt-brief">Your project, if you have one (optional)</label>
        <textarea id="rt-brief" className="glass-input" rows={4} value={brief} onChange={e => setBrief(e.target.value)}
          placeholder="The question you want to work on, the data, the people involved. The Supervisor reads this." />
        <div className="research-actions">
          <button className="btn-primary" disabled={!field.trim() || busy} onClick={start}>
            {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Start level 0
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Today ────────────────────────────────────────────────────────────────────

function TodayTab({ track, onReview, onTab }: { track: Track; onReview: () => void; onTab: (t: Tab) => void }) {
  const [data, setData] = useState<Today | null>(null);
  const [focus, setFocus] = useState(false);
  useEffect(() => { researchApi.today().then(setData).catch(notifyError); }, [focus]);
  const cards = data ? data.reviews.due + data.reviews.new : 0;

  return (
    <>
    <ResearchSession track={track} onTab={onTab} onFocus={setFocus} />
    {!focus && !data && <div className="progress-loading"><Loader2 size={18} className="spin" /></div>}
    {!focus && data && <>
    <div className="rs-more-label">Everything else for today</div>
    <div className="research-today">
      <section className="glass-card research-item">
        <header><BookOpenCheck size={15} /> Term reps <span className="muted">· 10 min</span></header>
        <p>{cards ? `${data.reviews.due} due and ${data.reviews.new} new term${data.reviews.new === 1 ? "" : "s"}. Say each answer out loud before you turn the card.`
          : "Nothing due. Your next cards come back tomorrow."}</p>
        {cards > 0 && <button className="btn-primary" onClick={onReview}>Review {cards} card{cards === 1 ? "" : "s"}</button>}
      </section>

      <section className="glass-card research-item">
        <header><Layers size={15} /> Today's lesson {data.lesson && <span className="muted">· {data.lesson.minutes} min</span>}</header>
        {data.lesson ? <>
          <p><b>{data.lesson.title}.</b> {data.lesson.why}</p>
          <button className="btn-neutral" onClick={() => onTab("ladder")}>Open the lesson</button>
        </> : <p>Every lesson in this level is done. The exit test is next.</p>}
      </section>

      <section className="glass-card research-item">
        <header><ScrollText size={15} /> Reading <span className="muted">· 20–40 min</span></header>
        {data.paper ? <>
          <p><b>{data.paper.title}</b> — next: {data.paper.pass < 3 ? `pass ${data.paper.pass + 1}` : "finish the card"}.</p>
          <button className="btn-neutral" onClick={() => onTab("papers")}>Open the card</button>
        </> : <>
          <p>Add a paper from your Library to start reading.</p>
          <button className="btn-neutral" onClick={() => onTab("papers")}>Add a paper</button>
        </>}
      </section>

      <section className="glass-card research-item">
        <header><Mic size={15} /> Speaking rep <span className="muted">· 5 min</span></header>
        <p>{data.speak}</p>
        <button className="btn-neutral" onClick={() => openMockWith({ scenario: "supervisor", subject: track.brief ? track.brief.split(/[.\n]/)[0] : track.field, details: supervisorDetails(track) })}>
          Practise with the Supervisor
        </button>
      </section>

      {data.project && (
        <section className="glass-card research-item">
          <header><ClipboardList size={15} /> {({ proposal: "Your proposal", replication: "Your replication", paper: "Your paper draft", review: "A peer review", talk: "Your talk" } as const)[data.project.kind]} <span className="muted">· 30–60 min</span></header>
          <p>{data.project.title
            ? <><b>{data.project.title}</b>{data.project.progress?.next ? ` — next: ${data.project.progress.next}` : ""}</>
            : ({
                proposal: "Start a one-page proposal: your research question, a hypothesis, and answers to the eight Heilmeier questions.",
                replication: "Start a replication: pick one published result to reproduce, with a plan and code.",
                paper: "Start a paper draft: abstract, introduction, methods, results, discussion and limitations.",
                review: "Review a published paper, ideally one with public reviews on OpenReview, then compare.",
                talk: "Start a 10-minute talk: one message, an outline, a script and the questions you expect.",
              } as const)[data.project.kind]}</p>
          <button className="btn-neutral" onClick={() => onTab("projects")}>{data.project.title ? "Open the project" : "Start it"}</button>
        </section>
      )}

      {(data.weekly.supervisor || data.weekly.journal_club || data.weekly.reviewer || data.weekly.sprint || data.weekly.peer_review || data.weekly.conference) && (
        <section className="glass-card research-item">
          <header><Users size={15} /> This week</header>
          <ul className="research-list">
            {data.weekly.supervisor && <li>Lab meeting: a 5-minute progress update to the Supervisor.</li>}
            {data.weekly.journal_club && <li>Journal club: present one paper from your cards.</li>}
            {data.weekly.reviewer && <li>Design review: defend your plan or draft to Reviewer 2.</li>}
            {data.weekly.sprint && <li>Writing sprint: 25 to 60 minutes on your current project (Projects tab).</li>}
            {data.weekly.peer_review && <li>Peer review: review one published paper and compare with its public reviews.</li>}
            {data.weekly.conference && <li>This month: a mock conference, your talk and the audience's questions.</li>}
          </ul>
        </section>
      )}

      <LastMeeting onOpen={() => onTab("readiness")} />

      <ExitCard status={data.exit} track={track} onDone={() => onTab("readiness")} />
    </div>
    </>}
    </>
  );
}

// ── Exit test ────────────────────────────────────────────────────────────────

function ExitCard({ status, track, onDone }: { status: ExitStatus; track: Track; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!status.exit) return null;
  async function advance() {
    setBusy(true);
    try { await researchApi.advance(); trackUsage("research.advance"); onDone(); window.location.reload(); }
    catch (e) { notifyError(e); } finally { setBusy(false); }
  }
  const persona = status.exit.persona;
  return (
    <section className="glass-card research-item research-exit">
      <header><Trophy size={15} /> Exit test: {status.exit.title}</header>
      <p className="muted">{status.exit.description}</p>
      <ul className="research-checks">
        {status.checks.map(c => (
          <li key={c.id} className={c.met ? "met" : ""}>
            {c.met ? <CheckCircle2 size={14} /> : <Circle size={14} />} {c.label}{c.value && <span className="muted"> · {c.value}</span>}
          </li>
        ))}
      </ul>
      <div className="research-actions">
        {persona === "supervisor" && (
          <button className="btn-neutral" onClick={() => openMockWith({ scenario: "supervisor", subject: track.field, details: supervisorDetails(track) + "\n\nThis is the level exit oral: ask how research works as well as about the project." })}>
            Take the oral with the Supervisor
          </button>
        )}
        {persona === "journal-club" && <span className="muted">Present from the Papers tab: each card has a journal club button.</span>}
        {persona === "proposal" && <span className="muted">Defend from the Projects tab: your proposal has a proposal panel button.</span>}
        {persona === "reviewer" && <span className="muted">Defend from the Projects tab: your replication and your paper draft each have a Reviewer 2 button.</span>}
        {persona === "audience" && <span className="muted">Give it from the Projects tab: your talk has a conference questions button.</span>}
        {persona === "audience" && (
          <button className="btn-neutral" onClick={() => openMockWith({ scenario: "professor", subject: track.field, details: supervisorDetails(track) })}>
            Practise a call with a professor
          </button>
        )}
        {persona === "committee" && (
          <button className="btn-neutral" onClick={() => openMockWith({ scenario: "committee", subject: track.brief ? track.brief.split(/[.\n]/)[0] : track.field, details: supervisorDetails(track) + "\n\nThis is the level 6 mock viva: ask at least eight questions, taking turns as three examiners." })}>
            Sit the mock viva
          </button>
        )}
        {status.passed && <button className="btn-primary" disabled={busy} onClick={advance}><Trophy size={14} /> Move up a level</button>}
      </div>
    </section>
  );
}

// ── Ladder ───────────────────────────────────────────────────────────────────

function Ladder({ levels, track, onChange, focus }: { levels: Level[]; track: Track; onChange: () => void; focus?: string | null }) {
  const [open, setOpen] = useState<number>(() => levels.find(lv => lv.lessons.some(l => l.id === focus))?.id ?? track.level);
  return (
    <div className="research-ladder">
      {levels.map(lv => (
        <section key={lv.id} className={`glass-card research-level ${lv.state}`}>
          <button className="research-level-head" onClick={() => setOpen(open === lv.id ? -1 : lv.id)}>
            <span className="research-level-n">{lv.state === "locked" ? <Lock size={13} /> : lv.state === "done" ? <CheckCircle2 size={14} /> : lv.id}</span>
            <span className="research-level-name">Level {lv.id}: {lv.name}</span>
            <span className="muted">weeks {lv.weeks}</span>
          </button>
          {open === lv.id && (
            <div className="research-level-body">
              <p>{lv.goal}</p>
              {lv.outcomes?.length > 0 && <ul className="research-list">{lv.outcomes.map(o => <li key={o}>{o}</li>)}</ul>}
              {lv.lessons.length === 0 && <p className="muted">Lessons for this level arrive in a later update. The exit test below shows what it builds towards.</p>}
              {lv.lessons.map(l => <LessonCard key={l.id} lesson={l} locked={lv.state === "locked"} onChange={onChange} focused={l.id === focus} />)}
              {lv.exit && (
                <div className="research-exit-spec">
                  <b><Trophy size={13} /> Exit test: {lv.exit.title}</b>
                  <p className="muted">{lv.exit.description}</p>
                  <ul className="research-list">{lv.exit.rubric.map(r => <li key={r.id}>{r.criterion}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function LessonCard({ lesson, locked, onChange, focused }: { lesson: Lesson; locked: boolean; onChange: () => void; focused?: boolean }) {
  const [expanded, setExpanded] = useState(!!focused);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focused) box.current?.scrollIntoView({ behavior: "smooth", block: "center" }); }, [focused]);
  const [answer, setAnswer] = useState(lesson.answer ?? "");
  const [busy, setBusy] = useState(false);
  async function mark(done: boolean) {
    setBusy(true);
    try { await researchApi.lesson(lesson.id, done, answer); trackUsage(done ? "research.lesson.done" : "research.lesson.undo"); onChange(); }
    catch (e) { notifyError(e); } finally { setBusy(false); }
  }
  return (
    <div ref={box} className={`research-lesson ${lesson.done ? "done" : ""}${focused ? " focused" : ""}`}>
      <button className="research-lesson-head" onClick={() => setExpanded(!expanded)} disabled={locked && !focused}>
        {lesson.done ? <CheckCircle2 size={14} /> : <Circle size={14} />}
        <span>{lesson.title}</span>
        {(lesson as { pack_name?: string }).pack_name && <span className="research-pack-badge">{(lesson as { pack_name?: string }).pack_name}</span>}
        <span className="muted">{lesson.minutes} min · {lesson.pillar}</span>
      </button>
      {expanded && (
        <div className="research-lesson-body">
          <p>{lesson.why}</p>
          {lesson.read.length > 0 && <>
            <div className="settings-label">Read</div>
            <ul className="research-list">
              {lesson.read.map(r => (
                <li key={r.url}><a onClick={() => openExternal(r.url)}>{r.title} <ExternalLink size={11} /></a>{r.by && <span className="muted"> · {r.by}</span>}</li>
              ))}
            </ul>
          </>}
          <div className="settings-label">Do</div>
          <p>{lesson.do}</p>
          <div className="settings-label">Say it out loud (60 seconds)</div>
          <p>{lesson.speak}</p>
          {lesson.check && <>
            <label className="settings-label" htmlFor={`chk-${lesson.id}`}>Check yourself</label>
            <p>{lesson.check}</p>
            <textarea id={`chk-${lesson.id}`} className="glass-input" rows={3} value={answer} onChange={e => setAnswer(e.target.value)}
              placeholder="Answer in your own words before you mark the lesson done." />
          </>}
          <div className="research-actions">
            {lesson.done
              ? <button className="btn-neutral" disabled={busy} onClick={() => mark(false)}>Mark not done</button>
              : <button className="btn-primary" disabled={busy || (!!lesson.check && answer.trim().length < 20)} onClick={() => mark(true)}
                  title={lesson.check && answer.trim().length < 20 ? "Answer the check question first" : undefined}>Mark done</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Readiness ────────────────────────────────────────────────────────────────

/** Everything made so far, as Markdown, to share with a mentor. */
async function exportPortfolio(how: "copy" | "file") {
  try {
    const { markdown } = await researchApi.portfolio();
    if (how === "copy") {
      await navigator.clipboard.writeText(markdown);
      toast.success("Portfolio copied as Markdown");
    } else {
      const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
      const a = document.createElement("a");
      a.href = url; a.download = "research-portfolio.md"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    trackUsage(`research.portfolio.${how}`);
  } catch (e) { notifyError(e); }
}

/** The portfolio laid out as a document, printed or saved as PDF from the print dialog. */
async function printPortfolio() {
  try {
    const { markdown } = await researchApi.portfolio();
    const root = document.createElement("div");
    root.className = "research-print-root research-doc";
    root.innerHTML = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>);
    document.body.appendChild(root);
    trackUsage("research.portfolio.print");
    setTimeout(() => {
      window.print();
      setTimeout(() => root.remove(), 500);
    }, 80);
  } catch (e) { notifyError(e); }
}

function ReadinessTab({ onTab, track, onTrack }: { onTab: (t: Tab) => void; track: Track; onTrack: () => void }) {
  const [data, setData] = useState<Readiness | null>(null);
  useEffect(() => { researchApi.readiness().then(setData).catch(notifyError); }, []);
  if (!data) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;
  return (
    <div className="research-readiness">
      <section className="glass-card progress-card">
        <header><Radar size={15} /> Six pillars</header>
        <p className="muted">Each skill scores 0 to 4 and only rises when you produce something: a held card, a finished paper card, a passed panel round.</p>
        <div className="research-pillars">
          {data.pillars.map(p => (
            <div key={p.id} className="research-pillar">
              <span className="research-pillar-name">{p.name}</span>
              <span className="research-bar"><span style={{ width: `${(p.score / 4) * 100}%` }} /></span>
              <span className="muted">{p.score.toFixed(1)} / 4</span>
            </div>
          ))}
        </div>
      </section>
      <section className="glass-card progress-card">
        <header><Sparkles size={15} /> Work on next</header>
        <ul className="research-list">
          {data.weakest.map(s => (
            <li key={s.id}><b>{s.name}</b> <span className="muted">· {scoreLabel(s.score)}</span><br /><span className="muted">{s.description}</span></li>
          ))}
        </ul>
        <div className="research-actions">
          <button className="btn-neutral" onClick={printPortfolio}>Print or save as PDF</button>
          <button className="btn-neutral" onClick={() => exportPortfolio("copy")}>Copy portfolio</button>
          <button className="btn-neutral" onClick={() => exportPortfolio("file")}>Save portfolio as .md</button>
          <button className="btn-neutral" onClick={() => onTab("today")}>Back to today</button>
        </div>
      </section>
      <Meetings />
      <Mentor track={track} readiness={data} onChange={() => { onTrack(); researchApi.readiness().then(setData).catch(() => {}); }} />
      {data.pillars.map(p => (
        <section key={p.id} className="glass-card progress-card">
          <header>{p.name}</header>
          <ul className="research-skills">
            {p.skills.map(s => (
              <li key={s.id} className={s.level > data.level + 1 ? "later" : ""}>
                <span>{s.name}</span>
                <span className={`research-score s${s.score}`} title={s.why || undefined}>{scoreLabel(s.score)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ── Field packs ──────────────────────────────────────────────────────────────

function Packs({ onChange }: { onChange: () => void }) {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { researchApi.packs().then(r => setPacks(r.packs)).catch(notifyError); }, []);
  if (!packs || packs.length === 0) return null;

  async function toggle(id: string) {
    const next = packs!.filter(p => (p.id === id ? !p.active : p.active)).map(p => p.id);
    try {
      const r = await researchApi.setPacks(next);
      setPacks(r.packs);
      trackUsage("research.packs");
      onChange();
    } catch (e) { notifyError(e); }
  }

  return (
    <section className="glass-card progress-card research-packs">
      <header><Sparkles size={15} /> Field packs</header>
      <p className="muted">A pack adds your field's terms to your bank, lessons to the ladder and reading to this list.</p>
      {packs.map(p => (
        <div key={p.id} className="research-pack">
          <label className="research-pack-toggle">
            <input type="checkbox" checked={p.active} onChange={() => toggle(p.id)} />
            <b>{p.name}</b> <span className="muted">· {p.terms} terms · {p.lessons} lessons</span>
          </label>
          <p className="muted">{p.description}</p>
          {p.active && p.resources.length > 0 && <>
            <button className="btn-neutral" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? "Hide" : "Show"} the field's reading and data</button>
            {open === p.id && (
              <ul className="research-list">
                {p.resources.map(r => (
                  <li key={r.url}>
                    <a onClick={() => openExternal(r.url)}>{r.title} <ExternalLink size={11} /></a>
                    <span className="muted"> · {r.kind}{r.by ? ` · ${r.by}` : ""}</span>
                    {r.why && <><br /><span className="muted">{r.why}</span></>}
                  </li>
                ))}
              </ul>
            )}
          </>}
        </div>
      ))}
    </section>
  );
}

// ── Real meetings ────────────────────────────────────────────────────────────

function LastMeeting({ onOpen }: { onOpen: () => void }) {
  const [report, setReport] = useState<MeetingReport | null>(null);
  useEffect(() => { researchApi.meetings().then(setReport).catch(() => {}); }, []);
  const last = report?.sessions[0];
  if (!last) return null;
  return (
    <section className="glass-card research-item">
      <header><Mic size={15} /> Your last real meeting</header>
      <p><b>{last.title}</b>: you used {last.terms.length} of your research term{last.terms.length === 1 ? "" : "s"}
        {last.overclaims.length ? `, and ${last.overclaims.length} claim${last.overclaims.length === 1 ? "" : "s"} may be stronger than the evidence.` : ", with no overclaiming."}</p>
      <button className="btn-neutral" onClick={onOpen}>See the details</button>
    </section>
  );
}

function Meetings() {
  const [report, setReport] = useState<MeetingReport | null>(null);
  useEffect(() => { researchApi.meetings().then(setReport).catch(notifyError); }, []);
  if (!report) return null;
  return (
    <section className="glass-card progress-card research-meetings">
      <header><Mic size={15} /> In your real meetings</header>
      <p className="muted">From your own words in live sessions (not practice), read on this computer: which of your terms you used,
        and sentences where a claim may be stronger than the evidence. Words like "always" or "proves" are flagged for you to judge.</p>
      {report.sessions.length === 0 ? <p className="muted">No live sessions with your own speech yet.</p> : <>
        <p><b>{report.distinct_terms}</b> different research terms used across your last {report.sessions.length} meeting{report.sessions.length === 1 ? "" : "s"}.</p>
        {report.top_terms.length > 0 && (
          <div className="research-chips">{report.top_terms.map(t => <span key={t.term} className="research-chip">{t.term} ×{t.count}</span>)}</div>
        )}
        <ul className="research-list">
          {report.sessions.slice(0, 5).map(s => (
            <li key={s.id}>
              <b>{s.title}</b> <span className="muted">· {s.created_at.slice(0, 10)} · {s.terms.length} terms · {s.hedges} hedges · {s.overclaims.length} to check</span>
              {s.overclaims.slice(0, 3).map((o, i) => <div key={i} className="research-overclaim">“{o.sentence}” <span className="muted">({o.word})</span></div>)}
            </li>
          ))}
        </ul>
      </>}
    </section>
  );
}

// ── Mentor ───────────────────────────────────────────────────────────────────

function Mentor({ track, readiness, onChange }: { track: Track; readiness: Readiness; onChange: () => void }) {
  const [name, setName] = useState(track.mentor_name ?? "");
  const [email, setEmail] = useState(track.mentor_email ?? "");
  const [signing, setSigning] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [signed, setSigned] = useState<SignOff[]>([]);
  useEffect(() => { researchApi.signOffs().then(setSigned).catch(() => {}); }, []);
  const skills = readiness.pillars.flatMap(p => p.skills).filter(s => s.level <= readiness.level + 1);

  async function saveMentor() {
    if (name === (track.mentor_name ?? "") && email === (track.mentor_email ?? "")) return;
    try { await researchApi.setMentor(name, email); onChange(); } catch (e) { notifyError(e); }
  }
  async function signOff() {
    try {
      await researchApi.signOff({ mentor: name, level: readiness.level, skills: picked, note });
      trackUsage("research.signoff");
      toast.success(`Recorded ${name}'s sign-off on ${picked.length} skill${picked.length === 1 ? "" : "s"}`);
      setSigning(false); setPicked([]); setNote("");
      researchApi.signOffs().then(setSigned).catch(() => {});
      onChange();
    } catch (e) { notifyError(e); }
  }

  return (
    <section className="glass-card progress-card research-mentor">
      <header><Users size={15} /> Your mentor</header>
      <p className="muted">A real researcher who looks at your portfolio and confirms what they have seen you do. Their sign-off counts as evidence.</p>
      <div className="research-mentor-fields">
        <input className="glass-input" aria-label="Mentor's name" placeholder="Their name" value={name} onChange={e => setName(e.target.value)} onBlur={saveMentor} />
        <input className="glass-input" aria-label="Mentor's email" placeholder="Their email (optional)" value={email} onChange={e => setEmail(e.target.value)} onBlur={saveMentor} />
      </div>
      <div className="research-actions">
        <button className="btn-neutral" onClick={() => exportPortfolio("file")}>Save portfolio to send</button>
        <button className="btn-neutral" disabled={!track.mentor_email} title={track.mentor_email ? "Opens your mail app; attach the saved portfolio" : "Add their email first"}
          onClick={() => openExternal(mentorEmail(track))}>Email my mentor</button>
        <button className="btn-primary" disabled={!name.trim()} onClick={() => setSigning(!signing)}>Record a sign-off</button>
      </div>
      {signing && (
        <div className="research-signoff">
          <div className="settings-label">Skills {name || "your mentor"} has seen you do</div>
          <div className="research-chips">
            {skills.map(s => (
              <button key={s.id} className={`scenario-option ${picked.includes(s.id) ? "active" : ""}`}
                onClick={() => setPicked(p => p.includes(s.id) ? p.filter(x => x !== s.id) : [...p, s.id])}>{s.name}</button>
            ))}
          </div>
          <textarea className="glass-input" rows={2} aria-label="What they said" placeholder="What they said (optional)" value={note} onChange={e => setNote(e.target.value)} />
          <div className="research-actions"><button className="btn-primary" disabled={!picked.length} onClick={signOff}>Save sign-off</button></div>
        </div>
      )}
      {signed.length > 0 && (
        <ul className="research-list">
          {signed.map((s, i) => <li key={i}><span className="muted">{s.created_at.slice(0, 10)}</span> {s.note} <span className="muted">· {s.skills.join(", ")}</span></li>)}
        </ul>
      )}
    </section>
  );
}
