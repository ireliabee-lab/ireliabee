import { describe, expect, it } from "vitest";
import { PERSONAS } from "./persona";
import { EXTRA_TEMPLATES, SCENARIOS } from "./scenarios";

// Live-coach templates offered in the app (App.tsx TEMPLATES = these core ids + EXTRA_TEMPLATES).
const TEMPLATE_IDS = [
  "general", "tech-interview", "academic-phd", "product-management", "sales-discovery", "medical-residency",
  ...EXTRA_TEMPLATES.map(t => t.id),
];

describe("personas", () => {
  it("covers the four onboarding choices, matching the backend's list", () => {
    expect(PERSONAS.map(p => p.id)).toEqual(["student", "job-seeker", "professional", "other"]);
  });

  it("point at templates and practice scenarios that exist", () => {
    for (const p of PERSONAS) {
      expect(TEMPLATE_IDS).toContain(p.template);
      expect(SCENARIOS.map(s => s.id)).toContain(p.practiceScenario);
    }
  });
});
