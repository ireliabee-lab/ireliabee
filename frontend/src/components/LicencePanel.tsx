import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { BadgeCheck, Loader2, RefreshCw } from "lucide-react";
import { fetchApi } from "../lib/api";
import { errorFromResponse, notifyError } from "../lib/errors";
import {
  BUY_URL, PLAN_LABELS, formatDate, loadLicence, setLicence, useLicence,
  type LicenceStatus,
} from "../lib/licence";
import { openExternal } from "../lib/openExternal";
import { track } from "../lib/usage";

/**
 * Settings → Your plan: what this copy of iReliabee is licensed for.
 *
 * Deliberately plain. Someone opens this screen either to type a key they just
 * bought, or because something stopped working and they want to know why — so
 * the state and the reason come first, and the actions are next to them.
 */
export default function LicencePanel() {
  const status = useLicence();
  const [key, setKey] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState<"" | "activate" | "import" | "refresh" | "deactivate">("");

  useEffect(() => { track("settings.plan"); loadLicence(); }, []);

  async function post(path: string, body: unknown, kind: typeof busy) {
    setBusy(kind);
    try {
      const res = await fetchApi(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw await errorFromResponse(res);
      setLicence((await res.json()) as LicenceStatus);
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    } finally {
      setBusy("");
    }
  }

  async function activate() {
    if (!key.trim()) return;
    if (await post("/licence/activate", { key }, "activate")) {
      setKey("");
      toast.success("Licence activated — Pro is on.");
    }
  }

  async function importToken() {
    if (!token.trim()) return;
    if (await post("/licence/import", { token }, "import")) {
      setToken("");
      setShowToken(false);
      toast.success("Licence installed.");
    }
  }

  async function deactivate() {
    if (await post("/licence/deactivate", {}, "deactivate")) {
      toast("This computer no longer uses the licence.");
    }
  }

  const lic = status.licence;
  const pro = lic.is_pro;
  const left = status.free_live_sessions.left;

  return (
    <div className="page-content">
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 620 }}>
      {/* What you have */}
      <section style={{
        background: "rgba(var(--ink-rgb),0.04)", borderRadius: 12, padding: "16px 18px",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          {pro && <BadgeCheck size={17} style={{ color: "var(--accent)" }} />}
          <span style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>
            {pro ? `iReliabee Pro${lic.plan ? ` · ${PLAN_LABELS[lic.plan] ?? lic.plan}` : ""}` : "iReliabee Free"}
          </span>
        </div>

        {pro ? (
          <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.7 }}>
            {lic.holder && <>Licensed to {lic.holder}.<br /></>}
            {lic.plan === "lifetime"
              ? "This licence does not expire."
              : lic.expires_at ? `Renews or ends on ${formatDate(lic.expires_at)}.` : null}
            {lic.seats > 1 && <><br />{lic.seats} seats.</>}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.7 }}>
            Your library and progress are yours for free.
            Live coaching in real calls, the calendar, recaps, people research,
            study packs, exam scoring and PDF export are part of Pro.
            <br />
            {left > 0
              ? `You have ${left} of ${status.free_live_sessions.limit} free live sessions left.`
              : "You have used both free live sessions."}
          </div>
        )}

        {lic.message && (
          <div style={{
            fontSize: 12, color: "var(--text)", lineHeight: 1.6,
            background: "rgba(245,158,11,0.12)", borderRadius: 8, padding: "9px 11px",
          }}>
            {lic.message}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          {!pro && (
            <button className="btn-primary" onClick={() => { track("plan.buy"); openExternal(BUY_URL); }}>
              See plans
            </button>
          )}
          {lic.state !== "none" && (
            <>
              <button className="btn-ghost" onClick={() => post("/licence/refresh", {}, "refresh")}
                      disabled={busy !== ""}>
                {busy === "refresh" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                {" "}Check now
              </button>
              <button className="btn-ghost" onClick={deactivate} disabled={busy !== ""}>
                Remove from this computer
              </button>
            </>
          )}
        </div>
      </section>

      {/* Enter a key */}
      {!pro && (
        <section style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <label htmlFor="licence-key" style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>
            Licence key
          </label>
          <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
            The code from your receipt. It looks like IREL-XXXXX-XXXXX-XXXXX-XXXXX.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              id="licence-key"
              value={key}
              onChange={e => setKey(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") activate(); }}
              placeholder="IREL-XXXXX-XXXXX-XXXXX-XXXXX"
              spellCheck={false}
              autoComplete="off"
              style={{
                flex: 1, padding: "9px 11px", borderRadius: 8,
                border: "1px solid var(--border)", background: "var(--surface)",
                color: "var(--text)", fontSize: 13, fontFamily: "var(--font-mono)",
              }}
            />
            <button className="btn-primary" onClick={activate} disabled={busy !== "" || !key.trim()}>
              {busy === "activate" ? <Loader2 size={13} className="spin" /> : "Activate"}
            </button>
          </div>

          {/* Offline and team installs get a signed token instead of a key. */}
          {showToken ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
              <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
                Paste the licence file your organisation gave you. This works with no
                internet connection.
              </div>
              <textarea
                value={token}
                onChange={e => setToken(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder="IRL1...."
                style={{
                  padding: "9px 11px", borderRadius: 8, resize: "vertical",
                  border: "1px solid var(--border)", background: "var(--surface)",
                  color: "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)",
                }}
              />
              <div>
                <button className="btn-primary" onClick={importToken}
                        disabled={busy !== "" || !token.trim()}>
                  {busy === "import" ? <Loader2 size={13} className="spin" /> : "Install licence"}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="btn-ghost"
              style={{ alignSelf: "flex-start", marginTop: 2 }}
              onClick={() => setShowToken(true)}
            >
              I have a licence file instead
            </button>
          )}
        </section>
      )}

      <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.7 }}>
        A licence is checked on this computer, not in an account. iReliabee still
        has no account and no cloud holding your conversations: your sessions,
        transcripts and files stay on this machine.
      </div>
    </div>
    </div>
  );
}
