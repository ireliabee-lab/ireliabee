/**
 * Licence state for the UI.
 *
 * One shared copy, one request. Several screens ask "is this Pro?" at the same
 * moment — the sidebar, a gated view and the session toolbar can all mount in
 * the same frame — so the status is cached here and broadcast to subscribers
 * rather than fetched per component.
 *
 * The backend is the authority (`backend/entitlements.py`). Nothing here
 * decides anything: it only reflects what the backend already said, so a stale
 * or missing cache can never open a gate.
 */
import { useEffect, useState } from "react";
import { fetchApi } from "./api";

export const PRO_FEATURES = [
  "live", "calendar", "recap", "people", "study", "notebook", "retry", "exams", "export",
] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export const BUY_URL = "https://ireliabee.co.uk/pro";

export type LicenceState =
  | "none" | "active" | "grace" | "expired" | "invalid" | "revoked";

export interface Licence {
  state: LicenceState;
  tier: "free" | "pro";
  plan: string;
  licence_id: string;
  holder: string;
  seats: number;
  expires_at: number | null;
  grace_until: number | null;
  message: string;
  is_pro: boolean;
}

export interface LicenceStatus {
  licence: Licence;
  features: Record<ProFeature, boolean>;
  free_live_sessions: { limit: number; used: number; left: number };
  /** Whether the free-session limit is actually enforced. */
  enforced?: boolean;
  /** Whether the session this was asked about may go live right now. */
  can_start_live: boolean;
  /** Whether that session has already spent a free live grant. */
  holds_grant?: boolean;
}

/** What we assume before the first reply, and if the backend can't be reached. */
const FREE: LicenceStatus = {
  licence: {
    state: "none", tier: "free", plan: "", licence_id: "", holder: "", seats: 1,
    expires_at: null, grace_until: null, message: "", is_pro: false,
  },
  features: Object.fromEntries(PRO_FEATURES.map(f => [f, false])) as Record<ProFeature, boolean>,
  free_live_sessions: { limit: 2, used: 0, left: 2 },
  enforced: false,
  can_start_live: true,
  holds_grant: false,
};

let cache: LicenceStatus = FREE;
let inflight: Promise<LicenceStatus> | null = null;
const listeners = new Set<(s: LicenceStatus) => void>();

function publish(status: LicenceStatus) {
  cache = status;
  listeners.forEach(fn => fn(status));
}

/** The last known status, without waiting. */
export function licenceNow(): LicenceStatus {
  return cache;
}

/**
 * Fetch the status, sharing one request between simultaneous callers.
 *
 * `background=false` skips the backend's own refresh check — used on the path
 * to joining a call, where no network round trip should happen at all.
 */
export async function loadLicence(background = true): Promise<LicenceStatus> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetchApi(`/licence/status?refresh=${background}`);
      if (res.ok) publish(await res.json());
    } catch {
      /* backend not up yet: keep whatever we have — free, at worst */
    } finally {
      inflight = null;
    }
    return cache;
  })();
  return inflight;
}

/** Replace the cached status with one the backend just returned. */
export function setLicence(status: LicenceStatus) {
  publish(status);
}

/** Subscribe to licence changes. Returns an unsubscribe function. */
export function onLicenceChange(fn: (s: LicenceStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The shared licence status, kept up to date. */
export function useLicence(): LicenceStatus {
  const [status, setStatus] = useState(cache);
  useEffect(() => {
    const off = onLicenceChange(setStatus);
    loadLicence();
    return off;
  }, []);
  return status;
}

/** Whether one feature is available right now, per the last known status. */
export function hasFeature(feature: ProFeature): boolean {
  return Boolean(cache.features[feature]);
}

/**
 * May this session go live?
 *
 * Asked immediately before joining a call, so the user is told beforehand
 * rather than cut off after the socket opens. It is a separate, uncached
 * request because the answer depends on the session, and it explicitly skips
 * the licence service: nothing should touch the network at this moment.
 *
 * On any failure it answers yes. The backend gate is the real enforcement; a
 * flaky local request must never block someone from their own interview.
 */
export async function canGoLive(sessionId: number | null): Promise<boolean> {
  if (sessionId == null) return true;
  try {
    const res = await fetchApi(`/licence/status?refresh=false&session_id=${sessionId}`);
    if (!res.ok) return true;
    // Deliberately not published: this answer is about one session, and the
    // shared cache is the general one.
    const status = (await res.json()) as LicenceStatus;
    return status.can_start_live;
  } catch {
    return true;
  }
}

/**
 * Open the Pro dialog, from anywhere.
 *
 * `feature` picks which line the dialog leads with, so someone who hit the
 * calendar gate reads about the calendar rather than a generic pitch.
 */
export function showUpgrade(feature?: ProFeature | string) {
  window.dispatchEvent(new CustomEvent("open-upgrade", { detail: feature ?? "" }));
}

export const PLAN_LABELS: Record<string, string> = {
  monthly: "Monthly",
  annual: "Yearly",
  pass7: "7-day pass",
  team: "Team",
  lifetime: "Lifetime",
};

/** "12 April 2027", or "" when there is nothing to show. */
export function formatDate(unix: number | null | undefined): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    day: "numeric", month: "long", year: "numeric",
  });
}
