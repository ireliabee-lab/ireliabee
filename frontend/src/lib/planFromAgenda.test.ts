import { describe, expect, it } from "vitest";
import { planFromAgenda } from "./planFromAgenda";

const empty = { title: "", purpose: "", answers_prep: [] as string[], traps_avoid: [] as string[], notes: "" };
const prep = {
  likely_questions: ["Why is Q3 slipping?"],
  talking_points: ["Hiring freeze", "Vendor delay"],
  risks: ["Committing to a date"],
};

describe("planFromAgenda", () => {
  it("maps the prep into plan fields", () => {
    const p = planFromAgenda(empty, "1. Q3 roadmap review\n2. Budget", prep);
    expect(p.title).toBe("Q3 roadmap review");
    expect(p.answers_prep).toEqual(["Why is Q3 slipping?"]);
    expect(p.traps_avoid).toEqual(["Committing to a date"]);
    expect(p.notes).toBe("TALKING POINTS\n- Hiring freeze\n- Vendor delay\n\nAGENDA\n1. Q3 roadmap review\n2. Budget");
    expect(p.purpose).toBe("Prepared from the meeting agenda.");
  });

  it("keeps what the user already typed and adds to it", () => {
    const typed = { ...empty, title: "Board sync", purpose: "Get budget approved", answers_prep: ["Mine"], notes: "My note" };
    const p = planFromAgenda(typed, "Budget", prep);
    expect(p.title).toBe("Board sync");
    expect(p.purpose).toBe("Get budget approved");
    expect(p.answers_prep).toEqual(["Mine", "Why is Q3 slipping?"]);
    expect(p.notes.startsWith("My note\n\nTALKING POINTS")).toBe(true);
  });

  it("falls back to a generic title and skips empty talking points", () => {
    const p = planFromAgenda(empty, "   ", { likely_questions: [], talking_points: [], risks: [] });
    expect(p.title).toBe("Meeting");
    expect(p.notes).toBe("AGENDA\n");
  });
});
