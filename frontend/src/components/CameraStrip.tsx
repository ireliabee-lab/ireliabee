import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Loader2, Maximize2, PanelTop, AlignLeft, ListChecks, MessageSquare } from "lucide-react";
import { parseReply } from "./CoachPanel";
import { readUpTo, wordsOf } from "../lib/readAloud";
import type { DeliveryStats } from "../lib/delivery";

interface Props {
  reply: string;
  loading: boolean;
  heard: string;
  /** Who said it: "You" or whatever this scenario calls the other person. */
  heardLabel: string;
  /** What the user has said out loud since this answer arrived (their microphone). */
  said: string;
  /** Whether the transcriber writes while someone speaks, or only after a pause. */
  streaming: boolean;
  listening: boolean;
  stats: DeliveryStats | null;
  /** Answer one side now: their words (R), or yours (Shift+R / Shift-click). */
  onRespond: (side: "user" | "interviewer") => void;
  onOverlay: () => void;
  onExpand: () => void;
  /** Show or hide the chat under the strip (T). */
  onChat?: () => void;
}

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

async function startDrag(e: React.MouseEvent) {
  if (e.button !== 0 || !(window as any).__TAURI_INTERNALS__) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  getCurrentWindow().startDragging().catch(() => {});
}

const readPref = () => { try { return localStorage.getItem("cameraStripCuesOnly") === "1"; } catch { return false; } };

/**
 * Near-the-camera mode: a short strip docked under the webcam. The cues come
 * first and large, so a glance is enough; the short answer sits right below.
 * Keeping the text close to the lens keeps your eyes close to the other
 * person's on their screen.
 */
export default function CameraStrip({ reply, loading, heard, heardLabel, said, listening, streaming, stats, onRespond, onOverlay, onExpand, onChat }: Props) {
  const { cues, short, full } = parseReply(reply);
  const answer = (short || full).replace(/\*\*/g, "");
  const [cuesOnly, setCuesOnly] = useState(readPref);
  const bodyRef = useRef<HTMLDivElement>(null);
  // How far the voice has got through the answer, so the words already said can
  // step back and leave the eye on the ones still to come.
  const words = useMemo(() => wordsOf(answer), [answer]);
  const [spoken, setSpoken] = useState(0);
  useEffect(() => { setSpoken(0); }, [answer]);
  useEffect(() => {
    const at = readUpTo(said, words);
    setSpoken(prev => (at > prev ? at : prev));
  }, [said, words]);

  useEffect(() => { try { localStorage.setItem("cameraStripCuesOnly", cuesOnly ? "1" : "0"); } catch { /* per-device nicety */ } }, [cuesOnly]);
  // While the answer is being written, follow its end so the newest words are
  // in view: the strip is short, and they used to land below it.
  useEffect(() => {
    const box = bodyRef.current;
    if (!box) return;
    if (loading) box.scrollTo({ top: box.scrollHeight });
    else if (reply === "") box.scrollTo({ top: 0 });
  }, [reply, loading]);

  const timer = stats?.answering ? stats.answerSec : 0;
  const timerState = timer >= 90 ? "hard" : timer >= 60 ? "soft" : "ok";

  return (
    <div className="camera-strip">
      <span className="camera-notch" aria-hidden title="Your camera is just above here" />
      <div className="camera-bar" onMouseDown={startDrag} data-tauri-drag-region>
        <span className={`compact-live ${listening ? "on" : ""}`}
              title={streaming ? undefined : "Words appear a moment after each pause, not while you speak"}>
          <i /> {listening ? (streaming ? "Live" : "After pauses") : "Idle"}
        </span>
        {heard && <span className="camera-heard" title={heard}><b>{heardLabel}</b> “{heard}”</span>}
        {stats?.answering && <span className={`compact-timer ${timerState}`}>{clock(timer)}{timerState === "hard" ? " · wrap up" : ""}</span>}
        {loading && <Loader2 size={12} className="spin" />}
        <div className="compact-actions" onMouseDown={e => e.stopPropagation()}>
          <button onClick={() => setCuesOnly(v => !v)} title={cuesOnly ? "Show the short answer too" : "Show only the cues (less reading)"}>
            {cuesOnly ? <AlignLeft size={12} /> : <ListChecks size={12} />}
          </button>
          <button onClick={e => onRespond(e.shiftKey ? "user" : "interviewer")} title="Answer what they said (R). Shift+R, or Shift-click, answers what you said."><CornerDownLeft size={12} /> <span className="kbd">R</span></button>
          {onChat && (
            <button onClick={onChat} title="Show or hide the chat under the strip (T)">
              <MessageSquare size={12} /> <span className="kbd">T</span>
            </button>
          )}
          <button onClick={onOverlay} title="Switch to the movable overlay"><PanelTop size={12} /></button>
          <button onClick={onExpand} title="Back to full view (E, or O)"><Maximize2 size={12} /> <span className="kbd">E</span></button>
        </div>
      </div>

      <div className="camera-body" ref={bodyRef}>
        {cues.length > 0 ? (
          <div className="camera-cues">{cues.map((c, i) => <span key={i}>{c}</span>)}</div>
        ) : !answer && (
          <p className="camera-empty">{loading ? "Thinking…" : "Cues show here, right under your camera, when a question comes in."}</p>
        )}
        {!cuesOnly && answer && (
          <p className="camera-answer">
            {words.map((w, i) => (
              <span key={i}>
                <span className={i < spoken ? "was" : i === spoken ? "here" : ""}>{w}</span>{" "}
              </span>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}
