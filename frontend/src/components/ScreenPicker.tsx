import { useEffect, useRef, useState } from "react";
import { X, RefreshCw, Monitor, Globe, AppWindow, ChevronDown, ChevronRight, Crop, RotateCcw } from "lucide-react";
import { fetchApi } from "../lib/api";

/** What the user chose to capture. `target` is "screen:<n>" or "window:<hwnd>". */
export interface ScreenPick {
  target: string;
  label: string;
  tabIndex?: number;
  tabTitle?: string;
  region?: boolean;   // drag-select an area after capturing
}

interface ScreenTarget {
  id: string;
  kind: "screen";
  label: string;
  width: number;
  height: number;
  primary: boolean;
  thumb?: string;
}

interface WindowTarget {
  id: string;
  kind: "window";
  title: string;
  app: string;
  browser: string | null;
  minimized: boolean;
  thumb?: string;
}

interface BrowserTab {
  index: number;
  title: string;
  label: string;
  selected: boolean;
}

const REGION_KEY = "screenPickRegion";

function readRegionPref(): boolean {
  try { return localStorage.getItem(REGION_KEY) === "1"; } catch { return false; }
}

export function windowLabel(w: { app: string; title: string; browser: string | null }): string {
  // "Page and 2 more pages - Profile - Microsoft Edge" → "Page"
  const title = w.browser
    ? w.title.replace(/\s+(and \d+ more pages?\s+)?-\s+([^-]+-\s+)?Microsoft.?\s?Edge$|\s+-\s+(Google Chrome|Mozilla Firefox|Brave|Opera|Vivaldi)$/i, "")
    : w.title;
  return w.app && !title.toLowerCase().includes(w.app.toLowerCase()) ? `${w.app} — ${title}` : title;
}

interface ScreenPickerProps {
  lastPick: ScreenPick | null;
  onPick: (pick: ScreenPick) => void;
  onClose: () => void;
  /** Old mode-based capture, used when screens can't be listed (e.g. Linux Wayland). */
  onLegacy: (mode: "region" | "full" | "window") => void;
}

export default function ScreenPicker({ lastPick, onPick, onClose, onLegacy }: ScreenPickerProps) {
  const [screens, setScreens] = useState<ScreenTarget[] | null>(null);
  const [windows, setWindows] = useState<WindowTarget[]>([]);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [region, setRegion] = useState(readRegionPref);
  const [openTabs, setOpenTabs] = useState<Record<string, BrowserTab[] | "loading" | { error: string }>>({});

  async function load() {
    setLoading(true);
    try {
      const res = await fetchApi("/coach/screen/targets");
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setScreens(data.screens ?? []);
      setWindows(data.windows ?? []);
      setFailed(!(data.screens ?? []).length);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function setRegionPref(v: boolean) {
    setRegion(v);
    try { localStorage.setItem(REGION_KEY, v ? "1" : "0"); } catch { /* ignore */ }
  }

  function pick(p: Omit<ScreenPick, "region">) {
    onPick({ ...p, region });
  }

  async function toggleTabs(w: WindowTarget) {
    if (Array.isArray(openTabs[w.id])) {
      setOpenTabs(prev => { const next = { ...prev }; delete next[w.id]; return next; });
      return;
    }
    setOpenTabs(prev => ({ ...prev, [w.id]: "loading" }));
    try {
      const res = await fetchApi(`/coach/screen/tabs?window=${encodeURIComponent(w.id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Couldn't read this browser's tabs.");
      setOpenTabs(prev => ({ ...prev, [w.id]: data.tabs ?? [] }));
    } catch (e) {
      setOpenTabs(prev => ({ ...prev, [w.id]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  }

  // Esc closes; 1-9 picks that screen.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      const n = Number(e.key);
      if (screens && n >= 1 && n <= screens.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); e.stopPropagation();
        const s = screens[n - 1];
        pick({ target: s.id, label: s.label });
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });

  const browsers = windows.filter(w => w.browser);
  const others = windows.filter(w => !w.browser);

  return (
    <div className="screen-picker-backdrop" onClick={onClose}>
      <div className="screen-picker" onClick={e => e.stopPropagation()}>
        <div className="screen-picker-head">
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>What should the coach look at?</div>
          <button className="screen-picker-icon" onClick={load} title="Refresh" disabled={loading}>
            <RefreshCw size={14} className={loading ? "spin" : ""} />
          </button>
          <button className="screen-picker-icon" onClick={onClose} title="Close (Esc)"><X size={15} /></button>
        </div>

        <div className="screen-picker-bar">
          <label className="screen-picker-toggle" title="After capturing, drag to select just the part you want">
            <input type="checkbox" checked={region} onChange={e => setRegionPref(e.target.checked)} />
            <Crop size={13} /> Select a region after capture
          </label>
          {lastPick && (
            <button className="btn-ghost screen-picker-again" onClick={() => onPick({ ...lastPick, region })}
              title="Capture the same thing again (C)">
              <RotateCcw size={12} /> Again: {lastPick.label}
              <span className="kbd">C</span>
            </button>
          )}
        </div>

        <div className="screen-picker-body">
          {loading && !screens && <div className="muted screen-picker-empty">Looking for screens and windows…</div>}

          {failed && !loading && (
            <div className="screen-picker-legacy">
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                Couldn't list your screens here. Use your system's capture tool instead:
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn-neutral" onClick={() => onLegacy("region")}>Region — drag-select</button>
                <button className="btn-neutral" onClick={() => onLegacy("full")}>Full screen</button>
                <button className="btn-neutral" onClick={() => onLegacy("window")}>Click a window</button>
              </div>
            </div>
          )}

          {!!screens?.length && (
            <section>
              <h4><Monitor size={12} /> Screens</h4>
              <div className="screen-picker-grid">
                {screens.map((s, i) => (
                  <button key={s.id} className={`screen-pick-card ${lastPick?.target === s.id ? "last" : ""}`}
                    onClick={() => pick({ target: s.id, label: s.label })}>
                    <div className="screen-pick-thumb">{s.thumb ? <img src={s.thumb} alt="" /> : <Monitor size={22} />}</div>
                    <div className="screen-pick-name">
                      <span className="kbd">{i + 1}</span> {s.label}
                      <span className="muted"> · {s.width}×{s.height}</span>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}

          {browsers.length > 0 && (
            <section>
              <h4><Globe size={12} /> Browsers</h4>
              <div className="screen-picker-list">
                {browsers.map(w => {
                  const tabs = openTabs[w.id];
                  const label = windowLabel(w);
                  return (
                    <div key={w.id} className={`screen-pick-row ${lastPick?.target === w.id ? "last" : ""}`}>
                      <div className="screen-pick-row-main">
                        <button className="screen-pick-row-btn" disabled={w.minimized}
                          onClick={() => pick({ target: w.id, label })}
                          title={w.minimized ? "Minimized — restore the window to capture it" : "Capture the tab this window is showing"}>
                          <div className="screen-pick-thumb small">{w.thumb ? <img src={w.thumb} alt="" /> : <Globe size={16} />}</div>
                          <div style={{ minWidth: 0 }}>
                            <div className="screen-pick-app">{w.browser}{w.minimized && <span className="muted"> · minimized</span>}</div>
                            <div className="screen-pick-title">{label.replace(`${w.app} — `, "")}</div>
                          </div>
                        </button>
                        <button className="btn-neutral screen-pick-tabs-btn" disabled={w.minimized} onClick={() => toggleTabs(w)}>
                          {Array.isArray(tabs) ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Tabs
                        </button>
                      </div>
                      {tabs === "loading" && <div className="muted screen-pick-tabs">Reading tabs…</div>}
                      {tabs && typeof tabs === "object" && !Array.isArray(tabs) && <div className="muted screen-pick-tabs">{tabs.error}</div>}
                      {Array.isArray(tabs) && (
                        <div className="screen-pick-tabs">
                          {tabs.length === 0 && <div className="muted">No tabs found.</div>}
                          {tabs.map(t => (
                            <button key={`${t.index}-${t.title}`} className={`screen-pick-tab ${t.selected ? "current" : ""}`}
                              onClick={() => pick({
                                target: w.id, label: `${w.browser} — ${t.label}`,
                                tabIndex: t.index, tabTitle: t.title,
                              })}>
                              <span className="screen-pick-tab-title">{t.label}</span>
                              {t.selected && <span className="muted">showing</span>}
                            </button>
                          ))}
                          {tabs.length > 1 && (
                            <div className="muted screen-pick-note">
                              Picking another tab switches the browser to it — anyone watching your screen share will see it change.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {others.length > 0 && (
            <section>
              <h4><AppWindow size={12} /> Windows</h4>
              <div className="screen-picker-grid windows">
                {others.map(w => (
                  <button key={w.id} className={`screen-pick-card ${lastPick?.target === w.id ? "last" : ""}`}
                    disabled={w.minimized}
                    title={w.minimized ? "Minimized — restore the window to capture it" : w.title}
                    onClick={() => pick({ target: w.id, label: windowLabel(w) })}>
                    <div className="screen-pick-thumb">{w.thumb ? <img src={w.thumb} alt="" /> : <AppWindow size={20} />}</div>
                    <div className="screen-pick-name">
                      <div className="screen-pick-app">{w.app}{w.minimized && <span className="muted"> · minimized</span>}</div>
                      <div className="screen-pick-title">{w.title}</div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** Region in capture pixels. */
export interface Region { x: number; y: number; w: number; h: number }

interface RegionSelectorProps {
  preview: string;          // data URL (may be downscaled)
  width: number;            // full capture size in pixels
  height: number;
  label: string;
  onDone: (region: Region | null, croppedPreview: string) => void;
  onCancel: () => void;
}

/** Drag a rectangle over a captured screenshot. Enter/"Whole image" skips cropping. */
export function RegionSelector({ preview, width, height, label, onDone, onCancel }: RegionSelectorProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragging = useRef(false);

  function toLocal(e: React.PointerEvent) {
    const box = imgRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(e.clientX - box.left, 0), box.width),
      y: Math.min(Math.max(e.clientY - box.top, 0), box.height),
    };
  }

  function confirm() {
    const img = imgRef.current;
    if (!img) return;
    if (!rect || rect.w < 6 || rect.h < 6) { onDone(null, preview); return; }
    const box = img.getBoundingClientRect();
    const sx = width / box.width, sy = height / box.height;
    const region = {
      x: Math.round(rect.x * sx), y: Math.round(rect.y * sy),
      w: Math.round(rect.w * sx), h: Math.round(rect.h * sy),
    };
    // Crop the preview image for the chat bubble.
    const px = img.naturalWidth / box.width, py = img.naturalHeight / box.height;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.w * px));
    canvas.height = Math.max(1, Math.round(rect.h * py));
    canvas.getContext("2d")!.drawImage(img, rect.x * px, rect.y * py, rect.w * px, rect.h * py, 0, 0, canvas.width, canvas.height);
    onDone(region, canvas.toDataURL("image/jpeg", 0.85));
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onCancel(); }
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); confirm(); }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  });

  const hasRect = rect && rect.w >= 6 && rect.h >= 6;

  return (
    <div className="region-select-backdrop">
      <div className="region-select-head">
        <Crop size={14} />
        <span>Drag over the part of <b>{label}</b> the coach should look at</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn-neutral" onClick={onCancel}>Cancel</button>
          <button className="btn-neutral" onClick={() => onDone(null, preview)}>Whole image</button>
          <button className="btn-primary" onClick={confirm} disabled={!hasRect}>
            Analyse selection <span className="kbd">↵</span>
          </button>
        </div>
      </div>
      <div className="region-select-stage">
        <div className="region-select-frame"
          onPointerDown={e => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            dragging.current = true;
            const p = toLocal(e);
            setStart(p);
            setRect({ x: p.x, y: p.y, w: 0, h: 0 });
          }}
          onPointerMove={e => {
            if (!dragging.current || !start) return;
            const p = toLocal(e);
            setRect({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
          }}
          onPointerUp={() => { dragging.current = false; }}
        >
          <img ref={imgRef} src={preview} alt="capture" draggable={false} />
          {hasRect && (
            <div className="region-select-rect" style={{ left: rect!.x, top: rect!.y, width: rect!.w, height: rect!.h }} />
          )}
        </div>
      </div>
    </div>
  );
}
