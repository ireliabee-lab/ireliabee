// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  RUNAWAY_LIMIT, RUNAWAY_WINDOW_MS, decide, enqueue, latest, pausesAutoAnswer, remember, without,
} from "./autoAnswer";

const now = 10_000_000;

describe("Auto Answer", () => {
  it("Off keeps a finished turn waiting — nothing is sent", () => {
    // The bug a live test showed: Off sent every turn anyway.
    expect(decide({ enabled: false, paused: false, now, recent: [] })).toBe("wait");
  });

  it("Off stays off however quiet it has been", () => {
    expect(decide({ enabled: false, paused: false, now: now * 9, recent: [] })).toBe("wait");
  });

  it("On sends a finished turn straight away", () => {
    expect(decide({ enabled: true, paused: false, now, recent: [] })).toBe("send");
  });

  it("On sends every turn of a busy, real conversation", () => {
    // A fast interview: a finished turn every 10 seconds for five minutes.
    const recent = Array.from({ length: 30 }, (_, i) => now - i * 10_000);
    expect(decide({ enabled: true, paused: false, now, recent })).toBe("send");
  });

  it("pauses instead of spending when answers come faster than any conversation", () => {
    const recent = Array.from({ length: RUNAWAY_LIMIT }, (_, i) => now - i * 5_000);
    expect(decide({ enabled: true, paused: false, now, recent })).toBe("pause");
  });

  it("while paused, turns wait rather than send", () => {
    expect(decide({ enabled: true, paused: true, now, recent: [] })).toBe("wait");
  });

  it("forgets answers older than the window", () => {
    const old = Array.from({ length: 100 }, (_, i) => now - RUNAWAY_WINDOW_MS - i * 1000);
    expect(decide({ enabled: true, paused: false, now, recent: old })).toBe("send");
  });

  it("remember keeps only the window, so the list cannot grow for ever", () => {
    const kept = remember([now - RUNAWAY_WINDOW_MS - 1, now - 1000], now);
    expect(kept).toEqual([now - 1000, now]);
  });
});

describe("the waiting list", () => {
  const a = { id: 1, speaker: "interviewer" as const, text: "Tell me about" };

  it("keeps every waiting question, not only the last", () => {
    const list = enqueue(enqueue([], a), { id: 2, speaker: "interviewer", text: "And why?" });
    expect(list.map(t => t.id)).toEqual([1, 2]);
  });

  it("a turn that grew replaces itself instead of waiting twice", () => {
    const list = enqueue(enqueue([], a), { ...a, text: "Tell me about a time you failed?" });
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe("Tell me about a time you failed?");
  });

  it("Answer and R take the most recent", () => {
    const list = enqueue(enqueue([], a), { id: 2, speaker: "interviewer", text: "And why?" });
    expect(latest(list)?.id).toBe(2);
    expect(latest([])).toBeNull();
  });

  it("an answered turn leaves the list", () => {
    expect(without(enqueue([], a), 1)).toEqual([]);
  });
});

describe("pausesAutoAnswer (audit 180-M11)", () => {
  it("pauses on errors every later turn would repeat", () => {
    for (const code of ["out_of_credits", "signed_out", "daily_limit", "rate_limited"]) {
      expect(pausesAutoAnswer({ info: { code } })).toBe(true);
    }
    expect(pausesAutoAnswer({ code: "out_of_credits" })).toBe(true);
  });

  it("does not pause on a one-off failure", () => {
    expect(pausesAutoAnswer({ info: { code: "network" } })).toBe(false);
    expect(pausesAutoAnswer(new Error("boom"))).toBe(false);
    expect(pausesAutoAnswer(null)).toBe(false);
  });
});

import { AUTO_THEM_KEY, AUTO_YOU_KEY, autoOnFor, rememberAutoSides, storedAutoSides } from "./autoAnswer";

describe("Auto Answer for each side", () => {
  beforeEach(() => localStorage.clear());

  it("uses the switch of the side that finished speaking", () => {
    expect(autoOnFor("interviewer", { them: true, you: false })).toBe(true);
    expect(autoOnFor("user", { them: true, you: false })).toBe(false);
    expect(autoOnFor("user", { them: false, you: true })).toBe(true);
  });

  it("starts yours the same as theirs on a computer that only remembers the old single switch", () => {
    localStorage.setItem(AUTO_THEM_KEY, "1");
    expect(storedAutoSides()).toEqual({ them: true, you: true });
    localStorage.setItem(AUTO_YOU_KEY, "0");
    expect(storedAutoSides()).toEqual({ them: true, you: false });
  });

  it("remembers both switches", () => {
    rememberAutoSides({ them: false, you: true });
    expect(storedAutoSides()).toEqual({ them: false, you: true });
  });
});
