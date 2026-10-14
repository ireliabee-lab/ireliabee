import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BalanceSummary } from "./AccountPanel";

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

/** The balance as the account screen shows it, as plain text. */
function shown(credits: number, held = 0, elsewhere = false) {
  const html = renderToStaticMarkup(
    <BalanceSummary
      balance={{ credits, held, available: credits - held }}
      free={{ month: "2026-09", granted: true, elsewhere }}
    />,
  );
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
}

describe("the account screen's balance", () => {
  it("a balance below zero shows what is owed, not a minus figure (F11)", () => {
    const text = shown(-10.8);
    expect(text).toMatch(/^10\.8 credits owed/);
    expect(text).not.toContain("-10.8");
    expect(text).toContain("You owe 10.8 credits. The next credits you buy pay that first, and what's left after it is yours to use.");
    expect(text).toContain("Until you're back above zero, live sessions, practice calls and debriefs won't start.");
    expect(text).not.toContain("You are out of credits");
    expect(text).not.toContain("of live session ·");
  });

  it("a debt is said even while a session is still running", () => {
    const text = shown(-2, 0.5);
    expect(text).toMatch(/^2 credits owed/);
    expect(text).toContain("0.5 reserved by a session that is still running.");
    expect(text).toContain("You owe 2 credits.");
  });

  it("a session holding more than is left shows nothing to spend, not a debt", () => {
    const text = shown(0.03, 0.05);
    expect(text).toMatch(/^0 credits/);
    expect(text).not.toContain("owe");
    expect(text).not.toContain("-0.02");
  });

  it("an empty balance is out of credits, and a positive one says how long it lasts", () => {
    expect(shown(0)).toContain("You are out of credits");
    expect(shown(0, 0, true)).toContain("went to another account");
    const some = shown(2);
    expect(some).toMatch(/^2 credits Time left 1 h of live session/);
    expect(some).not.toContain("owe");
  });
});
