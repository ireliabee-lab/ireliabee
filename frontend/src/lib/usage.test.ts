import { describe, expect, it } from "vitest";

// Mirrors backend/usage.py EVENT_RE — names that don't match are silently dropped there.
const EVENT_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;

// Every source file as text (Vite resolves this at build time; no Node APIs needed).
const sources = import.meta.glob(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}"], {
  query: "?raw", import: "default", eager: true,
}) as Record<string, string>;

describe("usage event names", () => {
  it("every literal track() name is accepted by the backend", () => {
    const names = Object.values(sources).flatMap(src => [...src.matchAll(/track\("([^"]+)"\)/g)].map(m => m[1]));
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter(n => !EVENT_RE.test(n))).toEqual([]);
  });
});
