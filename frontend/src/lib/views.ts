import type { View } from "../components/Sidebar";

/**
 * Every navigation (sidebar, onboarding steps, `navigate` events) goes through
 * resolveView, so a screen that is merged into another keeps working from old
 * links: its id is listed here with the view (and optional section) that now
 * holds it. See docs/ROADMAP.md, Phase 1.
 */
export const VIEW_ALIASES: Record<string, { view: View; section?: string }> = {
  // 1.2 — per-session reports live in the session hub.
  confidence: { view: "history", section: "confidence" },
  notes:      { view: "history", section: "notes" },
  // 1.4 — practice screens are modes of Practice.
  mock:         { view: "practice", section: "mock" },
  drills:       { view: "practice", section: "explain" },
  presentation: { view: "practice", section: "script" },
  warmup:       { view: "practice", section: "warmup" },
  // 1.5 — a plan can be built from a meeting agenda.
  meetingprep:  { view: "plans", section: "agenda" },
  // 2.6 — people research lives beside plans.
  people:       { view: "plans", section: "people" },
  // 1.6 — who you are: profile, CV link and stories together.
  profiles:     { view: "about", section: "profile" },
  stories:      { view: "about", section: "stories" },
  // 1.7 — one library for your CV and reference files.
  cvs:          { view: "library", section: "cvs" },
  documents:    { view: "library", section: "docs" },
  // 1.8 — export / import lives in Settings → Your data.
  transfer:     { view: "settings", section: "data" },
  // Licence and plan live in Settings → Your plan.
  plan:         { view: "settings", section: "plan" },
};

const KNOWN_VIEWS: readonly View[] = [
  "session", "history", "progress", "practice", "notebook", "board",
  "plans", "about", "library", "settings", "research", "wordcraft", "write",
];

export interface Destination { view: View; section?: string }

/** Where an id (current or retired) should take the user. Unknown ids go home. */
export function resolveView(id: string): Destination {
  const alias = VIEW_ALIASES[id];
  if (alias) return alias;
  // A place inside the Notebook: "notebook:12" opens notebook 12, "notebook:read:7"
  // starts reading notes from Library document 7.
  if (id.startsWith("notebook:")) return { view: "notebook", section: id.slice("notebook:".length) || undefined };
  // One session in the session hub: "history:open:12".
  if (id.startsWith("history:")) return { view: "history", section: id.slice("history:".length) || undefined };
  // A Research tab: "research:terms".
  if (id.startsWith("research:")) return { view: "research", section: id.slice("research:".length) || undefined };
  // A writing project: "write:12".
  if (id.startsWith("write:")) return { view: "write", section: id.slice("write:".length) || undefined };
  // A Wordcraft tab: "wordcraft:map".
  if (id.startsWith("wordcraft:")) return { view: "wordcraft", section: id.slice("wordcraft:".length) || undefined };
  if ((KNOWN_VIEWS as readonly string[]).includes(id)) return { view: id as View };
  return { view: "session" };
}
