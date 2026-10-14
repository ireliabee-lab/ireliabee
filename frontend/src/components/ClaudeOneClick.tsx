import { useEffect, useState } from "react";
import { CheckCircle, AlertTriangle, Zap } from "lucide-react";
import toast from "react-hot-toast";
import { getAssistantAuto, setAssistantAuto, CLAUDE_CODE_INSTALL_URL, type AssistantAuto } from "../lib/relay";
import { openExternal } from "../lib/openExternal";

/**
 * "Use my Claude subscription" in one click: the app starts Claude Code by itself when a
 * feature needs it, and it stops when there's nothing left to answer. No terminal, no
 * "start iReliabee". `onEnabled` tells Settings the relay switch is on now too.
 */
export default function ClaudeOneClick({ onEnabled }: { onEnabled: (on: boolean) => void }) {
  const [st, setSt] = useState<AssistantAuto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => getAssistantAuto().then(s => { if (alive) setSt(s); }).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  async function flip(on: boolean) {
    setBusy(true);
    try {
      const next = await setAssistantAuto(on);
      setSt(next);
      onEnabled(on);
      toast.success(on ? "Claude Code will answer text features: no credits used" : "Turned off: start your assistant yourself, or use credits");
    } catch {
      toast.error("Couldn't change that. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!st) return null;

  const box: React.CSSProperties = {
    marginTop: 10, marginBottom: 12, padding: "12px 14px", borderRadius: 8,
    background: "var(--card-bg, rgba(255,255,255,0.04))", border: "1px solid var(--border-color, rgba(255,255,255,0.1))",
  };
  const muted: React.CSSProperties = { fontSize: 12, color: "var(--muted, #94a3b8)", lineHeight: 1.45 };

  if (!st.available) {
    return (
      <div style={box} data-testid="claude-one-click">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Use my Claude subscription, in one click</div>
        <div style={muted}>
          Needs Claude Code on this computer, signed in once with your Claude plan.{" "}
          <button type="button" className="link-btn" onClick={() => void openExternal(CLAUDE_CODE_INSTALL_URL)}>Install Claude Code</button>,
          then come back here.
        </div>
      </div>
    );
  }

  if (!st.enabled) {
    return (
      <div style={box} data-testid="claude-one-click">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 260px" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>Use my Claude subscription, in one click</div>
            <div style={muted}>
              Text features run on your own Claude Code instead of credits. The app starts it when a feature needs it,
              and it stops when there's nothing left to answer, so it uses nothing while you're idle.
            </div>
          </div>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void flip(true)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Zap size={14} /> {busy ? "Turning on…" : "Turn on"}
          </button>
        </div>
      </div>
    );
  }

  const answered = st.last_run?.answered;
  return (
    <div style={box} data-testid="claude-one-click">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
            <CheckCircle size={14} color="#10b981" /> Claude Code answers text features
          </div>
          <div style={muted}>
            {st.running
              ? "Answering now."
              : "Ready: it starts by itself when a feature needs it."}
            {!st.running && typeof answered === "number" && answered > 0 ? ` Last run answered ${answered}.` : ""}
            {" "}Uses your Claude plan's limits, not iReliabee credits.
          </div>
        </div>
        <button type="button" className="btn-neutral" disabled={busy} onClick={() => void flip(false)}>
          {busy ? "Turning off…" : "Turn off"}
        </button>
      </div>
      {st.last_error && (
        <div role="alert" style={{ display: "flex", gap: 6, alignItems: "flex-start", marginTop: 8, fontSize: 12, color: "var(--warning, #f59e0b)" }}>
          <AlertTriangle size={14} style={{ flex: "none", marginTop: 1 }} /> <span>{st.last_error}</span>
        </div>
      )}
    </div>
  );
}
