/**
 * Reading an assignment brief and a research question, by rule, on this computer (no AI).
 *
 * Follows the University of Melbourne's task analysis (direction, content and limiting words) and
 * its research question criteria; docs/academic-writing.md. A rule here only suggests: the writer
 * confirms what the task really asks.
 */

/** Direction words and what each asks for. Longer phrases first, so "critically evaluate" wins over "evaluate". */
export const DIRECTIONS: [string, string][] = [
  ["to what extent", "Judge how far something is true: weigh the evidence for and against, and reach a position."],
  ["critically evaluate", "Judge the worth of something with evidence, its strengths and weaknesses, and reach a verdict."],
  ["critically analyse", "Break it into parts, examine how they work and relate, and judge their significance."],
  ["critically analyze", "Break it into parts, examine how they work and relate, and judge their significance."],
  ["critically discuss", "Explore the arguments on several sides with evidence, and argue a position."],
  ["compare and contrast", "Show both the similarities and the differences, and what they mean."],
  ["account for", "Explain why something happens or happened, giving reasons."],
  ["comment on", "Give your view on the main points, backed by evidence."],
  ["analyse", "Break it into parts and examine how they work and relate to each other."],
  ["analyze", "Break it into parts and examine how they work and relate to each other."],
  ["argue", "Take a position and defend it with reasons and evidence, answering objections."],
  ["assess", "Weigh up its value or importance, with evidence, and reach a judgement."],
  ["compare", "Show the similarities, and usually the differences, and what they mean."],
  ["contrast", "Show the differences and what they mean."],
  ["critique", "Assess its strengths and weaknesses against criteria, and reach a judgement."],
  ["define", "Give the precise meaning, and how it is used in your field."],
  ["describe", "Say what it is like, in detail. Little analysis is asked for."],
  ["discuss", "Explore the arguments and evidence on different sides, then reach a reasoned position."],
  ["evaluate", "Judge the worth or success of something with evidence, and reach a verdict."],
  ["examine", "Look at it closely and critically, and say what it reveals."],
  ["explain", "Make clear how or why something happens, with reasons."],
  ["explore", "Investigate it from several angles, and say what you found."],
  ["identify", "Name and briefly describe the main points or features."],
  ["illustrate", "Make it clear with examples."],
  ["interpret", "Say what something means and why, with evidence."],
  ["justify", "Give good reasons and evidence for a decision or conclusion."],
  ["outline", "Give the main points or structure, without detail."],
  ["propose", "Put forward a plan or answer, and support it."],
  ["recommend", "Advise a course of action, with reasons."],
  ["reflect", "Think about an experience, what it meant and what you learned, linking it to theory."],
  ["review", "Survey and assess what has been written or done, critically."],
  ["summarise", "Give the main points briefly, without detail or comment."],
  ["summarize", "Give the main points briefly, without detail or comment."],
];

/** Common words that are never key terms (stop words, task wording, and the direction words themselves). */
const STOP = new Set(("a an the and or but if then than of to in on at by for from with without within into onto upon about above below " +
  "between among across through during before after since until while as is are was were be been being am do does did done have has had " +
  "it its this that these those there their they them he she his her we our you your i me my not no nor so such can could may might must " +
  "shall should will would also any all each every some most more many much few other another own same both either neither only very just " +
  "what which who whom whose why how when where use using used make made include including includes required require requires words word " +
  "essay report paper answer question task assignment write writing written least minimum maximum approximately around about least " +
  "sources source reference references referencing cite citation style apa harvard ieee mla chicago vancouver one two three four five six " +
  "seven eight nine ten first second third relevant appropriate example examples way ways one's part parts give given well " +
  "draw drawing peer-reviewed peer reviewed academic scholarly literature research topic consider considering focus " +
  "discussion analysis evaluation account overview summary conclusion introduction").split(" "));

export interface Found { text: string; start: number; end: number }
export interface DirectionFound extends Found { meaning: string }
export interface TaskAnalysis {
  directions: DirectionFound[];
  limits: Found[];
  requirements: string[];
  wordLimit: number | null;
  keyTerms: string[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every direction word or phrase in the brief, as a whole word, longest first and never overlapping. */
export function findDirections(brief: string): DirectionFound[] {
  const out: DirectionFound[] = [];
  const taken: [number, number][] = [];
  for (const [phrase, meaning] of DIRECTIONS) {
    const re = new RegExp(`\\b${esc(phrase).replace(/ /g, "\\s+")}\\b`, "gi");
    for (const m of brief.matchAll(re)) {
      const start = m.index ?? 0, end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      out.push({ text: m[0], start, end, meaning });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Words that narrow the task: years and periods, numbers of things, places and groups introduced by "in"/"among". */
export function findLimits(brief: string): Found[] {
  const patterns = [
    /\b(?:in|during|since|from|between|after|before)\s+(?:the\s+)?(?:(?:early|late|mid)[-\s])?(?:1[5-9]|20)\d\d(?:s)?(?:\s*(?:and|to|–|-)\s*(?:1[5-9]|20)\d\d(?:s)?)?/gi,
    /\b(?:in|over)\s+the\s+(?:last|past)\s+\w+\s+(?:years?|decades?|months?)/gi,
    /\b(?:at\s+least|a\s+minimum\s+of|no\s+more\s+than|up\s+to|maximum\s+of)\s+\w+\s+[a-z-]+(?:\s+[a-z-]+)?/gi,
    /\b(?:in|across|within)\s+(?:the\s+)?(?:[A-Z][\w-]+)(?:\s+(?:[A-Z][\w-]+|and|of))*/g,
    /\b(?:among|for)\s+(?:young\s+|older\s+|adult\s+)?(?:adults|children|students|women|men|patients|teachers|nurses|employees|people|learners|speakers|users|workers)(?:\s+(?:who|with|in|aged)\s+[\w\s-]{2,30}?)?(?=[.,;:]|\s+(?:and|to|in|is|are)\b|$)/gi,
  ];
  const out: Found[] = [];
  for (const re of patterns) {
    for (const m of brief.matchAll(re)) {
      const start = m.index ?? 0, end = start + m[0].length;
      if (out.some(f => start < f.end && end > f.start)) continue;
      out.push({ text: m[0].trim(), start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Whole sentences that set a requirement: must, should, at least, include, required, needs to. */
export function findRequirements(brief: string): string[] {
  const sentences = brief.replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-Z0-9•\-(])|\s*[•\n]\s*/).map(s => s.trim()).filter(Boolean);
  return sentences.filter(s => /\b(must|should|at least|minimum|include|including|required|requirement|need(?:s)? to|you will|are expected|use\s+(?:the\s+)?(?:apa|harvard|ieee|mla|chicago|vancouver))\b/i.test(s));
}

/** The word limit the brief sets: "2,000 words", "1500-2000 words" (the upper figure), "approximately 2000 words". */
export function findWordLimit(brief: string): number | null {
  const m = /(\d{1,3}(?:[,.\s]\d{3})+|\d{3,6})\s*(?:(?:-|–|to)\s*(\d{1,3}(?:[,.\s]\d{3})+|\d{3,6})\s*)?(?:words?\b|-word\b)/i.exec(brief);
  if (!m) return null;
  const num = (s: string) => Number(s.replace(/[,.\s]/g, ""));
  const n = m[2] ? num(m[2]) : num(m[1] as string);
  return n >= 100 && n <= 200_000 ? n : null;
}

/** The content words: what the task is about, by how often they appear, without filler or task wording. */
export function findKeyTerms(brief: string, max = 8): string[] {
  const directionWords = new Set(DIRECTIONS.flatMap(([p]) => p.split(" ")));
  // A place, a period or a number of sources is a limiting word, not what the task is about.
  const limits = findLimits(brief);
  const counts = new Map<string, { n: number; first: number; shown: string }>();
  const words = [...brief.matchAll(/[A-Za-z][A-Za-z'-]{2,}/g)];
  words.forEach((m, i) => {
    const w = m[0].toLowerCase().replace(/'s$/, "");
    const at = m.index ?? 0;
    if (limits.some(l => at >= l.start && at < l.end)) return;
    if (STOP.has(w) || directionWords.has(w) || w.length < 4) return;
    const prev = counts.get(w);
    counts.set(w, { n: (prev?.n ?? 0) + 1, first: prev?.first ?? i, shown: prev?.shown ?? m[0] });
  });
  // Two content words that keep appearing side by side are one idea: "remote work", "speech timing".
  const kept = words.filter(m => counts.has(m[0].toLowerCase().replace(/'s$/, "")));
  const pairs = new Map<string, number>();
  for (let i = 0; i + 1 < kept.length; i++) {
    const a = kept[i] as RegExpMatchArray, b = kept[i + 1] as RegExpMatchArray;
    const between = brief.slice((a.index ?? 0) + a[0].length, b.index ?? 0);
    if (!/^\s+$/.test(between)) continue;
    const pair = `${a[0].toLowerCase()} ${b[0].toLowerCase()}`;
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  const phrases = [...pairs.entries()].filter(([, n]) => n >= 2).map(([p]) => p);
  const inPhrase = new Set(phrases.flatMap(p => p.split(" ")));
  const singles = [...counts.entries()]
    .filter(([w]) => !inPhrase.has(w))
    .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
    .map(([, v]) => v.shown);
  return [...phrases, ...singles].slice(0, max);
}

export function analyseTask(brief: string): TaskAnalysis {
  return {
    directions: findDirections(brief),
    limits: findLimits(brief),
    requirements: findRequirements(brief),
    wordLimit: findWordLimit(brief),
    keyTerms: findKeyTerms(brief),
  };
}

// ── Research question ──────────────────────────────────────────────────────────

export interface QuestionCheck { key: string; ok: boolean; label: string; tip: string }

const YES_NO = /^(is|are|was|were|does|do|did|can|could|will|would|should|has|have|had)\b/i;
const OPEN = /^(what|how|why|to what extent|in what ways?|which|under what conditions|who)\b/i;
const SCOPE = /\b(?:(?:1[5-9]|20)\d\d|in\s+[A-Z][\w-]+|among|aged|adults|children|students|patients|teachers|women|men|people|learners|speakers|employees|users|workers|organisations?|organizations?|schools?|universities|hospitals?|countries|region|rural|urban|during|since|between|over\s+the)\b/;

/** The research question criteria from the series, each a pass or a tip. */
export function checkQuestion(text: string): QuestionCheck[] {
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const question = lines.find(l => l.endsWith("?")) ?? lines[0] ?? "";
  const rest = text.replace(question, " ");
  const words = question.split(/\s+/).filter(Boolean).length;
  return [
    { key: "question", ok: question.endsWith("?"), label: "It is phrased as a question",
      tip: "End it with a question mark, so it is clear what you will answer." },
    { key: "open", ok: OPEN.test(question) && !YES_NO.test(question), label: "It can't be answered with yes or no",
      tip: "Start with what, how, why or to what extent. A question starting 'Is' or 'Does' invites a one-word answer." },
    { key: "count", ok: !/^how\s+(many|much)\b/i.test(question), label: "It isn't answered by a single number",
      tip: "'How many' asks for a figure. Ask what explains it, or what it means, instead." },
    { key: "scope", ok: SCOPE.test(question), label: "It names its scope: who, where or when",
      tip: "Narrow it: a group of people, a place, or a period, so the word limit can carry it." },
    { key: "length", ok: words >= 8 && words <= 40, label: "It is specific but not overloaded",
      tip: words < 8 ? "Add what exactly you will look at, and in whom or where." : "Split it: one main question, with sub-questions if needed." },
    { key: "purpose", ok: /\b(purpose|aim|objective|goal)s?\s+(of\s+this|is|are)\b|\bthis\s+(study|paper|project|research|review)\s+(aims|will|seeks)\b/i.test(rest),
      label: "A purpose statement goes with it", tip: "Add a sentence: 'The purpose of this study is to…', saying why the answer matters." },
  ];
}
