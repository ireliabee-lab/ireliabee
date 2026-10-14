import { describe, expect, it } from "vitest";
import { checklist } from "./NotesPanel";

describe("recap checklist", () => {
  it("lists each action with its owner and due date, ready to paste", () => {
    expect(checklist([
      { who: "You", what: "Send the rollout plan", due: "Friday" },
      { who: "Priya", what: "Review the migration", due: "" },
    ])).toBe("- [ ] Send the rollout plan — You (due Friday)\n- [ ] Review the migration — Priya");
  });
});
