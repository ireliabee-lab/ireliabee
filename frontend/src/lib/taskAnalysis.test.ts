import { describe, expect, it } from "vitest";
import { analyseTask, checkQuestion, findDirections, findKeyTerms, findLimits, findRequirements, findWordLimit } from "./taskAnalysis";

// Written down first (CLAUDE.md, Testing, rule 3). Ways reading a brief can mislead:
// 1. a direction word found inside another word ("discussion" is not "discuss");
// 2. a phrase ("to what extent", "critically evaluate") missed, or counted twice with its last word;
// 3. the word limit misread from another number, a range or "approximately";
// 4. a requirement cut mid-sentence; 5. filler or task wording offered as key terms;
// 6. a yes/no question passed as a research question; 7. a question with no scope passed.

const BRIEF = "Critically evaluate the impact of remote work on employee wellbeing in the United Kingdom since 2020. " +
  "Your essay must draw on at least eight peer-reviewed sources. Use APA 7th referencing. " +
  "The essay should be approximately 2,000 words. Include a discussion of remote work policy.";

describe("reading a brief", () => {
  it("finds direction words whole, and phrases before their parts", () => {
    const found = findDirections(BRIEF);
    expect(found.map(d => d.text.toLowerCase())).toEqual(["critically evaluate"]);   // not "evaluate" again, not "discussion"
    expect(findDirections("To what extent does sleep shape memory? Discuss.").map(d => d.text)).toEqual(["To what extent", "Discuss"]);
    expect(found[0]?.meaning).toMatch(/judge/i);
  });

  it("reads the word limit, not other numbers, and takes the top of a range", () => {
    expect(findWordLimit(BRIEF)).toBe(2000);
    expect(findWordLimit("Write 1500-2000 words on two case studies from 2019.")).toBe(2000);
    expect(findWordLimit("A 3000-word report.")).toBe(3000);
    expect(findWordLimit("Use at least 8 sources published since 2015.")).toBeNull();
  });

  it("finds the limits: the period, the place and the number of sources", () => {
    const limits = findLimits(BRIEF).map(l => l.text);
    expect(limits).toEqual(expect.arrayContaining(["in the United Kingdom", "since 2020"]));
    expect(limits.some(l => /at least eight peer-reviewed/.test(l))).toBe(true);
  });

  it("keeps each requirement as a whole sentence", () => {
    expect(findRequirements(BRIEF)).toEqual([
      "Your essay must draw on at least eight peer-reviewed sources.",
      "Use APA 7th referencing.",
      "The essay should be approximately 2,000 words.",
      "Include a discussion of remote work policy.",
    ]);
  });

  it("offers content words as key terms, never filler, task wording or direction words", () => {
    const terms = findKeyTerms(BRIEF).map(t => t.toLowerCase());
    expect(terms[0]).toBe("remote work");   // a pair that keeps appearing together is one term
    expect(terms).toEqual(expect.arrayContaining(["wellbeing", "employee", "policy"]));
    for (const w of ["essay", "words", "evaluate", "critically", "should", "sources", "apa", "discussion", "remote", "work"]) expect(terms).not.toContain(w);
  });

  it("puts it together", () => {
    const a = analyseTask(BRIEF);
    expect(a.wordLimit).toBe(2000);
    expect(a.directions).toHaveLength(1);
  });
});

describe("checking a research question", () => {
  const ok = (text: string) => Object.fromEntries(checkQuestion(text).map(c => [c.key, c.ok]));

  it("passes a good question with its purpose", () => {
    expect(ok("To what extent does speech timing predict fluency among adults who stutter in Ghana?\nThe purpose of this study is to inform therapy."))
      .toEqual({ question: true, open: true, count: true, scope: true, length: true, purpose: true });
  });

  it("catches a yes/no question and a 'how many' question", () => {
    expect(ok("Does remote work affect wellbeing among employees in the UK?").open).toBe(false);
    expect(ok("How many students in Accra use AI tools for essays?").count).toBe(false);
  });

  it("catches a question with no scope, or no question mark", () => {
    const vague = ok("Why does motivation matter for learning");
    expect(vague.question).toBe(false);
    expect(vague.scope).toBe(false);
    expect(vague.purpose).toBe(false);
  });
});
