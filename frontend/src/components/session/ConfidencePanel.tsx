import { useEffect, useState } from "react";
import { Gauge, Loader2, MessageCircleWarning, PieChart, ListTree, ShieldQuestion, Sparkles, RotateCw, Lightbulb } from "lucide-react";
import { fetchApi } from "../../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../../lib/errors";
import { track } from "../../lib/usage";
import Illustration from "../Illustration";

interface Phrase { phrase: string; count: number; }
interface Component {
  value: number | null;
  unit: string;
  score: number | null;
  count?: number;
  top?: Phrase[];
  source?: "timing" | "words" | null;
  answers?: { question: string; score: number; note: string }[];
}
interface Report {
  overall: number | null;
  components: Record<"pace" | "fillers" | "hedging" | "talk_share" | "structure", Component>;
  tips: string[];
  words: number;
  generated_at: string;
}

const PARTS: { key: keyof Report["components"]; label: string; icon: JSX.Element; good: string; missing: string }[] = [
  { key: "structure", label: "Answer structure", icon: <ListTree size={14} />, good: "Answer first, one example, clear close.", missing: "No answers long enough to judge." },
  { key: "fillers", label: "Filler words", icon: <MessageCircleWarning size={14} />, good: "Under 2 per 100 words sounds confident.", missing: "" },
  { key: "hedging", label: "Hedging words", icon: <ShieldQuestion size={14} />, good: "\"I think\", \"maybe\", \"probably\" — under 1 per 100 words.", missing: "" },
  { key: "pace", label: "Pace", icon: <Gauge size={14} />, good: "120–170 words a minute sounds natural.", missing: "Needs a spoken session with timing — not available for this one." },
  { key: "talk_share", label: "Talk share", icon: <PieChart size={14} />, good: "35–65% of the talking is a good balance.", missing: "Needs both sides of the conversation." },
];

function level(score: number) {
  return score >= 80 ? "good" : score >= 60 ? "ok" : "low";
}

function describe(c: Component) {
  if (c.value == null) return "—";
  const approx = c.source === "words" ? " of words" : "";
  return c.unit === "%" ? `${c.value}%${approx}` : `${c.value} ${c.unit}`;
}

/** How confidently the user came across in one session (scored on request, then saved). */
export default function ConfidencePanel({ sessionId }: { sessionId: number }) {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [scoring, setScoring] = useState(false);

  useEffect(() => {
    setLoading(true);
    setReport(null);
    fetchApi(`/confidence/${sessionId}`)
      .then(async r => { if (!r.ok) throw await errorFromResponse(r); return r.json(); })
      .then(setReport)
      .catch(notifyError)
      .finally(() => setLoading(false));
  }, [sessionId]);

  async function score() {
    if (!(await ensureReady(["llm"]))) return;
    setScoring(true);
    try {
      const cfg = await fetchApi("/config").then(r => r.json());
      track("session.confidence");
      const res = await fetchApi(`/confidence/${sessionId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg?.saved?.model }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      setReport(await res.json());
    } catch (e) {
      notifyError(e);
    } finally {
      setScoring(false);
    }
  }

  if (loading) return <div className="glass-card plans-empty"><Loader2 size={18} className="spin" /></div>;

  return (
    <div className="session-hub-stack">
      <div className="session-hub-actions">
        <span className="muted">Structure, fillers, hedging, pace and talk share.</span>
        <button className="btn-primary" onClick={score} disabled={scoring}>
          {scoring ? <Loader2 size={14} className="spin" /> : report ? <RotateCw size={14} /> : <Sparkles size={14} />}
          {scoring ? "Scoring…" : report ? "Rescore" : "Score this session"}
        </button>
      </div>

      {!report ? (
        <div className="glass-card plans-empty">
          <Illustration name="score" />
          <div className="plans-empty-title">Not scored yet</div>
          <p className="muted">Scoring reads what you said in this session. Repeated words aren't counted against you — only filler and hedging words are.</p>
        </div>
      ) : (
        <>
          <section className="glass-card confidence-hero">
            {report.overall != null ? (
              <div className={`confidence-score ${level(report.overall)}`}>
                <strong>{report.overall}</strong><small>/100</small>
              </div>
            ) : <div className="confidence-score"><strong>—</strong></div>}
            <div className="confidence-hero-text">
              <span className="plan-section-title">Confidence score</span>
              <p className="muted">Based on {report.words} of your words. Parts without enough data are left out, not counted as zero.</p>
            </div>
          </section>

          <section className="glass-card confidence-parts">
            {PARTS.map(p => {
              const c = report.components[p.key];
              return (
                <div key={p.key} className="confidence-part">
                  <div className="confidence-part-head">
                    <span className="confidence-part-label">{p.icon}{p.label}</span>
                    <span className="confidence-part-value">{describe(c)}</span>
                    <span className={`confidence-part-score ${c.score == null ? "none" : level(c.score)}`}>{c.score ?? "n/a"}</span>
                  </div>
                  <div className="confidence-bar"><span className={c.score == null ? "none" : level(c.score)} style={{ width: `${c.score ?? 0}%` }} /></div>
                  <p className="progress-hint">
                    {c.score == null ? (p.missing || p.good) : p.good}
                    {c.top && c.top.length > 0 && ` Most used: ${c.top.slice(0, 3).map(t => `"${t.phrase}" ×${t.count}`).join(", ")}.`}
                  </p>
                </div>
              );
            })}
          </section>

          {report.tips.length > 0 && (
            <section className="glass-card progress-card">
              <header><Lightbulb size={14} /> Try next time</header>
              <ul className="progress-focus">{report.tips.map(t => <li key={t}>{t}</li>)}</ul>
            </section>
          )}

          {report.components.structure.answers && report.components.structure.answers.length > 0 && (
            <section className="glass-card progress-card">
              <header><ListTree size={14} /> Answer by answer</header>
              <ul className="confidence-answers">
                {report.components.structure.answers.map((a, i) => (
                  <li key={i}>
                    <span className={`confidence-part-score ${level(a.score * 10)}`}>{a.score}/10</span>
                    <div>
                      {a.question && <div className="confidence-question">{a.question}</div>}
                      <div className="muted">{a.note}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
