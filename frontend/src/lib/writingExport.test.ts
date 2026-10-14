import { describe, expect, it } from "vitest";
import type { Ref } from "./citations";
import { buildDocument, fileName, toDocx, toMarkdown } from "./writingExport";

// Written down first (CLAUDE.md, Testing, rule 3). Ways an export can go wrong:
// 1. a citation with no source vanishes instead of staying visible and being reported;
// 2. an essay exported with section headings, or a paper without them;
// 3. sources never cited listed as references; MLA's list headed "References";
// 4. empty sections exported as empty headings; paragraph breaks lost;
// 5. a file name with characters a file system refuses; 6. a .docx that isn't a .docx.

const REFS: Ref[] = [{
  id: 1, key: "kim2020", doi: "", document_id: null, note: "",
  item: { type: "book", title: "Speech motor control", publisher: "Oxford University Press", author: [{ family: "Kim", given: "Ji-Hoon" }], issued: { "date-parts": [[2020]] } },
}, {
  id: 2, key: "unused2019", doi: "", document_id: null, note: "",
  item: { type: "webpage", title: "Never cited", URL: "https://example.org", issued: { "date-parts": [[2019]] } },
}];

const PAPER = {
  title: "Speech timing", style: "apa",
  sections: [
    { title: "Introduction", body: "Timing matters [@kim2020].\n\nSecond paragraph [@nobody2001]." },
    { title: "Methods", body: "   " },
    { title: "Discussion", body: "It held." },
  ],
};

// citeproc-js and the style files load on first use: slow when the whole suite runs at once.
describe("building the export", { timeout: 30_000 }, () => {
  it("formats citations, keeps paragraphs, skips empty sections and reports unknown keys", async () => {
    const d = await buildDocument(PAPER, REFS, true);
    expect(d.sections.map(s => s.title)).toEqual(["Introduction", "Discussion"]);
    expect(d.sections[0]?.paragraphs).toEqual(["Timing matters (Kim, 2020).", "Second paragraph [@nobody2001]."]);
    expect(d.unknown).toEqual(["nobody2001"]);
    expect(d.references).toHaveLength(1);
    expect(d.references[0]).toContain("Speech motor control");
    expect(d.hanging).toBe(true);
    expect(d.doubleSpaced).toBe(true);
  });

  it("lists no references when nothing real is cited, and heads MLA's list Works Cited", async () => {
    const none = await buildDocument({ ...PAPER, sections: [{ title: "Intro", body: "Nothing cited [@nobody2001]." }] }, REFS, true);
    expect(none.references).toEqual([]);
    const mla = await buildDocument(PAPER, REFS, true);
    expect(mla.referencesTitle).toBe("References");
    expect((await buildDocument({ ...PAPER, style: "mla" }, REFS, true)).referencesTitle).toBe("Works Cited");
    const ieee = await buildDocument({ ...PAPER, style: "ieee" }, REFS, true);
    expect(ieee.hanging).toBe(false);
    expect(ieee.sections[0]?.paragraphs[0]).toBe("Timing matters [1].");
  });

  it("writes Markdown with or without section headings", async () => {
    const paper = toMarkdown(await buildDocument(PAPER, REFS, true));
    expect(paper).toContain("## Introduction\n\nTiming matters (Kim, 2020).\n\nSecond paragraph");
    expect(paper).toContain("## References\n\nKim, J.-H. (2020).");
    const essay = toMarkdown(await buildDocument(PAPER, REFS, false));
    expect(essay).not.toContain("## Introduction");
    expect(essay.startsWith("# Speech timing\n\nTiming matters")).toBe(true);
  });

  it("makes a real .docx", async () => {
    const blob = await toDocx(await buildDocument(PAPER, REFS, true));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe("PK");   // a .docx is a zip
    expect(bytes.length).toBeGreaterThan(3000);
  }, 30_000);

  it("names the file safely", () => {
    expect(fileName('Speech: "timing"/fluency?', "docx")).toBe("Speech timingfluency.docx");
    expect(fileName("  ", "pdf")).toBe("writing.pdf");
    expect(fileName("Café in Kraków", "md")).toBe("Cafe in Krakow.md");
  });
});
