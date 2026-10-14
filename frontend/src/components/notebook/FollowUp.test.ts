import { describe, expect, it } from "vitest";
import { answerFrom } from "./FollowUp";

describe("follow-up answers", () => {
  it("say where they came from, and never pass iReliabee's words off as the author's", () => {
    expect(answerFrom({ from: "source", pages: [1, 2] })).toBe("From your source, p. 1, 2");
    expect(answerFrom({ from: "both", pages: [4] })).toBe("From your source (p. 4), with iReliabee's explanation");
    expect(answerFrom({ from: "general", pages: [] })).toBe("iReliabee's answer: not from your source");
  });

});
