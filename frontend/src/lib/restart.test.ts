import { afterEach, describe, expect, it, vi } from "vitest";
import { FLUSH_MS, RESTARTING, flushBeforeExit, restartApp } from "./restart";

describe("restartApp (the sidebar's Restart)", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("tells the app first, so editors can save, then restarts", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const reload = vi.fn(() => order.push("reload"));
    const target = new EventTarget();
    vi.stubGlobal("window", {
      dispatchEvent: (e: Event) => { order.push(e.type); return target.dispatchEvent(e); },
      location: { reload },
      setTimeout,
    });
    const done = restartApp();
    expect(order).toEqual([RESTARTING]);          // announced before anything closes
    await vi.advanceTimersByTimeAsync(500);
    await done;
    expect(order).toEqual([RESTARTING, "reload"]); // outside the desktop app: a reload
  });
});

describe("flushBeforeExit (what an update now waits for)", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("tells editors to save, and does not return until they have had their moment", async () => {
    // The updater depends on this. On Windows installing calls
    // std::process::exit(0) the moment the installer is handed over, so there is
    // no "after" for the notebook and the wall to save in.
    vi.useFakeTimers();
    const saved: string[] = [];
    const target = new EventTarget();
    target.addEventListener(RESTARTING, () => saved.push("saved"));
    vi.stubGlobal("window", {
      dispatchEvent: (e: Event) => target.dispatchEvent(e),
      setTimeout,
    });

    let finished = false;
    const done = flushBeforeExit().then(() => { finished = true; });
    expect(saved).toEqual(["saved"]);      // asked straight away
    expect(finished).toBe(false);          // and it waits
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    await done;
    expect(finished).toBe(true);
  });
});
