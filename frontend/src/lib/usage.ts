import { fetchApi } from "./api";

/**
 * Count a screen open or key action in the local usage table (backend/usage.py).
 * Stays on this machine; used to decide which screens to merge (docs/ROADMAP.md).
 * Fire-and-forget: never blocks or surfaces errors.
 *
 * Event names: "view:<id>" for screens, "<area>.<action>" for actions.
 */
export function track(event: string): void {
  try {
    fetchApi("/usage/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* ignore */ }
}
