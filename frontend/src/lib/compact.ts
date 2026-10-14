// Compact overlay: shrink the window into a small always-on-top strip and back.
//
// Two shapes:
// - "overlay": a small panel you place anywhere;
// - "camera":  a wide, short strip docked at the top-centre of the screen, right
//   under the webcam, so reading it looks close to looking at the other person.

export type CompactKind = "overlay" | "camera";

/** The view after this one, for O: full, then the overlay, then the strip under the camera, then full again. */
export function nextCompact(now: CompactKind | null): CompactKind | null {
  return now === null ? "overlay" : now === "overlay" ? "camera" : null;
}

const COMPACT_SIZE = { width: 520, height: 300 };
/** Narrow enough that reading a line barely moves the eyes sideways. */
// Wide and short: an answer read in a few long lines under the webcam, not a
// tall column. Narrower on a small screen (see cameraPosition's caller).
export const CAMERA_SIZE = { width: 900, height: 150 };
const NORMAL_MIN = { width: 900, height: 600 };

let saved: { width: number; height: number; x: number; y: number } | null = null;
/** The shape on screen now, so its size and place can be kept when it is left. */
let current: CompactKind | null = null;

/** A window's size and place, in logical pixels. */
export interface Bounds { x: number; y: number; width: number; height: number }
const BOUNDS_KEY = (kind: CompactKind) => `compactBounds.${kind}`;

/**
 * Whether saved bounds can be used again: a sensible size, and enough of the
 * window on a screen that is still connected to grab it. A teleprompter saved
 * on a monitor that has since been unplugged must not open where no one can
 * see it; it falls back to where it starts by default.
 */
export function fitsOnScreen(b: Bounds | null, screens: Bounds[]): boolean {
  if (!b || !(b.width >= 200 && b.height >= 80)) return false;
  return screens.some(m => {
    const w = Math.min(b.x + b.width, m.x + m.width) - Math.max(b.x, m.x);
    const h = Math.min(b.y + b.height, m.y + m.height) - Math.max(b.y, m.y);
    return w >= 120 && h >= 40;
  });
}

export function readBounds(kind: CompactKind): Bounds | null {
  try {
    const b = JSON.parse(localStorage.getItem(BOUNDS_KEY(kind)) || "null");
    return b && [b.x, b.y, b.width, b.height].every(Number.isFinite) ? b : null;
  } catch { return null; }
}

/**
 * Keep the size and place the person gave this shape, so switching to the
 * full view and back does not undo it.
 */
async function rememberBounds(win: any, scale: number) {
  if (!current) return;
  try {
    const [size, pos] = await Promise.all([win.innerSize(), win.outerPosition()]);
    const b: Bounds = { x: pos.x / scale, y: pos.y / scale, width: size.width / scale, height: size.height / scale };
    localStorage.setItem(BOUNDS_KEY(current), JSON.stringify(b));
  } catch { /* a per-device nicety */ }
}

async function screensNow(): Promise<Bounds[]> {
  try {
    const { availableMonitors } = await import("@tauri-apps/api/window");
    return (await availableMonitors()).map(m => ({
      x: m.position.x / m.scaleFactor, y: m.position.y / m.scaleFactor,
      width: m.size.width / m.scaleFactor, height: m.size.height / m.scaleFactor,
    }));
  } catch { return []; }
}

const isTauri = () => Boolean((window as any).__TAURI_INTERNALS__);

/** Where the camera strip goes: centred under the top edge of the screen the app is on. */
export function cameraPosition(monitor: { x: number; y: number; width: number }, width = CAMERA_SIZE.width) {
  return { x: Math.round(monitor.x + (monitor.width - width) / 2), y: Math.round(monitor.y) };
}

export async function enterCompactWindow(kind: CompactKind = "overlay") {
  window.dispatchEvent(new CustomEvent("compact-mode", { detail: true }));
  if (!isTauri()) return;
  try {
    const { getCurrentWindow, currentMonitor, LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const scale = await win.scaleFactor();
    // Switching between the two shapes keeps the size the full window had.
    if (!saved) {
      const [size, pos] = await Promise.all([win.innerSize(), win.outerPosition()]);
      saved = { width: size.width / scale, height: size.height / scale, x: pos.x / scale, y: pos.y / scale };
    }
    // Leaving one shape for the other keeps the one being left as it was.
    if (current && current !== kind) await rememberBounds(win, scale);
    current = kind;
    await win.setMinSize(new LogicalSize(360, kind === "camera" ? 90 : 180));
    const kept = readBounds(kind);
    if (kept && fitsOnScreen(kept, await screensNow())) {
      await win.setSize(new LogicalSize(kept.width, kept.height));
      await win.setPosition(new LogicalPosition(kept.x, kept.y));
    } else if (kind === "camera") {
      const m = await currentMonitor();
      const mon = m
        ? { x: m.position.x / m.scaleFactor, y: m.position.y / m.scaleFactor, width: m.size.width / m.scaleFactor }
        : { x: 0, y: 0, width: window.screen.width };
      const width = Math.min(CAMERA_SIZE.width, Math.round(mon.width - 40));
      await win.setSize(new LogicalSize(width, CAMERA_SIZE.height));
      const { x, y } = cameraPosition(mon, width);
      await win.setPosition(new LogicalPosition(x, y));
    } else {
      await win.setSize(new LogicalSize(COMPACT_SIZE.width, COMPACT_SIZE.height));
    }
    await win.setAlwaysOnTop(true);
  } catch { /* the layout still switches even if the window can't */ }
}

export async function exitCompactWindow() {
  if (isTauri()) {
    try {
      const { getCurrentWindow, LogicalSize, LogicalPosition } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await rememberBounds(win, await win.scaleFactor());
      await win.setAlwaysOnTop(false);
      await win.setMinSize(new LogicalSize(NORMAL_MIN.width, NORMAL_MIN.height));
      if (saved) {
        await win.setSize(new LogicalSize(saved.width, saved.height));
        await win.setPosition(new LogicalPosition(saved.x, saved.y));
      }
    } catch { /* ignore */ }
  }
  saved = null;
  current = null;
  // Titlebar re-applies the user's own pin choice when this fires.
  window.dispatchEvent(new CustomEvent("compact-mode", { detail: false }));
}
