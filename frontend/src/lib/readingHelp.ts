/**
 * Help while reading (Deep Read, B3): the terms a notebook defines, and which
 * one the cursor is resting on. Pure, so it is tested without a book.
 */
import type { NotebookDoc } from "./notebook";

export interface KnownTerm { term: string; meaning: string; src: number[]; /** A found term's meaning is iReliabee's unless it came from the source. */ ours?: boolean }

/** Every term the notebook defines (a glossary, or definition blocks anywhere), once each, longest first. */
export function knownTerms(doc: NotebookDoc): KnownTerm[] {
  const seen = new Map<string, KnownTerm>();
  for (const s of doc.sections ?? []) {
    for (const b of s.blocks ?? []) {
      const term = (b.type === "definition" && typeof b.term === "string" ? b.term : "").trim();
      if (term.length < 2 || seen.has(term.toLowerCase())) continue;
      seen.set(term.toLowerCase(), { term, meaning: String(b.text ?? "").trim(), src: Array.isArray(b.src) ? b.src : [] });
    }
  }
  // Then the terms found for the notebook (the fuller glossary); the notebook's own definitions win.
  for (const t of doc.terms ?? []) {
    const term = t.term.trim();
    if (term.length < 2 || seen.has(term.toLowerCase())) continue;
    seen.set(term.toLowerCase(), { term, meaning: t.meaning, src: t.pages ?? [], ours: t.from === "general" });
  }
  return [...seen.values()].sort((a, b) => b.term.length - a.term.length);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The term the cursor is on in this line, if any: whole words only, any case,
 * the longest that fits. Not on the term's own definition line ("entropy — …"),
 * which already says what it means.
 */
export function termAt(line: string, offset: number, terms: KnownTerm[]): KnownTerm | null {
  for (const t of terms) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escape(t.term)})(?=$|[^\\p{L}\\p{N}])`, "giu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const start = m.index + m[1].length;
      const end = start + m[2].length;
      if (offset >= start && offset <= end) {
        // "entropy — how disordered…" is the term's own definition: nothing to add there.
        if (start === line.length - line.trimStart().length && /^\s*[—–:-]/.test(line.slice(end))) break;
        return t;
      }
    }
  }
  return null;
}
