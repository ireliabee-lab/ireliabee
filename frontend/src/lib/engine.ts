/**
 * What is actually doing the work: one model hears, another answers.
 *
 * The name this computer picks is a *request*. For an ordinary account both
 * jobs run on iReliabee's service, which chooses on the server — so the model
 * that answers can differ from the one in Settings, and until now nothing said
 * so. Both now report themselves: the coach's reply carries the model that
 * wrote it, and the transcriber names itself in its own frames.
 *
 * This is the naming and the wording for showing that in the space of a few
 * words; everything here is pure so the shortening can be tested against the
 * real model names.
 */

export interface Engine {
  /** What answered, or heard. */
  model: string;
  provider?: string;
  /** Whether that came back from the work itself, or is only what was asked for. */
  confirmed?: boolean;
  /** What this computer asked for, when it differs from what ran. */
  asked?: string;
}

/** Vendor prefixes and dating that say nothing to a person mid-call. */
const NOISE = [
  /^(?:models\/|openai\/|anthropic\/|google\/|meta-llama\/|deepseek-ai\/)/i,
  /-\d{8}$/,          // claude-3-5-sonnet-20241022
  /^general-/i,       // general-nova-3 → nova-3
  /-latest$/i,
];

/** Names people actually use, where stripping is not enough. */
const KNOWN: Record<string, string> = {
  "claude-haiku-4-5": "haiku 4.5",
  "claude-sonnet-4-5": "sonnet 4.5",
  "claude-opus-4-5": "opus 4.5",
  "whisper-large-v3-turbo": "whisper v3 turbo",
  "whisper-large-v3": "whisper v3",
  "gpt-4o-mini-transcribe": "gpt-4o mini",
  "gpt-oss-120b": "gpt-oss 120b",
};

/**
 * A model name short enough to sit in a header: "claude-haiku-4-5" → "haiku
 * 4.5", "general-nova-3" → "nova-3". Never invents a name it was not given.
 */
export function shortModel(name: string): string {
  let out = (name || "").trim();
  if (!out) return "";
  for (const noise of NOISE) out = out.replace(noise, "");
  if (KNOWN[out]) return KNOWN[out];
  // claude-haiku-4-5-20251001 → haiku 4.5
  const claude = /^claude-(haiku|sonnet|opus)-(\d+)-(\d+)/i.exec(out);
  if (claude) return `${claude[1].toLowerCase()} ${claude[2]}.${claude[3]}`;
  return out;
}

/** Whether what ran is not what this computer asked for. */
export function swapped(engine: Engine): boolean {
  if (!engine.asked || !engine.model) return false;
  return shortModel(engine.asked) !== shortModel(engine.model);
}

/**
 * The sentence behind the mark. Says what ran, whether that is known or only
 * assumed, and — the point of the whole thing — when the service chose
 * something other than what this computer asked for.
 */
export function engineTip(hearing: Engine | null, answering: Engine | null,
                          listening = false): string {
  const lines: string[] = [];
  if (!hearing?.model) {
    // Nothing has listened yet. Say why this half is empty, rather than
    // leaving a gap for the reader to interpret.
    lines.push("Hearing: nothing yet — the transcriber names itself once you start listening");
  } else if (!listening) {
    // It ran, and has stopped. Past tense: naming a transcriber that is not
    // running as though it were would be the same lie the header used to tell
    // about the model in Settings.
    lines.push(`Heard by: ${shortModel(hearing.model)} (not listening now)`);
  } else {
    lines.push(`Hearing: ${shortModel(hearing.model)}${hearing.confirmed ? "" : " (assumed — it has not said yet)"}`);
  }
  if (answering?.model) {
    lines.push(`Answering: ${shortModel(answering.model)}${answering.confirmed ? "" : " (assumed — no answer yet)"}`);
    if (swapped(answering)) {
      // Only what is known: a name was asked for, a different one answered.
      // Which of the two places chose — the per-turn routing here, or the
      // service on the server — is not visible from the answer itself, so it
      // is not claimed.
      lines.push(`You asked for ${shortModel(answering.asked!)}; ${shortModel(answering.model)} answered.`);
    }
  }
  if (!answering?.model) {
    lines.push("Answering: nothing yet — the answer names the model that wrote it");
  }
  return lines.join("\n");
}
