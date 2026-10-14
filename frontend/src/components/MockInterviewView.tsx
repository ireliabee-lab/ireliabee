import { useEffect, useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { Play, ArrowRight, RotateCcw, Check, SkipForward, Phone, Keyboard } from "lucide-react";
import VoiceMockCall from "./VoiceMockCall";
import VoicePicker from "./VoicePicker";
import GlassSelect from "./GlassSelect";
import FilePicker from "./FilePicker";
import { RESPONSE_TONES } from "./PreferencesModal";
import { fetchApi } from "../lib/api";
import { ensureReady, errorFromResponse, notifyError } from "../lib/errors";
import { AiSuggest, SuggestLabel } from "./Suggested";
import { withSuggestion } from "../lib/suggestApi";
import { SCENARIOS, SCENARIO_GROUPS, getScenario, isExam } from "../lib/scenarios";
import ExamBands, { TaskTimer, ieltsRound, formatOverall, type ExamMeta, type ExamScore } from "./ExamBands";
import { track } from "../lib/usage";
import { LANGUAGE_OPTIONS, isEnglish } from "../lib/languages";
import { defaultPracticeScenario, getPersona } from "../lib/persona";

interface Question { question: string; type: string; looking_for: string; part?: string; prep_seconds?: number; speak_seconds?: number; }
interface Feedback {
  score: number;
  verdict: string;
  strengths: string[];
  improvements: string[];
  better_answer: string;
  phrasing?: { said: string; better: string; why: string }[];
  exam?: ExamScore;
}
interface Result { question: string; answer: string; feedback: Feedback | null; }

type Phase = "setup" | "starting" | "answering" | "scoring" | "feedback" | "summary" | "voice";

const FOCUS = [
  { id: "mixed",      label: "Mixed — like a real interview" },
  { id: "behavioral", label: "Behavioral — past experiences" },
  { id: "technical",  label: "Technical — skills and tools" },
];
const COUNTS = [3, 5, 8, 10].map(n => ({ id: String(n), label: `${n} questions` }));

function scoreColor(score: number) {
  if (score >= 8) return "var(--success)";
  if (score >= 5) return "var(--warning)";
  return "var(--danger)";
}

async function postJson(path: string, body: unknown) {
  const res = await fetchApi(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

/** Working professionals see Work first; everyone else starts with interviews, applications and tests. */
function scenarioGroups() {
  return getPersona() === "professional"
    ? [...SCENARIO_GROUPS].sort((a, b) => (a.id === "work" ? -1 : b.id === "work" ? 1 : 0))
    : SCENARIO_GROUPS;
}

/** What another screen fills in before sending someone here (Research Track's practice panel). */
export interface MockPreset { scenario: string; subject?: string; details?: string; documentIds?: number[]; tone?: "basic" | "advanced" }
const PRESET_KEY = "mockPreset";

/** Open Practice → Mock conversation with a scenario and its fields already filled in. */
export function openMockWith(preset: MockPreset) {
  try { sessionStorage.setItem(PRESET_KEY, JSON.stringify(preset)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("navigate", { detail: "mock" }));
}

function takePreset(): MockPreset | null {
  try {
    const raw = sessionStorage.getItem(PRESET_KEY);
    sessionStorage.removeItem(PRESET_KEY);
    const p = raw ? JSON.parse(raw) : null;
    return p && typeof p.scenario === "string" ? p : null;
  } catch { return null; }
}

export default function MockInterviewView() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [role, setRole] = useState("");
  const [focus, setFocus] = useState("mixed");
  const [scenarioId, setScenarioId] = useState(() => localStorage.getItem("mockScenario") || defaultPracticeScenario());
  const scenario = getScenario(scenarioId);
  const [count, setCount] = useState("5");
  const [tone, setTone] = useState("advanced");
  // A level handed over with the preset (Wordcraft) wins over the saved preference.
  const presetTone = useRef(false);
  const [language, setLanguage] = useState("en");
  const [jobDescription, setJobDescription] = useState("");
  // What the paid Suggest reads (lib/suggestApi.ts): the practice setup, nothing else.
  const practiceForm = () => ({ scenario: scenario.label, subject: role, details: jobDescription });
  const [plans, setPlans] = useState<any[]>([]);
  const [planId, setPlanId] = useState("");
  // Library files to practise from (roadmap 2.5); choosing a plan ticks its files.
  const [docIds, setDocIds] = useState<number[]>([]);
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<"voice" | "text">("voice");
  const [voice, setVoice] = useState(() => localStorage.getItem("mockVoice") || "hannah");
  const [voiceName, setVoiceName] = useState("Hannah");
  const [headphones, setHeadphones] = useState(false);

  const [sessionId, setSessionId] = useState<number | null>(null);
  const [exam, setExam] = useState<ExamMeta | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [idx, setIdx] = useState(0);
  const [answer, setAnswer] = useState("");
  const [results, setResults] = useState<Result[]>([]);

  // Sent here from another screen with the scenario already chosen.
  useEffect(() => {
    const p = takePreset();
    if (!p) return;
    setScenarioId(p.scenario);
    try { localStorage.setItem("mockScenario", p.scenario); } catch { /* ignore */ }
    if (p.subject) setRole(p.subject);
    if (p.details) setJobDescription(p.details);
    if (p.documentIds?.length) setDocIds(p.documentIds);
    if (p.tone) { presetTone.current = true; setTone(p.tone); }
  }, []);

  useEffect(() => {
    fetchApi("/config").then(r => r.json()).then(cfg => {
      if (cfg?.saved?.model) setModel(cfg.saved.model);
      if (cfg?.saved?.response_tone && !presetTone.current) setTone(cfg.saved.response_tone);
      if (cfg?.saved?.language) setLanguage(cfg.saved.language);
    }).catch(() => {});
    fetchApi("/plans/").then(r => r.ok ? r.json() : []).then(setPlans).catch(() => {});
    fetchApi("/profiles/").then(r => r.json()).then((rows: any[]) => {
      const active = rows.find(p => p.is_active);
      if (active?.target_role && (localStorage.getItem("mockScenario") || defaultPracticeScenario()) === "job") setRole(r => r || active.target_role);
    }).catch(() => {});
  }, []);

  function choosePlan(id: string) {
    setPlanId(id);
    const plan = plans.find(p => String(p.id) === id);
    if (!plan) return;
    setDocIds(ids => Array.from(new Set([...ids, ...(plan.document_ids ?? [])])));
    setRole(plan.title.replace(/\s+interview$/i, ""));
    // The interviewer prompt takes free text; give it the plan's substance.
    const parts = [
      plan.counterparty && `Company: ${plan.counterparty}`,
      plan.purpose && `Candidate's goal: ${plan.purpose}`,
      plan.notes && `Requirements:\n${plan.notes}`,
      plan.sections?.length && `Interview agenda:\n${plan.sections.map((s: any) => `- ${s.title}${s.goal ? `: ${s.goal}` : ""}`).join("\n")}`,
      plan.answers_prep?.length && `Likely questions:\n${plan.answers_prep.map((a: string) => `- ${a.split("→")[0].trim()}`).join("\n")}`,
    ].filter(Boolean);
    setJobDescription(parts.join("\n\n"));
  }

  async function start() {
    if (!(await ensureReady(mode === "voice" ? ["voice", "llm"] : ["llm"]))) return;
    track(`practice.mock.${mode}`);
    if (mode === "voice") { setPhase("voice"); return; }
    setPhase("starting");
    try {
      const data = await postJson("/mock/start", {
        model, focus, count: Number(count), scenario: scenario.id,
        role: role.trim() || undefined,
        job_description: jobDescription.trim() || undefined,
        document_ids: docIds.length ? docIds : undefined,
        language,
      });
      setSessionId(data.session_id);
      setQuestions(data.questions);
      setExam(data.exam ?? null);
      if (!role.trim()) setRole(data.role);
      setIdx(0);
      setResults([]);
      setAnswer("");
      setPhase("answering");
    } catch (e: any) {
      notifyError(e);
      setPhase("setup");
    }
  }

  async function submitAnswer() {
    const q = questions[idx];
    if (!answer.trim() || !q || sessionId == null) return;
    setPhase("scoring");
    try {
      const fb: Feedback = await postJson("/mock/answer", {
        session_id: sessionId, model, question: q.question, looking_for: q.looking_for, part: q.part,
        answer, response_tone: tone,
        document_ids: docIds.length ? docIds : undefined,
      });
      setResults(r => [...r, { question: q.question, answer, feedback: fb }]);
      setPhase("feedback");
    } catch (e: any) {
      notifyError(e);
      setPhase("answering");
    }
  }

  function skip() {
    const q = questions[idx];
    setResults(r => [...r, { question: q.question, answer: "", feedback: null }]);
    advance();
  }

  function advance() {
    setAnswer("");
    if (idx + 1 < questions.length) {
      setIdx(i => i + 1);
      setPhase("answering");
    } else {
      finish();
    }
  }

  async function finish() {
    setPhase("summary");
    if (sessionId != null) {
      fetchApi(`/sessions/${sessionId}/end`, { method: "POST" }).catch(() => {});
    }
  }

  function restart() {
    setPhase("setup");
    setSessionId(null);
    setQuestions([]);
    setResults([]);
    setIdx(0);
    setAnswer("");
  }

  const q = questions[idx];
  const current = results[results.length - 1]?.feedback;
  const scored = results.filter(r => r.feedback);
  const average = scored.length
    ? Math.round((scored.reduce((s, r) => s + (r.feedback?.score ?? 0), 0) / scored.length) * 10) / 10
    : 0;

  function examAverage(meta: ExamMeta, scores: (ExamScore | undefined)[]) {
    const vals = scores.map(s => s?.overall).filter((v): v is number => v != null);
    if (!vals.length) return "—";
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return formatOverall(meta, meta.scale === "band" ? ieltsRound(mean) : Math.round(mean * 10) / 10,
      meta.scale === "band" ? null : Math.round((mean / meta.max) * 30));
  }

  if (phase === "voice") {
    return (
      <VoiceMockCall
        config={{
          role: role.trim(), focus, count: Number(count), jobDescription: jobDescription.trim(),
          voice, voiceName, headphones, model, tone, scenario: scenario.id, documentIds: docIds,
        }}
        onExit={restart}
      />
    );
  }

  return (
    <div className="page-content">
        <div className="plans-header">
          <div>
            <h2>Mock conversation</h2>
            <p className="muted">
              Practise interviews, thesis defences, scholarship panels, salary talks and meetings. Every answer gets a score, feedback and a stronger version.
            </p>
          </div>
        </div>

        {(phase === "setup" || phase === "starting") && (
          <div className="page-split mock-setup">
          <div className="glass-card mock-setup-card">
            <div>
              <label className="settings-label">Practise for</label>
              {scenarioGroups().map(g => (
              <div key={g.id} className="scenario-group">
              <div className="scenario-group-label">{g.label}</div>
              <div className="scenario-picker">
                {SCENARIOS.filter(sc => sc.group === g.id).map(sc => (
                  <button
                    key={sc.id}
                    className={`scenario-option ${scenario.id === sc.id ? "active" : ""}`}
                    onClick={() => {
                      if (sc.id !== scenario.id) { setRole(""); setJobDescription(""); setPlanId(""); }
                      setScenarioId(sc.id);
                      try { localStorage.setItem("mockScenario", sc.id); } catch { /* ignore */ }
                    }}
                  >
                    <strong>{sc.label}</strong>
                    <small>{sc.hint}</small>
                  </button>
                ))}
              </div>
              </div>
              ))}
            </div>
            <div className="mode-picker">
              <button className={`mode-option ${mode === "voice" ? "active" : ""}`} onClick={() => setMode("voice")}>
                <Phone size={18} />
                <span><strong>Voice call</strong><small>Talk it through out loud, like a real call</small></span>
              </button>
              <button className={`mode-option ${mode === "text" ? "active" : ""}`} onClick={() => setMode("text")}>
                <Keyboard size={18} />
                <span><strong>Type answers</strong><small>Answer in writing, feedback after each one</small></span>
              </button>
            </div>
            <div>
              {plans.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <label className="settings-label">Practise for a plan (optional)</label>
                  <GlassSelect
                    options={[{ id: "", label: "— No plan —" }, ...plans.map(p => ({ id: String(p.id), label: p.title }))]}
                    value={planId}
                    onChange={choosePlan}
                    style={{ width: "100%" }}
                  />
                </div>
              )}
              <SuggestLabel label={scenario.subjectLabel}>
                <AiSuggest<string> field="practice.subject" label={scenario.subjectLabel} value={role} form={practiceForm}
                  onSuggest={text => setRole(r => (r.trim() ? r : text))} />
              </SuggestLabel>
              <input className="glass-input" value={role} onChange={e => setRole(e.target.value)} placeholder={scenario.subjectPlaceholder} />
            </div>
            <div>
              <SuggestLabel label={scenario.detailsLabel}>
                <AiSuggest<string> field="practice.details" label={scenario.detailsLabel} length="long" form={practiceForm}
                  onSuggest={text => setJobDescription(d => withSuggestion(d, text))} />
              </SuggestLabel>
              <textarea
                className="glass-input" rows={6} value={jobDescription}
                onChange={e => setJobDescription(e.target.value)}
                placeholder={scenario.detailsPlaceholder}
                style={{ resize: "vertical" }}
              />
            </div>
            <div>
              <label className="settings-label">Files to practise from (optional)</label>
              <FilePicker value={docIds} onChange={setDocIds}
                emptyHint="Add a job spec, lecture slides or notes to your Library and questions will be built from them." />
            </div>
          </div>

          <aside className="page-side">
          <div className="glass-card mock-setup-card">
            <div className="mock-options">
              {(scenario.id === "presentation" || scenario.id === "speaking") && (
                <button type="button" className="practice-crosslink"
                  onClick={() => window.dispatchEvent(new CustomEvent("practice-mode", { detail: "script" }))}>
                  Have a script or slide notes? Check timing and clarity first →
                </button>
              )}
              {scenario.id === "job" && (
                <div style={{ flex: "1 1 220px" }}>
                  <label className="settings-label">Focus</label>
                  <GlassSelect options={FOCUS} value={focus} onChange={setFocus} style={{ width: "100%" }} />
                </div>
              )}
              {!isExam(scenario.id) && (
              <div style={{ flex: "1 1 140px" }}>
                <label className="settings-label">Length</label>
                <GlassSelect options={COUNTS} value={count} onChange={setCount} style={{ width: "100%" }} />
              </div>
              )}
              {isExam(scenario.id) && (
                <p className="muted exam-setup-note">A full practice test in the exam's own parts and timings, scored on its criteria. English support is always on for tests.</p>
              )}
              <div style={{ flex: "1 1 220px" }}>
                <label className="settings-label">Language level</label>
                <GlassSelect options={RESPONSE_TONES} value={tone} onChange={setTone} style={{ width: "100%" }} />
              </div>
              {mode === "text" && !isExam(scenario.id) && (
                <div style={{ flex: "1 1 220px" }}>
                  <label className="settings-label">Language</label>
                  <GlassSelect options={LANGUAGE_OPTIONS} value={language} onChange={setLanguage} style={{ width: "100%" }} />
                </div>
              )}
              {mode === "voice" && !isEnglish(language) && (
                <p className="muted exam-setup-note">Voice calls are in English for now — choose Type answers to practise in another language.</p>
              )}
            </div>
            {mode === "voice" && (
              <>
                <div className="mock-voice">
                  <label className="settings-label">{scenario.counterpart} voice · {voiceName}</label>
                  <VoicePicker
                    value={voice}
                    onChange={v => {
                      setVoice(v.id);
                      setVoiceName(v.name);
                      localStorage.setItem("mockVoice", v.id);
                    }}
                  />
                </div>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--text)", cursor: "pointer" }}>
                  <input type="checkbox" checked={headphones} onChange={e => setHeadphones(e.target.checked)} />
                  I'm wearing headphones — let me interrupt the {scenario.counterpart.toLowerCase()}
                </label>
              </>
            )}
            <button className="btn-primary mock-start" onClick={start} disabled={phase === "starting"}>
              {mode === "voice" ? <Phone size={14} /> : <Play size={14} />}
              {phase === "starting" ? "Preparing questions…" : mode === "voice" ? "Start call" : "Start interview"}
            </button>
          </div>
          </aside>
          </div>
        )}

        {(phase === "answering" || phase === "scoring") && q && (
          <div className="glass-card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--muted)" }}>
              <span style={{ fontWeight: 700, letterSpacing: "0.06em" }}>{q.part ? `${q.part.toUpperCase()} · ` : ""}{exam ? "TASK" : "QUESTION"} {idx + 1} OF {questions.length}</span>
              <span style={{
                padding: "1px 8px", borderRadius: 999, fontSize: 10, fontWeight: 600,
                background: "rgba(var(--accent-rgb),0.14)", color: "var(--primary-hover)", textTransform: "capitalize",
              }}>{exam ? exam.name : q.type}</span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 3 }}>
                {questions.map((_, i) => (
                  <span key={i} style={{
                    width: 18, height: 4, borderRadius: 2,
                    background: i < idx ? "var(--primary)" : i === idx ? "var(--primary-hover)" : "rgba(var(--ink-rgb),0.12)",
                  }} />
                ))}
              </div>
            </div>
            <div style={{ fontSize: 16, lineHeight: 1.55, color: "var(--text)", fontWeight: 500, whiteSpace: "pre-line" }}>{q.question}</div>
            {exam && q.speak_seconds ? <TaskTimer key={idx} prep={q.prep_seconds ?? 0} speak={q.speak_seconds} /> : null}
            <textarea
              className="glass-input" rows={7} value={answer} autoFocus
              onChange={e => setAnswer(e.target.value)}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitAnswer(); }}
              placeholder="Type your answer as you would say it… (Ctrl+Enter to submit)"
              style={{ resize: "vertical" }}
              disabled={phase === "scoring"}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn-neutral" onClick={skip} disabled={phase === "scoring"} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <SkipForward size={13} /> Skip
              </button>
              <button className="btn-primary" onClick={submitAnswer} disabled={phase === "scoring" || !answer.trim()}>
                {phase === "scoring" ? "Scoring…" : <>Submit answer <Check size={14} /></>}
              </button>
            </div>
          </div>
        )}

        {phase === "feedback" && current && (
          <div className="glass-card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            {exam && current.exam ? (
              <>
                <ExamBands meta={exam} score={current.exam} />
                <div style={{ fontSize: 14, lineHeight: 1.5, color: "var(--text)" }}>{current.verdict}</div>
              </>
            ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{
                width: 58, height: 58, borderRadius: "50%", flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                border: `3px solid ${scoreColor(current.score)}`, color: scoreColor(current.score),
                fontSize: 18, fontWeight: 700,
              }}>{current.score}<span style={{ fontSize: 10, opacity: 0.7 }}>/10</span></div>
              <div style={{ fontSize: 14, lineHeight: 1.5, color: "var(--text)" }}>{current.verdict}</div>
            </div>
            )}
            <div className="mock-feedback-cols">
            <div className="mock-feedback-col">
            <FeedbackList title="What worked" color="var(--success)" items={current.strengths} />
            <FeedbackList title="Improve" color="var(--warning)" items={current.improvements} />
            {current.phrasing && current.phrasing.length > 0 && (
              <div className="phrasing-fixes">
                <div className="say-version-label">Say it more naturally</div>
                {current.phrasing.map((p, i) => (
                  <div key={i} className="phrasing-fix">
                    <span className="phrasing-said">{p.said}</span>
                    <span className="phrasing-better">{p.better}</span>
                    {p.why && <small>{p.why}</small>}
                  </div>
                ))}
              </div>
            )}
            </div>
            <div className="mock-feedback-col">
              <div className="coach-section-label say">Stronger answer</div>
              <div className="coach-section-body markdown-body"><ReactMarkdown>{current.better_answer}</ReactMarkdown></div>
            </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn-primary" onClick={advance}>
                {idx + 1 < questions.length ? <>Next question <ArrowRight size={14} /></> : <>See results <ArrowRight size={14} /></>}
              </button>
            </div>
          </div>
        )}

        {phase === "summary" && (
          <div className="glass-card" style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <span style={{ fontSize: 32, fontWeight: 700, color: scored.length ? scoreColor(average) : "var(--muted)" }}>
                {!scored.length ? "–" : exam ? examAverage(exam, scored.map(r => r.feedback!.exam)) : average}
              </span>
              <span className="muted" style={{ fontSize: 13 }}>
                {exam ? "estimated overall" : "average"} across {scored.length} answered {exam ? "task" : "question"}{scored.length === 1 ? "" : "s"}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {results.map((r, i) => (
                <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13 }}>
                  <span style={{
                    minWidth: 34, textAlign: "center", fontWeight: 700,
                    color: r.feedback ? scoreColor(r.feedback.score) : "var(--muted)",
                  }}>{r.feedback ? `${r.feedback.score}/10` : "skip"}</span>
                  <span style={{ color: "var(--text)", lineHeight: 1.45 }}>{r.question}</span>
                </div>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 12 }}>Saved under Sessions → Mock.</p>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button className="btn-primary" onClick={restart}><RotateCcw size={14} /> Practise again</button>
            </div>
          </div>
        )}
    </div>
  );
}

function FeedbackList({ title, color, items }: { title: string; color: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="coach-section-label" style={{ color }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc", display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((s, i) => (
          <li key={i} style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text)" }}>
            <ReactMarkdown components={{ p: ({ children }) => <>{children}</> }}>{s}</ReactMarkdown>
          </li>
        ))}
      </ul>
    </div>
  );
}
