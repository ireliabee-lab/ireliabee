import { describe, expect, it } from "vitest";
import { QUESTION_WINDOW_MS, screenContext } from "./screenContext";

const NOW = 1_000_000;

describe("what a live screenshot is about", () => {
  it("takes the other side's latest question, not the user's own words", () => {
    const c = screenContext([
      { speaker: "interviewer", transcript: "[INTERVIEWER] Here is the quarterly view.", ts: NOW - 30_000 },
      { speaker: "interviewer", transcript: "Why does revenue dip in Q3?", ts: NOW - 10_000 },
      { speaker: "user", transcript: "Let me look at that.", ts: NOW - 5_000 },
    ], NOW);
    expect(c.theirQuestion).toBe("Why does revenue dip in Q3?");
    expect(c.conversation.map(l => l.speaker)).toEqual(["them", "them", "you"]);
    expect(c.conversation[0].text).toBe("Here is the quarterly view.");
  });

  it("ignores a question asked too long ago, or too short to be one", () => {
    expect(screenContext([{ speaker: "interviewer", transcript: "Why the dip?", ts: NOW - QUESTION_WINDOW_MS - 1 }], NOW).theirQuestion).toBeNull();
    expect(screenContext([{ speaker: "interviewer", transcript: "Okay.", ts: NOW }], NOW).theirQuestion).toBeNull();
  });

  it("prefers their latest question over a remark made after it", () => {
    const c = screenContext([
      { speaker: "interviewer", transcript: "Why does revenue dip in Q3?", ts: NOW - 20_000 },
      { speaker: "interviewer", transcript: "As you can see on the chart here.", ts: NOW - 10_000 },
    ], NOW);
    expect(c.theirQuestion).toBe("Why does revenue dip in Q3?");
  });

  it("says which turn the question came from", () => {
    const c = screenContext([
      { id: 7, speaker: "interviewer", transcript: "Why does revenue dip in Q3?", ts: NOW - 20_000 },
      { id: 8, speaker: "user", transcript: "Let me look.", ts: NOW - 10_000 },
    ], NOW);
    expect(c.questionId).toBe(7);
  });

  it("only counts a whole question word, not a name that starts like one", () => {
    const c = screenContext([
      { speaker: "interviewer", transcript: "How do the margins compare", ts: NOW - 20_000 },
      { speaker: "interviewer", transcript: "Isabel's team built this chart.", ts: NOW - 10_000 },
    ], NOW);
    expect(c.theirQuestion).toBe("How do the margins compare");
  });

  it("uses their latest line when nothing reads as a question", () => {
    expect(screenContext([{ speaker: "interviewer", transcript: "Walk me through this slide", ts: NOW }], NOW).theirQuestion)
      .toBe("Walk me through this slide");
  });

  it("never answers a question with no time on it, as loaded from a saved session", () => {
    const c = screenContext([{ speaker: "interviewer", transcript: "Why does revenue dip in Q3?" }], NOW);
    expect(c.theirQuestion).toBeNull();
    expect(c.conversation).toHaveLength(1);   // still context
  });

  it("leaves earlier screenshots and pictures out of what was said", () => {
    const c = screenContext([
      { speaker: "user", transcript: "[SCREEN] Zoom — Answering: x", ts: NOW, screenshot: "data:" },
      { speaker: "user", transcript: "[IMAGE] slide.png", ts: NOW },
    ], NOW);
    expect(c).toEqual({ theirQuestion: null, questionId: null, conversation: [] });
  });

  it("sends at most the last twelve lines", () => {
    const turns = Array.from({ length: 30 }, (_, i) => ({ speaker: "user" as const, transcript: `line ${i}`, ts: NOW }));
    const c = screenContext(turns, NOW);
    expect(c.conversation).toHaveLength(12);
    expect(c.conversation[11].text).toBe("line 29");
  });
});
