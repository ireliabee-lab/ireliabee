import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { clampCue, CUE_DEFAULT, CUE_MAX, CUE_MIN } from "./NotebookPage";

describe("the Test yourself column width", () => {
  it("keeps the width between the limits", () => {
    expect(clampCue(5)).toBe(CUE_MIN);
    expect(clampCue(80)).toBe(CUE_MAX);
    expect(clampCue(30)).toBe(30);
  });
  it("rounds to one decimal so the saved value stays short", () => {
    expect(clampCue(31.23456)).toBe(31.2);
  });
  it("falls back to the default for a broken saved value", () => {
    expect(clampCue(Number("abc"))).toBe(CUE_DEFAULT);
    expect(clampCue(Infinity)).toBe(CUE_DEFAULT);
  });
});

describe("meeting card widths", () => {
  it("keeps saved spans between 1 and the maximum, and falls back per card", async () => {
    const { cleanSpans, SPAN_DEFAULT, SPAN_MAX } = await import("./NotebookPage");
    expect(cleanSpans(null)).toEqual(SPAN_DEFAULT);
    const spans = cleanSpans({ decisions: 2, actions: 9, risks: 0, questions: "3", numbers: 1.5 });
    expect(spans.decisions).toBe(2);
    expect(spans.actions).toBe(SPAN_DEFAULT.actions);
    expect(spans.risks).toBe(SPAN_DEFAULT.risks);
    expect(spans.questions).toBe(Math.min(3, SPAN_MAX));
    expect(spans.numbers).toBe(SPAN_DEFAULT.numbers);
  });
});

describe("ruled paper keeps its rhythm", () => {
  // Layout can't be measured here (no browser), so this guards the rule that
  // broke it: a heading is a flex row, so its items decide the row's height.
  // At line-height 1 each heading came out short of a ruled row and every
  // section pushed the writing below it further off the rules.
  // Read from disk: Vite stubs stylesheets in tests, so a raw import is empty.
  const text = readFileSync(new URL("../../notebook.css", import.meta.url), "utf8");

  it("gives the section heading's parts the paper's line height, after the rule that flattens inline text", () => {
    const flattens = text.indexOf(".nb-paper-classic :is(.nb-b, .nb-section-title");
    const restores = text.indexOf(".nb-paper-classic .nb-section-title > :is(span");
    expect(flattens, "the rule that sets line-height: 1 on inline text").toBeGreaterThan(-1);
    expect(restores, "the rule that puts the heading back on the rhythm").toBeGreaterThan(-1);
    expect(restores).toBeGreaterThan(flattens);                    // later wins: same specificity
    const rule = text.slice(restores, text.indexOf("}", restores));
    expect(rule).toContain("line-height: var(--L)");
  });

  it("measures every row of the classic paper in --L", () => {
    const start = text.indexOf("── Ruled paper");
    const block = text.slice(start, text.indexOf("/* ──", start + 40));
    // Small inline things (the source chip, the key star) sit inside a row and are
    // sized in their own terms. Everything that makes a row is sized in --L: by its
    // height, or by its line height when it has no height of its own.
    // Inline text inside a row (spans, links, the source chip) doesn't set the row's
    // height — the block's own line height does. The heading is the exception, and
    // the test above covers it.
    const inline = /\.nb-src|nb-key-star|nb-chip|nb-number|svg|:is\(span/;
    const inRows = /var\(--L|calc\(var\(--L|auto|inherit|^0(px)?$/;
    for (const rule of block.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const [, selector, body] = rule;
      if (inline.test(selector)) continue;
      const hasHeight = /(^|;)\s*height\s*:/.test(body);
      for (const d of body.matchAll(/(^|;)\s*(height|line-height|padding-top|padding-bottom)\s*:\s*([^;]+)/g)) {
        const [, , prop, raw] = d;
        const value = raw.trim();
        if (prop === "line-height" && hasHeight) continue;          // its height already sets the row
        expect(value, `${selector.trim()} { ${prop}: ${value} }`).toMatch(inRows);
      }
    }
  });
});
