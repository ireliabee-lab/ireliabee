import { useEffect, useRef, useState } from "react";
import { Compass, Loader2 } from "lucide-react";
import { fetchApi } from "../lib/api";

interface Line { speaker: "interviewer" | "you"; text: string; }
interface Followup { question: string; prep: string; }

// Waits for the candidate to finish speaking before predicting, so a stream
// of partial captions doesn't fire a request per word.
const SETTLE_MS = 1500;

// Through the user's own assistant a prediction can wait up to ten minutes
// (the engine's relay limit). Long before that it is about a turn long gone.
const GIVE_UP_MS = 90_000;

export default function FollowupCard({ lines, triggerKey }: { lines: Line[]; triggerKey: string }) {
  const [followups, setFollowups] = useState<Followup[]>([]);
  const [loading, setLoading] = useState(false);
  const latest = useRef(lines);
  latest.current = lines;

  useEffect(() => {
    if (!triggerKey) return;
    let cancelled = false;
    // A prediction nobody will see is cancelled, not left open: the webview has
    // only a few connections for the engine, and with them all held by
    // predictions waiting on the assistant, a live answer (/coach/turn) queued
    // behind them and never reached the engine — its turn sat on loading dots.
    const ctrl = new AbortController();
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(async () => {
      setLoading(true);
      giveUp = setTimeout(() => ctrl.abort(), GIVE_UP_MS);
      try {
        const res = await fetchApi("/coach/followups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcript: latest.current.slice(-12) }),
          signal: ctrl.signal,
        });
        // Predictions are a nice-to-have: failures stay silent mid-interview.
        const data = res.ok ? await res.json() : { followups: [] };
        if (!cancelled && data.followups?.length) setFollowups(data.followups);
      } catch { /* ignore */ } finally {
        clearTimeout(giveUp);
        if (!cancelled) setLoading(false);
      }
    }, SETTLE_MS);
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(giveUp); ctrl.abort(); };
  }, [triggerKey]);

  if (!followups.length && !loading) return null;

  return (
    <div className="followup-card">
      <div className="followup-head">
        <Compass size={13} />
        <span>Likely next</span>
        {loading && <Loader2 size={12} className="spin" />}
      </div>
      {followups.map((f, i) => (
        <div key={`${f.question}-${i}`} className="followup-item">
          <p className="followup-q">{f.question}</p>
          {f.prep && <p className="followup-prep">{f.prep}</p>}
        </div>
      ))}
    </div>
  );
}
