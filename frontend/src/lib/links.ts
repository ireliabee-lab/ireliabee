import { fetchApi, isTauri } from "./api";
import { errorFromResponse } from "./errors";

export interface LinkSource {
  url: string; title: string; text: string; author: string;
  platform?: string; captured_at?: string; method: "public" | "browser" | "screenshot";
  /** Set when only the start was public (an X long post): why, and how to get the rest. */
  partial?: string;
}
export interface SourceMetadata { url: string; platform: string; author: string; captured_at: string; method: string; partial?: boolean }
export interface LinkDocument { id: number; name: string; source: SourceMetadata }
export interface LinkFallback { url: string; fallback: true; reason: string; platform: string }
export interface ScreenshotPrice { credits: number; model: string; max_output: number }

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetchApi(path, init);
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const linksApi = {
  preview: (url: string) => json<LinkSource | LinkFallback>("/links/preview", post({ url })),
  save: (source: LinkSource) => json<LinkDocument>("/links/save", post({ url: source.url, title: source.title, text: source.text, author: source.author, method: source.method, ...(source.partial && source.method === "public" ? { partial: true } : {}) })),
  screenshotPrice: () => json<ScreenshotPrice>("/links/screenshot/estimate"),
  screenshot: (url: string, file: File, price: ScreenshotPrice) => {
    const body = new FormData();
    body.append("file", file); body.append("url", url); body.append("confirmed", "true");
    body.append("max_credits", String(price.credits));
    return json<LinkSource>("/links/screenshot", { method: "POST", body });
  },
  openBrowser: async (url: string) => {
    if (!isTauri()) throw new Error("Open this link in the desktop app, or use a screenshot below.");
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_link_browser", { url });
  },
  closeBrowser: async () => {
    if (!isTauri()) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_link_browser");
  },
  listen: async (captured: (source: LinkSource) => void, failed: (error: string) => void) => {
    if (!isTauri()) return () => {};
    const { listen } = await import("@tauri-apps/api/event");
    const [done, error] = await Promise.all([
      listen<LinkSource>("link-captured", e => captured(e.payload)),
      listen<string>("link-capture-error", e => failed(e.payload)),
    ]);
    return () => { done(); error(); };
  },
};
