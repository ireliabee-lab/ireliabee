import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import Logo from "./Logo";
import { restartApp } from "../lib/restart";

const STEPS = [
  { after: 0, text: "Starting the engine…" },
  { after: 4000, text: "Getting your coach ready…" },
  { after: 10000, text: "First launch takes a little longer — nearly there." },
];

/**
 * Shown while the engine (backend sidecar) starts: the mark animates in over
 * the theme's stipple pattern, with plain-language progress. The same screen
 * explains what to do if the engine doesn't start.
 */
interface Props {
  failed: boolean;
  /** What went wrong, in the backend's own words where it had any. */
  reason?: string;
  /** The file that has the details — named, rather than guessed at. */
  logPath?: string;
}

/**
 * Whether something outside the app is a likely culprit.
 *
 * Only said when the engine never ran or was stopped on its way up, which is
 * what an antivirus actually does to it. Appended to every failure — as it
 * was — it contradicts the sentence in front of it and sends people hunting
 * through security software for a problem the app has already named.
 */
function blamesSomethingOutside(reason?: string): boolean {
  if (!reason) return true;
  return /could not be started|missing from this install|stopped while starting|was stopped/i.test(reason);
}

export default function Splash({ failed, reason, logPath }: Props) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (failed) return;
    const timers = STEPS.slice(1).map((s, i) => window.setTimeout(() => setStep(i + 1), s.after));
    return () => timers.forEach(clearTimeout);
  }, [failed]);

  return (
    <div className="splash" data-tauri-drag-region>
      <div className="splash-center" data-tauri-drag-region>
        <Logo size={104} animated title="iReliabee" />
        <h1 className="splash-word">iReliabee</h1>
        <p className="splash-tag">Your calm coach for every conversation</p>

        {failed ? (
          <div className="splash-failed" role="alert">
            <strong>The iReliabee engine didn't start</strong>
            {/* Never a guessed cause. iReliabee takes whatever port the computer
                gives it, so "another program is using port 8000" was both wrong
                and the first thing people went looking for — and an antivirus
                line on the end of every message is the same mistake wearing a
                different coat. */}
            <span>
              {reason ? `${reason[0].toUpperCase()}${reason.slice(1)}.` : "It stopped before it could start."}
              {blamesSomethingOutside(reason) && " Your antivirus may have blocked it."}
              {" "}Details are in <code>{logPath ?? "~/.config/ireliabee/backend.log"}</code>.
            </span>
            {/* Starting the engine happens once, when the app starts. Reloading
                the page re-reads the same failure and redraws this screen for
                ever; only a restart gets another attempt. */}
            <button className="btn-primary" onClick={() => void restartApp()}>
              <RefreshCw size={14} /> Try again
            </button>
          </div>
        ) : (
          <div className="splash-status" aria-live="polite">
            <div className="splash-progress" aria-hidden="true">{Array.from({ length: 5 }, (_, i) => <i key={i} />)}</div>
            <span>{STEPS[step].text}</span>
          </div>
        )}
      </div>
      <div className="splash-foot">v{__APP_VERSION__}</div>
    </div>
  );
}
