import { useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { fetchApi } from "../lib/api";
import "../owner-usage.css";

/** One row of GET /usage/costs: a kind of call on one provider and model. */
interface CostRow {
  kind: string; provider: string; model: string; calls: number;
  in_tokens: number; out_tokens: number; seconds: number; cost_usd: number | null; unpriced_calls: number;
}
interface CostSummary {
  days: number; calls: number; sessions: number; cost_usd: number;
  cost_per_session_usd: number | null; unpriced_calls: number; by_model: CostRow[];
}

const WINDOWS = [7, 30, 90] as const;
const KIND_NAMES: Record<string, string> = {
  coach: "Coach answers", stt: "Speech to text", "mock.voice": "Voice mock", mock: "Text mock",
  debrief: "Debriefs", screen: "Screenshots", notebook: "Notebooks", reading: "Reading notes",
  other: "Other AI work", model: "Model checks",
};
const money = (n: number | null | undefined) => (n == null ? "—" : `$${n < 1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`);
const count = (n: number) => n.toLocaleString();
const amount = (r: CostRow) => (r.seconds > 0
  ? `${Math.round(r.seconds / 60).toLocaleString()} min`
  : `${count((r.in_tokens || 0) + (r.out_tokens || 0))} tokens`);

/**
 * The owner's account: its own keys, so no credits, and what its calls cost.
 *
 * The owner runs on the provider keys on this computer: calls go straight to
 * the providers and never touch the credit ledger. "0 credits, you are out of
 * credits" was true of the ledger and false of the owner, who is never
 * stopped for want of credit. What matters here is what the calls cost, from
 * the local record every call writes (backend/core/costs.py).
 */
export default function OwnerUsage() {
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [data, setData] = useState<CostSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    fetchApi(`/usage/costs?days=${days}`)
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(d => { if (live) setData(d); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [days]);

  const total = data?.cost_usd || 0;
  const share = (n: number | null) => (total > 0 && n ? Math.max(2, Math.round((n / total) * 100)) : 0);

  return (
    <div className="ou">
      <div className="ou-head">
        <div className="ou-note">
          <span className="ou-icon"><KeyRound size={15} /></span>
          <div>
            <strong>Owner · your own keys</strong><br />
            Calls go straight to the providers with the API keys on this computer and are not charged in
            credits, so nothing here ever stops for want of credit. Below is what they have cost.
          </div>
        </div>
        <div role="group" aria-label="Period" className="ou-periods">
          {WINDOWS.map(w => (
            <button key={w} className={w === days ? "btn-primary" : "btn-ghost"}
              aria-pressed={w === days} onClick={() => setDays(w)}>{w} days</button>
          ))}
        </div>
      </div>

      {failed ? (
        <div style={{ fontSize: 12.5, color: "var(--muted)" }}>The cost record couldn't be read just now. Try again in a moment.</div>
      ) : !data ? (
        <div style={{ fontSize: 12.5, color: "var(--muted)" }}><Loader2 size={13} className="spin" /> Reading the cost record…</div>
      ) : (
        <>
          <div className="ou-stats">
            {[
              [money(data.cost_usd), `Spent in ${data.days} days`],
              [count(data.calls), "Calls"],
              [count(data.sessions), "Sessions"],
              [money(data.cost_per_session_usd), "Per session"],
            ].map(([n, l], i) => (
              <div key={l} className={i === 0 ? "ou-stat lead" : "ou-stat"}>
                <div className="ou-stat-value">{n}</div>
                <div className="ou-stat-label">{l}</div>
              </div>
            ))}
          </div>
          {data.unpriced_calls > 0 && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: -6 }}>
              {count(data.unpriced_calls)} calls used a model with no price on record, so the total is at least this.
            </div>
          )}
          {data.by_model.length === 0 ? (
            <div style={{ fontSize: 12.5, color: "var(--muted)" }}>No calls in the last {data.days} days.</div>
          ) : (
            <div className="ou-split">
              <section className="ou-card">
                <span className="ou-label">What your calls cost</span>
                <div className="ou-table-wrap">
                  <table className="ou-table">
                    <thead>
                      <tr>
                        <th>What</th><th>Provider · model</th><th className="num">Calls</th>
                        <th className="num">Used</th><th className="num">Cost</th><th className="ou-share" aria-label="Share of spend" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.by_model.map(r => (
                        <tr key={`${r.kind}|${r.provider}|${r.model}`}>
                          <td className="ou-what">{KIND_NAMES[r.kind] ?? r.kind}</td>
                          <td className="ou-model"><span className="ou-provider">{r.provider}</span>{r.model}</td>
                          <td className="num">{count(r.calls)}</td>
                          <td className="num ou-model">{amount(r)}</td>
                          <td className="num ou-cost">{money(r.cost_usd)}</td>
                          <td className="ou-share"><div className="ou-bar"><span style={{ width: `${share(r.cost_usd)}%` }} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <aside className="ou-side">
                <Breakdown title="Where it goes" rows={groupBy(data.by_model, r => KIND_NAMES[r.kind] ?? r.kind)} total={total} />
                <Breakdown title="By provider" rows={groupBy(data.by_model, r => r.provider)} total={total} />
              </aside>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Cost per group, largest first. */
function groupBy(rows: CostRow[], key: (r: CostRow) => string): [string, number][] {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(key(r), (sums.get(key(r)) ?? 0) + (r.cost_usd ?? 0));
  return [...sums].sort((a, b) => b[1] - a[1]);
}

function Breakdown({ title, rows, total }: { title: string; rows: [string, number][]; total: number }) {
  return (
    <section className="ou-card">
      <span className="ou-label">{title}</span>
      <div className="ou-rows">
        {rows.map(([name, cost]) => {
          const pct = total > 0 ? (cost / total) * 100 : 0;
          return (
            <div key={name}>
              <div className="ou-row-top"><span>{name}</span><span>{money(cost)} · {pct < 1 ? "<1" : Math.round(pct)}%</span></div>
              <div className="ou-bar"><span style={{ width: `${Math.max(pct, cost > 0 ? 1.5 : 0)}%` }} /></div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
