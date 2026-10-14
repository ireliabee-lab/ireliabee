import { describe, expect, it } from "vitest";
import { formatCredits, lowCreditNotice, owedAmount, owedCredits, owedNotice, readAgo } from "./account";

/**
 * The two places the account screen turns a number into something a person
 * reads. Both are small and both are easy to get subtly wrong in a way nobody
 * notices until a balance looks like the wrong amount of money.
 */
describe("formatCredits", () => {
  it("does not put a decimal point on a whole balance", () => {
    expect(formatCredits(5)).toBe("5");
    expect(formatCredits(0)).toBe("0");
  });

  it("keeps a half credit, because half a credit is an ordinary balance", () => {
    // A session costs half a credit, so rounding here would show people more
    // or less than they have.
    expect(formatCredits(3.5)).toBe("3.5");
    expect(formatCredits(0.5)).toBe("0.5");
  });

  it("keeps two places when there are two to keep", () => {
    expect(formatCredits(3.25)).toBe("3.25");
  });

  it("survives nothing at all", () => {
    expect(formatCredits(null)).toBe("0");
    expect(formatCredits(undefined)).toBe("0");
    expect(formatCredits(Number.NaN)).toBe("0");
  });

  it("shows a negative balance rather than hiding it", () => {
    // A refund after the credits were spent is a real debt; the screen has to
    // be able to say so.
    expect(formatCredits(-0.5)).toBe("-0.5");
  });
});

describe("readAgo", () => {
  const ago = (seconds: number) => Math.floor(Date.now() / 1000) - seconds;

  it("says nothing when there is no reading to date", () => {
    expect(readAgo(null)).toBe("");
    expect(readAgo(0)).toBe("");
  });

  it("calls a fresh reading just now", () => {
    expect(readAgo(ago(5))).toBe("just now");
  });

  it("counts minutes, then hours, then days", () => {
    expect(readAgo(ago(600))).toBe("10 minutes ago");
    expect(readAgo(ago(3600))).toBe("an hour ago");
    expect(readAgo(ago(5 * 3600))).toBe("5 hours ago");
    expect(readAgo(ago(26 * 3600))).toBe("yesterday");
    expect(readAgo(ago(3 * 86400))).toBe("3 days ago");
  });

  it("does not claim a reading from the future", () => {
    expect(readAgo(ago(-60))).toBe("just now");
  });
});

import { liveMinutes } from "./account";

describe("liveMinutes (audit 178-H2: tell people what their balance buys)", () => {
  it("counts a credit as thirty minutes", () => {
    expect(liveMinutes(1)).toBe("30 minutes");
    expect(liveMinutes(0.3)).toBe("9 minutes");
  });
  it("reads large balances in hours", () => {
    expect(liveMinutes(4.5)).toBe("2 hours 15 min");
    expect(liveMinutes(2)).toBe("1 hour");
  });
  it("never says zero minutes for a balance that still starts a session", () => {
    expect(liveMinutes(0.02)).toBe("less than a minute");
  });
});

describe("the heads-up before a call", () => {
  // Nothing looked at the balance until a call was already running, so the
  // first a user heard of it was mid-interview.
  it("says nothing when there is plenty", () => {
    expect(lowCreditNotice({ available: 5, low: false })).toBeNull();
  });

  it("says nothing when the balance was never read, rather than guessing", () => {
    expect(lowCreditNotice(null)).toBeNull();
    expect(lowCreditNotice(undefined)).toBeNull();
  });

  it("says how long is left, in minutes, not just in credits", () => {
    const notice = lowCreditNotice({ available: 0.4, low: true })!;
    expect(notice).toContain("12 minutes");
    expect(notice).toContain("0.4");
  });

  it("an empty balance says the call will stop, not that it might", () => {
    const notice = lowCreditNotice({ available: 0, low: true })!;
    expect(notice).toMatch(/no credits left/i);
    expect(notice).toMatch(/top up/i);
  });

  it("gets the singular right", () => {
    expect(lowCreditNotice({ available: 1, low: true })).toContain("1 credit left");
  });
});

describe("a balance below zero is a debt (F11)", () => {
  // Credits taken back after they were spent leave the balance below zero.
  // The screen showed "-10.8 credits" and promised a pack or the free credit
  // would get them going again, which a debt bigger than either swallows.
  it("owes what the ledger is below zero, and nothing otherwise", () => {
    expect(owedCredits({ credits: -10.8, held: 0, available: -10.8 })).toBe(10.8);
    expect(owedCredits({ credits: 3, held: 0, available: 3 })).toBe(0);
    expect(owedCredits({ credits: 0, held: 0, available: 0 })).toBe(0);
    expect(owedCredits(null)).toBe(0);
    expect(owedCredits(undefined)).toBe(0);
  });

  it("a session holding more than is left is not a debt", () => {
    // Available dips below zero while a running session holds more than the
    // ledger has; nothing is owed until the ledger itself is below zero.
    expect(owedCredits({ credits: 0.03, held: 0.05, available: -0.02 })).toBe(0);
  });

  it("reads available when that is all there is, as the pre-call check has", () => {
    expect(owedCredits({ available: -2.5 })).toBe(2.5);
  });

  it("says the amount in words, and never '0.0'", () => {
    expect(owedAmount(10.8)).toBe("10.8 credits");
    expect(owedAmount(1)).toBe("1 credit");
    expect(owedAmount(0.004)).toBe("less than 0.01 credits");
  });

  it("says what gets paid first, and promises nothing a pack may not deliver", () => {
    const notice = owedNotice(10.8);
    expect(notice).toBe("You owe 10.8 credits. The next credits you buy pay that first, and what's left after it is yours to use.");
    expect(notice).not.toMatch(/-10\.8/);
    expect(notice).not.toMatch(/free credit/i);
  });

  it("the heads-up before a call says they owe, not that they have -10.8", () => {
    const notice = lowCreditNotice({ available: -10.8, low: true })!;
    expect(notice).toMatch(/^You owe 10\.8 credits/);
    expect(notice).toMatch(/next credits you buy pay that first/);
    expect(notice).not.toMatch(/-10\.8/);
    expect(notice).not.toMatch(/no credits left/i);
  });
});
