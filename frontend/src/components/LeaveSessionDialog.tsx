import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";

/**
 * Asked before leaving a session that is still listening: leaving the screen
 * stops it hearing the call. Staying is the default, and Escape stays.
 */
export default function LeaveSessionDialog({ onStay, onLeave }: {
  onStay: () => void;
  /** `pause` marks the session paused first, so it can be resumed from Sessions. */
  onLeave: (pause: boolean) => Promise<void> | void;
}) {
  const stay = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    stay.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onStay(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStay]);

  const leave = async (pause: boolean) => {
    setBusy(true);
    try { await onLeave(pause); } finally { setBusy(false); }
  };

  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onStay(); }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="leave-title" aria-describedby="leave-body"
        style={{
          width: 420, maxWidth: "calc(100vw - 32px)", padding: "22px 22px 18px", borderRadius: 14,
          background: "rgba(var(--base-rgb), 0.98)", boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          display: "flex", flexDirection: "column", gap: 12,
        }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, display: "grid", placeItems: "center",
            background: "rgba(var(--accent-rgb),0.14)", color: "var(--primary-hover)", flexShrink: 0 }}>
            <Mic size={16} />
          </span>
          <strong id="leave-title" style={{ fontSize: 15, color: "var(--text)" }}>Your session is still listening</strong>
        </div>
        <p id="leave-body" style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--muted)" }}>
          Leaving this screen stops listening to the call. The questions and answers so far are kept.
          Pause it to pick up where you left off from Sessions → Paused.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap", marginTop: 4 }}>
          <button className="btn-neutral" onClick={() => leave(false)} disabled={busy}>Leave</button>
          <button className="btn-neutral" onClick={() => leave(true)} disabled={busy}>Pause and leave</button>
          <button ref={stay} className="btn-primary" onClick={onStay} disabled={busy}>Stay in the session</button>
        </div>
      </div>
    </div>
  );
}
