import { useEffect, useRef, useState } from "react";
import { BookMarked, Download, Loader2, Plus, Search } from "lucide-react";
import toast from "react-hot-toast";
import { dictionaryApi, mb, type DictEntry, type DictStatus } from "../lib/dictionary";
import { wordcraftApi } from "../lib/wordcraft";
import { notifyError } from "../lib/errors";
import { openExternal } from "../lib/openExternal";

/**
 * Wordcraft's dictionary and phrase builder (docs/dictionary.md). Downloaded the
 * first time it is opened; after that every lookup is on this computer, free and
 * offline. Meanings come from Open English WordNet, real sentences and the words
 * that go before and after a word from Tatoeba.
 */
export default function WordcraftDictionary() {
  const [status, setStatus] = useState<DictStatus | null>(null);
  const [q, setQ] = useState("");
  const [hints, setHints] = useState<string[]>([]);
  const [entry, setEntry] = useState<DictEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number>();

  const refresh = () => dictionaryApi.status().then(s => { setStatus(s); return s; });
  useEffect(() => { refresh().catch(notifyError); return () => window.clearInterval(poll.current); }, []);
  useEffect(() => {
    window.clearInterval(poll.current);
    if (status?.download.state === "downloading") poll.current = window.setInterval(() => { void refresh().catch(() => {}); }, 700);
  }, [status?.download.state]);
  useEffect(() => {
    if (!status?.installed || q.trim().length < 2) { setHints([]); return; }
    const t = window.setTimeout(() => { dictionaryApi.suggest(q).then(r => setHints(r.words)).catch(() => setHints([])); }, 150);
    return () => window.clearTimeout(t);
  }, [q, status?.installed]);

  async function look(word = q) {
    if (!word.trim()) return;
    setBusy(true); setHints([]);
    try { setEntry(await dictionaryApi.lookup(word)); setQ(word); } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  async function keep(text: string, meaning: string, example?: string) {
    try {
      await wordcraftApi.addCard({ text, meaning, example, kind: text.includes(" ") ? "phrase" : "word" });
      toast.success(`“${text}” is in your cards`);
    } catch (e) { notifyError(e); }
  }

  if (!status) return <p className="muted"><Loader2 size={14} className="spin" /> Opening the dictionary…</p>;

  const credits = (
    <p className="muted dict-credits">Meanings: {status.credits.map((c, i) => (
      <span key={c.name}>{i > 0 && " · "}<button type="button" className="link-btn" onClick={() => void openExternal(c.url)}>{c.name}</button> ({c.licence})</span>
    ))}. Everything stays on this computer.</p>
  );

  if (!status.installed) {
    const d = status.download;
    const pct = d.total ? Math.round((100 * d.done) / d.total) : 0;
    return (
      <div className="glass-card dict-setup">
        <BookMarked size={28} />
        <h3>A dictionary that works offline</h3>
        <p>Meanings, examples and synonyms for about 127,000 English words, real sentences, and the phrase builder:
          the words people put before and after a word. It downloads once (about 17 MB), then works without internet.
          Looking words up is free and never leaves this computer.</p>
        {d.state === "downloading" ? (
          <div className="dict-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Downloading the dictionary">
            <span style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        {d.state === "downloading" ? (
          <small className="dict-progress-label" aria-live="polite">{!d.total ? "Starting…" : d.done >= d.total ? "Unpacking…" : `${mb(d.done)} of ${mb(d.total)}`}</small>
        ) : (
          <button type="button" className="btn-primary" onClick={() => { dictionaryApi.download().then(setStatus).catch(notifyError); }}>
            <Download size={14} /> {d.state === "error" ? "Try again" : "Download the dictionary"}
          </button>
        )}
        {d.state === "error" && <p className="dict-error" role="alert">{d.error}</p>}
        {credits}
      </div>
    );
  }

  return (
    <div className="dict">
      <form className="dict-search" onSubmit={e => { e.preventDefault(); void look(); }}>
        <Search size={15} aria-hidden="true" />
        <input id="dict-q" className="nb-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Look up a word or phrase…"
          aria-label="Word to look up" autoComplete="off" list="dict-hints" />
        <datalist id="dict-hints">{hints.map(h => <option key={h} value={h} />)}</datalist>
        <button type="submit" className="btn-primary" disabled={busy || !q.trim()}>{busy ? <Loader2 size={14} className="spin" /> : "Look up"}</button>
      </form>

      {entry && !entry.found && <p className="muted">No entry for “{entry.query}”. Check the spelling, or try the word on its own.</p>}

      {entry?.found && (
        <article className="glass-card dict-entry" aria-live="polite">
          <h3 className="dict-word">{entry.word}</h3>
          {entry.forms_of.length > 0 && <p className="muted dict-forms">Also a form of {entry.forms_of.map((f, i) => (
            <button key={f} type="button" className="link-btn" onClick={() => void look(f)}>{i > 0 ? ", " : ""}{f}</button>))}</p>}
          {entry.meanings.map(m => (
            <section key={m.pos} className="dict-pos">
              <p className="dict-pos-name">{m.pos}</p>
              <ol>
                {m.senses.map((s, i) => (
                  <li key={i}>
                    <span>{s.definition}</span>
                    {s.examples[0] && <em className="dict-example">“{s.examples[0]}”</em>}
                    {s.synonyms.length > 0 && <span className="dict-syn">Also: {s.synonyms.map((w, k) => (
                      <button key={w} type="button" className="link-btn" onClick={() => void look(w)}>{k > 0 ? ", " : ""}{w}</button>))}</span>}
                    <button type="button" className="nbk-pill dict-keep" onClick={() => void keep(entry.word, s.definition, s.examples[0] ?? entry.sentences[0])}
                      title="Add this meaning to your Wordcraft cards"><Plus size={12} /> Card</button>
                  </li>
                ))}
              </ol>
            </section>
          ))}

          {(entry.phrases.before.length > 0 || entry.phrases.after.length > 0) && (
            <section className="dict-phrases">
              <p className="dict-pos-name">Phrase builder</p>
              <p className="muted">The words people most often put before and after “{entry.word}”. Click one to keep the phrase as a card.</p>
              <div className="dict-phrase-cols">
                {entry.phrases.before.length > 0 && <div><small>before</small>{entry.phrases.before.map(p => (
                  <button key={p.word} type="button" className="talk-chip" onClick={() => void keep(`${p.word} ${entry.word}`, `A common phrase with “${entry.word}”.`, entry.sentences.find(s => s.toLowerCase().includes(`${p.word} ${entry.word}`)))}>
                    {p.word} <b>{entry.word}</b></button>))}</div>}
                {entry.phrases.after.length > 0 && <div><small>after</small>{entry.phrases.after.map(p => (
                  <button key={p.word} type="button" className="talk-chip" onClick={() => void keep(`${entry.word} ${p.word}`, `A common phrase with “${entry.word}”.`, entry.sentences.find(s => s.toLowerCase().includes(`${entry.word} ${p.word}`)))}>
                    <b>{entry.word}</b> {p.word}</button>))}</div>}
              </div>
            </section>
          )}

          {entry.sentences.length > 0 && (
            <section>
              <p className="dict-pos-name">In real sentences</p>
              <ul className="dict-sentences">{entry.sentences.map(s => <li key={s}>{s}</li>)}</ul>
            </section>
          )}
        </article>
      )}
      {credits}
    </div>
  );
}
