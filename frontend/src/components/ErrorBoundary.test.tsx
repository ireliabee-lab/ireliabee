import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import ErrorBoundary from "./ErrorBoundary";

vi.mock("react-hot-toast", () => ({ default: { error: vi.fn() } }));

/** What the boundary shows once a child has thrown (audit 181-H12). */
function fallback(props: ConstructorParameters<typeof ErrorBoundary>[0]) {
  const b = new ErrorBoundary(props);
  b.state = ErrorBoundary.getDerivedStateFromError(new Error("boom"));
  const out = b.render() as ReactElement | null;
  return out ? renderToStaticMarkup(out) : null;
}

describe("ErrorBoundary", () => {
  it("a broken screen keeps the app and offers to try again", () => {
    const html = fallback({ level: "view", children: null })!;
    expect(html).toContain("This screen ran into a problem");
    expect(html).toContain("Try again");
    // The exception text is reachable, not the first thing read: it used to sit
    // in the open under "Nothing you saved is lost", which tells a user nothing
    // and reads like the app arguing with them.
    expect(html).toContain("Show details");
    expect(html).toContain("boom");
    expect(html.indexOf("Show details")).toBeLessThan(html.indexOf("boom"));
  });

  it("a whole-app failure is a visible, draggable page with Reload", () => {
    const html = fallback({ level: "app", children: null })!;
    expect(html).toContain("data-tauri-drag-region");
    expect(html).toContain("Reload");
  });

  it("a broken dialog closes instead of stranding a panel", () => {
    const onReset = vi.fn();
    expect(fallback({ level: "dialog", onReset, children: null })).toBeNull();
    const b = new ErrorBoundary({ level: "dialog", onReset, children: null });
    b.componentDidCatch(new Error("boom"), { componentStack: "" });
    expect(onReset).toHaveBeenCalled();
  });

  it("with no error, the children render as they are", () => {
    const b = new ErrorBoundary({ level: "view", children: "hello" });
    expect(b.render()).toBe("hello");
  });
});
