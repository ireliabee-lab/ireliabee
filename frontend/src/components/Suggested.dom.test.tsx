// @vitest-environment jsdom
/**
 * AI Suggest and the free prefill, rendered: no Suggest request without a
 * click, and a suggestion never replaces what the person typed.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fakeBackend } from "../test/dom";

const backend = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import("../test/dom").fakeBackend> }));
vi.mock("../lib/api", async (orig) => ({
  ...(await orig<typeof import("../lib/api")>()),
  fetchApi: (path: string, init?: RequestInit) => backend.current!.fetchApi(path, init),
}));
vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) }));

import { AiSuggest } from "./Suggested";
import CreateSessionWizard, { type SessionDraft } from "./CreateSessionWizard";

const PRICE = { model: "claude-haiku-4-5", tokens: { input: 300, output: 60 }, usd: 0.0006, credits: 0.0012 };

beforeEach(() => {
  backend.current = fakeBackend({
    "/suggest/estimate": PRICE,
    "/suggest/": { field: "plan.traps_avoid", suggestion: ["Don't oversell"], cost: PRICE },
    "/config/readiness": {},
    "/account/": { signed_in: true, admin: false, balance: { credits: 5, held: 0, available: 5 } },
  });
});

const suggestCalls = () => backend.current!.paths().filter(p => p === "/suggest/");

describe("AI Suggest only asks the AI on a click", () => {
  it("rendering, waiting and typing elsewhere send no Suggest request; the price is shown first", async () => {
    const onSuggest = vi.fn();
    const user = userEvent.setup();
    render(<>
      <input aria-label="Title" />
      <AiSuggest<string[]> field="plan.traps_avoid" label="Traps to avoid" shape="list"
        form={() => ({ title: "Acme interview" })} onSuggest={onSuggest} />
    </>);
    await waitFor(() => expect(backend.current!.paths()).toContain("/suggest/estimate"), { timeout: 2000 });
    expect(await screen.findByText("(<0.01 credits)")).toBeTruthy();
    await user.type(screen.getByLabelText("Title"), "Acme interview");
    await user.tab();
    await new Promise(r => setTimeout(r, 800));
    expect(suggestCalls()).toEqual([]);
    expect(onSuggest).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /Suggest Traps to avoid/ }));
    await waitFor(() => expect(onSuggest).toHaveBeenCalledWith(["Don't oversell"]));
    expect(suggestCalls()).toHaveLength(1);
    const sent = backend.current!.calls.find(c => c.path === "/suggest/")!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ field: "plan.traps_avoid", label: "Traps to avoid", shape: "list", form: { title: "Acme interview" } });
  }, 20_000);   // renders the whole live screen: slow on a busy CI runner

  it("a box for a name, an email, a phone, a password or a card shows no Suggest at all", () => {
    render(<>
      {["profile.name", "profile.email", "profile.phone", "account.password", "billing.card_number", "settings.api_key"].map(f => (
        <AiSuggest key={f} field={f} form={() => ({})} onSuggest={() => {}} />
      ))}
      <AiSuggest field="about.other" label="Your email address" form={() => ({})} onSuggest={() => {}} />
    </>);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("a one-line box that already has text is not suggested over", async () => {
    render(<AiSuggest<string> field="plan.title" label="Plan title" value="Mine" form={() => ({})} onSuggest={() => {}} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("free prefill never overwrites what was typed", () => {
  const draft: SessionDraft = {
    title: "", subtitle: "", tags: [], cvId: null, documentIds: [], peopleIds: [], template: "general",
    model: "claude-haiku-4-5", language: "en", aiInstructions: "", responseTone: "advanced", autoAnswer: false,
  };
  const wizard = () => render(
    <CreateSessionWizard templates={[{ id: "general", label: "General" }]} models={[]} languages={[{ id: "en", label: "English" }]}
      cvs={[]} documents={[]} defaults={draft} onSubmit={() => {}} onCancel={() => {}} />,
  );
  const profile = [{ target_role: "Backend engineer", is_active: 1 }];
  const soon = new Date(Date.now() + 5 * 60_000).toISOString(), later = new Date(Date.now() + 60 * 60_000).toISOString();

  it("typed before the suggestion arrives: the typed text stays", async () => {
    let release!: (v: unknown) => void;
    backend.current = fakeBackend({ "/profiles/": () => new Promise(r => { release = r; }), "/calendar/events": [] });
    const user = userEvent.setup();
    wizard();
    const role = screen.getByPlaceholderText("Senior Python Engineer") as HTMLInputElement;
    await user.type(role, "Designer");
    await act(async () => { release(profile); });
    await new Promise(r => setTimeout(r, 50));
    expect(role.value).toBe("Designer");
    expect(screen.queryByText(/from your profile/)).toBeNull();
  });

  it("a suggestion fills an empty box, marked as one; once edited it is never replaced", async () => {
    let events!: (v: unknown) => void;
    backend.current = fakeBackend({
      "/profiles/": profile,
      "/calendar/events": () => new Promise(r => { events = r; }),
    });
    const user = userEvent.setup();
    wizard();
    const role = screen.getByPlaceholderText("Senior Python Engineer") as HTMLInputElement;
    await waitFor(() => expect(role.value).toBe("Backend engineer"));
    expect(screen.getByText(/from your profile/)).toBeTruthy();

    await user.clear(role);
    await user.type(role, "Platform lead");
    expect(screen.queryByText(/from your profile/)).toBeNull();

    // More suggestions arrive (the calendar): the title fills, the role stays theirs.
    await act(async () => { events([{ title: "Acme final round", start: soon, end: later, all_day: false }]); });
    const title = screen.getByPlaceholderText("e.g. Google SWE Onsite") as HTMLInputElement;
    await waitFor(() => expect(title.value).toBe("Acme final round"));
    expect(role.value).toBe("Platform lead");
  });
});
