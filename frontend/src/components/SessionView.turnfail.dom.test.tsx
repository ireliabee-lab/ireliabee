// @vitest-environment jsdom
/**
 * A live answer that fails must never leave a turn on loading dots.
 *
 * The owner's report (with "Use my Claude subscription" on): two "hey" turns
 * from them sat on three dots for good, and R added another card. Whatever
 * goes wrong (the relay times out, the stream ends early, the request never
 * gets an answer at all), the turn shows the error with Try again, later turns
 * still send, and R answers the failed turn again rather than a new one.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fakeBackend } from "../test/dom";

const backend = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("../test/dom").fakeBackend> }));
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  fetchApi: (path: string, init?: RequestInit) => backend.current!.fetchApi(path, init),
}));
vi.mock("../lib/compact", async (orig) => ({
  ...(await orig<typeof import("../lib/compact")>()),
  enterCompactWindow: vi.fn(async () => {}),
  exitCompactWindow: vi.fn(async () => {}),
}));
// A stream that goes quiet is given up on after this long (90 s in the app).
vi.mock("../lib/coachStream", async (orig) => ({
  ...(await orig<typeof import("../lib/coachStream")>()),
  ANSWER_STALL_MS: 600,
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn(), custom: vi.fn() }));
vi.mock("react-hot-toast", () => ({ default: toast }));

import SessionView from "./SessionView";

const sse = (...events: object[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), {
  status: 200, headers: { "Content-Type": "text/event-stream" },
});
const ANSWER = { type: "done", reply: "Say it plainly.", history: [], engine: { provider: "assistant_relay", model: "claude" } };
const answered = (text = "Say it plainly.") => sse({ type: "token", text }, { ...ANSWER, reply: text });
// What the backend sends when Claude Code never picked the request up (backend/errors.py relay_timeout).
const timedOut = () => sse(
  { type: "meta", turn_type: "statement", response_tone: "advanced" },
  { type: "error", code: "relay_timeout", title: "Your assistant didn't answer",
    message: "It took longer than 60 seconds. Try again, or use credits instead.", action: "credits_fallback" },
);
/** A request that never gets an answer: no headers, no bytes, until it is aborted. */
const hangs = (init?: RequestInit) => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
});

let replies: ((init?: RequestInit) => Response | Promise<Response>)[] = [];

beforeEach(() => {
  toast.mockClear();
  toast.custom.mockClear();
  localStorage.clear();
  replies = [];
  backend.current = fakeBackend({
    "/sessions/1": { id: 1, title: "Acme interview", language: "en", setup: {} },
    "/coach/turn": (init?: RequestInit) => (replies.shift() ?? (() => answered()))(init),
    "/coach/followups": { followups: [] },
    "/config": { llm_providers: [], saved: { notebook_relay: true } },
    "/relay/status": {
      enabled: true, listening: false, active: false, last_poll_at: null, queued: 0, working: [], client: null,
      auto: { enabled: true, available: true, path: "claude", running: false, started_at: null, last_error: null, last_run: {} },
    },
    "/audio/devices": { inputs: [], outputs: [] },
    "/account/": { signed_in: true, admin: true },
    "/licence/": { enforced: false },
    "/suggest/estimate": { model: "m", tokens: { input: 1, output: 1 }, usd: 0, credits: 0 },
  });
});
afterEach(() => { vi.restoreAllMocks(); });

const DRAFT = {
  title: "Acme interview", subtitle: "", tags: [], cvId: null, documentIds: [], peopleIds: [], template: "general",
  model: "claude-haiku-4-5", language: "en", aiInstructions: "", responseTone: "advanced",
  autoAnswer: true, autoAnswerYou: true,
};

const turnCalls = () => backend.current!.calls.filter(c => c.path === "/coach/turn");
const rowsSaying = (container: HTMLElement, text: string) =>
  Array.from(container.querySelectorAll(".turn-row")).filter(r => r.querySelector(".transcript-bubble")?.textContent === text) as HTMLElement[];

/** Type a line as theirs (Ctrl+Enter), then leave the box so letters are shortcuts again. */
async function theySay(user: ReturnType<typeof userEvent.setup>, line: string) {
  const box = screen.getByPlaceholderText(/Paste or type transcript/) as HTMLTextAreaElement;
  await user.click(box);
  await user.type(box, `${line}{Control>}{Enter}{/Control}`);
  act(() => { box.blur(); });
  fireEvent.pointerDown(document.body);     // a click elsewhere ends the typing grace
}

// First in the file: the turn counter is module state, and the collision was with id 1.
describe("a resumed session", () => {
  it("new turns get ids of their own, so nothing shares a React key with the rebuilt history", async () => {
    const errors = vi.spyOn(console, "error");
    const user = userEvent.setup();
    const { container } = render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    act(() => {
      window.dispatchEvent(new CustomEvent("resume-session", { detail: { sessionId: 1, messages: [
        { role: "user", content: "[INTERVIEWER] Why this company?" },
        { role: "assistant", content: "Because of the mission." },
      ] } }));
    });
    await waitFor(() => expect(rowsSaying(container, "Why this company?")).toHaveLength(1));
    await theySay(user, "And the role?");
    await waitFor(() => expect(container.querySelectorAll(".session-coach-card")).toHaveLength(2));
    const keyWarnings = errors.mock.calls.filter(args => args.some(a => typeof a === "string" && /same key/.test(a)));
    expect(keyWarnings).toEqual([]);
    expect(rowsSaying(container, "Why this company?")).toHaveLength(1);
  });
});

describe("a live answer that fails never stays on loading dots", { timeout: 20000 }, () => {
  it("a relay timeout shows the error on that turn with Try again, and a later turn still sends", async () => {
    const user = userEvent.setup();
    replies = [() => timedOut()];
    const { container } = render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    await theySay(user, "hey");

    const [row] = await waitFor(() => {
      const rows = rowsSaying(container, "hey");
      expect(rows).toHaveLength(1);
      expect(rows[0].querySelector(".typing-dots")).toBeNull();
      return rows;
    });
    const failed = within(row).getByRole("alert");
    // One-click mode: it is Claude Code that didn't answer, and there is nothing to type anywhere.
    expect(failed.textContent).toMatch(/Claude Code didn.t answer/);
    expect(failed.textContent).not.toMatch(/start iReliabee/i);
    expect(within(row).getByRole("button", { name: /Try again/ })).toBeTruthy();
    expect(within(row).getByRole("button", { name: /Use credits/ })).toBeTruthy();
    const banner = () => container.querySelector(".relay-companion-warning");
    expect(banner()?.textContent).toMatch(/Claude Code didn.t answer in time/);

    // The next thing they say is still answered...
    await theySay(user, "What brought you here?");
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
    expect(turnCalls()[1].body).toMatchObject({ transcript: "What brought you here?" });
    // ...and once an answer comes back, the "didn't answer in time" banner goes.
    await waitFor(() => expect(banner()).toBeNull());
    expect(container.querySelector(".coach-bar .typing-dots")).toBeNull();
  });

  it("the 'isn't listening' banner goes once an answer comes back", async () => {
    // Live 14 Oct: switched off and on again, the banner stayed up after a good answer.
    let status: Record<string, unknown> = {
      enabled: true, listening: false, active: false, last_poll_at: null, queued: 0, working: [], client: null,
      auto: { enabled: false, available: true, path: "claude", running: false, started_at: null, last_error: null, last_run: {} },
    };
    const routes = backend.current!;
    const fetchApi = routes.fetchApi.getMockImplementation()!;
    routes.fetchApi.mockImplementation(async (path: string, init?: RequestInit) =>
      path.startsWith("/relay/status") ? new Response(JSON.stringify(status), { status: 200, headers: { "Content-Type": "application/json" } }) : fetchApi(path, init));
    const user = userEvent.setup();
    const { container } = render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    const banner = () => container.querySelector(".relay-companion-warning");
    await theySay(user, "hey");
    await waitFor(() => expect(banner()?.textContent).toMatch(/isn.t listening/));
    status = { ...status, auto: { ...(status.auto as object), enabled: true } };
    await theySay(user, "What brought you here?");
    await waitFor(() => expect(turnCalls().length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(banner()).toBeNull());
  });

  it("Try again asks the same turn again, on the same card", async () => {
    const user = userEvent.setup();
    replies = [() => timedOut()];
    const { container } = render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    await theySay(user, "hey");
    const retry = await waitFor(() => within(rowsSaying(container, "hey")[0]).getByRole("button", { name: /Try again/ }));

    await user.click(retry);
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
    expect(turnCalls()[1].body).toMatchObject({ transcript: "hey", speaker: "interviewer" });
    await waitFor(() => expect(rowsSaying(container, "hey")[0].querySelector("[role=alert]")).toBeNull());
    expect(rowsSaying(container, "hey")).toHaveLength(1);
    expect(container.querySelectorAll(".session-coach-card")).toHaveLength(1);
  });

  it("R on the failed turn asks it again once, and adds no second card", async () => {
    const user = userEvent.setup();
    replies = [() => timedOut(), (init) => hangs(init)];
    const { container } = render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    await theySay(user, "hey");
    await waitFor(() => expect(within(rowsSaying(container, "hey")[0]).getByRole("alert")).toBeTruthy());

    // Pressed twice, as someone does when nothing seems to happen.
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    expect(turnCalls()).toHaveLength(2);
    expect(turnCalls()[1].body).toMatchObject({ transcript: "hey", speaker: "interviewer" });
    expect(rowsSaying(container, "hey")).toHaveLength(1);
    expect(container.querySelectorAll(".turn-row")).toHaveLength(1);
    // The second press says it is on its way, rather than "nothing to answer".
    expect(toast).toHaveBeenLastCalledWith(expect.stringMatching(/^Still answering/), expect.anything());
  });

  it("G answers a failed turn again on the same card too", async () => {
    const user = userEvent.setup();
    replies = [() => timedOut()];
    const { container } = render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    await theySay(user, "hey");
    await waitFor(() => expect(within(rowsSaying(container, "hey")[0]).getByRole("alert")).toBeTruthy());
    fireEvent.keyDown(window, { key: "g" });
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
    expect(turnCalls()[1].body).toMatchObject({ transcript: "hey" });
    expect(container.querySelectorAll(".turn-row")).toHaveLength(1);
  });

  it("an answer that never comes back is given up on, with Try again, and the next turn still sends", async () => {
    const user = userEvent.setup();
    replies = [(init) => hangs(init)];
    const { container } = render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    await theySay(user, "hey");
    await waitFor(() => expect(rowsSaying(container, "hey")[0].querySelector(".typing-dots")).toBeTruthy());

    const row = await waitFor(() => {
      const r = rowsSaying(container, "hey")[0];
      expect(r.querySelector(".typing-dots")).toBeNull();
      expect(within(r).getByRole("alert")).toBeTruthy();
      return r;
    }, { timeout: 4000 });
    expect(within(row).getByRole("button", { name: /Try again/ })).toBeTruthy();

    await theySay(user, "Shall we start?");
    await waitFor(() => expect(turnCalls()).toHaveLength(2));
  });

  it("a stream that ends without its last event is an error, not dots", async () => {
    const user = userEvent.setup();
    replies = [() => sse({ type: "meta", turn_type: "question" })];
    const { container } = render(<SessionView initialSessionId={1} initialDraft={DRAFT} />);
    await theySay(user, "hey");
    await waitFor(() => {
      const r = rowsSaying(container, "hey")[0];
      expect(r.querySelector(".typing-dots")).toBeNull();
      expect(within(r).getByRole("button", { name: /Try again/ })).toBeTruthy();
    });
  });
});
