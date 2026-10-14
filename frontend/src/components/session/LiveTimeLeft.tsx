import { useEffect, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { accountNow, formatDuration, refreshBalance, runsOutCheck } from "../../lib/account";
import { notifyCreditRunningOut } from "../../lib/errors";

/** Under this, the chip turns to a warning: enough time to top up before the call is cut. */
const LOW_SECONDS = 5 * 60;

/**
 * Seconds of live session left, counted down as the session listens.
 *
 * `base` is the ledger total when listening first starts, as time (a credit is
 * thirty minutes). The total, not `available`: the relay reserves the next
 * block as a hold as soon as it opens, and counting from `available` would
 * drop half an hour the moment listening started. Only time spent listening
 * is taken off, so a pause does not run the clock down.
 */
export function secondsLeft(baseSeconds: number, listenedMs: number): number {
  return Math.max(0, Math.floor(baseSeconds - listenedMs / 1000));
}

export default function LiveTimeLeft({ live }: { live: boolean }) {
  const [base, setBase] = useState<number | null>(null);
  const listened = useRef(0);        // ms listened before the current stretch
  const since = useRef<number | null>(null);
  const [, tick] = useState(0);
  const warned = useRef(false);     // "runs out in about 2 minutes" said for this stretch

  useEffect(() => {
    if (!live) {
      if (since.current != null) listened.current += Date.now() - since.current;
      since.current = null;
      return;
    }
    since.current = Date.now();
    if (base == null) {
      const from = (b: { credits: number } | null) => setBase(Math.max(0, Number(b?.credits ?? 0)) * 30 * 60);
      from(accountNow().balance);
      refreshBalance().then(b => { if (b) from(b); }).catch(() => {});
    }
    const t = setInterval(() => tick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  const ms = listened.current + (since.current != null ? Date.now() - since.current : 0);
  const left = base == null ? null : secondsLeft(base, ms);

  // Two minutes before the credit runs out, once, with a way to buy more.
  // Only while listening: a paused session is not spending.
  useEffect(() => {
    if (!live) return;
    const next = runsOutCheck(left, warned.current);
    warned.current = next.warned;
    if (next.warn) notifyCreditRunningOut();
  });

  if (base == null || left == null || (!live && listened.current === 0)) return null;
  const low = left < LOW_SECONDS;
  return (
    <span
      role="status"
      title="Live time your credits have left, counted down while the session listens. Buy more in Settings → Your account."
      style={{
        display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 999, fontSize: 12,
        fontWeight: 600, whiteSpace: "nowrap",
        color: low ? "var(--warning, #f59e0b)" : "var(--muted)",
        background: low ? "rgba(245,158,11,0.12)" : "rgba(var(--ink-rgb),0.05)",
      }}
    >
      <Clock size={12} /> {left === 0 ? "No live time left" : `≈ ${formatDuration(left)} left`}
    </span>
  );
}
