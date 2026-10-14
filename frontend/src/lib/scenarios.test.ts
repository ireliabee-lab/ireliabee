import { describe, expect, it } from "vitest";
import { SCENARIOS, SCENARIO_GROUPS, EXTRA_TEMPLATES } from "./scenarios";

// The backend's definitions, read as text: frontend and backend lists must match.
const backend = import.meta.glob(["../../../backend/scenarios.py", "../../../backend/core/templates.py"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const scenariosPy = Object.entries(backend).find(([k]) => k.endsWith("scenarios.py"))![1];
const templatesPy = Object.entries(backend).find(([k]) => k.endsWith("templates.py"))![1];

describe("scenarios (roadmap 2.4)", () => {
  it("every practice scenario exists in the backend, so the AI plays the right counterpart", () => {
    for (const s of SCENARIOS) expect(scenariosPy, s.id).toContain(`"${s.id}": {`);
  });

  it("every live-coach template a scenario or the session list uses exists in the backend", () => {
    const ids = [...SCENARIOS.map(s => s.template).filter(Boolean), ...EXTRA_TEMPLATES.map(t => t.id)] as string[];
    for (const id of ids) expect(templatesPy, id).toContain(`"${id}": {`);
  });

  it("covers the new student and work scenarios, each in a picker group", () => {
    const ids = SCENARIOS.map(s => s.id);
    for (const id of ["admission", "internship", "group", "review", "promotion", "feedback", "one_on_one", "support", "ielts", "toefl"]) {
      expect(ids).toContain(id);
    }
    const groups = SCENARIO_GROUPS.map(g => g.id);
    for (const s of SCENARIOS) expect(groups).toContain(s.group);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

import { ieltsRound, formatOverall } from "../components/ExamBands";

describe("speaking-test scores (roadmap 2.3)", () => {
  it("rounds the IELTS overall the way IELTS does", () => {
    expect(ieltsRound(6.25)).toBe(6.5);
    expect(ieltsRound(6.75)).toBe(7);
    expect(ieltsRound(6.1)).toBe(6);
  });

  it("shows IELTS as a band and TOEFL-style as points with an approximate /30", () => {
    const criteria = [{ key: "a", label: "A" }];
    expect(formatOverall({ name: "IELTS Speaking", scale: "band", max: 9, criteria }, 6.5, null)).toBe("Band 6.5");
    expect(formatOverall({ name: "IELTS Speaking", scale: "band", max: 9, criteria }, 7, null)).toBe("Band 7");
    expect(formatOverall({ name: "TOEFL-style", scale: "task", max: 4, criteria }, 3, 22)).toBe("3.0 / 4 · ≈ 22/30");
  });
});
