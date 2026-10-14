/**
 * Session languages (roadmap 3.3). One code per session drives live transcription,
 * the coach's suggestions and everything written afterwards.
 * Must match backend/languages.py (languages.test.ts checks).
 */
export interface Language {
  id: string;
  /** How speakers of the language write its name. */
  native: string;
  /** Its English name. */
  english: string;
  rtl?: boolean;
}

export const LANGUAGES: Language[] = [
  { id: "en",    native: "English",       english: "English" },
  { id: "en-US", native: "English (US)",  english: "American English" },
  { id: "en-GB", native: "English (UK)",  english: "British English" },
  { id: "fr",    native: "Français",      english: "French" },
  { id: "es",    native: "Español",       english: "Spanish" },
  { id: "pt",    native: "Português",     english: "Portuguese" },
  { id: "de",    native: "Deutsch",       english: "German" },
  { id: "ar",    native: "العربية",       english: "Arabic", rtl: true },
  { id: "hi",    native: "हिन्दी",         english: "Hindi" },
  { id: "multi", native: "Mixed",         english: "Switches between languages" },
];

export const DEFAULT_LANGUAGE = "en";

export const isEnglish = (id?: string | null) => !id || id.startsWith("en");

/** Picker options: the native name, with the English one where it differs. */
export const LANGUAGE_OPTIONS = LANGUAGES.map(l => ({
  id: l.id,
  label: l.native === l.english || l.id.startsWith("en") ? l.native : `${l.native} — ${l.english}`,
}));

export function languageLabel(id?: string | null): string {
  const l = LANGUAGES.find(x => x.id === id);
  return l ? (l.id.startsWith("en") ? l.native : l.english) : "English";
}


/**
 * What the user reads in (docs/translation.md, T1): the same as the call by default, or any single
 * language. Cues, answers, the debrief and notes are written in it; transcripts stay as spoken.
 */
export const DISPLAY_OPTIONS = [
  { id: "", label: "Same as spoken" },
  ...LANGUAGE_OPTIONS.filter(o => o.id !== "multi"),
];

/** What translating captions costs, shown before it is on (docs/translation.md, T2; website ledger PRICES.translate). */
export const TRANSLATION_COST = "Translating captions costs 1 credit per 30 minutes, on top of the live session.";

/** Whether a session's captions are translated: a single reading language other than the call's. */
export const translates = (spoken: string, reading?: string) => !!reading && reading !== spoken && reading !== "multi";
