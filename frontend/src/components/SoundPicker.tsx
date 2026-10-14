import { useEffect, useRef } from "react";
import { Check, Headphones, Mic, X, AlertTriangle } from "lucide-react";
import LevelMeter from "./LevelMeter";
import type { Level } from "../lib/levels";

/**
 * Which microphone, and which output to listen to.
 *
 * These were two dropdowns sitting in the session's control row, each as wide
 * as a device name and both there whether or not anyone was going to touch
 * them. They are opened from a speaker icon now, the way an operating system
 * does it: a small panel, the devices as a list, the one in use ticked.
 *
 * The live meters are in here on purpose. Choosing a microphone from a list of
 * names is guesswork; choosing one while watching it react to your voice is
 * not, and that is the whole reason someone opens this panel.
 */

export interface Device { id: string; label: string }

interface Props {
  inputs: Device[];
  outputs: Device[];
  micDevice: string;
  sysDevice: string;
  onMic: (id: string) => void;
  onSys: (id: string) => void;
  /** What the backend reports it is actually capturing the call from. */
  capturing: { devices: string[]; skipped: string[]; stale: string | null };
  /** And which microphone it opened — which "Automatic" does not otherwise say. */
  micCapturing: string[];
  levels: { mic: Level; system: Level };
  micOn: boolean;
  sysOn: boolean;
  /** Whether a change lands now or at the next session. */
  live: boolean;
  themLabel: string;
  onClose: () => void;
}

function Row({ chosen, label, hint, onPick }: {
  chosen: boolean; label: string; hint?: string; onPick: () => void;
}) {
  return (
    <button className={`sound-row ${chosen ? "on" : ""}`} onClick={onPick} role="radio" aria-checked={chosen}>
      <span className="sound-tick">{chosen && <Check size={13} />}</span>
      <span className="sound-name">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </button>
  );
}

export default function SoundPicker({
  inputs, outputs, micDevice, sysDevice, onMic, onSys,
  capturing, micCapturing, levels, micOn, sysOn, live, themLabel, onClose,
}: Props) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const handler = (e: KeyboardEvent) => {
      // Caught here so a panel over another dialog closes itself, not both.
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose]);

  return (
    <div className="sound-backdrop" onClick={onClose}>
      <div className="sound-panel" ref={panel} tabIndex={-1} onClick={e => e.stopPropagation()}
           role="dialog" aria-label="Sound">
        <div className="sound-head">
          <strong>Sound</strong>
          <button className="sound-close" onClick={onClose} title="Close (Esc)"><X size={14} /></button>
        </div>

        {/* ── Your microphone ─────────────────────────────────────────── */}
        <div className="sound-section">
          <div className="sound-section-head">
            <Mic size={13} /> <span>Your voice</span>
            {micOn && <LevelMeter label="You" which="mic" on={micOn} level={levels.mic} small />}
          </div>
          <div role="radiogroup" aria-label="Your voice">
            <Row chosen={micDevice === ""} label="Automatic"
                 hint="whatever this computer is set to use" onPick={() => onMic("")} />
            {inputs.map(d => (
              <Row key={d.id} chosen={micDevice === d.id} label={d.label} onPick={() => onMic(d.id)} />
            ))}
          </div>
          {!inputs.length && <p className="sound-none">No microphones found.</p>}

          {/* Which microphone "Automatic" came out as. Only worth a line when
              nothing was chosen: when a device was picked, the tick says it. */}
          {micOn && micDevice === "" && micCapturing.length > 0 && (
            <p className="sound-hearing">Hearing: {micCapturing.join(", ")}</p>
          )}
        </div>

        {/* ── What the call plays through ─────────────────────────────── */}
        <div className="sound-section">
          <div className="sound-section-head">
            <Headphones size={13} /> <span>{themLabel}’s voice</span>
            {sysOn && <LevelMeter label={themLabel} which="system" on={sysOn} level={levels.system} small />}
          </div>
          <div role="radiogroup" aria-label={`${themLabel}'s voice`}>
            <Row chosen={sysDevice === ""} label="All outputs"
                 hint="hears the call wherever it plays" onPick={() => onSys("")} />
            {outputs.map(d => (
              <Row key={d.id} chosen={sysDevice === d.id} label={d.label} onPick={() => onSys(d.id)} />
            ))}
          </div>
          {!outputs.length && <p className="sound-none">No outputs found.</p>}

          {/* What is actually being captured, which is not always what was chosen. */}
          {sysOn && capturing.devices.length > 0 && (
            <p className={`sound-hearing${capturing.stale ? " is-stale" : ""}`}>
              {capturing.stale
                ? <><AlertTriangle size={12} /> Not hearing the call. {capturing.stale}</>
                : <>Hearing: {capturing.devices.join(", ")}</>}
            </p>
          )}
          {capturing.skipped.length > 0 && (
            <p className="sound-hearing is-stale">
              <AlertTriangle size={12} /> Could not open: {capturing.skipped.join("; ")}
            </p>
          )}
        </div>

        {live && (
          <p className="sound-foot">A different device is used from the next session — this one keeps the one it started with.</p>
        )}
      </div>
    </div>
  );
}
