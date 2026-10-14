/**
 * A system notification (the corner of the screen, with a sound), for meeting
 * reminders. In the app it goes through Tauri's notification plugin; in a
 * browser (development) through the web Notification API. Never throws: a
 * reminder that cannot be shown still appears inside the app.
 */
import { isTauri } from "./api";

export async function notify(title: string, body: string): Promise<boolean> {
  try {
    if (isTauri()) {
      const n = await import("@tauri-apps/plugin-notification");
      let granted = await n.isPermissionGranted();
      if (!granted) granted = (await n.requestPermission()) === "granted";
      if (!granted) return false;
      n.sendNotification({ title, body });
      return true;
    }
    if (typeof Notification === "undefined") return false;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return false;
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}

/** Whether closing the window keeps iReliabee in the tray (so reminders still come). On unless turned off. */
const TRAY_KEY = "ireliabee.keepInTray";
export function keepInTray(): boolean {
  try { return localStorage.getItem(TRAY_KEY) !== "0"; } catch { return true; }
}
/** Remember the choice and tell the app's window (it decides what closing does). */
export async function setKeepInTray(on: boolean): Promise<void> {
  try { localStorage.setItem(TRAY_KEY, on ? "1" : "0"); } catch { /* the default applies next time */ }
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_keep_in_tray", { on });
  } catch { /* an older shell without the tray: closing quits, as before */ }
}

/** Whether iReliabee starts (hidden, in the tray) when you sign in to the computer. Off unless turned on. */
export async function startsAtLogin(): Promise<boolean> {
  if (!isTauri()) return false;
  try { return await (await import("@tauri-apps/plugin-autostart")).isEnabled(); } catch { return false; }
}
/** Turn starting at login on or off; says whether it worked. */
export async function setStartsAtLogin(on: boolean): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const a = await import("@tauri-apps/plugin-autostart");
    await (on ? a.enable() : a.disable());
    return (await a.isEnabled()) === on;
  } catch { return false; }
}
