import { Component, type ErrorInfo, type ReactNode } from "react";
import toast from "react-hot-toast";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { isTauri } from "../lib/api";

/**
 * What the user sees when a screen throws while rendering (audit 181-H12).
 *
 * Without a boundary one render error unmounts the whole tree, and this
 * window is transparent and undecorated: what was left was an invisible
 * window with no title bar to close it by. That already happened once, with
 * the session wizard.
 *
 * - `level="view"` wraps one screen inside the app. The title bar and sidebar
 *   stay, so the user can go elsewhere; "Try again" re-renders the screen.
 *   `resetKey` clears the error when the user navigates away.
 * - `level="dialog"` wraps a dialog: it closes (via `onReset`) and says so,
 *   rather than leaving an error panel stranded outside the main area.
 * - `level="app"` wraps everything: a solid, draggable page of its own with
 *   Reload and Close, since nothing else is left on screen.
 */
type Props = {
  level: "app" | "view" | "dialog";
  resetKey?: unknown;
  /** Called by "Try again" before re-rendering, e.g. to close a dialog. */
  onReset?: () => void;
  children: ReactNode;
};

type State = { error: Error | null };

/**
 * The exception text, for whoever wants it.
 *
 * It used to sit in the open under the apology, so the first thing a user read
 * after "Nothing you saved is lost" was `Cannot read properties of undefined
 * (reading 'map')` — which tells them nothing and reads like the app arguing.
 * It still has to be reachable: it is the one line that makes a support
 * message useful.
 */
function Details({ error }: { error: Error }) {
  return (
    <details className="error-details">
      <summary>Show details</summary>
      <code>{error.message}</code>
    </details>
  );
}

async function closeWindow() {
  if (!isTauri()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.level}] render error:`, error, info.componentStack);
    if (this.props.level === "dialog") {
      toast.error("That window ran into a problem and was closed. Please try again.");
      this.props.onReset?.();
    }
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private retry = () => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.level === "dialog") return null;

    if (this.props.level === "view") {
      return (
        <div className="page-content" role="alert">
          <div className="glass-card error-boundary">
            <AlertTriangle size={22} />
            <strong>This screen ran into a problem</strong>
            <span>
              Nothing you saved is lost. Try again, or open another screen from the sidebar.
            </span>
            <Details error={error} />
            <button className="btn-primary" onClick={this.retry}><RefreshCw size={14} /> Try again</button>
          </div>
        </div>
      );
    }

    return (
      <div className="splash" data-tauri-drag-region role="alert">
        <div className="splash-center" data-tauri-drag-region>
          <div className="splash-failed">
            <strong>iReliabee ran into a problem</strong>
            <span>
              Nothing you saved is lost. Reload to carry on; if it happens again, the details are in
              the app's log.
            </span>
            <Details error={error} />
            <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
              <button className="btn-primary" onClick={() => location.reload()}><RefreshCw size={14} /> Reload</button>
              {isTauri() && (
                <button className="btn-neutral" onClick={() => { closeWindow().catch(() => {}); }}><X size={14} /> Close</button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
}
