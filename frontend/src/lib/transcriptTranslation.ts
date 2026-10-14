/** A saved session's transcript translated afterwards (docs/translation.md, T3). */
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";

export interface TranscriptTranslation { language: string; total: number; done: number; lines: Record<string, string> }
export interface TranslationEstimate { lines: number; credits: number | null }
export interface SessionLanguages { spoken: string; reading: string }

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

const q = (language: string) => `language=${encodeURIComponent(language)}`;

export const transcriptTranslationApi = {
  get: (sessionId: number, language: string) =>
    fetchApi(`/sessions/${sessionId}/translation?${q(language)}`).then(r => json<TranscriptTranslation>(r)),
  estimate: (sessionId: number, language: string) =>
    fetchApi(`/sessions/${sessionId}/translation/estimate?${q(language)}`).then(r => json<TranslationEstimate>(r)),
  translate: (sessionId: number, language: string, fallbackCredits = false) =>
    fetchApi(`/sessions/${sessionId}/translation`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, fallback_credits: fallbackCredits }),
    }).then(r => json<TranscriptTranslation>(r)),
  markdown: (sessionId: number, language: string | null, them: string) =>
    fetchApi(`/sessions/${sessionId}/transcript.md?them=${encodeURIComponent(them)}${language ? `&${q(language)}` : ""}`)
      .then(r => json<{ markdown: string }>(r)).then(r => r.markdown),
  /** What the call was spoken in and what the user reads ("" when the session never chose). */
  languages: (sessionId: number) =>
    fetchApi(`/sessions/${sessionId}`).then(r => json<{ language?: string | null; display_language?: string | null }>(r))
      .then(s => ({ spoken: s.language ?? "", reading: s.display_language ?? "" }) as SessionLanguages),
};

/** The line shown first: its translation when there is one, else what was said. */
export function shownLine(id: number | undefined, original: string, tr: TranscriptTranslation | null): { text: string; original: string | null } {
  const t = id != null && tr ? tr.lines[String(id)] : undefined;
  return t && t !== original ? { text: t, original } : { text: original, original: null };
}

/** The cost line before translating: never a guessed price. */
export function translationCostLine(est: TranslationEstimate, ownAssistant: boolean): string {
  if (ownAssistant) return `Done by your own AI assistant: no credits used (${est.lines} lines).`;
  if (est.credits == null) return `Translating ${est.lines} lines uses a few credits.`;
  if (est.credits < 0.1) return `Translating ${est.lines} lines uses under 0.1 credits.`;
  return `Translating ${est.lines} lines uses about ${est.credits} credits.`;
}
