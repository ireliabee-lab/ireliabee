import { useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Plus, X } from "lucide-react";
import { notifyError } from "../lib/errors";
import { analyseTask, checkQuestion, type Found } from "../lib/taskAnalysis";
import { checkDraft } from "../lib/draftChecks";
import type { Project, ProjectPatch } from "../lib/writing";

/**
 * The brief, read by rule on this computer: what it asks you to do, what narrows it, what it
 * requires, its word limit and its key terms (lib/taskAnalysis.ts). It only suggests; the writer
 * confirms the key terms, which the final check looks for in the draft.
 */
export function TaskAnalyser({ p, onPatch }: { p: Project; onPatch: (change: ProjectPatch) => Promise<void> }) {
  const a = useMemo(() => analyseTask(p.brief), [p.brief]);
  const [adding, setAdding] = useState("");
  if (!p.brief.trim()) return null;
  const saveTerms = (terms: string[]) => void onPatch({ key_terms: terms }).catch(notifyError);
  const suggested = a.keyTerms.filter(t => !p.key_terms.some(k => k.toLowerCase() === t.toLowerCase()));
  return (
    <div className="write-analysis" aria-label="What the brief asks">
      <p className="write-marked">{marked(p.brief, a.directions, a.limits)}</p>
      <div className="write-analysis-grid">
        <div>
          <span className="write-kicker">What it asks you to do</span>
          {a.directions.length ? (
            <ul className="write-plain">
              {a.directions.map((d, i) => <li key={i}><strong className="write-dir">{d.text}</strong>: {d.meaning}</li>)}
            </ul>
          ) : <p className="muted">No direction word found. Look for the verb that says what to do: discuss, evaluate, compare…</p>}
        </div>
        <div>
          <span className="write-kicker">What narrows it</span>
          {a.limits.length ? <div className="write-chips">{a.limits.map((l, i) => <span key={i} className="write-chip lim">{l.text}</span>)}</div>
            : <p className="muted">No limits found. If the task has none, set your own: a place, a period, a group.</p>}
        </div>
        <div className="wide">
          <span className="write-kicker">What it requires</span>
          {a.requirements.length ? <ul className="write-plain">{a.requirements.map((r, i) => <li key={i}>{r}</li>)}</ul>
            : <p className="muted">No &ldquo;must&rdquo;, &ldquo;should&rdquo; or &ldquo;at least&rdquo; found. Check the rubric for requirements.</p>}
          {a.wordLimit != null && a.wordLimit !== p.word_limit && (
            <button type="button" className="btn-ghost write-use" onClick={() => void onPatch({ word_limit: a.wordLimit as number }).catch(notifyError)}>
              The brief says {a.wordLimit.toLocaleString()} words. Use that limit
            </button>
          )}
        </div>
        <div className="wide">
          <span className="write-kicker">Key terms: the final check looks for each in your draft</span>
          <div className="write-chips">
            {p.key_terms.map(t => (
              <span key={t} className="write-chip term">{t}
                <button type="button" aria-label={`Remove ${t}`} onClick={() => saveTerms(p.key_terms.filter(k => k !== t))}><X size={11} /></button>
              </span>
            ))}
            {suggested.map(t => (
              <button key={t} type="button" className="write-chip suggest" title="Add as a key term" onClick={() => saveTerms([...p.key_terms, t])}>
                <Plus size={11} /> {t}
              </button>
            ))}
            <form className="write-chip-add" onSubmit={e => { e.preventDefault(); if (adding.trim()) { saveTerms([...p.key_terms, adding.trim()]); setAdding(""); } }}>
              <input value={adding} onChange={e => setAdding(e.target.value)} placeholder="Add a term" aria-label="Add a key term" maxLength={60} />
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The brief with its direction words and limits marked. */
function marked(text: string, directions: Found[], limits: Found[]) {
  const spans = [...directions.map(d => ({ ...d, kind: "dir" })), ...limits.map(l => ({ ...l, kind: "lim" }))].sort((x, y) => x.start - y.start);
  const out: (string | JSX.Element)[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    if (s.start < at) return;
    out.push(text.slice(at, s.start));
    out.push(<mark key={i} className={`write-mark ${s.kind}`}>{text.slice(s.start, s.end)}</mark>);
    at = s.end;
  });
  out.push(text.slice(at));
  return out;
}

/** The research question against the series' criteria. */
export function QuestionCheck({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <ul className="write-qcheck" aria-label="Research question check">
      {checkQuestion(text).map(c => (
        <li key={c.key} className={c.ok ? "ok" : "todo"}>
          {c.ok ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
          <span><strong>{c.label}</strong>{!c.ok && <> {c.tip}</>}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The free checks (lib/draftChecks.ts) on the whole draft, re-run as it changes. What needs fixing
 * first, then tips, then what is already right; each finding opens the section it quotes.
 */
export function DraftChecks({ p, genre, videos, onOpenSection }: {
  p: Project; genre: { key: string; first_person: boolean }; videos: Record<string, string>; onOpenSection: (id: number) => void;
}) {
  const findings = useMemo(() => checkDraft({
    genre: genre.key, firstPerson: genre.first_person, wordLimit: p.word_limit, keyTerms: p.key_terms,
    sections: (p.sections ?? []).map(s => ({ id: s.id, key: s.key, title: s.title, body: s.body, target: s.target })),
  }), [p, genre]);
  const [showOk, setShowOk] = useState(false);
  const counts = { fix: findings.filter(f => f.level === "fix").length, tip: findings.filter(f => f.level === "tip").length, ok: findings.filter(f => f.level === "ok").length };
  const titleOf = (id: number) => p.sections?.find(s => s.id === id)?.title ?? "";
  return (
    <div className="write-checks" aria-label="Checks on your draft">
      <div className="write-checks-head">
        <span className="write-kicker">Checks on your draft · free, on this computer</span>
        <span className="write-checks-sum">
          <span className="fix">{counts.fix} to fix</span><span className="tip">{counts.tip} tips</span><span className="ok">{counts.ok} good</span>
        </span>
      </div>
      <ul className="write-findings">
        {findings.filter(f => showOk || f.level !== "ok").map(f => (
          <li key={f.key} className={f.level}>
            {f.level === "ok" ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
            <div>
              <strong>{f.title}</strong>
              <span className="muted"> {f.detail}</span>
              {f.where && f.where.length > 0 && (
                <ul className="write-where">
                  {f.where.map((w, i) => (
                    <li key={i}><button type="button" onClick={() => onOpenSection(w.sectionId)} title={`Open ${titleOf(w.sectionId)}`}>
                      <em>{titleOf(w.sectionId)}:</em> {w.quote}
                    </button></li>
                  ))}
                </ul>
              )}
              {f.videos.length > 0 && <span className="write-finding-videos">{f.videos.map(v => videos[v]).filter(Boolean).join(" · ")}</span>}
            </div>
          </li>
        ))}
      </ul>
      {counts.ok > 0 && (
        <button type="button" className="btn-ghost write-show-ok" onClick={() => setShowOk(s => !s)}>
          {showOk ? "Hide what is already good" : `Show what is already good (${counts.ok})`}
        </button>
      )}
    </div>
  );
}
