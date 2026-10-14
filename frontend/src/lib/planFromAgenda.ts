/** What the meeting-prep generator returns for an agenda (backend/meeting_prep.py). */
export interface AgendaPrep {
  likely_questions: string[];
  talking_points: string[];
  risks: string[];
}

interface PlanFields {
  title: string;
  purpose: string;
  answers_prep: string[];
  traps_avoid: string[];
  notes: string;
}

/**
 * Merge an agenda's prep into a plan being edited (roadmap 1.5): likely
 * questions become answers to prepare, risks become traps to avoid, talking
 * points and the agenda go into notes. What the user already typed is kept.
 */
export function planFromAgenda<P extends PlanFields>(plan: P, agenda: string, prep: AgendaPrep): P {
  const firstLine = agenda.trim().split("\n")[0].replace(/^[-*•\d.)\s]+/, "").trim();
  const talking = prep.talking_points.map(p => `- ${p}`).join("\n");
  return {
    ...plan,
    title: plan.title.trim() || firstLine.slice(0, 60) || "Meeting",
    purpose: plan.purpose || "Prepared from the meeting agenda.",
    answers_prep: [...plan.answers_prep, ...prep.likely_questions],
    traps_avoid: [...plan.traps_avoid, ...prep.risks],
    notes: [plan.notes, talking && `TALKING POINTS\n${talking}`, `AGENDA\n${agenda.trim()}`].filter(Boolean).join("\n\n"),
  };
}
