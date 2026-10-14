import React from "react";
import ReactDOM from "react-dom/client";
import toast, { Toaster } from "react-hot-toast";
import App from "./App";
import Splash from "./components/Splash";
import ErrorBoundary from "./components/ErrorBoundary";
import ReminderWindow, { parseReminder } from "./components/ReminderWindow";
import { backendLogPath, installApiRouting, resolveBackendBase, waitForBackend } from "./lib/backend";
import { fetchApi } from "./lib/api";
import { applyTextSize, installTextSizeShortcuts } from "./lib/textSize";
import { applyPageWidth } from "./lib/pageWidth";
import { applyLook } from "./lib/theme";
import { installAutoGrow } from "./lib/autoGrow";
import { installContextMenuGuard } from "./lib/contextMenu";
import "./index.css";
import "./notebook.css";
import "./board.css";
import "./meetings.css";

installApiRouting();
applyTextSize();
applyPageWidth();
applyLook();
installTextSizeShortcuts();
installAutoGrow();
installContextMenuGuard();

const root = ReactDOM.createRoot(document.getElementById("root")!);

// The meeting-reminder window (src-tauri: show_reminder) shows one card and
// needs nothing from the backend.
const reminderRaw = new URLSearchParams(window.location.search).get("reminder");
const reminder = parseReminder(reminderRaw);
if (reminder) {
  document.documentElement.classList.add("reminder-root");
  root.render(<ReminderWindow data={reminder} raw={encodeURIComponent(reminderRaw!)} />);
} else {
  root.render(<Splash failed={false} />);

  // Let the splash finish its entrance even when the engine is already up.
  const MIN_SPLASH_MS = 1100;
  const shown = Date.now();
  // Where the backend is has to be settled before anything asks for it: it
  // takes a port from the operating system rather than insisting on 8000, so
  // there is no address to assume (lib/backend.ts, src-tauri/src/lib.rs).
  (async () => {
    const found = await resolveBackendBase();
    const ready = found.ok ? await waitForBackend() : found;
    await new Promise(r => setTimeout(r, Math.max(0, MIN_SPLASH_MS - (Date.now() - shown))));
    if (!ready.ok) {
      root.render(<Splash failed reason={ready.reason} logPath={await backendLogPath()} />);
      return;
    }
    root.render(
      <React.StrictMode>
        <ErrorBoundary level="app">
          <App />
        </ErrorBoundary>
        <Toaster
          position="bottom-right"
          toastOptions={{
            className: "app-toast",
            // Inline so they win over the library's built-in white style; all theme variables.
            style: {
              background: "rgba(var(--raised-rgb), 0.98)",
              color: "var(--text)",
              border: "1px solid var(--border-light)",
              boxShadow: "var(--toast-shadow)",
              borderRadius: 12,
              padding: "10px 14px",
              fontFamily: "var(--font)",
              fontSize: 13,
              maxWidth: 380,
            },
            success: { iconTheme: { primary: "var(--success)", secondary: "var(--raised)" } },
            error: { iconTheme: { primary: "var(--danger)", secondary: "var(--raised)" } },
            loading: { iconTheme: { primary: "var(--primary)", secondary: "rgba(var(--ink-rgb), 0.15)" } },
          }}
        />
      </React.StrictMode>
    );
    // If the sessions database was unreadable, the backend moved it aside and
    // started afresh rather than failing to start (audit 181-H10): say so, or
    // an empty history would look like data loss with no explanation.
    fetchApi("/status", { cache: "no-store" }).then(r => (r.ok ? r.json() : null)).then(s => {
      if (s?.recovered_db) {
        toast.error(
          `Your session history couldn't be read, so iReliabee started a fresh one. ` +
          `The old file was kept at ${s.recovered_db.moved_to}.`,
          { duration: 20_000 },
        );
      }
    }).catch(() => {});
  })().catch(async (e) => {
    // A blank window says less than any message. Whatever went wrong on the way
    // up, the user gets a screen that explains itself and a button that retries.
    root.render(<Splash failed
                        reason={e instanceof Error && e.message ? e.message : "the app could not start"}
                        logPath={await backendLogPath().catch(() => undefined)} />);
  });
}

