// Research Track: the ladder from newcomer to research scientist (backend/research_track.py).
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";
import { checkMilestones } from "./milestones";

export type Goal = "phd" | "first-paper" | "industry" | "curious";
export const GOALS: { id: Goal; label: string }[] = [
  { id: "phd", label: "Get into a PhD" },
  { id: "first-paper", label: "Publish a first paper" },
  { id: "industry", label: "Do research at work" },
  { id: "curious", label: "Learn how research works" },
];

export interface Track {
  field: string; goal: Goal; level: number; weekly_hours: number; brief: string;
  started_at: string; level_at: string;
  packs?: string; mentor_name?: string; mentor_email?: string;
}

export interface PackResource { title: string; by?: string; url: string; kind: string; level?: number; why?: string }
export interface Pack { id: string; name: string; description: string; terms: number; lessons: number; resources: PackResource[]; active: boolean }
export interface MeetingSession {
  id: number; title: string; created_at: string; words: number;
  terms: { term: string; count: number }[]; overclaims: { word: string; sentence: string }[]; hedges: number;
}
export interface MeetingReport { sessions: MeetingSession[]; distinct_terms: number; top_terms: { term: string; count: number }[] }
export interface SignOff { note: string; created_at: string; skills: string[] }

export interface Reading { title: string; by?: string; url: string }
export interface Lesson {
  id: string; title: string; minutes: number; pillar: string; why: string;
  read: Reading[]; do: string; speak: string; check?: string; terms: string[]; skills?: string[];
  done?: boolean; answer?: string;
}
export interface Rubric { id: string; criterion: string }
export interface Exit { title: string; description: string; persona: string; recall_threshold: number | null; rubric: Rubric[]; skills?: string[] }
export interface Level {
  id: number; name: string; weeks: string; goal: string; outcomes: string[];
  lessons: (Lesson & { pack?: string; pack_name?: string })[]; exit: Exit; state: "done" | "current" | "locked";
}
export interface ExitCheck { id: string; label: string; value: string; met: boolean }
export interface ExitStatus { level: number; exit: Exit | null; checks: ExitCheck[]; lessons_done: number; lessons_total: number; passed: boolean }

export interface Card {
  id: number; term: string; definition: string; example: string; misuse: string; when_used: string;
  tier: "core" | "field" | "mine" | "pack"; grp: string; source: string;
  reps: number; lapses: number; interval_days: number; last_grade: number | null;
  first_seen: string | null; due: string | null;
}
export interface TermStats { total: number; seen: number; held: number; recall: number }

export interface Paper {
  id: number; title: string; authors: string; document_id: number | null; notebook_id: number | null;
  pass: number; question: string; method: string; result: string; limitation: string; critique: string;
  complete: boolean; updated_at: string;
}
export interface PaperSource { kind: "document" | "notebook"; id: number; title: string; file?: string }

export type ProjectKind = "proposal" | "replication" | "paper" | "review" | "talk";
/** A field of a paper, review or talk: free text with a minimum length, or a choice. */
export interface FlatField { id: string; label: string; hint?: string; rows?: number; min?: number; options?: string[] }
export interface ProjectData {
  question?: string; hypothesis?: string; answers?: Record<string, string>;
  paper?: string; claim?: string; data?: string; code_url?: string; prereg_url?: string; notes?: string;
  steps?: Record<string, boolean>;
  [field: string]: unknown;
}
export interface Project {
  id: number; kind: ProjectKind; title: string; data: ProjectData;
  progress: { done: number; total: number; complete: boolean; next: string | null };
  updated_at: string;
}
export interface ProjectMeta {
  projects: Project[];
  heilmeier: { id: string; question: string }[];
  answer_min: number;
  steps: { id: string; label: string }[];
  kinds: Record<"paper" | "review" | "talk", FlatField[]>;
  sprints: { sprints: number; minutes: number; words: number };
}

export interface PanelRound { id: number; persona: "supervisor" | "journal_club" | "proposal" | "reviewer" | "audience" | "committee" | "professor"; title: string; created_at: string; answers: number; score: number | null }

export interface Skill { id: string; name: string; level: number; description: string; score: number; why: string; pillar?: string }
export interface Pillar { id: string; name: string; score: number; skills: Skill[] }
export interface Readiness { level: number; pillars: Pillar[]; weakest: Skill[]; exit: ExitStatus }

export interface Today {
  track: Track;
  reviews: { due: number; new: number };
  lesson: Lesson | null;
  paper: Paper | null;
  speak: string;
  project: (Partial<Project> & { kind: ProjectKind }) | null;
  weekly: { supervisor: boolean; journal_club: boolean; reviewer?: boolean; sprint?: boolean; peer_review?: boolean; conference?: boolean };
  exit: ExitStatus;
}

export type StepKind = "cards" | "intro" | "read" | "do" | "speak" | "check" | "weekly" | "project" | "exit" | "unknown";
export interface SessionStep {
  id: string; kind: StepKind; title: string; done: boolean;
  minutes?: number; due?: number; new?: number;                       // cards
  lesson?: Lesson & { level: number; pack_name?: string };            // lesson steps
  answer?: string; terms?: { term: string; definition: string; example: string }[];
  what?: string;                                                      // weekly
  project?: Today["project"]; project_kind?: ProjectKind;             // project
  exit?: ExitStatus;                                                  // exit
}
export interface Session {
  day: string; steps: SessionStep[]; current: number | null; complete: boolean; started: boolean;
  minutes: number; streak: number;
  level: { id: number; name: string; lessons_done: number; lessons_total: number; exit_passed: boolean; levels: number };
  next_lesson: { id: string; title: string; minutes?: number } | null;
}

/** How far through today's session: steps done, the total and a whole percentage. */
export function sessionProgress(s: { steps: { done: boolean }[] }): { done: number; total: number; pct: number } {
  const total = s.steps.length;
  const done = s.steps.filter(x => x.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, ten: 10, thirty: 30, forty: 40, ninety: 90 };

/** How long a speaking task asks for ("in thirty seconds", "a two-minute answer"), in seconds; 60 if it doesn't say. */
export function speakSeconds(task: string): number {
  const m = /\b(\d+|one|two|three|four|five|ten|thirty|forty|ninety)[\s-](second|minute)s?\b/i.exec(task);
  if (!m) return 60;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
  return m[2].toLowerCase() === "minute" ? n * 60 : n;
}

/** 0 again, 1 hard, 2 good, 3 easy — the same grades the backend schedules with. */
export const GRADES = [
  { grade: 0, label: "Again", key: "1" },
  { grade: 1, label: "Hard", key: "2" },
  { grade: 2, label: "Good", key: "3" },
  { grade: 3, label: "Easy", key: "4" },
] as const;

export const PAPER_FIELDS: { key: "question" | "method" | "result" | "limitation" | "critique"; label: string; hint: string }[] = [
  { key: "question", label: "Question", hint: "What does the paper ask, and why does it matter?" },
  { key: "method", label: "Method", hint: "How did they study it: data, design, measures, analysis." },
  { key: "result", label: "Result", hint: "The main finding, with its size and uncertainty." },
  { key: "limitation", label: "Limitation", hint: "One real weakness: what the design can't rule out." },
  { key: "critique", label: "My critique", hint: "Is the claim bigger than the evidence? What would you do next?" },
];

export const PASSES = ["Not read", "Pass 1: skim", "Pass 2: understand", "Pass 3: rebuild"];

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}
const JSON_HEADERS = { "Content-Type": "application/json" };
const send = <T>(method: string, path: string, body?: unknown) =>
  fetchApi(path, { method, headers: JSON_HEADERS, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(r => json<T>(r))
    .then(v => { checkMilestones("research"); return v; });   // any change may have earned a milestone
const get = <T>(path: string) => fetchApi(path).then(r => json<T>(r));

export const researchApi = {
  track: () => get<{ track: Track | null; content: { terms: number; levels: number; skills: number } }>("/research/"),
  start: (body: { field: string; goal: Goal; weekly_hours: number; brief: string }) => send<Track>("POST", "/research/start", body),
  updateTrack: (body: Partial<Pick<Track, "field" | "goal" | "weekly_hours" | "brief">>) => send<Track>("PATCH", "/research/track", body),
  today: () => get<Today>("/research/today"),
  session: () => get<Session>("/research/session"),
  sessionStep: (id: string, body: { answer?: string; done?: boolean } = {}) =>
    send<Session>("POST", `/research/session/steps/${encodeURIComponent(id)}`, { done: true, ...body }),
  sessionMore: () => send<Session>("POST", "/research/session/more"),
  curriculum: () => get<{ level: number; levels: Level[] }>("/research/curriculum"),
  lesson: (id: string, done: boolean, answer = "") => send<{ done: boolean }>("POST", `/research/lessons/${encodeURIComponent(id)}`, { done, answer }),
  terms: (q = "", tier = "") => get<{ terms: Card[]; stats: TermStats }>(`/research/terms?q=${encodeURIComponent(q)}&tier=${tier}`),
  addTerm: (term: string, definition: string, example = "") => send<Card>("POST", "/research/terms", { term, definition, example }),
  harvest: () => send<{ added: number }>("POST", "/research/terms/harvest"),
  queue: () => get<{ due: Card[]; new: Card[]; new_left: number }>("/research/review"),
  grade: (cardId: number, grade: number) => send<Card>("POST", `/research/review/${cardId}`, { grade }),
  papers: () => get<Paper[]>("/research/papers"),
  paperSources: () => get<PaperSource[]>("/research/papers/sources"),
  addPaper: (body: { title: string; document_id?: number; notebook_id?: number; authors?: string }) => send<Paper>("POST", "/research/papers", body),
  updatePaper: (id: number, body: Partial<Pick<Paper, "title" | "authors" | "question" | "method" | "result" | "limitation" | "critique" | "pass">>) =>
    send<Paper>("PATCH", `/research/papers/${id}`, body),
  deletePaper: (id: number) => send<{ ok: boolean }>("DELETE", `/research/papers/${id}`),
  projects: (kind = "") => get<ProjectMeta>(`/research/projects?kind=${kind}`),
  addProject: (kind: ProjectKind, title: string) => send<Project>("POST", "/research/projects", { kind, title }),
  updateProject: (id: number, body: { title?: string; data?: Record<string, unknown> }) => send<Project>("PATCH", `/research/projects/${id}`, body),
  deleteProject: (id: number) => send<{ ok: boolean }>("DELETE", `/research/projects/${id}`),
  addSprint: (minutes: number, words: number, projectId?: number) =>
    send<{ id: number; minutes: number; words: number }>("POST", "/research/sprints", { minutes, words, project_id: projectId ?? null }),
  portfolio: () => get<{ markdown: string }>("/research/portfolio"),
  packs: () => get<{ packs: Pack[] }>("/research/packs"),
  setPacks: (packs: string[]) => send<{ packs: Pack[] }>("PUT", "/research/packs", { packs }),
  meetings: () => get<MeetingReport>("/research/meetings"),
  setMentor: (name: string, email: string) => send<Track>("PUT", "/research/mentor", { name, email }),
  signOffs: () => get<SignOff[]>("/research/signoffs"),
  signOff: (body: { mentor: string; level: number; skills: string[]; note: string }) =>
    send<{ signed: string[]; note: string }>("POST", "/research/signoffs", body),
  panel: () => get<PanelRound[]>("/research/panel"),
  readiness: () => get<Readiness>("/research/readiness"),
  advance: () => send<Track>("POST", "/research/advance"),
};

/** A skill score (0–4) in words, as the Readiness tab shows it. */
export function scoreLabel(score: number): string {
  return ["Not started", "Aware", "Guided", "Independent", "Fluent"][Math.max(0, Math.min(4, Math.round(score)))];
}

/** How long until a card is due, in words ("now", "in 3 days"). */
export function dueIn(due: string | null, now = new Date()): string {
  if (!due) return "new";
  const ms = new Date(due + "Z").getTime() - now.getTime();
  if (ms <= 0) return "now";
  const days = ms / 86_400_000;
  if (days < 1) return `in ${Math.max(1, Math.round(ms / 3_600_000))} h`;
  return `in ${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"}`;
}

/** What to tell the Supervisor about the project, from the track's brief and field. */
export function supervisorDetails(track: Track): string {
  return [`Field: ${track.field}`, track.brief && `Project: ${track.brief}`, `Research Track level ${track.level}`]
    .filter(Boolean).join("\n\n");
}

/** The proposal panel reads the learner's own answers, question by question. */
export function proposalDetails(p: Project, meta: Pick<ProjectMeta, "heilmeier">): string {
  const d = p.data;
  return [
    d.question?.trim() && `Research question: ${d.question.trim()}`,
    d.hypothesis?.trim() && `Hypothesis: ${d.hypothesis.trim()}`,
    ...meta.heilmeier.filter(q => d.answers?.[q.id]?.trim()).map(q => `${q.question}\n${d.answers![q.id].trim()}`),
  ].filter(Boolean).join("\n\n");
}

/** Reviewer 2 reads the replication plan and where it has got to. */
export function replicationDetails(p: Project, meta: Pick<ProjectMeta, "steps">): string {
  const d = p.data;
  const done = meta.steps.filter(s => d.steps?.[s.id]).map(s => s.label);
  return [
    d.paper?.trim() && `Paper: ${d.paper.trim()}`,
    d.claim?.trim() && `Result to reproduce: ${d.claim.trim()}`,
    d.data?.trim() && `Data: ${d.data.trim()}`,
    d.prereg_url?.trim() && `Plan: ${d.prereg_url.trim()}`,
    d.code_url?.trim() && `Code: ${d.code_url.trim()}`,
    done.length > 0 && `Done so far: ${done.join("; ")}`,
    d.notes?.trim() && `Findings: ${d.notes.trim()}`,
  ].filter(Boolean).join("\n");
}

/** A paper, review or talk for the panel: each written field under its label. */
export function flatDetails(p: Project, fields: FlatField[]): string {
  return fields.filter(f => typeof p.data[f.id] === "string" && (p.data[f.id] as string).trim())
    .map(f => `${f.label}:\n${(p.data[f.id] as string).trim()}`).join("\n\n");
}

/** Words in a piece of writing, for writing sprints. */
export function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Everything written in a project, the text a sprint counts. */
export function projectText(p: Project): string {
  const d = p.data;
  const answers = Object.values(d.answers ?? {});
  const fields = Object.entries(d).filter(([k, v]) => typeof v === "string" && !k.endsWith("url")).map(([, v]) => v as string);
  return [...fields, ...answers].join(" ");
}

/** An email to a mentor asking them to look at the portfolio (the learner attaches the saved file). */
export function mentorEmail(track: Track): string {
  const to = track.mentor_email?.trim() ?? "";
  const subject = `My research portfolio: ${track.field}, level ${track.level}`;
  const body = [
    `Hello${track.mentor_name ? ` ${track.mentor_name.trim().split(" ")[0]}` : ""},`,
    "",
    `I'm working through a structured research training track in ${track.field} and have reached level ${track.level}.`,
    "I've attached my portfolio: paper cards, projects, practice scores and the skills they support.",
    "Could you look at it and tell me which skills you've seen me do well, and what I should work on next?",
    "",
    "Thank you,",
  ].join("\n");
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** What to tell the journal club about the paper, from the learner's own card. */
export function journalDetails(p: Paper): string {
  return PAPER_FIELDS.filter(f => p[f.key].trim()).map(f => `${f.label}: ${p[f.key].trim()}`).join("\n");
}

/**
 * The roadmap page's colour tokens, taken from the app's current theme so the
 * embedded map looks like the rest of the app. `read` returns an app CSS
 * variable (e.g. "--base-rgb" → "18, 20, 22"). The four family colours stay
 * the roadmap's own; `light` picks its light or dark set of them.
 */
export function roadmapTheme(read: (name: string) => string, light: boolean): { tokens: Record<string, string>; light: boolean } {
  const v = (name: string, fallback: string) => read(name).trim() || fallback;
  const base = `rgb(${v("--base-rgb", "10, 12, 18")})`;
  const raised = `rgb(${v("--raised-rgb", "26, 29, 39")})`;
  const ink = `rgb(${v("--ink-rgb", "255, 255, 255")})`;
  return {
    light,
    tokens: {
      "--paper": base,
      "--card": raised,
      "--panel": `color-mix(in srgb, ${raised} 55%, ${base})`,
      "--ink": v("--text", "#e1e4ed"),
      "--ink-2": v("--muted", "#8b8fa3"),
      "--edge": `color-mix(in srgb, ${ink} 16%, ${base})`,
      "--dot": `color-mix(in srgb, ${ink} ${light ? 18 : 14}%, ${base})`,
      "--focus": `rgb(${v("--accent-rgb", "99, 102, 241")})`,
      "--frost": `color-mix(in srgb, ${base} 82%, transparent)`,
      "--shadow": v("--card-shadow", "0 6px 22px rgba(0, 0, 0, 0.2)"),
    },
  };
}
