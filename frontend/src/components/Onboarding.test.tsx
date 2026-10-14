import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Onboarding, { STEPS } from "./Onboarding";
import { resolveView } from "../lib/views";

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

/**
 * Found after signing out: the checklist showed every step but sign-in as
 * done, struck through and with no button, so there was no way back into
 * any of them; and "Sign in" opened Settings on General, not Your account.
 */
const signedOut = {
  steps: [
    { id: "persona", done: true }, { id: "account", done: false }, { id: "profile", done: true },
    { id: "cv", done: true }, { id: "practice", done: true },
  ],
  done: 4, total: 5,
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the setup checklist", () => {
  it("'Sign in' goes to Settings → Your account, where the address is typed", () => {
    expect(resolveView(STEPS.account.view)).toEqual({ view: "settings", section: "plan" });
  });

  it("every step's button goes somewhere real", () => {
    for (const [id, step] of Object.entries(STEPS)) {
      expect(resolveView(step.view).view, id).not.toBe("session");
    }
  });

  it("a finished step keeps a way back in, so signing out never shuts setup away", () => {
    const shown = text(renderToStaticMarkup(
      <Onboarding status={signedOut} open onClose={() => {}} onNav={() => {}} />,
    ));
    expect(shown).toContain("Sign in");
    for (const again of ["Change", "Edit", "Replace", "Practise again"]) expect(shown).toContain(again);
  });
});
