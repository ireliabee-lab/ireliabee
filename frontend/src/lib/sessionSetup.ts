import type { SessionDraft } from "../components/CreateSessionWizard";

/** A session as GET /sessions/{id} returns it: the parts a draft is made from. */
export interface SavedSession {
  title?: string;
  subtitle?: string | null;
  tags?: string[];
  mode?: string;
  language?: string | null;
  setup?: {
    plan_id?: number | null;
    cv_id?: number | null;
    document_ids?: number[] | null;
    people_ids?: number[] | null;
    ai_instructions?: string | null;
    response_tone?: string | null;
    auto_answer?: boolean | null;
    /** Auto Answer for what you say; sessions from before it follow auto_answer. */
    auto_answer_you?: boolean | null;
  };
}

/**
 * The draft a saved session opens with: everything it was set up with, and
 * the defaults for anything it wasn't (a session made before the setup was
 * kept has none of it, and opens as it always did).
 */
export function draftFromSession(saved: SavedSession | null | undefined, defaults: SessionDraft): SessionDraft {
  if (!saved) return defaults;
  const s = saved.setup ?? {};
  const pick = <T,>(v: T | null | undefined, fallback: T): T => (v === undefined || v === null ? fallback : v);
  return {
    ...defaults,
    title: saved.title ?? defaults.title,
    subtitle: saved.subtitle ?? defaults.subtitle,
    tags: saved.tags ?? defaults.tags,
    template: saved.mode || defaults.template,
    language: saved.language || defaults.language,
    cvId: s.cv_id === undefined ? defaults.cvId : s.cv_id,
    documentIds: pick(s.document_ids, defaults.documentIds),
    peopleIds: pick(s.people_ids, defaults.peopleIds ?? []),
    aiInstructions: pick(s.ai_instructions, defaults.aiInstructions),
    responseTone: pick(s.response_tone, defaults.responseTone),
    autoAnswer: pick(s.auto_answer, defaults.autoAnswer),
    autoAnswerYou: pick(s.auto_answer_you, pick(s.auto_answer, defaults.autoAnswerYou ?? defaults.autoAnswer)),
  };
}

/** What the session screen sends back when its setup changes. */
export function setupOf(state: {
  planId: number | null; cvId: number | null; documentIds: number[]; peopleIds: number[];
  aiInstructions: string; responseTone: string; autoAnswer: boolean; autoAnswerYou?: boolean;
}) {
  return {
    plan_id: state.planId, cv_id: state.cvId, document_ids: state.documentIds, people_ids: state.peopleIds,
    ai_instructions: state.aiInstructions, response_tone: state.responseTone, auto_answer: state.autoAnswer,
    ...(state.autoAnswerYou !== undefined ? { auto_answer_you: state.autoAnswerYou } : {}),
  };
}
