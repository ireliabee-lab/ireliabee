import { fetchApi } from "./api";

/**
 * Who the user is (student, job seeker, professional…) and the defaults that
 * follow from it (roadmap 1.1). The backend config is the source of truth
 * (`/config/persona`); a localStorage copy lets defaults be read synchronously.
 * Until a persona is chosen, everything falls back to the General coach.
 */

export type PersonaId = "student" | "job-seeker" | "professional" | "other";

export interface Persona {
  id: PersonaId;
  label: string;
  hint: string;
  /** Live-coach template a new session starts on. */
  template: string;
  /** Practice scenario suggested first (lib/scenarios.ts ids). */
  practiceScenario: string;
  /** What the user is getting ready for, for onboarding copy ("your next …"). */
  nextEvent: string;
  /** Wording of the onboarding practice step. */
  practiceStep: string;
}

export const PERSONAS: Persona[] = [
  {
    id: "student", label: "Student", hint: "Classes, vivas, presentations, internship and admission interviews",
    template: "general", practiceScenario: "job", nextEvent: "interview, viva or presentation",
    practiceStep: "Run a short practice round — an internship interview, a viva or a presentation.",
  },
  {
    id: "job-seeker", label: "Job seeker", hint: "Interviews, recruiter calls, salary talks",
    template: "general", practiceScenario: "job", nextEvent: "interview",
    practiceStep: "Run a short mock interview to hear how it feels before the real thing.",
  },
  {
    id: "professional", label: "Working professional", hint: "Meetings, reviews, pitches, hard conversations",
    template: "work-meeting", practiceScenario: "meeting", nextEvent: "meeting or call",
    practiceStep: "Rehearse a work meeting — updates, pushback and clear asks.",
  },
  {
    id: "other", label: "Something else", hint: "Any conversation you want to be ready for",
    template: "general", practiceScenario: "custom", nextEvent: "conversation",
    practiceStep: "Rehearse any conversation — describe it and practise.",
  },
];

const KEY = "persona";

function isPersonaId(v: unknown): v is PersonaId {
  return typeof v === "string" && PERSONAS.some(p => p.id === v);
}

export function getPersona(): PersonaId | null {
  try {
    const v = localStorage.getItem(KEY);
    return isPersonaId(v) ? v : null;
  } catch { return null; }
}

export function personaInfo(id: PersonaId | null = getPersona()): Persona | null {
  return PERSONAS.find(p => p.id === id) ?? null;
}

function cache(id: PersonaId | null) {
  try {
    if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent("persona-changed", { detail: id }));
}

/** Save the persona (backend + local copy) and tell listeners. */
export async function setPersona(id: PersonaId): Promise<void> {
  const res = await fetchApi("/config/persona", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ persona: id }),
  });
  if (!res.ok) throw new Error(`Couldn't save persona (${res.status})`);
  cache(id);
  window.dispatchEvent(new Event("onboarding-refresh"));
}

/** Refresh the local copy from the backend (e.g. after an import or reinstall). */
export async function syncPersona(): Promise<void> {
  try {
    const res = await fetchApi("/config/persona");
    if (!res.ok) return;
    const { persona } = await res.json();
    const id = isPersonaId(persona) ? persona : null;
    if (id !== getPersona()) cache(id);
  } catch { /* offline: keep the local copy */ }
}

/** Template a new session starts on (not Academic / PhD for everyone). */
export function defaultTemplate(): string {
  return personaInfo()?.template ?? "general";
}

/** Practice scenario to preselect when the user hasn't picked one yet. */
export function defaultPracticeScenario(): string {
  return personaInfo()?.practiceScenario ?? "job";
}

export type PracticeMode = "mock" | "explain" | "script" | "study" | "retry" | "talk" | "warmup";

// Practice modes, most useful first for each persona (roadmap 1.4).
const PRACTICE_ORDER: Record<PersonaId, Exclude<PracticeMode, "warmup">[]> = {
  student:        ["explain", "study", "mock", "retry", "talk", "script"],
  "job-seeker":   ["mock", "retry", "talk", "explain", "script", "study"],
  professional:   ["mock", "talk", "retry", "script", "explain", "study"],
  other:          ["mock", "retry", "talk", "explain", "script", "study"],
};

export function practiceModes(): Exclude<PracticeMode, "warmup">[] {
  const id = getPersona();
  return id ? PRACTICE_ORDER[id] : ["mock", "retry", "talk", "explain", "script", "study"];
}
