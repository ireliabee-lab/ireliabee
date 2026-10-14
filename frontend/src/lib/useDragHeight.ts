import { useCallback, useRef, useState } from "react";

/** Keep a height within bounds; `max` may be smaller than `min` on a tiny window — then min wins. */
export function clampHeight(h: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(Math.max(min, max), h)));
}

function read(key: string): number | null {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

function write(key: string, v: number | null) {
  try {
    if (v == null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(Math.round(v)));
  } catch { /* private mode: the height just isn't remembered */ }
}

/**
 * A height the user can drag, remembered on this device (per `key`).
 * `null` means "the default size" (CSS decides). `factor` is 2 for a box centred
 * on screen, whose bottom edge moves half as far as its height grows.
 */
export function useDragHeight(key: string, opts: { min: number; max: () => number; factor?: number; start: () => number }) {
  const [height, setHeightState] = useState<number | null>(() => read(key));
  const drag = useRef<{ y: number; h: number } | null>(null);
  const factor = opts.factor ?? 1;

  const setHeight = useCallback((v: number | null) => {
    const next = v == null ? null : clampHeight(v, opts.min, opts.max());
    setHeightState(next);
    write(key, next);
  }, [key, opts]);

  function end() {
    if (!drag.current) return;
    drag.current = null;
    setHeightState(h => { write(key, h); return h; });
  }

  const gripProps = {
    role: "separator" as const,
    "aria-orientation": "horizontal" as const,
    tabIndex: 0,
    "aria-valuemin": opts.min,
    "aria-valuenow": Math.round(height ?? opts.start()),
    title: "Drag to resize · double-click to reset",
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { y: e.clientY, h: height ?? opts.start() };
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      // The release was lost (focus moved away mid-drag): stop, never resize on a hover.
      if (e.pointerType === "mouse" && (e.buttons & 1) === 0) { end(); return; }
      const next = clampHeight(drag.current.h + (e.clientY - drag.current.y) * factor, opts.min, opts.max());
      setHeightState(next);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      end();
    },
    onPointerCancel: () => end(),
    onLostPointerCapture: () => end(),
    onDoubleClick: () => setHeight(null),
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      const step = e.shiftKey ? 80 : 24;
      if (e.key === "ArrowDown") { e.preventDefault(); setHeight((height ?? opts.start()) + step); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setHeight((height ?? opts.start()) - step); }
      else if (e.key === "Home" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setHeight(null); }
    },
  };

  return { height, setHeight, gripProps };
}
