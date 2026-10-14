import { useState } from "react";
import { Check, Loader2, MessageSquareText, RotateCw, X } from "lucide-react";
import { notifyError } from "../../lib/errors";
import { track } from "../../lib/usage";
import { readingApi, type ExplainResult, type ReadingProgress } from "../../lib/reading";

/**
 * Explain it back (Deep Read, B4): write the chapter from memory, then see what
 * you got, what you missed (each with its page) and anything to put right.
 * Recall, not rereading, is what makes it stick; the best score per chapter is kept.
 */
export default function ExplainBack({ notebookId, sectionId, chapter, onSource, onProgress, onClose }: {
  notebookId: number;
  sectionId: string;
  chapter: string;
  onSource?: (src: number[]) => void;
  onProgress?: (p: ReadingProgress) => void;
  onClose: () => void;
}) {
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExplainResult | null>(null);

  async function check() {
    setBusy(true);
    try {
      const r = await readingApi.explain({ notebook_id: notebookId, section_id: sectionId, text: said });
      setResult(r);
      onProgress?.(r.progress);
      track("reading.explain_back");
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  const src = (s: number[]) => s.length > 0 && onSource
    ? <button type="button" className="nbk-help-src" onClick={() => onSource(s)}>p. {s.join(", ")}</button> : null;

  return (
    <div className="nbk-explain" role="dialog" aria-label={`Explain ${chapter} back`}>
      <div className="nbk-help-head">
        <MessageSquareText size={14} /> <strong>Explain it back</strong> <span className="muted">{chapter}</span>
        <button type="button" className="nb-icon-btn" aria-label="Close" onClick={onClose}><X size={13} /></button>
      </div>
      {!result ? (
        <>
          <p className="muted">Without looking, explain this chapter in your own words, as if to a friend. Then check what you got.</p>
          <textarea id="nbk-explain-text" className="nb-input nbk-explain-text" rows={6} value={said} autoFocus
            onChange={e => setSaid(e.target.value)} placeholder="This chapter says that…" />
          <div className="nbk-explain-actions">
            <span className="muted">{said.trim() ? said.trim().split(/\s+/).length : 0} words</span>
            <button type="button" className="btn-primary" disabled={busy || said.trim().split(/\s+/).length < 5} onClick={() => void check()}>
              {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Check what I got
            </button>
          </div>
        </>
      ) : (
        <div className="nbk-explain-result">
          <div className="nbk-explain-score" aria-label={`${result.score} out of 100`}>
            <strong>{result.score}</strong><span>/100</span>
            {result.note && <p>{result.note}</p>}
          </div>
          {result.got.length > 0 && (
            <section><h4>You explained</h4><ul>{result.got.map((g, i) => <li key={i} className="got">{g.text} {src(g.src)}</li>)}</ul></section>
          )}
          {result.missed.length > 0 && (
            <section><h4>Worth going over</h4><ul>{result.missed.map((m, i) => <li key={i} className="missed">{m.text} {src(m.src)}</li>)}</ul></section>
          )}
          {result.wrong.length > 0 && (
            <section><h4>To put right</h4><ul>{result.wrong.map((w, i) => (
              <li key={i} className="wrong"><span className="muted">You wrote:</span> {w.said}<br /><span className="muted">The notes say:</span> {w.fix} {src(w.src)}</li>
            ))}</ul></section>
          )}
          <div className="nbk-explain-actions">
            <span className="muted">{result.progress.explained} of {result.progress.chapters} chapters explained</span>
            <button type="button" className="btn-neutral" onClick={() => { setResult(null); setSaid(""); }}><RotateCw size={14} /> Try again</button>
          </div>
        </div>
      )}
    </div>
  );
}
