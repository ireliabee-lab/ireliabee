import { describe, expect, it } from "vitest";
import { provenance } from "./ExplainCard";

describe("where an explanation came from", () => {
  it("names the source's pages, and never passes iReliabee's words off as the author's", () => {
    expect(provenance({ from: "source", pages: [1, 2] })).toBe("From your source, p. 1, 2");
    expect(provenance({ from: "both", pages: [5] })).toBe("From your source (p. 5), with iReliabee's explanation");
    expect(provenance({ from: "general", pages: [] })).toBe("iReliabee's explanation: your source doesn't explain this");
  });
});
