import { useEffect, useState } from "react";
import { TrendingUp, TrendingDown, Flame, Clock, Target, Lightbulb, Gauge, MessageCircleWarning, Loader2, ShieldCheck, Plus, GraduationCap, MessagesSquare } from "lucide-react";
import { fetchApi } from "../lib/api";
import Page from "./Page";
import Illustration from "./Illustration";

interface Point { date: string; [k: string]: any; }
interface Progress {
  summary: {
    sessions: number; practice_minutes: number; streak_days: number;
    avg_score: number | null; score_change: number | null;
    avg_wpm: number | null; avg_filler_rate: number | null; filler_change: number | null;
    avg_confidence: number | null; confidence_change: number | null;
    drills: number; solid_topics: number; topics: number;
    study_answers?: number; study_due?: number; avg_study?: number | null;
    talk_drills?: number; avg_talk?: number | null; talk_change?: number | null;
  };
  scores: Point[];
  delivery: Point[];
  confidence: Point[];
  drills: Point[];
  study_answers?: Point[];
  talk?: Point[];
  focus: string[];
}

function shortDate(iso: string) {
  return new Date(iso.length <= 19 ? iso + "Z" : iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Small dependency-free line chart. `band` shades the healthy range.
function TrendChart({ points, field, max, min = 0, band, format = (v: number) => String(v) }: {
  points: Point[]; field: string; max: number; min?: number;
  band?: [number, number]; format?: (v: number) => string;
}) {
  const data = points.filter(p => typeof p[field] === "number");
  if (data.length === 0) return <p className="progress-empty-chart">No data yet</p>;
  const W = 320, H = 110, PAD = 14;
  const x = (i: number) => data.length === 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (data.length - 1);
  const y = (v: number) => H - PAD - ((Math.min(Math.max(v, min), max) - min) / (max - min)) * (H - PAD * 2);
  const line = data.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[field]).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
  return (
    <svg className="trend-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
      {band && <rect x={0} width={W} y={y(band[1])} height={y(band[0]) - y(band[1])} className="trend-band" />}
      <path d={area} className="trend-area" />
      <path d={line} className="trend-line" />
      {data.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p[field])} r={3} className="trend-dot">
          <title>{`${shortDate(p.date)} · ${format(p[field])}${p.title ? ` · ${p.title}` : p.topic ? ` · ${p.topic}` : ""}`}</title>
        </circle>
      ))}
    </svg>
  );
}

function Delta({ value, goodWhen, unit = "" }: { value: number | null; goodWhen: "up" | "down"; unit?: string }) {
  if (value == null || value === 0) return null;
  const good = goodWhen === "up" ? value > 0 : value < 0;
  return (
    <span className={`progress-delta ${good ? "good" : "bad"}`}>
      {value > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {value > 0 ? "+" : ""}{value}{unit}
    </span>
  );
}

export default function ProgressView() {
  const [data, setData] = useState<Progress | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetchApi("/progress/").then(r => r.ok ? r.json() : Promise.reject()).then(setData).catch(() => setFailed(true));
  }, []);

  const frame = (body: React.ReactNode) => (
    <Page title="Progress" subtitle="How your answers, delivery and understanding are changing over time.">
      {body}
    </Page>
  );
  if (failed) return frame(<div className="page-content"><p className="muted">Couldn't load your progress. Try again in a moment.</p></div>);
  if (!data) return frame(<div className="page-content progress-loading"><Loader2 size={18} className="spin" /></div>);

  const s = data.summary;
  const confidence = data.confidence ?? [];
  const studied = data.study_answers ?? [];
  const talk = data.talk ?? [];
  const nothingYet = !data.scores.length && !data.delivery.length && !data.drills.length && !confidence.length && !studied.length && !talk.length;

  return frame(
    <div className="page-content">

      {nothingYet ? (
        <div className="glass-card plans-empty">
          <Illustration name="progress" />
          <div className="plans-empty-title">Your progress shows up here</div>
          <p className="muted">Do a mock interview, run a debrief on a live session, or try an Explain Clearly drill. Scores, pace and filler words are tracked automatically.</p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <button className="btn-primary" onClick={() => window.dispatchEvent(new Event("start-new-session"))}>
              <Plus size={14} /> New session
            </button>
            <button className="btn-neutral" onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "practice" }))}>
              Practise instead
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="progress-stats">
            <div className="glass-card progress-stat">
              <Flame size={16} className="streak" />
              <strong>{s.streak_days}</strong>
              <span>day streak</span>
            </div>
            <div className="glass-card progress-stat">
              <Target size={16} />
              <strong>{s.avg_score ?? "—"}<small>/10</small></strong>
              <span>recent score <Delta value={s.score_change} goodWhen="up" /></span>
            </div>
            <div className="glass-card progress-stat">
              <ShieldCheck size={16} />
              <strong>{s.avg_confidence ?? "—"}<small>/100</small></strong>
              <span>confidence <Delta value={s.confidence_change} goodWhen="up" /></span>
            </div>
            <div className="glass-card progress-stat">
              <MessageCircleWarning size={16} />
              <strong>{s.avg_filler_rate ?? "—"}</strong>
              <span>fillers / 100 words <Delta value={s.filler_change} goodWhen="down" /></span>
            </div>
            <div className="glass-card progress-stat">
              <Clock size={16} />
              <strong>{s.practice_minutes}</strong>
              <span>minutes practised</span>
            </div>
            <div className="glass-card progress-stat">
              <Lightbulb size={16} />
              <strong>{s.solid_topics}<small>/{s.topics}</small></strong>
              <span>topics you can explain</span>
            </div>
          </div>

          <div className="progress-grid">
            <section className="glass-card progress-card">
              <header><Target size={14} /> Interview scores</header>
              <TrendChart points={data.scores} field="score" min={0} max={10} band={[7, 10]} format={v => `${v}/10`} />
              <p className="progress-hint">From debriefs and mock interviews. 7+ is a strong answer.</p>
            </section>
            <section className="glass-card progress-card">
              <header><Gauge size={14} /> Speaking pace</header>
              <TrendChart points={data.delivery} field="wpm" min={60} max={220} band={[120, 170]} format={v => `${v} wpm`} />
              <p className="progress-hint">{s.avg_wpm ? `Recently ${s.avg_wpm} wpm. ` : ""}120–170 words per minute sounds natural.</p>
            </section>
            <section className="glass-card progress-card">
              <header><MessageCircleWarning size={14} /> Filler words</header>
              <TrendChart points={data.delivery} field="filler_rate" min={0} max={12} band={[0, 2]} format={v => `${v} per 100 words`} />
              <p className="progress-hint">Per 100 words. Under 2 sounds confident — the same measure the Confidence score uses.</p>
            </section>
            <section className="glass-card progress-card">
              <header><ShieldCheck size={14} /> Confidence</header>
              <TrendChart points={confidence} field="confidence" min={0} max={100} band={[80, 100]} format={v => `${v}/100`} />
              <p className="progress-hint">From each session's Confidence tab (Sessions → Review). 80+ comes across confident.</p>
            </section>
            <section className="glass-card progress-card">
              <header><Lightbulb size={14} /> Explain Clearly</header>
              <TrendChart points={data.drills} field="score" min={0} max={100} band={[80, 100]} format={v => `${v}%`} />
              <p className="progress-hint">Understanding per drill. 80%+ holds up in an interview.</p>
            </section>
            {studied.length > 0 && (
              <section className="glass-card progress-card">
                <header><GraduationCap size={14} /> Study reviews</header>
                <TrendChart points={studied} field="score" min={0} max={100} band={[85, 100]} format={v => `${v}/100`} />
                <p className="progress-hint">{s.study_answers ?? 0} answered from memory in your notebooks{s.study_due ? `, ${s.study_due} due now (Notebook → Review)` : ""}. 85+ means you've got it.</p>
              </section>
            )}
            {talk.length > 0 && (
              <section className="glass-card progress-card">
                <header><MessagesSquare size={14} /> Talk at work</header>
                <TrendChart points={talk} field="score" min={0} max={100} band={[80, 100]} format={v => `${v}/100`} />
                <p className="progress-hint">{s.talk_drills ?? 0} {s.talk_drills === 1 ? "drill" : "drills"}{s.avg_talk != null ? `, recently ${Math.round(s.avg_talk)}/100` : ""}{s.talk_change != null && <> <Delta value={s.talk_change} goodWhen="up" /></>}. Judged on main point first, clarity and length.</p>
              </section>
            )}
            <section className="glass-card progress-card progress-next">
              <header><Target size={14} /> Work on next</header>
              {data.focus.length > 0
                ? <ul className="progress-focus">{data.focus.map(f => <li key={f}>{f}</li>)}</ul>
                : <p className="progress-hint">Nothing stands out yet — keep practising and your weakest areas show up here.</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
