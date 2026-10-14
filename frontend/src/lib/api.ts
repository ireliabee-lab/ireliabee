/**
 * Centralized API client helper for iReliabee.
 *
 * Handles base URL resolution across:
 * 1. Tauri desktop release bundles — the backend takes a port from the
 *    operating system and tells the app which one; `setBackendBase` records it
 *    before the first request (see lib/backend.ts, src-tauri/src/lib.rs).
 * 2. Local Vite development server, where `make dev-backend` uses 8000
 * 3. Environment overrides via VITE_API_URL and VITE_WS_URL
 *
 * The app asked for port 8000 for years. Anything else holding it — another
 * copy of iReliabee, a development server, any web framework in the world —
 * stopped the app dead, and the splash blamed the user's antivirus. Nothing
 * here may quietly fall back to a guessed port again: a shipped build that
 * does not know where its backend is says so, rather than talking to whatever
 * happens to be listening.
 */

export const isTauri = (): boolean =>
  typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);

/** Where `make dev-backend` puts it, and the only place a port is assumed. */
const DEV_HTTP_HOST = "127.0.0.1:8000";

/** Told to us at startup by the backend itself, through the Rust side. */
let resolvedBase: string | null = null;

/** Record where the backend actually is. Called once, before anything asks. */
export function setBackendBase(url: string) {
  resolvedBase = url.replace(/\/+$/, "");
}

/** The port in use, for the identity proof that is bound to it. 0 if unknown. */
export function backendPort(): number {
  const base = resolvedBase ?? (import.meta.env.VITE_API_URL as string | undefined);
  const port = base ? Number(new URL(base).port) : NaN;
  return Number.isFinite(port) && port > 0 ? port : 0;
}

export function getApiBaseUrl(): string {
  // Explicit env override wins if configured
  if (import.meta.env.VITE_API_URL) {
    return (import.meta.env.VITE_API_URL as string).replace(/\/+$/, "");
  }

  // What the backend told us this launch.
  if (resolvedBase) return resolvedBase;

  // Running the page against a backend started by hand.
  if (import.meta.env.DEV) return `http://${DEV_HTTP_HOST}`;

  // A shipped build with no answer yet. Guessing a port is how the app used to
  // end up talking to someone else's server.
  throw new Error("iReliabee's engine hasn't said where it is listening yet.");
}

export function getWsBaseUrl(): string {
  if (import.meta.env.VITE_WS_URL) {
    return (import.meta.env.VITE_WS_URL as string).replace(/\/+$/, "");
  }
  const httpBase = getApiBaseUrl();
  if (httpBase.startsWith("https://")) {
    return httpBase.replace(/^https:\/\//, "wss://");
  }
  return httpBase.replace(/^http:\/\//, "ws://");
}

/**
 * Strips optional `/api` prefix and resolves against the configured API base URL.
 * e.g.:
 *   apiUrl("/api/status")     -> "http://127.0.0.1:8000/status"
 *   apiUrl("/sessions/")      -> "http://127.0.0.1:8000/sessions/"
 *   apiUrl("/coach/turn")     -> "http://127.0.0.1:8000/coach/turn"
 */
export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  const cleanPath = path.replace(/^\/?api(\/|$)/, "/");
  const normPath = cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;
  return `${base}${normPath}`;
}

/**
 * Resolves a WebSocket path against the active WS base URL.
 * e.g.:
 *   apiWsUrl("/audio/stream") -> "ws://127.0.0.1:8000/audio/stream"
 */
export function apiWsUrl(path: string): string {
  const base = getWsBaseUrl();
  const cleanPath = path.replace(/^\/?(api|ws)(\/|$)/, "/");
  const normPath = cleanPath.startsWith("/") ? cleanPath : `/${cleanPath}`;
  return `${base}${normPath}`;
}

/**
 * Fetch wrapper that automatically targets the correct backend host.
 */
export async function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}

// ── The local backend's per-launch token (audit 180-C3) ─────────────────────
// The backend answers only to this app: every request carries a token that
// changes each launch, fetched from /handshake, which replies only to this
// app's own origin. Any other web page can reach 127.0.0.1 but cannot read it.

let localToken: string | null = null;
let pendingToken: Promise<string> | null = null;

/** The token, fetched once; throws (like a failed fetch) while the backend is down. */
export function localReady(nativeFetch: typeof fetch = fetch): Promise<string> {
  if (localToken) return Promise.resolve(localToken);
  if (!pendingToken) {
    pendingToken = obtainToken(nativeFetch)
      .then(token => { localToken = token; return token; })
      .finally(() => { pendingToken = null; });
  }
  return pendingToken;
}

/**
 * The token, and proof that whatever answers on the port is our backend
 * (audit 182-H2).
 *
 * In the desktop app the token comes from Tauri, which made it and started
 * the backend with it; the backend never hands it out. Anything else that
 * got to the port first could otherwise have served its own "token" and
 * received CVs and transcripts. So the page also sends a random challenge,
 * without the token, and checks the backend's HMAC of it: only the holder of
 * the token can answer, and the answer reveals nothing.
 *
 * Running the backend from source (development only), Tauri's token is not
 * the backend's, so the page asks the backend for its own. A shipped build
 * never does: that fallback is what an impostor would exploit.
 */
async function obtainToken(nativeFetch: typeof fetch): Promise<string> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const fromApp = await invoke<string>("local_token");
    if (await isOurBackend(nativeFetch, fromApp)) return fromApp;
    if (!import.meta.env.DEV) {
      throw new TypeError("Another program is answering on iReliabee's port, not its engine.");
    }
  }
  const r = await nativeFetch(`${getApiBaseUrl()}/handshake`, { cache: "no-store" });
  if (!r.ok) throw new TypeError(`handshake ${r.status}`);
  const token = String((await r.json()).token);
  if (!(await isOurBackend(nativeFetch, token))) throw new TypeError("The engine could not prove who it is.");
  return token;
}

async function isOurBackend(nativeFetch: typeof fetch, token: string): Promise<boolean> {
  const challenge = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  const r = await nativeFetch(`${getApiBaseUrl()}/identify?n=${challenge}`, { cache: "no-store" });
  if (!r.ok) return false;
  const { proof } = await r.json().catch(() => ({ proof: "" }));
  return typeof proof === "string" && proof === await hmacHex(token, challenge);
}

export async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  return Array.from(mac, b => b.toString(16).padStart(2, "0")).join("");
}

/** Forget the token: the backend restarted and made a new one. */
export function forgetLocalToken() { localToken = null; }

/** The token as a query, for the places a header cannot go: WebSockets, <audio src>. */
function withToken(url: string): string {
  if (!localToken) return url;
  return `${url}${url.includes("?") ? "&" : "?"}t=${encodeURIComponent(localToken)}`;
}

/** A backend URL an <audio> element can load. Await localReady() first. */
export function apiMediaUrl(path: string): string {
  return withToken(apiUrl(path));
}

/** A backend WebSocket URL with the token. Await localReady() first. */
export function apiSocketUrl(path: string): string {
  return withToken(apiWsUrl(path));
}
