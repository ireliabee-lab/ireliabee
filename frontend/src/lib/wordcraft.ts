// Wordcraft — English from first words to expert communicator. Mirrors backend/wordcraft.py.
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";
import { checkMilestones } from "./milestones";

export type Goal = "everyday" | "work" | "study" | "exam" | "curious";
export const GOALS: { id: Goal; label: string }[] = [
  { id: "everyday", label: "Everyday life" },
  { id: "work", label: "Work" },
  { id: "study", label: "Study" },
  { id: "exam", label: "An English exam" },
  { id: "curious", label: "Just curious" },
];

export interface WcTrack { realm: number; placed_at: number; goal: Goal; show_pace: boolean; started_at: string; realm_at: string }
export type CardKind = "word" | "phrase" | "pattern";
export interface WcCard {
  id: number; card_id: string; kind: CardKind; text: string; meaning: string; example: string; goes_with: string;
  note: string; job: string; realm: number; reps: number; last_grade: number | null; first_seen: string | null; due: string | null;
}
/** A card as it appears in the content files (lesson intros). */
export interface CardDef { id: string; kind: CardKind; text: string; meaning: string; example: string; goes_with?: string[]; note?: string; job?: string; realm: number }
export interface Link { title: string; by?: string; url: string }

export type Drill =
  | { type: "choose"; prompt: string; options: string[]; answer: number; hint: string; why: string }
  | { type: "gap"; sentence: string; options: string[]; answer: number; hint: string; why: string }
  | { type: "order"; answer: string; hint: string; why: string }
  | { type: "fix"; sentence: string; answer: string; accept?: string[]; hint: string; why: string }
  | { type: "join"; parts: string[]; answers: string[]; hint: string; why: string };

export interface WcLesson {
  id: string; title: string; minutes: number; pillar: string; why: string; rule?: string; realm: number;
  cards: string[]; passage: { kind: "read"; title: string; text: string; links?: Link[] };
  drills?: Drill[]; write: { prompt: string; min_words: number }; speak: { prompt: string; character: string }; check: string;
  done?: boolean; score?: number | null; drill_count?: number;
}
export interface Exit { title: string; description: string; character: string; writing: boolean }
export interface Realm {
  id: number; name: string; cefr: string; blurb: string; goal: string; can_do: string[]; landmarks: string[]; exit: Exit;
  lessons: WcLesson[]; state: "done" | "current" | "locked"; placed: boolean; cards: number;
}
export interface ExitCheck { id: string; label: string; value: string; met: boolean; character?: string }
export interface ExitStatus { realm: number; exit: Exit; checks: ExitCheck[]; passed: boolean; lessons_done: number; lessons_total: number }
export interface Mission { week: string; kind: "phrases" | "character" | "write"; target: number; progress: number; text: string; done: boolean; found: string[] }

export type WcStepKind = "cards" | "wc_intro" | "wc_read" | "wc_drills" | "wc_write" | "wc_speak" | "wc_check" | "mission" | "exit" | "unknown";
export interface WcStep {
  id: string; kind: WcStepKind; title: string; done: boolean;
  minutes?: number; due?: number; new?: number;
  lesson?: WcLesson; realm?: { id: number; name: string; cefr: string }; answer?: string;
  cards?: CardDef[]; drills?: Drill[]; editor?: boolean;
  mission?: Mission; exit?: ExitStatus;
}
export interface WcSession {
  day: string; steps: WcStep[]; current: number | null; complete: boolean; started: boolean; minutes: number; streak: number;
  level: { id: number; name: string; cefr: string; lessons_done: number; lessons_total: number; exit_passed: boolean; levels: number };
  next_lesson: { id: string; title: string; minutes?: number } | null;
}
export interface Feedback {
  id?: number; score: number | null; strengths: string[];
  focus: { look_at: string; quote: string; better: string; why: string } | null; next: string;
}
export interface Writing { id: number; lesson_id: string; realm: number; prompt: string; text: string; score: number | null; feedback: Feedback; created_at: string }
export interface Skill { id: string; lessons_done: number; lessons_total: number; accuracy: number | null; score: number }
export interface Progress {
  track: WcTrack | null; cards: { total: number; seen: number; held: number; recall: number; by_kind: Record<CardKind, number> };
  days: number; streak: number; exercises: { done: number; right: number };
  writing: { date: string; score: number | null; words: number; sentences: number; words_per_sentence: number | null; joins_per_sentence: number | null; mtld: number | null }[];
  skills: Skill[]; cando: { realm: number; name: string; items: { text: string; rating: number | null }[] }[];
  rounds: { id: number; persona: string; title: string; created_at: string; answers: number; score: number | null }[];
}
export interface PlacementItem { id: string; realm: number; type: "choose" | "gap"; prompt?: string; sentence?: string; options: string[] }
export interface CharacterBrief { scenario: string; name: string; subject: string; details: string; tone: "basic" | "advanced" }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}
const get = <T>(path: string) => fetchApi(path).then(r => json<T>(r));
const send = <T>(method: string, path: string, body?: unknown) =>
  fetchApi(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(r => json<T>(r))
    .then(v => { checkMilestones("wordcraft"); return v; });   // any change may have earned a milestone

export const wordcraftApi = {
  track: () => get<{ track: WcTrack | null; content: { realms: number; lessons: number; cards: number } }>("/wordcraft/"),
  placement: () => get<{ items: PlacementItem[] }>("/wordcraft/placement"),
  place: (answers: Record<string, number>) => send<{ realm: number; name: string; by_realm: Record<string, number> }>("POST", "/wordcraft/placement", { answers }),
  start: (realm: number, goal: Goal) => send<WcTrack>("POST", "/wordcraft/start", { realm, goal }),
  updateTrack: (body: { goal?: Goal; show_pace?: boolean }) => send<WcTrack>("PATCH", "/wordcraft/track", body),
  session: () => get<WcSession>("/wordcraft/session"),
  sessionStep: (id: string, body: { answer?: string; done?: boolean; results?: boolean[] } = {}) =>
    send<WcSession>("POST", `/wordcraft/session/steps/${encodeURIComponent(id)}`, { done: true, ...body }),
  sessionMore: () => send<WcSession>("POST", "/wordcraft/session/more"),
  curriculum: () => get<{ realm: number; realms: Realm[] }>("/wordcraft/curriculum"),
  lesson: (id: string) => get<WcLesson & { card_list: CardDef[] }>(`/wordcraft/lessons/${encodeURIComponent(id)}`),
  markLesson: (id: string, done: boolean, answer = "") => send<{ done: boolean }>("POST", `/wordcraft/lessons/${encodeURIComponent(id)}`, { done, answer }),
  drills: (id: string, results: boolean[]) => send<{ score: number }>("POST", `/wordcraft/lessons/${encodeURIComponent(id)}/drills`, { results }),
  cards: (q = "", kind = "", realm?: number) =>
    get<{ cards: WcCard[]; stats: Progress["cards"] }>(`/wordcraft/cards?q=${encodeURIComponent(q)}&kind=${kind}${realm === undefined ? "" : `&realm=${realm}`}`),
  addCard: (body: { text: string; meaning: string; example?: string; kind?: CardKind }) => send<WcCard>("POST", "/wordcraft/cards", body),
  queue: () => get<{ due: WcCard[]; new: WcCard[] }>("/wordcraft/review"),
  grade: (cardId: number, grade: number) => send<WcCard>("POST", `/wordcraft/review/${cardId}`, { grade }),
  checkWriting: (text: string, lessonId = "", prompt = "") => send<Feedback>("POST", "/wordcraft/writing/check", { text, lesson_id: lessonId, prompt }),
  writing: () => get<Writing[]>("/wordcraft/writing"),
  character: (id: string, lessonId = "") => get<CharacterBrief>(`/wordcraft/characters/${id}?lesson_id=${encodeURIComponent(lessonId)}`),
  mission: () => get<Mission>("/wordcraft/mission"),
  missionDone: () => send<Mission>("POST", "/wordcraft/mission/done"),
  exit: () => get<ExitStatus>("/wordcraft/exit"),
  advance: () => send<WcTrack>("POST", "/wordcraft/advance"),
  progress: () => get<Progress>("/wordcraft/progress"),
  rateCando: (realm: number, ratings: number[]) => send<Progress>("PUT", `/wordcraft/cando/${realm}`, { ratings }),
};

export const CHARACTERS: Record<string, { name: string; role: string }> = {
  wc_guide: { name: "The Guide", role: "A patient tutor who travels with you" },
  wc_shopkeeper: { name: "The Shopkeeper", role: "Runs a busy market stall" },
  wc_neighbour: { name: "The Neighbour", role: "New in town and curious about you" },
  wc_colleague: { name: "The Colleague", role: "Works with you and needs things done" },
  wc_debater: { name: "The Debater", role: "Always takes the other side, politely" },
  wc_interviewer: { name: "The Interviewer", role: "Hires for a job you want" },
  wc_audience: { name: "The Audience", role: "A room after your talk" },
};

export const PILLAR_LABELS: Record<string, string> = {
  words: "Words", phrases: "Phrases", sentences: "Sentences", understanding: "Understanding",
  speaking: "Speaking", communicating: "Communicating",
};

// ── Checking answers ─────────────────────────────────────────────────────────

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b/g, "cannot"], [/\bwon't\b/g, "will not"], [/\bshan't\b/g, "shall not"], [/\blet's\b/g, "let us"],
  [/\b(\w+)n't\b/g, "$1 not"], [/\bi'm\b/g, "i am"], [/\b(\w+)'re\b/g, "$1 are"], [/\b(\w+)'ve\b/g, "$1 have"],
  [/\b(\w+)'ll\b/g, "$1 will"], [/\b(\w+)'d\b/g, "$1 would"],
  [/\b(it|that|there|what|who|where|here|he|she|how)'s\b/g, "$1 is"],
];

/**
 * A typed answer, made comparable: case, curly quotes, spacing, punctuation and
 * contractions ("I've" = "I have", "can't" = "cannot" = "can not") don't count.
 */
export function normalizeAnswer(text: string): string {
  let t = text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  t = t.replace(/\bcan not\b/g, "cannot");
  return t.replace(/[^a-z0-9'£$%\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Whether a typed answer matches any of the accepted ones. */
export function matches(given: string, accepted: string[]): boolean {
  const g = normalizeAnswer(given);
  return !!g && accepted.some(a => normalizeAnswer(a) === g);
}

/** Every answer a drill accepts, for typed drills. */
export function acceptedAnswers(d: Drill): string[] {
  if (d.type === "fix") return [d.answer, ...(d.accept ?? [])];
  if (d.type === "join") return d.answers;
  if (d.type === "order") return [d.answer];
  return [];
}

/** An order drill's words, shuffled the same way every time, never in the right order; the end mark stays put. */
export function scramble(answer: string, seed = 1): { tiles: string[]; end: string } {
  const m = /([.?!]+)$/.exec(answer.trim());
  const end = m ? m[1] : "";
  const words = answer.trim().replace(/[.?!]+$/, "").split(/\s+/);
  let x = seed * 9301 + 49297;
  const rand = () => { x = (x * 9301 + 49297) % 233280; return x / 233280; };
  const tiles = [...words];
  for (let attempt = 0; attempt < 6; attempt++) {
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }
    if (tiles.join(" ") !== words.join(" ")) break;
  }
  if (tiles.length > 1 && tiles.join(" ") === words.join(" ")) tiles.push(tiles.shift()!);
  return { tiles, end };
}

/** The words of a passage that belong to the lesson's cards, for highlighting. Longest first so phrases win. */
export function highlightTerms(cards: { text: string; kind: CardKind }[]): string[] {
  return cards.filter(c => c.kind !== "pattern").map(c => c.text.replace(/[.?!,]+$/, "").trim())
    .filter(t => t.length >= 2).sort((a, b) => b.length - a.length);
}

/** Split text into plain and highlighted runs for the given terms (whole words, any case). */
export function splitHighlights(text: string, terms: string[]): { text: string; hit: boolean }[] {
  if (!terms.length) return [{ text, hit: false }];
  const esc = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\b(${esc.join("|")})\\b`, "gi");
  const out: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), hit: false });
    out.push({ text: m[0], hit: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out;
}

export const countWords = (t: string) => (t.trim().match(/[A-Za-z0-9'’-]+/g) ?? []).length;
