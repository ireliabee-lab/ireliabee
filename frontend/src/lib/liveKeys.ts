/**
 * The live screen's keyboard, as pure decisions (SessionView, CompactOverlay).
 *
 * Two rules live here:
 *
 * 1. **Respond to one side.** R answers what *they* said (the interviewer, the
 *    other party); Shift+R answers what *you* said. It used to be one R that
 *    answered whoever spoke last, so with Auto Answer on the two sides could
 *    clash: the user's own half-sentence got answered instead of the question.
 *
 * 2. **Letters never fire while someone is typing.** A single-letter shortcut
 *    is ignored whenever a text box has focus, and for a moment after the
 *    transcript box was typed in even if focus has just left it (a submitted
 *    turn re-renders the screen). An e2e run lost the End button that way:
 *    "o" and "e" typed after Enter switched to the overlay and camera strip.
 */
import type { WaitingTurn } from "./autoAnswer";

export type Side = "user" | "interviewer";

/** Something a person types into: text inputs, text areas, selects, contenteditable, ARIA textboxes. */
export function isTypingTarget(el: unknown): boolean {
  const node = el as { tagName?: string; type?: string; isContentEditable?: boolean; getAttribute?: (n: string) => string | null } | null;
  if (!node || typeof node !== "object") return false;
  if (node.isContentEditable) return true;
  const tag = (node.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (node.type || "text").toLowerCase();
    return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset", "image"].includes(type);
  }
  return node.getAttribute?.("role") === "textbox";
}

/** How long after typing in the transcript box letters still count as typing. */
export const TYPING_GRACE_MS = 1500;

export type LiveAction =
  | "blur" | "save" | "keep-typing" | "answer-waiting" | "respond-them" | "respond-you"
  | "toggle-mic" | "toggle-system" | "both" | "capture" | "capture-choose" | "context" | "plan"
  | "type" | "next-view" | "camera";

export interface KeyLike { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean }

/** What a key does on the live screen, or null for nothing. */
export function liveKeyAction(e: KeyLike, ctx: {
  /** Focus (or the event's target) is somewhere text is typed. */
  typing: boolean;
  /** Milliseconds since the transcript box was last typed in (Infinity if never). */
  sinceTyped: number;
  /** A finished turn is waiting for Answer (Auto Answer off or paused). */
  hasWaiting: boolean;
  /** A picker or selector that owns the keyboard is open. */
  pickerOpen: boolean;
}): LiveAction | null {
  if (e.isComposing) return null;                        // an IME is mid-word
  if (e.key === "Escape" && ctx.typing) return "blur";
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") return "save";
  if (ctx.typing) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (ctx.pickerOpen) return null;
  // Focus has just left the box mid-typing: the letter belongs in the box.
  if (e.key.length === 1 && ctx.sinceTyped < TYPING_GRACE_MS) return "keep-typing";
  const key = e.key.toLowerCase();
  if ((key === "g" || e.key === "Enter") && ctx.hasWaiting) return "answer-waiting";
  switch (key) {
    case "r": return e.shiftKey ? "respond-you" : "respond-them";
    case "y": return "toggle-mic";
    case "l": return "toggle-system";
    case "a": return "both";
    case "c": return e.shiftKey ? "capture-choose" : "capture";
    case "x": return "context";
    case "p": return "plan";
    case "t": return "type";
    case "o": return "next-view";
    case "e": return "camera";
    default: return null;
  }
}

export type RespondPlan =
  /** Their (or your) turn is still being assembled: send it now. */
  | { kind: "flush"; withPartial: boolean; otherFirst: boolean }
  /** A finished turn from that side is waiting: answer it. */
  | { kind: "waiting"; turn: WaitingTurn }
  /** Nothing heard, but the box has text: send it as that side. */
  | { kind: "typed" }
  /** A turn from that side is being answered right now: asking again would only add a second card. */
  | { kind: "busy" }
  | { kind: "nothing" };

/**
 * What "respond to this side" means right now. Only that side's words are
 * ever answered; the other side's open turn is left to Auto Answer, except
 * that it is closed first when this side has started speaking over it.
 */
export function planRespond(side: Side, s: {
  open: Side | null;
  partial: { speaker: Side; text: string };
  waiting: WaitingTurn[];
  typed: string;
  /** Sides with a turn whose answer is on its way. */
  answering?: Side[];
}): RespondPlan {
  const partialMine = Boolean(s.partial.text.trim()) && s.partial.speaker === side;
  if (s.open === side || partialMine) {
    return { kind: "flush", withPartial: partialMine, otherFirst: s.open != null && s.open !== side };
  }
  const mine = s.waiting.filter(w => w.speaker === side);
  if (mine.length) return { kind: "waiting", turn: mine[mine.length - 1] };
  if (s.typed.trim()) return { kind: "typed" };
  if (s.answering?.includes(side)) return { kind: "busy" };
  return { kind: "nothing" };
}

/** The toast when that side's turn is already being answered. */
export function stillAnswering(side: Side, themLabel: string): string {
  const whose = side === "interviewer" ? `what ${themLabel.toLowerCase()} said` : "what you said";
  return `Still answering ${whose}. If it fails, the turn says so, with Try again.`;
}

/** The toast when there is nothing from that side to answer. */
export function nothingToAnswer(side: Side, themLabel: string): string {
  return side === "interviewer"
    ? `Nothing from ${themLabel.toLowerCase()} to answer yet. Shift+R answers what you said.`
    : "Nothing from you to answer yet. R answers what they said.";
}
