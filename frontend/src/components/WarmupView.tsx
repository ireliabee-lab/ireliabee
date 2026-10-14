import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, RotateCw, SkipForward, Wind, Gauge, Mic2, Volume2, MessageCircle } from "lucide-react";
import { track } from "../lib/usage";

interface Step { title: string; seconds: number; icon: JSX.Element; how: string; prompt?: string; }

const TONGUE_TWISTERS = [
  "Red lorry, yellow lorry, red lorry, yellow lorry.",
  "She sells seashells by the seashore.",
  "A proper copper coffee pot.",
  "Unique New York, unique New York.",
  "Six slippery snails slid slowly seaward.",
];
const PACE_LINES = [
  "I want to make one clear point today, and I'll back it up with a single example.",
  "Thank you for your time — here's what I'd like us to decide by the end of this call.",
  "The short version is this: we tried it, it worked, and here's what I learned.",
];
const QUICK_PROMPTS = [
  "In one sentence, what do you do?",
  "Tell me about something you built that you're proud of.",
  "Why should we pick you?",
  "What's a problem you'd love to spend a year solving?",
  "Describe your work to someone who isn't technical.",
];

const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

function buildSteps(): Step[] {
  return [
    { title: "Breathe", seconds: 20, icon: <Wind size={16} />, how: "In for 4, out for 6. Drop your shoulders. Unclench your jaw." },
    { title: "Steady pace", seconds: 30, icon: <Gauge size={16} />, how: "Read this aloud, slowly and evenly. Pause at each comma.", prompt: pick(PACE_LINES) },
    { title: "Articulate", seconds: 30, icon: <Mic2 size={16} />, how: "Say it three times, a little faster each round. Over-pronounce.", prompt: pick(TONGUE_TWISTERS) },
    { title: "Project", seconds: 20, icon: <Volume2 size={16} />, how: "Hum, then say \"one, two, three\" as if reaching the back of a room." },
    { title: "Warm answer", seconds: 40, icon: <MessageCircle size={16} />, how: "Answer aloud in about 30 seconds. Lead with your point.", prompt: pick(QUICK_PROMPTS) },
  ];
}

export default function WarmupView() {
  const [steps, setSteps] = useState<Step[]>(buildSteps);
  const [idx, setIdx] = useState(0);
  const [left, setLeft] = useState(steps[0].seconds);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);

  const total = steps.reduce((s, x) => s + x.seconds, 0);

  const stop = useCallback(() => { if (timer.current) { clearInterval(timer.current); timer.current = null; } }, []);

  useEffect(() => {
    if (!running) { stop(); return; }
    timer.current = window.setInterval(() => {
      setLeft(l => {
        if (l > 1) return l - 1;
        setIdx(i => {
          if (i + 1 < steps.length) { setLeft(steps[i + 1].seconds); return i + 1; }
          setRunning(false); setDone(true); track("practice.warmup.done"); return i;
        });
        return 0;
      });
    }, 1000);
    return stop;
  }, [running, steps, stop]);

  function reset() {
    stop(); const fresh = buildSteps();
    setSteps(fresh); setIdx(0); setLeft(fresh[0].seconds); setRunning(false); setDone(false);
  }
  function skip() {
    if (idx + 1 < steps.length) { setIdx(idx + 1); setLeft(steps[idx + 1].seconds); }
    else { setRunning(false); setDone(true); track("practice.warmup.done"); }
  }

  const step = steps[idx];
  const stepPct = Math.round(((step.seconds - left) / step.seconds) * 100);

  return (
    <div className="plans-page">
      <div className="plans-header">
        <div>
          <h2>Warm-up</h2>
          <p className="muted">A two-minute routine to loosen up your voice and pacing before you speak.</p>
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{Math.round(total / 60)} min · {steps.length} steps</span>
      </div>

      <div className="page-split">
      <section className="glass-card warmup-card">
        {done ? (
          <div className="warmup-done">
            <div className="plans-empty-title">Warmed up. Go get it.</div>
            <p className="muted">Your voice is ready. Jump into a live session or a practice round.</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
              <button className="btn-primary" onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "session" }))}>Live Companion</button>
              <button className="btn-neutral" onClick={() => window.dispatchEvent(new CustomEvent("practice-mode", { detail: "mock" }))}>Practice round</button>
              <button className="btn-neutral" onClick={reset}><RotateCw size={14} /> Again</button>
            </div>
          </div>
        ) : (
          <>
            <div className="warmup-step-head">
              <span className="warmup-step-icon">{step.icon}</span>
              <div>
                <div className="plan-section-title">{step.title}</div>
                <div className="muted" style={{ fontSize: 12 }}>Step {idx + 1} of {steps.length}</div>
              </div>
              <div className="warmup-clock">{left}s</div>
            </div>
            <div className="confidence-bar" style={{ margin: "12px 0" }}><span className="good" style={{ width: `${stepPct}%` }} /></div>
            <p className="warmup-how">{step.how}</p>
            {step.prompt && <blockquote className="warmup-prompt">{step.prompt}</blockquote>}
            <div className="warmup-controls">
              <button className="btn-primary" onClick={() => setRunning(r => !r)}>
                {running ? <><Pause size={14} /> Pause</> : <><Play size={14} /> {left < step.seconds || idx > 0 ? "Resume" : "Start"}</>}
              </button>
              <button className="btn-neutral" onClick={skip}><SkipForward size={14} /> Next</button>
              <button className="btn-neutral" onClick={reset}><RotateCw size={14} /> Reset</button>
            </div>
          </>
        )}
      </section>

      <aside className="page-side">
        <section className="glass-card warmup-steps">
          <div className="plan-section-title">The routine</div>
          <ol>
            {steps.map((s, i) => (
              <li key={s.title} className={done || i < idx ? "done" : i === idx ? "current" : ""}>
                <span className="warmup-step-icon">{s.icon}</span>
                <span><strong>{s.title}</strong><small>{s.seconds}s</small></span>
              </li>
            ))}
          </ol>
        </section>
      </aside>
      </div>
    </div>
  );
}
