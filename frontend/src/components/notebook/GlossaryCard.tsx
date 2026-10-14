import { useState } from "react";
import { BookA, BookmarkPlus, Loader2, Search, X } from "lucide-react";
import toast from "react-hot-toast";
import { readingApi, type ReaderLevel } from "../../lib/reading";
import { researchApi } from "../../lib/research";
import { notifyError } from "../../lib/errors";
import type { FoundTerm, NotebookDoc } from "../../lib/notebook";

/** Where a term's meaning came from, in words. */
export function termFrom(t: Pick<FoundTerm, "from" | "pages">): string {
  const pages = t.pages.length ? `p. ${t.pages.join(", ")}` : "";
  if (t.from === "general" || !pages) return "iReliabee's: not explained in your source";
  return t.from === "both" ? `From your source (${pages}), with iReliabee's explanation` : `From your source, ${pages}`;
}

/** The found terms with new ones added, each once (the first meaning kept). */
export function mergeTerms(have: FoundTerm[], found: FoundTerm[]): FoundTerm[] {
  const seen = new Set(have.map(t => t.term.toLowerCase()));
  return [...have, ...found.filter(t => !seen.has(t.term.toLowerCase()) && seen.add(t.term.toLowerCase()))];
}

/**
 * The fuller glossary: every unfamiliar term in the notebook, including the
 * names the notes never explain (datasets, tools, acronyms, methods), found on
 * request (POST /reading/glossary/find), explained from the source where it
 * says, and saved with the notebook so it is paid for once. The book
 * underlines them; the cursor on one shows its meaning.
 */
export default function GlossaryCard({ notebookId, doc, level, onDoc, onSource, onClose }: {
  notebookId: number;
  doc: NotebookDoc;
  level: ReaderLevel;
  onDoc: (doc: NotebookDoc) => void;
  onSource?: (src: number[]) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const terms = doc.terms ?? [];

  async function find() {
    setBusy(true);
    try {
      const r = await readingApi.findTerms({ notebook_id: notebookId, level });
      const merged = mergeTerms(doc.terms ?? [], r.terms);
      const added = merged.length - terms.length;
      onDoc({ ...doc, terms: merged });
      toast(added ? `${added} ${added === 1 ? "term" : "terms"} added, underlined in your notes` : "No new unfamiliar terms found.");
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  const remove = (term: string) => onDoc({ ...doc, terms: terms.filter(t => t.term !== term) });

  async function toTermBank(t: FoundTerm) {
    try {
      await researchApi.addTerm(t.term, t.meaning);
      toast.success(`“${t.term}” is in your term bank`);
    } catch (e) {
      notifyError(e);
    }
  }

  const keep = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="nbk-help nbk-explain-card" role="dialog" aria-label="Glossary" onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
      <div className="nbk-help-head"><BookA size={13} /> <strong>Glossary</strong>
        <span className="muted">{terms.length ? `${terms.length} ${terms.length === 1 ? "term" : "terms"}, underlined in your notes` : "Unfamiliar words in these notes"}</span>
        <button type="button" className="nb-icon-btn" aria-label="Close" onClick={onClose}><X size={13} /></button></div>
      {terms.length > 0 ? (
        <ul className="nbk-terms nbk-glossary">
          {terms.map(t => (
            <li key={t.term}>
              <strong>{t.term}</strong> {t.meaning}
              <span className="nbk-explain-from">
                {t.from !== "general" && t.pages.length > 0 && onSource
                  ? <button type="button" className="nbk-help-src" onMouseDown={keep} onClick={() => onSource(t.pages)}>{termFrom(t)}</button>
                  : <span>{termFrom(t)}</span>}
                {t.unsure && <span className="nbk-explain-unsure">Not certain: check it.</span>}
                <button type="button" className="nb-icon-btn" aria-label={`Add ${t.term} to my term bank`} title="Add to my term bank"
                  onMouseDown={keep} onClick={() => void toTermBank(t)}><BookmarkPlus size={13} /></button>
                <button type="button" className="nb-icon-btn" aria-label={`Remove ${t.term}`} title="Remove from the glossary"
                  onMouseDown={keep} onClick={() => remove(t.term)}><X size={12} /></button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Find the words in these notes you may not know, including names they never explain: datasets,
          tools, acronyms and methods. Each is explained from your source where it says, and underlined on the page.</p>
      )}
      <div className="nbk-explain-actions">
        <button type="button" className="nbk-pill" disabled={busy} onMouseDown={keep} onClick={() => void find()}>
          {busy ? <><Loader2 size={13} className="spin" /> Reading your notes…</> : <><Search size={13} /> {terms.length ? "Find more unfamiliar terms" : "Find unfamiliar terms"}</>}
        </button>
      </div>
      <p className="muted nbk-explain-cost">Finding terms uses credits once; they are kept with this notebook.</p>
    </div>
  );
}
