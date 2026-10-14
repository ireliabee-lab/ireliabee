/**
 * Restart the app: the window and the local backend it starts. The desktop app
 * relaunches itself (Tauri's process plugin, as after an update); in a browser
 * (development) a reload is the nearest thing.
 */
import { isTauri } from "./api";

export const RESTARTING = "ireliabee:restarting";

/** How long anything that saves on its way out gets before the app goes away. */
export const FLUSH_MS = 400;

/**
 * Tell everything that saves on its way out — the notebook editor, the wall —
 * to do it now, and wait a moment for those saves to leave.
 *
 * Used before a restart and before an update installs. On Windows the updater
 * calls `std::process::exit(0)` as soon as it has handed the installer to the
 * shell, so for an update there is no "after" to save in: it has to be first.
 */
export async function flushBeforeExit(): Promise<void> {
  window.dispatchEvent(new CustomEvent(RESTARTING));
  await new Promise(r => setTimeout(r, FLUSH_MS));
}

export async function restartApp(): Promise<void> {
  await flushBeforeExit();
  if (isTauri()) {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
      return;
    } catch { /* fall through: a reload still gets a fresh page */ }
  }
  window.location.reload();
}
