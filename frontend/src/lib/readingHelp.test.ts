import { describe, expect, it } from "vitest";
import { knownTerms, termAt } from "./readingHelp";
import type { NotebookDoc } from "./notebook";

const doc = {
  sections: [
    { title: "Glossary, in learning order", blocks: [
      { type: "definition", term: "enzyme", text: "A protein that speeds up a reaction.", src: [5] },
      { type: "definition", term: "RuBisCO", text: "The enzyme plants use to fix carbon.", src: [2] },
      { type: "definition", term: "Calvin cycle", text: "The steps that build sugar.", src: [3] },
    ] },
    { title: "Chapter 1", blocks: [{ type: "point", text: "RuBisCO is slow.", src: [2] }] },
  ],
} as unknown as NotebookDoc;

describe("help while reading: the term at the cursor", () => {
  const terms = knownTerms(doc);
  it("knows every defined term, longest first", () => {
    expect(terms.map(t => t.term)).toEqual(["Calvin cycle", "RuBisCO", "enzyme"]);
  });
  it("finds the term the cursor is on, whole words only, any case", () => {
    const line = "The calvin cycle needs RuBisCO, an enzyme.";
    expect(termAt(line, 6, terms)?.term).toBe("Calvin cycle");
    expect(termAt(line, 26, terms)?.term).toBe("RuBisCO");
    expect(termAt(line, 37, terms)?.term).toBe("enzyme");
    expect(termAt(line, 2, terms)).toBeNull();
    expect(termAt("enzymes everywhere", 3, terms)).toBeNull();
    expect(termAt("RuBisCO is slow.", 0, terms)?.term).toBe("RuBisCO");      // a line that starts with it
  });
  it("stays quiet on a term's own definition line", () => {
    expect(termAt("RuBisCO — The enzyme plants use to fix carbon.", 2, terms)).toBeNull();
    expect(termAt("RuBisCO — The enzyme plants use to fix carbon.", 16, terms)?.term).toBe("enzyme");
  });
});
