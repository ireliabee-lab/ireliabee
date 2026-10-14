/**
 * App-wide text size. Scales the whole UI with CSS `zoom` on <html> so text,
 * icons and spacing grow together and nothing overlaps.
 *
 * Viewport units don't shrink under zoom, so full-window sizes in CSS use
 * --vh / --vw (defined in index.css as 1vh / 1vw divided by --ui-zoom).
 */

export const TEXT_SIZES = [
  { id: "xs", label: "Extra small", scale: 0.85 },
  { id: "s",  label: "Small",       scale: 0.92 },
  { id: "m",  label: "Default",     scale: 1 },
  { id: "l",  label: "Large",       scale: 1.12 },
  { id: "xl", label: "Extra large", scale: 1.25 },
  { id: "xxl", label: "Huge",       scale: 1.4 },
] as const;

export type TextSizeId = (typeof TEXT_SIZES)[number]["id"];

const KEY = "textSize";
const DEFAULT: TextSizeId = "m";

export function getTextSize(): TextSizeId {
  try {
    const v = localStorage.getItem(KEY);
    return TEXT_SIZES.some(s => s.id === v) ? (v as TextSizeId) : DEFAULT;
  } catch { return DEFAULT; }
}

export function applyTextSize(id: TextSizeId = getTextSize()) {
  const scale = TEXT_SIZES.find(s => s.id === id)?.scale ?? 1;
  const root = document.documentElement;
  root.style.setProperty("--ui-zoom", String(scale));
  root.style.zoom = scale === 1 ? "" : String(scale);
}

export function setTextSize(id: TextSizeId) {
  try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
  applyTextSize(id);
  window.dispatchEvent(new CustomEvent("text-size", { detail: id }));
}

/** Ctrl/Cmd + "=" / "-" / "0": one size up, one size down, back to default. */
export function installTextSizeShortcuts() {
  window.addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const i = TEXT_SIZES.findIndex(s => s.id === getTextSize());
    let next: number | null = null;
    // Match the character and the physical key, so other layouts and the numpad work too.
    const up = e.key === "=" || e.key === "+" || e.code === "Equal" || e.code === "NumpadAdd";
    const down = e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract";
    const reset = e.key === "0" || e.code === "Digit0" || e.code === "Numpad0";
    if (up) next = Math.min(TEXT_SIZES.length - 1, i + 1);
    else if (down) next = Math.max(0, i - 1);
    else if (reset) next = TEXT_SIZES.findIndex(s => s.id === DEFAULT);
    if (next === null) return;
    e.preventDefault();
    if (next !== i) setTextSize(TEXT_SIZES[next].id);
  });
}
