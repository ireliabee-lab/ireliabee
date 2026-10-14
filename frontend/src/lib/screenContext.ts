/**
 * What a screenshot taken in a live session should be about: the other side's
 * latest question, and the lines before it as context (backend
 * routers/coach.py, _screen_question, caps them again).
 *
 * Someone presenting asks "why does revenue dip in Q3?" and the user presses C:
 * the answer has to be about that question, read off the slide.
 */

export interface ScreenContextTurn {
  id?: number;
  speaker: "user" | "interviewer";
  transcript: string;
  ts?: number;
  screenshot?: string;
  turnType?: string;   // the backend's classification, when it has one
}

export interface ScreenContext {
  /** The other side's latest question, or null when there isn't a recent one. */
  theirQuestion: string | null;
  /** The turn that question came from, so it can stop waiting once it's answered. */
  questionId: number | null;
  conversation: { speaker: "them" | "you"; text: string }[];
}

/** Only a question asked this recently counts; older, it is probably answered already. */
export const QUESTION_WINDOW_MS = 2 * 60 * 1000;
export const CONTEXT_LINES = 12;
/** Shorter than this is "okay", "right": not a question to answer. */
const MIN_QUESTION_CHARS = 8;

const clean = (s: string) => s.replace(/^(\[[^\]]*\]\s*)+/, "").replace(/\s+/g, " ").trim();

/** Reads as a question: the backend said so, it ends with "?", or it opens like one. */
const QUESTION_START = /^(why|what|how|when|where|who|which|can|could|would|do|does|did|is|are|was|were|will|should|have|has)\b/i;
const asks = (t: ScreenContextTurn) => t.turnType === "question" || /\?\s*$/.test(clean(t.transcript)) || QUESTION_START.test(clean(t.transcript));

export function screenContext(turns: ScreenContextTurn[], now: number = Date.now()): ScreenContext {
  // Speech only: earlier screenshots and pictures are not what was said.
  const said = turns.filter(t => !t.screenshot && !/^\[(SCREEN|IMAGE)/.test(t.transcript) && clean(t.transcript));
  const conversation = said.slice(-CONTEXT_LINES).map(t => ({
    speaker: t.speaker === "interviewer" ? "them" as const : "you" as const,
    text: clean(t.transcript),
  }));
  // Theirs, recent, and with a time on it: a turn loaded from a saved session
  // has none, and yesterday's question is not the one to answer now.
  const theirs = [...said].reverse().filter(t =>
    t.speaker === "interviewer" && t.ts != null && now - t.ts <= QUESTION_WINDOW_MS
    && clean(t.transcript).length >= MIN_QUESTION_CHARS);
  // The latest line that asks something, so "...as you can see here" after the
  // question doesn't take its place; failing that, their latest line.
  const pick = theirs.find(asks) ?? theirs[0];
  return { theirQuestion: pick ? clean(pick.transcript) : null, questionId: pick?.id ?? null, conversation };
}
