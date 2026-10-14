import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Loader2, Sparkles, X } from "lucide-react";
import { refreshBalance, useAccount } from "../lib/account";
import { ensureReady, notifyError } from "../lib/errors";
import { mergeSuggestions, type Placed, type Suggestion } from "../lib/prefill";
import {
  isSuggestable, priceLabel, priceShort, spentLabel, suggester, type SuggestBox, type SuggestField, type SuggestPrice,
} from "../lib/suggestApi";
import { track } from "../lib/usage";

/**
 * Free prefill (lib/prefill.ts): fills empty boxes with what the app already
 * knows and remembers which boxes are still its suggestion, so a box the
 * person has typed in is never replaced. No AI; nothing leaves the computer.
 */
export function usePrefill<T extends object>(
  values: T, setValues: (next: T) => void,
  suggestions: Partial<Record<keyof T & string, Suggestion | undefined>>,
) {
  const [placed, setPlaced] = useState<Placed>({});
  // Boxes the person cleared on purpose: not filled again.
  const dismissed = useRef(new Set<string>());
  const key = JSON.stringify(suggestions);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const placedRef = useRef(placed);
  placedRef.current = placed;
  useEffect(() => {
    const offered = Object.fromEntries(Object.entries(suggestions).filter(([k]) => !dismissed.current.has(k))) as typeof suggestions;
    const merged = mergeSuggestions(valuesRef.current, offered, placedRef.current);
    setPlaced(merged.placed);
    const now = merged.values as Record<string, unknown>, was = valuesRef.current as Record<string, unknown>;
    if (Object.keys(now).some(k => now[k] !== was[k])) setValues(merged.values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  // A box is still a suggestion only while it holds exactly what was put there.
  const isSuggested = (field: keyof T & string) => field in placed && values[field] === placed[field];
  const sourceOf = (field: keyof T & string) => suggestions[field]?.source ?? "";
  const clear = (field: keyof T & string) => {
    dismissed.current.add(field);
    setPlaced(p => { const { [field]: _gone, ...rest } = p; return rest; });
    setValues({ ...values, [field]: "" });
  };
  return { isSuggested, sourceOf, clear };
}

/** The mark beside a box's label while it holds a free suggestion. Plain words: not AI. */
export function SuggestedChip({ source, onClear }: { source: string; onClear?: () => void }) {
  return (
    <span className="suggested-chip" title={`Filled in from ${source}. Type over it to change it, or clear it.`}>
      from {source}
      {onClear && (
        <button type="button" onClick={onClear} aria-label="Clear the suggestion"><X size={10} /></button>
      )}
    </span>
  );
}

/**
 * Paid AI Suggest for one box — the one button every free-text box in a form
 * uses, so it looks and behaves the same everywhere. The price is on the
 * button before it is pressed; the AI is asked only on the click; what it
 * used is said after; the text goes in as an editable suggestion (use
 * withSuggestion / withSuggestedItems so nothing typed is lost) and nothing
 * is saved or submitted. Boxes for names, contact details, secrets or payment
 * details never show it (isSuggestable).
 */
export function AiSuggest<T = string | string[]>({
  field, label, shape = "text", length = "short", value, form, ready = true, notReadyHint, onSuggest,
}: {
  field: SuggestField;
  /** The label the person sees above the box: it tells the AI what the box is for. */
  label?: string;
  shape?: "text" | "list";
  length?: "short" | "long";
  /** The box's own value. A one-line box that already has text is not suggested over. */
  value?: string | string[];
  /** What the form says now (read at click time). */
  form: () => Record<string, unknown>;
  /** Whether there is enough on the form to go on. */
  ready?: boolean;
  notReadyHint?: string;
  onSuggest: (value: T) => void;
}) {
  const account = useAccount();
  const [price, setPrice] = useState<SuggestPrice | null>(null);
  const [busy, setBusy] = useState(false);
  const api = useRef(suggester()).current;
  const box: SuggestBox = { field, label, shape, length };
  // A one-line box holds one answer: with text in it, a suggestion would have
  // to replace what was typed, so it waits until the box is empty.
  if (shape === "text" && length === "short" && typeof value === "string" && value.trim()) {
    ready = false;
    notReadyHint = "Empty the box to get a suggestion";
  }
  const allowed = isSuggestable(box);
  // The price, from the estimate: no AI call. Asked again when the form grows
  // enough to change it, a moment after typing stops.
  const size = allowed ? Math.round(JSON.stringify(form()).length / 400) : 0;
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    const t = window.setTimeout(() => {
      api.price(box, form()).then(p => { if (alive) setPrice(p); }).catch(() => { /* the button says "credits" */ });
    }, 600);
    return () => { alive = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field, size, allowed]);

  if (!allowed) return null;
  const who = { admin: account.admin, available: account.balance?.available, credits: account.balance?.credits };
  const cost = priceLabel(price, who);

  async function run(fallbackCredits?: boolean | unknown) {
    const useCredits = fallbackCredits === true;
    if (!ready || busy) return;
    if (!(await ensureReady(["llm"]))) return;
    setBusy(true);
    try {
      track(`suggest:${field}`);
      const out = await api.ask<T>(box, form(), { fallbackCredits: useCredits });
      onSuggest(out.suggestion);
      const used = spentLabel(out.cost, account.admin);
      toast.success(`Suggested${used ? ` — used ${used}` : ""}. Edit it as you like; nothing is saved until you save.`, { id: "suggest-done" });
      refreshBalance().catch(() => {});
    } catch (e) {
      notifyError(e, () => run(true));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn-neutral small ai-suggest" onClick={() => run(false)} disabled={!ready || busy}
      aria-label={`Suggest ${label ?? "this"} with AI (${cost})`}
      title={ready ? `Ask the AI to suggest this. It uses your credits: ${cost}. It goes in as a suggestion you can edit.` : (notReadyHint ?? "Fill in more of the form first")}>
      {busy ? <Loader2 size={11} className="spin" /> : <Sparkles size={11} />}
      {busy ? "Suggesting…" : <>Suggest <span className="ai-suggest-cost">({priceShort(price, account)})</span></>}
    </button>
  );
}

/**
 * A form label with the Suggest button beside it: the wrapper forms use for
 * a box, so the label, the free-prefill chip and the button line up the same
 * everywhere.
 */
export function SuggestLabel({ label, htmlFor, chip, children }: {
  label: string; htmlFor?: string; chip?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="label-row">
      <label className="settings-label" htmlFor={htmlFor}>{label}</label>
      {chip}
      {children}
    </div>
  );
}
