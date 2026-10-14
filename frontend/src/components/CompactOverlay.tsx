import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines, Camera, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Loader2, Maximize2, Minimize2, MonitorUp, Mic, Move, RotateCcw,
  ThumbsDown, ThumbsUp, Type, X,
} from "lucide-react";
import { parseReply, type Pronunciation } from "./CoachPanel";
import { track } from "../lib/usage";
import { breathLines, plain, readUpTo, secondsLeft, wordsOf } from "../lib/readAloud";
import type { DeliveryStats } from "../lib/delivery";
import { quiet, type Level } from "../lib/levels";
import { isTypingTarget } from "../lib/liveKeys";
import LevelMeter from "./LevelMeter";

/**
 * The in-call overlay: three pieces that sit over whatever the user is really
 * doing.
 *
 *   1. a command bar — what you can do, and the key that does it
 *   2. a transcript line — what has just been heard
 *   3. the answer — set like a teleprompter, to be read out loud
 *
 * Separate pieces because they want different amounts of attention. The bar is
 * glanced at, the line is read peripherally, and the answer is the only thing
 * anyone looks at directly while someone is waiting for them to speak.
 *
 * Nothing sits on a card. The answer is the one thing being read, and a panel
 * around it only adds edges for the eye to catch on; the window behind it is
 * already the app's own surface. What is left is the text — short lines, large
 * type, and a marker that keeps up with the voice.
 *
 * The key badges show iReliabee's real shortcuts. Borrowing another product's
 * chrome is fine; borrowing its keystrokes would print keys that do nothing.
 */

export interface OverlayTurn {
  id: number;
  transcript: string;
  reply?: string;
  partialReply?: string;
  ts?: number;
}

interface Props {
  turns: OverlayTurn[];
  loading: boolean;
  heard: string;
  /** Who said it: "You" or whatever this scenario calls the other person. */
  heardLabel: string;
  /** Whether that was the other person, rather than the user reading aloud. */
  heardFromThem: boolean;
  /** What the user themselves has said since this answer arrived (their microphone). */
  said: string;
  listening: boolean;
  /** Whether the transcriber writes while someone speaks, or only after a pause. */
  streaming: boolean;
  /** How loud each side is, for the meters. */
  levels: { mic: Level; system: Level };
  micOn: boolean;
  sysOn: boolean;
  stats: DeliveryStats | null;
  /** Answer one side now: their words (R), or yours (Shift+R / Shift-click). */
  onRespond: (side: "user" | "interviewer") => void;
  onScreenshot: () => void;
  onChat: () => void;
  onEnd: () => void;
  onToggleMic: () => void;
  onToggleSys: () => void;
  onCamera?: () => void;
  onExpand: () => void;
}

function clock(sec: number) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * How big the reading text is. Bigger type takes fewer words a line — the
 * point of both is the same: less distance for the eye to travel, so the
 * reader's place is never lost between one line and the next.
 */
const SIZES = [
  { px: 14, per: 9, label: "Small" },
  { px: 16, per: 7, label: "Comfortable" },
  { px: 20, per: 6, label: "Large" },
  { px: 25, per: 5, label: "Presentation" },
];

/**
 * The most words a sentence keeps on one line before it is split. Lines are
 * sentences, and the browser wraps a long one at the edge of the window, so
 * this only guards against one that never ends.
 */
export const SENTENCE_MAX = 40;
const SIZE_KEY = "overlayReadSize";
const readSize = () => {
  try {
    const saved = localStorage.getItem(SIZE_KEY);
    const n = saved === null ? NaN : Number(saved);
    return Number.isInteger(n) && n >= 0 && n < SIZES.length ? n : 1;
  } catch { return 1; }
};

/** Break live speech into short phrases, so a long sentence stays scannable. */
function phrases(text: string, per = 4): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += per) out.push(words.slice(i, i + per).join(" "));
  return out;
}

async function startDrag(e: React.MouseEvent) {
  if (e.button !== 0 || !(window as any).__TAURI_INTERNALS__) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  getCurrentWindow().startDragging().catch(() => {});
}

export default function CompactOverlay({
  turns, loading, heard, heardLabel, heardFromThem, said, listening, streaming,
  levels = { mic: quiet, system: quiet }, micOn, sysOn, stats,
  onRespond, onScreenshot, onChat, onEnd, onToggleMic, onToggleSys, onCamera, onExpand,
}: Props) {
  // Which answer is on screen. -1 means "the newest", so a reply arriving
  // mid-call replaces what is shown rather than leaving the user on an old one.
  const [offset, setOffset] = useState(-1);
  const [showFull, setShowFull] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [voted, setVoted] = useState<"up" | "down" | null>(null);
  const [size, setSize] = useState(readSize);
  /** How many words of the answer have been said out loud. */
  const [spoken, setSpoken] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLParagraphElement>(null);
  // Where the marker was last put by hand, and how much had been heard by then:
  // everything after that point is matched from there, so moving the marker
  // back is not immediately undone by speech that was already counted.
  const anchor = useRef({ heardFrom: 0, word: 0 });
  /** The other person started saying something a moment ago. */
  const [cutIn, setCutIn] = useState(false);

  const answers = useMemo(
    () => turns.filter(t => (t.reply || t.partialReply || "").trim()),
    [turns],
  );
  const index = offset < 0 ? answers.length - 1 : Math.min(offset, answers.length - 1);
  const current = answers[index];
  const reply = current?.partialReply || current?.reply || "";
  const { cues, short, full, pronounce } = parseReply(reply);
  const body = (showFull ? full || short : short || full).replace(/\*\*/g, "");

  const atNewest = index === answers.length - 1;
  const hasPrev = index > 0;
  const hasNext = !atNewest;

  const words = useMemo(() => wordsOf(body), [body]);
  // One sentence a line, wrapped by the browser at the edge of the window:
  // a narrow column of one phrase a line left half the overlay empty.
  const lines = useMemo(() => breathLines(words, SENTENCE_MAX, { sentences: true }), [words]);
  // Where each line starts in `words`, so a word knows whether it has been said.
  const starts = useMemo(() => {
    let at = 0;
    return lines.map(line => { const from = at; at += line.length; return from; });
  }, [lines]);
  // Words the coach flagged as hard to say, by their plain spelling.
  const tricky = useMemo(() => {
    const map = new Map<string, Pronunciation>();
    for (const p of pronounce) map.set(plain(p.word), p);
    return map;
  }, [pronounce]);

  // Only the newest answer is the one being read, and only the microphone can
  // tell how far along the voice is. Anything else is followed by hand.
  const following = atNewest && micOn && words.length > 0;

  // A new answer pulls the view back to the front, on the short version.
  useEffect(() => {
    if (loading) { setOffset(-1); setShowFull(false); setDismissed(false); setVoted(null); }
  }, [loading]);
  useEffect(() => { setVoted(null); }, [current?.id]);
  useEffect(() => { setCleared(false); }, [heard]);
  // They have started saying something. Half way through an answer that is an
  // interruption, and reading on over it is the one thing that makes reading
  // obvious — so it is said plainly, and then gets out of the way.
  useEffect(() => {
    if (!heard.trim() || !heardFromThem) return;   // the user reading aloud is not an interruption
    setCutIn(true);
    const t = window.setTimeout(() => setCutIn(false), 3000);
    return () => window.clearTimeout(t);
  }, [heard, heardFromThem]);
  useEffect(() => { setDismissed(false); }, [current?.id]);
  // F switches between the short and the full answer, as the footer button
  // does. Not while typing, and not with a modifier (Ctrl+F finds).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || e.ctrlKey || e.metaKey || e.altKey) return;
      // Never while typing: the chat under the overlay is a text box too (lib/liveKeys.ts).
      if (isTypingTarget(e.target) || isTypingTarget(document.activeElement) || e.isComposing) return;
      e.preventDefault();
      setShowFull(v => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // What they are saying runs like a ticker: the newest words stay in view at
  // the right and the older ones slide out to the left. It used to show the
  // start and cut the end off ("…a background in comm").
  const wordsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wordsRef.current;
    if (el) el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [heard]);

  // A new answer comes to the front even if an older one was being looked at:
  // what the coach has just said is what matters mid-call.
  const answerCount = answers.length;
  const seen = useRef(answerCount);
  useEffect(() => {
    if (answerCount > seen.current) setOffset(-1);
    seen.current = answerCount;
  }, [answerCount]);

  // While an answer is still being written and reading has not started, follow
  // its end, so the newest words are in view rather than below the fold.
  useEffect(() => {
    if (!current?.partialReply || spoken > 0) return;
    const box = bodyRef.current;
    if (box) box.scrollTo({ top: box.scrollHeight });
  }, [current?.partialReply, spoken]);

  // A different answer, or the same one at a different length, starts unread.
  useEffect(() => {
    anchor.current = { heardFrom: 0, word: 0 };
    setSpoken(0);
    bodyRef.current?.scrollTo({ top: 0 });
  }, [current?.id, showFull]);

  // Reading along: match what has been heard from this microphone against the
  // words on screen. Only ever forwards — a marker that slips back mid-sentence
  // is worse than one that waits.
  useEffect(() => {
    if (!following) return;
    const { heardFrom, word } = anchor.current;
    const rest = said.slice(Math.min(heardFrom, said.length));
    const at = word + readUpTo(rest, words.slice(word));
    setSpoken(prev => (at > prev ? at : prev));
  }, [said, words, following]);

  // Keep the line being read in the same place on screen, a third of the way
  // down, so the eyes stay still and the words come to them.
  useEffect(() => {
    const box = bodyRef.current, line = lineRef.current;
    if (!box || !line) return;
    const want = line.offsetTop - box.clientHeight * 0.34;
    if (Math.abs(box.scrollTop - want) < 8) return;
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({ top: Math.max(0, want), behavior: smooth ? "smooth" : "auto" });
  }, [spoken, size]);

  useEffect(() => { try { localStorage.setItem(SIZE_KEY, String(size)); } catch { /* per-device nicety */ } }, [size]);

  function vote(direction: "up" | "down") {
    setVoted(direction);
    track(`coach.feedback.${direction}`);
  }

  /** Put the marker on a word by hand — for when the ear and the eye disagree. */
  function markAt(word: number) {
    anchor.current = { heardFrom: said.length, word };
    setSpoken(word);
    track("overlay.read.mark");
  }

  const timer = stats?.answering ? stats.answerSec : 0;
  const timerState = timer >= 90 ? "hard" : timer >= 60 ? "soft" : "ok";
  const theirWords = cleared ? [] : phrases(heard);
  const left = Math.max(0, words.length - spoken);
  const leftLabel = `${left} ${left === 1 ? "word" : "words"}`;
  const done = words.length > 0 && left === 0;
  // Reading on while the other person is talking is what gives it away.
  const interrupted = cutIn && spoken > 0 && !done;

  return (
    <div className="ov">
      {/* ── Command bar ─────────────────────────────────────────────── */}
      <div className="ov-bar" onMouseDown={startDrag} data-tauri-drag-region>
        <div className="ov-sources" onMouseDown={e => e.stopPropagation()}>
          {/* These look like controls, so they are controls: the commonest thing
              anyone wants mid-call is to stop one of them listening. */}
          <button className={`ov-src ${sysOn ? "on" : ""}`} onClick={onToggleSys}
                  title={sysOn ? "Hearing the call — click to stop (L)" : "Call audio off — click to listen (L)"}>
            <MonitorUp size={13} />{sysOn && <i />}
          </button>
          <button className={`ov-src ${micOn ? "on" : ""}`} onClick={onToggleMic}
                  title={micOn ? "Hearing you — click to mute (Y)" : "Microphone off — click to listen (Y)"}>
            <Mic size={13} />{micOn && <i />}
          </button>
        </div>

        <div className="ov-acts" onMouseDown={e => e.stopPropagation()}>
          <button className="ov-act" onClick={e => onRespond(e.shiftKey ? "user" : "interviewer")}
                  title="Answer what they said (R). Shift+R, or Shift-click, answers what you said.">
            {loading ? <Loader2 size={12} className="spin" /> : null}
            Answer <kbd>R</kbd>
          </button>
          <button className="ov-act" onClick={onScreenshot} title="Capture the screen and ask about it">
            Screenshot <kbd>C</kbd>
          </button>
          <button className="ov-act" onClick={onChat} title="Show or hide the chat under the overlay (T)">
            Chat <kbd>T</kbd>
          </button>
        </div>

        <div className="ov-tools" onMouseDown={e => e.stopPropagation()}>
          {stats?.answering && (
            <span className={`ov-timer ${timerState}`} title="How long you have been answering">
              {clock(timer)}
            </span>
          )}
          <span className="ov-tool ov-drag" title="Drag to move" onMouseDown={startDrag}><Move size={13} /></span>
          {onCamera && (
            <button className="ov-tool" onClick={onCamera}
                    title="Dock under your camera, so reading looks like eye contact (E)">
              <Camera size={13} />
            </button>
          )}
          <button className="ov-tool" onClick={onExpand} title="Back to the full view · O moves on to the strip under the camera">
            <Minimize2 size={13} />
          </button>
          <button className="ov-end" onClick={onEnd} title="End this session">End</button>
        </div>
      </div>

      {/* ── What has just been heard ────────────────────────────────── */}
      <div className={`ov-strip ${interrupted ? "cut-in" : ""}`}>
        {micOn || sysOn ? (
          <span className="ov-meters">
            {micOn && <LevelMeter label="You" which="mic" on={micOn} level={levels.mic} small />}
            {sysOn && <LevelMeter label={heardFromThem ? heardLabel : "Them"} which="system" on={sysOn} level={levels.system} small />}
          </span>
        ) : (
          <AudioLines size={13} className={`ov-wave ${listening ? "on" : ""}`} />
        )}
        {interrupted && <span className="ov-cut">They’re talking — stop and listen</span>}
        <div className="ov-words" ref={wordsRef}>
          {theirWords.length ? (
            <>
              <span className="ov-who">{heardLabel}</span>
              {theirWords.map((w, i) => <span key={i}>{w}</span>)}
            </>
          ) : (
            <span className="ov-words-idle"
                  title={streaming ? undefined : "This transcriber writes a moment after each pause, not while you speak"}>
              {!listening ? "Not listening"
                : streaming ? "Listening…"
                : "Listening — words appear after each pause"}
            </span>
          )}
        </div>
        {theirWords.length > 0 && (
          <button className="ov-quiet" onClick={() => setCleared(true)} title="Clear what was heard">Clear</button>
        )}
      </div>

      {/* ── The answer, to be read out loud ─────────────────────────── */}
      {(current || loading) && !dismissed && (
        <div className="ov-answer">
          {current?.transcript && (
            <p className="ov-q" title={current.transcript}>
              <span className="ov-label">Asked</span> {current.transcript}
            </p>
          )}

          {cues.length > 0 && (
            <p className="ov-cues">
              {cues.map((c, i) => <span key={i}>{c}</span>)}
            </p>
          )}

          {words.length > 0 ? (
            <div className="ov-read" ref={bodyRef} style={{ fontSize: SIZES[size].px }}>
              {lines.map((line, r) => {
                const from = starts[r];
                const state = spoken >= from + line.length ? "was" : spoken >= from ? "now" : "next";
                return (
                  <p key={r} className={`ov-line ${state}`} ref={state === "now" ? lineRef : undefined}>
                    {line.map((w, i) => {
                      const at = from + i;
                      const say = tricky.get(plain(w));
                      // The space sits outside the word, so the mark under the
                      // next word to say stops where the word does.
                      return (
                        <span key={i}>
                          <span className={`ov-w${at < spoken ? " was" : ""}${at === spoken ? " here" : ""}${say ? " tricky" : ""}`}
                                title={say ? `${say.word} — ${say.sounds}${say.tip ? ` · ${say.tip}` : ""}` : undefined}
                                onClick={() => markAt(at)}>{w}</span>{" "}
                        </span>
                      );
                    })}
                  </p>
                );
              })}
            </div>
          ) : (
            <p className="ov-empty">{loading ? "Thinking…" : "Answers appear here when a question comes in."}</p>
          )}

          {pronounce.length > 0 && (
            <p className="ov-say">
              {pronounce.map(p => (
                <span key={p.word}><b>{p.word}</b> {p.sounds}</span>
              ))}
            </p>
          )}

          {/* ── How the reading is going, and the few controls that help ── */}
          <div className="ov-foot">
            <span className="ov-meter" aria-hidden>
              <i style={{ width: `${words.length ? (spoken / words.length) * 100 : 0}%` }} />
            </span>

            <span className={`ov-left ${done ? "done" : ""}`}>
              {!words.length ? ""
                : done ? "That's the answer — stop there"
                : following ? `${leftLabel} left · about ${secondsLeft(left, stats?.wpm ?? null)}s`
                : micOn ? `${leftLabel} · click a word to move the marker`
                : `${leftLabel} · turn your mic on (Y) to follow along`}
            </span>

            {spoken > 0 && (
              <button className="ov-quiet" onClick={() => markAt(0)} title="Back to the first word">
                <RotateCcw size={11} /> Start over
              </button>
            )}

            <div className="ov-foot-end">
              <button className="ov-quiet" title={`Text size — ${SIZES[size].label}`}
                      onClick={() => setSize(s => (s + 1) % SIZES.length)}>
                <Type size={12} /> {SIZES[size].label}
              </button>
              {short && full && (
                <button className="ov-quiet" onClick={() => setShowFull(v => !v)}
                        title={`${showFull ? "The short answer" : "The full answer"} (F)`}
                        aria-keyshortcuts="F">
                  {showFull ? <><ChevronUp size={11} /> Short · F</> : <><ChevronDown size={11} /> Full · F</>}
                </button>
              )}
              <span className="ov-sep" />
              <button className="ov-tool" disabled={!hasPrev}
                      onClick={() => setOffset(index - 1)} title="Previous answer">
                <ChevronLeft size={13} />
              </button>
              {answers.length > 1 && <span className="ov-count">{index + 1}/{answers.length}</span>}
              <button className="ov-tool" disabled={!hasNext}
                      onClick={() => setOffset(index + 1 >= answers.length - 1 ? -1 : index + 1)}
                      title="Next answer">
                <ChevronRight size={13} />
              </button>
              <span className="ov-sep" />
              <div className="ov-vote">
                <button className={voted === "up" ? "on" : ""} onClick={() => vote("up")}
                        title="This helped"><ThumbsUp size={12} /></button>
                <button className={voted === "down" ? "on" : ""} onClick={() => vote("down")}
                        title="This missed"><ThumbsDown size={12} /></button>
              </div>
              <button className="ov-tool" onClick={() => setDismissed(true)}
                      title="Hide this answer until the next one"><X size={13} /></button>
              <button className="ov-tool" onClick={onExpand} title="Open the full view">
                <Maximize2 size={13} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
