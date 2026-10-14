/**
 * Account and credit state for the UI.
 *
 * One shared copy, one request — the same arrangement as `licence.ts`, and for
 * the same reason: several screens ask "who is signed in, and is there any
 * credit left?" in the same frame.
 *
 * The backend is the authority and the service is the authority behind it.
 * Nothing here decides anything; a stale cache can make a number slightly old
 * but can never let a session start that the server would refuse.
 *
 * **Status and balance are two requests on purpose.** Status is on the app's
 * startup path and must not wait on the network; the balance always touches
 * it. So the app opens with whatever was last known — labelled with when it
 * was read — and corrects itself a moment later.
 */
import { useEffect, useState } from "react";
import { fetchApi } from "./api";

export const BUY_URL = "https://ireliabee.co.uk/pro";

export interface Balance {
  /** What has been bought and not yet spent. */
  credits: number;
  /** Reserved by sessions that are still running. */
  held: number;
  /** credits − held: the number that decides whether a session can start. */
  available: number;
  /** When this was read, unix seconds. */
  at?: number;
  /** What `available` buys, as the service works it out (older services send none). */
  time_left?: TimeLeft;
}

/** The service's figure: the same one the backoffice shows for this account. */
export interface TimeLeft {
  live_seconds: number | null;
  voice_mock_seconds: number | null;
  owes_credits: number;
}

export interface AccountInfo {
  id: string;
  email: string;
  name?: string;
  status?: string;
  /** Own provider keys: an owner, or someone an owner granted them in the backoffice. */
  admin?: boolean;
  /** Whether to offer "Open backoffice": a separate grant from `admin`. */
  backoffice?: boolean;
}

export interface AccountStatus {
  signed_in: boolean;
  account: AccountInfo | null;
  admin: boolean;
  /** "open": the open-source edition, on the user's own keys unless they sign in (backend/edition.py). */
  edition?: "open" | "app";
  /** Whether signing in to the hosted service is offered: always in the app, off by default in the open edition. */
  hosted?: boolean;
  /** "Open backoffice" is offered; the service checks it again when the link is asked for. */
  backoffice?: boolean;
  balance: Balance | null;
  /** This month's free credit. One per computer: `elsewhere` means another account on this computer has it. */
  free?: { month: string; granted: boolean; elsewhere: boolean } | null;
  device: { id: string; label: string };
}

/** What we assume before the first reply, and if the backend can't be reached. */
const SIGNED_OUT: AccountStatus = {
  signed_in: false,
  account: null,
  admin: false,
  backoffice: false,
  balance: null,
  device: { id: "", label: "" },
};

let cache: AccountStatus = SIGNED_OUT;
let inflight: Promise<AccountStatus> | null = null;
const listeners = new Set<(s: AccountStatus) => void>();

function publish(status: AccountStatus) {
  cache = status;
  listeners.forEach(fn => fn(status));
}

/** The last known status, without waiting. */
export function accountNow(): AccountStatus {
  return cache;
}

/**
 * Fetch the status, sharing one request between simultaneous callers.
 *
 * `refresh` asks the backend to re-mint its access token and re-read the
 * balance. Left off on the startup path, where a slow network would otherwise
 * hold up the whole app.
 */
export async function loadAccount(refresh = false): Promise<AccountStatus> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetchApi(`/account/status?refresh=${refresh}`);
      if (res.ok) publish(await res.json());
    } catch {
      /* backend not up yet: keep whatever we have — signed out, at worst */
    } finally {
      inflight = null;
    }
    return cache;
  })();
  return inflight;
}

/**
 * Re-read just the balance.
 *
 * Called after anything that spends or buys. Failure is silent by design: the
 * cached figure is still roughly right, and an error toast every time a train
 * goes into a tunnel would be worse than a number a minute out of date.
 */
export async function refreshBalance(): Promise<Balance | null> {
  try {
    const res = await fetchApi("/account/balance");
    if (!res.ok) return cache.balance;
    const balance = (await res.json()) as Balance;
    publish({ ...cache, balance });
    return balance;
  } catch {
    return cache.balance;
  }
}

/** Replace the cached status with one the backend just returned. */
export function setAccount(status: AccountStatus) {
  publish(status);
}

/** Subscribe to account changes. Returns an unsubscribe function. */
export function onAccountChange(fn: (s: AccountStatus) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The shared account status, kept up to date. */
export function useAccount(): AccountStatus {
  const [status, setStatus] = useState(cache);
  useEffect(() => {
    const off = onAccountChange(setStatus);
    loadAccount();
    return off;
  }, []);
  return status;
}

/**
 * Credits, the way a person reads them.
 *
 * Half credits are ordinary — a session is half a credit — so a whole number
 * should not grow a needless ".0", and a half should not be rounded away into
 * a balance that looks like it has more or less than it does.
 */
export function formatCredits(n: number | null | undefined): string {
  const value = Number(n ?? 0);
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0$/, "");
}

/**
 * What the account owes, in credits: how far its balance is below zero, or 0.
 *
 * A balance goes below zero when credits are taken back after they were
 * spent: a payment refunded, or a correction on our side. The next credits in
 * pay that first. Shown as "-10.8 credits", it reads like a glitch, and the
 * lines under it promised that a pack or the free credit would get them going
 * again, which is not true of a debt bigger than either.
 *
 * `credits`, the ledger's own total, when there is one: `available` also dips
 * below zero for a moment when a running session holds more than is left,
 * and that is a session ending, not a debt.
 */
export function owedCredits(
  balance: { credits?: number | null; held?: number | null; available?: number | null } | null | undefined,
): number {
  if (!balance) return 0;
  const total = Number(balance.credits ?? balance.available ?? 0);
  return Number.isFinite(total) && total < 0 ? -total : 0;
}

/** "10.8 credits", "1 credit", or "less than 0.01 credits" — a debt, in words. */
export function owedAmount(owed: number): string {
  if (owed < 0.01) return "less than 0.01 credits";
  return `${formatCredits(owed)} ${owed === 1 ? "credit" : "credits"}`;
}

/**
 * What owing means, in plain words: what gets paid first. Not a promise that
 * a pack or the free credit gets them going again — a debt bigger than
 * either swallows it whole.
 */
export function owedNotice(owed: number): string {
  return `You owe ${owedAmount(owed)}. The next credits you buy pay that first, and what's left after it is yours to use.`;
}

/** "just now", "4 minutes ago", "yesterday" — for a balance read offline. */
export function readAgo(at: number | null | undefined): string {
  if (!at) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}


/**
 * Credits as minutes of live session — one credit is thirty — the way a
 * person thinks about what is left: "about 9 minutes", "about 2 hours 15 min".
 */
export function liveMinutes(credits: number): string {
  const minutes = Math.floor(Math.max(0, credits) * 30);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} hour${h === 1 ? "" : "s"}${m ? ` ${m} min` : ""}`;
}


/** A span of time the way the backoffice writes it: "3 h 24 min", "45 min". */
export function formatDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Seconds of live session the available credits buy: the service's figure
 * when it sent one, else worked out here (a credit is thirty minutes).
 * Credits a running session holds are not in it.
 */
export function liveSecondsLeft(balance: Balance | null | undefined): number {
  if (!balance) return 0;
  const sent = balance.time_left?.live_seconds;
  if (typeof sent === "number") return sent;
  return Math.floor(Math.max(0, balance.available) * 30 * 60);
}

export interface CreditWarning {
  available: number;
  low: boolean;
  /** When the balance was read, unix seconds. */
  at?: number;
}

/**
 * The line to show before a call, or null for none.
 *
 * A heads-up, never a gate: the figure can be a minute old and the service
 * decides what may start. Being told mid-interview — which is what happened
 * before, because nothing looked at the balance until a call was already
 * running — is the whole thing this exists to avoid.
 */
export function lowCreditNotice(credits: CreditWarning | null | undefined): string | null {
  if (!credits || !credits.low) return null;
  const owed = owedCredits(credits);
  if (owed > 0) {
    return `You owe ${owedAmount(owed)} — a call will stop as soon as it starts. The next credits you buy pay that first.`;
  }
  if (credits.available <= 0) {
    return "You have no credits left — a call will stop as soon as it starts. Top up first.";
  }
  const unit = credits.available === 1 ? "credit" : "credits";
  return `Only ${formatCredits(credits.available)} ${unit} left — about ${liveMinutes(credits.available)} of live session.`;
}


/** How close to the end of their credit someone is warned, in seconds. */
export const RUNS_OUT_WARNING_SECONDS = 2 * 60;

export const RUNS_OUT_MESSAGE = "Your credit runs out in about 2 minutes. Buy credits to keep going.";

/**
 * Whether to say "your credit runs out in about 2 minutes" now.
 *
 * `left` is the seconds of metered time left, as counted down on screen, or
 * null where it isn't known. `warned` is whether this stretch has been warned
 * about already. Once per stretch: the warning comes the first time the time
 * left is two minutes or less, and not again until it has gone back above two
 * minutes (credits bought) and come down again. At zero it says nothing: the
 * existing out-of-credits path speaks then, and "in about 2 minutes" would be
 * wrong.
 */
export function runsOutCheck(
  left: number | null | undefined,
  warned: boolean,
): { warn: boolean; warned: boolean } {
  if (left == null || !Number.isFinite(left)) return { warn: false, warned };
  if (left > RUNS_OUT_WARNING_SECONDS) return { warn: false, warned: false };
  if (left <= 0) return { warn: false, warned };
  return { warn: !warned, warned: true };
}

/**
 * How often an open app asks the service who it is and what it has left, in
 * milliseconds. What an owner changes in the backoffice (own keys on or off,
 * backoffice access) reaches a running app within this, without a restart.
 */
export const ACCOUNT_REFRESH_MS = 60_000;
