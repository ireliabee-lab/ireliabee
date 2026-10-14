// @vitest-environment jsdom
import { StrictMode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ExplainCard from "./ExplainCard";
import { readingApi } from "../../lib/reading";

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) }));

describe("ExplainCard with relay fallback", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows assistant isn't listening message when relay not active, and offers credits fallback", async () => {
    const user = userEvent.setup();
    const lookupSpy = vi.spyOn(readingApi, "lookup").mockImplementation(async (params) => {
      if (!params.fallback_credits) {
        const err = new Error("Your assistant isn't listening") as any;
        err.code = "relay_not_listening";
        throw err;
      }
      return {
        meaning: "Rate of change of velocity",
        example: "A car accelerating",
        from: "general",
        pages: [],
        unsure: false,
        cached: false,
      };
    });

    render(
      <ExplainCard
        selected={{ text: "acceleration", line: "Rate of acceleration", src: [1] }}
        documentId={1}
        notebookId={10}
        level="some"
        onAddUnder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    // Shows fallback message
    await waitFor(() => {
      expect(screen.getByText(/Your assistant isn't listening/i)).toBeTruthy();
    });
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(screen.getByText("Use credits instead")).toBeTruthy();
    expect(lookupSpy).toHaveBeenCalledWith(expect.objectContaining({ fallback_credits: false }));

    // Click "Use credits instead"
    await user.click(screen.getByText("Use credits instead"));

    // Should resolve with answer
    await waitFor(() => {
      expect(screen.getByText("Rate of change of velocity")).toBeTruthy();
    });
    expect(screen.getByText(/A car accelerating/)).toBeTruthy();
    expect(lookupSpy).toHaveBeenCalledWith(expect.objectContaining({ fallback_credits: true }));
  });

  it("shows assistant didn't answer in time message on relay timeout, and offers credits fallback", async () => {
    const user = userEvent.setup();
    const lookupSpy = vi.spyOn(readingApi, "lookup").mockImplementation(async (params) => {
      if (!params.fallback_credits) {
        const err = new Error("Your assistant didn't answer in time") as any;
        err.code = "relay_timeout";
        throw err;
      }
      return {
        meaning: "Rate of change of velocity",
        example: "A car accelerating",
        from: "general",
        pages: [],
        unsure: false,
        cached: false,
      };
    });

    render(
      <ExplainCard
        selected={{ text: "acceleration", line: "Rate of acceleration", src: [1] }}
        documentId={1}
        notebookId={10}
        level="some"
        onAddUnder={vi.fn()}
        onClose={vi.fn()}
      />
    );

    // Shows timeout fallback message
    await waitFor(() => {
      expect(screen.getByText(/Your assistant didn't answer in time/i)).toBeTruthy();
    });
    expect(screen.getByText("Try again")).toBeTruthy();
    expect(screen.getByText("Use credits instead")).toBeTruthy();
  });

  it("one Explain is one lookup, even when React runs the effect twice (development)", async () => {
    const lookupSpy = vi.spyOn(readingApi, "lookup").mockResolvedValue({
      meaning: "Rate of change of velocity", example: "A car accelerating", from: "general", pages: [], unsure: false, cached: false,
    });
    render(
      <StrictMode>
        <ExplainCard selected={{ text: "acceleration", line: "Rate of acceleration", src: [1] }}
          documentId={1} notebookId={10} level="some" onAddUnder={vi.fn()} onClose={vi.fn()} />
      </StrictMode>
    );
    await waitFor(() => expect(screen.getByText("Rate of change of velocity")).toBeTruthy());
    expect(lookupSpy).toHaveBeenCalledTimes(1);
  });
});
