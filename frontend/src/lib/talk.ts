import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";

/** A work situation to practise (Talk at work). */
export interface TalkScenario { id: string; kind: string; seconds: number; listener: string; brief: string }
export interface TalkFeedback {
  bluf: boolean; clear: number; length: "too short" | "right" | "too long"; score: number;
  strengths: string[]; fixes: string[]; better: string; target_seconds: number;
  delivery: { words: number; fillers: number; hedges: number; examples: string[] };
}
export interface Shortened { shorter: string; cut: string[]; words_before: number; words_after: number; saved_percent: number }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}
const post = <T>(path: string, body: { fallback_credits?: boolean } & Record<string, unknown>) =>
  fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json", ...(body.fallback_credits ? { "X-IRB-Use-Credits": "1" } : {}) },
    body: JSON.stringify(body) }).then(r => json<T>(r));

export const talkApi = {
  drills: (skip = 0) => fetchApi(`/talk/drills?skip=${skip}`).then(r => json<{ scenarios: TalkScenario[]; topic: string; impromptu_seconds: number }>(r)),
  score: (body: { drill: string; answer: string; topic?: string; seconds?: number; fallback_credits?: boolean }) => post<TalkFeedback>("/talk/score", body),
  shorten: (body: { text: string; kind: "chat" | "email"; fallback_credits?: boolean }) => post<Shortened>("/talk/shorten", body),
};

/** Seconds as the timer shows them: 0:45. */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
