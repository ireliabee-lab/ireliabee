import { describe, expect, it } from "vitest";
import { creditLine } from "./UpgradeDialog";

const signedIn = (credits: number, extra: { held?: number; elsewhere?: boolean } = {}) => ({
  signed_in: true,
  balance: { credits, held: extra.held ?? 0, available: credits - (extra.held ?? 0) },
  free: { month: "2026-09", granted: true, elsewhere: Boolean(extra.elsewhere) },
});

describe("the dialog's credit line", () => {
  it("a balance below zero says what is owed and what gets paid first (F11)", () => {
    // An admin took back 13 credits from someone who had 2.2 left.
    const line = creditLine(signedIn(-10.8));
    expect(line).toMatch(/^You owe 10\.8 credits\./);
    expect(line).toContain("The next credits you buy pay that first");
    // The old line promised this, and at -10.8 neither a small pack nor the
    // free credit brings them back.
    expect(line).not.toMatch(/next month's free credit/);
    expect(line).not.toMatch(/gets you practising and live again/);
    expect(line).not.toContain("-10.8");
  });

  it("owing wins over the free credit having gone elsewhere", () => {
    expect(creditLine(signedIn(-3, { elsewhere: true }))).toMatch(/^You owe 3 credits\./);
  });

  it("an empty balance is still out of credits, and a positive one says what it buys", () => {
    expect(creditLine(signedIn(0))).toMatch(/^You are out of credits\./);
    expect(creditLine(signedIn(0, { elsewhere: true }))).toMatch(/went to another account/);
    expect(creditLine(signedIn(2))).toMatch(/^You have 2 credits — about 1 hour of live session/);
  });

  it("signed out asks them to sign in", () => {
    expect(creditLine({ signed_in: false, balance: null, free: null })).toMatch(/^Sign in to use credits/);
  });
});
