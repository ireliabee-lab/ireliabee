import { useCallback, useEffect, useRef, useState } from "react";
import { Timer, Gauge, MessageCircleWarning, PieChart } from "lucide-react";
import { fetchApi } from "./api";

type Who = "you" | "them";

// A short pause (breath, thinking) still belongs to the same answer.
const SAME_ANSWER_GAP_MS = 3500;
const WRAP_UP_SOFT_SEC = 60;
const WRAP_UP_HARD_SEC = 90;

// Same list as backend/confidence.py FILLERS (a test keeps them in sync), so the
// live counter, Progress and the Confidence score all count the same words.
const FILLERS = /\b(u+m+|u+h+|e+r+m*|a+h+|m*h+m+|you know|i mean|kind of|sort of|basically|literally|actually)\b/gi;

export function countFillers(text: string): number {
  return (text.match(FILLERS) || []).length;
}

export interface DeliveryStats {
  answerSec: number;          // current answer length (0 when not answering)
  answering: boolean;
  wpm: number | null;         // across all of your speech so far
  fillers: number;
  lastAnswerFillers: number;
  talkShare: number | null;   // your % of total talk time
}

export function useDeliveryTracker(enabled: boolean) {
  const since = useRef<Record<Who, number | null>>({ you: null, them: null });
  const talkMs = useRef<Record<Who, number>>({ you: 0, them: 0 });
  const answerStart = useRef<number | null>(null);
  const lastYouActivity = useRef(0);
  const words = useRef(0);
  const fillers = useRef(0);
  const answerFillers = useRef(0);
  const partialWords = useRef(0);
  const longAnswers = useRef(0);
  const longCounted = useRef(false);
  const [stats, setStats] = useState<DeliveryStats>({
    answerSec: 0, answering: false, wpm: null, fillers: 0, lastAnswerFillers: 0, talkShare: null,
  });

  const activity = useCallback((who: Who, active: boolean) => {
    const now = Date.now();
    if (active && since.current[who] == null) {
      since.current[who] = now;
      if (who === "you") {
        if (answerStart.current == null || now - lastYouActivity.current > SAME_ANSWER_GAP_MS) {
          answerStart.current = now;
          answerFillers.current = 0;
          longCounted.current = false;
        }
        lastYouActivity.current = now;
      } else {
        answerStart.current = null;   // the other side speaking ends your answer
      }
    } else if (!active && since.current[who] != null) {
      talkMs.current[who] += now - since.current[who]!;
      since.current[who] = null;
      if (who === "you") lastYouActivity.current = now;
    }
  }, []);

  const finalText = useCallback((who: Who, text: string) => {
    if (who !== "you") return;
    const n = countFillers(text);
    words.current += text.split(/\s+/).filter(Boolean).length;
    fillers.current += n;
    answerFillers.current += n;
    partialWords.current = 0;
  }, []);

  const partialText = useCallback((who: Who, text: string) => {
    if (who === "you") partialWords.current = text.split(/\s+/).filter(Boolean).length;
  }, []);

  const reset = useCallback(() => {
    since.current = { you: null, them: null };
    talkMs.current = { you: 0, them: 0 };
    answerStart.current = null;
    words.current = fillers.current = answerFillers.current = partialWords.current = longAnswers.current = 0;
  }, []);

  // Totals for the progress dashboard, read straight from the refs so they're current.
  const snapshot = useCallback((): DeliverySnapshot | null => {
    const now = Date.now();
    const liveMs = (who: Who) => talkMs.current[who] + (since.current[who] != null ? now - since.current[who]! : 0);
    const you = liveMs("you");
    const them = liveMs("them");
    const spoken = words.current + partialWords.current;
    if (spoken < 20 || you < 10_000) return null;
    return {
      words: spoken,
      speaking_sec: Math.round(you / 1000),
      wpm: Math.round(spoken / (you / 60_000)),
      fillers: fillers.current,
      filler_rate: Math.round((fillers.current / spoken) * 1000) / 10,
      talk_share: you + them > 0 && them > 0 ? Math.round((you / (you + them)) * 100) : null,
      long_answers: longAnswers.current,
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      const now = Date.now();
      const liveMs = (who: Who) => talkMs.current[who] + (since.current[who] != null ? now - since.current[who]! : 0);
      const you = liveMs("you");
      const them = liveMs("them");
      const answering = answerStart.current != null && (since.current.you != null || now - lastYouActivity.current < SAME_ANSWER_GAP_MS);
      if (!answering && since.current.you == null) answerStart.current = null;
      if (answering && !longCounted.current && now - answerStart.current! >= WRAP_UP_HARD_SEC * 1000) {
        longCounted.current = true;
        longAnswers.current += 1;
      }
      const spokenWords = words.current + partialWords.current;
      setStats({
        answering,
        answerSec: answering ? Math.round((now - answerStart.current!) / 1000) : 0,
        wpm: you > 15_000 && spokenWords > 0 ? Math.round(spokenWords / (you / 60_000)) : null,
        fillers: fillers.current,
        lastAnswerFillers: answerFillers.current,
        talkShare: you + them > 10_000 ? Math.round((you / (you + them)) * 100) : null,
      });
    }, 500);
    return () => clearInterval(id);
  }, [enabled]);

  return { stats, activity, finalText, partialText, reset, snapshot };
}

export interface DeliverySnapshot {
  words: number;
  speaking_sec: number;
  wpm: number;
  fillers: number;
  filler_rate: number;        // fillers per 100 words
  talk_share: number | null;
  long_answers: number;       // answers that ran past the wrap-up mark
}

export function saveDelivery(sessionId: number | null, snap: DeliverySnapshot | null) {
  if (sessionId == null || !snap) return;
  fetchApi(`/sessions/${sessionId}/delivery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snap),
  }).catch(() => {});
}

function clock(sec: number) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export function DeliveryBar({ stats }: { stats: DeliveryStats }) {
  const timerState = stats.answerSec >= WRAP_UP_HARD_SEC ? "hard" : stats.answerSec >= WRAP_UP_SOFT_SEC ? "soft" : "ok";
  const pace = stats.wpm == null ? null : stats.wpm > 170 ? "fast" : stats.wpm < 110 ? "slow" : "good";
  const share = stats.talkShare == null ? null : stats.talkShare > 70 ? "high" : "ok";

  return (
    <div className="delivery-bar">
      <div className={`delivery-item timer ${stats.answering ? timerState : "idle"}`} title="Length of your current answer">
        <Timer size={13} />
        <strong>{stats.answering ? clock(stats.answerSec) : "0:00"}</strong>
        <span>
          {!stats.answering ? "answer" : timerState === "hard" ? "Wrap up now" : timerState === "soft" ? "Start wrapping up" : "answer"}
        </span>
      </div>
      <div className={`delivery-item ${pace ?? "idle"}`} title="Words per minute — about 120–170 sounds natural">
        <Gauge size={13} />
        <strong>{stats.wpm ?? "—"}</strong>
        <span>{pace === "fast" ? "wpm · slow down" : pace === "slow" ? "wpm · a bit slow" : "wpm"}</span>
      </div>
      <div className={`delivery-item ${stats.lastAnswerFillers >= 4 ? "soft" : stats.fillers ? "ok" : "idle"}`} title="Filler words like um, uh, you know, basically">
        <MessageCircleWarning size={13} />
        <strong>{stats.fillers}</strong>
        <span>fillers</span>
      </div>
      <div className={`delivery-item ${share === "high" ? "soft" : share ? "ok" : "idle"}`} title="Your share of the total talking time">
        <PieChart size={13} />
        <strong>{stats.talkShare == null ? "—" : `${stats.talkShare}%`}</strong>
        <span>{share === "high" ? "talk share · let them speak" : "talk share"}</span>
      </div>
    </div>
  );
}
