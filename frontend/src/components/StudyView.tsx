import { useEffect, useState } from "react";
import { ArrowLeft, GraduationCap, Layers, ListChecks } from "lucide-react";
import { fetchApi } from "../lib/api";
import Illustration from "./Illustration";
import StudyPanel from "./session/StudyPanel";

interface Pack {
  session_id: number; title: string; created_at: string; flashcards: number; quiz: number;
  /** False for a lecture whose study pack hasn't been made yet: opening it offers to make it. */
  ready?: boolean;
  last_quiz: { score: number; total: number; at: string } | null;
}

const date = (iso: string) => new Date(iso + (iso.endsWith("Z") ? "" : "Z")).toLocaleDateString([], { month: "short", day: "numeric" });

/** Practice → Study (roadmap 3.1): flashcards and quizzes from recorded lectures. */
export default function StudyView() {
  const [packs, setPacks] = useState<Pack[] | null>(null);
  const [open, setOpen] = useState<Pack | null>(null);

  useEffect(() => {
    fetchApi("/notes/study").then(r => (r.ok ? r.json() : [])).then(setPacks).catch(() => setPacks([]));
  }, [open]);

  if (open) {
    return (
      <div className="page-content">
        <div className="plans-header">
          <div>
            <button className="btn-neutral plan-back" onClick={() => setOpen(null)}><ArrowLeft size={13} /> All lectures</button>
            <h2 style={{ marginTop: 8 }}>{open.title}</h2>
          </div>
        </div>
        <StudyPanel sessionId={open.session_id} startOn="cards" />
      </div>
    );
  }

  return (
    <div className="page-content">
      <div className="plans-header">
        <div>
          <h2>Study</h2>
          <p className="muted">Flashcards and quizzes from lectures you've recorded. Start a Live session with the <strong>Lecture companion</strong> template to add one.</p>
        </div>
      </div>
      {packs == null ? null : packs.length === 0 ? (
        <div className="glass-card plans-empty">
          <Illustration name="stories" />
          <div className="plans-empty-title">No lectures yet</div>
          <p className="muted">Record a lecture with the Lecture companion — it listens without interrupting, explains anything you ask about,
            and turns the whole lecture into notes, flashcards and a quiz.</p>
          <button className="btn-primary" onClick={() => window.dispatchEvent(new Event("start-new-session"))}>
            <GraduationCap size={14} /> Record a lecture
          </button>
        </div>
      ) : (
        <div className="card-grid">
          {packs.map(p => (
            <button key={p.session_id} className="glass-card person-card" onClick={() => setOpen(p)}>
              <span className="person-card-main">
                <strong>{p.title}</strong>
                <span className="muted">{date(p.created_at)}</span>
              </span>
              <span className="person-card-foot">
                {p.ready === false
                  ? <span className="muted study-meta">No study pack yet: open it to make one</span>
                  : <span className="muted study-meta"><Layers size={11} /> {p.flashcards} cards <ListChecks size={11} /> {p.quiz} questions</span>}
                {p.last_quiz && <span className="person-status done">Quiz {p.last_quiz.score}/{p.last_quiz.total}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
