/**
 * What happens once a speaker has finished a turn (live capture).
 *
 * The turn assembler (./turnAssembler.ts) decides *when* someone has finished:
 * it joins slow phrases into one turn and waits out the pause the user chose.
 * This decides what happens *next*, and it is the part that spends money:
 *
 *   Auto Answer On   the finished turn goes to the coach straight away.
 *   Auto Answer Off  the finished turn waits, visibly, until the user presses
 *                    Answer or R. Nothing is spent until they do.
 *
 * "Respond now" (R while someone is still talking) is never decided here: the
 * user asked for it, so it always sends.
 *
 * One safety net on top: if automatic answers arrive faster than any real
 * conversation produces them — a video playing, a noisy room — Auto Answer
 * pauses instead of spending. It never turns itself off and never drops what
 * was heard; the turns wait like they do when it is Off, and one click
 * resumes it. A session once left listening made 245 calls in 43 minutes;
 * this is what would have stopped it.
 */

/** Automatic answers allowed inside the window before Auto Answer pauses. */
export const RUNAWAY_LIMIT = 40;
export const RUNAWAY_WINDOW_MS = 5 * 60_000;

export const RUNAWAY_MESSAGE =
  "Auto Answer paused: it was answering far more often than a conversation needs — " +
  "usually a video or background noise. Nothing was lost; new turns wait for you. " +
  "Press Resume when you're ready.";

export type AutoDecision = "send" | "wait" | "pause";

/**
 * Auto Answer is set for each side: what they say (`them`) and what you say
 * (`you`). Remembered on this computer for the next session. Before there were
 * two switches one covered both sides, so a computer that only remembers that
 * one starts with yours the same as theirs.
 */
export interface AutoSides { them: boolean; you: boolean }

export const AUTO_THEM_KEY = "autoAnswer";
export const AUTO_YOU_KEY = "autoAnswerYou";

export function storedAutoSides(): AutoSides {
  try {
    const them = localStorage.getItem(AUTO_THEM_KEY) === "1";
    const you = localStorage.getItem(AUTO_YOU_KEY);
    return { them, you: you === null ? them : you === "1" };
  } catch {
    return { them: false, you: false };
  }
}

export function rememberAutoSides(s: AutoSides): void {
  try {
    localStorage.setItem(AUTO_THEM_KEY, s.them ? "1" : "0");
    localStorage.setItem(AUTO_YOU_KEY, s.you ? "1" : "0");
  } catch { /* the next session starts with the defaults */ }
}

/** Whether Auto Answer is on for the side that just finished speaking. */
export function autoOnFor(speaker: "user" | "interviewer", s: AutoSides): boolean {
  return speaker === "user" ? s.you : s.them;
}

/** Send the finished turn now, keep it waiting, or pause Auto Answer and keep it waiting. */
export function decide(o: { enabled: boolean; paused: boolean; now: number; recent: number[] }): AutoDecision {
  if (!o.enabled || o.paused) return "wait";
  const inWindow = o.recent.filter(t => o.now - t < RUNAWAY_WINDOW_MS).length;
  return inWindow >= RUNAWAY_LIMIT ? "pause" : "send";
}

/** Record an automatic answer, forgetting those that have left the window. */
export function remember(recent: number[], now: number): number[] {
  return [...recent.filter(t => now - t < RUNAWAY_WINDOW_MS), now];
}

/** A finished turn nobody has asked the coach about yet. */
export interface WaitingTurn {
  id: number;
  speaker: "user" | "interviewer";
  text: string;
  /** Text an earlier answer was given to, when the speaker carried on. */
  replaces?: string;
}

/**
 * Add a finished turn to the waiting list. A turn that grew (the speaker
 * carried on) replaces its earlier self rather than waiting twice.
 */
export function enqueue(list: WaitingTurn[], turn: WaitingTurn): WaitingTurn[] {
  return [...list.filter(t => t.id !== turn.id), turn];
}

/** The most recent waiting turn — what "Answer" and R answer. */
export function latest(list: WaitingTurn[]): WaitingTurn | null {
  return list.length ? list[list.length - 1] : null;
}

/** The most recent waiting turn from one side — what R (theirs) and Shift+R (yours) answer. */
export function latestOf(list: WaitingTurn[], speaker: WaitingTurn["speaker"]): WaitingTurn | null {
  return latest(list.filter(t => t.speaker === speaker));
}

export function without(list: WaitingTurn[], id: number): WaitingTurn[] {
  return list.filter(t => t.id !== id);
}

/**
 * Errors after which Auto Answer pauses itself: every later turn would fail
 * the same way, each a failing call and a toast (audit 180-M11, 178-M9).
 * Paused, not switched off: the user resumes once it is fixed.
 */
const PAUSES_AUTO_ANSWER = new Set([
  "out_of_credits", "signed_out", "daily_limit", "account_suspended", "rate_limited", "service_unavailable",
]);

export function pausesAutoAnswer(err: unknown): boolean {
  const code = (err as { info?: { code?: string } })?.info?.code ?? (err as { code?: string })?.code;
  return typeof code === "string" && PAUSES_AUTO_ANSWER.has(code);
}
