import { useEffect, useRef, useState } from "react";
import { Pin, Minus, Square, X, ShieldCheck, ShieldOff, Palette } from "lucide-react";
import { ThemePicker, PatternPicker } from "./LookPicker";
import Logo from "./Logo";
import toast from "react-hot-toast";

// Only import Tauri APIs when running inside the Tauri shell
const isTauri = () => Boolean((window as any).__TAURI_INTERNALS__);

async function tauriWin() {
  if (!isTauri()) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export type BgMode = "glass" | "blurred" | "solid";

interface Props {
  sidebarOpen: boolean;
  bgMode?: BgMode;
  solidMode?: boolean;
  backendOk: boolean | null;
  onToggleSidebar: () => void;
  onSetBgMode?: (mode: BgMode) => void;
  onToggleSolid?: () => void;
}

export default function Titlebar({
  sidebarOpen,
  bgMode,
  solidMode,
  backendOk,
  onToggleSidebar,
  onSetBgMode,
  onToggleSolid,
}: Props) {
  const [maximized, setMaximized] = useState(false);
  const [pinned, setPinned]       = useState(false);
  // Screen-capture protection starts ON (the backend enables it at startup).
  const [protectedOn, setProtectedOn] = useState(true);

  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    tauriWin().then(win => {
      if (!win) return;
      win.isMaximized().then(m => mounted && setMaximized(m));
      const p = win.onResized(() => win.isMaximized().then(m => mounted && setMaximized(m)));
      return () => { mounted = false; p.then(u => u()); };
    });
  }, []);

  // Compact overlay forces pin on; restore the user's own choice afterwards.
  useEffect(() => {
    const h = async (e: Event) => {
      if ((e as CustomEvent).detail) return;
      (await tauriWin())?.setAlwaysOnTop(pinned).catch(() => {});
    };
    window.addEventListener("compact-mode", h);
    return () => window.removeEventListener("compact-mode", h);
  }, [pinned]);

  async function minimize()        { (await tauriWin())?.minimize(); }
  async function toggleMaximize()  { (await tauriWin())?.toggleMaximize(); }
  async function close()           { (await tauriWin())?.close(); }
  // isAlwaysOnTop() reports false on Linux even when the pin took effect, so
  // the button state follows the user's click once setAlwaysOnTop succeeds.
  async function togglePin() {
    const win = await tauriWin();
    if (!win) return;
    const next = !pinned;
    try {
      await win.setAlwaysOnTop(next);
      setPinned(next);
    } catch {
      toast.error("Couldn't change pin on top");
    }
  }

  // Toggle screen-capture protection: when ON, the window is excluded from
  // screenshots and screen-share/recording software (Windows/macOS; the Wayland
  // compositor may ignore it on Linux).
  async function toggleProtect() {
    const win = await tauriWin();
    if (!win) return;
    const next = !protectedOn;
    try {
      await win.setContentProtected(next);
      setProtectedOn(next);
      toast.success(next ? "Screen-capture protection on" : "Screen-capture protection off");
    } catch {
      toast.error("Couldn't change capture protection");
    }
  }

  const connLabel = backendOk === null ? "Checking…" : backendOk ? "Connected" : "Offline";
  const connState = backendOk === null ? "pending"   : backendOk ? "ok"        : "err";

  return (
    <div className="titlebar" data-tauri-drag-region>
      {/* Left */}
      <div className="titlebar-left">
        <span className="titlebar-brand"><Logo size={24} /> <span className="titlebar-title">iReliabee</span></span>
        <button className="titlebar-btn sidebar-toggle" onClick={onToggleSidebar}
          title={sidebarOpen ? "Hide sidebar (⌘/Ctrl+B)" : "Show sidebar (⌘/Ctrl+B)"}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            {sidebarOpen ? (
              <>
                <rect x="1" y="2" width="5" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="rgba(var(--accent-rgb),0.15)" />
                <rect x="7" y="2" width="8" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
              </>
            ) : (
              <>
                <rect x="1" y="2" width="14" height="12" rx="1" stroke="currentColor" strokeWidth="1.5" fill="none" />
                <line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <line x1="5" y1="11" x2="11" y2="11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </>
            )}
          </svg>
          <span className="kbd">⌘B</span>
        </button>
      </div>

      {/* Centre drag region */}
      <div className="titlebar-center" data-tauri-drag-region />

      {/* Right */}
      <div className="titlebar-right">
        {/* Backend status */}
        <div className="conn-pill" title={connLabel}>
          <span className={`conn-dot ${connState}`} />
          <span style={{ fontSize: 11, color: "var(--muted)" }}>{connLabel}</span>
        </div>

        {/* Background mode toggle: Glass | Blurred | Solid */}
        {(() => {
          const activeMode: BgMode = bgMode ?? (solidMode ? "solid" : "glass");
          const changeMode = (m: BgMode) => {
            if (onSetBgMode) onSetBgMode(m);
            else if (onToggleSolid) onToggleSolid();
          };
          return (
            <div className="opacity-toggle" role="group" aria-label="Background style">
              <button
                className={`opacity-btn glass ${activeMode === "glass" ? "active" : ""}`}
                onClick={() => changeMode("glass")}
                title="Glass mode (translucent)"
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.5 2" />
                </svg>
              </button>
              <button
                className={`opacity-btn blurred ${activeMode === "blurred" ? "active" : ""}`}
                onClick={() => changeMode("blurred")}
                title="Blurred mode (frosted glass)"
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.2" />
                  <circle cx="6.5" cy="6.5" r="2.8" fill="currentColor" fillOpacity="0.45" />
                </svg>
              </button>
              <button
                className={`opacity-btn solid ${activeMode === "solid" ? "active" : ""}`}
                onClick={() => changeMode("solid")}
                title="Solid mode (opaque)"
              >
                <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                  <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.2" fill="currentColor" fillOpacity="0.85" />
                </svg>
              </button>
            </div>
          );
        })()}

        <LookMenu />

        {/* Screen-capture protection */}
        <button className={`titlebar-btn ${protectedOn ? "active" : ""}`} onClick={toggleProtect}
          title={protectedOn ? "Protected — hidden from screen capture" : "Exposed — visible to screen capture"}>
          {protectedOn ? <ShieldCheck size={13} strokeWidth={1.8} /> : <ShieldOff size={13} strokeWidth={1.8} />}
        </button>

        {/* Pin */}
        <button className={`titlebar-btn ${pinned ? "active" : ""}`} onClick={togglePin}
          title={pinned ? "Unpin" : "Pin on top"}>
          <Pin size={13} strokeWidth={1.8} />
        </button>

        {/* Window controls — only meaningful inside Tauri, hidden in browser */}
        <button className="titlebar-btn win-minimize" onClick={minimize} title="Minimize">
          <Minus size={13} strokeWidth={1.8} />
        </button>
        <button className="titlebar-btn win-maximize" onClick={toggleMaximize}
          title={maximized ? "Restore" : "Maximize"}>
          {maximized ? (
            <span className="restore-icon">
              <Square size={9} strokeWidth={1.6} />
              <Square size={9} strokeWidth={1.6} />
            </span>
          ) : (
            <Square size={11} strokeWidth={1.6} />
          )}
        </button>
        <button className="titlebar-btn win-close" onClick={close} title="Close">
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

/** Palette button: switch theme and pattern without leaving the current screen. */
function LookMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div className="look-menu" ref={ref}>
      <button className={`titlebar-btn ${open ? "active" : ""}`} onClick={() => setOpen(o => !o)} title="Theme and pattern">
        <Palette size={13} strokeWidth={1.8} />
      </button>
      {open && (
        <div className="look-menu-pop glass-card" role="dialog" aria-label="Theme and pattern">
          <div className="look-menu-title">Theme</div>
          <ThemePicker compact />
          <div className="look-menu-title">Pattern</div>
          <PatternPicker compact />
        </div>
      )}
    </div>
  );
}
