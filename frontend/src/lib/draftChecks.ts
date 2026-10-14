/**
 * Write's free checks: rules a draft can be read against on this computer, no AI and no credits
 * (docs/academic-writing.md, stage 4). Each comes from the University of Melbourne's Academic Skills
 * series, named in `videos`. A check reports; the writer decides.
 */
import { findMarkers } from "./citations";

export interface DraftSection { id: number; key: string; title: string; body: string; target: number }
export interface DraftInput {
  genre: string; firstPerson: boolean; wordLimit: number; keyTerms: string[]; sections: DraftSection[];
}
export type Level = "ok" | "tip" | "fix";
export interface Finding {
  key: string; level: Level; title: string; detail: string; videos: string[];
  where?: { sectionId: number; quote: string }[];
}

/** Sections that frame the argument rather than carry its evidence. */
const FRAMING = new Set(["intro", "conclusion", "abstract", "summary", "executive", "describe", "plan", "timeline", "ethics", "recommendations"]);
const INTRO = new Set(["intro", "background"]);

// ── Reading text ────────────────────────────────────────────────────────────────

/** Abbreviations whose full stop doesn't end a sentence. */
const NO_STOP = /\b(?:et al|e\.g|i\.e|cf|vs|etc|p|pp|ch|vol|no|fig|figs|eq|ed|eds|dr|mr|mrs|ms|prof|st|approx|ca|al|inc|ltd|jr|sr|[A-Z])\.$/i;

/** The text without citation markers and quotations: what the writer says in their own words. */
export function ownWords(text: string): string {
  return text.replace(/\[@[^\]\n]*\]/g, " ").replace(/[“"][^”"\n]{0,600}[”"]/g, " ");
}

export function sentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const piece of text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=["“(\[]?[A-Z0-9])/)) {
    current = current ? `${current} ${piece}` : piece;
    if (!NO_STOP.test(current.trim()) && !/\d\.$/.test(current.trim())) {
      if (current.trim()) out.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export const paragraphs = (text: string) => text.split(/\n\s*\n|\n/).map(p => p.trim()).filter(Boolean);
export const countWords = (text: string) => (text.replace(/\[@[^\]\n]*\]/g, " ").match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

const has = (re: RegExp, text: string) => { re.lastIndex = 0; return re.test(text); };
// From the start: test() leaves a global pattern's position after its last match, and matchAll starts there.
const matches = (re: RegExp, text: string) => { re.lastIndex = 0; return [...text.matchAll(re)].map(m => m[0]); };

const CONTRACTION = /\b(?:\w+n['’]t|(?:it|that|there|what|who|here|he|she|let)['’]s|(?:I|you|we|they)['’](?:re|ve|ll|d)|I['’]m|(?:he|she|it|that)['’](?:ll|d))\b/gi;
const VAGUE = /\b(?:things?|stuff|a lot of|lots of|a lot|got|gets?|getting|nice|really|very|kind of|sort of|basically|pretty much|huge|massive)\b/gi;
// "I" only as a word on its own (not the i in "i.e."); "US" the country is not "us".
const FIRST = /(?<![\w.])I(?![\w.])|\b(?:[Mm]e|[Mm]y|[Mm]ine|[Mm]yself|[Ww]e|[Uu]s|[Oo]ur|[Oo]urs|[Oo]urselves)\b/g;
const STARTERS = /^(?:And|But|So|Or|Also|Plus)\b/;
const CLICHE = /\b(?:since the (?:dawn|beginning) of (?:time|mankind|humanity)|in today['’]s (?:world|society|modern world)|throughout history|it goes without saying|at the end of the day|in this day and age|needless to say)\b/gi;
const ABSOLUTE = /\b(?:always|never|proves?|proven|certainly|undoubtedly|definitely|without (?:a )?doubt|obviously|clearly shows?|everyone|no one|nobody)\b/gi;
const THESIS_VERB = /\bthis (?:essay|paper|report|review|study|article|chapter|proposal|project)\s+(?:will\s+)?(?:argues?|contends?|proposes?|examines?|analy[sz]es?|discusse?s?|evaluates?|explores?|investigates?|shows?|demonstrates?|maintains?|considers?|assesses?|reviews?|aims?)\b/i;
const CONCLUDING = /\b(?:in conclusion|to conclude|overall|this (?:essay|paper|report|review|study) (?:has )?(?:shown|argued|demonstrated|found)|therefore|thus|it (?:can be|is) concluded|these findings (?:suggest|show|indicate))\b/i;
const AUTHOR_DATE = /\(([A-Z][\p{L}'’-]+(?: (?:et al\.|&|and) [A-Z][\p{L}'’-]+)?),? (?:\d{4}|n\.d\.)[a-z]?(?:, (?:p|pp)\. ?\d+(?:[–-]\d+)?)?\)|[A-Z][\p{L}'’-]+(?: et al\.)? \(\d{4}[a-z]?\)/u;
/** Abbreviations readers know without a definition. */
const KNOWN = new Set(["UK", "US", "USA", "EU", "UN", "NHS", "BBC", "PhD", "MSc", "BSc", "MA", "BA", "AI", "IT", "TV", "DNA", "RNA", "HIV", "AIDS", "COVID", "GDP", "CEO", "OK", "AM", "PM", "APA", "MLA", "IEEE", "NASA", "WHO", "UNESCO", "OECD", "STEM", "ICT", "PDF", "URL", "II", "III", "IV", "VI", "VII", "VIII", "IX", "XI", "XII"]);

function cites(paragraph: string): boolean {
  return findMarkers(paragraph).length > 0 || AUTHOR_DATE.test(paragraph);
}

function quoteWords(text: string): number {
  return [...text.matchAll(/[“"]([^”"\n]{1,600})[”"]/g)].map(m => countWords(m[1] as string)).filter(n => n >= 5).reduce((a, b) => a + b, 0);
}

// ── The checks ──────────────────────────────────────────────────────────────────

export function checkDraft(d: DraftInput): Finding[] {
  const out: Finding[] = [];
  const secs = d.sections.filter(s => s.body.trim());
  const total = d.sections.reduce((n, s) => n + countWords(s.body), 0);
  const quote = (s: DraftSection, text: string) => ({ sectionId: s.id, quote: text.length > 160 ? text.slice(0, 157) + "…" : text });

  if (!secs.length) {
    return [{ key: "empty", level: "tip", title: "Nothing to check yet", detail: "Write in at least one section, then run the checks again.", videos: [] }];
  }

  // Word limit: within 10% either side.
  if (d.wordLimit) {
    const off = total - d.wordLimit;
    const level: Level = Math.abs(off) <= d.wordLimit * 0.1 ? "ok" : total < d.wordLimit * 0.5 ? "tip" : "fix";
    out.push({ key: "limit", level, title: level === "ok" ? "Within 10% of the word limit" : off > 0 ? "Over the word limit" : "Under the word limit",
      detail: `${total.toLocaleString()} of ${d.wordLimit.toLocaleString()} words. Most tasks expect you to land within 10% either side.`,
      videos: ["MD2upUW9HgI"] });
  }

  // Introduction and conclusion take about 5% each, once the draft is long enough to judge.
  if (total >= 300) {
    const bad = d.sections.filter(s => (s.key === "intro" || s.key === "conclusion") && s.body.trim())
      .filter(s => { const share = countWords(s.body) / total; return share > 0.15 || share < 0.02; });
    out.push(bad.length
      ? { key: "frame", level: "tip", title: "Introduction or conclusion out of proportion", videos: ["mxwCPPGXY8w"],
          detail: "Each usually takes about 5% of the words (up to 10% in short pieces); the body carries the argument.",
          where: bad.map(s => quote(s, `${s.title}: ${Math.round((countWords(s.body) / total) * 100)}% of the words`)) }
      : { key: "frame", level: "ok", title: "Introduction and conclusion in proportion", detail: "Neither takes much more or less than its share.", videos: ["mxwCPPGXY8w"] });
  }

  // Sentence length: about 15 to 25 words on average; very long ones lose the reader.
  const all = secs.flatMap(s => sentences(ownWords(s.body)).map(t => ({ s, t, n: countWords(t) }))).filter(x => x.n > 0);
  if (all.length >= 3) {
    const mean = all.reduce((a, x) => a + x.n, 0) / all.length;
    const long = all.filter(x => x.n > 40);
    out.push({ key: "length", level: long.length ? "fix" : mean < 12 || mean > 28 ? "tip" : "ok",
      title: long.length ? `${long.length} very long sentence${long.length === 1 ? "" : "s"}` : `Sentences average ${Math.round(mean)} words`,
      detail: long.length ? "Over 40 words, a sentence is hard to follow. Split it where the idea turns."
        : mean < 12 ? "Many short sentences read like a list. Join related ideas with linking words."
        : mean > 28 ? "Long on average. Aim for about 15 to 25 words." : "Within the 15 to 25 words that read clearly.",
      videos: ["1n15ZkcX5sM", "6c8hZVhEt5k"], where: long.slice(0, 5).map(x => quote(x.s, x.t)) });
  }

  // Paragraphs: one idea, developed: more than a couple of sentences, less than half a page.
  const paras = secs.flatMap(s => paragraphs(s.body).map(p => ({ s, p })));
  const thin = paras.filter(x => !/^#|^\d+\.\s|^[-•]/.test(x.p) && sentences(x.p).length < 3 && countWords(x.p) >= 1 && !FRAMING.has(x.s.key));
  const heavy = paras.filter(x => countWords(x.p) > 250);
  if (paras.length >= 2) {
    out.push({ key: "paragraphs", level: thin.length || heavy.length ? "tip" : "ok",
      title: thin.length || heavy.length ? "Paragraphs to develop or split" : "Paragraphs well sized",
      detail: "A body paragraph develops one idea: a topic sentence, evidence and what it shows, usually four or more sentences and under 250 words.",
      videos: ["1n15ZkcX5sM"], where: [...thin.slice(0, 3).map(x => quote(x.s, x.p)), ...heavy.slice(0, 2).map(x => quote(x.s, `${countWords(x.p)} words: ${x.p}`))] });
  }

  const wordCheck = (key: string, re: RegExp, title: string, ok: string, detail: string, videos: string[], level: Level = "fix") => {
    const found = secs.flatMap(s => sentences(ownWords(s.body)).filter(t => has(re, t)).map(t => ({ s, t, words: matches(re, t) })));
    out.push(found.length
      ? { key, level, title: `${title}: ${[...new Set(found.flatMap(f => f.words.map(w => w.toLowerCase())))].slice(0, 6).join(", ")}`,
          detail, videos, where: found.slice(0, 5).map(f => quote(f.s, f.t)) }
      : { key, level: "ok", title: ok, detail: "None found in your own words (quotations are left alone).", videos });
  };
  wordCheck("contractions", CONTRACTION, "Contractions", "No contractions", "Write them out in full: do not, it is, cannot.", ["4s_0um-fnXU", "MD2upUW9HgI"]);
  wordCheck("vague", VAGUE, "Vague or informal words", "No vague or informal words", "Say exactly what you mean: 'factors' or 'evidence' rather than 'things', 'many' rather than 'a lot of'.", ["4s_0um-fnXU"], "tip");
  wordCheck("cliche", CLICHE, "Sweeping openers", "No sweeping openers", "Start from the specific context of your topic, not all of history.", ["mxwCPPGXY8w"]);
  wordCheck("absolute", ABSOLUTE, "Claims stronger than evidence allows", "Claims are measured", "Hedge to match the evidence: suggests, indicates, is likely, may.", ["4s_0um-fnXU"], "tip");
  if (!d.firstPerson) {
    wordCheck("first", FIRST, "First person", "No first person", "This kind of writing is usually impersonal: 'This essay argues' rather than 'I argue'. Check your task's guidance.", ["4s_0um-fnXU", "H9FU90d-qjI"], "tip");
  }

  // Sentences that open with a conjunction read as speech.
  const starters = secs.flatMap(s => sentences(ownWords(s.body)).filter(t => STARTERS.test(t)).map(t => ({ s, t })));
  out.push(starters.length
    ? { key: "starters", level: "tip", title: `${starters.length} sentence${starters.length === 1 ? "" : "s"} starting with And, But or So`, videos: ["4s_0um-fnXU", "1n15ZkcX5sM"],
        detail: "Use a formal link instead: In addition, However, Therefore.", where: starters.slice(0, 5).map(x => quote(x.s, x.t)) }
    : { key: "starters", level: "ok", title: "Sentences open formally", detail: "No sentence starts with And, But or So.", videos: ["4s_0um-fnXU"] });

  // Every body paragraph that makes a claim should credit its evidence.
  const body = paras.filter(x => !FRAMING.has(x.s.key) && sentences(x.p).length >= 2);
  if (body.length) {
    const uncited = body.filter(x => !cites(x.p));
    out.push({ key: "citations", level: uncited.length ? "fix" : "ok",
      title: uncited.length ? `${uncited.length} body paragraph${uncited.length === 1 ? "" : "s"} with no citation` : "Every body paragraph cites its evidence",
      detail: "Credit the source of each piece of evidence in the paragraph that uses it. A paragraph of your own analysis may stand alone, but most need one.",
      videos: ["1n15ZkcX5sM", "MD2upUW9HgI", "H9FU90d-qjI"], where: uncited.slice(0, 5).map(x => quote(x.s, x.p)) });
  }

  // Quotations: under 10% of the words, ideally about 5%.
  const quoted = secs.reduce((n, s) => n + quoteWords(s.body), 0);
  if (total >= 150) {
    const share = quoted / total;
    out.push({ key: "quotes", level: share > 0.1 ? "fix" : share > 0.05 ? "tip" : "ok",
      title: `Direct quotation: ${Math.round(share * 100)}% of the words`,
      detail: share > 0.05 ? "Paraphrase more: your own words show your understanding. Keep quotation under 10%, ideally about 5%."
        : "Mostly in your own words, as it should be.", videos: ["H9FU90d-qjI", "jpE_DwnNc_s"] });
  }

  // Abbreviations defined the first time they appear: "World Health Organization (WHO)".
  const text = secs.map(s => s.body).join("\n");
  const undefinedAbbr: string[] = [];
  const seen = new Set<string>();
  for (const m of ownWords(text).matchAll(/\b[A-Z][A-Z0-9]{1,7}s?\b/g)) {
    const abbr = (m[0] as string).replace(/s$/, "");
    if (seen.has(abbr) || KNOWN.has(abbr) || /^\d/.test(abbr)) continue;
    seen.add(abbr);
    const first = new RegExp(`\\b${abbr}`).exec(text)?.index ?? 0;
    const defined = new RegExp(`\\(${abbr}s?\\)`).exec(text);
    if (!defined || defined.index > first + abbr.length + 2) undefinedAbbr.push(abbr);
  }
  out.push(undefinedAbbr.length
    ? { key: "abbr", level: "tip", title: `Abbreviations to define: ${undefinedAbbr.slice(0, 6).join(", ")}`, videos: ["1n15ZkcX5sM", "MD2upUW9HgI"],
        detail: "Give the full term the first time, with the abbreviation in brackets: 'cognitive behavioural therapy (CBT)'." }
    : { key: "abbr", level: "ok", title: "Abbreviations defined", detail: "Each is spelled out the first time, or widely known.", videos: ["1n15ZkcX5sM"] });

  // The introduction states the thesis; the conclusion concludes, without new sources.
  const intro = d.sections.find(s => INTRO.has(s.key) && s.body.trim());
  if (intro && d.genre !== "reflective") {
    out.push(has(THESIS_VERB, intro.body)
      ? { key: "thesis", level: "ok", title: "The introduction states its aim", detail: "It says what the piece argues or examines.", videos: ["mxwCPPGXY8w"] }
      : { key: "thesis", level: "tip", title: "No thesis statement found in the introduction", videos: ["mxwCPPGXY8w", "MD2upUW9HgI"],
          detail: "Say plainly what the piece does: 'This essay argues that…', 'This paper examines…'." });
  }
  const conclusion = d.sections.find(s => s.key === "conclusion" && s.body.trim());
  if (conclusion) {
    const newSources = cites(conclusion.body);
    out.push({ key: "conclusion", level: newSources ? "tip" : has(CONCLUDING, conclusion.body) ? "ok" : "tip",
      title: newSources ? "The conclusion cites sources" : has(CONCLUDING, conclusion.body) ? "The conclusion concludes" : "Say what your conclusion shows",
      detail: newSources ? "A conclusion draws together what you have shown; new evidence belongs in the body."
        : has(CONCLUDING, conclusion.body) ? "It signals what the piece has shown." : "Go beyond a summary: say what it all shows, and why it matters.",
      videos: ["mxwCPPGXY8w"] });
  }

  // Every key term from the brief appears in the draft.
  if (d.keyTerms.length) {
    const lower = text.toLowerCase();
    const missing = d.keyTerms.filter(t => !lower.includes(t.toLowerCase()));
    out.push({ key: "terms", level: missing.length ? "fix" : "ok",
      title: missing.length ? `Key terms not used: ${missing.join(", ")}` : "Every key term from the brief appears",
      detail: missing.length ? "The marker looks for the task's key terms. Address each one, in these words or clearly equivalent ones." : "You address the task in its own terms.",
      videos: ["pIygWc2FQiA", "MD2upUW9HgI"] });
  }

  const rank: Record<Level, number> = { fix: 0, tip: 1, ok: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
