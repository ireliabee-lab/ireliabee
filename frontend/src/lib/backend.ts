import { apiUrl, fetchApi, forgetLocalToken, getApiBaseUrl, isTauri, localReady, setBackendBase } from "./api";

/**
 * Every call to the backend goes through here.
 *
 * - Packaged builds have no Vite proxy, so a relative /api URL is pointed at
 *   the sidecar instead of the webview origin.
 * - Every backend call carries the per-launch token the backend requires
 *   (audit 180-C3). If the backend restarted and made a new one, the call is
 *   refused with `x-irb-auth: required`; a fresh token is fetched and the call
 *   tried once more.
 */
export function installApiRouting() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // Until the backend has said where it is, there is no base to compare a
    // URL against — and nothing can be addressed to it anyway, since its
    // address is what we are missing. Such a call is somebody else's, so it
    // goes out untouched rather than taking this patch down with it.
    let base: string;
    try {
      base = getApiBaseUrl();
    } catch {
      return nativeFetch(input, init);
    }
    if (!import.meta.env.DEV && typeof input === "string" && (input === "/api" || input.startsWith("/api/"))) {
      input = apiUrl(input);
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // The token's own endpoints go out bare: /identify must never carry the
    // token it is checking, and neither may wait on it.
    if (!url.startsWith(base) || url.startsWith(`${base}/handshake`) || url.startsWith(`${base}/identify`)) {
      return nativeFetch(input, init);
    }

    const send = async () => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("x-irb-token", await localReady(nativeFetch));
      return nativeFetch(input, { ...init, headers });
    };
    const first = await send();
    // A Request's body can be read once; anything else can be sent again.
    if (first.status === 401 && first.headers.get("x-irb-auth") === "required" && !(input instanceof Request)) {
      forgetLocalToken();
      return send();
    }
    return first;
  };
}

/** What the Rust side says about the backend's port (src-tauri/src/lib.rs). */
type BackendState =
  | { state: "waiting" }
  | { state: "ready"; port: number }
  | { state: "failed"; reason: string };

/** What the Rust side currently knows, or null when there is nobody to ask. */
async function backendState(): Promise<BackendState | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<BackendState>("backend_port");
  } catch {
    return null;
  }
}

/**
 * Find out where the backend is listening, before anything asks.
 *
 * The backend takes a port from the operating system, so there is no number to
 * assume; it reports the one it got, the Rust side keeps it, and this asks for
 * it. Outside the desktop app there is no one to ask — the page is talking to
 * a backend someone started by hand, on the port the Makefile uses.
 *
 * Returns the reason when the engine is not coming up, so the screen can say
 * what happened rather than counting down to a guess.
 */
export async function resolveBackendBase(timeoutMs = 25_000): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isTauri()) return { ok: true };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const told = await backendState();
    if (!told) return { ok: false, reason: "the app could not ask where its engine is" };
    if (told.state === "ready") {
      setBackendBase(`http://127.0.0.1:${told.port}`);
      return { ok: true };
    }
    if (told.state === "failed") return { ok: false, reason: told.reason };
    await new Promise(res => setTimeout(res, 100));
  }
  return { ok: false, reason: "the engine did not start in time" };
}

/** Where the backend writes down what happened, for the splash to point at. */
export async function backendLogPath(): Promise<string> {
  if (!isTauri()) return "~/.config/ireliabee/backend.log";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("backend_log_path");
  } catch {
    return "~/.config/ireliabee/backend.log";
  }
}

/**
 * Wait for the backend to start answering — and say what stopped it if it
 * does not.
 *
 * This used to return a bare true or false after ninety seconds, throwing away
 * every error on the way, so a backend that had died in one second still cost
 * the user a minute and a half of "nearly there" before being told, wrongly,
 * that their antivirus might be at fault.
 *
 * It now stops as soon as the app knows the engine is gone, and hands back the
 * last thing that actually happened.
 */
export async function waitForBackend(timeoutMs = 25_000): Promise<{ ok: true } | { ok: false; reason: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    // It may have started and then fallen over: the port is announced before
    // the backend has finished loading.
    const now = await backendState();
    if (now?.state === "failed") return { ok: false, reason: now.reason };

    try {
      const r = await fetchApi("/status", { cache: "no-store" });
      if (r.ok) return { ok: true };
      last = `the engine answered with ${r.status}`;
    } catch (e) {
      last = e instanceof Error && e.message ? `the engine could not be reached (${e.message})` : "the engine could not be reached";
    }
    await new Promise(res => setTimeout(res, 500));
  }
  return { ok: false, reason: last || "the engine did not answer in time" };
}
