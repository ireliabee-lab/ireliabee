import { useState } from "react";
import { createPortal } from "react-dom";
import { Mic, Clock, BookOpen, User, Settings, Plus, FolderOpen, GraduationCap, LineChart, NotebookPen, RotateCw, StickyNote, FlaskConical, Languages, PenLine } from "lucide-react";
import ConfirmDialog from "./ConfirmDialog";
import { restartApp } from "../lib/restart";

export type View = "session" | "history" | "progress" | "practice" | "notebook" | "board" | "plans" | "about" | "library" | "settings" | "research" | "wordcraft" | "write";

interface Props {
  open: boolean;
  active: View;
  onNav: (v: View) => void;
  onNewSession: () => void;
  setup?: React.ReactNode;
}

const GROUPS: { label: string; items: { id: View; label: string; icon: React.ReactNode }[] }[] = [
  {
    label: "Live",
    items: [
      { id: "session", label: "Live Companion", icon: <Mic size={15} strokeWidth={1.8} /> },
      { id: "history", label: "Sessions",       icon: <Clock size={15} strokeWidth={1.8} /> },
      { id: "progress", label: "Progress",     icon: <LineChart size={15} strokeWidth={1.8} /> },
    ],
  },
  {
    label: "Prep",
    items: [
      { id: "practice",  label: "Practice",       icon: <GraduationCap size={15} strokeWidth={1.8} /> },
      { id: "wordcraft", label: "Wordcraft",      icon: <Languages size={15} strokeWidth={1.8} /> },
      { id: "plans",     label: "Plans",         icon: <BookOpen size={15} strokeWidth={1.8} /> },
      { id: "about",     label: "About you",     icon: <User size={15} strokeWidth={1.8} /> },
      { id: "library",   label: "Library",       icon: <FolderOpen size={15} strokeWidth={1.8} /> },
    ],
  },
  {
    // Where thinking is kept: what was said, and what is still being worked out.
    label: "Think",
    items: [
      { id: "notebook",  label: "Notebook",       icon: <NotebookPen size={15} strokeWidth={1.8} /> },
      { id: "board",     label: "Idea board",    icon: <StickyNote size={15} strokeWidth={1.8} /> },
      { id: "research",  label: "Research",      icon: <FlaskConical size={15} strokeWidth={1.8} /> },
      { id: "write",     label: "Write",         icon: <PenLine size={15} strokeWidth={1.8} /> },
    ],
  },
];

export default function Sidebar({ open, active, onNav, onNewSession, setup }: Props) {
  const [confirmRestart, setConfirmRestart] = useState(false);
  return (
    <div className={`sidebar ${open ? "" : "collapsed"}`}>
      {/* Zone 1 — Primary CTA */}
      <button className="sidebar-cta" onClick={onNewSession} title="Create a new session (N)">
        <Plus size={15} strokeWidth={2.4} />
        New Session
        <span className="kbd">N</span>
      </button>

      {/* Zone 2 — Grouped nav */}
      {GROUPS.map(group => (
        <div key={group.label} className="sidebar-group">
          <span className="sidebar-section-label">{group.label}</span>
          {group.items.map(item => (
            <button
              key={item.id}
              className={`sidebar-btn ${active === item.id ? "active" : ""}`}
              onClick={() => onNav(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ))}

      <div className="sidebar-spacer" />

      {/* Zone 3 — Account footer */}
      <div className="sidebar-footer">
        {setup}
        <div className="sidebar-settings-row">
          <button
            className={`sidebar-btn ${active === "settings" ? "active" : ""}`}
            onClick={() => onNav("settings")}
          >
            <Settings size={15} strokeWidth={1.8} />
            Settings
          </button>
          <button className="sidebar-btn sidebar-restart" onClick={() => setConfirmRestart(true)}
            title="Restart iReliabee" aria-label="Restart iReliabee">
            <RotateCw size={14} strokeWidth={1.8} />
          </button>
        </div>
        <div className="sidebar-version">iReliabee · v{__APP_VERSION__}</div>
      </div>
      {/* Portalled: the sidebar's backdrop filter would otherwise trap a fixed dialog inside it. */}
      {confirmRestart && createPortal(
        <ConfirmDialog message="Restart iReliabee?"
          detail="It closes and opens again in a few seconds, with a fresh start for the app and its background service. Anything still recording stops; your sessions, notes and notebooks are saved."
          confirmLabel="Restart" onCancel={() => setConfirmRestart(false)}
          onConfirm={() => { setConfirmRestart(false); void restartApp(); }} />,
        document.body,
      )}
    </div>
  );
}
