import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { Loader2, MessageSquare } from "lucide-react";
import { notifyError } from "../lib/errors";
import { track } from "../lib/usage";
import { phoneApi, type PhoneInfo } from "../lib/meetings";

/**
 * The number meeting reminders are texted to: added once, confirmed with a
 * code iReliabee texts to it, and shown masked afterwards. What a text costs
 * is said here, before any is turned on (docs/meetings-and-reminders.md, R2).
 */
export default function PhoneSettings() {
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [number, setNumber] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    phoneApi.get().then(setInfo).catch(() => setInfo({ phone: null, confirmed: false, signed_in: false, price: null }));
  }, []);

  async function sendCode() {
    setBusy(true);
    try {
      const r = await phoneApi.start(number);
      setSentTo(r.sent_to);
      setCode("");
      track("reminders.phone.code");
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true);
    try {
      const r = await phoneApi.confirm(code);
      setInfo(i => (i ? { ...i, phone: r.phone, confirmed: true } : i));
      setSentTo(null);
      setChanging(false);
      setNumber("");
      track("reminders.phone.confirmed");
      toast.success(`Text reminders will go to ${r.phone}`);
    } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  const price = info?.price;
  return (
    <div className="phone-settings">
      <strong><MessageSquare size={13} /> Text-message reminders</strong>
      <small className="muted">
        For meeting reminders by text, to a Ghanaian mobile number.
        {price ? ` Each text costs ${price.credits_per_text} credits (about ${price.about_pesewas} pesewas); a reminder is at most ${price.max_texts_per_reminder} texts. You choose which meetings get them.` : ""}
      </small>
      {!info ? (
        <small className="muted"><Loader2 size={12} className="spin" /> Checking…</small>
      ) : !info.signed_in ? (
        <small className="muted">Sign in to iReliabee to add your number.</small>
      ) : info.confirmed && !changing ? (
        <div className="phone-row">
          <span>Texts go to <strong>{info.phone}</strong></span>
          <button type="button" className="btn-neutral" onClick={() => setChanging(true)}>Change number</button>
        </div>
      ) : !sentTo ? (
        <div className="phone-row">
          <input id="phone-number" className="mt-input" inputMode="tel" autoComplete="tel" placeholder="024 412 3456"
            aria-label="Your Ghanaian mobile number" value={number} onChange={e => setNumber(e.target.value)} />
          <button type="button" className="btn-primary" disabled={busy || number.replace(/\D/g, "").length < 9} onClick={sendCode}>
            {busy ? <Loader2 size={13} className="spin" /> : null} Text me a code
          </button>
          {changing && <button type="button" className="btn-neutral" onClick={() => setChanging(false)}>Keep {info.phone}</button>}
        </div>
      ) : (
        <div className="phone-row">
          <input id="phone-code" className="mt-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            placeholder="6-digit code" aria-label={`The code texted to ${sentTo}`} value={code} onChange={e => setCode(e.target.value)} />
          <button type="button" className="btn-primary" disabled={busy || code.replace(/\D/g, "").length !== 6} onClick={confirm}>
            {busy ? <Loader2 size={13} className="spin" /> : null} Confirm
          </button>
          <button type="button" className="btn-neutral" onClick={() => setSentTo(null)}>Use another number</button>
          <small className="muted">Sent to {sentTo}. It expires in 10 minutes.</small>
        </div>
      )}
    </div>
  );
}
