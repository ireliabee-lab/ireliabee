import { useState, useRef, useEffect, useCallback } from "react";
import { screenContext } from "../lib/screenContext";
import { EXTRA_TEMPLATES, counterpartLabel } from "../lib/scenarios";
import { defaultTemplate } from "../lib/persona";
import { Mic, MicOff, Headphones, Type, ChevronRight, BookOpen, BrainCircuit, X, Zap, Sliders, Monitor, Sparkles, Save, Pause, Square, CornerDownLeft, Minimize2, Camera, Play, GripVertical, ChevronDown, ImagePlus, Loader2, Volume2, AlertTriangle } from "lucide-react";
import toast from "react-hot-toast";
import CoachPanel, { ToneBadge } from "./CoachPanel";
import FollowupCard from "./FollowupCard";
import CompactOverlay from "./CompactOverlay";
import { enterCompactWindow, exitCompactWindow, nextCompact, type CompactKind } from "../lib/compact";
import CameraStrip from "./CameraStrip";
import PlanPanel from "./PlanPanel";
import PreferencesModal from "./PreferencesModal";
import ScreenPicker, { RegionSelector, type Region, type ScreenPick } from "./ScreenPicker";
import GlassSelect from "./GlassSelect";
import { TurnAssembler, PAUSE_TOLERANCES, getPauseTolerance, setPauseTolerance, pauseMsFor, dropSuperseded, type PauseToleranceId, type Segment } from "../lib/turnAssembler";
import { RUNAWAY_MESSAGE, autoOnFor, decide, enqueue, latest, latestOf, pausesAutoAnswer, remember, rememberAutoSides, storedAutoSides, without, type WaitingTurn } from "../lib/autoAnswer";
import { isTypingTarget, liveKeyAction, nothingToAnswer, planRespond, stillAnswering } from "../lib/liveKeys";
import { AiSuggest } from "./Suggested";
import { withSuggestion } from "../lib/suggestApi";
import { fetchApi, apiSocketUrl, localReady } from "../lib/api";
import { notebookApi, rememberedStyle as rememberedNotebookStyle } from "../lib/notebook";
import { abandonSocket } from "../lib/socket";
import { useAccount } from "../lib/account";
import { useStickToBottom } from "../lib/useStickToBottom";
import { DeliveryBar, saveDelivery, useDeliveryTracker } from "../lib/delivery";
import { AppError, ensureReady, errorFromResponse, notifyError, toFriendly, type FriendlyInfo } from "../lib/errors";
import { getRelayStatus, isRelayFailure, relayIssueCopy, relayReady, type AssistantAuto } from "../lib/relay";
import { ANSWER_STALL_MS, brokenAnswer, stallWatchdog, stalledAnswer } from "../lib/coachStream";
import { canGoLive, showUpgrade, useLicence } from "../lib/licence";
import { track } from "../lib/usage";
import { both, openList, pick, type Listening } from "../lib/sources";
import { keepPartialReply } from "../lib/turns";
import { quiet, type Level } from "../lib/levels";
import { MAX_BYTES, isImage, pictureIn, prepare, sizeLabel, type Attached } from "../lib/image";
import LevelMeter from "./LevelMeter";
import SoundPicker from "./SoundPicker";
import EngineMark from "./EngineMark";
import type { Engine } from "../lib/engine";
import { LANGUAGE_OPTIONS, LANGUAGES } from "../lib/languages";
import { translatedTurn } from "../lib/captionTranslation";
import { setupOf } from "../lib/sessionSetup";
import Illustration from "./Illustration";
import SessionHub from "./session/SessionHub";
import LiveTimeLeft from "./session/LiveTimeLeft";
import { registerSessionGuard } from "../lib/sessionGuard";
import { countWhileOpen } from "../lib/reminderSound";
import { serverDate } from "../lib/dates";

interface Turn {
  id: number;
  speaker: "user" | "interviewer";
  transcript: string;
  reply?: string;
  loading?: boolean;
  ts?: number;          // epoch ms
  isQuestion?: boolean; // heuristic for "?" or interviewer speaker
  turnType?: string;    // from backend classifier: "question" | "statement" | "clarification" | etc
  tone?: string;        // language level the backend actually used
  screenshot?: string;  // data URL preview of a screen capture
  screenLabel?: string; // what was captured ("Screen 2", "Edge — Example Domain")
  screenQuestion?: string; // what the user asked about the capture
  assembling?: boolean;    // live speech still coming in; not sent to the coach yet
  partialReply?: string;   // coach reply streaming in for this turn
  superseded?: boolean;    // speaker carried on; `reply` is being replaced
  incomplete?: boolean;    // the stream broke: this is as far as it got, and it is not saved
  waiting?: boolean;       // finished, Auto Answer off: waits for Answer / R
  answeredOnScreen?: boolean; // a screenshot answered this question (lib/screenContext)
  failed?: FriendlyInfo;      // the answer failed: shown on the turn, with Try again
}

type HistoryItem = { role: string; content: string };

/**
 * Errors from the audio socket that mean transcription has stopped for good.
 *
 * `account_suspended` is the relay ending a live call because the account was
 * blocked (close 4403). It used to arrive as `speech_stopped`; left out of this
 * set, the call would keep going on the page — and the transcript's last words
 * could still set off an Auto Answer the service would only refuse.
 */
const SESSION_ENDING = new Set(["out_of_credits", "signed_out", "speech_stopped", "account_suspended"]);

const LAST_SCREEN_KEY = "lastScreenPick";

// Pane layout: transcript width (fraction of the row) and which side the coach sits on.
const SPLIT_KEY = "sessionSplit";
const COACH_SIDE_KEY = "sessionCoachSide";
const MIN_PANE_PX = 240;

function readSplit(): number {
  try {
    const v = Number(localStorage.getItem(SPLIT_KEY));
    return v > 0.1 && v < 0.9 ? v : 0.5;
  } catch { return 0.5; }
}

function readCoachSide(): "left" | "right" {
  try { return localStorage.getItem(COACH_SIDE_KEY) === "left" ? "left" : "right"; } catch { return "right"; }
}

function readLastScreenPick(): ScreenPick | null {
  try {
    const raw = localStorage.getItem(LAST_SCREEN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}


/** Pinned to the bottom of a scroll area the user has scrolled away from. */
function JumpToLatest({ onClick, label = "Jump to latest" }: { onClick: () => void; label?: string }) {
  return (
    <div className="jump-latest">
      <button onClick={onClick} title="Scroll to the newest message and keep following">
        {label} <ChevronDown size={13} />
      </button>
    </div>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function looksLikeQuestion(text: string, speaker: "user" | "interviewer"): boolean {
  if (speaker === "interviewer") return true;
  return /\?\s*$/.test(text.trim());
}

type RecordState = "idle" | "connecting" | "ready" | "recording" | "transcribing";

const TEMPLATES = [
  { id: "general",            label: "General" },
  { id: "tech-interview",     label: "Tech Interview" },
  { id: "academic-phd",       label: "Academic / PhD" },
  { id: "product-management", label: "Product Management" },
  { id: "sales-discovery",    label: "Sales Discovery" },
  { id: "medical-residency",  label: "Medical Residency" },
  ...EXTRA_TEMPLATES,
];

// Fallback if /config is unreachable — matches the CLI's providers.py labels
const FALLBACK_MODELS = [
  { id: "claude-sonnet-4-6",  label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5",   label: "Claude Haiku 4.5" },
  { id: "gpt-5-mini",         label: "GPT-5 mini" },
  { id: "deepseek-chat",      label: "DeepSeek V4 chat" },
  { id: "gemini-2.5-flash",   label: "Gemini 2.5 Flash" },
];


let _id = 0;

/** Live templates that end with a recap instead of a debrief (roadmap 2.1). */
const MEETING_TEMPLATES = new Set(["work-meeting"]);

interface SessionViewProps {
  initialSessionId?: number | null;
  initialDraft?: {
    title: string;
    subtitle: string;
    tags: string[];
    cvId: number | null;
    documentIds: number[];
    peopleIds?: number[];
    template: string;
    model: string;
    language: string;
    displayLanguage?: string;
    aiInstructions: string;
    responseTone?: string;
    autoAnswer: boolean;
    autoAnswerYou?: boolean;
  } | null;
  /** The session no longer exists (deleted from Sessions): the app goes back to the start step. */
  onGone?: () => void;
}

export default function SessionView({ initialSessionId = null, initialDraft = null, onGone }: SessionViewProps = {}) {
  const { admin } = useAccount();
  const [turns, setTurns]           = useState<Turn[]>([]);
  const [text, setText]             = useState("");
  const [plan, setPlan]             = useState<any>(null);
  // Until the session's own plan has loaded, its setup is not saved back:
  // saving the empty plan first would forget the one it was made with.
  const [planReady, setPlanReady]   = useState(() => !localStorage.getItem("activePlanId"));
  // A plan chosen with "Use in session" on the Plans page, or the one a
  // saved session was set up with.
  useEffect(() => {
    const id = localStorage.getItem("activePlanId");
    if (!id) return;
    localStorage.removeItem("activePlanId");
    fetchApi(`/plans/${id}`).then(r => r.ok ? r.json() : null).then(p => {
      if (p) { setPlan(p); setSectionIdx(0); setShowPlan(true); }
    }).catch(() => {}).finally(() => setPlanReady(true));
  }, []);
  const [sectionIdx, setSectionIdx] = useState(0);
  const [showPlan, setShowPlan]     = useState(false);
  const [template, setTemplate]     = useState(initialDraft?.template ?? defaultTemplate());
  const [recapFor, setRecapFor]     = useState<{ id: number; title: string; lecture?: boolean } | null>(null);
  // Lecture companion (roadmap 3.1): record everything, answer only when asked to explain.
  const isLecture = template === "lecture";
  const lectureRef = useRef(isLecture);
  lectureRef.current = isLecture;
  const themLabel = counterpartLabel(template);   // display label for the other party (per scenario)
  const [model, setModel]           = useState(initialDraft?.model ?? "claude-haiku-4-5");
  const [recState, setRecState]     = useState<RecordState>("idle");
  // Source → speaker (natural mapping):
  //   micOn  → mic input  → YOU (interviewee) — your voice into the PC
  //   sysOn  → system out → INTERVIEWER — their voice coming out of your speakers
  const [micOn, setMicOn]           = useState(false);
  const [sysOn, setSysOn]           = useState(false);
  const [micActive, setMicActive]   = useState(false);
  const [sysActive, setSysActive]   = useState(false);
  const licence = useLicence();
  // What the backend actually opened for system audio. A capture on the
  // wrong output device sounds exactly like a capture on nothing, so it is
  // worth a line in the toolbar rather than only a line in the log.
  // `stale` is the one that matters mid-call: the audio moved to a device we
  // cannot record, so what we are still recording has gone quiet.
  const [capturing, setCapturing] = useState<
    { devices: string[]; skipped: string[]; stale: string | null }
  >({ devices: [], skipped: [], stale: null });

  // And which microphone it turned out to be. "Automatic" is a resolution on
  // Windows now, not a shrug at the OS — the backend picks the WASAPI default
  // input rather than letting PortAudio pick a host API — so the panel says
  // which device that came out as. A resolution nobody can see is
  // indistinguishable from the wrong device.
  const [micCapturing, setMicCapturing] = useState<string[]>([]);

  // Which microphone, and which output to listen to. Empty means "let the
  // machine decide" — the system default mic, and every output mixed together
  // so the call is heard wherever it happens to play. That default is why this
  // works with nothing configured; the picker is for when it picks wrong.
  interface AudioDevice { id: string; label: string; default?: boolean }
  const [audioDevices, setAudioDevices] = useState<{ inputs: AudioDevice[]; outputs: AudioDevice[] }>(
    { inputs: [], outputs: [] });
  const [micDevice, setMicDevice] = useState<string>(
    () => { try { return localStorage.getItem("micDevice") ?? ""; } catch { return ""; } });
  const [sysDevice, setSysDevice] = useState<string>(
    () => { try { return localStorage.getItem("sysDevice") ?? ""; } catch { return ""; } });
  const devicesRef = useRef({ mic: micDevice, system: sysDevice });
  useEffect(() => {
    devicesRef.current = { mic: micDevice, system: sysDevice };
    try {
      localStorage.setItem("micDevice", micDevice);
      localStorage.setItem("sysDevice", sysDevice);
    } catch { /* a remembered choice is a convenience, not a requirement */ }
  }, [micDevice, sysDevice]);

  // Asked again whenever a device comes or goes, and when the window comes back
  // into focus, so a headset plugged in after the app opened shows up in the
  // picker. A remembered choice that is no longer connected falls back to automatic.
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const load = () => {
      fetchApi("/audio/devices")
        .then(r => (r.ok ? r.json() : null))
        .then(d => {
          if (!d || !alive) return;
          const inputs: AudioDevice[] = d.inputs ?? [], outputs: AudioDevice[] = d.outputs ?? [];
          setAudioDevices({ inputs, outputs });
          setMicDevice(id => (id && !inputs.some(x => x.id === id) ? "" : id));
          setSysDevice(id => (id && !outputs.some(x => x.id === id) ? "" : id));
        })
        .catch(() => { /* older backend: the pickers simply do not appear */ });
    };
    // Windows reports one change as a burst of events: ask once it settles.
    const soon = () => { window.clearTimeout(timer); timer = window.setTimeout(load, 600); };
    load();
    navigator.mediaDevices?.addEventListener?.("devicechange", soon);
    window.addEventListener("focus", soon);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      navigator.mediaDevices?.removeEventListener?.("devicechange", soon);
      window.removeEventListener("focus", soon);
    };
  }, []);
  const activeSources = [micOn && "mic", sysOn && "system"].filter(Boolean) as ("mic" | "system")[];
  const liveMode = sysOn || micOn;
  const [history, setHistory]         = useState<HistoryItem[]>([]);
  // Latest history for requests; several answers can stream at once, so the
  // state setter appends and this ref is what each new request sends.
  const historyRef = useRef<HistoryItem[]>([]);
  historyRef.current = history;
  const [sessionId, setSessionId]     = useState<number | null>(initialSessionId);
  const [livePartial, setLivePartial]  = useState<string>("");
  const [compact, setCompact] = useState<CompactKind | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedSources = useRef<("mic" | "system")[]>([]);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const [livePartialSpeaker, setLivePartialSpeaker] = useState<"user" | "interviewer">("interviewer");
  // What the user has said out loud since the coach started this answer — their
  // own microphone only. The overlay matches it against the words on screen to
  // show how far along the reading is, so it starts empty with every answer.
  const [said, setSaid] = useState("");
  // Which transcriber the backend picked for this socket, and whether it writes
  // while someone speaks or only after they pause. Told rather than guessed:
  // the app looking broken is what silent degradation costs.
  const [stt, setStt] = useState<{ provider: string; streaming: boolean } | null>(null);
  // The two models doing the work. Both report themselves — the transcriber in
  // its own frames, the coach in the answer it returns — because for an
  // ordinary account the service chooses them on the server, and the name in
  // Settings is only a request.
  const [hearing, setHearing] = useState<Engine | null>(null);
  const [answering, setAnswering] = useState<Engine | null>(null);
  // How loud each side is, straight from the backend's own level stage — so
  // the meter shows what the transcriber is being given, not a second guess.
  const [levels, setLevels] = useState<{ mic: Level; system: Level }>({ mic: quiet, system: quiet });
  // A picture waiting to be sent with whatever is typed beside it.
  const [soundOpen, setSoundOpen] = useState(false);
  const [attached, setAttached] = useState<Attached | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [dropping, setDropping] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const saidFinal = useRef("");
  /** Keep the last of it: a whole session of speech is not worth matching. */
  const keepSaid = (text: string) => {
    const words = text.split(/\s+/);
    return words.length > 160 ? words.slice(-160).join(" ") : text;
  };
  const clearSaid = useCallback(() => { saidFinal.current = ""; setSaid(""); }, []);
  // Auto Answer, set for each side: what they say, and what you say.
  const [autoAnswer, setAutoAnswer]    = useState<boolean>(
    initialDraft?.autoAnswer ?? storedAutoSides().them
  );
  const [autoAnswerYou, setAutoAnswerYou] = useState<boolean>(
    initialDraft?.autoAnswerYou ?? initialDraft?.autoAnswer ?? storedAutoSides().you
  );
  // Finished turns waiting for Answer / R because Auto Answer is off (or
  // paused). A list, so a second question never overwrites the first.
  const [waiting, setWaiting]          = useState<WaitingTurn[]>([]);
  // The turn a screenshot is answering, from the moment it was taken (screenAsk).
  const screenQuestionIdRef = useRef<number | null>(null);
  const waitingRef = useRef<WaitingTurn[]>([]);
  waitingRef.current = waiting;
  // Auto Answer pauses itself — never switches off — when answers come
  // faster than a conversation produces them. See lib/autoAnswer.ts.
  const [autoPaused, setAutoPaused]    = useState(false);
  const autoPausedRef = useRef(false);
  autoPausedRef.current = autoPaused;
  const autoCallsRef = useRef<number[]>([]);
  // Set for the duration of a "Respond now": the user asked, so it sends
  // whatever Auto Answer says.
  const forceSendRef = useRef(false);
  const [language, setLanguage]        = useState<string>(initialDraft?.language ?? "en");
  // A session keeps the language it was held in (roadmap 3.3): pick it up when one is reopened.
  useEffect(() => {
    if (initialSessionId == null) return;
    fetchApi(`/sessions/${initialSessionId}`).then(r => {
      // Deleted while it was the one on screen: its controls would all fail.
      if (r.status === 404) { onGone?.(); return null; }
      return r.ok ? r.json() : null;
    }).then(s => {
      if (s?.language) setLanguage(s.language);
      if (s && "display_language" in s) setDisplayLanguage(s.display_language ?? "");
    }).catch(() => {});
  }, [initialSessionId]);
  const languageRef = useRef(language);
  languageRef.current = language;
  // What the user reads in, when it differs from the call (docs/translation.md, T1).
  const [displayLanguage, setDisplayLanguage] = useState<string>(initialDraft?.displayLanguage ?? "");
  const displayRef = useRef(displayLanguage);
  displayRef.current = displayLanguage;
  // Caption translations as they arrive, by original line (docs/translation.md, T2).
  const [translations, setTranslations] = useState<Record<string, string>>({});
  const [showOriginals, setShowOriginals] = useState(true);
  const [aiInstructions, setAIInstructions] = useState<string>(initialDraft?.aiInstructions ?? "");
  const [responseTone, setResponseTone] = useState<string>(initialDraft?.responseTone ?? "advanced");
  const [showPrefs, setShowPrefs]      = useState<boolean>(false);
  const [cvId, setCvId]                = useState<number | null>(initialDraft?.cvId ?? null);
  const [documentIds, setDocumentIds]  = useState<number[]>(initialDraft?.documentIds ?? []);
  // Researched people on this call (roadmap 2.6): the coach tailors answers to them.
  const [peopleIds, setPeopleIds]      = useState<number[]>(initialDraft?.peopleIds ?? []);

  // The session keeps how it is set up, so Start on the Sessions page opens
  // it the same way (lib/sessionSetup.ts). Changes in Preferences and the
  // plan picker land here; a short wait folds a burst of them into one save.
  useEffect(() => {
    if (sessionId == null || !planReady) return;
    const t = setTimeout(() => {
      fetchApi(`/sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template,
          setup: setupOf({ planId: plan?.id ?? null, cvId, documentIds, peopleIds, aiInstructions, responseTone, autoAnswer, autoAnswerYou }),
        }),
      }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [sessionId, planReady, template, plan?.id, cvId, documentIds, peopleIds, aiInstructions, responseTone, autoAnswer, autoAnswerYou]);
  const [availableCvs, setAvailableCvs] = useState<{ id: number; label: string }[]>([]);
  const [availableDocs, setAvailableDocs] = useState<{ id: number; label: string }[]>([]);
  // Full LLM catalog fetched from /config, kept in sync with Settings
  const [availableModels, setAvailableModels] = useState<{ id: string; label: string }[]>(FALLBACK_MODELS);
  const [notebookRelay, setNotebookRelay] = useState(false);
  const [relayListening, setRelayListening] = useState<boolean | null>(null);
  const [sessionFallback, setSessionFallback] = useState(false);
  // Read when a request is sent, so "Use credits" then Try again goes on credits at once.
  const fallbackRef = useRef(sessionFallback);
  fallbackRef.current = sessionFallback;
  const [relayIssue, setRelayIssue]         = useState(false);
  // "Use my Claude subscription": the app starts Claude Code itself, so relay
  // errors must not tell the user to type anything (lib/relay.ts relayIssueCopy).
  const [relayAuto, setRelayAuto]           = useState<AssistantAuto | null>(null);
  const relayAutoRef = useRef(relayAuto);
  relayAutoRef.current = relayAuto;
  const checkRelay = useCallback(() => {
    getRelayStatus()
      .then(st => { setRelayListening(relayReady(st)); setRelayAuto(st.auto ?? null); })
      .catch(() => setRelayListening(false));
  }, []);

  const enableSessionFallback = useCallback(async () => {
    fallbackRef.current = true;
    setSessionFallback(true);
    setRelayIssue(false);
    if (sessionId) {
      try {
        await fetchApi(`/coach/session/${sessionId}/fallback`, { method: "POST" });
      } catch {}
    }
    toast.success("Using iReliabee's AI for the rest of this call", { id: "relay-fallback" });
  }, [sessionId]);
  const [saved, setSaved]               = useState(false);
  const [savingSession, setSavingSession] = useState(false);
  const [screenBusy, setScreenBusy]     = useState(false);
  const [screenPickerOpen, setScreenPickerOpen] = useState(false);
  const [screenPreview, setScreenPreview] = useState<{ dataUrl: string; blob: Blob; prompt: string } | null>(null);
  // Last capture target — C re-captures it without opening the picker.
  const [lastScreenPick, setLastScreenPick] = useState<ScreenPick | null>(readLastScreenPick);
  const [regionFor, setRegionFor] = useState<{ captureId: string; preview: string; width: number; height: number; label: string } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const screenHotkeyRef = useRef<(chooseNew: boolean) => void>(() => {});
  // Resizable, reorderable transcript / coach panes.
  const splitRef = useRef<HTMLDivElement>(null);
  const [split, setSplit] = useState(readSplit);          // transcript pane width fraction
  const [coachSide, setCoachSide] = useState(readCoachSide);
  const [resizing, setResizing] = useState(false);
  const [paneDrag, setPaneDrag] = useState<{ pane: "transcript" | "coach"; side: "left" | "right" } | null>(null);
  useEffect(() => { try { localStorage.setItem(SPLIT_KEY, String(split)); } catch { /* ignore */ } }, [split]);
  useEffect(() => { try { localStorage.setItem(COACH_SIDE_KEY, coachSide); } catch { /* ignore */ } }, [coachSide]);
  const [contextOpen, setContextOpen]   = useState(false);
  const [contextDraft, setContextDraft] = useState("");
  const [contextUpdates, setContextUpdates] = useState<number>(0);

  const wsRef       = useRef<WebSocket | null>(null);
  const textRef     = useRef<HTMLTextAreaElement>(null);
  const autoAnswerRef = useRef({ them: autoAnswer, you: autoAnswerYou });
  useEffect(() => { autoAnswerRef.current = { them: autoAnswer, you: autoAnswerYou }; }, [autoAnswer, autoAnswerYou]);

  const delivery = useDeliveryTracker(recState !== "idle");
  const transcriptScroll = useStickToBottom<HTMLDivElement>();
  const coachScroll      = useStickToBottom<HTMLDivElement>();

  useEffect(() => {
    rememberAutoSides({ them: autoAnswer, you: autoAnswerYou });
    // Switching it (either way) is a fresh decision: forget a pause and
    // the count that led to it.
    autoCallsRef.current = [];
    setAutoPaused(false);
  }, [autoAnswer, autoAnswerYou]);

  // Fetch model catalog + current Settings default whenever they change.
  // Runs on mount AND on 'settings-saved' broadcasts.
  useEffect(() => {
    const load = async () => {
      try {
        const cfg = await fetchApi("/config").then(r => r.ok ? r.json() : null);
        if (!cfg) return;
        // Flatten every provider's models into one list — same source-of-truth as Settings
        const flat: { id: string; label: string }[] = [];
        for (const p of (cfg.llm_providers || [])) {
          for (const m of (p.models || [])) flat.push({ id: m.id, label: m.label });
        }
        if (flat.length) setAvailableModels(flat);
        if (cfg.saved?.model) setModel(cfg.saved.model);
        if (cfg.saved?.response_tone && !initialDraft?.responseTone) setResponseTone(cfg.saved.response_tone);
        if (cfg.saved?.notebook_relay !== undefined) {
          const nr = Boolean(cfg.saved.notebook_relay);
          setNotebookRelay(nr);
          if (nr) checkRelay();
        }
      } catch {}
    };
    load();
    window.addEventListener("settings-saved", load);
    return () => window.removeEventListener("settings-saved", load);
  }, []);

  // Global keyboard shortcuts for SessionView actions (lib/liveKeys.ts).
  // Never while typing: not in any text box, and not for a moment after the
  // transcript box was typed in, even if a new turn has just moved focus.
  const typedAtRef = useRef(0);
  useEffect(() => {
    // Leaving the box on purpose (a click elsewhere) ends the typing grace.
    const clicked = () => { typedAtRef.current = 0; };
    window.addEventListener("pointerdown", clicked, true);
    return () => window.removeEventListener("pointerdown", clicked, true);
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = liveKeyAction(e, {
        typing: isTypingTarget(document.activeElement) || isTypingTarget(e.target),
        sinceTyped: Date.now() - typedAtRef.current,
        hasWaiting: waitingRef.current.length > 0,
        // The screen picker / region selector own the keyboard while open.
        pickerOpen: Boolean(document.querySelector(".screen-picker-backdrop, .region-select-backdrop")),
      });
      if (!action) return;
      if (action === "blur") {
        typedAtRef.current = 0;
        (document.activeElement as HTMLElement)?.blur();
        return;
      }
      e.preventDefault();
      switch (action) {
        case "save": saveSession(); break;                               // Ctrl/Cmd+S, even in inputs
        case "keep-typing": {                                            // the letter goes where it was meant to
          const box = textRef.current;
          if (box) { box.focus(); setText(t => t + e.key); typedAtRef.current = Date.now(); }
          break;
        }
        // Read through the ref: this handler is not rebuilt when the list changes.
        case "answer-waiting": { const next = latest(waitingRef.current); if (next) answerWaitingRef.current(next); break; }
        case "respond-them": respondRef.current("interviewer"); break;  // R = answer what they said
        case "respond-you": respondRef.current("user"); break;          // Shift+R = answer what you said
        case "toggle-mic": toggleSource("mic"); break;                  // Y = You = mic input
        case "toggle-system": toggleSource("system"); break;            // L = Listener/interviewer = system output
        case "both": listenTo(both({ mic: micOn, system: sysOn })); break;
        case "capture": screenHotkeyRef.current(false); break;          // C = capture again
        case "capture-choose": screenHotkeyRef.current(true); break;    // Shift+C = choose
        case "context": setContextOpen(true); break;
        case "plan": setShowPlan(v => !v); break;
        // T types a question: in the text box, or in the Ask bar of the overlay
        // and the strip under the camera, which have no text box of their own.
        case "type": if (compactRef.current) setCompactChat(v => !v); else textRef.current?.focus(); break;
        case "next-view": nextView(); break;                            // O = next view: full → overlay → camera → full
        case "camera": toggleCompact("camera"); break;                  // E = eye line: strip under the camera
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [micOn, sysOn]);

  // Load available CVs / Documents whenever the Preferences modal opens
  useEffect(() => {
    if (!showPrefs) return;
    fetchApi("/cvs/").then(r => r.json())
      .then(rows => setAvailableCvs((rows as any[]).map(r => ({ id: r.id, label: r.name }))))
      .catch(() => {});
    fetchApi("/documents/").then(r => r.json())
      .then(rows => setAvailableDocs((rows as any[]).map(r => ({ id: r.id, label: r.name }))))
      .catch(() => {});
  }, [showPrefs]);

  // ── Resume session listener ────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId: sid, messages } = (e as CustomEvent).detail as {
        sessionId: number;
        messages: { role: string; content: string; speaker?: string; created_at?: string }[];
      };
      setSessionId(sid);
      // For history (LLM context) we only need role+content
      setHistory(messages.map(m => ({ role: m.role, content: m.content })));
      // Reconstruct turns from messages for display
      // Ids from the same counter as new turns: a counter of its own started at
      // 1 again, so the first new turn shared an id (and a React key) with the
      // first rebuilt one, and updates to one changed both.
      const rebuilt: Turn[] = [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === "user") {
          const nextMsg = messages[i + 1];
          const isInt = /^\[INTERVIEWER\]/.test(msg.content) || msg.speaker === "interviewer";
          const speaker: "user" | "interviewer" = isInt ? "interviewer" : "user";
          const cleanText = msg.content.replace(/^\[USER\]\s*/, "").replace(/^\[INTERVIEWER\]\s*/, "");
          rebuilt.push({
            id: ++_id,
            speaker,
            transcript: cleanText,
            reply: nextMsg?.role === "assistant" ? nextMsg.content : undefined,
            isQuestion: looksLikeQuestion(cleanText, speaker),
            ts: msg.created_at ? serverDate(msg.created_at).getTime() : undefined,
          });
          if (nextMsg?.role === "assistant") i++;
        }
      }
      setTurns(rebuilt);
    };
    window.addEventListener("resume-session", handler);
    return () => window.removeEventListener("resume-session", handler);
  }, []);

  // ── Coach turn (SSE streaming) ────────────────────────────────────────────
  // Add a turn to the transcript feed without hitting the coach LLM.
  const addTurnOnly = useCallback((transcript: string, speaker: "user" | "interviewer"): number => {
    const id = ++_id;
    setTurns(prev => [...prev, {
      id, speaker, transcript,
      ts: Date.now(),
      isQuestion: looksLikeQuestion(transcript, speaker),
    }]);
    return id;
  }, []);

  // One AbortController per turn with a coach request in flight.
  const inflightRef = useRef(new Map<number, AbortController>());

  const cancelTurnRequest = useCallback((id: number) => {
    inflightRef.current.get(id)?.abort();
    inflightRef.current.delete(id);
  }, []);

  /**
   * What each failed turn asked, so Try again, R and G ask exactly that again,
   * on the same card. Cleared when the turn is answered.
   */
  const failedAskRef = useRef(new Map<number, { text: string; speaker: "user" | "interviewer"; replaces?: string; explain?: boolean }>());

  /** Take a turn off the waiting list now, not at the next render, so a second key press can't send it again. */
  const unwait = useCallback((id: number) => {
    if (waitingRef.current.some(w => w.id === id)) waitingRef.current = without(waitingRef.current, id);
    setWaiting(q => (q.some(w => w.id === id) ? without(q, id) : q));
  }, []);

  /**
   * Ask the coach about a transcript. `turnId` reuses an existing transcript
   * turn (live speech assembled in place); `replaces` is an earlier, partial
   * question this one supersedes — its exchange is dropped from the history
   * sent to the model and from the saved session.
   *
   * However it ends, the turn stops loading: answered, or failed with the
   * error on it and Try again (and back on the waiting list, so R and G ask
   * it again). An answer that goes quiet is given up on (ANSWER_STALL_MS), and
   * the connection is always let go of: the webview has only a few for the
   * engine, and with them all held a new answer never reaches it.
   */
  const sendTurn = useCallback(async (
    transcript: string,
    speaker: "user" | "interviewer",
    opts: { turnId?: number; replaces?: string; explain?: boolean } = {},
  ) => {
    const id = opts.turnId ?? ++_id;
    const fields = {
      speaker, ...(opts.explain ? {} : { transcript }), loading: true, assembling: false, waiting: false, partialReply: undefined,
      failed: undefined, isQuestion: opts.explain ? false : looksLikeQuestion(transcript, speaker),
    };
    if (opts.turnId != null) {
      setTurns(prev => prev.map(t => t.id === id ? { ...t, ...fields } : t));
    } else {
      setTurns(prev => [...prev, { id, ts: Date.now(), transcript, ...fields }]);
    }
    // Being answered now, so no longer waiting for Answer, R or G.
    unwait(id);

    clearSaid();                       // a new answer is a new thing to read out
    cancelTurnRequest(id);
    const ctrl = new AbortController();
    inflightRef.current.set(id, ctrl);
    const watchdog = stallWatchdog(() => ctrl.abort(), ANSWER_STALL_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const onCredits = fallbackRef.current;

    try {
      const res = await fetchApi("/coach/turn", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(onCredits ? { "X-IRB-Use-Credits": "1" } : {}),
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          // An explain request asks about the lecture passage; the lecture itself is already saved.
          transcript: opts.explain ? `Explain this part of the lecture:\n\n${transcript}` : transcript,
          speaker, plan_id: plan?.id ?? null,
          section_idx: sectionIdx, template, model,
          history: opts.replaces ? dropSuperseded(historyRef.current, transcript) : historyRef.current,
          session_id: opts.explain ? null : sessionId,
          ai_instructions: aiInstructions || undefined,
          response_tone: responseTone,
          cv_id: cvId ?? undefined,
          document_ids: documentIds.length ? documentIds : undefined,
          people_ids: peopleIds.length ? peopleIds : undefined,
          // Read at send time: the language can change (Preferences, a reopened session) without rebuilding this callback.
          language: languageRef.current,
          display_language: displayRef.current,
          replaces: opts.replaces || undefined,
          fallback_credits: onCredits || undefined,
        }),
      });
      watchdog.kick();
      if (!res.ok) throw await errorFromResponse(res);
      if (!res.body) throw new Error("no stream");

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";
      let buffer = "";
      let finished = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        watchdog.kick();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          let event: any = null;
          try {
            event = JSON.parse(raw);
          } catch {
            continue; /* malformed chunk — skip */
          }
          if (event.type === "token") {
            accumulated += event.text;
            const text = accumulated;
            setTurns(prev => prev.map(t => t.id === id ? { ...t, partialReply: text } : t));
          } else if (event.type === "meta") {
            // Update badge live with classifier result
            const tt = event.turn_type as string | undefined;
            const tone = event.response_tone as string | undefined;
            if (tt || tone) {
              setTurns(prev => prev.map(t =>
                t.id === id ? { ...t, turnType: tt ?? t.turnType, tone: tone ?? t.tone } : t
              ));
            }
          } else if (event.type === "done") {
            finished = true;
            failedAskRef.current.delete(id);
            // An answer came back, so whatever failed before isn't failing now:
            // the "didn't answer in time" banner stops pushing credits, and the
            // "isn't listening" banner is checked again (it was only read at start).
            setRelayIssue(false);
            checkRelay();
            setTurns(prev => prev.map(t =>
              t.id === id ? { ...t, reply: accumulated, partialReply: undefined, superseded: false, loading: false, incomplete: undefined, failed: undefined } : t
            ));
            // Append this exchange (answers can finish out of order, so don't
            // overwrite with the server's snapshot of the history).
            const exchange: HistoryItem[] = (event.history ?? []).slice(-2);
            setHistory(h => [...(opts.replaces ? dropSuperseded(h, transcript) : h), ...exchange]);
            if (event.session_id != null) {
              setSessionId(prev => {
                if (prev == null && fallbackRef.current) {
                  fetchApi(`/coach/session/${event.session_id}/fallback`, { method: "POST" }).catch(() => {});
                }
                return prev ?? event.session_id;
              });
            }
            // The answer names the model that wrote it — which, for an
            // ordinary account, the service chose rather than this computer.
            if (event.engine?.model) setAnswering(event.engine as Engine);
          } else if (event.type === "error") {
            throw new AppError(event);
          }
        }
      }
      // Closed with neither "done" nor "error": left alone, the turn would say loading for good.
      if (!finished) throw brokenAnswer();
    } catch (caught: any) {
      // Cancelled because the speaker kept talking, a new request for this
      // turn, or the screen was left: whoever cancelled it owns the turn now.
      // Given up on because it went quiet is a failure like any other.
      if (ctrl.signal.aborted && !watchdog.fired) return;
      const err = watchdog.fired ? stalledAnswer() : caught;
      const raw = toFriendly(err);
      // One-click users are never told to type "start iReliabee" (lib/relay.ts).
      const copy = relayIssueCopy(raw.code, relayAutoRef.current);
      const info: FriendlyInfo = copy ? { ...raw, ...copy } : raw;
      if (isRelayFailure(raw.code) || raw.code === "answer_stalled") {
        setRelayIssue(true);
        if (isRelayFailure(raw.code)) checkRelay();      // the latest reason Claude Code failed, for the turn
        // "Use credits instead" answers this turn on credits too, on its own card.
        notifyError(new AppError(info), () => {
          void enableSessionFallback();
          // Unless it was asked again meanwhile (Try again, R, G).
          if (failedAskRef.current.has(id) && !inflightRef.current.has(id)) {
            void sendTurnRef.current(transcript, speaker, { turnId: id, replaces: opts.replaces, explain: opts.explain });
          }
        });
      } else {
        notifyError(new AppError(info));
      }
      // Out of credits, signed out, the daily limit: every later turn would
      // fail the same way. Pause Auto Answer rather than fire and toast each
      // one (audit 180-M11).
      if (pausesAutoAnswer(err)) setAutoPaused(true);
      // Keep whatever streamed before it broke (lib/turns), and say on the
      // turn what went wrong, with Try again. Never leave it on loading dots.
      setTurns(prev => prev.map(t => t.id === id ? { ...t, ...keepPartialReply(t), failed: raw } : t));
      failedAskRef.current.set(id, { text: transcript, speaker, replaces: opts.replaces, explain: opts.explain });
      // Back on the waiting list, so R (or Shift+R) and G ask this turn again
      // rather than finding nothing, or making a new one.
      if (!opts.explain) {
        const again = { id, speaker, text: transcript, replaces: opts.replaces };
        waitingRef.current = enqueue(waitingRef.current, again);
        setWaiting(q => enqueue(q, again));
      }
    } finally {
      watchdog.stop();
      reader?.cancel().catch(() => {});
      if (inflightRef.current.get(id) === ctrl) inflightRef.current.delete(id);
    }
  }, [plan, sectionIdx, template, model, sessionId, aiInstructions, responseTone, cvId, documentIds, peopleIds, language, cancelTurnRequest, clearSaid, enableSessionFallback, unwait, checkRelay]);

  /** Ask a failed turn again, on its own card. Once: not while it is already being asked. */
  const retryTurn = useCallback((id: number) => {
    const ask = failedAskRef.current.get(id);
    if (!ask || inflightRef.current.has(id)) return;
    void sendTurn(ask.text, ask.speaker, { turnId: id, replaces: ask.replaces, explain: ask.explain });
  }, [sendTurn]);

  // The audio socket's handlers outlive renders; always call the latest sendTurn.
  const sendTurnRef = useRef(sendTurn);
  sendTurnRef.current = sendTurn;
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  // Lecture mode: save each passage to the session without asking the coach.
  // The session is created on the first passage if the lecture wasn't started from New Session.
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const creatingSession = useRef<Promise<number> | null>(null);
  async function lectureSession(): Promise<number> {
    if (sessionIdRef.current != null) return sessionIdRef.current;
    if (!creatingSession.current) {
      creatingSession.current = fetchApi("/sessions/", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Lecture — ${new Date().toLocaleDateString([], { day: "numeric", month: "short" })}`,
          subtitle: "Lecture companion", tags: ["lecture"], template: "lecture", language: languageRef.current,
        }),
      }).then(async r => {
        if (!r.ok) throw await errorFromResponse(r);
        const s = await r.json();
        sessionIdRef.current = s.id;
        setSessionId(s.id);
        return s.id as number;
      }).finally(() => { creatingSession.current = null; });
    }
    return creatingSession.current;
  }
  async function recordLecture(seg: Segment) {
    setTurns(prev => prev.map(t => t.id === seg.id ? { ...t, transcript: seg.text, assembling: false } : t));
    try {
      const sid = await lectureSession();
      const r = await fetchApi(`/sessions/${sid}/transcript`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: seg.text, speaker: seg.speaker }),
      });
      if (!r.ok) throw await errorFromResponse(r);
    } catch (e) { notifyError(e); }
  }
  const recordLectureRef = useRef(recordLecture);
  recordLectureRef.current = recordLecture;

  // ── Live turn assembly ─────────────────────────────────────────────────────
  // Joins a speaker's transcript lines into one question and only asks the
  // coach once they've finished (see lib/turnAssembler.ts).
  const [pauseTolerance, setPauseToleranceState] = useState<PauseToleranceId>(getPauseTolerance);
  const pauseMsRef = useRef(pauseMsFor(pauseTolerance));
  pauseMsRef.current = pauseMsFor(pauseTolerance);
  useEffect(() => {
    const h = () => setPauseToleranceState(getPauseTolerance());
    window.addEventListener("pause-tolerance", h);
    return () => window.removeEventListener("pause-tolerance", h);
  }, []);

  const assemblerRef = useRef<TurnAssembler | null>(null);
  if (!assemblerRef.current) {
    assemblerRef.current = new TurnAssembler({
      onStart: (speaker, text) => {
        const id = ++_id;
        setTurns(prev => [...prev, {
          id, speaker, transcript: text, assembling: true, ts: Date.now(),
          isQuestion: looksLikeQuestion(text, speaker),
        }]);
        return id;
      },
      onUpdate: (seg: Segment) => {
        setTurns(prev => prev.map(t => t.id === seg.id ? { ...t, transcript: seg.text } : t));
      },
      onReopen: (seg: Segment) => {
        // Stop the answer to the first part; keep it visible (dimmed) until
        // the answer to the whole question starts streaming. A turn that was
        // waiting is being spoken again, so it stops waiting until it ends.
        cancelTurnRequest(seg.id);
        failedAskRef.current.delete(seg.id);
        setWaiting(q => without(q, seg.id));
        setTurns(prev => prev.map(t => t.id === seg.id ? {
          ...t, transcript: seg.text, assembling: true, loading: false, waiting: false,
          partialReply: undefined, superseded: !!t.reply, failed: undefined,
        } : t));
      },
      onFlush: (seg: Segment) => {
        if (lectureRef.current) { recordLectureRef.current(seg); return; }
        const send = () => sendTurnRef.current(seg.text, seg.speaker, { turnId: seg.id, replaces: seg.replaces });

        // "Respond now": the user asked, so Auto Answer has no say.
        if (forceSendRef.current) { send(); return; }

        // The speaker has finished (the assembler waited out the pause).
        // Whether that costs money is Auto Answer's decision — this line used
        // to send unconditionally, so Off changed nothing.
        const now = Date.now();
        const decision = decide({
          enabled: autoOnFor(seg.speaker, autoAnswerRef.current), paused: autoPausedRef.current,
          now, recent: autoCallsRef.current,
        });
        if (decision === "send") {
          autoCallsRef.current = remember(autoCallsRef.current, now);
          send();
          return;
        }
        if (decision === "pause") {
          setAutoPaused(true);
          toast.error(RUNAWAY_MESSAGE, { duration: 12000 });
        }
        setWaiting(q => enqueue(q, { id: seg.id, speaker: seg.speaker, text: seg.text, replaces: seg.replaces }));
        setTurns(prev => prev.map(t => t.id === seg.id ? { ...t, assembling: false, waiting: true } : t));
      },
    }, () => pauseMsRef.current);
  }
  const assembler = assemblerRef.current;

  // Leaving the session: drop anything half-assembled and stop streaming answers.
  // And stop listening: live time is billed per second of open socket, so a
  // socket left behind would spend credits with nothing on screen (audit
  // 180-C4). Not closeAudioWs(): that answers the last thing said, a paid
  // call whose answer nobody would see.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Set on every mount: React's development mode mounts twice.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      assemblerRef.current?.reset();
      inflightRef.current.forEach(c => c.abort());
      inflightRef.current.clear();
      abandonSocket(wsRef.current);
      wsRef.current = null;
    };
  }, []);

  // ── Text submit ───────────────────────────────────────────────────────────
  /**
   * Send what is in the box. Enter (yours) and They said (theirs) put it in the
   * transcript, and that side's Auto Answer decides, as for spoken words: off,
   * it waits for Answer, R or Shift+R (owner, 30 Sep 2026: it was answered with
   * both switches off). `ask` is an explicit request (Respond, R, Shift+R):
   * it is answered now.
   */
  function handleSubmit(speaker: "user" | "interviewer", ask = false) {
    if (!text.trim()) return;
    if (lectureRef.current && speaker === "interviewer") {
      // Typed or pasted lecture text is recorded like spoken lecture, not answered.
      const id = ++_id;
      setTurns(prev => [...prev, { id, speaker, transcript: text.trim(), ts: Date.now(), isQuestion: false }]);
      recordLecture({ id, speaker, text: text.trim() } as Segment);
    } else if (!ask && !autoOnFor(speaker, autoAnswerRef.current)) {
      const id = ++_id;
      const said = text.trim();
      setTurns(prev => [...prev, { id, speaker, transcript: said, ts: Date.now(), isQuestion: looksLikeQuestion(said, speaker), waiting: true }]);
      setWaiting(q => enqueue(q, { id, speaker, text: said }));
    } else {
      sendTurn(text.trim(), speaker);
    }
    setText("");
    // Keep the box focused through the re-render a new turn causes, so the
    // next letters are typed, not taken as shortcuts (lib/liveKeys.ts).
    typedAtRef.current = Date.now();
    textRef.current?.focus();
    requestAnimationFrame(() => { if (document.activeElement !== textRef.current) textRef.current?.focus(); });
  }

  /** Lecture mode: explain the last couple of minutes, without saving the question into the lecture. */
  function explainRecent() {
    const heard = livePartial.trim();
    if (heard) { assembler.flushNow(livePartialSpeaker, heard); setLivePartial(""); }
    setTimeout(() => {
      const said = turnsRef.current.filter(t => t.speaker === "interviewer" && t.transcript.trim());
      const last = said[said.length - 1];
      if (!last) { toast("Nothing to explain yet — the lecture hasn't started", { icon: "🎓" }); return; }
      let passage = "";
      for (let i = said.length - 1; i >= 0 && passage.length < 2000; i--) passage = `${said[i].transcript}\n${passage}`;
      track("lecture.explain");
      sendTurn(passage.trim(), "interviewer", { turnId: last.id, explain: true });
    }, heard ? 50 : 0);
  }

  /**
   * Answer one side now (lib/liveKeys.ts, planRespond): R for what they said,
   * Shift+R for what you said. Only that side's words are answered; the other
   * side's turn is left to Auto Answer.
   */
  function respondTo(side: "user" | "interviewer") {
    if (lectureRef.current) { explainRecent(); return; }
    const plan = planRespond(side, {
      open: assembler.current?.speaker ?? null,
      partial: { speaker: livePartialSpeaker, text: livePartial },
      waiting: waitingRef.current,
      typed: text,
      // A turn already being answered is not asked again as a new card.
      answering: turnsRef.current.filter(t => t.loading && inflightRef.current.has(t.id)).map(t => t.speaker),
    });
    if (plan.kind === "flush") {
      // They were still talking over the start of yours: their turn goes the
      // ordinary way (Auto Answer decides), and only yours is forced.
      if (plan.otherFirst) assembler.flushNow();
      // Don't wait for the pause: answer what's been said so far, including
      // words still being transcribed (their final line is then ignored).
      forceSendRef.current = true;
      try {
        if (plan.withPartial) assembler.flushNow(side, livePartial.trim());
        else assembler.flushNow();
      } finally {
        forceSendRef.current = false;
      }
      if (plan.withPartial) setLivePartial("");
      return;
    }
    if (plan.kind === "waiting") { answerWaiting(plan.turn); return; }
    if (plan.kind === "typed") { handleSubmit(side, true); return; }
    if (plan.kind === "busy") { toast(stillAnswering(side, themLabel), { icon: "⏳", id: "respond-nothing" }); return; }
    toast(nothingToAnswer(side, themLabel), { icon: "🎙️", id: "respond-nothing" });
  }
  const respondRef = useRef(respondTo);
  respondRef.current = respondTo;

  /**
   * Send one waiting (or failed) turn to the coach — the user asked for it.
   * On its own card, and once: a second press while it is being asked does nothing.
   */
  function answerWaiting(turn: WaitingTurn) {
    unwait(turn.id);
    if (inflightRef.current.has(turn.id)) return;
    sendTurn(turn.text, turn.speaker, { turnId: turn.id, replaces: turn.replaces });
  }
  const answerWaitingRef = useRef(answerWaiting);
  answerWaitingRef.current = answerWaiting;

  // ── Audio: open WebSocket ─────────────────────────────────────────────────
  async function openAudioWs(sources: ("mic" | "system")[]) {
    // Turning audio back on while paused means the user is resuming.
    if (pausedRef.current) {
      pausedRef.current = false;
      setPaused(false);
      if (sessionId != null) fetchApi(`/sessions/${sessionId}/start`, { method: "POST" }).catch(() => {});
    }
    if (wsRef.current) return;
    if (!sources.length) return;
    setRecState("connecting");
    if (notebookRelay && !sessionFallback) checkRelay();
    if (!(await ensureReady(["stt"]))) {
      setRecState("idle");
      setMicOn(false);
      setSysOn(false);
      return;
    }
    // Ask before connecting rather than after: being cut off mid-interview is
    // the one failure this feature must never produce.
    if (!(await canGoLive(sessionId))) {
      setRecState("idle");
      setMicOn(false);
      setSysOn(false);
      showUpgrade("live");
      return;
    }

    track(`session.listen.${sources.slice().sort().join("-")}`);
    // The backend opens a socket only for this app's token (audit 180-C3).
    await localReady().catch(() => {});
    // Starting takes several round trips; if the screen was left meanwhile,
    // do not open a socket nothing will ever close, which would bill live
    // time with nothing on screen (audit 182-M2).
    if (!mountedRef.current) return;
    const ws = new WebSocket(apiSocketUrl("/audio/stream"));
    countWhileOpen(ws);   // reminders stay silent while the coach listens
    wsRef.current = ws;

    ws.onopen = async () => {
      // Pull the app-wide STT provider/model from /config so live capture
      // honours the user's Settings choice (deepgram = streaming, else batch).
      let stt_provider = "deepgram";
      let stt_model: string | undefined = undefined;
      try {
        const cfg = await fetchApi("/config").then(r => r.ok ? r.json() : null);
        if (cfg?.saved?.stt_provider) stt_provider = cfg.saved.stt_provider;
        if (cfg?.saved?.stt_model)    stt_model    = cfg.saved.stt_model;
      } catch {}
      ws.send(JSON.stringify({ mode: "live", sources, stt_provider, stt_model,
                              language: languageRef.current, display_language: displayRef.current, session_id: sessionId,
                              devices: devicesRef.current }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "ready":
          setRecState("ready");
          break;
        case "level":
          setLevels(prev => ({
            ...prev,
            [msg.source === "system" ? "system" : "mic"]: {
              level: msg.level ?? 0, speaking: !!msg.speaking, gain: msg.gain ?? 1,
            },
          }));
          break;
        case "stt":
          setStt({ provider: msg.provider || "", streaming: !!msg.streaming });
          setHearing({ model: msg.model || "", provider: msg.provider || "", confirmed: !!msg.confirmed });
          if (!msg.streaming) {
            toast(
              `${msg.provider || "This transcriber"} can't write while you speak — ` +
              "your words appear a moment after each pause.",
              { icon: "\u23f3", duration: 8000, id: "stt-not-streaming" },
            );
          }
          break;
        case "recording":
          setRecState("recording");
          break;
        case "partial":
          setLivePartial(msg.text || "");
          if (msg.speaker) setLivePartialSpeaker(msg.speaker);
          if (msg.speaker === "user") {
            delivery.partialText("you", msg.text || "");
            setSaid(keepSaid(`${saidFinal.current} ${msg.text || ""}`.trim()));
          }
          assemblerRef.current?.partial((msg.speaker as "user" | "interviewer") ?? "user", msg.text || "");
          break;
        case "transcript":
          setLivePartial("");
          if (msg.speaker === "user" && msg.text) {
            delivery.finalText("you", msg.text);
            saidFinal.current = keepSaid(`${saidFinal.current} ${msg.text}`.trim());
            setSaid(saidFinal.current);
          }
          if (msg.text) {
            // The assembler joins lines split by pauses into one turn and, once
            // the speaker has finished, hands it to onFlush — which answers it
            // or keeps it waiting, as Auto Answer says.
            assemblerRef.current?.final((msg.speaker as "user" | "interviewer") ?? "user", msg.text);
          }
          break;
        case "translation":
          if (msg.text && msg.translation) setTranslations(prev => ({ ...prev, [msg.text]: msg.translation }));
          break;
        case "activity":
          if (msg.source === "mic")    { setMicActive(!!msg.active); delivery.activity("you", !!msg.active); }
          if (msg.source === "system") { setSysActive(!!msg.active); delivery.activity("them", !!msg.active); }
          assemblerRef.current?.activity(msg.source === "mic" ? "user" : "interviewer", !!msg.active);
          break;
        case "capture":
          if (msg.source === "mic") { setMicCapturing(msg.devices || []); break; }
          setCapturing((prev) => {
            // Only complain once per move, not on every re-send.
            if (msg.stale && msg.stale !== prev.stale) {
              toast.error(
                "The call's audio moved to a device we cannot record. " +
                "Switch the meeting's speaker back to your laptop or speakers.",
                { duration: 8000 },
              );
            }
            return {
              devices: msg.devices || [],
              skipped: msg.skipped || [],
              stale: msg.stale || null,
            };
          });
          if ((msg.skipped || []).length && !(msg.devices || []).length) {
            toast.error("No system audio device could be opened — check Settings.");
          }
          break;
        case "error":
          if (msg.error === "pro_required") {
            setMicOn(false);
            setSysOn(false);
            showUpgrade(msg.feature ?? "live");
          } else if (SESSION_ENDING.has(msg.code)) {
            // Transcription has stopped on the server's side — out of
            // credits, signed out, or the connection closed. Say so and stop
            // listening, rather than showing "listening" to nothing (audit
            // 178-H1).
            // Close the socket too, without answering the last thing said:
            // that would be one more call that fails the same way (180-M11).
            abandonSocket(wsRef.current);
            wsRef.current = null;
            liveAudioStopped();
            if (pausesAutoAnswer(msg)) setAutoPaused(true);
            notifyError(msg);
          } else {
            notifyError(msg);
          }
          break;
      }
    };

    ws.onerror = () => {
      // A newer socket has already taken over: its state is the true one, and
      // this one's failure must not pull the toolbar down under it.
      if (wsRef.current !== ws) return;
      toast.error("Microphone connection failed — is the backend running?");
      wsRef.current = null;
      liveAudioStopped();
    };

    ws.onclose = () => {
      // Already null: either onerror got here first, or this socket was
      // abandoned on purpose. Either way the toolbar has been dealt with.
      if (wsRef.current !== ws) return;
      wsRef.current = null;
      liveAudioStopped();
    };
  }

  /**
   * Listening stopped and we are not the ones who stopped it: the socket died,
   * or the server said the session is over. Put the toolbar back to
   * not-listening.
   *
   * A lit You/Them button over a dead socket is a lie, and because those two
   * are a toggle (lib/sources `pick`), the next press on a lit-but-dead one
   * only turns it *off* — so carrying on after an error took two presses, the
   * first of which looked like it had done nothing.
   *
   * This is the union of what the SESSION_ENDING branch and `ws.onclose` each
   * used to do, in one place so they cannot drift apart again. It leaves
   * `wsRef` alone: every caller has already dealt with its own socket.
   */
  function liveAudioStopped() {
    setMicOn(false);
    setSysOn(false);
    setRecState("idle");
    setMicActive(false);
    setSysActive(false);
    setLevels({ mic: quiet, system: quiet });
    setCapturing({ devices: [], skipped: [], stale: null });
    setMicCapturing([]);
    // Drop the half-heard turn rather than answer it: the backend that would
    // answer it is the one that just went.
    assembler.reset();
    // …and take its "Waiting for them to finish" off the screen with it.
    // Dropping the turn while leaving the row pulsing left the last thing on
    // screen still claiming to be listening — the same lie one line lower.
    setTurns(prev => prev.map(t => (t.assembling ? { ...t, assembling: false } : t)));
    setLivePartial("");
    saveDelivery(sessionId, delivery.snapshot());
  }

  function closeAudioWs() {
    setCapturing({ devices: [], skipped: [], stale: null });
    setMicCapturing([]);
    setLevels({ mic: quiet, system: quiet });
    // Answer whatever the speaker said before listening stopped.
    assembler.stop();
    saveDelivery(sessionId, delivery.snapshot());
    // Detach the handlers before closing. `ws.onclose` is the *unexpected*
    // close path and now stands the toolbar down, which must not happen when
    // we are the one closing — switching sides, Pause, and End all come
    // through here, and all three want the toggles left exactly as they are.
    abandonSocket(wsRef.current);
    wsRef.current = null;
    setRecState("idle");
    setMicActive(false);
    setSysActive(false);
  }

  /** Listen to whatever `next` says: the one place either control ends up. */
  function listenTo(next: Listening) {
    setMicOn(next.mic);
    setSysOn(next.system);
    // Close the current stream and (re)open with the new set.
    closeAudioWs();
    const open = openList(next);
    // Small delay so the backend fully tears down before we open again.
    if (open.length) setTimeout(() => openAudioWs(open), 100);
  }

  /**
   * Pick one side — the You and {themLabel} buttons, and their keys. The rule
   * (lib/sources) is that the two are a choice, not a pair: picking one puts
   * the other down. Auto is the only control that runs both.
   */
  function toggleSource(source: "mic" | "system") {
    listenTo(pick({ mic: micOn, system: sysOn }, source));
  }

  // ── Screen capture ───────────────────────────────────────────────────────
  /**
   * What a screenshot in this session is about: the other side's latest
   * question and the lines before it (lib/screenContext). Read from the live
   * transcript at the moment of the capture; what's typed still wins (server).
   */
  function screenAsk(): { their_question?: string; conversation?: { speaker: string; text: string }[] } {
    const c = screenContext(turns);
    screenQuestionIdRef.current = c.theirQuestion ? c.questionId : null;
    return {
      ...(c.theirQuestion ? { their_question: c.theirQuestion } : {}),
      ...(c.conversation.length ? { conversation: c.conversation } : {}),
    };
  }

  function appendScreenAsk(fd: FormData) {
    const a = screenAsk();
    if (a.their_question) fd.append("their_question", a.their_question);
    if (a.conversation) fd.append("conversation", JSON.stringify(a.conversation));
  }

  /**
   * A screenshot that answered their question settles it: it leaves the
   * waiting list (Answer latest, G) and says it was answered, so pressing
   * Answer doesn't ask the coach again without the slide. Only that turn:
   * the user's own lines still wait for them.
   */
  function settleScreenQuestion(questionId: number | null, answering: string | null | undefined) {
    if (questionId == null || !answering) return;
    setWaiting(q => without(q, questionId));
    setTurns(prev => prev.map(t => t.id === questionId ? { ...t, waiting: false, answeredOnScreen: true } : t));
  }

  async function captureScreen(mode: "region" | "full" | "window" = "region") {
    // Native path — server invokes grim / gnome-screenshot / import / scrot.
    // This is the only reliable path in Tauri webviews. Browser fallback below.
    setScreenBusy(true);
    const id = ++_id;
    setTurns(prev => [...prev, {
      id, speaker: "user",
      transcript: `[SCREEN ${mode}] (capturing…)`,
      loading: true, ts: Date.now(),
    }]);
    const modeAsk = screenAsk();
    const modeQid = screenQuestionIdRef.current;
    try {
      const res = await fetchApi("/coach/screen/native", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          session_id: sessionId ?? undefined,
          template, model,
          ai_instructions: aiInstructions || undefined,
          cv_id: cvId ?? undefined,
          ...modeAsk,
        }),
      });
      if (!res.ok) {
        // Fall back to browser getDisplayMedia on failure (e.g. Wayland picker denied)
        throw new Error(String(res.status));
      }
      const data = await res.json();
      setTurns(prev => prev.map(t => t.id === id
        ? { ...t, transcript: `[SCREEN ${mode}] ${data.prompt_used}`, reply: data.reply, loading: false }
        : t));
      settleScreenQuestion(modeQid, data.answering);
      if (data.session_id && sessionId == null) setSessionId(data.session_id);
    } catch {
      // Fallback: browser getDisplayMedia + preview modal
      setTurns(prev => prev.filter(t => t.id !== id));
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 5 } as any, audio: false,
        });
        const track = stream.getVideoTracks()[0];
        await new Promise(r => setTimeout(r, 300));
        const video = document.createElement("video");
        video.srcObject = stream;
        await new Promise<void>(res => { video.onloadedmetadata = () => { video.play(); res(); }; });
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")!.drawImage(video, 0, 0);
        track.stop();
        const blob: Blob = await new Promise(r => canvas.toBlob(b => r(b!), "image/png", 0.92));
        setScreenPreview({ dataUrl: canvas.toDataURL("image/png"), blob, prompt: "" });
      } catch {
        toast.error(navigator.userAgent.includes("Linux")
          ? "Screen capture unavailable — install grim (Wayland) or imagemagick"
          : "Screen capture failed");
      }
    } finally {
      setScreenBusy(false);
    }
  }

  // Picker path: grab the chosen screen / window / tab, show it in the
  // transcript straight away, then ask the coach about it.
  async function captureTarget(pick: ScreenPick) {
    track(`screen.capture.${pick.target.split(":")[0]}${pick.tabTitle ? ".tab" : ""}${pick.region ? ".region" : ""}`);
    setScreenPickerOpen(false);
    setScreenBusy(true);
    try {
      const res = await fetchApi("/coach/screen/grab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: pick.target,
          tab_index: pick.tabIndex ?? undefined,
          tab_title: pick.tabTitle ?? undefined,
          session_id: sessionId ?? undefined,
        }),
      });
      if (!res.ok) {
        let detail = "Screen capture failed";
        try { detail = (await res.json()).detail || detail; } catch { /* keep default */ }
        toast.error(detail);
        if (res.status === 404) {
          // Window closed / screen unplugged — forget it and let the user choose again.
          if (lastScreenPick?.target === pick.target) {
            setLastScreenPick(null);
            try { localStorage.removeItem(LAST_SCREEN_KEY); } catch { /* ignore */ }
          }
          setScreenPickerOpen(true);
        }
        return;
      }
      const data = await res.json();
      // Remember the window, not the tab: tab positions change, and C should
      // re-capture whatever that window is showing.
      const remembered: ScreenPick = pick.tabTitle
        ? { target: pick.target, label: pick.label.split(" — ")[0] + " window", region: pick.region }
        : pick;
      setLastScreenPick(remembered);
      try { localStorage.setItem(LAST_SCREEN_KEY, JSON.stringify(remembered)); } catch { /* ignore */ }

      if (pick.region) {
        setRegionFor({ captureId: data.capture_id, preview: data.preview, width: data.width, height: data.height, label: pick.label });
        return;
      }
      await analyzeCapture(data.capture_id, data.preview, pick.label, null);
    } catch (e) {
      notifyError(e);
    } finally {
      setScreenBusy(false);
    }
  }

  async function analyzeCapture(captureId: string, preview: string, label: string, region: Region | null) {
    const id = ++_id;
    const caption = region ? `${label} (selection)` : label;
    // Whatever is typed in the composer ("solve it in Java") is the question.
    const question = text.trim();
    if (question) setText("");
    const ask = screenAsk();
    const askQid = screenQuestionIdRef.current;
    setTurns(prev => [...prev, {
      id, speaker: "user",
      transcript: `[SCREEN] ${caption}${question ? ` — ${question}` : ""}`,
      screenshot: preview, screenLabel: caption, screenQuestion: question || undefined,
      loading: true, ts: Date.now(),
    }]);
    try {
      const res = await fetchApi("/coach/screen/native", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capture_id: captureId,
          region: region ?? undefined,
          prompt: question || undefined,
          session_id: sessionId ?? undefined,
          template, model,
          ai_instructions: aiInstructions || undefined,
          cv_id: cvId ?? undefined,
          ...ask,
        }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      const data = await res.json();
      setTurns(prev => prev.map(t => t.id === id
        ? { ...t, reply: data.reply, loading: false, screenQuestion: t.screenQuestion ?? (data.answering ? `Answering: ${data.answering}` : undefined) }
        : t));
      settleScreenQuestion(askQid, data.answering);
      if (data.session_id && sessionId == null) setSessionId(data.session_id);
    } catch (e) {
      setTurns(prev => prev.map(t => t.id === id ? { ...t, loading: false } : t));
      notifyError(e);
    }
  }

  screenHotkeyRef.current = (chooseNew: boolean) => {
    if (screenBusy) return;
    if (!chooseNew && lastScreenPick) captureTarget(lastScreenPick);
    else setScreenPickerOpen(true);
  };

  async function submitScreen() {
    if (!screenPreview) return;
    setScreenBusy(true);
    try {
      const id = ++_id;
      // Add turn to feed with the screenshot preview
      setTurns(prev => [...prev, {
        id, speaker: "user", transcript: `[SCREEN] ${screenPreview.prompt || "(analyse this screenshot)"}`,
        loading: true, ts: Date.now(),
      }]);
      const fd = new FormData();
      fd.append("file", screenPreview.blob, "screen.png");
      if (screenPreview.prompt) fd.append("prompt", screenPreview.prompt);
      appendScreenAsk(fd);
      const previewQid = screenQuestionIdRef.current;
      if (sessionId != null)     fd.append("session_id", String(sessionId));
      fd.append("template", template);
      fd.append("model", model);
      if (aiInstructions)        fd.append("ai_instructions", aiInstructions);
      if (cvId != null)          fd.append("cv_id", String(cvId));
      const res = await fetchApi("/coach/screen", { method: "POST", body: fd });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTurns(prev => prev.map(t => t.id === id ? { ...t, reply: data.reply, loading: false } : t));
      settleScreenQuestion(previewQid, data.answering);
      if (data.session_id && sessionId == null) setSessionId(data.session_id);
      setScreenPreview(null);
    } catch {
      toast.error("Screen analysis failed");
      setTurns(prev => prev.map(t => t.loading ? { ...t, loading: false } : t));
    } finally {
      setScreenBusy(false);
    }
  }

  // ── A picture in the prompt box ───────────────────────────────

  /** Take a picked, pasted or dropped picture, ready to send with the question. */
  async function attach(file: File | null) {
    if (!file) return;
    if (!isImage(file)) {
      toast.error("That is not a picture the coach can read — PNG, JPEG, WebP or GIF.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error(`That picture is ${sizeLabel(file.size)} — too big to send. Crop it, or save it smaller.`);
      return;
    }
    setAttaching(true);
    try {
      setAttached(await prepare(file));
      textRef.current?.focus();
    } catch {
      toast.error("That picture could not be opened.");
    } finally {
      setAttaching(false);
    }
  }

  /**
   * Send the attached picture with whatever is typed as the question — the
   * same road a screenshot takes, walked from the other end.
   */
  async function sendPicture() {
    if (!attached || screenBusy) return;
    const picture = attached;
    const question = text.trim();
    const id = ++_id;
    setAttached(null);
    setText("");
    setScreenBusy(true);
    setTurns(prev => [...prev, {
      id, speaker: "user",
      transcript: `[IMAGE] ${picture.file.name}${question ? ` — ${question}` : ""}`,
      screenshot: picture.dataUrl, screenLabel: picture.file.name,
      screenQuestion: question || undefined,
      loading: true, ts: Date.now(),
    }]);
    try {
      const fd = new FormData();
      fd.append("file", picture.file, picture.file.name);
      if (question)          fd.append("prompt", question);
      appendScreenAsk(fd);
      const pictureQid = screenQuestionIdRef.current;
      if (sessionId != null) fd.append("session_id", String(sessionId));
      fd.append("template", template);
      fd.append("model", model);
      if (aiInstructions)    fd.append("ai_instructions", aiInstructions);
      if (cvId != null)      fd.append("cv_id", String(cvId));
      const res = await fetchApi("/coach/screen", { method: "POST", body: fd });
      if (!res.ok) throw await errorFromResponse(res);
      const data = await res.json();
      setTurns(prev => prev.map(t => t.id === id
        ? { ...t, reply: data.reply, loading: false, screenQuestion: t.screenQuestion ?? (data.answering ? `Answering: ${data.answering}` : undefined) }
        : t));
      settleScreenQuestion(pictureQid, data.answering);
      if (data.session_id && sessionId == null) setSessionId(data.session_id);
      track("coach.image");
    } catch (e) {
      setTurns(prev => prev.map(t => t.id === id ? { ...t, loading: false } : t));
      notifyError(e);
    } finally {
      setScreenBusy(false);
    }
  }

  // ── Extra context (mid-session) ──────────────────────────────────────────
  function saveContextUpdate() {
    const text = contextDraft.trim();
    if (!text) { setContextOpen(false); return; }
    const addendum = `\n\n[LIVE CONTEXT UPDATE #${contextUpdates + 1}]\n${text}`;
    setAIInstructions(prev => prev + addendum);
    setContextUpdates(n => n + 1);
    setContextDraft("");
    setContextOpen(false);
    toast.success("Context saved — future coach replies will use it");
  }

  // ── Session lifecycle: Save / Pause / End ────────────────────────────────
  async function saveSession() {
    if (sessionId == null) { toast.error("Session not created yet — send a turn first."); return; }
    setSavingSession(true);
    try {
      const r = await fetchApi(`/sessions/${sessionId}/save`, { method: "POST" });
      if (!r.ok) throw new Error();
      setSaved(true);
      toast.success("Session saved");
    } catch { toast.error("Save failed"); }
    finally { setSavingSession(false); }
  }
  // Compact overlay: a small pinned strip with just the answer.
  // Side effects stay outside the state updater: StrictMode runs updaters twice.
  // The chat under the overlay or the camera strip, shown and hidden with T.
  const [compactChat, setCompactChat] = useState(false);
  useEffect(() => { if (compactChat) setTimeout(() => textRef.current?.focus(), 0); }, [compactChat]);
  const compactRef = useRef(compact);
  compactRef.current = compact;
  function setCompactMode(kind: CompactKind | null) {
    const was = compactRef.current;
    compactRef.current = kind;
    setCompact(kind);
    if (kind) enterCompactWindow(kind); else if (was) exitCompactWindow();
  }
  // The same key again goes back to the full view; the other key switches shape.
  function toggleCompact(kind: CompactKind = "overlay") {
    setCompactMode(compactRef.current === kind ? null : kind);
  }
  /** O steps through the three views: full, the teleprompter overlay, the strip under the camera, and back. */
  function nextView() {
    setCompactMode(nextCompact(compactRef.current));
  }
  // Leaving the session view while compact must restore the full window.
  useEffect(() => () => { if (compactRef.current) exitCompactWindow(); }, []);

  // "Join & listen" from the calendar: start hearing the call as soon as the session opens.
  const listenToCallRef = useRef(() => {});
  listenToCallRef.current = () => {
    if (wsRef.current) return;
    setSysOn(true);
    openAudioWs(["system"]);
    toast("Listening to the call. Press Y to add your mic.", { icon: "🎧" });
  };
  useEffect(() => {
    if (localStorage.getItem("autoListen") !== "1") return;
    // Cleared only once it runs, so a remount (React dev mode) still starts it.
    const t = setTimeout(() => { localStorage.removeItem("autoListen"); listenToCallRef.current(); }, 700);
    return () => clearTimeout(t);
  }, []);

  // Pause stops listening (so nothing is transcribed or answered) and remembers
  // which audio sources were on, so Resume picks up exactly where it left off.
  async function pauseSession() {
    if (sessionId == null || paused) return;
    const sources: ("mic" | "system")[] = [];
    if (micOn) sources.push("mic");
    if (sysOn) sources.push("system");
    pausedSources.current = sources;
    closeAudioWs();
    setPaused(true);
    try {
      const r = await fetchApi(`/sessions/${sessionId}/pause`, { method: "POST" });
      if (!r.ok) throw await errorFromResponse(r);
    } catch (e) { notifyError(e); }
  }
  // Other pages ask this before leaving (lib/sessionGuard.ts): leaving
  // unmounts the screen, and that stops it hearing the call. Refs, so the
  // guard always answers with what is true now, not at registration.
  const liveRef = useRef(false);
  liveRef.current = liveMode && !paused;
  const pauseRef = useRef(pauseSession);
  pauseRef.current = pauseSession;
  useEffect(() => registerSessionGuard({
    live: () => liveRef.current,
    pause: () => pauseRef.current(),
  }), []);

  async function resumeSession() {
    if (sessionId == null || !paused) return;
    pausedRef.current = false;
    setPaused(false);
    try {
      const r = await fetchApi(`/sessions/${sessionId}/start`, { method: "POST" });
      if (!r.ok) throw await errorFromResponse(r);
    } catch (e) { notifyError(e); }
    const sources = pausedSources.current;
    if (sources.length) setTimeout(() => openAudioWs(sources), 100);
  }
  async function endSession() {
    if (sessionId == null) return;
    closeAudioWs();
    // Pause deliberately keeps them lit, because Resume reads them back.
    // Ending does not come back, so a lit button here is the same lie.
    setMicOn(false);
    setSysOn(false);
    setPaused(false);
    try {
      const r = await fetchApi(`/sessions/${sessionId}/end`, { method: "POST" });
      if (!r.ok) throw new Error();
      // Lectures and meetings get their notebook written in the background (decision 184-1);
      // the backend decides whether it should (length, the Settings switch, Pro, over two hours).
      if ((isLecture || MEETING_TEMPLATES.has(template)) && turns.length > 0) {
        const kind = isLecture ? "lecture" : "meeting";
        notebookApi.auto(sessionId, rememberedNotebookStyle(kind)).catch(() => { /* the Notebook tab still offers it */ });
      }
      // A lecture (roadmap 3.1) ends with its study pack; a meeting (2.1) with its recap.
      if (isLecture && turns.length > 0) {
        const s = await fetchApi(`/sessions/${sessionId}`).then(x => (x.ok ? x.json() : null)).catch(() => null);
        setRecapFor({ id: sessionId, title: s?.title || "Lecture", lecture: true });
        toast.success("Lecture saved — making your study pack");
      } else if (MEETING_TEMPLATES.has(template) && turns.length > 0) {
        const s = await fetchApi(`/sessions/${sessionId}`).then(x => (x.ok ? x.json() : null)).catch(() => null);
        setRecapFor({ id: sessionId, title: s?.title || initialDraft?.title || "Meeting" });
        toast.success("Meeting ended — writing your recap");
      } else {
        toast.success("Session ended");
      }
    } catch { toast.error("End failed"); }
  }

  /** A failed answer, on its turn: what went wrong, Try again, and credits when it was the user's assistant. */
  const failedNote = (t: Turn) => {
    const f = t.failed!;
    const copy = relayIssueCopy(f.code, relayAuto);
    const title = (copy?.title ?? f.title ?? "Couldn't answer").replace(/[.!]$/, "");
    const message = copy?.message ?? f.message;
    const credits = notebookRelay && !sessionFallback && (isRelayFailure(f.code) || f.code === "answer_stalled");
    const isNext = latestOf(waiting, t.speaker)?.id === t.id;
    return (
      <div className="assembling-status failed-status" role="alert">
        <AlertTriangle size={12} className="failed-icon" />
        <span><strong>{title}.</strong> {message}</span>
        <button onClick={() => retryTurn(t.id)} title="Ask the coach about this turn again">
          Try again {isNext && !isLecture && <span className="kbd">{t.speaker === "user" ? "⇧R" : "R"}</span>}
        </button>
        {credits && (
          <button onClick={() => { void enableSessionFallback(); retryTurn(t.id); }}
            title="Answer this turn, and the rest of this call, with iReliabee's AI">
            Use credits
          </button>
        )}
      </div>
    );
  };

  const isRecording    = recState === "recording";
  const isBusy         = recState !== "idle" && recState !== "ready";
  const isActive       = recState !== "idle";
  const sections       = plan?.sections ?? [];
  const currentSection = sections[sectionIdx];
  // Coach cards: finished answers, answers streaming in, and answers being
  // replaced because the speaker carried on (shown dimmed until the new one streams).
  const coachTurns     = turns.filter(t => t.reply || t.partialReply);
  // The full view also shows a turn whose answer failed, with Try again: the
  // coach pane is where the user looks for it.
  const coachCards     = turns.filter(t => t.reply || t.partialReply || (t.failed && !t.loading));
  const streamingId    = turns.find(t => t.loading)?.id ?? null;
  const hasAnyReply    = coachCards.length > 0;
  const lastCoachTurn  = coachTurns[coachTurns.length - 1];
  const latestReply    = lastCoachTurn?.partialReply || lastCoachTurn?.reply || "";
  const assemblingTurn = turns.find(t => t.assembling);
  const lastTurnId     = turns[turns.length - 1]?.id;

  // Something new started — a question in the transcript, or an answer being
  // written (including a re-ask after the speaker carried on): bring it into
  // view and resume following, even if the user had scrolled up to re-read.
  // Streaming within the same answer only follows while they're at the bottom.
  const { scrollToBottom: transcriptToBottom } = transcriptScroll;
  const { scrollToBottom: coachToBottom } = coachScroll;
  useEffect(() => { if (lastTurnId != null) transcriptToBottom(); }, [lastTurnId, transcriptToBottom]);
  useEffect(() => { if (streamingId != null) coachToBottom(); }, [streamingId, coachToBottom]);

  // What is being said right now, and by whom. Whoever is speaking, so the
  // words move while the user speaks too; labelled, so the overlay can tell an
  // interruption (them, mid-answer) from the user reading their own answer out.
  const heardNow = livePartial
    ? { text: livePartial, who: livePartialSpeaker === "interviewer" ? "them" : "you" }
    : { text: turns.filter(t => t.speaker !== "user").slice(-1)[0]?.transcript || "", who: "them" };

  const recStatusLabel: Record<RecordState, string> = {
    idle: "", connecting: "Connecting…", ready: "Ready",
    recording: liveMode ? "Live — listening" : "Recording",
    transcribing: "Transcribing…",
  };

  // ── Pane layout: drag the divider to resize, drag a grip to swap sides ────
  function clampSplit(frac: number, width: number) {
    const min = Math.min(0.45, MIN_PANE_PX / Math.max(width, 1));
    return Math.min(1 - min, Math.max(min, frac));
  }

  function startResize(e: React.PointerEvent) {
    const box = splitRef.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    setResizing(true);
    const move = (ev: PointerEvent) => {
      // The transcript's width is measured from whichever edge it sits on.
      const frac = coachSide === "right" ? (ev.clientX - box.left) / box.width : (box.right - ev.clientX) / box.width;
      setSplit(clampSplit(frac, box.width));
    };
    const up = () => {
      setResizing(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function nudgeSplit(e: React.KeyboardEvent) {
    const step = e.shiftKey ? 0.1 : 0.02;
    // Arrow keys move the divider in that direction on screen.
    const dir = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const width = splitRef.current?.clientWidth ?? 1000;
    setSplit(s => clampSplit(s + dir * step * (coachSide === "right" ? 1 : -1), width));
  }

  function startPaneDrag(pane: "transcript" | "coach", e: React.PointerEvent) {
    const box = splitRef.current?.getBoundingClientRect();
    if (!box || e.button !== 0) return;
    e.preventDefault();
    const sideAt = (x: number): "left" | "right" => (x < box.left + box.width / 2 ? "left" : "right");
    let side = sideAt(e.clientX);
    setPaneDrag({ pane, side });
    const move = (ev: PointerEvent) => {
      const next = sideAt(ev.clientX);
      if (next !== side) { side = next; setPaneDrag({ pane, side }); }
    };
    const up = () => {
      setPaneDrag(null);
      const coach = pane === "coach" ? side : side === "left" ? "right" : "left";
      setCoachSide(coach);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const coachOnLeft = coachSide === "left";

  // The chat composer: under the transcript in the full view, and under the
  // overlay or the strip under the camera when T (or Chat) shows it there, so
  // a question can be typed, sources switched or Respond pressed without
  // leaving the compact view mid-call.
  const inputBar = (
        <div style={{ padding: "10px 12px", background: "rgba(var(--base-rgb),0.45)", flexShrink: 0 }}>
          {/* Auto Answer toggle + pause tolerance + Answer for waiting turns */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, rowGap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {/* One switch per side: what they say, and what you say. */}
            <span className="auto-answer-sides" role="group" aria-label="Auto Answer">
              <Zap size={12} strokeWidth={2.2} aria-hidden />
              <span className="auto-answer-label">Auto Answer</span>
              <button
                onClick={() => setAutoAnswer(a => !a)}
                className="auto-answer-toggle"
                data-on={autoAnswer}
                aria-pressed={autoAnswer}
                title={autoAnswer
                  ? `On: the coach answers ${themLabel.toLowerCase()} as soon as they finish (after the pause you set)`
                  : `Off: what ${themLabel.toLowerCase()} say waits for you. Press Answer or R`}
              >
                {themLabel} {autoAnswer ? "On" : "Off"}
              </button>
              <button
                onClick={() => setAutoAnswerYou(a => !a)}
                className="auto-answer-toggle"
                data-on={autoAnswerYou}
                aria-pressed={autoAnswerYou}
                title={autoAnswerYou
                  ? "On: the coach answers you as soon as you finish (after the pause you set)"
                  : "Off: what you say waits for you. Press Answer or Shift+R"}
              >
                You {autoAnswerYou ? "On" : "Off"}
              </button>
            </span>
            {/* How long a pause means "they've finished" (live capture) */}
            <div className="pause-tolerance" title="How long someone can pause mid-question before the coach answers. Choose Patient or Very patient for slow or thoughtful speakers.">
              <span>Wait for pauses</span>
              <GlassSelect
                options={PAUSE_TOLERANCES.map(p => ({ id: p.id, label: p.label }))}
                value={pauseTolerance}
                onChange={id => setPauseTolerance(id as PauseToleranceId)}
                style={{ minWidth: 150 }}
              />
            </div>
            {(autoAnswer || autoAnswerYou) && autoPaused && (
              <span className="auto-paused" role="status">
                Paused — too many answers
                <button
                  onClick={() => { autoCallsRef.current = []; setAutoPaused(false); }}
                  title="Resume answering automatically"
                >
                  Resume
                </button>
              </span>
            )}
            {waiting.length > 0 && (
              <button
                className="btn-primary"
                style={{ padding: "6px 14px", fontSize: 12, marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}
                onClick={() => { const next = latest(waiting); if (next) answerWaiting(next); }}
                title="Answer the most recent waiting turn (G or Enter). R answers theirs, Shift+R yours."
              >
                Answer{waiting.length > 1 ? ` latest (${waiting.length} waiting)` : ""} →
                <span className="kbd">G</span>
              </button>
            )}
          </div>
          <div className={`composer ${dropping ? "dropping" : ""}`}
               onDragOver={e => { if (pictureIn(e.dataTransfer)) { e.preventDefault(); setDropping(true); } }}
               onDragLeave={() => setDropping(false)}
               onDrop={e => {
                 const picture = pictureIn(e.dataTransfer);
                 setDropping(false);
                 if (picture) { e.preventDefault(); void attach(picture); }
               }}>
          {attached && (
            <div className="composer-picture">
              <img src={attached.dataUrl} alt="" onClick={() => setLightbox(attached.dataUrl)} title="Click to enlarge" />
              <span className="composer-picture-name" title={attached.file.name}>
                {attached.file.name}
                <small>{sizeLabel(attached.file.size)}</small>
              </span>
              <button type="button" className="composer-picture-drop" onClick={() => setAttached(null)}
                      title="Take the picture off">
                <X size={13} />
              </button>
            </div>
          )}
          <textarea
            ref={textRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              typedAtRef.current = Date.now();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // A picture waiting to go is what Enter sends, with whatever
                // was typed beside it as the question.
                if (attached)                    void sendPicture();
                else if (e.metaKey || e.ctrlKey) handleSubmit("interviewer");
                else                             handleSubmit("user");
              }
            }}
            onPaste={e => {
              const picture = pictureIn(e.clipboardData);
              if (picture) { e.preventDefault(); void attach(picture); }
            }}
            placeholder={attached
              ? "Ask about the picture… (Enter to send)"
              : "Paste or type transcript… (Enter = You, ⌘/Ctrl+Enter = They said, Shift+Enter = new line)"}
            rows={2}
            className="glass-input composer-input"
            style={{ resize: "none" }}
          />
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
                 onChange={e => { void attach(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          <button
            type="button"
            className="composer-attach"
            onClick={() => fileRef.current?.click()}
            onMouseDown={e => e.preventDefault()}
            disabled={attaching || screenBusy}
            title="Send a picture — a diagram, a chart, a photo of a whiteboard. You can also paste or drop one here."
          >
            {attaching ? <Loader2 size={13} className="spin" /> : <ImagePlus size={13} />}
          </button>
          <button
            type="button"
            className="respond-btn"
            // With text in the box it sends it as yours, like Enter; otherwise it
            // answers what they said, or what you said with Shift held.
            onClick={e => attached ? void sendPicture()
              : text.trim() ? handleSubmit("user", true)
              : respondTo(e.shiftKey ? "user" : "interviewer")}
            onMouseDown={e => e.preventDefault()}
            title={attached ? "Ask the coach about this picture"
                   : isLecture ? "Explain the last part of the lecture in plain words (R)"
                   : text.trim() ? "Send what you typed as yours (Enter)"
                   : `Answer what ${themLabel.toLowerCase()} said (R). Shift+R, or Shift-click, answers what you said.`}
          >
            <CornerDownLeft size={12} strokeWidth={2.4} />
            {attached ? "Ask about it" : isLecture ? "Explain this" : "Respond"}
            {!attached && <span className="kbd">R</span>}
          </button>
          </div>
          <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>

            {/* How many free live sessions are left, before the call rather
                than after it: nobody should discover the limit mid-interview. */}
            {licence.enforced && !licence.licence.is_pro && !liveMode && (
              <button
                className="btn-ghost"
                style={{ padding: "8px 10px", fontSize: 12, opacity: 0.9 }}
                onClick={() => showUpgrade("live")}
                title="What iReliabee Pro adds"
              >
                {licence.free_live_sessions.left > 0
                  ? `${licence.free_live_sessions.left} free live session${licence.free_live_sessions.left === 1 ? "" : "s"} left`
                  : "Live needs Pro"}
              </button>
            )}

            {/* Auto — turn on both at once */}
            <button
              className={micOn && sysOn ? "btn-danger" : "btn-ghost"}
              style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 4 }}
              onClick={() => listenTo(both({ mic: micOn, system: sysOn }))}
              title="Auto — capture both sources, whichever speaks (A)"
            >
              Auto
              <span className="kbd">A</span>
            </button>

            {/* You — mic input (your voice going into the PC) */}
            <button
              className={micOn ? (micActive ? "btn-danger" : "btn-primary") : "btn-ghost"}
              style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 6, opacity: micOn ? 1 : 0.85 }}
              onClick={() => toggleSource("mic")}
              title={micOn ? (sysOn ? "Listen to your mic only (Y)" : "Stop your mic (Y)")
                           : sysOn ? `Switch from ${themLabel.toLowerCase()} to your mic (Y)`
                           : "Capture your mic — you speaking (Y)"}
            >
              {micOn ? <MicOff size={13} /> : <Mic size={13} />}
              You
              {micOn && micActive && <span className="pulse-dot" />}
              <span className="kbd">Y</span>
            </button>

            {/* Interviewer — system audio output (their voice from your speakers) */}
            <button
              className={sysOn ? (sysActive ? "btn-danger" : "btn-primary") : "btn-ghost"}
              style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 6, opacity: sysOn ? 1 : 0.85 }}
              onClick={() => toggleSource("system")}
              title={sysOn ? (micOn ? `Listen to ${themLabel.toLowerCase()} only (L)` : "Stop system audio (L)")
                           : micOn ? `Switch from your mic to ${themLabel.toLowerCase()} (L)`
                           : `Capture system audio — ${themLabel.toLowerCase()} voice (L)`}
            >
              <Headphones size={13} />
              {themLabel}
              {sysOn && sysActive && <span className="pulse-dot" />}
              <span className="kbd">L</span>
            </button>

            {/* What each side actually sounds like. Only while listening, and
                only for the sides being listened to: a meter for something
                switched off is a meter that says nothing. */}
            {(micOn || sysOn) && (
              <div className="hearing-row">
                {micOn && <LevelMeter label="You" which="mic" on={micOn} level={levels.mic} />}
                {sysOn && <LevelMeter label={themLabel} which="system" on={sysOn} level={levels.system} />}
              </div>
            )}

            {/* Sound — the microphone, and which output to listen to. An icon
                and a panel, the way an operating system does it: the two
                dropdowns were each as wide as a device name and always there,
                for a choice almost nobody makes twice. */}
            <button
              className={`btn-ghost sound-btn${capturing.stale || capturing.skipped.length ? " is-stale" : ""}`}
              style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 4 }}
              onClick={() => setSoundOpen(true)}
              title={capturing.stale
                ? `Not hearing the call. ${capturing.stale}`
                : capturing.devices.length
                  ? `Sound — hearing: ${capturing.devices.join(", ")}`
                  : "Sound — choose your microphone, and which output to listen to"}
            >
              <Volume2 size={14} />
              {(capturing.stale || capturing.skipped.length > 0) && <i className="hearing-warn">!</i>}
            </button>


            <div style={{ width: 1, height: 24, background: "rgba(var(--ink-rgb),0.06)", flexShrink: 0 }} />

            {/* Screen capture — opens the screen / window / tab picker */}
            <button
              className="btn-ghost"
              style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 4 }}
              onClick={() => setScreenPickerOpen(true)}
              title={lastScreenPick
                ? `Capture screen and ask coach — C captures ${lastScreenPick.label} again, Shift+C chooses`
                : "Capture screen and ask coach (C)"}
              disabled={screenBusy}
            >
              <Monitor size={14} />
              <span className="kbd">C</span>
            </button>

            {/* Extra context */}
            <button
              className="btn-ghost"
              style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 4 }}
              onClick={() => setContextOpen(true)}
              title="Inject extra context for the rest of the session (X)"
            >
              <Sparkles size={14} />
              {contextUpdates > 0 && (
                <span style={{ fontSize: 10, color: "var(--primary-hover)" }}>
                  {contextUpdates}
                </span>
              )}
              <span className="kbd">X</span>
            </button>

            {/* Text submit — Enter = You (default), this button = Interviewer */}
            <button
              className="btn-neutral"
              onClick={() => handleSubmit("interviewer")}
              style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 6 }}
              title={`Send the box as what ${themLabel.toLowerCase()} said (Ctrl/⌘+Enter). R answers them, Shift+R answers you.`}
            >
              <Type size={13} /> They said
              <span className="kbd">⌘↵</span>
            </button>

            {/* Clear the screen. The session stays (lib/liveGate.ts): dropping its
                id used to leave a live screen with no session behind it, and the
                next turn quietly made an untitled one. */}
            {turns.length > 0 && (
              <button className="btn-neutral" style={{ marginLeft: "auto", padding: "7px 12px", fontSize: 12 }}
                title="Clear the screen and start the coach's memory afresh. What was said stays saved in this session."
                onClick={() => {
                  assembler.reset();
                  inflightRef.current.forEach(c => c.abort());
                  inflightRef.current.clear();
                  setTurns([]); setHistory([]); setSectionIdx(0); setWaiting([]);
                  setHearing(null); setAnswering(null);
                }}>
                Clear
              </button>
            )}
          </div>
        </div>
  );

  const withChat = (view: JSX.Element) => (
    <div className="compact-shell">
      <div className="compact-view">{view}</div>
      {compactChat && <div className="compact-chat">{inputBar}</div>}
    </div>
  );

  if (compact === "camera") {
    return withChat(
      <CameraStrip
        reply={latestReply}
        loading={!!streamingId}
        heard={heardNow.text}
        heardLabel={heardNow.who === "you" ? "You" : themLabel}
        said={said}
        listening={isRecording}
        streaming={stt?.streaming ?? true}
        stats={micOn && isActive ? delivery.stats : null}
        onRespond={side => respondRef.current(side)}
        onOverlay={() => setCompactMode("overlay")}
        onExpand={() => setCompactMode(null)}
        onChat={() => setCompactChat(v => !v)}
      />
    );
  }
  if (compact) {
    return withChat(
      <CompactOverlay
        turns={coachTurns}
        loading={!!streamingId}
        heard={heardNow.text}
        heardLabel={heardNow.who === "you" ? "You" : themLabel}
        heardFromThem={heardNow.who === "them"}
        said={said}
        listening={isRecording}
        streaming={stt?.streaming ?? true}
        levels={levels}
        micOn={micOn}
        sysOn={sysOn}
        stats={micOn && isActive ? delivery.stats : null}
        onRespond={side => respondRef.current(side)}
        // Capture the remembered target straight away. The picker only renders
        // in the full view, so when there is nothing to re-capture we have to
        // go there first — otherwise the button sets state and nothing appears.
        onScreenshot={() => {
          if (lastScreenPick) screenHotkeyRef.current(false);
          else { setCompactMode(null); setScreenPickerOpen(true); }
        }}
        onChat={() => setCompactChat(v => !v)}
        onToggleMic={() => toggleSource("mic")}
        onToggleSys={() => toggleSource("system")}
        // Leave the overlay on the way out: the recap and debrief that ending a
        // session produces are part of the full view.
        onEnd={() => { endSession(); setCompactMode(null); }}
        onCamera={() => setCompactMode("camera")}
        onExpand={() => setCompactMode(null)}
      />
    );
  }

  return (
    <div ref={splitRef} className={`session-view ${resizing ? "resizing" : ""} ${paneDrag ? "pane-dragging" : ""}`}
      style={{ display: "flex", height: "100%", overflow: "hidden", position: "relative" }}>

      {/* ── Transcript: controls + transcript ─────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", flex: `0 0 ${split * 100}%`, minWidth: 0, overflow: "hidden", order: coachOnLeft ? 2 : 0 }}>

        {/* Setup bar */}
        <div className="session-bar" style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", flexShrink: 0, flexWrap: "wrap" }}>
          <button className="pane-grip" onPointerDown={e => startPaneDrag("transcript", e)}
            onDoubleClick={() => setCoachSide(s => s === "left" ? "right" : "left")}
            title="Drag to move the transcript to the other side (double-click to swap)" aria-label="Move transcript pane">
            <GripVertical size={14} />
          </button>
          <button className="btn-neutral" style={{ padding: "6px 12px", fontSize: 12 }} onClick={() => setShowPrefs(true)}>
            <Sliders size={13} /> Preferences
          </button>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>
            {TEMPLATES.find(t => t.id === template)?.label}
            {" · "}<EngineMark hearing={hearing} answering={answering} listening={micOn || sysOn} />
            {aiInstructions && <span style={{ color: "var(--primary-hover)", marginLeft: 6 }}>· custom instructions</span>}
          </span>

          {/* Section badge */}
          {currentSection && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--primary-hover)", marginLeft: 4 }}>
              <span style={{ color: "var(--muted)" }}>§{sectionIdx + 1}</span>
              <span style={{ color: "var(--text)" }}>{currentSection.title}</span>
              {sections.length > sectionIdx + 1 && (
                <button className="btn-neutral" style={{ padding: "2px 8px", fontSize: 11 }}
                  onClick={() => setSectionIdx(i => i + 1)}>
                  <ChevronRight size={11} /> Next
                </button>
              )}
            </div>
          )}

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            {/* The owner runs on their own keys and spends no credits. */}
            {!admin && <LiveTimeLeft live={liveMode && !paused} />}
            {sessionId != null && (
              <>
                <button
                  className={saved ? "btn-primary" : "btn-neutral"}
                  style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}
                  onClick={saveSession}
                  disabled={savingSession}
                  title="Save this session so it's kept in the list (⌘/Ctrl+S)"
                >
                  <Save size={12} /> {saved ? "Saved" : (savingSession ? "Saving…" : "Save")}
                </button>
                <button
                  className={paused ? "btn-primary" : "btn-neutral"}
                  style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}
                  onClick={paused ? resumeSession : pauseSession}
                  title={paused ? "Resume listening" : "Pause: stop listening and coaching until you resume"}
                >
                  {paused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}
                </button>
                <button
                  className="btn-neutral"
                  style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}
                  onClick={endSession}
                  title="End session"
                >
                  <Square size={11} /> End
                </button>
              </>
            )}
            <button className="btn-neutral" style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}
              onClick={() => setShowPlan(p => !p)}
              title="Toggle plan panel (P)">
              <BookOpen size={13} /> {showPlan ? "Hide plan" : "Plan"}
              <span className="kbd">P</span>
            </button>
            <button className="btn-neutral" style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}
              onClick={() => toggleCompact("overlay")}
              title="Shrink into a small always-on-top overlay (O)">
              <Minimize2 size={13} /> Compact
              <span className="kbd">O</span>
            </button>
            <button className="btn-neutral" style={{ padding: "5px 10px", fontSize: 12, display: "flex", alignItems: "center", gap: 5 }}
              onClick={() => toggleCompact("camera")}
              title="Dock a thin strip right under your webcam: reading it looks close to eye contact on video calls (E)">
              <Camera size={13} /> Under camera
              <span className="kbd">E</span>
            </button>
          </div>
        </div>

        {notebookRelay && !sessionFallback && relayListening === false && (
          <div className="relay-companion-warning" style={{ margin: "6px 12px 0", padding: "8px 12px", borderRadius: 6, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", color: "var(--text)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AlertTriangle size={14} style={{ color: "#ef4444", flexShrink: 0 }} />
              <span>{relayAuto?.enabled
                ? `Claude Code can't be started${relayAuto.last_error ? ` (${relayAuto.last_error.replace(/\.$/, "")})` : ""}: live answers will fail unless you switch to iReliabee's AI.`
                : "Your AI assistant isn't listening — live answers will fail unless it's started or you switch to iReliabee's AI."}</span>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button className="btn-primary" style={{ padding: "4px 10px", fontSize: 11 }} onClick={enableSessionFallback}>
                Use iReliabee's AI for this call
              </button>
            </div>
          </div>
        )}

        {notebookRelay && !sessionFallback && relayIssue && relayListening !== false && (
          <div className="relay-companion-warning" style={{ margin: "6px 12px 0", padding: "8px 12px", borderRadius: 6, fontSize: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, background: "rgba(245, 158, 11, 0.1)", border: "1px solid rgba(245, 158, 11, 0.3)", color: "var(--text)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <AlertTriangle size={14} style={{ color: "#f59e0b", flexShrink: 0 }} />
              <span>{relayAuto?.enabled
                ? "Claude Code didn't answer in time. Try again on the turn, or use credits."
                : "Your assistant didn't answer in time or disconnected. Try again on the turn, or use credits."}</span>
            </div>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button className="btn-primary" style={{ padding: "4px 10px", fontSize: 11 }} onClick={enableSessionFallback}>
                Use iReliabee's AI for the rest of this call
              </button>
            </div>
          </div>
        )}

        {notebookRelay && sessionFallback && (
          <div className="relay-companion-fallback" style={{ margin: "6px 12px 0", padding: "6px 12px", borderRadius: 6, fontSize: 12, display: "flex", alignItems: "center", gap: 6, background: "rgba(34, 197, 94, 0.08)", border: "1px solid rgba(34, 197, 94, 0.25)", color: "var(--muted)" }}>
            <Sparkles size={13} style={{ color: "#22c55e", flexShrink: 0 }} />
            <span>Using iReliabee's AI for the rest of this call (assistant bypassed).</span>
          </div>
        )}

        {notebookRelay && !sessionFallback && !relayIssue && relayListening !== false && (
          <div className="relay-companion-notice" style={{ margin: "6px 12px 0", padding: "6px 12px", borderRadius: 6, fontSize: 12, display: "flex", alignItems: "center", gap: 6, background: "rgba(99, 102, 241, 0.08)", border: "1px solid rgba(99, 102, 241, 0.25)", color: "var(--muted)" }}>
            <Sparkles size={13} style={{ color: "var(--accent, #6366f1)", flexShrink: 0 }} />
            <span>Using your AI assistant — answers may take 5–15 seconds through your assistant.</span>
          </div>
        )}

        {paused && (
          <div className="paused-banner">
            <Pause size={14} />
            <span><strong>Paused</strong> — not listening or coaching. Paused time isn't counted.</span>
            <button className="btn-primary" onClick={resumeSession}><Play size={12} /> Resume</button>
          </div>
        )}

        {/* Recording indicator */}
        {isActive && (
          <div className="recording-indicator" style={{ margin: "10px 12px 0", flexShrink: 0 }}>
            <div className="rec-dot" />
            <span className="rec-label">{recStatusLabel[recState]}</span>
            {(isRecording) && (
              <div className="waveform">
                {Array.from({ length: 20 }, (_, i) => (
                  <span key={i} className="wave-bar" style={{ animationDelay: `${i * 0.065}s` }} />
                ))}
              </div>
            )}
            <button onClick={closeAudioWs} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--muted)", cursor: "pointer", display: "flex", alignItems: "center", padding: 0 }}>
              <X size={14} />
            </button>
          </div>
        )}
        {isActive && micOn && <div style={{ margin: "8px 12px 0", flexShrink: 0 }}><DeliveryBar stats={delivery.stats} /></div>}

        {/* Transcript feed */}
        <div ref={transcriptScroll.ref} style={{ flex: 1, overflowY: "auto", overflowX: "hidden", padding: "14px 16px" }}>
          {turns.length === 0 && (
            <div className="session-empty">
              <Illustration name="listen" size={180} />
              <h3>{isLecture ? "Ready to record the lecture" : "Ready when you are"}</h3>
              <p>{isLecture
                ? <>Turn on <strong>{themLabel}</strong> for a lecture playing on this computer, or <strong>You</strong> to record the room with your mic. The coach stays quiet until you press <strong>Explain this</strong>; when you end, the lecture becomes notes, flashcards and a quiz.</>
                : <>Turn on <strong>{themLabel}</strong> to hear the call, <strong>You</strong> for your mic, or type a question below.</>}</p>
              <div className="session-empty-keys">
                <span><span className="kbd">L</span> {themLabel} audio</span>
                <span><span className="kbd">Y</span> Your mic</span>
                <span><span className="kbd">R</span> {isLecture ? "Explain this" : `Answer ${themLabel.toLowerCase()}`}</span>
                {!isLecture && <span><span className="kbd">⇧R</span> Answer you</span>}
                <span><span className="kbd">O</span> Compact overlay</span>
                <span><span className="kbd">E</span> Under the camera</span>
              </div>
              <button className="practice-crosslink" onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "warmup" }))}>
                Nervous? Take a two-minute voice warm-up first →
              </button>
            </div>
          )}

          {turns.map(turn => {
            const isYou = turn.speaker === "user";
            return (
              <div key={turn.id} className={`turn-row ${isYou ? "align-right" : "align-left"}`}>
                <div className="turn-meta">
                  <span className={`badge-name ${isYou ? "you" : "them"}`}>
                    {isYou ? "You" : themLabel}
                  </span>
                  {!isYou && !isLecture && (turn.turnType
                    ? <span className="badge-question">{turn.turnType.toUpperCase()}</span>
                    : turn.isQuestion && <span className="badge-question">Question</span>
                  )}
                  {turn.ts && <span className="badge-time">{formatTime(turn.ts)}</span>}
                </div>
                {turn.screenshot ? (
                  <div className={`transcript-bubble screen ${isYou ? "you" : "them"}`}>
                    <img src={turn.screenshot} alt={turn.screenLabel ?? "screen capture"}
                      onClick={() => setLightbox(turn.screenshot!)} title="Click to enlarge" />
                    <div className="screen-caption">
                      <Monitor size={12} />
                      {turn.loading ? `Analysing ${turn.screenLabel}…` : turn.screenLabel}
                    </div>
                    {turn.screenQuestion && <div className="screen-question">{turn.screenQuestion}</div>}
                  </div>
                ) : (
                  <div className={`transcript-bubble ${isYou ? "you" : "them"} ${turn.assembling ? "assembling" : ""}`}>
                    {turn.transcript}
                    {/* Words still being transcribed join the bubble they belong to */}
                    {turn.assembling && livePartial && livePartialSpeaker === turn.speaker && (
                      <span className="partial-tail"> {livePartial}</span>
                    )}
                  </div>
                )}
                {turn.assembling && (
                  <div className="assembling-status">
                    <span className="assembling-pulse" />
                    {turn.superseded ? "They kept talking — waiting for them to finish" : "Waiting for them to finish"}
                    <button onClick={() => respondRef.current(turn.speaker)}
                      title={`Don't wait for the pause — answer now (${turn.speaker === "user" ? "Shift+R" : "R"})`}>
                      Answer now <span className="kbd">{turn.speaker === "user" ? "⇧R" : "R"}</span>
                    </button>
                  </div>
                )}
                {turn.answeredOnScreen && !turn.waiting && !turn.reply && (
                  <div className="assembling-status">Answered from the screenshot</div>
                )}
                {turn.waiting && !turn.loading && (
                  <div className="assembling-status waiting-status">
                    {autoPaused ? "Auto Answer paused — waiting for you" : "Finished — waiting for you (Auto Answer is off)"}
                    <button
                      onClick={() => {
                        const item = waiting.find(w => w.id === turn.id);
                        if (item) answerWaiting(item);
                      }}
                      title="Ask the coach about this turn"
                    >
                      Answer {latestOf(waiting, turn.speaker)?.id === turn.id && <span className="kbd">{turn.speaker === "user" ? "⇧R" : "R"}</span>}
                    </button>
                  </div>
                )}
                {turn.loading && (
                  <div className="typing-dots" style={{ paddingLeft: 8, marginTop: 6 }}>
                    <span /><span /><span />
                  </div>
                )}
                {turn.failed && !turn.loading && failedNote(turn)}
              </div>
            );
          })}
          {livePartial && !(assemblingTurn && assemblingTurn.speaker === livePartialSpeaker) && (
            <div className={`turn-row ${liveMode ? "align-left" : "align-right"}`}>
              <div className="turn-meta">
                <span className={`badge-name ${livePartialSpeaker === "interviewer" ? "them" : "you"}`}>
                  {livePartialSpeaker === "interviewer" ? themLabel : "You"}
                </span>
                <span className="badge-time" style={{ color: "#10b981" }}>● live</span>
              </div>
              <div className={`transcript-bubble ${livePartialSpeaker === "interviewer" ? "them" : "you"} partial`}>
                {livePartial}
              </div>
            </div>
          )}
          {!transcriptScroll.stuck && <JumpToLatest onClick={transcriptScroll.scrollToBottom} />}
        </div>

        {inputBar}
      </div>

      {/* ── Divider: drag to resize, double-click to reset ─────────────── */}
      <div className="pane-divider" role="separator" aria-orientation="vertical" tabIndex={0}
        aria-valuenow={Math.round(split * 100)} aria-valuemin={10} aria-valuemax={90}
        aria-label="Resize transcript and coach panes"
        title="Drag to resize · double-click to reset"
        style={{ order: 1 }}
        onPointerDown={startResize}
        onDoubleClick={() => setSplit(0.5)}
        onKeyDown={nudgeSplit}
      />

      {/* ── Coach panel ───────────────────────────────────────────────── */}
      {/* Always shown. The plan used to take its place, and answers kept
          arriving where nobody could see them; now the plan sits above them. */}
      {(
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden", order: coachOnLeft ? 0 : 2 }}>
          {showPlan && (
            <div className="session-plan-strip" style={{
              maxHeight: "42%", overflowY: "auto", flexShrink: 0,
              borderBottom: "1px solid var(--border)", background: "rgba(var(--base-rgb),0.40)",
            }}>
              <PlanPanel plan={plan} onSelect={setPlan} sectionIdx={sectionIdx} onSectionChange={setSectionIdx} />
            </div>
          )}
          <div className="session-bar coach-bar" style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 14px", flexShrink: 0 }}>
            <button className="pane-grip" onPointerDown={e => startPaneDrag("coach", e)}
              onDoubleClick={() => setCoachSide(s => s === "left" ? "right" : "left")}
              title="Drag to move the coach to the other side (double-click to swap)" aria-label="Move coach pane">
              <GripVertical size={14} />
            </button>
            <BrainCircuit size={14} strokeWidth={1.8} style={{ color: "var(--primary-hover)" }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--primary-hover)" }}>Coach</span>
            {turns.some(t => t.loading) && (
              <div className="typing-dots" style={{ marginLeft: 4 }}>
                <span /><span /><span />
              </div>
            )}
          </div>
          <div ref={coachScroll.ref} className="session-coach-scroll" style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
            {!hasAnyReply && (
              <div className="session-empty coach">
                <Illustration name="coach" size={180} />
                <h3>{isLecture ? "Your tutor is on standby" : "Your coach is listening"}</h3>
                <p>{isLecture
                  ? "It stays quiet while the lecture is recorded. Press Explain this (R) when something's unclear: you'll get the key ideas and a plain-language explanation of the last few minutes."
                  : "When a question comes in you'll get three cues, a short answer and a full answer — based on your profile, CV and plan."}</p>
              </div>
            )}
            {coachCards.map((t, i) => {
              const streaming = !!t.partialReply;
              // The speaker carried on: this answer covers only the first part
              // and is replaced as soon as the answer to the whole question streams.
              const stale = !streaming && !!t.superseded;
              const isLatest = i === coachCards.length - 1;
              return (
              <div key={t.id} className={`session-coach-card ${isLatest ? "latest" : ""} ${streaming ? "streaming" : ""} ${stale ? "superseded" : ""}`}>
                <div className="session-coach-head" style={{
                  fontSize: 11, fontWeight: 600, letterSpacing: "0.06em",
                  color: t.speaker === "user" ? "var(--primary-hover)" : "var(--yellow)",
                  display: "flex", alignItems: "center", gap: 6,
                }}>
                  <span>{t.speaker === "user" ? "YOU" : isLecture ? "EXPLAINED" : themLabel.toUpperCase()}</span>
                  {t.turnType && !isLecture && (
                    <span style={{
                      color: "var(--tone-amber)", background: "rgba(245,158,11,0.12)",
                      padding: "1px 6px", borderRadius: 3, fontSize: 9,
                    }}>{t.turnType.toUpperCase()}</span>
                  )}
                  {t.ts && (
                    <span style={{ color: "var(--muted)", fontWeight: 500, letterSpacing: "0.02em", textTransform: "none", opacity: 0.7 }}>
                      · {formatTime(t.ts)}
                    </span>
                  )}
                  {streaming && <span className="coach-card-status">COACHING…</span>}
                  {stale && <span className="coach-card-status">UPDATING — THEY KEPT TALKING</span>}
                  {!streaming && t.incomplete && (
                    <span className="coach-card-status cut-off">CUT OFF — NOT SAVED</span>
                  )}
                  <ToneBadge tone={t.tone ?? (streaming ? responseTone : undefined)} />
                </div>
                <div className="session-coach-q">
                  {t.screenshot && (
                    <img src={t.screenshot} alt="" onClick={() => setLightbox(t.screenshot!)} title="Click to enlarge"
                      style={{ display: "block", maxHeight: 72, maxWidth: 180, borderRadius: 6, marginBottom: 6, cursor: "zoom-in", background: "var(--base)" }} />
                  )}
                  {(() => {
                    const tr = translatedTurn(t.transcript, translations);
                    const cut = (s: string) => (s.length > 240 ? s.slice(0, 240) + "…" : s);
                    if (!tr) return cut(t.transcript);
                    return <>
                      <span className="caption-translation" onClick={() => setShowOriginals(true)}
                        title={showOriginals ? undefined : "Show what was said"}>{cut(tr)}</span>
                      {showOriginals && <span className="caption-original" lang={language} onClick={() => setShowOriginals(false)}
                        title="What was said. Click to hide originals">{cut(t.transcript)}</span>}
                    </>;
                  })()}
                </div>
                {(t.partialReply || t.reply) && <CoachPanel reply={t.partialReply || t.reply!}
                  sayIn={displayLanguage && displayLanguage !== language && language !== "multi" && t.reply && !t.partialReply ? {
                    language: LANGUAGES.find(l => l.id === language)?.english ?? language,
                    fetch: () => fetchApi("/coach/say-in", { method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ text: t.reply, session_id: sessionId, language }) })
                      .then(async r => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()).text as string; }),
                  } : undefined} />}
                {t.failed && !t.loading && failedNote(t)}
              </div>
              );
            })}
            {(() => {
              // Likely next is a paid prediction too: only for your turns that went to the coach, never one
              // waiting because Auto Answer is off (owner, 30 Sep 2026: it answered with both switches off).
              const lastYou = [...turns].reverse().find(t => t.speaker === "user" && !t.waiting && !t.assembling);
              if (!lastYou) return null;
              return (
                <div style={{ paddingBottom: 10 }}>
                  <FollowupCard
                    triggerKey={`${lastYou.id}:${lastYou.transcript.length}`}
                    lines={turns.map(t => ({ speaker: t.speaker === "user" ? "you" : "interviewer", text: t.transcript }))}
                  />
                </div>
              );
            })()}
            {!coachScroll.stuck && (
              <JumpToLatest onClick={coachScroll.scrollToBottom}
                label={streamingId != null ? "New answer coming in" : "Jump to latest"} />
            )}
          </div>
        </div>
      )}

      {/* Drop preview while dragging a pane */}
      {paneDrag && (
        <div className="pane-drop-overlay" style={{ order: 3 }}>
          <div className={`pane-drop-target ${paneDrag.side}`}>
            {paneDrag.pane === "coach" ? <BrainCircuit size={18} /> : <Mic size={18} />}
            Drop to put the {paneDrag.pane === "coach" ? "coach" : "transcript"} on the {paneDrag.side}
          </div>
        </div>
      )}

      {soundOpen && (
        <SoundPicker
          inputs={audioDevices.inputs}
          outputs={audioDevices.outputs}
          micDevice={micDevice}
          sysDevice={sysDevice}
          onMic={id => { setMicDevice(id); if (recState !== "idle") toast("Applies to the next session"); }}
          onSys={id => { setSysDevice(id); if (recState !== "idle") toast("Applies to the next session"); }}
          capturing={capturing}
          micCapturing={micCapturing}
          levels={levels}
          micOn={micOn}
          sysOn={sysOn}
          live={recState !== "idle"}
          themLabel={themLabel}
          onClose={() => setSoundOpen(false)}
        />
      )}

      {screenPickerOpen && (
        <ScreenPicker
          lastPick={lastScreenPick}
          onPick={captureTarget}
          onClose={() => setScreenPickerOpen(false)}
          onLegacy={mode => { setScreenPickerOpen(false); captureScreen(mode); }}
        />
      )}

      {regionFor && (
        <RegionSelector
          preview={regionFor.preview}
          width={regionFor.width}
          height={regionFor.height}
          label={regionFor.label}
          onCancel={() => setRegionFor(null)}
          onDone={(region, cropped) => {
            const r = regionFor;
            setRegionFor(null);
            analyzeCapture(r.captureId, cropped, r.label, region);
          }}
        />
      )}

      {lightbox && (
        <div className="screen-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="screen capture" />
        </div>
      )}

      {screenPreview && (
        <div
          onClick={() => setScreenPreview(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 500,
            background: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 560, maxWidth: "calc(94 * var(--vw))",
              background: "rgba(var(--base-rgb),0.98)", borderRadius: 14,
              padding: "20px 22px", display: "flex", flexDirection: "column", gap: 12,
              boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Analyse screen</div>
              <button onClick={() => setScreenPreview(null)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
                <X size={15} />
              </button>
            </div>
            <img src={screenPreview.dataUrl} alt="capture" style={{ width: "100%", maxHeight: 260, objectFit: "contain", borderRadius: 6, background: "#000" }} />
            <textarea
              className="glass-input"
              rows={2}
              placeholder="What do you want the coach to do with this? (empty = default analysis)"
              value={screenPreview.prompt}
              onChange={e => setScreenPreview(p => p ? { ...p, prompt: e.target.value } : null)}
              autoFocus
              style={{ resize: "vertical" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn-neutral" style={{ padding: "8px 16px" }} onClick={() => setScreenPreview(null)} disabled={screenBusy}>
                Cancel
              </button>
              <button className="btn-primary" style={{ padding: "8px 18px" }} onClick={submitScreen} disabled={screenBusy}>
                {screenBusy ? "Analysing…" : "Analyse"}
              </button>
            </div>
          </div>
        </div>
      )}

      {contextOpen && (
        <div
          onClick={() => setContextOpen(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 500,
            background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 460, maxWidth: "calc(92 * var(--vw))",
              background: "rgba(var(--base-rgb),0.98)", borderRadius: 14,
              padding: "20px 22px", display: "flex", flexDirection: "column", gap: 10,
              boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>Inject extra context</div>
              <button onClick={() => setContextOpen(false)} style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}>
                <X size={15} />
              </button>
            </div>
            <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>
              Anything you note here is added to the coach's system prompt for every future turn in this session.
              e.g. "she just mentioned she was on the Anthropic team" or "change of plan — he wants architecture depth".
            </div>
            <div className="label-row">
              <AiSuggest<string> field="session.context" label="Extra context for the coach, from the call so far" length="long"
                form={() => ({
                  template: TEMPLATES.find(t => t.id === template)?.label ?? template,
                  ai_instructions: aiInstructions, context: contextDraft,
                  recent: turns.slice(-6).map(t => `${t.speaker === "user" ? "You" : themLabel}: ${t.transcript}`),
                })}
                onSuggest={text => setContextDraft(d => withSuggestion(d, text))} />
            </div>
            <textarea
              className="glass-input"
              rows={5}
              placeholder="Context to remember for the rest of this session…"
              value={contextDraft}
              onChange={e => setContextDraft(e.target.value)}
              autoFocus
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") saveContextUpdate(); }}
              style={{ resize: "vertical" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 10 }}>⌘/Ctrl+Enter to save · {contextUpdates} update{contextUpdates === 1 ? "" : "s"} so far</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn-neutral" style={{ padding: "7px 14px" }} onClick={() => setContextOpen(false)}>
                  Cancel
                </button>
                <button className="btn-primary" style={{ padding: "7px 16px" }} onClick={saveContextUpdate}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {recapFor && (
        <SessionHub sessionId={recapFor.id} title={recapFor.title}
          initialTab={recapFor.lecture ? "study" : "notes"} autoRecap={!recapFor.lecture}
          lecture={recapFor.lecture} autoStudy={recapFor.lecture}
          onClose={() => setRecapFor(null)} />
      )}

      {showPrefs && (
        <PreferencesModal
          templates={TEMPLATES}
          models={availableModels}
          languages={LANGUAGE_OPTIONS}
          cvs={availableCvs}
          documents={availableDocs}
          template={template}
          model={model}
          language={language}
          displayLanguage={displayLanguage}
          aiInstructions={aiInstructions}
          responseTone={responseTone}
          cvId={cvId}
          documentIds={documentIds}
          peopleIds={peopleIds}
          onChange={patch => {
            if (patch.template !== undefined)       setTemplate(patch.template);
            if (patch.model !== undefined)          setModel(patch.model);
            if (patch.language !== undefined)       setLanguage(patch.language);
            if (patch.displayLanguage !== undefined) setDisplayLanguage(patch.displayLanguage);
            if (patch.aiInstructions !== undefined) setAIInstructions(patch.aiInstructions);
            if (patch.responseTone !== undefined)   setResponseTone(patch.responseTone);
            if (patch.cvId !== undefined)           setCvId(patch.cvId);
            if (patch.documentIds !== undefined)    setDocumentIds(patch.documentIds);
            if (patch.peopleIds !== undefined)      setPeopleIds(patch.peopleIds);
          }}
          onClose={() => setShowPrefs(false)}
        />
      )}
    </div>
  );
}
