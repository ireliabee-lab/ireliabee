import { useCallback, useEffect, useRef, useState } from "react";
import { EXTRA_TEMPLATES } from "./lib/scenarios";
import toast from "react-hot-toast";
import Titlebar, { type BgMode } from "./components/Titlebar";
import ErrorBoundary from "./components/ErrorBoundary";
import Sidebar, { type View } from "./components/Sidebar";
import SessionView from "./components/SessionView";
import SessionStart from "./components/SessionStart";
import PlansView from "./components/PlansView";
import ProgressView from "./components/ProgressView";
import UpdatePrompt from "./components/UpdatePrompt";
import UpgradeDialog from "./components/UpgradeDialog";
import Onboarding, { SetupPill, shouldAutoOpen, useOnboarding } from "./components/Onboarding";
import AboutYouView from "./components/AboutYouView";
import LibraryView from "./components/LibraryView";
import NotebookView from "./components/notebook/NotebookView";
import BoardsView from "./components/board/BoardsView";
import SettingsHub from "./components/SettingsHub";
import CallSessionsView from "./components/CallSessionsView";
import PracticeView from "./components/PracticeView";
import ResearchView from "./components/ResearchView";
import WriteView from "./components/WriteView";
import WordcraftView from "./components/WordcraftView";
import ResizeHandles from "./components/ResizeHandles";
import CreateSessionWizard, { type SessionDraft } from "./components/CreateSessionWizard";
import { draftFromSession } from "./lib/sessionSetup";
import { leavingStopsASession, pauseCurrentSession } from "./lib/sessionGuard";
import LeaveSessionDialog from "./components/LeaveSessionDialog";
import { fetchApi } from "./lib/api";
import { LANGUAGE_OPTIONS } from "./lib/languages";
import { sessionForMeeting, type MeetingStart, type SessionPrefill } from "./lib/calendar";
import { openExternal } from "./lib/openExternal";
import { ACCOUNT_REFRESH_MS, accountNow, loadAccount } from "./lib/account";
import MeetingReminders from "./components/MeetingReminders";
import { defaultTemplate, syncPersona } from "./lib/persona";
import { loadLicence } from "./lib/licence";
import { resolveView } from "./lib/views";
import { track } from "./lib/usage";
import { isTypingTarget } from "./lib/liveKeys";
import { rememberAutoSides, storedAutoSides } from "./lib/autoAnswer";

const TEMPLATES = [
  { id: "general",            label: "General" },
  { id: "tech-interview",     label: "Tech Interview" },
  { id: "academic-phd",       label: "Academic / PhD" },
  { id: "product-management", label: "Product Management" },
  { id: "sales-discovery",    label: "Sales Discovery" },
  { id: "medical-residency",  label: "Medical Residency" },
  ...EXTRA_TEMPLATES,
];
const FALLBACK_MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5",  label: "Claude Haiku 4.5" },
  { id: "gpt-5-mini",        label: "GPT-5 mini" },
  { id: "deepseek-chat",     label: "DeepSeek V4 chat" },
  { id: "gemini-2.5-flash",  label: "Gemini 2.5 Flash" },
];

const BASE_DRAFT: SessionDraft = {
  title: "",
  subtitle: "",
  tags: [],
  cvId: null,
  documentIds: [],
  peopleIds: [],
  template: "general",
  model: "claude-haiku-4-5",
  language: "en",
  displayLanguage: "",
  aiInstructions: "",
  responseTone: "advanced",
  autoAnswer: false,
};

export default function App() {
  const [view, setView]         = useState<View>("session");
  // Leaving a session that is listening asks first (lib/sessionGuard.ts):
  // `leaving` is where to go once the person has chosen.
  const viewRef = useRef(view);
  viewRef.current = view;
  const [leaving, setLeaving] = useState<null | (() => void)>(null);
  const guarded = useCallback((go: () => void) => {
    if (viewRef.current === "session" && leavingStopsASession()) setLeaving(() => go);
    else go();
  }, []);
  const [compact, setCompact]   = useState(false);
  const { status: setup, refresh: refreshSetup } = useOnboarding();
  const [setupOpen, setSetupOpen] = useState(false);
  // Which Pro feature the upgrade dialog should lead with; null = closed.
  const [upgrade, setUpgrade] = useState<string | null>(null);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!autoOpened.current && setup) {
      autoOpened.current = true;
      if (shouldAutoOpen(setup)) setSetupOpen(true);
    }
  }, [setup]);
  useEffect(() => { refreshSetup(); loadLicence(); }, [view, refreshSetup]);
  useEffect(() => {
    const h = (e: Event) => setCompact(Boolean((e as CustomEvent).detail));
    window.addEventListener("compact-mode", h);
    return () => window.removeEventListener("compact-mode", h);
  }, []);
  const [sidebar, setSidebar]   = useState(true);
  const [bgMode, setBgMode]     = useState<BgMode>(() => {
    const saved = localStorage.getItem("bgMode");
    if (saved === "glass" || saved === "blurred" || saved === "solid") return saved;
    const legacy = localStorage.getItem("solidMode");
    if (legacy === "1" || legacy === "true") return "solid";
    return "glass";
  });
  const [backendOk, setBackend] = useState<boolean | null>(null);

  // All navigation resolves through lib/views.ts, so merged screens keep working from old ids.
  // `section` is where inside a screen a merged page now lives (e.g. Sessions → Confidence).
  const [viewSection, setViewSection] = useState<string | undefined>();
  const navigateTo = useCallback((id: string) => {
    const { view: next, section } = resolveView(id);
    const go = () => {
      track(`view:${next}`);
      if (section) track(`view:${id}.redirected`);
      setView(next);
      setViewSection(section);
    };
    if (next === "session") go(); else guarded(go);
  }, [guarded]);

  useEffect(() => {
    const open = () => navigateTo("settings");
    const navigate = (e: Event) => navigateTo(String((e as CustomEvent).detail));
    const upgradeTo = (e: Event) => setUpgrade(String((e as CustomEvent).detail ?? ""));
    window.addEventListener("open-settings", open);
    window.addEventListener("navigate", navigate);
    window.addEventListener("open-upgrade", upgradeTo);
    return () => {
      window.removeEventListener("open-settings", open);
      window.removeEventListener("navigate", navigate);
      window.removeEventListener("open-upgrade", upgradeTo);
    };
  }, []);

  const changeBgMode = (mode: BgMode) => {
    setBgMode(mode);
    localStorage.setItem("bgMode", mode);
  };

  const [sessionKey, setSessionKey] = useState(0);
  const [showWizard, setShowWizard] = useState(false);
  const [initialSession, setInitialSession] = useState<{
    sessionId: number;
    draft: SessionDraft;
  } | null>(null);
  const [wizardOptions, setWizardOptions] = useState<{
    cvs: { id: number; label: string }[];
    documents: { id: number; label: string }[];
  }>({ cvs: [], documents: [] });
  // Session defaults reactively inherit the app-wide Settings choice
  const [defaultDraft, setDefaultDraft] = useState<SessionDraft>(() => ({ ...BASE_DRAFT, template: defaultTemplate() }));
  // The persona decides the coach a new session starts on; follow it when it's
  // chosen in onboarding or Settings, or restored from the backend at startup.
  useEffect(() => {
    const follow = () => setDefaultDraft(d => ({ ...d, template: defaultTemplate() }));
    window.addEventListener("persona-changed", follow);
    syncPersona();
    return () => window.removeEventListener("persona-changed", follow);
  }, []);
  const [availableModels, setAvailableModels] = useState(FALLBACK_MODELS);

  const loadDefaults = () => {
    fetchApi("/config")
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (!cfg) return;
        const flat: { id: string; label: string }[] = [];
        for (const p of (cfg.llm_providers || [])) {
          for (const m of (p.models || [])) flat.push({ id: m.id, label: m.label });
        }
        if (flat.length) setAvailableModels(flat);
        if (cfg?.saved?.model) {
          setDefaultDraft(d => ({ ...d, model: cfg.saved.model }));
        }
        if (cfg?.saved?.response_tone) {
          setDefaultDraft(d => ({ ...d, responseTone: cfg.saved.response_tone }));
        }
        if (cfg?.saved?.language) {
          setDefaultDraft(d => ({ ...d, language: cfg.saved.language }));
        }
      })
      .catch(() => {});
  };
  useEffect(() => { loadDefaults(); }, []);
  useEffect(() => {
    const h = () => loadDefaults();
    window.addEventListener("settings-saved", h);
    return () => window.removeEventListener("settings-saved", h);
  }, []);

  useEffect(() => {
    const check = () =>
      fetchApi("/status")
        .then(r => r.ok ? setBackend(true) : setBackend(false))
        .catch(() => setBackend(false));
    check();
    const id = setInterval(check, 10_000);
    return () => clearInterval(id);
  }, []);

  // Who this is and what they have left, read again every minute while signed
  // in: an owner switching own keys or the backoffice on or off for them
  // reaches this app without a restart, and the balance stays current.
  useEffect(() => {
    const id = setInterval(() => { if (accountNow().signed_in) loadAccount(true); }, ACCOUNT_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // A meeting from the calendar (roadmap 3.2) opens the wizard filled in, with its plan.
  const [wizardPrefill, setWizardPrefill] = useState<SessionPrefill | null>(null);
  // A new session replaces the one on screen, so it asks first too.
  const openWizard = (prefill?: SessionPrefill | null) => guarded(() => openWizardNow(prefill));
  const openWizardNow = (prefill?: SessionPrefill | null) => {
    // Only a real prefill counts. Passing this straight to onClick hands it a
    // MouseEvent, which is truthy and has no title — and an undefined title
    // took the whole wizard down with it.
    const valid = prefill && typeof prefill.title === "string" ? prefill : null;
    setWizardPrefill(valid);
    Promise.all([
      fetchApi("/cvs/").then(r => r.ok ? r.json() : []),
      fetchApi("/documents/").then(r => r.ok ? r.json() : []),
    ]).then(([cvs, docs]) => {
      setWizardOptions({
        cvs: (cvs as any[]).map(c => ({ id: c.id, label: c.name })),
        documents: (docs as any[]).map(d => ({ id: d.id, label: d.name })),
      });
      setShowWizard(true);
    });
  };

  // Listen for "start-new-session" from Sidebar + CallSessionsView
  useEffect(() => {
    const handler = (e: Event) => openWizard((e as CustomEvent).detail?.title ? (e as CustomEvent).detail : null);
    window.addEventListener("start-new-session", handler);
    return () => window.removeEventListener("start-new-session", handler);
  }, []);

  // Global keyboard shortcuts (app-level)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isEditable = () => isTypingTarget(document.activeElement) || isTypingTarget(e.target) || e.isComposing;
      // Ctrl/Cmd+B → toggle sidebar (works anywhere, including in inputs)
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebar(s => !s);
        return;
      }
      if (isEditable()) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        openWizard();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Listen for "open-session" from CallSessionsView (Start / Resume / View Transcript)
  useEffect(() => {
    const handler = async (e: Event) => {
      const { sessionId, messages } = (e as CustomEvent).detail as {
        sessionId: number;
        messages: { role: string; content: string }[];
      };
      // The session as it was set up: its coach, language, plan, files,
      // people and instructions. Opened with the defaults instead, a PhD
      // interview came back as a work meeting with no plan.
      const saved = await fetchApi(`/sessions/${sessionId}`).then(r => r.ok ? r.json() : null).catch(() => null);
      const draft = draftFromSession(saved, { ...defaultDraft, autoAnswer: storedAutoSides().them, autoAnswerYou: storedAutoSides().you });
      if (saved?.setup?.plan_id) localStorage.setItem("activePlanId", String(saved.setup.plan_id));
      // Switch to Session view first; SessionView will pick up the ID + messages via a fresh mount
      setInitialSession({ sessionId, draft });
      setSessionKey(k => k + 1);
      setView("session");
      // Then fire resume-session so SessionView rebuilds turns from messages
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("resume-session", { detail: { sessionId, messages } }));
      }, 50);
    };
    window.addEventListener("open-session", handler);
    return () => window.removeEventListener("open-session", handler);
  }, [defaultDraft]);

  const submitWizard = async (draft: SessionDraft, prefill: SessionPrefill | null = wizardPrefill, listen = false) => {
    try {
      const res = await fetchApi("/sessions/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          subtitle: draft.subtitle || undefined,
          tags: draft.tags,
          template: draft.template,
          llm_provider: "",
          llm_model: draft.model,
          language: draft.language,
          display_language: draft.displayLanguage || undefined,
          // Kept with the session, so Start on the Sessions page opens it as
          // it was made (backend/routers/sessions.py, SessionSetup).
          setup: {
            plan_id: prefill?.planId ?? null,
            event_id: prefill?.eventId ?? null,
            cv_id: draft.cvId,
            document_ids: draft.documentIds,
            people_ids: draft.peopleIds ?? [],
            ai_instructions: draft.aiInstructions,
            response_tone: draft.responseTone,
            auto_answer: draft.autoAnswer,
            auto_answer_you: draft.autoAnswerYou ?? draft.autoAnswer,
          },
        }),
      });
      if (!res.ok) throw new Error();
      const created = await res.json();
      rememberAutoSides({ them: draft.autoAnswer, you: draft.autoAnswerYou ?? draft.autoAnswer });
      // The session opens with the meeting's plan on screen.
      if (prefill?.planId) localStorage.setItem("activePlanId", String(prefill.planId));
      // Set only once the session exists, so a failed start never leaves the next session listening.
      if (listen) localStorage.setItem("autoListen", "1");
      setWizardPrefill(null);
      setInitialSession({ sessionId: created.id, draft });
      setShowWizard(false);
      setSessionKey(k => k + 1);
      setView("session");
      toast.success(`Session "${draft.title}" ready — start speaking or type below`);
    } catch {
      toast.error("Failed to create session");
    }
  };

  // Calendar "Join & listen" (roadmap 3.2): straight into a session with the
  // default settings, the call opened, and the coach listening to it.
  const joinRef = useRef<(m: MeetingStart) => void>(() => {});
  joinRef.current = async (m: MeetingStart) => {
    if (m.joinUrl) openExternal(m.joinUrl);
    // A session already set up for this meeting is the one to open: made from
    // the meeting, or recently from its plan. Only with none is one made.
    const sessions = await fetchApi("/sessions/").then(r => (r.ok ? r.json() : [])).catch(() => []);
    const mine = sessionForMeeting(sessions, { eventId: m.eventId, planId: m.planId });
    if (mine) {
      if (m.eventId != null && mine.setup?.event_id !== m.eventId) {
        // Linked from now on, so the meeting's notes and action items come back to it.
        await fetchApi(`/sessions/${mine.id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setup: { event_id: m.eventId } }),
        }).catch(() => {});
      }
      const messages = await fetchApi(`/sessions/${mine.id}/messages`).then(r => (r.ok ? r.json() : [])).catch(() => []);
      if (m.listen) localStorage.setItem("autoListen", "1");
      window.dispatchEvent(new CustomEvent("open-session", { detail: { sessionId: mine.id, messages } }));
      return;
    }
    submitWizard({
      ...defaultDraft, title: m.title, subtitle: m.subtitle ?? "", template: m.template ?? defaultDraft.template,
      autoAnswer: storedAutoSides().them, autoAnswerYou: storedAutoSides().you,
    }, m, m.listen);
  };
  useEffect(() => {
    const h = (e: Event) => joinRef.current((e as CustomEvent).detail);
    window.addEventListener("start-meeting", h);
    return () => window.removeEventListener("start-meeting", h);
  }, []);

  return (
    <div className={`app ${bgMode === "solid" ? "solid-mode" : bgMode === "blurred" ? "blurred-mode" : "glass-mode"}${compact ? " compact" : ""}`}>
      <ResizeHandles />
      <UpdatePrompt />
      {upgrade !== null && <UpgradeDialog feature={upgrade} onClose={() => setUpgrade(null)} />}
      <Onboarding status={setup} open={setupOpen} onClose={() => setSetupOpen(false)} onNav={navigateTo} />
      {leaving && (
        <LeaveSessionDialog
          onStay={() => setLeaving(null)}
          onLeave={async (pause) => {
            if (pause) await pauseCurrentSession().catch(() => {});
            const go = leaving;
            setLeaving(null);
            go();
          }}
        />
      )}
      <Titlebar
        sidebarOpen={sidebar}
        bgMode={bgMode}
        solidMode={bgMode === "solid"}
        backendOk={backendOk}
        onToggleSidebar={() => setSidebar(s => !s)}
        onSetBgMode={changeBgMode}
        onToggleSolid={() => changeBgMode(bgMode === "solid" ? "glass" : "solid")}
      />

      <div className="app-body">
        <Sidebar
          open={sidebar && !compact} active={view} onNav={navigateTo} onNewSession={() => openWizard()}
          setup={<SetupPill status={setup} onOpen={() => setSetupOpen(true)} />}
        />

        <div className="main-content">
          {/* One broken screen must not take the window with it (181-H12). */}
          <ErrorBoundary level="view" resetKey={`${view}:${viewSection ?? ""}:${sessionKey}`}>
          {/* The live screen needs a session (lib/liveGate.ts): without one it
              shows one step to start one, not controls that half work. */}
          {view === "session" && initialSession && (
            <SessionView
              key={sessionKey}
              initialSessionId={initialSession.sessionId}
              initialDraft={initialSession.draft}
              onGone={() => {
                setInitialSession(null);
                toast("That session was deleted. Start a new one to carry on.", { icon: "🗂️" });
              }}
            />
          )}
          {view === "session" && !initialSession && (
            <SessionStart
              base={{ ...defaultDraft, autoAnswer: storedAutoSides().them, autoAnswerYou: storedAutoSides().you }}
              templates={TEMPLATES}
              languages={LANGUAGE_OPTIONS}
              onStart={() => openWizard()}
              onQuickStart={(draft, prefill) => { track("session.quick_start"); return submitWizard(draft, prefill); }}
            />
          )}
          {view === "history"   && <CallSessionsView key={viewSection ?? "list"} section={viewSection} />}
          {view === "practice"  && <PracticeView key={viewSection ?? "practice"} section={viewSection} />}
          {view === "research"  && <ResearchView key={viewSection ?? "research"} section={viewSection} />}
          {view === "write"     && <WriteView key={viewSection ?? "write"} section={viewSection} />}
          {view === "wordcraft" && <WordcraftView key={viewSection ?? "wordcraft"} section={viewSection} />}
          {view === "progress"  && <ProgressView />}
          {view === "plans"     && <PlansView key={viewSection ?? "plans"} section={viewSection} />}
          {view === "about"     && <AboutYouView key={viewSection ?? "about"} section={viewSection} />}
          {view === "notebook"  && <NotebookView key={viewSection ?? "notebook"} section={viewSection} />}
          {view === "board"     && <BoardsView />}
          {view === "library"   && <LibraryView key={viewSection ?? "library"} section={viewSection} />}
          {view === "settings"  && <SettingsHub key={viewSection ?? "settings"} section={viewSection} />}
          </ErrorBoundary>
        </div>
      </div>

      <MeetingReminders />
      {showWizard && (
        <ErrorBoundary level="dialog" onReset={() => setShowWizard(false)}>
        <CreateSessionWizard
          templates={TEMPLATES}
          models={availableModels}
          languages={LANGUAGE_OPTIONS}
          cvs={wizardOptions.cvs}
          documents={wizardOptions.documents}
          defaults={wizardPrefill ? {
            ...defaultDraft, title: wizardPrefill.title ?? defaultDraft.title,
            subtitle: wizardPrefill.subtitle ?? "",
            template: wizardPrefill.template ?? defaultDraft.template,
          } : defaultDraft}
          planId={wizardPrefill?.planId ?? null}
          onSubmit={submitWizard}
          onCancel={() => setShowWizard(false)}
        />
        </ErrorBoundary>
      )}
    </div>
  );
}
