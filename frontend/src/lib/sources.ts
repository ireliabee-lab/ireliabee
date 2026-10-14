/**
 * Which side the app is listening to.
 *
 * Two sources: your microphone ("mic" — you speaking) and the computer's own
 * output ("system" — the other person's voice coming out of your speakers).
 *
 * You and they are a **choice**, not a pair. Picking one puts the other down,
 * so pressing Y while their audio is on switches to your microphone rather
 * than adding to it. **Auto** is the one control that runs both at once — and
 * pressing the side that is already listening, on its own, stops.
 *
 * Kept here, away from the screen, because the buttons and the keyboard must
 * behave identically: the same rule decides both.
 */

export type Source = "mic" | "system";

/** What is being listened to right now. */
export interface Listening {
  mic: boolean;
  system: boolean;
}

export const nothing: Listening = { mic: false, system: false };

/** Is anything being listened to? */
export const isListening = (now: Listening): boolean => now.mic || now.system;

/** The sources to open, in a stable order — what the socket is told. */
export function openList(next: Listening): Source[] {
  const list: Source[] = [];
  if (next.mic) list.push("mic");
  if (next.system) list.push("system");
  return list;
}

/**
 * Pick one side — the You and the other-person buttons, and their keys.
 *
 * Whatever was on before, this side ends up the only one on. The exception is
 * pressing the side that is already listening by itself, which is that button
 * being a toggle: it stops.
 */
export function pick(now: Listening, source: Source): Listening {
  const other: Source = source === "mic" ? "system" : "mic";
  if (now[source] && !now[other]) return { ...nothing };
  return { mic: source === "mic", system: source === "system" };
}

/**
 * Auto — both sides at once, whoever speaks. Pressing it while both are on
 * stops listening altogether; pressing it in any other state turns both on,
 * including when one side was on alone.
 */
export function both(now: Listening): Listening {
  return now.mic && now.system ? { ...nothing } : { mic: true, system: true };
}
