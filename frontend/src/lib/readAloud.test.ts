import { describe, expect, it } from "vitest";
import { breathLines, readUpTo, secondsLeft, wordsOf } from "./readAloud";

/** How far through the answer the marker is, as a word count. */
const read = (heard: string, answer: string) => readUpTo(heard, wordsOf(answer));

const ANSWER =
  "I led a team of five engineers through the migration. We cut the build time in half, "
  + "and nobody lost a day of work.";

describe("Reading along", () => {
  it("nothing said, nothing marked", () => {
    expect(read("", ANSWER)).toBe(0);
    expect(read("   ", ANSWER)).toBe(0);
  });

  it("follows the words as they are read out", () => {
    expect(read("I led", ANSWER)).toBe(2);
    expect(read("I led a team", ANSWER)).toBe(4);
    expect(read("I led a team of five engineers", ANSWER)).toBe(7);
  });

  it("reaches the end when the whole answer has been said", () => {
    expect(read(ANSWER, ANSWER)).toBe(wordsOf(ANSWER).length);
  });

  it("ignores the ums and ers between the words", () => {
    expect(read("I led, um, a team erm of five", ANSWER)).toBe(6);
  });

  it("keeps up when a word is skipped or misheard", () => {
    // "of" never reaches the transcript; the marker steps over it.
    expect(read("I led a team five engineers", ANSWER)).toBe(7);
  });

  it("keeps up through a paraphrase — nobody reads it word for word", () => {
    expect(read("So I actually led a small team of five brilliant engineers", ANSWER)).toBe(7);
  });

  it("counts an ending as the same word", () => {
    // "engineer" for "engineers", "migrations" for "migration".
    expect(read("I led a team of five engineer through the migrations", ANSWER)).toBe(10);
  });

  it("says five for 5 and 5 for five", () => {
    expect(read("I led a team of 5", ANSWER)).toBe(6);
    expect(readUpTo("I hired five people", wordsOf("I hired 5 people"))).toBe(4);
  });

  it("does not race ahead on a word that appears everywhere", () => {
    // "the" is in the answer three times; hearing it alone proves nothing.
    expect(read("the", ANSWER)).toBe(0);
    expect(read("well, the thing is", ANSWER)).toBe(0);
  });

  it("stays put when what is heard is not the answer at all", () => {
    expect(read("could you tell me about a difficult project", ANSWER)).toBe(0);
  });

  it("does not go backwards when a phrase is repeated", () => {
    expect(read("I led a team — sorry — I led a team of five", ANSWER)).toBe(6);
  });

  it("holds its place through an interruption mid-answer", () => {
    const heard = "I led a team of five engineers through the migration sorry go on yes "
      + "we cut the build time in half";
    expect(read(heard, ANSWER)).toBe(17);   // up to "half", the interruption ignored
  });

  it("an apostrophe is not a different word", () => {
    expect(readUpTo("we don't do that", wordsOf("We dont do that"))).toBe(4);
    expect(readUpTo("we dont do that", wordsOf("We don't do that"))).toBe(4);
  });
});

describe("Breath lines", () => {
  const lines = (text: string, max?: number) => breathLines(wordsOf(text), max).map(l => l.join(" "));

  it("breaks where the punctuation already asks for a breath", () => {
    expect(lines("We shipped it, and nobody noticed.")).toEqual(["We shipped it,", "and nobody noticed."]);
  });

  it("never leaves a line too long to say in one breath", () => {
    for (const line of breathLines(wordsOf(ANSWER), 7)) expect(line.length).toBeLessThanOrEqual(7);
  });

  it("splits a long clause evenly instead of stranding one word", () => {
    // Nine words at seven a line is 5 + 4, not 7 + 2.
    expect(lines("one two three four five six seven eight nine", 7))
      .toEqual(["one two three four five", "six seven eight nine"]);
  });

  it("keeps every word, in order", () => {
    expect(breathLines(wordsOf(ANSWER), 7).flat()).toEqual(wordsOf(ANSWER));
  });

  it("does not break on an initial or an abbreviation", () => {
    // No breath after "J.", "R." or "e.g." — so it is one clause, split evenly.
    expect(lines("I worked with J. R. on the e.g. case study"))
      .toEqual(["I worked with J. R.", "on the e.g. case study"]);
  });

  it("has nothing to show for an empty answer", () => {
    expect(breathLines([], 7)).toEqual([]);
  });
});

describe("Time left", () => {
  it("uses the pace the user is actually speaking at", () => {
    expect(secondsLeft(100, 100)).toBe(60);
    expect(secondsLeft(100, 200)).toBe(30);
  });

  it("falls back to a normal speaking pace when there is no measurement", () => {
    expect(secondsLeft(140, null)).toBe(60);
    expect(secondsLeft(140, 3)).toBe(60);       // a nonsense reading is not a pace
  });

  it("is zero at the end", () => {
    expect(secondsLeft(0, 150)).toBe(0);
  });
});
