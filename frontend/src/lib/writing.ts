/** Write: the academic writing framework (backend/writing.py, docs/academic-writing.md). */
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";
import type { CslItem, Ref } from "./citations";
import type { Paper } from "./papers";

export interface Stage { key: string; title: string; why: string; produce: string; checklist: string[]; videos: string[] }
export interface GenreSection { key: string; title: string; share: number; hint: string }
export interface Genre { key: string; title: string; summary: string; first_person: boolean; headings: boolean; sections: GenreSection[] }
export interface Framework {
  stages: Stage[]; genres: Genre[]; videos: Record<string, string>; video_source: string;
  citation_styles: { key: string; title: string }[];
}
export interface Section {
  id: number; key: string; title: string; body: string; notes: string;
  share: number; target: number; target_set: boolean; words: number; updated_at: string;
}
export interface Project {
  id: number; title: string; genre: string; word_limit: number; style: string;
  brief: string; focus: string; thesis: string; stage: string; ticks: Record<string, number[]>;
  /** The brief's key terms, as the writer confirmed them (lib/taskAnalysis.ts suggests them). */
  key_terms: string[];
  created_at: string; updated_at: string; words: number; sections?: Section[];
}
export type ProjectPatch = Partial<Pick<Project, "title" | "genre" | "word_limit" | "style" | "brief" | "focus" | "thesis" | "stage" | "ticks" | "key_terms">>;
export type SectionPatch = Partial<{ title: string; body: string; notes: string; target: number | null }>;

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchApi(path, init);
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}
const send = (method: string, body?: unknown): RequestInit =>
  ({ method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const writingApi = {
  framework: () => json<Framework>("/writing/framework"),
  projects: () => json<Project[]>("/writing/projects"),
  project: (id: number) => json<Project>(`/writing/projects/${id}`),
  create: (genre: string, title: string, word_limit: number, style: string) =>
    json<Project>("/writing/projects", send("POST", { genre, title, word_limit, style })),
  update: (id: number, patch: ProjectPatch) => json<Project>(`/writing/projects/${id}`, send("PATCH", patch)),
  remove: (id: number) => json<{ ok: true }>(`/writing/projects/${id}`, send("DELETE")),
  addSection: (id: number, title: string, afterId?: number) =>
    json<Project>(`/writing/projects/${id}/sections`, send("POST", { title, after_id: afterId ?? null })),
  reorder: (id: number, ids: number[]) => json<Project>(`/writing/projects/${id}/sections/order`, send("PUT", { ids })),
  updateSection: (sectionId: number, patch: SectionPatch) => json<Project>(`/writing/sections/${sectionId}`, send("PATCH", patch)),
  removeSection: (sectionId: number) => json<Project>(`/writing/sections/${sectionId}`, send("DELETE")),
  refs: (id: number) => json<Ref[]>(`/writing/projects/${id}/refs`),
  addRef: (id: number, from: { doi: string } | { document_id: number } | { item: CslItem } | { paper: Paper }) =>
    json<Ref & { existing: boolean }>(`/writing/projects/${id}/refs`, send("POST", from)),
  updateRef: (refId: number, patch: { item?: CslItem; note?: string }) => json<Ref>(`/writing/refs/${refId}`, send("PATCH", patch)),
  removeRef: (refId: number) => json<{ ok: true }>(`/writing/refs/${refId}`, send("DELETE")),
  reviewEstimate: (id: number, sectionId: number | null) =>
    json<ReviewEstimate>(`/writing/projects/${id}/review/estimate${sectionId != null ? `?section_id=${sectionId}` : ""}`),
  review: (id: number, sectionId: number | null, textHash: string, fallbackCredits = false) =>
    json<Review>(`/writing/projects/${id}/review`, send("POST", { section_id: sectionId, fallback_credits: fallbackCredits, text_hash: textHash })),
};

/** The coach's notes: never rewritten text (backend/writing_review.py). */
export interface ReviewNote { quote: string; issue: string; why: string; try: string }
export interface Review { summary: string; strengths: string[]; notes: ReviewNote[]; next: string; created_at: string; stale: boolean }
export interface ReviewEstimate { words: number; credits: number | null; saved: Review | null; text_hash: string }

/** The cost line before a review: never a guessed price. */
export function reviewCostLine(est: ReviewEstimate, ownAssistant: boolean): string {
  if (ownAssistant) return "Done by your own AI assistant: no credits used.";
  if (est.credits == null) return "A review uses a few credits.";
  if (est.credits < 0.1) return "A review uses under 0.1 credits.";
  return `A review uses about ${est.credits} credits.`;
}

/** How a word count sits against its target: within 10% is on target, as the brief's limit is. */
export function wordStatus(words: number, target: number): "none" | "under" | "on" | "over" {
  if (!target) return "none";
  if (words > target * 1.1) return "over";
  if (words >= target * 0.9) return "on";
  return "under";
}

/** Ticked items of a stage, out of how many. */
export function stageProgress(project: Pick<Project, "ticks">, stage: Stage): { done: number; total: number } {
  const ticked = new Set(project.ticks[stage.key] ?? []);
  return { done: stage.checklist.filter((_, i) => ticked.has(i)).length, total: stage.checklist.length };
}

export const videoUrl = (id: string) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

/** Words in a piece of text, counted as the backend counts them (backend/writing.py words). */
export function countWords(text: string): number {
  return (text.replace(/\[@[^\]\n]*\]/g, " ").match(/[\p{L}\p{N}_'’-]+/gu) ?? []).length;
}
