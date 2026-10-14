import { describe, expect, it } from "vitest";
import { breathLines } from "./readAloud";
import { SENTENCE_MAX } from "../components/CompactOverlay";

const words = (s: string) => s.split(/\s+/);

describe("the overlay's lines fill the window", () => {
  it("breaks at the ends of sentences, not at every comma", () => {
    const text = "It gives me tools: signal processing, machine learning, data pipelines. I know the gap.";
    expect(breathLines(words(text), 20, { sentences: true }).map(l => l.join(" "))).toEqual([
      "It gives me tools:", "signal processing, machine learning, data pipelines.", "I know the gap.",
    ]);
  });

  it("a sentence stays on one line (the browser wraps it); only a runaway one is split", () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).concat("end.");
    expect(breathLines(long, SENTENCE_MAX, { sentences: true })).toHaveLength(1);
    const runaway = Array.from({ length: 90 }, (_, i) => `w${i}`);
    expect(breathLines(runaway, SENTENCE_MAX, { sentences: true }).length).toBeGreaterThan(1);
  });
});
