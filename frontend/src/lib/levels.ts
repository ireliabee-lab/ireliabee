/**
 * How loud each side is, for the meter beside the listening controls.
 *
 * The question a meter has to answer is "is it hearing me at all?", and the
 * honest answer is a picture of the level, not a dot that lights up once
 * something crosses a threshold. The app used to have only the dot, so a
 * microphone that was working badly and a microphone that was not working
 * looked exactly the same.
 *
 * Levels arrive from the backend as rms after its own level stage
 * (backend/core/gain.py), so what is drawn is what the transcriber hears.
 */

export type Source = "mic" | "system";

export interface Level {
  /** rms, 0–1, as the transcriber receives it. */
  level: number;
  /** Whether the backend counts this as someone speaking. */
  speaking: boolean;
  /** What the level stage is multiplying this source by. */
  gain: number;
}

export const quiet: Level = { level: 0, speaking: false, gain: 1 };

/** Segments in a full meter. */
export const BARS = 12;

/** The quietest level the meter shows at all — below this a room is empty. */
export const FLOOR_DB = -60;
/** Where the meter is full. Short of 0 dBFS, since speech should never get there. */
export const CEILING_DB = -6;

/** An rms level as decibels below full scale. Silence is far below the floor. */
export function dbfs(level: number): number {
  return level > 0 ? 20 * Math.log10(level) : -Infinity;
}

/**
 * How many segments to light for a level.
 *
 * On a decibel scale, because a linear one spends most of its length on sounds
 * nobody can hear and squeezes the whole of speech into the last few pixels.
 */
export function bars(level: number, count = BARS): number {
  const db = dbfs(level);
  if (!Number.isFinite(db) || db <= FLOOR_DB) return 0;
  const share = (db - FLOOR_DB) / (CEILING_DB - FLOOR_DB);
  return Math.max(1, Math.min(count, Math.round(share * count)));
}

/**
 * What to say about a source in one line: the meter is a picture, this is the
 * sentence underneath it.
 */
export function hearing(on: boolean, level: Level): string {
  if (!on) return "Not listening";
  if (level.speaking) return "Hearing you";
  return bars(level.level) > 0 ? "Listening — quiet" : "Listening — silent";
}

/**
 * The boost being applied, when it is worth saying. Under twice, the level
 * stage is barely doing anything and the number is only clutter.
 */
export function boostLabel(gain: number): string {
  return gain >= 2 ? `×${gain >= 10 ? Math.round(gain) : gain.toFixed(1).replace(/\.0$/, "")}` : "";
}

/**
 * Nothing at all is arriving — digital silence, not merely a quiet room.
 *
 * Only ever said of a microphone. A real one always picks up *something*, so
 * exact zeros mean it is muted or is not the device being spoken into; -90
 * dBFS, on the other hand, is a quiet room and a voice that needs a better
 * level, not an alarm.
 *
 * Never said of the call: a loopback of an output nobody is playing through is
 * exactly zero, so "nothing is arriving" would be on screen through every
 * pause in the conversation — which is most of a conversation.
 */
export function isDead(on: boolean, level: Level, which: Source): boolean {
  return on && which === "mic" && level.level === 0;
}
