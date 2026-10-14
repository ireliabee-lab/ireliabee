/**
 * App-wide page width. Every screen built on <Page> lays its content out in
 * the same column, capped at --page-max and centred, so switching screens
 * never makes the content jump or shrink. The live session keeps the whole
 * window — it is a workspace, not a page.
 */

export const PAGE_WIDTHS = [
  { id: "standard", label: "Standard",   hint: "1120px — easy to scan", max: 1120 },
  { id: "wide",     label: "Wide",       hint: "1360px — recommended",  max: 1360 },
  { id: "xwide",    label: "Extra wide", hint: "1640px — big monitors", max: 1640 },
  { id: "full",     label: "Full width", hint: "Edge to edge",          max: null },
] as const;

export type PageWidthId = (typeof PAGE_WIDTHS)[number]["id"];

const KEY = "pageWidth";
const DEFAULT: PageWidthId = "wide";

export function getPageWidth(): PageWidthId {
  try {
    const v = localStorage.getItem(KEY);
    return PAGE_WIDTHS.some(w => w.id === v) ? (v as PageWidthId) : DEFAULT;
  } catch { return DEFAULT; }
}

export function applyPageWidth(id: PageWidthId = getPageWidth()) {
  const max = PAGE_WIDTHS.find(w => w.id === id)?.max ?? null;
  // "Full" is a very large cap rather than `none` so the gutter maths in
  // index.css (which subtracts --page-max from 100%) stays valid.
  document.documentElement.style.setProperty("--page-max", max ? `${max}px` : "100000px");
  document.documentElement.dataset.pageWidth = id;
}

export function setPageWidth(id: PageWidthId) {
  try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
  applyPageWidth(id);
  window.dispatchEvent(new CustomEvent("page-width", { detail: id }));
}

/** Window size presets for the desktop app (logical pixels, before text zoom). */
export const WINDOW_SIZES = [
  { id: "1280x800",  label: "1280 × 800",  w: 1280, h: 800 },
  { id: "1440x900",  label: "1440 × 900",  w: 1440, h: 900 },
  { id: "1680x1050", label: "1680 × 1050", w: 1680, h: 1050 },
  { id: "1920x1080", label: "1920 × 1080", w: 1920, h: 1080 },
] as const;

const isTauri = () => Boolean((window as any).__TAURI_INTERNALS__);
export const canResizeWindow = isTauri;

/** Largest window the current monitor fits, in logical pixels (null outside the desktop app). */
export async function monitorLimit(): Promise<{ w: number; h: number } | null> {
  if (!isTauri()) return null;
  try {
    const { currentMonitor } = await import("@tauri-apps/api/window");
    const m = await currentMonitor();
    if (!m) return null;
    const area = (m as any).workArea?.size ?? m.size;
    return { w: Math.floor(area.width / m.scaleFactor), h: Math.floor(area.height / m.scaleFactor) };
  } catch { return null; }
}

/** Resize the app window to a preset (or maximise it) and centre it on its monitor. */
export async function resizeWindow(size: { w: number; h: number } | "maximize") {
  if (!isTauri()) return;
  const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  if (size === "maximize") { await win.maximize(); return; }
  if (await win.isMaximized()) await win.unmaximize();
  const limit = await monitorLimit();
  const w = limit ? Math.min(size.w, limit.w) : size.w;
  const h = limit ? Math.min(size.h, limit.h) : size.h;
  await win.setSize(new LogicalSize(w, h));
  await win.center().catch(() => { /* older capability files: size still applies */ });
}
