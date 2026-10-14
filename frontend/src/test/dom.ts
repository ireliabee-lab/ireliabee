/**
 * What rendered tests need that jsdom leaves out. Imported by the test files
 * that run under `// @vitest-environment jsdom`; the rest of the suite stays
 * in node and never loads this.
 */
import { vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
if (!("ResizeObserver" in window)) {
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
}
Element.prototype.scrollTo ??= function scrollTo() {} as typeof Element.prototype.scrollTo;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

/** A JSON reply for a mocked fetchApi. */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * A fetchApi stand-in that answers by path and records every call, so a test
 * can say exactly which requests were made.
 */
export function fakeBackend(routes: Record<string, unknown | ((init?: RequestInit) => unknown)> = {}) {
  const calls: { path: string; body: unknown }[] = [];
  const fetchApi = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find(k => path === k || path.startsWith(k));
    const answer = key ? routes[key] : undefined;
    const value = typeof answer === "function" ? await (answer as (i?: RequestInit) => unknown)(init) : answer;
    if (value instanceof Response) return value;
    return value === undefined ? json({}, 404) : json(value);
  });
  return { calls, fetchApi, paths: () => calls.map(c => c.path) };
}
