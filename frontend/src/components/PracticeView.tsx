import { useEffect, useState } from "react";
import { GraduationCap, Lightbulb, Presentation, Wind, Layers, History, MessagesSquare } from "lucide-react";
import StudyView from "./StudyView";
import RetryView from "./RetryView";
import MockInterviewView from "./MockInterviewView";
import DrillsView from "./DrillsView";
import PresentationView from "./PresentationView";
import WarmupView from "./WarmupView";
import TalkView from "./TalkView";
import { practiceModes, type PracticeMode } from "../lib/persona";
import { track } from "../lib/usage";
import Page, { PageTab } from "./Page";

const MODES: Record<Exclude<PracticeMode, "warmup">, { label: string; hint: string; icon: JSX.Element }> = {
  mock:    { label: "Mock conversation", hint: "Interviews, vivas, meetings, pitches — scored with stronger answers", icon: <GraduationCap size={14} /> },
  explain: { label: "Explain a topic",   hint: "The coach probes until your explanation holds up",               icon: <Lightbulb size={14} /> },
  script:  { label: "Check my script",   hint: "Timing and clarity feedback on a talk or slide notes",           icon: <Presentation size={14} /> },
  study:   { label: "Study",             hint: "Flashcards and quizzes from lectures you've recorded",           icon: <Layers size={14} /> },
  retry:   { label: "Hard moments",      hint: "Answer the questions that went badly in real calls again",       icon: <History size={14} /> },
  talk:    { label: "Talk at work",      hint: "Stand-ups, pushing back, bad news, 60-second talks, shorter messages", icon: <MessagesSquare size={14} /> },
};

const LAST_MODE_KEY = "practiceMode";

function isMode(v: unknown): v is PracticeMode {
  return v === "mock" || v === "explain" || v === "script" || v === "warmup" || v === "study" || v === "retry" || v === "talk";
}

function initialMode(section?: string): PracticeMode {
  if (isMode(section)) return section;
  try {
    const saved = localStorage.getItem(LAST_MODE_KEY);
    if (isMode(saved) && saved !== "warmup") return saved;
  } catch { /* ignore */ }
  return practiceModes()[0];
}

/**
 * One place to practise (roadmap 1.4): mock conversations, explaining a topic
 * and checking a script, with a two-minute warm-up before any of them. Modes
 * are ordered for the user's persona; `section` opens a specific one (old
 * links to Rehearse, Explain Clearly, Presentation and Warm-up land here).
 */
export default function PracticeView({ section }: { section?: string }) {
  const [mode, setMode] = useState<PracticeMode>(() => initialMode(section));

  useEffect(() => {
    track(`practice.mode.${mode}`);
    if (mode !== "warmup") try { localStorage.setItem(LAST_MODE_KEY, mode); } catch { /* ignore */ }
  }, [mode]);

  // Other screens ask for a mode ("Check your script first" in a speaking scenario).
  useEffect(() => {
    const h = (e: Event) => { const m = (e as CustomEvent).detail; if (isMode(m)) setMode(m); };
    window.addEventListener("practice-mode", h);
    return () => window.removeEventListener("practice-mode", h);
  }, []);

  return (
    <Page
      title="Practice"
      subtitle="Rehearse out loud before the real thing — every round is scored and tracked in Progress."
      tabs={<>
        {practiceModes().map(id => (
          <PageTab key={id} active={mode === id} title={MODES[id].hint} icon={MODES[id].icon} onClick={() => setMode(id)}>
            {MODES[id].label}
          </PageTab>
        ))}
        <button className={`practice-warmup ${mode === "warmup" ? "active" : ""}`} onClick={() => setMode("warmup")}
          title="Loosen up your voice and pacing before you speak">
          <Wind size={13} /> Warm up · 2 min
        </button>
      </>}
    >
      {mode === "mock" && <MockInterviewView />}
      {mode === "explain" && <DrillsView />}
      {mode === "script" && <PresentationView />}
      {mode === "warmup" && <WarmupView />}
      {mode === "study" && <StudyView />}
      {mode === "retry" && <RetryView />}
      {mode === "talk" && <TalkView />}
    </Page>
  );
}
