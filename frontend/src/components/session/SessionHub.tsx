import { useEffect, useRef, useState } from "react";
import { X, MessageSquare, Sparkles, Gauge, FileText, Mail, Play, GraduationCap, NotebookPen } from "lucide-react";
import StudyPanel from "./StudyPanel";
import TranscriptPanel from "./TranscriptPanel";
import DebriefPanel from "./DebriefPanel";
import ConfidencePanel from "./ConfidencePanel";
import NotesPanel from "./NotesPanel";
import EmailPanel from "./EmailPanel";
import NotebookPanel from "./NotebookPanel";
import { track } from "../../lib/usage";
import { useDragHeight } from "../../lib/useDragHeight";
import HeightGrip from "../HeightGrip";

export type HubTab = "transcript" | "notebook" | "debrief" | "confidence" | "notes" | "email" | "study";

export const HUB_TABS: { id: HubTab; label: string; icon: JSX.Element; hint: string }[] = [
  { id: "transcript", label: "Transcript", icon: <MessageSquare size={13} />, hint: "What was said, with the coach's answers" },
  { id: "notebook",   label: "Notebook",   icon: <NotebookPen size={13} />,   hint: "Beautiful, editable notes from what was said" },
  { id: "debrief",    label: "Debrief",    icon: <Sparkles size={13} />,      hint: "Score, what landed, stronger answers" },
  { id: "confidence", label: "Confidence", icon: <Gauge size={13} />,         hint: "Structure, fillers, hedging, pace" },
  { id: "notes",      label: "Recap",      icon: <FileText size={13} />,      hint: "Summary, decisions, action items with due dates, and the recap email" },
  { id: "email",      label: "Follow-up",  icon: <Mail size={13} />,          hint: "Thank-you, follow-up or recap email" },
  { id: "study",      label: "Study",      icon: <GraduationCap size={13} />, hint: "Notes, flashcards and a quiz from a lecture" },
];
/** Tabs that make sense for a recorded lecture (roadmap 3.1). */
const LECTURE_TABS: HubTab[] = ["transcript", "notebook", "study", "notes"];

export function isHubTab(v: unknown): v is HubTab {
  return HUB_TABS.some(t => t.id === v);
}

/**
 * Everything about one past session in one place (roadmap 1.2): the transcript
 * and every report made from it. Each tab loads what's saved and generates on
 * request, exactly as the separate pages used to.
 */
export default function SessionHub({ sessionId, title, subtitle, initialTab = "transcript", themLabel, autoRecap = false, lecture = false, autoStudy = false, onClose, onResume }: {
  sessionId: number;
  title: string;
  subtitle?: string | null;
  initialTab?: HubTab;
  themLabel?: string;
  /** Write the recap straight away if there isn't one (a meeting just ended). */
  autoRecap?: boolean;
  /** A lecture: show transcript, study pack and recap only. */
  lecture?: boolean;
  /** Make the study pack straight away (a lecture just ended). */
  autoStudy?: boolean;
  onClose: () => void;
  onResume?: () => void;
}) {
  const [tab, setTab] = useState<HubTab>(initialTab);

  useEffect(() => { track(`session.hub.${tab}`); }, [tab]);

  // The window's height is the user's to choose (remembered on this device). It's
  // centred on screen, so its bottom edge moves half as far as it grows: factor 2.
  const panelRef = useRef<HTMLDivElement>(null);
  const { height: hubHeight, gripProps } = useDragHeight("hub.height", {
    min: 420, factor: 2, max: () => window.innerHeight - 56,
    start: () => panelRef.current?.getBoundingClientRect().height ?? 720,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="debrief-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="debrief-panel session-hub" role="dialog" aria-label={`Session: ${title}`} ref={panelRef}
        style={hubHeight ? { height: hubHeight } : undefined}>
        <header className="debrief-panel-head">
          <div style={{ minWidth: 0 }}>
            <div className="debrief-kicker">Session</div>
            <div className="debrief-title">{title}</div>
            {subtitle && <div className="muted session-hub-sub">{subtitle}</div>}
          </div>
          {onResume && (
            <button className="btn-neutral session-hub-resume" onClick={onResume} title="Open this session in Live Companion">
              <Play size={12} /> Resume
            </button>
          )}
          <button className="titlebar-btn" onClick={onClose} title="Close (Esc)"><X size={16} /></button>
        </header>

        <nav className="session-hub-tabs" role="tablist">
          {HUB_TABS.filter(t => (lecture ? LECTURE_TABS.includes(t.id) : t.id !== "study")).map(t => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} title={t.hint}
              className={`session-hub-tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              {t.icon} {t.label}
            </button>
          ))}
        </nav>

        <div className="debrief-panel-body session-hub-body" role="tabpanel">
          {tab === "transcript" && <TranscriptPanel sessionId={sessionId} themLabel={themLabel} sessionTitle={title} />}
          {tab === "notebook"   && <NotebookPanel sessionId={sessionId} lecture={lecture} />}
          {tab === "debrief"    && <DebriefPanel sessionId={sessionId} onLeave={onClose} />}
          {tab === "confidence" && <ConfidencePanel sessionId={sessionId} />}
          {tab === "notes"      && <NotesPanel sessionId={sessionId} autoGenerate={autoRecap} />}
          {tab === "email"      && <EmailPanel sessionId={sessionId} />}
          {tab === "study"      && <StudyPanel sessionId={sessionId} autoGenerate={autoStudy} />}
        </div>
        <HeightGrip label="Window height" className="session-hub-grip" {...gripProps} />
      </div>
    </div>
  );
}
