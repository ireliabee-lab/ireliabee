import { describe, expect, it } from "vitest";
import { PAGE_WIDTHS, WINDOW_SIZES, getPageWidth } from "./pageWidth";

const components = import.meta.glob("../components/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const source = (name: string) => components[`../components/${name}.tsx`];

describe("page width", () => {
  it("offers widths from narrowest to full, defaulting to Wide", () => {
    const caps = PAGE_WIDTHS.map(w => w.max ?? Infinity);
    expect([...caps].sort((a, b) => a - b)).toEqual(caps);
    expect(PAGE_WIDTHS[PAGE_WIDTHS.length - 1].max).toBeNull();
    expect(getPageWidth()).toBe("wide"); // no localStorage here → the default
  });

  it("window presets grow in both directions", () => {
    for (let i = 1; i < WINDOW_SIZES.length; i++) {
      expect(WINDOW_SIZES[i].w).toBeGreaterThan(WINDOW_SIZES[i - 1].w);
      expect(WINDOW_SIZES[i].h).toBeGreaterThan(WINDOW_SIZES[i - 1].h);
    }
  });
});

describe("every screen shares the page shell", () => {
  // The sidebar's screens; the live session is a full-window workspace on purpose.
  const SCREENS = ["CallSessionsView", "ProgressView", "PracticeView", "PlansView", "AboutYouView", "LibraryView", "SettingsHub"];

  it.each(SCREENS)("%s renders inside <Page>", name => {
    expect(source(name)).toBeDefined();
    expect(source(name)).toMatch(/import Page(, \{ PageTab \})? from "\.\/Page"/);
    expect(source(name)).toContain("<Page");
  });

  it("no view caps its own width or uses the old hub bar", () => {
    for (const [path, src] of Object.entries(components)) {
      expect(src, path).not.toMatch(/practice-hub|practice-bar|practice-body/);
      expect(src, path).not.toMatch(/maxWidth: (560|760|820|860|900) *[,}]/);
    }
  });
});
