import { describe, expect, it } from "vitest";
import { mergeTerms, termFrom } from "./GlossaryCard";
import { knownTerms } from "../../lib/readingHelp";
import { markedRanges, setMarkedTerms } from "../../lib/book/pages";
import type { FoundTerm, NotebookDoc } from "../../lib/notebook";

const t = (term: string, from: FoundTerm["from"] = "general", pages: number[] = []): FoundTerm => ({ term, meaning: `${term} means…`, from, pages });

describe("the fuller glossary", () => {
  it("adds new terms once, keeping the first meaning", () => {
    expect(mergeTerms([t("TalkBank")], [t("talkbank"), t("lme4"), t("LME4")]).map(x => x.term)).toEqual(["TalkBank", "lme4"]);
  });

  it("says where a meaning came from, and a source claim without pages is iReliabee's", () => {
    expect(termFrom(t("x", "source", [2]))).toBe("From your source, p. 2");
    expect(termFrom(t("x", "source", []))).toBe("iReliabee's: not explained in your source");
    expect(termFrom(t("x", "general"))).toBe("iReliabee's: not explained in your source");
  });

  it("knows found terms as well as the notebook's own definitions, which win", () => {
    const doc = {
      title: "", summary: "", cues: [], board: {} as NotebookDoc["board"],
      sections: [{ id: "a", title: "A", src: [], blocks: [{ id: "b", type: "definition", term: "Surprisal", text: "The notes' meaning.", src: [1] }] }],
      terms: [t("surprisal"), t("TalkBank", "general")],
    } as unknown as NotebookDoc;
    const known = knownTerms(doc);
    expect(known.find(k => k.term === "Surprisal")?.meaning).toBe("The notes' meaning.");
    expect(known.find(k => k.term === "TalkBank")?.ours).toBe(true);
  });

  it("underlines whole terms on a line, longest first, through punctuation and possessives", () => {
    setMarkedTerms(["stuttering", "stuttering-like events", "TalkBank"]);
    expect(markedRanges(["surprisal", "predicts", "stuttering-like", "events", "more"])).toEqual([[2, 3]]);
    expect(markedRanges(["TalkBank's", "Ground", "Rules,", "stuttering."])).toEqual([[0, 0], [3, 3]]);
    expect(markedRanges(["stutter"])).toEqual([]);
    setMarkedTerms([]);
    expect(markedRanges(["stuttering"])).toEqual([]);
  });
});
