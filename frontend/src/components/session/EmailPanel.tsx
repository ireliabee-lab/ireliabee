import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Mail, Copy, Loader2, RotateCcw } from "lucide-react";
import { fetchApi } from "../../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../../lib/errors";
import { AiSuggest } from "../Suggested";
import { track } from "../../lib/usage";
import { languageLabel } from "../../lib/languages";
import { transcriptTranslationApi } from "../../lib/transcriptTranslation";

const KINDS = [
  { id: "thank_you", label: "Thank you", hint: "Send within 24 hours" },
  { id: "follow_up", label: "Follow up", hint: "No reply after a week" },
  { id: "recap", label: "Meeting recap", hint: "What was agreed + next steps" },
];

/** Thank-you / follow-up / recap email written from one session. */
export default function EmailPanel({ sessionId }: { sessionId: number }) {
  const [kind, setKind] = useState("thank_you");
  const [recipient, setRecipient] = useState("");
  const [notes, setNotes] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  // Read in one language, the call in another (T3): the email goes to people on the call, so it
  // starts in the call's language, with the user's own one a click away.
  const [langs, setLangs] = useState<{ spoken: string; reading: string } | null>(null);
  const [writeIn, setWriteIn] = useState("");
  useEffect(() => {
    transcriptTranslationApi.languages(sessionId).then(l => {
      if (l.reading && l.spoken && l.spoken !== "multi" && l.reading !== l.spoken) { setLangs(l); setWriteIn(l.spoken); }
    }).catch(() => {});
  }, [sessionId]);

  async function write(fallbackCredits?: boolean | unknown) {
    const useCredits = fallbackCredits === true;
    if (!(await ensureReady(["llm"]))) return;
    setBusy(true);
    try {
      const cfg = await fetchApi("/config").then(r => r.json()).catch(() => ({}));
      track("session.email");
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (useCredits) headers["X-IRB-Use-Credits"] = "1";
      const res = await fetchApi(`/sessions/${sessionId}/email`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind, recipient: recipient || null, notes: notes || null,
          model: cfg?.saved?.model, response_tone: cfg?.saved?.response_tone,
          language: writeIn || null,
        }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      const data = await res.json();
      setSubject(data.subject);
      setBody(data.body);
    } catch (e) { notifyError(e, () => write(true)); } finally { setBusy(false); }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      toast.success("Email copied — paste it into your mail app");
    } catch {
      toast.error("Couldn't copy. Select the text and copy it manually.");
    }
  }

  const hasPlaceholders = /\[[^\]]+\]/.test(subject + body);

  return (
    <div className="email-body">
      <div className="email-kinds">
        {KINDS.map(k => (
          <button key={k.id} className={`email-kind ${kind === k.id ? "active" : ""}`} onClick={() => setKind(k.id)}>
            <strong>{k.label}</strong>
            <small>{k.hint}</small>
          </button>
        ))}
      </div>

      {langs && (
        <div className="email-lang" role="group" aria-label="Write it in">
          <span className="muted">Write it in</span>
          {[langs.spoken, langs.reading].map(l => (
            <button key={l} type="button" className={`nbk-pill ${writeIn === l ? "active" : ""}`} aria-pressed={writeIn === l}
              onClick={() => setWriteIn(l)}>{languageLabel(l)}{l === langs.spoken ? " (the call's)" : " (yours)"}</button>
          ))}
        </div>
      )}

      <div className="email-fields">
        <input className="glass-input" value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="Who is it to? (optional, e.g. Ms. Mensah)" />
        <div className="suggest-inline">
          <input className="glass-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Anything to mention? (optional, e.g. attach portfolio link)" />
          <AiSuggest<string> field="email.notes" label="Anything to mention in the email" value={notes}
            form={() => ({ kind: KINDS.find(k => k.id === kind)?.label ?? kind, notes })}
            onSuggest={text => setNotes(n => (n.trim() ? n : text))} />
        </div>
      </div>

      {!body ? (
        <button className="btn-primary email-write" onClick={() => write(false)} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Mail size={14} />} {busy ? "Writing…" : "Write email"}
        </button>
      ) : (
        <>
          <input className="glass-input email-subject" value={subject} onChange={e => setSubject(e.target.value)} aria-label="Subject" />
          <textarea className="glass-input email-text" value={body} onChange={e => setBody(e.target.value)} rows={12} aria-label="Email body" />
          {hasPlaceholders && <div className="story-gap-note">Replace the parts in [brackets] before sending.</div>}
          <div className="email-actions">
            <button className="btn-neutral" onClick={() => write(false)} disabled={busy}>
              {busy ? <Loader2 size={13} className="spin" /> : <RotateCcw size={13} />} Rewrite
            </button>
            <button className="btn-primary" onClick={copy}><Copy size={13} /> Copy email</button>
          </div>
        </>
      )}
    </div>
  );
}
