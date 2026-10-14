/**
 * Idea boards: sticky notes on a cork wall (backend/boards.py).
 *
 * For thinking before there is a plan. One thought per note, moved around by
 * hand. Everything saves as it is typed or dragged, so there is nothing to lose.
 */
import { fetchApi } from "./api";
import { errorFromResponse } from "./errors";

export const NOTE_COLOURS = ["yellow", "green", "blue", "pink", "orange", "white", "lined"] as const;
export type NoteColour = (typeof NOTE_COLOURS)[number];

export const PIN_COLOURS = ["red", "blue", "green", "yellow", "pink", "white"] as const;
export type PinColour = (typeof PIN_COLOURS)[number];

export interface Note {
  id: number;
  text: string;
  colour: NoteColour;
  pin: PinColour;
  x: number; y: number; w: number; h: number;
  /** Which note is on top; a note comes to the front when it is picked up. */
  z: number;
  /** How it hangs on its pin, in degrees: 0 is square, negative leans left. */
  rot: number;
  created_at: string;
  updated_at: string;
  /** The meeting made from this note ("Schedule…"), and when it is. */
  event_id?: number | null;
  meeting?: { title: string; start: string; timezone: string | null } | null;
}

export interface Board {
  id: number;
  title: string;
  /** Notes settle onto the grid when dropped. Off: they stay exactly where they land. */
  snap: boolean;
  created_at: string;
  updated_at: string;
  notes: Note[];
}

export interface BoardSummary extends Omit<Board, "notes"> {
  notes: number;
  preview: string;
}

/** What one note may be changed to; anything left out stays as it was. */
export type NotePatch = Partial<Pick<Note, "text" | "colour" | "pin" | "x" | "y" | "w" | "h" | "rot">> & { front?: boolean };

// The wall and its notes, in points. Kept the same as backend/boards.py.
export const WALL = 12000;
export const GRID = 20;
export const NOTE_MIN = 120;
export const NOTE_MAX = 900;
export const NOTE_W = 220;
export const NOTE_H = 200;
/** As much as one note holds (the same as backend/boards.py LIMITS["text"]). */
export const TEXT_MAX = 2000;
/** A note can be turned this far either way (the same as backend/boards.py). */
export const ROT_MAX = 180;
/** Turning with Shift held lands on these, so several notes can share an angle. */
export const ROT_STEP = 15;

/** Where a note sits after being dropped: on the grid, or exactly where it landed. */
export function place(value: number, snap: boolean): number {
  const on = snap ? Math.round(value / GRID) * GRID : Math.round(value);
  return Math.min(WALL, Math.max(0, on));
}

/**
 * A free spot for a new note, starting from `near` (usually the middle of what
 * the user is looking at): walk right and down until nothing overlaps, so a new
 * note never lands on top of another.
 */
export function freeSpot(notes: Note[], near: { x: number; y: number }, size = { w: NOTE_W, h: NOTE_H }): { x: number; y: number } {
  const clear = (x: number, y: number) => !notes.some(n =>
    x < n.x + n.w - 8 && x + size.w - 8 > n.x && y < n.y + n.h - 8 && y + size.h - 8 > n.y);
  const startX = Math.max(0, Math.round(near.x)), startY = Math.max(0, Math.round(near.y));
  if (clear(startX, startY)) return { x: startX, y: startY };
  const step = GRID * 2;
  for (let ring = 1; ring <= 40; ring++) {
    for (const [dx, dy] of [[ring, 0], [0, ring], [ring, ring], [-ring, 0], [0, -ring], [-ring, ring], [ring, -ring], [-ring, -ring]]) {
      const x = Math.max(0, startX + dx * step), y = Math.max(0, startY + dy * step);
      if (clear(x, y)) return { x, y };
    }
  }
  return { x: startX + step, y: startY + step };      // a very full board: let them overlap
}

/** Degrees, brought back into -180..180 so a note never reads as upside down twice. */
export function wrapAngle(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/** Which way a point lies from a centre, in degrees, with straight up as 0. */
export function angleTo(centre: { x: number; y: number }, point: { x: number; y: number }): number {
  return wrapAngle((Math.atan2(point.y - centre.y, point.x - centre.x) * 180) / Math.PI + 90);
}

/**
 * Where a note ends up while its handle is being dragged.
 *
 * It turns by however far the pointer has gone round since the drag started,
 * so the handle stays under the cursor wherever the handle sits on the paper.
 * `step` (Shift held) lands it on whole steps, so several notes can be set to
 * the same lean.
 */
export function turnBy(base: number, from: number, to: number, step = 0): number {
  const turned = wrapAngle(base + wrapAngle(to - from));
  const snapped = step > 0 ? Math.round(turned / step) * step : Math.round(turned * 10) / 10;
  return Math.min(ROT_MAX, Math.max(-ROT_MAX, wrapAngle(snapped)));
}

/** The next colour to reach for, so a board doesn't come out all one shade. */
export function nextColour(notes: Note[]): NoteColour {
  const last = notes[notes.length - 1]?.colour;
  const at = last ? NOTE_COLOURS.indexOf(last) : -1;
  return NOTE_COLOURS[(at + 1) % NOTE_COLOURS.length];
}

/** A pin for a new note: whichever is least used, so the wall keeps its colour. */
export function nextPin(notes: Note[]): PinColour {
  const used = new Map<PinColour, number>(PIN_COLOURS.map(p => [p, 0]));
  for (const n of notes) used.set(n.pin, (used.get(n.pin) ?? 0) + 1);
  return [...used.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await errorFromResponse(res);
  return res.json() as Promise<T>;
}

const send = <T>(path: string, method: string, body?: unknown) =>
  fetchApi(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(r => json<T>(r));

export const boardApi = {
  list: (q = "") => fetchApi(`/boards/${q ? `?q=${encodeURIComponent(q)}` : ""}`).then(r => json<BoardSummary[]>(r)),
  create: (title = "") => send<Board>("/boards/", "POST", { title }),
  get: (id: number) => fetchApi(`/boards/${id}`).then(r => json<Board>(r)),
  update: (id: number, patch: { title?: string; snap?: boolean }) => send<Board>(`/boards/${id}`, "PATCH", patch),
  remove: (id: number) => send<{ ok: boolean }>(`/boards/${id}`, "DELETE"),

  addNote: (id: number, note: NotePatch) => send<Note>(`/boards/${id}/notes`, "POST", note),
  updateNote: (id: number, noteId: number, patch: NotePatch) => send<Note>(`/boards/${id}/notes/${noteId}`, "PATCH", patch),
  moveNotes: (id: number, moves: { id: number; x: number; y: number; z?: number }[]) =>
    send<Note[]>(`/boards/${id}/notes/moves`, "POST", { moves }),
  removeNote: (id: number, noteId: number) => send<{ ok: boolean }>(`/boards/${id}/notes/${noteId}`, "DELETE"),
};
