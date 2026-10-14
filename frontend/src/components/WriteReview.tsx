import { useEffect, useState } from "react";
import { GraduationCap, Loader2, RefreshCw, X } from "lucide-react";
import { notifyError, toFriendly } from "../lib/errors";
import { useOwnAssistant, relayIssueLine, useAssistantAuto } from "../lib/relay";
import { reviewCostLine, writingApi, type Review, type ReviewEstimate } from "../lib/writing";

/**
 * The AI coach on a section or the whole draft (backend/writing_review.py). It points to what to
 * work on and why; it never writes the text. The price is shown first, and a review already paid
 * for is shown again for free, marked when the text has changed since.
 */
export function ReviewPanel({ projectId, sectionId, label, onClose, version }: {
  projectId: number; sectionId: number | null; label: string; onClose?: () => void;
  /** Changes whenever the text does, so the price shown is always for the text as it is now. */
  version: string;
}) {
  const ownAssistant = useOwnAssistant();
  const [est, setEst] = useState<ReviewEstimate | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [relayIssue, setRelayIssue] = useState<string | null>(null);
  const relayAuto = useAssistantAuto(relayIssue);
  const [error, setError] = useState("");

  useEffect(() => {
    setEst(null); setReview(null); setError("");
    writingApi.reviewEstimate(projectId, sectionId)
      .then(e => { setEst(e); setReview(e.saved); })
      .catch(e => setError(toFriendly(e).message ?? "This can't be reviewed yet."));
  }, [projectId, sectionId, version]);

  async function run(fallbackCredits = false) {
    setBusy(true); setRelayIssue(null);
    if (!est) return;
    try { setReview(await writingApi.review(projectId, sectionId, est.text_hash, fallbackCredits)); }
    catch (e) {
      const code = toFriendly(e).code;
      if (code === "relay_not_listening" || code === "relay_timeout") setRelayIssue(code); else notifyError(e);
    } finally { setBusy(false); }
  }

  const whole = sectionId == null;
  return (
    <section className="write-review" aria-label={`Review of ${label}`}>
      <div className="write-review-head">
        <span className="write-kicker"><GraduationCap size={13} /> Coach&rsquo;s review: {label}</span>
        {onClose && <button type="button" className="btn-ghost" onClick={onClose} aria-label="Close the review"><X size={14} /></button>}
      </div>
      <p className="muted write-small">The coach points to what to work on and why. It never writes your text: the words stay yours.</p>
      {error ? <p className="muted">{error}</p> : !est ? <p className="muted"><Loader2 size={13} className="spin" /> Working out the cost…</p> : null}
      {review && (
        <div className="write-review-body">
          {review.stale && <p className="write-warn">You have changed the text since this review. Review again to see notes on the new version.</p>}
          {review.summary && <p className="write-review-summary">{review.summary}</p>}
          {review.strengths.length > 0 && (
            <div><span className="write-kicker">What works</span>
              <ul className="write-plain">{review.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
          )}
          {review.notes.length > 0 && (
            <div><span className="write-kicker">To work on</span>
              <ol className="write-review-notes">
                {review.notes.map((n, i) => (
                  <li key={i}>
                    {n.quote && <blockquote>&ldquo;{n.quote}&rdquo;</blockquote>}
                    <strong>{n.issue}</strong>
                    {n.why && <span className="muted"> {n.why}</span>}
                    {n.try && <span className="write-try">Try: {n.try}</span>}
                  </li>
                ))}
              </ol></div>
          )}
          {review.next && <p className="write-next"><strong>Next:</strong> {review.next}</p>}
        </div>
      )}
      {est && (
        relayIssue ? (
          <div className="mm-actions">
            <p className="muted">{relayIssueLine(relayIssue, relayAuto)}</p>
            <button type="button" className="nbk-pill" onClick={() => void run(false)}>Try again</button>
            <button type="button" className="btn-neutral" onClick={() => void run(true)}>Use credits instead</button>
          </div>
        ) : (
          <div className="write-review-run">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(false)}>
              {busy ? <><Loader2 size={13} className="spin" /> Reading{ownAssistant ? " with your assistant" : ""}…</>
                : review ? <><RefreshCw size={13} /> Review again</> : <><GraduationCap size={13} /> {whole ? "Review the whole draft" : "Review this section"}</>}
            </button>
            <span className="muted write-small">{reviewCostLine(est, ownAssistant)}</span>
          </div>
        )
      )}
    </section>
  );
}
