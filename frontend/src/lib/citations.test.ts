import { describe, expect, it } from "vitest";
import { findMarkers, formatDocument, insertCitation, markerFor, type Ref } from "./citations";

// Written down first (CLAUDE.md, Testing, rule 3). Ways citing can go wrong:
// 1. a marker's page, or a second source in it, misread; a bracket that isn't a citation taken for one;
// 2. a style not applied (APA author-date, IEEE numbers) or a page lost;
// 3. numbered styles numbering by list order instead of first citation, across sections;
// 4. a key with no source silently dropped instead of left visible and reported;
// 5. the reference list listing sources never cited, or empty when nothing is cited yet.

const ref = (id: number, key: string, item: Ref["item"]): Ref => ({ id, key, item, doi: "", document_id: null, note: "" });
const REFS: Ref[] = [
  ref(1, "lecun2015", { type: "article-journal", title: "Deep learning", "container-title": "Nature", volume: "521", page: "436-444",
    author: [{ family: "LeCun", given: "Yann" }, { family: "Bengio", given: "Yoshua" }], issued: { "date-parts": [[2015]] } }),
  ref(2, "kim2020", { type: "book", title: "Speech motor control", publisher: "Oxford University Press",
    author: [{ family: "Kim", given: "Ji-Hoon" }], issued: { "date-parts": [[2020]] } }),
  ref(3, "unused2019", { type: "webpage", title: "Never cited", URL: "https://example.org", issued: { "date-parts": [[2019]] } }),
];

describe("citation markers", () => {
  it("reads sources, pages and other locators, and ignores brackets that aren't citations", () => {
    const text = "As shown [@lecun2015, p. 12] and [@kim2020; @lecun2015, ch. 3]. See [the appendix] and [@ bad].";
    expect(findMarkers(text).map(m => m.items)).toEqual([
      [{ key: "lecun2015", locator: "12", label: "page" }],
      [{ key: "kim2020" }, { key: "lecun2015", locator: "3", label: "chapter" }],
    ]);
    expect(markerFor("kim2020", "45")).toBe("[@kim2020, p. 45]");
    expect(markerFor("kim2020")).toBe("[@kim2020]");
  });
});

describe("inserting a citation", () => {
  it("goes inside the sentence when the cursor is after its full stop, and keeps a space before it", () => {
    expect(insertCitation("Models are good.", 16, "[@x]")).toEqual({ text: "Models are good [@x].", caret: 20 });
    expect(insertCitation("As \"good.\" ", 12, "[@x]").text).toBe("As \"good [@x].\" ");
    expect(insertCitation("Models are good", 15, "[@x]").text).toBe("Models are good [@x]");
    expect(insertCitation("Mid sentence here", 3, "[@x]").text).toBe("Mid [@x] sentence here");
    expect(insertCitation("", 0, "[@x]")).toEqual({ text: "[@x]", caret: 4 });
  });
});

// citeproc-js and the style files load on first use: slow when the whole suite runs at once.
describe("formatting a document", { timeout: 30_000 }, () => {
  it("writes APA author-date citations with pages, and an APA reference list of what is cited", async () => {
    const doc = await formatDocument(["Timing matters [@lecun2015, p. 12].", "Control is learned [@kim2020]."], REFS, "apa");
    expect(doc.texts[0]).toBe("Timing matters (LeCun & Bengio, 2015, p. 12).");
    expect(doc.texts[1]).toBe("Control is learned (Kim, 2020).");
    expect(doc.bibliography).toHaveLength(2);
    expect(doc.bibliography[0]).toMatch(/^Kim, J\.-H\. \(2020\)\. Speech motor control\. Oxford University Press\.$/);
    expect(doc.bibliography[1]).toMatch(/^LeCun, Y\., & Bengio, Y\. \(2015\)\. Deep learning\. Nature, 521, 436–444\.$/);
    expect(doc.uncited).toEqual(["unused2019"]);
  });

  it("numbers IEEE citations by first citation across sections", async () => {
    const doc = await formatDocument(["First [@kim2020].", "Then [@lecun2015] and again [@kim2020]."], REFS, "ieee");
    expect(doc.texts).toEqual(["First [1].", "Then [2] and again [1]."]);
    expect(doc.bibliography[0]).toMatch(/^\[1\]/);
    expect(doc.bibliography[0]).toContain("Speech motor control");
  });

  it("leaves a key with no source visible and reports it", async () => {
    const doc = await formatDocument(["Claimed [@nobody2001] and [@kim2020]."], REFS, "harvard");
    expect(doc.texts[0]).toContain("[@nobody2001]");
    expect(doc.texts[0]).toContain("Kim, 2020");
    expect(doc.unknown).toEqual(["nobody2001"]);
  });

  it("lists every source while nothing is cited yet", async () => {
    const doc = await formatDocument(["No citations yet."], REFS, "mla");
    expect(doc.bibliography).toHaveLength(3);
  });

  it("formats every style without failing", async () => {
    for (const style of ["apa", "harvard", "ieee", "vancouver", "mla", "chicago"]) {
      const doc = await formatDocument(["See [@lecun2015, p. 2]."], REFS, style);
      expect(doc.texts[0], style).not.toContain("@lecun2015");
      expect(doc.bibliography.length, style).toBe(1);
    }
  }, 30_000);   // six style files to load: slow when the whole suite runs at once
});
