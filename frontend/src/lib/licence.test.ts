import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRO_FEATURES, canGoLive, formatDate, hasFeature, licenceNow,
  loadLicence, onLicenceChange, setLicence, type LicenceStatus,
} from "./licence";

function status(overrides: Partial<LicenceStatus> = {}): LicenceStatus {
  return {
    licence: {
      state: "active", tier: "pro", plan: "annual", licence_id: "lic_1",
      holder: "Ada", seats: 1, expires_at: 2_000_000_000, grace_until: null,
      message: "", is_pro: true,
    },
    features: Object.fromEntries(PRO_FEATURES.map(f => [f, true])) as LicenceStatus["features"],
    free_live_sessions: { limit: 2, used: 0, left: 2 },
    can_start_live: true,
    ...overrides,
  };
}

const FREE_STATUS = status({
  licence: { ...status().licence, state: "none", tier: "free", is_pro: false },
  features: Object.fromEntries(PRO_FEATURES.map(f => [f, false])) as LicenceStatus["features"],
});

function mockFetch(impl: (url: string) => unknown) {
  const fn = vi.fn(async (url: string) => ({
    ok: true, status: 200, json: async () => impl(url),
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => setLicence(FREE_STATUS));
afterEach(() => vi.unstubAllGlobals());

describe("licence cache", () => {
  it("assumes nothing is paid for until the backend says otherwise", () => {
    expect(licenceNow().licence.is_pro).toBe(false);
    for (const feature of PRO_FEATURES) expect(hasFeature(feature)).toBe(false);
  });

  it("shares one request between callers that ask at the same moment", async () => {
    const fetchMock = mockFetch(() => status());
    const [a, b, c] = await Promise.all([loadLicence(), loadLicence(), loadLicence()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.licence.is_pro && b.licence.is_pro && c.licence.is_pro).toBe(true);
  });

  it("tells subscribers when the licence changes", async () => {
    const seen: boolean[] = [];
    const off = onLicenceChange(s => seen.push(s.licence.is_pro));
    mockFetch(() => status());
    await loadLicence();
    off();
    await loadLicence();
    expect(seen).toEqual([true]);
  });

  it("keeps the last known state when the backend is unreachable", async () => {
    setLicence(status());
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Failed to fetch"); }));
    const result = await loadLicence();
    expect(result.licence.is_pro).toBe(true);
  });
});

describe("going live", () => {
  it("asks about the specific session, without touching the licence service", async () => {
    const fetchMock = mockFetch(() => status({ can_start_live: true }));
    await canGoLive(42);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("session_id=42");
    expect(url).toContain("refresh=false");
  });

  it("refuses when the free sessions are spent", async () => {
    mockFetch(() => status({
      can_start_live: false,
      free_live_sessions: { limit: 2, used: 2, left: 0 },
    }));
    expect(await canGoLive(7)).toBe(false);
  });

  it("does not put a session-specific answer into the shared cache", async () => {
    setLicence(FREE_STATUS);
    mockFetch(() => status({ can_start_live: true, holds_grant: true }));
    await canGoLive(7);
    expect(licenceNow().holds_grant).toBeFalsy();
    expect(licenceNow().licence.is_pro).toBe(false);
  });

  it("lets the call go ahead if the check itself fails", async () => {
    // The backend gate is the real enforcement. A broken local request must
    // never stand between someone and their own interview.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Failed to fetch"); }));
    expect(await canGoLive(7)).toBe(true);
  });

  it("allows a session that has not been created yet", async () => {
    expect(await canGoLive(null)).toBe(true);
  });
});

describe("dates", () => {
  it("shows nothing rather than 1970 when there is no date", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(0)).toBe("");
    expect(formatDate(undefined)).toBe("");
  });

  it("formats a real date", () => {
    expect(formatDate(1_800_000_000)).toMatch(/2027/);
  });
});
