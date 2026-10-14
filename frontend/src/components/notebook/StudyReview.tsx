import { useEffect, useRef, useState } from "react";
import { CalendarClock, CheckCircle2, CircleDashed, GraduationCap, Loader2, X } from "lucide-react";
import { readingApi, rememberedLevel, type CheckResult } from "../../lib/reading";
import { comesBack, studyApi, type StudyCard } from "../../lib/study";
import { OWN_ASSISTANT_COST, useOwnAssistant } from "../../lib/relay";
import { notifyError } from "../../lib/errors";
import { verdict } from "./CheckCard";
import MicButton from "./MicButton";

/**
 * Today's reviews (Study mode, S1): each question answered earlier in a
 * notebook comes back on its schedule. Answer from memory, see what you got
 * and missed, and it is rescheduled: sooner if you missed it, later if not.
 */
export default function StudyReview({ onClose, onDone }: { onClose: () => void; onDone?: () => void }) {
  const ownAssistant = useOwnAssistant();
  const [cards, setCards] = useState<StudyCard[] | null>(null);
  const [at, setAt] = useState(0);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [next, setNext] = useState<StudyCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    studyApi.due().then(r => setCards(r.cards)).catch(e => { notifyError(e); setCards([]); });
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { before?.focus?.(); };
  }, []);

  const card = cards?.[at];

  async function mark() {
    if (!card || !answer.trim()) return;
    setBusy(true);
    try {
      const r = await readingApi.checkMark({ text: card.paragraph, question: card.question, points: card.points, answer,
        level: rememberedLevel(), document_id: card.document_id });
      setResult(r);
      setNext(await studyApi.review(card.id, r.score));
      setDone(d => d + 1);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  function advance() {
    setAnswer(""); setResult(null); setNext(null);
    setAt(i => i + 1);
  }

  const finished = cards !== null && at >= cards.length;
  useEffect(() => { if (finished && done) onDone?.(); }, [finished]);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panel} tabIndex={-1} className="glass-card study-review" role="dialog" aria-modal="true" aria-label="Today's reviews"
        onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
        <header className="study-head">
          <strong><GraduationCap size={16} /> Today's reviews</strong>
          {cards && cards.length > 0 && !finished && <span className="muted">{at + 1} of {cards.length}</span>}
          <button type="button" className="nb-icon-btn" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </header>

        {cards === null && <p className="muted"><Loader2 size={14} className="spin" /> Finding what's due…</p>}

        {finished && (
          <div className="study-done">
            <CheckCircle2 size={28} />
            <p><strong>{done ? `${done} reviewed.` : skipped ? "Nothing reviewed this time." : "Nothing to review right now."}</strong></p>
            <p className="muted">{skipped
              ? `${skipped} skipped ${skipped === 1 ? "question stays" : "questions stay"} due until you answer ${skipped === 1 ? "it" : "them"}.`
              : "Questions you answer with \"Check my understanding\" in a notebook come back here when they're due."}</p>
            <button type="button" className="nbk-pill" onClick={onClose}>Close</button>
          </div>
        )}

        {card && (
          <>
            <p className="muted study-from">From <strong>{card.notebook_title ?? "a notebook"}</strong>{card.src.length ? ` · p. ${card.src.join(", ")}` : ""}</p>
            <p className="nbk-check-q">{card.question}</p>
            {!result ? (
              <form onSubmit={e => { e.preventDefault(); void mark(); }}>
                <textarea id="study-answer" className="nb-input" rows={4} maxLength={2000} value={answer} disabled={busy} autoFocus
                  placeholder="Answer from memory, in your own words…" aria-label="Your answer"
                  onChange={e => setAnswer(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void mark(); } }} />
                <div className="nbk-explain-actions">
                  <button type="submit" className="nbk-pill" disabled={!answer.trim() || busy}>
                    {busy ? <><Loader2 size={13} className="spin" /> Marking…</> : "Check my answer"}
                  </button>
                  <MicButton disabled={busy} onText={said => setAnswer(a => (a.trim() ? `${a.trimEnd()} ${said}` : said))} />
                  <button type="button" className="btn-neutral" disabled={busy} onClick={() => { setSkipped(n => n + 1); advance(); }}>Skip for now</button>
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
                {next && <p className="muted nbk-check-kept"><CalendarClock size={13} /> Comes back {comesBack(next.due)}.</p>}
                <div className="nbk-explain-actions">
                  <button type="button" className="nbk-pill" autoFocus onClick={advance}>{at + 1 < (cards?.length ?? 0) ? "Next question" : "Finish"}</button>
                </div>
              </div>
            )}
          </>
        )}
        <p className="muted nbk-explain-cost">{ownAssistant ? `${OWN_ASSISTANT_COST}.` : "Marking each answer uses a few credits. The review schedule itself is free."}</p>
      </div>
    </div>
  );
}
