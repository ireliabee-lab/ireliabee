import { describe, expect, it } from "vitest";
import { tagHint } from "../notebookApp";

// What hovering a source tag says. Ways it could mislead: a range read as one page, a time read as
// a page, the brackets left in.
describe("the hint over a source tag", () => {
  it("names one page, or a range or list of pages", () => {
    expect(tagHint("(p.2)")).toBe("Page 2 of the source · click to open it");
    expect(tagHint("(p.2–3)")).toBe("Pages 2–3 of the source · click to open them");
    expect(tagHint("(pp.4,6)")).toBe("Pages 4,6 of the source · click to open them");
  });

  it("says a time tag is a moment in the recording", () => {
    expect(tagHint("(0:18)")).toBe("Said at 0:18 · click to show where");
    expect(tagHint("(1:02:15)")).toBe("Said at 1:02:15 · click to show where");
  });
});
