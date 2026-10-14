import { useEffect, useState } from "react";
import { Loader2, Wand2, X } from "lucide-react";
import { notifyError, toFriendly } from "../lib/errors";
import { useOwnAssistant, relayIssueLine, useAssistantAuto } from "../lib/relay";
import { sourceTidyApi, tidyCostLine, type TidyEstimate, type TidyResult } from "../lib/sourceTidy";

/**
 * Tidy a saved YouTube transcript: the AI adds punctuation and paragraphs and works out who is
 * speaking. The cost is shown before anything runs, and the result is a new Library document,
 * so the original and the notes that cite its pages stay as they are.
 */
export default function TidyTranscript({ docId, name, onClose, onDone }: {
  docId: number; name: string; onClose: () => void; onDone: (r: TidyResult) => void;
}) {
  const ownAssistant = useOwnAssistant();
  const [est, setEst] = useState<TidyEstimate | null>(null);
  const [busy, setBusy] = useState(false);
  const [relayIssue, setRelayIssue] = useState<string | null>(null);
  const relayAuto = useAssistantAuto(relayIssue);

  useEffect(() => { sourceTidyApi.estimate(docId).then(setEst).catch(e => { notifyError(e); onClose(); }); }, [docId, onClose]);

  async function run(fallbackCredits = false) {
    setBusy(true); setRelayIssue(null);
    try {
      onDone(await sourceTidyApi.tidy(docId, fallbackCredits, !!est?.existing));
    } catch (e) {
      const code = toFriendly(e).code;
      if (code === "relay_not_listening" || code === "relay_timeout") setRelayIssue(code); else notifyError(e);
    } finally { setBusy(false); }
  }

  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="debrief-panel library-kind-panel" role="dialog" aria-modal="true" aria-label="Tidy transcript">
        <header className="debrief-panel-head">
          <div style={{ minWidth: 0 }}>
            <div className="debrief-kicker">Tidy transcript</div>
            <div className="debrief-title">{name}</div>
          </div>
          <button className="titlebar-btn" onClick={onClose} disabled={busy} title="Cancel"><X size={16} /></button>
        </header>
        <div className="debrief-panel-body library-kind">
          <p className="muted">
            The AI adds punctuation and paragraphs, and works out who is speaking: by name when they're introduced,
            otherwise Host, Guest and so on. Every word said is kept. It's saved as a new copy beside this one,
            so this transcript and any notes made from it stay as they are.
          </p>
          {est?.existing && (
            <p className="muted">
              <strong>Already tidied</strong> as “{est.existing.name}” in your Library. Tidying again makes another copy and is paid again.
            </p>
          )}
          <p className="muted">{est ? tidyCostLine(est, ownAssistant) : <><Loader2 size={13} className="spin" /> Working out the cost…</>}</p>
          {relayIssue ? (
            <div className="mm-actions">
              <p className="muted">{relayIssueLine(relayIssue, relayAuto)}</p>
              <button type="button" className="nbk-pill" onClick={() => run(false)}>Try again</button>
              <button type="button" className="btn-neutral" onClick={() => run(true)}>
                Use credits instead{est?.credits != null ? ` (about ${est.credits} credits)` : ""}
              </button>
            </div>
          ) : (
            <button type="button" className="btn-primary" disabled={!est || busy} onClick={() => run(false)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start" }}>
              {busy
                ? <><Loader2 size={13} className="spin" /> Tidying{ownAssistant ? " with your assistant" : ""}… a long video takes a few minutes</>
                : <><Wand2 size={13} /> {est?.existing ? "Tidy again" : "Tidy transcript"}</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
