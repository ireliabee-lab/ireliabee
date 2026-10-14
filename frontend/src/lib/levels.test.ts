import { describe, expect, it } from "vitest";
import { BARS, bars, boostLabel, dbfs, hearing, isDead, quiet } from "./levels";

// The levels this was built against, measured on the owner's laptop:
const ROOM = 0.002;        // an empty room
const RAW_MIC = 0.017;     // ordinary speech, before the level stage
const TARGET = 0.06;       // where the level stage puts speech
const CALL = 0.14;         // call audio at a normal volume

describe("The meter", () => {
  it("shows nothing for silence", () => {
    expect(bars(0)).toBe(0);
    expect(bars(0.0001)).toBe(0);      // -80 dBFS: below the floor
  });

  it("shows something for a room that is merely quiet", () => {
    // The point of the meter: a quiet room and a dead microphone must not
    // look the same.
    expect(bars(ROOM)).toBeGreaterThan(0);
    expect(bars(ROOM)).toBeLessThan(BARS / 2);
  });

  it("shows speech well up the scale", () => {
    expect(bars(TARGET)).toBeGreaterThanOrEqual(7);
    expect(bars(CALL)).toBeGreaterThanOrEqual(9);
  });

  it("shows the raw microphone as the weak signal it is", () => {
    // -35 dBFS, which is what the user was shouting to get past.
    expect(bars(RAW_MIC)).toBeLessThan(bars(TARGET));
  });

  it("never lights more segments than it has", () => {
    for (const level of [0.5, 1, 4]) expect(bars(level)).toBe(BARS);
  });

  it("only ever grows with the level", () => {
    let last = -1;
    for (let l = 0; l <= 1; l += 0.005) {
      const now = bars(l);
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  it("scales to whatever size it is drawn at", () => {
    expect(bars(TARGET, 6)).toBeLessThanOrEqual(6);
    expect(bars(1, 6)).toBe(6);
    expect(bars(0, 6)).toBe(0);
  });

  it("measures silence as far below anything audible", () => {
    expect(dbfs(0)).toBe(-Infinity);
    expect(dbfs(1)).toBeCloseTo(0);
    expect(dbfs(0.1)).toBeCloseTo(-20);
  });
});

describe("What it says", () => {
  it("says when nothing is being listened to", () => {
    expect(hearing(false, quiet)).toBe("Not listening");
    expect(hearing(false, { level: 0.2, speaking: true, gain: 1 })).toBe("Not listening");
  });

  it("says it is hearing you while you speak", () => {
    expect(hearing(true, { level: TARGET, speaking: true, gain: 3 })).toBe("Hearing you");
  });

  it("tells a quiet room from a silent one", () => {
    expect(hearing(true, { level: ROOM, speaking: false, gain: 3 })).toBe("Listening — quiet");
    expect(hearing(true, quiet)).toBe("Listening — silent");
  });

  it("does not cry wolf over a microphone that is merely very quiet", () => {
    // Measured on the owner's laptop: the array delivers about -90 dBFS with
    // sound in the room. Quiet, and real — not a dead device.
    expect(isDead(true, { level: 0.00002, speaking: false, gain: 8 }, "mic")).toBe(false);
    expect(hearing(true, { level: 0.00002, speaking: false, gain: 8 })).toBe("Listening — silent");
  });

  it("never calls the call audio dead — a pause in it is exactly zero", () => {
    // What a live test caught: the sentence transcribed perfectly, and the
    // moment the voice stopped the meter said "nothing is arriving". A
    // loopback of an idle output is digital silence, and most of a
    // conversation is the other person not talking.
    expect(isDead(true, quiet, "system")).toBe(false);
  });

  it("flags a source that is delivering nothing at all", () => {
    // A muted device, or the wrong one: the whole reason for the meter.
    expect(isDead(true, quiet, "mic")).toBe(true);
    expect(isDead(true, { level: ROOM, speaking: false, gain: 1 }, "mic")).toBe(false);
    expect(isDead(false, quiet, "mic")).toBe(false);
  });
});

describe("The boost", () => {
  it("is not mentioned when the audio barely needed it", () => {
    expect(boostLabel(1)).toBe("");
    expect(boostLabel(1.9)).toBe("");
  });

  it("is said plainly when the app is doing real work", () => {
    expect(boostLabel(3.5)).toBe("×3.5");
    expect(boostLabel(8)).toBe("×8");
    expect(boostLabel(24)).toBe("×24");
  });
});
