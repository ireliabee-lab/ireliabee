import { useEffect, useLayoutEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { BadgeCheck, KeyRound, Loader2, LogOut, Mail, RefreshCw } from "lucide-react";
import { fetchApi } from "../lib/api";
import { errorFromResponse, notifyError } from "../lib/errors";
import {
  BUY_URL, formatCredits, formatDuration, liveSecondsLeft, loadAccount, owedCredits, owedNotice, readAgo, refreshBalance,
  setAccount, useAccount, type AccountStatus, type Balance,
} from "../lib/account";
import { AUTH_CODE_LENGTH, codeComplete, editCode } from "../lib/authCode";
import { openExternal } from "../lib/openExternal";
import OwnerUsage from "./OwnerUsage";
import { track } from "../lib/usage";

/**
 * Settings → Your plan: who is signed in, and what is left to spend.
 *
 * Someone opens this screen for one of three reasons — to sign in, to see how
 * many credits are left, or because something stopped working and they want to
 * know why. So the state comes first and the actions sit next to it.
 *
 * **There is no password field, and there never will be.** Sign-in is a link
 * emailed to the address: nothing to invent, forget, reset, or have reused from
 * someone else's breach. The link opens in the browser and hands this app a
 * one-time code over loopback, which is the same route the calendar sign-in
 * already takes.
 *
 * The screen therefore has a waiting state that most sign-in screens do not:
 * the email has gone, the browser has it, and this window has nothing to do but
 * say so and keep checking.
 *
 * And a second way in, because the loopback handoff cannot always happen. The
 * link carries the port this app was on when it asked, so a restart in between
 * points the browser at nothing; and a link opened on a phone points the phone
 * at itself. The page the link opens shows a code for exactly those cases, and
 * the field for it is here — always, not only while a link is out, since losing
 * the waiting state is one of the ways this goes wrong.
 */
export default function AccountPanel() {
  const status = useAccount();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"" | "signin" | "code" | "refresh" | "signout">("");
  const [sentTo, setSentTo] = useState("");
  const [code, setCode] = useState("");
  // Where the cursor goes after the field reformats itself (lib/authCode.ts):
  // without it, every keystroke would throw it to the end of the code.
  const codeInput = useRef<HTMLInputElement>(null);
  const codeCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = codeInput.current;
    if (el && codeCaret.current != null && document.activeElement === el) el.setSelectionRange(codeCaret.current, codeCaret.current);
    codeCaret.current = null;
  }, [code]);
  const [showCode, setShowCode] = useState(false);
  /**
   * Whether a sign-in this window started is still outstanding.
   *
   * It decides whether to announce one, and both routes set it: the link, whose
   * landing this window only finds out about by polling, and the code, which it
   * sends itself. Without it, a window that simply opens already signed in
   * announces that as news.
   */
  const [expecting, setExpecting] = useState(false);

  // Worked out once a render, not once for every button that asks.
  const idle = busy === "";
  // The open edition, signed out: own keys, nothing to buy (backend/edition.py).
  const ownKeys = !status.signed_in && status.edition === "open";
  // The open edition with the hosted service off (its default): there is nothing to sign in to.
  const hostedOff = status.hosted === false;
  const address = email.trim();
  const codeReady = codeComplete(code);

  useEffect(() => { track("settings.account"); loadAccount(true); }, []);

  /**
   * While the link is out, poll for the sign-in landing.
   *
   * The browser completes the handoff into the backend, not into this window,
   * so nothing here is told when it happens. Polling is the honest way to
   * notice — and it stops as soon as it succeeds.
   *
   * Each check is scheduled after the last one has answered, so a slow backend
   * is asked one question at a time rather than one every two seconds whatever
   * happened to the last. A hidden window does not ask at all — nobody is
   * looking — and asks the moment it is shown again. And it gives up when the
   * backend would (its 30-minute sign-in window, `_STATE_TTL`): a link nobody
   * opened is not worth asking about for the rest of the day.
   */
  useEffect(() => {
    if (!sentTo || status.signed_in) return;
    let stopped = false;
    // A check is out or the next one is set: one at a time, so showing the
    // window again mid-check never starts a second chain beside the first.
    let waiting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const until = Date.now() + POLL_FOR_MS;

    const check = () => {
      waiting = true;
      loadAccount().then(() => { waiting = false; schedule(); });
    };
    const schedule = () => {
      if (stopped || waiting || document.hidden || Date.now() > until) return;
      waiting = true;
      timer = setTimeout(() => { timer = undefined; check(); }, POLL_EVERY_MS);
    };
    const onVisibility = () => {
      if (document.hidden) {
        // Only a check not yet sent is called off; one already out finishes and stops at schedule().
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; waiting = false; }
        return;
      }
      if (!waiting) check();
    };

    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sentTo, status.signed_in]);

  // One announcement, however the sign-in landed, and the form put away with it.
  useEffect(() => {
    if (!status.signed_in || !expecting) return;
    setExpecting(false);
    setSentTo("");
    setEmail("");
    setCode("");
    setShowCode(false);
    toast.success(`Signed in as ${status.account?.email || sentTo || "your account"}.`);
  }, [status.signed_in, status.account?.email, expecting, sentTo]);

  async function signIn() {
    if (!address || !idle) return;
    setBusy("signin");
    try {
      const res = await fetchApi("/account/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      setSentTo(address);
      setExpecting(true);
      track("account.signin.requested");
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy("");
    }
  }

  /**
   * Finish a sign-in from the code on the page the link opened.
   *
   * The code goes up as typed — the service folds the hyphens and the case
   * (its `normaliseAuthCode`), so there is one place that rule lives rather
   * than two that can disagree about what somebody pasted.
   *
   * The address goes with it because a code on its own proves nothing about
   * whose sign-in it is: see `complete_with_code`. It is the same field as the
   * one above, deliberately — one address, asked for once.
   */
  async function signInWithCode() {
    const entered = code.trim();
    // Enter fires this directly, so the button being disabled does not stop a
    // second one. Without this, a sign-in that worked reports "expired" when
    // the second attempt spends a code the first already used.
    if (!codeComplete(entered) || !address || !idle) return;
    setBusy("code");
    try {
      const res = await fetchApi("/account/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: entered, email: address }),
      });
      if (!res.ok) throw await errorFromResponse(res);
      setExpecting(true);          // the effect above announces it once status lands
      await loadAccount(true);
      track("account.signin.code");
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy("");
    }
  }

  async function refresh() {
    setBusy("refresh");
    try {
      await refreshBalance();
    } finally {
      setBusy("");
    }
  }

  async function signOut() {
    setBusy("signout");
    try {
      const res = await fetchApi("/account/signout", { method: "POST" });
      if (!res.ok) throw await errorFromResponse(res);
      setAccount(await res.json());
      toast("Signed out on this computer.");
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy("");
    }
  }

  return (
    // `.page-content` is what carries the page's gutters and its top and
    // bottom padding. A panel dropped straight into a page body without it
    // sits tight against the tab bar and out of line with the heading above
    // it, which is exactly how this screen shipped.
    <div className="page-content">
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: status.admin ? "none" : 620 }}>

      {/* ── What you have ─────────────────────────────────────────────── */}
      <section style={{
        background: "rgba(var(--ink-rgb),0.04)", borderRadius: 12, padding: "16px 18px",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          {status.signed_in && <BadgeCheck size={17} style={{ color: "var(--accent)" }} />}
          <span style={{ fontSize: 15, fontWeight: 800, color: "var(--text)" }}>
            {status.signed_in
              ? (status.account?.email || "Signed in")
              : ownKeys ? "Open edition · your own keys" : "Not signed in"}
          </span>
        </div>

        {status.signed_in ? (
          <>
            {/* The owner runs on their own keys: no credits to count, but what the calls cost. */}
            {status.admin ? <OwnerUsage /> : <BalanceSummary balance={status.balance} free={status.free} />}

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
              {!status.admin && (
                <button className="btn-primary" onClick={() => { track("account.buy"); openExternal(BUY_URL); }}>
                  Buy credits
                </button>
              )}
              <button className="btn-ghost" onClick={refresh} disabled={!idle}>
                {busy === "refresh" ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                {" "}Check now
              </button>
              <button className="btn-ghost" onClick={signOut} disabled={!idle}>
                {busy === "signout" ? <Loader2 size={13} className="spin" /> : <LogOut size={13} />}
                {" "}Sign out
              </button>
            </div>
          </>
        ) : ownKeys ? (
          // The open edition needs no account: the keys on this computer pay the providers directly.
          <OwnerUsage />
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.7 }}>
            Sign in to use the AI. Live sessions, mock interviews, warmups, debriefs,
            recaps, people research and study packs all spend credits, and credits
            belong to an account — each computer gets a free one each month. Your
            library and your progress work without an account and always will.
          </div>
        )}
      </section>

      {/* ── Sign in ───────────────────────────────────────────────────── */}
      {!status.signed_in && hostedOff && (
        <div style={HINT}>
          Signing in to iReliabee is off in this build. To use its hosted AI and credits instead of
          your own keys, start the app with IRELIABEE_HOSTED=1.
        </div>
      )}
      {!status.signed_in && !hostedOff && (
        <section style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <label htmlFor="account-email" style={LABEL}>
            Email address
          </label>
          {ownKeys && (
            <div style={HINT}>
              Optional. Sign in to iReliabee to use its AI and pay per use in credits, instead of your own keys.
            </div>
          )}
          <div style={HINT}>
            We send a link. There is no password to create or remember. Use the same
            address you bought credits with and they will be there.
          </div>
          <div style={ROW}>
            {/* Signed out, this tab is only here to sign in: every "Sign in"
                button in the app lands on it, so the address is ready to type. */}
            <input
              id="account-email"
              autoFocus
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") signIn(); }}
              placeholder="you@example.com"
              spellCheck={false}
              autoComplete="email"
              style={INPUT}
            />
            <button className="btn-primary" onClick={signIn} disabled={!idle || !address}>
              {busy === "signin" ? <Loader2 size={13} className="spin" /> : "Send link"}
            </button>
          </div>

          {sentTo && (
            <div style={{
              display: "flex", gap: 9, alignItems: "flex-start", marginTop: 4,
              background: "rgba(var(--ink-rgb),0.04)", borderRadius: 8, padding: "11px 12px",
            }}>
              <Mail size={15} style={{ color: "var(--accent)", flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
                Link sent to <b style={{ color: "var(--text)" }}>{sentTo}</b>. Open it on this
                computer — it signs this app in, and you can close the tab afterwards.
                This window will notice on its own.
                <br />
                <span style={{ opacity: 0.85 }}>
                  Nothing arrived? Check spam, then send it again. The link lasts 15 minutes.
                  Opened it on your phone, or did it go nowhere? That page shows a code — use it below.
                </span>
              </div>
            </div>
          )}

          {/* Folded away until it is wanted: the link works on its own for most
              people, and an extra field in front of all of them to serve some
              of them is the wrong trade. Worded as the question they would be
              asking at that moment, not as a feature name. */}
          {!showCode ? (
            <button
              className="btn-ghost"
              onClick={() => setShowCode(true)}
              style={{ alignSelf: "flex-start", marginTop: 2 }}
            >
              <KeyRound size={13} /> Opened the link on another device?
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 2 }}>
              <label htmlFor="account-code" style={LABEL}>
                Code from the sign-in page
              </label>
              <div style={HINT}>
                The page the link opens shows a code. Put it here, with the address above,
                and this computer is signed in — it does not matter which device you
                opened the link on. It works once, and only for the account the link was
                sent to.
              </div>
              <div style={ROW}>
                <input
                  id="account-code"
                  ref={codeInput}
                  value={code}
                  onChange={e => {
                    const next = editCode(e.target.value, e.target.selectionStart ?? e.target.value.length, code);
                    codeCaret.current = next.caret;
                    setCode(next.value);
                  }}
                  aria-describedby="account-code-count"
                  autoCapitalize="characters"
                  onKeyDown={e => { if (e.key === "Enter") signInWithCode(); }}
                  placeholder="ABCD-EFGH-JKMN"
                  spellCheck={false}
                  autoComplete="off"
                  style={CODE_INPUT}
                />
                <button
                  className="btn-primary"
                  onClick={signInWithCode}
                  disabled={!idle || !codeReady || !address}
                >
                  {busy === "code" ? <Loader2 size={13} className="spin" /> : "Sign in"}
                </button>
              </div>
              <div id="account-code-count" style={{ fontSize: 11.5, color: "var(--muted)" }}>
                {code.replace(/-/g, "").length} of {AUTH_CODE_LENGTH} characters
              </div>
            </div>
          )}
        </section>
      )}

      <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.7 }}>
        Signing in links this computer to your account so your credits are the same
        everywhere. Sign out here and this computer alone is signed out; your other
        machines keep working.
      </div>
    </div>
    </div>
  );
}

/**
 * The balance, and what it means for what will start.
 *
 * Its own component so what it says can be checked without the rest of the
 * screen. A balance below zero is shown as what is owed, not as "-10.8
 * credits": that reads like a glitch, and the lines that went with it said a
 * pack or the free credit would get them going again, which a bigger debt
 * swallows whole.
 */
/**
 * What the credits buy, in time: how people think about what is left. The
 * service's figure when it sent one (the backoffice shows the same), and live
 * time worked out here when it did not.
 */
export function TimeLeftLine({ balance }: { balance: Balance | null }) {
  const live = liveSecondsLeft(balance);
  const voice = balance?.time_left?.voice_mock_seconds;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--muted)" }}>
        Time left
      </span>
      <span style={{ fontSize: 17, fontWeight: 800, color: "var(--text)" }}>{formatDuration(live)}</span>
      <span style={{ fontSize: 13, color: "var(--muted)" }}>
        of live session{typeof voice === "number" && voice > 0 ? ` · or ${formatDuration(voice)} of voice mock` : ""}
      </span>
    </div>
  );
}

export function BalanceSummary({ balance, free }: Pick<AccountStatus, "balance" | "free">) {
  const available = balance?.available ?? 0;
  const held = balance?.held ?? 0;
  const owed = owedCredits(balance);
  // Below zero only while a session holds more than is left: it is ending,
  // and nothing is owed, so there is nothing to spend rather than a minus.
  const shown = Math.max(available, 0);

  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 30, fontWeight: 800, color: "var(--text)", lineHeight: 1 }}>
          {owed > 0 ? (owed < 0.01 ? "<0.01" : formatCredits(owed)) : formatCredits(shown)}
        </span>
        <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 600 }}>
          {owed > 0 ? "credits owed" : shown === 1 ? "credit" : "credits"}
        </span>
      </div>
      {owed <= 0 && shown > 0 && <TimeLeftLine balance={balance} />}

      <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.7 }}>
        {/* Held credits are the difference between "you have none" and
            "a session you are in is using them", which are very
            different things to read on this screen. */}
        {held > 0 && (
          <>
            {formatCredits(held)} reserved by a session that is still running.
            <br />
          </>
        )}
        One credit is half an hour of live session, charged by the minute, with
        the coach's answers during it included. Debriefs, study packs, text mocks
        and warmups use a small part of a credit each, by how much AI work they
        do; a voice mock, where the AI listens and speaks, costs more a minute
        than a live session. Your library and your progress never spend credits.
        {balance?.at && (
          <>
            <br />
            <span style={{ opacity: 0.8 }}>Read {readAgo(balance.at)}.</span>
          </>
        )}
      </div>

      {/* A debt is said whenever there is one. The empty-balance note is not
          shown while credits are only reserved: that is a session in use (or
          just ending), not an empty balance. */}
      {owed > 0 ? (
        <div style={NOTE}>
          {owedNotice(owed)} Until you're back above zero, live sessions, practice
          calls and debriefs won't start. Your library and your progress are still here.
          <ElsewhereNote free={free} />
        </div>
      ) : available <= 0 && held <= 0 && (
        <div style={NOTE}>
          You are out of credits, so live sessions, practice calls and debriefs
          will not start. Your library and your progress are still here.
          <ElsewhereNote free={free} />
        </div>
      )}
    </>
  );
}

/** Under either note, when it applies: the free credit is per computer, and this one's went elsewhere. */
function ElsewhereNote({ free }: Pick<AccountStatus, "free">) {
  if (!free?.elsewhere) return null;
  return <> This computer's free credit for this month went to another account — it's one per computer, not per email address.</>;
}

// How often to ask whether the sign-in landed, and for how long. The backend
// stops finishing a sign-in it started after 30 minutes
// (backend/core/account.py, `_STATE_TTL`), so asking past that is noise.
const POLL_EVERY_MS = 2000;
const POLL_FOR_MS = 30 * 60 * 1000;

// Built once, not on every keystroke: the same objects every render, so React
// has nothing new to diff for them.
const LABEL = { fontSize: 13, fontWeight: 700, color: "var(--text)" } as const;
const HINT = { fontSize: 12, color: "var(--muted)", lineHeight: 1.6 } as const;
const ROW = { display: "flex", gap: 8 } as const;
const INPUT = {
  flex: 1, padding: "9px 11px", borderRadius: 8,
  border: "1px solid var(--border)", background: "var(--surface)",
  color: "var(--text)", fontSize: 13,
} as const;
const CODE_INPUT = {
  ...INPUT,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  letterSpacing: "0.06em", textTransform: "uppercase",
} as const;
const NOTE = {
  fontSize: 12, color: "var(--text)", lineHeight: 1.6,
  background: "rgba(245,158,11,0.12)", borderRadius: 8, padding: "9px 11px",
} as const;
