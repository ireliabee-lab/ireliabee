import { useEffect, useState } from "react";
import { Loader2, Plus, ScrollText, Trash2, Users } from "lucide-react";
import { openMockWith } from "./MockInterviewView";
import { PAPER_FIELDS, PASSES, journalDetails, researchApi, type Paper, type PaperSource } from "../lib/research";
import { notifyError } from "../lib/errors";
import { track } from "../lib/usage";

/**
 * Paper cards: the learner's own summary of each paper, filled in over three
 * reading passes. Writing it yourself is the practice; nothing here is
 * generated. A finished card can be presented at the Journal Club.
 */
export default function ResearchPapers() {
  const [papers, setPapers] = useState<Paper[] | null>(null);
  const [sources, setSources] = useState<PaperSource[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  const load = () => Promise.all([researchApi.papers(), researchApi.paperSources()])
    .then(([p, s]) => { setPapers(p); setSources(s); }).catch(notifyError);
  useEffect(() => { load(); }, []);

  async function add(src?: PaperSource) {
    try {
      const p = await researchApi.addPaper(src
        ? { title: src.title, ...(src.kind === "document" ? { document_id: src.id } : { notebook_id: src.id }) }
        : { title });
      track("research.paper.add");
      setTitle(""); setAdding(false); setOpen(p.id); load();
    } catch (e) { notifyError(e); }
  }

  if (!papers) return <div className="progress-loading"><Loader2 size={18} className="spin" /></div>;
  const complete = papers.filter(p => p.complete).length;
  return (
    <div className="research-papers">
      <div className="research-toolbar">
        <span className="muted">{papers.length} paper{papers.length === 1 ? "" : "s"} · {complete} complete card{complete === 1 ? "" : "s"}. Level 1 asks for 10 complete cards; a field map is 30.</span>
        <button className="btn-primary" onClick={() => setAdding(!adding)}><Plus size={14} /> Add a paper</button>
      </div>
      {adding && (
        <div className="glass-card research-form">
          {sources.length > 0 && <>
            <div className="settings-label">From your Library and reading notes</div>
            <div className="research-sources">
              {sources.map(s => (
                <button key={`${s.kind}-${s.id}`} className="scenario-option" onClick={() => add(s)} title={s.file || undefined}>
                  <ScrollText size={13} /> {s.title}{s.kind === "notebook" && <span className="muted"> · reading notes</span>}
                </button>
              ))}
            </div>
          </>}
          <label className="settings-label" htmlFor="rt-paper">Or type a paper's title</label>
          <input id="rt-paper" className="glass-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Warner, Bernstein Ratner & Jackson (2026). Information load predicts stuttering events" />
          <div className="research-actions"><button className="btn-primary" disabled={!title.trim()} onClick={() => add()}>Add card</button></div>
        </div>
      )}
      {papers.length === 0 && !adding && (
        <div className="glass-card plans-empty">
          <div className="plans-empty-title">No papers yet</div>
          <p className="muted">Add a paper you're reading. You'll write its card in your own words over three passes: skim, understand, rebuild.</p>
        </div>
      )}
      {papers.map(p => (
        <PaperCard key={p.id} paper={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} onChange={load} />
      ))}
    </div>
  );
}

function PaperCard({ paper, open, onToggle, onChange }: { paper: Paper; open: boolean; onToggle: () => void; onChange: () => void }) {
  const [draft, setDraft] = useState(paper);
  useEffect(() => setDraft(paper), [paper]);

  async function save(fields: Partial<Paper>) {
    try { await researchApi.updatePaper(paper.id, fields); onChange(); } catch (e) { notifyError(e); }
  }
  async function remove() {
    try { await researchApi.deletePaper(paper.id); track("research.paper.delete"); onChange(); } catch (e) { notifyError(e); }
  }
  const filled = PAPER_FIELDS.filter(f => paper[f.key].trim()).length;

  return (
    <section className="glass-card research-paper">
      <button className="research-paper-head" onClick={onToggle}>
        <ScrollText size={15} />
        <b>{paper.title}</b>
        <span className="muted">{PASSES[paper.pass]} · {filled}/5 fields</span>
        {paper.complete && <span className="research-due held">complete</span>}
      </button>
      {open && (
        <div className="research-paper-body">
          <div className="research-passes" role="radiogroup" aria-label="Reading passes done">
            {PASSES.map((label, i) => (
              <button key={label} role="radio" aria-checked={paper.pass === i} className={`scenario-option ${paper.pass === i ? "active" : ""}`}
                onClick={() => { save({ pass: i }); track("research.paper.pass"); }}>{label}</button>
            ))}
          </div>
          <label className="settings-label" htmlFor={`pa-${paper.id}`}>Authors and year</label>
          <input id={`pa-${paper.id}`} className="glass-input" value={draft.authors} onChange={e => setDraft({ ...draft, authors: e.target.value })}
            onBlur={() => draft.authors !== paper.authors && save({ authors: draft.authors })} />
          {PAPER_FIELDS.map(f => (
            <div key={f.key}>
              <label className="settings-label" htmlFor={`p-${paper.id}-${f.key}`}>{f.label}</label>
              <textarea id={`p-${paper.id}-${f.key}`} className="glass-input" rows={f.key === "critique" ? 4 : 3} placeholder={f.hint}
                value={draft[f.key]} onChange={e => setDraft({ ...draft, [f.key]: e.target.value })}
                onBlur={() => draft[f.key] !== paper[f.key] && save({ [f.key]: draft[f.key] })} />
            </div>
          ))}
          <div className="research-actions">
            <button className="btn-neutral danger" onClick={remove}><Trash2 size={14} /> Remove card</button>
            <button className="btn-primary" disabled={filled < 3}
              title={filled < 3 ? "Fill at least the question, method and result first" : "Present this paper and take the panel's questions"}
              onClick={() => openMockWith({ scenario: "journal_club", subject: paper.authors ? `${paper.authors}: ${paper.title}` : paper.title,
                details: journalDetails(paper), documentIds: paper.document_id ? [paper.document_id] : [] })}>
              <Users size={14} /> Present at journal club
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
