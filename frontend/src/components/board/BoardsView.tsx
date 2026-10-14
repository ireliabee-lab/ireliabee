import { useEffect, useState } from "react";
import { Loader2, Plus, Search, StickyNote } from "lucide-react";
import Page from "../Page";
import Wall from "./Wall";
import { notifyError } from "../../lib/errors";
import { track } from "../../lib/usage";
import { boardApi, type Board, type BoardSummary } from "../../lib/boards";

/**
 * Idea boards: a cork wall per topic, for the thinking that happens before
 * there is a plan. Pick a board to open its wall, or start a new one.
 */
export default function BoardsView() {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Board | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(q = query) {
    try { setBoards(await boardApi.list(q)); } catch (e) { notifyError(e); setBoards([]); }
  }

  useEffect(() => { void load(""); }, []);                       // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = window.setTimeout(() => { void load(query); }, 250);
    return () => window.clearTimeout(t);
  }, [query]);                                                   // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    setBusy(true);
    try {
      const made = await boardApi.create("");
      track("board.create");
      setOpen(made);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  }

  async function show(id: number) {
    setBusy(true);
    try { setOpen(await boardApi.get(id)); } catch (e) { notifyError(e); } finally { setBusy(false); }
  }

  if (open) {
    return (
      <div className="page-content board-open">
        <Wall board={open} onBack={() => { setOpen(null); void load(); }}
          onChanged={() => { /* the list is refreshed when the wall is left */ }}
          onDeleted={() => { setOpen(null); void load(); }} />
      </div>
    );
  }

  return (
    <Page
      title="Idea board"
      subtitle="Sticky notes on a cork wall — for working an idea out before it becomes a plan."
      actions={
        <button className="btn-primary" onClick={() => void start()} disabled={busy}>
          {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} New board
        </button>
      }
    >
      <div className="page-content">
        <div className="nb-search">
          <Search size={15} className="muted" />
          <input className="nb-input" value={query} onChange={e => setQuery(e.target.value)}
            placeholder="Search boards and notes" aria-label="Search boards and notes" />
        </div>

        {boards === null ? (
          <p className="muted"><Loader2 size={14} className="spin" /> Loading…</p>
        ) : boards.length === 0 ? (
          <div className="board-blank glass-card">
            <StickyNote size={22} className="muted" />
            <p><strong>{query ? "Nothing matches that." : "No boards yet."}</strong></p>
            <p className="muted">
              {query
                ? "Try another word, or start a board for it."
                : "A board is a wall you can pin thoughts to: one note each, moved around until they make sense."}
            </p>
            <button className="btn-primary" onClick={() => void start()}><Plus size={14} /> New board</button>
          </div>
        ) : (
          <div className="board-list">
            {boards.map(b => (
              <button key={b.id} type="button" className="board-card glass-card" onClick={() => void show(b.id)}>
                <span className="board-card-pins" aria-hidden="true">
                  <i className="pin-red" /><i className="pin-blue" /><i className="pin-yellow" />
                </span>
                <strong className="board-card-title">{b.title}</strong>
                <span className="muted board-card-preview">{b.preview || "Nothing pinned yet."}</span>
                <span className="board-card-meta muted">
                  {b.notes} note{b.notes === 1 ? "" : "s"} · {new Date(b.updated_at + "Z").toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}
