import { OWN_ASSISTANT_COST, useOwnAssistant } from "../../lib/relay";
import { useEffect, useState } from "react";
import { BookmarkPlus, Loader2, Plus, Sparkles, X } from "lucide-react";
import toast from "react-hot-toast";
import {
  READER_LEVELS, UNDERSTAND_MODES, readingApi,
  type ReaderLevel, type UnderstandMode, type UnderstoodTerm,
} from "../../lib/reading";
import { researchApi } from "../../lib/research";
import { notifyError } from "../../lib/errors";
import FollowUp from "./FollowUp";

type Answer = { plain: string; terms?: UnderstoodTerm[] };
const ORDER: ReaderLevel[] = ["new", "some", "expert"];

/** One level simpler or more technical, or null at the end of the scale. */
export function shiftLevel(level: ReaderLevel, by: -1 | 1): ReaderLevel | null {
  return ORDER[ORDER.indexOf(level) + by] ?? null;
}

/** What goes under the paragraph: labelled as iReliabee's, on one line (a note line holds one paragraph). */
export function noteLine(mode: UnderstandMode, a: Answer): string {
  const label = UNDERSTAND_MODES.find(m => m.id === mode)?.label ?? "Explained";
  const body = mode === "terms"
    ? (a.terms ?? []).map(t => `${t.term}: ${t.meaning}`).join("; ")
    : a.plain.replace(/\s*\n+\s*/g, " ");
  return `${label} (iReliabee's): ${body}`;
}

/**
 * The Simplify menu's card: the paragraph at the cursor explained another way
 * (POST /reading/simplify with a mode), switchable between ways and between
 * simpler and more technical, each answer kept while the card is open.
 * Everything here is iReliabee's, never the author's, and says so.
 */
export default function UnderstandCard({ paragraph, documentId, notebookId, level: startLevel, mode: startMode, onSource, onAddUnder, onClose }: {
  paragraph: { text: string; src: number[] };
  documentId: number | null;
  notebookId: number;
  onSource?: (src: number[]) => void;
  level: ReaderLevel;
  mode: UnderstandMode;
  onAddUnder: (text: string) => void;
  onClose: () => void;
}) {
  const ownAssistant = useOwnAssistant();
  const [mode, setMode] = useState<UnderstandMode>(startMode);
  const [level, setLevel] = useState<ReaderLevel>(startLevel);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [busy, setBusy] = useState(false);
  const key = `${mode}:${level}`;
  const answer = answers[key];

  useEffect(() => {
    if (answers[key]) return;
    let live = true;
    setBusy(true);
    readingApi.simplify({ document_id: documentId, text: paragraph.text, pages: paragraph.src, level, mode })
      .then(r => { if (live) setAnswers(a => ({ ...a, [key]: r })); })
      .catch(e => { if (live) notifyError(e); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [key]);  // eslint-disable-line react-hooks/exhaustive-deps

  const simpler = shiftLevel(level, -1);
  const deeper = shiftLevel(level, 1);
  const levelLabel = READER_LEVELS.find(l => l.id === level)?.label ?? "";
  const keep = (e: React.MouseEvent) => e.preventDefault();

  async function toTermBank(t: UnderstoodTerm) {
    try {
      await researchApi.addTerm(t.term, t.meaning);
      toast.success(`“${t.term}” is in your term bank`);
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <div className="nbk-help nbk-explain-card" role="dialog" aria-label="Understand this paragraph"
      onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
      <div className="nbk-help-head"><Sparkles size={13} /> <strong>Understand this paragraph</strong>
        <span className="muted">iReliabee's, not the author's</span>
        <button type="button" className="nb-icon-btn" aria-label="Close" onClick={onClose}><X size={13} /></button></div>
      <div className="nbk-modes" role="radiogroup" aria-label="How to explain it">
        {UNDERSTAND_MODES.map(m => (
          <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} title={m.hint} onMouseDown={keep} onClick={() => setMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      {busy && !answer && <p className="muted"><Loader2 size={13} className="spin" /> Working it out…</p>}
      {answer && mode !== "terms" && <p className="nbk-understand-text">{answer.plain}</p>}
      {answer && mode === "terms" && (
        answer.terms?.length
          ? <ul className="nbk-terms">
              {answer.terms.map(t => (
                <li key={t.term}>
                  <strong>{t.term}</strong> {t.meaning}{" "}
                  <span className="muted">{t.from === "source" ? "(from the page)" : "(iReliabee's)"}</span>
                  <button type="button" className="nb-icon-btn" aria-label={`Add ${t.term} to my term bank`} title="Add to my term bank"
                    onMouseDown={keep} onClick={() => void toTermBank(t)}><BookmarkPlus size={13} /></button>
                </li>
              ))}
            </ul>
          : <p className="muted">No technical terms in this paragraph.</p>
      )}
      <div className="nbk-explain-actions">
        <span className="nbk-level" aria-live="polite">{levelLabel}</span>
        <button type="button" className="nbk-pill" disabled={!simpler || busy} onMouseDown={keep} onClick={() => simpler && setLevel(simpler)}>Simpler</button>
        <button type="button" className="nbk-pill" disabled={!deeper || busy} onMouseDown={keep} onClick={() => deeper && setLevel(deeper)}>More technical</button>
        {answer && (answer.plain || answer.terms?.length) && (
          <button type="button" className="nbk-pill" onMouseDown={keep} onClick={() => { onAddUnder(noteLine(mode, answer)); onClose(); }}>
            <Plus size={13} /> Add under the paragraph
          </button>
        )}
      </div>
      {answer && (answer.plain || answer.terms?.length) && (
        <FollowUp key={key} passage={paragraph.text} explained={noteLine(mode, answer)} documentId={documentId} pages={paragraph.src}
          notebookId={notebookId} level={level} onSource={onSource} onAddUnder={onAddUnder} />
      )}
      <p className="muted nbk-explain-cost">{ownAssistant ? OWN_ASSISTANT_COST + "." : "Each new answer or question uses a few credits."}</p>
    </div>
  );
}
