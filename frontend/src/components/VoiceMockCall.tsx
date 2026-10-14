import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  Mic, MicOff, PhoneOff, Headphones, RotateCcw, Sparkles, MessageSquareText, BrainCircuit,
} from "lucide-react";
import CoachPanel, { ToneBadge } from "./CoachPanel";
import FollowupCard from "./FollowupCard";
import DebriefReport, { type Debrief } from "./DebriefReport";
import { apiSocketUrl, fetchApi } from "../lib/api";
import { streamCoachTurn } from "../lib/coachStream";
import { useStickToBottom } from "../lib/useStickToBottom";
import { DeliveryBar, saveDelivery, useDeliveryTracker } from "../lib/delivery";
import { getScenario } from "../lib/scenarios";
import { errorFromResponse, notifyError, openSettings, toFriendly, type FriendlyInfo } from "../lib/errors";
import Illustration from "./Illustration";
import { countWhileOpen } from "../lib/reminderSound";

export interface VoiceCallConfig {
  role: string;
  focus: string;
  count: number;
  jobDescription: string;
  voice: string;
  voiceName: string;
  headphones: boolean;
  model: string;
  tone: string;
  scenario: string;
  documentIds?: number[];
}

type CallState = "connecting" | "speaking" | "thinking" | "listening" | "user_speaking";
type Phase = "call" | "reviewing" | "results" | "failed";

interface Line { id: number; role: "interviewer" | "you"; text: string; ts: number; }
interface CoachCard { id: number; question: string; reply: string; loading: boolean; tone?: string; error?: FriendlyInfo; }


const AGENT_RATE = 24_000;
const EQ_BARS = 9;

// Plays the interviewer's PCM16 stream gaplessly and exposes its loudness.
class AgentPlayer {
  ctx = new AudioContext();
  analyser = this.ctx.createAnalyser();
  private next = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private samples = new Float32Array(1024);
  onIdle: () => void = () => {};

  constructor() {
    this.analyser.fftSize = 1024;
    this.analyser.connect(this.ctx.destination);
    // Keep the output stream running with silence for the whole call. Bluetooth
    // outputs sleep when idle; waking them takes 1–2 s and WebKit abandons the
    // stream in that gap, so the interviewer's voice never reaches the earbuds.
    const keepAlive = this.ctx.createConstantSource();
    keepAlive.offset.value = 0;
    keepAlive.connect(this.ctx.destination);
    keepAlive.start();
  }

  play(chunk: ArrayBuffer) {
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    const pcm = new Int16Array(chunk);
    if (!pcm.length) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, AGENT_RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser);
    const at = Math.max(this.ctx.currentTime + 0.02, this.next);
    src.start(at);
    this.next = at + buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.onIdle();
    };
  }

  stop() {
    this.sources.forEach(s => { try { s.stop(); } catch { /* already stopped */ } });
    this.sources.clear();
    this.next = 0;
  }

  get playing() { return this.sources.size > 0; }

  level() {
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += v * v;
    return Math.sqrt(sum / this.samples.length);
  }

  close() { this.stop(); this.ctx.close().catch(() => {}); }
}

function formatClock(sec: number) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

function formatTime(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function templateFor(role: string, scenario: string) {
  const fixed = getScenario(scenario).template;
  if (fixed) return fixed;
  if (/phd|research|academic|professor|postdoc|scholar/i.test(role)) return "academic-phd";
  if (/engineer|developer|software|data|devops|backend|frontend|ml\b|machine learning/i.test(role)) return "tech-interview";
  if (/product manager|\bpm\b/i.test(role)) return "product-management";
  return "general";
}

const STATE_LABEL: Record<CallState, string> = {
  connecting: "Connecting…",
  speaking: "Speaking",
  thinking: "Thinking…",
  listening: "Listening",
  user_speaking: "Listening to you",
};

let _lineId = 0;
let _cardId = 0;

export default function VoiceMockCall({ config, onExit }: { config: VoiceCallConfig; onExit: () => void }) {
  const [phase, setPhase] = useState<Phase>("call");
  const [callState, setCallState] = useState<CallState>("connecting");
  const [interviewer, setInterviewer] = useState(config.voiceName || "Interviewer");
  const [candidate, setCandidate] = useState("You");
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [cards, setCards] = useState<CoachCard[]>([]);
  const [autoCoach, setAutoCoach] = useState(true);
  const [narrowTab, setNarrowTab] = useState<"transcript" | "coach">("transcript");
  const [unseenCoach, setUnseenCoach] = useState(0);
  const [questionsAsked, setQuestionsAsked] = useState(0);
  const [report, setReport] = useState<Debrief | null>(null);
  const [error, setError] = useState<FriendlyInfo | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<AgentPlayer | null>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const eqRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const micLevel = useRef(0);
  const audioDone = useRef(false);
  const sessionId = useRef<number | null>(null);
  const callStateRef = useRef<CallState>("connecting");
  callStateRef.current = callState;

  // Interviewer text since her last completed turn, used to prompt the coach.
  const pendingTurn = useRef("");
  const lastQuestion = useRef("");
  const interviewerTurns = useRef(0);
  const coachHistory = useRef<{ role: string; content: string }[]>([]);
  const autoCoachRef = useRef(autoCoach);
  autoCoachRef.current = autoCoach;
  const narrowTabRef = useRef(narrowTab);
  narrowTabRef.current = narrowTab;

  const delivery = useDeliveryTracker(phase === "call");
  const transcriptRef = useStickToBottom<HTMLDivElement>();
  const coachRef = useStickToBottom<HTMLDivElement>();

  useEffect(() => {
    fetchApi("/profiles/").then(r => r.json()).then((rows: any[]) => {
      const active = rows.find(p => p.is_active);
      if (active?.name) setCandidate(active.name.split(" ")[0]);
    }).catch(() => {});
  }, []);

  // ── Coach ──────────────────────────────────────────────────────────────────
  async function askCoach(question: string) {
    const q = question.trim();
    if (!q) { toast("Nothing from the interviewer to answer yet", { icon: "🎙️" }); return; }
    const id = ++_cardId;
    setCards(prev => [...prev, { id, question: q, reply: "", loading: true }]);
    if (narrowTabRef.current !== "coach") setUnseenCoach(n => n + 1);
    try {
      await streamCoachTurn(
        {
          transcript: q, speaker: "interviewer", template: templateFor(config.role, config.scenario),
          model: config.model, history: coachHistory.current, response_tone: config.tone,
        },
        {
          onToken: text => setCards(prev => prev.map(c => c.id === id ? { ...c, reply: text } : c)),
          onMeta: meta => setCards(prev => prev.map(c => c.id === id ? { ...c, tone: meta.response_tone ?? c.tone } : c)),
          onDone: ev => { coachHistory.current = ev.history ?? coachHistory.current; },
        },
      );
      setCards(prev => prev.map(c => c.id === id ? { ...c, loading: false } : c));
    } catch (e: any) {
      setCards(prev => prev.map(c => c.id === id ? { ...c, loading: false, error: toFriendly(e) } : c));
    }
  }

  function completeInterviewerTurn() {
    const text = pendingTurn.current.trim();
    pendingTurn.current = "";
    if (!text) return;
    interviewerTurns.current += 1;
    // The first turn is the greeting; later turns ending in a question are interview questions.
    if (interviewerTurns.current > 1 && text.includes("?")) {
      lastQuestion.current = text;
      setQuestionsAsked(n => Math.min(config.count, n + 1));
      if (autoCoachRef.current) askCoach(text);
    }
  }

  function addCaption(role: "interviewer" | "you", text: string) {
    setLines(prev => {
      const last = prev[prev.length - 1];
      if (last && last.role === role) {
        return [...prev.slice(0, -1), { ...last, text: `${last.text} ${text}` }];
      }
      return [...prev, { id: ++_lineId, role, text, ts: Date.now() }];
    });
  }

  // ── Call lifecycle ─────────────────────────────────────────────────────────
  useEffect(() => {
    const player = new AgentPlayer();
    playerRef.current = player;
    player.ctx.resume().catch(() => {});

    // With this launch's token, fetched before the app first rendered (audit 180-C3).
    const ws = new WebSocket(apiSocketUrl("/mock/voice"));
    countWhileOpen(ws);   // reminders stay silent during the call
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    const send = (m: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

    player.onIdle = () => {
      if (audioDone.current) {
        audioDone.current = false;
        send({ type: "playback", playing: false });
      }
    };

    ws.onopen = () => send({
      type: "start", scenario: config.scenario, role: config.role, focus: config.focus, count: config.count,
      job_description: config.jobDescription, voice: config.voice, headphones: config.headphones,
      document_ids: config.documentIds?.length ? config.documentIds : undefined,
    });

    ws.onmessage = e => {
      if (e.data instanceof ArrayBuffer) { player.play(e.data); return; }
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "session":
          sessionId.current = msg.session_id;
          if (msg.interviewer) setInterviewer(msg.interviewer);
          break;
        case "state":
          if (msg.state === "listening" && player.playing) break;
          if (msg.state === "user_speaking") completeInterviewerTurn();
          delivery.activity("you", msg.state === "user_speaking");
          delivery.activity("them", msg.state === "speaking");
          setCallState(msg.state);
          break;
        case "caption":
          addCaption(msg.role, msg.text);
          if (msg.role === "you") delivery.finalText("you", msg.text);
          if (msg.role === "interviewer") pendingTurn.current += ` ${msg.text}`;
          else completeInterviewerTurn();
          break;
        case "level":
          micLevel.current = msg.mic;
          break;
        case "agent_audio_done":
          audioDone.current = true;
          completeInterviewerTurn();
          if (!player.playing) player.onIdle();
          break;
        case "interrupt":
          player.stop();
          audioDone.current = false;
          send({ type: "playback", playing: false });
          break;
        case "error":
          setError(toFriendly(msg));
          notifyError(msg);
          break;
        case "ended":
          finishCall();
          break;
      }
    };
    ws.onclose = () => { if (sessionId.current != null) finishCall(); };

    return () => {
      ws.onclose = null;
      ws.onmessage = null;
      if (ws.readyState === WebSocket.OPEN) send({ type: "end" });
      ws.close();
      player.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== "call") return;
    const id = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Animate the orb from the interviewer's voice and the equalizer from the candidate's mic.
  useEffect(() => {
    let raf = 0;
    let orb = 0;
    let mic = 0;
    const phases = Array.from({ length: EQ_BARS }, (_, i) => i * 0.9);
    const tick = (t: number) => {
      const player = playerRef.current;
      const agent = callStateRef.current === "speaking" && player ? player.level() * 5 : 0.04;
      orb += (Math.min(1, agent) - orb) * 0.25;
      orbRef.current?.style.setProperty("--level", orb.toFixed(3));

      mic += (Math.min(1, micLevel.current * 12) - mic) * 0.3;
      eqRefs.current.forEach((bar, i) => {
        if (!bar) return;
        const wave = 0.55 + 0.45 * Math.sin(t / (180 + i * 23) + phases[i]);
        bar.style.transform = `scaleY(${(0.12 + mic * wave).toFixed(3)})`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Shortcuts: M = mute, R = ask the coach now.
  useEffect(() => {
    if (phase !== "call") return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "m") { e.preventDefault(); toggleMute(); }
      if (key === "r") { e.preventDefault(); askCoach(pendingTurn.current || lastQuestion.current); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const finishing = useRef(false);
  async function finishCall() {
    if (finishing.current) return;
    finishing.current = true;
    playerRef.current?.stop();
    wsRef.current?.close();
    if (sessionId.current == null) { onExit(); return; }
    saveDelivery(sessionId.current, delivery.snapshot());
    setPhase("reviewing");
    try {
      const res = await fetchApi("/mock/voice/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId.current, model: config.model, response_tone: config.tone }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      setReport(await res.json());
      setPhase("results");
    } catch (e: any) {
      setError(toFriendly(e));
      setPhase("failed");
    }
  }

  function hangUp() {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "end" }));
    } else {
      finishCall();
    }
  }

  function toggleMute() {
    setMuted(m => {
      const next = !m;
      wsRef.current?.send(JSON.stringify({ type: "mute", muted: next }));
      return next;
    });
  }

  // ── Call room ──────────────────────────────────────────────────────────────
  if (phase === "call") {
    const interviewerActive = callState === "speaking";
    const youActive = callState === "user_speaking" && !muted;
    return (
      <div className="mock-room">
        <header className="mock-topbar">
          <div className="mock-topbar-left">
            <span className="call-live-dot" />
            <span className="mock-title">{getScenario(config.scenario).title}</span>
            {config.role && <span className="mock-chip">{config.role}</span>}
          </div>
          <div className="mock-progress" title="Interview questions asked">
            {Array.from({ length: config.count }, (_, i) => (
              <span key={i} className={i < questionsAsked ? "done" : i === questionsAsked ? "next" : ""} />
            ))}
            <em>Q{Math.min(questionsAsked, config.count)}/{config.count}</em>
          </div>
          <span className="mock-clock">{formatClock(elapsed)}</span>
        </header>

        <DeliveryBar stats={delivery.stats} />

        <div className="mock-grid" data-tab={narrowTab}>
          {/* Participants */}
          <section className="mock-stage">
            <div className={`mock-tile interviewer ${interviewerActive ? "active" : ""}`}>
              <div ref={orbRef} className={`voice-orb state-${callState}`} style={{ ["--orb" as any]: "150px" }}>
                <span className="orb-ring r3" /><span className="orb-ring r2" /><span className="orb-ring r1" />
                <span className="orb-core"><span className="orb-initial">{interviewer[0]}</span></span>
                {callState === "thinking" && <span className="orb-orbit"><i /><i /><i /></span>}
              </div>
              <div className="mock-tile-meta">
                <span className="mock-tile-name">{interviewer}</span>
                <span className="mock-tile-role">Interviewer</span>
              </div>
              <span className="mock-tile-status" data-state={callState}>{STATE_LABEL[callState]}</span>
            </div>

            <div className={`mock-tile you ${youActive ? "active" : ""} ${muted ? "is-muted" : ""}`}>
              <div className="you-avatar">
                <span>{candidate[0]?.toUpperCase()}</span>
              </div>
              <div className="eq" aria-hidden>
                {Array.from({ length: EQ_BARS }, (_, i) => (
                  <span key={i} ref={el => { eqRefs.current[i] = el; }} />
                ))}
              </div>
              <div className="mock-tile-meta">
                <span className="mock-tile-name">{candidate}</span>
                <span className="mock-tile-role">Candidate</span>
              </div>
              {muted && <span className="mock-tile-status muted"><MicOff size={11} /> Muted</span>}
            </div>

            <div className="mock-controls">
              <button className={`call-btn ${muted ? "muted" : ""}`} onClick={toggleMute} title={`${muted ? "Unmute" : "Mute"} (M)`}>
                {muted ? <MicOff size={19} /> : <Mic size={19} />}
              </button>
              <button className="call-btn end" onClick={hangUp} title="End interview">
                <PhoneOff size={21} />
              </button>
              <button
                className={`call-btn ${autoCoach ? "on" : ""}`}
                onClick={() => setAutoCoach(a => !a)}
                title={autoCoach ? "Coach suggests answers automatically" : "Coach only when you press R"}
              >
                <Sparkles size={18} />
              </button>
              <span className="call-btn passive" title={config.headphones ? "Headphones — you can interrupt" : "Speaker mode — mic pauses while the interviewer talks"}>
                <Headphones size={17} style={{ opacity: config.headphones ? 1 : 0.35 }} />
              </span>
            </div>
          </section>

          {/* Narrow-window tab switcher */}
          <div className="mock-tabs">
            <button className={narrowTab === "transcript" ? "active" : ""} onClick={() => setNarrowTab("transcript")}>
              <MessageSquareText size={14} /> Transcript
            </button>
            <button className={narrowTab === "coach" ? "active" : ""} onClick={() => { setNarrowTab("coach"); setUnseenCoach(0); }}>
              <BrainCircuit size={14} /> Coach {unseenCoach > 0 && <b>{unseenCoach}</b>}
            </button>
          </div>

          {/* Transcript */}
          <section className="mock-panel transcript">
            <div className="mock-panel-head">
              <MessageSquareText size={14} />
              <span>Live transcript</span>
            </div>
            <div className="mock-panel-body" ref={transcriptRef.ref}>
              {lines.length === 0 && (
                <div className="mock-empty">
                  <div className="mock-empty-pulse" />
                  <p>{callState === "connecting" ? `Connecting to ${interviewer}…` : `Say hello when you hear ${interviewer}.`}</p>
                </div>
              )}
              {lines.map(line => (
                <div key={line.id} className={`bubble-row ${line.role}`}>
                  <div className="bubble-meta">
                    <span>{line.role === "interviewer" ? interviewer : candidate}</span>
                    <time>{formatTime(line.ts)}</time>
                  </div>
                  <div className="bubble">{line.text}</div>
                </div>
              ))}
              {callState === "thinking" && (
                <div className="bubble-row interviewer">
                  <div className="bubble typing"><i /><i /><i /></div>
                </div>
              )}
              {error && <p className="caption-error" style={{ textAlign: "center" }}>{error.title ? `${error.title}. ` : ""}{error.message}</p>}
            </div>
          </section>

          {/* Coach */}
          <section className="mock-panel coach">
            <div className="mock-panel-head">
              <BrainCircuit size={14} />
              <span>Coach</span>
              <button className="coach-ask" onClick={() => askCoach(pendingTurn.current || lastQuestion.current)} title="Ask the coach about the latest question (R)">
                <Sparkles size={12} /> Ask <span className="kbd">R</span>
              </button>
            </div>
            <div className="mock-panel-body" ref={coachRef.ref}>
              {cards.length === 0 && (
                <div className="mock-empty">
                  <Illustration name="score" size={150} />
                  <p>{autoCoach
                    ? "When the interviewer asks a question, a suggested answer appears here."
                    : "Auto-coach is off. Press R when you want a suggestion."}</p>
                </div>
              )}
              {cards.map(card => (
                <article key={card.id} className="coach-card">
                  <header>
                    <span className="coach-card-q">“{card.question}”</span>
                    <ToneBadge tone={card.tone} />
                  </header>
                  {card.error ? (
                    <div className="card-error">
                      <strong>{card.error.title || "Coach couldn't answer"}</strong>
                      <span>{card.error.message}</span>
                      {card.error.action === "settings" && <button onClick={openSettings}>Open Settings</button>}
                    </div>
                  ) : card.reply ? (
                    <CoachPanel reply={card.reply} />
                  ) : (
                    <div className="coach-skeleton"><span /><span /><span /></div>
                  )}
                </article>
              ))}
              {(() => {
                const lastYou = [...lines].reverse().find(l => l.role === "you");
                if (!lastYou) return null;
                return (
                  <FollowupCard
                    triggerKey={`${lastYou.id}:${lastYou.text.length}`}
                    lines={lines.map(l => ({ speaker: l.role, text: l.text }))}
                  />
                );
              })()}
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (phase === "reviewing") {
    return (
      <div className="mock-review">
        <div className="voice-orb state-thinking" style={{ ["--level" as any]: 0.2, ["--orb" as any]: "190px" }}>
          <span className="orb-ring r3" /><span className="orb-ring r2" /><span className="orb-ring r1" />
          <span className="orb-core"><span className="orb-initial">✓</span></span>
          <span className="orb-orbit"><i /><i /><i /></span>
        </div>
        <div className="mock-tile-name" style={{ fontSize: 20 }}>Reviewing your interview…</div>
        <div className="muted" style={{ fontSize: 12 }}>Scoring each answer and writing stronger versions</div>
      </div>
    );
  }

  return (
    <div className="page-content">
        {phase === "failed" || !report ? (
          <div className="glass-card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{error?.title || "No feedback for this call"}</div>
            <p className="muted" style={{ fontSize: 13 }}>{error?.message || "Something went wrong."}</p>
            {error?.action === "settings" && <button className="btn-primary" onClick={openSettings}>Open Settings</button>}
          </div>
        ) : (
          <DebriefReport report={report} sessionId={sessionId.current} subtitle={`Interview with ${interviewer} · ${formatClock(elapsed)}`} />
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn-primary" onClick={onExit}><RotateCcw size={14} /> Practise again</button>
        </div>
    </div>
  );
}
