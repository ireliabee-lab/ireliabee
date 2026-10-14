import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Grid3x3, LayoutGrid, Loader2, Plus, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import ConfirmDialog from "../ConfirmDialog";
import StickyNote from "./StickyNote";
import MeetingForm from "../MeetingForm";
import { fromNoteText, meetingsApi, type Meeting } from "../../lib/meetings";
import { notifyError } from "../../lib/errors";
import { track } from "../../lib/usage";
import { RESTARTING } from "../../lib/restart";
import {
  angleTo, boardApi, freeSpot, nextColour, nextPin, place, turnBy, wrapAngle,
  GRID, NOTE_H, NOTE_MAX, NOTE_MIN, NOTE_W, ROT_MAX, ROT_STEP, WALL,
  type Board, type Note, type NoteColour, type NotePatch, type PinColour,
} from "../../lib/boards";

/** How long after the last change a note is saved. Long enough to type through. */
const SAVE_MS = 500;
/** Cork beyond the furthest note, so there is always somewhere to put the next one. */
const MARGIN = 600;

// A drag belongs to the pointer that started it: a second finger is ignored
// rather than taking over, which used to move a different note and lose the one
// being dragged.
type Drag = { pointer: number } & (
  | { kind: "move"; id: number; dx: number; dy: number; moved: boolean }
  | { kind: "resize"; id: number; w: number; h: number; x: number; y: number; rot: number }
  // A turn remembers where the pointer started and how the note was hanging,
  // so the note follows the cursor round instead of jumping to meet it.
  | { kind: "turn"; id: number; cx: number; cy: number; from: number; base: number });

/** What a note looks like mid-drag, before React is told about it. */
type Live = { x?: number; y?: number; w?: number; h?: number; rot?: number };

/**
 * The cork wall: sticky notes you write on and move around.
 *
 * Every change is the user's and is kept: typing, dragging, the paper and pin
 * colours, taking a note down. Changes show at once and are saved a moment
 * later, batched per note, so a drag across the wall is one save and typing a
 * sentence is one save.
 */
export default function Wall({ board, onBack, onChanged, onDeleted }: {
  board: Board;
  onBack: () => void;
  onChanged?: () => void;
  onDeleted?: () => void;
}) {
  const [notes, setNotes] = useState<Note[]>(board.notes);
  const [snap, setSnap] = useState(board.snap);
  const [title, setTitle] = useState(board.title);
  const [picked, setPicked] = useState<number | null>(null);
  const [writing, setWriting] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const [askDelete, setAskDelete] = useState<null | { note: Note } | { board: true }>(null);
  // "Schedule…" on a note: a new meeting from its words, or the one it already is.
  const [scheduling, setScheduling] = useState<null | { note: Note; meeting: Meeting | null }>(null);
  const cork = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // A drag moves the paper, not the app: while one is happening the note's own
  // element is written to directly, once per frame, and React hears about it
  // when the note is let go. So dragging costs the same on a wall of 200 notes
  // as on a wall of two.
  const held = useRef<HTMLElement | null>(null);
  const live = useRef<Live>({});
  const frame = useRef(0);

  /** Where a note's 0,0 sits on screen: inside the wall's own edge. */
  const surfaceOrigin = () => {
    const el = surface.current!;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: r.left + parseFloat(cs.borderLeftWidth), y: r.top + parseFloat(cs.borderTopWidth) };
  };

  const paint = useCallback(() => {
    frame.current = 0;
    const el = held.current, now = live.current;
    if (!el) return;
    if (now.x !== undefined) { el.style.left = `${now.x}px`; el.style.top = `${now.y}px`; }
    if (now.w !== undefined) { el.style.width = `${now.w}px`; el.style.height = `${now.h}px`; }
    if (now.rot !== undefined) el.style.transform = `rotate(${now.rot}deg)`;
  }, []);

  const show = useCallback((next: Live) => {
    live.current = { ...live.current, ...next };
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  }, [paint]);

  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  // Notes taken down while a save was on its way: their patches are not retried.
  const gone = useRef(new Set<number>());

  // ── Saving ────────────────────────────────────────────────────────────────
  // What each note still owes the server, merged until it goes. A patch stays
  // owed until the server has taken it: if a save fails, it goes back (under
  // anything newer) and is tried again, and the pill says so. Saves run one at
  // a time, so an older patch can never land after a newer one.
  const owed = useRef(new Map<number, NotePatch>());
  const boardOwed = useRef<{ title?: string; snap?: boolean }>({});
  const timer = useRef<number | undefined>();
  const running = useRef<Promise<void> | null>(null);
  const failures = useRef(0);

  const owe = (id: number, patch: NotePatch) => {
    // Anything already owed was typed earlier: the newer patch wins field by field.
    owed.current.set(id, { ...(owed.current.get(id) ?? {}), ...patch });
  };

  const flush = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    if (running.current) return running.current;            // one save at a time, in order
    if (!owed.current.size && !Object.keys(boardOwed.current).length) return;
    const notePatches = [...owed.current.entries()];
    const boardPatch = boardOwed.current;
    owed.current = new Map();
    boardOwed.current = {};
    setSaving(true);
    const run = (async () => {
      let lost = false;
      try {
        if (Object.keys(boardPatch).length) await boardApi.update(board.id, boardPatch);
      } catch (e) {
        boardOwed.current = { ...boardPatch, ...boardOwed.current };
        lost = true;
        notifyError(e);
      }
      for (const [id, patch] of notePatches) {
        try {
          const saved = await boardApi.updateNote(board.id, id, patch);
          // Only what the server decides comes back: never the words, which the
          // user may still be typing.
          setNotes(prev => prev.map(n => (n.id === id ? { ...n, z: saved.z, updated_at: saved.updated_at } : n)));
        } catch (e) {
          if (gone.current.has(id)) continue;               // the note was taken down meanwhile
          owed.current.set(id, { ...patch, ...(owed.current.get(id) ?? {}) });   // back in the queue, under anything newer
          lost = true;
          if (!failures.current) notifyError(e);
        }
      }
      failures.current = lost ? failures.current + 1 : 0;
      setSaving(false);
      setUnsaved(owed.current.size > 0 || Object.keys(boardOwed.current).length > 0);
      if (lost) {
        // The engine is busy or down: try again, a little later each time.
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => { void flush(); }, Math.min(30000, SAVE_MS * 2 ** failures.current));
      } else {
        onChanged?.();
      }
    })();
    running.current = run.finally(() => { running.current = null; });
    return running.current;
  }, [board.id, onChanged]);

  const save = useCallback((id: number, patch: NotePatch) => {
    owe(id, patch);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, SAVE_MS);
  }, [flush]);

  const saveBoard = useCallback((patch: { title?: string; snap?: boolean }) => {
    boardOwed.current = { ...boardOwed.current, ...patch };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void flush(); }, SAVE_MS);
  }, [flush]);

  // Leaving the wall, closing the app or restarting: whatever is owed goes now.
  useEffect(() => {
    const go = () => { void flush(); };
    window.addEventListener("beforeunload", go);
    window.addEventListener(RESTARTING, go);
    return () => {
      window.removeEventListener("beforeunload", go);
      window.removeEventListener(RESTARTING, go);
      go();
    };
  }, [flush]);

  // ── Notes ─────────────────────────────────────────────────────────────────
  const change = (id: number, patch: NotePatch, keep = true) => {
    setNotes(prev => prev.map(n => (n.id === id ? { ...n, ...patch } as Note : n)));
    if (keep) save(id, patch);
  };

  /** Where the middle of what the user is looking at sits on the wall. */
  const middle = () => {
    const el = cork.current;
    if (!el) return { x: 40, y: 40 };
    return {
      x: place(el.scrollLeft + el.clientWidth / 2 - NOTE_W / 2, snap),
      y: place(el.scrollTop + el.clientHeight / 3, snap),
    };
  };

  async function add(at?: { x: number; y: number }) {
    const spot = freeSpot(notes, at ?? middle());
    const wanted = { text: "", colour: nextColour(notes), pin: nextPin(notes), ...spot, w: NOTE_W, h: NOTE_H };
    try {
      const made = await boardApi.addNote(board.id, wanted);
      setNotes(prev => [...prev, made]);
      setPicked(made.id);
      setWriting(made.id);                 // a new note opens ready to write in
      track("board.note.add");
      onChanged?.();
    } catch (e) {
      notifyError(e);
    }
  }

  async function remove(note: Note) {
    setAskDelete(null);
    setNotes(prev => prev.filter(n => n.id !== note.id));
    owed.current.delete(note.id);
    gone.current.add(note.id);
    if (picked === note.id) setPicked(null);
    if (writing === note.id) setWriting(null);
    try {
      await boardApi.removeNote(board.id, note.id);
      onChanged?.();
      toast.success("Note taken down");
    } catch (e) {
      gone.current.delete(note.id);
      setNotes(prev => [...prev, note].sort((a, b) => a.z - b.z));       // put it back
      notifyError(e);
    }
  }

  function askRemove(note: Note) {
    if (note.text.trim()) setAskDelete({ note });
    else void remove(note);                 // an empty note: nothing to lose
  }

  // ── Dragging and resizing ─────────────────────────────────────────────────
  const top = () => notes.reduce((m, n) => Math.max(m, n.z), 0);

  function startDrag(note: Note, e: React.PointerEvent) {
    // The paper can be grabbed anywhere except where something else is happening:
    // the words being typed, the tools, the corner. So a note is still movable
    // mid-sentence, by its edge.
    if ((e.target as HTMLElement).closest("textarea, button, summary, .sticky-grip")) return;
    if (e.button !== 0 || drag.current) return;
    e.preventDefault();          // a press on the words is a drag, not a text drag
    const box = surfaceOrigin();                              // the wall, wherever it is scrolled to
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* the pointer went away; the wall still tracks it */ }
    held.current = el;
    live.current = {};
    drag.current = { pointer: e.pointerId, kind: "move", id: note.id,
                     dx: e.clientX - box.x - note.x, dy: e.clientY - box.y - note.y, moved: false };
    setPicked(note.id);
  }

  function startResize(note: Note, e: React.PointerEvent) {
    e.stopPropagation();
    if (drag.current) return;
    const el = e.currentTarget.parentElement as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch { /* the pointer went away; the wall still tracks it */ }
    held.current = el;
    live.current = {};
    drag.current = { pointer: e.pointerId, kind: "resize", id: note.id, w: note.w, h: note.h,
                     x: e.clientX, y: e.clientY, rot: note.rot };
    setPicked(note.id);
  }

  /** Turning a note on its pin: the angle follows the pointer around its middle. */
  function startTurn(note: Note, e: React.PointerEvent) {
    e.stopPropagation();
    if (drag.current) return;
    const el = e.currentTarget.parentElement as HTMLElement;
    const box = el.getBoundingClientRect();
    try { el.setPointerCapture(e.pointerId); } catch { /* the pointer went away; the wall still tracks it */ }
    held.current = el;
    live.current = {};
    const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    drag.current = { pointer: e.pointerId, kind: "turn", id: note.id, cx: centre.x, cy: centre.y,
                     from: angleTo(centre, { x: e.clientX, y: e.clientY }), base: note.rot };
    setPicked(note.id);
  }

  function onMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (d.kind === "move") {
      if (!d.moved) {                                    // picked up: it comes to the front
        d.moved = true;
        const front = top() + 1;
        if (held.current) held.current.style.zIndex = String(front);
        setNotes(prev => prev.map(n => (n.id === d.id ? { ...n, z: front } : n)));
      }
      const box = surfaceOrigin();
      show({ x: Math.max(0, Math.min(WALL, e.clientX - box.x - d.dx)),
             y: Math.max(0, Math.min(WALL, e.clientY - box.y - d.dy)) });
    } else if (d.kind === "resize") {
      // The corner follows the pointer even on a turned note: the movement is read
      // in the note's own frame, not the screen's.
      const a = (d.rot * Math.PI) / 180, dx = e.clientX - d.x, dy = e.clientY - d.y;
      show({ w: Math.min(NOTE_MAX, Math.max(NOTE_MIN, d.w + dx * Math.cos(a) + dy * Math.sin(a))),
             h: Math.min(NOTE_MAX, Math.max(NOTE_MIN, d.h - dx * Math.sin(a) + dy * Math.cos(a))) });
    } else {
      const now = angleTo({ x: d.cx, y: d.cy }, { x: e.clientX, y: e.clientY });
      show({ rot: turnBy(d.base, d.from, now, e.shiftKey ? ROT_STEP : 0) });
    }
  }

  function endDrag(e?: React.PointerEvent) {
    const d = drag.current;
    if (!d || (e && d.pointer !== e.pointerId)) return;
    const now = live.current;
    const el = held.current;
    drag.current = null;
    held.current = null;
    live.current = {};
    if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
    // What the drag wrote straight onto the element goes now: React draws the
    // note where it was committed (on the grid, when the board snaps).
    const settle = (style: Partial<CSSStyleDeclaration>) => {
      if (!el) return;
      Object.assign(el.style, style);
    };
    if (d.kind === "move") {
      if (!d.moved || now.x === undefined || now.y === undefined) {
        open(d.id);                                       // a press that never moved is a click
        return;
      }
      const x = place(now.x, snap), y = place(now.y, snap);
      settle({ left: `${x}px`, top: `${y}px` });
      change(d.id, { x, y });
      save(d.id, { front: true });
      track("board.note.move");
    } else if (d.kind === "resize") {
      if (now.w === undefined || now.h === undefined) return;
      const w = Math.round(now.w), h = Math.round(now.h);
      settle({ width: `${w}px`, height: `${h}px` });
      change(d.id, { w, h });
    } else {
      if (now.rot === undefined) return;
      settle({ transform: `rotate(${now.rot}deg)` });
      change(d.id, { rot: now.rot });
      track("board.note.turn");
    }
  }

  /** Open a note for writing (a click on its paper). */
  function open(id: number) {
    setPicked(id);
    setWriting(id);
  }

  function keys(note: Note, e: React.KeyboardEvent) {
    if (writing === note.id) return;
    const step = e.shiftKey ? 1 : GRID;
    const nudge = (dx: number, dy: number) => {
      e.preventDefault();
      change(note.id, { x: Math.max(0, Math.min(WALL, note.x + dx)), y: Math.max(0, Math.min(WALL, note.y + dy)) });
    };
    if (e.key === "ArrowLeft") nudge(-step, 0);
    else if (e.key === "ArrowRight") nudge(step, 0);
    else if (e.key === "ArrowUp") nudge(0, -step);
    else if (e.key === "ArrowDown") nudge(0, step);
    else if (e.key === "[" || e.key === "]") {
      e.preventDefault();
      const by = (e.key === "[" ? -1 : 1) * (e.shiftKey ? ROT_STEP : 1);
      change(note.id, { rot: Math.min(ROT_MAX, Math.max(-ROT_MAX, wrapAngle(note.rot + by))) });
    }
    else if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); setWriting(note.id); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); askRemove(note); }
  }

  /** Lay every note out in reading order, on the grid: a wall that got messy, tidied. */
  function tidy() {
    const el = cork.current;
    const across = Math.max(1, Math.floor(((el?.clientWidth ?? 900) - GRID * 2) / (NOTE_W + GRID)));
    const ordered = [...notes].sort((a, b) => a.y - b.y || a.x - b.x);
    ordered.forEach((n, i) => {
      const x = GRID + (i % across) * (NOTE_W + GRID);
      const y = GRID + Math.floor(i / across) * (NOTE_H + GRID);
      change(n.id, { x, y, w: NOTE_W, h: NOTE_H, rot: 0 });
    });
    track("board.tidy");
    toast.success("Tidied up");
  }

  async function removeBoard() {
    setAskDelete(null);
    try {
      await boardApi.remove(board.id);
      toast.success("Board deleted");
      onDeleted?.();
    } catch (e) {
      notifyError(e);
    }
  }

  const size = useMemo(() => ({
    width: Math.min(WALL, Math.max(1200, ...notes.map(n => n.x + n.w)) + MARGIN),
    height: Math.min(WALL, Math.max(700, ...notes.map(n => n.y + n.h)) + MARGIN),
  }), [notes]);


  async function schedule(note: Note) {
    let meeting: Meeting | null = null;
    if (note.event_id) {
      try { meeting = await meetingsApi.get(note.event_id); } catch { meeting = null; }   // deleted in the calendar: schedule afresh
    }
    setScheduling({ note, meeting });
  }

  async function saveSchedule(note: Note, input: Parameters<typeof meetingsApi.scheduleNote>[2]) {
    const saved = await meetingsApi.scheduleNote(board.id, note.id, input);
    setNotes(prev => prev.map(n => (n.id === note.id ? { ...n, event_id: saved.event_id, meeting: saved.meeting } : n)));
    track("board.note.schedule");
    toast.success("In your calendar");
  }

  return (
    <div className="board-wrap">
      <div className="board-bar" role="toolbar" aria-label="Board">
        <button type="button" className="btn-neutral" onClick={() => { void flush(); onBack(); }}>
          <ArrowLeft size={14} /> All boards
        </button>
        <input className="board-title" value={title} aria-label="Board name" placeholder="Untitled board"
          onChange={e => { setTitle(e.target.value); saveBoard({ title: e.target.value }); }} />
        <span className="board-spacer" />
        <span className={`board-state ${saving ? "saving" : ""}${unsaved ? " unsaved" : ""}`} role="status">
          {saving ? <><Loader2 size={12} className="spin" /> Saving…</>
            : unsaved ? "Not saved yet — trying again" : "Saved"}
        </span>
        <div className="nb-segment" role="radiogroup" aria-label="Where notes land">
          <label className={snap ? "active" : ""}>
            <input type="radio" name="board-snap" checked={snap}
              onChange={() => { setSnap(true); saveBoard({ snap: true }); }} />
            <span><Grid3x3 size={13} /> Grid</span>
          </label>
          <label className={snap ? "" : "active"}>
            <input type="radio" name="board-snap" checked={!snap}
              onChange={() => { setSnap(false); saveBoard({ snap: false }); }} />
            <span><LayoutGrid size={13} /> Free</span>
          </label>
        </div>
        <button type="button" className="btn-neutral" onClick={tidy} disabled={notes.length < 2}
          title="Lay every note out in order">Tidy up</button>
        <button type="button" className="btn-primary" onClick={() => void add()}><Plus size={14} /> Note</button>
        <button type="button" className="btn-neutral danger" aria-label="Delete board"
          onClick={() => setAskDelete({ board: true })}><Trash2 size={14} /></button>
      </div>

      <div className="board-stage">
      <div
        className="board-cork"
        ref={cork}
        onPointerMove={onMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onDoubleClick={e => {
          if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains("board-surface")) return;
          const box = surfaceOrigin();
          void add({ x: place(e.clientX - box.x - NOTE_W / 2, snap), y: place(e.clientY - box.y - 20, snap) });
        }}
        onPointerDown={e => { if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains("board-surface")) setPicked(null); }}
      >
        <div className="board-surface" ref={surface} style={size}>
          {notes.map(note => (
            <StickyNote
              key={note.id}
              note={note}
              selected={picked === note.id}
              editing={writing === note.id}
              onPick={() => setPicked(note.id)}
              onOpen={() => open(note.id)}
              onClose={() => setWriting(w => (w === note.id ? null : w))}
              onText={text => change(note.id, { text })}
              onColour={(colour: NoteColour) => change(note.id, { colour })}
              onPin={(pin: PinColour) => change(note.id, { pin })}
              onDelete={() => askRemove(note)}
              onSchedule={() => schedule(note)}
              onDragStart={e => startDrag(note, e)}
              onResizeStart={e => startResize(note, e)}
              onTurnStart={e => startTurn(note, e)}
              onStraighten={() => change(note.id, { rot: 0 })}
              onKeyDown={e => keys(note, e)}
            />
          ))}
        </div>
      </div>
      {notes.length === 0 && (
        <div className="board-empty-layer">
          <div className="board-empty">
            <p><strong>Nothing pinned yet.</strong></p>
            <p className="muted">Add a note, or double-click the cork wherever you want one.</p>
            <button type="button" className="btn-primary" onClick={() => void add()}><Plus size={14} /> First note</button>
          </div>
        </div>
      )}
      </div>

      {scheduling && (
        <MeetingForm meeting={scheduling.meeting}
          draft={scheduling.meeting ? undefined : fromNoteText(scheduling.note.text)}
          onClose={() => setScheduling(null)}
          onSubmit={input => saveSchedule(scheduling.note, input)} />
      )}
      {askDelete && "note" in askDelete && (
        <ConfirmDialog message="Take this note down?" detail={askDelete.note.text.slice(0, 120)}
          confirmLabel="Take it down" onConfirm={() => void remove(askDelete.note)} onCancel={() => setAskDelete(null)} />
      )}
      {askDelete && "board" in askDelete && (
        <ConfirmDialog message="Delete this board?" detail={`Its ${notes.length} note${notes.length === 1 ? "" : "s"} go too.`}
          onConfirm={() => void removeBoard()} onCancel={() => setAskDelete(null)} />
      )}
    </div>
  );
}
