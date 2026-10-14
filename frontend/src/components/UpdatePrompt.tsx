import { useEffect, useRef, useState } from "react";
import { Download, X, Loader2, RotateCw, Sparkles } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";
import { describeUpdateFailure, type UpdateFailure } from "../lib/updateError";
import { flushBeforeExit } from "../lib/restart";
import { AUTO_UPDATE } from "../lib/edition";

const CHECK_DELAY_MS = 8000;
const RECHECK_MS = 4 * 60 * 60 * 1000;   // long sessions still hear about new releases
const SKIP_KEY = "updateSkippedVersion";
const NOTES_KEY = "updateInstalledNotes";
// The last failure, kept because nothing else keeps a record: there is no log
// plugin on the Rust side and no client-log endpoint on the backend.
const ERROR_KEY = "updateLastError";

function store(key: string, value: string | null) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* ignore */ }
}
function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// Checks for a newer release once after launch (installed app only) and offers
// to download, install and restart. Failures stay silent: offline is normal.
export default function UpdatePrompt() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<"idle" | "downloading" | "ready" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [whatsNew, setWhatsNew] = useState<{ version: string; notes: string } | null>(null);
  const [failure, setFailure] = useState<UpdateFailure | null>(null);
  // Downloaded already, so "Try again" after a failed *install* does not fetch
  // the whole thing a second time.
  const downloaded = useRef(false);

  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__ || import.meta.env.DEV || !AUTO_UPDATE) return;
    // After an update restarts the app, show what changed once.
    const saved = read(NOTES_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.version === __APP_VERSION__ && parsed.notes) setWhatsNew(parsed);
      } catch { /* ignore */ }
      store(NOTES_KEY, null);
    }
    const run = async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const found = await check();
        if (found && found.version !== read(SKIP_KEY)) setUpdate(found);
      } catch (e) {
        // Offline, or no release yet: normal, so the screen stays quiet. The
        // reason still goes somewhere a developer can read it.
        console.warn("[updater] check failed:", e);
      }
    };
    const timer = setTimeout(run, CHECK_DELAY_MS);
    const interval = setInterval(run, RECHECK_MS);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, []);

  if (!update) {
    if (!whatsNew) return null;
    return (
      <div className="update-prompt" role="status">
        <span className="update-prompt-icon"><Sparkles size={16} /></span>
        <div className="update-prompt-text">
          <strong>Updated to {whatsNew.version}</strong>
          <pre className="update-notes">{whatsNew.notes}</pre>
        </div>
        <button className="titlebar-btn" onClick={() => setWhatsNew(null)} title="Close"><X size={14} /></button>
      </div>
    );
  }

  async function install() {
    if (!update) return;
    setPhase("downloading");
    setShowNotes(false);          // the toggle is shared with the failure details
    // Saved first: on Windows the installer closes the app before this call returns.
    store(NOTES_KEY, JSON.stringify({ version: update.version, notes: update.body ?? "" }));
    let total = 0;
    let got = 0;
    try {
      // Download and install are taken apart deliberately. On Windows install()
      // never returns — the plugin hands the installer to the shell and calls
      // std::process::exit(0) — so unsaved notebook and wall edits have to leave
      // before it, not after. Up to 1.2 s of typing, or 30 s while saves are
      // being retried, used to go with it.
      if (!downloaded.current) {
        await update.download(event => {
          if (event.event === "Started") total = event.data.contentLength ?? 0;
          if (event.event === "Progress") {
            got += event.data.chunkLength;
            if (total) setProgress(Math.min(100, Math.round((got / total) * 100)));
          }
        });
        downloaded.current = true;
      }
      setPhase("ready");
      await flushBeforeExit();
      await update.install();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      store(NOTES_KEY, null);
      const failed = describeUpdateFailure(e);
      console.error("[updater] update failed:", e);
      store(ERROR_KEY, JSON.stringify({
        version: update.version, at: new Date().toISOString(), detail: failed.detail,
      }));
      setFailure(failed);
      setPhase("error");
    }
  }

  function later() {
    store(SKIP_KEY, update!.version);
    setUpdate(null);
  }

  return (
    <div className="update-prompt" role="status">
      <span className="update-prompt-icon">
        {phase === "downloading" ? <Loader2 size={16} className="spin" /> : phase === "ready" ? <RotateCw size={16} /> : <Download size={16} />}
      </span>
      <div className="update-prompt-text">
        <strong>
          {phase === "downloading" ? `Downloading update… ${progress ? `${progress}%` : ""}`
            : phase === "ready" ? "Restarting to finish the update…"
            : phase === "error" ? "The update couldn't be installed"
            : `iReliabee ${update.version} is available`}
        </strong>
        {phase === "idle" && <span>Install now — the app restarts in a few seconds.</span>}
        {phase === "idle" && update.body && (
          <>
            <button className="update-notes-toggle" onClick={() => setShowNotes(v => !v)}>
              {showNotes ? "Hide what's new" : "What's new"}
            </button>
            {showNotes && <pre className="update-notes">{update.body}</pre>}
          </>
        )}
        {phase === "error" && (
          <>
            <span>{failure?.message ?? "Check your connection and try again."}</span>
            {failure?.detail && (
              <>
                <button className="update-notes-toggle" onClick={() => setShowNotes(v => !v)}>
                  {showNotes ? "Hide details" : "Details"}
                </button>
                {showNotes && <pre className="update-notes">{failure.detail}</pre>}
              </>
            )}
          </>
        )}
        {phase === "downloading" && <i className="update-prompt-bar" style={{ width: `${progress}%` }} />}
      </div>
      {(phase === "idle" || phase === "error") && (
        <>
          <button className="btn-primary" onClick={install}>{phase === "error" ? "Try again" : "Update"}</button>
          <button className="titlebar-btn" onClick={later} title="Skip this version"><X size={14} /></button>
        </>
      )}
    </div>
  );
}
