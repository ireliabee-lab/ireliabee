import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Loader2, FileText, Sparkles, RotateCw, CheckSquare, HelpCircle, Flag, Mail, Copy, Send, CalendarClock } from "lucide-react";
import { fetchApi } from "../../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../../lib/errors";
import { openExternal } from "../../lib/openExternal";
import { track } from "../../lib/usage";
import Illustration from "../Illustration";

interface Action { who: string; what: string; due?: string; }
interface Notes {
  summary: string;
  decisions: string[];
  action_items: Action[];
  open_questions: string[];
  email?: { subject: string; body: string };
  generated_at: string;
}

/** Action items as a checklist anyone can paste into chat, a doc or a task app. */
export function checklist(items: Action[]): string {
  return items.map(a => `- [ ] ${a.what} — ${a.who}${a.due ? ` (due ${a.due})` : ""}`).join("\n");
}

async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); toast.success(`${what} copied`); }
  catch { toast.error("Couldn't copy — select the text and copy it instead"); }
}

/**
 * The recap of one session (roadmap 2.1): summary, decisions, action items with
 * owner and due date, what's still open, and a recap email to the others — all
 * from one pass over the transcript. `autoGenerate` writes it straight away if
 * there's none yet (meeting-mode sessions open here when they end).
 */
export default function NotesPanel({ sessionId, autoGenerate = false }: { sessionId: number; autoGenerate?: boolean }) {
  const [notes, setNotes] = useState<Notes | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  // What went wrong last time, kept on screen with a way to try again: a toast
  // alone vanished and left an empty panel that looked like it was still busy.
  const [failed, setFailed] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const autoStarted = useRef(false);

  function show(n: Notes | null) {
    setNotes(n);
    setSubject(n?.email?.subject ?? "");
    setBody(n?.email?.body ?? "");
  }

  useEffect(() => {
    setLoading(true); show(null);
    fetchApi(`/notes/${sessionId}`)
      .then(async r => { if (!r.ok) throw await errorFromResponse(r); return r.json(); })
      .then(n => {
        show(n);
        if (!n && autoGenerate && !autoStarted.current) { autoStarted.current = true; generate(); }
      })
      .catch(notifyError).finally(() => setLoading(false));
  }, [sessionId]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function generate(fallbackCredits?: boolean | unknown) {
    const useCredits = fallbackCredits === true;
    if (!(await ensureReady(["llm"]))) return;
    setWorking(true); setFailed(null); setSlow(false);
    // A recap usually takes well under a minute; past that, say so.
    const slowTimer = setTimeout(() => setSlow(true), 40_000);
    try {
      track("session.recap");
      // No model is named: the service writes it with the model that answered
      // during this session, the one known to work (meeting_notes.answered_with).
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (useCredits) headers["X-IRB-Use-Credits"] = "1";
      const res = await fetchApi(`/notes/${sessionId}`, { method: "POST", headers, body: "{}" });
      if (!res.ok) throw await errorFromResponse(res);
      show(await res.json());
    } catch (e) {
      notifyError(e, () => generate(true));
      setFailed(e instanceof Error && e.message ? e.message : "The recap couldn't be written.");
    } finally { clearTimeout(slowTimer); setWorking(false); setSlow(false); }
  }

  if (loading) return <div className="glass-card plans-empty"><Loader2 size={18} className="spin" /></div>;

  return (
    <div className="session-hub-stack">
      <div className="session-hub-actions">
        <span className="muted">What was covered and decided, who does what by when, and the email to send.</span>
        <button className="btn-primary" onClick={() => generate(false)} disabled={working}>
          {working ? <Loader2 size={14} className="spin" /> : notes ? <RotateCw size={14} /> : <Sparkles size={14} />}
          {working ? "Writing the recap…" : notes ? "Refresh" : "Write the recap"}
        </button>
      </div>

      {!notes ? (
        <div className="glass-card plans-empty">
          <Illustration name="notes" />
          <div className="plans-empty-title">{working ? "Writing your recap…" : failed ? "The recap wasn't written" : "No recap yet"}</div>
          {working && slow ? (
            <p className="muted" role="status">This is taking longer than usual: the AI provider may be slow or unreachable. It gives up within a few minutes and tries another provider.</p>
          ) : failed ? (
            <>
              <p className="muted" role="alert">{failed}</p>
              <button className="btn-primary" onClick={generate}><RotateCw size={14} /> Try again</button>
            </>
          ) : (
            <p className="muted">A summary, the decisions, action items with owners and due dates, what's still open — and a recap email ready to send.</p>
          )}
        </div>
      ) : (
        <div className="recap-grid">
          <div className="recap-col">
            <section className="glass-card progress-card">
              <header><FileText size={14} /> Summary</header>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>{notes.summary || "—"}</p>
            </section>
            {notes.action_items.length > 0 && (
              <section className="glass-card progress-card">
                <header>
                  <CheckSquare size={14} /> Action items
                  <button className="btn-neutral recap-copy" onClick={() => copy(checklist(notes.action_items), "Checklist")}><Copy size={12} /> Copy as checklist</button>
                </header>
                <ul className="recap-actions">
                  {notes.action_items.map((a, i) => (
                    <li key={i}>
                      <span className="notes-who">{a.who}</span>
                      <span className="recap-what">{a.what}</span>
                      <span className={`recap-due ${a.due ? "" : "none"}`}><CalendarClock size={11} /> {a.due || "no date agreed"}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {notes.decisions.length > 0 && (
              <section className="glass-card progress-card">
                <header><Flag size={14} /> Decisions</header>
                <ul className="progress-focus">{notes.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </section>
            )}
            {notes.open_questions.length > 0 && (
              <section className="glass-card progress-card">
                <header><HelpCircle size={14} /> Still open</header>
                <ul className="progress-focus">{notes.open_questions.map((q, i) => <li key={i}>{q}</li>)}</ul>
              </section>
            )}
          </div>

          <section className="glass-card progress-card recap-email">
            <header><Mail size={14} /> Recap email</header>
            {notes.email?.body ? (
              <>
                <input className="glass-input" value={subject} onChange={e => setSubject(e.target.value)} aria-label="Subject" />
                <textarea className="glass-input" rows={10} value={body} onChange={e => setBody(e.target.value)} aria-label="Email" />
                <div className="recap-email-actions">
                  <button className="btn-neutral" onClick={() => copy(`${subject}\n\n${body}`, "Email")}><Copy size={12} /> Copy</button>
                  <button className="btn-primary" onClick={() => openExternal(`mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`)}>
                    <Send size={12} /> Open in mail app
                  </button>
                </div>
              </>
            ) : (
              <p className="progress-hint">This recap was made before recap emails existed — press Refresh to write one.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
