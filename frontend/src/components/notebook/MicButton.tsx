import { Loader2, Mic, Square } from "lucide-react";
import { useDictation } from "../../lib/dictation";

/**
 * Speak instead of typing: click to start, click again to stop. The words go
 * into the answer (added after anything already typed). Study mode, S3.
 */
export default function MicButton({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const { state, error, start, stop } = useDictation(onText);
  const live = state === "recording" || state === "connecting";
  return (
    <span className="study-mic">
      <button type="button" className={`nbk-pill study-mic-btn ${state === "recording" ? "on" : ""}`} disabled={disabled || state === "transcribing"}
        aria-pressed={live} onClick={() => (live ? stop() : void start())}
        title={live ? "Stop and write down what you said" : "Speak your answer"}>
        {state === "transcribing" ? <><Loader2 size={13} className="spin" /> Writing it down…</>
          : live ? <><Square size={12} /> {state === "connecting" ? "Starting…" : "Stop"}</>
            : <><Mic size={13} /> Speak</>}
      </button>
      {error && <span className="muted study-mic-err" role="alert">{error}</span>}
    </span>
  );
}
