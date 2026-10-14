import { useEffect, useRef } from "react";
import { Sparkles, X } from "lucide-react";
import { PLAN_LABELS, useLicence, type ProFeature } from "../lib/licence";
import { BUY_URL, formatCredits, liveMinutes, owedCredits, owedNotice, useAccount, type AccountStatus } from "../lib/account";
import { openExternal } from "../lib/openExternal";
import { track } from "../lib/usage";

/**
 * What Pro adds, shown when a gate closes.
 *
 * It leads with the thing the person was just trying to do — someone who hit
 * the calendar gate should read about the calendar, not a generic pitch — and
 * it always says plainly what stays free, so the free tier never feels like a
 * countdown to a payment.
 */

const LEAD: Record<ProFeature, string> = {
  live:     "Live coaching in your real calls",
  calendar: "Your calendar, with plans and reminders",
  recap:    "Recaps, action items and follow-up emails",
  people:   "Know who you're meeting",
  study:    "Turn a lecture into a study pack",
  notebook: "Notes you'd be proud to have written",
  retry:    "Practise the moments that went badly",
  exams:    "IELTS and TOEFL band scoring",
  export:   "Take your debrief with you",
};

const BLURB: Record<ProFeature, string> = {
  live:     "Three cues, a 20-second answer and a full answer, built only from your own background, while the call is happening.",
  calendar: "Google, Outlook and iCal. Turn an invite into a plan in one click and get a reminder five minutes before, with Join & listen.",
  recap:    "Every meeting ends with a recap, the action items and a follow-up email ready to send.",
  people:   "Fact-checked briefs on the people in the room, with every claim linked, feeding the coach during the call.",
  study:    "Record a lecture, ask \"explain this\" when you're lost, and leave with notes, a glossary, flashcards and a quiz.",
  notebook: "Lectures and meetings become beautiful notebook pages — key points highlighted, decisions and actions in one place, every note linked to the moment it was said, and all of it yours to edit.",
  retry:    "Questions that went badly in real calls come back for practice, scored against your last attempt.",
  exams:    "Speaking tests in the real structure, scored against the band descriptors, honestly.",
  export:   "Export any debrief as a PDF. You can always read it here and copy the text for free.",
};

// What spends credits: the AI. Calendar sync and PDF export make no AI calls
// and cost nothing, so they are not listed as things credits buy (audit 180-H6).
const EVERYTHING = [
  "Live cues during Teams, Zoom, Meet, Webex and phone calls — half an hour a credit",
  "Mock interviews by voice or text, warmups and scored debriefs",
  "Recaps, action items and follow-up emails",
  "People research, fact-checked and linked",
  "Lecture companion with notes, flashcards and quizzes",
  "IELTS and TOEFL band scoring",
  "Hard moments from real calls, back for practice",
];

const FREE_ALWAYS = "Your CV, stories, library, progress, calendar and PDF export stay free. Text mocks, warmups and debriefs use a small part of a credit each; a voice mock, where the AI listens and speaks, costs more a minute than a live session. Each computer gets a free credit every month.";

interface Props {
  feature?: string;
  onClose: () => void;
}

/**
 * The credit position, in one line.
 *
 * A balance below zero is a debt, not an empty balance: "a pack, or next
 * month's free credit, gets you practising and live again" was untrue of a
 * debt bigger than either, so owing says what gets paid first instead.
 */
export function creditLine(account: Pick<AccountStatus, "signed_in" | "balance" | "free">): string {
  if (!account.signed_in) {
    return "Sign in to use credits. Each computer gets one free credit a month — half an hour of live session.";
  }
  const available = account.balance?.available ?? 0;
  const owed = owedCredits(account.balance);
  if (owed > 0) return `${owedNotice(owed)} Your library and progress are all still here.`;
  if (available > 0) {
    return `You have ${formatCredits(available)} ${available === 1 ? "credit" : "credits"} — about ${liveMinutes(available)} of live session. Debriefs and study packs use a small part of a credit each.`;
  }
  return account.free?.elsewhere
    ? "You are out of credits, and this computer's free credit for this month went to another account — it's one per computer. A pack gets you practising and live again."
    : "You are out of credits. Your library and progress are all still here — a pack, or next month's free credit, gets you practising and live again.";
}

export default function UpgradeDialog({ feature, onClose }: Props) {
  const status = useLicence();
  // The dialog states the credit position; the gate that opened it is still
  // the licence entitlement. Wiring the gates themselves to credits is its own
  // job — this makes sure the dialog does not say something untrue while it
  // waits.
  const account = useAccount();
  const closeRef = useRef<HTMLButtonElement>(null);
  const key = (feature && feature in LEAD ? feature : "live") as ProFeature;

  useEffect(() => {
    track(`upgrade.shown.${key}`);
    closeRef.current?.focus();
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [key, onClose]);

  const lapsed = ["expired", "revoked", "invalid"].includes(status.licence.state);

  return (
    <div
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="iReliabee Pro"
      style={{
        position: "fixed", inset: 0, zIndex: 500,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: 460, maxWidth: "100%", maxHeight: "86vh", overflowY: "auto",
          background: "rgba(var(--base-rgb), 0.96)",
          backdropFilter: "blur(24px)", WebkitBackdropFilter: "blur(24px)",
          borderRadius: 16, padding: "26px 26px 22px",
          boxShadow: "0 24px 64px rgba(0,0,0,0.7)",
          display: "flex", flexDirection: "column", gap: 16, position: "relative",
        }}
      >
        <button
          ref={closeRef}
          onClick={onClose}
          aria-label="Close"
          style={{
            position: "absolute", top: 14, right: 14, border: "none", background: "transparent",
            color: "var(--muted)", cursor: "pointer", padding: 4, borderRadius: 6, lineHeight: 0,
          }}
        >
          <X size={16} />
        </button>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 11,
            background: "rgba(var(--accent-rgb),0.14)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <Sparkles size={19} style={{ color: "var(--accent)" }} />
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: "var(--text)", lineHeight: 1.25 }}>
            {LEAD[key]}
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.65 }}>
            {BLURB[key]}
          </div>
        </div>

        {!lapsed && (
          <div style={{
            fontSize: 12, color: "var(--muted)", lineHeight: 1.6,
            background: "rgba(var(--ink-rgb),0.05)", borderRadius: 9, padding: "10px 12px",
          }}>
            {creditLine(account)}
          </div>
        )}

        {lapsed && status.licence.message && (
          <div style={{
            fontSize: 12, color: "var(--text)", lineHeight: 1.6,
            background: "rgba(245,158,11,0.12)",
            borderRadius: 9, padding: "10px 12px",
          }}>
            {status.licence.message}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.06em",
                        textTransform: "uppercase", color: "var(--muted)" }}>
            What credits buy
          </div>
          {EVERYTHING.map(item => (
            <div key={item} style={{ display: "flex", gap: 8, fontSize: 12.5,
                                     color: "var(--text)", lineHeight: 1.5 }}>
              <span style={{ color: "var(--accent)" }} aria-hidden>•</span>
              <span>{item}</span>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
          {FREE_ALWAYS}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
          <button
            onClick={() => { track(`upgrade.buy.${key}`); openExternal(BUY_URL); }}
            style={{
              flex: 1, padding: "10px 0", border: "none", borderRadius: 9,
              background: "var(--accent)", color: "var(--on-primary, #fff)",
              fontSize: 13, fontWeight: 700, fontFamily: "var(--font)", cursor: "pointer",
            }}
          >
            Buy credits
          </button>
          <button
            onClick={() => {
              track("upgrade.sign_in");
              onClose();
              window.dispatchEvent(new CustomEvent("navigate", { detail: "plan" }));
            }}
            style={{
              flex: 1, padding: "10px 0", border: "none", borderRadius: 9,
              background: "rgba(var(--ink-rgb),0.07)", color: "var(--text)",
              fontSize: 13, fontWeight: 600, fontFamily: "var(--font)", cursor: "pointer",
            }}
          >
            {account.signed_in ? "Your account" : "Sign in"}
          </button>
        </div>

        {status.licence.is_pro && (
          <div style={{ fontSize: 11.5, color: "var(--muted)", textAlign: "center" }}>
            {PLAN_LABELS[status.licence.plan] ?? "Pro"} licence active
          </div>
        )}
      </div>
    </div>
  );
}
