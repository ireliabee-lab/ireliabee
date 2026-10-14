import { useEffect, useRef, useState } from "react";
import { apiSocketUrl, fetchApi, localReady } from "./api";

export type DictationState = "idle" | "connecting" | "recording" | "transcribing" | "error";

/** What one message from /audio/stream means for a push-to-talk answer. */
export function dictationStep(msg: { type?: string; text?: string; message?: string; error?: string }):
  { state?: DictationState; text?: string; error?: string; done?: boolean } {
  switch (msg.type) {
    case "recording": return { state: "recording" };
    case "transcript": return { text: (msg.text ?? "").trim(), done: true };
    case "empty": return { error: "Nothing was heard. Check your microphone and try again.", done: true };
    case "error":
      return { error: msg.error === "pro_required" ? "Speaking answers is part of iReliabee Pro." : (msg.message || "The microphone couldn't start."), done: true };
    default: return {};
  }
}

/**
 * Speak an answer instead of typing it (Study mode, S3). Uses the backend's
 * push-to-talk capture on /audio/stream: `start()` opens the mic, `stop()` ends
 * the recording and the transcript arrives through `onText`. The socket is
 * closed after every answer, so nothing listens (or is billed) in between.
 */
export function useDictation(onText: (text: string) => void, language?: string) {
  const [state, setState] = useState<DictationState>("idle");
  const [error, setError] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const wanted = useRef(false);
  const textRef = useRef(onText);
  textRef.current = onText;

  const close = () => {
    const s = ws.current;
    ws.current = null;
    if (s && s.readyState <= WebSocket.OPEN) {
      try { s.send(JSON.stringify({ action: "stop" })); } catch { /* already closing */ }
      s.close();
    }
  };
  useEffect(() => () => { wanted.current = false; close(); }, []);

  async function start() {
    if (ws.current) return;
    setError(null);
    setState("connecting");
    wanted.current = true;
    await localReady().catch(() => {});
    if (!wanted.current) { setState("idle"); return; }
    const sock = new WebSocket(apiSocketUrl("/audio/stream"));
    ws.current = sock;
    sock.onopen = async () => {
      let stt_provider = "deepgram";
      let stt_model: string | undefined;
      try {
        const cfg = await fetchApi("/config").then(r => (r.ok ? r.json() : null));
        if (cfg?.saved?.stt_provider) stt_provider = cfg.saved.stt_provider;
        if (cfg?.saved?.stt_model) stt_model = cfg.saved.stt_model;
      } catch { /* the default provider */ }
      sock.send(JSON.stringify({ mode: "push-to-talk", sources: ["mic"], stt_provider, stt_model, language }));
    };
    sock.onmessage = e => {
      let msg: Record<string, string> = {};
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "ready") {
        if (wanted.current) sock.send(JSON.stringify({ action: "start" })); else close();
        return;
      }
      const step = dictationStep(msg);
      if (step.state) setState(step.state);
      if (step.text) textRef.current(step.text);
      if (step.error) setError(step.error);
      if (step.done) { setState(step.error ? "error" : "idle"); close(); }
    };
    sock.onerror = () => { setError("The microphone couldn't start."); setState("error"); close(); };
    sock.onclose = () => { if (ws.current === sock) { ws.current = null; setState(s => (s === "error" ? s : "idle")); } };
  }

  function stop() {
    wanted.current = false;
    const s = ws.current;
    if (!s) { setState("idle"); return; }
    if (s.readyState === WebSocket.OPEN) {
      setState("transcribing");
      s.send(JSON.stringify({ action: "stop_record" }));
    } else {
      close();
      setState("idle");
    }
  }

  return { state, error, start, stop };
}
