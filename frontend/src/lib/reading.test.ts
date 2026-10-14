import { describe, expect, it } from "vitest";
import {
  defaultChapters, estimateCost, formatBytes, formatDuration, pagesLabel, parseNotebookSection, parsePages, percent, rangesLabel,
  type OutlineEntry,
} from "./reading";
import { resolveView } from "./views";

describe("page ranges", () => {
  it("read the ways people write pages", () => {
    expect(parsePages("12–14, 20", 50)).toEqual({ pages: [12, 13, 14, 20] });
    expect(parsePages("3 to 5; pp. 7", 50)).toEqual({ pages: [3, 4, 5, 7] });
    expect(parsePages("9-7", 50)).toEqual({ pages: [7, 8, 9] });
    expect(parsePages("2, 2, 1-2", 50)).toEqual({ pages: [1, 2] });
  });

  it("explain what's wrong instead of guessing", () => {
    expect(parsePages("abc", 50)).toHaveProperty("error");
    expect(parsePages("0-3", 50)).toEqual({ error: "This document has pages 1–50." });
    expect(parsePages("40-60", 50)).toEqual({ error: "This document has pages 1–50." });
    expect(parsePages("1-2-3", 50)).toHaveProperty("error");
    expect(parsePages("  ", 50)).toHaveProperty("error");
  });

  it("label pages back as short ranges", () => {
    expect(rangesLabel([7, 1, 2, 3, 9, 10])).toBe("1–3, 7, 9–10");
    expect(pagesLabel({ page_from: 4, page_to: 4 })).toBe("p. 4");
    expect(pagesLabel({ page_from: 4, page_to: 9 })).toBe("pp. 4–9");
  });
});

describe("choosing chapters", () => {
  const outline: OutlineEntry[] = [
    { idx: 0, level: 1, title: "Abstract", page_from: 1, page_to: 1, kind: "" },
    { idx: 1, level: 1, title: "Methods", page_from: 2, page_to: 4, kind: "" },
    { idx: 2, level: 2, title: "2.1 Data", page_from: 3, page_to: 4, kind: "" },
    { idx: 3, level: 1, title: "References", page_from: 5, page_to: 6, kind: "references" },
    { idx: 4, level: 1, title: "Appendix A", page_from: 7, page_to: 9, kind: "appendix" },
  ];

  it("start with every main chapter except the back matter", () => {
    expect(defaultChapters({ outline })).toEqual([0, 1]);
  });

  it("start with the suggestion for a book", () => {
    expect(defaultChapters({ outline, suggested: { mode: "chapters", chapters: [1] } })).toEqual([1]);
  });
});

describe("numbers people read", () => {
  it("time, size and progress", () => {
    expect(formatDuration(40)).toBe("about a minute");
    expect(formatDuration(600)).toBe("about 10 minutes");
    expect(formatDuration(4000)).toBe("about 1 h 7 min");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3.5 * 1024 * 1024)).toBe("3.5 MB");
    expect(formatBytes(150 * 1024 * 1024)).toBe("150 MB");
    expect(percent(3, 12)).toBe(25);
    expect(percent(5, 0)).toBe(0);
    expect(percent(20, 10)).toBe(100);
  });
});

describe("getting to reading notes", () => {
  it("the Library's Make notes lands on the setup for that document", () => {
    expect(resolveView("notebook:read:7")).toEqual({ view: "notebook", section: "read:7" });
    expect(parseNotebookSection("read:7")).toEqual({ read: { documentId: 7 } });
    expect(parseNotebookSection("read")).toEqual({ read: {} });
  });

  it("a notebook id opens that notebook, anything else the list", () => {
    expect(resolveView("notebook:12")).toEqual({ view: "notebook", section: "12" });
    expect(parseNotebookSection("12")).toEqual({ openId: 12 });
    expect(parseNotebookSection("nonsense")).toEqual({});
    expect(parseNotebookSection(undefined)).toEqual({});
    expect(resolveView("notebook")).toEqual({ view: "notebook" });
  });
});

describe("page ranges match the backend", () => {
  it("drop every p. and pp., as the backend does", () => {
    expect(parsePages("p.1-p.5", 50)).toEqual({ pages: [1, 2, 3, 4, 5] });
    expect(parsePages("pp.3 - pp.4", 50)).toEqual({ pages: [3, 4] });
  });
});

describe("estimateCost (decision 185-1: a price before anything is spent)", () => {
  const est = { usd: 0.42, credits: 0.84, model: "claude-haiku-4-5" };
  it("shows an ordinary account credits, never dollars or the model", () => {
    expect(estimateCost(est, { admin: false, available: 10 })).toEqual({ text: "about 0.84 credits", short: false });
  });
  it("rounds up, so the estimate is never lower than the price", () => {
    expect(estimateCost({ ...est, credits: 1.231 }, { admin: false, available: 10 }).text).toBe("about 1.24 credits");
  });
  it("says so when it is more than the balance", () => {
    const c = estimateCost({ ...est, credits: 3 }, { admin: false, available: 1.5 });
    expect(c.short).toBe(true);
    expect(c.text).toBe("about 3 credits — more than your 1.5 available");
  });
  it("says a debt is a debt, not 'more than your -10.8 available'", () => {
    const c = estimateCost({ ...est, credits: 0.84 }, { admin: false, available: -10.8, credits: -10.8 });
    expect(c.short).toBe(true);
    expect(c.text).toBe("about 0.84 credits — and you owe 10.8 credits, which the next credits you buy pay first");
    // A running session holding more than is left is not a debt.
    expect(estimateCost({ ...est, credits: 0.84 }, { admin: false, available: -0.02, credits: 0.03 }).text)
      .toBe("about 0.84 credits — and you have none available right now");
    expect(estimateCost({ ...est, credits: 0.84 }, { admin: false, available: 0, credits: 0 }).text)
      .toBe("about 0.84 credits — and you have none available right now");
  });
  it("never guesses when the service's prices are unknown", () => {
    expect(estimateCost({ ...est, credits: null }, { admin: false }).text).toBe("charged from your credits as it runs");
  });
  it("shows the admin dollars and the model", () => {
    expect(estimateCost(est, { admin: true }).text).toBe("about $0.42 of claude-haiku-4-5");
  });
});
