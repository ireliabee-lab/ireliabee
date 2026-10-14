/**
 * Where a card opens beside words selected in the book (owner, 30 Sep 2026: the
 * Explain card sat at the book's foot whatever was selected). Below the words
 * when there is room, else above them; never over them; always inside the book.
 * Pure, so it is tested without a book.
 */

export interface Box { left: number; top: number; right: number; bottom: number }
export interface Placement { left: number; top?: number; bottom?: number; maxHeight: number; side: "below" | "above" }

/** The gap between the words and the card, and the margin kept from the book's edges. */
const GAP = 10;
const MARGIN = 8;
/** Below the words if at least this much room is there (a card with an answer and its buttons). */
const ROOM = 320;

export function placeBeside(words: Box, host: { width: number; height: number }, cardWidth: number): Placement {
  const width = Math.min(cardWidth, host.width - 2 * MARGIN);
  const centre = (words.left + words.right) / 2;
  const left = Math.max(MARGIN, Math.min(host.width - MARGIN - width, centre - width / 2));
  const below = host.height - words.bottom - GAP - MARGIN;
  const above = words.top - GAP - MARGIN;
  if (below >= ROOM || below >= above) {
    return { left, top: words.bottom + GAP, maxHeight: Math.max(120, below), side: "below" };
  }
  return { left, bottom: host.height - words.top + GAP, maxHeight: Math.max(120, above), side: "above" };
}
