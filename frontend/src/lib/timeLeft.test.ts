import { describe, expect, it } from "vitest";
import { RUNS_OUT_MESSAGE, RUNS_OUT_WARNING_SECONDS, formatDuration, liveSecondsLeft, runsOutCheck } from "./account";
import { secondsLeft } from "../components/session/LiveTimeLeft";
import { leavingStopsASession, pauseCurrentSession, registerSessionGuard } from "./sessionGuard";

describe("time left", () => {
  it("reads the way the backoffice writes it", () => {
    expect(formatDuration(3 * 3600 + 24 * 60)).toBe("3 h 24 min");
    expect(formatDuration(45 * 60 + 59)).toBe("45 min");
    expect(formatDuration(2 * 3600)).toBe("2 h");
    expect(formatDuration(30)).toBe("under a minute");
  });

  it("uses the service's figure when it sent one, and works live time out when it did not", () => {
    expect(liveSecondsLeft({ credits: 7.8, held: 1, available: 6.8, time_left: { live_seconds: 12240, voice_mock_seconds: 2700, owes_credits: 0 } })).toBe(12240);
    expect(liveSecondsLeft({ credits: 2, held: 0, available: 2 })).toBe(3600);
    expect(liveSecondsLeft({ credits: -1, held: 0, available: -1 })).toBe(0);
  });

  it("the session's countdown only runs while it listens, and stops at zero", () => {
    expect(secondsLeft(3600, 10 * 60 * 1000)).toBe(3000);
    expect(secondsLeft(60, 5 * 60 * 1000)).toBe(0);
  });
});

describe("the two-minute warning", () => {
  /** A countdown fed through the check the way the session's chip feeds it, tick by tick. */
  function run(ticks: (number | null)[]): number[] {
    let warned = false;
    const at: number[] = [];
    ticks.forEach((left, i) => {
      const next = runsOutCheck(left, warned);
      warned = next.warned;
      if (next.warn) at.push(i);
    });
    return at;
  }

  it("says it once, the first time two minutes or less are left", () => {
    expect(RUNS_OUT_WARNING_SECONDS).toBe(120);
    expect(run([600, 300, 125, 120, 115, 60, 5])).toEqual([3]);
    expect(run([130, 118, 110])).toEqual([1]);
  });

  it("says nothing with plenty left, when the time isn't known, or once it has run out", () => {
    expect(run([3600, 1800, 121])).toEqual([]);
    expect(run([null, null])).toEqual([]);
    expect(run([Number.NaN])).toEqual([]);
    // Nothing left: the out-of-credits path speaks, not "in about 2 minutes".
    expect(run([0, 0])).toEqual([]);
  });

  it("starting a session with under two minutes left warns straight away", () => {
    expect(run([90])).toEqual([0]);
  });

  it("buying credits re-arms it, and it comes again when the new credit runs low", () => {
    expect(run([130, 100, 80, 1900, 1000, 119, 60])).toEqual([1, 5]);
  });

  it("reads the way the owner asked for it", () => {
    expect(RUNS_OUT_MESSAGE).toBe("Your credit runs out in about 2 minutes. Buy credits to keep going.");
  });
});

describe("leaving a session", () => {
  it("asks only while the session is listening, and pausing goes to the session", async () => {
    let live = true;
    let paused = 0;
    const off = registerSessionGuard({ live: () => live, pause: async () => { paused++; } });
    expect(leavingStopsASession()).toBe(true);
    live = false;
    expect(leavingStopsASession()).toBe(false);
    await pauseCurrentSession();
    expect(paused).toBe(1);
    off();
    live = true;
    expect(leavingStopsASession()).toBe(false);
  });
});
