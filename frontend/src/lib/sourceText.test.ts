import { describe, expect, it } from "vitest";
import { printedLines, textBands } from "./sourceText";

// How the Text view lays out a page. Ways it could go wrong: a PDF's printed lines spaced apart
// as if each were a paragraph (it read as double-spaced); a transcript's paragraphs run together;
// a band split loses or repeats a paragraph.
describe("the source panel's Text view", () => {
  it("keeps a PDF's printed lines together and spaces a transcript's paragraphs", () => {
    const pdf = ["Spaced repetition means returning to the same material after growing gaps: a day, then",
      "three days, then a week. Spaced repetition builds on the forgetting curve: each review",
      "comes just before the memory fades.", "6"].join("\n");
    expect(printedLines(pdf)).toBe(true);
    const transcript = Array.from({ length: 4 }, (_, i) => `Paragraph ${i}. ` + "and then we talked about the memo at length ".repeat(8)).join("\n");
    expect(printedLines(transcript)).toBe(false);
    expect(printedLines("One short line.\nAnother.")).toBe(false);   // too little to tell: paragraphs
  });

  it("groups paragraphs into bands without losing or repeating one", () => {
    const paras = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ` + "x".repeat(500));
    const bands = textBands(paras.join("\n"), 2400);
    expect(bands.length).toBeGreaterThan(1);
    expect(bands.flat()).toEqual(paras);
    expect(textBands(paras.join("\n"), Infinity)).toEqual([paras]);
  });
});
