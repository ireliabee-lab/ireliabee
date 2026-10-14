/**
 * Reading notes (spec 185): a paper or book → a deck of notebook slides.
 * The backend reads the PDF page by page in the background and writes the deck
 * as a background job; this module talks to it and holds the small pure helpers
 * the screens share (page ranges, labels, progress).
 */
import { fetchApi } from "./api";
import { formatCredits, owedAmount, owedCredits } from "./account";
import { errorFromResponse } from "./errors";
import type { FoundTerm, NotebookStyle, NotebookSummary } from "./notebook";
export type { Coverage } from "./notebook";

export type ReadState = "new" | "reading" | "ready" | "scanned" | "failed" | "cancelled";
export type DocKind = "paper" | "book" | "document" | "";

export interface OutlineEntry {
  idx: number;
  level: number;
  title: string;
  page_from: number;
  page_to: number;
  /** references | acknowledgements | appendix — left out unless ticked. */
  kind: string;
}

export interface ReadStatus {
  document_id: number;
  name: string;
  filename: string;
  bytes: number;
  state: ReadState;
  pages: number;
  done: number;
  kind: DocKind;
  source: "bookmarks" | "headings" | "link" | "";
  error: string;
  outline: OutlineEntry[];
  labels?: Record<string, string>;
  suggested?: Scope;
  /** For a source added from a link: where it came from. */
  link?: LinkOrigin;
}

export interface LinkOrigin { url?: string; platform?: string; author?: string; captured_at?: string; method?: string }

const POST_PLATFORMS: Record<string, string> = {
  x: "X", instagram: "Instagram", facebook: "Facebook", reddit: "Reddit", bluesky: "Bluesky",
  mastodon: "Mastodon", tiktok: "TikTok", linkedin: "LinkedIn", threads: "Threads",
};
const PAPER_PLATFORMS = new Set(["arxiv", "pubmed", "pmc"]);

/** What a link source is, for the notes page: "a web page", "an X post", "a paper", "a YouTube video". */
export function linkKind(link: LinkOrigin): { kicker: string; label: string } {
  const p = link.platform ?? "web";
  if (p === "youtube") return { kicker: "Notes from a YouTube video", label: "YouTube transcript" };
  if (POST_PLATFORMS[p]) return { kicker: `Notes from a ${POST_PLATFORMS[p]} post`, label: `${POST_PLATFORMS[p]} post` };
  if (PAPER_PLATFORMS.has(p)) return { kicker: "Notes from a paper", label: "Paper" };
  return { kicker: "Notes from a web page", label: "Web page" };
}

/** The site a link came from, without "www.". */
export function linkSite(url?: string): string {
  try { return url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch { return ""; }
}

export type Scope =
  | { mode: "all" }
  | { mode: "chapters"; chapters: number[] }
  | { mode: "pages"; pages: string };

export interface Template { id: string; label: string; for: string; slides: string; /** What the app shows, when it differs from what the model is told. */ shows?: string }

export interface Estimate {
  pages: number;
  label: string;
  units: number;
  left_out: string[];
  calls: number;
  cached_windows: number;
  windows: number;
  tokens: { input: number; output: number };
  usd: number | null;
  /** The service's price in credits, for an ordinary account; null when its prices can't be read. */
  credits?: number | null;
  model: string;
  seconds: number;
  template: string;
}

/**
 * The price line under the estimate (decision 185-1: an estimate before anything is spent).
 * The admin runs on their own keys and sees dollars; everyone else sees credits, and is
 * told plainly when that is more than they have. Never a guessed number.
 */
export function estimateCost(
  est: Pick<Estimate, "usd" | "credits" | "model">,
  account: { admin: boolean; available?: number | null; credits?: number | null },
):
  { text: string; short: boolean } {
  if (account.admin) {
    return { text: est.usd != null ? `about $${est.usd.toFixed(2)} of ${est.model}` : "", short: false };
  }
  if (est.credits == null) return { text: "charged from your credits as it runs", short: false };
  const amount = est.credits < 0.01 ? "under 0.01 credits" : `about ${formatCredits(Math.ceil(est.credits * 100) / 100)} credits`;
  const short = account.available != null && est.credits > account.available;
  if (!short) return { text: amount, short };
  // Below zero is a debt, and "more than your -10.8 available" reads like a
  // glitch; say what it is. Below zero with nothing owed is a running session
  // holding more than is left: there is simply none to use right now.
  const owed = owedCredits({ credits: account.credits, available: account.available });
  const left = Number(account.available);
  return {
    text: owed > 0
      ? `${amount} — and you owe ${owedAmount(owed)}, which the next credits you buy pay first`
      : left > 0
        ? `${amount} — more than your ${formatCredits(left)} available`
        : `${amount} — and you have none available right now`,
    short,
  };
}

export interface Job {
  id: string;
  document_id: number;
  state: "running" | "done" | "failed" | "cancelled";
  step: string;
  done: number;
  total: number;
  notebook_id: number | null;
  error: { code?: string; title?: string; message: string; action?: string | null } | null;
  /** The stage it's in ("read", "write", "terms") and when its current part began (seconds). */
  phase?: string;
  part_started?: number;
}


export const SKIPPED_BY_DEFAULT = ["references", "acknowledgements", "appendix"];
export const MAX_UPLOAD_MB = 200;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}
const JSON_HEADERS = { "Content-Type": "application/json" };
const post = <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
  fetchApi(path, { method: "POST", headers: { ...JSON_HEADERS, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(r => json<T>(r));

export const readingApi = {
  templates: () => fetchApi("/reading/templates").then(r => json<{ templates: Template[]; limits: { upload_mb: number; pages: number; run_pages: number } }>(r)),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("name", file.name.replace(/\.[^.]+$/, ""));
    return fetchApi("/reading/upload", { method: "POST", body: fd }).then(r => json<ReadStatus>(r));
  },
  status: (docId: number) => fetchApi(`/reading/documents/${docId}`).then(r => json<ReadStatus>(r)),
  read: (docId: number) => post<ReadStatus>(`/reading/documents/${docId}/read`),
  cancelRead: (docId: number) => post<ReadStatus>(`/reading/documents/${docId}/cancel`),
  pages: (docId: number, pages: number[]) =>
    fetchApi(`/reading/documents/${docId}/pages?p=${pages.join(",")}`).then(r => json<{ pages: { page: number; label: string; text: string }[] }>(r)),
  /** The pages of the source that mention these words. */
  find: (docId: number, q: string) =>
    fetchApi(`/reading/documents/${docId}/find?q=${encodeURIComponent(q)}`).then(r => json<{ pages: number[] }>(r)),
  decks: (docId: number) => fetchApi(`/reading/documents/${docId}/decks`).then(r => json<NotebookSummary[]>(r)),
  estimate: (body: { document_id: number; scope: Scope; template: string; model?: string; level?: ReaderLevel }) => post<Estimate>("/reading/estimate", body),
  generate: (body: { document_id: number; scope: Scope; template: string; style: NotebookStyle; model?: string; tutor: boolean; notebook_id?: number; level?: ReaderLevel }) =>
    post<Job>("/reading/generate", body),
  job: (id: string) => fetchApi(`/reading/jobs/${id}`).then(r => json<Job>(r)),
  /** A chapter explained back from memory, marked against its notes (Deep Read, B4). */
  explain: (body: { notebook_id: number; section_id: string; text: string; level?: ReaderLevel }) => post<ExplainResult>("/reading/explain", body),
  progress: (notebookId: number) => fetchApi(`/reading/progress/${notebookId}`).then(r => json<ReadingProgress>(r)),
  /** One paragraph in plainer words, with its page(s) as context (Deep Read, B3). */
  /** One paragraph understood another way (the Simplify menu): plainer, for a newcomer, an example, an analogy, steps, key terms. */
  simplify: (body: { document_id?: number | null; text: string; pages: number[]; level?: ReaderLevel; model?: string; mode?: UnderstandMode }) =>
    post<{ plain: string; terms?: UnderstoodTerm[] }>("/reading/simplify", body),
  /** What selected words mean: from the source when it says (with its pages), else general knowledge, labelled. */
  lookup: (body: { text: string; line?: string; document_id?: number | null; pages?: number[]; depth: LookupDepth; level?: ReaderLevel; model?: string; fallback_credits?: boolean }) =>
    post<Lookup>("/reading/lookup", body, body.fallback_credits ? { "X-IRB-Use-Credits": "1" } : undefined),
  /** A highlighted passage as a mind map. */
  mindMap: (body: { passage: string; document_id?: number | null; pages?: number[]; level?: ReaderLevel; fallback_credits?: boolean }) =>
    post<MindMap>("/reading/mind-map", body, body.fallback_credits ? { "X-IRB-Use-Credits": "1" } : undefined),
  /** A follow-up question about words or a paragraph already explained, with the conversation so far. */
  ask: (body: { question: string; passage: string; explained?: string; history?: { q: string; a: string }[];
    document_id?: number | null; pages?: number[]; notebook_id?: number | null; level?: ReaderLevel; model?: string }) =>
    post<FollowUpAnswer>("/reading/ask", body),
  /** One question that checks a paragraph was understood, and the points a good answer contains. */
  checkQuestion: (body: { text: string; document_id?: number | null; pages?: number[]; level?: ReaderLevel; avoid?: string[]; model?: string }) =>
    post<{ question: string; points: string[] }>("/reading/check/question", body),
  /** The answer, in the reader's own words, marked against the paragraph. */
  checkMark: (body: { text: string; question: string; points: string[]; answer: string; level?: ReaderLevel; document_id?: number | null; model?: string }) =>
    post<CheckResult>("/reading/check/mark", body),
  /** Every unfamiliar term in a notebook, explained (the fuller glossary); the caller saves them with the notebook. */
  findTerms: (body: { notebook_id: number; level?: ReaderLevel; model?: string }) =>
    post<{ terms: FoundTerm[] }>("/reading/glossary/find", body),
  cancelJob: (id: string) => post<Job>(`/reading/jobs/${id}/cancel`),
};

/** An answer to a follow-up question: from the source (with its pages), general knowledge, or both. */
export interface FollowUpAnswer { answer: string; from: "source" | "general" | "both"; pages: number[]; unsure: boolean }

/** A marked answer: point numbers (1-based) got and missed, what was wrong, and the points themselves. */
export interface CheckResult {
  score: number; got: number[]; missed: number[]; wrong: { said: string; fix: string }[]; note: string; points: string[];
}

/** The ways the Simplify menu can explain a paragraph. */
export type UnderstandMode = "plainer" | "newcomer" | "example" | "analogy" | "steps" | "terms";
export const UNDERSTAND_MODES: { id: UnderstandMode; label: string; hint: string }[] = [
  { id: "plainer", label: "In plainer words", hint: "The same paragraph, simpler" },
  { id: "newcomer", label: "Explain like I'm new", hint: "The background it assumes, then what it says" },
  { id: "example", label: "An example", hint: "A concrete case that shows what it means" },
  { id: "analogy", label: "An analogy", hint: "An everyday comparison, and where it stops fitting" },
  { id: "steps", label: "Step by step", hint: "Its reasoning as short steps" },
  { id: "terms", label: "Key terms", hint: "Every technical or unfamiliar term in it" },
];
export interface UnderstoodTerm { term: string; meaning: string; from: "source" | "general" }

/** How an explanation is pitched: everyday words, or the field's own terms. */
export type LookupDepth = "basic" | "technical";
export interface Lookup {
  meaning: string;
  example: string;
  /** Where it came from: the source (with its pages), general knowledge (iReliabee's), or both. */
  from: "source" | "general" | "both";
  pages: number[];
  /** The AI was not sure what the name refers to. */
  unsure: boolean;
  /** Looked up before: no credits spent this time. */
  cached: boolean;
}

/** Where the Notebook opens: "12" opens notebook 12; "read" / "read:7" starts reading notes (from document 7). */
export function parseNotebookSection(section?: string): { openId?: number; read?: { documentId?: number } } {
  if (!section) return {};
  if (section === "read") return { read: {} };
  const m = /^read:(\d+)$/.exec(section);
  if (m) return { read: { documentId: Number(m[1]) } };
  const id = Number(section);
  return Number.isInteger(id) && id > 0 ? { openId: id } : {};
}

/** Take the user to "What should I cover?" for a Library document. */
export function openReading(documentId: number) {
  window.dispatchEvent(new CustomEvent("navigate", { detail: `notebook:read:${documentId}` }));
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** "12–48, 60" → pages, or a message saying what's wrong. Mirrors backend reading.parse_pages. */
export function parsePages(spec: string, total: number): { pages: number[] } | { error: string } {
  const pages = new Set<number>();
  for (let part of spec.split(/[,;]/)) {
    part = part.trim().toLowerCase().replaceAll("pp.", "").replaceAll("p.", "").trim();
    if (!part) continue;
    const bits = part.split(/\s*(?:[-–—]|\bto\b)\s*/);
    const nums = bits.map(b => (/^\d+$/.test(b) ? Number(b) : NaN));
    if (nums.length > 2 || nums.some(Number.isNaN)) return { error: `“${part}” isn't a page or a range. Write pages like 12–48, 60.` };
    let [lo, hi] = nums.length === 1 ? [nums[0], nums[0]] : nums;
    if (lo > hi) [lo, hi] = [hi, lo];
    if (lo < 1 || hi > total) return { error: `This document has pages 1–${total}.` };
    for (let p = lo; p <= hi; p++) pages.add(p);
  }
  if (!pages.size) return { error: "Write the pages to cover, like 12–48, 60." };
  return { pages: [...pages].sort((a, b) => a - b) };
}

/** [1,2,3,7] → "1–3, 7" */
export function rangesLabel(pages: number[]): string {
  const runs: [number, number][] = [];
  for (const p of [...pages].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else runs.push([p, p]);
  }
  return runs.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
}

export function pagesLabel(e: Pick<OutlineEntry, "page_from" | "page_to">): string {
  return e.page_from === e.page_to ? `p. ${e.page_from}` : `pp. ${e.page_from}–${e.page_to}`;
}

/** The chapters ticked when the user switches to "Chapters": the suggestion, else every main one not skipped. */
export function defaultChapters(st: Pick<ReadStatus, "outline" | "suggested">): number[] {
  if (st.suggested?.mode === "chapters") return st.suggested.chapters;
  const top = Math.min(...st.outline.map(e => e.level));
  return st.outline.filter(e => e.level === top && !SKIPPED_BY_DEFAULT.includes(e.kind)).map(e => e.idx);
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return "about a minute";
  const min = Math.round(seconds / 60);
  return min < 60 ? `about ${min} minutes` : `about ${Math.floor(min / 60)} h ${min % 60} min`;
}

export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function percent(done: number, total: number): number {
  return total > 0 ? Math.max(0, Math.min(100, Math.round((100 * done) / total))) : 0;
}

export const KIND_LABEL: Record<string, string> = { paper: "Paper", book: "Book", document: "Document", "": "Document" };

/** How much the reader already knows, for a Deep read's plain meanings and gists. */
export type ReaderLevel = "new" | "some" | "expert";
export const READER_LEVELS: { id: ReaderLevel; label: string; hint: string }[] = [
  { id: "new", label: "New to this", hint: "Everyday words, no background assumed" },
  { id: "some", label: "Some background", hint: "Plain words; the basics of the field assumed" },
  { id: "expert", label: "Expert nearby", hint: "Precise and brief" },
];
const LEVEL_KEY = "ireliabee.deepReadLevel";
/** The level chosen last time, as the next document's starting point. */
export function rememberedLevel(): ReaderLevel {
  try {
    const v = localStorage.getItem(LEVEL_KEY);
    return v === "new" || v === "expert" ? v : "some";
  } catch { return "some"; }
}
export function rememberLevel(level: ReaderLevel): void {
  try { localStorage.setItem(LEVEL_KEY, level); } catch { /* the default next time */ }
}

/** A term of a deep read and the terms it builds on, for the map of ideas. */
export interface Idea { term: string; builds_on: string[]; pages?: number[] }
export interface ExplainItem { text: string; src: number[] }
export interface ReadingProgress {
  chapters: number; explained: number; understood: number;
  sections: Record<string, { score: number; tries: number; at: string }>;
}
export interface ExplainResult {
  score: number; got: ExplainItem[]; missed: ExplainItem[]; wrong: { said: string; fix: string; src: number[] }[];
  note: string; progress: ReadingProgress;
}

/** One idea on a mind map: a short label, what it means here, and the source pages that say it. */
export interface MindNode { label: string; note: string; pages: number[]; children?: MindNode[] }
export interface MindMap { center: string; branches: MindNode[] }
