import { describe, expect, it } from "vitest";
import { both, isListening, nothing, openList, pick, type Listening } from "./sources";

const you: Listening = { mic: true, system: false };
const them: Listening = { mic: false, system: true };
const auto: Listening = { mic: true, system: true };

describe("Picking a side", () => {
  it("switches to you when they were the one being listened to", () => {
    // The bug this exists for: pressing Y with the other side on turned *both*
    // on, so the app was suddenly listening to a room it had been told to leave.
    expect(pick(them, "mic")).toEqual(you);
  });

  it("switches to them when you were the one being listened to", () => {
    expect(pick(you, "system")).toEqual(them);
  });

  it("starts listening to one side from silence", () => {
    expect(pick(nothing, "mic")).toEqual(you);
    expect(pick(nothing, "system")).toEqual(them);
  });

  it("narrows Auto down to the side that was picked", () => {
    expect(pick(auto, "mic")).toEqual(you);
    expect(pick(auto, "system")).toEqual(them);
  });

  it("stops when the side already listening alone is pressed again", () => {
    expect(pick(you, "mic")).toEqual(nothing);
    expect(pick(them, "system")).toEqual(nothing);
  });

  it("never leaves both sides on — that is Auto's job alone", () => {
    for (const start of [nothing, you, them, auto]) {
      for (const source of ["mic", "system"] as const) {
        const next = pick(start, source);
        expect(next.mic && next.system).toBe(false);
      }
    }
  });

  it("is the same answer however the button was reached", () => {
    // Clicking and pressing the key run this one function, so there is no
    // second behaviour to drift out of step with the first.
    expect(pick(them, "mic")).toEqual(pick(pick(nothing, "system"), "mic"));
  });
});

describe("Auto", () => {
  it("turns both on from silence", () => {
    expect(both(nothing)).toEqual(auto);
  });

  it("turns both on when only one side was listening", () => {
    expect(both(you)).toEqual(auto);
    expect(both(them)).toEqual(auto);
  });

  it("stops everything when both were already on", () => {
    expect(both(auto)).toEqual(nothing);
  });
});

describe("What the socket is told", () => {
  it("lists the sides to open, in a settled order", () => {
    expect(openList(auto)).toEqual(["mic", "system"]);
    expect(openList(you)).toEqual(["mic"]);
    expect(openList(them)).toEqual(["system"]);
    expect(openList(nothing)).toEqual([]);
  });

  it("knows when nothing is being listened to", () => {
    expect(isListening(nothing)).toBe(false);
    expect(isListening(you)).toBe(true);
    expect(isListening(auto)).toBe(true);
  });
});
