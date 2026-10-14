import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";

/** A question from "Check my understanding", kept for spaced review (docs/study-mode.md). */
export interface StudyCard {
  id: number;
  notebook_id: number;
  notebook_title?: string;
  document_id: number | null;
  paragraph: string;
  src: number[];
  question: string;
  points: string[];
  reps: number;
  last_score: number | null;
  due: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}
const send = <T>(path: string, method: string, body?: unknown) =>
  fetchApi(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(r => json<T>(r));

/** A question to read a chapter for, with what a good answer contains and where it is. */
export interface ChapterQuestion { question: string; points: string[]; src: number[]; paragraph: string }

/** Feedback on one of the two explanations (Explain it twice). */
export interface ExplainSide {
  accurate: number; bluf: boolean; missed: string[]; wrong: { said: string; fix: string }[]; note: string;
  plain?: number; analogy?: boolean; unexplained?: string[];
  delivery: { words: number; fillers: number; hedges: number; examples: string[]; avg_sentence_words: number };
}
export interface ExplainTwiceResult { title: string; expert: ExplainSide; beginner: ExplainSide }

export const studyApi = {
  chapterEstimate: (notebookId: number, sectionId: string, level?: string) =>
    fetchApi(`/study/chapter-estimate?notebook_id=${notebookId}&section_id=${encodeURIComponent(sectionId)}${level ? `&level=${level}` : ""}`)
      .then(r => json<{ questions_ready: boolean; answers: number; credits: number | null }>(r)),
  explainTwice: (body: { notebook_id: number; section_id: string; expert: string; beginner: string; fallback_credits?: boolean }) =>
    fetchApi("/study/explain-twice", { method: "POST", headers: { "Content-Type": "application/json", ...(body.fallback_credits ? { "X-IRB-Use-Credits": "1" } : {}) },
      body: JSON.stringify(body) }).then(r => json<ExplainTwiceResult>(r)),
  chapter: (body: { notebook_id: number; section_id: string; level?: string; fallback_credits?: boolean }) =>
    fetchApi("/study/chapter", { method: "POST", headers: { "Content-Type": "application/json", ...(body.fallback_credits ? { "X-IRB-Use-Credits": "1" } : {}) },
      body: JSON.stringify(body) }).then(r => json<{ title: string; questions: ChapterQuestion[]; cached: boolean }>(r)),
  due: (notebookId?: number) =>
    fetchApi(`/study/due${notebookId ? `?notebook_id=${notebookId}` : ""}`).then(r => json<{ cards: StudyCard[]; due: number; total: number }>(r)),
  add: (body: { notebook_id: number; document_id?: number | null; paragraph: string; src: number[]; question: string; points: string[]; score: number }) =>
    send<StudyCard>("/study/cards", "POST", body),
  review: (id: number, score: number) => send<StudyCard>(`/study/cards/${id}`, "POST", { score }),
  remove: (id: number) => send<{ ok: boolean }>(`/study/cards/${id}`, "DELETE"),
};

/** When a card comes back, in words: "in 10 minutes", "tomorrow", "in 4 days". */
export function comesBack(due: string, now: Date = new Date()): string {
  const ms = new Date(due).getTime() - now.getTime();
  const min = Math.round(ms / 60000);
  if (min <= 1) return "now";
  if (min < 60) return `in ${min} minutes`;
  const hours = Math.round(min / 60);
  if (hours < 20) return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.round(ms / 86_400_000);
  if (days <= 1) return "tomorrow";
  if (days < 45) return `in ${days} days`;
  const months = Math.round(days / 30);
  return `in ${months} ${months === 1 ? "month" : "months"}`;
}
