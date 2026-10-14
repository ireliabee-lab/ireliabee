import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Loader2, Sparkles, RotateCw, BookOpen, Layers, ListChecks, Check, X, ArrowRight, RotateCcw } from "lucide-react";
import { fetchApi } from "../../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../../lib/errors";
import { track } from "../../lib/usage";
import Illustration from "../Illustration";
import FilePicker from "../FilePicker";

export interface StudyPack {
  title: string;
  summary: string;
  outline: { heading: string; points: string[] }[];
  key_points: string[];
  glossary: { term: string; definition: string }[];
  flashcards: { front: string; back: string }[];
  quiz: { question: string; options: string[]; answer: number; explanation: string }[];
  generated_at: string;
  condensed?: boolean;
}

type View = "notes" | "cards" | "quiz";

async function saveResult(sessionId: number, kind: "quiz" | "flashcards", score: number, total: number) {
  try {
    await fetchApi(`/notes/${sessionId}/study/result`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, score, total }),
    });
  } catch { /* results are a bonus; never block studying */ }
}

/**
 * A lecture's study pack (roadmap 3.1): notes, flashcards and a quiz.
 * `autoGenerate` makes it straight away (a lecture just ended); `startOn`
 * opens a view (Practice → Study opens on flashcards).
 */
export default function StudyPanel({ sessionId, autoGenerate = false, startOn = "notes" }: {
  sessionId: number; autoGenerate?: boolean; startOn?: View;
}) {
  const [pack, setPack] = useState<StudyPack | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [view, setView] = useState<View>(startOn);
  const [slides, setSlides] = useState<number[]>([]);
  const started = useRef(false);

  useEffect(() => {
    setLoading(true);
    fetchApi(`/notes/${sessionId}/study`)
      .then(async r => { if (!r.ok) throw await errorFromResponse(r); return r.json(); })
      .then(p => {
        setPack(p);
        if (!p && autoGenerate && !started.current) { started.current = true; generate(); }
      })
      .catch(notifyError).finally(() => setLoading(false));
  }, [sessionId]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function generate(fallbackCredits?: boolean | unknown) {
    const useCredits = fallbackCredits === true;
    if (!(await ensureReady(["llm"]))) return;
    setWorking(true);
    try {
      const cfg = await fetchApi("/config").then(r => r.json());
      track("study.generate");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (useCredits) headers["X-IRB-Use-Credits"] = "1";
      const res = await fetchApi(`/notes/${sessionId}/study`, {
        method: "POST", headers,
        body: JSON.stringify({ model: cfg?.saved?.model, document_ids: slides.length ? slides : undefined }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      setPack(await res.json());
    } catch (e) { notifyError(e, () => generate(true)); } finally { setWorking(false); }
  }

  if (loading) return <div className="glass-card plans-empty"><Loader2 size={18} className="spin" /></div>;

  if (!pack) {
    return (
      <div className="session-hub-stack">
        <div className="glass-card plans-empty">
          <Illustration name="stories" />
          <div className="plans-empty-title">{working ? "Making your study pack…" : "Turn this lecture into a study pack"}</div>
          <p className="muted">A summary, the lecture's outline, key points, a glossary, flashcards and a quiz — all from what was said.</p>
          {!working && (
            <div className="study-slides">
              <label className="settings-label">Add the slides or handout (optional)</label>
              <FilePicker value={slides} onChange={setSlides}
                emptyHint="Add the lecture slides to your Library to make the pack more accurate." />
            </div>
          )}
          <button className="btn-primary" onClick={() => generate(false)} disabled={working}>
            {working ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} {working ? "Writing…" : "Make study pack"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="session-hub-stack">
      <div className="session-hub-actions study-tabs">
        {([["notes", "Notes", <BookOpen size={13} key="n" />], ["cards", `Flashcards · ${pack.flashcards.length}`, <Layers size={13} key="c" />],
           ["quiz", `Quiz · ${pack.quiz.length}`, <ListChecks size={13} key="q" />]] as const).map(([id, label, icon]) => (
          <button key={id} className={`page-tab ${view === id ? "active" : ""}`} onClick={() => setView(id)}>{icon}{label}</button>
        ))}
        <button className="btn-neutral study-refresh" onClick={() => generate(false)} disabled={working} title="Make the pack again">
          {working ? <Loader2 size={13} className="spin" /> : <RotateCw size={13} />}
        </button>
      </div>

      {view === "notes" && <Notes pack={pack} />}
      {view === "cards" && <Flashcards key={pack.generated_at} pack={pack} sessionId={sessionId} />}
      {view === "quiz" && <Quiz key={pack.generated_at} pack={pack} sessionId={sessionId} />}
    </div>
  );
}

function Notes({ pack }: { pack: StudyPack }) {
  return (
    <div className="study-notes">
      <section className="glass-card progress-card">
        <header><BookOpen size={14} /> {pack.title || "Summary"}</header>
        <p className="study-summary">{pack.summary}</p>
        {pack.condensed && <p className="progress-hint">A long lecture — it was condensed part by part first, so the whole lecture is covered.</p>}
      </section>
      {pack.key_points.length > 0 && (
        <section className="glass-card progress-card">
          <header><Sparkles size={14} /> Key points</header>
          <ul className="progress-focus">{pack.key_points.map((k, i) => <li key={i}>{k}</li>)}</ul>
        </section>
      )}
      {pack.outline.length > 0 && (
        <section className="glass-card progress-card study-outline">
          <header><ListChecks size={14} /> Outline</header>
          <ol>
            {pack.outline.map((s, i) => (
              <li key={i}><strong>{s.heading}</strong>{s.points.length > 0 && <ul>{s.points.map((p, j) => <li key={j}>{p}</li>)}</ul>}</li>
            ))}
          </ol>
        </section>
      )}
      {pack.glossary.length > 0 && (
        <section className="glass-card progress-card">
          <header><Layers size={14} /> Glossary</header>
          <dl className="study-glossary">
            {pack.glossary.map((g, i) => <div key={i}><dt>{g.term}</dt><dd>{g.definition}</dd></div>)}
          </dl>
        </section>
      )}
    </div>
  );
}

/** One pass through the deck: "Got it" or "Again"; cards marked Again come back at the end. */
function Flashcards({ pack, sessionId }: { pack: StudyPack; sessionId: number }) {
  const [queue, setQueue] = useState(() => pack.flashcards.map((_, i) => i));
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<number>>(new Set());
  const [firstTry, setFirstTry] = useState<Set<number>>(new Set());
  const [seen, setSeen] = useState<Set<number>>(new Set());
  const saved = useRef(false);
  const total = pack.flashcards.length;
  const current = queue[0];

  useEffect(() => {
    if (queue.length === 0 && total > 0 && !saved.current) {
      saved.current = true;
      saveResult(sessionId, "flashcards", firstTry.size, total);
      track("study.flashcards.done");
    }
  }, [queue.length, total, firstTry.size, sessionId]);

  function mark(gotIt: boolean) {
    const i = queue[0];
    if (gotIt) {
      setKnown(k => new Set(k).add(i));
      if (!seen.has(i)) setFirstTry(f => new Set(f).add(i));
      setQueue(q => q.slice(1));
    } else {
      setQueue(q => [...q.slice(1), i]);
    }
    setSeen(s => new Set(s).add(i));
    setFlipped(false);
  }

  if (total === 0) return <p className="muted">No flashcards in this pack.</p>;
  if (current === undefined) {
    return (
      <div className="glass-card plans-empty">
        <Illustration name="progress" />
        <div className="plans-empty-title">Deck done — {firstTry.size} of {total} first time</div>
        <p className="muted">Cards you missed came back until you had them. Go again tomorrow to make it stick.</p>
        <button className="btn-primary" onClick={() => { setQueue(pack.flashcards.map((_, i) => i)); setKnown(new Set()); setFirstTry(new Set()); setSeen(new Set()); saved.current = false; }}>
          <RotateCcw size={14} /> Go through again
        </button>
      </div>
    );
  }
  const card = pack.flashcards[current];
  return (
    <div className="study-cards">
      <div className="study-progress"><i style={{ width: `${(known.size / total) * 100}%` }} /></div>
      <span className="muted study-count">{known.size} of {total} learned</span>
      <button className={`glass-card study-card ${flipped ? "flipped" : ""}`} onClick={() => setFlipped(f => !f)} title="Click or press Space to flip">
        <span className="study-card-side">{flipped ? "Answer" : "Question"}</span>
        <span className="study-card-text">{flipped ? card.back : card.front}</span>
        {!flipped && <span className="muted study-card-hint">Say the answer out loud, then flip</span>}
      </button>
      {flipped && (
        <div className="study-card-actions">
          <button className="btn-neutral" onClick={() => mark(false)}><X size={14} /> Again</button>
          <button className="btn-primary" onClick={() => mark(true)}><Check size={14} /> Got it</button>
        </div>
      )}
    </div>
  );
}

function Quiz({ pack, sessionId }: { pack: StudyPack; sessionId: number }) {
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const total = pack.quiz.length;

  if (total === 0) return <p className="muted">No quiz questions in this pack.</p>;
  if (idx >= total) {
    const pct = Math.round((score / total) * 100);
    return (
      <div className="glass-card plans-empty">
        <Illustration name="score" />
        <div className="plans-empty-title">{score} / {total} · {pct}%</div>
        <p className="muted">{pct >= 80 ? "Solid — you've got this lecture." : pct >= 50 ? "Getting there. Review the notes and flashcards, then try again." : "Go back through the notes and flashcards first, then retake it."}</p>
        <button className="btn-primary" onClick={() => { setIdx(0); setPicked(null); setScore(0); }}><RotateCcw size={14} /> Retake quiz</button>
      </div>
    );
  }
  const q = pack.quiz[idx];
  function choose(i: number) {
    if (picked !== null) return;
    setPicked(i);
    if (i === q.answer) setScore(s => s + 1);
  }
  function next() {
    const nextIdx = idx + 1;
    if (nextIdx >= total) {
      saveResult(sessionId, "quiz", score, total);
      track("study.quiz.done");
      toast.success(`Quiz done — ${score}/${total}`);
    }
    setIdx(nextIdx); setPicked(null);
  }
  return (
    <div className="glass-card study-quiz">
      <span className="muted study-count">Question {idx + 1} of {total} · score {score}</span>
      <div className="study-question">{q.question}</div>
      <div className="study-options">
        {q.options.map((o, i) => (
          <button key={i} onClick={() => choose(i)} disabled={picked !== null}
            className={`study-option ${picked === null ? "" : i === q.answer ? "right" : i === picked ? "wrong" : "dim"}`}>
            <b>{String.fromCharCode(65 + i)}</b><span>{o}</span>
          </button>
        ))}
      </div>
      {picked !== null && (
        <>
          <p className={`study-explain ${picked === q.answer ? "right" : "wrong"}`}>
            {picked === q.answer ? "Right. " : `Not quite — it's ${String.fromCharCode(65 + q.answer)}. `}{q.explanation}
          </p>
          <button className="btn-primary study-next" onClick={next}>{idx + 1 < total ? "Next question" : "See score"} <ArrowRight size={14} /></button>
        </>
      )}
    </div>
  );
}
