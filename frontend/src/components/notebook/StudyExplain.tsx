import { useState } from "react";
import { CheckCircle2, CircleDashed, GraduationCap, Loader2, MessagesSquare, X, XCircle } from "lucide-react";
import { studyApi, type ExplainSide, type ExplainTwiceResult } from "../../lib/study";
import { OWN_ASSISTANT_COST, useOwnAssistant, relayIssueLine, useAssistantAuto } from "../../lib/relay";
import { notifyError, toFriendly } from "../../lib/errors";
import MicButton from "./MicButton";

type Step = "expert" | "beginner" | "result";

const add = (prev: string, said: string) => (prev.trim() ? `${prev.trimEnd()} ${said}` : said);

function Side({ who, side }: { who: string; side: ExplainSide }) {
  const d = side.delivery;
  return (
    <section className="study-side" aria-label={`To ${who}`}>
      <h4>To {who}</h4>
      <p className="study-score"><strong>{side.accurate}</strong><span className="muted">/100 accurate</span>
        {side.plain !== undefined && <> · <strong>{side.plain}</strong><span className="muted">/100 plain</span></>}</p>
      <ul className="nbk-check-points">
        <li className={side.bluf ? "got" : "missed"}>{side.bluf ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />} Main point first</li>
        {side.analogy !== undefined && (
          <li className={side.analogy ? "got" : "missed"}>{side.analogy ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />} An everyday example</li>
        )}
      </ul>
      {side.missed.length > 0 && <p className="muted">Left out: {side.missed.join("; ")}</p>}
      {side.unexplained && side.unexplained.length > 0 && <p className="muted">Terms to explain: {side.unexplained.join(", ")}</p>}
      {side.wrong.map((w, i) => <p key={i} className="nbk-check-wrong"><XCircle size={13} /> <span className="muted">The notes say:</span> {w.fix}</p>)}
      {side.note && <p>{side.note}</p>}
      <p className="muted study-delivery">{d.words} words · {d.fillers} filler {d.fillers === 1 ? "word" : "words"} · {d.hedges} {d.hedges === 1 ? "hedge" : "hedges"}
        {d.examples.length > 0 && <> ({d.examples.join(", ")})</>}</p>
    </section>
  );
}

/**
 * Explain it twice (Study mode, S3): the chapter's main idea to an expert,
 * then to a beginner, typed or spoken. Feedback on both, side by side:
 * accuracy against the notes, main point first, an everyday example and
 * plain words for the beginner, and counted filler words and hedges.
 */
export default function StudyExplain({ notebookId, sectionId, title, onClose }: {
  notebookId: number; sectionId: string; title: string; onClose: () => void;
}) {
  const ownAssistant = useOwnAssistant();
  const [step, setStep] = useState<Step>("expert");
  const [expert, setExpert] = useState("");
  const [beginner, setBeginner] = useState("");
  const [result, setResult] = useState<ExplainTwiceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [relayIssue, setRelayIssue] = useState<string | null>(null);
  const relayAuto = useAssistantAuto(relayIssue);

  async function judge(fallbackCredits = false) {
    setBusy(true); setRelayIssue(null);
    try {
      setResult(await studyApi.explainTwice({ notebook_id: notebookId, section_id: sectionId, expert, beginner, fallback_credits: fallbackCredits }));
      setStep("result");
    } catch (e) {
      const code = toFriendly(e).code;
      if (code === "relay_not_listening" || code === "relay_timeout") setRelayIssue(code); else notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  const writing = step === "expert" ? expert : beginner;
  const setWriting = step === "expert" ? setExpert : setBeginner;
  const enough = writing.trim().split(/\s+/).length >= 5;

  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="glass-card study-review study-explain" role="dialog" aria-modal="true" aria-label={`Explain ${title} twice`}
        onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
        <header className="study-head">
          <strong><MessagesSquare size={16} /> Explain it twice: {title}</strong>
          <button type="button" className="nb-icon-btn" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </header>

        {step !== "result" && (
          <>
            <p className="study-step"><span>{step === "expert" ? 1 : 2}</span>
              {step === "expert" ? "To an expert colleague: precise, using the field's terms" : "To a beginner: plain words and an everyday example"}</p>
            <textarea id={`study-explain-${step}`} className="nb-input" rows={6} maxLength={4000} value={writing} disabled={busy} autoFocus
              placeholder={step === "expert" ? "Start with the main point, then the reasoning…" : "Imagine a friend who has never heard of this…"}
              aria-label={step === "expert" ? "Your explanation to an expert" : "Your explanation to a beginner"}
              onChange={e => setWriting(e.target.value)} />
            <div className="nbk-explain-actions">
              <MicButton disabled={busy} onText={said => setWriting(prev => add(prev, said))} />
              {step === "expert"
                ? <button type="button" className="nbk-pill" disabled={!enough} onClick={() => setStep("beginner")}>Next: to a beginner</button>
                : <>
                    <button type="button" className="btn-neutral" disabled={busy} onClick={() => setStep("expert")}>Back</button>
                    <button type="button" className="nbk-pill" disabled={!enough || busy} onClick={() => void judge(false)}>
                      {busy ? <><Loader2 size={13} className="spin" /> Reading both…</> : <><GraduationCap size={13} /> See how I did</>}
                    </button>
                  </>}
            </div>
            {relayIssue && (
              <div className="mm-actions">
                <p className="muted">{relayIssueLine(relayIssue, relayAuto)}</p>
                <button type="button" className="nbk-pill" onClick={() => void judge(false)}>Try again</button>
                <button type="button" className="btn-neutral" onClick={() => void judge(true)}>Use credits instead</button>
              </div>
            )}
            <p className="muted nbk-explain-cost">{ownAssistant ? `${OWN_ASSISTANT_COST}.` : "Feedback on both uses a few credits. Speaking uses transcription, like a practice answer."}</p>
          </>
        )}

        {step === "result" && result && (
          <>
            <div className="study-sides">
              <Side who="an expert" side={result.expert} />
              <Side who="a beginner" side={result.beginner} />
            </div>
            <div className="nbk-explain-actions">
              <button type="button" className="btn-neutral" onClick={() => { setResult(null); setStep("expert"); }}>Try again</button>
              <button type="button" className="nbk-pill" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
