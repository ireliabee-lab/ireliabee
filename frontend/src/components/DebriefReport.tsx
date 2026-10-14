import { useState } from "react";
import toast from "react-hot-toast";
import ReactMarkdown from "react-markdown";
import { ChevronDown, FileDown, Loader2, MessageCircleQuestion, ListChecks, RotateCcw } from "lucide-react";
import { fetchApi } from "../lib/api";
import { errorFromResponse, notifyError } from "../lib/errors";
import ExamBands, { type ExamMeta, type ExamScore } from "./ExamBands";
import { practiseMoment } from "../lib/retry";

export interface QuestionFeedback {
  question: string;
  answer_summary: string;
  score: number;
  verdict: string;
  improvements: string[];
  better_answer: string;
}

export interface Debrief {
  overall_score: number;
  summary: string;
  strengths: string[];
  improvements: string[];
  questions: QuestionFeedback[];
  questions_to_ask?: string[];
  next_steps?: string[];
  generated_at?: string;
  session_title?: string;
  /** Speaking-test practice (roadmap 2.3): whole-test band scores. */
  exam?: ExamMeta & ExamScore;
}

export function scoreColor(score: number) {
  if (score >= 8) return "var(--success)";
  if (score >= 5) return "var(--warning)";
  return "var(--danger)";
}

export default function DebriefReport({ report, sessionId, subtitle }: { report: Debrief; sessionId: number | null; subtitle?: string }) {
  const [exporting, setExporting] = useState(false);

  async function exportPdf() {
    if (sessionId == null) return;
    setExporting(true);
    try {
      const res = await fetchApi(`/sessions/${sessionId}/debrief/export`, { method: "POST" });
      if (!res.ok) throw await errorFromResponse(res);
      const data = await res.json();
      toast.success(`Saved to ${data.path}`, { duration: 6000 });
    } catch (e: any) {
      notifyError(e);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="debrief">
      <div className="glass-card results-hero">
        <div className="score-ring" style={{ ["--score-color" as any]: scoreColor(report.overall_score), ["--pct" as any]: report.overall_score * 10 }}>
          <span>{report.overall_score}</span><small>/10</small>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{subtitle || report.session_title || "Interview debrief"}</div>
          <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--text)", marginTop: 4 }}>{report.summary}</p>
        </div>
        {sessionId != null && (
          <button className="btn-neutral debrief-export" onClick={exportPdf} disabled={exporting} title="Save this report as a PDF in Downloads">
            {exporting ? <Loader2 size={14} className="spin" /> : <FileDown size={14} />} PDF
          </button>
        )}
      </div>

      {report.exam && (
        <div className="glass-card" style={{ padding: 16 }}>
          <ExamBands meta={report.exam} score={report.exam} compact />
        </div>
      )}

      <div className="debrief-row">
        <BulletCard title="What landed" color="var(--success)" items={report.strengths} />
        <BulletCard title="Focus on next" color="var(--warning)" items={report.improvements} />
      </div>

      {report.questions.map((q, i) => <QuestionCard key={i} q={q} index={i} sessionId={sessionId ?? null} sessionTitle={report.session_title} />)}

      <div className="debrief-row">
        <BulletCard title="Questions you could have asked" color="var(--primary-hover)" items={report.questions_to_ask || []} icon={<MessageCircleQuestion size={13} />} />
        <BulletCard title="Next steps" color="var(--tone-blue)" items={report.next_steps || []} icon={<ListChecks size={13} />} />
      </div>
    </div>
  );
}

function BulletCard({ title, color, items, icon }: { title: string; color: string; items: string[]; icon?: React.ReactNode }) {
  if (!items.length) return null;
  return (
    <div className="glass-card" style={{ padding: 16, flex: "1 1 280px" }}>
      <div className="coach-section-label" style={{ color, display: "flex", alignItems: "center", gap: 6 }}>{icon}{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc", display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((s, i) => (
          <li key={i} style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text)" }}>
            <ReactMarkdown components={{ p: ({ children }) => <>{children}</> }}>{s}</ReactMarkdown>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QuestionCard({ q, index, sessionId, sessionTitle }: { q: QuestionFeedback; index: number; sessionId: number | null; sessionTitle?: string }) {
  const [open, setOpen] = useState(index === 0);
  return (
    <div className="glass-card" style={{ padding: 0, overflow: "hidden" }}>
      <button className="question-card-head" onClick={() => setOpen(o => !o)}>
        <span className="question-score" style={{ color: scoreColor(q.score), borderColor: scoreColor(q.score) }}>{q.score}</span>
        <span style={{ flex: 1, textAlign: "left" }}>{q.question}</span>
        <ChevronDown size={16} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
      </button>
      {open && (
        <div style={{ padding: "0 16px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <p className="muted" style={{ fontSize: 12 }}>You said: {q.answer_summary}</p>
          <p style={{ fontSize: 13, color: "var(--text)" }}>{q.verdict}</p>
          {q.improvements.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc" }}>
              {q.improvements.map((s, i) => <li key={i} style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text)" }}>{s}</li>)}
            </ul>
          )}
          <div>
            <div className="coach-section-label say">Stronger answer</div>
            <div className="coach-section-body markdown-body"><ReactMarkdown>{q.better_answer}</ReactMarkdown></div>
          </div>
          <button className="btn-neutral practise-again" onClick={() => practiseMoment({
            session_id: sessionId, session_title: sessionTitle, question: q.question, previous_answer: q.answer_summary,
            score: q.score, feedback: q.verdict, improvements: q.improvements, source: "debrief",
          })}>
            <RotateCcw size={12} /> Practise this again
          </button>
        </div>
      )}
    </div>
  );
}
