import { describe, expect, it } from "vitest";
import { parseReply } from "./CoachPanel";

const fence = "```";

describe("parseReply", () => {
  it("splits CUES / SHORT / FULL", () => {
    const r = parseReply("CUES:\n- one\n- two\n- three\n\nSHORT:\nShort answer.\n\nFULL:\nFull answer.");
    expect(r.cues).toEqual(["one", "two", "three"]);
    expect(r.short).toBe("Short answer.");
    expect(r.full).toBe("Full answer.");
  });

  it("does not treat header-like lines inside code as sections", () => {
    const r = parseReply(
      `CUES:\n- a\n\nSHORT:\nUse DP.\n\nFULL:\n${fence}python\nclass S:\n    full: int = 0\n    short: int = 1\n${fence}\n### Walkthrough\nDone.`,
    );
    expect(r.short).toBe("Use DP.");
    expect(r.full).toContain("short: int = 1");
    expect(r.full.endsWith("Done.")).toBe(true);
  });

  it("drops a trailing --- rule before the next heading", () => {
    const r = parseReply("SHORT:\nOpening line.\n\n---\n\nFULL:\nBody.");
    expect(r.short).toBe("Opening line.");
  });

  it("returns plain text as the full answer when there are no sections", () => {
    expect(parseReply("Just an answer.").full).toBe("Just an answer.");
  });

  it("keeps at most three cues", () => {
    expect(parseReply("CUES:\n- a\n- b\n- c\n- d\n\nSHORT:\nx").cues).toHaveLength(3);
  });
});
