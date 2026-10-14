/**
 * AI Suggest for one box of a form (backend/routers/suggest.py).
 *
 * A paid job: it spends credits like a debrief does, so the price is shown on
 * the button before anyone presses it (from /suggest/estimate, which makes no
 * AI call), and what it actually used is shown after. The AI is only ever
 * asked when the person presses Suggest — never on load, focus or in the
 * background. What comes back goes into the box as an editable suggestion and
 * is never saved or submitted by itself.
 *
 * Kept apart from the free prefill in lib/prefill.ts, which uses no AI.
 */
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";
import { formatCredits } from "./account";
import { estimateCost } from "./reading";

/**
 * A box that offers Suggest: "<form>.<box>" (the last part is the box's key
 * in the form), the label the person sees, and its shape. Every free-text box
 * may offer it; a box for a name, an email address, a phone number, a
 * password, a key or a payment detail never does (isSuggestable, and the
 * backend refuses them too).
 */
export type SuggestField = string;
export interface SuggestBox {
  field: SuggestField;
  label?: string;
  shape?: "text" | "list";
  length?: "short" | "long";
}

const NEVER = /(^|[\s._-])(name|email|e[-_ ]?mail|phone|mobile|tel|telephone|pronouns?|address|password|passcode|passphrase|secret|token|api[-_ ]?key|key|licen[cs]e|card|cvv|cvc|iban|sort[-_ ]?code|account|payment|pin)($|[\s._-])/i;

/** Whether a box may offer Suggest at all (mirrors backend/routers/suggest.py, NOT_SUGGESTED). */
export function isSuggestable(box: Pick<SuggestBox, "field" | "label">): boolean {
  const key = box.field.split(".").pop() ?? "";
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(box.field)
    && !NEVER.test(key.replace(/_/g, " ")) && !NEVER.test(box.label ?? "");
}

export interface SuggestPrice {
  model: string;
  tokens: { input: number; output: number };
  usd: number | null;
  credits: number | null;
}

export interface SuggestResult<T = string | string[]> { field: SuggestField; suggestion: T; cost: SuggestPrice }

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

async function post<T>(doFetch: Fetcher, path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const res = await doFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

/**
 * The two requests, and nothing else. `price` never reaches the AI; `ask`
 * does and is charged, so only a click may call it (components/AiSuggest.tsx).
 */
export function suggester(doFetch: Fetcher = fetchApi) {
  const body = (box: SuggestField | SuggestBox, form: Record<string, unknown>) =>
    (typeof box === "string" ? { field: box, form } : { ...box, form });
  return {
    price: (box: SuggestField | SuggestBox, form: Record<string, unknown>) =>
      post<SuggestPrice & { field: SuggestField }>(doFetch, "/suggest/estimate", body(box, form)),
    ask: <T = string | string[]>(box: SuggestField | SuggestBox, form: Record<string, unknown>, opts?: { fallbackCredits?: boolean }) => {
      const headers = opts?.fallbackCredits ? { "X-IRB-Use-Credits": "1" } : undefined;
      return post<SuggestResult<T>>(doFetch, "/suggest/", body(box, form), headers);
    },
  };
}

/** A price short enough for a button beside every box: "<0.01 credits", "~0.03 credits". */
export function priceShort(
  price: Pick<SuggestPrice, "usd" | "credits"> | null,
  account: { admin: boolean },
): string {
  if (!price) return "credits";
  if (account.admin) return price.usd == null ? "your keys" : price.usd < 0.01 ? "<$0.01" : `~$${price.usd.toFixed(2)}`;
  if (price.credits == null) return "credits";
  return price.credits < 0.01 ? "<0.01 credits" : `~${formatCredits(Math.ceil(price.credits * 100) / 100)} credits`;
}

/** A suggestion put into a box without losing what is there: under it, never over it. */
export function withSuggestion(current: string, suggestion: string | string[]): string {
  const text = Array.isArray(suggestion) ? suggestion.join("\n") : suggestion;
  return current.trim() ? `${current.replace(/\s+$/, "")}\n${text}` : text;
}

/** The same for a list box: new items after the ones already there (empty ones dropped). */
export function withSuggestedItems(current: string[], suggestion: string | string[]): string[] {
  const items = Array.isArray(suggestion) ? suggestion : suggestion.split("\n");
  return [...current.filter(x => x.trim()), ...items.map(x => x.trim()).filter(Boolean)];
}

/** "about 0.02 credits", "under 0.01 credits", or dollars for the admin. */
export function priceLabel(
  price: Pick<SuggestPrice, "usd" | "credits" | "model"> | null,
  account: { admin: boolean; available?: number | null; credits?: number | null },
): string {
  if (!price) return "uses credits";
  if (account.admin) return price.usd != null ? `about $${price.usd < 0.01 ? "0.01 or less" : price.usd.toFixed(2)}` : "on your keys";
  return estimateCost(price, account).text || "uses credits";
}

/** What a finished suggestion used, for the note after it. */
export function spentLabel(cost: Pick<SuggestPrice, "usd" | "credits"> | null | undefined, admin: boolean): string {
  if (!cost) return "";
  if (admin) return cost.usd != null ? `$${cost.usd.toFixed(4)}` : "";
  if (cost.credits == null) return "a small part of a credit";
  return cost.credits < 0.01 ? "under 0.01 credits" : `${formatCredits(Math.ceil(cost.credits * 100) / 100)} credits`;
}
