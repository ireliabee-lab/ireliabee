import { useEffect, useState } from "react";
import { Timer, Info } from "lucide-react";

/** Speaking-test practice (roadmap 2.3): band scores and task timing. */
export interface ExamMeta { id?: string; name: string; scale: "band" | "task"; max: number; criteria: { key: string; label: string }[]; }
export interface ExamScore { bands: Record<string, number | null>; overall: number | null; scaled: number | null; not_assessed: string[]; }

/** IELTS overall: the average rounded to the nearest half band, with .25 and .75 rounding up. */
export function ieltsRound(mean: number): number {
  return Math.floor(mean * 2 + 0.5) / 2;
}

export function formatOverall(meta: ExamMeta, overall: number | null, scaled: number | null): string {
  if (overall == null) return "—";
  return meta.scale === "band" ? `Band ${overall.toFixed(1).replace(/\.0$/, "")}` : `${overall.toFixed(1)} / ${meta.max}${scaled != null ? ` · ≈ ${scaled}/30` : ""}`;
}

export default function ExamBands({ meta, score, compact = false }: { meta: ExamMeta; score: ExamScore; compact?: boolean }) {
  const missing = meta.criteria.filter(c => score.not_assessed.includes(c.key)).map(c => c.label);
  return (
    <div className={`exam-bands ${compact ? "compact" : ""}`}>
      <div className="exam-overall">
        <strong>{formatOverall(meta, score.overall, score.scaled)}</strong>
        <small>{meta.name}{missing.length ? " · over the parts that could be judged" : ""}</small>
      </div>
      <div className="exam-criteria">
        {meta.criteria.map(c => {
          const v = score.bands[c.key];
          return (
            <div key={c.key} className={`exam-criterion ${v == null ? "none" : ""}`}>
              <span>{c.label}</span>
              <div className="exam-bar"><i style={{ width: `${v == null ? 0 : (v / meta.max) * 100}%` }} /></div>
              <b>{v == null ? "—" : v}</b>
            </div>
          );
        })}
      </div>
      {missing.length > 0 && (
        <p className="exam-note"><Info size={12} /> {missing.join(" and ")} {missing.length === 1 ? "is" : "are"} about how you sound, which can't be judged
          from {compact ? "a transcript" : "typed answers"} — so {missing.length === 1 ? "it isn't" : "they aren't"} scored here. Use the pronunciation hints and a voice test to work on it.</p>
      )}
    </div>
  );
}

/** Exam timing for one task: preparation, then speaking time. Guides the pace; never blocks the answer. */
export function TaskTimer({ prep, speak }: { prep: number; speak: number }) {
  const [stage, setStage] = useState<"prep" | "speak">(prep > 0 ? "prep" : "speak");
  const [left, setLeft] = useState(prep > 0 ? prep : speak);
  useEffect(() => {
    const t = window.setInterval(() => setLeft(l => l - 1), 1000);
    return () => window.clearInterval(t);
  }, [stage]);
  useEffect(() => {
    if (left <= 0 && stage === "prep") { setStage("speak"); setLeft(speak); }
  }, [left, stage, speak]);
  const mmss = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
  const total = stage === "prep" ? prep : speak;
  return (
    <div className={`task-timer ${stage} ${stage === "speak" && left <= 0 ? "over" : ""}`}>
      <Timer size={13} />
      <span>{stage === "prep" ? "Preparation" : left > 0 ? "Speaking time" : "Time's up — finish your sentence"}</span>
      <div className="task-timer-bar"><i style={{ width: `${Math.max(0, left / total) * 100}%` }} /></div>
      <b>{mmss(left)}</b>
      {stage === "prep" && <button className="btn-neutral" onClick={() => { setStage("speak"); setLeft(speak); }}>I'm ready</button>}
    </div>
  );
}
