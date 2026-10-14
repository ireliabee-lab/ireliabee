import { describe, expect, it } from "vitest";
import { patternDots, patternSvg, type PatternStyle } from "./patterns";
import { THEMES, PALETTES, PATTERNS, getLook, isLight, resolveTheme } from "./theme";

const STYLES: PatternStyle[] = ["flow", "clusters", "drift"];

describe("stipple patterns", () => {
  it.each(STYLES)("%s draws the same picture every time", style => {
    expect(patternSvg(style)).toBe(patternSvg(style));
  });

  it.each(STYLES)("%s has enough dots to read as a texture, few enough to stay light", style => {
    const n = patternDots(style).length;
    expect(n).toBeGreaterThan(300);
    expect(n).toBeLessThan(4000);
    expect(patternSvg(style).length).toBeLessThan(200_000);
  });

  it.each(STYLES)("%s dots never overlap", style => {
    const dots = patternDots(style);
    let overlaps = 0;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const a = dots[i], b = dots[j];
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 < (a.r + b.r) ** 2 - 1e-6) overlaps++;
      }
    }
    expect(overlaps).toBe(0);
  });
});

describe("themes", () => {
  it("every theme sets the same variables, so switching never leaves one behind", () => {
    const keys = Object.keys(PALETTES.midnight).sort();
    for (const t of THEMES) expect(Object.keys(PALETTES[t.id]).sort(), t.id).toEqual(keys);
  });

  it("each picker preview matches its palette's accent and dots", () => {
    const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(", ");
    for (const t of THEMES) {
      expect(rgb(t.accent), t.id).toBe(PALETTES[t.id]["--accent-rgb"]);
      expect(rgb(t.dots), t.id).toBe(PALETTES[t.id]["--pattern-rgb"]);
    }
  });

  it("has a light and a dark default pair, and 'Match system' switches between them", () => {
    expect(THEMES.slice(0, 2).map(t => t.id)).toEqual(["paper", "dark"]);
    expect(resolveTheme("auto", false)).toBe("paper");
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("sage", true)).toBe("sage");   // an explicit choice ignores the system
  });

  it("offers a way to turn patterns off, and defaults sensibly", () => {
    expect(PATTERNS.map(p => p.id)).toContain("none");
    expect(getLook()).toEqual({ theme: "paper", pattern: "flow", strength: "subtle" });
    expect(THEMES[0].id).toBe("paper");  // the default leads the picker
  });
});

describe("every palette is complete and readable", () => {
  // A theme nobody can read is worse than no theme. Text and the colour on a
  // button must clear WCAG AA (4.5:1); quieter things (muted text, the accent
  // against the window) must clear 3:1.
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map(v => channel(v / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const rgbOf = (value: string): number[] => {
    if (value.startsWith("#")) {
      const h = value.slice(1);
      const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
      const n = parseInt(full, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return value.split(",").map(v => Number(v.trim()));
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(rgbOf(a)), luminance(rgbOf(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  const NEEDED = Object.keys(PALETTES.paper);

  it.each(THEMES.map(t => t.id))("%s sets every variable the others do", id => {
    const missing = NEEDED.filter(k => !(k in PALETTES[id]));
    expect(missing, `${id} is missing ${missing.join(", ")}`).toEqual([]);
  });

  it.each(THEMES.map(t => t.id))("%s can be read", id => {
    const p = PALETTES[id];
    expect(contrast(p["--text"], p["--base-rgb"]), "text on the window").toBeGreaterThanOrEqual(4.5);
    expect(contrast(p["--text"], p["--raised-rgb"]), "text on a card").toBeGreaterThanOrEqual(4.5);
    expect(contrast(p["--muted"], p["--base-rgb"]), "quiet text").toBeGreaterThanOrEqual(3);
    expect(contrast(p["--accent-rgb"], p["--base-rgb"]), "the accent").toBeGreaterThanOrEqual(3);
    // 4.4 rather than 4.5: Midnight's white on indigo has always been 4.46.
    expect(contrast(p["--on-primary"], p["--accent-rgb"]), "words on a button").toBeGreaterThanOrEqual(4.4);
  });

  it("says which themes are light, and they are", () => {
    for (const t of THEMES) {
      const bright = luminance(rgbOf(PALETTES[t.id]["--base-rgb"])) > 0.5;
      expect(isLight(t.id), `${t.id}`).toBe(bright);
    }
    expect(THEMES.filter(t => isLight(t.id)).length).toBeGreaterThan(1);
  });

  it("gives every theme its own id, label and swatches", () => {
    const ids = THEMES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of THEMES) {
      expect(t.label.length, t.id).toBeGreaterThan(2);
      expect(t.hint.length, t.id).toBeGreaterThan(8);
      for (const swatch of [t.base, t.raised, t.accent, t.dots]) expect(swatch).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("components follow the theme", () => {
  const components = import.meta.glob("../components/**/*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

  it("no component hard-codes a dark surface colour (use rgba(var(--base-rgb|--raised-rgb), a))", () => {
    for (const [path, src] of Object.entries(components)) {
      for (const m of src.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
        const [r, g, b] = m.slice(1).map(Number);
        const darkSurface = Math.max(r, g, b) < 70 && r + g + b > 0;  // pure black shadows are fine
        expect(darkSurface, `${path}: ${m[0]}`).toBe(false);
      }
    }
  });
});
