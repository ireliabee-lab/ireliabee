import { describe, expect, it } from "vitest";
import { depths } from "./IdeasMap";

describe("the map of ideas", () => {
  it("puts the basics in the first column and what builds on them after", () => {
    const d = depths([
      { term: "p-value", builds_on: ["null hypothesis", "probability"] },
      { term: "null hypothesis", builds_on: ["probability"] },
      { term: "probability", builds_on: [] },
      { term: "effect size", builds_on: [] },
    ]);
    expect(Object.fromEntries(d)).toEqual({ probability: 0, "null hypothesis": 1, "p-value": 2, "effect size": 0 });
  });
  it("survives a loop and a term that isn't in the list", () => {
    const d = depths([{ term: "a", builds_on: ["b", "zzz"] }, { term: "b", builds_on: ["a"] }]);
    expect([...d.keys()].sort()).toEqual(["a", "b"]);
  });
});
