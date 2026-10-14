import { memo, useEffect, useRef } from "react";
import { CalendarClock, CalendarPlus, Palette, RotateCw, Trash2 } from "lucide-react";
import { NOTE_COLOURS, PIN_COLOURS, TEXT_MAX, type Note, type NoteColour, type PinColour } from "../../lib/boards";

/**
 * One sticky note: paper, a pin through the top, and whatever was written on
 * it. Picked up anywhere on the paper, written on once it is open, resized by
 * the corner. Nothing here saves — the wall does that as things change.
 */
/** "Fri 2 Oct, 3:00 pm" in the reader's own time. */
const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
};

function StickyNote({ note, selected, editing, onPick, onOpen, onClose, onText, onColour, onPin, onDelete, onSchedule, onDragStart, onResizeStart, onTurnStart, onStraighten, onKeyDown }: {
  note: Note;
  selected: boolean;
  editing: boolean;
  onPick: () => void;
  onOpen: () => void;
  onClose: () => void;
  onText: (text: string) => void;
  onColour: (colour: NoteColour) => void;
  onPin: (pin: PinColour) => void;
  onDelete: () => void;
  /** Make this note a meeting, or open the meeting it already is. */
  onSchedule: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  onResizeStart: (e: React.PointerEvent) => void;
  onTurnStart: (e: React.PointerEvent) => void;
  onStraighten: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) {
      box.current?.focus();
      box.current?.setSelectionRange(note.text.length, note.text.length);
    } else if (wasEditing.current) {
      paper.current?.focus();        // back to the note itself, so the arrows still move it
    }
    wasEditing.current = editing;
  }, [editing]);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={paper}
      draggable={false}
      className={`sticky sticky-${note.colour}${selected ? " picked" : ""}${editing ? " writing" : ""}`}
      style={{ left: note.x, top: note.y, width: note.w, height: note.h, zIndex: note.z,
        transform: `rotate(${note.rot}deg)` }}
      tabIndex={0}
      role="group"
      aria-label={note.text ? `Note: ${note.text.slice(0, 60)}` : "Empty note"}
      onPointerDown={onDragStart}
      onDoubleClick={onOpen}
      onFocus={onPick}
      onKeyDown={onKeyDown}
    >
      <span className={`sticky-pin pin-${note.pin}`} aria-hidden="true" />
      {selected && (
        <span className="sticky-turn" role="separator" title="Turn it — hold Shift for whole steps, double-click to straighten"
          aria-label="Turn note" onPointerDown={onTurnStart} onDoubleClick={onStraighten}>
          <RotateCw size={12} />
        </span>
      )}

      {editing ? (
        <textarea
          ref={box}
          className="sticky-text"
          value={note.text}
          maxLength={TEXT_MAX}
          placeholder="What's the idea?"
          aria-label="Note"
          onChange={e => onText(e.target.value)}
          onBlur={onClose}
          onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
        />
      ) : (
        <div className="sticky-text read" onClick={onOpen}>
          {note.text || <span className="sticky-empty">Write something…</span>}
        </div>
      )}

      {selected && !editing && (
        <div className="sticky-tools" onPointerDown={e => e.stopPropagation()}>
          <details className="sticky-palette">
            <summary aria-label="Paper and pin"><Palette size={13} /></summary>
            <div className="sticky-swatches glass-card">
              <div className="sticky-kicker">Paper</div>
              <div className="sticky-row">
                {NOTE_COLOURS.map(c => (
                  <button key={c} type="button" className={`sticky-swatch sticky-${c}${note.colour === c ? " on" : ""}`}
                    aria-label={`${c} paper`} aria-pressed={note.colour === c} onClick={() => onColour(c)} />
                ))}
              </div>
              <div className="sticky-kicker">Pin</div>
              <div className="sticky-row">
                {PIN_COLOURS.map(p => (
                  <button key={p} type="button" className={`sticky-swatch pin-${p}${note.pin === p ? " on" : ""}`}
                    aria-label={`${p} pin`} aria-pressed={note.pin === p} onClick={() => onPin(p)} />
                ))}
              </div>
            </div>
          </details>
          <button type="button" className="sticky-btn" aria-label={note.meeting ? "Open the meeting" : "Schedule as a meeting"}
            title={note.meeting ? "Open the meeting" : "Schedule as a meeting"} onClick={onSchedule}><CalendarPlus size={13} /></button>
          <button type="button" className="sticky-btn" aria-label="Take this note down" title="Take this note down"
            onClick={onDelete}><Trash2 size={13} /></button>
        </div>
      )}

      {note.meeting && !editing && (
        <button type="button" className="sticky-meeting" title={`${note.meeting.title}: open the meeting`}
          onPointerDown={e => e.stopPropagation()} onClick={onSchedule}>
          <CalendarClock size={11} /> {when(note.meeting.start)}
        </button>
      )}
      <span className="sticky-grip" role="separator" aria-label="Resize note" onPointerDown={onResizeStart} />
    </div>
  );
}

export default memo(StickyNote);
