import { useEffect, useState } from "react";
import { BookOpen, BookOpenCheck, CalendarClock, CheckCircle2, CircleDashed, Loader2, X } from "lucide-react";
import { readingApi, type CheckResult, type ReaderLevel } from "../../lib/reading";
import { comesBack, studyApi, type ChapterQuestion } from "../../lib/study";
import { OWN_ASSISTANT_COST, useOwnAssistant, relayIssueLine, useAssistantAuto } from "../../lib/relay";
import { notifyError, toFriendly } from "../../lib/errors";
import { verdict } from "./CheckCard";
import MicButton from "./MicButton";
import StudyExplain from "./StudyExplain";

type Step = "survey" | "reading" | "recite" | "done";

/**
 * Study a chapter (Study mode, S2: SQ3R). Survey the chapter's points, read it
 * with its questions pinned beside the book, then answer each from memory.
 * A miss points to the source page it is on; every question is kept for review.
 */
export default function StudyChapter({ notebookId, documentId, sectionId, title, points, level, onSource, onClose }: {
  notebookId: number;
  documentId: number | null;
  sectionId: string;
  title: string;
  /** The chapter's notes, for the survey. */
  points: { text: string; src: number[] }[];
  level: ReaderLevel;
  onSource?: (src: number[]) => void;
  onClose: () => void;
}) {
  const ownAssistant = useOwnAssistant();
  const [step, setStep] = useState<Step>("survey");
  const [questions, setQuestions] = useState<ChapterQuestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [relayIssue, setRelayIssue] = useState<string | null>(null);
  const relayAuto = useAssistantAuto(relayIssue);
  const [at, setAt] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scores, setScores] = useState<number[]>([]);
  const [explaining, setExplaining] = useState(false);
  // What studying this chapter costs, shown before anything is spent (study-mode decision 4).
  const [estimate, setEstimate] = useState<{ questions_ready: boolean; answers: number; credits: number | null } | null>(null);
  useEffect(() => { studyApi.chapterEstimate(notebookId, sectionId, level).then(setEstimate).catch(() => setEstimate(null)); }, [notebookId, sectionId, level]);

  function load(fallbackCredits = false) {
    setLoading(true); setRelayIssue(null);
    studyApi.chapter({ notebook_id: notebookId, section_id: sectionId, level, fallback_credits: fallbackCredits })
      .then(r => setQuestions(r.questions))
      .catch(e => {
        const code = toFriendly(e).code;
        if (code === "relay_not_listening" || code === "relay_timeout") setRelayIssue(code); else notifyError(e);
      })
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const q = questions?.[at];

  async function mark() {
    if (!q || !answer.trim()) return;
    setBusy(true);
    try {
      const r = await readingApi.checkMark({ text: q.paragraph, question: q.question, points: q.points, answer, level, document_id: documentId });
      setResult(r);
      setScores(s => [...s, r.score]);
      const card = await studyApi.add({ notebook_id: notebookId, document_id: documentId, paragraph: q.paragraph, src: q.src,
        question: q.question, points: q.points, score: r.score }).catch(() => null);
      setDue(card?.due ?? null);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  function next() {
    setAnswer(""); setResult(null); setDue(null);
    if (questions && at + 1 < questions.length) setAt(at + 1); else setStep("done");
  }

  const cost = ownAssistant ? `${OWN_ASSISTANT_COST}.`
    : estimate?.credits != null
      ? `${estimate.credits < 0.1 ? "Under 0.1" : `About ${estimate.credits.toFixed(1)}`} credits to ${estimate.questions_ready ? "" : "make the questions and "}mark ${estimate.answers} answers. Reviews are scheduled for free.`
      : "The questions and each marking use a few credits. Reviews are scheduled for free.";

  if (explaining) return <StudyExplain notebookId={notebookId} sectionId={sectionId} title={title} onClose={onClose} />;

  // While reading: a small panel beside the book, so the pages stay usable.
  if (step === "reading") {
    return (
      <aside className="nbk-help study-pinned" aria-label="Questions to read for">
        <div className="nbk-help-head"><BookOpen size={13} /> <strong>Reading for</strong>
          <button type="button" className="nb-icon-btn" aria-label="Stop studying" onClick={onClose}><X size={13} /></button></div>
        <ol className="study-qs">{questions?.map((x, i) => <li key={i}>{x.question}</li>)}</ol>
        <button type="button" className="nbk-pill" onClick={() => setStep("recite")}><BookOpenCheck size={13} /> I've read it, test me</button>
      </aside>
    );
  }

  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-card study-review" role="dialog" aria-modal="true" aria-label={`Study ${title}`}
        onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
        <header className="study-head">
          <strong><BookOpenCheck size={16} /> Study: {title}</strong>
          {step === "recite" && questions && <span className="muted">{at + 1} of {questions.length}</span>}
          <button type="button" className="nb-icon-btn" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </header>

        {step === "survey" && (
          <>
            <p className="study-step"><span>1</span> Survey: what this chapter covers</p>
            <ul className="study-survey">{points.slice(0, 8).map((p, i) => <li key={i}>{p.text}</li>)}
              {points.length > 8 && <li className="muted">and {points.length - 8} more</li>}</ul>
            <p className="study-step"><span>2</span> Read to answer these</p>
            {loading && <p className="muted"><Loader2 size={13} className="spin" /> Writing the questions{ownAssistant ? " with your assistant" : ""}…</p>}
            {relayIssue && (
              <div className="mm-actions">
                <p className="muted">{relayIssueLine(relayIssue, relayAuto)}</p>
                <button type="button" className="nbk-pill" onClick={() => load(false)}>Try again</button>
                <button type="button" className="btn-neutral" onClick={() => load(true)}>Use credits instead</button>
              </div>
            )}
            {questions && <ol className="study-qs">{questions.map((x, i) => <li key={i}>{x.question}</li>)}</ol>}
            <div className="nbk-explain-actions">
              <button type="button" className="nbk-pill" disabled={!questions} onClick={() => setStep("reading")}><BookOpen size={13} /> Start reading</button>
              <button type="button" className="btn-neutral" disabled={!questions} onClick={() => setStep("recite")}>I've read it already</button>
            </div>
          </>
        )}

        {step === "recite" && q && (
          <>
            <p className="study-step"><span>3</span> Answer from memory</p>
            <p className="nbk-check-q">{q.question}</p>
            {!result ? (
              <form onSubmit={e => { e.preventDefault(); void mark(); }}>
                <textarea id="study-chapter-answer" className="nb-input" rows={4} maxLength={2000} value={answer} disabled={busy} autoFocus
                  placeholder="In your own words, without looking…" aria-label="Your answer" onChange={e => setAnswer(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void mark(); } }} />
                <div className="nbk-explain-actions">
                  <button type="submit" className="nbk-pill" disabled={!answer.trim() || busy}>
                    {busy ? <><Loader2 size={13} className="spin" /> Marking…</> : "Check my answer"}</button>
                  <MicButton disabled={busy} onText={said => setAnswer(a => (a.trim() ? `${a.trimEnd()} ${said}` : said))} />
                  <button type="button" className="btn-neutral" disabled={busy} onClick={next}>Skip</button>
                </div>
              </form>
            ) : (
              <div className="nbk-check-result" aria-live="polite">
                <p className="nbk-check-verdict"><strong>{verdict(result.score)}</strong> <span className="muted">{result.score}/100</span></p>
                <ul className="nbk-check-points">
                  {result.points.map((p, i) => {
                    const got = result.got.includes(i + 1);
                    return <li key={i} className={got ? "got" : "missed"}>
                      {got ? <CheckCircle2 size={14} aria-label="You got this" /> : <CircleDashed size={14} aria-label="You missed this" />} {p}</li>;
                  })}
                </ul>
                {result.score < 85 && q.src.length > 0 && onSource && (
                  <p className="study-feynman">Look again, then put it in plain words:{" "}
                    <button type="button" className="nbk-help-src" onClick={() => onSource(q.src)}>Show me where · p. {q.src.join(", ")}</button></p>
                )}
                {due && <p className="muted nbk-check-kept"><CalendarClock size={13} /> Comes back {comesBack(due)} to review.</p>}
                <div className="nbk-explain-actions">
                  <button type="button" className="nbk-pill" autoFocus onClick={next}>{questions && at + 1 < questions.length ? "Next question" : "Finish"}</button>
                </div>
              </div>
            )}
          </>
        )}

        {step === "done" && (
          <div className="study-done">
            <CheckCircle2 size={28} />
            <p><strong>{scores.length ? `${scores.filter(s => s >= 85).length} of ${scores.length} answered well.` : "No answers this time."}</strong></p>
            <p className="muted">{scores.length ? "Every question you answered comes back for review: sooner the ones you missed." : "Study this chapter again whenever you're ready."}</p>
            <div className="nbk-explain-actions">
              <button type="button" className="nbk-pill" onClick={() => setExplaining(true)}
                title="Explain the chapter to an expert, then to a beginner, and see how clear each was">Explain it twice</button>
              <button type="button" className="btn-neutral" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
        {step !== "done" && <p className="muted nbk-explain-cost">{cost}</p>}
      </div>
    </div>
  );
}
