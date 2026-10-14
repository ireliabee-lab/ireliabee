/** A saved transcript tidied by the AI: punctuation, paragraphs and who is speaking (backend/source_tidy.py). */
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";
import type { LinkDocument } from "./links";

export interface TidyEstimate { parts: number; characters: number; credits: number | null; existing: { id: number; name: string } | null }
export interface TidyResult { document: LinkDocument; speakers: string[]; parts: number; kept_original: number }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

export const sourceTidyApi = {
  estimate: (docId: number) => fetchApi(`/links/documents/${docId}/tidy/estimate`).then(r => json<TidyEstimate>(r)),
  /** `again`: tidy a video that already has a tidied copy, paying again. */
  tidy: (docId: number, fallbackCredits = false, again = false) =>
    fetchApi(`/links/documents/${docId}/tidy`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fallback_credits: fallbackCredits, again }),
    }).then(r => json<TidyResult>(r)),
};

/** Only a YouTube transcript that isn't itself a tidied copy offers it. */
export function canTidy(source: { platform?: string; method?: string } | null | undefined): boolean {
  return !!source && source.platform === "youtube" && source.method !== "tidied";
}

/** The cost line before tidying: never a guessed price. */
export function tidyCostLine(est: TidyEstimate, ownAssistant: boolean): string {
  const size = `${Math.round(est.characters / 1000).toLocaleString()}k characters`;
  if (ownAssistant) return `Done by your own AI assistant: no credits used (${size}).`;
  if (est.credits == null) return `Tidying this transcript (${size}) uses a few credits.`;
  if (est.credits < 0.1) return `Tidying this transcript (${size}) uses under 0.1 credits.`;
  return `Tidying this transcript (${size}) uses about ${est.credits} credits.`;
}
