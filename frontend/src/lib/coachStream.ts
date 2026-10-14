import { fetchApi } from "./api";
import { AppError, errorFromResponse } from "./errors";

/**
 * How long an answer may go completely quiet before the app gives up on it.
 *
 * The engine itself gives up on the user's own assistant after 60 seconds for a
 * live answer (backend/core/providers.py RELAY_TIMEOUTS) and says so with a
 * relay_timeout event, so this only fires when that never arrives: the request
 * is stuck behind others in the webview, the engine hung, or the connection
 * died without closing. Counted from the request, and again from every chunk
 * that arrives, so a slow answer that is still writing is never cut off.
 */
export const ANSWER_STALL_MS = 90_000;

/** The error a stalled answer ends with: shown on its card, with Try again. */
export function stalledAnswer(): AppError {
  return new AppError({
    code: "answer_stalled",
    title: "No answer came back",
    message: "Nothing arrived for a while, so it was stopped. Try again.",
  });
}

/** The error for a stream that closed before its last event. */
export function brokenAnswer(): AppError {
  return new AppError({
    code: "answer_cut_off",
    title: "The answer stopped part-way",
    message: "The connection closed before it finished. Try again.",
  });
}

export interface StallWatchdog {
  /** Something arrived: start counting again. */
  kick(): void;
  stop(): void;
  /** Whether it gave up (and called onStall). */
  readonly fired: boolean;
}

/** Calls `onStall` once if `kick` is not called for `ms`. Starts counting at once. */
export function stallWatchdog(onStall: () => void, ms: number): StallWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  let stopped = false;
  const w: StallWatchdog = {
    kick() {
      if (stopped || fired) return;
      clearTimeout(timer);
      timer = setTimeout(() => { fired = true; onStall(); }, ms);
    },
    stop() { stopped = true; clearTimeout(timer); },
    get fired() { return fired; },
  };
  w.kick();
  return w;
}

export interface CoachStreamHandlers {
  onToken: (fullText: string) => void;
  onMeta?: (meta: { turn_type?: string; response_tone?: string }) => void;
  onDone?: (event: { history: { role: string; content: string }[] }) => void;
}

// Streams a /coach/turn reply (server-sent events) and reports progress.
export async function streamCoachTurn(body: Record<string, unknown>, handlers: CoachStreamHandlers): Promise<string> {
  const ctrl = new AbortController();
  const watchdog = stallWatchdog(() => ctrl.abort(), ANSWER_STALL_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const res = await fetchApi("/coach/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    watchdog.kick();
    if (!res.ok) throw await errorFromResponse(res);
    if (!res.body) throw new Error("No response stream");

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      watchdog.kick();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let event: any;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }
        if (event.type === "token") { text += event.text; handlers.onToken(text); }
        else if (event.type === "meta") handlers.onMeta?.(event);
        else if (event.type === "done") handlers.onDone?.(event);
        else if (event.type === "error") throw new AppError(event);
      }
    }
    return text;
  } catch (err) {
    if (watchdog.fired) throw stalledAnswer();
    throw err;
  } finally {
    watchdog.stop();
    // Let go of the connection whatever happened: the webview has only a few
    // for the engine, and one left open blocks the next answer.
    reader?.cancel().catch(() => {});
  }
}
