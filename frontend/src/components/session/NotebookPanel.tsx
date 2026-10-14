import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, RotateCw, NotebookPen } from "lucide-react";
import { fetchApi } from "../../lib/api";
import { ensureReady, notifyError } from "../../lib/errors";
import { track } from "../../lib/usage";
import { notebookApi, rememberStyle, rememberedStyle, type AutoState, type Notebook, type NotebookKind, type NotebookStyle } from "../../lib/notebook";
import { formatCredits, useAccount } from "../../lib/account";
import Illustration from "../Illustration";
import FilePicker from "../FilePicker";
import StylePicker from "../notebook/StylePicker";
import NotebookEditor from "../notebook/NotebookEditor";

/** "2 h 40 min" */
function hoursAndMinutes(seconds: number): string {
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/**
 * A session's notebook (spec 184), in the session hub. If there is none yet,
 * the user chooses how it should look first — font, size, style — and only
 * then does the AI write it.
 */
export default function NotebookPanel({ sessionId, lecture }: { sessionId: number; lecture: boolean }) {
  const kind: NotebookKind = lecture ? "lecture" : "meeting";
  const [nb, setNb] = useState<Notebook | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [style, setStyle] = useState<NotebookStyle>(() => rememberedStyle(kind));
  const [tutor, setTutor] = useState(true);
  const [slides, setSlides] = useState<number[]>([]);
  const [rewrite, setRewrite] = useState(false);
  // The notebook written automatically when the session ended (decision 184-1).
  const [auto, setAuto] = useState<AutoState | null>(null);
  const account = useAccount();
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;          // set on every mount: StrictMode mounts, unmounts and mounts again
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    setLoading(true);
    notebookApi.forSession(sessionId)
      .then(n => { if (alive.current) setNb(n); })
      .catch(notifyError)
      .finally(() => { if (alive.current) setLoading(false); });
  }, [sessionId]);

  // No notebook yet: is one being written? The window opens as the session ends, so
  // "none" is only believed after a few seconds; "writing" is followed until it lands.
  useEffect(() => {
    if (loading || nb) return;
    let stop = false;
    let timer: number | undefined;
    const since = Date.now();
    const check = async () => {
      try {
        const st = await notebookApi.autoStatus(sessionId);
        if (stop || !alive.current) return;
        setAuto(st);
        if (st.state === "done") {
          const made = await notebookApi.forSession(sessionId);
          if (!stop && alive.current && made) setNb(made);
          return;
        }
        if (st.state === "writing" || (st.state === "none" && Date.now() - since < 6000)) {
          timer = window.setTimeout(check, 2500);
        }
      } catch { /* the button below still works */ }
    };
    check();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [sessionId, loading, nb]);

  const writingInBackground = auto?.state === "writing";

  async function generate(fallbackCredits?: boolean | unknown) {
    const useCredits = fallbackCredits === true;
    if (!(await ensureReady(["llm"]))) return;
    setWorking(true);
    rememberStyle(kind, style);
    try {
      const cfg = await fetchApi("/config").then(r => r.json()).catch(() => ({}));
      track(rewrite ? "notebook.rewrite" : "notebook.generate");
      const made = await notebookApi.generate({
        session_id: sessionId, style, model: cfg?.saved?.model || undefined,
        document_ids: slides.length ? slides : undefined, tutor: lecture ? tutor : false,
        fallback_credits: useCredits,
      });
      if (alive.current) { setNb(made); setRewrite(false); }
    } catch (e) { notifyError(e, () => generate(true)); } finally { if (alive.current) setWorking(false); }
  }

  if (loading) return <div className="glass-card plans-empty"><Loader2 size={18} className="spin" /></div>;

  if (nb && !rewrite) {
    return (
      <div className="session-hub-stack">
        <div className="nb-hub-actions">
          <span className="muted">{nb.edited ? "Edited by you" : "Written from the transcript"}{nb.generated_at ? ` · ${new Date(nb.generated_at + "Z").toLocaleDateString()}` : ""}</span>
          <button type="button" className="btn-neutral" onClick={() => { setStyle(nb.style); setRewrite(true); }}
            title="Write the notes again from the transcript. The current notes are kept as an earlier version.">
            <RotateCw size={13} /> Write again
          </button>
        </div>
        <NotebookEditor key={nb.id} initial={nb} onDeleted={() => setNb(null)} />
      </div>
    );
  }

  return (
    <div className="session-hub-stack">
      <div className="glass-card nb-make">
        <div className="nb-make-head">
          <Illustration name="stories" />
          <div>
            <div className="plans-empty-title">
              {working || writingInBackground ? "Writing your notes…" : rewrite ? "Write the notes again" : lecture ? "Turn this lecture into notes" : "Turn this meeting into notes"}
            </div>
            <p className="muted">
              {lecture
                ? "Beautiful notebook pages from what was said: key points highlighted, terms explained, a question column to test yourself, and every note linked to the moment it was said."
                : "A clean notebook page: the TL;DR, decisions, action items with owners and dates, open questions, risks and the numbers mentioned — each linked to the moment it was said."}
              {rewrite && " Your current notes are kept as an earlier version you can restore."}
            </p>
            {writingInBackground && (
              <p className="muted nb-auto-note"><Loader2 size={13} className="spin" /> Being written from the transcript now. You can close this window — they'll be here when you come back.</p>
            )}
            {auto?.state === "ask" && !working && (
              <p className="nb-auto-note">
                This session ran {hoursAndMinutes(auto.estimate.seconds)}, so the notes weren't written automatically.
                {" "}{account.admin
                  ? (auto.estimate.usd != null ? `They'll take about $${auto.estimate.usd.toFixed(2)} of ${auto.estimate.model}.` : "")
                  : (auto.estimate.credits != null ? `They'll take about ${formatCredits(Math.ceil(auto.estimate.credits * 100) / 100)} credits.` : "They're charged from your credits as they're written.")}
              </p>
            )}
            {auto?.state === "failed" && !working && (
              <p className="nb-field-error nb-auto-note">{auto.error.title}. {auto.error.message}</p>
            )}
          </div>
        </div>

        {!working && !writingInBackground && (
          <>
            <h3 className="nb-make-step"><NotebookPen size={14} /> First, choose how your notes look</h3>
            <StylePicker kind={kind} value={style} onChange={setStyle} />
            {lecture && (
              <>
                <label className="nb-toggle">
                  <input type="checkbox" checked={tutor} onChange={e => setTutor(e.target.checked)} />
                  <span>Add a few simple explanations where the lecture is hard to follow <span className="muted">(labelled as iReliabee's, never mixed with what was said)</span></span>
                </label>
                <div className="study-slides">
                  <label className="settings-label">Add the slides or handout (optional)</label>
                  <FilePicker value={slides} onChange={setSlides}
                    emptyHint="Add the lecture slides to your Library to make the notes more accurate." />
                </div>
              </>
            )}
          </>
        )}

        <div className="nb-make-actions">
          {rewrite && !working && <button type="button" className="btn-neutral" onClick={() => setRewrite(false)}>Cancel</button>}
          {!writingInBackground && (
            <button type="button" className="btn-primary" onClick={() => generate(false)} disabled={working}>
              {working ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} {working ? "Writing…" : "Make my notes"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
