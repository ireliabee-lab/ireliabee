// @vitest-environment jsdom
/**
 * "Likely next" through the user's own assistant can wait up to ten minutes.
 * A prediction nobody will see any more must not keep its request open: the
 * webview allows only a few connections to the engine at once, and once they
 * are all held, a live answer (/coach/turn) waits behind them and never
 * reaches the engine, so its turn sits on loading dots.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import "../test/dom";

const calls = vi.hoisted(() => ({ signals: [] as (AbortSignal | undefined)[] }));
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  fetchApi: (_path: string, init?: RequestInit) => {
    calls.signals.push(init?.signal ?? undefined);
    // Never answers on its own, like a relay request nobody picks up.
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  },
}));

import FollowupCard from "./FollowupCard";

const lines = [{ speaker: "you" as const, text: "I led the payments team." }];

beforeEach(() => { calls.signals = []; });

describe("Likely next lets go of a prediction it no longer needs", () => {
  it("a new turn cancels the request for the last one", async () => {
    const { rerender } = render(<FollowupCard lines={lines} triggerKey="1:10" />);
    await waitFor(() => expect(calls.signals).toHaveLength(1), { timeout: 4000 });
    expect(calls.signals[0]).toBeDefined();
    expect(calls.signals[0]!.aborted).toBe(false);
    rerender(<FollowupCard lines={lines} triggerKey="2:12" />);
    expect(calls.signals[0]!.aborted).toBe(true);
    await waitFor(() => expect(calls.signals).toHaveLength(2), { timeout: 4000 });
  });

  it("leaving the screen cancels it too", async () => {
    const { unmount } = render(<FollowupCard lines={lines} triggerKey="1:10" />);
    await waitFor(() => expect(calls.signals).toHaveLength(1), { timeout: 4000 });
    unmount();
    expect(calls.signals[0]!.aborted).toBe(true);
  });
});
