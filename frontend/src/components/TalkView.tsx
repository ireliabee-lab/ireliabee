import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleDashed, Copy, Loader2, RefreshCw, Scissors, Timer } from "lucide-react";
import toast from "react-hot-toast";
import { clock, talkApi, type Shortened, type TalkFeedback, type TalkScenario } from "../lib/talk";
import { OWN_ASSISTANT_COST, useOwnAssistant, relayIssueLine, useAssistantAuto } from "../lib/relay";
import { notifyError, toFriendly } from "../lib/errors";
import MicButton from "./notebook/MicButton";

type Part = "scenarios" | "impromptu" | "shorten";
const join = (prev: string, said: string) => (prev.trim() ? `${prev.trimEnd()} ${said}` : said);

/** A count-up timer that starts on the first word and shows the target. */
function useTimer(running: boolean) {
  const [s, setS] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setS(x => x + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  return [s, () => setS(0)] as const;
}

function Feedback({ fb }: { fb: TalkFeedback }) {
  const d = fb.delivery;
  return (
    <div className="talk-feedback" aria-live="polite">
      <p className="talk-score"><strong>{fb.score}</strong><span className="muted">/100</span>
        <span className="muted"> · clear {fb.clear}/100 · length: {fb.length}</span></p>
      <ul className="nbk-check-points">
        <li className={fb.bluf ? "got" : "missed"}>{fb.bluf ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />} Main point first</li>
        {fb.strengths.map((s, i) => <li key={i} className="got"><CheckCircle2 size={14} /> {s}</li>)}
      </ul>
      {fb.fixes.length > 0 && <><p className="talk-label">Try next time</p><ol className="talk-fixes">{fb.fixes.map((f, i) => <li key={i}>{f}</li>)}</ol></>}
      {fb.better && <><p className="talk-label">A stronger version</p><blockquote className="talk-better">{fb.better}</blockquote></>}
      <p className="muted talk-delivery">{d.words} words · {d.fillers} filler {d.fillers === 1 ? "word" : "words"} · {d.hedges} {d.hedges === 1 ? "hedge" : "hedges"}
        {d.examples.length > 0 && <> ({d.examples.join(", ")})</>}</p>
    </div>
  );
}

/** One answer: the situation, a timer, type or speak, then feedback. */
function Answer({ drill, topic, prompt, target }: { drill: string; topic?: string; prompt: React.ReactNode; target: number }) {
  const [answer, setAnswer] = useState("");
  const [fb, setFb] = useState<TalkFeedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [relayIssue, setRelayIssue] = useState<string | null>(null);
  const relayAuto = useAssistantAuto(relayIssue);
  const [started, setStarted] = useState(false);
  const [secs, resetSecs] = useTimer(started && !fb);
  const took = useRef(0);
  useEffect(() => { setAnswer(""); setFb(null); setStarted(false); resetSecs(); }, [drill, topic]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function send(fallbackCredits = false) {
    setBusy(true); setRelayIssue(null); took.current = secs;
    try {
      setFb(await talkApi.score({ drill, answer, topic, seconds: secs || undefined, fallback_credits: fallbackCredits }));
    } catch (e) {
      const code = toFriendly(e).code;
      if (code === "relay_not_listening" || code === "relay_timeout") setRelayIssue(code); else notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass-card talk-card">
      {prompt}
      <div className="talk-timer" aria-live="off"><Timer size={13} /> {clock(fb ? took.current : secs)} <span className="muted">/ aim for {clock(target)}</span></div>
      {!fb ? (
        <>
          <textarea id={`talk-${drill}`} className="nb-input" rows={5} maxLength={4000} value={answer} disabled={busy}
            placeholder="Say it as you would out loud. Main point first…" aria-label="Your answer"
            onChange={e => { setAnswer(e.target.value); if (!started) setStarted(true); }} />
          <div className="nbk-explain-actions">
            <MicButton disabled={busy} onText={said => { setStarted(true); setAnswer(a => join(a, said)); }} />
            <button type="button" className="nbk-pill" disabled={busy || answer.trim().split(/\s+/).length < 4} onClick={() => void send(false)}>
              {busy ? <><Loader2 size={13} className="spin" /> Listening back…</> : "How did I do?"}</button>
          </div>
          {relayIssue && (
            <div className="mm-actions">
              <p className="muted">{relayIssueLine(relayIssue, relayAuto)}</p>
              <button type="button" className="nbk-pill" onClick={() => void send(false)}>Try again</button>
              <button type="button" className="btn-neutral" onClick={() => void send(true)}>Use credits instead</button>
            </div>
          )}
        </>
      ) : (
        <>
          <Feedback fb={fb} />
          <div className="nbk-explain-actions">
            <button type="button" className="nbk-pill" onClick={() => { setFb(null); setAnswer(""); setStarted(false); resetSecs(); }}>Try it again</button>
          </div>
        </>
      )}
    </div>
  );
}

function Shorten() {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"chat" | "email">("chat");
  const [out, setOut] = useState<Shortened | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    try { setOut(await talkApi.shorten({ text, kind })); } catch (e) { notifyError(e); } finally { setBusy(false); }
  }
  return (
    <div className="glass-card talk-card">
      <p className="talk-situation">Paste a message you're about to send. You get it about half as long, with what you need first. Every fact is kept.</p>
      <div className="nbk-depth" role="radiogroup" aria-label="What kind of message">
        {(["chat", "email"] as const).map(k => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>{k === "chat" ? "Chat message" : "Email"}</button>
        ))}
      </div>
      <textarea id="talk-shorten" className="nb-input" rows={6} maxLength={6000} value={text} disabled={busy}
        placeholder="Hi, sorry to bother you, I just wanted to let you know…" aria-label="Your message" onChange={e => { setText(e.target.value); setOut(null); }} />
      <div className="nbk-explain-actions">
        <button type="button" className="nbk-pill" disabled={busy || text.trim().split(/\s+/).length < 12} onClick={() => void go()}>
          {busy ? <><Loader2 size={13} className="spin" /> Shortening…</> : <><Scissors size={13} /> Write it shorter</>}</button>
      </div>
      {out && (
        <div className="talk-feedback" aria-live="polite">
          <p className="talk-score"><strong>{out.saved_percent}%</strong><span className="muted"> shorter · {out.words_before} → {out.words_after} words</span></p>
          <blockquote className="talk-better">{out.shorter}</blockquote>
          {out.cut.length > 0 && <><p className="talk-label">What went</p><ul className="talk-fixes">{out.cut.map((c, i) => <li key={i}>{c}</li>)}</ul></>}
          <div className="nbk-explain-actions">
            <button type="button" className="nbk-pill" onClick={() => { void navigator.clipboard.writeText(out.shorter).then(() => toast.success("Copied")); }}>
              <Copy size={13} /> Copy</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Talk at work (Practice; Study mode S4): everyday work talk, judged for the
 * listener. Real situations (a stand-up, pushing back, bad news, asking for
 * help, "I don't know"), a 60-second talk on today's topic, and Write it
 * shorter for a message about to be sent. Type or speak every answer.
 */
export default function TalkView() {
  const ownAssistant = useOwnAssistant();
  const [part, setPart] = useState<Part>("scenarios");
  const [data, setData] = useState<{ scenarios: TalkScenario[]; topic: string; impromptu_seconds: number } | null>(null);
  const [pick, setPick] = useState("standup");
  const [skip, setSkip] = useState(0);
  useEffect(() => { talkApi.drills(skip).then(setData).catch(notifyError); }, [skip]);
  const sc = data?.scenarios.find(s => s.id === pick) ?? data?.scenarios[0];

  return (
    <div className="page-content talk-view">
      <div className="nbk-depth talk-parts" role="radiogroup" aria-label="Kind of drill">
        {([["scenarios", "Situations"], ["impromptu", "60-second talk"], ["shorten", "Write it shorter"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="radio" aria-checked={part === id} onClick={() => setPart(id)}>{label}</button>
        ))}
      </div>

      {!data && <p className="muted"><Loader2 size={14} className="spin" /> Loading…</p>}

      {data && part === "scenarios" && sc && (
        <>
          <div className="talk-chips" role="radiogroup" aria-label="Situation">
            {data.scenarios.map(s => (
              <button key={s.id} type="button" role="radio" aria-checked={s.id === sc.id} className="talk-chip" onClick={() => setPick(s.id)}>{s.kind}</button>
            ))}
          </div>
          <Answer drill={sc.id} target={sc.seconds} prompt={<>
            <p className="talk-situation"><strong>{sc.kind}.</strong> {sc.brief}</p>
            <p className="muted">Listening: {sc.listener}.</p>
          </>} />
        </>
      )}

      {data && part === "impromptu" && (
        <Answer drill="impromptu" topic={data.topic} target={data.impromptu_seconds} prompt={<>
          <p className="talk-situation"><strong>Today's topic:</strong> {data.topic}</p>
          <p className="muted">One clear point, two or three reasons or examples, and a closing line. Start talking: the timer starts with your first word.
            {" "}<button type="button" className="btn-link" onClick={() => setSkip(n => n + 1)}><RefreshCw size={11} /> Another topic</button></p>
        </>} />
      )}

      {part === "shorten" && <Shorten />}

      <p className="muted nbk-explain-cost">{ownAssistant ? `${OWN_ASSISTANT_COST}.` : "Each piece of feedback uses a few credits. Speaking uses transcription, like any practice answer."}</p>
    </div>
  );
}
