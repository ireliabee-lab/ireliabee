import { useCallback, useEffect, useState } from "react";
import { Check, LogIn, User, FileText, GraduationCap, X, ArrowRight, Sparkles, Compass } from "lucide-react";
import toast from "react-hot-toast";
import { fetchApi } from "../lib/api";
import { PERSONAS, personaInfo, setPersona, type PersonaId } from "../lib/persona";
import Logo from "./Logo";

interface Step { id: string; done: boolean; }
interface Status { steps: Step[]; done: number; total: number; }

/**
 * `view` is where the step's button goes: a view, or a place inside one
 * (lib/views.ts), so "plan" is Settings → Your account, not Settings' first
 * tab. `again` is the button a finished step keeps, so setup is never a place
 * you can't get back into: the persona, profile and CV stay on this computer
 * when you sign out, and those steps stay done.
 */
export const STEPS: Record<string, { title: string; body: string; action: string; again: string; view: string; icon: JSX.Element }> = {
  persona: {
    title: "What are you using iReliabee for?",
    body: "It picks the right coach and practice for you. You can change it in Settings.",
    action: "", again: "Change", view: "settings", icon: <Compass size={16} />,
  },
  // Two steps became one when the AI stopped being something the user had to
  // go and buy. There are no keys to paste; there is an account to sign in to.
  account: {
    title: "Sign in to iReliabee",
    body: "Live sessions, debriefs and research come with credits — no API keys to create. Each computer gets one free credit a month.",
    action: "Sign in", again: "Your account", view: "plan", icon: <LogIn size={16} />,
  },
  profile: {
    title: "Tell the coach about you",
    body: "Your name, target role and experience level, so answers sound like you and never oversell.",
    action: "Create profile", again: "Edit", view: "about", icon: <User size={16} />,
  },
  cv: {
    title: "Upload your CV",
    body: "A PDF of your CV lets the coach use your real projects and results.",
    action: "Upload CV", again: "Replace", view: "library", icon: <FileText size={16} />,
  },
  practice: {
    title: "Try a practice round",
    body: "Run a short mock interview to hear how it feels before the real thing.",
    action: "Start practice", again: "Practise again", view: "practice", icon: <GraduationCap size={16} />,
  },
};

/**
 * A step the backend sent that this build has no copy for.
 *
 * Silently skipping it was worse than it sounds: the progress bar counts what
 * the backend sent, so an unrendered *incomplete* step left the checklist
 * reading "5 of 6 done" with every visible row ticked and nothing to click —
 * setup that could never be finished, and no error to explain why.
 *
 * That happens whenever the two halves disagree about the step list, which is
 * exactly what a half-updated dev environment looks like. Showing a plain row
 * that points at Settings keeps the count honest and the path forward open.
 */
function fallbackStep(id: string) {
  return {
    title: `Finish setting up: ${id}`,
    body: "This step comes from a newer or older version of the app than this screen knows about. Settings has it.",
    action: "Open Settings",
    again: "Open Settings",
    view: "settings",
    icon: <Compass size={16} />,
  };
}

const DISMISS_KEY = "onboardingDismissed";

function readDismissed() {
  try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
}

export function useOnboarding() {
  const [status, setStatus] = useState<Status | null>(null);
  const refresh = useCallback(() => {
    fetchApi("/config/onboarding").then(r => r.ok ? r.json() : null).then(setStatus).catch(() => {});
  }, []);
  useEffect(() => {
    refresh();
    // Setup changes happen on other pages; re-check when the user comes back to the window or navigates.
    const id = setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    window.addEventListener("onboarding-refresh", refresh);
    return () => { clearInterval(id); window.removeEventListener("focus", refresh); window.removeEventListener("onboarding-refresh", refresh); };
  }, [refresh]);
  return { status, refresh };
}

export function SetupPill({ status, onOpen }: { status: Status | null; onOpen: () => void }) {
  if (!status || status.done >= status.total) return null;
  const pct = Math.round((status.done / status.total) * 100);
  return (
    <button className="setup-pill" onClick={onOpen} title="Finish setting up iReliabee">
      <Sparkles size={14} />
      <span>Finish setup</span>
      <small>{status.done}/{status.total}</small>
      <i style={{ width: `${pct}%` }} />
    </button>
  );
}

/** One-click persona choice, shown inside the persona step. */
function PersonaChoice() {
  const [saving, setSaving] = useState<PersonaId | null>(null);
  async function choose(id: PersonaId) {
    setSaving(id);
    try { await setPersona(id); } catch { toast.error("Couldn't save that — is the app's engine running?"); }
    finally { setSaving(null); }
  }
  return (
    <div className="persona-choices">
      {PERSONAS.map(p => (
        <button key={p.id} className="persona-choice" onClick={() => choose(p.id)} disabled={saving !== null} title={p.hint}>
          <strong>{p.label}</strong>
          <small>{p.hint}</small>
        </button>
      ))}
    </div>
  );
}

export default function Onboarding({ status, open, onClose, onNav }: {
  status: Status | null; open: boolean; onClose: () => void; onNav: (v: string) => void;
}) {
  // Re-render when the persona changes so the wording below follows it.
  const [, setPersonaTick] = useState(0);
  useEffect(() => {
    const h = () => setPersonaTick(t => t + 1);
    window.addEventListener("persona-changed", h);
    return () => window.removeEventListener("persona-changed", h);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !status) return null;
  const next = status.steps.find(s => !s.done);
  const complete = !next;
  const persona = personaInfo();
  const remaining = status.total - status.done;

  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="onboarding-panel">
        <button className="titlebar-btn onboarding-close" onClick={onClose} title="Close (Esc)"><X size={16} /></button>
        <div className="onboarding-hero">
          <div className="onboarding-logo" aria-hidden="true">
            <Logo size={84} animated />
          </div>
          <h2>{complete ? "You're all set" : "Welcome to iReliabee"}</h2>
          <p>{complete
            ? "Everything is ready. Start a session before your next call, or keep practising."
            : `${remaining === 1 ? "One quick step" : `${remaining} quick steps`} and you're ready for your next ${persona?.nextEvent ?? "interview or call"}.`}</p>
          <div className="onboarding-progress"><i style={{ width: `${(status.done / status.total) * 100}%` }} /></div>
          <small>{status.done} of {status.total} done</small>
        </div>

        <ol className="onboarding-steps">
          {status.steps.map((s, i) => {
            const meta = STEPS[s.id] ?? fallbackStep(s.id);
            const isNext = next?.id === s.id;
            return (
              <li key={s.id} className={`onboarding-step ${s.done ? "done" : ""} ${isNext ? "next" : ""}`}>
                <span className="onboarding-step-icon">{s.done ? <Check size={15} /> : meta.icon}</span>
                <div className="onboarding-step-text">
                  <strong>{i + 1}. {s.id === "persona" && s.done && persona ? `Using iReliabee as: ${persona.label}` : meta.title}</strong>
                  {!s.done && <span>{s.id === "practice" && persona ? persona.practiceStep : meta.body}</span>}
                  {!s.done && s.id === "persona" && <PersonaChoice />}
                </div>
                {!s.done && s.id !== "persona" && (
                  <button className={isNext ? "btn-primary" : "btn-neutral"} onClick={() => { onNav(meta.view); onClose(); }}>
                    {meta.action} <ArrowRight size={13} />
                  </button>
                )}
                {s.done && (
                  <button className="btn-neutral onboarding-again" onClick={() => { onNav(meta.view); onClose(); }}>
                    {meta.again}
                  </button>
                )}
              </li>
            );
          })}
        </ol>

        <div className="onboarding-foot">
          {complete ? (
            // Straight into making one: the live screen needs a session (lib/liveGate.ts).
            <button className="btn-primary" onClick={() => { onClose(); window.dispatchEvent(new Event("start-new-session")); }}>Start a session</button>
          ) : (
            <button className="onboarding-later" onClick={() => { try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ } onClose(); }}>
              I'll do this later
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function shouldAutoOpen(status: Status | null) {
  return !!status && status.done < status.total && !readDismissed();
}
