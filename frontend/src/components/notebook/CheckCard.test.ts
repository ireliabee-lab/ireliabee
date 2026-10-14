import { describe, expect, it } from "vitest";
import { verdict } from "./CheckCard";

describe("checking your understanding", () => {
  it("says how it went in words, not a grade", () => {
    expect(verdict(100)).toBe("You've got it");
    expect(verdict(67)).toBe("Nearly there");
    expect(verdict(20)).toBe("Worth another look");
  });
});
