/**
 * The meeting reminder's chime: two soft, low notes when the reminder appears,
 * once more two minutes later if it is still unanswered, then quiet.
 *
 * Never while the coach is listening or a voice practice call is on: the
 * other side of a call could hear it, and the coach would transcribe it.
 */

/** Whether reminders make a sound. On unless turned off (Settings → Notifications). */
const SOUND_KEY = "ireliabee.reminderSound";
export function reminderSound(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== "0"; } catch { return true; }
}
export function setReminderSound(on: boolean) {
  try { localStorage.setItem(SOUND_KEY, on ? "1" : "0"); } catch { /* the default applies next time */ }
}

/** Audio sockets open in this window: live listening and voice practice calls. */
let openAudio = 0;
export function countWhileOpen(ws: WebSocket) {
  openAudio++;
  ws.addEventListener("close", () => { openAudio--; }, { once: true });
}
export function listeningNow(): boolean {
  return openAudio > 0;
}

/** When the chime plays again if nobody answers: once. */
export const CHIME_AGAIN_MS = 2 * 60_000;

/** Two low notes, falling: G4 then D4, quiet and short. */
export function playChime(): void {
  try {
    const ctx = new AudioContext();
    const note = (freq: number, at: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + at;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.09, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.95);
    };
    note(392, 0);
    note(293.66, 0.24);
    window.setTimeout(() => void ctx.close().catch(() => {}), 1500);
  } catch { /* no audio output: the window still shows */ }
}
