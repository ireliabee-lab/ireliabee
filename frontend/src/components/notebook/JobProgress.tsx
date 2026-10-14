import { useEffect, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { Job } from "../../lib/reading";
import { getRelayStatus } from "../../lib/relay";
import ApprovalHint from "./ApprovalHint";

/** After this long on one step, show how to approve the assistant's permission prompt. */
const APPROVAL_HINT_AFTER_S = 20;

/** The stages a set of notes goes through, in order. */
const STAGES: { id: string; label: string; doing: string; unit: string }[] = [
  { id: "read", label: "Reading", doing: "Reading the pages", unit: "part" },
  { id: "write", label: "Writing", doing: "Writing the slides", unit: "slide set" },
  { id: "terms", label: "Explaining terms", doing: "Explaining the terms", unit: "part" },
  { id: "done", label: "Ready", doing: "Putting the deck together", unit: "" },
];

/** A friendly name for the assistant the relay reports ("codex-mcp-client" → "Codex"). */
export function assistantName(client: string | null | undefined): string {
  const c = (client ?? "").toLowerCase();
  if (c.includes("codex")) return "Codex";
  if (c.includes("antigravity") || c.includes("gemini")) return "Gemini";
  if (c.includes("claude")) return "Claude";
  if (c.includes("cursor")) return "Cursor";
  return "your assistant";
}

function since(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Where a set of notes has got to: the stage it's in, a chip for every part that
 * fills as it's done, and, when the user's own assistant does the work, who is
 * working on it and for how long.
 */
export default function JobProgress({ job, deep, onStop }: { job: Job; deep: boolean; onStop: () => void }) {
  const [assistant, setAssistant] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let alive = true;
    getRelayStatus().then(s => { if (alive && s.enabled) setAssistant(assistantName(s.client)); }).catch(() => {});
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);

  const stages = STAGES.filter(s => s.id !== "terms" || deep);
  const phase = job.phase ?? "read";
  const current = Math.max(0, stages.findIndex(s => s.id === phase));
  const stage = stages[current];
  const total = Math.max(job.total, 0);
  const done = Math.min(job.done, total);
  // Within the stage: whole parts done, plus a little for the one in progress.
  const pct = total ? Math.round(((done + (done < total ? 0.35 : 0)) / total) * 100) : 6;
  const waited = job.part_started ? Math.max(0, Math.round(now / 1000 - job.part_started)) : null;
  const part = done < total ? done + 1 : total;

  return (
    <div className="glass-card nb-job" aria-live="polite">
      <ol className="nb-job-stages">
        {stages.map((s, i) => (
          <li key={s.id} className={i < current ? "done" : i === current ? "now" : ""}>
            <span className="nb-job-dot">{i < current ? <Check size={13} /> : i + 1}</span>
            <span className="nb-job-label">{s.label}</span>
          </li>
        ))}
      </ol>

      <div className="nb-job-now">
        <Loader2 size={18} className="spin" />
        <strong>{stage.doing}{total ? ` · ${part} of ${total}` : "…"}</strong>
      </div>

      <div className="nb-job-bar" role="progressbar" aria-label={stage.doing} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>

      {total > 1 && (
        <div className="nb-job-chips" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <span key={i} className={i < done ? "done" : i === done ? "now" : ""} />
          ))}
        </div>
      )}

      {assistant ? (
        <>
          <p className="nb-job-who">
            <span className="nb-job-pulse" aria-hidden="true" />
            Waiting for {assistant}{waited !== null ? ` · ${since(waited)} on this ${stage.unit || "step"}` : ""}.
          </p>
          {waited !== null && waited >= APPROVAL_HINT_AFTER_S && <ApprovalHint assistant={assistant} />}
        </>
      ) : (
        <p className="muted nb-job-note">Every point is listed with its page, written into slides, then checked so nothing important is left out.</p>
      )}

      <p className="muted nb-job-note">You can leave this page: the deck appears in Notebook → Reading when it's done.</p>
      <button type="button" className="btn-neutral" onClick={onStop}><X size={14} /> Stop</button>
    </div>
  );
}
