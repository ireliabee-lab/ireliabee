import toast from "react-hot-toast";
import { AlertTriangle, KeyRound, MicOff, Sparkles, VolumeX, WalletCards, Settings, X } from "lucide-react";
import { fetchApi } from "./api";
import { BUY_URL, RUNS_OUT_MESSAGE, lowCreditNotice } from "./account";
import { showUpgrade } from "./licence";
import { openExternal } from "./openExternal";

export interface FriendlyInfo {
  code?: string;
  title?: string;
  message: string;
  action?: string | null;
  /** Which Pro feature was refused, when `code` is "pro_required". */
  feature?: string;
}

export class AppError extends Error {
  info: FriendlyInfo;
  constructor(info: FriendlyInfo) {
    super(info.title ? `${info.title}. ${info.message}` : info.message);
    this.info = info;
  }
}

function fromDetail(detail: unknown): FriendlyInfo | null {
  if (detail && typeof detail === "object" && "message" in (detail as any)) return detail as FriendlyInfo;
  if (typeof detail === "string" && detail.trim()) return { message: detail };
  return null;
}

export function toFriendly(err: unknown): FriendlyInfo {
  if (err instanceof AppError) return err.info;
  if (err && typeof err === "object") {
    const e = err as any;
    if (e.title || e.code) return { code: e.code, title: e.title, message: e.message ?? "", action: e.action };
    const detail = fromDetail(e.detail);
    if (detail) return detail;
    if (typeof e.message === "string") {
      if (/failed to fetch|networkerror|load failed/i.test(e.message)) {
        return { code: "backend_offline", title: "iReliabee engine isn't responding", message: "Restart the app and try again." };
      }
      return { message: e.message };
    }
  }
  return { message: "Something went wrong. Please try again." };
}

export async function errorFromResponse(res: Response): Promise<AppError> {
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body);
    // FastAPI's bare "Not Found" means the route itself doesn't exist: the engine
    // running is older than this screen (a missing item has its own message).
    if (res.status === 404 && parsed?.detail === "Not Found") {
      return new AppError({
        code: "backend_outdated", title: "The iReliabee engine is out of date",
        message: "This feature is newer than the engine that's running. Restart iReliabee and try again.",
      });
    }
    // 402 is a closed Pro gate (backend/entitlements.py), not a failure: show
    // the upgrade route rather than an error the user can do nothing about.
    if (res.status === 402 && parsed?.detail?.error === "pro_required") {
      return new AppError({
        code: "pro_required", title: "iReliabee Pro",
        message: parsed.detail.message, action: "upgrade",
        feature: parsed.detail.feature,
      });
    }
    const info = fromDetail(parsed?.detail) ?? fromDetail(parsed);
    if (info) return new AppError(info);
  } catch { /* not JSON */ }
  return new AppError({ message: body || `Request failed (${res.status})` });
}

export function openSettings() {
  window.dispatchEvent(new CustomEvent("open-settings"));
}

const ICONS: Record<string, JSX.Element> = {
  missing_key: <KeyRound size={16} />,
  invalid_key: <KeyRound size={16} />,
  no_model: <Settings size={16} />,
  out_of_credits: <WalletCards size={16} />,
  credits_running_out: <WalletCards size={16} />,
  pro_required: <Sparkles size={16} />,
  relay_not_listening: <AlertTriangle size={16} />,
  relay_timeout: <AlertTriangle size={16} />,
  // The sentence for these comes from the backend, like every other code
  // (backend/errors.py). All the frontend adds is the icon — and a code of
  // their own each, so a microphone problem and a call-audio problem in the
  // same session are two toasts rather than one replacing the other.
  mic_lost: <MicOff size={16} />,
  mic_silent: <MicOff size={16} />,
  system_lost: <VolumeX size={16} />,
  audio_unsupported: <VolumeX size={16} />,
};

export function notifyError(err: unknown, onRetryCredits?: () => void) {
  const info = toFriendly(err);
  const id = `err-${info.code ?? info.message}`;
  toast.custom(t => (
    <div className={`error-toast ${t.visible ? "in" : "out"}`} role="alert">
      <span className="error-toast-icon">{ICONS[info.code ?? ""] ?? <AlertTriangle size={16} />}</span>
      <div className="error-toast-body">
        {info.title && <strong>{info.title}</strong>}
        <span>{info.message}</span>
        {info.action === "settings" && (
          <button onClick={() => { toast.dismiss(t.id); openSettings(); }}>
            <Settings size={12} /> Open Settings
          </button>
        )}
        {info.action === "buy" && (
          <button onClick={() => { toast.dismiss(t.id); openExternal(BUY_URL); }}>
            <WalletCards size={12} /> Buy credits
          </button>
        )}
        {info.action === "upgrade" && (
          <button onClick={() => { toast.dismiss(t.id); showUpgrade(info.feature); }}>
            <Sparkles size={12} /> See what Pro adds
          </button>
        )}
        {info.action === "credits_fallback" && (
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {onRetryCredits && (
              <button onClick={() => { toast.dismiss(t.id); onRetryCredits(); }}>
                <Sparkles size={12} /> Use credits instead
              </button>
            )}
            <button
              style={{ background: "rgba(var(--ink-rgb), 0.12)", color: "var(--text)" }}
              onClick={() => { toast.dismiss(t.id); openSettings(); }}
            >
              <Settings size={12} /> Check assistant in Settings
            </button>
          </div>
        )}
      </div>
      <button className="error-toast-close" onClick={() => toast.dismiss(t.id)} aria-label="Dismiss"><X size={14} /></button>
    </div>
  ), { id, duration: info.action ? 9000 : 6000 });
}

/**
 * "Your credit runs out in about 2 minutes", with a Buy credits button: the
 * same toast as every other notice, once per stretch (account.ts runsOutCheck
 * decides when).
 */
export function notifyCreditRunningOut() {
  notifyError(new AppError({
    code: "credits_running_out", title: "Credit running out", message: RUNS_OUT_MESSAGE, action: "buy",
  }));
}

type Requirement = "llm" | "stt" | "voice";

// Checks keys/models before starting something, and explains what's missing.
export async function ensureReady(needs: Requirement[]): Promise<boolean> {
  try {
    const res = await fetchApi("/config/readiness");
    if (!res.ok) return true;
    const status = await res.json();
    for (const need of needs) {
      if (status?.[need]) {
        notifyError(new AppError(status[need]));
        return false;
      }
    }
    // Only before a call. A warning on every debrief and every note would be
    // noise — and a heads-up, not a gate: the service refuses what it must, and
    // a cached balance must never be what stops a call from starting.
    if (needs.includes("stt") || needs.includes("voice")) {
      const notice = lowCreditNotice(status?.credits);
      if (notice) toast(notice, { id: "low-credits", icon: "🪙", duration: 7000 });
    }
    return true;
  } catch (e) {
    notifyError(e);
    return false;
  }
}
