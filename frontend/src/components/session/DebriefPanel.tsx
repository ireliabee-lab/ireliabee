import { useEffect, useState } from "react";
import { Sparkles, RotateCcw } from "lucide-react";
import DebriefReport, { type Debrief } from "../DebriefReport";
import { fetchApi } from "../../lib/api";
import { ensureReady, errorFromResponse, openSettings, toFriendly, type FriendlyInfo } from "../../lib/errors";
import { track } from "../../lib/usage";
import Illustration from "../Illustration";

type State = "loading" | "empty" | "generating" | "ready" | "error";

/** Score and review of one session: loads a saved debrief or writes one on request. */
export default function DebriefPanel({ sessionId, onLeave }: { sessionId: number; onLeave?: () => void }) {
  const [state, setState] = useState<State>("loading");
  const [report, setReport] = useState<Debrief | null>(null);
  const [error, setError] = useState<FriendlyInfo | null>(null);

  useEffect(() => {
    setState("loading");
    fetchApi(`/sessions/${sessionId}/debrief`).then(r => r.json()).then(d => {
      if (d?.debrief) { setReport(d.debrief); setState("ready"); }
      else setState("empty");
    }).catch(() => setState("empty"));
  }, [sessionId]);

  async function generate(fallbackCredits?: boolean | unknown) {
    const useCredits = fallbackCredits === true;
    if (!(await ensureReady(["llm"]))) return;
    setState("generating");
    setError(null);
    try {
      const cfg = await fetchApi("/config").then(r => r.json());
      track("session.debrief");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (useCredits) headers["X-IRB-Use-Credits"] = "1";
      const res = await fetchApi(`/sessions/${sessionId}/debrief`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: cfg?.saved?.model, response_tone: cfg?.saved?.response_tone }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      setReport(await res.json());
      setState("ready");
    } catch (e: any) {
      setError(toFriendly(e));
      setState("error");
    }
  }

  return (
    <>
      {state === "loading" && <div className="coach-skeleton"><span /><span /><span /></div>}

      {(state === "empty" || state === "error") && (
        <div className="debrief-empty">
          <Illustration name="coach" />
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
            {state === "error" ? (error?.title || "Couldn't write the debrief") : "No debrief yet"}
          </div>
          <p className="muted" style={{ fontSize: 13, maxWidth: 420, textAlign: "center" }}>
            {state === "error" ? error?.message : "Get a score, what landed, stronger versions of weak answers, questions you could have asked, and next steps."}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            {state === "error" && error?.action === "settings" && (
              <button className="btn-neutral" onClick={() => { onLeave?.(); openSettings(); }}>Open Settings</button>
            )}
            {state === "error" && error?.action === "credits_fallback" && (
              <>
                <button className="btn-primary" onClick={() => generate(true)}><Sparkles size={14} /> Use credits instead</button>
                <button className="btn-neutral" onClick={() => { onLeave?.(); openSettings(); }}>Check assistant in Settings</button>
              </>
            )}
            {state === "error" && error?.action !== "credits_fallback" && (
              <button className="btn-primary" onClick={() => generate(false)}><Sparkles size={14} /> Try again</button>
            )}
            {state === "empty" && (
              <button className="btn-primary" onClick={() => generate(false)}><Sparkles size={14} /> Generate debrief</button>
            )}
          </div>
        </div>
      )}

      {state === "generating" && (
        <div className="debrief-empty">
          <div className="voice-orb state-thinking" style={{ ["--level" as any]: 0.2, ["--orb" as any]: "140px" }}>
            <span className="orb-ring r3" /><span className="orb-ring r2" /><span className="orb-ring r1" />
            <span className="orb-core"><span className="orb-initial">✓</span></span>
            <span className="orb-orbit"><i /><i /><i /></span>
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>Reviewing the conversation…</div>
          <p className="muted" style={{ fontSize: 12 }}>Scoring answers and writing stronger versions</p>
        </div>
      )}

      {state === "ready" && report && (
        <>
          <div className="session-hub-actions">
            <button className="btn-neutral" onClick={generate} title="Write a fresh debrief">
              <RotateCcw size={12} /> Regenerate
            </button>
          </div>
          <DebriefReport report={report} sessionId={sessionId} />
        </>
      )}
    </>
  );
}
