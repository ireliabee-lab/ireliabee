import { useEffect, useMemo, useState } from "react";
import { BookOpenCheck, Loader2, Plus, Search, Sparkles } from "lucide-react";
import { GRADES, dueIn, researchApi, type Card, type TermStats } from "../lib/research";
import { notifyError } from "../lib/errors";
import { track } from "../lib/usage";
import toast from "react-hot-toast";

const TIERS = [
  { id: "", label: "All" },
  { id: "core", label: "Core" },
  { id: "field", label: "From my notes" },
  { id: "pack", label: "From field packs" },
  { id: "mine", label: "Added by me" },
];

/** The term bank: every card, how well it is held, and adding your own. */
export default function ResearchTerms({ onReview }: { onReview: () => void }) {
  const [q, setQ] = useState("");
  const [tier, setTier] = useState("");
  const [data, setData] = useState<{ terms: Card[]; stats: TermStats } | null>(null);
  const [adding, setAdding] = useState(false);
  const [term, setTerm] = useState("");
  const [definition, setDefinition] = useState("");
  const [open, setOpen] = useState<number | null>(null);

  const load = () => researchApi.terms(q, tier).then(setData).catch(notifyError);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [q, tier]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    try {
      await researchApi.addTerm(term, definition);
      track("research.term.add");
      setTerm(""); setDefinition(""); setAdding(false); load();
    } catch (e) { notifyError(e); }
  }
  async function harvest() {
    try {
      const { added } = await researchApi.harvest();
      track("research.term.harvest");
      toast.success(added ? `Added ${added} term${added === 1 ? "" : "s"} from your notes` : "No new terms in your notes");
      load();
    } catch (e) { notifyError(e); }
  }

  if (!data) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;
  const s = data.stats;
  return (
    <div className="research-terms">
      <div className="research-stats">
        <div className="glass-card progress-stat"><strong>{s.total}</strong><span>terms in your bank</span></div>
        <div className="glass-card progress-stat"><strong>{s.seen}</strong><span>seen so far</span></div>
        <div className="glass-card progress-stat"><strong>{s.held}</strong><span>held (last answered good or easy)</span></div>
        <div className="glass-card progress-stat"><strong>{Math.round(s.recall * 100)}<small>%</small></strong><span>of the bank held</span></div>
      </div>
      <div className="research-toolbar">
        <button className="btn-primary" onClick={onReview}><BookOpenCheck size={14} /> Review due cards</button>
        <div className="search-wrap"><Search size={13} /><input className="glass-input" aria-label="Search terms" placeholder="Search terms" value={q} onChange={e => setQ(e.target.value)} /></div>
        <div className="research-tiers">
          {TIERS.map(t => <button key={t.id} className={`scenario-option ${tier === t.id ? "active" : ""}`} onClick={() => setTier(t.id)}>{t.label}</button>)}
        </div>
        <button className="btn-neutral" onClick={harvest} title="Every term your reading and lecture notes define becomes a card"><Sparkles size={14} /> Find terms in my notes</button>
        <button className="btn-neutral" onClick={() => setAdding(!adding)}><Plus size={14} /> Add a term</button>
      </div>
      {adding && (
        <div className="glass-card research-form">
          <label className="settings-label" htmlFor="rt-term">Term</label>
          <input id="rt-term" className="glass-input" value={term} onChange={e => setTerm(e.target.value)} placeholder="e.g. Surprisal" />
          <label className="settings-label" htmlFor="rt-def">What it means, in your words</label>
          <textarea id="rt-def" className="glass-input" rows={3} value={definition} onChange={e => setDefinition(e.target.value)} />
          <div className="research-actions"><button className="btn-primary" disabled={!term.trim() || !definition.trim()} onClick={add}>Add to my bank</button></div>
        </div>
      )}
      <ul className="research-term-list">
        {data.terms.map(c => (
          <li key={c.id} className="glass-card">
            <button className="research-term-head" onClick={() => setOpen(open === c.id ? null : c.id)}>
              <b>{c.term}</b>
              <span className="muted">{c.grp || (c.tier === "field" ? "From my notes" : "Added by me")}</span>
              <span className={`research-due ${c.first_seen && (c.last_grade ?? 0) >= 2 ? "held" : ""}`}>{dueIn(c.first_seen ? c.due : null)}</span>
            </button>
            {open === c.id && <CardBody card={c} />}
          </li>
        ))}
        {data.terms.length === 0 && <li className="muted">No terms match.</li>}
      </ul>
    </div>
  );
}

function CardBody({ card }: { card: Card }) {
  return (
    <div className="research-card-body">
      <p>{card.definition}</p>
      {card.example && <p><span className="settings-label">Said well</span><br />“{card.example}”</p>}
      {card.misuse && <p><span className="settings-label">Watch out</span><br />{card.misuse}</p>}
      {card.when_used && <p><span className="settings-label">When to use it</span><br />{card.when_used}</p>}
      {card.source && <p className="muted">From: {card.source}</p>}
    </div>
  );
}

/**
 * Spaced review: say the definition out loud, turn the card, grade yourself.
 * Keys: space turns the card, 1–4 grade it.
 */
export function ReviewDeck({ onDone }: { onDone: () => void }) {
  const [queue, setQueue] = useState<Card[] | null>(null);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState({ total: 0, good: 0 });

  useEffect(() => {
    researchApi.queue().then(q => setQueue([...q.due, ...q.new])).catch(e => { notifyError(e); setQueue([]); });
  }, []);
  const card = queue?.[0];

  async function grade(g: number) {
    if (!card) return;
    try {
      await researchApi.grade(card.id, g);
      setDone(d => ({ total: d.total + 1, good: d.good + (g >= 2 ? 1 : 0) }));
      // "Again" comes back at the end of this run, as it would in ten minutes.
      setQueue(q => (q ? [...q.slice(1), ...(g === 0 ? [card] : [])] : q));
      setShown(false);
    } catch (e) { notifyError(e); }
  }

  const keys = useMemo(() => (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.closest("input, textarea")) return;
    if (e.key === " ") { e.preventDefault(); setShown(true); return; }
    const g = GRADES.find(x => x.key === e.key);
    if (g && shown) grade(g.grade);
  }, [shown, card]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys); }, [keys]);

  if (!queue) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;
  if (!card) {
    return (
      <div className="glass-card plans-empty">
        <div className="plans-empty-title">{done.total ? "Done for now" : "Nothing due"}</div>
        <p className="muted">{done.total ? `${done.total} reviews, ${done.good} remembered. The cards you found hard come back sooner.` : "Your next cards come back tomorrow."}</p>
        <button className="btn-primary" onClick={onDone}>Back</button>
      </div>
    );
  }
  return (
    <div className="research-review">
      <div className="research-review-meta muted">{queue.length} left · {card.first_seen ? "review" : "new card"} · {card.grp || card.tier}</div>
      <div className="glass-card research-flash">
        <div className="research-flash-term">{card.term}</div>
        {!shown && <p className="muted">Say what it means, and use it in a sentence, out loud. Then turn the card.</p>}
        {shown && <CardBody card={card} />}
      </div>
      {!shown
        ? <button className="btn-primary research-turn" onClick={() => setShown(true)}>Turn the card <kbd>Space</kbd></button>
        : <div className="research-grades">
            {GRADES.map(g => (
              <button key={g.grade} className={g.grade === 0 ? "btn-neutral danger" : g.grade === 2 ? "btn-primary" : "btn-neutral"} onClick={() => grade(g.grade)}>
                {g.label} <kbd>{g.key}</kbd>
              </button>
            ))}
          </div>}
      <button className="btn-neutral research-stop" onClick={onDone}>Stop for now</button>
    </div>
  );
}
