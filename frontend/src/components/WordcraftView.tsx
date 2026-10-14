import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import toast from "react-hot-toast";
import {
  Anchor, BookOpen, BookOpenCheck, CalendarCheck, Castle, Check, ChevronDown, ChevronRight, Compass, Flag, Flame, Landmark,
  Loader2, Lock, Map as MapIcon, MessageCircle, Mountain, PenLine, Play, Plus, Puzzle, Search, Signpost, Sparkles, Store,
  TrendingUp, Building2, X, BookMarked,
} from "lucide-react";
import Page, { PageTab } from "./Page";
import WordcraftSession, { DrillRunner, EditorPanel, MissionCard, WordDeck, WordFlip, talkTo, type WcTab } from "./WordcraftSession";
import { Ring } from "./ResearchSession";
import WordcraftDictionary from "./WordcraftDictionary";
import { MilestoneOverlay, ProgressCharts, type OpenTarget } from "./Milestones";
import {
  CHARACTERS, GOALS, PILLAR_LABELS, wordcraftApi, type CardDef, type CardKind, type Goal, type Mission, type PlacementItem,
  type Progress, type Realm, type WcCard, type WcLesson, type WcTrack, type Writing,
} from "../lib/wordcraft";
import { notifyError } from "../lib/errors";
import { openExternal } from "../lib/openExternal";
import { track as trackUsage } from "../lib/usage";
import guide from "../content/wordcraft-guide.md?raw";

type Tab = "guide" | "map" | "today" | "dictionary" | WcTab;
const TABS: { id: Tab; label: string; icon: JSX.Element; hint: string }[] = [
  { id: "guide",    label: "Guide",    icon: <BookOpen size={14} />,       hint: "Wordcraft: beginner to expert communicator" },
  { id: "map",      label: "Map",      icon: <MapIcon size={14} />,        hint: "The seven realms, and where you are" },
  { id: "today",    label: "Today",    icon: <CalendarCheck size={14} />,  hint: "Today's guided session" },
  { id: "realms",   label: "Realms",   icon: <Compass size={14} />,        hint: "Every realm and lesson; practise any of them" },
  { id: "cards",    label: "Cards",    icon: <BookOpenCheck size={14} />,  hint: "Your words, phrases and patterns" },
  { id: "writing",  label: "Writing",  icon: <PenLine size={14} />,        hint: "Write anything and ask the Editor" },
  { id: "dictionary", label: "Dictionary", icon: <BookMarked size={14} />, hint: "Meanings, real sentences and the phrase builder, offline" },
  { id: "missions", label: "Missions", icon: <Flag size={14} />,           hint: "This week's mission and the characters" },
  { id: "progress", label: "Progress", icon: <TrendingUp size={14} />,     hint: "Your skills, trends and \"I can\" ratings" },
];
const isTab = (s?: string): s is Tab => !!s && TABS.some(t => t.id === s);

export const REALM_ICONS = [Anchor, Store, Signpost, Landmark, Building2, Mountain, Castle];

/**
 * Wordcraft: English from first words to expert communicator. Seven realms,
 * a guided daily session, cards, exercises checked on this computer, the
 * Editor for writing and characters to talk to. Only the Editor and the
 * characters use credits.
 */
export default function WordcraftView({ section }: { section?: string }) {
  const [tab, setTab] = useState<Tab>(() => (isTab(section) ? section : "today"));
  const [todayKey, setTodayKey] = useState(0);
  const [track, setTrack] = useState<WcTrack | null | undefined>(undefined);
  const [realms, setRealms] = useState<Realm[]>([]);

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([wordcraftApi.track(), wordcraftApi.curriculum()]);
      setTrack(t.track);
      setRealms(c.realms);
    } catch (e) { notifyError(e); setTrack(null); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { trackUsage(`wordcraft.tab.${tab}`); }, [tab]);

  // A lesson picked from the Progress calendar: Realms opens straight into it.
  const [focusLesson, setFocusLesson] = useState<string | null>(null);
  const openFrom = (t: OpenTarget) => {
    if (t.kind === "today") { setTodayKey(k => k + 1); setTab("today"); }
    else if (t.kind === "lesson") { setFocusLesson(t.id); setTab("realms"); }
    else if (t.kind === "writing") setTab("writing");
    else if (t.kind === "session") window.dispatchEvent(new CustomEvent("navigate", { detail: `history:open:${t.id}` }));
  };

  const realm = track ? realms.find(r => r.id === track.realm) : undefined;
  const subtitle = track && realm
    ? `Realm ${realm.id}: ${realm.name} · ${realm.cefr}`
    : "English, from your first words to speaking like an expert.";

  if (track === undefined) {
    return <Page title="Wordcraft" subtitle={subtitle}><div className="page-content progress-loading"><Loader2 size={18} className="spin" /></div></Page>;
  }
  if (track === null) {
    return <Page title="Wordcraft" subtitle={subtitle}><div className="page-content"><Welcome realms={realms} onStarted={load} /></div></Page>;
  }
  return (
    <Page
      title="Wordcraft"
      subtitle={subtitle}
      tabs={<>{TABS.map(t => (
        <PageTab key={t.id} active={tab === t.id} title={t.hint} icon={t.icon}
          onClick={() => { if (t.id === "today" && tab === "today") setTodayKey(k => k + 1); setTab(t.id); }}>{t.label}</PageTab>
      ))}</>}
    >
      <div className="page-content">
        {tab === "guide" && <Guide />}
        {tab === "map" && <WorldMap realms={realms} current={track.realm} onOpen={() => setTab("realms")} />}
        {tab === "today" && <TodayTab key={todayKey} onTab={t => { setTab(t); load(); }} />}
        {tab === "realms" && <RealmsTab key={focusLesson ?? ""} realms={realms} current={track.realm} onChange={load} focus={focusLesson} onFocusDone={() => setFocusLesson(null)} />}
        {tab === "cards" && <CardsTab />}
        {tab === "writing" && <WritingTab />}
        {tab === "dictionary" && <WordcraftDictionary />}
        {tab === "missions" && <MissionsTab />}
        {tab === "progress" && <ProgressTab track={track} onTrack={setTrack} onOpen={openFrom} />}
      </div>
      <MilestoneOverlay track="wordcraft" />
    </Page>
  );
}

function TodayTab({ onTab }: { onTab: (t: WcTab) => void }) {
  const [, setFocus] = useState(false);
  return <WordcraftSession onTab={onTab} onFocus={setFocus} />;
}

// ── Guide ────────────────────────────────────────────────────────────────────

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

// ── Welcome and placement ────────────────────────────────────────────────────

function Welcome({ realms, onStarted }: { realms: Realm[]; onStarted: () => void }) {
  const [mode, setMode] = useState<"hello" | "place" | "result">("hello");
  const [result, setResult] = useState<{ realm: number; name: string } | null>(null);

  if (mode === "place") return <Placement onDone={r => { setResult(r); setMode("result"); }} onCancel={() => setMode("hello")} />;
  if (mode === "result" && result) return <StartHere realms={realms} suggested={result.realm} onStarted={onStarted} />;

  return (
    <section className="rs-hero wc-welcome rs-enter">
      <div className="rs-hero-glow" aria-hidden="true" />
      <div className="rs-eyebrow"><Sparkles size={13} /> Seven realms · 42 lessons · about 300 words, phrases and patterns</div>
      <h2 className="rs-hero-title">Your English adventure starts here</h2>
      <p className="rs-hero-sub">Wordcraft takes you from your first words to speaking and writing like an expert: every word, phrase and sentence learned, used out loud and checked. It judges whether your message lands, never how fast or smoothly you speak.</p>
      <div className="wc-realm-strip">
        {realms.map((r, i) => {
          const Icon = REALM_ICONS[i] ?? Compass;
          return <div key={r.id} className="wc-strip-item" style={{ ["--i" as string]: i }}><span><Icon size={18} /></span><b>{r.name}</b><small>{r.cefr}</small></div>;
        })}
      </div>
      <div className="rs-hero-actions">
        <button className="btn-primary rs-cta" onClick={() => setMode("place")}><Compass size={16} /> Find my starting realm (5 minutes)</button>
        <button className="btn-neutral" onClick={() => { setResult({ realm: 0, name: realms[0]?.name ?? "" }); setMode("result"); }}>Start from the beginning</button>
      </div>
    </section>
  );
}

function Placement({ onDone, onCancel }: { onDone: (r: { realm: number; name: string }) => void; onCancel: () => void }) {
  const [items, setItems] = useState<PlacementItem[] | null>(null);
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [sending, setSending] = useState(false);
  useEffect(() => { wordcraftApi.placement().then(r => setItems(r.items)).catch(notifyError); }, []);
  if (!items) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;
  const it = items[i];

  async function pick(k: number) {
    const next = { ...answers, [it.id]: k };
    setAnswers(next);
    if (i + 1 < items!.length) { setI(i + 1); return; }
    setSending(true);
    try { onDone(await wordcraftApi.place(next)); } catch (e) { notifyError(e); } finally { setSending(false); }
  }

  const [before, after] = it.type === "gap" ? (it.sentence ?? "").split("___") : ["", ""];
  return (
    <div className="rs-frame">
      <div className="rs-rail">
        <div className="rs-rail-bar"><span style={{ width: `${Math.round((i / items.length) * 100)}%` }} /></div>
        <div className="rs-rail-meta"><span>Question {i + 1} of {items.length}</span>
          <button className="rs-rail-close" onClick={onCancel}><X size={14} /> Stop</button></div>
      </div>
      <div key={it.id} className="rs-card rs-enter">
        <div className="rs-eyebrow"><Compass size={13} /> Finding your starting realm</div>
        {it.type === "choose" ? <p className="wc-drill-prompt">{it.prompt}</p>
          : <p className="wc-drill-prompt wc-gap">{before}<span className="wc-blank">&nbsp;</span>{after}</p>}
        <div className="wc-options">
          {it.options.map((o, k) => <button key={k} className="wc-option" disabled={sending} onClick={() => pick(k)}>{o}</button>)}
        </div>
        <p className="muted">It's fine not to know. The questions get harder on purpose; a guess is better than a blank.</p>
      </div>
    </div>
  );
}

function StartHere({ realms, suggested, onStarted }: { realms: Realm[]; suggested: number; onStarted: () => void }) {
  const [realm, setRealm] = useState(suggested);
  const [goal, setGoal] = useState<Goal>("everyday");
  const [busy, setBusy] = useState(false);
  const r = realms.find(x => x.id === realm);
  const Icon = REALM_ICONS[realm] ?? Compass;
  async function start() {
    setBusy(true);
    try { await wordcraftApi.start(realm, goal); toast.success(`Welcome to ${r?.name}`); onStarted(); }
    catch (e) { notifyError(e); } finally { setBusy(false); }
  }
  return (
    <section className="rs-hero wc-start rs-enter">
      <div className="rs-hero-glow" aria-hidden="true" />
      <div className="wc-start-icon"><Icon size={34} /></div>
      <div className="rs-eyebrow">{realm === suggested ? "Your starting realm" : "You chose"}</div>
      <h2 className="rs-hero-title">Realm {realm}: {r?.name} <small>{r?.cefr}</small></h2>
      <p className="rs-hero-sub">{r?.blurb} {r?.goal}</p>
      <div className="rs-section-label">What is English for, for you?</div>
      <div className="wc-chips">{GOALS.map(g => <button key={g.id} className={`wc-chip ${goal === g.id ? "on" : ""}`} onClick={() => setGoal(g.id)}>{g.label}</button>)}</div>
      <div className="rs-section-label">Or start somewhere else</div>
      <div className="wc-chips">{realms.map(x => <button key={x.id} className={`wc-chip ${realm === x.id ? "on" : ""}`} onClick={() => setRealm(x.id)}>{x.id}. {x.name}</button>)}</div>
      <div className="rs-hero-actions"><button className="btn-primary rs-cta" disabled={busy} onClick={start}><Play size={16} /> Start here</button></div>
      {realm > 0 && <p className="muted">Words from the realms below come in as already known, and return now and then for a quick review.</p>}
    </section>
  );
}

// ── The map ──────────────────────────────────────────────────────────────────

/** Island positions on the map, as percentages of its width and height. */
const SPOTS = [[10, 78], [26, 52], [40, 76], [55, 48], [68, 72], [80, 38], [90, 14]];

/** A curving sea route through the given islands, in the map's 1000 × 600 space. */
function route(spots: number[][]): string {
  return spots.reduce((acc, [x, y], k) => {
    if (!k) return `M ${x * 10} ${y * 6}`;
    const [px, py] = spots[k - 1];
    const cx = ((px + x) / 2) * 10, cy = ((py + y) / 2) * 6 + (k % 2 ? 60 : -60);
    return `${acc} Q ${cx} ${cy} ${x * 10} ${y * 6}`;
  }, "");
}

function WorldMap({ realms, current, onOpen }: { realms: Realm[]; current: number; onOpen: () => void }) {
  const [sel, setSel] = useState(current);
  const r = realms.find(x => x.id === sel);
  const d = route(SPOTS);
  const dDone = route(SPOTS.slice(0, current + 1));
  return (
    <div className="wc-map-wrap rs-enter">
      <div className="wc-map">
        <svg viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true" className="wc-map-svg">
          <defs>
            <radialGradient id="wcSea" cx="50%" cy="40%" r="75%">
              <stop offset="0%" className="wc-sea-a" /><stop offset="100%" className="wc-sea-b" />
            </radialGradient>
          </defs>
          <rect x="0" y="0" width="1000" height="600" fill="url(#wcSea)" />
          {[...Array(26)].map((_, k) => <circle key={k} cx={(k * 137) % 1000} cy={(k * 71) % 600} r={1.6 + (k % 3)} className="wc-map-dot" />)}
          <path d={d} className="wc-route" />
          {current > 0 && <path d={dDone} className="wc-route-done" />}
        </svg>
        {realms.map((x, k) => {
          const [px, py] = SPOTS[k] ?? [50, 50];
          const Icon = REALM_ICONS[k] ?? Compass;
          const state = x.id < current ? "done" : x.id === current ? "here" : "locked";
          return (
            <button key={x.id} className={`wc-island ${state} ${sel === x.id ? "sel" : ""}`} style={{ left: `${px}%`, top: `${py}%`, ["--i" as string]: k }}
              onClick={() => setSel(x.id)} title={`${x.name} (${x.cefr})`}>
              <span className="wc-island-disc">{state === "done" ? <Check size={20} /> : state === "locked" ? <Lock size={16} /> : <Icon size={22} />}</span>
              <span className="wc-island-label"><b>{x.name}</b><small>{x.cefr}</small></span>
              {state === "here" && <span className="wc-you">You are here</span>}
            </button>
          );
        })}
      </div>
      {r && (
        <section key={r.id} className="rs-card wc-realm-card rs-enter">
          <header className="rs-step-head">
            <span className="rs-step-icon">{(() => { const I = REALM_ICONS[r.id] ?? Compass; return <I size={22} />; })()}</span>
            <div><div className="rs-eyebrow">Realm {r.id} · {r.cefr}{r.placed ? " · placed above it" : ""}</div><h2 className="rs-step-title">{r.name}</h2></div>
          </header>
          <p className="rs-lead">{r.blurb}</p>
          <div className="wc-realm-grid">
            <div><div className="rs-section-label">By the end you can</div><ul className="wc-cando">{r.can_do.map(c => <li key={c}><Check size={13} /> {c}</li>)}</ul></div>
            <div>
              <div className="rs-section-label">Grammar landmarks</div>
              <div className="wc-patterns">{r.landmarks.map(l => <span key={l}>{l}</span>)}</div>
              <div className="rs-section-label">The gate</div>
              <p className="muted">{r.exit.title}: {r.exit.description}</p>
              <p className="muted">{r.lessons.length} lessons · {r.cards} cards · {r.lessons.filter(l => l.done).length} done</p>
            </div>
          </div>
          <div className="rs-actions"><button className="btn-neutral" onClick={onOpen}><Compass size={15} /> See its lessons</button></div>
        </section>
      )}
    </div>
  );
}

// ── Realms and lessons ───────────────────────────────────────────────────────

function RealmsTab({ realms, current, onChange, focus, onFocusDone }: {
  realms: Realm[]; current: number; onChange: () => void; focus?: string | null; onFocusDone?: () => void;
}) {
  const [open, setOpen] = useState<number | null>(() => realms.find(r => r.lessons.some(l => l.id === focus))?.id ?? current);
  const [practise, setPractise] = useState<string | null>(focus ?? null);
  if (practise) return <LessonPractice id={practise} onClose={() => { setPractise(null); onFocusDone?.(); onChange(); }} />;
  return (
    <div className="wc-realms">
      {realms.map((r, k) => {
        const Icon = REALM_ICONS[k] ?? Compass;
        const done = r.lessons.filter(l => l.done).length;
        return (
          <section key={r.id} className={`glass-card wc-realm ${r.state}`} style={{ ["--i" as string]: k }}>
            <button className="wc-realm-head" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
              <span className="wc-realm-icon"><Icon size={18} /></span>
              <span className="wc-realm-name"><b>{r.id}. {r.name}</b><small>{r.cefr} · {r.goal}</small></span>
              <span className="wc-realm-meter"><span style={{ width: `${Math.round((done / Math.max(1, r.lessons.length)) * 100)}%` }} /></span>
              <span className="muted">{r.state === "done" ? (r.placed ? "Placed above" : "Done") : r.state === "current" ? `${done} of ${r.lessons.length}` : "Ahead"}</span>
              {open === r.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </button>
            {open === r.id && (
              <ol className="wc-lessons rs-enter">
                {r.lessons.map(l => (
                  <li key={l.id} className={l.done ? "done" : ""}>
                    <span className="rs-check-dot">{l.done && <Check size={12} />}</span>
                    <span className="wc-lesson-text"><b>{l.title}</b><small>{PILLAR_LABELS[l.pillar] ?? l.pillar} · {l.minutes} min · {l.drill_count} exercises{l.score != null ? ` · ${Math.round(l.score * 100)}% first time` : ""}</small></span>
                    <button className="btn-neutral" onClick={() => setPractise(l.id)}><Puzzle size={14} /> Practise</button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </div>
  );
}

function LessonPractice({ id, onClose }: { id: string; onClose: () => void }) {
  const [lesson, setLesson] = useState<(WcLesson & { card_list: CardDef[] }) | null>(null);
  const [part, setPart] = useState<"learn" | "drills">("learn");
  useEffect(() => { wordcraftApi.lesson(id).then(setLesson).catch(notifyError); }, [id]);
  if (!lesson) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;
  return (
    <div className="rs-frame">
      <div className="rs-nav"><button className="btn-neutral" onClick={onClose}><X size={14} /> Back to the realms</button></div>
      <div className="rs-card rs-enter">
        <header className="rs-step-head"><span className="rs-step-icon"><Compass size={22} /></span>
          <div><div className="rs-eyebrow">{PILLAR_LABELS[lesson.pillar]} · {lesson.minutes} min</div><h2 className="rs-step-title">{lesson.title}</h2></div></header>
        {part === "learn" ? <>
          <blockquote className="rs-why">{lesson.why}</blockquote>
          {lesson.rule && <div className="wc-rule"><b>The rule</b><p>{lesson.rule}</p></div>}
          <div className="rs-flips">{lesson.card_list.map((c, i) => <WordFlip key={c.id} card={c} i={i} />)}</div>
          <article className="wc-passage"><h3>{lesson.passage.title}</h3>{lesson.passage.text.split(/\n+/).map((p, i) => <p key={i}>{p}</p>)}</article>
          <button className="btn-primary rs-next" onClick={() => setPart("drills")}><Puzzle size={15} /> Practise the exercises</button>
        </> : (
          <DrillRunner drills={lesson.drills ?? []} seed={lesson.id.length + 7} busy={false}
            onDone={async results => { try { const r = await wordcraftApi.drills(lesson.id, results); toast.success(`${Math.round(r.score * 100)}% right first time`); } catch (e) { notifyError(e); } onClose(); }} />
        )}
      </div>
    </div>
  );
}

// ── Cards ────────────────────────────────────────────────────────────────────

function CardsTab() {
  const [cards, setCards] = useState<WcCard[] | null>(null);
  const [stats, setStats] = useState<Progress["cards"] | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"" | CardKind>("");
  const [reviewing, setReviewing] = useState(false);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => wordcraftApi.cards(q, kind).then(r => { setCards(r.cards); setStats(r.stats); }).catch(notifyError), [q, kind]);
  useEffect(() => { const t = window.setTimeout(load, 200); return () => window.clearTimeout(t); }, [load]);
  if (reviewing) return <div className="rs-frame"><WordDeck onDone={() => { setReviewing(false); load(); }} /></div>;
  const seen = (cards ?? []).filter(c => c.first_seen);
  return (
    <div className="wc-cards">
      {stats && (
        <div className="rs-stat-row">
          <div className="rs-stat"><b>{stats.held}</b><span>held of {stats.total}</span></div>
          <div className="rs-stat"><b>{stats.by_kind.word}</b><span>words</span></div>
          <div className="rs-stat"><b>{stats.by_kind.phrase}</b><span>phrases</span></div>
          <div className="rs-stat"><b>{stats.by_kind.pattern}</b><span>patterns</span></div>
        </div>
      )}
      <div className="wc-toolbar">
        <button className="btn-primary" onClick={() => setReviewing(true)}><Play size={14} /> Review due cards</button>
        <div className="wc-search"><Search size={14} /><input id="wc-card-search" className="glass-input" placeholder="Search words and meanings" value={q} onChange={e => setQ(e.target.value)} /></div>
        <div className="wc-chips">{(["", "word", "phrase", "pattern"] as const).map(k => <button key={k || "all"} className={`wc-chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>{k ? k[0].toUpperCase() + k.slice(1) + "s" : "All"}</button>)}</div>
        <button className="btn-neutral" onClick={() => setAdding(a => !a)}><Plus size={14} /> Add your own</button>
      </div>
      {adding && <AddCard onAdded={() => { setAdding(false); load(); }} />}
      {!cards ? <div className="progress-loading"><Loader2 size={18} className="spin" /></div> : (
        <>
          <p className="muted">{seen.length} met so far; {cards.length - seen.length} still to come. Cards arrive ten a day, in lesson order.</p>
          <div className="wc-card-grid">
            {cards.slice(0, 240).map(c => (
              <div key={c.id} className={`wc-card-item ${c.first_seen ? "" : "unseen"}`}>
                <span className={`wc-kind k-${c.kind}`}>{c.kind}</span>
                <b>{c.text}</b>
                <span>{c.first_seen ? c.meaning : "Arrives with its lesson"}</span>
                {c.first_seen && c.example && <em>{c.example}</em>}
                <small className="muted">Realm {c.realm}{c.last_grade != null ? ` · last: ${["again", "hard", "good", "easy"][c.last_grade]}` : ""}</small>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AddCard({ onAdded }: { onAdded: () => void }) {
  const [text, setText] = useState(""); const [meaning, setMeaning] = useState(""); const [example, setExample] = useState("");
  const [kind, setKind] = useState<CardKind>("word");
  async function add() {
    try { await wordcraftApi.addCard({ text, meaning, example, kind }); toast.success("Card added"); onAdded(); }
    catch (e) { notifyError(e); }
  }
  return (
    <div className="glass-card wc-add rs-enter">
      <div className="wc-chips">{(["word", "phrase", "pattern"] as const).map(k => <button key={k} className={`wc-chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>{k}</button>)}</div>
      <input id="wc-add-text" className="glass-input" placeholder="The word or phrase" value={text} onChange={e => setText(e.target.value)} />
      <input id="wc-add-meaning" className="glass-input" placeholder="What it means, in simple words" value={meaning} onChange={e => setMeaning(e.target.value)} />
      <input id="wc-add-example" className="glass-input" placeholder="An example sentence (optional)" value={example} onChange={e => setExample(e.target.value)} />
      <button className="btn-primary" disabled={!text.trim() || !meaning.trim()} onClick={add}>Add card</button>
    </div>
  );
}

// ── Writing ──────────────────────────────────────────────────────────────────

function WritingTab() {
  const [text, setText] = useState("");
  const [prompt, setPrompt] = useState("");
  const [history, setHistory] = useState<Writing[]>([]);
  const load = useCallback(() => wordcraftApi.writing().then(setHistory).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="wc-writing">
      <div className="rs-card">
        <header className="rs-step-head"><span className="rs-step-icon"><PenLine size={22} /></span>
          <div><div className="rs-eyebrow">Free writing</div><h2 className="rs-step-title">Write anything</h2></div></header>
        <p className="rs-lead">An email you need to send, a paragraph for work, a story. Ask the Editor for one kind note on what works and one thing to change.</p>
        <input id="wc-writing-task" className="glass-input" placeholder="What is it for? (optional, e.g. an email asking my manager for a day off)" value={prompt} onChange={e => setPrompt(e.target.value)} />
        <textarea id="wc-writing-text" className="glass-input rs-answer" rows={8} value={text} onChange={e => setText(e.target.value)} placeholder="Write here." />
        <EditorPanel text={text} prompt={prompt} onScored={() => load()} />
      </div>
      {!!history.length && <>
        <div className="rs-more-label">Your writing so far</div>
        <div className="wc-history">
          {history.map(w => (
            <div key={w.id} className="glass-card wc-history-item">
              {w.score !== null && <Ring pct={w.score * 10} size={56} stroke={5}><b>{w.score}</b></Ring>}
              <div>
                <small className="muted">{w.created_at.slice(0, 10)} · realm {w.realm}{w.prompt ? ` · ${w.prompt.slice(0, 80)}` : ""}</small>
                <p>{w.text.slice(0, 220)}{w.text.length > 220 ? "…" : ""}</p>
                {w.feedback.focus && <p className="muted"><b>Look at:</b> {w.feedback.focus.look_at} <b>Better:</b> {w.feedback.focus.better}</p>}
              </div>
            </div>
          ))}
        </div>
      </>}
    </div>
  );
}

// ── Missions and characters ──────────────────────────────────────────────────

function MissionsTab() {
  const [m, setM] = useState<Mission | null>(null);
  const load = useCallback(() => wordcraftApi.mission().then(setM).catch(notifyError), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="wc-missions">
      <div className="rs-card">
        <header className="rs-step-head"><span className="rs-step-icon"><Flag size={22} /></span>
          <div><div className="rs-eyebrow">This week · {m?.week}</div><h2 className="rs-step-title">Your mission</h2></div></header>
        {m ? <MissionCard m={m} onRefresh={load} /> : <Loader2 size={18} className="spin" />}
      </div>
      <div className="rs-more-label">Characters to practise with, any time</div>
      <div className="wc-characters">
        {Object.entries(CHARACTERS).map(([id, c], k) => (
          <div key={id} className="glass-card wc-character" style={{ ["--i" as string]: k }}>
            <span className="wc-avatar">{c.name.replace("The ", "")[0]}</span>
            <b>{c.name}</b><small className="muted">{c.role}</small>
            <button className="btn-neutral" onClick={() => talkTo(id)}><MessageCircle size={14} /> Talk</button>
          </div>
        ))}
      </div>
      <p className="muted">Each character speaks at your realm's level and scores whether your message was clear, complete and well organised. Pauses and repeated sounds never count against you.</p>
    </div>
  );
}

// ── Progress ─────────────────────────────────────────────────────────────────

function Trend({ values, label }: { values: (number | null)[]; label: string }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] !== null);
  if (pts.length < 2) return <div className="wc-trend empty"><b>{label}</b><small className="muted">Needs two or more checked pieces of writing.</small></div>;
  const max = Math.max(...pts.map(p => p[1])) * 1.15 || 1;
  const w = 220, h = 60;
  const xy = pts.map(([i, v]) => `${(i / Math.max(1, values.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <div className="wc-trend">
      <b>{label}</b><span>{pts[pts.length - 1][1]}</span>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"><polyline points={xy} /></svg>
    </div>
  );
}

function ProgressTab({ track, onTrack, onOpen }: { track: WcTrack; onTrack: (t: WcTrack) => void; onOpen: (t: OpenTarget) => void }) {
  const [p, setP] = useState<Progress | null>(null);
  useEffect(() => { wordcraftApi.progress().then(setP).catch(notifyError); }, []);
  const realmCando = useMemo(() => p?.cando.find(c => c.realm === track.realm), [p, track.realm]);
  if (!p) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;
  const acc = p.exercises.done ? Math.round((p.exercises.right / p.exercises.done) * 100) : 0;
  async function rate(item: number, value: number) {
    if (!realmCando) return;
    const ratings = realmCando.items.map((x, k) => (k === item ? value : x.rating ?? 1));
    try { setP(await wordcraftApi.rateCando(track.realm, ratings)); } catch (e) { notifyError(e); }
  }
  async function togglePace() {
    try { onTrack(await wordcraftApi.updateTrack({ show_pace: !track.show_pace })); } catch (e) { notifyError(e); }
  }
  return (
    <div className="wc-progress">
      <ProgressCharts track="wordcraft" unit="realm" onOpen={onOpen} />
      <div className="rs-stat-row">
        <div className="rs-stat"><b>{p.cards.held}</b><span>cards held</span></div>
        <div className="rs-stat"><b>{p.exercises.done}</b><span>exercises done</span></div>
        <div className="rs-stat"><b>{acc}%</b><span>right first time</span></div>
      </div>
      <div className="rs-card">
        <div className="rs-section-label">Your six pillars</div>
        <div className="wc-skills">
          {p.skills.map((s, k) => (
            <div key={s.id} className="wc-skill" style={{ ["--i" as string]: k }}>
              <b>{PILLAR_LABELS[s.id]}</b>
              <div className="wc-skill-bar">{[1, 2, 3, 4].map(n => <span key={n} className={s.score >= n ? "on" : ""} />)}</div>
              <small className="muted">{["Not started", "Started", "Guided", "Independent", "Strong"][s.score]} · {s.lessons_done} lesson{s.lessons_done === 1 ? "" : "s"}</small>
            </div>
          ))}
        </div>
      </div>
      <div className="rs-card">
        <div className="rs-section-label">Your writing over time</div>
        <div className="wc-trends">
          <Trend label="Words per sentence" values={p.writing.map(w => w.words_per_sentence)} />
          <Trend label="Joined ideas per sentence" values={p.writing.map(w => w.joins_per_sentence)} />
          <Trend label="Word variety (MTLD)" values={p.writing.map(w => w.mtld)} />
          <Trend label="Editor score" values={p.writing.map(w => w.score)} />
        </div>
        <p className="muted">Trends, not a level. Longer sentences aren't always better; what matters is that the reader follows you.</p>
      </div>
      {realmCando && (
        <div className="rs-card">
          <div className="rs-section-label">How sure are you? Realm {realmCando.realm}: {realmCando.name}</div>
          <ul className="wc-rate">
            {realmCando.items.map((it, k) => (
              <li key={k}><span>{it.text}</span>
                <span className="wc-chips">{["Not yet", "With help", "Mostly", "Easily"].map((l, n) => (
                  <button key={l} className={`wc-chip ${it.rating === n + 1 ? "on" : ""}`} onClick={() => rate(k, n + 1)}>{l}</button>
                ))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!p.rounds.length && (
        <div className="rs-card">
          <div className="rs-section-label">Conversations with characters</div>
          <ul className="rs-checks">{p.rounds.map(r => <li key={r.id} className={r.score !== null && r.score >= 7 ? "met" : ""}><span className="rs-check-dot">{r.score !== null && r.score >= 7 && <Check size={12} />}</span>{CHARACTERS[r.persona]?.name ?? r.persona}<small>{r.score ?? "—"}/10 · {r.created_at.slice(0, 10)}</small></li>)}</ul>
        </div>
      )}
      <div className="rs-card">
        <div className="rs-section-label">Pace and fillers</div>
        <p className="rs-lead">Wordcraft never scores how fast or smoothly you speak. If you'd find it useful, the app can show your pace and filler words in speaking practice, for your information only.</p>
        <button className={`wc-chip ${track.show_pace ? "on" : ""}`} onClick={togglePace}>{track.show_pace ? "Shown" : "Hidden"}</button>
      </div>
    </div>
  );
}
