import { useEffect, useRef } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  message: string;
  detail?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ message, detail, confirmLabel = "Delete", onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const handler = (e: KeyboardEvent) => {
      // Stopped here, in the capture phase: a dialog on top of another window closes itself, not both.
      if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
      if (e.key === "Enter")  onConfirm();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCancel, onConfirm]);

  return (
    /* Backdrop */
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 500,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      {/* Panel */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 340,
          background: "rgba(var(--base-rgb), 0.96)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          borderRadius: 14,
          padding: "28px 24px 22px",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          display: "flex", flexDirection: "column", gap: 16,
        }}
      >
        {/* Icon + message */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
          <div style={{
            width: 44, height: 44, borderRadius: "50%",
            background: "rgba(239,68,68,0.12)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <AlertTriangle size={20} style={{ color: "var(--tone-red)" }} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)", lineHeight: 1.4 }}>
            {message}
          </div>
          {detail && (
            <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
              {detail}
            </div>
          )}
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button
            ref={cancelRef}
            onClick={onCancel}
            style={{
              flex: 1, padding: "9px 0", border: "none", borderRadius: 8,
              background: "rgba(var(--ink-rgb),0.07)",
              color: "var(--muted)", fontSize: 13, fontWeight: 600,
              fontFamily: "var(--font)", cursor: "pointer",
              transition: "background 0.15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(var(--ink-rgb),0.12)")}
            onMouseLeave={e => (e.currentTarget.style.background = "rgba(var(--ink-rgb),0.07)")}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              flex: 1, padding: "9px 0", border: "none", borderRadius: 8,
              background: "rgba(239,68,68,0.85)",
              color: "#fff", fontSize: 13, fontWeight: 700,
              fontFamily: "var(--font)", cursor: "pointer",
              boxShadow: "0 0 20px rgba(239,68,68,0.30)",
              transition: "background 0.15s, box-shadow 0.15s",
            }}
            onMouseEnter={e => { e.currentTarget.style.background = "#ef4444"; e.currentTarget.style.boxShadow = "0 0 28px rgba(239,68,68,0.50)"; }}
            onMouseLeave={e => { e.currentTarget.style.background = "rgba(239,68,68,0.85)"; e.currentTarget.style.boxShadow = "0 0 20px rgba(239,68,68,0.30)"; }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
