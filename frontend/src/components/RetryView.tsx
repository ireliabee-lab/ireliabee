import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, Loader2, Send, RotateCcw, ArrowRight, TrendingUp, TrendingDown, Minus, Target, Check, History } from "lucide-react";
import { fetchApi } from "../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../lib/errors";
import { takePendingMoment, type Moment } from "../lib/retry";
import { track } from "../lib/usage";
import Illustration from "./Illustration";
import { scoreColor } from "./DebriefReport";

interface Result {
  score: number; previous_score: number | null; delta: number | null; verdict: string;
  improved: string[]; still_missing: string[]; better_answer: string;
}

const date = (iso?: string) => (iso ? new Date(iso + (iso.endsWith("Z") ? "" : "Z")).toLocaleDateString([], { month: "short", day: "numeric" }) : "");

/** Practice → Hard moments (roadmap 3.4): answer the questions that went badly in real calls, again. */
export default function RetryView() {
  const [moments, setMoments] = useState<Moment[] | null>(null);
  const [open, setOpen] = useState<Moment | null>(() => takePendingMoment());

  const load = () => fetchApi("/retry/moments").then(r => (r.ok ? r.json() : [])).then(setMoments).catch(() => setMoments([]));
  useEffect(() => { load(); }, [open]);

  if (open) return <Retry moment={open} onBack={() => setOpen(null)} onNext={() => {
    const rest = (moments ?? []).filter(m => m.question !== open.question);
    setOpen(rest[0] ?? null);
  }} />;

  return (
    <div className="page-content">
      <div className="plans-header">
        <div>
          <h2>Hard moments</h2>
          <p className="muted">Questions that went badly in your real calls and mock interviews, weakest first. Answer them again until they're solid —
            each try is scored against the earlier one.</p>
        </div>
      </div>
      {moments == null ? null : moments.length === 0 ? (
        <div className="glass-card plans-empty">
          <Illustration name="progress" />
          <div className="plans-empty-title">No hard moments yet</div>
          <p className="muted">After a live session or a mock interview, run its Debrief. Any answer scored 6/10 or lower shows up here to practise
            — or pick a question from a session's transcript with "Practise this".</p>
        </div>
      ) : (
        <div className="card-grid">
          {moments.map((m, i) => {
            const solved = !!m.best_retry && m.best_retry.score >= 8;
            return (
              <button key={i} className={`glass-card person-card retry-card ${solved ? "solved" : ""}`} onClick={() => setOpen(m)}>
                <span className="retry-scores">
                  <span className="retry-score" style={{ color: scoreColor(m.score ?? 0), borderColor: scoreColor(m.score ?? 0) }}>{m.score ?? "–"}</span>
                  {m.best_retry && <><ArrowRight size={12} /><span className="retry-score" style={{ color: scoreColor(m.best_retry.score), borderColor: scoreColor(m.best_retry.score) }}>{m.best_retry.score}</span></>}
                  {solved && <span className="person-status done"><Check size={11} /> Solid</span>}
                </span>
                <span className="person-card-main">
                  <strong className="retry-question">{m.question}</strong>
                  {m.feedback && <span className="person-card-summary">{m.feedback}</span>}
                </span>
                <span className="person-card-foot">
                  <span className="muted study-meta"><History size={11} /> {m.session_title} · {date(m.date)}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Retry({ moment, onBack, onNext }: { moment: Moment; onBack: () => void; onNext: () => void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  // Each new try is compared with the latest one, so improvement is visible round by round.
  const [previous, setPrevious] = useState({ answer: moment.previous_answer, score: moment.score });

  async function submit() {
    if (!answer.trim() || !(await ensureReady(["llm"]))) return;
    setBusy(true);
    try {
      const cfg = await fetchApi("/config").then(r => r.json()).catch(() => ({}));
      track("practice.retry");
      const res = await fetchApi("/retry/answer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: moment.session_id, question: moment.question, answer,
          previous_answer: previous.answer, previous_score: previous.score, model: cfg?.saved?.model,
        }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      setResult(await res.json());
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  function again() {
    if (result) setPrevious({ answer, score: result.score });
    setResult(null); setAnswer("");
  }

  const Trend = result?.delta == null ? Minus : result.delta > 0 ? TrendingUp : result.delta < 0 ? TrendingDown : Minus;
  return (
    <div className="page-content">
      <div className="plans-header">
        <div>
          <button className="btn-neutral plan-back" onClick={onBack}><ArrowLeft size={13} /> All hard moments</button>
          <p className="muted" style={{ marginTop: 8 }}>From {moment.session_title ?? "a session"}{moment.date ? ` · ${date(moment.date)}` : ""}</p>
        </div>
      </div>

      <div className="page-split">
        <section className="glass-card retry-main">
          <div className="retry-q">{moment.question}</div>
          {!result ? (
            <>
              <textarea className="glass-input" rows={7} value={answer} autoFocus onChange={e => setAnswer(e.target.value)}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit(); }}
                placeholder="Answer it again, the way you'd say it out loud… (Ctrl+Enter to submit)" />
              <div className="retry-actions">
                <button className="btn-primary" onClick={submit} disabled={busy || !answer.trim()}>
                  {busy ? <><Loader2 size={14} className="spin" /> Scoring…</> : <><Send size={13} /> Score my answer</>}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="retry-result-head">
                <span className="retry-score big" style={{ color: scoreColor(result.score), borderColor: scoreColor(result.score) }}>{result.score}</span>
                <div>
                  {result.previous_score != null && (
                    <div className={`retry-delta ${result.delta! > 0 ? "up" : result.delta! < 0 ? "down" : ""}`}>
                      <Trend size={14} /> {result.previous_score} → {result.score}
                      {result.delta! > 0 ? ` (+${result.delta})` : result.delta! < 0 ? ` (${result.delta})` : " (same)"}
                    </div>
                  )}
                  <div className="retry-verdict">{result.verdict}</div>
                </div>
              </div>
              <div className="mock-feedback-cols">
                <div className="mock-feedback-col">
                  {result.improved.length > 0 && (
                    <div><div className="coach-section-label" style={{ color: "var(--success)" }}>Better than last time</div>
                      <ul className="progress-focus">{result.improved.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
                  )}
                  {result.still_missing.length > 0 && (
                    <div><div className="coach-section-label" style={{ color: "var(--warning)" }}>Still missing</div>
                      <ul className="progress-focus">{result.still_missing.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
                  )}
                </div>
                <div className="mock-feedback-col">
                  <div className="coach-section-label say">Stronger answer</div>
                  <div className="coach-section-body markdown-body"><ReactMarkdown>{result.better_answer}</ReactMarkdown></div>
                </div>
              </div>
              <div className="retry-actions">
                <button className="btn-neutral" onClick={again}><RotateCcw size={13} /> Try again</button>
                <button className="btn-primary" onClick={onNext}>Next hard moment <ArrowRight size={13} /></button>
              </div>
            </>
          )}
        </section>

        <aside className="page-side">
          <section className="glass-card progress-card">
            <header><History size={14} /> {previous.answer === moment.previous_answer ? "Last time" : "Your previous try"}
              {previous.score != null && <span className="retry-score small" style={{ color: scoreColor(previous.score), borderColor: scoreColor(previous.score) }}>{previous.score}</span>}
            </header>
            <p className="retry-previous">{previous.answer || "Not recorded."}</p>
            {previous.answer === moment.previous_answer && moment.feedback && <p className="progress-hint">{moment.feedback}</p>}
          </section>
          {moment.improvements && moment.improvements.length > 0 && previous.answer === moment.previous_answer && (
            <section className="glass-card progress-card">
              <header><Target size={14} /> What to fix</header>
              <ul className="progress-focus">{moment.improvements.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
