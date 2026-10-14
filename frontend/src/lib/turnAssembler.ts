/**
 * Turn assembly for live transcription.
 *
 * Speech-to-text finalises a line after ~1 s of silence, so a slow or
 * thoughtful speaker ("Tell me about… [4 s] …a time you led a team") arrives
 * as several transcripts. Answering each one separately gives the user a
 * stack of half-answers. The assembler merges them into one turn and only
 * hands it to the coach once the speaker has really finished:
 *
 *  • Consecutive finals from the same speaker are joined into one segment.
 *  • The segment is sent after `pauseMs` of silence, stretched when the text
 *    sounds unfinished ("…and", "so,", "um") and shortened after a clear "?".
 *    Silence is measured from the last sign of speech: a final line, a live
 *    partial, or the moment voice activity stopped — so batch providers,
 *    whose text lands seconds after the audio, aren't cut off early.
 *  • While the speaker's voice activity is on, the countdown is held (with a
 *    cap, so a noisy line can't hold it forever).
 *  • When the other person starts talking, the open segment is sent at once.
 *  • If the same speaker carries on shortly after a segment was sent, that
 *    segment is re-opened: the caller cancels / replaces its answer and the
 *    merged question is asked again, so there is one answer per question.
 *
 * Pure logic, no React: the host wires callbacks to UI state.
 */

export type Speaker = "user" | "interviewer";

export const PAUSE_TOLERANCES = [
  { id: "quick",   label: "Quick (1.5s)",        ms: 1500 },
  { id: "normal",  label: "Normal (3s)",         ms: 3000 },
  { id: "patient", label: "Patient (5s)",        ms: 5000 },
  { id: "relaxed", label: "Very patient (8s)",   ms: 8000 },
] as const;

export type PauseToleranceId = (typeof PAUSE_TOLERANCES)[number]["id"];

const PAUSE_KEY = "pauseTolerance";
const DEFAULT_PAUSE: PauseToleranceId = "normal";

export function getPauseTolerance(): PauseToleranceId {
  try {
    const v = localStorage.getItem(PAUSE_KEY);
    return PAUSE_TOLERANCES.some(p => p.id === v) ? (v as PauseToleranceId) : DEFAULT_PAUSE;
  } catch { return DEFAULT_PAUSE; }
}

export function setPauseTolerance(id: PauseToleranceId) {
  try { localStorage.setItem(PAUSE_KEY, id); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("pause-tolerance", { detail: id }));
}

export function pauseMsFor(id: PauseToleranceId): number {
  return PAUSE_TOLERANCES.find(p => p.id === id)?.ms ?? 3000;
}

// Words a sentence rarely ends on: the speaker is mid-thought.
const TRAILING = new Set([
  "and", "but", "or", "so", "because", "like", "um", "uh", "er", "erm", "hmm", "then",
  "the", "a", "an", "to", "of", "with", "for", "that", "which", "if", "when", "about",
  "my", "your", "our", "their", "is", "are", "was", "were", "in", "on", "at", "as",
  "how", "what", "why", "where", "who", "also", "just", "maybe", "basically", "actually",
]);

/**
 * How long to wait, relative to the base tolerance, before treating this text
 * as finished. >1 = sounds unfinished, <1 = sounds complete.
 */
export function endingFactor(text: string): number {
  const t = text.trim();
  if (!t) return 1;
  if (/(\.\.\.|…|,|;|:|-|—|–)$/.test(t)) return 1.6;          // trailing off
  const words = t.toLowerCase().replace(/[^a-z'\s]/g, " ").split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] ?? "";
  if (!/[.?!]$/.test(t) && TRAILING.has(last)) return 1.6;
  if (words.length < 4) return 1.3;                               // too short to be a whole question
  if (/\?$/.test(t)) return 0.6;                                  // a complete question
  if (/[.!]$/.test(t) && words.length >= 6) return 0.85;
  return 1;
}

export const MIN_WAIT_MS = 900;
export const MAX_WAIT_MS = 12_000;
/** Longest voice activity can hold a segment open without new final text. */
export const MAX_HOLD_MS = 25_000;
const HOLD_POLL_MS = 400;
/**
 * Batch providers (local Whisper, Groq, OpenAI) send no partials and deliver
 * text a second or two after the audio. When the speaker spoke after the last
 * text arrived, allow this much extra for that text to land before sending.
 */
export const TRANSCRIPTION_GRACE_MS = 1500;

export function waitMsFor(text: string, pauseMs: number): number {
  return Math.round(Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, pauseMs * endingFactor(text))));
}

export interface Segment {
  /** Host-assigned id (the transcript turn this segment renders into). */
  id: number;
  speaker: Speaker;
  text: string;
  /** The last text sent for this turn, now superseded (set when re-opened). */
  replaces?: string;
}

export interface AssemblerHost {
  /** A new segment began; return the id of the transcript turn showing it. */
  onStart(speaker: Speaker, text: string): number;
  /** The open segment's text grew. */
  onUpdate(seg: Segment): void;
  /** The speaker finished: answer this segment. */
  onFlush(seg: Segment): void;
  /** The speaker carried on after `seg.replaces` was sent: cancel that answer. */
  onReopen(seg: Segment): void;
}

interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface OpenSegment extends Segment {
  lastTextAt: number;
  deadline: number;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export class TurnAssembler {
  private open: OpenSegment | null = null;
  private lastSent: (Segment & { sentAt: number }) | null = null;
  private timer: unknown = null;
  private lastPartial: Partial<Record<Speaker, number>> = {};
  private active: Partial<Record<Speaker, boolean>> = {};
  private activeEnded: Partial<Record<Speaker, number>> = {};
  private forced: { text: string; at: number } | null = null;

  constructor(
    private host: AssemblerHost,
    private pauseMs: () => number,
    private clock: Clock = realClock,
  ) {}

  /** Window after a send in which more speech from the same person re-opens it. */
  private continuationMs() {
    return Math.max(3000, this.pauseMs() * 1.5);
  }

  /** A finalised transcript line. */
  final(speaker: Speaker, rawText: string) {
    const text = rawText.trim();
    if (!text) return;
    const now = this.clock.now();

    // Already sent via "Respond now" from the live partial: don't send it twice.
    if (this.forced) {
      const { text: f, at } = this.forced;
      this.forced = null;
      const a = norm(f), b = norm(text);
      if (now - at < 15_000 && (a.startsWith(b) || b.startsWith(a))) return;
    }

    if (this.open && this.open.speaker !== speaker) this.flush();

    if (this.open) {
      this.open.text = `${this.open.text} ${text}`;
      this.open.lastTextAt = now;
      this.host.onUpdate(this.segment(this.open));
      this.arm();
      return;
    }

    const last = this.lastSent;
    if (last && last.speaker === speaker && now - last.sentAt < this.continuationMs()) {
      // They kept talking after we answered: merge and ask again.
      this.lastSent = null;
      this.open = {
        id: last.id, speaker, text: `${last.text} ${text}`,
        replaces: last.text,
        lastTextAt: now, deadline: 0,
      };
      this.host.onReopen(this.segment(this.open));
      this.arm();
      return;
    }

    const id = this.host.onStart(speaker, text);
    this.open = { id, speaker, text, lastTextAt: now, deadline: 0 };
    this.arm();
  }

  /** An interim (not yet final) transcript: the speaker is mid-sentence. */
  partial(speaker: Speaker, text: string) {
    if (!text.trim()) return;
    this.lastPartial[speaker] = this.clock.now();
    // The other person started talking: the open segment is finished.
    if (this.open && this.open.speaker !== speaker && text.trim().split(/\s+/).length >= 2) this.flush();
  }

  /** Voice activity for a speaker's audio source. */
  activity(speaker: Speaker, isActive: boolean) {
    if (this.active[speaker] && !isActive) this.activeEnded[speaker] = this.clock.now();
    this.active[speaker] = isActive;
  }

  /**
   * Send now (the user pressed Respond). `partial` is live text not yet
   * finalised; it is included, and its final is ignored when it arrives.
   */
  flushNow(partialSpeaker?: Speaker, partialText?: string): boolean {
    const extra = partialText?.trim();
    if (extra && partialSpeaker) {
      this.forced = { text: extra, at: this.clock.now() };
      if (this.open && this.open.speaker !== partialSpeaker) this.flush();
      if (this.open) {
        this.open.text = `${this.open.text} ${extra}`;
        this.host.onUpdate(this.segment(this.open));
      } else {
        const id = this.host.onStart(partialSpeaker, extra);
        this.open = { id, speaker: partialSpeaker, text: extra, lastTextAt: this.clock.now(), deadline: 0 };
      }
    }
    if (!this.open) return false;
    this.flush();
    return true;
  }

  /** Audio stopped: send whatever is still open. */
  stop() {
    if (this.open) this.flush();
    this.lastSent = null;
    this.forced = null;
    this.lastPartial = {};
    this.active = {};
    this.activeEnded = {};
  }

  /** Forget everything without sending (Clear, unmount). */
  reset() {
    this.cancelTimer();
    this.open = null;
    this.lastSent = null;
    this.forced = null;
    this.lastPartial = {};
    this.active = {};
    this.activeEnded = {};
  }

  /** The segment currently being assembled, if any. */
  get current(): Segment | null {
    return this.open ? this.segment(this.open) : null;
  }

  /** When the open segment will be sent if nothing else is said (epoch ms). */
  get deadline(): number | null {
    return this.open?.deadline ?? null;
  }

  private segment(o: OpenSegment): Segment {
    return { id: o.id, speaker: o.speaker, text: o.text, replaces: o.replaces };
  }

  private arm(ms?: number) {
    if (!this.open) return;
    this.cancelTimer();
    const wait = ms ?? waitMsFor(this.open.text, this.pauseMs());
    this.open.deadline = this.clock.now() + wait;
    this.timer = this.clock.setTimeout(() => this.onTimer(), wait);
  }

  private onTimer() {
    this.timer = null;
    const seg = this.open;
    if (!seg) return;
    const now = this.clock.now();
    const sp = seg.speaker;
    // Still making sound: hold, but not forever (a noisy line keeps VAD on).
    if (this.active[sp] && now - seg.lastTextAt < MAX_HOLD_MS) {
      this.arm(HOLD_POLL_MS);
      return;
    }
    // Otherwise wait out the full pause from the last sign of speech.
    const spokeAfterText = (this.activeEnded[sp] ?? 0) > seg.lastTextAt;
    const grace = spokeAfterText && this.lastPartial[sp] == null ? TRANSCRIPTION_GRACE_MS : 0;
    const lastSignal = Math.max(seg.lastTextAt, this.lastPartial[sp] ?? 0, this.activeEnded[sp] ?? 0);
    const remaining = waitMsFor(seg.text, this.pauseMs()) + grace - (now - lastSignal);
    if (remaining > 0 && now - seg.lastTextAt < MAX_HOLD_MS) {
      this.arm(remaining);
      return;
    }
    this.flush();
  }

  private flush() {
    const seg = this.open;
    if (!seg) return;
    this.cancelTimer();
    this.open = null;
    const out = this.segment(seg);
    this.lastSent = { ...out, sentAt: this.clock.now() };
    this.host.onFlush(out);
  }

  private cancelTimer() {
    if (this.timer != null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}


const squash = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * Conversation history without the answer to an earlier part of `question` —
 * used when a speaker carried on and the whole question is asked again. Only
 * the most recent question is considered (nobody else spoke in between), and
 * only if `question` starts with it (speaker tags like "[INTERVIEWER]" are
 * ignored). Mirrors backend sessions.delete_superseded_exchange.
 */
export function dropSuperseded<T extends { role: string; content: string }>(history: T[], question: string): T[] {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue;
    const asked = squash(history[i].content.replace(/^(\[[^\]]*\]\s*)+/, ""));
    if (!asked || !squash(question).startsWith(asked)) return history;
    const n = history[i + 1]?.role === "assistant" ? 2 : 1;
    return [...history.slice(0, i), ...history.slice(i + n)];
  }
  return history;
}
