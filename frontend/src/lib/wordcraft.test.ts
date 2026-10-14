import { describe, expect, it } from "vitest";
import { acceptedAnswers, countWords, matches, normalizeAnswer, scramble, splitHighlights, highlightTerms, type Drill } from "./wordcraft";

describe("Wordcraft answer checking", () => {
  it("ignores case, punctuation, spacing and curly quotes", () => {
    expect(normalizeAnswer("  Where  do you LIVE? ")).toBe("where do you live");
    expect(matches("I’m tired, but I finished.", ["I am tired but I finished"])).toBe(true);
  });

  it("treats contractions and their long forms as the same", () => {
    expect(matches("I've finished the report", ["I have finished the report."])).toBe(true);
    expect(matches("She doesn't like it", ["She does not like it."])).toBe(true);
    expect(matches("I can't come", ["I cannot come."])).toBe(true);
    expect(matches("I can not come", ["I can't come."])).toBe(true);
    expect(matches("It's late", ["It is late."])).toBe(true);
  });

  it("still tells different sentences apart", () => {
    expect(matches("He go to work", ["He goes to work."])).toBe(false);
    expect(matches("", ["Anything"])).toBe(false);
  });

  it("collects every accepted answer for typed drills", () => {
    const fix: Drill = { type: "fix", sentence: "He go.", answer: "He goes.", accept: ["He went."], hint: "", why: "" };
    const join: Drill = { type: "join", parts: ["a", "b"], answers: ["x", "y"], hint: "", why: "" };
    expect(acceptedAnswers(fix)).toEqual(["He goes.", "He went."]);
    expect(acceptedAnswers(join)).toEqual(["x", "y"]);
  });
});

describe("Wordcraft order drills", () => {
  it("shuffles the words, never into the answer, and keeps the end mark apart", () => {
    const { tiles, end } = scramble("Where do you live?", 3);
    expect(end).toBe("?");
    expect([...tiles].sort()).toEqual(["Where", "do", "live", "you"].sort());
    expect(tiles.join(" ")).not.toBe("Where do you live");
    expect(scramble("Where do you live?", 3)).toEqual({ tiles, end });      // the same every time
  });
});

describe("Wordcraft passages", () => {
  it("highlights the lesson's words and phrases, longest first, as whole words", () => {
    const terms = highlightTerms([{ text: "market", kind: "word" }, { text: "How much is it?", kind: "phrase" }, { text: "___ is ___", kind: "pattern" }]);
    expect(terms).toEqual(["How much is it", "market"]);
    const runs = splitHighlights("At the market: how much is it? Supermarket prices differ.", terms);
    expect(runs.filter(r => r.hit).map(r => r.text)).toEqual(["market", "how much is it"]);
  });

  it("counts words", () => {
    expect(countWords("  one two-three it's ")).toBe(3);
  });
});
