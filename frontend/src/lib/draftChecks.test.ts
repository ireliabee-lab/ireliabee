import { describe, expect, it } from "vitest";
import { checkDraft, ownWords, sentences, type DraftInput, type DraftSection } from "./draftChecks";

// Written down first (CLAUDE.md, Testing, rule 3). Ways reading a draft by rule can mislead:
// 1. sentences split at "et al.", "e.g.", "p. 12", decimals or initials;
// 2. the source's words inside a quotation counted against the writer;
// 3. a possessive "'s" taken for a contraction;
// 4. well-known abbreviations (UK, USA) flagged as undefined;
// 5. first person flagged where the genre allows it, or "i.e." and "US" taken for it;
// 6. citations typed by hand (Smith, 2020) missed, so a cited paragraph looks uncited;
// 7. a short quoted phrase counted as a quotation.

const sec = (id: number, key: string, body: string): DraftSection => ({ id, key, title: key, body, target: 0 });
const draft = (sections: DraftSection[], over: Partial<DraftInput> = {}): DraftInput =>
  ({ genre: "essay", firstPerson: false, wordLimit: 0, keyTerms: [], sections, ...over });
const find = (d: DraftInput, key: string) => checkDraft(d).find(f => f.key === key);

describe("reading a draft", () => {
  it("splits sentences only where they end", () => {
    expect(sentences("Smith et al. (2020) found a 2.5 times rise, e.g. in J. Kim's sample (p. 12). It held. Did it?"))
      .toEqual(["Smith et al. (2020) found a 2.5 times rise, e.g. in J. Kim's sample (p. 12).", "It held.", "Did it?"]);
  });

  it("leaves quotations and citation markers out of the writer's own words", () => {
    expect(ownWords('As Kim put it, "we don\'t know" [@kim2020].').replace(/\s+/g, " ").trim()).toBe("As Kim put it, .");
  });
});

describe("the checks", () => {
  it("finds contractions in the writer's words but not possessives or quoted speech", () => {
    const d = draft([sec(1, "body1", 'The model\'s accuracy rose. It doesn\'t generalise. One participant said "it isn\'t fair".')]);
    const f = find(d, "contractions");
    expect(f?.level).toBe("fix");
    expect(f?.title).toBe("Contractions: doesn't");
  });

  it("flags first person only where the genre is impersonal, and never i.e. or US", () => {
    const text = "We argue that policy matters, i.e. that US policy shapes outcomes. I agree.";
    expect(find(draft([sec(1, "body1", text)]), "first")?.title).toBe("First person: we, i");
    expect(find(draft([sec(1, "body1", text)], { firstPerson: true }), "first")).toBeUndefined();
    expect(find(draft([sec(1, "body1", "The US and the UK differ, i.e. in scale.")]), "first")?.level).toBe("ok");
  });

  it("asks for abbreviations to be defined, except well-known ones and those already defined", () => {
    const d = draft([sec(1, "body1", "Cognitive behavioural therapy (CBT) helps. CBT is used in the UK and USA. The SDQ was low.")]);
    expect(find(d, "abbr")?.title).toBe("Abbreviations to define: SDQ");
  });

  it("counts hand-typed author-date citations and markers as citing", () => {
    const d = draft([
      sec(1, "body1", "Timing shapes fluency (Kim, 2020). It varies by task."),
      sec(2, "body2", "Smith et al. (2019) disagree. Their sample was small."),
      sec(3, "body3", "Models now predict speech [@lecun2015]. They are large."),
      sec(4, "body1", "This is just asserted. Nobody is cited here."),
    ]);
    const f = find(d, "citations");
    expect(f?.title).toBe("1 body paragraph with no citation");
    expect(f?.where?.[0]?.sectionId).toBe(4);
  });

  it("counts only real quotations, not a quoted word or two", () => {
    const words = Array.from({ length: 160 }, (_, i) => `word${i}`).join(" ");
    const scare = draft([sec(1, "body1", `${words} the so-called "gold standard" was used.`)]);
    expect(find(scare, "quotes")?.title).toBe("Direct quotation: 0% of the words");
    const heavy = draft([sec(1, "body1", `${words} "${Array.from({ length: 30 }, () => "quoted").join(" ")}" (Kim, 2020, p. 3).`)]);
    expect(find(heavy, "quotes")?.level).toBe("fix");
  });

  it("checks the word limit within 10%, and every key term from the brief", () => {
    const body = Array.from({ length: 95 }, () => "remote").join(" ");
    const d = draft([sec(1, "body1", body)], { wordLimit: 100, keyTerms: ["remote", "wellbeing"] });
    expect(find(d, "limit")?.level).toBe("ok");
    expect(find(d, "terms")?.title).toBe("Key terms not used: wellbeing");
  });

  it("looks for a thesis statement and a conclusion that concludes without new sources", () => {
    const d = draft([
      sec(1, "intro", "Remote work is widespread. This essay argues that it helps wellbeing."),
      sec(2, "conclusion", "Overall, remote work helps, as Kim (2020) showed."),
    ]);
    expect(find(d, "thesis")?.level).toBe("ok");
    expect(find(d, "conclusion")?.title).toBe("The conclusion cites sources");
  });

  it("says so when there is nothing to check", () => {
    expect(checkDraft(draft([sec(1, "intro", "  ")]))[0]?.key).toBe("empty");
  });
});
