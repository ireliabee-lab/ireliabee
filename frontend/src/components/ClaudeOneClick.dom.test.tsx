// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "../test/dom";
import ClaudeOneClick from "./ClaudeOneClick";
import { getAssistantAuto, setAssistantAuto, type AssistantAuto } from "../lib/relay";

vi.mock("../lib/relay", () => ({
  getAssistantAuto: vi.fn(), setAssistantAuto: vi.fn(),
  CLAUDE_CODE_INSTALL_URL: "https://docs.claude.com/en/docs/claude-code/setup",
}));
vi.mock("../lib/openExternal", () => ({ openExternal: vi.fn() }));

const base: AssistantAuto = { enabled: false, available: true, path: "claude", running: false, started_at: null, last_error: null, last_run: {} };

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Use my Claude subscription, in one click", () => {
  it("one click turns it on and tells Settings the relay is on", async () => {
    vi.mocked(getAssistantAuto).mockResolvedValue(base);
    vi.mocked(setAssistantAuto).mockResolvedValue({ ...base, enabled: true });
    const onEnabled = vi.fn();
    render(<ClaudeOneClick onEnabled={onEnabled} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /Turn on/ }));
    await waitFor(() => expect(setAssistantAuto).toHaveBeenCalledWith(true));
    expect(onEnabled).toHaveBeenCalledWith(true);
    expect(await screen.findByText("Claude Code answers text features")).toBeTruthy();
    expect(screen.getByText(/not iReliabee credits/)).toBeTruthy();
  });

  it("without Claude Code installed, it says how to get it instead of a button that fails", async () => {
    vi.mocked(getAssistantAuto).mockResolvedValue({ ...base, available: false, path: null });
    render(<ClaudeOneClick onEnabled={vi.fn()} />);
    expect(await screen.findByRole("button", { name: "Install Claude Code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Turn on/ })).toBeNull();
  });

  it("shows why the last run couldn't answer", async () => {
    vi.mocked(getAssistantAuto).mockResolvedValue({ ...base, enabled: true, last_error: "Claude Code isn't signed in. Open it once in a terminal (type claude) and sign in." });
    render(<ClaudeOneClick onEnabled={vi.fn()} />);
    expect((await screen.findByRole("alert")).textContent).toContain("isn't signed in");
  });

  it("turning off says so and stops the switch", async () => {
    vi.mocked(getAssistantAuto).mockResolvedValue({ ...base, enabled: true, running: true });
    vi.mocked(setAssistantAuto).mockResolvedValue(base);
    const onEnabled = vi.fn();
    render(<ClaudeOneClick onEnabled={onEnabled} />);
    expect(await screen.findByText(/Answering now/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(setAssistantAuto).toHaveBeenCalledWith(false));
    expect(onEnabled).toHaveBeenCalledWith(false);
  });
});
