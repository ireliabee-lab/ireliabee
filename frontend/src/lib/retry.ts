/**
 * Practice from real calls (roadmap 3.4): a hard moment to practise again.
 * Any screen can hand one to Practice → Hard moments with `practiseMoment`.
 */
export interface Moment {
  session_id: number | null;
  session_title?: string;
  date?: string;
  question: string;
  previous_answer: string;
  score: number | null;
  feedback?: string;
  improvements?: string[];
  source?: "debrief" | "mock" | "transcript";
  best_retry?: { score: number; at: string } | null;
}

let pending: Moment | null = null;

/** Open Practice → Hard moments on this moment. */
export function practiseMoment(m: Moment) {
  pending = m;
  window.dispatchEvent(new CustomEvent("navigate", { detail: "practice" }));
  // Practice may already be open: switch mode after it has had a chance to mount.
  setTimeout(() => window.dispatchEvent(new CustomEvent("practice-mode", { detail: "retry" })), 0);
}

/** The moment handed over by another screen, once. */
export function takePendingMoment(): Moment | null {
  const m = pending;
  pending = null;
  return m;
}
