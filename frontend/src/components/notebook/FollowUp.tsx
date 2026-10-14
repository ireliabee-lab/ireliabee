import { useState } from "react";
import { Loader2, Plus, Send } from "lucide-react";
import { readingApi, type FollowUpAnswer, type ReaderLevel } from "../../lib/reading";
import { notifyError } from "../../lib/errors";

type Turn = { q: string; a: FollowUpAnswer };

/** Questions offered before you type one. */
export const STARTERS = ["Why does this matter?", "Give me another example", "How does this connect to my notes?"];

/** Where an answer came from, in words, as the Explain card says it. */
export function answerFrom(a: Pick<FollowUpAnswer, "from" | "pages">): string {
  const pages = a.pages.length ? `p. ${a.pages.join(", ")}` : "";
  if (a.from === "source") return `From your source${pages ? `, ${pages}` : ""}`;
  if (a.from === "both") return `From your source${pages ? ` (${pages})` : ""}, with iReliabee's explanation`;
  return "iReliabee's answer: not from your source";
}

/**
 * Follow-up questions under an explanation (POST /reading/ask): a short
 * conversation tied to the words or paragraph explained, grounded in the
 * source like the explanation was, each answer labelled. One question, one
 * charge; the conversation goes along so "why?" means why *that*.
 */
export default function FollowUp({ passage, explained, documentId, pages, notebookId, level, onSource, onAddUnder }: {
  passage: string;
  explained: string;
  documentId: number | null;
  pages: number[];
  notebookId: number;
  level: ReaderLevel;
  onSource?: (src: number[]) => void;
  onAddUnder: (text: string) => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      const a = await readingApi.ask({
        question: q, passage, explained, history: turns.map(t => ({ q: t.q, a: t.a.answer })),
        document_id: documentId, pages, notebook_id: notebookId, level,
      });
      setTurns(t => [...t, { q, a }]);
      setDraft("");
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="nbk-followup">
      {turns.map((t, i) => (
        <div key={i} className="nbk-turn">
          <p className="nbk-turn-q">{t.q}</p>
          <p className="nbk-turn-a">{t.a.answer}</p>
          <p className="nbk-explain-from">
            {t.a.from !== "general" && t.a.pages.length > 0 && onSource
              ? <button type="button" className="nbk-help-src" onMouseDown={keep} onClick={() => onSource(t.a.pages)}>{answerFrom(t.a)}</button>
              : <span>{answerFrom(t.a)}</span>}
            {t.a.unsure && <span className="nbk-explain-unsure"> Not certain: check before relying on it.</span>}
            {" "}
            <button type="button" className="nbk-help-src" onMouseDown={keep}
              onClick={() => onAddUnder(`Q: ${t.q} A (${t.a.from === "general" ? "iReliabee's" : answerFrom(t.a)}): ${t.a.answer}`)}>
              <Plus size={11} /> Add to notes
            </button>
          </p>
        </div>
      ))}
      {turns.length === 0 && (
        <div className="nbk-starters">
          {STARTERS.map(s => (
            <button key={s} type="button" className="nbk-starter" disabled={busy} onMouseDown={keep} onClick={() => void send(s)}>{s}</button>
          ))}
        </div>
      )}
      <form className="nbk-ask" onSubmit={e => { e.preventDefault(); void send(draft); }}>
        <input id="nbk-ask-input" className="nb-input" value={draft} maxLength={600} disabled={busy}
          placeholder={turns.length ? "Ask another question…" : "Ask about this…"} aria-label="Ask a question about this"
          onChange={e => setDraft(e.target.value)} />
        <button type="submit" className="nb-icon-btn" aria-label="Ask" disabled={busy || !draft.trim()}>
          {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
        </button>
      </form>
    </div>
  );
}
