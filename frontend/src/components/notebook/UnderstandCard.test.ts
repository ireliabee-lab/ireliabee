import { describe, expect, it } from "vitest";
import { noteLine, shiftLevel } from "./UnderstandCard";

describe("understanding a paragraph another way", () => {
  it("moves one step simpler or more technical, and stops at the ends", () => {
    expect(shiftLevel("some", -1)).toBe("new");
    expect(shiftLevel("some", 1)).toBe("expert");
    expect(shiftLevel("new", -1)).toBeNull();
    expect(shiftLevel("expert", 1)).toBeNull();
  });

  it("puts the answer under the paragraph as one line, labelled as iReliabee's", () => {
    expect(noteLine("steps", { plain: "1. It claims X.\n2. Because Y." })).toBe("Step by step (iReliabee's): 1. It claims X. 2. Because Y.");
    expect(noteLine("terms", { plain: "", terms: [{ term: "RuBisCO", meaning: "an enzyme", from: "source" }, { term: "ATP", meaning: "energy", from: "general" }] }))
      .toBe("Key terms (iReliabee's): RuBisCO: an enzyme; ATP: energy");
  });
});
