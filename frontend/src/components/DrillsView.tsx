import { useEffect, useState } from "react";
import { ArrowLeft, Lightbulb, Loader2, RotateCcw, Send, Sparkles, CheckCircle2, FileText } from "lucide-react";
import { fetchApi } from "../lib/api";
import { useStickToBottom } from "../lib/useStickToBottom";
import { ensureReady, errorFromResponse, notifyError } from "../lib/errors";
import { AiSuggest } from "./Suggested";
import { track } from "../lib/usage";
import Illustration from "./Illustration";
import GlassSelect from "./GlassSelect";

interface Topic { title: string; why: string; }
/** Where a topic comes from (roadmap 2.2): a Library file, or null for the CV. */
interface Source { id: number; name: string; }
interface Exchange { role: "coach" | "you"; text: string; }
interface Check { understanding: number; feedback: string; gaps: string[]; }
interface Past { id: number; topic: string; score: number; rounds: number; solid: boolean; created_at: string; document_id?: number | null; source?: string; }

const SOURCE_KEY = "drillSource";

async function post(path: string, body: unknown) {
  const res = await fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

function meterState(n: number) {
  return n >= 80 ? "good" : n >= 50 ? "mid" : "low";
}

export default function DrillsView() {
  const [model, setModel] = useState("");
  const [tone, setTone] = useState<string | undefined>();
  const [topics, setTopics] = useState<Topic[]>([]);
  const [files, setFiles] = useState<Source[]>([]);
  // What to suggest topics from: "" = my CV, otherwise a Library file id.
  const [sourceId, setSourceId] = useState<string>(() => { try { return localStorage.getItem(SOURCE_KEY) ?? ""; } catch { return ""; } });
  const [topicsFrom, setTopicsFrom] = useState<Source | null>(null);
  const [drillFile, setDrillFile] = useState<Source | null>(null);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [custom, setCustom] = useState("");
  const [past, setPast] = useState<Past[]>([]);

  const [topic, setTopic] = useState<string | null>(null);
  const [history, setHistory] = useState<Exchange[]>([]);
  const [checks, setChecks] = useState<Record<number, Check>>({});
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState<{ score: number; solid: boolean; explanation: string | null } | null>(null);
  const scrollRef = useStickToBottom<HTMLDivElement>();

  useEffect(() => {
    fetchApi("/config").then(r => r.json()).then(cfg => {
      if (cfg?.saved?.model) setModel(cfg.saved.model);
      if (cfg?.saved?.response_tone) setTone(cfg.saved.response_tone);
    }).catch(() => {});
    loadPast();
    fetchApi("/documents/").then(r => (r.ok ? r.json() : [])).then((rows: Source[]) => {
      setFiles(rows.map(d => ({ id: d.id, name: d.name })));
      // A remembered file that has since been deleted falls back to the CV.
      setSourceId(s => (s && !rows.some(d => String(d.id) === s) ? "" : s));
    }).catch(() => {});
  }, []);

  const chosen = files.find(f => String(f.id) === sourceId) ?? null;
  function chooseSource(id: string) {
    setSourceId(id);
    setTopics([]);
    try { localStorage.setItem(SOURCE_KEY, id); } catch { /* ignore */ }
  }

  function loadPast() {
    fetchApi("/drills/history?limit=8").then(r => r.ok ? r.json() : []).then(setPast).catch(() => {});
  }

  async function suggest() {
    if (!(await ensureReady(["llm"]))) return;
    setLoadingTopics(true);
    try {
      const data = await post("/drills/topics", { model: model || null, document_id: chosen?.id ?? null });
      setTopics(data.topics);
      setTopicsFrom(chosen);
      if (!data.topics.length) notifyError({ message: chosen ? "No topics came out of that file — try another one." : "Add a CV or fill in your profile so topics can be suggested." });
    } catch (e) { notifyError(e); } finally { setLoadingTopics(false); }
  }

  async function start(title: string, file: Source | null) {
    if (!title.trim() || !(await ensureReady(["llm"]))) return;
    setTopic(title.trim());
    setDrillFile(file);
    setHistory([]); setChecks({}); setFinished(null); setAnswer("");
    setBusy(true);
    try {
      track(file ? "practice.drill.start.file" : "practice.drill.start");
      const data = await post("/drills/turn", { topic: title.trim(), history: [], answer: "", model: model || null, response_tone: tone, document_id: file?.id ?? null });
      setHistory([{ role: "coach", text: data.question }]);
    } catch (e) {
      notifyError(e);
      setTopic(null);
    } finally { setBusy(false); }
  }

  async function send() {
    const text = answer.trim();
    if (!text || busy || !topic) return;
    const answerIdx = history.length;
    setHistory(h => [...h, { role: "you", text }]);
    setAnswer("");
    setBusy(true);
    try {
      const data = await post("/drills/turn", { topic, history, answer: text, model: model || null, response_tone: tone, document_id: drillFile?.id ?? null });
      setChecks(c => ({ ...c, [answerIdx]: { understanding: data.understanding, feedback: data.feedback, gaps: data.gaps } }));
      if (data.done) {
        setFinished({ score: data.understanding, solid: data.solid, explanation: data.model_explanation });
        loadPast();
      } else {
        setHistory(h => [...h, { role: "coach", text: data.question }]);
      }
    } catch (e) {
      notifyError(e);
      setHistory(h => h.slice(0, answerIdx));   // let them resend the same answer
      setAnswer(text);
    } finally { setBusy(false); }
  }

  const latest = Object.entries(checks).sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1];

  if (topic) {
    return (
      <div className="plans-page">
        <div className="plans-header">
          <div>
            <button className="btn-neutral drill-back" onClick={() => setTopic(null)}><ArrowLeft size={13} /> Topics</button>
            <h2>{topic}</h2>
            <p className="muted">
              {drillFile
                ? <>Explain it in your own words. Checked against <span className="drill-source"><FileText size={11} /> {drillFile.name}</span> — the coach keeps digging until it's solid.</>
                : "Explain it like you would in the interview. The coach keeps digging until it's solid."}
            </p>
          </div>
          <div className={`drill-meter ${latest ? meterState(latest.understanding) : "idle"}`} title="How well you've explained it so far">
            <span>{latest ? `${latest.understanding}%` : "—"}</span>
            <div><i style={{ width: `${latest?.understanding ?? 0}%` }} /></div>
            <small>understanding</small>
          </div>
        </div>

        <div className="glass-card drill-chat" ref={scrollRef.ref}>
          {history.map((m, i) => (
            <div key={i} className={`turn-row ${m.role === "you" ? "align-right" : "align-left"}`}>
              <div className="turn-meta">
                <span className={`badge-name ${m.role === "you" ? "you" : "them"}`}>{m.role === "you" ? "You" : "Interviewer"}</span>
              </div>
              <div className={`transcript-bubble ${m.role === "you" ? "you" : "them"}`}>{m.text}</div>
              {checks[i] && (
                <div className={`drill-check ${meterState(checks[i].understanding)}`}>
                  <strong>{checks[i].understanding}%</strong> {checks[i].feedback}
                  {checks[i].gaps.length > 0 && !finished && (
                    <ul>{checks[i].gaps.map(g => <li key={g}>{g}</li>)}</ul>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="typing-dots" style={{ paddingLeft: 8 }}><span /><span /><span /></div>}

          {finished && (
            <div className={`drill-result ${finished.solid ? "good" : "mid"}`}>
              <div className="drill-result-head">
                {finished.solid ? <CheckCircle2 size={16} /> : <Lightbulb size={16} />}
                {finished.solid ? "Solid — you can explain this." : "Not quite there yet — worth another round."}
              </div>
              {finished.explanation && (
                <>
                  <div className="say-version-label">How you could say it</div>
                  <p>{finished.explanation}</p>
                </>
              )}
              <div className="drill-result-actions">
                <button className="btn-primary" onClick={() => start(topic, drillFile)}><RotateCcw size={13} /> Drill again</button>
                <button className="btn-neutral" onClick={() => setTopic(null)}>Pick another topic</button>
              </div>
            </div>
          )}
        </div>

        {!finished && (
          <div className="drill-composer">
            <textarea
              className="glass-input"
              value={answer}
              onChange={e => setAnswer(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Type your explanation… (Enter to send, Shift+Enter for a new line)"
              rows={3}
              disabled={busy || !history.length}
              autoFocus
            />
            <button className="btn-primary" onClick={send} disabled={busy || !answer.trim()}>
              {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="plans-page">
      <div className="plans-header">
        <div>
          <h2>Explain a topic</h2>
          <p className="muted">Pick something from your CV or any file in your Library — lecture slides, a spec, notes. The coach asks you to explain it and keeps probing until it would hold up in an interview, exam or meeting.</p>
        </div>
        <div className="drill-source-pick">
          <GlassSelect
            style={{ minWidth: 220 }}
            value={sourceId}
            onChange={chooseSource}
            options={[{ id: "", label: "From my CV" }, ...files.map(f => ({ id: String(f.id), label: `From: ${f.name}` }))]}
          />
          <button className="btn-primary" onClick={suggest} disabled={loadingTopics}>
            {loadingTopics ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Suggest topics
          </button>
        </div>
      </div>
      {files.length === 0 && (
        <p className="muted drill-files-hint">
          Studying or preparing from a document? Add it to your{" "}
          <button className="link-btn" onClick={() => window.dispatchEvent(new CustomEvent("navigate", { detail: "documents" }))}>Library</button>
          {" "}and pick it here — topics come from the file and your explanations are checked against it.
        </p>
      )}

      <form className="drill-custom" onSubmit={e => { e.preventDefault(); start(custom, chosen); }}>
        <input className="glass-input" value={custom} onChange={e => setCustom(e.target.value)}
          placeholder={chosen ? `Or type any topic from "${chosen.name}"` : "Or type any topic, e.g. React hooks, my capstone project, REST vs GraphQL"} />
        <AiSuggest<string> field="drill.topic" label="A topic to explain" value={custom}
          form={() => ({ file: chosen?.name ?? "", topic: custom })}
          onSuggest={text => setCustom(c => (c.trim() ? c : text))} />
        <button className="btn-primary" type="submit" disabled={!custom.trim()}>Start drill</button>
      </form>

      {topics.length > 0 && (
        <div className="plans-grid">
          {topics.map(t => (
            <article key={t.title} className="glass-card plan-card story-card" onClick={() => start(t.title, topicsFrom)}>
              <div className="plan-card-title">{t.title}</div>
              {t.why && <p className="plan-card-purpose">{t.why}</p>}
            </article>
          ))}
        </div>
      )}

      {topics.length === 0 && !loadingTopics && (
        <div className="glass-card plans-empty">
          <Illustration name="explain" />
          <div className="plans-empty-title">{chosen ? `Can you explain "${chosen.name}"?` : "Can you really explain what's on your CV?"}</div>
          <p className="muted">{chosen
            ? "Get topics from the file, then explain each one out loud. The file is the answer key — gaps and mistakes are pointed out until your explanation holds up."
            : "Interviewers dig into the things you list. Practise until you can explain each one clearly, with a real example and the \"why\"."}</p>
        </div>
      )}

      {past.length > 0 && (
        <div className="drill-past">
          <div className="say-version-label">Recent drills</div>
          {past.map(p => (
            <button key={p.id} className="drill-past-row" title="Drill this again"
              onClick={() => start(p.topic, p.document_id ? files.find(f => f.id === p.document_id) ?? null : null)}>
              <span>{p.topic}</span>
              {p.source && <span className="drill-source"><FileText size={11} /> {p.source}</span>}
              <span className={`drill-pill ${meterState(p.score)}`}>{p.score}%</span>
              <small>{new Date(p.created_at + "Z").toLocaleDateString()}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
