import { describe, expect, it } from "vitest";
import { shownLine, translationCostLine } from "./transcriptTranslation";

const tr = { language: "en", total: 2, done: 1, lines: { "7": "Hello, tell me about yourself." } };

describe("a saved transcript read in another language", () => {
  it("shows the translation first and keeps the words as said under it", () => {
    expect(shownLine(7, "Bonjour, parlez-moi de vous.", tr))
      .toEqual({ text: "Hello, tell me about yourself.", original: "Bonjour, parlez-moi de vous." });
  });

  it("falls back to the words as said when a line has no translation", () => {
    expect(shownLine(8, "Je dirige une équipe.", tr)).toEqual({ text: "Je dirige une équipe.", original: null });
    expect(shownLine(undefined, "x", tr)).toEqual({ text: "x", original: null });
    expect(shownLine(7, "x", null)).toEqual({ text: "x", original: null });
  });

  it("says what translating costs, never a guessed price", () => {
    expect(translationCostLine({ lines: 40, credits: 0.32 }, false)).toBe("Translating 40 lines uses about 0.32 credits.");
    expect(translationCostLine({ lines: 3, credits: 0.01 }, false)).toBe("Translating 3 lines uses under 0.1 credits.");
    expect(translationCostLine({ lines: 3, credits: null }, false)).toBe("Translating 3 lines uses a few credits.");
    expect(translationCostLine({ lines: 3, credits: 0.5 }, true)).toMatch(/own AI assistant: no credits used/);
  });
});
