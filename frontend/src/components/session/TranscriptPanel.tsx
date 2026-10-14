import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ChevronDown, ChevronRight, Copy, Download, Languages, Loader2, RotateCcw } from "lucide-react";
import { practiseMoment } from "../../lib/retry";
import CoachPanel from "../CoachPanel";
import { fetchApi } from "../../lib/api";
import { errorFromResponse, notifyError, toFriendly } from "../../lib/errors";
import { DISPLAY_OPTIONS } from "../../lib/languages";
import { useOwnAssistant, relayIssueLine, useAssistantAuto } from "../../lib/relay";
import {
  shownLine, transcriptTranslationApi as api, translationCostLine,
  type TranscriptTranslation, type TranslationEstimate,
} from "../../lib/transcriptTranslation";
import Illustration from "../Illustration";

interface Message { id?: number; role: "user" | "assistant"; content: string; speaker: string | null; created_at: string; }
interface Turn { id?: number; speaker: "you" | "them" | "screen"; text: string; at: string; reply?: string; }

// Saved user turns look like "[INTERVIEWER] [§2: Leadership] text" or "[SCREEN] …".
function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const last = turns[turns.length - 1];
      if (last && last.reply === undefined) last.reply = m.content;
      continue;
    }
    const tag = m.content.match(/^\[([A-Z]+)/)?.[1];
    const speaker = tag === "SCREEN" ? "screen" : tag === "INTERVIEWER" || m.speaker === "interviewer" ? "them" : "you";
    turns.push({ id: m.id, speaker, text: m.content.replace(/^(\[[^\]]*\]\s*)+/, ""), at: m.created_at });
  }
  return turns;
}

function time(iso: string) {
  const d = new Date(iso + (iso.endsWith("Z") ? "" : "Z"));
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** What was said in one session, with the coach's answer to each turn one click away. */
export default function TranscriptPanel({ sessionId, themLabel = "Them", sessionTitle }: { sessionId: number; themLabel?: string; sessionTitle?: string }) {
  const [turns, setTurns] = useState<Turn[] | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  // Reading it in another language (T3): "" is the words as said.
  const [spoken, setSpoken] = useState("");
  const [readIn, setReadIn] = useState("");
  const [tr, setTr] = useState<TranscriptTranslation | null>(null);
  const [est, setEst] = useState<TranslationEstimate | null>(null);
  const [translating, setTranslating] = useState(false);
  const [relayIssue, setRelayIssue] = useState<string | null>(null);
  const relayAuto = useAssistantAuto(relayIssue);
  const ownAssistant = useOwnAssistant();

  useEffect(() => {
    setTurns(null);
    fetchApi(`/sessions/${sessionId}/messages`)
      .then(async r => { if (!r.ok) throw await errorFromResponse(r); return r.json(); })
      .then((m: Message[]) => setTurns(toTurns(m)))
      .catch(e => { setTurns([]); notifyError(e); });
    api.languages(sessionId).then(l => {
      setSpoken(l.spoken);
      // Read in the session's reading language when it had one, as during the call.
      if (l.reading && l.reading !== l.spoken) setReadIn(l.reading);
    }).catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    setTr(null); setEst(null); setRelayIssue(null);
    if (!readIn) return;
    api.get(sessionId, readIn).then(t => {
      setTr(t);
      if (t.done < t.total) api.estimate(sessionId, readIn).then(setEst).catch(() => {});
    }).catch(notifyError);
  }, [sessionId, readIn]);

  async function translate(fallbackCredits = false) {
    setTranslating(true); setRelayIssue(null);
    try {
      const t = await api.translate(sessionId, readIn, fallbackCredits);
      setTr(t);
      setEst(null);
      if (t.done < t.total) toast.error("Some lines didn't come back translated. Translate again to finish them.");
    } catch (e) {
      const code = toFriendly(e).code;
      if (code === "relay_not_listening" || code === "relay_timeout") setRelayIssue(code); else notifyError(e);
    } finally { setTranslating(false); }
  }

  async function exportMarkdown(how: "copy" | "file") {
    try {
      const md = await api.markdown(sessionId, readIn || null, themLabel);
      if (how === "copy") {
        await navigator.clipboard.writeText(md);
        toast.success("Transcript copied as Markdown");
      } else {
        const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
        const a = document.createElement("a");
        a.href = url; a.download = `${(sessionTitle || "transcript").replace(/[^\w\- ]+/g, "").trim() || "transcript"}.md`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { notifyError(e); }
  }

  if (turns == null) return <div className="glass-card plans-empty"><Loader2 size={18} className="spin" /></div>;
  if (turns.length === 0) {
    return (
      <div className="glass-card plans-empty">
        <Illustration name="chat" />
        <div className="plans-empty-title">Nothing was said in this session</div>
        <p className="muted">Resume it to start talking, or delete it from the list.</p>
      </div>
    );
  }

  const toggle = (i: number) => setOpen(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const readOptions = DISPLAY_OPTIONS.filter(o => o.id && o.id !== spoken);
  const missing = tr ? tr.total - tr.done : 0;

  return (
    <>
      <div className="hub-transcript-bar">
        <label className="hub-transcript-lang">
          <Languages size={13} />
          <span>Read in</span>
          <select className="glass-input" id="transcript-read-in" value={readIn} onChange={e => setReadIn(e.target.value)}>
            <option value="">As it was said</option>
            {readOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <button type="button" className="btn-neutral" onClick={() => exportMarkdown("copy")}><Copy size={13} /> Copy</button>
        <button type="button" className="btn-neutral" onClick={() => exportMarkdown("file")}><Download size={13} /> Save as .md</button>
      </div>
      {readIn && tr && missing > 0 && (
        <div className="hub-transcript-translate">
          <p className="muted">
            {tr.done ? `${missing} of ${tr.total} lines aren't translated yet.` : "This transcript hasn't been translated into this language yet."}
            {" "}{est ? translationCostLine(est, ownAssistant) : ""} The words as said are kept.
          </p>
          {relayIssue ? (
            <div className="mm-actions">
              <p className="muted">{relayIssueLine(relayIssue, relayAuto)}</p>
              <button type="button" className="nbk-pill" onClick={() => translate(false)}>Try again</button>
              <button type="button" className="btn-neutral" onClick={() => translate(true)}>Use credits instead</button>
            </div>
          ) : (
            <button type="button" className="nbk-pill" disabled={translating} onClick={() => translate(false)}>
              {translating ? <><Loader2 size={13} className="spin" /> Translating{ownAssistant ? " with your assistant" : ""}…</> : <><Languages size={13} /> Translate</>}
            </button>
          )}
        </div>
      )}
      <ol className="hub-transcript">
        {turns.map((t, i) => {
          const line = t.speaker === "screen" ? { text: t.text, original: null } : shownLine(t.id, t.text, tr);
          return (
            <li key={i} className={`hub-turn ${t.speaker}`}>
              <div className="hub-turn-meta">
                <strong>{t.speaker === "you" ? "You" : t.speaker === "screen" ? "Screen" : themLabel}</strong>
                <span>{time(t.at)}</span>
              </div>
              <div className="hub-turn-text">
                {line.original ? <>
                  <span className="caption-translation">{line.text}</span>
                  <span className="caption-original">{line.original}</span>
                </> : line.text}
              </div>
              {t.speaker === "them" && t.text.length > 15 && (
                <button className="hub-turn-toggle practise-inline" title="Answer this again in Practice → Hard moments"
                  onClick={() => practiseMoment({
                    session_id: sessionId, session_title: sessionTitle, question: t.text,
                    previous_answer: turns.slice(i + 1).find(x => x.speaker === "you")?.text ?? "", score: null, source: "transcript",
                  })}>
                  <RotateCcw size={11} /> Practise this
                </button>
              )}
              {t.reply && (
                <>
                  <button className="hub-turn-toggle" onClick={() => toggle(i)}>
                    {open.has(i) ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Coach's answer
                  </button>
                  {open.has(i) && <div className="hub-turn-reply"><CoachPanel reply={t.reply} /></div>}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
