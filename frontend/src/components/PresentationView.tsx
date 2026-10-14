import { useState } from "react";
import { Loader2, Sparkles, Timer, Scissors, AlertTriangle, ThumbsUp, Presentation } from "lucide-react";
import { fetchApi } from "../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../lib/errors";
import { track } from "../lib/usage";

interface Timing {
  words: number; est_minutes: number; est_seconds: number; target_minutes: number | null;
  sentences: number; avg_sentence_words: number; over_under?: number;
  long_sentences: { words: number; text: string }[]; jargon: string[];
}
interface Report {
  timing: Timing; clarity_score: number; opening: string; strengths: string[]; fixes: string[];
}

function mmss(sec: number) { return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; }

export default function PresentationView() {
  const [text, setText] = useState("");
  const [target, setTarget] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [working, setWorking] = useState(false);

  async function analyze() {
    if (text.trim().split(/\s+/).length < 20) { notifyError({ message: "Paste a bit more of your script — at least 20 words." }); return; }
    if (!(await ensureReady(["llm"]))) return;
    setWorking(true);
    try {
      const cfg = await fetchApi("/config").then(r => r.json());
      track("practice.script.check");
      const res = await fetchApi("/presentation/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, target_minutes: target ? Number(target) : null, model: cfg?.saved?.model }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      setReport(await res.json());
    } catch (e) { notifyError(e); } finally { setWorking(false); }
  }

  const t = report?.timing;
  const over = t?.over_under;

  return (
    <div className="plans-page">
      <div className="plans-header">
        <div>
          <h2>Check my script</h2>
          <p className="muted">Paste your script or slide notes for a timing estimate and clarity feedback.</p>
        </div>
      </div>

      <div className="page-split">
      <section className="glass-card plan-form">
        <textarea className="glass-input" rows={16} value={text} onChange={e => setText(e.target.value)}
          placeholder="Paste your talk script or speaker notes…" style={{ resize: "vertical" }} />
        <div className="confidence-picker" style={{ marginTop: 10 }}>
          <input className="glass-input" style={{ maxWidth: 200 }} type="number" min={1} max={120} value={target}
            onChange={e => setTarget(e.target.value)} placeholder="Target minutes (optional)" />
          <button className="btn-primary" onClick={analyze} disabled={working}>
            {working ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
            {working ? "Analysing…" : "Analyse"}
          </button>
        </div>
      </section>

      <aside className="page-side">
      {report && t ? (
        <>
          <section className="glass-card confidence-hero">
            <div className="confidence-score"><strong>{t.est_minutes}</strong><small>min</small></div>
            <div className="confidence-hero-text">
              <span className="plan-section-title"><Timer size={13} /> About {mmss(t.est_seconds)} at a calm pace</span>
              <p className="muted">
                {t.words} words · {t.sentences} sentences · avg {t.avg_sentence_words} words/sentence.
                {over != null && (over > 0
                  ? ` Roughly ${over} min over your ${t.target_minutes}-min target — trim a little.`
                  : over < 0 ? ` About ${Math.abs(over)} min under your ${t.target_minutes}-min target — room to breathe.`
                  : ` Right on your ${t.target_minutes}-min target.`)}
              </p>
            </div>
          </section>

          <section className="glass-card confidence-parts">
            <div className="confidence-part">
              <div className="confidence-part-head">
                <span className="confidence-part-label"><ThumbsUp size={14} /> Clarity</span>
                <span className={`confidence-part-score ${report.clarity_score >= 8 ? "good" : report.clarity_score >= 6 ? "ok" : "low"}`}>{report.clarity_score || "—"}/10</span>
              </div>
              {report.opening && <p className="progress-hint">Punchier opening: <em>"{report.opening}"</em></p>}
            </div>
          </section>
        </>
      ) : (
        <section className="glass-card progress-card">
          <header><Sparkles size={14} /> What you get</header>
          <ul className="progress-focus">
            <li>How long it runs at a calm speaking pace, against your target</li>
            <li>A clarity score and a punchier opening line</li>
            <li>What's working, and what to tighten</li>
            <li>Sentences too long to say in one breath</li>
            <li>Jargon to swap for plain words</li>
          </ul>
        </section>
      )}
      </aside>
      </div>

      {report && t && (
        <div className="card-grid">
          {report.strengths.length > 0 && (
            <section className="glass-card progress-card">
              <header><ThumbsUp size={14} /> Working well</header>
              <ul className="progress-focus">{report.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </section>
          )}
          {report.fixes.length > 0 && (
            <section className="glass-card progress-card">
              <header><Scissors size={14} /> Tighten this</header>
              <ul className="progress-focus">{report.fixes.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </section>
          )}
          {t.long_sentences.length > 0 && (
            <section className="glass-card progress-card">
              <header><AlertTriangle size={14} /> Long sentences ({t.long_sentences.length})</header>
              <ul className="confidence-answers">
                {t.long_sentences.map((s, i) => (
                  <li key={i}><span className="confidence-part-score low">{s.words}w</span><div className="muted">{s.text}…</div></li>
                ))}
              </ul>
            </section>
          )}
          {t.jargon.length > 0 && (
            <section className="glass-card progress-card">
              <header><Presentation size={14} /> Jargon to swap</header>
              <p className="progress-hint">{t.jargon.map(j => `"${j}"`).join(", ")}</p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
