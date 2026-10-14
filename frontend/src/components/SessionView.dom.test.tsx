// @vitest-environment jsdom
/**
 * The live screen, rendered. The e2e bug: text typed into the transcript box,
 * Enter sent it, the screen re-rendered, focus left the box, and the next
 * letters ran as shortcuts — O and E switched to the overlay and the camera
 * strip, hiding End. And with no session, the live keys must do nothing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fakeBackend } from "../test/dom";

const backend = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("../test/dom").fakeBackend> }));
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  fetchApi: (path: string, init?: RequestInit) => backend.current!.fetchApi(path, init),
}));
const compact = vi.hoisted(() => ({ enter: vi.fn(async () => {}), exit: vi.fn(async () => {}) }));
vi.mock("../lib/compact", async (orig) => ({
  ...(await orig<typeof import("../lib/compact")>()),
  enterCompactWindow: compact.enter,
  exitCompactWindow: compact.exit,
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }));
vi.mock("react-hot-toast", () => ({ default: toast }));

import SessionView from "./SessionView";
import SessionStart from "./SessionStart";

/** A coach answer, streamed the way /coach/turn streams it. */
const answer = () => new Response("data: {\"type\":\"done\",\"reply\":\"Say it plainly.\"}\n\n", {
  status: 200, headers: { "Content-Type": "text/event-stream" },
});

beforeEach(() => {
  compact.enter.mockClear();
  compact.exit.mockClear();
  toast.mockClear();
  backend.current = fakeBackend({
    "/sessions/1": { id: 1, title: "Acme interview", language: "en", setup: {} },
    "/coach/turn": () => answer(),
    "/config": { llm_providers: [], saved: {} },
    "/audio/devices": { inputs: [], outputs: [] },
    "/account/": { signed_in: true, admin: true },
    "/licence/": { enforced: false },
    "/suggest/estimate": { model: "m", tokens: { input: 1, output: 1 }, usd: 0, credits: 0 },
  });
});

const DRAFT = {
  title: "Acme interview", subtitle: "", tags: [], cvId: null, documentIds: [], peopleIds: [], template: "general",
  model: "claude-haiku-4-5", language: "en", aiInstructions: "", responseTone: "advanced", autoAnswer: false,
};

// These type whole sentences key by key, which takes longer than 5 s on the capped CI runner.
describe("typing into the transcript box never fires shortcuts", { timeout: 20000 }, () => {
  it("after a typed turn is sent, the box keeps focus, and typing o or e does not change the view", async () => {
    const user = userEvent.setup();
    // Auto Answer on for your side, so Enter sends it to the coach (off, it waits: see below).
    const { container } = render(<SessionView initialSessionId={1} initialDraft={{ ...DRAFT, autoAnswerYou: true }} />);
    const box = screen.getByPlaceholderText(/Paste or type transcript/) as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "What is your notice period?{Enter}");

    await waitFor(() => expect(backend.current!.paths()).toContain("/coach/turn"));
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    expect(document.activeElement).toBe(box);

    await user.keyboard("oe");
    expect(box.value).toBe("oe");
    expect(compact.enter).not.toHaveBeenCalled();
    expect(container.querySelector(".session-view")).toBeTruthy();
    expect(screen.getByRole("button", { name: /End/ })).toBeTruthy();
  });

  it("even if something takes focus just after sending, the next letters still go into the box", async () => {
    const user = userEvent.setup();
    const { container } = render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    const box = screen.getByPlaceholderText(/Paste or type transcript/) as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "Tell me about yourself{Enter}");
    await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))); });
    // A re-render or a dialog moves focus away without a click.
    act(() => { box.blur(); });
    expect(document.activeElement).not.toBe(box);

    // The first letter lands on the window, with nothing focused...
    fireEvent.keyDown(window, { key: "o" });
    // ...and is put in the box, which has focus again, so the next one is typed there.
    expect(document.activeElement).toBe(box);
    await user.keyboard("e");
    expect(compact.enter).not.toHaveBeenCalled();
    expect(container.querySelector(".session-view")).toBeTruthy();
    expect(box.value).toBe("oe");
    expect(document.activeElement).toBe(box);
  });

  it("with the box left on purpose, O does switch to the overlay (the key still works)", async () => {
    render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    fireEvent.keyDown(window, { key: "o" });
    await waitFor(() => expect(compact.enter).toHaveBeenCalledWith("overlay"));
  });

  it("with Auto Answer off for both sides, a typed turn waits until you ask, and Answer answers it", async () => {
    const user = userEvent.setup();
    render(<SessionView initialSessionId={1} initialDraft={{ ...DRAFT, autoAnswer: false, autoAnswerYou: false }} />);
    const box = screen.getByPlaceholderText(/Paste or type transcript/) as HTMLTextAreaElement;
    await user.click(box);
    await user.type(box, "What is your notice period?{Enter}");
    await screen.findByText("What is your notice period?");
    expect(backend.current!.paths()).not.toContain("/coach/turn");          // off means off, typed or spoken
    await user.type(box, "Tell me about a hard project.{Control>}{Enter}{/Control}");
    await screen.findByText("Tell me about a hard project.");
    expect(backend.current!.paths()).not.toContain("/coach/turn");
    // Both wait visibly; asking answers the latest.
    await user.click(screen.getByRole("button", { name: /Answer latest \(2 waiting\)/ }));
    await waitFor(() => expect(backend.current!.paths()).toContain("/coach/turn"));
  }, 20_000);   // renders the whole live screen: slow on a busy CI runner

  it("R with nothing from them says so instead of doing nothing", async () => {
    render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    fireEvent.keyDown(window, { key: "r" });
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^Nothing from .* to answer yet/), expect.anything());
    fireEvent.keyDown(window, { key: "R", shiftKey: true });
    expect(toast).toHaveBeenLastCalledWith(expect.stringMatching(/^Nothing from you/), expect.anything());
    expect(backend.current!.paths()).not.toContain("/coach/turn");
  });

  it("Auto Answer has a switch for each side, and each turns on and off alone", async () => {
    render(<SessionView initialSessionId={1} initialDraft={{ ...DRAFT, autoAnswer: false, autoAnswerYou: false }} />);
    const group = screen.getByRole("group", { name: "Auto Answer" });
    const [them, you] = Array.from(group.querySelectorAll("button"));
    expect(you.textContent).toMatch(/^You Off/);
    fireEvent.click(you);
    expect(you.getAttribute("aria-pressed")).toBe("true");
    expect(them.getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem("autoAnswerYou")).toBe("1");
    expect(localStorage.getItem("autoAnswer")).toBe("0");
  });
});

describe("with no session, the live keys do nothing", () => {
  it("the start step shows, and L, Y, R, O, E, C and Ctrl+S change nothing and ask no one", async () => {
    backend.current = fakeBackend({ "/sessions/": [], "/calendar/events": [], "/cvs/": [] });
    const onStart = vi.fn(), onQuickStart = vi.fn();
    const { container } = render(
      <SessionStart base={DRAFT} templates={[{ id: "general", label: "General" }]} languages={[{ id: "en", label: "English" }]}
        onStart={onStart} onQuickStart={onQuickStart} />,
    );
    expect(screen.getByText("Start a session to use the Live Companion")).toBeTruthy();
    await waitFor(() => expect(backend.current!.paths()).toContain("/sessions/"));
    const before = backend.current!.paths().length;

    for (const key of ["l", "y", "r", "o", "e", "c", "a", "x", "p", "t"]) fireEvent.keyDown(window, { key });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    expect(backend.current!.paths().length).toBe(before);     // no audio, no coach, no capture
    expect(compact.enter).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
    expect(onQuickStart).not.toHaveBeenCalled();
    expect(container.querySelector(".session-view")).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Start a session first/), expect.anything());
  });

  it("Quick start makes the session only when clicked", async () => {
    backend.current = fakeBackend({ "/sessions/": [], "/calendar/events": [], "/cvs/": [] });
    const onQuickStart = vi.fn();
    const user = userEvent.setup();
    render(<SessionStart base={DRAFT} templates={[{ id: "general", label: "General" }]} languages={[{ id: "en", label: "English" }]}
      onStart={() => {}} onQuickStart={onQuickStart} />);
    const quick = await screen.findByRole("button", { name: /Quick start/ });
    await waitFor(() => expect((quick as HTMLButtonElement).disabled).toBe(false));
    expect(onQuickStart).not.toHaveBeenCalled();
    await user.click(quick);
    expect(onQuickStart).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^Session, /) }), expect.anything());
  });
});
