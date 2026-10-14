import { describe, expect, it, vi } from "vitest";
import { isSuggestable, priceLabel, priceShort, spentLabel, suggester, withSuggestedItems, withSuggestion } from "./suggestApi";

vi.mock("react-hot-toast", () => ({ default: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) }));

function recorder(reply: unknown = {}) {
  const calls: { path: string; body: any }[] = [];
  const doFetch = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(reply), { status: 200 });
  });
  return { calls, doFetch };
}

describe("AI Suggest asks the AI only when told to", () => {
  it("making the suggester sends nothing", () => {
    const { doFetch } = recorder();
    suggester(doFetch);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("the price comes from the estimate, which is not the AI", async () => {
    const { calls, doFetch } = recorder({ credits: 0.004, usd: 0.002, model: "claude-haiku-4-5" });
    await suggester(doFetch).price("plan.purpose", { title: "Acme interview" });
    expect(calls.map(c => c.path)).toEqual(["/suggest/estimate"]);
  });

  it("only ask() reaches the paid endpoint, with the field and the form", async () => {
    const { calls, doFetch } = recorder({ suggestion: "x", cost: {} });
    const api = suggester(doFetch);
    await api.price("plan.purpose", { title: "Acme" });
    expect(calls.some(c => c.path === "/suggest/")).toBe(false);
    await api.ask("plan.purpose", { title: "Acme" });
    expect(calls[1]).toEqual({ path: "/suggest/", body: { field: "plan.purpose", form: { title: "Acme" } } });
  });

  it("a refusal from the backend becomes an error, not a suggestion", async () => {
    const doFetch = vi.fn(async () => new Response(JSON.stringify({ detail: { code: "invalid", title: "Not enough to go on yet", message: "…" } }), { status: 400 }));
    await expect(suggester(doFetch).ask("plan.purpose", {})).rejects.toBeTruthy();
  });
});

// "Only on a click" is tested rendered: components/Suggested.dom.test.tsx.
describe("one door to the paid endpoint", () => {
  it("no other file calls the paid endpoint", () => {
    const files = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const callers = Object.entries(files)
      .filter(([path, text]) => !/\.test\.tsx?$/.test(path) && !path.includes("/test/") && /["'`]\/suggest\/["'`]/.test(text))
      .map(([path]) => path);
    expect(callers).toEqual(["./suggestApi.ts"]);
  });
});

describe("the price, before and after", () => {
  const user = { admin: false, available: 5, credits: 5 };

  it("is shown in credits before", () => {
    expect(priceLabel({ credits: 0.024, usd: 0.012, model: "m" }, user)).toBe("about 0.03 credits");
    expect(priceLabel({ credits: 0.004, usd: 0.002, model: "m" }, user)).toBe("under 0.01 credits");
  });

  it("says so when it is more than there is", () => {
    expect(priceLabel({ credits: 0.5, usd: 0.25, model: "m" }, { admin: false, available: 0.1, credits: 0.1 })).toMatch(/more than your 0\.1 available/);
  });

  it("never guesses a number it does not have", () => {
    expect(priceLabel(null, user)).toBe("uses credits");
    expect(priceLabel({ credits: null, usd: null, model: "m" }, user)).toBe("charged from your credits as it runs");
  });

  it("the admin on their own keys sees dollars", () => {
    expect(priceLabel({ credits: null, usd: 0.0021, model: "m" }, { admin: true })).toBe("about $0.01 or less");
  });

  it("what it used, after", () => {
    expect(spentLabel({ credits: 0.002, usd: 0.001 }, false)).toBe("under 0.01 credits");
    expect(spentLabel({ credits: 0.031, usd: 0.015 }, false)).toBe("0.04 credits");
    expect(spentLabel({ credits: null, usd: 0.0012 }, true)).toBe("$0.0012");
  });
});

describe("every box may offer Suggest, except these", () => {
  it("ordinary boxes can", () => {
    for (const field of ["plan.traps_avoid", "story.situation", "profile.background", "session.context", "notebook.title", "profile.target_role"]) {
      expect(isSuggestable({ field }), field).toBe(true);
    }
  });

  it("names, contact details, secrets and payment details never", () => {
    for (const field of ["profile.name", "profile.email", "profile.phone", "profile.pronouns", "account.password",
      "settings.api_key", "billing.card_number", "licence.licence_key", "people.full_name", "x.address"]) {
      expect(isSuggestable({ field }), field).toBe(false);
    }
    expect(isSuggestable({ field: "about.other", label: "Your email address" })).toBe(false);
    expect(isSuggestable({ field: "Not a field" })).toBe(false);
  });
});

describe("a suggestion goes in without losing what was typed", () => {
  it("under a box's text, never over it", () => {
    expect(withSuggestion("", "Be brief.")).toBe("Be brief.");
    expect(withSuggestion("Mine.  ", "Be brief.")).toBe("Mine.\nBe brief.");
  });

  it("after a list's items, dropping empty rows", () => {
    expect(withSuggestedItems(["Mine", " "], ["New"])).toEqual(["Mine", "New"]);
  });

  it("a short price for the button beside every box", () => {
    expect(priceShort({ credits: 0.004, usd: 0.002 }, { admin: false })).toBe("<0.01 credits");
    expect(priceShort({ credits: 0.021, usd: 0.01 }, { admin: false })).toBe("~0.03 credits");
    expect(priceShort(null, { admin: false })).toBe("credits");
  });
});
