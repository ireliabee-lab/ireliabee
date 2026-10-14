import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetLocalToken, hmacHex, localReady } from "./api";

/** A backend on the port: the real one proves the token; an impostor cannot. */
function backend(token: string, { impostor = false } = {}) {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/handshake") return new Response(JSON.stringify({ token }), { status: 200 });
    if (u.pathname === "/identify") {
      const n = u.searchParams.get("n") ?? "";
      const proof = impostor ? "0".repeat(64) : await hmacHex(token, n);
      return new Response(JSON.stringify({ proof }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

afterEach(() => forgetLocalToken());

describe("the local backend's identity (audit 182-H2)", () => {
  it("the page's HMAC is standard HMAC-SHA256 (the published test vector)", async () => {
    expect(await hmacHex("key", "The quick brown fox jumps over the lazy dog"))
      .toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });

  it("the real backend is trusted", async () => {
    expect(await localReady(backend("t".repeat(43)))).toBe("t".repeat(43));
  });

  it("something else on the port is not, even with a token of its own", async () => {
    await expect(localReady(backend("fake", { impostor: true }))).rejects.toThrow(/could not prove/);
  });

  it("the challenge goes out without the token", async () => {
    const f = backend("t".repeat(43));
    await localReady(f);
    const identify = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([url]) => String(url).includes("/identify"));
    expect(String(identify?.[0])).not.toContain("t".repeat(43));
  });
});

// ── Where the backend is ────────────────────────────────────────────────────
// The app asked for port 8000 for years. Anything else holding that port —
// another copy of iReliabee, a development server, any web framework in the
// world — stopped it dead, and the splash blamed the user's antivirus. The
// backend now takes a port from the operating system and says which one it
// got. These pin down that the page uses what it was told, and that a shipped
// build never invents an address instead.

async function freshApi({ apiUrl = "", ...env }: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.stubEnv("VITE_API_URL", apiUrl as string);
  vi.stubEnv("VITE_WS_URL", "");
  const api = await import("./api");
  // import.meta.env is read at call time, so patch the object the module sees.
  Object.assign(import.meta.env, { DEV: true, PROD: false, VITE_API_URL: apiUrl, ...env });
  return api;
}

describe("Finding the backend", () => {
  beforeEach(() => { vi.unstubAllEnvs(); });

  it("uses the port the backend reported", async () => {
    const api = await freshApi();
    api.setBackendBase("http://127.0.0.1:49812");
    expect(api.getApiBaseUrl()).toBe("http://127.0.0.1:49812");
    expect(api.apiUrl("/status")).toBe("http://127.0.0.1:49812/status");
    expect(api.apiWsUrl("/audio/stream")).toBe("ws://127.0.0.1:49812/audio/stream");
  });

  it("takes a later answer, since each launch gets its own port", async () => {
    const api = await freshApi();
    api.setBackendBase("http://127.0.0.1:1111");
    api.setBackendBase("http://127.0.0.1:2222");
    expect(api.apiUrl("/status")).toBe("http://127.0.0.1:2222/status");
  });

  it("keeps the port to hand, for the proof that is tied to it", async () => {
    const api = await freshApi();
    api.setBackendBase("http://127.0.0.1:49812");
    expect(api.backendPort()).toBe(49812);
  });

  it("falls back to the development port only while developing", async () => {
    // `make dev-backend` runs on 8000, with the page open in a browser.
    const api = await freshApi({ DEV: true, PROD: false });
    expect(api.getApiBaseUrl()).toBe("http://127.0.0.1:8000");
  });

  it("a shipped build refuses to guess an address", async () => {
    // The point of the whole change: a packaged app that does not know where
    // its backend is says so, rather than talking to whoever is on 8000.
    const api = await freshApi({ DEV: false, PROD: true });
    expect(() => api.getApiBaseUrl()).toThrow(/hasn't said where/i);
  });

  it("an explicit override still wins over everything", async () => {
    const api = await freshApi({ apiUrl: "http://127.0.0.1:8123/", DEV: false, PROD: true });
    expect(api.getApiBaseUrl()).toBe("http://127.0.0.1:8123");
    expect(api.backendPort()).toBe(8123);
  });

  it("knows nothing before it has been told, and says nothing either", async () => {
    const api = await freshApi({ DEV: false, PROD: true });
    expect(api.backendPort()).toBe(0);
  });
});
