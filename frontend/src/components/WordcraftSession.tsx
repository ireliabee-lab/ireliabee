import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  BookOpen, BookOpenCheck, Check, ChevronLeft, ChevronRight, CircleHelp, Compass, ExternalLink, Eye, Flag, Lightbulb,
  Loader2, MessageCircle, Mic, PenLine, Play, Puzzle, RotateCcw, Sparkles, Star, Trophy, Undo2,
} from "lucide-react";
import { Celebration, NextButton, Overview, Rail, Ring, type GuidedDay, type IconSet } from "./ResearchSession";
import { openMockWith } from "./MockInterviewView";
import {
  CHARACTERS, acceptedAnswers, countWords, highlightTerms, matches, scramble, splitHighlights, wordcraftApi,
  type CardDef, type Drill, type Feedback, type WcCard, type WcSession, type WcStep,
} from "../lib/wordcraft";
import { notifyError } from "../lib/errors";
import { openExternal } from "../lib/openExternal";

export type WcTab = "map" | "realms" | "cards" | "writing" | "missions" | "progress";

export const WC_ICONS: IconSet = {
  cards: BookOpenCheck, wc_intro: Compass, wc_read: BookOpen, wc_drills: Puzzle, wc_write: PenLine,
  wc_speak: Mic, wc_check: CircleHelp, mission: Flag, exit: Trophy,
};

function describe(step: WcStep): string {
  switch (step.kind) {
    case "cards": return `${step.due ?? 0} to review, ${step.new ?? 0} new`;
    case "wc_intro": return step.lesson?.title ?? "";
    case "wc_read": return step.lesson?.passage?.title ?? "A short passage";
    case "wc_drills": return `${step.drills?.length ?? 0} exercises`;
    case "wc_write": return `At least ${step.lesson?.write?.min_words ?? 0} words`;
    case "wc_speak": return step.lesson?.speak?.character ? `With ${CHARACTERS[step.lesson.speak.character]?.name ?? "a character"}` : "Out loud, no clock";
    case "wc_check": return "Can you explain it?";
    case "mission": return step.mission?.done ? "Done this week" : "This week's quest";
    case "exit": return "The gate to the next realm";
    default: return "";
  }
}

/** Open a practice round with a character, briefed with the learner's level and today's words. */
export async function talkTo(character: string, lessonId = "") {
  try {
    const brief = await wordcraftApi.character(character, lessonId);
    openMockWith({ scenario: brief.scenario, subject: brief.subject, details: brief.details, tone: brief.tone });
  } catch (e) { notifyError(e); }
}

export default function WordcraftSession({ onTab, onFocus }: { onTab: (t: WcTab) => void; onFocus: (running: boolean) => void }) {
  const [s, setS] = useState<WcSession | null>(null);
  const [mode, setMode] = useState<"overview" | "run" | "cards">("overview");
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => { wordcraftApi.session().then(setS).catch(notifyError); }, []);
  useEffect(() => { onFocus(mode !== "overview"); }, [mode, onFocus]);

  const apply = useCallback((next: WcSession, stay = false) => {
    setS(next);
    if (!stay && next.current !== null) setIdx(next.current);
  }, []);

  async function finish(step: WcStep, body: { answer?: string; done?: boolean; results?: boolean[] } = {}) {
    setBusy(true);
    try {
      const next = await wordcraftApi.sessionStep(step.id, body);
      if (step.kind === "wc_check" && body.done !== false) toast.success("Lesson complete");
      apply(next);
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  async function keepGoing() {
    setBusy(true);
    try { apply(await wordcraftApi.sessionMore()); setMode("run"); }
    catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  if (!s) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;
  const day = s as unknown as GuidedDay;

  if (mode === "cards") {
    const step = s.steps[idx];
    return (
      <div className="rs-frame rs-enter">
        <WordDeck onDone={async () => {
          try {
            const q = await wordcraftApi.queue();
            if (!q.due.length && !q.new.length) await finish(step);
            else apply(await wordcraftApi.session(), true);
          } catch (e) { notifyError(e); }
          setMode("run");
        }} />
      </div>
    );
  }

  if (mode === "run") {
    if (s.complete) return <Celebration s={day} busy={busy} onMore={keepGoing} onClose={() => setMode("overview")} onRoadmap={() => onTab("map")} unit="realm" />;
    const step = s.steps[idx] ?? s.steps[s.current ?? 0];
    return (
      <div className="rs-frame">
        <Rail s={day} idx={idx} onPick={i => setIdx(i)} onClose={() => setMode("overview")} icons={WC_ICONS} />
        <div key={step.id} className="rs-stage rs-enter">
          <StepView step={step} busy={busy} onTab={onTab} onFinish={body => finish(step, body)} onCards={() => setMode("cards")}
            onRefresh={async () => apply(await wordcraftApi.session(), true)} />
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

  return <Overview s={day} busy={busy} onStart={() => { setIdx(s.current ?? 0); setMode("run"); }}
    onMore={keepGoing} onCelebrate={() => setMode("run")} onRoadmap={() => onTab("map")}
    icons={WC_ICONS} describe={st => describe(st as unknown as WcStep)} unit="Realm"
    fallback="Words, a passage, practice and a little speaking." />;
}

// ── Steps ────────────────────────────────────────────────────────────────────

function StepHead({ step, kicker }: { step: WcStep; kicker?: string }) {
  const Icon = WC_ICONS[step.kind] ?? Sparkles;
  return (
    <header className="rs-step-head">
      <span className={`rs-step-icon wc-k-${step.kind}`}><Icon size={22} /></span>
      <div>
        <div className="rs-eyebrow">{kicker ?? step.lesson?.title ?? ""}</div>
        <h2 className="rs-step-title">{step.title}</h2>
      </div>
    </header>
  );
}

const Done = () => <div className="rs-done-note"><Check size={15} /> Done</div>;

function StepView({ step, busy, onFinish, onCards, onTab, onRefresh }: {
  step: WcStep; busy: boolean; onFinish: (b?: { answer?: string; done?: boolean; results?: boolean[] }) => void;
  onCards: () => void; onTab: (t: WcTab) => void; onRefresh: () => void;
}) {
  const lesson = step.lesson;
  const realmKicker = step.realm ? `${step.realm.name} · ${step.realm.cefr}` : undefined;
  switch (step.kind) {
    case "cards":
      return (
        <div className="rs-card">
          <StepHead step={step} kicker="Warm up" />
          <p className="rs-lead">Say each word or phrase out loud, say what it means and use it in a sentence. Then turn the card and grade yourself honestly.</p>
          <div className="rs-stat-row">
            <div className="rs-stat"><b>{step.due ?? 0}</b><span>to review</span></div>
            <div className="rs-stat"><b>{step.new ?? 0}</b><span>new today</span></div>
            <div className="rs-stat"><b>10</b><span>minutes</span></div>
          </div>
          {step.done ? <Done /> : (step.due || step.new)
            ? <button className="btn-primary rs-next" onClick={onCards}><Play size={15} /> Start the cards</button>
            : <NextButton busy={busy} onClick={() => onFinish()} label="Nothing due: next" />}
        </div>
      );

    case "wc_intro":
      return (
        <div className="rs-card">
          <StepHead step={step} kicker={`${realmKicker ?? ""} · ${lesson?.minutes ?? ""} min`} />
          <h3 className="rs-lesson-title">{lesson?.title}</h3>
          <blockquote className="rs-why"><Lightbulb size={16} /> {lesson?.why}</blockquote>
          {lesson?.rule && <div className="wc-rule"><b>The rule</b><p>{lesson.rule}</p></div>}
          {!!step.cards?.length && <>
            <div className="rs-section-label">Today's words and phrases · tap a card to turn it</div>
            <div className="rs-flips">{step.cards.map((c, i) => <WordFlip key={c.id} card={c} i={i} />)}</div>
          </>}
          {step.done ? <Done /> : <NextButton busy={busy} onClick={() => onFinish()} label="Begin the quest" />}
        </div>
      );

    case "wc_read":
      return <Passage step={step} busy={busy} onFinish={onFinish} />;

    case "wc_drills":
      return (
        <div className="rs-card">
          <StepHead step={step} kicker={lesson?.title} />
          {step.done ? <><p className="rs-lead">You've done these exercises today. You can practise them again from Realms at any time.</p><Done /></>
            : <DrillRunner drills={step.drills ?? []} seed={lesson?.id.length ?? 1} busy={busy}
                onDone={results => onFinish({ results })} />}
        </div>
      );

    case "wc_write":
      return <WriteStep step={step} busy={busy} onFinish={onFinish} />;

    case "wc_speak": {
      const who = lesson?.speak?.character;
      return (
        <div className="rs-card">
          <StepHead step={step} kicker={lesson?.title} />
          <p className="rs-prompt">{lesson?.speak?.prompt}</p>
          <SpeakTwice />
          <p className="wc-reassure"><Sparkles size={14} /> Pauses, repeated sounds and "um" are fine. What counts is that your message is clear.</p>
          <div className="rs-actions">
            {who && <button className="btn-neutral" onClick={() => talkTo(who, lesson?.id)}><MessageCircle size={15} /> Talk it through with {CHARACTERS[who]?.name ?? "a character"}</button>}
            {step.done ? <Done /> : <NextButton busy={busy} onClick={() => onFinish()} label="I said it out loud" />}
          </div>
        </div>
      );
    }

    case "wc_check":
      return (
        <div className="rs-card">
          <StepHead step={step} kicker={lesson?.title} />
          <p className="rs-prompt">{lesson?.check}</p>
          <p className="rs-lead">Answer it out loud first. Be honest: "not yet" is how learning works.</p>
          {step.done ? <Done /> : (
            <div className="rs-actions rs-check">
              <button className="btn-neutral" disabled={busy} onClick={() => onFinish({ done: false })}><RotateCcw size={15} /> Not yet, go back over it</button>
              <button className="btn-primary rs-next" disabled={busy} onClick={() => onFinish()}><Check size={16} /> Yes, I can explain it</button>
            </div>
          )}
        </div>
      );

    case "mission":
      return <MissionStep step={step} busy={busy} onFinish={onFinish} onRefresh={onRefresh} />;

    case "exit":
      return <ExitStep step={step} busy={busy} onFinish={onFinish} onTab={onTab} onRefresh={onRefresh} />;

    default:
      return <div className="rs-card"><StepHead step={step} />{step.done ? <Done /> : <NextButton busy={busy} onClick={() => onFinish()} />}</div>;
  }
}

// ── Cards ────────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = { word: "Word", phrase: "Phrase", pattern: "Pattern" };

export function WordFlip({ card, i }: { card: CardDef; i: number }) {
  const [on, setOn] = useState(false);
  return (
    <button className={`rs-flip wc-flip ${on ? "on" : ""}`} style={{ ["--i" as string]: i }} onClick={() => setOn(v => !v)} aria-pressed={on}>
      <span className="rs-flip-inner">
        <span className="rs-flip-face rs-flip-front">
          <span className={`wc-kind k-${card.kind}`}>{KIND_LABEL[card.kind]}</span>
          <b>{card.text}</b><small>Say what it means, then tap</small>
        </span>
        <span className="rs-flip-face rs-flip-back">
          <span>{card.meaning}</span>
          {card.example && <em>{card.example}</em>}
          {!!card.goes_with?.length && <span className="wc-goes">{card.goes_with.join(" · ")}</span>}
        </span>
      </span>
    </button>
  );
}

const GRADES = [
  { grade: 0, label: "Again", key: "1" }, { grade: 1, label: "Hard", key: "2" },
  { grade: 2, label: "Good", key: "3" }, { grade: 3, label: "Easy", key: "4" },
];

/** Spaced review of Wordcraft cards. Space turns the card; 1–4 grade it. */
export function WordDeck({ onDone }: { onDone: () => void }) {
  const [queue, setQueue] = useState<WcCard[] | null>(null);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState({ total: 0, good: 0 });

  useEffect(() => {
    wordcraftApi.queue().then(q => setQueue([...q.due, ...q.new])).catch(e => { notifyError(e); setQueue([]); });
  }, []);
  const card = queue?.[0];

  async function grade(g: number) {
    if (!card) return;
    try {
      await wordcraftApi.grade(card.id, g);
      setDone(d => ({ total: d.total + 1, good: d.good + (g >= 2 ? 1 : 0) }));
      setQueue(q => (q ? [...q.slice(1), ...(g === 0 ? [card] : [])] : q));
      setShown(false);
    } catch (e) { notifyError(e); }
  }

  const keys = useMemo(() => (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest("input, textarea")) return;
    if (e.key === " ") { e.preventDefault(); setShown(true); return; }
    const g = GRADES.find(x => x.key === e.key);
    if (g && shown) grade(g.grade);
  }, [shown, card]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys); }, [keys]);

  if (!queue) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;
  if (!card) {
    return (
      <div className="rs-card wc-deck-done">
        <Ring pct={100} size={96} stroke={8}><Check size={30} className="rs-ring-check" /></Ring>
        <h2 className="rs-step-title">{done.total ? "Cards done" : "Nothing due"}</h2>
        <p className="rs-lead">{done.total ? `${done.total} reviews, ${done.good} remembered. The ones you found hard come back sooner.` : "Your next cards come back tomorrow."}</p>
        <button className="btn-primary rs-next" onClick={onDone}>Continue <ChevronRight size={16} /></button>
      </div>
    );
  }
  return (
    <div className="research-review wc-review">
      <div className="research-review-meta muted">{queue.length} left · {card.first_seen ? "review" : "new"} · {KIND_LABEL[card.kind]}{card.job ? ` · ${card.job}` : ""}</div>
      <div key={`${card.id}-${shown}`} className={`glass-card research-flash wc-flash ${shown ? "shown" : ""}`}>
        <span className={`wc-kind k-${card.kind}`}>{KIND_LABEL[card.kind]}</span>
        <div className="research-flash-term">{card.text}</div>
        {!shown && <p className="muted">Say what it means and use it in a sentence, out loud. Then turn the card.</p>}
        {shown && <div className="wc-flash-body">
          <p className="wc-meaning">{card.meaning}</p>
          {card.example && <p className="wc-example">{card.example}</p>}
          {card.goes_with && <p className="wc-goes">Goes with: {card.goes_with}</p>}
          {card.note && <p className="wc-note">{card.note}</p>}
        </div>}
      </div>
      {!shown
        ? <button className="btn-primary research-turn" onClick={() => setShown(true)}>Turn the card <kbd>Space</kbd></button>
        : <div className="research-grades">
            {GRADES.map(g => (
              <button key={g.grade} className={g.grade === 0 ? "btn-neutral danger" : g.grade === 2 ? "btn-primary" : "btn-neutral"} onClick={() => grade(g.grade)}>
                {g.label} <kbd>{g.key}</kbd>
              </button>
            ))}
          </div>}
      <button className="btn-neutral research-stop" onClick={onDone}>Stop for now</button>
    </div>
  );
}

// ── Reading ──────────────────────────────────────────────────────────────────

function Passage({ step, busy, onFinish }: { step: WcStep; busy: boolean; onFinish: (b?: { answer?: string; done?: boolean }) => void }) {
  const lesson = step.lesson;
  const [cards, setCards] = useState<CardDef[]>([]);
  useEffect(() => {
    if (lesson?.id) wordcraftApi.lesson(lesson.id).then(l => setCards(l.card_list)).catch(() => {});
  }, [lesson?.id]);
  const terms = useMemo(() => highlightTerms(cards), [cards]);
  const meaning = useMemo(() => new Map(cards.map(c => [c.text.replace(/[.?!,]+$/, "").toLowerCase(), c.meaning])), [cards]);
  const paragraphs = (lesson?.passage?.text ?? "").split(/\n+/);
  return (
    <div className="rs-card">
      <StepHead step={step} kicker={lesson?.title} />
      <article className="wc-passage">
        <h3>{lesson?.passage?.title}</h3>
        {paragraphs.map((p, i) => (
          <p key={i}>{splitHighlights(p, terms).map((run, j) => run.hit
            ? <mark key={j} className="wc-mark" title={meaning.get(run.text.toLowerCase()) ?? ""}>{run.text}</mark>
            : <span key={j}>{run.text}</span>)}</p>
        ))}
      </article>
      <p className="rs-lead">Read it once for the meaning, then once more out loud. The highlighted words are today's; hover to see what they mean.</p>
      {!!lesson?.passage?.links?.length && (
        <div className="wc-links">
          <div className="rs-section-label">More to read or hear</div>
          {lesson.passage.links.map(l => (
            <button key={l.url} className="wc-link" onClick={() => openExternal(l.url)}>
              <ExternalLink size={14} /> <span><b>{l.title}</b>{l.by && <small>{l.by}</small>}</span>
            </button>
          ))}
        </div>
      )}
      {step.done ? <Done /> : <NextButton busy={busy} onClick={() => onFinish()} label="I've read it" />}
    </div>
  );
}

// ── Exercises ────────────────────────────────────────────────────────────────

type DrillState = { tries: number; status: "open" | "hinted" | "right" | "shown"; picked?: number; typed?: string; order?: string[] };

/**
 * One exercise at a time. A wrong first answer gets a hint; a wrong second one
 * shows the answer and the reason. Only first-try answers count as right. For
 * typed answers there is always "Mine is correct too", because English allows
 * more than one right sentence.
 */
export function DrillRunner({ drills, seed = 1, busy, onDone }: { drills: Drill[]; seed?: number; busy: boolean; onDone: (results: boolean[]) => void }) {
  const [i, setI] = useState(0);
  const [states, setStates] = useState<DrillState[]>(() => drills.map(() => ({ tries: 0, status: "open" })));
  const [firstTry, setFirstTry] = useState<boolean[]>(() => drills.map(() => false));
  const [finished, setFinished] = useState(false);
  const d = drills[i];
  const st = states[i];
  const set = (patch: Partial<DrillState>) => setStates(ss => ss.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  function judge(right: boolean) {
    if (right) {
      if (st.tries === 0) setFirstTry(f => f.map((x, k) => (k === i ? true : x)));
      set({ status: "right", tries: st.tries + 1 });
    } else if (st.tries === 0) {
      set({ status: "hinted", tries: 1 });
    } else {
      set({ status: "shown", tries: st.tries + 1 });
    }
  }
  function mineToo() {
    if (st.tries <= 1) setFirstTry(f => f.map((x, k) => (k === i ? true : x)));
    set({ status: "right" });
  }
  const next = () => (i + 1 < drills.length ? setI(i + 1) : setFinished(true));

  if (!drills.length) return <NextButton busy={busy} onClick={() => onDone([])} label="Next" />;

  if (finished) {
    const right = firstTry.filter(Boolean).length;
    const pct = Math.round((right / drills.length) * 100);
    return (
      <div className="wc-drill-summary rs-enter">
        <Ring pct={pct} size={110} stroke={9}><b>{right}</b><span>of {drills.length}</span></Ring>
        <div>
          <div className="wc-stars">{[0, 1, 2].map(k => <Star key={k} size={22} className={pct >= [40, 70, 90][k] ? "on" : ""} style={{ ["--i" as string]: k }} />)}</div>
          <b>{pct >= 90 ? "Excellent work." : pct >= 70 ? "Well done." : pct >= 40 ? "Good effort." : "A tough set: it will come back soon."}</b>
          <p className="muted">Right first time: {right} of {drills.length}. The realm's exit asks for 80% across its lessons.</p>
          <NextButton busy={busy} onClick={() => onDone(firstTry)} label="Continue" />
        </div>
      </div>
    );
  }

  const answered = st.status === "right" || st.status === "shown";
  return (
    <div className="wc-drills">
      <div className="wc-drill-dots">
        {drills.map((_, k) => <span key={k} className={`${k === i ? "on" : ""} ${k < i ? (firstTry[k] ? "right" : "missed") : ""}`} />)}
      </div>
      <div key={i} className={`wc-drill rs-enter ${st.status}`}>
        <div className="wc-drill-type">{{ choose: "Choose", gap: "Fill the gap", order: "Put in order", fix: "Fix it", join: "Join them" }[d.type]}</div>
        {(d.type === "choose" || d.type === "gap") && <ChoiceDrill d={d} st={st} onPick={k => { set({ picked: k }); judge(k === d.answer); }} />}
        {d.type === "order" && <OrderDrill d={d} seed={seed * 31 + i} st={st} set={set} onCheck={words => judge(matches(words, [d.answer]))} />}
        {(d.type === "fix" || d.type === "join") && <TypedDrill d={d} st={st} set={set} onCheck={text => judge(matches(text, acceptedAnswers(d)))} />}

        {st.status === "hinted" && (
          <div className="wc-hint rs-enter">
            <Lightbulb size={15} /> <span>{d.hint}</span>
            {(d.type === "order" || d.type === "fix" || d.type === "join") && <button className="wc-mine" onClick={mineToo}>Mine is correct too</button>}
          </div>
        )}
        {answered && (
          <div className={`wc-why rs-enter ${st.status}`}>
            <div className="wc-why-head">{st.status === "right" ? <><Check size={16} /> {st.tries <= 1 ? "Right first time" : "Right"}</> : <><Eye size={16} /> Here's the answer</>}</div>
            {st.status === "shown" && <p className="wc-answer">{(d.type === "choose" || d.type === "gap") ? d.options[d.answer] : acceptedAnswers(d)[0]}</p>}
            {st.status === "shown" && d.type !== "choose" && d.type !== "gap" && acceptedAnswers(d).length > 1 &&
              <p className="muted wc-also">Also right: {acceptedAnswers(d).slice(1).join(" / ")}</p>}
            <p>{d.why}</p>
            {st.status === "shown" && (d.type === "order" || d.type === "fix" || d.type === "join") &&
              <button className="wc-mine" onClick={mineToo}>Mine was correct too</button>}
            <button className="btn-primary rs-next" onClick={next}>{i + 1 < drills.length ? "Next exercise" : "See how you did"} <ChevronRight size={16} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChoiceDrill({ d, st, onPick }: { d: Extract<Drill, { type: "choose" | "gap" }>; st: DrillState; onPick: (k: number) => void }) {
  const answered = st.status === "right" || st.status === "shown";
  const [before, after] = d.type === "gap" ? d.sentence.split("___") : ["", ""];
  return (
    <>
      {d.type === "choose" ? <p className="wc-drill-prompt">{d.prompt}</p>
        : <p className="wc-drill-prompt wc-gap">{before}<span className={`wc-blank ${answered ? "filled" : ""}`}>{answered ? d.options[d.answer] : " "}</span>{after}</p>}
      <div className="wc-options">
        {d.options.map((o, k) => {
          const cls = answered && k === d.answer ? "right" : st.picked === k && k !== d.answer ? "wrong" : "";
          return <button key={k} className={`wc-option ${cls}`} disabled={answered} onClick={() => onPick(k)}>{o}</button>;
        })}
      </div>
    </>
  );
}

function OrderDrill({ d, seed, st, set, onCheck }: {
  d: Extract<Drill, { type: "order" }>; seed: number; st: DrillState; set: (p: Partial<DrillState>) => void; onCheck: (text: string) => void;
}) {
  const { tiles, end } = useMemo(() => scramble(d.answer, seed), [d.answer, seed]);
  const placed = st.order ?? [];
  const answered = st.status === "right" || st.status === "shown";
  // Tiles are tracked by position so repeated words work.
  const used = new Set(placed.map(p => Number(p.split(":")[0])));
  const text = placed.map(p => tiles[Number(p.split(":")[0])]).join(" ") + end;
  return (
    <>
      <p className="wc-drill-prompt">Tap the words to build the sentence.</p>
      <div className={`wc-order-line ${placed.length ? "" : "empty"}`}>
        {placed.map(p => {
          const k = Number(p.split(":")[0]);
          return <button key={p} className="wc-tile placed" disabled={answered} onClick={() => set({ order: placed.filter(x => x !== p) })}>{tiles[k]}</button>;
        })}
        {end && <span className="wc-end">{end}</span>}
      </div>
      <div className="wc-tiles">
        {tiles.map((w, k) => (
          <button key={k} className={`wc-tile ${used.has(k) ? "gone" : ""}`} disabled={used.has(k) || answered}
            onClick={() => set({ order: [...placed, `${k}:${w}`] })}>{w}</button>
        ))}
      </div>
      {!answered && (
        <div className="rs-actions">
          <button className="btn-neutral" disabled={!placed.length} onClick={() => set({ order: [] })}><Undo2 size={14} /> Clear</button>
          <button className="btn-primary" disabled={placed.length !== tiles.length} onClick={() => onCheck(text)}>Check</button>
        </div>
      )}
    </>
  );
}

function TypedDrill({ d, st, set, onCheck }: {
  d: Extract<Drill, { type: "fix" | "join" }>; st: DrillState; set: (p: Partial<DrillState>) => void; onCheck: (text: string) => void;
}) {
  const answered = st.status === "right" || st.status === "shown";
  const value = st.typed ?? (d.type === "fix" ? d.sentence : "");
  return (
    <>
      {d.type === "fix"
        ? <p className="wc-drill-prompt">One mistake changes the meaning. Rewrite the sentence correctly.<span className="wc-wrong">{d.sentence}</span></p>
        : <div className="wc-drill-prompt">Join these into one sentence.
            <div className="wc-parts">{d.parts.map((p, k) => <span key={k}>{p}</span>)}</div></div>}
      <textarea id={`wc-typed-${d.type}`} className="glass-input wc-typed" rows={2} value={value} disabled={answered}
        onChange={e => set({ typed: e.target.value })}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && value.trim()) { e.preventDefault(); onCheck(value); } }} />
      {!answered && <div className="rs-actions"><button className="btn-primary" disabled={!value.trim()} onClick={() => onCheck(value)}>Check</button></div>}
    </>
  );
}

// ── Writing and the Editor ───────────────────────────────────────────────────

function WriteStep({ step, busy, onFinish }: { step: WcStep; busy: boolean; onFinish: (b?: { answer?: string; done?: boolean }) => void }) {
  const lesson = step.lesson;
  const min = lesson?.write?.min_words ?? 1;
  const [text, setText] = useState(step.answer ?? "");
  const [saved, setSaved] = useState(true);
  const timer = useRef<number>();
  const words = countWords(text);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  function change(v: string) {
    setText(v); setSaved(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      wordcraftApi.sessionStep(step.id, { answer: v, done: false }).then(() => setSaved(true)).catch(notifyError);
    }, 800);
  }
  const patterns = (step.cards ?? []).filter(c => c.kind === "pattern");
  return (
    <div className="rs-card">
      <StepHead step={step} kicker={lesson?.title} />
      <p className="rs-prompt">{lesson?.write?.prompt}</p>
      {!!patterns.length && <div className="wc-patterns">{patterns.map(p => <span key={p.id}>{p.text}</span>)}</div>}
      <textarea id={`wc-write-${step.id}`} className="glass-input rs-answer" rows={7} value={text}
        placeholder="Write here. It is saved as you type." onChange={e => change(e.target.value)} />
      <div className="wc-count">
        <div className="rs-meter"><span style={{ width: `${Math.min(100, Math.round((words / Math.max(1, min)) * 100))}%` }} /></div>
        <span>{words} of {min} words · {saved ? "Saved" : "Saving…"}</span>
      </div>
      {step.editor && <EditorPanel text={text} lessonId={lesson?.id ?? ""} />}
      {step.done ? <Done /> : <NextButton busy={busy} disabled={words < min} onClick={() => onFinish({ answer: text })}
        label={words < min ? `${min - words} more word${min - words === 1 ? "" : "s"}` : "Next"} />}
    </div>
  );
}

/** Ask the Editor for notes: praise first, then one thing to look at, with the better version behind a tap. */
export function EditorPanel({ text, lessonId = "", prompt = "", onScored }: { text: string; lessonId?: string; prompt?: string; onScored?: (f: Feedback) => void }) {
  const [fb, setFb] = useState<Feedback | null>(null);
  const [asking, setAsking] = useState(false);
  const [reveal, setReveal] = useState(false);
  async function ask() {
    setAsking(true); setReveal(false);
    try { const f = await wordcraftApi.checkWriting(text, lessonId, prompt); setFb(f); onScored?.(f); }
    catch (e) { notifyError(e); } finally { setAsking(false); }
  }
  return (
    <div className="wc-editor">
      <div className="wc-editor-head">
        <PenLine size={16} /> <b>The Editor</b>
        <span className="muted">reads your writing and gives kind, useful notes. One AI check.</span>
        <button className="btn-neutral" disabled={asking || countWords(text) < 3} onClick={ask}>
          {asking ? <><Loader2 size={14} className="spin" /> Reading…</> : fb ? "Check again" : "Ask the Editor"}
        </button>
      </div>
      {fb && (
        <div className="wc-feedback rs-enter">
          {fb.score !== null && <Ring pct={fb.score * 10} size={76} stroke={7}><b>{fb.score}</b><span>/10</span></Ring>}
          <div className="wc-feedback-body">
            {!!fb.strengths.length && <ul className="wc-strengths">{fb.strengths.map((s, k) => <li key={k}><Check size={13} /> {s}</li>)}</ul>}
            {fb.focus && (
              <div className="wc-focus">
                <b>One thing to look at:</b> {fb.focus.look_at}
                {fb.focus.quote && <q>{fb.focus.quote}</q>}
                {reveal ? <p className="wc-better"><b>Better:</b> {fb.focus.better}<br /><span className="muted">{fb.focus.why}</span></p>
                  : <button className="wc-mine" onClick={() => setReveal(true)}>Try it yourself first, then show the better version</button>}
              </div>
            )}
            {fb.next && <p className="muted">Next time: {fb.next}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Speaking ─────────────────────────────────────────────────────────────────

function SpeakTwice() {
  const [ticks, setTicks] = useState([false, false]);
  const steps = ["Say it once, out loud", "Say it again, a little clearer"];
  return (
    <div className="wc-twice">
      {steps.map((label, k) => (
        <button key={k} className={`wc-twice-item ${ticks[k] ? "on" : ""}`} onClick={() => setTicks(t => t.map((x, j) => (j === k ? !x : x)))} aria-pressed={ticks[k]}>
          <span className="rs-read-tick">{ticks[k] && <Check size={14} />}</span> {label}
        </button>
      ))}
      <small className="muted">Saying the same thing twice makes it easier the second time. That is the point.</small>
    </div>
  );
}

// ── Mission and exit ─────────────────────────────────────────────────────────

function MissionStep({ step, busy, onFinish, onRefresh }: { step: WcStep; busy: boolean; onFinish: (b?: { done?: boolean }) => void; onRefresh: () => void }) {
  const m = step.mission;
  if (!m) return null;
  return (
    <div className="rs-card">
      <StepHead step={step} kicker="Once a week" />
      <MissionCard m={m} onRefresh={onRefresh} />
      {step.done ? <Done /> : <NextButton busy={busy} onClick={() => onFinish()} label={m.done ? "Next" : "I'll do it this week"} />}
    </div>
  );
}

export function MissionCard({ m, onRefresh }: { m: NonNullable<WcStep["mission"]>; onRefresh?: () => void }) {
  const pct = Math.round((m.progress / Math.max(1, m.target)) * 100);
  return (
    <div className={`wc-mission ${m.done ? "done" : ""}`}>
      <Flag size={20} className="wc-mission-flag" />
      <div>
        <b>{m.text}</b>
        <div className="rs-meter"><span style={{ width: `${m.done ? 100 : pct}%` }} /></div>
        <small className="muted">{m.done ? "Mission complete this week." : m.kind === "phrases" ? `${m.progress} of ${m.target} found in your real calls so far. Counted on your computer from your own words only.` : m.kind === "character" ? "Any Wordcraft character counts, for three answers or more." : "Tell the app when you've sent it."}</small>
        {!!m.found.length && <div className="wc-patterns">{m.found.map(f => <span key={f}>{f}</span>)}</div>}
        <div className="rs-actions">
          {m.kind === "character" && !m.done && <button className="btn-neutral" onClick={() => talkTo("wc_guide")}><MessageCircle size={14} /> Talk to the Guide</button>}
          {m.kind === "write" && !m.done && <button className="btn-neutral" onClick={async () => { try { await wordcraftApi.missionDone(); onRefresh?.(); toast.success("Mission complete"); } catch (e) { notifyError(e); } }}><Check size={14} /> I've sent it</button>}
        </div>
      </div>
    </div>
  );
}

function ExitStep({ step, busy, onFinish, onTab, onRefresh }: {
  step: WcStep; busy: boolean; onFinish: (b?: { done?: boolean }) => void; onTab: (t: WcTab) => void; onRefresh: () => void;
}) {
  const exit = step.exit;
  const [going, setGoing] = useState(false);
  const [piece, setPiece] = useState("");
  async function levelUp() {
    setGoing(true);
    try { await wordcraftApi.advance(); toast.success("A new realm opens"); onFinish(); }
    catch (e) { notifyError(e); } finally { setGoing(false); }
  }
  const talk = exit?.checks.find(c => c.id === "talk");
  const writing = exit?.checks.find(c => c.id === "writing");
  return (
    <div className="rs-card">
      <StepHead step={step} kicker={exit?.exit?.title ?? "Realm exit"} />
      {exit?.exit?.description && <p className="rs-lead">{exit.exit.description}</p>}
      <ul className="rs-checks">
        {exit?.checks.map(c => (
          <li key={c.id} className={c.met ? "met" : ""}><span className="rs-check-dot">{c.met && <Check size={12} />}</span>{c.label}<small>{c.value}</small></li>
        ))}
      </ul>
      {!exit?.passed && <div className="rs-actions">
        {talk && !talk.met && talk.character && <button className="btn-neutral" onClick={() => talkTo(talk.character!)}><MessageCircle size={15} /> Talk to {CHARACTERS[talk.character]?.name}</button>}
        <button className="btn-neutral" onClick={() => onTab("cards")}><BookOpenCheck size={15} /> Review cards</button>
        <button className="btn-neutral" onClick={() => onTab("realms")}><Puzzle size={15} /> Redo exercises</button>
      </div>}
      {writing && !writing.met && (
        <div className="wc-exit-write">
          <div className="rs-section-label">The written piece for this exit</div>
          <textarea id="wc-exit-writing" className="glass-input rs-answer" rows={6} value={piece} onChange={e => setPiece(e.target.value)}
            placeholder="Write the piece the exit asks for, then ask the Editor." />
          <EditorPanel text={piece} prompt={exit?.exit?.description ?? ""} onScored={() => onRefresh()} />
        </div>
      )}
      <div className="rs-actions">
        {exit?.passed
          ? <button className="btn-primary rs-next rs-level-up" disabled={going || busy} onClick={levelUp}><Trophy size={16} /> Open the next realm</button>
          : step.done ? <Done /> : <NextButton busy={busy} onClick={() => onFinish()} label="Finish for today" />}
      </div>
    </div>
  );
}
