import { useEffect, useState } from "react";
import { CalendarClock, CheckCircle2, CircleDashed, GraduationCap, Loader2, RotateCcw, X, XCircle } from "lucide-react";
import { readingApi, type CheckResult, type ReaderLevel } from "../../lib/reading";
import { notifyError } from "../../lib/errors";
import { comesBack, studyApi, type StudyCard } from "../../lib/study";

type Question = { question: string; points: string[] };

/** How the score reads: a word, not a grade. */
export function verdict(score: number): string {
  if (score >= 85) return "You've got it";
  if (score >= 50) return "Nearly there";
  return "Worth another look";
}

/**
 * Check your understanding: one question about the paragraph at the cursor
 * (POST /reading/check/question), your answer in your own words, marked
 * against that paragraph (POST /reading/check/mark): the points you got, the
 * ones you missed, and anything to correct. "Another question" never repeats one.
 */
export default function CheckCard({ paragraph, documentId, notebookId, level, onClose }: {
  paragraph: { text: string; src: number[] };
  documentId: number | null;
  /** Marked questions are kept here for spaced review (Study mode). */
  notebookId?: number;
  level: ReaderLevel;
  onClose: () => void;
}) {
  const [q, setQ] = useState<Question | null>(null);
  const [asked, setAsked] = useState<string[]>([]);
  const [answer, setAnswer] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState<"question" | "mark" | null>(null);
  const [kept, setKept] = useState<StudyCard | null>(null);

  async function nextQuestion(avoid: string[]) {
    setBusy("question");
    setResult(null);
    setAnswer("");
    try {
      const r = await readingApi.checkQuestion({ text: paragraph.text, document_id: documentId, pages: paragraph.src, level, avoid });
      setQ(r);
      setAsked(a => [...a, r.question]);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => { void nextQuestion([]); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  async function mark() {
    if (!q || !answer.trim()) return;
    setBusy("mark");
    try {
      const marked = await readingApi.checkMark({ text: paragraph.text, question: q.question, points: q.points, answer, level, document_id: documentId });
      setResult(marked);
      // Keep it for review: scheduling is free (no AI); a failure here never hides the marking.
      if (notebookId) {
        studyApi.add({ notebook_id: notebookId, document_id: documentId, paragraph: paragraph.text, src: paragraph.src,
          question: q.question, points: q.points, score: marked.score }).then(setKept).catch(() => setKept(null));
      }
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="nbk-help nbk-explain-card" role="dialog" aria-label="Check your understanding"
      onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
      <div className="nbk-help-head"><GraduationCap size={13} /> <strong>Check your understanding</strong>
        <button type="button" className="nb-icon-btn" aria-label="Close" onClick={onClose}><X size={13} /></button></div>
      {busy === "question" && <p className="muted"><Loader2 size={13} className="spin" /> Thinking of a question…</p>}
      {q && busy !== "question" && (
        <>
          <p className="nbk-check-q">{q.question}</p>
          {!result ? (
            <form className="nbk-check-form" onSubmit={e => { e.preventDefault(); void mark(); }}>
              <textarea id="nbk-check-answer" className="nb-input" rows={3} maxLength={2000} value={answer} disabled={busy === "mark"}
                placeholder="Answer in your own words, without looking…" aria-label="Your answer"
                onChange={e => setAnswer(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void mark(); } }} />
              <div className="nbk-explain-actions">
                <button type="submit" className="nbk-pill" disabled={!answer.trim() || busy === "mark"}>
                  {busy === "mark" ? <><Loader2 size={13} className="spin" /> Marking…</> : "Check my answer"}
                </button>
                <span className="muted nbk-explain-cost">Ctrl + Enter</span>
              </div>
            </form>
          ) : (
            <div className="nbk-check-result" aria-live="polite">
              <p className="nbk-check-verdict"><strong>{verdict(result.score)}</strong> <span className="muted">{result.score}/100</span></p>
              <ul className="nbk-check-points">
                {result.points.map((p, i) => {
                  const got = result.got.includes(i + 1);
                  return (
                    <li key={i} className={got ? "got" : "missed"}>
                      {got ? <CheckCircle2 size={14} aria-label="You got this" /> : <CircleDashed size={14} aria-label="You missed this" />} {p}
                    </li>
                  );
                })}
              </ul>
              {result.wrong.map((w, i) => (
                <p key={i} className="nbk-check-wrong"><XCircle size={13} /> {w.said && <><span className="muted">You wrote:</span> {w.said} </>}
                  <span className="muted">The paragraph says:</span> {w.fix}</p>
              ))}
              {result.note && <p className="muted">{result.note}</p>}
              {kept && (
                <p className="muted nbk-check-kept"><CalendarClock size={13} /> This question comes back {comesBack(kept.due)} to review.{" "}
                  <button type="button" className="btn-link" onClick={() => { void studyApi.remove(kept.id).then(() => setKept(null)).catch(notifyError); }}>
                    Don't review it</button></p>
              )}
              <div className="nbk-explain-actions">
                <button type="button" className="nbk-pill" onClick={() => { setResult(null); }}><RotateCcw size={13} /> Try again</button>
                <button type="button" className="nbk-pill" onClick={() => void nextQuestion(asked)}>Another question</button>
              </div>
            </div>
          )}
        </>
      )}
      <p className="muted nbk-explain-cost">A question and each marking use a few credits.</p>
    </div>
  );
}
