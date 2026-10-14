import { OWN_ASSISTANT_COST, relayIssueLine, useAssistantAuto, useOwnAssistant } from "../../lib/relay";
import { useEffect, useRef, useState } from "react";
import { BookmarkPlus, Lightbulb, Loader2, Plus, X } from "lucide-react";
import toast from "react-hot-toast";
import { readingApi, type Lookup, type LookupDepth, type ReaderLevel } from "../../lib/reading";
import { researchApi } from "../../lib/research";
import { notifyError, toFriendly } from "../../lib/errors";
import FollowUp from "./FollowUp";
import type { Placement } from "../../lib/cardPlacement";

/** Basic or technical, remembered on this computer: the last way you asked. */
const DEPTH_KEY = "ireliabee.explainDepth";
const rememberedDepth = (): LookupDepth => { try { return localStorage.getItem(DEPTH_KEY) === "technical" ? "technical" : "basic"; } catch { return "basic"; } };

/** Short enough to be a term: it can go in the term bank. */
const TERM_CHARS = 80;

export interface Selected { text: string; line: string; src: number[] }

/** Where the explanation came from, in words: the reader must never mistake ours for the author's. */
export function provenance(r: Pick<Lookup, "from" | "pages">): string {
  const pages = r.pages.length ? `p. ${r.pages.join(", ")}` : "";
  if (r.from === "source") return `From your source${pages ? `, ${pages}` : ""}`;
  if (r.from === "both") return `From your source${pages ? ` (${pages})` : ""}, with iReliabee's explanation`;
  return "iReliabee's explanation: your source doesn't explain this";
}

/**
 * The Explain card: what the selected words mean, basic or technical, from the
 * source when it says and labelled as iReliabee's when it doesn't
 * (POST /reading/lookup). Each new explanation costs credits; the same words
 * again are free.
 */
export default function ExplainCard({ selected, documentId, notebookId, level, placement, onSource, onAddUnder, onClose }: {
  selected: Selected;
  documentId: number | null;
  notebookId: number;
  level: ReaderLevel;
  /** Beside the selected words; at the book's foot without one. */
  placement?: Placement | null;
  onSource?: (src: number[]) => void;
  onAddUnder: (text: string) => void;
  onClose: () => void;
}) {
  const ownAssistant = useOwnAssistant();
  const [depth, setDepth] = useState<LookupDepth>(rememberedDepth);
  const [answers, setAnswers] = useState<Partial<Record<LookupDepth, Lookup>>>({});
  const [busy, setBusy] = useState(false);
  const [relayIssue, setRelayIssue] = useState<"not_listening" | "timeout" | null>(null);
  const relayAuto = useAssistantAuto(relayIssue);
  const answer = answers[depth];

  // The lookup being asked for, by depth. React's development mode runs the
  // effect below twice on mount; without this each new word was looked up
  // (and, through the user's assistant, answered) twice.
  const asking = useRef(new Set<LookupDepth>());

  function doLookup(fallbackCredits = false) {
    if (answers[depth] && !fallbackCredits) return;
    if (asking.current.has(depth) && !fallbackCredits) return;
    const asked = depth;
    asking.current.add(asked);
    setBusy(true);
    setRelayIssue(null);
    readingApi.lookup({
      text: selected.text,
      line: selected.line,
      document_id: documentId,
      pages: selected.src,
      depth,
      level,
      fallback_credits: fallbackCredits,
    })
      .then(r => {
        setAnswers(a => ({ ...a, [depth]: r }));
      })
      .catch(e => {
        if (toFriendly(e).code === "relay_not_listening") {
          setRelayIssue("not_listening");
        } else if (toFriendly(e).code === "relay_timeout") {
          setRelayIssue("timeout");
        } else {
          notifyError(e);
        }
      })
      .finally(() => {
        asking.current.delete(asked);
        setBusy(false);
      });
  }

  useEffect(() => {
    doLookup(false);
  }, [depth]);  // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (d: LookupDepth) => { try { localStorage.setItem(DEPTH_KEY, d); } catch { /* asked again next time */ } setDepth(d); };
  const isTerm = selected.text.length <= TERM_CHARS;
  const shown = selected.text.length > 70 ? `${selected.text.slice(0, 67)}…` : selected.text;

  async function toTermBank(r: Lookup) {
    try {
      await researchApi.addTerm(selected.text, r.meaning, r.example);
      toast.success(`“${selected.text}” is in your term bank`);
    } catch (e) {
      notifyError(e);
    }
  }

  return (
    <div className="nbk-help nbk-explain-card" role="dialog" aria-label={`Explain ${selected.text}`}
      data-side={placement?.side}
      style={placement ? {
        left: placement.left, transform: "none", maxHeight: placement.maxHeight,
        top: placement.top ?? "auto", bottom: placement.bottom ?? "auto",
      } : undefined}
      onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
      <div className="nbk-help-head"><Lightbulb size={13} /> <strong>Explain</strong> <span className="nbk-explain-words">“{shown}”</span>
        <button type="button" className="nb-icon-btn" aria-label="Close" onClick={onClose}><X size={13} /></button></div>
      <div className="nbk-depth" role="radiogroup" aria-label="How to explain it">
        {(["basic", "technical"] as LookupDepth[]).map(d => (
          <button key={d} type="button" role="radio" aria-checked={depth === d} onMouseDown={e => e.preventDefault()} onClick={() => pick(d)}>
            {d === "basic" ? "Basic" : "Technical"}
          </button>
        ))}
      </div>
      {busy && !answer && <p className="muted"><Loader2 size={13} className="spin" /> Looking it up…</p>}
      {!busy && relayIssue && !answer && (
        <div className="nbk-relay-fallback" style={{ margin: "10px 0", padding: "10px 12px", borderRadius: 6, background: "rgba(234, 179, 8, 0.08)", border: "1px solid rgba(234, 179, 8, 0.25)" }}>
          <p style={{ margin: "0 0 8px 0", fontSize: 12, fontWeight: 500, color: "var(--foreground)" }}>
            {relayIssueLine(relayIssue === "timeout" ? "relay_timeout" : "relay_not_listening", relayAuto)}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn-neutral"
              style={{ fontSize: 11, padding: "4px 8px" }}
              onClick={() => doLookup(false)}
            >
              Try again
            </button>
            <button
              type="button"
              className="btn-primary"
              style={{ fontSize: 11, padding: "4px 8px" }}
              onClick={() => doLookup(true)}
            >
              Use credits instead
            </button>
          </div>
        </div>
      )}
      {answer && (
        <>
          <p>{answer.meaning}</p>
          {answer.example && <p className="nbk-explain-example"><strong>For example:</strong> {answer.example}</p>}
          <p className="nbk-explain-from">
            {answer.from !== "general" && answer.pages.length > 0 && onSource
              ? <button type="button" className="nbk-help-src" onMouseDown={e => e.preventDefault()} onClick={() => onSource(answer.pages)}>{provenance(answer)}</button>
              : <span>{provenance(answer)}</span>}
            {answer.unsure && <span className="nbk-explain-unsure"> Not certain what this refers to: check before relying on it.</span>}
          </p>
          <div className="nbk-explain-actions">
            <button type="button" className="nbk-pill" onMouseDown={e => e.preventDefault()}
              onClick={() => { onAddUnder(`${isTerm ? selected.text : "In other words"}: ${answer.meaning} (${answer.from === "general" ? "iReliabee's" : provenance(answer)})`); onClose(); }}>
              <Plus size={13} /> Add under the line
            </button>
            {isTerm && (
              <button type="button" className="nbk-pill" onMouseDown={e => e.preventDefault()} onClick={() => void toTermBank(answer)}>
                <BookmarkPlus size={13} /> Add to my term bank
              </button>
            )}
          </div>
          <FollowUp passage={selected.text} explained={answer.meaning} documentId={documentId} pages={selected.src}
            notebookId={notebookId} level={level} onSource={onSource} onAddUnder={onAddUnder} />
        </>
      )}
      <p className="muted nbk-explain-cost">
        {ownAssistant ? OWN_ASSISTANT_COST + "." : answer?.cached ? "Looked up before, so no credits used. Each question uses a few." : "A new explanation or question uses a few credits; the same words again are free."}
      </p>
    </div>
  );
}
